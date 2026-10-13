"""Actual artifact inventory and fail-closed controls; no semantic proof claims."""
import hashlib
import json
from pathlib import Path
import subprocess
import shutil
import tempfile
import time
import uuid
import unittest

ROOT = Path(__file__).resolve().parents[3]
PROJECT = Path(__file__).with_name('RefinementExport.csproj')
COMPILER = Path.home() / '.dotnet/tools/.store/neo.compiler.csharp/3.9.1/neo.compiler.csharp/3.9.1/tools/net10.0/any'
NEF = ROOT / 'contracts/bin/v3/UnifiedSmartWalletV3.nef'
MANIFEST = NEF.with_suffix('.manifest.json')


class ExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        build = subprocess.run(['dotnet', 'build', str(PROJECT), '--nologo',
                                '-p:CompilerToolDirectory=' + str(COMPILER)],
                               capture_output=True, text=True, timeout=90)
        if build.returncode:
            raise AssertionError(build.stdout + build.stderr)
        cls.command = ['dotnet', str(PROJECT.parent / 'bin/Debug/net10.0/RefinementExport.dll'),
                       '--compiler-tool-dir', str(COMPILER),
                       '--source-root', str(ROOT), '--project',
                       str(ROOT / 'contracts/UnifiedSmartWallet.csproj'),
                       '--nef', str(NEF), '--manifest', str(MANIFEST)]

    def test_actual_candidate_complete_inventory(self):
        result = subprocess.run(self.command, capture_output=True, text=True, timeout=240)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout[-2000:])
        report = json.loads(result.stdout)
        self.assertEqual(report['schema'], 'neoos-aa-refinement-inventory/v1')
        self.assertEqual(report['status'], 'INVENTORY_ONLY')
        self.assertEqual(report['nef']['sha256'], hashlib.sha256(NEF.read_bytes()).hexdigest())
        self.assertEqual(report['manifest']['methods'], json.loads(MANIFEST.read_text())['abi']['methods'])
        instructions = report['nef']['instructions']
        self.assertEqual(sum(i['size'] for i in instructions), len(bytes.fromhex(report['nef']['scriptHex'])))
        self.assertEqual(sum(report['nef']['opcodeCounts'].values()), len(instructions))
        self.assertTrue(report['sourceMap']['exactByteMatch'])
        self.assertTrue(report['sourceMap']['exactManifestMatch'])
        for document in report['sourceMap']['documentInputs']:
            self.assertEqual(document['sha256'], hashlib.sha256(Path(document['path']).read_bytes()).hexdigest())
        methods = report['source']['methods']
        self.assertTrue(any('CapReimbursementToActualCost' in m['displayName'] for m in methods))
        self.assertTrue(any('CapReimbursementToActualCost' in m['id'] for m in report['sourceMap']['focusedMethods']))
        self.assertTrue(report['source']['unsupportedOperations'])
        self.assertTrue(report['proofObligations'])

    def test_bad_checksum_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            bad = Path(temp) / 'bad.nef'
            data = bytearray(NEF.read_bytes()); data[-1] ^= 1; bad.write_bytes(data)
            command = list(self.command); command[command.index('--nef') + 1] = str(bad)
            result = subprocess.run(command, capture_output=True, text=True, timeout=60)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('checksum', result.stderr.lower())

    def test_bad_abi_offset_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            bad = Path(temp) / 'bad.manifest.json'
            data = json.loads(MANIFEST.read_text()); data['abi']['methods'][0]['offset'] = 999999
            bad.write_text(json.dumps(data))
            command = list(self.command); command[command.index('--manifest') + 1] = str(bad)
            result = subprocess.run(command, capture_output=True, text=True, timeout=60)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('abi', result.stderr.lower())

    def test_legal_changed_manifest_is_not_bound_to_source(self):
        with tempfile.TemporaryDirectory() as temp:
            bad = Path(temp) / 'different.manifest.json'
            data = json.loads(MANIFEST.read_text())
            data['abi']['methods'][0]['safe'] = not data['abi']['methods'][0]['safe']
            bad.write_text(json.dumps(data))
            command = list(self.command); command[command.index('--manifest') + 1] = str(bad)
            result = subprocess.run(command, capture_output=True, text=True, timeout=120)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('source/manifest pair mismatch', result.stderr.lower())

    def test_legal_changed_source_is_not_bound_to_candidate(self):
        with tempfile.TemporaryDirectory() as temp:
            mirror = Path(temp)
            shutil.copytree(ROOT / 'contracts', mirror / 'contracts',
                            ignore=shutil.ignore_patterns('bin', 'obj', 'build'))
            for name in ['Directory.Build.props', 'nuget.config']:
                shutil.copy2(ROOT / name, mirror / name)
            changed = mirror / 'contracts/UnifiedSmartWallet.Paymaster.cs'
            source = changed.read_text()
            old = 'BigInteger cap = BigInteger.Max(actualCost - budget.Reserved, 0) + estimationFlag * requested;'
            self.assertIn(old, source)
            changed.write_text(source.replace(old, old.replace(' + estimationFlag', ' - estimationFlag')))
            command = list(self.command)
            command[command.index('--source-root') + 1] = str(mirror)
            command[command.index('--project') + 1] = str(mirror / 'contracts/UnifiedSmartWallet.csproj')
            result = subprocess.run(command, capture_output=True, text=True, timeout=120)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('source/nef pair mismatch', result.stderr.lower())

    def test_source_changed_after_snapshot_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            mirror = Path(temp)
            shutil.copytree(ROOT / 'contracts', mirror / 'contracts',
                            ignore=shutil.ignore_patterns('bin', 'obj', 'build'))
            for name in ['Directory.Build.props', 'nuget.config']:
                shutil.copy2(ROOT / name, mirror / name)
            original = mirror / 'contracts/UnifiedSmartWallet.Paymaster.cs'
            marker = '// race-control-' + uuid.uuid4().hex
            original.write_text(original.read_text() + '\n' + marker + '\n')
            command = list(self.command)
            command[command.index('--source-root') + 1] = str(mirror)
            command[command.index('--project') + 1] = str(mirror / 'contracts/UnifiedSmartWallet.csproj')
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 30
            changed = False
            while time.monotonic() < deadline and process.poll() is None:
                for scratch in Path(tempfile.gettempdir()).glob('aa-refinement-export-*/contracts/UnifiedSmartWallet.Paymaster.cs'):
                    try:
                        if marker in scratch.read_text():
                            original.write_text(original.read_text() + '// changed after snapshot\n')
                            changed = True
                            break
                    except FileNotFoundError:
                        continue
                if changed:
                    break
                time.sleep(0.01)
            stdout, stderr = process.communicate(timeout=120)
            self.assertTrue(changed, 'Exporter scratch source was not observed')
            self.assertNotEqual(process.returncode, 0, stdout[-500:])
            self.assertTrue('input changed' in stderr.lower() or 'typed tree differs' in stderr.lower(), stderr)


if __name__ == '__main__':
    unittest.main()
