#!/usr/bin/env python3
"""Build a pinned native core and exercise reproducible module NEFs in its VM.

This is a local ApplicationEngine probe with synthetic signers, not a block,
mempool, wallet, or public-network test. Only JSON receipts are exported; build
trees, packages and executable artifacts remain in the private work directory.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import urllib.request


SDK = "10.0.400"
VM_VERSION = "3.10.2-ci00384"
VM_SHA256 = "84bd08d291362cfaf85697f0fb14666719d3443f2f71c39c8de1b9184c20820e"
VM_URL = f"https://www.myget.org/F/neo/api/v3/flatcontainer/neo.vm/{VM_VERSION}/neo.vm.{VM_VERSION}.nupkg"
CORE_PROJECTS = ("Neo", "Neo.Extensions", "Neo.IO", "Neo.Json")
PROBE_FILES = ("Program.cs", "NativeMultiSigProbe.csproj", "packages.lock.json")
PROBE_MODULES = ("SessionKeyVerifier", "NeoNativeVerifier", "MultiSigVerifier")
# Schema v1 is a reviewed finite matrix, not a count threshold. Adding a case
# requires changing the producer and this evidence boundary together.
PROBE_SCENARIOS = {
    ("SN", "11", False, False, False), ("SN", "11", True, False, False),
    ("SS", "11", False, False, False), ("SS", "11", True, False, False),
    ("SSN", "110", False, False, False), ("SSN", "101", False, False, False),
    ("SSN", "011", False, False, False), ("SSN", "111", False, False, False),
    ("SSN", "111", False, True, False), ("SSN", "111", True, False, False),
    ("SSN", "110", True, False, False), ("SSN", "101", True, False, False),
    ("SSN", "011", True, False, False), ("SSS", "111", True, True, False),
    ("SSS", "111", True, False, False), ("SSS", "110", True, False, False),
    ("SSN", "100", False, False, False), ("SSN", "111", False, False, True),
}
PROBE_PRICING = {"executionFeeFactor": 30, "storagePriceDatoshi": 100000,
                 "globalVerificationLimitDatoshi": 150000000, "rootCallbackLimitDatoshi": 100000000,
                 "internalFeeScale": "10000000"}
PROBE_DOMAIN = "95f9b24ea3b055e8bd3bce0bf24c6ec31b68689ad320de2adef18b0719f6f528"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def pin_sdk(directory):
    """Select the exact SDK; installing it alone does not defeat newer SDKs."""
    target = directory / "global.json"
    value = {"sdk": {"version": SDK, "rollForward": "disable", "allowPrerelease": False}}
    require(not target.is_symlink(), "SDK selector must not be a symbolic link")
    if target.exists():
        require(json.loads(target.read_text()) == value, "Existing global.json differs; it will not be overwritten")
    else:
        with target.open("x") as stream:
            stream.write(json.dumps(value, indent=2) + "\n")
    return target


def build_environment(work, cache):
    pin_sdk(work)
    scratch = work / "temporary"
    scratch.mkdir()
    # build_native_modules.py creates its two scratch trees with tempfile. Keep
    # both below global.json so compiler/MSBuild children select this SDK too.
    return {**os.environ, "NUGET_PACKAGES": str(cache), "TMPDIR": str(scratch),
            "TMP": str(scratch), "TEMP": str(scratch),
            "DOTNET_NOLOGO": "1", "DOTNET_CLI_TELEMETRY_OPTOUT": "1"}


def command(args, cwd, log, env=None, timeout=600):
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
    log.write_text(result.stdout + result.stderr)
    if result.returncode:
        print(result.stdout[-12000:] + result.stderr[-12000:], file=sys.stderr)
        raise RuntimeError(f"Command failed ({result.returncode}); see {log.name}")
    return result.stdout


def check_core_identity(core, expected):
    require(re.fullmatch(r"[0-9a-f]{40}", expected) is not None, "Core pin must be a full lowercase commit SHA")
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=core, text=True).strip()
    require(actual == expected, "Checked-out core does not match the reviewed commit")
    changed = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=core, text=True)
    require(not changed, "Core checkout has tracked changes")


def snapshot_core(core, destination):
    # Export only committed build inputs. Never consume a developer's bin/obj or
    # package overlay, and reject links/path traversal before extracting anything.
    # Preserve repository-wide compiler policy such as .editorconfig too.
    archive = subprocess.check_output(["git", "archive", "HEAD"], cwd=core)
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        members = stream.getmembers()
        for member in members:
            require((destination / member.name).resolve().is_relative_to(destination), "Core archive path escapes its build directory")
            require(member.isfile() or member.isdir(), "Core archive contains a non-regular input")
        for member in members:
            stream.extract(member, destination)
    return {p.relative_to(destination).as_posix(): sha256(p) for p in sorted(destination.rglob("*")) if p.is_file()}


def install_locks(core, bundle_path):
    bundle = json.loads(bundle_path.read_text())
    require(bundle.get("schema") == "smartaccount-native-core-locks/v1" and bundle.get("sdk") == SDK, "Unexpected core lock schema or SDK")
    locks = bundle.get("locks")
    require(isinstance(locks, dict) and set(locks) == {f"src/{name}/packages.lock.json" for name in CORE_PROJECTS}, "Core lock project roster differs")
    for name, lock in locks.items():
        require(lock.get("version") == 1 and set(lock.get("dependencies", {})) == {"net10.0"}, "Unexpected core lock target")
        write_json(core / name, lock)
    return locks, bundle.get("archiveSha256")


def verify_package_archives(locks, cache, archive_pins):
    """Check archive bytes even when NuGet reuses a pre-existing global cache."""
    archives = {}
    expected_packages = {}
    for lock in locks.values():
        for name, entry in lock["dependencies"]["net10.0"].items():
            if entry["type"] == "Project":
                continue
            require(entry["type"] in ("Direct", "Transitive"), "Unexpected locked dependency type")
            identity = f"{name.lower()}/{entry['resolved'].lower()}"
            expected_hash = entry.get("contentHash")
            require(isinstance(expected_hash, str) and expected_hash, "Dependency lacks its archive hash")
            require(identity not in expected_packages or expected_packages[identity] == expected_hash, "Conflicting locked package hashes")
            expected_packages[identity] = expected_hash
    require(expected_packages, "Core dependency lock is empty")
    require(isinstance(archive_pins, dict) and set(archive_pins) == set(expected_packages), "Archive pin roster differs from the dependency locks")
    for identity in expected_packages:
        name, version = identity.split("/")
        archive = cache / name / version / f"{name}.{version}.nupkg"
        # NuGet checks contentHash in locked mode. Its signed-package content hash
        # is not a hash of the whole ZIP; pin those archive bytes separately.
        actual = sha256(archive)
        require(actual == archive_pins[identity], f"Restored archive differs from the reviewed bytes: {identity}")
        archives[identity] = actual
    require(archives.get(f"neo.vm/{VM_VERSION}") == VM_SHA256, "Native VM archive differs from the reviewed package")
    require(not any(identity.split("/")[0] in {name.lower() for name in CORE_PROJECTS} for identity in archives), "Binary package substituted for source-built core")
    return archives


def validate_module_receipt(receipt, modules):
    require(receipt.get("schema") == "smartaccount-native-module-build/v2" and receipt.get("status") == "PASS", "Native module build did not pass")
    require(receipt.get("publicNetworksTouched") is False and receipt.get("nefRewritten") is False, "Unexpected native module build mode")
    builds = receipt.get("builds")
    require(receipt.get("reproducible") is True and isinstance(builds, list) and len(builds) == 2 and builds[0] == builds[1] and builds[0], "Independent module bytes differ or are absent")
    actual = {p.name: sha256(p) for p in modules.iterdir() if p.suffix in (".nef", ".json")}
    require(actual == builds[0], "Retained module bytes differ from the two verified builds")
    require(sum(name.endswith(".nef") for name in actual) == 6 and sum(name.endswith(".manifest.json") for name in actual) == 6, "Native module roster differs")
    return actual


def parse_probe_output(output):
    decoder = json.JSONDecoder()
    candidates = []
    for match in re.finditer(r"(?m)^\{", output):
        try:
            value, _ = decoder.raw_decode(output[match.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("schema") == "smartaccount-native-multisig-probe/v1":
            candidates.append(value)
    require(len(candidates) == 1, "Probe must return exactly one structured receipt")
    return candidates[0]


def validate_probe_cases(receipt):
    """Require the reviewed matrix and measured outcome, including negative cases."""
    require(receipt.get("pricing") == PROBE_PRICING, "Probe pricing differs from the reviewed measurement conditions")
    cases = receipt.get("cases")
    require(isinstance(cases, list) and len(cases) == len(PROBE_SCENARIOS) + 2, "Native VM scenario matrix is incomplete or contains unknown cases")
    seen, aliases = set(), set()
    for case in cases:
        require(isinstance(case, dict), "Probe case must be an object")
        if "label" in case:
            require(case["label"] == "session-native-same-key-rejected" and type(case.get("uncompressed")) is bool, "Unknown signer-alias scenario")
            encoding = case["uncompressed"]
            require(encoding not in aliases, "Duplicate signer-alias scenario")
            aliases.add(encoding)
            require(all(case.get(key) is True for key in ("configurationRollback", "invalidPointRollback", "revocationClearsDomainAndLastUse")), "Signer-alias rejection or rollback did not pass")
            require(case.get("standardAccount") == "0x7efe7ee0d3e349e085388c351955e5172605de66" and case.get("domain") == PROBE_DOMAIN and case.get("initialLastUseHex") == "", "Signer-alias vector or initial policy state differs")
            continue
        require(all(type(case.get(key)) is bool for key in ("Maximum", "BadSignature", "Malformed")), "Scenario selectors must be exact Booleans")
        require(type(case.get("Roster")) is str and type(case.get("Slots")) is str, "Scenario identity must be strings")
        identity = tuple(case.get(key) for key in ("Roster", "Slots", "Maximum", "BadSignature", "Malformed"))
        require(identity in PROBE_SCENARIOS and identity not in seen, "Unknown or duplicate execution scenario")
        seen.add(identity)
        roster, slots, maximum, bad_signature, malformed = identity
        deep = roster == "SSS" and maximum and not bad_signature
        grow_spent = roster == "SSN" and slots == "111" and maximum
        signature_bytes = 2 + sum(1 if slot == "0" else 3 if malformed and i == len(roster) - 1 else 66 if kind == "S" else 2
                                  for i, (kind, slot) in enumerate(zip(roster, slots)))
        # The 4096-byte args envelope contains 84 fixed bytes (two Hash160s,
        # one 32-byte positive Integer and byte-string framing); depth 8 adds
        # seven two-byte Array wrappers. Check measured inputs, not Maximum alone.
        measurements = {
            "descriptionBytes": 128 if maximum else 16,
            "amount": str(2 ** 255 - (2 if grow_spent else 1)) if maximum else "1000000",
            "dataLength": (3998 if deep else 4012) if maximum else 0,
            "argumentDepth": 8 if deep else 1,
            "methodBytes": 128 if roster == "SSS" and slots == "110" else 8,
            "priorSpent": "1" if grow_spent else "0",
            "signatureBytes": 1024 if grow_spent else signature_bytes,
            "timestamp": str(2 ** 64 - 1 - (24 - len(roster)) * 86400000) if maximum else str(1468595302000 + (len(roster) + 1) * 86400000),
            "lastUsePostRollbackNegativeControls": 4 if roster == "SN" and not maximum else 0,
            "canonicalDomain": PROBE_DOMAIN,
        }
        require(all(type(case.get(key)) is type(value) and case[key] == value for key, value in measurements.items()), "Probe measured inputs or negative-control coverage differ from the scenario")
        expected = not case["Malformed"] and case["Slots"].count("1") >= 2
        state = "HALT" if expected else "FAULT"
        result, verification = case.get("result"), case.get("verification")
        require(isinstance(result, dict) and isinstance(verification, dict), "Probe omitted trigger results")
        require(result.get("state") == state and verification.get("state") == state, "Probe trigger outcome differs from the expected approval")
        require(type(result.get("gas")) is int and type(result.get("minimum")) is int and 0 < result["gas"] <= result["minimum"], "Probe admission fee is absent or below consumption")
        require(type(result.get("notifications")) is int and result["notifications"] == (1 if expected else 0), "Probe target notification outcome differs")
        require(type(verification.get("gasConsumedDatoshi")) is int and 0 < verification["gasConsumedDatoshi"] <= PROBE_PRICING["globalVerificationLimitDatoshi"], "Verification exceeds its global budget")
        require(verification.get("gasLimitDatoshi") == PROBE_PRICING["globalVerificationLimitDatoshi"], "Verification budget differs from the reviewed limit")
        require(verification.get("authorized") is expected, "Verification did not report the expected authorization")
        if expected:
            require(type(verification.get("resultCount")) is int and verification["resultCount"] == 1
                    and verification.get("resultType") == "Boolean" and verification.get("booleanResult") is True,
                    "Verification HALT must return exactly one Boolean true")
            require(result.get("error") is None and verification.get("exception") is None, "Successful scenario contains a VM failure")
        else:
            reason = "Invalid child signature type" if case["Malformed"] else "Verifier rejected signature"
            require(all(isinstance(error, str) and reason in error for error in (result.get("error"), verification.get("exception"))), "Negative scenario failed for an unrelated reason")
        phases = case.get("phases")
        names = ["validateCompositeSignature", "postExecuteComposite"] if expected else ["validateCompositeSignature"]
        require(isinstance(phases, list) and [p.get("phase") if isinstance(p, dict) else None for p in phases] == names, "Probe callback phases are absent, duplicated or incorrect")
        for phase in phases:
            values = [phase.get(key) for key in ("limitDatoshi", "consumedDatoshi", "remainingDatoshi")]
            require(all(isinstance(value, str) and re.fullmatch(r"0|[1-9][0-9]*", value) for value in values), "Callback measurements must be canonical nonnegative integers")
            limit, consumed, remaining = map(int, values)
            require(limit == PROBE_PRICING["rootCallbackLimitDatoshi"] and 0 < consumed < limit and remaining == limit - consumed, "Callback exceeds or misreports its fixed budget")
    require(seen == PROBE_SCENARIOS and aliases == {False, True}, "Probe omitted a required execution or signer-alias scenario")


def validate_probe(receipt, runtime, modules, probe_sources):
    require(receipt.get("schema") == "smartaccount-native-multisig-probe/v1" and receipt.get("status") == "PASS", "Native VM probe did not pass")
    require(receipt.get("publicNetworksTouched") is False, "Unexpected probe network mode")
    validate_probe_cases(receipt)
    require(receipt.get("probeSourceHashes") == probe_sources, "Executed probe source differs from the reviewed source")
    expected_artifacts = {f"{name}{suffix}": modules[f"{name}{suffix}"] for name in PROBE_MODULES for suffix in (".nef", ".manifest.json")}
    require(receipt.get("artifactHashes") == expected_artifacts, "Probe did not execute the reproducible module bytes")
    loaded = receipt.get("runtimeAssemblyHashes")
    require(isinstance(loaded, dict) and {f"{name}.dll" for name in (*CORE_PROJECTS, "Neo.VM")} <= set(loaded), "Probe omitted a required source-runtime assembly")
    require(all(runtime.get(name) == digest for name, digest in loaded.items()), "Probe loaded an assembly outside the published core runtime")


def execute(args):
    repo = Path(__file__).resolve().parent.parent
    core, work, output = args.core.resolve(), args.work.resolve(), args.output.resolve()
    compiler, cache = args.compiler.resolve(), args.cache.resolve()
    require(not work.exists(), "CI work directory must be new; existing data is never removed")
    require(not output.exists(), "Receipt directory must be new; existing data is never removed")
    work.mkdir(parents=True)
    output.mkdir(parents=True)
    report = {"schema": "smartaccount-native-profile-ci/v1", "status": "RUNNING", "publicNetworksTouched": False,
              "scope": "ApplicationEngine host probe with synthetic transaction signers; no mempool or block guarantee",
              "coreCommit": args.core_commit, "recipeSha256": sha256(Path(__file__)),
              "workflowSha256": sha256(repo / ".github/workflows/native-profile.yml"),
              "guardTestSha256": sha256(Path(__file__).with_name("test_native_profile_ci.py"))}
    write_json(output / "native-profile-ci.json", report)
    try:
        check_core_identity(core, args.core_commit)
        env = build_environment(work, cache)
        # AA/probe commands use the checkout selector created by the workflow;
        # core and module compilation use the independent work-tree selector.
        version = subprocess.check_output(["dotnet", "--version"], cwd=repo, text=True).strip()
        require(version == SDK, f"Expected .NET SDK {SDK}; found {version}")
        require(subprocess.check_output(["dotnet", "--version"], cwd=work, env=env, text=True).strip() == SDK, "Isolated build selected a different SDK")
        source = work / "core"
        source.mkdir()
        sources = snapshot_core(core, source)
        bundle = Path(__file__).with_name("native-profile-core-locks.json")
        locks, archive_pins = install_locks(source, bundle)
        lock_bytes = {name: sha256(source / name) for name in locks}
        feed = source / "pkgs"
        feed.mkdir(exist_ok=True)
        vm_archive = feed / f"neo.vm.{VM_VERSION}.nupkg"
        with urllib.request.urlopen(VM_URL, timeout=60) as response:
            vm_archive.write_bytes(response.read())
        require(sha256(vm_archive) == VM_SHA256, "Downloaded native VM package differs from the reviewed bytes")
        common = ["-p:RestorePackagesWithLockFile=true", "-p:UseSharedCompilation=false"]
        command(["dotnet", "restore", "src/Neo/Neo.csproj", "--configfile", "nuget.config", "--locked-mode", *common], source, work / "core-restore.log", env)
        archives = verify_package_archives(locks, cache, archive_pins)
        runtime_dir = work / "runtime"
        command(["dotnet", "publish", "src/Neo/Neo.csproj", "--no-restore", "--configuration", "Release", "--output", str(runtime_dir), *common], source, work / "core-publish.log", env)
        runtime = {p.name: sha256(p) for p in sorted(runtime_dir.iterdir()) if p.is_file()}
        require(all(f"{name}.dll" in runtime for name in (*CORE_PROJECTS, "Neo.VM")), "Published core runtime is incomplete")
        require(sources == {name: sha256(source / name) for name in sources}, "Core build changed a source input")
        require(lock_bytes == {name: sha256(source / name) for name in locks}, "Core build changed a reviewed lock")
        write_json(output / "core-build-manifest.json", {"schema": "smartaccount-native-core-build/v1", "status": "PASS", "coreCommit": args.core_commit,
                   "sdk": version, "sourceSha256": sources, "lockBundleSha256": sha256(bundle), "locks": lock_bytes, "archives": archives, "runtime": runtime})
        modules = work / "modules"
        command([sys.executable, "scripts/build_native_modules.py", "--contracts", str(repo / "contracts"), "--compiler", str(compiler), "--cache", str(cache),
                 "--output", str(modules), "--receipt", str(output / "module-build.json")], repo, work / "module-build.log", env, timeout=1200)
        module_hashes = validate_module_receipt(json.loads((output / "module-build.json").read_text()), modules)
        probe_root = repo / "tests/NativeMultiSigProbe"
        probe_sources = {name: sha256(probe_root / name) for name in PROBE_FILES}
        stdout = command(["dotnet", "run", "--project", str(probe_root / "NativeMultiSigProbe.csproj"), "--configuration", "Release",
                          f"-p:NativeRuntimeDirectory={runtime_dir}", "-p:UseArtifactsOutput=true", f"-p:ArtifactsPath={work / 'probe'}", "-p:UseSharedCompilation=false",
                          "--", str(modules)], repo, work / "multisig-probe.log", env)
        receipt = parse_probe_output(stdout)
        validate_probe(receipt, runtime, module_hashes, probe_sources)
        require(probe_sources == {name: sha256(probe_root / name) for name in PROBE_FILES}, "Probe inputs changed during execution")
        require(runtime == {p.name: sha256(p) for p in runtime_dir.iterdir() if p.is_file()}, "Probe changed the source runtime")
        validate_module_receipt(json.loads((output / "module-build.json").read_text()), modules)
        check_core_identity(core, args.core_commit)
        write_json(output / "multisig-probe.json", receipt)
        report.update(status="PASS", sdk=version, probeCases=len(receipt["cases"]), receipts={name: sha256(output / name) for name in ("core-build-manifest.json", "module-build.json", "multisig-probe.json")})
    except Exception as error:
        report.update(status="FAIL", error=str(error))
        raise
    finally:
        report["completedAtUtc"] = datetime.now(timezone.utc).isoformat()
        write_json(output / "native-profile-ci.json", report)
    print(json.dumps({"status": report["status"], "probeCases": report["probeCases"], "coreCommit": args.core_commit}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("core", "work", "output", "compiler", "cache"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--core-commit", required=True)
    execute(parser.parse_args())
