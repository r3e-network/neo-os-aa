"""Private hook helper exact-byte certificates and input identity controls."""
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
from formal.refinement import hook_params_proofs as proofs
import formal.refinement.export.test_export as export_tests


class HookParamsProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        export_tests.ExportTests.setUpClass()
        cls.inventory=export_tests.ExportTests().actual_inventory()

    def test_complete_hook_kernel_alias_frame_and_controls(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt=proofs.run_proofs(self.inventory,directory)
            self.assertTrue(receipt['kernelChecked'])
            self.assertFalse(receipt['fullImplementationVerified'])
            self.assertFalse(receipt['vmCorrespondenceProven'])
            self.assertEqual(receipt['methodRange'],[15136,15160])
            self.assertEqual((receipt['byteCount'],receipt['instructionCount']),(24,21))
            self.assertEqual(receipt['fullUnprovedEntrypointCount'],109)
            self.assertGreaterEqual(len(receipt['semanticControls']),4)
            self.assertTrue(all(c['definitionsAccepted'] and c['proofRejected'] for c in receipt['semanticControls']))
            self.assertIn('complete_hook_reference_refinement',receipt['closedDeclarations']['HookArtifact'])
            self.assertTrue({'source_hook_complete','vm_hook_complete','hook_existing_heap_and_frame',
                             'hook_null_operation_fault','hook_missing_arguments_fault','hook_short_record_fault',
                             'hook_dangling_operation_fault','hook_success_has_no_timeout'} <=
                            set(receipt['closedDeclarations']['HookArtifact']))
            self.assertIn('tuple_argument_alias_unchanged',receipt['closedDeclarations']['HookParams'])
            self.assertEqual(receipt['sourceTreeSha256'],proofs.sha(json.dumps(self.inventory['source'],sort_keys=True,separators=(',',':')).encode()))

    def test_nef_identity_and_decode_use_same_read(self):
        path=next(Path(n) for n in self.inventory['inputs'] if n.endswith('SmartAccountV3.nef'))
        original_read=Path.read_bytes;original=original_read(path);changed=bytearray(original);changed[4]^=1
        changed[-4:]=hashlib.sha256(hashlib.sha256(changed[:-4]).digest()).digest()[:4]
        reads=[]
        def alternate(p):
            if p==path:
                reads.append(1);return original if len(reads)%2 else bytes(changed)
            return original_read(p)
        with patch.object(Path,'read_bytes',alternate):receipt=proofs.bind_method(self.inventory)
        self.assertEqual(receipt['nefSha256'],hashlib.sha256(original).hexdigest())
        self.assertEqual(len(reads),1)


class HookFailureReceiptTests(unittest.TestCase):
    def test_failure_overwrites_old_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            report=Path(directory,'receipt.json');report.write_text('{"kernelChecked":true}')
            result=subprocess.run([sys.executable,str(Path(proofs.__file__)),'--inventory',str(Path(directory,'missing.json')),
                                   '--output-dir',str(Path(directory,'proofs')),'--json-report',str(report)],
                                  capture_output=True,text=True,timeout=20)
            self.assertNotEqual(result.returncode,0)
            self.assertIs(json.loads(report.read_text())['kernelChecked'],False)
