#!/usr/bin/env python3
"""Fail-closed, offline AA model checks; never substitutes tests for proofs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
ARTIFACTS = {"coq/UnifiedSmartWalletAA.v", "coq/MultiSigPolicy.v",
             "tla/UnifiedSmartWalletAA.tla",
             "tla/UnifiedSmartWalletAA.cfg", "smt/aa_core.smt2"}
SOURCE_FILES = {"contracts/UnifiedSmartWallet.Execution.cs",
                "contracts/UnifiedSmartWallet.Models.cs",
                "contracts/UnifiedSmartWallet.State.cs",
                "contracts/UnifiedSmartWallet.Escape.cs",
                "contracts/UnifiedSmartWallet.Paymaster.cs",
                "contracts/paymaster/Paymaster.cs",
                "contracts/verifiers/VerifierPayload.cs"}
MULTISIG_SOURCE = "contracts/verifiers/MultiSigVerifier.cs"
MULTISIG_SOURCE_GUARDS = {
    "non_empty": "verifiers != null && verifiers.Length > 0",
    "maximum_size": "verifiers.Length <= MaxChildVerifiers",
    "threshold_range": "threshold > 0 && threshold <= verifiers.Length",
    "address_validity": "verifiers[i] != UInt160.Zero && verifiers[i].IsValid",
    "no_duplicates": "verifiers[i] != verifiers[j]",
    "post_execute_threshold": "ExecutionEngine.Assert(validCount >= config.Threshold, \"Verifier rejected signature\")",
}
MULTISIG_SOURCE_MUTATIONS = {
    "non_empty": ("verifiers != null && verifiers.Length > 0", "true"),
    "maximum_size": ("verifiers.Length <= MaxChildVerifiers", "true"),
    "threshold_range": ("threshold > 0 && threshold <= verifiers.Length", "true"),
    "address_validity": ("verifiers[i] != UInt160.Zero && verifiers[i].IsValid", "true"),
    "no_duplicates": ("verifiers[i] != verifiers[j]", "true"),
    "post_execute_threshold": ("ExecutionEngine.Assert(validCount >= config.Threshold, \"Verifier rejected signature\")",
                               "ExecutionEngine.Assert(true, \"Verifier rejected signature\")"),
}
COQ_MUTATIONS = {
    "authorization": ("  authorized s op &&", "  true &&"),
    "nonce-check": ("\n  Nat.eqb (opSequence op) (cursor s (opChannel op)) &&\n", "\n  true &&\n"),
    "nonce-increment": ("(S (cursor s (opChannel op))))", "(S (S (cursor s (opChannel op)))))"),
    "reentrancy": ("  negb (executing s) &&", "  true &&"),
    "escape-owner": ("base && ownerWitness op", "base"),
    "rollback": ("  | None => s", "  | None => committed s op"),
    "operation-shape": ("  operationShapeValid op &&\n  deadlineValid op", "  true &&\n  deadlineValid op"),
    "reject-all": ("if admissible s op then", "if false then"),
}
MULTISIG_COQ_MUTATIONS = {
    # Each removes one acceptance condition from the policy model. A mutant that
    # still compiles would mean the theorems never depended on that condition.
    "multisig-threshold": ("(threshold <=? tally approve ids)",
                           "(0 <=? tally approve ids)"),
    "multisig-signature-count": ("Nat.eqb signature_count (length ids)",
                                 "Nat.eqb signature_count signature_count"),
    "multisig-uniqueness": ("forallb (fun id => negb (Nat.eqb id 0)) ids && unique ids.",
                            "forallb (fun id => negb (Nat.eqb id 0)) ids."),
}
COQ_MODULES = {
    "UnifiedSmartWalletAA.v": COQ_MUTATIONS,
    "MultiSigPolicy.v": MULTISIG_COQ_MUTATIONS,
}
TLA_MUTATIONS = {
    "authorization": ("SuccessAuthorizationGuard == pendingAuthorized",
                      "SuccessAuthorizationGuard == TRUE", "SuccessWasAuthorized"),
    "operation-shape": ("SuccessShapeGuard == pendingShape",
                        "SuccessShapeGuard == TRUE", "SuccessWasWellShaped"),
    "nonce-increment": ("![pendingChannel] = @ + 1", "![pendingChannel] = @ + 2", "SuccessNonceTransition"),
    "rollback": ("    /\\ cursor' = cursor", "    /\\ cursor' = [cursor EXCEPT ![pendingChannel] = @ + 1]", "FailureAtomic"),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def replace_once(source, old, new):
    require(source.count(old) == 1, f"Mutation match is not unique: {old!r}")
    require(old != new, "Mutation made no change")
    return source.replace(old, new, 1)


def check_inventory(root=ROOT):
    found = {str(p.relative_to(root)) for d in ("coq", "tla", "smt")
             for p in (root / d).rglob("*") if p.suffix in {".v", ".tla", ".cfg", ".smt2"}}
    require(found == ARTIFACTS, f"Artifact inventory mismatch: {found ^ ARTIFACTS}")
    lock = json.loads((root / "source-lock.json").read_text())
    require(lock["schema"] == "aa-formal-source-lock/v1", "Unknown source-lock schema")
    require(set(lock["sources"]) == SOURCE_FILES, "Source roster changed; explicit review required")
    for name, expected in lock["sources"].items():
        actual = hashlib.sha256((root.parent / name).read_bytes()).hexdigest()
        require(actual == expected, f"Source drift: {name}; review correspondence before updating pins")


def multisig_config_valid(verifiers, threshold):
    """Executable bounded specification for MultiSigVerifier.SetConfig."""
    return (0 < len(verifiers) <= 10
            and 0 < threshold <= len(verifiers)
            and all(verifier > 0 for verifier in verifiers)
            and len(set(verifiers)) == len(verifiers))


def multisig_accepts(verifier_count, threshold, signature_count, valid_children):
    """Executable bounded specification for both validation and PostExecute gating."""
    return signature_count == verifier_count and sum(valid_children) >= threshold


def check_multisig_bounded(repo_root=ROOT.parent):
    """Check the finite MultiSig policy space and reject guard-removal mutants.

    This is deliberately a bounded correspondence aid, not a claim of cryptographic or
    NeoVM-semantic proof. The concrete VM vectors live in VerifierSignatureRuntimeTests.
    """
    source = (repo_root / MULTISIG_SOURCE).read_text()
    for name, fragment in MULTISIG_SOURCE_GUARDS.items():
        require(fragment in source, f"Missing MultiSig source guard: {name}")

    for name, (old, new) in MULTISIG_SOURCE_MUTATIONS.items():
        mutant = replace_once(source, old, new)
        require(any(fragment not in mutant for fragment in MULTISIG_SOURCE_GUARDS.values()),
                f"MultiSig guard mutation escaped source gate: {name}")

    config_cases = 0
    # Past MaxChildVerifiers on purpose: counts 11 and 12 enumerate the rejection
    # boundary instead of leaving it to the three spot checks below.
    for count in range(0, 13):
        verifiers = list(range(1, count + 1))
        for threshold in range(0, count + 2):
            expected = 1 <= count <= 10 and 0 < threshold <= count
            require(multisig_config_valid(verifiers, threshold) == expected,
                    f"MultiSig config model mismatch: count={count}, threshold={threshold}")
            config_cases += 1

    require(not multisig_config_valid([1] * 2, 1), "Duplicate verifier accepted by model")
    require(not multisig_config_valid([0, 1], 1), "Zero verifier accepted by model")
    require(not multisig_config_valid(list(range(1, 12)), 1), "Oversized verifier set accepted by model")

    acceptance_cases = 0
    for count in range(1, 11):
        for threshold in range(1, count + 1):
            for signature_count in range(0, count + 2):
                for mask in range(1 << count):
                    valid_children = [(mask >> index) & 1 == 1 for index in range(count)]
                    expected = signature_count == count and sum(valid_children) >= threshold
                    require(multisig_accepts(count, threshold, signature_count, valid_children) == expected,
                            f"MultiSig acceptance model mismatch: count={count}, threshold={threshold}, "
                            f"signature_count={signature_count}, mask={mask}")
                    acceptance_cases += 1
    return {"configCases": config_cases, "acceptanceCases": acceptance_cases,
            "sourceGuards": len(MULTISIG_SOURCE_GUARDS),
            "sourceMutationsRejected": list(MULTISIG_SOURCE_MUTATIONS)}


def artifact_hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sorted(ARTIFACTS)}


def coq_declarations(source):
    # Strip nested comments for auditing declarations, not for proof compilation.
    clean = source
    while "(*" in clean:
        clean, n = re.subn(r"\(\*(?:(?!\(\*|\*\)).)*\*\)", "", clean, flags=re.S)
        require(n > 0, "Unterminated Coq comment")
    require(not re.search(r"\b(Admitted|admit|Abort|Axiom|Parameter|Hypothesis|give_up)\b", clean),
            "Coq proof-gap marker")
    declared = re.findall(r"\b(?:Theorem|Lemma|Corollary|Proposition|Fact|Example|Remark)\s+(\w+)\s*:", clean)
    printed = re.findall(r"\bPrint\s+Assumptions\s+(\w+)\s*\.", clean)
    require(len(declared) > 0 and len(declared) == len(set(declared)), "Missing/duplicate declarations")
    require(sorted(declared) == sorted(printed), "Each declaration needs exactly one named assumption audit")
    return declared


def parse_tlc(output, returncode):
    require(returncode == 0, f"TLC exited {returncode}")
    require("Model checking completed. No error has been found." in output, "TLC did not exhaust the model")
    require(not re.search(r"^Error:", output, re.M), "TLC error")
    # Do not read progress counters as final state counts.
    final = re.findall(r"^(\d+) states generated, (\d+) distinct states found, 0 states left on queue\.$",
                       output, re.M)
    require(len(final) == 1 and int(final[0][1]) > 1, "Missing/non-trivial final TLC summary")
    rows = re.findall(r"^<(\w+) line .*?>: (\d+):(\d+)$", output, re.M)
    expected_actions = {"Init", "Tick", "Begin", "CompleteSuccess", "CompleteFailure"}
    require(len(rows) == len(expected_actions) and {name for name, _, _ in rows} == expected_actions,
            "TLC action coverage roster mismatch")
    actions = dict((name, int(generated)) for name, distinct, generated in rows)
    require(all(actions.values()), "Unreachable TLC action")
    return {"generated": int(final[0][0]), "distinct": int(final[0][1]), "actions": actions}


def parse_smt(source, output, returncode):
    require(returncode == 0 and "(error" not in output, "Z3 failed")
    labels = re.findall(r'^\(echo "((?:OBL|CTRL):[^"]+)"\)$', source, re.M)
    require(labels and len(labels) == len(set(labels)), "Missing/duplicate SMT labels")
    tokens = [line for line in output.splitlines()
              if re.match(r"^(OBL:|CTRL:|DONE:|sat$|unsat$|unknown$)", line)]
    expected = []
    for label in labels:
        expected += [label, "unsat" if label.startswith("OBL:") else "sat"]
    expected += ["DONE:aa_core"]
    require(tokens == expected, "SMT verdict missing, unexpected, reordered, unknown or incorrect")
    return {"obligations": sum(s.startswith("OBL:") for s in labels),
            "controls": sum(s.startswith("CTRL:") for s in labels)}


def run(args, cwd, logs, name, timeout=180):
    completed = subprocess.run([str(arg) for arg in args], cwd=cwd, text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    output = completed.stdout
    # Local logs may contain tool paths; they are ignored and never public evidence.
    (logs / f"{name}.log").write_text(output)
    return completed.returncode, output


def executable(env, default):
    value = os.environ.get(env, default)
    path = shutil.which(value)
    require(path is not None, f"Missing required tool {env} ({value})")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / ".runs" / "latest")
    args = parser.parse_args()
    logs = args.output.resolve()
    logs.mkdir(parents=True, exist_ok=True)
    # Invalidate a previous success before any current gate runs.
    report = {"modelChecksPassed": False, "implementationVerified": False,
              "boundary": "Hand-written abstractions; no VM/source/NEF refinement or liveness proof"}
    report_path = logs / "result.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    try:
        check_inventory()
        report["multisigBoundedModel"] = check_multisig_bounded()
        coqc = executable("COQC", "coqc")
        z3 = executable("Z3", "z3")
        java = executable("JAVA_BIN", "java")
        jar = Path(os.environ.get("TLA_JAR", str(Path.home() / "tools/tla/tla2tools.jar"))).resolve()
        require(jar.is_file(), "Missing TLA_JAR; no simulated success allowed")
        report["artifactSha256"] = artifact_hashes()
        report["sourceSha256"] = json.loads((ROOT / "source-lock.json").read_text())["sources"]
        report["tlcJarSha256"] = hashlib.sha256(jar.read_bytes()).hexdigest()
        report["toolVersions"] = {}
        for name, command in {"coq": [coqc, "--version"], "z3": [z3, "--version"],
                              "java": [java, "-version"]}.items():
            rc, output = run(command, ROOT, logs, name + "-version")
            require(rc == 0 and output.strip(), f"Cannot read {name} version")
            report["toolVersions"][name] = output.splitlines()[0]
        with tempfile.TemporaryDirectory(prefix="aa-formal-") as scratch:
            work = Path(scratch)
            for relative in ARTIFACTS:
                shutil.copyfile(ROOT / relative, work / Path(relative).name)
            # Every registered Coq module is compiled, assumption-audited and
            # mutation-tested. Compiling only the module named here is how
            # MultiSigPolicy.v came to sit in the tree unchecked while the run
            # still reported PASS.
            report["coqDeclarations"] = {}
            report["coqMutationsRejected"] = {}
            for module, mutations in COQ_MODULES.items():
                require(f"coq/{module}" in ARTIFACTS, f"Unregistered Coq module: {module}")
                require(bool(mutations), f"Coq module without mutations: {module}")
                source = (work / module).read_text()
                names = coq_declarations(source)
                rc, out = run([coqc, "-q", module], work, logs, "coq-" + module)
                require(rc == 0 and out.count("Closed under the global context") == len(names)
                        and "Axioms:" not in out,
                        f"Coq compilation/assumption audit failed: {module}")
                report["coqDeclarations"][module] = len(names)
                for name, (old, new) in mutations.items():
                    mutant = replace_once(source, old, new)
                    directory = work / ("coq-" + name)
                    directory.mkdir()
                    (directory / module).write_text(mutant)
                    # First compile just the definitions: a malformed mutation is
                    # not proof evidence.
                    prefix = re.split(r"^(?:Lemma|Theorem|Corollary|Proposition|Fact|Example|Remark) ",
                                      mutant, maxsplit=1, flags=re.M)[0]
                    (directory / "Definitions.v").write_text(prefix)
                    rc, out = run([coqc, "-q", "Definitions.v"], directory, logs, name + "-definitions")
                    require(rc == 0, f"Invalid model mutation: {name}")
                    rc, out = run([coqc, "-q", module], directory, logs, name + "-mutant")
                    require(rc != 0 and "Error:" in out and "Syntax error" not in out,
                            f"Coq mutation escaped or failed without proof rejection: {name}")
                report["coqMutationsRejected"][module] = list(mutations)
            command = [java, "-Xmx1g", "-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC",
                       "-workers", "1", "-coverage", "1", "-config", "UnifiedSmartWalletAA.cfg",
                       "UnifiedSmartWalletAA.tla"]
            rc, out = run(command, work, logs, "tlc")
            report["tlc"] = parse_tlc(out, rc)
            report["toolVersions"]["tlc"] = out.splitlines()[0]
            model = (work / "UnifiedSmartWalletAA.tla").read_text()
            for name, (old, new, invariant) in TLA_MUTATIONS.items():
                directory = work / ("tla-" + name)
                directory.mkdir()
                shutil.copyfile(work / "UnifiedSmartWalletAA.cfg", directory / "UnifiedSmartWalletAA.cfg")
                (directory / "UnifiedSmartWalletAA.tla").write_text(replace_once(model, old, new))
                rc, out = run(command, directory, logs, "tlc-" + name + "-mutant")
                require(rc != 0 and f"Invariant {invariant} is violated" in out,
                        f"TLC mutation did not produce the expected counterexample: {name}")
            report["tlcMutationsRejected"] = list(TLA_MUTATIONS)
            smt = (work / "aa_core.smt2").read_text()
            rc, out = run([z3, "-T:120", "aa_core.smt2"], work, logs, "z3")
            report["smt"] = parse_smt(smt, out, rc)
        # Detect edits made while the tools were running.
        check_inventory()
        require(artifact_hashes() == report["artifactSha256"], "Model artifacts changed during this run")
        report["modelChecksPassed"] = True
        coq_mutation_count = sum(len(m) for m in COQ_MODULES.values())
        print(f"PASS: AA model checks over {len(COQ_MODULES)} Coq modules, MultiSig bounded "
              f"model, source snapshot gate and "
              f"{coq_mutation_count + len(TLA_MUTATIONS)} semantic mutations")
        return 0
    except (ValueError, OSError, KeyError, subprocess.TimeoutExpired) as error:
        report["failure"] = str(error)
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    finally:
        report_path.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    sys.exit(main())
