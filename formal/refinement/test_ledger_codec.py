import unittest
import hashlib
import json
from pathlib import Path
import tempfile
from unittest.mock import patch

import ledger_codec as codec
import codec_proofs as proofs


class LedgerCodecTests(unittest.TestCase):
    def test_native_snapshot_is_shared_by_hash_join_certificate_and_staging(self):
        # Synthetic runner fixture, never reported as actual runtime evidence.
        receipt = {'runtime': {
            'neo': dict(fullName='Neo, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null', informationalVersion='3.10.1+'+codec.NEO_COMMIT, sha256='cb1b4db8076847dc23fda920ded773adaeeda07895effd350d2d8a99595a7f3a'),
            'vm': dict(fullName='Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null', informationalVersion='3.10.1+'+codec.VM_COMMIT, sha256='cea00a147add3c672bb23ffb5d98a4b1f31da135272efc258fee8fb7805bbfe9'),
            'neoSourceCommit': codec.NEO_COMMIT, 'vmSourceCommit': codec.VM_COMMIT}, 'vectors': []}
        for kind in ('Array', 'Struct'):
            for value in (0, 1, 127, 128, (1 << 63)-1, codec.LIMIT-1):
                receipt['vectors'].append(dict(shape=kind, number=str(value), wire=codec.encode_ledger(codec.Ledger(kind, bytes(32), value)).hex()))
        receipt['vectors'].extend(dict(input=wire, canonical=canon) for wire, canon in [('2100','2100'), ('210100','2100'), ('21020700','210107')])
        wire = receipt['vectors'][0]['wire']
        receipt['vectors'].extend(dict(name='synthetic-'+str(i), input=wire, canonical=wire) for i in range(9))
        raw_a = (json.dumps(receipt) + '\n').encode()
        changed = json.loads(raw_a)
        changed['vectors'][0]['wire'] = '41' + changed['vectors'][0]['wire'][2:]
        raw_b = (json.dumps(changed) + '\n').encode()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'native.json'
            path.write_bytes(raw_a)
            snapshot = proofs.snapshot_input(path)
            joined = proofs.native_join(snapshot)
            path.write_bytes(raw_b)
            with patch.object(Path, 'read_bytes', side_effect=AssertionError('Snapshot consumer re-read path')), patch.object(Path, 'read_text', side_effect=AssertionError('Snapshot consumer re-read path')):
                certificate, names = proofs.native_certificate(snapshot)
                staged = Path(directory) / 'staged.json'
                proofs.stage_snapshot(snapshot, staged)
            path.write_bytes(raw_a)
            self.assertEqual(joined['sha256'], hashlib.sha256(raw_a).hexdigest())
            self.assertEqual(staged.read_bytes(), raw_a)
            self.assertEqual(len(names), len(receipt['vectors']))
            self.assertIn('= [64%nat;2%nat;', certificate)
            self.assertEqual(proofs.digest(path), joined['sha256'])

    def test_coq_snapshot_read_once_and_exact_bytes_staged(self):
        with tempfile.TemporaryDirectory() as directory:
            path, staged = Path(directory) / 'Input.v', Path(directory) / 'Staged.v'
            raw_a, raw_b = b'Definition result := 1.\r\n', b'Definition result := 2.\n'
            with patch.object(Path, 'read_bytes', side_effect=[raw_a, raw_b]) as reader:
                snapshot = proofs.snapshot_input(path)
                self.assertEqual(snapshot.sha256, hashlib.sha256(raw_a).hexdigest())
                self.assertEqual(snapshot.text, raw_a.decode())
                proofs.stage_snapshot(snapshot, staged)
                self.assertEqual(reader.call_count, 1)
            self.assertEqual(staged.read_bytes(), raw_a)

    def test_actual_source_ast_executes_loops_stacks_tags_and_suffix(self):
        projection = codec.project_codec_source(codec.source_evidence()['BinarySerializer']['source'])
        self.assertEqual(set(projection['methods']), {'serialize', 'deserialize'})
        for kind in ('Array', 'Struct'):
            for hash_kind in ('ByteString', 'Buffer'):
                for number in (0, 1, 127, 128, 255, 256, (1 << 63)-1, codec.LIMIT-1):
                    ledger = codec.Ledger(kind, bytes(range(32)), number, hash_kind)
                    raw = codec.source_serialize_ledger(projection, ledger, max_items=3)
                    self.assertEqual(raw, codec.encode_ledger(ledger))
                    self.assertEqual(codec.source_deserialize_ledger(projection, raw+b'\xde\xad\xbe\xef', max_items=3), (ledger, b'\xde\xad\xbe\xef'))
        padded = b'\x41\xff\x02'+bytes(7)+b'\x30\xfd\x20\0'+bytes(32)+b'\x21\xfd\x02\0\x07\0'
        self.assertEqual(codec.source_deserialize_ledger(projection, padded), (codec.Ledger('Struct', bytes(32), 7, 'Buffer'), b''))

    def test_actual_source_ast_mutations_have_causal_effect(self):
        source = codec.source_evidence()['BinarySerializer']['source']
        ledger = codec.Ledger('Struct', bytes(range(32)), 128, 'Buffer')
        raw = codec.encode_ledger(ledger)
        reversed_source = source.replace('for (int i = array.Count - 1; i >= 0; i--)', 'for (int i = 0; i < array.Count; i++)')
        changed = codec.project_codec_source(reversed_source)
        self.assertNotEqual(codec.source_serialize_ledger(changed, ledger), raw)
        for old, new, operation in [
            ('if (--maxItems < 0)', 'if (--maxItems < 1)', 'serialize'),
            ('undeserialized += count;', 'undeserialized += count * 2;', 'deserialize'),
            ('if (deserialized.Count > maxItems)', 'if (deserialized.Count >= maxItems)', 'deserialize')]:
            changed = codec.project_codec_source(source.replace(old, new))
            with self.subTest(mutation=old), self.assertRaises(codec.CodecError):
                if operation == 'serialize':
                    codec.source_serialize_ledger(changed, ledger, max_items=3)
                else:
                    codec.source_deserialize_ledger(changed, raw, max_items=3)
        changed = codec.project_codec_source(source.replace('Struct @struct = new();', 'Array @struct = new();'))
        self.assertEqual(codec.source_deserialize_ledger(changed, raw)[0].kind, 'Array')

    def test_actual_source_ast_rejects_unconsumed_or_unknown_syntax(self):
        stream = codec.method_tokens(codec.source_evidence()['BinarySerializer']['source'], codec.SERIALIZE_SIGNATURE)
        with self.assertRaises(codec.CodecError):
            codec.CodecSourceParser(stream+['unknown']).program()
        with self.assertRaises(codec.CodecError):
            codec.CodecSourceParser(['{','goto','label',';','}']).program()

    def test_actual_source_ast_domain_resource_and_truncation_faults(self):
        projection = codec.project_codec_source(codec.source_evidence()['BinarySerializer']['source'])
        ledger = codec.Ledger('Array', bytes(32), 128)
        raw = codec.encode_ledger(ledger)
        for end in range(len(raw)):
            with self.subTest(end=end), self.assertRaises(codec.CodecError):
                codec.source_deserialize_ledger(projection, raw[:end])
        for operation in ('serialize', 'deserialize'):
            for kwargs in ({'max_items': 2}, {'max_size': 31}):
                with self.subTest(operation=operation, kwargs=kwargs), self.assertRaises(codec.CodecError):
                    if operation == 'serialize':
                        codec.source_serialize_ledger(projection, ledger, **kwargs)
                    else:
                        codec.source_deserialize_ledger(projection, raw, **kwargs)

    def test_zero_empty_and_positive_sign_boundaries(self):
        for value, expected in [(0, b''), (1, b'\x01'), (127, b'\x7f'), (128, b'\x80\0'), (255, b'\xff\0'), (256, b'\0\x01'), ((1 << 255)-1, b'\xff'*31+b'\x7f')]:
            with self.subTest(value=value):
                self.assertEqual(codec.encode_integer(value), expected)
                self.assertEqual(codec.decode_integer(expected), value)

    def test_all_kind_and_hash_tag_roundtrips(self):
        for kind in ('Array', 'Struct'):
            for tag in ('ByteString', 'Buffer'):
                for reserved in [0, 1, 127, 128, 255, 256, (1 << 255)-1]:
                    ledger = codec.Ledger(kind, bytes(range(32)), reserved, tag)
                    raw = codec.encode_ledger(ledger)
                    self.assertEqual(codec.decode_ledger_prefix(raw), (ledger, b''))
                    self.assertTrue(38 <= len(raw) <= 70)
                    self.assertEqual(raw[0], {'Array': 0x40, 'Struct': 0x41}[kind])
                    self.assertEqual(raw[2], {'ByteString': 0x28, 'Buffer': 0x30}[tag])

    def test_signed_extension_and_nonminimal_varint_are_native_compatible(self):
        zero = codec.Ledger('Array', bytes(32), 0)
        raw = codec.encode_ledger(zero)
        nonminimal = b'\x40\xfd\x02\0\x28\xfd\x20\0' + bytes(32) + b'\x21\xfd\x02\0\0\0'
        self.assertEqual(codec.decode_ledger_prefix(nonminimal), (zero, b''))
        self.assertNotEqual(raw, nonminimal)
        self.assertEqual(codec.encode_ledger(codec.decode_ledger_prefix(nonminimal)[0]), raw)
        self.assertEqual(codec.decode_integer(b'\x80\0\0'), 128)

    def test_trailing_bytes_are_returned_not_silently_claimed_consumed(self):
        ledger = codec.Ledger('Struct', bytes(32), 1)
        self.assertEqual(codec.decode_ledger_prefix(codec.encode_ledger(ledger)+b'\xff\x00'), (ledger,b'\xff\x00'))

    def test_invalid_domain_and_truncated_prefixes_rejected(self):
        ledger = codec.Ledger('Array', bytes(32), 128)
        raw = codec.encode_ledger(ledger)
        for length in range(len(raw)):
            with self.subTest(length=length), self.assertRaises(codec.CodecError):
                codec.decode_ledger_prefix(raw[:length])
        for value in [-1, 1 << 255]:
            with self.assertRaises(codec.CodecError):
                codec.encode_integer(value)
        for raw in [b'\xff', b'\x80', bytes(33)]:
            with self.assertRaises(codec.CodecError):
                codec.decode_integer(raw)

    def test_source_validation_rejects_changed_integer_zero_and_reader_width(self):
        sources = codec.source_evidence()
        for name, old, new in [('Integer', 'value.IsZero ? ReadOnlyMemory<byte>.Empty : value.ToByteArray()', 'value.ToByteArray()'), ('MemoryReader', '0xfd => ReadUInt16()', '0xfd => ReadUInt32()')]:
            altered = dict(sources)
            altered[name] = dict(sources[name])
            altered[name]['source'] = sources[name]['source'].replace(old, new)
            with self.subTest(name=name), self.assertRaises(codec.CodecError):
                codec.validate_sources(altered)

    def test_varint_all_widths_and_native_bounds(self):
        for value in [0, 252, 253, 65535, 65536, 0xffffffff, 0x100000000, (1 << 64)-1]:
            raw = codec.encode_varint(value)
            self.assertEqual(codec.decode_varint(raw+b"suffix"), (value, len(raw)))
        for prefix, width in [(253, 2), (254, 4), (255, 8)]:
            raw = bytes([prefix, 2]) + bytes(width-1)
            self.assertEqual(codec.decode_varint(raw), (2, len(raw)))
            with self.assertRaises(codec.CodecError):
                codec.decode_varint(raw, maximum=1)
            for end in range(1, len(raw)):
                with self.assertRaises(codec.CodecError):
                    codec.decode_varint(raw[:end])

    def test_tags_field_count_and_resource_domain_are_checked(self):
        raw = codec.encode_ledger(codec.Ledger('Array', bytes(32), 0))
        for pos, value in [(0, 0x48), (1, 3), (2, 0x21), (3, 31), (36, 0x28)]:
            changed = bytearray(raw)
            changed[pos] = value
            with self.subTest(pos=pos), self.assertRaises(codec.CodecError):
                codec.decode_ledger_prefix(bytes(changed))
        with self.assertRaises(codec.CodecError):
            codec.decode_ledger_prefix(raw, max_items=2)
        with self.assertRaises(codec.CodecError):
            codec.decode_ledger_prefix(raw, max_size=31)

    def test_source_validator_checks_executable_paths_beyond_hashes(self):
        sources = codec.source_evidence()
        mutations = [
            ('Integer', 'public const int MaxSize = 32;', 'public const int MaxSize = 33;'),
            ('StdLib', 'return BinarySerializer.Serialize(item, engine.Limits);', 'return new byte[0];'),
            ('BinarySerializer', 'for (int i = array.Count - 1; i >= 0; i--)', 'for (int i = 0; i < array.Count; i++)'),
            ('MemoryReader', 'BinaryPrimitives.ReadUInt16LittleEndian', 'BinaryPrimitives.ReadUInt16BigEndian'),
            ('PrimitiveType', 'return Memory.Span;', 'return ReadOnlySpan<byte>.Empty;'),
            ('Buffer', 'StackItemType.Buffer;', 'StackItemType.ByteString;'),
        ]
        for name, old, new in mutations:
            altered = {key: dict(value) for key, value in sources.items()}
            self.assertIn(old, altered[name]['source'])
            altered[name]['source'] = altered[name]['source'].replace(old, new)
            with self.subTest(name=name), self.assertRaises(codec.CodecError):
                codec.validate_sources(altered)


if __name__ == '__main__':
    unittest.main()
