"""Independent bundle, binding and witness-scope controls for the native matrix."""
import importlib
import base64
import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from neoexpress_validate import ValidationFailure


class NativeMultiSigMatrixTests(unittest.TestCase):
    def module(self):
        return importlib.import_module('neoexpress_native_multisig_validate')

    def test_bundle_preserves_null_and_empty_signature(self):
        m = self.module()
        self.assertEqual(bytes.fromhex('4002002800'), m.bundle([None, b'']))
        self.assertEqual(bytes.fromhex('4002280201022800'), m.bundle([b'\x01\x02', b'']))
        self.assertEqual(bytes.fromhex('4003002800280101'), m.bundle([None, b'', b'\x01']))
        for bad in ([True], [1], ['signature'], [bytearray(b'')], [], [b''] * 4):
            with self.assertRaises(ValidationFailure): m.bundle(bad)

    def test_root_configuration_keeps_two_fields_and_the_roster_order(self):
        m = self.module(); children = ['0x' + '11' * 20, '0x' + '22' * 20, '0x' + '33' * 20]
        config, raw = m.root_configuration(children, 2)
        self.assertEqual([[bytes([i]) * 20 for i in (0x11, 0x22, 0x33)], 2], config)
        self.assertEqual(bytes.fromhex('400240032814' + '11' * 20 + '2814' + '22' * 20 + '2814' + '33' * 20 + '210102'), raw)
        self.assertNotEqual(raw, m.root_configuration(children[::-1], 2)[1])
        for roster, threshold in (([], 1), (children * 2, 2), (children[:1] * 2, 1), (children, 3), (children, True), (children, 0), (children[:1], 2)):
            with self.assertRaises(ValidationFailure): m.root_configuration(roster, threshold)

    def test_native_session_configuration_preserves_five_fields_and_separate_domain(self):
        from neoexpress_validate import B, H, I, S
        key = bytes.fromhex('036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296')
        domain = bytes.fromhex('95f9b24ea3b055e8bd3bce0bf24c6ec31b68689ad320de2adef18b0719f6f528')
        args = [B(key), H('0x' + '11' * 20), S('transfer'), I(99), I(7), S('description')]
        config, raw = self.module().session_configuration(args)
        self.assertEqual([key, bytes.fromhex('11' * 20), b'transfer', 99, 7], config)
        self.assertEqual(bytes.fromhex('40052821' + key.hex() + '2814' + '11' * 20 +
            '28087472616e73666572210163210107'), raw)
        m = self.module()
        self.assertEqual(domain, m.native_session_signer_domain(key))
        domain_raw = m.raw_entry('0x' + '11' * 20, 5, m.native_session_signer_domain(key), 7)
        self.assertEqual({base64.b64encode(bytes.fromhex('a205' + '11' * 20 + '0700000000000000')).decode():
            base64.b64encode(domain).decode()}, domain_raw)
        args[-1] = S('another description')
        self.assertEqual(raw, self.module().session_configuration(args)[1])

    def test_session_use_updates_separate_last_used_integer_without_rewriting_metadata(self):
        from neoexpress_validate import B, H, I, S
        m = self.module(); account = '0x' + '11' * 20
        key = bytes.fromhex('036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296')
        args = [B(key), H('0x' + '22' * 20), S('transfer'), I(999), I(20), S('description' * 50)]
        state = {'account': [2] + [None] * 7 + [3] + [None] * 4 + [7], 'nonce': 4, 'balance': 100,
                 'spent': 9, 'raw': {m.NAMES[1]: [{}, {}, m.raw_entry(account, 3, b'\x09', 7), {}, {}, {}]}}
        m.session_granted(state, account, args, 123)
        self.assertEqual([123, 0, b'description' * 50], state['metadata'])
        last_used_key = base64.b64encode(bytes.fromhex('a206' + '11' * 20 + '0700000000000000')).decode()
        self.assertEqual({last_used_key: ''}, state['raw'][m.NAMES[1]][5])
        self.assertEqual(9, state['spent'])
        metadata_raw = copy.deepcopy(state['raw'][m.NAMES[1]][1])
        m.session_consumed(state, account, 256)
        self.assertEqual((5, 99, 10), (state['nonce'], state['balance'], state['spent']))
        self.assertEqual([123, 256, b'description' * 50], state['metadata'])
        self.assertEqual(metadata_raw, state['raw'][m.NAMES[1]][1])
        self.assertEqual({last_used_key: 'AAE='}, state['raw'][m.NAMES[1]][5])
        self.assertEqual(m.raw_entry(account, 3, b'\x0a', 7), state['raw'][m.NAMES[1]][2])
        m.session_granted(state, account, args, 300)
        self.assertEqual({last_used_key: ''}, state['raw'][m.NAMES[1]][5])
        self.assertEqual([300, 0, b'description' * 50], state['metadata'])
        self.assertEqual(10, state['spent'])

    def test_state_observes_six_session_and_three_native_keys_in_the_fresh_epoch(self):
        m = self.module(); account = '0x' + '11' * 20
        modules = dict(zip(m.NAMES, ['0x' + '22' * 20, '0x' + '33' * 20, '0x' + '44' * 20]))
        driver = m.CompositeTransactions(None, modules, account, '0x' + '55' * 20, '0x' + '66' * 20, {})
        driver.value = Mock(return_value=7)
        with patch.object(m, 'storage_prefix', return_value={}) as storage:
            state = driver.state(account)
        keys = [call.args[2] for call in storage.call_args_list if call.args[1] == modules[m.NAMES[1]]]
        self.assertEqual([bytes.fromhex('a2' + f'{prefix:02x}' + '11' * 20 + '0700000000000000') for prefix in range(1, 7)], keys)
        self.assertEqual([{}] * 6, state['raw'][m.NAMES[1]])
        keys = [call.args[2] for call in storage.call_args_list if call.args[1] == modules[m.NAMES[2]]]
        self.assertEqual([bytes.fromhex('a2' + f'{prefix:02x}' + '11' * 20 + '0700000000000000') for prefix in range(1, 4)], keys)
        self.assertEqual([{}] * 3, state['raw'][m.NAMES[2]])

    def test_native_configuration_stores_packed_ordered_domains_and_keeps_two_fields(self):
        from neoexpress_validate import A, H, I
        m = self.module(); account = '0x' + '11' * 20
        signers = ['0x000102030405060708090a0b0c0d0e0f10111213', '0x1415161718191a1b1c1d1e1f2021222324252627']
        args = [A(*(H(signer) for signer in signers)), I(2)]
        state = {'account': [2] + [None] * 7 + [3] + [None] * 4 + [7], 'raw': {m.NAMES[2]: [{}, {}, {}]}}
        m.native_configured(state, account, args)
        self.assertEqual([[bytes.fromhex(signer[2:])[::-1] for signer in signers], 2], state['native'])
        self.assertEqual(m.raw_entry(account, 1, bytes.fromhex('400240022814131211100f0e0d0c0b0a09080706050403020100281427262524232221201f1e1d1c1b1a191817161514210102'), 7), state['raw'][m.NAMES[2]][0])
        self.assertEqual(m.raw_entry(account, 2, b'\x02', 7), state['raw'][m.NAMES[2]][1])
        domains = bytes.fromhex('4611dd6061821294b30a04279ca5724864722c877a2a64a635c2808223475c31'
                                '8294a678bd7ed08044c3f284d8487b7989ddb359464820d67f408b2227f5309d')
        self.assertEqual(m.raw_entry(account, 3, domains, 7), state['raw'][m.NAMES[2]][2])
        self.assertEqual(64, len(base64.b64decode(next(iter(state['raw'][m.NAMES[2]][2].values())))))
        m.native_configured(state, account, [A(H(signers[1]), H(signers[0])), I(1)])
        self.assertEqual(m.raw_entry(account, 3, domains[32:] + domains[:32], 7), state['raw'][m.NAMES[2]][2])
        m.native_configured(state, account, [A(H(signers[0])), I(1)])
        self.assertEqual(m.raw_entry(account, 3, domains[:32], 7), state['raw'][m.NAMES[2]][2])

    def test_native_cleanup_removes_packed_domains_and_preserves_session(self):
        m = self.module(); session = [{str(prefix): 'session'} for prefix in range(1, 7)]
        state = {'native': ['configured'], 'nonce': 3, 'raw': {m.NAMES[2]: [{str(prefix): 'native'} for prefix in range(1, 4)],
                                                          m.NAMES[1]: copy.deepcopy(session)}}
        m.native_cleared(state)
        self.assertIsNone(state['native']); self.assertEqual(3, state['nonce'])
        self.assertEqual([{}] * 3, state['raw'][m.NAMES[2]])
        self.assertEqual(session, state['raw'][m.NAMES[1]])

    def test_full_session_cleanup_clears_last_used_and_rotation(self):
        m = self.module()
        state = {'nonce': 3, 'session': ['configured'], 'metadata': [1, 2, b'description'], 'spent': 9,
                 'raw': {m.NAMES[1]: [{str(prefix): 'seeded'} for prefix in range(1, 7)]}}
        m.session_cleared(state)
        self.assertEqual([{}] * 6, state['raw'][m.NAMES[1]])
        self.assertEqual((None, None, 0, 3), (state['session'], state['metadata'], state['spent'], state['nonce']))

    def test_module_metadata_requires_current_profile_and_exact_composite_boolean(self):
        m = self.module()
        for composite in (False, True):
            manifest = {'extra': {'smartAccount': {'abiVersion': 2, 'profileDigest': m.DIGEST, 'compositeVerifier': composite}}}
            m.check_module_profile(manifest, composite)
            for field, bad in (('abiVersion', True), ('abiVersion', 1), ('profileDigest', '00' * 32),
                               ('compositeVerifier', int(composite)), ('compositeVerifier', not composite)):
                wrong = copy.deepcopy(manifest); wrong['extra']['smartAccount'][field] = bad
                with self.assertRaises(ValidationFailure): m.check_module_profile(wrong, composite)
            for field in ('abiVersion', 'profileDigest', 'compositeVerifier'):
                wrong = copy.deepcopy(manifest); del wrong['extra']['smartAccount'][field]
                with self.assertRaises(ValidationFailure): m.check_module_profile(wrong, composite)

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

    def test_native_storage_namespace_uses_the_explicit_epoch(self):
        m = self.module(); account = '0x' + '11' * 20
        self.assertEqual(bytes.fromhex('a201'+'11'*20+'0700000000000000'),m.native_storage_key(account,1,7))
        self.assertNotEqual(m.raw_entry(account,1,b'\x04',0),m.raw_entry(account,1,b'\x04',1))


if __name__ == '__main__': unittest.main()
