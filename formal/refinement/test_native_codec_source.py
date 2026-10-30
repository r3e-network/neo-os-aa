import copy
import json
from pathlib import Path
import tempfile
import unittest

import ledger_codec as codec
import native_codec_source as native


def walk(node):
    yield node
    for child in node['children']:
        yield from walk(child)


class NativeCodecSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.source = codec.source_evidence()['BinarySerializer']['source']
        path = Path(cls.directory.name)/'BinarySerializer.cs'
        path.write_text(cls.source)
        _, cls.inventory, cls.projection = native.export_inventory(path, Path(cls.directory.name)/'inventory.json')

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_actual_resolved_source_has_all_nodes_and_typed_boundaries(self):
        self.assertEqual(self.projection['operationCount'], 541)
        self.assertEqual(len(self.projection['resolvedExternalSymbols']),55)
        for kind in ('Array','Struct'):
            for tag in ('ByteString','Buffer'):
                for value in (0,1,127,128,255,256,(1<<63)-1,codec.LIMIT-1):
                    ledger = codec.Ledger(kind,bytes(range(32)),value,tag)
                    expected = codec.encode_ledger(ledger)
                    self.assertEqual(codec.source_serialize_ledger(self.projection,ledger),expected)
                    self.assertEqual(codec.source_deserialize_ledger(self.projection,expected+b'\xde\xad\xbe\xef'),(ledger,b'\xde\xad\xbe\xef'))

    def test_semantic_metadata_mutations_fail_closed(self):
        cases = ['extra-child','unknown-metadata','incomplete-collection','wrong-overload','wrong-dispatch','checked-arithmetic','big-endian-default','wrong-core-signature']
        for case in cases:
            altered = copy.deepcopy(self.inventory)
            nodes = [n for m in altered['methods'] for n in walk(m['operation'])]
            if case == 'extra-child':
                altered['methods'][0]['operation']['children'].append(copy.deepcopy(nodes[-1]))
            elif case == 'unknown-metadata':
                nodes[0]['metadata']['Unexpected.Semantics'] = True
            elif case == 'incomplete-collection':
                nodes[0]['metadata']['IBlockOperation.Operations']['complete'] = False
            elif case == 'wrong-overload':
                node = next(n for n in nodes if n['kind'] == 'Invocation')
                node['metadata']['IInvocationOperation.TargetMethod']['value']['id'] += '.Different'
            elif case == 'wrong-dispatch':
                node = next(n for n in nodes if n['kind'] == 'Invocation')
                node['metadata']['IInvocationOperation.IsVirtual'] = not node['metadata']['IInvocationOperation.IsVirtual']
            elif case == 'checked-arithmetic':
                node = next(n for n in nodes if n['kind'] == 'Binary')
                node['metadata']['IBinaryOperation.IsChecked'] = True
            elif case == 'big-endian-default':
                node = next(n for n in nodes if n['kind'] == 'ObjectCreation' and n['type'] == 'global::System.Numerics.BigInteger')
                default = node['children'][-1]['children'][0]
                default['constant']['value'] = True
            elif case == 'wrong-core-signature':
                altered['methods'][0]['symbol']['parameters'][0]['type'] = 'int'
            with self.subTest(case=case),self.assertRaises(codec.CodecError):
                native.project_inventory(altered)

    def test_unresolved_actual_csharp_is_not_exported(self):
        path = Path(self.directory.name)/'Unresolved.cs'
        path.write_text(self.source.replace('reader.ReadByte()', 'reader.NoSuchReadMethod()'))
        target = Path(self.directory.name)/'unresolved.json'
        with self.assertRaisesRegex(codec.CodecError,'Native Roslyn export failed'):
            native.export_inventory(path,target)
        self.assertFalse(target.exists())

    def test_typed_source_resource_and_outside_domain_faults(self):
        ledger = codec.Ledger('Array',bytes(32),128)
        raw = codec.encode_ledger(ledger)
        for limits in ({'max_items':2},{'max_size':31}):
            with self.assertRaises(codec.CodecError):
                codec.source_serialize_ledger(self.projection,ledger,**limits)
            with self.assertRaises(codec.CodecError):
                codec.source_deserialize_ledger(self.projection,raw,**limits)
        with self.assertRaises(codec.CodecError):
            codec.source_deserialize_ledger(self.projection,bytes([64,2,40,32])+bytes(32)+bytes([33,1,255]))


if __name__ == '__main__':
    unittest.main()
