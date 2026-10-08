"""Locked recipe input and fail-closed receipt controls."""
import json
import hashlib
import subprocess
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import build_native_modules as builder
from test_native_module_profile import manifest

class NativeBuildTests(unittest.TestCase):
    def test_linked_source_rejects_escape_and_symlink_alias(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve(); contracts=root/'contracts'; contracts.mkdir(); source=contracts/'module.cs'; source.write_text('class C {}')
            self.assertEqual(source,builder.checked_input(contracts,source))
            link=contracts/'alias.cs';link.symlink_to(source)
            for invalid in (link,root/'outside.cs'):
                with self.assertRaises(ValueError):builder.checked_input(contracts,invalid)

    def fixture(self, root):
        contracts = root / "contracts"; native = contracts / "native"; native.mkdir(parents=True)
        parameters = root / "docs/proposals/smartaccount-native-profile-v2-parameters.json"
        parameters.parent.mkdir(parents=True)
        parameters.write_bytes((Path(__file__).resolve().parents[1] / "docs/proposals/smartaccount-native-profile-v2-parameters.json").read_bytes())
        (root / "Directory.Build.props").write_text("<Project><PropertyGroup><NeoSmartContractFrameworkVersion>3.10.1</NeoSmartContractFrameworkVersion><RestorePackagesWithLockFile>true</RestorePackagesWithLockFile><RestoreLockedMode>true</RestoreLockedMode></PropertyGroup></Project>")
        (root / "nuget.config").write_text('<configuration><packageSources><clear/><add key="nuget.org" value="https://api.nuget.org/v3/index.json"/></packageSources></configuration>')
        (native / "profiles.json").write_text(json.dumps({"Verifier": {"project": "Verifier.Native.csproj", "role": "verifier", "configurationMethods": ["setConfig"], "compositeVerifier": False}}))
        project = '<Project><ItemGroup><Compile Include="../module.cs" /></ItemGroup></Project>'
        (native / "Verifier.Native.csproj").write_text(project)
        (native / "Second.Native.csproj").write_text(project)
        (contracts / "module.cs").write_text("class Module {}")
        return contracts

    def test_native_build_requires_committed_project_lock_before_compiler(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); contracts = self.fixture(root); receipt = root / "receipt.json"
            with patch.object(builder.subprocess, "check_output") as compiler:
                with self.assertRaisesRegex(ValueError, "lock"):
                    builder.build(contracts, root / "compiler", root / "cache", root / "output", receipt)
                compiler.assert_not_called()
            self.assertEqual("FAIL", json.loads(receipt.read_text())["status"])
            self.assertFalse((root / "output").exists())

    def test_input_inventory_pins_repository_policy_and_project_specific_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); contracts = self.fixture(root)
            lock = contracts / "native/packages.Verifier.Native.lock.json"; lock.write_text('{"version":1}')
            _, pins = builder.collect_inputs(contracts)
            self.assertEqual({"Directory.Build.props", "nuget.config", "contracts/native/profiles.json", "docs/proposals/smartaccount-native-profile-v2-parameters.json",
                              "contracts/native/Verifier.Native.csproj", "contracts/native/Second.Native.csproj", "contracts/module.cs",
                              "contracts/native/packages.Verifier.Native.lock.json"}, set(pins))
            lock.unlink(); lock.symlink_to(contracts / "module.cs")
            with self.assertRaises(ValueError): builder.collect_inputs(contracts)

    def test_relaxed_restore_policy_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); contracts = self.fixture(root)
            (contracts / "native/packages.Verifier.Native.lock.json").write_text('{"version":1}')
            policy = root / "Directory.Build.props"
            policy.write_text(policy.read_text().replace("<RestoreLockedMode>true", "<RestoreLockedMode>false"))
            with self.assertRaisesRegex(ValueError, "locked restore policy"):
                builder.collect_inputs(contracts)

    def compiler_fixture(self, root):
        contracts = self.fixture(root)
        (contracts / "native/packages.Verifier.Native.lock.json").write_text('{"version":1}')
        compiler = root / "compiler"; compiler.write_text("compiler launcher")
        cache = root / "cache"; archive = cache / "neo.smartcontract.framework/3.10.1/neo.smartcontract.framework.3.10.1.nupkg"
        archive.parent.mkdir(parents=True); archive.write_bytes(b"archive")
        return contracts, compiler, cache

    def test_both_private_builds_keep_policy_locks_and_native_source_preparation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); contracts, compiler, cache = self.compiler_fixture(root)
            calls = []
            def compile_project(command, **kwargs):
                scratch = kwargs["cwd"]; calls.append(scratch)
                self.assertEqual((root / "Directory.Build.props").read_bytes(), (scratch / "Directory.Build.props").read_bytes())
                self.assertEqual((root / "nuget.config").read_bytes(), (scratch / "nuget.config").read_bytes())
                self.assertNotIn("NuGet.Config", [p.name for p in scratch.iterdir()])
                self.assertEqual("true", kwargs["env"]["RestoreLockedMode"])
                self.assertEqual(str(cache), kwargs["env"]["NUGET_PACKAGES"])
                self.assertEqual('{"version":1}', (scratch / "contracts/native/packages.Verifier.Native.lock.json").read_text())
                self.assertEqual("#define SMARTACCOUNT_NATIVE\nclass Module {}", (scratch / "contracts/module.cs").read_text())
                raw = Path(command[-1]); value = manifest(); value["name"] = "Verifier"
                (raw / "Verifier.manifest.json").write_text(json.dumps(value))
                body = b'NEF3' + bytes(64) + bytes(5) + b'\x01\x40'
                (raw / "Verifier.nef").write_bytes(body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4])
                return subprocess.CompletedProcess(command, 0, "", "")
            with patch.object(builder.subprocess, "check_output", return_value="nccs test"), \
                 patch.object(builder.subprocess, "run", side_effect=compile_project), \
                 patch.dict(os.environ, {"RestoreLockedMode": "false"}):
                result = builder.build(contracts, compiler, cache, root / "output", root / "receipt.json")
            self.assertEqual("PASS", result["status"])
            self.assertEqual(2, len(calls)); self.assertNotEqual(calls[0], calls[1])
            self.assertEqual(result["builds"][0], result["builds"][1])
            self.assertEqual("class Module {}", (contracts / "module.cs").read_text())
            self.assertEqual(2, json.loads((root / "output/Verifier.manifest.json").read_text())["extra"]["smartAccount"]["abiVersion"])

    def test_compiler_lock_mutation_fails_without_publishing_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve(); contracts, compiler, cache = self.compiler_fixture(root)
            def rewrite_lock(command, **kwargs):
                (kwargs["cwd"] / "contracts/native/packages.Verifier.Native.lock.json").write_text("changed")
                return subprocess.CompletedProcess(command, 0, "", "")
            with patch.object(builder.subprocess, "check_output", return_value="nccs test"), \
                 patch.object(builder.subprocess, "run", side_effect=rewrite_lock):
                with self.assertRaisesRegex(ValueError, "pinned build input or lock"):
                    builder.build(contracts, compiler, cache, root / "output", root / "receipt.json")
            self.assertFalse((root / "output").exists())
            self.assertEqual("FAIL", json.loads((root / "receipt.json").read_text())["status"])
            self.assertEqual('{"version":1}', (contracts / "native/packages.Verifier.Native.lock.json").read_text())

    def test_failed_build_overwrites_old_success_and_never_invokes_compiler(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp).resolve(); contracts=root/'contracts'; (contracts/'native').mkdir(parents=True)
            (contracts/'native/profiles.json').write_text('{}'); receipt=root/'receipt.json';receipt.write_text('{"status":"PASS"}')
            with patch.object(builder.subprocess,'check_output') as compiler:
                with self.assertRaises(ValueError):builder.build(contracts,root/'compiler',root/'cache',root/'output',receipt)
                compiler.assert_not_called()
            self.assertEqual('FAIL',json.loads(receipt.read_text())['status'])

if __name__=='__main__':unittest.main()
