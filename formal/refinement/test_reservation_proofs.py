"""Universal reservation arithmetic and semantic fault controls."""
import importlib.util
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent


class ReservationProofTests(unittest.TestCase):
    def prover(self):
        spec = importlib.util.spec_from_file_location("reservation_prover", ROOT / "reservation_proofs.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_universal_paid_estimation_and_iteration_proofs(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = self.prover().run_proofs(Path(temporary))
        self.assertTrue(result["kernelChecked"])
        self.assertFalse(result["fullHelperVerified"])
        self.assertIn("paid_reservation_success_iff_remaining", result["closedDeclarations"])
        self.assertIn("estimation_success_iff_representable", result["closedDeclarations"])
        self.assertIn("same_transaction_iteration_preserves_fee_bound", result["closedDeclarations"])

    def test_semantic_mutants_are_valid_definitions_and_rejected_proofs(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = self.prover().run_semantic_controls(Path(temporary))
        self.assertTrue(result["definitionsCompiled"])
        self.assertEqual(set(result["rejected"]), {
            "zero-charge-admitted", "addition-becomes-subtraction", "overflow-wrap",
            "reservation-not-accumulated", "wrong-transaction-ledger", "iteration-skips-reservation"})


if __name__ == "__main__":
    unittest.main()
