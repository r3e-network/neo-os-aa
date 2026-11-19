"""Exact public pure-method kernel and fail-closed receipt controls."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
# `formal` is a namespace package, so the package-relative imports below need the
# repository root on sys.path. Discovery run from inside this directory puts only
# this directory there, which used to turn these modules into import errors.
if str(Path(__file__).resolve().parents[2]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from formal.refinement import public_pure_proofs as proofs
import formal.refinement.export.test_export as export_tests


class PublicPureProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        export_tests.ExportTests.setUpClass()
        cls.inventory = export_tests.ExportTests().actual_inventory()

    def test_actual_public_methods_kernel_and_semantic_controls(self):
        with tempfile.TemporaryDirectory() as directory:
            result = proofs.run_proofs(self.inventory, directory)
            self.assertTrue(result['kernelChecked'])
            self.assertFalse(result['fullImplementationVerified'])
            self.assertFalse(result['vmCorrespondenceProven'])
            self.assertEqual(set(result['referenceVerifiedEntrypoints']),
                             {'getAccountImplementationId', 'supportsExecutionMode', 'supportsModuleType'})
            self.assertGreaterEqual(len(result['semanticControls']), 4)
            self.assertTrue(all(c['definitionsAccepted'] and c['proofRejected'] for c in result['semanticControls']))
            declared = set(result['closedDeclarations']['PublicPureArtifact'])
            for name in result['referenceVerifiedEntrypoints']:
                for suffix in ['execution_classified', 'source_domain', 'source_refinement',
                               'source_halts_preserves_frame', 'no_timeout']:
                    self.assertIn(name+'_'+suffix, declared)
                if result['methods'][name]['source']['parameters']:
                    for suffix in ['oversized_fault_preserves_frame', 'missing_argument_fault',
                                   'non_string_returns_false']:
                        self.assertIn(name+'_'+suffix, declared)
            self.assertEqual(result['fullUnprovedEntrypointCount'], 109)

    def test_actual_manifest_drift_is_rejected(self):
        changed = copy.deepcopy(self.inventory)
        next(m for m in changed['manifest']['methods'] if m['name'] == 'supportsExecutionMode')['offset'] += 1
        with self.assertRaisesRegex(ValueError, 'manifest'): proofs.bind_methods(changed)

    def test_nef_hash_and_decoding_share_one_immutable_read(self):
        nef_path = next(Path(name) for name in self.inventory['inputs'] if name.endswith('SmartAccount.nef'))
        original_read = Path.read_bytes
        original = original_read(nef_path)
        changed = bytearray(original)
        changed[4] ^= 1  # legal compiler metadata change; script stays identical
        changed[-4:] = hashlib.sha256(hashlib.sha256(changed[:-4]).digest()).digest()[:4]
        alternations = []
        def alternate(path):
            if path == nef_path:
                alternations.append(1)
                return original if len(alternations) % 2 else bytes(changed)
            return original_read(path)
        with patch.object(Path, 'read_bytes', alternate):
            bound = proofs.bind_methods(self.inventory)
        self.assertEqual(bound['nefSha256'], hashlib.sha256(original).hexdigest())
        self.assertEqual(len(alternations), 1, 'Hash and decode must use one captured NEF payload')

    def test_nonempty_output_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'old-success').write_text('keep')
            with self.assertRaisesRegex(ValueError, 'new or empty'): proofs.run_proofs(self.inventory, directory)
            self.assertEqual(Path(directory, 'old-success').read_text(), 'keep')



class PublicPureCliFailureTests(unittest.TestCase):
    def test_failed_cli_overwrites_stale_success_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory, 'receipt.json'); report.write_text('{"kernelChecked": true}')
            result = subprocess.run([sys.executable, str(Path(proofs.__file__)),
                                     '--inventory', str(Path(directory, 'missing.json')),
                                     '--output-dir', str(Path(directory, 'proofs')),
                                     '--json-report', str(report)], capture_output=True, text=True, timeout=20)
            self.assertNotEqual(result.returncode, 0)
            receipt = json.loads(report.read_text())
            self.assertIs(receipt['kernelChecked'], False)
            self.assertEqual(receipt['referenceVerifiedEntrypoints'], [])
