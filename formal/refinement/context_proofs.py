#!/usr/bin/env python3
"""Kernel certificate for complete raw-NEF initialization and frame properties."""
import argparse
import copy
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile

import method_proofs as method
import nef_decode

ROOT = Path(__file__).resolve().parent
START, END = 29996, 30678
SCOPE = "complete-initializer-reference-refinement"
# The kernel is the long pole and this host is shared with unrelated workloads.
# The old 1800s budget was exceeded on 2026-10-20 by a loaded host rather than by
# a stuck proof. This is a liveness limit, not a claim: a late proof is still
# kernel-checked and a genuine hang still fails closed at this bound.
KERNEL_TIMEOUT = 3600
MODELS = ["IntegerSemantics", "CapArithmetic", "CapMethodVm", "CapContext"]
THEOREM_NAMES = ["actual_initializer_complete", "actual_initializer_preserves_existing", "actual_initializer_fresh_arrays", "actual_initializer_static_entry", "actual_initializer_no_fault_or_timeout", "actual_initializer_rejects_existing_statics"]
require, digest = method.require, method.digest


def bind_helper(inventory):
    # The legacy binder verifies all input files, then reads the NEF again to
    # decode it. Join its digest of those actual decoded bytes to the expected
    # identity, so replacing the file between reads cannot certify another NEF.
    bound = method.bind_method(inventory)
    require(bound["nefSha256"] == inventory["nef"]["sha256"],
            "Decoded NEF digest differs from inventory")
    return bound


def bind_initializer(inventory):
    # Reuses full raw-NEF/token/instruction/current-input verification, not the
    # previous arithmetic or method certificate as acceptance evidence.
    bound = bind_helper(inventory)
    entries = [m for m in inventory["manifest"]["methods"] if m["name"] == "_initialize"]
    require(entries == [dict(name="_initialize", parameters=[], returntype="Void", offset=START, safe=False)],
            "Initializer manifest entry mismatch")
    require("Prefix_TransactionReimbursement,ByteArray,38" in inventory["sourceMap"]["debug"]["static-variables"],
            "Reimbursement static descriptor mismatch")
    script = bytes.fromhex(inventory["nef"]["scriptHex"])
    require(len(script) == END, "Initializer is not the full terminal byte range")
    instructions = nef_decode.decode_script(script, len(inventory["nef"]["tokens"]))
    region = [i for i in instructions if START <= i["offset"] < END]
    require(region and region[0]["offset"] == START and region[-1]["offset"] + region[-1]["size"] == END,
            "Initializer range is not an instruction boundary")
    require(len(region) == 182 and region[-1]["name"] == "RET", "Initializer coverage mismatch")
    return dict(start=START, end=END, bytes=list(script[START:END]), instructions=region,
                nefSha256=bound["nefSha256"], scriptSha256=bound["scriptSha256"],
                initializerSha256=digest(script[START:END]))


PROOFS = r"""
Theorem actual_initializer_complete : forall hp st,
 exists final first second,
 run_init 182 initializer_code (initializer_entry hp st) = InitReturned final /\
 init_heap final = hp ++ [first;second] /\
 init_stack final = st /\
 init_pc final = 681%nat /\
 lookup_init_static final 38 = Some (VBuffer [33%nat]) /\
 lookup_init_static final 19 = Some (VRef (length hp)) /\
 lookup_init_static final 21 = Some (VRef (length (hp++[first]))) /\
 (exists slots, init_slots final = Some slots /\ length slots = 57%nat).
Proof.
 intros hp st. vm_compute.
 eexists. eexists. eexists. repeat split; try reflexivity.
 fold (@app Object). rewrite <- app_assoc. reflexivity.
 eexists. split; reflexivity.
Qed.


Theorem actual_initializer_preserves_existing : forall hp st final index,
 run_init 182 initializer_code (initializer_entry hp st) = InitReturned final ->
 (index < length hp)%nat ->
 nth_error (init_heap final) index = nth_error hp index.
Proof.
 intros hp st final index Hrun Hindex.
 destruct (actual_initializer_complete hp st) as [f [a [b [Hf [Hheap Hrest]]]]].
 rewrite Hrun in Hf. inversion Hf; subst f.
 rewrite Hheap. apply heap_append_preserves_existing. exact Hindex.
Qed.
Theorem actual_initializer_fresh_arrays : forall hp st final,
 run_init 182 initializer_code (initializer_entry hp st) = InitReturned final ->
 exists first second,
 nth_error (init_heap final) (length hp) = Some first /\
 nth_error (init_heap final) (S (length hp)) = Some second /\
 nth_error hp (length hp) = None /\
 nth_error hp (S (length hp)) = None /\
 length (init_heap final) = (length hp+2)%nat /\
 VRef (length hp) <> VRef (S (length hp)).
Proof.
 intros hp st final Hrun.
 destruct (actual_initializer_complete hp st) as [f [a [b [Hf [Hheap Hrest]]]]].
 rewrite Hrun in Hf. inversion Hf; subst f.
 exists a,b. rewrite Hheap. repeat split.
 - rewrite nth_error_app2 by lia. rewrite Nat.sub_diag. reflexivity.
 - rewrite nth_error_app2 by lia. replace (S (length hp)-length hp)%nat with 1%nat by lia. reflexivity.
 - apply nth_error_None. lia.
 - apply nth_error_None. lia.
 - rewrite app_length. reflexivity.
 - intro H. inversion H. lia.
Qed.
Theorem actual_initializer_static_entry : forall hp st final,
 run_init 182 initializer_code (initializer_entry hp st) = InitReturned final ->
 lookup_init_static final 38 = Some (VBuffer [33%nat]) /\ init_stack final = st.
Proof.
 intros hp st final Hrun.
 destruct (actual_initializer_complete hp st) as [f [a [b [Hf [Hheap [Hstack [Hpc [Hslot Hrest]]]]]]]].
 rewrite Hrun in Hf. inversion Hf; subst f. split; assumption.
Qed.
Theorem actual_initializer_no_fault_or_timeout : forall hp st,
 run_init 182 initializer_code (initializer_entry hp st) <> InitFaulted /\
 run_init 182 initializer_code (initializer_entry hp st) <> InitTimedOut.
Proof.
 intros hp st. destruct (actual_initializer_complete hp st) as [f [a [b [Hrun Hrest]]]].
 rewrite Hrun. split; discriminate.
Qed.
Theorem actual_initializer_rejects_existing_statics : forall hp st slots,
 run_init 182 initializer_code (init_state 0 st hp (Some slots)) = InitFaulted.
Proof. intros. reflexivity. Qed.
"""


def render_certificate(program):
    return ("From Coq Require Import ZArith List Bool Lia.\n"
            "Require Import IntegerSemantics CapArithmetic CapMethodVm CapContext.\n"
            "Import ListNotations.\nOpen Scope Z_scope.\n"
            "Definition initializer_code : list nat := [" +
            ";".join(str(b)+"%nat" for b in program["bytes"]) + "].\n" + PROOFS)


def semantic_controls(program, work):
    model = (work / "CapContext.v").read_bytes().decode()
    changes = []
    # The initializer stores Prefix_TransactionReimbursement by pushing the
    # one-byte data [33] with PUSHDATA1, converting it to a Buffer, and storing
    # it with STSFLD 38. The mutations retarget the stored buffer (33 -> 34)
    # and the destination slot (38 -> 39); both offsets are absolute pcs of the
    # operand bytes in the current initializer (30499/30503).
    for name, offset, value in [("WrongStaticSlot",30503,39), ("WrongKey",30499,34)]:
        changed=copy.deepcopy(program)
        changed["bytes"][offset-START]=value
        changes.append((name, changed, model))
    old="(init_heap s ++ [obj ArrayKind (firstn (Z.to_nat count) rest)])"
    require(model.count(old)==1, "Allocation control target changed")
    changes.append(("DropHeapAllocation",program,model.replace(old,"(init_heap s)")))
    results=[]
    for name, changed, changed_model in changes:
        directory=work/name
        directory.mkdir()
        for file in work.iterdir():
            if file.suffix in (".vo", ".vos", ".vok", ".glob") and file.is_file():
                shutil.copy2(file,directory/file.name)
        (directory/"CapContext.v").write_bytes(changed_model.encode())
        compiled,log=method._kernel_command(["coqc","-q","CapContext.v"],directory,"model.log")
        method._require_kernel_success(compiled,log)
        certificate=render_certificate(changed)
        definitions=certificate.split("Theorem actual_initializer_complete",1)[0]
        (directory/"MutantDefinitions.v").write_bytes(definitions.encode())
        compiled,log=method._kernel_command(["coqc","-q","MutantDefinitions.v"],directory,"definitions.log")
        method._require_kernel_success(compiled,log)
        (directory/"MutantCertificate.v").write_bytes(certificate.encode())
        rejected,log=method._kernel_command(["coqc","-q","MutantCertificate.v"],directory,"rejected.log")
        message=rejected.stdout+rejected.stderr
        require(rejected.returncode!=0 and any(marker in message for marker in
                ("Unable to unify","Found no subterm","Attempt to save an incomplete proof","No applicable tactic")) and
                not any(marker in message for marker in ("Syntax error","Cannot find","not found","Anomaly")),
                "Semantic mutant not rejected: "+name+"; see "+str(log))
        results.append(dict(name=name,definitionsCompiled=True,certificateRejected=True,log=str(log),
                            certificateSha256=digest(certificate.encode()),modelSha256=digest(changed_model.encode())))
    return results


def run_proofs(inventory, output_dir, controls=False):
    require(shutil.which("coqc") and shutil.which("coqchk"),"coqc and coqchk are required")
    tool_paths=[ROOT/name for name in ("context_proofs.py","method_proofs.py","nef_decode.py","verify.py")]
    tools={str(p):digest(p.read_bytes()) for p in tool_paths}
    program=bind_initializer(inventory)
    # Both counts below appear verbatim in the receipt, so derive them from the
    # bound program and the source map rather than restating a number that a
    # later build can silently invalidate.
    static_slots=len(inventory["sourceMap"]["debug"]["static-variables"])
    output=Path(output_dir)
    require(not output.exists() or (output.is_dir() and not any(output.iterdir())), "Output directory must be empty")
    output.mkdir(parents=True,exist_ok=True)
    work=Path(tempfile.mkdtemp(prefix="cap-context-kernel-",dir=str(output)))
    hashes={};declarations={}
    for module in MODELS:
        raw=(ROOT/"coq"/(module+".v")).read_bytes();source=raw.decode()
        require(not re.search(r"\b(?:Admitted|Axiom|Axioms|admit|Parameter|Parameters|Abort)\b",source),"Proof escape in "+module)
        hashes[module]=digest(raw);declarations[module]=method.declared_names(source)
        (work/(module+".v")).write_bytes(raw)
        result,log=method._kernel_command(["coqc","-q",module+".v"],work,module+".log")
        method._require_kernel_success(result,log)
    certificate=render_certificate(program)
    require(not re.search(r"\b(?:Admitted|Axiom|Axioms|admit|Parameter|Parameters|Abort)\b", certificate), "Certificate proof escape")
    (work/"CapContextArtifact.v").write_bytes(certificate.encode())
    declarations["CapContextArtifact"]=method.declared_names(certificate)
    require(set(THEOREM_NAMES)<=set(declarations["CapContextArtifact"]),"Missing claimed theorem")
    result,log=method._kernel_command(["coqc","-q","CapContextArtifact.v"],work,"artifact.log")
    method._require_kernel_success(result,log)
    result,log=method._kernel_command(["coqchk","-silent","CapContextArtifact"],work,"coqchk.log")
    method._require_kernel_success(result,log)
    assumptions="Require Import "+" ".join(MODELS+["CapContextArtifact"])+".\n"
    assumptions+="\n".join("Print Assumptions "+module+"."+name+"." for module,names in declarations.items() for name in names)+"\n"
    (work/"ContextAssumptions.v").write_bytes(assumptions.encode())
    result,log=method._kernel_command(["coqc","-q","ContextAssumptions.v"],work,"assumptions.log")
    method._require_kernel_success(result,log)
    closed=sum(line.strip()=="Closed under the global context" for line in result.stdout.splitlines())
    require(closed==sum(map(len,declarations.values())),"Incomplete closed-assumptions inventory")
    controls_result=semantic_controls(program,work) if controls else []
    require(bind_initializer(inventory)==program,"Initializer inputs changed during verification")
    for path,expected in tools.items():require(digest(Path(path).read_bytes())==expected,"Tool changed: "+path)
    for name,expected in hashes.items():require(digest((ROOT/"coq"/(name+".v")).read_bytes())==expected,"Model changed: "+name)
    return dict(scope=SCOPE,status="PASS",kernelChecked=True,initializerReferenceVerified=True,
                helperContextVerified=False,fullImplementationVerified=False,
                initializerRange=[START,END],byteCount=len(program["bytes"]),instructionCount=len(program["instructions"]),
                nefSha256=program["nefSha256"],scriptSha256=program["scriptSha256"],initializerSha256=program["initializerSha256"],
                toolInputSha256=tools,modelSha256=hashes,certificateSha256=digest(certificate.encode()),
                inventorySha256=digest(json.dumps(inventory,sort_keys=True,separators=(",",":")).encode()),
                inventorySourceSha256=digest(json.dumps(inventory["source"],sort_keys=True,separators=(",",":")).encode()),
                manifestSha256=inventory["manifest"]["sha256"],
                kernelDirectory=str(work),assumptionDeclarations=declarations,closedAssumptionCount=closed,
                theoremNames=THEOREM_NAMES,semanticControls=controls_result,
                established=[f"all {len(program['instructions'])} initializer instructions halt", "static slot 38 is Buffer[33]",
                             f"{static_slots} source-mapped static slots; the certificate pins the helper slot 38 and allocated slots 18 and 20",
                             "arbitrary existing heap objects preserved", "two fresh array references", "arbitrary stack suffix preserved"],
                excludedCorrespondence=["actual ApplicationEngine and resource/gas behavior", "mutable Buffer identity",
                                        "helper arbitrary caller context and fresh GetScriptContainer allocations", "all 109 public ABI entrypoints"])


# Complete caller-context path proofs. All use actual byte decoding and
# the same frozen ordinary instruction semantics.
CONTEXT_PROOFS = r"""
Ltac norm := cbv [with_stack change with_local with_heap with_effect with_storage pc stack arguments locals heap storage effects statics fields object_kind jump_target signed_byte signed_short vm_max checked_binary binary_value]; cbn [artifact decode context_step vm_step with_stack change with_local with_heap
       with_effect with_storage allocate deserialize serialize read_field write_field
       get_storage put_storage value_eqb scalar jump_target signed_byte signed_short
       pc stack arguments locals heap storage effects object_kind fields tx_object
       skipn firstn nth_error repeat length app Nat.eqb Nat.leb Nat.ltb Nat.add Nat.sub Nat.mul andb orb negb Bool.eqb checked_binary binary_value statics forallb Z.of_nat Pos.of_succ_nat Pos.succ Z.leb Z.compare].
Ltac heap_norm :=
 fold (@app Object) (@length Object) (@nth_error Object) (@firstn Object) (@skipn Object) Nat.add Nat.sub;
 first [ rewrite skipn_successor_heap_suffix
       | rewrite nth_error_app2 by (rewrite ?app_length; cbn [length]; lia)
       | rewrite firstn_app
       | rewrite skipn_app
       | rewrite app_length
       | rewrite <- app_assoc
       | rewrite firstn_all2 by lia
       | rewrite skipn_all2 by lia ];
 rewrite ?Nat.sub_diag; try match goal with |- context[(?a-?b)%nat] => first [replace (a-b)%nat with 0%nat by lia | replace (a-b)%nat with 1%nat by lia | replace (a-b)%nat with 2%nat by lia | replace (a-b)%nat with 3%nat by lia | replace (a-b)%nat with 4%nat by lia] end; cbn [nth_error firstn skipn length].
Ltac drive sf nf q r Heq Hstatic Hfits := repeat (first [ progress norm | progress heap_norm
 | progress (rewrite ?Heq, ?Hstatic)
 | match goal with |- context[Z.to_nat ?z] =>
   let n := eval vm_compute in (Z.to_nat z) in progress change (Z.to_nat z) with n end
 |
   match goal with
   | |- observe_context (run_context (S ?fuel) ?code ?hash ?sf ?nf ?s) = _ => rewrite (run_context_one_step fuel code hash sf nf s)
   end
 | progress (rewrite (Z.min_comm 1 (sf+nf)))
 | progress (rewrite (Z.max_comm 0 (sf+nf-r)))
 | progress (rewrite (Z.min_comm (Z.max (sf+nf-r) 0+(1-Z.min (sf+nf) 1)*q) q))
 | match goal with
   | |- context[checked_integer ?z] => progress change (checked_integer z) with (Some z)
   end
 | match goal with
   | |- context[checked_integer (1 * 2 ^ 254 - 1 + 1 * 2 ^ 254 - ?z)] =>
       progress (rewrite (checked_integer_in_range (1 * 2 ^ 254 - 1 + 1 * 2 ^ 254 - z))
         by (apply vm_margin_fits; [assumption | assumption]))
   end
 | match goal with
   | |- context[checked_integer ?z] => rewrite (checked_integer_in_range z) by (unfold integer_fits in *; lia)
   end
 | progress (rewrite (vm_leb_margin_of_fits r (Z.min q (Z.max (sf+nf-r) 0+(1-Z.min (sf+nf) 1)*q)) Hfits))
 ]).
Theorem context_same_hash_classified : forall hash old sf nf q r kind static_values hp tail,
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 cap_domain (sf+nf) q r ->
 integer_fits (r + charge_expression (sf+nf) q r) ->
 bytes_eqb old hash = true ->
 observe_context (run_context 110 artifact hash sf nf (context_entry q (VWire kind [VBytes old;VInt r]) static_values hp tail)) =
 contextual_classified hp tail static_values old hash sf nf q r kind (VWire kind [VBytes old;VInt r])
 [ReadStorage (VWire kind [VBytes old;VInt r]);Deserialized (VWire kind [VBytes old;VInt r])].
Proof.
 intros hash old sf nf q r kind static_values hp tail Hstatic Hdom Hsum Heq.
 unfold charge_expression in Hsum.
 pose proof (cap_intermediates_representable (sf+nf) q r Hdom) as [H1 [H2 [H3 [H4 [H5 [H6 H7]]]]]].
 assert (Hcost : integer_fits (sf+nf)) by (apply nonnegative_integer_fits; destruct Hdom as [H _]; exact H).
 pose proof integer_limit_positive as HL.
 assert (Hsmall : 8 < integer_limit) by (vm_compute; reflexivity).
 unfold context_entry, contextual_classified, classified, charge_expression, method_error.
 (* `drive` receives the representability hypothesis so it can discharge the
    helper's VM-integer headroom assertion. The assertion only appears once the
    run reaches its LE/JMPIF, which is why the rewrite lives inside `drive`
    rather than before it; with it reduced to `true`, the classification's
    rejection branch is unreachable and the two sides stay convertible. *)
 drive sf nf q r Heq Hstatic Hsum.
 destruct (0 <? Z.min q (Z.max (sf+nf-r) 0+(1-Z.min (sf+nf) 1)*q)) eqn:Hpositive; drive sf nf q r Heq Hstatic Hsum.
 all: cbv [observe_context observe]; norm; try reflexivity.
 all: repeat heap_norm; norm; try reflexivity.
 all: rewrite skipn_successor_heap_suffix; cbn [skipn]; reflexivity.
Qed.
Print Assumptions context_same_hash_classified.

Theorem context_different_hash_classified : forall hash old sf nf q r kind static_values hp tail,
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 cap_domain (sf+nf) q 0 ->
 integer_fits (0 + charge_expression (sf+nf) q 0) ->
 bytes_eqb old hash = false ->
 observe_context (run_context 110 artifact hash sf nf (context_entry q (VWire kind [VBytes old;VInt r]) static_values hp tail)) =
 contextual_classified hp tail static_values hash hash sf nf q 0 kind (VWire kind [VBytes old;VInt r])
 [ReadStorage (VWire kind [VBytes old;VInt r]);Deserialized (VWire kind [VBytes old;VInt r])].
Proof.
 intros hash old sf nf q r kind static_values hp tail Hstatic Hdom Hsum Heq.
 unfold charge_expression in Hsum.
 pose proof (cap_intermediates_representable (sf+nf) q 0 Hdom) as [H1 [H2 [H3 [H4 [H5 [H6 H7]]]]]].
 assert (Hcost : integer_fits (sf+nf)) by (apply nonnegative_integer_fits; destruct Hdom as [H _]; exact H).
 pose proof integer_limit_positive as HL.
 assert (Hsmall : 8 < integer_limit) by (vm_compute; reflexivity).
 unfold context_entry, contextual_classified, classified, charge_expression, method_error.
 (* The helper's VM-integer headroom assertion is discharged from the
    representability hypothesis, so the classification's rejection branch
    is unreachable and the guard reduces to its accepting arm. *)
 drive sf nf q constr:(0) Heq Hstatic Hsum.
 destruct (0 <? Z.min q (Z.max (sf+nf-0) 0+(1-Z.min (sf+nf) 1)*q)) eqn:Hpositive;
 drive sf nf q constr:(0) Heq Hstatic Hsum.
 all: cbv [observe_context observe]; norm; try reflexivity.
 all: repeat heap_norm; norm; try reflexivity.
 all: rewrite skipn_successor_heap_suffix; cbn [skipn]; reflexivity.
Qed.
Print Assumptions context_different_hash_classified.

Theorem context_absent_classified : forall hash sf nf q static_values hp tail,
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 cap_domain (sf+nf) q 0 ->
 integer_fits (0 + charge_expression (sf+nf) q 0) ->
 observe_context (run_context 110 artifact hash sf nf (context_entry q VNull static_values hp tail)) =
 contextual_classified hp tail static_values (if bytes_eqb (repeat 0%nat 32) hash then repeat 0%nat 32 else hash)
 hash sf nf q 0 ArrayKind VNull [ReadStorage VNull].
Proof.
 intros hash sf nf q static_values hp tail Hstatic Hdom Hsum.
 unfold charge_expression in Hsum.
 pose proof (cap_intermediates_representable (sf+nf) q 0 Hdom) as [H1 [H2 [H3 [H4 [H5 [H6 H7]]]]]].
 assert (Hcost : integer_fits (sf+nf)) by (apply nonnegative_integer_fits; destruct Hdom as [H _]; exact H).
 pose proof integer_limit_positive as HL.
 assert (Hsmall : 8 < integer_limit) by (vm_compute; reflexivity).
 destruct (bytes_eqb (repeat 0%nat 32) hash) eqn:Heq;
 cbn [repeat] in Heq;
 unfold context_entry, contextual_classified, classified, charge_expression, method_error;
 (* The helper's VM-integer headroom assertion is discharged from the
    representability hypothesis, so the classification's rejection branch
    is unreachable and the guard reduces to its accepting arm. *)
 drive sf nf q constr:(0) Heq Hstatic Hsum.
 all: destruct (0 <? Z.min q (Z.max (sf+nf-0) 0+(1-Z.min (sf+nf) 1)*q)) eqn:Hpositive;
 drive sf nf q constr:(0) Heq Hstatic Hsum.
 all: cbv [observe_context observe]; norm; try reflexivity.
 all: repeat heap_norm; norm; try reflexivity.
 all: rewrite skipn_successor_heap_suffix; cbn [skipn]; reflexivity.
Qed.
Print Assumptions context_absent_classified.

"""

CONTEXT_COMPOSITION = r"""

Theorem context_method_classified : forall hash sf nf q input static_values hp tail,
 legal_inputs hash sf nf q input ->
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 observe_context (run_context 110 artifact hash sf nf (context_entry q (stored_value input) static_values hp tail)) =
 contextual_classified hp tail static_values hash hash sf nf q
 (effective_reserved hash input) (input_kind input) (stored_value input) (input_trace input).
Proof.
 intros hash sf nf q input static_values hp tail Hlegal Hstatic.
 pose proof (legal_cap_domain hash sf nf q input Hlegal) as Hdomain.
 pose proof (legal_update_fits hash sf nf q input Hlegal) as Hsum.
 destruct input as [|kind old reserved].
 - cbn [stored_value input_kind effective_reserved input_trace] in *.
   rewrite context_absent_classified by assumption.
   replace (if bytes_eqb (repeat 0%nat 32) hash then repeat 0%nat 32 else hash) with hash.
   + reflexivity.
   + destruct (bytes_eqb (repeat 0%nat 32) hash) eqn:E; [|reflexivity].
     symmetry. apply bytes_eqb_true. exact E.
 - cbn [stored_value input_kind effective_reserved input_trace] in *.
   destruct (bytes_eqb old hash) eqn:E.
   + rewrite context_same_hash_classified by assumption.
     rewrite (bytes_eqb_true old hash E). reflexivity.
   + rewrite context_different_hash_classified by assumption. reflexivity.
Qed.
Theorem complete_context_observation : forall hash sf nf q input static_values hp tail,
 legal_inputs hash sf nf q input ->
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 observe (run_context 110 artifact hash sf nf (context_entry q (stored_value input) static_values hp tail)) =
 contract_observation hash sf nf q input.
Proof.
 intros. pose proof (context_method_classified hash sf nf q input static_values hp tail H H0) as Hclass.
 apply context_observation_from_classification in Hclass.
 rewrite Hclass. apply classified_refines_contract. assumption.
Qed.
Theorem complete_context_frame : forall hash sf nf q input static_values hp tail,
 legal_inputs hash sf nf q input ->
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 exists final,
 ((exists value, run_context 110 artifact hash sf nf (context_entry q (stored_value input) static_values hp tail) = Halt value final /\ stack final = value::tail) \/
  (exists message, run_context 110 artifact hash sf nf (context_entry q (stored_value input) static_values hp tail) = Aborted message final /\ stack final = tail)) /\
 (exists added, length added = 4%nat /\ heap final = hp++added) /\
 statics final = static_values.
Proof.
 intros. apply (context_frame_from_classification hp tail static_values hash hash sf nf q
 (effective_reserved hash input) (input_kind input) (stored_value input) (input_trace input)).
 - (* The helper's headroom assertion holds on the legal domain: the updated
      reservation stays representable, so the guard's comparison is true and
      the abort branch is unreachable here. *)
   apply legal_update_fits. assumption.
 - apply context_method_classified; assumption.
Qed.
Theorem complete_context_existing_object_unchanged : forall hash sf nf q input static_values hp tail final index,
 legal_inputs hash sf nf q input ->
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 (index < length hp)%nat ->
 ((exists value, run_context 110 artifact hash sf nf (context_entry q (stored_value input) static_values hp tail) = Halt value final) \/
  (exists message, run_context 110 artifact hash sf nf (context_entry q (stored_value input) static_values hp tail) = Aborted message final)) ->
 nth_error (heap final) index = nth_error hp index.
Proof.
 intros hash sf nf q input static_values hp tail final index Hlegal Hstatic Hindex Hfinal.
 destruct (complete_context_frame hash sf nf q input static_values hp tail Hlegal Hstatic)
 as [s [Hrun [[added [Hlen Hheap]] Hstat]]].
 assert (s = final).
 { destruct Hrun as [[value [Hrun Hstack]]|[message [Hrun Hstack]]];
   destruct Hfinal as [[v Hfinal]|[m Hfinal]]; rewrite Hrun in Hfinal; inversion Hfinal; reflexivity. }
 subst s. rewrite Hheap. apply heap_append_preserves_existing. assumption.
Qed.
Theorem complete_context_return_stack : forall hash sf nf q input static_values hp tail final value,
 legal_inputs hash sf nf q input ->
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 run_context 110 artifact hash sf nf (context_entry q (stored_value input) static_values hp tail) = Halt value final ->
 stack final = value::tail.
Proof.
 intros hash sf nf q input static_values hp tail final value Hlegal Hstatic Hfinal.
 destruct (complete_context_frame hash sf nf q input static_values hp tail Hlegal Hstatic)
 as [s [Hrun Hrest]].
 destruct Hrun as [[v [Hrun Hstack]]|[m [Hrun Hstack]]];
 rewrite Hrun in Hfinal; inversion Hfinal; subst; assumption.
Qed.
Theorem complete_context_fresh_allocations : forall hash sf nf q input static_values hp tail,
 legal_inputs hash sf nf q input ->
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 exists final,
 ((exists value, run_context 110 artifact hash sf nf (context_entry q (stored_value input) static_values hp tail) = Halt value final) \/
  (exists message, run_context 110 artifact hash sf nf (context_entry q (stored_value input) static_values hp tail) = Aborted message final)) /\
 (forall index, (index < 4)%nat -> nth_error hp (length hp+index) = None /\
    exists value, nth_error (heap final) (length hp+index) = Some value) /\
 (forall old index, (old < length hp)%nat -> (index < 4)%nat ->
    VRef old <> VRef (length hp+index)).
Proof.
 intros hash sf nf q input static_values hp tail Hlegal Hstatic.
 destruct (complete_context_frame hash sf nf q input static_values hp tail Hlegal Hstatic)
 as [s [Hrun [[added [Hlen Hheap]] Hstat]]].
 exists s. split.
 - destruct Hrun as [[v [Hrun Hstack]]|[m [Hrun Hstack]]]; eauto.
 - split.
   + intros index Hindex. rewrite Hheap. apply fresh_appended_index. lia.
   + intros. apply fresh_index_not_caller_alias. assumption.
Qed.

Theorem complete_context_refines_isolated_vm : forall hash sf nf q input static_values hp tail,
 legal_inputs hash sf nf q input ->
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 observe (run_context 110 artifact hash sf nf (context_entry q (stored_value input) static_values hp tail)) =
 observe (run_vm 130 CapContextIsolatedArtifact.artifact
   (initial_vm hash sf nf q (stored_value input) static_values)).
Proof.
 intros. rewrite complete_context_observation by assumption.
 symmetry. apply CapContextIsolatedArtifact.vm_method_classified; assumption.
Qed.
Theorem initialized_helper_context : forall hp tail initialized hash sf nf q input,
 run_init 182 CapContextArtifact.initializer_code (initializer_entry hp tail) = InitReturned initialized ->
 legal_inputs hash sf nf q input ->
 exists final,
 ((exists value, run_context 110 artifact hash sf nf
   (context_entry q (stored_value input) (lookup_init_static initialized) (init_heap initialized) tail) = Halt value final /\ stack final = value::tail) \/
  (exists message, run_context 110 artifact hash sf nf
   (context_entry q (stored_value input) (lookup_init_static initialized) (init_heap initialized) tail) = Aborted message final /\ stack final = tail)) /\
 (exists added, length added = 6%nat /\ heap final = hp++added) /\
 statics final = lookup_init_static initialized.
Proof.
 intros hp tail initialized hash sf nf q input Hinit Hlegal.
 pose proof (CapContextArtifact.actual_initializer_static_entry hp tail initialized Hinit) as [Hstatic Hstack].
 destruct (CapContextArtifact.actual_initializer_complete hp tail) as [initial [a [b [Hinitial [Hheap Hrest]]]]].
 rewrite Hinit in Hinitial. inversion Hinitial; subst initial.
 destruct (complete_context_frame hash sf nf q input (lookup_init_static initialized) (init_heap initialized) tail Hlegal Hstatic)
 as [final [Hrun [[added [Hlen HfinalHeap]] Hstat]]].
 exists final. split; [exact Hrun|]. split; [|exact Hstat].
 exists (a::b::added). split; [cbn [length]; lia|].
 rewrite HfinalHeap, Hheap, <- app_assoc. reflexivity.
Qed.

"""

CONTEXT_THEOREM_NAMES = [
    "context_same_hash_classified", "context_different_hash_classified", "context_absent_classified",
    "context_method_classified", "complete_context_observation", "complete_context_frame",
    "complete_context_existing_object_unchanged", "complete_context_return_stack",
    "complete_context_fresh_allocations", "complete_context_refines_isolated_vm", "initialized_helper_context"]


def render_helper_header(program, imports):
    return ("From Coq Require Import ZArith List Bool Lia.\nRequire Import " + imports +
            ".\nImport ListNotations.\nOpen Scope Z_scope.\nDefinition artifact : list nat := [" +
            ";".join(str(b)+"%nat" for b in program["bytes"]) + "].\n")


def render_isolated_certificate(program):
    classification = method.COMPOSITION_PROOFS.split("Theorem vm_method_classified", 1)[1].split(
        "Theorem complete_helper_reference_refinement", 1)[0]
    return (render_helper_header(program, "IntegerSemantics CapArithmetic CapMethodVm") +
            method.VM_PROOFS + "Theorem vm_method_classified" + classification)


def render_context_certificate(program):
    return (render_helper_header(program, "IntegerSemantics CapArithmetic CapMethodVm CapContext CapContextArtifact CapContextIsolatedArtifact") +
            CONTEXT_PROOFS + CONTEXT_COMPOSITION)



COUNTER_DEFINITIONS = r"""
Definition frame_statics (slot : nat) := if Nat.eqb slot 38 then Some (VBuffer [33%nat]) else None.
Definition frame_hash := repeat 1%nat 32.
Definition caller_heap := [obj ArrayKind [VInt 111];obj StructKind [VRef 0]].
Definition caller_tail := [VRef 1;VInt 7].
Definition before_budget := VWire StructKind [VBytes frame_hash;VInt 40].
Definition after_budget := VWire StructKind [VBytes frame_hash;VInt 60].
Definition caller_example := observe_context (run_context 110 artifact frame_hash 50 10
 (context_entry 30 before_budget frame_statics caller_heap caller_tail)).
Definition expected_caller_example := Some (context_view
 (Returned (VInt 20) after_budget [ReadStorage before_budget;Deserialized before_budget;Serialized after_budget;WroteStorage after_budget])
 (VInt 20::caller_tail)
 (caller_heap++[tx_object frame_hash 50 10;obj StructKind [VBytes frame_hash;VInt 60];tx_object frame_hash 50 10;tx_object frame_hash 50 10]) frame_statics).
"""
COUNTER_PROOF = r"""
Example actual_nonempty_caller_frame : caller_example = expected_caller_example.
Proof. vm_compute. reflexivity. Qed.
"""
CONTEXT_THEOREM_NAMES.append("actual_nonempty_caller_frame")


def contextual_semantic_controls(program, work):
    model=(work/"CapContext.v").read_bytes().decode()
    dropped=copy.deepcopy(program)
    # The write that installs the updated reservation is the SETITEM at 19159;
    # replacing it with DROP leaves the caller heap object at its stored value.
    # The pre-sweep target (18021) predates the 2026-11-16 design-phase legacy
    # sweep, which moved the helper to [18900,19181); applying the old offset
    # now lands outside the method body, and the control would prove nothing.
    dropped["bytes"][19159-method.START]=0x45
    return_site="Halt value (with_stack s (pc s+width)%nat (value::rest))"
    getter_site="Continue (with_stack allocated (pc s+width)%nat (reference::stack s))"
    require(model.count(return_site)==1 and model.count(getter_site)==1,"Context control sites changed")
    mutations=[("DropReservationHeapWrite",dropped,model),
        ("DiscardCallerStack",program,model.replace(return_site,"Halt value (with_stack s (pc s+width)%nat [])")),
        ("ReuseCallerTransactionReference",program,model.replace(getter_site,"Continue (with_stack s (pc s+width)%nat (VRef 0::stack s))"))]
    reports=[]
    for name,changed,changed_model in mutations:
        directory=work/name;directory.mkdir()
        for path in work.iterdir():
            if path.is_file() and path.suffix in (".vo",".vos",".vok",".glob"):
                shutil.copy2(path,directory/path.name)
        (directory/"CapContext.v").write_bytes(changed_model.encode())
        result,log=method._kernel_command(["coqc","-q","CapContext.v"],directory,"model.log")
        method._require_kernel_success(result,log)
        definitions=render_helper_header(changed,"IntegerSemantics CapArithmetic CapMethodVm CapContext")+COUNTER_DEFINITIONS
        (directory/"MutantDefinitions.v").write_bytes(definitions.encode())
        result,log=method._kernel_command(["coqc","-q","MutantDefinitions.v"],directory,"definitions.log")
        method._require_kernel_success(result,log)
        refutation=definitions+"\nExample mutant_changes_caller_observation : caller_example <> expected_caller_example.\nProof. vm_compute. congruence. Qed.\nPrint Assumptions mutant_changes_caller_observation.\n"
        (directory/"MutantRefutation.v").write_bytes(refutation.encode())
        result,log=method._kernel_command(["coqc","-q","MutantRefutation.v"],directory,"refutation.log")
        method._require_kernel_success(result,log)
        require("Closed under the global context" in result.stdout,"Mutant refutation is not closed")
        result,log=method._kernel_command(["coqchk","-silent","MutantRefutation"],directory,"refutation-coqchk.log")
        method._require_kernel_success(result,log)
        (directory/"MutantPositive.v").write_bytes((definitions+COUNTER_PROOF).encode())
        rejected,log=method._kernel_command(["coqc","-q","MutantPositive.v"],directory,"rejected.log")
        message=rejected.stdout+rejected.stderr
        require(rejected.returncode!=0 and "Unable to unify" in message and
                not any(marker in message for marker in ("Syntax error","Cannot find","not found","Anomaly")),
                "Context mutant not semantically rejected: "+name+"; see "+str(log))
        reports.append(dict(name=name,definitionsCompiled=True,certificateRejected=True,
                            refutationKernelChecked=True,refutationSha256=digest(refutation.encode()),
                            modelSha256=digest(changed_model.encode()),
                            methodSha256=digest(bytes(changed["bytes"])),log=str(log)))
    return reports


def run_complete_proofs(inventory, output_dir, controls=False):
    # No successful complete-context receipt exists until every stage below
    # succeeds. Reuse the already checked initializer kernel directory.
    receipt=run_proofs(inventory,output_dir,controls=controls)
    work=Path(receipt["kernelDirectory"])
    program=bind_helper(inventory)
    artifacts={"CapContextIsolatedArtifact":render_isolated_certificate(program),
               "CapContextHelperArtifact":render_context_certificate(program)+COUNTER_DEFINITIONS+COUNTER_PROOF}
    declarations=receipt["assumptionDeclarations"]
    artifact_hashes={}
    for module,source in artifacts.items():
        require(not re.search(r"\b(?:Admitted|Axiom|Axioms|admit|Parameter|Parameters|Abort)\b",source),"Context proof escape")
        (work/(module+".v")).write_bytes(source.encode())
        declarations[module]=method.declared_names(source)
        artifact_hashes[module]=digest(source.encode())
        result,log=method._kernel_command(["coqc","-q",module+".v"],work,module+".log",timeout=KERNEL_TIMEOUT)
        method._require_kernel_success(result,log)
    require(set(CONTEXT_THEOREM_NAMES)<=set(declarations["CapContextHelperArtifact"]),"Missing context theorem")
    result,log=method._kernel_command(["coqchk","-silent","CapContextHelperArtifact"],work,"context-coqchk.log",timeout=KERNEL_TIMEOUT)
    method._require_kernel_success(result,log)
    assumptions="Require Import "+" ".join(declarations)+".\n"+"\n".join(
        "Print Assumptions "+module+"."+name+"." for module,names in declarations.items() for name in names)+"\n"
    (work/"CompleteContextAssumptions.v").write_bytes(assumptions.encode())
    result,log=method._kernel_command(["coqc","-q","CompleteContextAssumptions.v"],work,"complete-assumptions.log")
    method._require_kernel_success(result,log)
    closed=sum(line.strip()=="Closed under the global context" for line in result.stdout.splitlines())
    require(closed==sum(map(len,declarations.values())),"Incomplete complete-context assumptions inventory")
    extra_controls=contextual_semantic_controls(program,work) if controls else []
    require(bind_helper(inventory)==program,"Helper changed during context proof")
    for path,expected in receipt["toolInputSha256"].items():
        require(digest(Path(path).read_bytes())==expected,"Context tool changed during proof: "+path)
    for name,expected in receipt["modelSha256"].items():
        require(digest((ROOT/"coq"/(name+".v")).read_bytes())==expected,"Context model changed during proof: "+name)
    receipt.update(scope="complete-helper-context-and-initializer-reference-refinement",helperContextVerified=True,
        methodRange=[method.START,method.END],methodByteCount=len(program["bytes"]),methodInstructionCount=len(program["instructions"]),
        methodSha256=program["methodSha256"],contextArtifactSha256=artifact_hashes,closedAssumptionCount=closed,
        theoremNames=THEOREM_NAMES+CONTEXT_THEOREM_NAMES,semanticControls=receipt["semanticControls"]+extra_controls,
        established=receipt["established"]+[f"all {len(program['instructions'])} helper instructions classified in arbitrary caller heap and stack",
            "three fresh transaction projections and one fresh budget object", "caller objects and static fields preserved",
            "success returns exactly one value above caller stack", "abort preserves caller stack",
            "legal-domain observations equal the isolated helper", "initializer establishes the helper static precondition"],
        excludedCorrespondence=["actual ApplicationEngine and resource/gas behavior", "mutable Buffer identity",
            "actual native binary codecs and storage handlers", "caller reachability and valid persisted budget invariant",
            "actual C# CALL frame/heap correspondence", "all 109 public ABI entrypoints"])
    return receipt

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory",required=True);parser.add_argument("--output-dir",required=True)
    parser.add_argument("--json-report",required=True);parser.add_argument("--controls",action="store_true")
    parser.add_argument("--initializer-only",action="store_true",help="Check only the complete initialization certificate")
    args=parser.parse_args();report=Path(args.json_report);report.parent.mkdir(parents=True,exist_ok=True)
    failure=dict(scope=(SCOPE if args.initializer_only else "complete-helper-context-and-initializer-reference-refinement"),status="FAIL",kernelChecked=False,initializerReferenceVerified=False,
                 helperContextVerified=False,fullImplementationVerified=False,error="Verification has not completed")
    report.write_text(json.dumps(failure,indent=2)+"\n")
    try:
        path=Path(args.inventory)
        with (gzip.open(path,"rt") if path.suffix==".gz" else path.open()) as stream: inventory=json.load(stream)
        result=(run_proofs if args.initializer_only else run_complete_proofs)(inventory,args.output_dir,controls=args.controls)
        report.write_text(json.dumps(result,indent=2)+"\n");print(json.dumps(result,indent=2));return 0
    except Exception as error:
        failure["error"]=str(error);report.write_text(json.dumps(failure,indent=2)+"\n");print(str(error),file=sys.stderr);return 1

if __name__=="__main__": raise SystemExit(main())
