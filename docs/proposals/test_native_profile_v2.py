"""ABI 2 conformance checks reject stale authority and inconsistent profile data."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).parent
VECTORS = "smartaccount-native-profile-v2-vectors.json"
PARAMETERS = "smartaccount-native-profile-v2-parameters.json"


class NativeProfileV2Tests(unittest.TestCase):
    def check(self, mutate=None):
        with tempfile.TemporaryDirectory(prefix="native-profile-v2-") as directory:
            dest = Path(directory)
            for path in ROOT.iterdir():
                if path.is_file() and (path.suffix in (".json", ".md") or path.name == "validate-native-smartaccount-profile.py"):
                    (dest / path.name).write_bytes(path.read_bytes())
            if mutate:
                mutate(dest)
            return subprocess.run([sys.executable, str(dest / "validate-native-smartaccount-profile.py")],
                                  capture_output=True, text=True, timeout=15)

    def test_v2_profile_and_vectors_pass(self):
        self.assertTrue((ROOT / VECTORS).exists())
        self.assertEqual(json.loads((ROOT / VECTORS).read_text())["profileVersion"], 2)
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_authority_counters_have_independent_commitments(self):
        data = json.loads((ROOT / VECTORS).read_text())
        controls = data["authorizationControls"]
        self.assertEqual({v["name"] for v in controls}, {"initial", "epoch-advanced", "configuration-advanced", "both-advanced", "maximum-counters"})
        self.assertEqual(len({v["authorizationDigest"] for v in controls}), len(controls))

    def test_active_version_and_callback_overviews_cannot_revert_to_prior_draft(self):
        required = (
            "Version 2 uses\n`Active = 0` and `Frozen = 1`",
            "Version 2 composites\nare the protocol-defined",
            "Version 2 exposes the following Application methods:",
            "`validateCompositeSignature` for an admitted composite",
            "verifier `postExecuteComposite` for an admitted composite",
        )
        document = (ROOT / "SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md").read_text()
        for clause in required:
            with self.subTest(clause=clause):
                self.assertIn(clause, document)
                def mutate(root):
                    p = root / "SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md"
                    p.write_text(p.read_text().replace(clause, "stale draft clause"))
                self.assertNotEqual(self.check(mutate).returncode, 0)

    def test_mutated_profile_parameters_are_rejected(self):
        def mutate(root):
            p = root / PARAMETERS
            data = json.loads(p.read_text()); data["verifierBudgetDatoshi"] = 1_000_000_000
            p.write_text(json.dumps(data))
        self.assertNotEqual(self.check(mutate).returncode, 0)

    def test_composite_receipt_contract_cannot_be_weakened(self):
        for old, replacement in (
            ("validateCompositeSignature(accountId: Hash160, op: Array) -> Array",
             "validateCompositeSignature(accountId: Hash160, op: Array) -> Boolean"),
            ("postExecuteComposite(accountId: Hash160, op: Array, result: Any, receipt: Array) -> Void",
             "postExecuteComposite(accountId: Hash160, op: Array, result: Any) -> Void"),
            ("`[Boolean true, orderedApprovedChildren, policyCommitment32]`",
             "`[true, anyChildren]`"),
            ("Verification parses\nand discards its receipt.",
             "Verification persists its receipt for Application."),
            ("Recovery revokes both roots\nand deletes the registry without an external cleanup callback",
             "Recovery preserves the registry until external cleanup succeeds"),
        ):
            def mutate(root):
                p = root / "SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md"
                text = p.read_text(); self.assertEqual(1, text.count(old))
                p.write_text(text.replace(old, replacement))
            with self.subTest(contract=old):
                self.assertNotEqual(self.check(mutate).returncode, 0)

    def test_self_consistent_digest_cannot_hide_weakened_composite_profile(self):
        for field, changed in (("compositeVerifierMaxChildren", 10),
                ("compositeVerifierMaxThreshold", 3),
                ("moduleProfileDigestRequired", False),
                ("compositeReceipt", {"version": 1, "verificationReceiptReused": True}),
                ("nativeP256SignerDomain", {"scheme": "Secp256r1", "domainsPerKey": 2}),
                ("nativeSessionSignerDomainStorage", {"policyPrefix": "05", "legacyFallback": True})):
            def mutate(root):
                path = root / PARAMETERS; data = json.loads(path.read_text())
                old = json.dumps(data, sort_keys=True, separators=(",", ":"))
                old_hash = hashlib.sha256(b"NeoSmartAccount/Profile\x02" + old.encode()).hexdigest()
                data[field] = changed
                new = json.dumps(data, sort_keys=True, separators=(",", ":"))
                new_hash = hashlib.sha256(b"NeoSmartAccount/Profile\x02" + new.encode()).hexdigest()
                path.write_text(json.dumps(data))
                doc = root / "SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md"
                doc.write_text(doc.read_text().replace(old, new).replace(old_hash, new_hash))
                path = root / VECTORS; vectors = json.loads(path.read_text())
                vectors["profileParameterDigest"] = new_hash; path.write_text(json.dumps(vectors))
            with self.subTest(field=field): self.assertNotEqual(self.check(mutate).returncode, 0)

    def test_self_consistent_profile_rejects_numeric_boolean_aliases(self):
        for field, nested in (("compositeVerifierCallbacks", ("validation", "safe")),
                ("compositeReceipt", ("verificationReceiptReused",)),
                ("nativeSessionSignerDomainStorage", ("legacyFallback",)),
                ("nativeSessionMetadataStorage", ("legacyFallback",)),
                ("nativeWitnessSignerDomainStorage", ("legacyFallback",))):
            def mutate(root):
                path = root / PARAMETERS; data = json.loads(path.read_text())
                old = json.dumps(data, sort_keys=True, separators=(",", ":"))
                old_hash = hashlib.sha256(b"NeoSmartAccount/Profile\x02" + old.encode()).hexdigest()
                target = data[field]
                for key in nested[:-1]: target = target[key]
                self.assertIs(target[nested[-1]], False); target[nested[-1]] = 0
                new = json.dumps(data, sort_keys=True, separators=(",", ":"))
                new_hash = hashlib.sha256(b"NeoSmartAccount/Profile\x02" + new.encode()).hexdigest()
                path.write_text(json.dumps(data))
                doc = root / "SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md"
                doc.write_text(doc.read_text().replace(old, new).replace(old_hash, new_hash))
                path = root / VECTORS; data = json.loads(path.read_text())
                data["profileParameterDigest"] = new_hash; path.write_text(json.dumps(data))
            with self.subTest(field=field): self.assertNotEqual(self.check(mutate).returncode, 0)

    def test_session_domain_storage_preserves_public_record_and_fails_closed(self):
        data = json.loads((ROOT / PARAMETERS).read_text())
        self.assertEqual(data["nativeSessionSignerDomainStorage"], {
            "policyPrefix": "05", "valueBytes": 32, "sessionRecordFields": 5,
            "namespace": "authorityEpoch", "atomicWithSessionConfiguration": True,
            "deletedWithSession": True, "readFresh": True, "legacyFallback": False,
        })

    def test_session_storage_optimization_keeps_metadata_abi_and_canonical_key(self):
        data = json.loads((ROOT / PARAMETERS).read_text())
        self.assertEqual(data["nativeSessionMetadataStorage"], {
            "policyPrefix": "06", "valueType": "CanonicalUInt64NeoInteger", "metadataRecordFields": 3,
            "storedMetadataLastUsedAt": 0, "sessionConfigurationInitialValue": 0,
            "namespace": "authorityEpoch", "atomicWithSessionConfiguration": True,
            "deletedWithSession": True, "readFresh": True, "legacyFallback": False,
        })
        self.assertEqual(data["nativeSessionPublicKey"], {
            "acceptedEncodingBytes": [33, 65], "storedEncodingBytes": 33,
            "normalization": "secp256r1DecodeThenCompress", "invalidPoint": "rejectAtomically",
            "normalizationServiceMethod": "canonicalP256PublicKey",
        })

    def test_native_witness_domain_storage_preserves_configuration_abi(self):
        data = json.loads((ROOT / PARAMETERS).read_text())
        self.assertEqual(data["nativeWitnessSignerDomainStorage"], {
            "policyPrefix": "03", "encoding": "orderedPackedByteString32", "maxDomains": 10,
            "configurationRecordFields": 2, "namespace": "authorityEpoch", "atomicWithConfiguration": True,
            "deletedWithAccountCleanup": True, "readFresh": True, "legacyFallback": False,
        })

    def test_p256_helper_abi_and_strict_point_vectors_are_bound(self):
        data = json.loads((ROOT / PARAMETERS).read_text())
        self.assertEqual(data["nativeP256Canonicalization"], {
            "name": "canonicalP256PublicKey", "parameters": ["ByteArray"], "returnType": "ByteArray",
            "safe": True, "requiredCallFlags": "None", "cpuFeeUnits": 32768,
            "argumentStackType": "ByteString", "accountRegistrationRequired": False,
            "algorithm": "compressedDecodeThenExactUncompressedRoundTrip", "ownedResult": True,
        })
        vectors = json.loads((ROOT / VECTORS).read_text())["p256Canonicalization"]
        self.assertGreaterEqual(len(vectors), 8)
        self.assertEqual(2, sum(v["accepted"] for v in vectors))
        def mutate(root):
            path = root / VECTORS; data = json.loads(path.read_text())
            case = next(v for v in data["p256Canonicalization"] if v["name"] == "invalid-uncompressed-y")
            case["accepted"] = True; case["canonicalPublicKey"] = data["nativeP256SignerDomain"]["publicKey"]
            path.write_text(json.dumps(data))
        self.assertNotEqual(self.check(mutate).returncode, 0)

    def test_native_key_alias_and_receipt_vectors_are_independently_checked(self):
        for variant in ("script", "domain", "approved-order", "policy", "receipt"):
            def mutate(root):
                p = root / VECTORS; data = json.loads(p.read_text())
                if variant == "script": data["nativeP256SignerDomain"]["standardAccountScript"] = "40"
                elif variant == "domain": data["nativeP256SignerDomain"]["domain"] = "00" * 32
                elif variant == "approved-order": data["compositeReceipt"]["approvedChildrenWire"].reverse()
                elif variant == "policy": data["compositeReceipt"]["threshold"] = 1
                else: data["compositeReceipt"]["canonicalReceipt"] = "4000"
                p.write_text(json.dumps(data))
            with self.subTest(variant=variant): self.assertNotEqual(self.check(mutate).returncode, 0)

    def test_domain_counter_reorder_and_old_version_are_rejected_even_with_matching_hash(self):
        for variant in ("swap", "old-version", "omit-epoch"):
            def mutate(root):
                p = root / VECTORS; data = json.loads(p.read_text())
                value = data["operation"]; message = bytearray.fromhex(value["authorizationMessage"])
                offset = len(b"NeoSmartAccount/UserOperation")
                suffix = offset + 1 + 4 + 20 + 20
                if variant == "swap":
                    message[suffix:suffix + 16] = message[suffix + 8:suffix + 16] + message[suffix:suffix + 8]
                elif variant == "old-version":
                    message[offset] = 1
                else:
                    del message[suffix:suffix + 8]
                value["authorizationMessage"] = message.hex()
                value["authorizationDigest"] = hashlib.sha256(message).hexdigest()
                p.write_text(json.dumps(data))
            with self.subTest(variant=variant):
                self.assertNotEqual(self.check(mutate).returncode, 0)

    def test_record_serialization_and_namespace_bytes_are_verified(self):
        for field in ("record", "namespace"):
            def mutate(root):
                p = root / VECTORS; data = json.loads(p.read_text())
                if field == "record":
                    data["accountRecord"]["initialSerialized"] = "400d"
                else:
                    data["storageNamespaces"][0]["key"] = "00" + data["storageNamespaces"][0]["key"][2:]
                p.write_text(json.dumps(data))
            with self.subTest(field=field):
                self.assertNotEqual(self.check(mutate).returncode, 0)

    def test_legacy_or_misbound_execution_envelope_is_rejected(self):
        for kind in ("arity", "epoch", "configuration"):
            def mutate(root):
                p = root / VECTORS; data = json.loads(p.read_text())
                vector = data["applicationEnvelopes"][0]
                if kind == "arity": vector["argumentCount"] = 2
                elif kind == "epoch": vector["expectedAuthorityEpoch"] = "8"
                else: vector["expectedConfigurationNonce"] = "12"
                p.write_text(json.dumps(data))
            with self.subTest(kind=kind):
                self.assertNotEqual(self.check(mutate).returncode, 0)

    def test_unreachable_counter_pair_cannot_be_labelled_valid_account(self):
        def mutate(root):
            p = root / VECTORS; data = json.loads(p.read_text())
            control = next(v for v in data["authorizationControls"] if v["name"] == "epoch-advanced")
            control["validAccountState"] = True
            p.write_text(json.dumps(data))
        self.assertNotEqual(self.check(mutate).returncode, 0)

    def test_malformed_event_record_or_recovery_rule_is_rejected(self):
        replacements = [
            ("**Version:** 2 (identity version 1;", "**Version:** 2 (identity version 2;"),
            ("| `AccountCreated` | `Hash160, Hash160, Hash160, Hash160, Hash160, Hash160` |",
             "| `AccountCreated` | `Hash160, Hash160, Hash160, Hash160, Hash160` |"),
            ("| `RecoveryExecuted` | `Hash160, Hash160, Hash160, Integer, Integer` |",
             "| `RecoveryExecuted` | `Hash160, Hash160, Hash160, Integer` |"),
            ("Array with exactly these 14 positions", "Array with exactly these 13 positions"),
            ("without invoking any external callback", "after invoking every external cleanup callback"),
        ]
        for before, after in replacements:
            def mutate(root):
                p = root / "SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md"; text = p.read_text()
                self.assertEqual(text.count(before), 1)
                p.write_text(text.replace(before, after))
            with self.subTest(rule=before):
                self.assertNotEqual(self.check(mutate).returncode, 0)


if __name__ == "__main__":
    unittest.main()
