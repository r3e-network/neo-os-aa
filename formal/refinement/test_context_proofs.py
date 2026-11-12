"""Portable acceptance checks for initialization and complete helper context."""
import copy
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import subprocess
import sys

import context_proofs as context
from test_method_proofs import load_inventory, materialize_nef_fixture

ROOT = Path(__file__).resolve().parents[2]

class ContextProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inventory = load_inventory()
        cls.directory = tempfile.TemporaryDirectory(prefix='aa-context-fixture-')
        cls.addClassCleanup(cls.directory.cleanup)
        nef = materialize_nef_fixture(cls.inventory, cls.directory.name)
        cls.inventory['inputs'] = {str(nef):cls.inventory['nef']['sha256']}
        # Portable ABI-only test container, with its own explicit digest.
        manifest = Path(cls.directory.name) / 'SmartAccountV3.manifest.json'
        raw = json.dumps({'abi': {'methods': cls.inventory['manifest']['methods']}}, sort_keys=True).encode()
        manifest.write_bytes(raw)
        cls.inventory['manifest']['sha256'] = hashlib.sha256(raw).hexdigest()
        cls.inventory['inputs'][str(manifest)] = cls.inventory['manifest']['sha256']
        cls.program = context.bind_initializer(cls.inventory)

    def test_full_initializer_identity(self):
        self.assertEqual((self.program['start'],self.program['end']), (29415,30097))
        self.assertEqual(len(self.program['bytes']),682)
        self.assertEqual(len(self.program['instructions']),182)

    def test_wrong_entry_descriptor_rejected(self):
        changed=copy.deepcopy(self.inventory)
        next(m for m in changed['manifest']['methods'] if m['name']=='_initialize')['offset']+=2
        with self.assertRaises(ValueError): context.bind_initializer(changed)

    def test_missing_static_descriptor_rejected(self):
        changed=copy.deepcopy(self.inventory)
        changed['sourceMap']['debug']['static-variables'].remove('Prefix_TransactionReimbursement,ByteArray,38')
        with self.assertRaises(ValueError): context.bind_initializer(changed)

    def test_forged_initializer_bytes_rejected(self):
        changed=copy.deepcopy(self.inventory)
        code=bytearray.fromhex(changed['nef']['scriptHex'])
        code[29899]=34
        changed['nef']['scriptHex']=code.hex()
        with self.assertRaises(ValueError): context.bind_initializer(changed)

    def test_duplicate_initializer_rejected(self):
        changed=copy.deepcopy(self.inventory)
        changed['manifest']['methods'].append(copy.deepcopy(next(m for m in changed['manifest']['methods'] if m['name']=='_initialize')))
        with self.assertRaises(ValueError): context.bind_initializer(changed)

    def test_initializer_binding_hashes_and_decodes_one_nef_snapshot(self):
        nef=Path(next(iter(self.inventory['inputs'])))
        original=nef.read_bytes()
        changed=bytearray(original)
        changed[4]^=1  # Different compiler text, same valid script and tokens.
        changed[-4:]=hashlib.sha256(hashlib.sha256(changed[:-4]).digest()).digest()[:4]
        real_read=Path.read_bytes
        reads=[]
        def read_snapshot(path):
            if path == nef:
                reads.append(path)
                return original if len(reads)==1 else bytes(changed)
            return real_read(path)
        with mock.patch.object(Path,'read_bytes',read_snapshot):
            bound = context.bind_initializer(self.inventory)
        self.assertEqual(bound['nefSha256'], self.inventory['nef']['sha256'])
        self.assertEqual(len(reads),1)

    def test_cli_failure_replaces_stale_success(self):
        with tempfile.TemporaryDirectory(prefix='aa-context-fail-') as temporary:
            directory=Path(temporary)
            receipt=directory/'receipt.json'
            receipt.write_text('{"status":"PASS","kernelChecked":true}')
            result=subprocess.run([sys.executable,str(Path(context.__file__)), '--inventory',str(directory/'missing.json'),
                '--output-dir',str(directory/'proof'), '--json-report',str(receipt)],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            fail=json.loads(receipt.read_text())
            self.assertEqual(fail['status'],'FAIL')
            self.assertFalse(fail['initializerReferenceVerified'])

    def test_kernel_and_semantic_controls(self):
        with tempfile.TemporaryDirectory(prefix='aa-context-proof-') as output:
            receipt=context.run_proofs(self.inventory, output, controls=True)
            self.assertTrue(receipt['initializerReferenceVerified'])
            self.assertFalse(receipt['fullImplementationVerified'])
            self.assertEqual(len(receipt['semanticControls']),3)
            self.assertEqual(receipt['closedAssumptionCount'],sum(map(len,receipt['assumptionDeclarations'].values())))

    def test_complete_context_kernel_certificate(self):
        with tempfile.TemporaryDirectory(prefix='aa-complete-context-proof-') as output:
            receipt=context.run_complete_proofs(self.inventory,output,controls=True)
            self.assertTrue(receipt['initializerReferenceVerified'])
            self.assertTrue(receipt['helperContextVerified'])
            self.assertFalse(receipt['fullImplementationVerified'])
            self.assertEqual(receipt['methodRange'],[17762,18043])
            self.assertEqual((receipt['methodByteCount'],receipt['methodInstructionCount']),(281,116))
            self.assertEqual(len(receipt['semanticControls']),6)
            self.assertTrue(all(c['refutationKernelChecked'] for c in receipt['semanticControls'][3:]))
            self.assertEqual(receipt['closedAssumptionCount'],sum(map(len,receipt['assumptionDeclarations'].values())))
            self.assertTrue(set(context.CONTEXT_THEOREM_NAMES)<=set(receipt['theoremNames']))

if __name__=='__main__': unittest.main()
