"""Receipt boundary tests using synthetic timings, without VM or network execution."""

import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import native_budget_benchmark as benchmark


def fixture():
    # Historical execution evidence supplies the finite scenario matrix only.
    # Timing and storage values below are test data, not benchmark measurements.
    root = Path(__file__).resolve().parents[1]
    probe = json.loads((root / "docs/reports/aa-native-ci-probe-consistency-20261009.json").read_text())
    receipt = {key: copy.deepcopy(probe[key]) for key in
               ("status", "publicNetworksTouched", "pricing", "artifactHashes", "runtimeAssemblyHashes", "probeSourceHashes")}
    receipt.update(schema="smartaccount-native-multisig-benchmark/v1", mode="fixed-snapshot-discard",
                   warmupCount=2, samplesPerCase=4, immutableOperationPerCase=True,
                   diagnosticsDuringTiming=False, timingBoundary="ApplicationEngine.Execute",
                   quantileMethod="nearest-rank", semanticControls=copy.deepcopy(probe["cases"]),
                   environment={"frameworkDescription": ".NET fixture", "osDescription": "test OS",
                                "osArchitecture": "Arm64", "processArchitecture": "Arm64",
                                "processorCount": 4, "stopwatchFrequency": 1000,
                                "stopwatchIsHighResolution": True, "machineName": "test-machine",
                                "runtimeVersion": "10.0.fixture", "serverGC": False,
                                "gcLatencyMode": "Interactive"}, cases=[])
    for source in probe["cases"][:18]:
        scenario = {key: value for key, value in source.items()
                    if key not in ("result", "verification", "phases", "lastUsePostRollbackNegativeControls")}
        state = source["result"]["state"]
        start = {"keyCount": 10, "keyBytes": 40, "valueBytes": 100, "totalBytes": 140}
        delta = {"keyCount": 1, "keyBytes": 4, "valueBytes": 8, "totalBytes": 12} if state == "HALT" else dict.fromkeys(start, 0)
        logical = {key: start[key] + delta[key] for key in start}
        samples = [{"elapsedTicks": ticks, "state": state,
                    "feeConsumedDatoshi": source["result"]["gas"],
                    "minimumRequiredFeeDatoshi": source["result"]["minimum"],
                    "logicalStorage": copy.deepcopy(logical), "storageDelta": copy.deepcopy(delta),
                    "committedStorageUnchanged": True} for ticks in (40, 10, 30, 20)]
        selected, sessions = 0, []
        for index, kind in enumerate(scenario["Roster"]):
            approved = state == "HALT" and scenario["Slots"][index] == "1" and not (scenario["BadSignature"] and index == 0) and selected < 2
            selected += int(approved)
            if kind == "S":
                spent = int(scenario["priorSpent"]) + (int(scenario["amount"]) if approved and scenario["methodBytes"] == 8 else 0)
                sessions.append({"childIndex": index, "spentAmount": str(spent),
                                 "lastUsedAt": scenario["timestamp"] if approved else "0", "immutableMetadataLastUsedAt": "0"})
        receipt["cases"].append({"scenario": scenario, "expectedState": state,
                                 "startingStorage": start, "phaseGas": source["phases"],
                                 "executionResult": source["result"], "verification": source["verification"],
                                 "samples": samples, "p50Ticks": 20, "p95Ticks": 40,
                                 "postExecutionState": {"nonceChannel": str(2 ** 191 - 1) if scenario["Maximum"] else "0",
                                                        "nonce": "1" if state == "HALT" else "0", "sessions": sessions}})
    return receipt


class NativeBudgetBenchmarkTests(unittest.TestCase):
    def test_valid_receipt_and_nearest_rank_preserve_input(self):
        receipt = fixture()
        original = copy.deepcopy(receipt)
        self.assertEqual(benchmark.validate_receipt(receipt), receipt)
        self.assertEqual(benchmark.nearest_rank([40, 10, 30, 20], 50), 20)
        self.assertEqual(benchmark.nearest_rank(list(range(1, 21)), 95), 19)
        self.assertEqual(receipt, original)

    def test_rejects_malformed_metrics_and_summaries(self):
        changes = [("p50Ticks", 25), ("p95Ticks", 30), ("p50Ticks", True)]
        for field, value in changes:
            receipt = fixture()
            receipt["cases"][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                benchmark.validate_receipt(receipt)
        for field, value in (("elapsedTicks", -1), ("elapsedTicks", 1.5), ("elapsedTicks", True),
                             ("elapsedTicks", 2 ** 63), ("feeConsumedDatoshi", -1),
                             ("minimumRequiredFeeDatoshi", 1), ("state", "FAULT"),
                             ("committedStorageUnchanged", 1)):
            receipt = fixture()
            receipt["cases"][0]["samples"][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                benchmark.validate_receipt(receipt)

    def test_rejects_nonfixed_samples_and_inconsistent_storage(self):
        mutations = [lambda case: case["samples"][0]["logicalStorage"].update(totalBytes=1),
                     lambda case: case["samples"][0]["storageDelta"].update(valueBytes=-1, totalBytes=3),
                     lambda case: case["startingStorage"].update(keyCount=-1),
                     lambda case: case["samples"][0].update(feeConsumedDatoshi=1),
                     lambda case: case["samples"].pop()]
        for change in mutations:
            receipt = fixture()
            change(receipt["cases"][0])
            with self.subTest(change=change), self.assertRaises(ValueError):
                benchmark.validate_receipt(receipt)
        receipt = fixture()
        case = receipt["cases"][16]
        for sample in case["samples"]:
            sample["logicalStorage"].update(valueBytes=101, totalBytes=141)
            sample["storageDelta"].update(valueBytes=1, totalBytes=1)
        with self.assertRaises(ValueError):
            benchmark.validate_receipt(receipt)

    def test_rejects_missing_duplicate_unknown_or_aliased_scenarios(self):
        for change in (lambda rows: rows.pop(), lambda rows: rows.append(copy.deepcopy(rows[0])),
                       lambda rows: rows.__setitem__(1, copy.deepcopy(rows[0])),
                       lambda rows: rows[0]["scenario"].update(Maximum=0),
                       lambda rows: rows[0]["scenario"].update(Roster="NN"),
                       lambda rows: rows[1]["scenario"].update(amount="1"),
                       lambda rows: rows[0].update(expectedState="FAULT")):
            receipt = fixture()
            change(receipt["cases"])
            with self.subTest(change=change), self.assertRaises(ValueError):
                benchmark.validate_receipt(receipt)

    def test_rejects_incomplete_identity_and_timing_conditions(self):
        changes = [("schema", "other/v1"), ("status", "FAIL"), ("publicNetworksTouched", 0),
                   ("mode", "commit"), ("warmupCount", True), ("warmupCount", -1),
                   ("samplesPerCase", 0), ("samplesPerCase", 10001),
                   ("immutableOperationPerCase", False), ("diagnosticsDuringTiming", True),
                   ("timingBoundary", "whole process"), ("quantileMethod", "interpolated")]
        for field, value in changes:
            receipt = fixture()
            receipt[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                benchmark.validate_receipt(receipt)
        for field in ("runtimeAssemblyHashes", "probeSourceHashes", "artifactHashes", "environment"):
            receipt = fixture()
            receipt[field] = {}
            with self.subTest(field=field), self.assertRaises(ValueError):
                benchmark.validate_receipt(receipt)
        receipt = fixture()
        receipt["environment"]["stopwatchFrequency"] = True
        with self.assertRaises(ValueError):
            benchmark.validate_receipt(receipt)

    def test_rejects_unrelated_fault_and_invalid_phase_gas(self):
        mutations = [(0, "phaseGas", lambda value: value[0].update(remainingDatoshi="0")),
                     (0, "phaseGas", lambda value: value[0].update(consumedDatoshi=1)),
                     (0, "phaseGas", lambda value: value.pop()),
                     (0, "verification", lambda value: value.update(booleanResult=False)),
                     (0, "executionResult", lambda value: value.update(notifications=0)),
                     (16, "executionResult", lambda value: value.update(error="Out of gas")),
                     (17, "verification", lambda value: value.update(exception="Out of gas"))]
        for index, field, change in mutations:
            receipt = fixture()
            change(receipt["cases"][index][field])
            with self.subTest(index=index, field=field), self.assertRaises(ValueError):
                benchmark.validate_receipt(receipt)

    def test_requires_full_semantic_controls_consistent_with_measured_cases(self):
        for change in (lambda receipt: receipt.pop("semanticControls"),
                       lambda receipt: receipt["semanticControls"].pop(),
                       lambda receipt: receipt["semanticControls"][18].update(configurationRollback=False),
                       lambda receipt: receipt["semanticControls"][0]["result"].update(gas=1)):
            receipt = fixture()
            change(receipt)
            with self.subTest(change=change), self.assertRaises(ValueError):
                benchmark.validate_receipt(receipt)

    def test_rejects_missing_or_incorrect_post_execution_value_semantics(self):
        for change in (lambda case: case.pop("postExecutionState"),
                       lambda case: case["postExecutionState"].update(nonce="0"),
                       lambda case: case["postExecutionState"].update(nonceChannel="1"),
                       lambda case: case["postExecutionState"]["sessions"].pop(),
                       lambda case: case["postExecutionState"]["sessions"][0].update(spentAmount="0"),
                       lambda case: case["postExecutionState"]["sessions"][0].update(lastUsedAt="0"),
                       lambda case: case["postExecutionState"]["sessions"][0].update(immutableMetadataLastUsedAt="1")):
            receipt = fixture()
            change(receipt["cases"][0])
            with self.subTest(change=change), self.assertRaises(ValueError):
                benchmark.validate_receipt(receipt)

    def test_comparison_rejects_runtime_pricing_source_environment_or_settings_mismatch(self):
        baseline = fixture()
        for field, key, value in (("runtimeAssemblyHashes", "Neo.dll", "f" * 64),
                                  ("probeSourceHashes", "Program.cs", "e" * 64),
                                  ("pricing", "executionFeeFactor", 31),
                                  ("environment", "machineName", "another-machine")):
            candidate = fixture()
            candidate[field][key] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                benchmark.compare_receipts(baseline, candidate)
        candidate = fixture()
        candidate["warmupCount"] += 1
        with self.assertRaises(ValueError):
            benchmark.compare_receipts(baseline, candidate)
        candidate = fixture()
        candidate["cases"][0]["scenario"]["dataLength"] = 1
        with self.assertRaises(ValueError):
            benchmark.compare_receipts(baseline, candidate)

    def test_artifact_changes_require_explicit_narrow_allowlist(self):
        baseline = fixture()
        candidate = fixture()
        candidate["artifactHashes"]["MultiSigVerifier.nef"] = "f" * 64
        with self.assertRaises(ValueError):
            benchmark.compare_receipts(baseline, candidate)
        report = benchmark.compare_receipts(baseline, candidate, ["MultiSigVerifier.nef"])
        self.assertEqual(report["status"], "PASS")
        for name in ("SessionKeyVerifier.nef", "missing.nef", "../MultiSigVerifier.nef"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                benchmark.compare_receipts(baseline, candidate, [name])
        candidate["artifactHashes"]["MultiSigVerifier.manifest.json"] = "e" * 64
        with self.assertRaises(ValueError):
            benchmark.compare_receipts(baseline, candidate, ["MultiSigVerifier.nef"])
        benchmark.compare_receipts(baseline, candidate, ["MultiSigVerifier.nef", "MultiSigVerifier.manifest.json"])

    def test_require_improvement_rejects_identical_and_requires_target_case(self):
        baseline = fixture()
        with self.assertRaisesRegex(ValueError, "strict.*improvement"):
            benchmark.compare_receipts(baseline, fixture(), require_improvement=True)
        candidate = fixture()
        phase = next(case for case in candidate["cases"] if
                     case["scenario"]["Roster"] == "SSN" and case["scenario"]["Slots"] == "110"
                     and case["scenario"]["Maximum"])["phaseGas"][1]
        phase["consumedDatoshi"] = str(int(phase["consumedDatoshi"]) - 1)
        phase["remainingDatoshi"] = str(int(phase["remainingDatoshi"]) + 1)
        candidate["semanticControls"][10]["phases"][1] = copy.deepcopy(phase)
        report = benchmark.compare_receipts(baseline, candidate, require_improvement=True)
        self.assertTrue(report["improvementRequired"])

    def test_comparison_preserves_raw_receipts_and_matches_cases_by_identity(self):
        baseline, candidate = fixture(), fixture()
        candidate["cases"].reverse()
        report = benchmark.compare_receipts(baseline, candidate)
        self.assertEqual(report["baselineReceipt"], baseline)
        self.assertEqual(report["candidateReceipt"], candidate)
        self.assertEqual(len(report["cases"]), 18)
        candidate["cases"][0]["samples"][0]["elapsedTicks"] = 999
        self.assertNotEqual(report["candidateReceipt"], candidate)

    def test_changed_artifact_sizes_are_reported_but_state_growth_must_match(self):
        baseline, candidate = fixture(), fixture()
        for case in candidate["cases"]:
            case["startingStorage"]["valueBytes"] += 20
            case["startingStorage"]["totalBytes"] += 20
            for sample in case["samples"]:
                sample["logicalStorage"]["valueBytes"] += 20
                sample["logicalStorage"]["totalBytes"] += 20
        benchmark.compare_receipts(baseline, candidate)
        for sample in candidate["cases"][0]["samples"]:
            sample["logicalStorage"]["valueBytes"] += 1
            sample["logicalStorage"]["totalBytes"] += 1
            sample["storageDelta"]["valueBytes"] += 1
            sample["storageDelta"]["totalBytes"] += 1
        with self.assertRaisesRegex(ValueError, "storageDelta"):
            benchmark.compare_receipts(baseline, candidate)

    def test_cli_records_input_hashes_raw_samples_and_failure_status(self):
        script = Path(__file__).with_name("native_budget_benchmark.py")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            baseline, candidate, output = [directory / name for name in ("baseline.json", "candidate.json", "report.json")]
            baseline.write_text(json.dumps(fixture(), indent=2))
            candidate.write_text(json.dumps(fixture()))
            command = [sys.executable, str(script)]
            validated = subprocess.run(command + ["validate", str(baseline)], capture_output=True, text=True)
            self.assertEqual(validated.returncode, 0, validated.stderr)
            compared = subprocess.run(command + ["compare", str(baseline), str(candidate), "--output", str(output)], capture_output=True, text=True)
            self.assertEqual(compared.returncode, 0, compared.stderr)
            report = json.loads(output.read_text())
            self.assertEqual(report["inputs"]["baseline"]["sha256"], hashlib.sha256(baseline.read_bytes()).hexdigest())
            self.assertEqual(report["baselineReceipt"]["cases"][0]["samples"], fixture()["cases"][0]["samples"])
            rejected = subprocess.run(command + ["compare", str(baseline), str(candidate), "--require-improvement", "--output", str(output)], capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertEqual(json.loads(output.read_text())["status"], "FAIL")

    def test_cli_rejects_duplicate_json_keys_and_nonfinite_numbers(self):
        script = Path(__file__).with_name("native_budget_benchmark.py")
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "bad.json"
            for content in ('{"schema":"one","schema":"two"}', '{"metric": NaN}'):
                path.write_text(content)
                result = subprocess.run([sys.executable, str(script), "validate", str(path)], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
