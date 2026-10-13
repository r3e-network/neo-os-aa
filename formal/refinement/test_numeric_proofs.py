"""Pinned numeric coercion model, actual kernel checks and semantic controls."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


def prover():
    spec = importlib.util.spec_from_file_location('numeric_prover', ROOT / 'numeric_proofs.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NumericProofTests(unittest.TestCase):
    def test_algorithm_range_and_value_relation_are_kernel_checked(self):
        with tempfile.TemporaryDirectory() as temp:
            result = prover().run_model_proofs(Path(temp))
        self.assertTrue(result['kernelChecked'])
        self.assertFalse(result['vmCorrespondenceProven'])
        self.assertFalse(result['fullImplementationVerified'])
        self.assertEqual(result['scope'], 'numeric-coercions')
        self.assertTrue({'signed_le_unsigned_relation', 'byte_string_integer_range',
                         'get_integer_range', 'signed_le_sign_extension',
                         'numeric_refines_integer', 'buffer_get_integer_rejected',
                         'null_convert_preserves_null'}.issubset(result['closedDeclarations']))

    def test_wellformed_semantic_changes_are_rejected_by_the_kernel(self):
        with tempfile.TemporaryDirectory() as temp:
            result = prover().run_semantic_controls(Path(temp))
        self.assertTrue(result['definitionsCompiled'])
        self.assertEqual(set(result['rejected']), {'unsigned-sign', 'big-endian',
            'oversized-33', 'boolean-inverted', 'buffer-coercion', 'null-zero',
            'noncanonical-rejected', 'sign-extension-zero'})

    def test_model_vectors_match_signed_little_endian_definition(self):
        module = prover()
        vectors = [b'', b'\x00', b'\x01', b'\x7f', b'\x80', b'\xff',
                   b'\x80\x00', b'\xff\x00', b'\xff\xff', b'\x00\x80',
                   bytes([0xff]) * 31 + b'\x7f', bytes(31) + b'\x80']
        for value in vectors:
            self.assertEqual(module.reference_signed_le(value), int.from_bytes(value, 'little', signed=True))
        with self.assertRaises(ValueError):
            module.reference_signed_le(bytes(33))

    def test_changed_pinned_runtime_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp) / 'StackItem.cs').write_text('changed source')
            with self.assertRaisesRegex(ValueError, 'Pinned source cache mismatch'):
                prover().source_evidence(Path(temp))


if __name__ == '__main__':
    unittest.main()
