import unittest
import runtime_collection_source as source
import runtime_collection_proofs as proof

class LoweringTests(unittest.TestCase):
 def test_source_programs_lower_as_data(self):
  lowered=proof.lower(source.extract())
  self.assertIn('ArrayGet',lowered['PICKITEM'])
  self.assertIn('CountedPack',lowered['PACK'])
  self.assertIn('EntryInitSlots',lowered['INITSLOT'])
 def test_semantic_index_change_survives_lowering(self):
  p=source.parse_collection(source.capture_sources()['JumpTable/JumpTable.Compound.cs'].replace('array[(int)index]','array[(int)index + 1]',1),'PickItem')
  self.assertIn(' 1)',proof.lower_program(p))



class ReceiptTests(unittest.TestCase):
 def test_bad_cache_overwrites_stale_success(self):
  import json,tempfile
  from pathlib import Path
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);cache=root/'cache';bad=cache/'JumpTable/JumpTable.Compound.cs';bad.parent.mkdir(parents=True);bad.write_bytes(b'wrong source')
   report=root/'receipt.json';report.write_text('{"kernelChecked":true}')
   with self.assertRaises(ValueError):proof.run(root/'out',report,cache)
   self.assertFalse(json.loads(report.read_text())['kernelChecked'])
 def test_missing_source_failure_overwrites_stale_success(self):
  import json,tempfile
  from pathlib import Path
  from unittest.mock import patch
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);report=root/'receipt.json';report.write_text('{"kernelChecked":true}')
   with patch.object(source.urllib.request,'urlopen',side_effect=OSError('missing fixed source')):
    with self.assertRaises(OSError):proof.run(root/'out',report,root/'missing')
   self.assertFalse(json.loads(report.read_text())['productionSourceBound'])
 def test_nonempty_output_rejects_and_revokes_receipt(self):
  import json,tempfile
  from pathlib import Path
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);out=root/'out';out.mkdir();(out/'existing').write_text('preserve')
   report=root/'receipt.json';report.write_text('{"kernelChecked":true}')
   with self.assertRaises(ValueError):proof.run(out,report)
   self.assertFalse(json.loads(report.read_text())['kernelChecked'])
   self.assertEqual((out/'existing').read_text(),'preserve')


class KernelIntegrationTests(unittest.TestCase):
 def test_fresh_kernel_and_real_source_controls(self):
  import tempfile
  from pathlib import Path
  with tempfile.TemporaryDirectory(prefix='sa-collection-kernel-') as directory:
   out=Path(directory)
   report=proof.run(out,out/'receipt.json')
   self.assertTrue(report['kernelChecked'])
   self.assertEqual(len(report['provenOpcodes']),13)
   self.assertEqual(set(report['supportingProjections']),{'RET','SIZE','ISTYPE','CONVERT'})
   self.assertEqual(len(report['semanticControls']),9)
   self.assertTrue(all(c['sourceDefinitionCompiled'] and c['kernelCounterexampleChecked'] and c['correspondenceRejected'] for c in report['semanticControls']))
   self.assertFalse(report['fullImplementationVerified'])

if __name__ == "__main__":unittest.main()
