#!/usr/bin/env python3
"""Run native private-chain matrices against a byte-verified source-built runner."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil

import neoexpress_activation_validate as activation
import neoexpress_native_service_validate as service
import neoexpress_native_proxy_validate as proxy
import neoexpress_native_configuration_validate as configuration
import neoexpress_native_recovery_validate as recovery
from neoexpress_reproducible_build import BuildFailure, check_runtime_receipt, sha256


def activation_current(runtime, dotnet, output):
    return activation.validate(runtime, None, dotnet, output)


VALIDATORS = [("service", service.validate), ("proxy", proxy.validate),
              ("configuration", configuration.validate), ("recovery", recovery.validate),
              ("activation", activation_current)]


def validate(runtime, dotnet, build_receipt, output):
    if output.exists(): raise BuildFailure("Validation output directory must be new")
    output.mkdir(parents=True)
    summary = {"schema": "smartaccount-source-runtime-private/v1", "status": "RUNNING", "publicNetworksTouched": False,
               "runtimeMode": "Complete source-built NeoExpress runtime; exact full file map verified before and after each matrix.",
               "validations": {}, "sourceSha256": {p.name: sha256(p) for p in Path(__file__).parent.glob("neoexpress_*validate.py")},
               "fullProtocolConformanceVerified": False}
    summary["sourceSha256"]["neoexpress_reproducible_build.py"] = sha256(Path(__file__).with_name("neoexpress_reproducible_build.py"))
    target = output / "summary.json"
    target.write_text(json.dumps(summary, indent=2) + "\n")
    try:
        build = json.loads(build_receipt.read_text())
        summary["sourceBuildReceiptSha256"] = sha256(build_receipt)
        for name, validator in VALIDATORS:
            check_runtime_receipt(build, runtime)
            raw = output / (name + ".raw.json")
            validator(runtime, dotnet, raw)
            result = json.loads(raw.read_text())
            if result.get("status") != "PASS" or result.get("ownedNodesStopped") is not True:
                raise BuildFailure("Private validator failed or did not stop its owned nodes")
            check_runtime_receipt(build, runtime)
            linked = {**result, "runtimeMode": summary["runtimeMode"],
                      "sourceBuildReceiptSha256": summary["sourceBuildReceiptSha256"],
                      "rawReceipt": raw.name, "rawReceiptSha256": sha256(raw)}
            receipt = output / (name + ".json")
            receipt.write_text(json.dumps(linked, indent=2) + "\n")
            summary["validations"][name] = {"receipt": receipt.name, "sha256": sha256(receipt), "status": "PASS"}
            print("PASS: source-built runtime " + name, flush=True)
        if sha256(build_receipt) != summary["sourceBuildReceiptSha256"]:
            raise BuildFailure("Build receipt changed during validation")
        for name, digest in summary["sourceSha256"].items():
            if sha256(Path(__file__).with_name(name)) != digest:
                raise BuildFailure("Validation sources changed during execution")
        summary.update(status="PASS", runtimeFilesMatched=True, ownedNodesStopped=True)
    except Exception as error:
        summary.update(status="FAIL", failureType=type(error).__name__)
        raise
    finally:
        if summary["status"] != "PASS": summary["status"] = "FAIL"
        summary["completedAtUtc"] = datetime.now(timezone.utc).isoformat()
        target.write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("runtime", "build-receipt", "output"):
        parser.add_argument("--" + key, type=Path, required=True)
    parser.add_argument("--dotnet", type=Path, default=shutil.which("dotnet"))
    args = parser.parse_args()
    if args.dotnet is None: raise BuildFailure("A local dotnet runtime is required")
    validate(args.runtime.resolve(), args.dotnet.resolve(), args.build_receipt.resolve(), args.output.resolve())


if __name__ == "__main__": main()
