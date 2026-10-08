"""Receipt checks for the actual native-service private-chain harness."""
import base64
import copy
import unittest
from unittest.mock import Mock
import neoexpress_native_service_validate as native
from neoexpress_validate import ValidationFailure


class NativeServiceReceiptTests(unittest.TestCase):
    def manifest(self):
        return {"hash": native.CORE, "id": -13, "manifest": {"name": "AccountManagement",
            "extra": {"smartAccount": {"abiVersion": 2, "profileParameterDigest": native.DIGEST}},
            "abi": {"methods": [{"name": n, "parameters": [{"type":t} for t in ('Hash160','Array','Integer','Integer')]}
                                 if n in ('executeUserOp','executeUserOps') else {"name":n} for n in native.REQUIRED_METHODS],
                    "events": [{"name": n} for n in native.REQUIRED_EVENTS]}}}

    def test_valid_native_identity(self):
        native.check_native(self.manifest())

    def test_mismatched_native_identity_is_rejected(self):
        for key, value in (("hash", "0x" + "00" * 20), ("id", 1)):
            item = self.manifest(); item[key] = value
            with self.assertRaises(ValidationFailure): native.check_native(item)
        item = self.manifest(); item["manifest"]["extra"]["smartAccount"]["abiVersion"] = 1
        with self.assertRaises(ValidationFailure): native.check_native(item)
        item = self.manifest(); item["manifest"]["extra"]["smartAccount"]["profileParameterDigest"] = "00" * 32
        with self.assertRaises(ValidationFailure): native.check_native(item)

    def test_record_requires_version_two_and_unsigned_authority_counters(self):
        record=[2,bytes(20),bytes(20),bytes(20),None,None,None,0,11,None,None,None,None,7]
        self.assertEqual(record,native.check_account_record(record))
        for index,value in ((0,1),(0,True),(8,-1),(8,True),(13,-1),(13,2**64),(13,True)):
            bad=list(record);bad[index]=value
            with self.assertRaises(ValidationFailure):native.check_account_record(bad)
        with self.assertRaises(ValidationFailure):native.check_account_record(record[:13])

    def test_execution_arguments_pin_both_live_authority_counters(self):
        from neoexpress_validate import H, I
        account='0x'+'11'*20; payload=native.operation(7)
        record=[2,bytes.fromhex('11'*20),bytes(20),bytes(20),None,None,None,0,11,None,None,None,None,7]
        self.assertEqual([H(account),payload,I(7),I(11)],native.execution_arguments(account,payload,record))
        with self.assertRaises(ValidationFailure): native.execution_arguments('0x'+'22'*20,payload,record)
        for index,value in ((8,True),(13,-1),(13,2**64)):
            bad=copy.deepcopy(record);bad[index]=value
            with self.assertRaises(ValidationFailure): native.execution_arguments(account,payload,bad)

    def test_disabled_or_missing_abi_is_not_conformance(self):
        for key in ("methods", "events"):
            item = self.manifest(); item["manifest"]["abi"][key] = []
            with self.assertRaises(ValidationFailure): native.check_native(item)

    def test_two_argument_execution_abi_is_rejected_even_with_matching_metadata(self):
        for method in ('executeUserOp','executeUserOps'):
            item=self.manifest()
            row=next(m for m in item['manifest']['abi']['methods'] if m['name']==method)
            row['parameters']=row['parameters'][:2]
            with self.assertRaises(ValidationFailure):native.check_native(item)

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


class TransactionSystemFeeTests(unittest.TestCase):
    def setUp(self):
        self.script = b"\x00\x0c\x03\xff\x00\x81\x40"
        self.signers = [{"account": "0x" + "12" * 20, "scopes": "CalledByEntry"},
                        {"account": "0x" + "34" * 20, "scopes": "WitnessRules",
                         "rules": [{"action": "Allow", "condition": {"type": "CalledByEntry"}}]}]

    def fee(self, result):
        chain = Mock()
        chain.rpc.return_value = result
        signers_before = copy.deepcopy(self.signers)
        fee = native.transaction_system_fee(chain, self.script, self.signers)
        chain.rpc.assert_called_once_with("invokescript", [base64.b64encode(self.script).decode("ascii"), self.signers])
        self.assertEqual(signers_before, self.signers)
        self.assertIs(type(fee), int)
        return fee

    def test_reserves_larger_minimum_for_halt_and_deliberate_fault(self):
        for state in ("HALT", "FAULT"):
            with self.subTest(state=state):
                self.assertEqual(125_000_000, self.fee({"state": state, "gasconsumed": "2100000",
                    "minimumrequiredfee": "125000000", "exception": "expected rejection" if state == "FAULT" else None}))

    def test_consumed_fee_above_minimum_is_preserved_exactly(self):
        for state in ("HALT", "FAULT"):
            with self.subTest(state=state):
                self.assertEqual(9_007_199_254_740_993, self.fee({"state": state,
                    "gasconsumed": "9007199254740993", "minimumrequiredfee": "125000000"}))

    def test_zero_fees_are_valid(self):
        self.assertEqual(0, self.fee({"state": "HALT", "gasconsumed": "0", "minimumrequiredfee": "0"}))

    def test_missing_consumed_or_minimum_fee_fails_closed(self):
        for field in ("gasconsumed", "minimumrequiredfee"):
            result = {"state": "HALT", "gasconsumed": "1", "minimumrequiredfee": "2"}
            del result[field]
            with self.subTest(field=field), self.assertRaises(ValidationFailure):
                self.fee(result)

    def test_malformed_fee_amounts_fail_closed(self):
        for field in ("gasconsumed", "minimumrequiredfee"):
            for value in (None, True, False, -1, 1, 1.0, "-1", "+1", "1.0", "1e3", "", " 1", "1 ", "1\n", "١", "1_000"):
                result = {"state": "HALT", "gasconsumed": "1", "minimumrequiredfee": "2", field: value}
                with self.subTest(field=field, value=value), self.assertRaises(ValidationFailure):
                    self.fee(result)

    def test_missing_or_unfinished_simulation_state_fails_closed(self):
        for state in (None, "BREAK", "NONE", "HALT, BREAK", True):
            with self.subTest(state=state), self.assertRaises(ValidationFailure):
                self.fee({"state": state, "gasconsumed": "1", "minimumrequiredfee": "2"})


if __name__ == "__main__": unittest.main()
