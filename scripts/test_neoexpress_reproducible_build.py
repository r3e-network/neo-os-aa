"""Fail-closed source selection and complete build-output comparison."""
import tempfile
import unittest
from pathlib import Path
import json
from unittest.mock import patch
from types import SimpleNamespace
import subprocess
import sys
import shutil

import neoexpress_reproducible_build as build


class ReproducibleBuildTests(unittest.TestCase):
    def test_source_recipe_survives_nested_repository_targets(self):
        dotnet = shutil.which("dotnet")
        if dotnet is None:
            self.fail("Real MSBuild is required for the source-graph regression")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "NativeRunner.targets").write_text(build.targets_text())
            nested = root / "node"
            nested.mkdir()
            (nested / "Directory.Build.targets").write_text(
                "<Project><PropertyGroup><RepositoryTargetsRetained>true</RepositoryTargetsRetained>"
                "</PropertyGroup></Project>")
            project = nested / "Probe.csproj"
            project.write_text('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>'
                '<TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup>'
                '<PackageReference Include="Neo" Version="3.10.2-CI02099" />'
                '</ItemGroup></Project>')
            # Capture the exact production arguments passed to restore/publish.
            commands = []
            def capture(command, *args):
                commands.append(command)
                raise build.BuildFailure("captured")
            with patch.object(build, "prepare"), patch.object(build, "run", side_effect=capture):
                with self.assertRaisesRegex(build.BuildFailure, "captured"):
                    build.build_once(root, {}, {}, root / "patch", dotnet, "10.0.400", root)
            arguments = [arg for arg in commands[0] if arg.startswith("-p:")]
            output = subprocess.check_output([dotnet, "msbuild", str(project),
                "-getItem:PackageReference,ProjectReference", "-getProperty:RepositoryTargetsRetained,PathMap",
                *arguments], text=True, cwd=root)
            evaluated = json.loads(output)
            self.assertEqual("true", evaluated["Properties"]["RepositoryTargetsRetained"])
            self.assertFalse(any(item["Identity"] == "Neo" for item in evaluated["Items"]["PackageReference"]))
            self.assertEqual([str(root / "core/src/Neo/Neo.csproj")],
                [item["Identity"] for item in evaluated["Items"]["ProjectReference"]])
            self.assertEqual(str(root) + "/=/_/native-runner/", evaluated["Properties"]["PathMap"])

    def test_sources_exclude_outputs_and_private_inputs(self):
        for path in ("src/Neo/Native.cs", "src/Neo/Neo.csproj", "global.json", "src/Directory.Build.props", "src/Neo/Resources/BIP-39.cs.txt"):
            self.assertTrue(build.allowed_source("core", path), path)
        for path in ("src/Neo/bin/Debug/Neo.dll", "src/Neo/obj/generated.cs", "wallet.json", ".env", "src/Neo/secret.key", "../src/a.cs"):
            self.assertFalse(build.allowed_source("core", path), path)
        self.assertTrue(build.allowed_source("node", "plugins/RpcServer/RpcServer.cs"))
        self.assertFalse(build.allowed_source("node", "plugins/SQLiteWallet/Wallet.cs"))
        self.assertTrue(build.allowed_source("express", "src/bctklib/persistence/RocksDbStore.cs"))
        self.assertFalse(build.allowed_source("express", "src/worknet/Wallet.cs"))
        self.assertFalse(build.allowed_source("core", "src/Neo/wallet.json"))

    def test_complete_output_maps_reject_extra_missing_and_changed_files(self):
        baseline = {"Neo.dll": "a", "runtimes/osx/native/lib.dylib": "b"}
        build.require_equal(baseline, dict(baseline), "runtime")
        for wrong in ({"Neo.dll": "a"}, {**baseline, "extra.dll": "c"}, {**baseline, "Neo.dll": "c"}):
            with self.assertRaises(build.BuildFailure): build.require_equal(baseline, wrong, "runtime")
        with self.assertRaises(build.BuildFailure): build.require_equal({}, {}, "runtime")

    def test_inventory_rejects_symlinks_and_hashes_all_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / "a").write_bytes(b"one")
            before = build.inventory(root)
            (root / "a").write_bytes(b"two")
            self.assertNotEqual(before, build.inventory(root))
            (root / "b").symlink_to(root / "a")
            with self.assertRaises(build.BuildFailure): build.inventory(root)

    def test_project_reference_recipe_excludes_obsolete_binary_core(self):
        recipe = build.targets_text()
        for name in ("Neo", "Neo.Plugins.RpcServer", "Neo.Consensus.DBFT", "Neo.Cryptography.MPT", "Neo.Network.RPC.RpcClient"):
            self.assertIn('Remove="' + name + '"', recipe)
        self.assertIn("Deterministic", recipe)
        self.assertIn("PathMap", recipe)
        self.assertNotIn("https://", recipe)

    def test_current_receipt_requires_two_equal_builds_and_exact_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root / "Neo.dll").write_bytes(b"native")
            result = {"runtime": build.inventory(root), "archives": {"Neo.VM/1": "pin"}, "locks": {"project": "pin"}}
            receipt = {"status": "PASS", "independentCleanBuilds": 2, "builds": [result, result]}
            build.check_runtime_receipt(receipt, root)
            for wrong in ({**receipt, "status": "RUNNING"}, {**receipt, "builds": [result]},
                          {**receipt, "builds": [result, {**result, "archives": {"other": "pin"}}]}):
                with self.assertRaises(build.BuildFailure): build.check_runtime_receipt(wrong, root)
            (root / "Neo.dll").write_bytes(b"changed")
            with self.assertRaises(build.BuildFailure): build.check_runtime_receipt(receipt, root)

    def test_package_inventory_refuses_private_binary_core_and_missing_archives(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); assets = root / "core/src/Neo/obj/project.assets.json"
            assets.parent.mkdir(parents=True)
            cache = root / "packages"; archive = cache / "neo.vm/1/neo.vm.1.nupkg"
            archive.parent.mkdir(parents=True); archive.write_bytes(b"package")
            assets.write_text(json.dumps({"libraries": {"Neo.VM/1": {"type": "package"}, "Neo/1": {"type": "project"}}}))
            self.assertEqual({"Neo.VM/1": build.sha256(archive)}, build.package_archives(root, cache))
            archive.unlink()
            with self.assertRaises(build.BuildFailure): build.package_archives(root, cache)
            archive = cache / "neo/1/neo.1.nupkg"; archive.parent.mkdir(parents=True); archive.write_bytes(b"obsolete")
            assets.write_text(json.dumps({"libraries": {"Neo/1": {"type": "package"}}}))
            with self.assertRaises(build.BuildFailure): build.package_archives(root, cache)

    def test_source_snapshot_rejects_missing_files_and_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); name = "src/Neo/a.cs"; path = root / name
            path.parent.mkdir(parents=True)
            with patch.object(build.subprocess, "check_output", return_value=(name + "\0").encode()):
                with self.assertRaises(build.BuildFailure): build.source_files("core", root)
                path.symlink_to(root / "missing")
                with self.assertRaises(build.BuildFailure): build.source_files("core", root)
                path.unlink(); path.write_bytes(b"source")
                self.assertEqual({name: build.sha256(path)}, build.source_files("core", root))
            with patch.object(build.subprocess, "check_output", return_value=b"wallet.json\0"):
                with self.assertRaises(build.BuildFailure): build.source_files("core", root)

    def test_failure_replaces_pass_even_if_expected_receipt_is_malformed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); output = root / "result.json"; output.write_text('{"status":"PASS"}')
            expected = root / "expected.json"; expected.write_text("invalid")
            args = SimpleNamespace(output=output, expected=expected)
            with self.assertRaises(ValueError): build.execute(args)
            self.assertEqual("FAIL", json.loads(output.read_text())["status"])

    def test_interrupted_build_cannot_remain_running(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            args = SimpleNamespace(output=root / "result.json", expected=None, core=root, node=root, express=root, work=root / "work")
            with patch.object(build, "source_files", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
                build.execute(args)
            self.assertEqual("FAIL", json.loads(args.output.read_text())["status"])

    def test_build_process_failure_is_reported_without_command_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(build.subprocess, "run", return_value=SimpleNamespace(returncode=1)):
                with self.assertRaisesRegex(build.BuildFailure, "private build log"):
                    build.run(["false"], root, root / "build.log", {})
            with patch.object(build.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
                build.run(["true"], root, root / "build.log", {})

    def test_cli_cannot_overwrite_the_expected_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); expected = root / "expected.json"; expected.write_text("reviewed")
            arguments = ["build", "--core", tmp, "--node", tmp, "--express", tmp, "--cache", tmp,
                         "--work", str(root / "work"), "--expected", str(expected), "--output", str(expected)]
            with patch.object(sys, "argv", arguments), self.assertRaises(SystemExit) as error:
                build.main()
            self.assertEqual(2, error.exception.code)
            self.assertEqual("reviewed", expected.read_text())

    def test_successful_commands_with_missing_runtime_files_still_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(build, "prepare"), patch.object(build, "run"), patch.object(build, "package_archives", return_value={"dependency": "pin"}):
                with self.assertRaisesRegex(build.BuildFailure, "runtime is incomplete"):
                    build.build_once(root, {}, {}, root / "patch", "dotnet", "10.0.400", root)

    def test_orchestrator_checks_both_builds_and_refuses_existing_directory(self):
        for mode in ("success", "drift", "existing", "pinned"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); result = {"runtime": {"Neo.dll": "hash"}, "archives": {"vm": "hash"}, "locks": {"lock": "hash"}}
                args = SimpleNamespace(core=root, node=root, express=root, cache=root, dotnet="dotnet", work=root / "work", output=root / "result.json", expected=None)
                if mode == "existing": args.work.mkdir()
                builds = [result, {**result, "runtime": {"Neo.dll": "changed"}} if mode == "drift" else result]
                with patch.object(build, "source_files", return_value={"source.cs": "pin"}), patch.object(build, "build_once", side_effect=builds), patch.object(build.subprocess, "check_output", return_value="fixed"):
                    if mode in ("drift", "existing"):
                        with self.assertRaises(build.BuildFailure): build.execute(args)
                    else: build.execute(args)
                self.assertEqual("FAIL" if mode in ("drift", "existing") else "PASS", json.loads(args.output.read_text())["status"])
                if mode == "pinned":
                    args.expected = args.output; args.output = root / "replay.json"; args.work = root / "replay"
                    with patch.object(build, "source_files", return_value={"source.cs": "pin"}), patch.object(build, "build_once", return_value=result), patch.object(build.subprocess, "check_output", return_value="fixed"):
                        build.execute(args)
                    self.assertEqual("PASS", json.loads(args.output.read_text())["status"])


if __name__ == "__main__": unittest.main()
