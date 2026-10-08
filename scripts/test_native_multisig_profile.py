"""Native composite entry points preserve the original phase restrictions."""
import json
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent


class NativeMultiSigProfileTests(unittest.TestCase):
    def test_explicit_profile_and_sources(self):
        profiles = json.loads((ROOT / 'contracts/native/profiles.json').read_text())
        self.assertEqual({'project': 'MultiSigVerifier.Native.csproj', 'role': 'verifier',
                          'configurationMethods': ['setConfig']}, profiles.get('MultiSigVerifier'))
        project = ET.parse(ROOT / 'contracts/native/MultiSigVerifier.Native.csproj')
        self.assertEqual({'NativeAuthority.cs', '../verifiers/NativeOperation.cs', '../verifiers/VerifierAuthority.cs',
                          '../verifiers/VerifierModels.cs', '../verifiers/MultiSigVerifier.cs'},
                         {item.attrib['Include'] for item in project.findall('.//Compile')})

    def test_leaf_revalidation_is_a_distinct_phase_scoped_entry(self):
        for name in ('NeoNativeVerifier', 'SessionKeyVerifier'):
            source = (ROOT / 'contracts/verifiers' / (name + '.cs')).read_text()
            self.assertIn('public static bool ValidateSignatureForPostExecute(UInt160 accountId, object[] fields)', source)
            self.assertIn('NativeAuthority.Require(VerifierAuthority.AuthorizedCore(), accountId, "verifier", "validation")', source)
            self.assertIn('NativeAuthority.Require(VerifierAuthority.AuthorizedCore(), accountId, "verifier", "postExecute")', source)

    def test_native_composite_bundle_and_entry_guards(self):
        source = (ROOT / 'contracts/verifiers/MultiSigVerifier.cs').read_text()
        for phase in ('validation', 'postExecute', 'cleanup'):
            self.assertIn('NativeAuthority.Require(VerifierAuthority.AuthorizedCore(), accountId, "verifier", "' + phase + '")', source)
        self.assertIn('"validateSignatureForPostExecute"', source)
        self.assertIn('"Noncanonical MultiSig signature bundle"', source)
        self.assertIn('public static ByteString[] GetSignerDomains(UInt160 accountId)', source)


if __name__ == '__main__':
    unittest.main()
