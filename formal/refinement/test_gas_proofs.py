"""Adversarial source frontend and fee certificate checks."""
import importlib.util
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("gas_proofs", Path(__file__).with_name("gas_proofs.py"))
gas = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gas)

SOURCE = '''private readonly BigInteger _feeAmount;
private BigInteger _feeConsumed;
public static readonly BigInteger FeeFactor = 10000;
protected internal void AddFee(BigInteger gas, bool applyFactor) {
 if (gas < 0) { throw new InvalidOperationException("AddFee can't be negative."); }
 if (CurrentContext?.GetState<ExecutionContextState>()?.WhiteListed == true) { return; }
 if (applyFactor) { gas *= FeeFactor; }
 _feeConsumed = _feeConsumed + gas;
 if (_feeConsumed > _feeAmount) throw new InvalidOperationException("Insufficient GAS.");
}'''


class SourceTests(unittest.TestCase):
    def test_original_and_whitespace_parse_same_program(self):
        original = gas.project_source(SOURCE)
        spaced = gas.project_source(SOURCE.replace("if (", "/* comment */ if\n("))
        self.assertEqual(original["program"], spaced["program"])
        self.assertEqual(original["feeFactor"], 10000)

    def test_supported_semantic_mutations_change_program(self):
        original = gas.project_source(SOURCE)["program"]
        for old, new in [("+ gas", "- gas"), ("> _feeAmount", ">= _feeAmount"),
                         ("gas *= FeeFactor", "gas += FeeFactor"), ("gas < 0", "gas <= 0")]:
            with self.subTest(new=new):
                self.assertNotEqual(original, gas.project_source(SOURCE.replace(old, new))["program"])

    def test_unknown_effect_rejected(self):
        with self.assertRaisesRegex(ValueError, "unsupported|expected"):
            gas.project_source(SOURCE.replace("_feeConsumed =", "Notify(); _feeConsumed ="))

    def test_changed_field_type_and_duplicate_method_rejected(self):
        for source in [SOURCE.replace("private BigInteger _feeConsumed", "private long _feeConsumed"), SOURCE + SOURCE]:
            with self.subTest(source=source[:40]), self.assertRaises(ValueError):
                gas.project_source(source)

    def test_unknown_exception_not_coerced_to_known_failure(self):
        with self.assertRaisesRegex(ValueError, "exception"):
            gas.project_source(SOURCE.replace("Insufficient GAS.", "Different failure"))

    def test_factor_is_source_data(self):
        self.assertEqual(gas.project_source(SOURCE.replace("10000", "10001"))["feeFactor"], 10001)

    def test_all_kernel_certificates_and_mutations(self):
        with tempfile.TemporaryDirectory(prefix="aa-gas-test-") as temp:
            original_read = Path.read_text
            def guarded_read(path, *args, **kwargs):
                if path == gas.MODEL:
                    raise AssertionError("Model must compile the same raw snapshot used for its hash")
                return original_read(path, *args, **kwargs)
            with mock.patch.object(Path, "read_text", guarded_read):
                result = gas.run_proofs(temp, source_text=SOURCE, controls=True)
            self.assertTrue(result["kernelChecked"])
            self.assertFalse(result["applicationEngineVerified"])
            self.assertEqual(len(result["semanticControls"]), 7)
            self.assertEqual(hashlib.sha256((Path(temp) / "GasSemantics.v").read_bytes()).hexdigest(),
                             result["inputSha256"][str(gas.MODEL)])


if __name__ == "__main__":
    unittest.main()
