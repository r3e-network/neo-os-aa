#!/usr/bin/env python3
"""Offline, two-directory source rebuild of the native SmartAccount test runner."""
import argparse
import hashlib
import json
import os
import platform
from pathlib import Path, PurePosixPath
import shutil
import subprocess
from datetime import datetime, timezone


class BuildFailure(RuntimeError):
    """An input or output did not meet the declared build contract."""


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def allowed_source(role, relative):
    path = PurePosixPath(relative)
    if path.is_absolute() or any(p in ("..", "bin", "obj", ".git") for p in path.parts):
        return False
    if relative in ("global.json", "version.json", "Directory.Build.props", "Directory.Build.targets", ".editorconfig", "README.md", "readme.md", "LICENSE", "neo.png"):
        return True
    prefixes = {
        "core": ("src/Neo/", "src/Neo.Extensions/", "src/Neo.IO/", "src/Neo.Json/"),
        "node": tuple("plugins/" + p + "/" for p in ("RpcServer", "RpcClient", "MPTTrie", "DBFTPlugin", "PluginHelper")) + ("src/Neo.ConsoleService/",),
        "express": ("src/neoxp/", "src/bctklib/"),
    }
    if relative in ("src/Directory.Build.props", "src/Directory.Build.targets", "plugins/Directory.Build.props", "src/neo-logo-72.png", "src/neo-cli.ico"):
        return True
    if role == "core" and relative.startswith("src/Neo/Resources/BIP-39.") and path.suffix == ".txt":
        return True
    return relative.startswith(prefixes[role]) and path.suffix.lower() in (".cs", ".csproj", ".props", ".targets", ".resx", ".ico", ".png")


def inventory(root):
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise BuildFailure("Symbolic links are not build inputs or outputs")
        if path.is_file():
            result[path.relative_to(root).as_posix()] = sha256(path)
    return result


def require_equal(first, second, label):
    if not first or first != second:
        raise BuildFailure(label + " file map is empty or has missing, added or changed files")


def check_runtime_receipt(receipt, runtime):
    if receipt.get("status") != "PASS" or receipt.get("independentCleanBuilds") != 2 or len(receipt.get("builds", [])) != 2:
        raise BuildFailure("Runtime requires a successful two-build receipt")
    for label in ("runtime", "archives", "locks"):
        require_equal(receipt["builds"][0][label], receipt["builds"][1][label], label)
    require_equal(receipt["builds"][0]["runtime"], inventory(runtime), "selected runtime")


def source_files(role, root):
    listed = subprocess.check_output(["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard", "-z"]).decode().split("\0")
    result = {}
    for name in sorted(set(filter(None, listed))):
        if allowed_source(role, name):
            path = root / name
            if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
                raise BuildFailure("Selected source is missing or not a regular repository file")
            result[name] = sha256(path)
    if not result:
        raise BuildFailure("Empty source snapshot")
    return result


def targets_text():
    replacements = {
        "Neo": "core/src/Neo/Neo.csproj",
        "Neo.Plugins.RpcServer": "node/plugins/RpcServer/RpcServer.csproj",
        "Neo.Consensus.DBFT": "node/plugins/DBFTPlugin/DBFTPlugin.csproj",
        "Neo.Cryptography.MPT": "node/plugins/MPTTrie/MPTTrie.csproj",
        "Neo.Network.RPC.RpcClient": "node/plugins/RpcClient/RpcClient.csproj",
    }
    text = '''<Project>
  <PropertyGroup>
    <Deterministic>true</Deterministic>
    <PathMap>$(MSBuildThisFileDirectory)=/_/native-runner/</PathMap>
    <DebugType>portable</DebugType>
    <EmbedUntrackedSources>false</EmbedUntrackedSources>
    <UseAppHost>false</UseAppHost>
    <NuGetAudit>false</NuGetAudit>
    <RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Remove="Nerdbank.GitVersioning" />
    <PackageReference Remove="Microsoft.SourceLink.GitHub" />
  </ItemGroup>
'''
    for package, project in replacements.items():
        text += f'''  <ItemGroup Condition="'@(PackageReference->WithMetadataValue('Identity', '{package}'))' != ''">
    <PackageReference Remove="{package}" />
    <ProjectReference Include="$(MSBuildThisFileDirectory){project}" />
  </ItemGroup>
'''
    return text + "</Project>\n"


def run(command, cwd, logfile, environment):
    with logfile.open("ab") as output:
        result = subprocess.run(command, cwd=cwd, env=environment, stdout=output, stderr=subprocess.STDOUT, timeout=600)
    if result.returncode:
        raise BuildFailure("Local build command failed; inspect the private build log")


def prepare(root, sources, snapshots, patch, sdk):
    for role, origin in sources.items():
        for relative in snapshots[role]:
            destination = root / role / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(origin / relative, destination)
        require_equal(snapshots[role], inventory(root / role), role + " snapshot")
    subprocess.run(["git", "apply", "--check", str(patch)], cwd=root / "express", check=True, capture_output=True)
    subprocess.run(["git", "apply", str(patch)], cwd=root / "express", check=True, capture_output=True)
    (root / "Directory.Build.targets").write_text(targets_text())
    (root / "global.json").write_text(json.dumps({"sdk": {"version": sdk, "rollForward": "disable"}}))
    # Git-derived version generators are replaced by explicit, reproducible metadata.
    # Snapshot and revision identities are retained separately in the receipt.
    for project in ("bctklib", "neoxp"):
        (root / "express/src" / project / "BuildVersion.cs").write_text(
            'internal static class ThisAssembly { public const string AssemblyFileVersion = "3.10.1.0"; '
            'public const string AssemblyInformationalVersion = "3.10.1-native-source"; }\n')


def package_archives(root, packages):
    result = {}
    for assets in root.glob("*/**/obj/project.assets.json"):
        for name, item in json.loads(assets.read_text())["libraries"].items():
            if item["type"] != "package":
                continue
            package, version = name.lower().split("/")
            archive = packages / package / version / f"{package}.{version}.nupkg"
            if not archive.is_file():
                raise BuildFailure("Restored dependency archive is missing")
            result[name] = sha256(archive)
    forbidden = ("Neo/", "Neo.Extensions/", "Neo.IO/", "Neo.Json/", "Neo.Plugins.RpcServer/", "Neo.Consensus.DBFT/", "Neo.Cryptography.MPT/", "Neo.Network.RPC.RpcClient/")
    if not result or any(name.startswith(forbidden) for name in result):
        raise BuildFailure("Source graph unexpectedly uses a binary Neo core or node package")
    return result


def build_once(root, sources, snapshots, patch, dotnet, sdk, cache, expected=None):
    prepare(root, sources, snapshots, patch, sdk)
    configuration = root / "NuGet.Config"
    # NuGet's hierarchical local feed layout matches the global package archive cache.
    import xml.etree.ElementTree as ET
    xml = ET.Element("configuration"); feeds = ET.SubElement(xml, "packageSources")
    ET.SubElement(feeds, "clear"); ET.SubElement(feeds, "add", key="offline", value=str(cache))
    ET.ElementTree(xml).write(configuration, encoding="utf-8", xml_declaration=True)
    packages = root / "packages"
    environment = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "DOTNET_ROOT") if key in os.environ}
    environment.update({"NUGET_PACKAGES": str(packages), "DOTNET_CLI_TELEMETRY_OPTOUT": "1", "DOTNET_NOLOGO": "1"})
    project = "express/src/neoxp/neoxp.csproj"
    log = root / "build.log"
    common = ["-p:NuGetAudit=false", "-p:UseSharedCompilation=false"]
    run([dotnet, "restore", project, "--configfile", str(configuration), "--source", str(cache), *common], root, log, environment)
    archives = package_archives(root, packages)
    locks = {str(p.relative_to(root)): sha256(p) for p in root.glob("*/**/packages.lock.json") if "packages" not in p.relative_to(root).parts}
    if expected is not None:
        require_equal(expected["archives"], archives, "pinned dependency archive")
        require_equal(expected["locks"], locks, "pinned dependency lock")
    run([dotnet, "restore", project, "--configfile", str(configuration), "--source", str(cache), "--locked-mode", *common], root, log, environment)
    output = root / "runtime"
    run([dotnet, "publish", project, "--no-restore", "-c", "Release", "-o", str(output), *common], root, log, environment)
    run([dotnet, str(output / "neoxp.dll"), "--version"], root, log, environment)
    required = ("neoxp.dll", "bctklib.dll", "Neo.dll", "RpcServer.dll", "DBFTPlugin.dll", "RpcClient.dll", "MPTTrie.dll", "neoxp.deps.json", "neoxp.runtimeconfig.json")
    if not all((output / name).is_file() for name in required):
        raise BuildFailure("Source-built runtime is incomplete")
    return {"runtime": inventory(output), "archives": archives, "locks": locks}


def execute(args):
    report = {"schema": "smartaccount-native-runner-reproducibility/v1", "status": "RUNNING", "publicNetworksTouched": False,
              "runtimeMode": "Complete source-built NeoExpress runtime with pinned external package inputs; no assembly overlay.",
              "compilerRefinementProven": False}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    try:
        expected = json.loads(args.expected.read_text()) if args.expected is not None else None
        sources = {role: getattr(args, role).resolve() for role in ("core", "node", "express")}
        if args.work.exists():
            raise BuildFailure("Build directory must not exist; existing data is never removed")
        args.work.mkdir(parents=True)
        snapshots = {role: source_files(role, root) for role, root in sources.items()}
        sdk = subprocess.check_output([args.dotnet, "--version"], text=True).strip()
        patch = Path(__file__).with_name("neoexpress-build-compat.patch").resolve()
        report.update({"sdk": sdk, "host": {"system": platform.system(), "machine": platform.machine()}, "sourceSha256": snapshots, "sourceCommits": {role: subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip() for role, root in sources.items()},
                       "recipeSha256": sha256(Path(__file__)), "compatibilityPatchSha256": sha256(patch)})
        if expected is not None:
            if expected.get("status") != "PASS": raise BuildFailure("Expected receipt is not PASS")
            for label in ("sdk", "host", "sourceSha256", "sourceCommits", "recipeSha256", "compatibilityPatchSha256"):
                require_equal(expected[label], report[label], "pinned " + label)
            report["expectedReceiptSha256"] = sha256(args.expected)
        results = []
        for index in (1, 2):
            directory = args.work / f"build-{index}"
            directory.mkdir()
            print(f"Starting independent offline source build {index}", flush=True)
            results.append(build_once(directory, sources, snapshots, patch, args.dotnet, sdk, args.cache.resolve(), None if expected is None else expected["builds"][0]))
            for role, origin in sources.items():
                require_equal(snapshots[role], source_files(role, origin), role + " original source")
        for label in ("runtime", "archives", "locks"):
            require_equal(results[0][label], results[1][label], label)
            if expected is not None: require_equal(expected["builds"][0][label], results[0][label], "pinned " + label)
        report.update({"status": "PASS", "builds": results, "runtimeFileCount": len(results[0]["runtime"]),
                       "packageCount": len(results[0]["archives"]), "independentCleanBuilds": 2,
                       "sourceInputsUnchanged": True, "runtimeByteIdentical": True,
                       "limits": "Pinned host/SDK/dependency reproducibility; not compiler correctness, full protocol conformance or a third-party audit. Private-chain validation is separate."})
    except Exception as error:
        report.update({"status": "FAIL", "failureType": type(error).__name__})
        raise
    finally:
        if report["status"] != "PASS": report["status"] = "FAIL"
        report["completedAtUtc"] = datetime.now(timezone.utc).isoformat()
        args.output.write_text(json.dumps(report, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("core", "node", "express", "cache", "work", "output"):
        parser.add_argument("--" + option, required=True, type=Path)
    parser.add_argument("--dotnet", default="dotnet")
    parser.add_argument("--expected", type=Path, help="Previously reviewed PASS receipt; all source, recipe, dependency and runtime pins must match")
    args = parser.parse_args()
    args.work = args.work.resolve(); args.output = args.output.resolve()
    if args.expected is not None and args.expected.resolve() == args.output:
        parser.error("Expected receipt and output must be different files")
    execute(args)


if __name__ == "__main__": main()
