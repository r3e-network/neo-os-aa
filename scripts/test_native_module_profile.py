"""Native packaging must enforce the profile instead of widening the service ABI."""
import copy
import unittest
from pathlib import Path
import tempfile
import json
import hashlib

import native_module_profile as profile


def manifest():
    def method(name, result, safe, types):
        return {"name":name,"returntype":result,"safe":safe,"parameters":[{"name":"p","type":t} for t in types],"offset":0}
    return {"name":"NeoNativeVerifier","extra":{"SmartAccountProfile":"native-v2"},"permissions":[{"contract":"0xd9421d07adf206e9dc4be746a02e8e087fa61741","methods":["getAuthorityEpoch"]}],"abi":{"methods":[
        method("supportsComposition","Boolean",True,[]),method("getSignerDomains","Array",True,["Hash160"]),
        method("clearAccount","Void",False,["Hash160"]),method("validateSignature","Boolean",False,["Hash160","Array"]),
        method("postExecute","Void",False,["Hash160","Array","Any"]),method("setConfig","Void",False,["Hash160","Array","Integer"])]}}


class NativeModuleProfileTests(unittest.TestCase):
    def test_descriptor_is_nonempty_and_path_bounded(self):
        valid = {"NeoNativeVerifier": {"project":"NeoNativeVerifier.Native.csproj", "role":"verifier", "configurationMethods":["setConfig"]}}
        self.assertEqual(valid, profile.validate_descriptor(valid))
        for bad in ({}, [], {"../escape":valid["NeoNativeVerifier"]}, {"Name":{**valid["NeoNativeVerifier"], "project":"../escape.csproj"}},
                    {"Name":{**valid["NeoNativeVerifier"], "configurationMethods":"setConfig"}},
                    {"Name":{**valid["NeoNativeVerifier"], "role":"unknown"}}):
            with self.assertRaises(ValueError): profile.validate_descriptor(bad)

    def test_packaging_failure_invalidates_receipt_and_success_preserves_nef(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); raw=root/"raw"; raw.mkdir(); output=root/"output"; descriptor=root/"profiles.json"
            descriptor.write_text('{}')
            with self.assertRaises(ValueError):profile.package(raw,output,descriptor)
            self.assertEqual("FAIL",json.loads((output/"native-profile-packaging.json").read_text())["status"])
            descriptor.write_text(json.dumps({"NeoNativeVerifier":{"project":"Verifier.Native.csproj","role":"verifier","configurationMethods":["setConfig"]}}))
            # Well-shaped diagnostic NEF with a RET script; production bytes are produced by the compiler.
            body=b'NEF3'+bytes(64)+bytes(5)+b'\x01\x40'
            nef=body+hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
            (raw/"NeoNativeVerifier.nef").write_bytes(nef)
            (raw/"NeoNativeVerifier.manifest.json").write_text(json.dumps(manifest()))
            self.assertEqual("PASS",profile.package(raw,output,descriptor)["status"])
            self.assertEqual(nef,(output/"NeoNativeVerifier.nef").read_bytes())
            (raw/"NeoNativeVerifier.nef").write_bytes(nef[:-1]+bytes([nef[-1]^1]))
            with self.assertRaises(ValueError):profile.package(raw,output,descriptor)
            self.assertEqual("FAIL",json.loads((output/"native-profile-packaging.json").read_text())["status"])

    def test_exact_native_abi_and_explicit_capability_metadata(self):
        original=manifest();packaged=profile.package_manifest(original,"verifier",["setConfig"])
        self.assertNotIn("smartAccount",original["extra"])
        self.assertEqual(2, packaged["extra"]["smartAccount"]["abiVersion"])
        self.assertEqual(["setConfig"],packaged["extra"]["smartAccount"]["configurationMethods"])
        self.assertEqual(original["abi"],packaged["abi"])

    def test_legacy_abi_or_missing_marker_cannot_be_relabelled_native(self):
        for mutate in [lambda m:m["extra"].clear(),lambda m:m["abi"]["methods"][3]["parameters"][1].update(type="Any")]:
            wrong=manifest();mutate(wrong)
            with self.assertRaises(ValueError):profile.package_manifest(wrong,"verifier",["setConfig"])

    def test_v1_marker_cannot_be_relabelled_as_v2(self):
        wrong = manifest(); wrong["extra"]["SmartAccountProfile"] = "native-v1"
        with self.assertRaises(ValueError): profile.package_manifest(wrong, "verifier", ["setConfig"])

    def test_epoch_permission_must_name_the_native_service_and_method(self):
        for permissions in ([], [{"contract": "*", "methods": ["getAuthorityEpoch"]}],
                            [{"contract": "0xd9421d07adf206e9dc4be746a02e8e087fa61741", "methods": "*"}],
                            [{"contract": "0xd9421d07adf206e9dc4be746a02e8e087fa61741", "methods": ["hasModuleContext"]}],
                            [{"contract": "0x" + "00" * 20, "methods": ["getAuthorityEpoch"]}]):
            wrong = manifest(); wrong["permissions"] = permissions
            with self.assertRaises(ValueError): profile.package_manifest(wrong, "verifier", ["setConfig"])

    def test_capabilities_reject_unsafe_ambiguity_and_reserved_methods(self):
        for methods in [[],["missing"],["setConfig","setConfig"],["clearAccount"],["_deploy"]]:
            with self.assertRaises(ValueError):profile.package_manifest(manifest(),"verifier",methods)
        for mutate in [lambda m:m["abi"]["methods"][-1].update(safe=True),
                       lambda m:m["abi"]["methods"][-1]["parameters"][0].update(type="Any"),
                       lambda m:m["abi"]["methods"].append(copy.deepcopy(m["abi"]["methods"][-1]))]:
            wrong=manifest();mutate(wrong)
            with self.assertRaises(ValueError):profile.package_manifest(wrong,"verifier",["setConfig"])

    def test_native_source_preparation_is_explicit_and_does_not_mutate_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/"source.cs";source.write_text("#if SMARTACCOUNT_NATIVE\nclass Native {}\n#endif\n")
            original=source.read_bytes();destination=Path(tmp)/"prepared.cs"
            profile.prepare_native_source(source,destination)
            self.assertEqual(original,source.read_bytes())
            self.assertEqual(b"#define SMARTACCOUNT_NATIVE\n"+original,destination.read_bytes())


if __name__=="__main__":unittest.main()
