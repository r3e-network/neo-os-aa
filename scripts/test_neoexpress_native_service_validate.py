"""Receipt checks for the actual native-service private-chain harness."""
import copy
import unittest
import neoexpress_native_service_validate as native
from neoexpress_validate import ValidationFailure


class NativeServiceReceiptTests(unittest.TestCase):
    def manifest(self):
        return {"hash": native.CORE, "id": -13, "manifest": {"name": "AccountManagement",
            "extra": {"smartAccount": {"abiVersion": 1, "profileParameterDigest": native.DIGEST}},
            "abi": {"methods": [{"name": n} for n in native.REQUIRED_METHODS],
                    "events": [{"name": n} for n in native.REQUIRED_EVENTS]}}}

    def test_valid_native_identity(self):
        native.check_native(self.manifest())

    def test_mismatched_native_identity_is_rejected(self):
        for key, value in (("hash", "0x" + "00" * 20), ("id", 1)):
            item = self.manifest(); item[key] = value
            with self.assertRaises(ValidationFailure): native.check_native(item)
        item = self.manifest(); item["manifest"]["extra"]["smartAccount"]["abiVersion"] = 2
        with self.assertRaises(ValidationFailure): native.check_native(item)
        item = self.manifest(); item["manifest"]["extra"]["smartAccount"]["profileParameterDigest"] = "00" * 32
        with self.assertRaises(ValidationFailure): native.check_native(item)

    def test_disabled_or_missing_abi_is_not_conformance(self):
        for key in ("methods", "events"):
            item = self.manifest(); item["manifest"]["abi"][key] = []
            with self.assertRaises(ValidationFailure): native.check_native(item)

    def test_persisted_outcome_and_event_are_both_required(self):
        valid = {"vmstate": "HALT", "notifications": [{"eventname": "AccountCreated", "contract": native.CORE}]}
        native.check_application(valid, "AccountCreated")
        for patch in ({"vmstate": "FAULT"}, {"notifications": []},
                      {"notifications": [{"eventname": "AccountCreated", "contract": "0x" + "00" * 20}]}):
            item = copy.deepcopy(valid); item.update(patch)
            with self.assertRaises(ValidationFailure): native.check_application(item, "AccountCreated")

    def test_witness_probe_has_valid_nef_and_exact_abi(self):
        import hashlib
        script, nef, manifest = native.witness_probe()
        self.assertEqual(hashlib.sha256(hashlib.sha256(nef[:-4]).digest()).digest()[:4], nef[-4:])
        self.assertEqual(b"\x41" + hashlib.sha256(b"System.Runtime.CheckWitness").digest()[:4] + b"\x40", script)
        method = manifest["abi"]["methods"][0]
        self.assertEqual("Boolean", method["returntype"])
        self.assertEqual([{"name": "principal", "type": "Hash160"}], method["parameters"])

    def test_operation_is_exact_six_field_array(self):
        op = native.operation(7)
        self.assertEqual("Array", op["type"]); self.assertEqual(6, len(op["value"]))
        self.assertEqual("7", op["value"][3]["value"])
        self.assertEqual("", op["value"][5]["value"])


if __name__ == "__main__": unittest.main()
