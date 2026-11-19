"""Native v4 module admission must stay read-only and fail closed.

Protocol v4 replaced the v2 manifest-rewriting gate with a module-declared
profile: `getModuleProfile()` is a safe read-only callback and the core verifies
its digest at install time. Admission here only checks that a compiler manifest
carries the native-v4 marker, the v4 lifecycle ABI, the exact native service
permission allowlist and a well-formed NEF; it never rewrites the manifest.
"""
import copy
import unittest
from pathlib import Path
import tempfile
import json
import hashlib
import re

import native_module_profile as profile

PROFILE_DIGEST = "12" * 32
ROOT = Path(__file__).resolve().parents[1]
NATIVE_SERVICE = "0x398dc3f0227d7efac5533ed5ce9937390c158084"
PERMISSIONS = {
    "NeoWitnessValidator": ["getAuthorizedModuleId", "getModule"],
    "SessionKeyValidator": ["getAccountAddress", "getAuthorizedModuleId", "getModule"],
    "WhitelistHook": ["getAuthorizedModuleId"],
}


def method(name, result, safe, types):
    return {"name": name, "returntype": result, "safe": safe,
            "parameters": [{"name": "p", "type": t} for t in types], "offset": 0}


def manifest(name="NeoWitnessValidator"):
    """A compiler manifest for a v4 native module, before admission."""
    methods = [
        method("getModuleProfile", "String", True, []),
        method("onInstall", "Void", False, ["Hash160", "Integer", "Integer", "Array"]),
        method("configure", "Void", False, ["Hash160", "Integer", "Integer", "Array"]),
        method("onUninstall", "Void", False, ["Hash160", "Integer", "Integer", "Array"]),
    ]
    if name.endswith("Hook"):
        methods.extend([
            method("preCheck", "ByteString", False, ["Hash160", "Array"]),
            method("postCheck", "Void", False, ["Hash160", "Array", "Any", "ByteString"]),
        ])
    else:
        methods.extend([
            method("validateUserOp", "Boolean", False, ["Hash160", "ByteString", "Array"]),
            method("onUserOpComplete", "Void", False, ["Hash160", "Array", "Any"]),
            method("getSignerDomains", "Array", True, ["Hash160", "Integer"]),
        ])
    methods.append(method("setConfig", "Void", False, ["Hash160", "Array"]))
    return {"name": name, "extra": {"SmartAccountProfile": "native-v4"},
            "permissions": [{"contract": NATIVE_SERVICE, "methods": list(PERMISSIONS[name])}],
            "abi": {"methods": methods}}


def hook_manifest():
    value = manifest("WhitelistHook")
    value["abi"]["methods"] = [m for m in value["abi"]["methods"] if m["name"] != "setConfig"]
    value["abi"]["methods"].append(method("setWhitelist", "Void", False, ["Hash160", "Array"]))
    return value


class NativeModuleProfileTests(unittest.TestCase):
    def package_manifest(self, value, role, capabilities, composite=False, digest=PROFILE_DIGEST, composite_profile=""):
        return profile.package_manifest(value, role, capabilities, composite, digest, composite_profile)

    def test_admission_is_read_only_and_keeps_the_v4_marker(self):
        original = manifest()
        admitted = self.package_manifest(original, "verifier", ["setConfig"])
        self.assertEqual(original, admitted)
        self.assertNotIn("smartAccount", admitted["extra"])
        legacy = copy.deepcopy(original); legacy["extra"]["SmartAccountProfile"] = "native-v2"
        with self.assertRaisesRegex(ValueError, "native-v4 profile marker"):
            self.package_manifest(legacy, "verifier", ["setConfig"])
        missing = copy.deepcopy(original); missing["extra"].clear()
        with self.assertRaises(ValueError):
            self.package_manifest(missing, "verifier", ["setConfig"])

    def test_digest_is_explicit_and_strict(self):
        for digest in ("", "AB" * 32, "12" * 31, 123):
            with self.subTest(digest=digest), self.assertRaises(ValueError):
                self.package_manifest(manifest(), "verifier", ["setConfig"], digest=digest)

    def test_composite_declarations_are_rejected_in_v4(self):
        # v4 replaced composite verifiers with the core threshold policy, so a
        # descriptor or manifest that still declares one must fail closed.
        for composite, composite_profile in ((True, "MultiSigValidator"), (False, "MultiSigValidator")):
            with self.subTest(composite=composite), self.assertRaisesRegex(ValueError, "composite verifiers"):
                self.package_manifest(manifest(), "verifier", ["setConfig"], composite, composite_profile=composite_profile)
        spec = {"project": "MultiSigValidator.Native.csproj", "role": "verifier",
                "configurationMethods": ["configure"], "compositeVerifier": True,
                "compositeProfile": "MultiSigValidator"}
        with self.assertRaisesRegex(ValueError, "composite verifiers"):
            profile.validate_descriptor({"MultiSigValidator": spec})

    def test_lifecycle_callbacks_must_be_non_safe(self):
        for name in ("validateUserOp", "onUserOpComplete"):
            wrong = copy.deepcopy(manifest())
            next(m for m in wrong["abi"]["methods"] if m["name"] == name)["safe"] = True
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "lifecycle safety"):
                self.package_manifest(wrong, "verifier", ["setConfig"])
        wrong = copy.deepcopy(manifest("WhitelistHook"))
        next(m for m in wrong["abi"]["methods"] if m["name"] == "preCheck")["safe"] = True
        with self.assertRaisesRegex(ValueError, "lifecycle safety"):
            self.package_manifest(wrong, "hook", ["setWhitelist"])

    def test_profile_getter_is_safe_read_only_and_unparameterised(self):
        unsafe = copy.deepcopy(manifest())
        next(m for m in unsafe["abi"]["methods"] if m["name"] == "getModuleProfile")["safe"] = False
        with self.assertRaisesRegex(ValueError, "lifecycle safety"):
            self.package_manifest(unsafe, "verifier", ["setConfig"])
        parameterised = copy.deepcopy(manifest())
        next(m for m in parameterised["abi"]["methods"] if m["name"] == "getModuleProfile")["parameters"] = [{"name": "p", "type": "Hash160"}]
        with self.assertRaisesRegex(ValueError, "lifecycle ABI"):
            self.package_manifest(parameterised, "verifier", ["setConfig"])

    def test_hook_requires_both_pre_and_post_check(self):
        for name in ("preCheck", "postCheck"):
            wrong = copy.deepcopy(manifest("WhitelistHook"))
            wrong["abi"]["methods"] = [m for m in wrong["abi"]["methods"] if m["name"] != name]
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "lifecycle ABI"):
                self.package_manifest(wrong, "hook", ["setWhitelist"])
        # A verifier callback set cannot be admitted as a hook and vice versa.
        with self.assertRaisesRegex(ValueError, "lifecycle ABI"):
            self.package_manifest(manifest(), "hook", ["setConfig"])

    def test_native_service_permissions_are_module_specific_and_exact(self):
        for methods in (["getAuthorizedModuleId"], ["getAuthorizedModuleId", "getModule", "unexpected"], [{"method": "getModule"}]):
            wrong = manifest(); wrong["permissions"][0]["methods"] = methods
            with self.subTest(methods=methods), self.assertRaisesRegex(ValueError, "allowlist"):
                self.package_manifest(wrong, "verifier", ["setConfig"])
        session = manifest("SessionKeyValidator")
        self.package_manifest(session, "verifier", ["setConfig"])
        session["permissions"][0]["methods"].append("setConfig")
        with self.assertRaisesRegex(ValueError, "allowlist"):
            self.package_manifest(session, "verifier", ["setConfig"])
        unknown = manifest(); unknown["name"] = "RenamedVerifier"
        with self.assertRaisesRegex(ValueError, "no permission profile"):
            self.package_manifest(unknown, "verifier", ["setConfig"])

    def test_native_service_permission_must_name_the_canonical_contract(self):
        for contract in ("*", "0x" + "00" * 20):
            wrong = manifest(); wrong["permissions"] = [{"contract": contract, "methods": list(PERMISSIONS["NeoWitnessValidator"])}]
            with self.assertRaises(ValueError):
                self.package_manifest(wrong, "verifier", ["setConfig"])
        for permissions in ([], [{"contract": NATIVE_SERVICE, "methods": list(PERMISSIONS["NeoWitnessValidator"])}] * 2):
            wrong = manifest(); wrong["permissions"] = permissions
            with self.assertRaises(ValueError):
                self.package_manifest(wrong, "verifier", ["setConfig"])

    def test_capabilities_reject_unsafe_ambiguity_and_reserved_methods(self):
        for capabilities in ([], ["missing"], ["setConfig", "setConfig"], ["getModuleProfile"],
                             ["onInstall"], ["validateUserOp"], ["_deploy"]):
            with self.subTest(capabilities=capabilities), self.assertRaises(ValueError):
                self.package_manifest(manifest(), "verifier", capabilities)
        for mutate in (lambda m: next(x for x in m["abi"]["methods"] if x["name"] == "setConfig").update(safe=True),
                       lambda m: next(x for x in m["abi"]["methods"] if x["name"] == "setConfig")["parameters"][0].update(type="Any"),
                       lambda m: m["abi"]["methods"].append(copy.deepcopy(next(x for x in m["abi"]["methods"] if x["name"] == "setConfig")))):
            wrong = manifest(); mutate(wrong)
            with self.assertRaises(ValueError):
                self.package_manifest(wrong, "verifier", ["setConfig"])
        self.package_manifest(manifest(), "verifier", ["configure"])

    def test_descriptor_is_nonempty_and_path_bounded(self):
        valid = {"NeoWitnessValidator": {"project": "NeoWitnessValidator.Native.csproj", "role": "verifier",
                                         "configurationMethods": ["configure"], "compositeVerifier": False,
                                         "compositeProfile": ""}}
        self.assertEqual(valid, profile.validate_descriptor(valid))
        for bad in ({}, [], {"../escape": valid["NeoWitnessValidator"]},
                    {"Name": {**valid["NeoWitnessValidator"], "project": "../escape.csproj"}},
                    {"Name": {**valid["NeoWitnessValidator"], "configurationMethods": "configure"}},
                    {"Name": {**valid["NeoWitnessValidator"], "role": "unknown"}},
                    {"Name": {k: v for k, v in valid["NeoWitnessValidator"].items() if k != "compositeProfile"}}):
            with self.assertRaises(ValueError):
                profile.validate_descriptor(bad)

    def parameters(self):
        return Path(__file__).resolve().parents[1] / "docs/proposals/smartaccount-native-profile-v4-parameters.json"

    def test_packaging_publishes_compiler_artifacts_unchanged_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); raw = root / "raw"; raw.mkdir(); output = root / "output"
            descriptor = root / "profiles.json"; parameters = root / "parameters.json"
            parameters.write_bytes(self.parameters().read_bytes())
            descriptor.write_text('{}')
            with self.assertRaises(ValueError):
                profile.package(raw, output, descriptor, parameters)
            self.assertEqual("FAIL", json.loads((output / "native-profile-packaging.json").read_text())["status"])
            descriptor.write_text(json.dumps({"NeoWitnessValidator": {"project": "Witness.Native.csproj", "role": "verifier",
                                                                     "configurationMethods": ["setConfig"],
                                                                     "compositeVerifier": False, "compositeProfile": ""}}))
            # Well-shaped diagnostic NEF with a RET script; production bytes are produced by the compiler.
            body = b'NEF3' + bytes(64) + bytes(5) + b'\x01\x40'
            nef = body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
            (raw / "NeoWitnessValidator.nef").write_bytes(nef)
            emitted = json.dumps(manifest())
            (raw / "NeoWitnessValidator.manifest.json").write_text(emitted)
            report = profile.package(raw, output, descriptor, parameters)
            self.assertEqual("PASS", report["status"])
            self.assertEqual(nef, (output / "NeoWitnessValidator.nef").read_bytes())
            self.assertEqual(emitted, (output / "NeoWitnessValidator.manifest.json").read_text())
            self.assertEqual({"nefSha256", "manifestSha256"}, set(report["artifacts"]["NeoWitnessValidator"]))
            (raw / "NeoWitnessValidator.nef").write_bytes(nef[:-1] + bytes([nef[-1] ^ 1]))
            with self.assertRaises(ValueError):
                profile.package(raw, output, descriptor, parameters)
            self.assertEqual("FAIL", json.loads((output / "native-profile-packaging.json").read_text())["status"])

    def test_native_source_preparation_is_explicit_and_does_not_mutate_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.cs"; source.write_text("#if SMARTACCOUNT_NATIVE\nclass Native {}\n#endif\n")
            original = source.read_bytes(); destination = Path(tmp) / "prepared.cs"
            profile.prepare_native_source(source, destination)
            self.assertEqual(original, source.read_bytes())
            self.assertEqual(b"#define SMARTACCOUNT_NATIVE\n" + original, destination.read_bytes())

    def test_native_source_preparation_preserves_crlf_and_removes_utf8_bom(self):
        with tempfile.TemporaryDirectory() as tmp:
            original = (b"\xef\xbb\xbf#if SMARTACCOUNT_NATIVE\r\n"
                        b"class Native {}\r\n#endif\r\n")
            source = Path(tmp) / "source.cs"
            source.write_bytes(original)
            destination = Path(tmp) / "prepared.cs"
            profile.prepare_native_source(source, destination)
            self.assertEqual(original, source.read_bytes())
            self.assertEqual(b"#define SMARTACCOUNT_NATIVE\n" + original[3:], destination.read_bytes())

    def test_profile_parameters_must_be_v4(self):
        v2 = ROOT / "docs/proposals/smartaccount-native-profile-v2-parameters.json"
        with self.assertRaisesRegex(ValueError, "ABI 4 profile parameters"):
            profile.profile_digest(v2)
        digest = profile.profile_digest(self.parameters())
        self.assertEqual(digest, profile.profile_digest(self.parameters()))
        self.assertTrue(re.fullmatch(r"[0-9a-f]{64}", digest))
        self.assertEqual(digest, hashlib.sha256(b"NeoSmartAccount/Profile" + bytes([4]) + json.dumps(
            json.loads(self.parameters().read_text()), sort_keys=True, separators=(",", ":"),
            ensure_ascii=True).encode()).hexdigest())


if __name__ == "__main__":
    unittest.main()
