#!/usr/bin/env python3
"""Prove complete source static initialization against the exact NEF initializer."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

import context_proofs
import initializer_source

HERE = Path(__file__).resolve().parent
MODULES = ["IntegerSemantics", "CapArithmetic", "CapMethodVm", "CapContext", "InitializerSource"]
# The Neo VM defines STSFLD0..STSFLD6 as the compact forms of STSFLD 0..6.
SHORT_STORES = {"STSFLD" + str(index): index for index in range(7)}
require = initializer_source.require


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def bind(inventory):
    # Source projection is computed before, and independently of, static slots.
    projection = initializer_source.project_source(inventory)
    initializer = context_proofs.bind_initializer(inventory)
    descriptors = inventory["sourceMap"]["debug"]["static-variables"]
    lookup = {i["fieldName"]: i for i in projection["initializers"]}
    slots = {}
    for descriptor in descriptors:
        parts = descriptor.split(",")
        require(len(parts) == 3 and parts[0] in lookup, "Unbound static slot")
        name, typ, index = parts
        require(index.isdecimal() and str(int(index)) == index, "Invalid static slot index")
        require(name not in slots, "Duplicate static slot name")
        expected_type = {"byte[]": "ByteArray", "string[]": "Array", initializer_source.source.BIG: "Integer"}
        require(typ == expected_type[lookup[name]["fieldType"]], "Static slot type mismatch")
        slots[name] = int(index)
    require(set(slots) == set(lookup) and len(set(slots.values())) == len(slots),
            "Static field/slot mapping is not a bijection")
    # The frame is declared by the bytes, not inferred from the descriptor count.
    # The reviewed 2026-11-20 rebuild declares 82 slots; the compiler debug info
    # names 81 of them and the initializer stores exactly those 81 -- slots 0..6
    # through the compact STSFLD0..STSFLD6 aliases, slots 7..81 through STSFLD.
    # Slot 14 is declared but never stored or described, so it stays outside the
    # field/slot bijection instead of being invented from the frame size.
    instructions = initializer["instructions"]
    require(instructions and instructions[0]["name"] == "INITSSLOT",
            "Initializer does not declare its frame")
    frame = int(instructions[0]["operandHex"], 16)
    require(max(slots.values()) < frame, "Static slot outside the declared frame")
    written = {int(item["operandHex"], 16) if item["name"] == "STSFLD"
               else SHORT_STORES[item["name"]] for item in instructions
               if item["name"] == "STSFLD" or item["name"] in SHORT_STORES}
    require(written <= set(slots.values()), "Initializer writes an undescribed static slot")
    return {"source": projection, "initializer": initializer, "slots": slots, "frame": frame,
            "unwritten": sorted(set(slots.values()) - written)}


def render(bound):
    values = ["(" + str(bound["slots"][i["fieldName"]]) + "%nat," + initializer_source.render_expression(i["expression"]) + ")"
              for i in bound["source"]["initializers"]]
    return r"""From Coq Require Import ZArith List Bool Lia.
Require Import IntegerSemantics CapMethodVm CapContext CapContextArtifact InitializerSource.
Import ListNotations. Open Scope Z_scope.
Definition source_assignments : list (nat * SourceStaticExpression) := [%s].
Theorem all_static_source_values_refine_initializer : forall hp st,
 exists target source,
 run_init init_fuel initializer_code (initializer_entry hp st) = InitReturned target /\
 source_initialize source_assignments (source_entry %d hp) = Some source /\
 init_heap target = source_heap source /\
 init_slots target = Some (source_slots source) /\
 init_stack target = st.
Proof.
 intros hp st. vm_compute. eexists. eexists. repeat split; reflexivity.
Qed.
Theorem source_initializer_field_count : length source_assignments = %d%%nat.
Proof. reflexivity. Qed.
""" % (";".join(values), bound["frame"], len(values))


def command(arguments, directory, log, success=True):
    result = subprocess.run(arguments, cwd=directory, text=True, capture_output=True, timeout=600)
    message = result.stdout + result.stderr
    Path(log).write_text(message)
    if success:
        require(result.returncode == 0, "Kernel/tool failed: " + str(log) + "\n" + message[-1500:])
    return result.returncode, message


def declarations(source):
    return re.findall(r"^(?:Definition|Fixpoint|Inductive|Record|Lemma|Theorem|Example)\s+(\w+)", source, re.MULTILINE)


def run_proofs(inventory, output_dir, controls=True):
    work = Path(output_dir).resolve()
    require(not work.exists() or not any(work.iterdir()), "Output directory must be new or empty")
    work.mkdir(parents=True, exist_ok=True)
    paths = [HERE / "coq" / (name + ".v") for name in MODULES] + [HERE / name for name in
        ("initializer_proofs.py", "initializer_source.py", "context_proofs.py", "method_source.py", "method_proofs.py", "nef_decode.py", "verify.py")]
    paths.extend([HERE / "test_initializer_source.py", HERE / "test_initializer_proofs.py"])
    raw = {path: path.read_bytes() for path in paths}
    inputs = {str(path): digest(data) for path, data in raw.items()}
    bound = bind(inventory)
    # The certificate is a theorem about one specific instruction model, so verify
    # that the live initializer still decodes there before rendering. PUSHINT8,
    # SHL and SUB are part of the model now; this guard catches the next opcode
    # the build adds instead of reporting a kernel error nobody can attribute.
    context_proofs.require_model_domain(bound["initializer"])
    artifacts = {module: raw[HERE / "coq" / (module + ".v")] for module in MODULES}
    artifacts["CapContextArtifact"] = context_proofs.render_certificate(bound["initializer"]).encode("utf-8")
    artifacts["InitializerSourceArtifact"] = render(bound).encode("utf-8")
    require(shutil.which("coqc") and shutil.which("coqchk"), "Missing Coq kernel")
    names = {}
    for module, source_bytes in artifacts.items():
        source = source_bytes.decode("utf-8")
        require(not re.search(r"\b(?:Admitted|Axiom|Parameter|admit|Abort)\b", source), "Proof escape")
        names[module] = declarations(source)
        (work / (module + ".v")).write_bytes(source_bytes)
        command(["coqc", "-q", module + ".v"], work, work / (module + ".log"))
    command(["coqchk", "-silent", "InitializerSourceArtifact"], work, work / "coqchk.log")
    checks = "Require Import " + " ".join(artifacts) + ".\n" + "\n".join(
        "Print Assumptions " + module + "." + name + "." for module, declarations_ in names.items() for name in declarations_)
    (work / "Assumptions.v").write_bytes(checks.encode())
    _, audited = command(["coqc", "-q", "Assumptions.v"], work, work / "assumptions.log")
    count = sum(map(len, names.values()))
    require(audited.count("Closed under the global context") == count and "Axioms:" not in audited, "Incomplete assumption audit")
    rejected = []
    if controls:
        mutants = {}
        for name in ("wrong-source-key", "wrong-source-timelock", "wrong-field-slot", "missing-source-assignment"):
            changed = copy.deepcopy(bound)
            items = changed["source"]["initializers"]
            if name == "wrong-source-key":
                next(i for i in items if i["fieldName"] == "Prefix_TransactionReimbursement")["expression"] = ["StaticBuffer", [["Number", 34]]]
            elif name == "wrong-source-timelock":
                next(i for i in items if i["fieldName"] == "MinUpgradeDelayMs")["expression"] = ["StaticInteger", ["Number", 0]]
            elif name == "wrong-field-slot":
                a, b = "Prefix_TransactionReimbursement", "Prefix_AccountState"
                changed["slots"][a], changed["slots"][b] = changed["slots"][b], changed["slots"][a]
            else:
                items.pop()
            mutants[name] = render(changed)
        for name, certificate in mutants.items():
            case = work / name; case.mkdir()
            for path in work.glob("*.vo"):
                shutil.copyfile(path, case / path.name)
            definitions = certificate.split("Theorem all_static_source_values", 1)[0]
            (case / "Definitions.v").write_bytes(definitions.encode())
            command(["coqc", "-q", "Definitions.v"], case, case / "definitions.log")
            (case / "Mutant.v").write_bytes(certificate.encode())
            code, message = command(["coqc", "-q", "Mutant.v"], case, case / "rejection.log", False)
            require(code != 0 and "Error:" in message and "Syntax error" not in message, "Semantic mutation escaped: " + name)
            rejected.append({"name": name, "definitionsCompiled": True, "certificateRejected": True})
    require(bind(inventory) == bound, "Initializer input changed during proof")
    require(all(digest(Path(path).read_bytes()) == expected for path, expected in inputs.items()), "Proof inputs changed during run")
    return {"scope": "source-to-complete-initializer-reference-refinement", "kernelChecked": True,
        "fullImplementationVerified": False, "sourceFrontendVerified": False, "applicationEngineVerified": False,
        "nefSha256": bound["initializer"]["nefSha256"], "scriptSha256": bound["initializer"]["scriptSha256"],
        "initializerSha256": bound["initializer"]["initializerSha256"],
        "sourceProjectionSha256": bound["source"]["sourceProjectionSha256"],
        "certificateSha256": digest(artifacts["InitializerSourceArtifact"]), "inputSha256": inputs,
        "closedDeclarations": names, "closedAssumptionCount": count, "semanticControls": rejected,
        "fieldCount": len(bound["source"]["initializers"]), "slots": bound["slots"],
        "sourceProjection": bound["source"], "outputDirectory": str(work),
        "unproved": ["source frontend and debugger member identity correctness", "event lowering and notification semantics",
                     "mutable Buffer identity", "initialization scheduling, gas and actual runtime correspondence"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--json-report", type=Path, required=True)
    args = parser.parse_args(argv)
    result = {"scope": "source-to-complete-initializer-reference-refinement", "kernelChecked": False, "fullImplementationVerified": False}
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    args.json_report.write_text(json.dumps(result) + "\n")
    try:
        result = run_proofs(json.loads(args.inventory.read_text()), args.output_dir)
        args.json_report.write_text(json.dumps(result, indent=2) + "\n")
        return 0
    except Exception as error:
        result["failure"] = type(error).__name__ + ": " + str(error)
        args.json_report.write_text(json.dumps(result, indent=2) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
