"""The native SmartAccount service identity has exactly one canonical value.

L-4: the service hash and parameter digest are pinned in many places
(NativeAuthority.cs, module ContractPermission attributes, client codecs,
validators and probes). This read-only consistency scan fails the suite the
moment any single pin drifts, so a stale fork cannot ship with green tests.
Module sources are only scanned here; edits stay in their owning domains.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVICE = "398dc3f0227d7efac5533ed5ce9937390c158084"
DIGEST = "ae557647b63789c7af0a8c7816dc90d5c0d7e65afb78ce3c669de9a01ce3c91a"


class NativeServiceIdentityTests(unittest.TestCase):
    def test_native_authority_pins_exactly_the_canonical_service_hash(self):
        source = (ROOT / 'contracts/native/NativeAuthority.cs').read_text(encoding='utf-8')
        self.assertEqual([SERVICE], re.findall(r'InitialValue\("0x([0-9a-f]{40})"', source))

    def test_native_module_contract_permissions_pin_the_canonical_service_hash(self):
        # Every permission row that grants native service methods must address
        # exactly the canonical native contract; a stale or forked service hash
        # here would silently redirect the cross-contract authority calls.
        native_methods = re.compile(r'"(?:getAuthorityEpoch|hasModuleContext)"')
        checked = 0
        for path in sorted((ROOT / 'contracts').rglob('*.cs')):
            text = path.read_text(encoding='utf-8')
            for contract, methods in re.findall(r'\[ContractPermission\("0x([0-9a-f]{40})", (.*?)\)\]', text):
                if native_methods.search(methods):
                    checked += 1
                    self.assertEqual(SERVICE, contract, f'{path.name} pins a stale native service hash')
        self.assertGreater(checked, 0)

    def test_client_codecs_pin_the_canonical_service_hash(self):
        for name in ('nativeSmartAccount.mjs', 'nativeSmartAccountClient.mjs', 'nativeTransactionArtifact.mjs'):
            path = ROOT / 'shared' / name
            self.assertTrue(path.exists(), path)
            text = path.read_text(encoding='utf-8')
            pinned = re.findall(r'"(398dc3f0227d7efac5533ed5ce9937390c158084)"', text)
            self.assertTrue(pinned, f'{name} lost its native service hash pin')
            mirror = ROOT / 'frontend/src/shared' / name
            if mirror.exists():
                self.assertEqual(pinned, re.findall(r'"(398dc3f0227d7efac5533ed5ce9937390c158084)"',
                                                    mirror.read_text(encoding='utf-8')), f'{mirror} mirror drifted')

    def test_frontend_client_mirror_stays_byte_identical(self):
        for name in ('nativeSmartAccount.mjs', 'nativeSmartAccountClient.mjs', 'nativeTransactionArtifact.mjs'):
            mirror = ROOT / 'frontend/src/shared' / name
            if mirror.exists():
                self.assertEqual((ROOT / 'shared' / name).read_bytes(), mirror.read_bytes(),
                                 f'{name} frontend mirror is not byte identical')

    def test_validator_and_probe_scripts_pin_the_canonical_service_hash(self):
        checked = 0
        for path in sorted((ROOT / 'scripts').glob('*.py')):
            text = path.read_text(encoding='utf-8')
            for value in re.findall(r'(?:^CORE|NATIVE_CONTRACT)\s*=\s*"0?x?([0-9a-f]{40})"', text, re.M):
                checked += 1
                self.assertEqual(SERVICE, value, f'{path.name} pins a stale native service hash')
        self.assertGreater(checked, 0)

    def test_parameter_digest_pins_are_canonical_everywhere(self):
        # The parameter digest is pinned by the client codec (NATIVE_PROFILE_PARAMETER_DIGEST)
        # and its frontend mirror; the codec and transaction artifact compare the
        # profile structurally instead of duplicating the literal.
        sources = ['shared/nativeSmartAccountClient.mjs']
        for name in sources:
            path = ROOT / name
            self.assertIn(DIGEST, path.read_text(encoding='utf-8'), f'{name} lost its parameter digest pin')
            mirror = ROOT / 'frontend/src/shared' / Path(name).name
            if mirror.exists():
                self.assertIn(DIGEST, mirror.read_text(encoding='utf-8'), f'{mirror} lost its parameter digest pin')


if __name__ == '__main__':
    unittest.main()
