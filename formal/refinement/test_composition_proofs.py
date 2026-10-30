"""Real helper dependency, caller composition and semantic rejection checks."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
# 20261013 receipt pins pre-timeout-fix proof-runner bytes; the 20261015 run
# rebinds the identical certificate to the current tool bytes (coqchk/coqc
# budget raised 2026-10-15 after loaded-host timeouts).
DEFAULT_REPORT = ROOT.parent.parent / "docs/reports/aa-method-refinement-20261015/host/method-proof.json"


class CompositionProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("composition_prover", ROOT / "composition_proofs.py")
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)
        cls.temporary = tempfile.TemporaryDirectory()
        cls.helper_report = Path(os.environ.get("AA_HELPER_PROOF_REPORT", str(DEFAULT_REPORT)))
        directory = Path(cls.temporary.name)
        cls.proof_directory = directory / "proof"
        receipt = directory / "receipt.json"
        result = subprocess.run([sys.executable, str(ROOT / "composition_proofs.py"),
            "--helper-proof-report", str(cls.helper_report), "--output-dir", str(cls.proof_directory),
            "--json-report", str(receipt), "--controls"], capture_output=True, text=True, timeout=1800)
        if result.returncode != 0:
            raise AssertionError(result.stdout + result.stderr + receipt.read_text())
        cls.receipt = json.loads(receipt.read_text())

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def prover(self):
        return self.module

    def report(self):
        return Path(os.environ.get("AA_HELPER_PROOF_REPORT", str(DEFAULT_REPORT)))

    def test_actual_helper_serial_nested_and_outer_snapshot_proofs(self):
        result = self.receipt
        self.assertTrue(result["kernelChecked"])
        self.assertTrue(result["actualHelperTheoremApplied"])
        self.assertEqual(result["helperByteCount"], 281)
        self.assertFalse(result["actualApplicationEngineVerified"])
        self.assertFalse(result["fullImplementationVerified"])
        self.assertTrue({"helper_reservation_sound", "finite_nested_paid_fee_bound",
                         "finite_nested_reservation_conservation", "outer_fault_restores_snapshot",
                         "absent_budget_is_legal", "cross_transaction_helper_resets"}
                        <= set(result["newClosedDeclarations"]))

    def test_valid_semantic_mutations_rejected(self):
        result = self.receipt["semanticControls"]
        self.assertTrue(result["definitionsCompiled"])
        self.assertEqual(set(result["rejected"]),
                         {"lose-cumulative-reservation", "reentrant-old-ledger", "commit-after-fault"})

    def test_real_cli_control_receipt_is_accepted_by_closure(self):
        import closure
        report = self.receipt
        self.assertTrue(report["kernelChecked"])
        self.assertFalse(report["fullImplementationVerified"])
        self.assertEqual(closure.checked_controls(report["semanticControls"], "composition"), 3)
        self.assertNotIn("semanticControlsReceipt", report)
        controls = report["semanticControls"]
        self.assertEqual(set(controls["controls"]), set(self.prover().MUTATIONS))
        for row in controls["controls"].values():
            self.assertTrue(row["definitionsCompiled"])
            self.assertTrue(row["certificateRejected"])
            self.assertGreater(row["kernelExitCode"], 0)

    def test_helper_certificate_hash_tampering_fails_closed(self):
        report = json.loads(self.report().read_text())
        report["certificateSha256"] = "00" * 32
        with self.assertRaisesRegex(ValueError, "certificate"):
            self.prover().helper_inputs(report, self.report().parent)

    def test_certificate_hash_and_compiled_content_use_one_raw_read(self):
        report = json.loads(self.report().read_text())
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name in ["IntegerSemantics", "CapArithmetic", "CapMethodVm", "CapMethodArtifact"]:
                shutil.copyfile(self.proof_directory / (name+".v"), directory / (name+".v"))
            certificate = directory / "CapMethodArtifact.v"
            original = certificate.read_bytes()
            report["kernelDirectory"] = str(directory)
            original_read = Path.read_bytes
            reads = []
            def adversarial_read(path):
                if path == certificate:
                    reads.append(path)
                    return original if len(reads) == 1 else original+b"\n(* changed between reads *)\n"
                return original_read(path)
            with mock.patch.object(Path, "read_bytes", autospec=True, side_effect=adversarial_read):
                inputs, selected = self.prover().helper_inputs(report, directory)
            self.assertEqual(selected, certificate)
            self.assertEqual(inputs[certificate], original)
            self.assertEqual(len(reads), 1)


if __name__ == "__main__":
    unittest.main()
