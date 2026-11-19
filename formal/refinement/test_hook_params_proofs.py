"""v4 hook argument view byte binding, and the retired certificate receipt."""
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
from formal.refinement import hook_params_source
import formal.refinement.export.test_export as export_tests


class HookParamsProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        export_tests.ExportTests.setUpClass()
        cls.inventory=export_tests.ExportTests().actual_inventory()

    def test_helper_region_and_opcodes_are_bound(self):
        bound=proofs.bind_method(self.inventory)
        raw=next(Path(name).read_bytes() for name in self.inventory['inputs'] if name.endswith('SmartAccount.nef'))
        again=proofs.bind_method(self.inventory)
        self.assertEqual(bound,again)
        self.assertGreater(bound['end']-bound['start'],0)
        self.assertGreater(bound['instructionCount'],0)
        self.assertEqual(len(bound['methodSha256']),64)
        self.assertEqual(bound['nefSha256'],proofs.sha(raw))
        self.assertTrue(set(bound['opcodes']) <= proofs.HELPER_OPCODES)
        self.assertIn(64,bound['opcodes'])  # RET closes the helper
        self.assertEqual(bound['projection']['viewFields'],list(hook_params_source.VIEW_FIELDS))
        self.assertEqual(bound['projection']['deepCopiedFields'],[3,12])

    def test_certificate_is_retired_for_the_v4_view(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError) as raised:
                proofs.run_proofs(self.inventory,directory)
            self.assertFalse(any(Path(directory).iterdir()))
        message=str(raised.exception)
        self.assertIn('BuildHookOperationParams',message)
        self.assertIn('BuildCanonicalOperationView',message)

    def test_nef_identity_and_decode_use_same_read(self):
        path=next(Path(n) for n in self.inventory['inputs'] if n.endswith('SmartAccount.nef'))
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
