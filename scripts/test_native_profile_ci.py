"""Fail-closed tests for the CI evidence boundary; no compilation or network."""

import base64
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import native_profile_ci as ci


class NativeProfileCiTests(unittest.TestCase):
    def test_mismatched_module_bytes_are_rejected_even_with_equal_build_counts(self):
        with tempfile.TemporaryDirectory() as temp:
            modules = Path(temp)
            for name in range(6):
                (modules / f"module{name}.nef").write_bytes(b"compiled")
                (modules / f"module{name}.manifest.json").write_text("{}")
            actual = {p.name: ci.sha256(p) for p in modules.iterdir()}
            receipt = {"schema": "smartaccount-native-module-build/v2", "status": "PASS", "publicNetworksTouched": False,
                       "nefRewritten": False, "reproducible": True, "builds": [actual, copy.deepcopy(actual)]}
            self.assertEqual(ci.validate_module_receipt(receipt, modules), actual)
            receipt["builds"][1]["module0.nef"] = "f" * 64
            with self.assertRaisesRegex(ValueError, "Independent module bytes differ"):
                ci.validate_module_receipt(receipt, modules)
            receipt["builds"][1] = copy.deepcopy(actual)
            (modules / "module0.nef").write_bytes(b"substituted")
            with self.assertRaisesRegex(ValueError, "Retained module bytes differ"):
                ci.validate_module_receipt(receipt, modules)

    def fixture(self):
        runtime = {name + ".dll": "1" * 64 for name in (*ci.CORE_PROJECTS, "Neo.VM")}
        modules = {name + suffix: "2" * 64 for name in ci.PROBE_MODULES for suffix in (".nef", ".manifest.json")}
        sources = {name: "3" * 64 for name in ci.PROBE_FILES}
        receipt = {"schema": "smartaccount-native-multisig-probe/v1", "status": "PASS", "publicNetworksTouched": False,
                   "cases": [{}] * 20, "runtimeAssemblyHashes": copy.deepcopy(runtime), "artifactHashes": copy.deepcopy(modules), "probeSourceHashes": copy.deepcopy(sources)}
        return receipt, runtime, modules, sources

    def test_probe_rejects_binary_overlay_wrong_artifacts_and_incomplete_matrix(self):
        receipt, runtime, modules, sources = self.fixture()
        ci.validate_probe(receipt, runtime, modules, sources)
        for field, key in (("runtimeAssemblyHashes", "Neo.dll"), ("artifactHashes", "MultiSigVerifier.nef"), ("probeSourceHashes", "Program.cs")):
            changed = copy.deepcopy(receipt)
            changed[field][key] = "f" * 64
            with self.subTest(field=field), self.assertRaises(ValueError):
                ci.validate_probe(changed, runtime, modules, sources)
        for change in ({"status": "FAIL"}, {"publicNetworksTouched": True}, {"cases": []}, {"runtimeAssemblyHashes": {}}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                ci.validate_probe({**receipt, **change}, runtime, modules, sources)

    def test_probe_requires_one_receipt_and_does_not_mistake_build_output_for_it(self):
        receipt, *_ = self.fixture()
        output = "Restored project\n{\"build\":true}\n" + json.dumps(receipt, indent=2)
        self.assertEqual(ci.parse_probe_output(output), receipt)
        for malformed in ("Build succeeded", "{malformed}", output + "\n" + json.dumps(receipt)):
            with self.subTest(output=malformed), self.assertRaisesRegex(ValueError, "exactly one"):
                ci.parse_probe_output(malformed)

    def test_cached_package_archive_tampering_fails_before_publish(self):
        with tempfile.TemporaryDirectory() as temp:
            cache = Path(temp)
            archive = cache / "dependency/1.0.0/dependency.1.0.0.nupkg"
            archive.parent.mkdir(parents=True)
            archive.write_bytes(b"changed cached package")
            locked_hash = base64.b64encode(hashlib.sha512(b"reviewed package").digest()).decode()
            locks = {"src/Neo/packages.lock.json": {"dependencies": {"net10.0": {"Dependency": {"type": "Direct", "resolved": "1.0.0", "contentHash": locked_hash}}}}}
            with self.assertRaisesRegex(ValueError, "Restored archive differs"):
                ci.verify_package_archives(locks, cache, {"dependency/1.0.0": hashlib.sha256(b"reviewed package").hexdigest()})

    def test_checked_out_core_must_match_full_clean_commit(self):
        import subprocess
        with tempfile.TemporaryDirectory() as temp:
            core = Path(temp)
            subprocess.run(["git", "init", "--quiet", str(core)], check=True)
            (core / "source.cs").write_text("reviewed")
            (core / ".editorconfig").write_text("root = true\n")
            subprocess.run(["git", "add", "source.cs", ".editorconfig"], cwd=core, check=True)
            subprocess.run(["git", "-c", "user.name=CI test", "-c", "user.email=ci@example.invalid", "commit", "--quiet", "-m", "fixture"], cwd=core, check=True)
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=core, text=True).strip()
            ci.check_core_identity(core, head)
            (core / "unreviewed.dll").write_bytes(b"local assembly overlay")
            snapshot = core / "snapshot"
            snapshot.mkdir()
            inputs = ci.snapshot_core(core, snapshot.resolve())
            self.assertEqual(set(inputs), {"source.cs", ".editorconfig"})
            self.assertEqual((snapshot / ".editorconfig").read_text(), "root = true\n")
            for wrong in (head[:8], "main", "0" * 40):
                with self.subTest(pin=wrong), self.assertRaises(ValueError):
                    ci.check_core_identity(core, wrong)
            (core / "source.cs").write_text("unreviewed")
            with self.assertRaisesRegex(ValueError, "tracked changes"):
                ci.check_core_identity(core, head)


if __name__ == "__main__":
    unittest.main()
