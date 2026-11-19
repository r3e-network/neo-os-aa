"""Explicit native profile and instance-scoped guards for restricted assets."""
import json
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parent.parent

class NativeRestrictedProfileTests(unittest.TestCase):
    def test_profile_and_linked_sources_are_explicit(self):
        profiles=json.loads((ROOT/'contracts/plugins/native-profile/profiles.json').read_text())
        self.assertEqual(
            {
                'project': 'TokenRestrictedHook.Native.csproj',
                'role': 'hook',
                'configurationMethods': ['configure'],
                'compositeVerifier': False,
                'compositeProfile': '',
            },
            profiles['TokenRestrictedHook'],
        )
        project=ET.parse(ROOT/'contracts/plugins/native-profile/TokenRestrictedHook.Native.csproj')
        self.assertEqual({'NativeAuthority.cs','../hooks/HookAuthority.cs','../validators/ModuleOperation.cs','../hooks/TokenRestrictedHook.cs'},
                         {v.attrib['Include'] for v in project.findall('.//Compile')})

    def test_native_guards_cover_every_phase_and_snapshot_cleanup(self):
        source=(ROOT/'contracts/plugins/hooks/TokenRestrictedHook.cs').read_text(encoding='utf-8')
        # v4 authorises the authenticated module context instead of a per-phase
        # permission string, and cleanup drops both instance prefixes.
        for callback in ('OnInstall','Configure','OnUninstall','PreCheck','PostCheck'):
            self.assertIn('public static ', source)
        self.assertEqual(3, source.count('HookAuthority.RequireLifecycle(accountId, moduleId)'))
        self.assertIn('HookAuthority.DeleteInstancePrefix(Prefix_RestrictedTokens, accountId, moduleId)', source)
        self.assertIn('HookAuthority.DeleteInstancePrefix(Prefix_RestrictedSnapshot, accountId, moduleId)', source)
        self.assertIn('"Missing restricted balance snapshot"', source)
        self.assertIn('Storage.Delete(Storage.CurrentContext, TokenKey(Prefix_RestrictedSnapshot, accountId, moduleId, token))', source)
        self.assertIn('return Helper.Concat(HookAuthority.InstanceKey(prefix, accountId, moduleId), (byte[])token);', source)
        self.assertIn('value is BigInteger && (BigInteger)value >= 0', source)
        self.assertIn('public static bool IsRestricted(UInt160 accountId, BigInteger moduleId, UInt160 token)', source)
        # The retired v3 phase strings must not come back.
        self.assertNotIn('"preExecute"', source)
        self.assertNotIn('"postExecute"', source)


if __name__=='__main__':unittest.main()
