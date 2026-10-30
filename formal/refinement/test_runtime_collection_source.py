import unittest
import runtime_collection_source as source

class CollectionSourceTests(unittest.TestCase):
    def test_actual_guard_and_alias_operations_retained(self):
        inventory=source.extract()
        self.assertEqual(inventory['programs']['PICKITEM']['upperComparison'],'>=')
        self.assertEqual(inventory['programs']['SETITEM']['indexOffset'],0)
        self.assertTrue(inventory['programs']['SETITEM']['cloneStructBeforeKeyPop'])
    def test_source_semantic_mutation_changes_ir(self):
        text=source.capture_sources()['JumpTable/JumpTable.Compound.cs']
        changed=text.replace('array[(int)index]','array[(int)index + 1]',1)
        self.assertEqual(source.parse_collection(changed,'PickItem')['indexOffset'],1)
    def test_unknown_effect_rejects(self):
        text=source.capture_sources()['JumpTable/JumpTable.Compound.cs']
        changed=text.replace('engine.Push(array[(int)index]);','engine.Reset(); engine.Push(array[(int)index]);',1)
        with self.assertRaises(ValueError): source.parse_collection(changed,'PickItem')
    def test_counted_pop_order(self):
        program=source.extract()['programs']['PACK']
        self.assertEqual((program['loopStart'],program['loopComparison'],program['loopStep']),(0,'<',1))
        self.assertEqual(program['allocationType'],'VMArray')



class ApiSourceTests(unittest.TestCase):
 def test_extra_converter_effect_rejects(self):
  text=source.capture_sources()['Types/PrimitiveType.cs']
  changed=text.replace('if (type == Type) return this;','UnknownEffect(); if (type == Type) return this;',1)
  with self.assertRaises(ValueError):source.parse_primitive_buffer_api(changed)
 def test_converter_slice_is_data(self):
  text=source.capture_sources()['Types/PrimitiveType.cs']
  changed=text.replace('new Buffer(GetSpan())','new Buffer(GetSpan().Slice(1))',1)
  self.assertEqual(source.parse_primitive_buffer_api(changed)['spanDrop'],1)

if __name__=='__main__':unittest.main()
