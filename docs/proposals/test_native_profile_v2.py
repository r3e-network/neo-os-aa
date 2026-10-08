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

    def test_mutated_profile_parameters_are_rejected(self):
        def mutate(root):
            p = root / PARAMETERS
            data = json.loads(p.read_text()); data["verifierBudgetDatoshi"] = 1_000_000_000
            p.write_text(json.dumps(data))
        self.assertNotEqual(self.check(mutate).returncode, 0)

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
