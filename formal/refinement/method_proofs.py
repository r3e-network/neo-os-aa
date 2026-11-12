#!/usr/bin/env python3
"""Complete-helper raw-byte reference execution and kernel certificate runner.

This module never equates this reference machine with ApplicationEngine. Native
codecs are explicit structured-wire contracts; malformed ledgers are not repaired.
"""
from dataclasses import dataclass
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import re
import tempfile

import nef_decode

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
START, END = 17762, 18043
METHOD = "SmartAccount.SmartAccount.CapReimbursementToActualCost(System.Numerics.BigInteger)"
LIMIT = 1 << 255
ERROR = b"Reimbursement exceeds actual gas cost"
# The headroom assertion added after the charge region aborts with its own
# message, so an accumulation that would leave the signed range is rejected
# before the ADD runs rather than faulting inside it.
MARGIN_ERROR = b"Reimbursement budget exceeds VM integer limit"
NATIVE = "0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def repo_relative_hashes(hashes):
    """Keep stable repository identities without leaking host paths."""
    result = {}
    root = REPO.resolve()
    for path, expected in hashes.items():
        candidate = Path(path).resolve()
        try:
            relative = candidate.relative_to(root)
        except ValueError:
            continue
        result[relative.as_posix()] = expected
    return result


def bind_method(inventory):
    """Hash and parse one captured payload per input; never reread to decode.

    run_proofs performs a separate final binding to detect persistent drift
    during kernel verification. Every accepted identity below comes from the
    exact bytes consumed by this binding, including the full NEF container.
    """
    snapshots = {filename: Path(filename).read_bytes() for filename in inventory["inputs"]}
    input_hashes = {filename:digest(raw) for filename, raw in snapshots.items()}
    for filename, expected in inventory["inputs"].items():
        require(input_hashes[filename] == expected, "Inventory input drift: " + filename)
    paths = [name for name, expected in inventory["inputs"].items()
             if name.endswith("SmartAccountV3.nef") and expected == inventory["nef"]["sha256"]]
    require(len(paths) == 1, "Ambiguous actual NEF")
    spec = importlib.util.spec_from_file_location("cap_method_binding", ROOT / "verify.py")
    binding = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(binding)
    raw = snapshots[paths[0]]
    require(digest(raw) == inventory["nef"]["sha256"], "Actual NEF container identity mismatch")
    decoded = binding.decode_nef(raw)
    script = decoded["script"]
    require(script.hex() == inventory["nef"]["scriptHex"], "Raw NEF script differs from inventory")
    require(digest(script) == inventory["nef"]["scriptSha256"], "Script digest differs")
    instructions = nef_decode.decode_script(script, len(decoded["tokens"]))
    require(len(instructions) == len(inventory["nef"]["instructions"]) and
            all(all(exported.get(key) == value for key, value in actual.items())
                for actual, exported in zip(instructions, inventory["nef"]["instructions"])),
            "Instruction inventory differs from bytes")
    focused = [item for item in inventory["sourceMap"]["focusedMethods"] if item["id"] == METHOD]
    require(len(focused) == 1 and focused[0]["range"] == f"{START}-{END-1}", "Full helper boundary mismatch")
    region = [item for item in instructions if START <= item["offset"] < END]
    require(region[0]["offset"] == START and region[-1]["offset"] + region[-1]["size"] == END,
            "Method boundary is not an instruction boundary")
    require(len(region) == len(focused[0]["instructions"]) and
            all(all(exported.get(key) == value for key, value in actual.items())
                for actual, exported in zip(region, focused[0]["instructions"])),
            "Focused method instructions differ")
    for index, name in [(3, "serialize"), (4, "deserialize")]:
        expected = dict(hash=NATIVE, method=name, parametersCount=1, hasReturnValue=True, callFlags=15)
        require(inventory["nef"]["tokens"][index] == expected, "Native token effect contract mismatch")
    normalized_tokens = [dict(hash="0x" + bytes.fromhex(token["hashLittleEndian"])[::-1].hex(),
                              **{key: token[key] for key in ("method", "parametersCount", "hasReturnValue", "callFlags")})
                         for token in decoded["tokens"]]
    require(normalized_tokens == inventory["nef"]["tokens"], "Actual NEF token table differs")
    manifests = [name for name, expected in inventory["inputs"].items()
                 if name.endswith("SmartAccountV3.manifest.json")
                 and expected == inventory["manifest"]["sha256"]]
    require(len(manifests) == 1, "Ambiguous actual manifest")
    manifest_raw = snapshots[manifests[0]]
    require(json.loads(manifest_raw)["abi"]["methods"] == inventory["manifest"]["methods"],
            "Actual full manifest differs from inventory")
    require(inventory["sourceMap"]["exactByteMatch"] and inventory["sourceMap"]["exactManifestMatch"],
            "Source/debug artifact correspondence unavailable")
    return dict(start=START, end=END, bytes=list(script[START:END]), instructions=region,
                nefSha256=digest(raw), scriptSha256=digest(script), methodSha256=digest(script[START:END]),
                manifestSha256=digest(manifest_raw), inputSha256=input_hashes,
                tokens=decoded["tokens"])


@dataclass(frozen=True)
class Ledger:
    tx_hash: bytes
    reserved: int
    kind: str = "Array"


@dataclass(frozen=True)
class Ref:
    index: int


class ReferenceFault(Exception):
    pass


def execute(program, *, requested, system_fee, network_fee, tx_hash, stored, max_steps=200, static_values=None):
    """Interpret every instruction. CALLT consumes actual values, never expected output.

    Array/Struct references alias a heap object. Wire Ledger is the documented
    codec abstraction, not Neo's binary serialization. Storage commit is external;
    the returned stored value only changes when the actual PUT instruction runs.
    """
    code = bytes(program)
    instructions = {item["offset"]: item for item in nef_decode.decode_script(code, 7)}
    stack, locals_, args = [requested], [], []
    heap = [("Array", [tx_hash, None, None, None, system_fee, network_fee, None, None])]
    effects, pcs = [], []
    storage, pc, status, result, error = stored, 0, "RUNNING", None, None
    context = object()
    static_values = {38: bytearray(b"\x21")} if static_values is None else static_values

    def pop():
        if not stack:
            raise ReferenceFault("stack underflow")
        return stack.pop()

    def integer(value):
        if type(value) is not int or not -LIMIT <= value < LIMIT:
            raise ReferenceFault("Integer type or range")
        return value

    def allocate(kind, values):
        heap.append((kind, list(values)))
        return Ref(len(heap)-1)

    def object_at(value):
        if not isinstance(value, Ref) or not 0 <= value.index < len(heap):
            raise ReferenceFault("Array/Struct reference required")
        return heap[value.index]

    try:
        integer(requested)
        for _ in range(max_steps):
            if pc not in instructions:
                raise ReferenceFault("invalid instruction boundary")
            item = instructions[pc]
            pcs.append(pc + START)
            op, operand = item["opcode"], bytes.fromhex(item["operandHex"])
            next_pc = pc + item["size"]
            if op == 0x57:
                if locals_ or args:
                    raise ReferenceFault("duplicate INITSLOT")
                locals_ = [None] * operand[0]
                args = [pop() for _ in range(operand[1])]
            elif op in (0x00, 0x01):
                stack.append(int.from_bytes(operand, "little", signed=True))
            elif 0x10 <= op <= 0x20:
                stack.append(op - 0x10)
            elif op == 0x0b:
                stack.append(None)
            elif op == 0x0c:
                stack.append(operand)
            elif op == 0x5f:
                index = int.from_bytes(operand, "little")
                if index not in static_values:
                    raise ReferenceFault("unknown static field")
                stack.append(static_values[index])
            elif 0x68 <= op <= 0x6e:
                stack.append(locals_[op-0x68])
            elif 0x70 <= op <= 0x76:
                locals_[op-0x70] = pop()
            elif 0x78 <= op <= 0x7e:
                stack.append(args[op-0x78])
            elif op in (0x6f, 0x77, 0x7f):
                # The compact slot opcodes stop at six; a method with a seventh
                # local uses the generic form carrying the slot as an operand.
                slot = operand[0]
                target = args if op == 0x7f else locals_
                if slot >= len(target):
                    raise ReferenceFault("slot out of range")
                if op == 0x77:
                    target[slot] = pop()
                else:
                    stack.append(target[slot])
            elif op in (0x97, 0x98):
                right, left = pop(), pop()
                equal = type(left) is type(right) and left == right
                stack.append(equal if op == 0x97 else not equal)
            elif op in (0x22, 0x24, 0x26):
                take = True
                if op != 0x22:
                    condition = pop()
                    if type(condition) is not bool:
                        raise ReferenceFault("Boolean branch contract")
                    take = condition if op == 0x24 else not condition
                if take:
                    next_pc = pc + int.from_bytes(operand, "little", signed=True)
            elif op == 0x4a:
                value = pop(); stack.extend([value, value])
            elif op == 0x45:
                pop()
            elif op == 0x51:
                a, b, c = pop(), pop(), pop(); stack.extend([b, a, c])
            elif op == 0x4e:
                a, b = pop(), pop(); stack.extend([a, b, a])
            elif op == 0x50:
                a, b = pop(), pop(); stack.extend([a, b])
            elif op == 0xc0:
                length = integer(pop())
                if length < 0 or length > len(stack):
                    raise ReferenceFault("PACK bounds")
                stack.append(allocate("Array", [pop() for _ in range(length)]))
            elif op == 0xce:
                index = integer(pop()); _, values = object_at(pop())
                if not 0 <= index < len(values):
                    raise ReferenceFault("PICKITEM bounds")
                stack.append(values[index])
            elif op == 0xd0:
                value, index, receiver = pop(), integer(pop()), pop()
                _, values = object_at(receiver)
                if not 0 <= index < len(values):
                    raise ReferenceFault("SETITEM bounds")
                # Only scalar fields occur in this helper; no Struct value-cloning
                # claim is made for arbitrary nested object values.
                if isinstance(value, Ref):
                    raise ReferenceFault("nested field outside helper contract")
                values[index] = value
            elif op == 0xa8:
                shift, value = integer(pop()), integer(pop())
                if not 0 <= shift <= 256:
                    raise ReferenceFault("shift out of range")
                stack.append(integer(value << shift))
            elif op in (0x9e, 0x9f, 0xa0, 0xb9, 0xba, 0xb7):
                right, left = integer(pop()), integer(pop())
                if op == 0xb7:
                    stack.append(left > right)
                else:
                    value = {0x9e: lambda: left+right, 0x9f: lambda: left-right,
                             0xa0: lambda: left*right, 0xb9: lambda: min(left,right),
                             0xba: lambda: max(left,right)}[op]()
                    stack.append(integer(value))
            elif op == 0xb6:
                right, left = integer(pop()), integer(pop())
                stack.append(left <= right)
            elif op == 0x41:
                if operand == bytes.fromhex("2d510830"):
                    effects.append("GetScriptContainer"); stack.append(Ref(0))
                elif operand == bytes.fromhex("9bf667ce"):
                    effects.append("GetContext"); stack.append(context)
                elif operand == bytes.fromhex("925de831"):
                    ctx, key = pop(), pop()
                    if ctx is not context or type(key) is not bytearray or key != b"\x21":
                        raise ReferenceFault("Storage.Get context/key contract")
                    effects.append("Storage.Get"); stack.append(storage)
                elif operand == bytes.fromhex("e63f1884"):
                    ctx, key, value = pop(), pop(), pop()
                    if ctx is not context or type(key) is not bytearray or key != b"\x21" or not isinstance(value, Ledger):
                        raise ReferenceFault("Storage.Put effect contract")
                    effects.append("Storage.Put"); storage = value
                else:
                    raise ReferenceFault("unknown syscall")
            elif op == 0x37:
                token, value = int.from_bytes(operand, "little"), pop()
                if token == 4:
                    if not isinstance(value, Ledger) or value.kind not in ("Array", "Struct"):
                        raise ReferenceFault("typed ledger codec contract")
                    effects.append("Deserialize")
                    stack.append(allocate(value.kind, [value.tx_hash, value.reserved]))
                elif token == 3:
                    kind, values = object_at(value)
                    if len(values) != 2 or not isinstance(values[0], bytes) or type(values[1]) is not int:
                        raise ReferenceFault("typed ledger serialization contract")
                    effects.append("Serialize")
                    stack.append(Ledger(values[0], values[1], kind))
                else:
                    raise ReferenceFault("unknown native token")
            elif op == 0xe0:
                error = pop(); status = "ABORT"; break
            elif op == 0x40:
                if len(stack) != 1:
                    raise ReferenceFault("return stack shape")
                result = pop(); status = "HALT"; break
            else:
                raise ReferenceFault("unsupported opcode")
            pc = next_pc
        else:
            raise ReferenceFault("reference fuel exhausted")
    except (ReferenceFault, IndexError) as failure:
        status, error = "FAULT", str(failure)
    return dict(status=status, result=result, stored=storage, effects=effects,
                instructionOffsets=pcs, error=error, heap=heap, locals=locals_)


SOURCE_PROOFS = r"""
Ltac source_norm := cbn [source initial_source eval_expr eval_args bind
 with_local with_heap with_effect with_storage allocate deserialize serialize
 read_field write_field get_storage put_storage value_eqb scalar tx_object
 change pc stack statics arguments locals heap storage effects object_kind fields
 skipn firstn nth_error repeat length app Nat.eqb Nat.leb Nat.ltb Nat.add Nat.sub Nat.mul
 andb orb negb Bool.eqb binary_value forallb].
Ltac state_norm := cbv [with_stack with_local with_heap with_effect with_storage change
  pc stack arguments locals heap storage effects statics object_kind fields tx_object
  firstn skipn nth_error length app repeat Nat.add Nat.sub Nat.mul].
Theorem source_present_classified : forall hash old sf nf q r kind,
 observe (run_source 48 source (initial_source hash sf nf q (VWire kind [VBytes old;VInt r]))) =
 classified (if bytes_eqb old hash then old else hash) sf nf q
 (if bytes_eqb old hash then r else 0) kind
 (VWire kind [VBytes old;VInt r]) [ReadStorage (VWire kind [VBytes old;VInt r]);Deserialized (VWire kind [VBytes old;VInt r])].
Proof.
 intros. destruct (bytes_eqb old hash) eqn:E.
 (* Same transaction hash: the stored reservation is the effective one. The
    headroom assertion is decided by a case split, because neither operand is a
    numeral: the rejection branch is the classification's own rejection. *)
 - destruct (0 <? charge_expression (sf+nf) q r) eqn:Hguard;
   unfold charge_expression in Hguard; cbn [repeat] in E; unfold initial_source, source;
   repeat (rewrite run_source_one_step; source_norm; rewrite ?E, ?Hguard; source_norm; state_norm);
   unfold classified, charge_expression, vm_max; rewrite Hguard;
   destruct (vm_leb r (1 * 2 ^ 254 - 1 + 1 * 2 ^ 254 - Z.min q (Z.max (sf+nf-r) 0 + (1 - Z.min (sf+nf) 1) * q))) eqn:Hmargin;
   cbn [observe]; source_norm; reflexivity.
 (* Different hash: the helper resets the reservation to zero first. *)
 - destruct (0 <? charge_expression (sf+nf) q 0) eqn:Hguard;
   unfold charge_expression in Hguard; cbn [repeat] in E; unfold initial_source, source;
   repeat (rewrite run_source_one_step; source_norm; rewrite ?E, ?Hguard; source_norm; state_norm);
   unfold classified, charge_expression, vm_max; rewrite Hguard;
   destruct (vm_leb 0 (1 * 2 ^ 254 - 1 + 1 * 2 ^ 254 - Z.min q (Z.max (sf+nf-0) 0 + (1 - Z.min (sf+nf) 1) * q))) eqn:Hmargin;
   cbn [observe]; source_norm; reflexivity.
Qed.
Print Assumptions source_present_classified.
Theorem source_absent_classified : forall hash sf nf q,
 observe (run_source 48 source (initial_source hash sf nf q VNull)) =
 classified (if bytes_eqb (repeat 0%nat 32) hash then repeat 0%nat 32 else hash)
 sf nf q 0 ArrayKind VNull [ReadStorage VNull].
Proof.
 intros. destruct (bytes_eqb (repeat 0%nat 32) hash) eqn:E;
 destruct (0 <? charge_expression (sf+nf) q 0) eqn:Hguard;
 unfold charge_expression in Hguard; cbn [repeat] in E; unfold initial_source, source.
 all: repeat (rewrite run_source_one_step; source_norm; rewrite ?E, ?Hguard; source_norm; state_norm).
 all: unfold classified, charge_expression, vm_max; rewrite Hguard.
 all: destruct (vm_leb 0 (1 * 2 ^ 254 - 1 + 1 * 2 ^ 254 - Z.min q (Z.max (sf+nf-0) 0 + (1 - Z.min (sf+nf) 1) * q))) eqn:Hmargin.
 all: cbn [observe]; source_norm; reflexivity.
Qed.
Print Assumptions source_absent_classified.

"""

VM_PROOFS = r"""
Ltac norm := cbv [artifact decode vm_step with_stack change with_local with_heap
       with_effect with_storage allocate deserialize serialize read_field write_field
       get_storage put_storage value_eqb scalar jump_target signed_byte signed_short
       pc stack arguments locals heap storage effects object_kind fields tx_object
       skipn firstn nth_error repeat length app Nat.eqb Nat.leb Nat.ltb Nat.add Nat.sub Nat.mul andb orb negb Bool.eqb checked_binary binary_value statics forallb Z.of_nat Pos.of_succ_nat Pos.succ Z.leb Z.compare].
Ltac drive sf nf q r Heq Hstatic := repeat (first [ progress norm
 | progress (rewrite ?Heq, ?Hstatic)
 | match goal with |- context[Z.to_nat ?z] =>
   let n := eval vm_compute in (Z.to_nat z) in progress change (Z.to_nat z) with n end
 |
   match goal with
   | |- observe (run_vm (S ?fuel) ?code ?s) = _ => rewrite (run_vm_one_step fuel code s)
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
 ]).
Theorem vm_same_hash_classified : forall hash old sf nf q r kind static_values,
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 cap_domain (sf+nf) q r ->
 integer_fits (r + charge_expression (sf+nf) q r) ->
 bytes_eqb old hash = true ->
 observe (run_vm 130 artifact (initial_vm hash sf nf q (VWire kind [VBytes old;VInt r]) static_values)) =
 classified old sf nf q r kind (VWire kind [VBytes old;VInt r])
 [ReadStorage (VWire kind [VBytes old;VInt r]);Deserialized (VWire kind [VBytes old;VInt r])].
Proof.
 intros hash old sf nf q r kind static_values Hstatic Hdom Hsum Heq.
 unfold charge_expression in Hsum.
 pose proof (cap_intermediates_representable (sf+nf) q r Hdom) as [H1 [H2 [H3 [H4 [H5 [H6 H7]]]]]].
 assert (Hcost : integer_fits (sf+nf)) by (apply nonnegative_integer_fits; destruct Hdom as [H _]; exact H).
 pose proof integer_limit_positive as HL.
 assert (Hsmall : 8 < integer_limit) by (vm_compute; reflexivity).
 unfold initial_vm, classified, charge_expression, method_error, vm_max.
 drive sf nf q r Heq Hstatic.
 destruct (0 <? Z.min q (Z.max (sf+nf-r) 0+(1-Z.min (sf+nf) 1)*q)) eqn:Hpositive; drive sf nf q r Heq Hstatic.
 all: destruct (vm_leb r (1 * 2 ^ 254 - 1 + 1 * 2 ^ 254 - Z.min q (Z.max (sf+nf-r) 0 + (1 - Z.min (sf+nf) 1) * q))) eqn:Hmargin.
 all: drive sf nf q r Heq Hstatic.
 all: cbv [observe]; norm; reflexivity.
Qed.
Print Assumptions vm_same_hash_classified.
Theorem vm_different_hash_classified : forall hash old sf nf q r kind static_values,
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 cap_domain (sf+nf) q 0 ->
 integer_fits (0 + charge_expression (sf+nf) q 0) ->
 bytes_eqb old hash = false ->
 observe (run_vm 130 artifact (initial_vm hash sf nf q (VWire kind [VBytes old;VInt r]) static_values)) =
 classified hash sf nf q 0 kind (VWire kind [VBytes old;VInt r])
 [ReadStorage (VWire kind [VBytes old;VInt r]);Deserialized (VWire kind [VBytes old;VInt r])].
Proof.
 intros hash old sf nf q r kind static_values Hstatic Hdom Hsum Heq.
 unfold charge_expression in Hsum.
 pose proof (cap_intermediates_representable (sf+nf) q 0 Hdom) as [H1 [H2 [H3 [H4 [H5 [H6 H7]]]]]].
 assert (Hcost : integer_fits (sf+nf)) by (apply nonnegative_integer_fits; destruct Hdom as [H _]; exact H).
 pose proof integer_limit_positive as HL.
 assert (Hsmall : 8 < integer_limit) by (vm_compute; reflexivity).
 unfold initial_vm, classified, charge_expression, method_error, vm_max.
 drive sf nf q constr:(0) Heq Hstatic.
 destruct (0 <? Z.min q (Z.max (sf+nf-0) 0+(1-Z.min (sf+nf) 1)*q)) eqn:Hpositive;
 drive sf nf q constr:(0) Heq Hstatic.
 all: destruct (vm_leb 0 (1 * 2 ^ 254 - 1 + 1 * 2 ^ 254 - Z.min q (Z.max (sf+nf-0) 0 + (1 - Z.min (sf+nf) 1) * q))) eqn:Hmargin.
 all: drive sf nf q constr:(0) Heq Hstatic.
 all: cbv [observe]; norm; reflexivity.
Qed.
Print Assumptions vm_different_hash_classified.

"""


VM_PROOFS += r"""
Theorem vm_absent_classified : forall hash sf nf q static_values,
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 cap_domain (sf+nf) q 0 ->
 integer_fits (0 + charge_expression (sf+nf) q 0) ->
 observe (run_vm 130 artifact (initial_vm hash sf nf q VNull static_values)) =
 classified (if bytes_eqb (repeat 0%nat 32) hash then repeat 0%nat 32 else hash)
 sf nf q 0 ArrayKind VNull [ReadStorage VNull].
Proof.
 intros hash sf nf q static_values Hstatic Hdom Hsum.
 unfold charge_expression in Hsum.
 pose proof (cap_intermediates_representable (sf+nf) q 0 Hdom) as [H1 [H2 [H3 [H4 [H5 [H6 H7]]]]]].
 assert (Hcost : integer_fits (sf+nf)) by (apply nonnegative_integer_fits; destruct Hdom as [H _]; exact H).
 pose proof integer_limit_positive as HL.
 assert (Hsmall : 8 < integer_limit) by (vm_compute; reflexivity).
 destruct (bytes_eqb (repeat 0%nat 32) hash) eqn:Heq;
 cbn [repeat] in Heq;
 unfold initial_vm, classified, charge_expression, method_error, vm_max;
 drive sf nf q constr:(0) Heq Hstatic.
 all: destruct (0 <? Z.min q (Z.max (sf+nf-0) 0+(1-Z.min (sf+nf) 1)*q)) eqn:Hpositive;
 drive sf nf q constr:(0) Heq Hstatic.
 all: destruct (vm_leb 0 (1 * 2 ^ 254 - 1 + 1 * 2 ^ 254 - Z.min q (Z.max (sf+nf-0) 0 + (1 - Z.min (sf+nf) 1) * q))) eqn:Hmargin.
 all: drive sf nf q constr:(0) Heq Hstatic.
 all: cbv [observe]; norm; reflexivity.
Qed.
Print Assumptions vm_absent_classified.

"""

COMPOSITION_PROOFS = r"""
Theorem source_method_classified : forall hash sf nf q input,
 legal_inputs hash sf nf q input ->
 observe (run_source 48 source (initial_source hash sf nf q (stored_value input))) =
 contract_observation hash sf nf q input.
Proof.
 intros hash sf nf q input Hlegal.
 pose proof (classified_refines_contract hash sf nf q input Hlegal) as Hcontract.
 destruct input as [|kind old reserved].
 - cbn [stored_value input_kind effective_reserved input_trace] in *.
   rewrite source_absent_classified.
   replace (if bytes_eqb (repeat 0%nat 32) hash then repeat 0%nat 32 else hash) with hash.
   + exact Hcontract.
   + destruct (bytes_eqb (repeat 0%nat 32) hash) eqn:E; [|reflexivity].
     symmetry. apply bytes_eqb_true. exact E.
 - cbn [stored_value input_kind effective_reserved input_trace] in *.
   rewrite source_present_classified.
   destruct (bytes_eqb old hash) eqn:E.
   + rewrite (bytes_eqb_true old hash E). rewrite (bytes_eqb_true old hash E) in Hcontract. exact Hcontract.
   + exact Hcontract.
Qed.
Print Assumptions source_method_classified.
Theorem vm_method_classified : forall hash sf nf q input static_values,
 legal_inputs hash sf nf q input ->
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 observe (run_vm 130 artifact (initial_vm hash sf nf q (stored_value input) static_values)) =
 contract_observation hash sf nf q input.
Proof.
 intros hash sf nf q input static_values Hlegal Hstatic.
 pose proof (legal_cap_domain hash sf nf q input Hlegal) as Hdomain.
 pose proof (legal_update_fits hash sf nf q input Hlegal) as Hsum.
 pose proof (classified_refines_contract hash sf nf q input Hlegal) as Hcontract.
 destruct input as [|kind old reserved].
 - cbn [stored_value input_kind effective_reserved input_trace] in *.
   rewrite vm_absent_classified by assumption.
   replace (if bytes_eqb (repeat 0%nat 32) hash then repeat 0%nat 32 else hash) with hash.
   + exact Hcontract.
   + destruct (bytes_eqb (repeat 0%nat 32) hash) eqn:E; [|reflexivity].
     symmetry. apply bytes_eqb_true. exact E.
 - cbn [stored_value input_kind effective_reserved input_trace] in *.
   destruct (bytes_eqb old hash) eqn:E.
   + rewrite vm_same_hash_classified by assumption.
     rewrite (bytes_eqb_true old hash E). rewrite (bytes_eqb_true old hash E) in Hcontract. exact Hcontract.
   + rewrite vm_different_hash_classified by assumption. exact Hcontract.
Qed.
Theorem complete_helper_reference_refinement : forall hash sf nf q input static_values,
 legal_inputs hash sf nf q input ->
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 observe (run_vm 130 artifact (initial_vm hash sf nf q (stored_value input) static_values)) =
 observe (run_source 48 source (initial_source hash sf nf q (stored_value input))).
Proof. intros. rewrite vm_method_classified by assumption.
 symmetry. apply source_method_classified. assumption. Qed.

Theorem complete_helper_no_fault_or_timeout : forall hash sf nf q input static_values,
 legal_inputs hash sf nf q input ->
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 exists s, (exists result, run_vm 130 artifact (initial_vm hash sf nf q (stored_value input) static_values) = Halt result s)
        \/ (exists message, run_vm 130 artifact (initial_vm hash sf nf q (stored_value input) static_values) = Aborted message s).
Proof.
 intros. pose proof (vm_method_classified hash sf nf q input static_values H H0) as Hclass.
 destruct (contract_observation_total hash sf nf q input) as
   [[value [wire [trace Hc]]]|[message [stored [trace Hc]]]].
 all: destruct (run_vm 130 artifact (initial_vm hash sf nf q (stored_value input) static_values)) eqn:E.
 all: try (rewrite Hc in Hclass; cbn [observe] in Hclass; discriminate).
 all: try (eexists; left; eexists; reflexivity).
 all: eexists; right; eexists; reflexivity.
Qed.
Theorem complete_helper_paid_exhaustion_aborts : forall hash sf nf q input static_values,
 legal_inputs hash sf nf q input ->
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 0 < sf+nf -> sf+nf <= effective_reserved hash input ->
 observe (run_vm 130 artifact (initial_vm hash sf nf q (stored_value input) static_values)) =
 Rejected method_error (stored_value input) (input_trace input).
Proof.
 intros hash sf nf q input static_values Hlegal Hstatic Hpaid Hspent.
 rewrite vm_method_classified by assumption.
 pose proof (legal_cap_domain hash sf nf q input Hlegal) as [_ [Hq Hr]].
 unfold contract_observation, source_charge.
 assert (E : (sf+nf =? 0) = false) by (apply Z.eqb_neq; lia).
 rewrite E, Z.max_r by lia. rewrite Z.min_r by lia. reflexivity.
Qed.

Definition reviewed_statics (slot : nat) := if Nat.eqb slot 38 then Some (VBuffer [33%nat]) else None.
Example actual_nonempty_success :
 observe (run_vm 130 artifact (initial_vm (repeat 1%nat 32) 50 10 90 VNull reviewed_statics)) =
 Returned (VInt 60) (VWire ArrayKind [VBytes (repeat 1%nat 32);VInt 60])
 [ReadStorage VNull;Serialized (VWire ArrayKind [VBytes (repeat 1%nat 32);VInt 60]);
 WroteStorage (VWire ArrayKind [VBytes (repeat 1%nat 32);VInt 60])].
Proof. vm_compute. reflexivity. Qed.
Example actual_zero_estimation_overflow_margin_rejected :
 let before := VWire StructKind [VBytes (repeat 1%nat 32);VInt (integer_limit-1)] in
 observe (run_vm 130 artifact (initial_vm (repeat 1%nat 32) 0 0 1 before reviewed_statics)) =
 Rejected margin_error before [ReadStorage before;Deserialized before] /\
 observe (run_source 48 source (initial_source (repeat 1%nat 32) 0 0 1 before)) =
 Rejected margin_error before [ReadStorage before;Deserialized before].
Proof. vm_compute. split; reflexivity. Qed.
Print Assumptions vm_method_classified.
Print Assumptions complete_helper_reference_refinement.
Print Assumptions complete_helper_no_fault_or_timeout.
Print Assumptions complete_helper_paid_exhaustion_aborts.
Print Assumptions actual_nonempty_success.
Print Assumptions actual_zero_estimation_overflow_margin_rejected.

"""

def render_certificate(program, projection):
    from method_source import render_program
    header = "From Coq Require Import ZArith List Bool Lia.\nRequire Import IntegerSemantics CapArithmetic CapMethodVm.\nImport ListNotations.\nOpen Scope Z_scope.\n"
    header += "Definition artifact : list nat := [" + ";".join(str(x)+"%nat" for x in program["bytes"]) + "].\n"
    header += "Definition source : list Stmt := " + render_program(projection) + ".\n"
    return header + SOURCE_PROOFS + VM_PROOFS + COMPOSITION_PROOFS



def declared_names(source):
    clean = re.sub(r"\(\*.*?\*\)", "", source, flags=re.S)
    names = re.findall(r"^(?:Definition|Fixpoint|CoFixpoint|Inductive|CoInductive|Record|Lemma|Theorem|Example|with)\s+(\w+)", clean, flags=re.M)
    require(names and len(names) == len(set(names)), "Missing or duplicate declaration inventory")
    return names

def _kernel_command(arguments, work, log_name, timeout=1800):
    # 600s was measured too tight for coqc CapMethodArtifact.v on a loaded
    # host (2026-10-15); use the same budget as the gate lane wrapper.
    result = subprocess.run(arguments, cwd=str(work), text=True, capture_output=True, timeout=timeout)
    log = work / log_name
    log.write_text(result.stdout + result.stderr)
    return result, log


def _require_kernel_success(result, log):
    require(result.returncode == 0, "Kernel command failed; see " + str(log))
    require("Axioms:" not in result.stdout + result.stderr,
            "Open theorem assumptions; see " + str(log))


def semantic_controls(program, projection, work):
    """Mutants must be valid Coq definitions before their certificates fail.

    These controls intentionally bypass byte/source frontends. Acceptance is a
    rejection by the semantic certificate, not an artifact-hash or parser check.
    """
    import copy
    mutants = []
    for name, offset, opcode in [("MinToMax", 17892, 0xba),
                                 ("ReverseAssertBranch", 17897, 0x26),
                                 # The drop after the reservation write: replacing it with a
                                 # duplicate leaves the written value on the stack, so the
                                 # helper no longer halts with a single result.
                                 ("DropReservationWrite", 18022, 0x4a)]:
        mutated = copy.deepcopy(program)
        mutated["bytes"][offset-START] = opcode
        mutants.append((name, mutated, projection))
    changed_source = copy.deepcopy(projection)
    changed_source["statements"][-1] = ["SReturn", ["EVal", ["VInt", 0]]]
    mutants.append(("SourceReturnsZero", program, changed_source))
    changed_initializer = copy.deepcopy(projection)
    changed_initializer["statements"][2][2][0][2][2][1] = ["EVal", ["VInt", 1]]
    mutants.append(("SourceInitialReservationOne", program, changed_initializer))
    changed_assert = copy.deepcopy(projection)
    changed_assert["statements"] = [item for item in changed_assert["statements"] if item[0] != "SAssert"]
    mutants.append(("SourceDropsAssert", program, changed_assert))
    reports = []
    for name, bytecode, source in mutants:
        certificate = render_certificate(bytecode, source)
        # Header contains the actual mutated bytes and the independently rendered
        # source IR. The first proof is deliberately not part of this check.
        definitions = certificate.split("Ltac source_norm", 1)[0]
        definitions_name = "Mutant" + name + "Definitions"
        (work / (definitions_name + ".v")).write_text(definitions)
        result, log = _kernel_command(["coqc", "-q", definitions_name + ".v"], work, definitions_name + ".log")
        _require_kernel_success(result, log)
        module = "Mutant" + name
        (work / (module + ".v")).write_text(certificate)
        rejected, reject_log = _kernel_command(["coqc", "-q", module + ".v"], work, module + ".log")
        failure = rejected.stdout + rejected.stderr
        semantic_error = any(marker in failure for marker in
                             ("Unable to unify", "Attempt to save an incomplete proof", "No applicable tactic"))
        require(rejected.returncode != 0 and semantic_error and
                not any(marker in failure for marker in ("Syntax error", "Cannot find", "not found", "Anomaly")),
                "Semantic mutant was not rejected: " + name + "; see " + str(reject_log))
        reports.append(dict(name=name, definitionsCompiled=True, certificateRejected=True,
                            definitionsSha256=digest(definitions.encode()), log=reject_log.name,
                            logSha256=digest(reject_log.read_bytes())))
    return reports


def run_proofs(inventory, output_dir, controls=False):
    from method_source import project_method
    require(shutil.which("coqc") and shutil.which("coqchk"), "coqc and coqchk are required")
    tool_paths = [ROOT / name for name in ("method_proofs.py", "method_source.py", "nef_decode.py", "verify.py")]
    tool_hashes = {path.name:digest(path.read_bytes()) for path in tool_paths}
    bound = bind_method(inventory)
    projection = project_method(inventory)
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="cap-method-kernel-", dir=str(output)))
    models = ["IntegerSemantics", "CapArithmetic", "CapMethodVm"]
    model_hashes = {}
    declarations = {}
    for module in models:
        original = ROOT / "coq" / (module + ".v")
        source = original.read_text()
        require(not re.search(r"\b(?:Admitted|Axiom|Axioms|admit|Parameter|Parameters|Abort)\b", source), "Untrusted proof escape in " + module)
        model_hashes[module] = digest(source.encode())
        declarations[module] = declared_names(source)
        (work / original.name).write_text(source)
        result, log = _kernel_command(["coqc", "-q", original.name], work, module + ".log")
        _require_kernel_success(result, log)
    certificate = render_certificate(bound, projection)
    require(not re.search(r"\b(?:Admitted|Axiom|Axioms|admit|Parameter|Parameters|Abort)\b", certificate), "Untrusted certificate escape")
    artifact_file = work / "CapMethodArtifact.v"
    artifact_file.write_text(certificate)
    declarations["CapMethodArtifact"] = declared_names(certificate)
    require(set(THEOREM_NAMES) <= set(declarations["CapMethodArtifact"]), "Reported theorem is missing from certificate")
    result, log = _kernel_command(["coqc", "-q", artifact_file.name], work, "CapMethodArtifact.log")
    _require_kernel_success(result, log)
    result, kernel_log = _kernel_command(["coqchk", "-silent", "CapMethodArtifact"], work, "coqchk.log")
    _require_kernel_success(result, kernel_log)
    assumptions = "Require Import " + " ".join(models + ["CapMethodArtifact"]) + ".\n"
    assumptions += "\n".join("Print Assumptions " + module + "." + name + "."
                            for module, names in declarations.items() for name in names) + "\n"
    (work / "CapMethodAssumptions.v").write_text(assumptions)
    checked, assumptions_log = _kernel_command(["coqc", "-q", "CapMethodAssumptions.v"], work, "assumptions.log")
    _require_kernel_success(checked, assumptions_log)
    closed_count = sum(line.strip() == "Closed under the global context" for line in checked.stdout.splitlines())
    require(closed_count == sum(len(names) for names in declarations.values()),
            "Incomplete closed-assumptions inventory; see " + str(assumptions_log))
    control_results = semantic_controls(bound, projection, work) if controls else []
    # A fresh input read closes a race with work performed by other lanes.
    after = bind_method(inventory)
    for key in ("nefSha256", "scriptSha256", "methodSha256", "manifestSha256", "inputSha256"):
        require(after[key] == bound[key], "Artifact changed during kernel verification")
    for module, expected in model_hashes.items():
        require(digest((ROOT / "coq" / (module + ".v")).read_bytes()) == expected,
                "Semantic model changed during kernel verification")
    for path, expected in tool_hashes.items():
        require(digest((ROOT / path).read_bytes()) == expected, "Proof tool changed during verification: " + path)
    return dict(scope="complete-helper-reference-refinement", kernelChecked=True,
                referenceRefinementVerified=True, fullImplementationVerified=False,
                methodRange=[START, END], byteCount=len(bound["bytes"]), instructionCount=len(bound["instructions"]),
                nefSha256=bound["nefSha256"], scriptSha256=bound["scriptSha256"], methodSha256=bound["methodSha256"],
                manifestSha256=bound["manifestSha256"],
                inputSha256=repo_relative_hashes(bound["inputSha256"]),
                sourceProjectionSha256=projection["sourceProjectionSha256"],
                sourceTreeSha256=projection["sourceTreeSha256"], certificateSha256=digest(certificate.encode()),
                modelSha256=model_hashes, toolInputSha256=tool_hashes,
                inventorySha256=digest(json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()),
                coqchkSha256=digest(kernel_log.read_bytes()),
                assumptionDeclarations=declarations, closedAssumptionCount=closed_count,
                assumptionsSha256=digest(assumptions_log.read_bytes()),
                theoremNames=THEOREM_NAMES, nativeTokenContracts={str(i):inventory["nef"]["tokens"][i] for i in (3,4)},
                traceProjection=["Storage.Get", "StdLib.Deserialize", "StdLib.Serialize(snapshot)", "Storage.Put(snapshot)"],
                pureStableNonfaultingGetters=["GetScriptContainer", "GetContext"],
                sourceDialect=projection["dialect"], environmentContracts=projection["frameworkContracts"],
                staticEntryInvariant="Static slot 38 is Buffer[0x21]; _initialize is outside this theorem",
                excludedCorrespondence=["actual ApplicationEngine and resource/gas behavior", "native binary codec",
                                        "Roslyn/compiler/source frontend correctness", "arbitrary CLR reference equality",
                                        "caller reachability and typed persisted-storage invariant", "all 105 public ABI entrypoints"],
                semanticControls=control_results)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--json-report", required=True)
    parser.add_argument("--controls", action="store_true")
    args = parser.parse_args()
    report_path = Path(args.json_report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    failure = dict(scope="complete-helper-reference-refinement", status="FAIL", kernelChecked=False,
                   referenceRefinementVerified=False, fullImplementationVerified=False,
                   error="Verification has not completed")
    report_path.write_text(json.dumps(failure, indent=2) + "\n")
    try:
        path = Path(args.inventory)
        with (gzip.open(path, "rt") if path.suffix == ".gz" else path.open()) as stream:
            inventory = json.load(stream)
        receipt = run_proofs(inventory, args.output_dir, controls=args.controls)
        report_path.write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt, indent=2))
        return 0
    except Exception as error:
        failure["error"] = str(error)
        report_path.write_text(json.dumps(failure, indent=2) + "\n")
        print(str(error), file=sys.stderr)
        return 1


THEOREM_NAMES = ["source_present_classified", "source_absent_classified", "vm_same_hash_classified",
                 "vm_different_hash_classified", "vm_absent_classified", "source_method_classified",
                 "vm_method_classified", "complete_helper_reference_refinement",
                 "complete_helper_no_fault_or_timeout", "complete_helper_paid_exhaustion_aborts",
                 "actual_nonempty_success", "actual_zero_estimation_overflow_margin_rejected"]

if __name__ == "__main__":
    raise SystemExit(main())
