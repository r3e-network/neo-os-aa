"""Source-built runtime attestation must not rewrite chain evidence."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import neoexpress_source_validate as source
from neoexpress_reproducible_build import BuildFailure, inventory


class SourceRuntimeTests(unittest.TestCase):
    def fixture(self, root):
        runtime = root / "runtime"; runtime.mkdir(); (runtime / "Neo.dll").write_bytes(b"native")
        result = {"runtime": inventory(runtime), "archives": {"archive": "hash"}, "locks": {"lock": "hash"}}
        receipt = root / "build.json"
        receipt.write_text(json.dumps({"status": "PASS", "independentCleanBuilds": 2, "builds": [result, result]}))
        return runtime, receipt

    def test_provenance_annotation_preserves_raw_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); runtime, receipt = self.fixture(root)
            original = {"status": "PASS", "ownedNodesStopped": True, "runtimeMode": "old label", "transactions": ["tx"]}
            def validator(_runtime, _dotnet, output): output.write_text(json.dumps(original)); return original
            with patch.object(source, "VALIDATORS", [("service", validator)]):
                report = source.validate(runtime, Path("dotnet"), receipt, root / "results")
            self.assertEqual("PASS", report["status"])
            self.assertEqual(original, json.loads((root / "results/service.raw.json").read_text()))
            derived = json.loads((root / "results/service.json").read_text())
            self.assertEqual(original["transactions"], derived["transactions"])
            self.assertIn("source-built", derived["runtimeMode"])

    def test_drift_failure_and_live_node_cannot_produce_pass(self):
        for mode in ("drift", "fail", "node", "raise", "interrupt"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); runtime, receipt = self.fixture(root)
                def validator(_runtime, _dotnet, output):
                    if mode == "interrupt": raise KeyboardInterrupt
                    if mode == "raise": raise BuildFailure("test")
                    report = {"status": "FAIL" if mode == "fail" else "PASS", "ownedNodesStopped": mode != "node"}
                    output.write_text(json.dumps(report))
                    if mode == "drift": (runtime / "extra.dll").write_bytes(b"unexpected")
                    return report
                with patch.object(source, "VALIDATORS", [("service", validator)]), self.assertRaises(KeyboardInterrupt if mode == "interrupt" else BuildFailure):
                    source.validate(runtime, Path("dotnet"), receipt, root / "results")
                self.assertEqual("FAIL", json.loads((root / "results/summary.json").read_text())["status"])
                self.assertFalse((root / "results/service.json").exists())

    def test_build_receipt_or_validator_source_drift_fails_aggregate(self):
        for mode in ("receipt", "source"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); runtime, receipt = self.fixture(root); changed = False
                original_hash = source.sha256
                def digest(path):
                    if mode == "source" and changed and path.name == "neoexpress_source_validate.py": return "0" * 64
                    return original_hash(path)
                def validator(_runtime, _dotnet, output):
                    nonlocal changed
                    output.write_text(json.dumps({"status": "PASS", "ownedNodesStopped": True}))
                    changed = True
                    if mode == "receipt": receipt.write_text("changed")
                with patch.object(source, "VALIDATORS", [("service", validator)]), patch.object(source, "sha256", side_effect=digest), self.assertRaises(BuildFailure):
                    source.validate(runtime, Path("dotnet"), receipt, root / "results")
                self.assertEqual("FAIL", json.loads((root / "results/summary.json").read_text())["status"])


if __name__ == "__main__": unittest.main()
