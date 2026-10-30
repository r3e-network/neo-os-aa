#!/usr/bin/env python3
"""Compile reservation arithmetic and protocol composition with real kernels.

This runner establishes universal arithmetic statements, not a byte/suffix,
mutable-heap, storage, C# compiler, or complete-method certificate.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
DEPENDENCIES = [ROOT / "coq/IntegerSemantics.v", ROOT / "coq/CapArithmetic.v",
                REPO / "formal/coq/OrdinarySponsorship.v"]
MODEL = ROOT / "coq/ReservationArithmetic.v"
MUTATIONS = {
    "zero-charge-admitted": ("if 0 <? settled then checked_binary Add reserved settled else None",
                              "if 0 <=? settled then checked_binary Add reserved settled else None"),
    "addition-becomes-subtraction": ("checked_binary Add reserved settled", "checked_binary Sub reserved settled"),
    "overflow-wrap": ("checked_binary Add reserved settled", "Some ((reserved + settled) mod integer_limit)"),
    "reservation-not-accumulated": ("checked_integer (ledger_spent next)",
                                    "checked_integer (ledger_spent next - spent_for tx before)"),
    "wrong-transaction-ledger": ("Some (mkLedger tx bounded)", "Some (mkLedger (ledger_tx before) bounded)"),
    "iteration-skips-reservation": ("Some reserved => bounded_reserve_many tx cost rest reserved",
                                    "Some reserved => bounded_reserve_many tx cost rest before"),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def declarations(source):
    return re.findall(r"^(?:Lemma|Theorem|Example)\s+(\w+)\s*:", source, re.MULTILINE)


def command(arguments, work, log, positive=True):
    # 120s measured too tight on a loaded host; use the same 600s budget as
    # method_proofs.py/numeric_proofs.py kernel commands.
    result = subprocess.run(arguments, cwd=work, capture_output=True, text=True, timeout=600)
    output = result.stdout + result.stderr
    Path(log).write_text(output)
    if positive:
        require(result.returncode == 0, "Kernel/tool failed: " + str(log))
    return result.returncode, output


def snapshot():
    paths = [*DEPENDENCIES, MODEL, Path(__file__), ROOT / "test_reservation_proofs.py"]
    raw = {path: path.read_bytes() for path in paths}
    hashes = {str(path.relative_to(REPO)): hashlib.sha256(value).hexdigest() for path, value in raw.items()}
    return raw, hashes


def unchanged(hashes):
    require(all(digest(REPO / path) == expected for path, expected in hashes.items()), "Proof inputs changed during run")


def prepare(output_dir, raw):
    work = Path(output_dir).resolve(); work.mkdir(parents=True, exist_ok=True)
    coqc, coqchk = shutil.which("coqc"), shutil.which("coqchk")
    require(coqc and coqchk, "Missing coqc/coqchk; no simulated proof success")
    names = []
    for path in [*DEPENDENCIES, MODEL]:
        source = raw[path].decode("utf-8")
        require(not re.search(r"\b(?:Axiom|Admitted|admit|Abort|Parameter)\b", source), "Untrusted proof declaration")
        (work / path.name).write_bytes(raw[path])
        _, output = command([coqc, "-q", path.name], work, work / (path.stem + ".log"))
        closed = declarations(source)
        require(output.count("Closed under the global context") == len(closed) and "Axioms:" not in output,
                "Proof assumptions audit failed: " + path.name)
        names.extend(closed)
    command([coqchk, "-silent", *(path.stem for path in [*DEPENDENCIES, MODEL])], work, work / "coqchk.log")
    return work, coqc, names


def run_proofs(output_dir):
    raw, hashes = snapshot()
    work, coqc, names = prepare(output_dir, raw)
    _, version = command([coqc, "--version"], work, work / "tool-version.log")
    unchanged(hashes)
    return {"schema": "neoos-aa-reservation-arithmetic-proof/v1", "scope": "reservation-arithmetic",
        "kernelChecked": True, "kernelRecheck": "coqchk -silent", "toolVersion": version.splitlines()[0],
        "fullHelperVerified": False, "suffixBytecodeVerified": False, "fullImplementationVerified": False,
        "closedDeclarations": names, "newClosedDeclarations": declarations(raw[MODEL].decode("utf-8")),
        "inputSha256": hashes, "outputDirectory": str(work),
        "preconditions": ["paid: 0<cost<2^255, 0<requested<2^255, 0<=reserved<=cost",
            "estimation: cost=0, 0<requested<2^255, 0<=reserved<2^255",
            "Integer-typed scalar inputs; same-transaction ledger invariant required for iteration"],
        "conclusions": ["positive paid reservation succeeds iff remaining fee is positive",
            "paid success advances reserved within cost and signed Integer range",
            "zero-fee estimation succeeds iff reserved+requested<2^255; otherwise checked ADD faults",
            "successful representable reservations compose with original protocol reserve/reserve_many",
            "zero-fee overflow disagrees with original unbounded protocol; no source/target same-fault claim"],
        "unproved": ["actual suffix control/heap/SETITEM bytecode certificate", "source/target exception trace equivalence",
            "caller/ledger/type invariant establishment", "transaction-hash projection, deserialize/serialize, storage",
            "transaction rollback, instruction GAS, reference VM/runtime correspondence", "complete helper and public methods"]}


def run_semantic_controls(output_dir):
    raw, hashes = snapshot()
    work, coqc, _ = prepare(output_dir, raw)
    source = raw[MODEL].decode("utf-8")
    rejected = []
    for name, (old, new) in MUTATIONS.items():
        require(source.count(old) == 1, "Mutation does not select exactly one semantic condition: " + name)
        mutant = source.replace(old, new)
        case = work / name; case.mkdir()
        for dependency in DEPENDENCIES:
            for suffix in (".v", ".vo"):
                shutil.copyfile(work / (dependency.stem + suffix), case / (dependency.stem + suffix))
        prefix = re.split(r"^(?:Lemma|Theorem|Example) ", mutant, maxsplit=1, flags=re.MULTILINE)[0]
        (case / "Definitions.v").write_text(prefix)
        command([coqc, "-q", "Definitions.v"], case, case / "definitions.log")
        (case / MODEL.name).write_text(mutant)
        rc, output = command([coqc, "-q", MODEL.name], case, case / "rejection.log", False)
        require(rc != 0 and "Error:" in output and "Syntax error" not in output,
                "Semantic mutation escaped or failed without proof rejection: " + name)
        rejected.append(name)
    unchanged(hashes)
    return {"schema": "neoos-aa-reservation-semantic-controls/v1", "definitionsCompiled": True,
        "scope": "reservation-arithmetic", "fullHelperVerified": False,
        "rejected": rejected, "inputSha256": hashes, "outputDirectory": str(work)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--json-report", type=Path, required=True)
    parser.add_argument("--controls", action="store_true")
    args = parser.parse_args()
    report = {"scope": "reservation-arithmetic", "kernelChecked": False, "fullHelperVerified": False}
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    args.json_report.write_text(json.dumps(report) + "\n")
    try:
        report = run_semantic_controls(args.output_dir) if args.controls else run_proofs(args.output_dir)
        args.json_report.write_text(json.dumps(report, indent=2) + "\n")
        return 0
    except Exception as error:
        report["failure"] = type(error).__name__ + ": " + str(error)
        args.json_report.write_text(json.dumps(report, indent=2) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
