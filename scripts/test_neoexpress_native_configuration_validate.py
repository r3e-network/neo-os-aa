"""Fail-closed controls for persisted native configuration diagnostics."""
import hashlib
import unittest
import neoexpress_native_configuration_validate as config
from neoexpress_validate import ValidationFailure


class NativeConfigurationTests(unittest.TestCase):
    def test_fixture_checksums_and_lifecycle_are_exact(self):
        for hook in (False, True):
            for root in (False, True):
                script, nef, manifest = config.module_fixture(hook, root)
                self.assertEqual(hashlib.sha256(hashlib.sha256(nef[:-4]).digest()).digest()[:4], nef[-4:])
                self.assertTrue(nef[:-4].endswith(script))
                methods = {m["name"]: m for m in manifest["abi"]["methods"]}
                self.assertEqual("Boolean", methods["supportsComposition"]["returntype"])
                self.assertEqual(root, script[methods["supportsComposition"]["offset"]] == 8)
                self.assertEqual("Void", methods["clearAccount"]["returntype"])
                self.assertEqual(["Hash160", "Integer"], [a["type"] for a in methods["configure"]["parameters"]])
                self.assertEqual(["configure"], manifest["extra"]["smartAccount"]["configurationMethods"])

    def test_destructive_fixture_contains_targeted_call_after_write(self):
        root = "0x" + "01" * 20
        script, _, _ = config.module_fixture(False, False, root)
        put = config.syscall("System.Storage.Put")
        self.assertLess(script.index(put), script.index(b"destroySelf"))
        self.assertIn(bytes.fromhex("01" * 20), script)

    def test_positive_and_negative_fixtures_have_distinct_deployment_names(self):
        for hook in (False, True):
            good = config.module_fixture(hook, False)[2]
            bad = config.module_fixture(hook, False, "0x" + "01" * 20)[2]
            self.assertNotEqual(good["name"], bad["name"])

    def test_configuration_fault_requires_precise_cause_and_no_effects(self):
        good = {"vmstate": "FAULT", "exception": "The module is zero, native or blocked.", "notifications": []}
        config.check_configuration_outcome(good, fault=True)
        for patch in ({"vmstate": "HALT"}, {"exception": "out of gas"}, {"notifications": [{}]}):
            with self.assertRaises(ValidationFailure): config.check_configuration_outcome({**good, **patch}, fault=True)

    def test_false_configuration_result_is_a_committed_success(self):
        valid = {"vmstate": "HALT", "stack": [{"type": "Boolean", "value": False}]}
        config.check_configuration_outcome(valid, fault=False)
        for stack in ([], [{"type": "Integer", "value": "0"}], [{"type": "Boolean", "value": True}]):
            with self.assertRaises(ValidationFailure): config.check_configuration_outcome({**valid, "stack": stack}, fault=False)

    def test_log_wait_only_accepts_known_not_yet_persisted_errors(self):
        self.assertTrue(config.pending_log(ValidationFailure("rpc getapplicationlog: Unknown transaction/blockhash")))
        for message in ("connection reset", "rpc getapplicationlog: out of gas", "Unknown transaction", "rpc getapplicationlog: Unknown transaction/blockhash extra"):
            self.assertFalse(config.pending_log(ValidationFailure(message)))


if __name__ == "__main__": unittest.main()
