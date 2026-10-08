"""Independent bundle, binding and witness-scope controls for the native matrix."""
import importlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from neoexpress_validate import ValidationFailure


class NativeMultiSigMatrixTests(unittest.TestCase):
    def module(self):
        return importlib.import_module('neoexpress_native_multisig_validate')

    def test_bundle_preserves_null_and_empty_signature(self):
        m = self.module()
        self.assertEqual(bytes.fromhex('4002002800'), m.bundle([None, b'']))
        self.assertEqual(bytes.fromhex('4002280201022800'), m.bundle([b'\x01\x02', b'']))
        for bad in ([True], [1], ['signature'], [bytearray(b'')], []):
            with self.assertRaises(ValidationFailure): m.bundle(bad)

    def test_compiler_class_records_are_exact_arrays(self):
        from neoexpress_validate import I
        self.assertEqual(bytes.fromhex('4001210101'), self.module().record(I(1)))

    def test_leaf_witness_scope_is_root_specific_and_keys_are_unique(self):
        m = self.module(); root = '0x' + '33' * 20
        keys = [SimpleNamespace(script_hash=bytes([i]) * 20) for i in (1, 2)]
        signers = m.signers(keys, root, True)
        self.assertEqual('CalledByEntry', signers[0]['scopes'])
        self.assertEqual([{'action': 'Allow', 'condition': {'type': 'Or', 'expressions': [{'type': 'CalledByContract', 'hash': root}]}}], signers[1]['rules'])
        self.assertEqual('CalledByEntry', m.signers(keys, root, False)[1]['scopes'])
        for bad in ([], [keys[0], keys[0]]):
            with self.assertRaises(ValidationFailure): m.signers(bad, root, True)

    def test_root_scope_reaches_the_actual_transaction_serializer(self):
        from neoexpress_validate import serialize_unsigned
        keys = [SimpleNamespace(script_hash=bytes([i]) * 20) for i in (1, 2)]
        rows = self.module().signers(keys, '0x' + '33' * 20, True)
        encoded = serialize_unsigned(1, 100, 100, 1, rows, b'\x40')
        self.assertIn(bytes.fromhex('2833'), encoded)

    def test_missing_provenance_replaces_stale_success(self):
        m = self.module()
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp); report = p / 'out.json'; report.write_text('{"status":"PASS"}')
            with self.assertRaises(FileNotFoundError): m.validate(p, p, p, p / 'missing', p / 'module', report)
            self.assertEqual('FAIL', json.loads(report.read_text())['status'])

    def test_diagnostic_mode_oracle_tracks_raw_storage(self):
        m = self.module(); account = '0x' + '11' * 20
        state = {'diagnosticMode': 0, 'diagnosticRaw': {}}
        m.diagnostic_mode(state, account, 4)
        self.assertEqual(4, state['diagnosticMode'])
        self.assertEqual(m.raw_entry(account, 1, bytes([4])), state['diagnosticRaw'])


if __name__ == '__main__': unittest.main()
