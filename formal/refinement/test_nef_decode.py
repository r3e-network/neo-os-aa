"""Independent structural-decoder adversarial tests; no exporter sizes or names."""
import copy
import struct
import unittest
from unittest import mock

import nef_decode


class IndependentInstructionDecodeTests(unittest.TestCase):
    def test_official_opcode_and_width_inventory_is_complete_and_attested(self):
        self.assertEqual('004cd6070a940405818d9357638277dd44407e2e', nef_decode.NEO_VM_SOURCE_COMMIT)
        self.assertEqual('928f9602898b7abb4fc8894bf8fd3c510f05bb3906e5460743243a566dfec805',
                         nef_decode.SOURCE_HASHES['src/Neo.VM/OpCode.cs'])
        self.assertEqual('a25bff81e4f742036d2f599ab8688369592786a1e0cc2f920a3bd45c4e1fa24b',
                         nef_decode.opcode_table_digest())
        self.assertEqual(196, len(nef_decode.OPCODES))
        self.assertEqual(('ASSERTMSG', 0, 0), nef_decode.OPCODES[0xE1])
        self.assertEqual(131070, nef_decode.VM_MAX_ITEM_SIZE)

    def test_forged_size_cannot_hide_a_branch_in_push_data(self):
        script = b'\x0c\x01A\x22\x02\x40'
        actual = nef_decode.decode_script(script, 0)
        self.assertEqual([0, 3, 5], [row['offset'] for row in actual])
        self.assertEqual([3, 2, 1], [row['size'] for row in actual])
        self.assertEqual([{'kind': 'branch', 'target': 5}], actual[1]['edges'])
        forged = copy.deepcopy(actual)
        forged[0]['size'] = 5
        forged.pop(1)
        self.assertNotEqual(actual, forged)

    def test_changed_long_branch_width_does_not_consume_its_operand_as_opcodes(self):
        script = b'\x23' + struct.pack('<i', 5) + b'\x40'
        actual = nef_decode.decode_script(script, 0)
        self.assertEqual(5, actual[0]['size'])
        self.assertEqual('05000000', actual[0]['operandHex'])
        self.assertEqual('2305000000', actual[0]['instructionHex'])
        self.assertEqual([{'kind': 'branch', 'target': 5}], actual[0]['edges'])

    def test_truncated_pushdata_prefixes_and_payloads_fail_closed(self):
        for script in [b'\x0c', b'\x0d\x01', b'\x0e\x01\x00\x00',
                       b'\x0c\x03AB', b'\x0d\x02\x00A', b'\x0e\x02\x00\x00\x00A',
                       b'\x0e\xff\xff\xff\xff']:
            with self.subTest(script=script.hex()), self.assertRaises(ValueError):
                nef_decode.decode_script(script, 0)

    def test_jump_targets_must_be_actual_instruction_boundaries(self):
        for script in [b'\x22\x01\x40', b'\x22\x03\x40', b'\x22\xff\x40',
                       b'\x22\x03\x0c\x01A\x40']:
            with self.subTest(script=script.hex()), self.assertRaises(ValueError):
                nef_decode.decode_script(script, 0)

    def test_callt_index_is_unsigned_little_endian_and_in_range(self):
        for script, count in [(b'\x37\x00\x00\x40', 0), (b'\x37\x01\x00\x40', 1),
                              (b'\x37\x00\x01\x40', 2), (b'\x37\x00', 1)]:
            with self.subTest(script=script.hex(), count=count), self.assertRaises(ValueError):
                nef_decode.decode_script(script, count)
        self.assertEqual('CALLT', nef_decode.decode_script(b'\x37\x01\x00\x40', 2)[0]['name'])

    def test_calla_is_an_explicit_unresolved_indirect_call(self):
        rows = nef_decode.decode_script(b'\x36\x40', 0)
        self.assertEqual([{'kind': 'unresolved-indirect-call', 'target': None},
                          {'kind': 'fallthrough', 'target': 1}], rows[0]['edges'])

    def test_terminals_do_not_acquire_fallthrough_edges(self):
        for opcode in [0x38, 0x3A, 0x3F, 0x40, 0xE0]:
            with self.subTest(opcode=opcode):
                self.assertEqual([], nef_decode.decode_script(bytes([opcode, 0x40]), 0)[0]['edges'])
        self.assertEqual([], nef_decode.decode_script(b'\x21', 0)[0]['edges'])

    def test_call_and_conditional_branches_keep_their_continuation(self):
        script = b'\x21\x34\x02\x24\xfe\x40'
        rows = nef_decode.decode_script(script, 0)
        self.assertEqual([{'kind': 'call', 'target': 3}, {'kind': 'fallthrough', 'target': 3}], rows[1]['edges'])
        self.assertEqual([{'kind': 'branch', 'target': 1}, {'kind': 'fallthrough', 'target': 5}], rows[2]['edges'])

    def test_try_records_only_nonzero_signed_handlers_and_endtry_has_no_fallthrough(self):
        rows = nef_decode.decode_script(b'\x3b\x03\x05\x3d\x02\x40', 0)
        self.assertEqual([{'kind': 'catch', 'target': 3}, {'kind': 'finally', 'target': 5},
                          {'kind': 'fallthrough', 'target': 3}], rows[0]['edges'])
        self.assertEqual([{'kind': 'branch', 'target': 5}], rows[1]['edges'])
        self.assertEqual([{'kind': 'finally', 'target': 3}, {'kind': 'fallthrough', 'target': 3}],
                         nef_decode.decode_script(b'\x3b\x00\x03\x40', 0)[0]['edges'])
        long_try = b'\x3c' + struct.pack('<ii', 9, 0) + b'\x40'
        self.assertEqual([{'kind': 'catch', 'target': 9}, {'kind': 'fallthrough', 'target': 9}],
                         nef_decode.decode_script(long_try, 0)[0]['edges'])
        with self.assertRaises(ValueError):
            nef_decode.decode_script(b'\x3b\x02\x00\x40', 0)

    def test_pusha_checks_the_declared_pointer_without_inventing_a_jump_edge(self):
        row = nef_decode.decode_script(b'\x0a' + struct.pack('<i', 5) + b'\x40', 0)[0]
        self.assertEqual([{'kind': 'fallthrough', 'target': 5}], row['edges'])
        for delta in [1, -1, 6]:
            with self.subTest(delta=delta), self.assertRaises(ValueError):
                nef_decode.decode_script(b'\x0a' + struct.pack('<i', delta) + b'\x40', 0)

    def test_unknown_and_truncated_fixed_operands_are_rejected(self):
        for script in [b'\x06', b'\x07', b'\xff', b'\x02\x01\x02\x03',
                       b'\x41\x01\x02\x03', b'\x57\x00', b'\x3c' + bytes(7)]:
            with self.subTest(script=script.hex()), self.assertRaises(ValueError):
                nef_decode.decode_script(script, 0)

    def test_pushdata_operand_excludes_prefix_and_never_decodes_payload_opcodes(self):
        payload = b'\xff\x22\x00\x40'
        for opcode, prefix in [(0x0C, 1), (0x0D, 2), (0x0E, 4)]:
            script = bytes([opcode]) + len(payload).to_bytes(prefix, 'little') + payload + b'\x40'
            rows = nef_decode.decode_script(script, 0)
            self.assertEqual(2, len(rows))
            self.assertEqual(payload.hex(), rows[0]['operandHex'])
            self.assertEqual(script[:-1].hex(), rows[0]['instructionHex'])
            self.assertEqual(1 + prefix + len(payload), rows[0]['size'])

    def test_input_types_limits_and_inventory_tampering_fail_closed(self):
        for script, count in [(b'', 0), (bytearray(b'\x40'), 0), ('40', 0),
                              (b'\x40', True), (b'\x40', -1), (b'\x40', 65537),
                              (b'\x21' * 131071, 0)]:
            with self.subTest(script_type=type(script), count=count), self.assertRaises(ValueError):
                nef_decode.decode_script(script, count)
        altered = dict(nef_decode.OPCODES)
        altered[0x23] = ('JMP_L', 1, 0)
        with mock.patch.object(nef_decode, 'OPCODES', altered), self.assertRaisesRegex(ValueError, 'inventory drift'):
            nef_decode.decode_script(b'\x23\x02\x40', 0)

    def test_stack_item_operand_tags_follow_the_pinned_strict_script_rule(self):
        self.assertEqual('NEWARRAY_T', nef_decode.decode_script(b'\xc4\x00\x40', 0)[0]['name'])
        for script in [b'\xc4\xff\x40', b'\xd9\x00\x40', b'\xdb\x00\x40', b'\xdb\xff\x40']:
            with self.subTest(script=script.hex()), self.assertRaises(ValueError):
                nef_decode.decode_script(script, 0)


if __name__ == '__main__':
    unittest.main()
