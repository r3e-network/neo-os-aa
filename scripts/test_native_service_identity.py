"""The native SmartAccount service identity has exactly one canonical value.

L-4: the service hash is pinned in NativeAuthority, in the ContractPermission
attributes of every native module and in the shared client codec. This read-only
consistency scan fails the suite the moment any single pin drifts, so a stale
fork cannot ship with green tests.

Protocol v4 retired the v2 parameter digest pin: a module declares its profile
through `getModuleProfile()` and clients derive the digest from that text, so a
stray `NATIVE_PROFILE_PARAMETER_DIGEST` constant is a regression rather than a
missing pin.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVICE = "398dc3f0227d7efac5533ed5ce9937390c158084"
CLIENTS = ('nativeSmartAccount.mjs', 'nativeSmartAccountClient.mjs', 'nativeTransactionArtifact.mjs')


class NativeServiceIdentityTests(unittest.TestCase):
    def test_native_authority_pins_exactly_the_canonical_service_hash(self):
        source = (ROOT / 'contracts/plugins/native-profile/NativeAuthority.cs').read_text(encoding='utf-8')
        self.assertEqual([SERVICE], re.findall(r'InitialValue\("0x([0-9a-f]{40})"', source))

    def test_native_module_contract_permissions_pin_the_canonical_service_hash(self):
        # Every permission row that grants native service methods must address
        # exactly the canonical native contract; a stale or forked service hash
        # here would silently redirect the cross-contract authority calls.
        native_methods = re.compile(r'"(?:getAuthorizedModuleId|getModule|getAccountAddress)"')
        checked = 0
        for path in sorted((ROOT / 'contracts').rglob('*.cs')):
            text = path.read_text(encoding='utf-8')
            for contract, methods in re.findall(r'\[ContractPermission\("0x([0-9a-f]{40})", (.*?)\)\]', text):
                if native_methods.search(methods):
                    checked += 1
                    self.assertEqual(SERVICE, contract, f'{path.name} pins a stale native service hash')
        self.assertGreater(checked, 0)

    def test_client_codecs_pin_the_canonical_service_hash(self):
        pinned_files = 0
        for name in CLIENTS:
            path = ROOT / 'shared' / name
            self.assertTrue(path.exists(), path)
            pins = re.findall(r'"([0-9a-f]{40})"', path.read_text(encoding='utf-8'))
            if not pins:
                continue
            pinned_files += 1
            self.assertEqual({SERVICE}, set(pins), f'{name} pins a stale native service hash')
            mirror = ROOT / 'frontend/src/shared' / name
            if mirror.exists():
                self.assertEqual(pins, re.findall(r'"([0-9a-f]{40})"', mirror.read_text(encoding='utf-8')),
                                 f'{mirror} mirror drifted')
        self.assertEqual(1, pinned_files, 'the shared native client must keep the native service hash pin')

    def test_frontend_client_mirror_stays_byte_identical(self):
        for name in CLIENTS:
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

    def test_retired_parameter_digest_pin_does_not_come_back(self):
        scanned = [ROOT / 'shared' / name for name in CLIENTS]
        scanned += sorted((ROOT / 'sdk/js/src').rglob('*.js'))
        for path in scanned:
            text = path.read_text(encoding='utf-8')
            self.assertNotIn('NATIVE_PROFILE_PARAMETER_DIGEST =', text,
                             f'{path} re-pins the retired v2 parameter digest')
        # A v4 profile digest is the sha256 of the module-declared profile text.
        service = (ROOT / 'frontend/src/services/moduleProfileService.js').read_text(encoding='utf-8')
        self.assertIn('sha256(toUtf8Bytes(String(profileText)))', service)


if __name__ == '__main__':
    unittest.main()
