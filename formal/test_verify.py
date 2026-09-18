"""Tests of the gate, not formal proof evidence. Run with unittest discovery."""
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import verify


class VerificationGateTests(unittest.TestCase):
    def tlc_output(self):
        return "\n".join([
            "Progress(2): 10 states generated, 3 distinct states found, 1 states left on queue.",
            "Model checking completed. No error has been found.",
            "100 states generated, 20 distinct states found, 0 states left on queue.",
            *[f"<{action} line 1, col 1 of module M>: 0:7" for action in
              ("Init", "Tick", "Begin", "CompleteSuccess", "CompleteFailure")],
        ])

    def test_final_counts_not_progress_and_generated_not_distinct(self):
        result = verify.parse_tlc(self.tlc_output(), 0)
        self.assertEqual(20, result["distinct"])
        self.assertEqual(7, result["actions"]["Begin"])

    def test_tlc_nonzero_exit_even_with_success_marker(self):
        with self.assertRaises(ValueError):
            verify.parse_tlc(self.tlc_output(), 1)

    def test_tlc_truncated_summary(self):
        with self.assertRaises(ValueError):
            verify.parse_tlc(self.tlc_output().replace("0 states left on queue.", "1 states left on queue."), 0)

    def test_tlc_unreachable_action(self):
        with self.assertRaises(ValueError):
            verify.parse_tlc(self.tlc_output().replace(": 0:7", ": 0:0"), 0)

    def test_tlc_missing_action(self):
        with self.assertRaises(ValueError):
            verify.parse_tlc(self.tlc_output().replace("CompleteFailure", "Other"), 0)

    def test_tlc_duplicate_action_row_fails_closed(self):
        with self.assertRaises(ValueError):
            verify.parse_tlc(self.tlc_output() + "\n<Begin line 1, col 1 of module M>: 0:9", 0)

    def test_smt_exact_verdicts(self):
        source = '(echo "OBL:one")\n(echo "CTRL:one")'
        output = "OBL:one\nunsat\nCTRL:one\nsat\nDONE:aa_core"
        self.assertEqual({"obligations": 1, "controls": 1}, verify.parse_smt(source, output, 0))
        for bad in [output.replace("unsat", "unknown"), output.replace("unsat", "sat"),
                    output.replace("CTRL:one\nsat\n", ""), output + "\nsat",
                    output.replace("DONE:aa_core", "")]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                verify.parse_smt(source, bad, 0)
        with self.assertRaises(ValueError):
            verify.parse_smt(source, output, 1)

    def test_smt_duplicate_labels(self):
        with self.assertRaises(ValueError):
            verify.parse_smt('(echo "OBL:one")\n(echo "OBL:one")', "", 0)

    def test_coq_audit_requires_names_not_just_counts(self):
        with self.assertRaises(ValueError):
            verify.coq_declarations("Theorem one : 1 = 1. Proof. reflexivity. Qed. Print Assumptions two.")

    def test_coq_gap_marker(self):
        with self.assertRaises(ValueError):
            verify.coq_declarations("Theorem one : 1 = 1. Admitted. Print Assumptions one.")

    def test_nested_comments(self):
        source = "(* (* Admitted *) *) Lemma one : 1 = 1. Proof. reflexivity. Qed. Print Assumptions one."
        self.assertEqual(["one"], verify.coq_declarations(source))

    def test_all_coq_mutations_are_unique_and_change_definitions(self):
        # Every mutation must land in the definitions prefix that the gate
        # compiles on its own; one that landed in a proof body would make the
        # "invalid mutation" guard pass without ever compiling the mutant.
        for module, mutations in verify.COQ_MODULES.items():
            source = (verify.ROOT / "coq" / module).read_text()
            prefix = re.split(
                r"^(?:Lemma|Theorem|Corollary|Proposition|Fact|Example|Remark) ",
                source, maxsplit=1, flags=re.M)[0]
            for name, (old, new) in mutations.items():
                with self.subTest(module=module, name=name):
                    self.assertNotEqual(source, verify.replace_once(source, old, new))
                    self.assertIn(old, prefix)

    def test_multisig_bounded_model_and_source_mutations(self):
        result = verify.check_multisig_bounded()
        self.assertEqual(6, result["sourceGuards"])
        self.assertEqual(6, len(result["sourceMutationsRejected"]))
        self.assertGreater(result["configCases"], 100)
        self.assertGreater(result["acceptanceCases"], 10_000)

    def test_multisig_model_rejects_duplicate_zero_and_oversized_sets(self):
        self.assertFalse(verify.multisig_config_valid([1, 1], 1))
        self.assertFalse(verify.multisig_config_valid([0, 1], 1))
        self.assertFalse(verify.multisig_config_valid(list(range(1, 12)), 1))
        self.assertTrue(verify.multisig_config_valid([1, 2, 3], 2))

    def test_missing_or_duplicate_mutation_match_fails(self):
        for source in ["", "aa"]:
            with self.assertRaises(ValueError):
                verify.replace_once(source, "a", "b")

    def test_source_drift_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            formal = repo / "formal"
            formal.mkdir()
            for name in verify.ARTIFACTS | {"source-lock.json"}:
                (formal / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(verify.ROOT / name, formal / name)
            for name in verify.SOURCE_FILES:
                (repo / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(verify.ROOT.parent / name, repo / name)
            verify.check_inventory(formal)
            (repo / "contracts/UnifiedSmartWallet.Execution.cs").write_text("// drift\n")
            with self.assertRaisesRegex(ValueError, "Source drift"):
                verify.check_inventory(formal)

    def test_missing_tool_invalidates_previous_success(self):
        with tempfile.TemporaryDirectory() as output:
            result = Path(output) / "result.json"
            result.write_text('{"modelChecksPassed": true}')
            env = {**os.environ, "COQC": "/nonexistent-aa-formal/coqc"}
            process = subprocess.run([sys.executable, str(verify.ROOT / "verify.py"), "--output", output],
                                     env=env, capture_output=True, text=True, timeout=20)
            self.assertNotEqual(0, process.returncode)
            self.assertFalse(json.loads(result.read_text())["modelChecksPassed"])
            self.assertIn("Missing required tool", process.stderr)


if __name__ == "__main__":
    unittest.main()
