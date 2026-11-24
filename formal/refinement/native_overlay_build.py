"""Rebuild the current native overlay twice from clean directories and bind its proof target."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from native_profile_ci import SDK, install_locks, pin_sdk, snapshot_core

CORE = "e7fcc132f6546c55ad7342f26d69081a71357be5"
PROJECT = Path("contracts/native/Neo.csproj")
BUNDLE = Path("scripts/native-profile-core-locks.json")
LIBRARIES = ("Neo.dll", "Neo.Extensions.dll", "Neo.IO.dll", "Neo.Json.dll")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inputs():
    files = [PROJECT, PROJECT.parent / "packages.lock.json", BUNDLE, Path("Directory.Build.props"), Path("nuget.config")]
    for group in ("SmartAccount", "Runtime"):
        files.extend(p.relative_to(ROOT) for p in sorted((ROOT / PROJECT.parent / group).glob("*.cs")))
    return {str(path): sha(ROOT / path) for path in files}


def build(core, out):
    out.mkdir(parents=True, exist_ok=True)
    receipt = out / "build.json"
    receipt.write_text('{"status":"INCOMPLETE","implementationVerified":false}\n')
    expected = inputs()
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=core, text=True).strip() != CORE:
        raise ValueError("base core must match the reviewed commit")
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp).resolve()
        results = []
        for run in ("first", "second"):
            stage = root / run
            base = stage / "core"
            base.mkdir(parents=True)
            # git archive ignores dirty files and compiler output in the donor checkout.
            snapshot_core(core, base)
            if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=core, text=True).strip() != CORE:
                raise ValueError("base core changed during export")
            checkout = stage / "aa"
            for name, digest in expected.items():
                target = checkout / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, target)
                if sha(target) != digest:
                    raise ValueError("source changed: " + name)
            install_locks(base, checkout / BUNDLE)
            pin_sdk(stage)
            env = {**os.environ, "DOTNET_CLI_TELEMETRY_OPTOUT":"1", "DOTNET_NOLOGO":"1"}
            if subprocess.check_output(["dotnet","--version"], cwd=checkout, env=env, text=True).strip() != SDK:
                raise ValueError("SDK mismatch")
            flags = ["-p:NeoSourceRoot="+str(base/"src"), "-p:NeoCoreRoot="+str(base/"src/Neo"),
                     "-p:PathMap="+str(stage)+"=/_/sa", "-p:Deterministic=true"]
            subprocess.run(["dotnet","restore",str(PROJECT),"--configfile","nuget.config","--locked-mode",
                            "-p:NuGetAudit=false",*flags], cwd=checkout, env=env, check=True)
            subprocess.run(["dotnet","build",str(PROJECT),"-c","Release","--no-restore",*flags],
                           cwd=checkout, env=env, check=True)
            binaries = checkout / PROJECT.parent / "bin/Release/net10.0"
            results.append({name: sha(binaries / name) for name in LIBRARIES})
        if results[0] != results[1] or inputs() != expected:
            raise ValueError("independent outputs or input snapshot differ")
        for name in LIBRARIES:
            shutil.copyfile(binaries / name, out / name)
    receipt.write_text(json.dumps(dict(status="PASS",implementationVerified=False,coreCommit=CORE,
        sdk=SDK,configuration="Release",inputs=expected,builds=results,
        scope="Exact bytes of the native overlay and its three project references; no method semantics or activation claim."),
        indent=2)+"\n")


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--core",required=True,type=Path)
    cli.add_argument("--output",required=True,type=Path)
    a=cli.parse_args()
    build(a.core.resolve(),a.output.resolve())
