import copy
import unittest
import runtime_source as source
import runtime_bridge_proofs as bridge

class RuntimeBridgeTests(unittest.TestCase):
    def test_lower_actual_all_handlers(self):
        inventory=source.extract_runtime()
        programs=bridge.lower_inventory(inventory)
        self.assertEqual(set(programs),set(source.HANDLERS))
        self.assertIn('CheckedInt32',programs['JMP'])
        self.assertIn('SetSlot',programs['STLOC0'])
    def test_source_semantic_mutant_changes_program(self):
        inventory=source.extract_runtime(); changed=copy.deepcopy(inventory)
        changed['handlers']['SUB']['body'][2]['expression']['arguments'][0]['operator']='+'
        self.assertNotEqual(bridge.lower_inventory(inventory)['SUB'],bridge.lower_inventory(changed)['SUB'])
    def test_unknown_lowering_rejected(self):
        inventory=source.extract_runtime()
        inventory['handlers']['ADD']['body'].append({'kind':'while'})
        with self.assertRaises(ValueError): bridge.lower_inventory(inventory)


class KernelTests(unittest.TestCase):
    def test_kernel_and_actual_source_semantic_controls(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory(prefix='sa-runtime-bridge-test-') as temporary:
            receipt=bridge.run(Path(temporary),Path(temporary)/'receipt.json')
            self.assertTrue(receipt['kernelChecked'])
            self.assertEqual(set(receipt['provenOpcodes']),set(source.HANDLERS))
            self.assertEqual(len(receipt['semanticControls']),8)
            self.assertTrue(all(c['sourceDefinitionCompiled'] and c['kernelCounterexampleChecked'] and c['correspondenceRejected'] for c in receipt['semanticControls']))
            self.assertFalse(receipt['runtimeImplementationProven'])


class ReceiptIntegrityTests(unittest.TestCase):
    def test_bad_source_cache_revokes_stale_success(self):
        import json,tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);cache=root/'cache';bad=cache/'JumpTable/JumpTable.Numeric.cs'
            bad.parent.mkdir(parents=True);bad.write_bytes(b'bad source')
            report=root/'receipt.json';report.write_text('{"kernelChecked":true}')
            with self.assertRaises(ValueError):bridge.run(root/'out',report,cache)
            self.assertFalse(json.loads(report.read_text())['kernelChecked'])
    def test_missing_source_revokes_stale_success(self):
        import json,tempfile
        from pathlib import Path
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);report=root/'receipt.json';report.write_text('{"kernelChecked":true}')
            with patch.object(source.urllib.request,'urlopen',side_effect=OSError('missing pinned source')):
                with self.assertRaises(OSError):bridge.run(root/'out',report,root/'missing')
            self.assertFalse(json.loads(report.read_text())['productionSourceBound'])
    def test_existing_output_rejects_and_preserves_files(self):
        import json,tempfile
        from pathlib import Path
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);out=root/'out';out.mkdir();(out/'preserved').write_text('keep')
            report=root/'receipt.json';report.write_text('{"kernelChecked":true}')
            with patch.object(source,'extract_runtime',side_effect=ValueError('must reject earlier')):
                with self.assertRaises(ValueError):bridge.run(out,report)
            self.assertFalse(json.loads(report.read_text())['kernelChecked'])
            self.assertEqual((out/'preserved').read_text(),'keep')

if __name__ == "__main__": unittest.main()
