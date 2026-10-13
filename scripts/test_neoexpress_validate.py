"""Offline regression tests for private-chain evidence accounting and readback."""
import base64
import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

SPEC = importlib.util.spec_from_file_location(
    "neoexpress_validate", Path(__file__).with_name("neoexpress_validate.py"))
validation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validation)


class SummaryTests(unittest.TestCase):
    def summary(self, steps, skipped=False):
        scenario = {"steps": steps, "assertions": [{"ok": True}]}
        if skipped:
            scenario["skipped"] = "optional artifact absent"
        return validation.validation_summary(SimpleNamespace(
            scenarios=[scenario], deployments=[{}], simulated_seconds=42))

    def test_persisted_fault_is_not_a_halted_transaction(self):
        summary = self.summary([
            {"txid": "success", "outcome": "HALT"},
            {"txid": "fault", "outcome": "FAULT", "expectedFault": "replay"},
            {"outcome": "FAULT", "expectedFault": "expired"},
        ])
        self.assertEqual(summary["transactionsPersisted"], 2)
        self.assertEqual(summary["transactionsHalted"], 1)
        self.assertEqual(summary["transactionsFaulted"], 1)
        self.assertEqual(summary["expectedFaults"], 2)
        self.assertEqual(summary["expectedPreflightFaults"], 1)

    def test_unexpected_fault_is_not_counted_as_expected(self):
        summary = self.summary([{"txid": "unexpected", "outcome": "FAULT"}])
        self.assertEqual(summary["transactionsFaulted"], 1)
        self.assertEqual(summary["expectedFaults"], 0)

    def test_minting_and_pending_broadcast_are_not_halts(self):
        summary = self.summary([{"outcome": "minted"}, {"txid": "pending"}])
        self.assertEqual(summary["transactionsHalted"], 0)
        self.assertEqual(summary["transactionsFaulted"], 0)

    def test_skipped_scenario_is_explicit(self):
        summary = self.summary([], skipped=True)
        self.assertEqual(summary["scenariosSkipped"], 1)
        self.assertEqual(summary["assertions"], 1)
        self.assertEqual(summary["simulatedTimeAdvancedSeconds"], 42)

    def test_bounded_callback_fault_aliases_are_narrow(self):
        expected = "The bounded contract call gas limit has been exhausted."
        self.assertTrue(validation.fault_matches(expected, "Contract call gas limit exceeded."))
        self.assertTrue(validation.fault_matches(expected, "The bounded contract call gas limit has been exhausted."))
        self.assertFalse(validation.fault_matches(expected, "Contract call gas limit exceeded by another operation."))


class ReadbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.chain = object.__new__(validation.Chain)
        self.chain.deployments = []
        self.chain.local_artifacts = {}
        self.states = {}
        self.chain.start_node = Mock()
        self.chain.stop_node = Mock()
        self.chain.rpc = Mock(side_effect=self.rpc)
        self.add_artifact("UnifiedSmartWalletV3")
        # This artifact is not in ARTIFACTS. It must receive the same complete
        # readback checks as the contracts deployed from contracts/bin/v3.
        self.add_artifact("NeoDIDRegistry")

    def rpc(self, method, args):
        if method == "getblockcount":
            return 42
        self.assertEqual(method, "getcontractstate")
        return copy.deepcopy(self.states[args[0]])

    def add_artifact(self, name):
        script = b"\x11\x40"
        body = b"NEF3" + bytes(64) + b"\x00\x00\x00\x00\x00" + bytes([len(script)]) + script
        checksum = hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
        nef = Path(self.temp.name) / f"{name}.nef"
        nef.write_bytes(body + checksum)
        manifest = {"name": name, "abi": {"methods": [], "events": []}, "permissions": []}
        manifest_path = nef.with_suffix(".manifest.json")
        manifest_path.write_text(json.dumps(manifest))
        contract_hash = f"0x{len(self.states) + 1:040x}"
        self.chain.local_artifacts[name] = nef
        self.chain.deployments.append({
            "contractName": name,
            "contractHash": contract_hash,
            "localNefSha256": hashlib.sha256(nef.read_bytes()).hexdigest(),
            "localManifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        })
        self.states[contract_hash] = {
            "nef": {"script": base64.b64encode(script).decode(), "checksum": int.from_bytes(checksum, "little")},
            "manifest": manifest,
        }

    def sibling(self):
        return self.states[self.chain.deployments[-1]["contractHash"]]

    def test_every_deployment_has_a_complete_readback(self):
        result = self.chain.readback()
        self.assertEqual(result["blockCountAtReadback"], 42)
        rows = result["contracts"]
        self.assertEqual([row["contractName"] for row in rows], ["UnifiedSmartWalletV3", "NeoDIDRegistry"])
        for row in rows:
            for field in ("nefScriptByteEquality", "nefChecksumEquality", "manifestSemanticEquality"):
                self.assertTrue(row[field])
        self.chain.stop_node.assert_called_once()

    def test_sibling_manifest_drift_fails(self):
        self.sibling()["manifest"]["permissions"] = [{"contract": "*", "methods": "*"}]
        with self.assertRaisesRegex(validation.ValidationFailure, "RPC readback parity failed for NeoDIDRegistry"):
            self.chain.readback()
        self.chain.stop_node.assert_called_once()

    def test_sibling_script_drift_fails(self):
        self.sibling()["nef"]["script"] = base64.b64encode(b"\x10\x40").decode()
        with self.assertRaises(validation.ValidationFailure):
            self.chain.readback()

    def test_sibling_checksum_drift_fails(self):
        self.sibling()["nef"]["checksum"] += 1
        with self.assertRaises(validation.ValidationFailure):
            self.chain.readback()

    def test_local_nef_changed_after_deployment_fails(self):
        nef = self.chain.local_artifacts["NeoDIDRegistry"]
        nef.write_bytes(nef.read_bytes() + b"extra")
        with self.assertRaisesRegex(validation.ValidationFailure, "local artifact changed"):
            self.chain.readback()

    def test_local_manifest_changed_after_deployment_fails(self):
        path = self.chain.local_artifacts["NeoDIDRegistry"].with_suffix(".manifest.json")
        path.write_text(path.read_text() + " ")
        with self.assertRaisesRegex(validation.ValidationFailure, "local artifact changed"):
            self.chain.readback()

    def test_missing_local_input_fails_before_starting_node(self):
        del self.chain.local_artifacts["NeoDIDRegistry"]
        with self.assertRaisesRegex(validation.ValidationFailure, "do not match"):
            self.chain.readback()
        self.chain.start_node.assert_not_called()

    def test_unrecorded_deployment_fails(self):
        self.chain.deployments.pop()
        with self.assertRaises(validation.ValidationFailure):
            self.chain.readback()

    def test_duplicate_deployment_fails(self):
        self.chain.deployments.append(self.chain.deployments[-1].copy())
        with self.assertRaises(validation.ValidationFailure):
            self.chain.readback()


if __name__ == "__main__":
    unittest.main()
