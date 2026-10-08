#!/usr/bin/env python3
"""Reproduce native modules under the repository restore policy.

Copy root policy files and committed per-project locks into private build trees.
Missing locks fail before compilation; never generate locks or replace the source
policy with an offline feed during a release build. The cache only supplies the
locked package bytes and the framework archive used for provenance.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

from native_module_profile import package, prepare_native_source, validate_descriptor


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def checked_input(root, path):
    lexical = Path(os.path.abspath(path))
    if not lexical.is_relative_to(root) or any(p.is_symlink() for p in [lexical, *lexical.parents] if p.is_relative_to(root)):
        raise ValueError("Native input must remain in the source tree without symbolic links")
    if not lexical.is_file():
        raise ValueError("Native input must be an existing regular file")
    return lexical


def collect_inputs(contracts):
    """Pin inputs using repository paths, including files governing locked restore."""
    root = contracts.parent
    descriptor = checked_input(contracts, contracts / "native/profiles.json")
    profiles = validate_descriptor(json.loads(descriptor.read_text()))
    inputs = {"Directory.Build.props", "nuget.config", "contracts/native/profiles.json"}
    for spec in profiles.values():
        project = checked_input(contracts, contracts / "native" / spec["project"])
        # Directory.Build.props selects the lock name by sibling project count.
        # Copy all project names so the scratch tree preserves that same decision.
        siblings = list(project.parent.glob("*.csproj"))
        for sibling in siblings:
            inputs.add(checked_input(contracts, sibling).relative_to(root).as_posix())
        lock_name = f"packages.{project.stem}.lock.json" if len(siblings) > 1 else "packages.lock.json"
        lock = project.parent / lock_name
        if not lock.is_file():
            raise ValueError(f"Native project lock is missing: {lock.relative_to(root)}; generate and review it separately")
        inputs.add(checked_input(contracts, lock).relative_to(root).as_posix())
        for item in ET.parse(project).findall(".//Compile"):
            source = checked_input(contracts, project.parent / item.attrib["Include"])
            inputs.add(source.relative_to(root).as_posix())
    pins = {name: digest(checked_input(root, root / name)) for name in sorted(inputs)}
    policy = ET.parse(root / "Directory.Build.props")
    for key in ("RestorePackagesWithLockFile", "RestoreLockedMode"):
        values = policy.findall(".//" + key)
        if len(values) != 1 or values[0].text != "true":
            raise ValueError("Native builds require the repository locked restore policy: " + key)
    return profiles, pins


def build(contracts, compiler, cache, output, receipt):
    report = {"schema": "smartaccount-native-module-build/v2", "status": "RUNNING",
              "publicNetworksTouched": False, "nefRewritten": False, "sourceRoot": "repository"}
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(json.dumps(report) + "\n")
    try:
        if output.exists():
            raise ValueError("Native output must be a new directory")
        root = contracts.parent
        profiles, pins = collect_inputs(contracts)
        versions = ET.parse(root / "Directory.Build.props").findall(".//NeoSmartContractFrameworkVersion")
        if len(versions) != 1 or not versions[0].text:
            raise ValueError("A single explicit framework version is required")
        framework = versions[0].text.lower()
        if any(c not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for c in framework):
            raise ValueError("Invalid framework version")
        archive = cache / "neo.smartcontract.framework" / framework / f"neo.smartcontract.framework.{framework}.nupkg"
        version = subprocess.check_output([str(compiler), "--version"], text=True).strip()
        report.update(compilerVersion=version, compilerLauncherSha256=digest(compiler),
                      frameworkArchiveSha256=digest(archive), sourceSha256=pins,
                      restoreLockedMode=True, packageSourcesPolicy="nuget.config",
                      recipeSha256=digest(Path(__file__)),
                      packagingRecipeSha256=digest(Path(__file__).with_name("native_module_profile.py")))
        artifacts = []; prepared = []
        with tempfile.TemporaryDirectory(prefix="smartaccount-native-build-") as temp:
            for index in (1, 2):
                scratch = Path(temp) / f"build-{index}"; scratch.mkdir()
                for name in pins:
                    src = root / name; destination = scratch / name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    if src.suffix == ".cs":
                        prepare_native_source(src, destination)
                    else:
                        shutil.copyfile(src, destination)
                snapshot = {name: digest(scratch / name) for name in pins}
                prepared.append(snapshot)
                raw = scratch / "raw"; raw.mkdir()
                # Cache selection cannot override the pinned feed or locked mode.
                env = {**os.environ, "NUGET_PACKAGES": str(cache), "RestoreLockedMode": "true",
                       "RestorePackagesWithLockFile": "true"}
                for spec in profiles.values():
                    result = subprocess.run([str(compiler), str(scratch / "contracts/native" / spec["project"]),
                                             "-o", str(raw)], cwd=scratch, env=env,
                                            capture_output=True, text=True, timeout=180)
                    if result.returncode:
                        raise RuntimeError("Native compiler failed: " + result.stdout[-1000:] + result.stderr[-1000:])
                if snapshot != {name: digest(scratch / name) for name in pins}:
                    raise ValueError("Native compiler changed a pinned build input or lock")
                packaged = scratch / "packaged"
                package(raw, packaged, scratch / "contracts/native/profiles.json")
                artifacts.append({p.name: digest(p) for p in packaged.iterdir() if p.suffix in (".nef", ".json")})
                if index == 1:
                    retained = scratch / "retained"; shutil.copytree(packaged, retained)
                    raw_retained = raw
            if artifacts[0] != artifacts[1] or prepared[0] != prepared[1]:
                raise ValueError("Native artifacts are not reproducible")
            for name, pin in pins.items():
                if digest(root / name) != pin:
                    raise ValueError("Native build input changed")
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(retained, output); shutil.copytree(raw_retained, output / "raw")
        report.update(status="PASS", builds=artifacts, preparedSourceSha256=prepared[0], reproducible=True)
    finally:
        if report["status"] != "PASS": report["status"] = "FAIL"
        report["completedAtUtc"] = datetime.now(timezone.utc).isoformat()
        receipt.write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ("contracts","compiler","cache","output","receipt"):parser.add_argument("--"+name,type=Path,required=True)
    a=parser.parse_args();build(a.contracts.resolve(),a.compiler.resolve(),a.cache.resolve(),a.output.resolve(),a.receipt.resolve())
