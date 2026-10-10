"""Fail-closed tests for the CI evidence boundary; no compilation or network."""

import base64
import copy
import fnmatch
import hashlib
import json
import re
import sys
from pathlib import Path
import tempfile
import unittest
import subprocess

import native_profile_ci as ci


class NativeProfileCiTests(unittest.TestCase):
    def test_sdk_pin_is_exact_and_never_overwrites_an_existing_selector(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            selector = ci.pin_sdk(root)
            before = selector.read_bytes()
            self.assertEqual(json.loads(before)["sdk"], {"version": ci.SDK, "rollForward": "disable", "allowPrerelease": False})
            ci.pin_sdk(root)
            self.assertEqual(selector.read_bytes(), before)
            selector.write_text('{"sdk":{"version":"10.0.401"}}')
            other = selector.read_bytes()
            with self.assertRaisesRegex(ValueError, "will not be overwritten"):
                ci.pin_sdk(root)
            self.assertEqual(selector.read_bytes(), other)

    def test_real_sdk_resolver_inherits_the_pin_in_compiler_scratch_directories(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp)
            env = ci.build_environment(work, work / "packages")
            # A separate Python process honors TMPDIR exactly as the native
            # module build does; it must not escape into the system /tmp tree.
            scratch = Path(subprocess.check_output([sys.executable, "-c", "import tempfile; print(tempfile.mkdtemp())"], env=env, text=True).strip())
            self.assertTrue(scratch.resolve().is_relative_to(work.resolve()))
            actual = subprocess.check_output(["dotnet", "--version"], cwd=scratch, env=env, text=True).strip()
            self.assertEqual(actual, ci.SDK)
            installed = subprocess.check_output(["dotnet", "--list-sdks"], env=env, text=True).strip()
            print("SDK selection regression: " + installed.replace("\n", "; ") + " -> " + actual)

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
        # Retained real VM trace supplies schema-valid cases, not fabricated PASS
        # rows. The current source/artifact identity guard is exercised separately.
        receipt = json.loads((Path(__file__).resolve().parents[1] / "docs/reports/aa-native-ci-probe-consistency-20261009.json").read_text())
        receipt.update(runtimeAssemblyHashes=copy.deepcopy(runtime), artifactHashes=copy.deepcopy(modules), probeSourceHashes=copy.deepcopy(sources))
        return receipt, runtime, modules, sources

    def test_probe_requires_each_real_scenario_once_and_rejects_unknown_cases(self):
        for kind in ("empty", "missing", "duplicate", "unknown", "extra", "numeric-boolean", "alias-missing"):
            receipt, runtime, modules, sources = self.fixture()
            if kind == "empty": receipt["cases"] = [{}] * 20
            elif kind == "missing": receipt["cases"].pop(0)
            elif kind == "duplicate": receipt["cases"][1] = copy.deepcopy(receipt["cases"][0])
            elif kind == "unknown": receipt["cases"][0]["Roster"] = "NN"
            elif kind == "extra": receipt["cases"].append({"label": "unreviewed"})
            elif kind == "numeric-boolean": receipt["cases"][0]["Maximum"] = 0
            else: receipt["cases"][19] = copy.deepcopy(receipt["cases"][18])
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                ci.validate_probe(receipt, runtime, modules, sources)

    def test_probe_checks_execution_verification_budgets_and_rollback_outcomes(self):
        changes = (
            (0, ("result", "state"), "FAULT"), (0, ("verification", "state"), "FAULT"),
            (16, ("result", "state"), "HALT"), (16, ("verification", "state"), "HALT"),
            (16, ("result", "error"), "Insufficient GAS"),
            (0, ("result", "notifications"), 0), (0, ("result", "minimum"), 0),
            (0, ("result", "minimum"), "1"), (0, ("result", "minimum"), None),
            (0, ("verification", "authorized"), False), (16, ("verification", "authorized"), True),
            (0, ("verification", "resultCount"), 0), (0, ("verification", "resultCount"), 2),
            (0, ("verification", "resultType"), "Integer"), (0, ("verification", "booleanResult"), False),
            (0, ("verification", "booleanResult"), 1),
            (0, ("verification", "gasConsumedDatoshi"), 150000001),
            (0, ("verification", "gasLimitDatoshi"), 150000001),
            (0, ("phases", 0, "consumedDatoshi"), "100000000"),
            (0, ("phases", 1, "consumedDatoshi"), "100000001"),
            (0, ("phases", 1, "limitDatoshi"), "200000000"),
            (0, ("phases", 0, "remainingDatoshi"), "0"),
            (0, ("phases", 0, "consumedDatoshi"), "-1"),
            (0, ("phases", 0, "consumedDatoshi"), True),
            (0, ("phases",), []),
            (0, ("phases", 1, "phase"), "validateCompositeSignature"),
            (18, ("configurationRollback",), False), (19, ("invalidPointRollback",), False),
            (19, ("revocationClearsDomainAndLastUse",), 1),
            (19, ("domain",), "0" * 64), (19, ("initialLastUseHex",), "01"),
            (1, ("descriptionBytes",), 0), (1, ("amount",), "1"), (1, ("dataLength",), 0),
            (9, ("signatureBytes",), 1), (9, ("priorSpent",), "0"),
            (9, ("amount",), str(2 ** 255 - 1)), (14, ("argumentDepth",), 1),
            (15, ("methodBytes",), 8), (0, ("lastUsePostRollbackNegativeControls",), 0),
            (0, ("canonicalDomain",), "0" * 64), (1, ("timestamp",), "1"),
        )
        for index, path, value in changes:
            receipt, runtime, modules, sources = self.fixture()
            target = receipt["cases"][index]
            for key in path[:-1]: target = target[key]
            target[path[-1]] = value
            with self.subTest(index=index, path=path, value=value), self.assertRaises(ValueError):
                ci.validate_probe(receipt, runtime, modules, sources)
        receipt, runtime, modules, sources = self.fixture()
        receipt["pricing"]["executionFeeFactor"] = 1
        with self.assertRaises(ValueError): ci.validate_probe(receipt, runtime, modules, sources)

    def test_workflow_triggers_on_policy_specification_and_evidence_guard_inputs(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/native-profile.yml").read_text()
        sections = re.findall(r"    paths:\n((?:      - [^\n]+\n)+)", workflow)
        self.assertEqual(len(sections), 2, "Both push and pull_request must select the input graph")
        for section in sections:
            patterns = re.findall(r"      - '([^']+)'", section)
            for changed in (".editorconfig", "global.json", "Directory.Build.props", "Directory.Build.targets", "nuget.config",
                    "docs/proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md", "docs/proposals/smartaccount-native-profile-v2-parameters.json",
                    "docs/proposals/test_native_profile_v2.py", "docs/reports/aa-native-ci-probe-consistency-20261009.json",
                    "scripts/native_profile_ci.py", "scripts/native-profile-core-locks.json", "tests/NativeMultiSigProbe/Program.cs"):
                with self.subTest(changed=changed):
                    self.assertTrue(any(fnmatch.fnmatchcase(changed, pattern) for pattern in patterns), changed)
        self.assertIn("python3 -m unittest discover -s docs/proposals -p test_native_profile_v2.py -v", workflow)

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
