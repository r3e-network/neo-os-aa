"""Independent encoding and fail-closed evidence controls for proxy transactions."""
import base64
import json
from pathlib import Path
import unittest
import neoexpress_native_proxy_validate as proxy
from neoexpress_validate import A, B, H, I, S, BOOL, ValidationFailure, hash_le


class NativeProxyValidationTests(unittest.TestCase):
    def test_proxy_script_matches_published_identity_vector(self):
        vectors = json.loads((Path(__file__).parent.parent / "docs/proposals/smartaccount-native-profile-v2-vectors.json").read_text())
        identity = vectors["identity"]
        account = "0x" + bytes.fromhex(identity["accountIdWire"])[::-1].hex()
        self.assertEqual(identity["verificationScript"], proxy.verification_script(account).hex())
        self.assertEqual(identity["accountAddressDisplay"], proxy.proxy_address(account))

    def test_application_initializer_matches_independent_core_vector(self):
        account = "0x3e25330008563c55fe2853e07868b36ca00020ac"
        operation = A(H(proxy.CORE), S("ping"), A(), I(0), I(0), B(b""))
        expected = ("1b170c001010c20c0470696e670c144117a67f088e2ea046e74bdce906f2ad071d42d916c0"
                    "0c14ac2000a06cb36878e05328fe553c56080033253e14c01f0c0d65786563757465557365724f70"
                    "0c144117a67f088e2ea046e74bdce906f2ad071d42d941627d5b52")
        self.assertEqual(expected, proxy.application_script(account, operation, authority_epoch=7, configuration_nonce=11).hex())
        self.assertIn(b"executeUserOps", proxy.application_script(account, A(operation, operation), batch=True, authority_epoch=7, configuration_nonce=11))
        for field in ('authority_epoch','configuration_nonce'):
            for value in (-1,2**64,True,'1'):
                counters={'authority_epoch':7,'configuration_nonce':11,field:value}
                with self.assertRaises(ValidationFailure): proxy.application_script(account,operation,**counters)

    def test_exact_scalar_encodings_and_integer_boundaries(self):
        for value, expected in ((BOOL(True), "08"), (BOOL(False), "09"), (I(-1), "0f"), (I(0), "10"),
                                (I(16), "20"), (I(17), "0011"), (I(128), "018000"),
                                ({"type": "Any"}, "0b"), (A(), "c2"), (B(b""), "0c00")):
            self.assertEqual(bytes.fromhex(expected), proxy.encode_value(value))
        self.assertEqual(b"\x05" + (2**255-1).to_bytes(32, "little"), proxy.encode_value(I(2**255-1)))
        self.assertEqual(b"\x0d\x00\x01" + bytes(256), proxy.encode_value(B(bytes(256))))
        for item in (I(2**255), I(-(2**255)-1), {"type": "Map", "value": []},
                     {"type": "Boolean", "value": "false"}, H("0x01")):
            with self.assertRaises(ValidationFailure): proxy.encode_value(item)

    def test_persisted_fault_requires_empty_notifications(self):
        proxy.check_fault({"vmstate": "FAULT", "exception": "ABORT is executed.", "notifications": []}, "ABORT")
        for item in ({"vmstate": "HALT", "notifications": []},
                     {"vmstate": "FAULT", "exception": "out of gas", "notifications": []},
                     {"vmstate": "FAULT", "exception": "ABORT", "notifications": [{"eventname": "Transfer"}]}):
            with self.assertRaises(ValidationFailure): proxy.check_fault(item, "ABORT")

    def test_confirmation_binds_hash_script_signers_and_block(self):
        script = b"\x40"; txid = "0x" + "ab" * 32
        signers = [{"account": proxy.CORE, "scopes": "CalledByEntry"}]
        witnesses = [(b"\x0c\x01\x01", b"\x40")]
        tx = {"hash": txid, "script": base64.b64encode(script).decode(), "signers": signers,
              "witnesses": [{"invocation": base64.b64encode(i).decode(), "verification": base64.b64encode(v).decode()} for i, v in witnesses],
              "blockhash": "0x" + "cd" * 32, "confirmations": 1}
        proxy.check_transaction(tx, txid, script, signers, witnesses)
        for field, value in (("hash", "0x" + "00" * 32), ("script", ""), ("signers", []),
                             ("witnesses", []), ("witnesses", [{"invocation": "", "verification": "QA=="}]),
                             ("confirmations", 0), ("blockhash", None)):
            changed = {**tx, field: value}
            with self.assertRaises(ValidationFailure): proxy.check_transaction(changed, txid, script, signers, witnesses)

    def test_custom_witness_and_standard_signature_rejections_are_distinct(self):
        prefix = "rpc sendrawtransaction: Inventory verification failed - "
        messages = {"Invalid": prefix + "Invalid", "InvalidSignature": "rpc sendrawtransaction: Invalid signature - InvalidSignature"}
        for expected in messages:
            proxy.check_admission_rejection(ValidationFailure(messages[expected]), expected)
            for actual in ("InsufficientFunds", "Expired", "InvalidScript", "InvalidSignature" if expected == "Invalid" else "Invalid"):
                with self.assertRaises(ValidationFailure):
                    proxy.check_admission_rejection(ValidationFailure(prefix + actual), expected)
        for message in ("connection reset", "Invalid", prefix + "Invalid additional text"):
            with self.assertRaises(ValidationFailure): proxy.check_admission_rejection(ValidationFailure(message), "Invalid")

    def test_balance_change_and_nonce_cannot_be_inferred_from_halt(self):
        proxy.check_state_delta((100, 0, 0), (90, 10, 1), amount=10, consumed=1)
        for after in ((100, 0, 1), (90, 9, 1), (90, 10, 0)):
            with self.assertRaises(ValidationFailure): proxy.check_state_delta((100, 0, 0), after, amount=10, consumed=1)
        proxy.check_state_delta((100, 0, 0), (100, 0, 0), amount=0, consumed=0)


if __name__ == "__main__": unittest.main()
