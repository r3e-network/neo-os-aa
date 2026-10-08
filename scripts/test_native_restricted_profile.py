"""Explicit native profile and grant/cleanup guards for restricted assets."""
import json
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parent.parent

class NativeRestrictedProfileTests(unittest.TestCase):
    def test_profile_and_linked_sources_are_explicit(self):
        profiles=json.loads((ROOT/'contracts/native/profiles.json').read_text())
        self.assertEqual({'project':'TokenRestrictedHook.Native.csproj','role':'hook','configurationMethods':['setRestrictedToken']},profiles['TokenRestrictedHook'])
        project=ET.parse(ROOT/'contracts/native/TokenRestrictedHook.Native.csproj')
        self.assertEqual({'NativeAuthority.cs','../hooks/HookAuthority.cs','../hooks/TokenRestrictedHook.cs'},
                         {v.attrib['Include'] for v in project.findall('.//Compile')})

    def test_native_guards_cover_every_phase_and_snapshot_cleanup(self):
        source=(ROOT/'contracts/hooks/TokenRestrictedHook.cs').read_text()
        for phase in ('preExecute','postExecute','cleanup'):
            self.assertIn('NativeAuthority.Require(HookAuthority.AuthorizedCore(), accountId, "hook", "'+phase+'")',source)
        self.assertIn('"getAccountAddress"',source)
        self.assertIn('"Missing restricted balance snapshot"',source)
        self.assertIn('value is BigInteger && (BigInteger)value >= 0',source)
        self.assertIn('ClearPrefix(Helper.Concat(Prefix_RestrictedSnapshot, (byte[])accountId))',source)


if __name__=='__main__':unittest.main()
