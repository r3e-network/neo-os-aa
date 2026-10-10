#!/usr/bin/env python3
"""Validate and compare local fixed-snapshot benchmark JSON, without executing it.

Timings describe ApplicationEngine.Execute on the recorded host. Logical storage
bytes are serialized key/value sizes, not physical database usage or network TPS.
Comparison PASS means the identities and semantic controls match; only
--require-improvement additionally requires the designated callback GAS reduction.
"""

import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import sys

import native_profile_ci as profile


SCHEMA = "smartaccount-native-multisig-benchmark/v1"
COMPARISON_SCHEMA = "smartaccount-native-multisig-benchmark-comparison/v1"
MAX_SAFE_INTEGER = 2 ** 53 - 1
STORAGE_FIELDS = ("keyCount", "keyBytes", "valueBytes", "totalBytes")
SELECTORS = ("Roster", "Slots", "Maximum", "BadSignature", "Malformed")
MEASUREMENTS = ("descriptionBytes", "amount", "dataLength", "methodBytes", "timestamp",
                "priorSpent", "signatureBytes", "argumentDepth", "canonicalDomain")
CONDITIONS = {"mode": "fixed-snapshot-discard", "immutableOperationPerCase": True,
              "diagnosticsDuringTiming": False, "timingBoundary": "ApplicationEngine.Execute",
              "quantileMethod": "nearest-rank"}
ALLOWED_ARTIFACTS = {"MultiSigVerifier.nef", "MultiSigVerifier.manifest.json"}
TARGET = ("SSN", "110", True, False, False)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def same(left, right):
    """JSON identity must not conflate true, 1 and 1.0."""
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def integer(value, label, minimum=0, maximum=MAX_SAFE_INTEGER):
    require(type(value) is int and minimum <= value <= maximum,
            f"{label} must be an integer in [{minimum}, {maximum}]")
    return value


def nearest_rank(values, percentile):
    require(isinstance(values, list) and values, "Quantiles require nonempty samples")
    integer(percentile, "percentile", 1, 100)
    for value in values:
        integer(value, "elapsedTicks")
    return sorted(values)[(percentile * len(values) + 99) // 100 - 1]


def hash_map(value, label, expected, exact=True):
    require(isinstance(value, dict) and value, f"{label} must be a nonempty object")
    require(set(value) == set(expected) if exact else set(expected) <= set(value), f"{label} roster differs")
    require(all(isinstance(name, str) and Path(name).name == name and name not in ("", ".", "..")
                and isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest)
                for name, digest in value.items()), f"{label} must contain file names and lowercase SHA256 hashes")


def storage(value, label, signed=False):
    require(isinstance(value, dict) and set(value) == set(STORAGE_FIELDS), f"{label} fields differ")
    for key in STORAGE_FIELDS:
        integer(value[key], f"{label}.{key}", -MAX_SAFE_INTEGER if signed else 0)
    require(value["totalBytes"] == value["keyBytes"] + value["valueBytes"], f"{label} byte total differs")
    return value


def identity(scenario):
    require(isinstance(scenario, dict), "scenario must be an object")
    require(all(type(scenario.get(key)) is bool for key in SELECTORS[2:]), "Scenario selectors must be exact Booleans")
    require(all(type(scenario.get(key)) is str for key in SELECTORS[:2]), "Scenario identity must be strings")
    return tuple(scenario[key] for key in SELECTORS)


def expected_post_state(scenario, state):
    selected, sessions = 0, []
    for index, kind in enumerate(scenario["Roster"]):
        approved = (state == "HALT" and scenario["Slots"][index] == "1"
                    and not (scenario["BadSignature"] and index == 0) and selected < 2)
        selected += int(approved)
        if kind == "S":
            spent = int(scenario["priorSpent"])
            if approved and scenario["methodBytes"] == 8:
                spent += int(scenario["amount"])
            sessions.append({"childIndex": index, "spentAmount": str(spent),
                             "lastUsedAt": scenario["timestamp"] if approved else "0",
                             "immutableMetadataLastUsedAt": "0"})
    return {"nonceChannel": str(2 ** 191 - 1) if scenario["Maximum"] else "0",
            "nonce": "1" if state == "HALT" else "0", "sessions": sessions}


def validate_receipt(receipt):
    require(isinstance(receipt, dict), "Receipt must be an object")
    require(receipt.get("schema") == SCHEMA and receipt.get("status") == "PASS", "Benchmark schema or status differs")
    require(receipt.get("publicNetworksTouched") is False, "Benchmark must not touch public networks")
    for key, value in CONDITIONS.items():
        require(same(receipt.get(key), value), f"Benchmark {key} differs")
    integer(receipt.get("warmupCount"), "warmupCount", 0, 10000)
    sample_count = integer(receipt.get("samplesPerCase"), "samplesPerCase", 1, 10000)
    environment = receipt.get("environment")
    require(isinstance(environment, dict), "environment must be an object")
    for key in ("frameworkDescription", "osDescription", "osArchitecture", "processArchitecture",
                "machineName", "runtimeVersion", "gcLatencyMode"):
        require(isinstance(environment.get(key), str) and environment[key].strip(), f"environment.{key} must be a nonempty string")
    for key in ("processorCount", "stopwatchFrequency"):
        integer(environment.get(key), f"environment.{key}", 1)
    for key in ("stopwatchIsHighResolution", "serverGC"):
        require(type(environment.get(key)) is bool, f"environment.{key} must be Boolean")
    require(same(receipt.get("pricing"), profile.PROBE_PRICING), "Benchmark pricing differs from the reviewed conditions")
    hash_map(receipt.get("artifactHashes"), "artifactHashes",
             {name + suffix for name in profile.PROBE_MODULES for suffix in (".nef", ".manifest.json")})
    hash_map(receipt.get("runtimeAssemblyHashes"), "runtimeAssemblyHashes",
             {name + ".dll" for name in (*profile.CORE_PROJECTS, "Neo.VM")}, exact=False)
    hash_map(receipt.get("probeSourceHashes"), "probeSourceHashes", profile.PROBE_FILES)

    controls = receipt.get("semanticControls")
    # This reuses the existing finite input, authorization, rollback, and GAS
    # boundary without invoking the CI module's build or network entry point.
    profile.validate_probe_cases({"pricing": receipt["pricing"], "cases": controls})
    indexed_controls = {identity(control): control for control in controls if "label" not in control}
    cases = receipt.get("cases")
    require(isinstance(cases, list) and len(cases) == len(profile.PROBE_SCENARIOS), "Benchmark scenario matrix is incomplete or contains unknown cases")
    seen = set()
    for case in cases:
        require(isinstance(case, dict), "Benchmark case must be an object")
        scenario = case.get("scenario")
        key = identity(scenario)
        require(key in profile.PROBE_SCENARIOS and key not in seen, "Unknown or duplicate benchmark scenario")
        seen.add(key)
        control = indexed_controls[key]
        expected_scenario = {field: control[field] for field in (*SELECTORS, *MEASUREMENTS)}
        require(same(scenario, expected_scenario), "Benchmark scenario measurements differ from semantic controls")
        state = control["result"]["state"]
        require(case.get("expectedState") == state, "Benchmark expectedState differs from semantic controls")
        require(same(case.get("postExecutionState"), expected_post_state(scenario, state)),
                "Benchmark postExecutionState differs from expected nonce, selected Session spending or timestamps")
        for field, control_field in (("executionResult", "result"), ("verification", "verification"), ("phaseGas", "phases")):
            require(same(case.get(field), control[control_field]), f"Benchmark {field} differs from semantic controls")
        start = storage(case.get("startingStorage"), "startingStorage")
        samples = case.get("samples")
        require(isinstance(samples, list) and len(samples) == sample_count, "Benchmark sample count differs")
        fixed_result = None
        for sample in samples:
            require(isinstance(sample, dict), "Benchmark sample must be an object")
            integer(sample.get("elapsedTicks"), "elapsedTicks")
            require(sample.get("state") == state, "Sample state differs from expectedState")
            fee = integer(sample.get("feeConsumedDatoshi"), "feeConsumedDatoshi")
            minimum = integer(sample.get("minimumRequiredFeeDatoshi"), "minimumRequiredFeeDatoshi")
            require(minimum >= fee, "Minimum required fee is below consumption")
            require(fee == control["result"]["gas"] and minimum == control["result"]["minimum"], "Sample fees differ from the fixed execution result")
            require(sample.get("committedStorageUnchanged") is True, "Sample committed storage was not unchanged")
            logical = storage(sample.get("logicalStorage"), "logicalStorage")
            delta = storage(sample.get("storageDelta"), "storageDelta", signed=True)
            require(all(logical[field] - start[field] == delta[field] for field in STORAGE_FIELDS), "Sample storageDelta differs from logicalStorage minus startingStorage")
            if state == "FAULT":
                require(logical == start and all(value == 0 for value in delta.values()), "FAULT must retain starting storage")
            current = (sample["state"], fee, minimum, logical, delta)
            require(fixed_result is None or current == fixed_result, "Repeated samples do not have fixed execution and storage outcomes")
            fixed_result = current
        for field, percentile in (("p50Ticks", 50), ("p95Ticks", 95)):
            integer(case.get(field), field)
            require(case[field] == nearest_rank([sample["elapsedTicks"] for sample in samples], percentile), f"{field} differs from nearest-rank samples")
    require(seen == profile.PROBE_SCENARIOS, "Benchmark omitted a required scenario")
    return receipt


def normalized_controls(controls):
    normalized = copy.deepcopy(controls)
    for control in normalized:
        if "label" in control:
            continue
        for field in ("gas", "minimum"):
            del control["result"][field]
        del control["verification"]["gasConsumedDatoshi"]
        for phase in control["phases"]:
            del phase["consumedDatoshi"]
            del phase["remainingDatoshi"]
    # JSON sorting also keeps Boolean selectors distinct from integer aliases.
    return sorted(normalized, key=lambda value: json.dumps(value, sort_keys=True))


def metric(baseline, candidate):
    return {"baseline": baseline, "candidate": candidate, "delta": candidate - baseline,
            "changePercent": 100 * (candidate - baseline) / baseline if baseline else None}


def compare_receipts(baseline, candidate, allow_artifact_change=(), require_improvement=False):
    validate_receipt(baseline)
    validate_receipt(candidate)
    allowed = set(allow_artifact_change)
    require(allowed <= ALLOWED_ARTIFACTS, "Artifact exceptions are limited to explicitly named MultiSigVerifier NEF or manifest")
    for field in ("schema", "mode", "warmupCount", "samplesPerCase", "environment", "pricing",
                  "runtimeAssemblyHashes", "probeSourceHashes", *CONDITIONS):
        require(same(baseline[field], candidate[field]), f"Comparison identity mismatch: {field}")
    before_hashes, after_hashes = baseline["artifactHashes"], candidate["artifactHashes"]
    require(set(before_hashes) == set(after_hashes), "Comparison artifact roster differs")
    changes = {name: {"baseline": before_hashes[name], "candidate": after_hashes[name]}
               for name in before_hashes if before_hashes[name] != after_hashes[name]}
    require(set(changes) <= allowed, "Comparison contains an unallowed artifact change")
    require(same(normalized_controls(baseline["semanticControls"]), normalized_controls(candidate["semanticControls"])),
            "Comparison semantic controls differ")
    candidates = {identity(case["scenario"]): case for case in candidate["cases"]}
    comparisons = []
    target_reduction = False
    for before in baseline["cases"]:
        key = identity(before["scenario"])
        after = candidates[key]
        require(same(before["scenario"], after["scenario"]), "Comparison scenario differs")
        require(same(before["postExecutionState"], after["postExecutionState"]), "Comparison postExecutionState differs")
        require(before["startingStorage"]["keyCount"] == after["startingStorage"]["keyCount"], "Comparison startingStorage.keyCount differs")
        require(same(before["samples"][0]["storageDelta"], after["samples"][0]["storageDelta"]), "Comparison storageDelta differs")
        phases = {left["phase"]: metric(int(left["consumedDatoshi"]), int(right["consumedDatoshi"]))
                  for left, right in zip(before["phaseGas"], after["phaseGas"])}
        if key == TARGET:
            target_reduction = phases["postExecuteComposite"]["delta"] < 0
        frequency = baseline["environment"]["stopwatchFrequency"]
        comparisons.append({"scenario": copy.deepcopy(before["scenario"]), "expectedState": before["expectedState"],
                            "p50Ticks": metric(before["p50Ticks"], after["p50Ticks"]),
                            "p95Ticks": metric(before["p95Ticks"], after["p95Ticks"]),
                            "p50Milliseconds": metric(before["p50Ticks"] * 1000 / frequency, after["p50Ticks"] * 1000 / frequency),
                            "p95Milliseconds": metric(before["p95Ticks"] * 1000 / frequency, after["p95Ticks"] * 1000 / frequency),
                            "feeConsumedDatoshi": metric(before["executionResult"]["gas"], after["executionResult"]["gas"]),
                            "minimumRequiredFeeDatoshi": metric(before["executionResult"]["minimum"], after["executionResult"]["minimum"]),
                            "verificationGasConsumedDatoshi": metric(before["verification"]["gasConsumedDatoshi"], after["verification"]["gasConsumedDatoshi"]),
                            "phaseGasConsumedDatoshi": phases,
                            "startingStorage": {field: metric(before["startingStorage"][field], after["startingStorage"][field]) for field in STORAGE_FIELDS},
                            "storageDelta": copy.deepcopy(before["samples"][0]["storageDelta"])})
    require(not require_improvement or target_reduction, "Required strict postExecuteComposite GAS improvement for SSN/110 Maximum=true was not measured")
    return {"schema": COMPARISON_SCHEMA, "status": "PASS", "publicNetworksTouched": False,
            "scope": "Local ApplicationEngine.Execute only; logical storage bytes; no network throughput claim",
            "improvementRequired": require_improvement, "targetPostGasReduced": target_reduction,
            "allowedArtifactChanges": sorted(allowed), "artifactChanges": changes,
            "baselineReceipt": copy.deepcopy(baseline), "candidateReceipt": copy.deepcopy(candidate), "cases": comparisons}


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON field: {key}")
        result[key] = value
    return result


def read_receipt(path):
    raw = path.read_bytes()
    def reject_constant(value):
        raise ValueError(f"Nonfinite JSON number: {value}")
    value = json.loads(raw, object_pairs_hook=reject_duplicate_keys, parse_constant=reject_constant)
    return value, {"path": str(path.resolve()), "sha256": hashlib.sha256(raw).hexdigest()}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate", help="Validate a retained benchmark receipt")
    validate.add_argument("receipt", type=Path)
    validate.add_argument("--output", type=Path)
    compare = commands.add_parser("compare", help="Compare identities, semantics, and local measurements")
    compare.add_argument("baseline", type=Path)
    compare.add_argument("candidate", type=Path)
    compare.add_argument("--allow-artifact-change", action="append", default=[], metavar="NAME")
    compare.add_argument("--require-improvement", action="store_true")
    compare.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    report = {"schema": COMPARISON_SCHEMA if args.command == "compare" else "smartaccount-native-multisig-benchmark-validation/v1",
              "status": "FAIL", "publicNetworksTouched": False, "inputs": {}}
    try:
        input_paths = [args.receipt] if args.command == "validate" else [args.baseline, args.candidate]
        require(args.output is None or all(args.output.resolve() != path.resolve() for path in input_paths), "Output must not overwrite an input receipt")
        if args.command == "validate":
            receipt, metadata = read_receipt(args.receipt)
            report["inputs"]["receipt"] = metadata
            validate_receipt(receipt)
            report.update(status="PASS", cases=len(receipt["cases"]), samplesPerCase=receipt["samplesPerCase"])
        else:
            baseline, metadata = read_receipt(args.baseline)
            report["inputs"]["baseline"] = metadata
            candidate, metadata = read_receipt(args.candidate)
            report["inputs"]["candidate"] = metadata
            report["baselineReceipt"], report["candidateReceipt"] = baseline, candidate
            report.update(compare_receipts(baseline, candidate, args.allow_artifact_change, args.require_improvement))
    except (ValueError, OSError, UnicodeError, TypeError, KeyError) as error:
        report.update(status="FAIL", error=str(error))
    serialized = json.dumps(report, indent=2, sort_keys=True, allow_nan=False) + "\n"
    if args.output:
        # Even a rejected comparison must retain a FAIL receipt. Never replace
        # the inputs when the requested output aliases one of them.
        if all(args.output.resolve() != path.resolve() for path in input_paths):
            try:
                args.output.write_text(serialized)
            except OSError as error:
                print(f"Cannot write comparison receipt: {error}", file=sys.stderr)
                return 1
    else:
        print(serialized, end="")
    if report["status"] != "PASS":
        print(report["error"], file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
