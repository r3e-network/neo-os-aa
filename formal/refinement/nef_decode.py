"""Independent Neo.VM 3.10.1 instruction and control-flow inventory.

Width/name inventory is transcribed from the fixed official source, not exporter
JSON or the C# disassembler. operandHex mirrors Instruction.Operand: PUSHDATA
length prefixes are excluded, while instructionHex contains the full bytes.

Edges are structural: calls retain their return continuation as fallthrough;
TRY records handler declarations, not implicit exception edges from every op.
ENDTRY's branch is its declared end continuation (a finally may run first).
ENDFINALLY/THROW/RET have no ordinary fallthrough. CALLA explicitly leaves an
unresolved-indirect-call. SYSCALL/CALLT effects, exception/context behavior,
stack/heap types and compiler refinement are outside this checker. This is not
a VM simulation or proof, and edge agreement cannot close those semantic gaps.
"""
import hashlib
import json
from types import MappingProxyType

NEO_VM_SOURCE_COMMIT = '004cd6070a940405818d9357638277dd44407e2e'
NEO_VM_SOURCE_URL = 'https://github.com/neo-project/neo-vm/tree/' + NEO_VM_SOURCE_COMMIT
SOURCE_HASHES = MappingProxyType({'src/Neo.VM/OpCode.cs': '928f9602898b7abb4fc8894bf8fd3c510f05bb3906e5460743243a566dfec805', 'src/Neo.VM/Instruction.cs': '608b2602c5117109e44153d3166ad68604904b1e1f408a0b5652e69b5229f224', 'src/Neo.VM/Script.cs': '537e623d0407b221fe992f891ae81529774087da84cb67897c452a6388984de4', 'src/Neo.VM/JumpTable/JumpTable.Control.cs': 'a0ac51ff220abbfcf8fb8c19bb0f2b8be4680169ba8ba33f6ededfc5e5e6a2ec', 'src/Neo.VM/ExecutionEngineLimits.cs': 'b8353f47f18aec5093426b550a231c7ce1e2201e636e806f177ffcb9043374b4', 'src/Neo.VM/Types/StackItemType.cs': '5f84ba615857815350c46a93eb8c1400d548baa6138a2fa0e0a9242b77f28d16'})
# ExecutionEngineLimits.cs: MaxItemSize = ushort.MaxValue * 2.
VM_MAX_ITEM_SIZE = 131070
# Entries are (official opcode name, fixed operand bytes, length-prefix bytes).
OPCODES = MappingProxyType({
    0x00: ('PUSHINT8', 1, 0),
    0x01: ('PUSHINT16', 2, 0),
    0x02: ('PUSHINT32', 4, 0),
    0x03: ('PUSHINT64', 8, 0),
    0x04: ('PUSHINT128', 16, 0),
    0x05: ('PUSHINT256', 32, 0),
    0x08: ('PUSHT', 0, 0),
    0x09: ('PUSHF', 0, 0),
    0x0A: ('PUSHA', 4, 0),
    0x0B: ('PUSHNULL', 0, 0),
    0x0C: ('PUSHDATA1', 0, 1),
    0x0D: ('PUSHDATA2', 0, 2),
    0x0E: ('PUSHDATA4', 0, 4),
    0x0F: ('PUSHM1', 0, 0),
    0x10: ('PUSH0', 0, 0),
    0x11: ('PUSH1', 0, 0),
    0x12: ('PUSH2', 0, 0),
    0x13: ('PUSH3', 0, 0),
    0x14: ('PUSH4', 0, 0),
    0x15: ('PUSH5', 0, 0),
    0x16: ('PUSH6', 0, 0),
    0x17: ('PUSH7', 0, 0),
    0x18: ('PUSH8', 0, 0),
    0x19: ('PUSH9', 0, 0),
    0x1A: ('PUSH10', 0, 0),
    0x1B: ('PUSH11', 0, 0),
    0x1C: ('PUSH12', 0, 0),
    0x1D: ('PUSH13', 0, 0),
    0x1E: ('PUSH14', 0, 0),
    0x1F: ('PUSH15', 0, 0),
    0x20: ('PUSH16', 0, 0),
    0x21: ('NOP', 0, 0),
    0x22: ('JMP', 1, 0),
    0x23: ('JMP_L', 4, 0),
    0x24: ('JMPIF', 1, 0),
    0x25: ('JMPIF_L', 4, 0),
    0x26: ('JMPIFNOT', 1, 0),
    0x27: ('JMPIFNOT_L', 4, 0),
    0x28: ('JMPEQ', 1, 0),
    0x29: ('JMPEQ_L', 4, 0),
    0x2A: ('JMPNE', 1, 0),
    0x2B: ('JMPNE_L', 4, 0),
    0x2C: ('JMPGT', 1, 0),
    0x2D: ('JMPGT_L', 4, 0),
    0x2E: ('JMPGE', 1, 0),
    0x2F: ('JMPGE_L', 4, 0),
    0x30: ('JMPLT', 1, 0),
    0x31: ('JMPLT_L', 4, 0),
    0x32: ('JMPLE', 1, 0),
    0x33: ('JMPLE_L', 4, 0),
    0x34: ('CALL', 1, 0),
    0x35: ('CALL_L', 4, 0),
    0x36: ('CALLA', 0, 0),
    0x37: ('CALLT', 2, 0),
    0x38: ('ABORT', 0, 0),
    0x39: ('ASSERT', 0, 0),
    0x3A: ('THROW', 0, 0),
    0x3B: ('TRY', 2, 0),
    0x3C: ('TRY_L', 8, 0),
    0x3D: ('ENDTRY', 1, 0),
    0x3E: ('ENDTRY_L', 4, 0),
    0x3F: ('ENDFINALLY', 0, 0),
    0x40: ('RET', 0, 0),
    0x41: ('SYSCALL', 4, 0),
    0x43: ('DEPTH', 0, 0),
    0x45: ('DROP', 0, 0),
    0x46: ('NIP', 0, 0),
    0x48: ('XDROP', 0, 0),
    0x49: ('CLEAR', 0, 0),
    0x4A: ('DUP', 0, 0),
    0x4B: ('OVER', 0, 0),
    0x4D: ('PICK', 0, 0),
    0x4E: ('TUCK', 0, 0),
    0x50: ('SWAP', 0, 0),
    0x51: ('ROT', 0, 0),
    0x52: ('ROLL', 0, 0),
    0x53: ('REVERSE3', 0, 0),
    0x54: ('REVERSE4', 0, 0),
    0x55: ('REVERSEN', 0, 0),
    0x56: ('INITSSLOT', 1, 0),
    0x57: ('INITSLOT', 2, 0),
    0x58: ('LDSFLD0', 0, 0),
    0x59: ('LDSFLD1', 0, 0),
    0x5A: ('LDSFLD2', 0, 0),
    0x5B: ('LDSFLD3', 0, 0),
    0x5C: ('LDSFLD4', 0, 0),
    0x5D: ('LDSFLD5', 0, 0),
    0x5E: ('LDSFLD6', 0, 0),
    0x5F: ('LDSFLD', 1, 0),
    0x60: ('STSFLD0', 0, 0),
    0x61: ('STSFLD1', 0, 0),
    0x62: ('STSFLD2', 0, 0),
    0x63: ('STSFLD3', 0, 0),
    0x64: ('STSFLD4', 0, 0),
    0x65: ('STSFLD5', 0, 0),
    0x66: ('STSFLD6', 0, 0),
    0x67: ('STSFLD', 1, 0),
    0x68: ('LDLOC0', 0, 0),
    0x69: ('LDLOC1', 0, 0),
    0x6A: ('LDLOC2', 0, 0),
    0x6B: ('LDLOC3', 0, 0),
    0x6C: ('LDLOC4', 0, 0),
    0x6D: ('LDLOC5', 0, 0),
    0x6E: ('LDLOC6', 0, 0),
    0x6F: ('LDLOC', 1, 0),
    0x70: ('STLOC0', 0, 0),
    0x71: ('STLOC1', 0, 0),
    0x72: ('STLOC2', 0, 0),
    0x73: ('STLOC3', 0, 0),
    0x74: ('STLOC4', 0, 0),
    0x75: ('STLOC5', 0, 0),
    0x76: ('STLOC6', 0, 0),
    0x77: ('STLOC', 1, 0),
    0x78: ('LDARG0', 0, 0),
    0x79: ('LDARG1', 0, 0),
    0x7A: ('LDARG2', 0, 0),
    0x7B: ('LDARG3', 0, 0),
    0x7C: ('LDARG4', 0, 0),
    0x7D: ('LDARG5', 0, 0),
    0x7E: ('LDARG6', 0, 0),
    0x7F: ('LDARG', 1, 0),
    0x80: ('STARG0', 0, 0),
    0x81: ('STARG1', 0, 0),
    0x82: ('STARG2', 0, 0),
    0x83: ('STARG3', 0, 0),
    0x84: ('STARG4', 0, 0),
    0x85: ('STARG5', 0, 0),
    0x86: ('STARG6', 0, 0),
    0x87: ('STARG', 1, 0),
    0x88: ('NEWBUFFER', 0, 0),
    0x89: ('MEMCPY', 0, 0),
    0x8B: ('CAT', 0, 0),
    0x8C: ('SUBSTR', 0, 0),
    0x8D: ('LEFT', 0, 0),
    0x8E: ('RIGHT', 0, 0),
    0x90: ('INVERT', 0, 0),
    0x91: ('AND', 0, 0),
    0x92: ('OR', 0, 0),
    0x93: ('XOR', 0, 0),
    0x97: ('EQUAL', 0, 0),
    0x98: ('NOTEQUAL', 0, 0),
    0x99: ('SIGN', 0, 0),
    0x9A: ('ABS', 0, 0),
    0x9B: ('NEGATE', 0, 0),
    0x9C: ('INC', 0, 0),
    0x9D: ('DEC', 0, 0),
    0x9E: ('ADD', 0, 0),
    0x9F: ('SUB', 0, 0),
    0xA0: ('MUL', 0, 0),
    0xA1: ('DIV', 0, 0),
    0xA2: ('MOD', 0, 0),
    0xA3: ('POW', 0, 0),
    0xA4: ('SQRT', 0, 0),
    0xA5: ('MODMUL', 0, 0),
    0xA6: ('MODPOW', 0, 0),
    0xA8: ('SHL', 0, 0),
    0xA9: ('SHR', 0, 0),
    0xAA: ('NOT', 0, 0),
    0xAB: ('BOOLAND', 0, 0),
    0xAC: ('BOOLOR', 0, 0),
    0xB1: ('NZ', 0, 0),
    0xB3: ('NUMEQUAL', 0, 0),
    0xB4: ('NUMNOTEQUAL', 0, 0),
    0xB5: ('LT', 0, 0),
    0xB6: ('LE', 0, 0),
    0xB7: ('GT', 0, 0),
    0xB8: ('GE', 0, 0),
    0xB9: ('MIN', 0, 0),
    0xBA: ('MAX', 0, 0),
    0xBB: ('WITHIN', 0, 0),
    0xBE: ('PACKMAP', 0, 0),
    0xBF: ('PACKSTRUCT', 0, 0),
    0xC0: ('PACK', 0, 0),
    0xC1: ('UNPACK', 0, 0),
    0xC2: ('NEWARRAY0', 0, 0),
    0xC3: ('NEWARRAY', 0, 0),
    0xC4: ('NEWARRAY_T', 1, 0),
    0xC5: ('NEWSTRUCT0', 0, 0),
    0xC6: ('NEWSTRUCT', 0, 0),
    0xC8: ('NEWMAP', 0, 0),
    0xCA: ('SIZE', 0, 0),
    0xCB: ('HASKEY', 0, 0),
    0xCC: ('KEYS', 0, 0),
    0xCD: ('VALUES', 0, 0),
    0xCE: ('PICKITEM', 0, 0),
    0xCF: ('APPEND', 0, 0),
    0xD0: ('SETITEM', 0, 0),
    0xD1: ('REVERSEITEMS', 0, 0),
    0xD2: ('REMOVE', 0, 0),
    0xD3: ('CLEARITEMS', 0, 0),
    0xD4: ('POPITEM', 0, 0),
    0xD8: ('ISNULL', 0, 0),
    0xD9: ('ISTYPE', 1, 0),
    0xDB: ('CONVERT', 1, 0),
    0xE0: ('ABORTMSG', 0, 0),
    0xE1: ('ASSERTMSG', 0, 0),
})
# SHA256 of compact JSON [[opcode,name,fixedWidth,prefixWidth], ...] in byte order.
OPCODE_TABLE_SHA256 = 'a25bff81e4f742036d2f599ab8688369592786a1e0cc2f920a3bd45c4e1fa24b'
STACK_ITEM_TYPES = frozenset((0x00, 0x10, 0x20, 0x21, 0x28, 0x30, 0x40, 0x41, 0x48, 0x60))
_BRANCHES = frozenset(range(0x22, 0x34))
_CALLS = frozenset((0x34, 0x35))
_ENDTRIES = frozenset((0x3D, 0x3E))
_TERMINALS = frozenset((0x38, 0x3A, 0x3F, 0x40, 0xE0))
_NO_FALLTHROUGH = _TERMINALS | _ENDTRIES | frozenset((0x22, 0x23))


def opcode_table_digest() -> str:
    rows = [[opcode, *spec] for opcode, spec in sorted(OPCODES.items())]
    return hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()


def decode_script(script: bytes, token_count: int) -> list:
    """Decode immutable bytes and validate all encoded local control-flow targets.

    Raises ValueError on malformed input. No exporter metadata is accepted.
    token_count is independently parsed by the caller from the NEF token table.
    """
    if type(script) is not bytes or not script:
        raise ValueError('script must be nonempty immutable bytes')
    if len(script) > VM_MAX_ITEM_SIZE:
        raise ValueError('script exceeds pinned VM MaxItemSize')
    if type(token_count) is not int or not 0 <= token_count <= 65536:
        raise ValueError('token_count must be a nonnegative UInt16 index-space count')
    if opcode_table_digest() != OPCODE_TABLE_SHA256:
        raise ValueError('pinned opcode/operand inventory drift')
    rows, referenced = [], []
    pc = 0
    while pc < len(script):
        opcode = script[pc]
        spec = OPCODES.get(opcode)
        if spec is None:
            raise ValueError(f'unknown opcode 0x{opcode:02x} at {pc}')
        name, width, prefix = spec
        operand_start = pc + 1
        if prefix:
            end = operand_start + prefix
            if end > len(script):
                raise ValueError(f'truncated {name} length prefix at {pc}')
            width = int.from_bytes(script[operand_start:end], 'little', signed=prefix == 4)
            if width < 0:
                raise ValueError(f'negative {name} length at {pc}')
            operand_start = end
        next_pc = operand_start + width
        if next_pc > len(script):
            raise ValueError(f'truncated {name} operand at {pc}')
        operand = script[operand_start:next_pc]
        edges = []
        if opcode in _BRANCHES | _CALLS | _ENDTRIES:
            target = pc + int.from_bytes(operand, 'little', signed=True)
            edges.append({'kind': 'call' if opcode in _CALLS else 'branch', 'target': target})
            referenced.append((pc, target))
        if opcode == 0x0A:  # PUSHA declares a pointer, not a control-flow jump.
            referenced.append((pc, pc + int.from_bytes(operand, 'little', signed=True)))
        if opcode in (0x3B, 0x3C):
            part = 1 if opcode == 0x3B else 4
            for i, kind in enumerate(('catch', 'finally')):
                delta = int.from_bytes(operand[i * part:(i + 1) * part], 'little', signed=True)
                if delta:  # Zero means no handler, not a jump back to TRY.
                    edges.append({'kind': kind, 'target': pc + delta})
                    referenced.append((pc, pc + delta))
        if opcode == 0x36:
            edges.append({'kind': 'unresolved-indirect-call', 'target': None})
        if opcode == 0x37 and int.from_bytes(operand, 'little') >= token_count:
            raise ValueError(f'CALLT token index out of bounds at {pc}')
        if opcode in (0xC4, 0xD9, 0xDB):
            tag = operand[0]
            if tag not in STACK_ITEM_TYPES or (opcode != 0xC4 and tag == 0):
                raise ValueError(f'invalid {name} stack-item tag at {pc}')
        if opcode not in _NO_FALLTHROUGH and next_pc < len(script):
            edges.append({'kind': 'fallthrough', 'target': next_pc})
        rows.append({'offset': pc, 'opcode': opcode, 'name': name,
                     'operandHex': operand.hex(), 'size': next_pc - pc,
                     'instructionHex': script[pc:next_pc].hex(), 'edges': edges})
        pc = next_pc
    boundaries = {row['offset'] for row in rows}
    for origin, target in referenced:
        if target not in boundaries:
            raise ValueError(f'target {target} from {origin} is not an instruction boundary')
    return rows
