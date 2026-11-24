"""Receipt checks for the actual native-contract private-chain harness."""
import base64
import copy
import unittest
from unittest.mock import Mock, patch
import neoexpress_native_service_validate as native
from neoexpress_validate import ValidationFailure


class NativeContractReceiptTests(unittest.TestCase):
    def test_consent_signers_each_sign_and_node_state_is_restored(self):
        from types import SimpleNamespace
        from pathlib import Path
        keys = [SimpleNamespace(script_hash=bytes([n]) * 20, verification=bytes([n]), sign=Mock(return_value=bytes([n]) * 64)) for n in (1, 2)]
        chain = SimpleNamespace(workdir=Path("/unused"), node=None, magic=123,
            wallet_private_key=Mock(side_effect=["owner-key", "guardian-key"]),
            start_node=Mock(), stop_node=Mock())
        captured = {}
        execution = {"vmstate": "HALT", "gasconsumed": "10", "stack": [{"type": "ByteString", "value": base64.b64encode(bytes(20)).decode()}], "notifications": []}
        def rpc(method, args):
            if method == "getblockcount": return 10
            if method == "sendrawtransaction":
                captured["raw"] = base64.b64decode(args[0])
                # Two fixed witnesses are 69 bytes each plus the witness count.
                unsigned = captured["raw"][:-139]
                import hashlib
                captured["txid"] = "0x" + hashlib.sha256(unsigned).digest()[::-1].hex()
                return {"hash": captured["txid"]}
            if method == "getapplicationlog": return {"executions": [execution]}
            if method == "getrawtransaction": return {"hash": captured["txid"]}
            self.fail("Unexpected RPC: " + method)
        chain.rpc = rpc
        report = {"transactions": []}
        with patch.object(native, "RawKey", side_effect=keys), patch.object(native, "transaction_system_fee", return_value=100), patch.object(native, "check_application"), patch("neoexpress_native_proxy_validate.check_transaction") as readback:
            native.persist(chain, report, "register", "registerAccount", [], "AccountCreated", consent_wallets=("guardian",))
        self.assertEqual(1, keys[0].sign.call_count)
        self.assertEqual(keys[0].sign.call_args, keys[1].sign.call_args)
        self.assertEqual(2, len(readback.call_args.args[3]))
        self.assertEqual(2, len(readback.call_args.args[4]))
        self.assertEqual(2, report["transactions"][0]["consentWitnesses"])
        chain.stop_node.assert_called_once()

    def manifest(self):
        return {"hash": native.CORE, "id": -13, "manifest": {"name": "SmartAccount",
            "extra": {"smartAccount": {"abiVersion": 2, "profileParameterDigest": native.DIGEST}},
            "abi": {"methods": [{"name": name, **copy.deepcopy(descriptor)}
                                  for name, descriptor in native.REQUIRED_METHOD_ABI.items()],
                    "events": [{"name": name, "parameters": copy.deepcopy(parameters)}
                               for name, parameters in native.REQUIRED_EVENT_ABI.items()]}}}

    def test_valid_native_identity(self):
        native.check_native(self.manifest())

    def test_activation_profile_storage_readback_is_exact(self):
        record = b"\x80\x02\x03\x02\x00\x20" + bytes.fromhex(native.DIGEST)
        chain = Mock(); chain.rpc.return_value = base64.b64encode(record).decode("ascii")
        native.check_profile_storage_readback(chain)
        chain.rpc.assert_called_once_with("getstorage", [native.CORE, "00"])
        for bad in (None, "",
                    base64.b64encode(b"\x80\x02\x03\x02\x00\x20" + b"\x00" * 32).decode("ascii"),
                    base64.b64encode(b"\x80\x02\x03\x01\x00\x20" + bytes.fromhex(native.DIGEST)).decode("ascii"),
                    base64.b64encode(b"\x80\x02\x03\x02\x00\x20" + bytes.fromhex(native.DIGEST)[:-1]).decode("ascii")):
            chain = Mock(); chain.rpc.return_value = bad
            with self.assertRaises(ValidationFailure):
                native.check_profile_storage_readback(chain)

    def test_prior_abi2_digest_does_not_identify_authority_admission_revision(self):
        legacy = self.manifest()
        legacy["manifest"]["extra"]["smartAccount"]["profileParameterDigest"] = "4201b02f571b7415121467d67343a8189b8070ad795a82424c0403782d22b1b4"
        with self.assertRaises(ValidationFailure):
            native.check_native(legacy)

    def test_contract_digest_matches_the_canonical_current_parameters(self):
        import hashlib
        import json
        from pathlib import Path
        parameters = json.loads((Path(__file__).resolve().parent.parent / 'docs/archive/native-research/smartaccount-native-profile-v2-parameters.json').read_text())
        canonical = json.dumps(parameters, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()
        self.assertEqual(hashlib.sha256(b'NeoSmartAccount/Profile\x02' + canonical).hexdigest(), native.DIGEST)
        self.assertEqual('ae557647b63789c7af0a8c7816dc90d5c0d7e65afb78ce3c669de9a01ce3c91a', native.DIGEST)

    def test_p256_canonicalization_abi_is_unique_safe_and_account_independent(self):
        item = self.manifest(); native.check_native(item)
        methods = item['manifest']['abi']['methods']
        canonical = next(row for row in methods if row['name'] == 'canonicalP256PublicKey')
        for field, value in (('parameters', []), ('parameters', [{'type': 'Hash160'}, {'type': 'ByteArray'}]),
                             ('parameters', [{'type': 'Any'}]), ('returntype', 'Array'), ('safe', False), ('safe', 1)):
            wrong = copy.deepcopy(item)
            next(row for row in wrong['manifest']['abi']['methods'] if row['name'] == canonical['name'])[field] = value
            with self.assertRaises(ValidationFailure): native.check_native(wrong)
        for rows in ([row for row in methods if row['name'] != canonical['name']], [*methods, copy.deepcopy(canonical)]):
            wrong = copy.deepcopy(item); wrong['manifest']['abi']['methods'] = rows
            with self.assertRaises(ValidationFailure): native.check_native(wrong)

    def p256_results(self):
        compressed = bytes.fromhex('036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296')
        success = {'state': 'HALT', 'stack': [{'type': 'ByteString', 'value': base64.b64encode(compressed).decode()}], 'notifications': []}
        reasons = ['exact ByteString'] * 4 + ["can't be null", 'requires a 33-byte compressed or 65-byte uncompressed encoding',
            'not a point on the curve', 'Invalid ECPoint', 'Invalid ECPoint',
            'requires a 33-byte compressed or 65-byte uncompressed encoding']
        return [copy.deepcopy(success), copy.deepcopy(success), *[{'state': 'FAULT', 'exception': reason, 'notifications': []} for reason in reasons]]

    def test_p256_readback_uses_none_flags_without_an_account_or_witness(self):
        chain = Mock(); chain.rpc.side_effect = self.p256_results()
        result = native.canonical_p256_readback(chain)
        self.assertEqual([33, 65], result['acceptedInputBytes'])
        self.assertEqual('ByteString', result['outputType'])
        self.assertEqual(33, result['outputBytes'])
        self.assertEqual(10, len(result['rejectedInputs']))
        self.assertEqual(12, chain.rpc.call_count)
        call_suffix = b'\x11\xc0\x10\x0c\x16canonicalP256PublicKey\x0c\x14' + bytes.fromhex(native.CORE[2:])[::-1] + bytes.fromhex('41627d5b52')
        for call in chain.rpc.call_args_list:
            self.assertEqual('invokescript', call.args[0]); self.assertEqual([], call.args[1][1])
            self.assertTrue(base64.b64decode(call.args[1][0]).endswith(call_suffix))

    def test_p256_readback_rejects_wrong_output_types_bytes_events_and_unexpected_acceptance(self):
        bad_outputs = [
            {'state': 'FAULT', 'exception': 'missing method'},
            {'state': 'HALT', 'stack': []},
            {'state': 'HALT', 'stack': [{'type': 'Buffer', 'value': self.p256_results()[0]['stack'][0]['value']}]},
            {'state': 'HALT', 'stack': [{'type': 'ByteString', 'value': base64.b64encode(bytes(33)).decode()}]},
        ]
        with_event = self.p256_results()[0]; with_event['notifications'] = [{'eventname': 'Unexpected'}]; bad_outputs.append(with_event)
        for bad in bad_outputs:
            chain = Mock(); chain.rpc.side_effect = [bad]
            with self.assertRaises(ValidationFailure): native.canonical_p256_readback(chain)
        for index in range(2, 12):
            rows = self.p256_results(); rows[index] = copy.deepcopy(rows[0])
            chain = Mock(); chain.rpc.side_effect = rows
            with self.assertRaises(ValidationFailure): native.canonical_p256_readback(chain)

    def test_mismatched_native_identity_is_rejected(self):
        for key, value in (("hash", "0x" + "00" * 20), ("id", 1)):
            item = self.manifest(); item[key] = value
            with self.assertRaises(ValidationFailure): native.check_native(item)
        item = self.manifest(); item["manifest"]["extra"]["smartAccount"]["abiVersion"] = 1
        with self.assertRaises(ValidationFailure): native.check_native(item)
        item = self.manifest(); item["manifest"]["extra"]["smartAccount"]["profileParameterDigest"] = "00" * 32
        with self.assertRaises(ValidationFailure): native.check_native(item)
        item = self.manifest(); item["manifest"]["extra"]["smartAccount"]["profileParameterDigest"] = "a55dfe56356cdb9f51d9139f7f6e617c8bf4bcaa3211fd69a53dc980d477c03e"
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

    def test_every_required_method_descriptor_is_checked(self):
        for name, descriptor in native.REQUIRED_METHOD_ABI.items():
            bad_parameters = descriptor["parameters"][:-1] or [{"name": "unexpected", "type": "Any"}]
            for field, value in (("returntype", "Any" if descriptor["returntype"] != "Any" else "Void"),
                                 ("safe", not descriptor["safe"]),
                                 ("parameters", bad_parameters)):
                item = self.manifest()
                row = next(method for method in item["manifest"]["abi"]["methods"] if method["name"] == name)
                row[field] = value
                with self.subTest(method=name, field=field), self.assertRaises(ValidationFailure):
                    native.check_native(item)

            item = self.manifest()
            row = next(method for method in item["manifest"]["abi"]["methods"] if method["name"] == name)
            if row["parameters"]:
                row["parameters"][0]["name"] = "wrong"
            else:
                row["parameters"] = [{"name": "unexpected", "type": "Any"}]
            with self.subTest(method=name, field="parameter-name"), self.assertRaises(ValidationFailure):
                native.check_native(item)

            item = self.manifest()
            duplicate = next(method for method in item["manifest"]["abi"]["methods"] if method["name"] == name)
            item["manifest"]["abi"]["methods"].append(copy.deepcopy(duplicate))
            with self.subTest(method=name, field="duplicate"), self.assertRaises(ValidationFailure):
                native.check_native(item)

    def test_every_required_event_descriptor_is_checked(self):
        for name, parameters in native.REQUIRED_EVENT_ABI.items():
            item = self.manifest()
            row = next(event for event in item["manifest"]["abi"]["events"] if event["name"] == name)
            row["parameters"] = parameters[:-1]
            with self.subTest(event=name, field="parameters"), self.assertRaises(ValidationFailure):
                native.check_native(item)

            item = self.manifest()
            row = next(event for event in item["manifest"]["abi"]["events"] if event["name"] == name)
            if row["parameters"]:
                row["parameters"][0]["type"] = "Any"
            else:
                row["parameters"] = [{"name": "unexpected", "type": "Any"}]
            with self.subTest(event=name, field="parameter-type"), self.assertRaises(ValidationFailure):
                native.check_native(item)

            item = self.manifest()
            duplicate = next(event for event in item["manifest"]["abi"]["events"] if event["name"] == name)
            item["manifest"]["abi"]["events"].append(copy.deepcopy(duplicate))
            with self.subTest(event=name, field="duplicate"), self.assertRaises(ValidationFailure):
                native.check_native(item)

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

    def fee(self, result, reserve=0):
        chain = Mock()
        chain.rpc.return_value = result
        signers_before = copy.deepcopy(self.signers)
        fee = native.transaction_system_fee(chain, self.script, self.signers, reserve)
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

    def test_explicit_core_envelope_is_reserved(self):
        self.assertEqual(1_000_000_000, self.fee({"state": "HALT", "gasconsumed": "1"}, 1_000_000_000))

    def test_missing_consumed_fee_fails_closed_but_optional_minimum_is_supported(self):
        self.assertEqual(1, self.fee({"state": "HALT", "gasconsumed": "1"}))
        with self.assertRaises(ValidationFailure):
            self.fee({"state": "HALT", "minimumrequiredfee": "2"})

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
