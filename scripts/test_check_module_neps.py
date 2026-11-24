import copy
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from check_module_neps import ROOT, check_core_envelope, check_project_coverage, named_interfaces, profile, signatures, verify_manifest, verify_named


class TestModuleNEPs(unittest.TestCase):
    def setUp(self):
        self.raw = (ROOT / "contracts/plugins/hooks/WhitelistHook.profile.json").read_text()
        self.p = json.loads(self.raw)

    def check(self, raw):
        return profile(raw, "WhitelistHook", "hook")

    def test_new_plugin_directory_cannot_escape_the_named_catalogue(self):
        with TemporaryDirectory() as tmp:
            contracts = Path(tmp)
            native = contracts / "plugins/native-profile"
            native.mkdir(parents=True)
            (native / "profiles.json").write_text("{}")
            for path in ("plugins/templates/hook/HookTemplate", "plugins/templates/validator/ValidatorTemplate",
                         "plugins/recovery/SocialRecoveryService", "plugins/policies/NewModule"):
                project = (contracts / path).with_suffix(".csproj")
                project.parent.mkdir(parents=True, exist_ok=True)
                project.touch()
            with self.assertRaisesRegex(ValueError, "policies/NewModule"):
                check_project_coverage(contracts, {})
            check_project_coverage(contracts, {"NewModule": project})

    def test_core_nep_rejects_swapped_nonce_and_subkey(self):
        docs = ROOT / "docs"
        nep = (docs / "proposals/nep-smartaccount-entry-verifier.mediawiki").read_text()
        with self.assertRaisesRegex(ValueError, "field order"):
            check_core_envelope(nep.replace("args, nonce, nonceSubkey", "args, nonceSubkey, nonce"),
                                (docs / "SA-MODULE-PROTOCOL.md").read_text(),
                                (ROOT / "contracts/native/SmartAccount/SmartAccountModuleProtocol.cs").read_text())

    def test_portable_profile_vectors(self):
        vectors = ROOT / "tests/fixtures/sa-module-protocol/module-profile-vectors.json"
        for row in json.loads(vectors.read_bytes()):
            with self.subTest(case=row["case"]):
                wire = row["profileText"]
                self.assertEqual(hashlib.sha256(wire.encode("utf-8")).hexdigest(), row["sha256"])
                if row["expectedAccepted"]:
                    profile(wire, row["manifestName"], row["role"])
                else:
                    with self.assertRaises(ValueError):
                        profile(wire, row["manifestName"], row["role"])

    def test_exact_profile_bytes(self):
        self.assertEqual(self.check(self.raw), self.p)
        for altered in (self.raw + "\n", self.raw.replace('"callbacks":', '"callbacks":[],"callbacks":'),
                        self.raw.replace('"compositeLayer":0', '"compositeLayer":false'),
                        self.raw.replace('"messageCapability":false', '"messageCapability":true'),
                        self.raw.replace('"preCheck","postCheck"', '"postCheck","preCheck"')):
            with self.subTest(altered=altered), self.assertRaises(ValueError):
                self.check(altered)

    def test_changed_manifest_rejected(self):
        specs = signatures()
        methods = [{"name": k, "parameters": [{"type": t} for t in specs[k][0]],
                    "returntype": specs[k][1], "safe": specs[k][2], "offset": 0}
                   for k in ["getModuleProfile", *self.p["lifecycle"], *self.p["callbacks"]]]
        manifest = {"name": "WhitelistHook", "abi": {"methods": methods}}
        verify_manifest(self.p, manifest, specs)
        without = {**self.p, "lifecycle": ["onInstall", "onUninstall"]}
        with self.assertRaisesRegex(ValueError, "configure/4"):
            verify_manifest(without, manifest, specs)
        overload = copy.deepcopy(manifest)
        next(m for m in overload["abi"]["methods"] if m["name"] == "configure")["parameters"].pop()
        verify_manifest(without, overload, specs)
        with self.assertRaisesRegex(ValueError, "configure/4"):
            verify_manifest(self.p, overload, specs)
        for change in ("unsafe getter", "missing callback", "ambiguous callback", "return type", "parameter order", "negative offset", "missing offset", "boolean offset"):
            broken = copy.deepcopy(manifest)
            ms = broken["abi"]["methods"]
            if change == "unsafe getter":
                ms[0]["safe"] = False
            elif change == "missing callback":
                ms.pop()
            elif change == "ambiguous callback":
                ms.append(ms[-1])
            elif change == "return type":
                ms[-1]["returntype"] = "Boolean"
            elif change == "negative offset":
                ms[-1]["offset"] = -1
            elif change == "missing offset":
                del ms[-1]["offset"]
            elif change == "boolean offset":
                ms[-1]["offset"] = True
            else:
                ms[-1]["parameters"].reverse()
            with self.subTest(change=change), self.assertRaises(ValueError):
                verify_manifest(self.p, broken, specs)
        with self.assertRaisesRegex(ValueError, "invalid offset"):
            verify_manifest(self.p, manifest, specs, script_length=0)

    def test_manifest_cannot_supply_an_empty_or_nonstrings_identity(self):
        for name in ("", "  ", None, 1):
            raw = json.dumps({**self.p, "contractName": name}, sort_keys=True, separators=(",", ":"))
            with self.subTest(name=name), self.assertRaises(ValueError):
                profile(raw, name, "hook")

    def test_named_whitelist_requires_its_query_even_for_an_independent_deployment(self):
        catalog = named_interfaces()
        p = {**self.p, "contractName": "MyWhitelist"}
        query = {"name": "isWhitelisted", "parameters": [{"type": t} for t in
                 ("Hash160", "Integer", "Hash160")], "returntype": "Boolean", "safe": True, "offset": 0}
        verify_named(p, [query], "WhitelistHook", catalog)
        for methods in ([], [query, query], [{**query, "safe": False}],
                        [{**query, "returntype": "Integer"}],
                        [{**query, "parameters": query["parameters"][1:] + query["parameters"][:1]}]):
            with self.subTest(methods=methods), self.assertRaisesRegex(ValueError, "isWhitelisted"):
                verify_named(p, methods, "WhitelistHook", catalog)
        with self.assertRaisesRegex(ValueError, "capabilities"):
            verify_named({**p, "capabilities": {**p["capabilities"], "instanceIsolation": True}},
                         [query], "WhitelistHook", catalog)
        with self.assertRaisesRegex(ValueError, "unknown named module"):
            verify_named(p, [query], "MyWhitelist", catalog)
