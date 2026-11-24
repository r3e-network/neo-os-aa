"""Build a permission and frame certificate for every descriptor of a pinned NEF/manifest pair."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

import contract_handoff_proofs as hp
import contract_handoff_source as hs
import entry_dispatch_proofs as dp
import entry_dispatch_source as ds
import nef_decode
from verify import decode_nef

HERE = Path(__file__).resolve().parent
MODELS = ("EntryDispatch", "ContractHandoff", "OrdinaryEntry")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def bind(raw_nef, raw_manifest, nef_hash, manifest_hash):
    if digest(raw_nef) != nef_hash or digest(raw_manifest) != manifest_hash:
        raise ValueError("NEF or manifest differs from the requested artifact")
    nef = decode_nef(raw_nef)
    offsets = {i["offset"] for i in nef_decode.decode_script(nef["script"], len(nef["tokens"]))}
    methods = json.loads(raw_manifest)["abi"]["methods"]
    keys = set()
    for m in methods:
        dp.coq_string(m["name"])
        if not isinstance(m["parameters"], list) or type(m["safe"]) is not bool:
            raise ValueError("invalid descriptor")
        key = (m["name"], len(m["parameters"]))
        if key in keys or key[1] > 65535 or type(m["offset"]) is not int or m["offset"] not in offsets:
            raise ValueError("ambiguous key, invalid arity or offset")
        keys.add(key)
    init = [m for m in methods if m["name"] == "_initialize" and not m["parameters"]]
    if len(init) != 1 or init[0]["returntype"] != "Void":
        raise ValueError("expected one void initializer of arity zero")
    return methods, init[0]["offset"], digest(nef["script"])


def render(methods, init, handoff, dispatch):
    lines = ["""From Coq Require Import List String NArith PeanoNat Bool.
Require Import EntryDispatch ContractHandoff OrdinaryEntry.
Import ListNotations. Open Scope string_scope.""",
             "Definition hp := " + hp.program_expression(handoff) + ".",
             "Definition dp := " + dp.program_expression(dispatch) + ".",
             "Definition abi := [" + ";".join(map(dp.descriptor, methods)) + "].",
             f"Definition init : option nat := Some {init}.",
             'Example init_lookup : init = option_map D.descriptor_offset (D.abi_select abi "_initialize" 0).',
             "Proof. vm_compute. reflexivity. Qed."]
    for i,m in enumerate(methods):
        name, arity = dp.coq_string(m["name"]), len(m["parameters"])
        desc = f"d{i}"
        lines += [f"Definition {desc} := {dp.descriptor(m)}.",
                  f"Example lookup{i} : D.abi_select abi {name} {arity} = Some {desc}.",
                  "Proof. vm_compute. reflexivity. Qed."]
        lhs = f"enter hp dp abi {name} args flags caller tail ids init b a s w fee count"
        header = f"Theorem entry{i} : forall args flags caller tail ids b a s w fee count,"
        if m["name"].startswith("_"):
            lines += [header, lhs + " = NotCallable.",
                      "Proof. intros. apply private_name. reflexivity. Qed."]
        else:
            lines += [header,
                      f"List.length args = {arity} -> D.valid_flags flags ->",
                      lhs + f" = specification {desc} args flags caller tail ids init b a s w fee count.",
                      f"Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;",
                      f" rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup{i}]. Qed."]
    for i, name in enumerate(dict.fromkeys(m["name"] for m in methods)):
        counts = [len(m["parameters"]) for m in methods if m["name"] == name]
        q = dp.coq_string(name)
        literal = "["+";".join(map(str, counts))+"]"
        lines += [f"Example arities{i} : arities_for abi {q} = {literal}.",
                  "Proof. vm_compute. reflexivity. Qed.",
                  f"Theorem reject{i} : forall args flags caller tail ids,"
                  + ("" if name.startswith("_") else f" ~ In (List.length args) {literal} ->"),
                  f"D.source_call dp abi {q} args flags caller tail ids init = None.",
                  "Proof. intros. apply rejected_dispatch. " +
                  ("left. reflexivity." if name.startswith("_") else f"right. now rewrite arities{i}.") + " Qed."]
    text = "\n".join(lines)
    return text + "\n" + "\n".join(f"Print Assumptions {n}." for n in dp.declarations(text)) + "\n"


def run(args):
    args.output.mkdir(parents=True, exist_ok=True)
    receipt = args.output / "result.json"
    receipt.write_text(json.dumps({"status":"INCOMPLETE","implementationVerified":False}) + "\n")
    methods, init, script_hash = bind(args.nef.read_bytes(), args.manifest.read_bytes(),
                                      args.nef_sha256, args.manifest_sha256)
    with tempfile.TemporaryDirectory(dir=args.output) as tmp:
        work = Path(tmp)
        # Both frontends must identify the exact same engine, not unrelated semantic versions.
        if (hs.CORE_COMMIT,hs.VM_COMMIT) != (ds.CORE_COMMIT,ds.VM_COMMIT):
            raise ValueError("different source revisions")
        h, hrows = hs.project_production(args.output / "source")
        d, drows = ds.project_production(args.output / "source")
        for key in hrows.keys() & drows.keys():
            if hrows[key]["sha256"] != drows[key]["sha256"]:
                raise ValueError("conflicting source pin: " + key)
        certificate = render(methods, init, h["program"], d["program"])
        artifact = "OrdinaryEntryArtifact"
        for name in (*MODELS,artifact):
            data = certificate if name == artifact else (HERE/"coq"/(name+".v")).read_text()
            (work/(name+".v")).write_text(data)
            with (args.output/(name+".log")).open("w") as log:
                subprocess.run(["coqc","-q",name+".v"],cwd=work,stdout=log,stderr=log,check=True)
            logtext = (args.output/(name+".log")).read_text()
            if name == artifact and (logtext.count("Closed under the global context") != len(dp.declarations(data))
                                     or "Axioms:" in logtext):
                raise ValueError("unclosed artifact declarations")
        subprocess.run(["coqchk","-silent",artifact],cwd=work,check=True)
        (args.output/(artifact+".v")).write_text(certificate)
    if digest(args.nef.read_bytes()) != args.nef_sha256 or digest(args.manifest.read_bytes()) != args.manifest_sha256:
        raise ValueError("input artifact changed during proof")
    result = dict(status="PASS_SCOPED", implementationVerified=False, nefSha256=args.nef_sha256,
                  manifestSha256=args.manifest_sha256, scriptSha256=script_hash,
                  coreCommit=ds.CORE_COMMIT, vmCommit=ds.VM_COMMIT, sourceSha256={
                      k:v["sha256"] for k,v in (hrows | drows).items()},
                  modelSha256={n:digest((HERE/"coq"/(n+".v")).read_bytes()) for n in MODELS},
                  certificateSha256=digest(certificate.encode()), coqchkPassed=True,
                  methods=[dict(name=m["name"],arity=len(m["parameters"]),offset=m["offset"],
                                theorem=f"entry{i}",ordinaryCall="reserved" if m["name"].startswith("_")
                                else "safe" if m["safe"] else "caller-permission") for i,m in enumerate(methods)],
                  boundary="Ordinary dynamic call after interop conversion, valid flags and exact arity. "
                           "CanCall and blocked inputs are observations. Frame construction assumes available "
                           "resources, fresh identities, coherent ABI/initializer lookup and the default ordinary "
                           "runtime. No initializer, body, fee or rollback execution.",
                  rejectionNames=len({m["name"] for m in methods}),
                  rejectionScope="Any unlisted arity; reserved names for every arity. No target frame returned.",
                  completeEntrypointProofs=0)
    receipt.write_text(json.dumps(result,indent=2)+"\n")
    print(f"Kernel checked {len(methods)} descriptor cases; scope: ordinary call admission and frame construction.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("nef","manifest","output"):
        parser.add_argument("--"+key, type=Path, required=True)
    for key in ("nef-sha256","manifest-sha256"):
        parser.add_argument("--"+key, required=True)
    run(parser.parse_args())
