"""Native validator entry points preserve the v4 lifecycle and instance scoping."""
import json
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent


class NativeMultiSigProfileTests(unittest.TestCase):
    def test_native_descriptor_keeps_multihook_out_of_abi4_admission(self):
        profiles = json.loads((ROOT / 'contracts/plugins/native-profile/profiles.json').read_text())
        self.assertEqual({
            'NeoWitnessValidator', 'WhitelistHook', 'SessionKeyValidator',
            'DailyLimitHook', 'TokenRestrictedHook', 'MultiSigValidator',
        }, set(profiles))
        self.assertNotIn('MultiHook', profiles)
        self.assertFalse((ROOT / 'contracts/plugins/native-profile/MultiHook.Native.csproj').exists())
        draft = (ROOT / 'docs/proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md').read_text(encoding='utf-8')
        self.assertIn('only native composite profile', draft)
        self.assertIn('ordinary-contract composition module', draft)

    def test_explicit_profile_and_sources(self):
        profiles = json.loads((ROOT / 'contracts/plugins/native-profile/profiles.json').read_text())
        # v4 replaced composite verifiers with the core threshold policy, so the
        # descriptor keeps the fields and carries the non-composite values.
        self.assertEqual({'project': 'MultiSigValidator.Native.csproj', 'role': 'verifier',
                          'configurationMethods': ['configure'], 'compositeVerifier': False,
                          'compositeProfile': ''},
                         profiles.get('MultiSigValidator'))
        project = ET.parse(ROOT / 'contracts/plugins/native-profile/MultiSigValidator.Native.csproj')
        self.assertEqual({'NativeAuthority.cs', '../validators/ValidatorAuthority.cs',
                          '../validators/ModuleOperation.cs', '../validators/ValidatorPayload.cs',
                          '../validators/ValidatorModels.cs', '../validators/SignerDomain.cs',
                          '../validators/ValidatorClock.cs', '../validators/MultiSigValidator.cs'},
                         {item.attrib['Include'] for item in project.findall('.//Compile')})

    def test_validator_callbacks_are_lifecycle_scoped(self):
        source = (ROOT / 'contracts/plugins/validators/MultiSigValidator.cs').read_text(encoding='utf-8')
        for callback in ('OnInstall', 'Configure', 'OnUninstall'):
            self.assertIn('public static void ' + callback + '(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[]', source)
        self.assertIn('ValidatorAuthority.RequireLifecycle(accountId, moduleId)', source)
        self.assertIn('public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)', source)
        self.assertIn('public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)', source)
        self.assertIn('public static ByteString[] GetSignerDomains(UInt160 accountId, BigInteger moduleId)', source)
        # The retired v3 phase-scoped entries must not come back.
        for retired in ('ValidateSignatureForPostExecute', 'validateSignatureForPostExecute',
                        'postExecuteComposite', 'validateCompositeSignature', 'clearAccount'):
            self.assertNotIn(retired, source)

    def test_native_composite_bundle_and_entry_guards(self):
        source = (ROOT / 'contracts/plugins/validators/MultiSigValidator.cs').read_text(encoding='utf-8')
        self.assertIn('public static ByteString GetMemberKey(UInt160 accountId, BigInteger moduleId)', source)
        self.assertIn('public static ByteString GetMemberDigest(UInt160 accountId, BigInteger moduleId, ByteString operationDigest)', source)
        self.assertIn('ValidatorAuthority.InstanceKey(Prefix_MemberKey, accountId, moduleId)', source)
        self.assertIn('Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_MemberKey, accountId, moduleId))', source)


if __name__ == '__main__':
    unittest.main()
