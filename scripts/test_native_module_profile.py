"""Native packaging must enforce the profile instead of widening the native contract ABI."""
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


def manifest():
    def method(name, result, safe, types):
        return {"name":name,"returntype":result,"safe":safe,"parameters":[{"name":"p","type":t} for t in types],"offset":0}
    return {"name":"NeoNativeVerifier","extra":{"SmartAccountProfile":"native-v2"},"permissions":[{"contract":"0x398dc3f0227d7efac5533ed5ce9937390c158084","methods":["getAuthorityEpoch", "hasModuleContext"]}],"abi":{"methods":[
        method("supportsComposition","Boolean",True,[]),method("getSignerDomains","Array",True,["Hash160"]),
        method("clearAccount","Void",False,["Hash160"]),method("validateSignature","Boolean",False,["Hash160","Array"]),
        method("postExecute","Void",False,["Hash160","Array","Any"]),method("setConfig","Void",False,["Hash160","Array","Integer"])]}}


class NativeModuleProfileTests(unittest.TestCase):
    def package_manifest(self, value, role, capabilities, composite=False, digest=PROFILE_DIGEST):
        return profile.package_manifest(value, role, capabilities, composite, digest)

    def test_digest_and_composite_marker_are_explicit_and_strict(self):
        result = self.package_manifest(manifest(), "verifier", ["setConfig"])
        self.assertEqual(PROFILE_DIGEST, result["extra"]["smartAccount"]["profileDigest"])
        self.assertIs(False, result["extra"]["smartAccount"]["compositeVerifier"])
        for digest in ("", "AB" * 32, "12" * 31, 123):
            with self.assertRaises(ValueError):
                self.package_manifest(manifest(), "verifier", ["setConfig"], digest=digest)
        for composite in (None, 1, "false"):
            with self.assertRaises(ValueError):
                self.package_manifest(manifest(), "verifier", ["setConfig"], composite=composite)

    def test_composite_requires_exact_non_safe_receipt_callbacks(self):
        composite = manifest()
        for name, result, types in (("validateCompositeSignature", "Array", ["Hash160", "Array"]),
                ("postExecuteComposite", "Void", ["Hash160", "Array", "Any", "Array"])):
            composite["abi"]["methods"].append({"name":name,"returntype":result,"safe":False,
                "parameters":[{"name":"p","type":t} for t in types],"offset":0})
        self.assertIs(True, self.package_manifest(composite, "verifier", ["setConfig"], True)["extra"]["smartAccount"]["compositeVerifier"])
        for variant in ("missing", "safe", "wrong-result", "wrong-arity", "wrong-type"):
            wrong = copy.deepcopy(composite)
            if variant == "missing": wrong["abi"]["methods"].pop()
            elif variant == "safe": wrong["abi"]["methods"][-1]["safe"] = True
            elif variant == "wrong-result": wrong["abi"]["methods"][-2]["returntype"] = "Boolean"
            elif variant == "wrong-arity": wrong["abi"]["methods"][-1]["parameters"].pop()
            else: wrong["abi"]["methods"][-1]["parameters"][-1]["type"] = "Any"
            with self.subTest(variant=variant), self.assertRaises(ValueError):
                self.package_manifest(wrong, "verifier", ["setConfig"], True)
        for name in ("validateCompositeSignature", "postExecuteComposite", "validateSignatureForPostExecute"):
            wrong = copy.deepcopy(composite)
            wrong["abi"]["methods"] = [m for m in wrong["abi"]["methods"] if m["name"] != name]
            wrong["abi"]["methods"].append({"name":name,"returntype":"Void","safe":False,
                "parameters":[{"name":"p","type":"Hash160"}],"offset":0})
            with self.assertRaises(ValueError): self.package_manifest(wrong, "verifier", [name])

    def test_native_lifecycle_callbacks_must_be_non_safe(self):
        # Verifier validation and every module post callback are authenticated
        # application phases, never public read-only ABI methods.
        for name in ("validateSignature", "postExecute"):
            wrong = copy.deepcopy(manifest())
            next(method for method in wrong["abi"]["methods"] if method["name"] == name)["safe"] = True
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "lifecycle safety"):
                self.package_manifest(wrong, "verifier", ["setConfig"])

        # Exercise the hook branch separately because its required callback is
        # preExecute rather than validateSignature.
        hook = copy.deepcopy(manifest())
        hook["name"] = "WhitelistHook"
        hook["abi"]["methods"] = [
            method for method in hook["abi"]["methods"]
            if method["name"] not in ("getSignerDomains", "validateSignature", "setConfig")
        ]
        hook["abi"]["methods"].extend([
            {"name": "preExecute", "returntype": "Void", "safe": False,
             "parameters": [{"name": "p", "type": "Hash160"}, {"name": "p", "type": "Array"}], "offset": 0},
            {"name": "setWhitelist", "returntype": "Void", "safe": False,
             "parameters": [{"name": "p", "type": "Hash160"}, {"name": "p", "type": "Array"}], "offset": 0},
        ])
        self.assertIs(False, self.package_manifest(hook, "hook", ["setWhitelist"])["extra"]["smartAccount"]["compositeVerifier"])
        next(method for method in hook["abi"]["methods"] if method["name"] == "preExecute")["safe"] = True
        with self.assertRaisesRegex(ValueError, "lifecycle safety"):
            self.package_manifest(hook, "hook", ["setWhitelist"])

    def test_native_session_requires_explicit_canonical_key_helper_permission(self):
        original = manifest(); original["name"] = "SessionKeyVerifier"
        with self.assertRaises(ValueError): self.package_manifest(original, "verifier", ["setConfig"])
        original["permissions"][0]["methods"] = [
            "canonicalP256PublicKey", "getAccountAddress", "getAuthorizationDomain",
            "getAuthorityEpoch", "getOperationDigest", "hasModuleContext",
        ]
        self.package_manifest(original, "verifier", ["setConfig"])
        for methods in ("*", ["getAuthorityEpoch"]):
            wrong = copy.deepcopy(original); wrong["permissions"][0]["methods"] = methods
            with self.assertRaises(ValueError): self.package_manifest(wrong, "verifier", ["setConfig"])

    def test_native_service_permissions_are_module_specific_and_exact(self):
        for methods in (["getAuthorityEpoch"], ["getAuthorityEpoch", "hasModuleContext", "unexpected"], [{"method": "getAuthorityEpoch"}]):
            wrong = manifest(); wrong["permissions"][0]["methods"] = methods
            with self.assertRaisesRegex(ValueError, "allowlist"):
                self.package_manifest(wrong, "verifier", ["setConfig"])

        session = manifest(); session["name"] = "SessionKeyVerifier"
        session["permissions"][0]["methods"] = [
            "canonicalP256PublicKey", "getAccountAddress", "getAuthorizationDomain",
            "getAuthorityEpoch", "getOperationDigest", "hasModuleContext",
        ]
        self.package_manifest(session, "verifier", ["setConfig"])
        session["permissions"][0]["methods"].append("setConfig")
        with self.assertRaisesRegex(ValueError, "allowlist"):
            self.package_manifest(session, "verifier", ["setConfig"])

    def test_native_session_uses_the_profile_call_flag_for_canonicalization(self):
        source = (ROOT / "contracts/verifiers/SessionKeyVerifier.cs").read_text(encoding="utf-8")
        method = source.split("public static void SetSessionKey", 1)[1]
        native_block = method.split("#endif", 1)[0]
        self.assertIn('"canonicalP256PublicKey"', native_block)
        self.assertIn("CallFlags.None", native_block)
        self.assertNotIn("CallFlags.ReadOnly", native_block)

    def test_descriptor_is_nonempty_and_path_bounded(self):
        valid = {"NeoNativeVerifier": {"project":"NeoNativeVerifier.Native.csproj", "role":"verifier", "configurationMethods":["setConfig"], "compositeVerifier":False}}
        self.assertEqual(valid, profile.validate_descriptor(valid))
        for bad in ({}, [], {"../escape":valid["NeoNativeVerifier"]}, {"Name":{**valid["NeoNativeVerifier"], "project":"../escape.csproj"}},
                    {"Name":{**valid["NeoNativeVerifier"], "configurationMethods":"setConfig"}},
                    {"Name":{**valid["NeoNativeVerifier"], "role":"unknown"}}):
            with self.assertRaises(ValueError): profile.validate_descriptor(bad)

    def test_packaging_failure_invalidates_receipt_and_success_preserves_nef(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); raw=root/"raw"; raw.mkdir(); output=root/"output"; descriptor=root/"profiles.json"; parameters=root/"parameters.json"
            parameters.write_bytes((Path(__file__).resolve().parents[1]/"docs/proposals/smartaccount-native-profile-v2-parameters.json").read_bytes())
            descriptor.write_text('{}')
            with self.assertRaises(ValueError):profile.package(raw,output,descriptor,parameters)
            self.assertEqual("FAIL",json.loads((output/"native-profile-packaging.json").read_text())["status"])
            descriptor.write_text(json.dumps({"NeoNativeVerifier":{"project":"Verifier.Native.csproj","role":"verifier","configurationMethods":["setConfig"], "compositeVerifier":False}}))
            # Well-shaped diagnostic NEF with a RET script; production bytes are produced by the compiler.
            body=b'NEF3'+bytes(64)+bytes(5)+b'\x01\x40'
            nef=body+hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
            (raw/"NeoNativeVerifier.nef").write_bytes(nef)
            (raw/"NeoNativeVerifier.manifest.json").write_text(json.dumps(manifest()))
            self.assertEqual("PASS",profile.package(raw,output,descriptor,parameters)["status"])
            self.assertEqual(nef,(output/"NeoNativeVerifier.nef").read_bytes())
            (raw/"NeoNativeVerifier.nef").write_bytes(nef[:-1]+bytes([nef[-1]^1]))
            with self.assertRaises(ValueError):profile.package(raw,output,descriptor,parameters)
            self.assertEqual("FAIL",json.loads((output/"native-profile-packaging.json").read_text())["status"])

    def test_exact_native_abi_and_explicit_capability_metadata(self):
        original=manifest();packaged=self.package_manifest(original,"verifier",["setConfig"])
        self.assertNotIn("smartAccount",original["extra"])
        self.assertEqual(2, packaged["extra"]["smartAccount"]["abiVersion"])
        self.assertEqual(["setConfig"],packaged["extra"]["smartAccount"]["configurationMethods"])
        self.assertEqual(original["abi"],packaged["abi"])

    def test_legacy_abi_or_missing_marker_cannot_be_relabelled_native(self):
        for mutate in [lambda m:m["extra"].clear(),lambda m:m["abi"]["methods"][3]["parameters"][1].update(type="Any")]:
            wrong=manifest();mutate(wrong)
            with self.assertRaises(ValueError):self.package_manifest(wrong,"verifier",["setConfig"])

    def test_v1_marker_cannot_be_relabelled_as_v2(self):
        wrong = manifest(); wrong["extra"]["SmartAccountProfile"] = "native-v1"
        with self.assertRaises(ValueError): self.package_manifest(wrong, "verifier", ["setConfig"])

    def test_epoch_permission_must_name_the_native_service_and_method(self):
        for permissions in ([], [{"contract": "*", "methods": ["getAuthorityEpoch"]}],
                            [{"contract": "0x398dc3f0227d7efac5533ed5ce9937390c158084", "methods": "*"}],
                            [{"contract": "0x398dc3f0227d7efac5533ed5ce9937390c158084", "methods": ["hasModuleContext"]}],
                            [{"contract": "0x" + "00" * 20, "methods": ["getAuthorityEpoch"]}]):
            wrong = manifest(); wrong["permissions"] = permissions
            with self.assertRaises(ValueError): self.package_manifest(wrong, "verifier", ["setConfig"])

    def test_capabilities_reject_unsafe_ambiguity_and_reserved_methods(self):
        for methods in [[],["missing"],["setConfig","setConfig"],["clearAccount"],["_deploy"]]:
            with self.assertRaises(ValueError):self.package_manifest(manifest(),"verifier",methods)
        for mutate in [lambda m:m["abi"]["methods"][-1].update(safe=True),
                       lambda m:m["abi"]["methods"][-1]["parameters"][0].update(type="Any"),
                       lambda m:m["abi"]["methods"].append(copy.deepcopy(m["abi"]["methods"][-1]))]:
            wrong=manifest();mutate(wrong)
            with self.assertRaises(ValueError):self.package_manifest(wrong,"verifier",["setConfig"])

    def test_native_source_preparation_is_explicit_and_does_not_mutate_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/"source.cs";source.write_text("#if SMARTACCOUNT_NATIVE\nclass Native {}\n#endif\n")
            original=source.read_bytes();destination=Path(tmp)/"prepared.cs"
            profile.prepare_native_source(source,destination)
            self.assertEqual(original,source.read_bytes())
            self.assertEqual(b"#define SMARTACCOUNT_NATIVE\n"+original,destination.read_bytes())

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

    def test_profile_digest_definitions_match_canonical_parameters(self):
        """Client and service literals must fail closed when profile parameters change."""
        parameters = ROOT / "docs/proposals/smartaccount-native-profile-v2-parameters.json"
        expected = profile.profile_digest(parameters)
        definitions = {
            "shared client": (
                ROOT / "shared/nativeSmartAccountClient.mjs",
                r"NATIVE_PROFILE_PARAMETER_DIGEST\s*=\s*\"([0-9a-f]{64})\"",
            ),
            "frontend client": (
                ROOT / "frontend/src/shared/nativeSmartAccountClient.mjs",
                r"NATIVE_PROFILE_PARAMETER_DIGEST\s*=\s*\"([0-9a-f]{64})\"",
            ),
            "SmartAccount native contract validator": (
                ROOT / "scripts/neoexpress_native_service_validate.py",
                r"\bDIGEST\s*=\s*\"([0-9a-f]{64})\"",
            ),
        }
        for label, (path, pattern) in definitions.items():
            matches = re.findall(pattern, path.read_text(encoding="utf-8"))
            with self.subTest(label=label):
                self.assertEqual(1, len(matches), f"expected one digest definition in {path}")
                self.assertEqual(expected, matches[0], f"{path} is out of sync with canonical profile parameters")


if __name__=="__main__":unittest.main()
