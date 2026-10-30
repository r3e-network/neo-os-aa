"""Independent Neo 3.10.1 two-field ledger byte codec and source checks.

Decode is permissive prefix parsing, just like native BinarySerializer. Canonical
serialization and accepted decoding are different domains. Native C#/.NET
correspondence remains a stated proof obligation, not inferred from source hashes.
"""
from dataclasses import dataclass
import hashlib
from pathlib import Path
import re
import tempfile
import urllib.request

NEO_COMMIT = 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d'
VM_COMMIT = '004cd6070a940405818d9357638277dd44407e2e'
LIMIT = 1 << 255
TAGS = {'Array': 0x40, 'Struct': 0x41, 'ByteString': 0x28, 'Buffer': 0x30, 'Integer': 0x21}


class CodecError(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise CodecError(message)


@dataclass(frozen=True)
class Ledger:
    kind: str
    tx_hash: bytes
    reserved: int
    hash_kind: str = 'ByteString'


def encode_integer(value):
    require(type(value) is int and 0 <= value < LIMIT, 'Ledger Integer must be nonnegative signed-256')
    out = []
    while value:
        out.append(value % 256)
        value //= 256
    if out and out[-1] >= 128:
        out.append(0)
    return bytes(out)


def decode_integer(payload):
    require(type(payload) is bytes and len(payload) <= 32, 'Integer payload exceeds 32 bytes')
    value = sum(byte * 256 ** index for index, byte in enumerate(payload))
    if payload and payload[-1] >= 128:
        value -= 256 ** len(payload)
    require(0 <= value < LIMIT, 'Decoded Integer is outside nonnegative ledger domain')
    return value


def encode_varint(value):
    require(type(value) is int and 0 <= value < 1 << 64, 'Varint outside UInt64')
    if value < 253:
        return bytes([value])
    width, prefix = (2, 253) if value <= 65535 else ((4, 254) if value <= 0xffffffff else (8, 255))
    return bytes([prefix]) + bytes((value >> (8 * index)) & 255 for index in range(width))


def decode_varint(data, offset=0, maximum=(1 << 64)-1):
    require(type(data) is bytes and type(offset) is int and 0 <= offset < len(data), 'Truncated varint')
    tag = data[offset]
    if tag < 253:
        value, end = tag, offset + 1
    else:
        width = {253: 2, 254: 4, 255: 8}[tag]
        end = offset + 1 + width
        require(end <= len(data), 'Truncated extended varint')
        value = sum(byte * 256 ** index for index, byte in enumerate(data[offset+1:end]))
    require(value <= maximum, 'Varint exceeds configured bound')
    return value, end


def encode_ledger(ledger):
    require(type(ledger) is Ledger and ledger.kind in ('Array', 'Struct') and ledger.hash_kind in ('ByteString', 'Buffer'), 'Unsupported ledger tags')
    require(type(ledger.tx_hash) is bytes and len(ledger.tx_hash) == 32, 'Hash must contain 32 bytes')
    payload = encode_integer(ledger.reserved)
    return bytes([TAGS[ledger.kind], 2, TAGS[ledger.hash_kind], 32]) + ledger.tx_hash + bytes([TAGS['Integer'], len(payload)]) + payload


def decode_ledger_prefix(data, *, max_size=131070, max_items=2048):
    require(type(data) is bytes and data, 'Empty or non-byte wire')
    require(max_items >= 3, 'Record requires one container and two scalar items')
    kinds, hash_kinds = {64: 'Array', 65: 'Struct'}, {40: 'ByteString', 48: 'Buffer'}
    require(data[0] in kinds, 'Expected Array or Struct')
    count, offset = decode_varint(data, 1, max_items)
    require(count == 2 and offset < len(data) and data[offset] in hash_kinds, 'Expected two fields and byte hash tag')
    hash_kind = hash_kinds[data[offset]]
    length, offset = decode_varint(data, offset+1, min(len(data), max_size))
    require(length == 32 and offset + length < len(data), 'Hash length/truncation')
    tx_hash, offset = data[offset:offset+length], offset+length
    require(data[offset] == TAGS['Integer'], 'Expected Integer reservation')
    length, offset = decode_varint(data, offset+1, 32)
    require(offset+length <= len(data), 'Truncated Integer payload')
    reserved = decode_integer(data[offset:offset+length])
    return Ledger(kinds[data[0]], tx_hash, reserved, hash_kind), data[offset+length:]


def tokens(source):
    """Small C# lexical tokenizer; quoted text is kept intact before comments."""
    pattern = r'@?"(?:""|\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\n]*|/\*[\s\S]*?\*/|[A-Za-z_][A-Za-z_0-9]*|0[xX][0-9A-Fa-f]+|[0-9]+|=>|\+\+|--|<=|>=|==|!=|\+=|\|\||&&|[^\s]'
    return [x for x in re.findall(pattern, source) if not x.startswith('//') and not x.startswith('/*')]


def method_tokens(source, signature):
    stream, target = tokens(source), tokens(signature)
    matches = [i for i in range(len(stream)-len(target)+1) if stream[i:i+len(target)] == target]
    require(len(matches) == 1, 'Expected unique pinned method signature: ' + signature)
    pos = matches[0] + len(target)
    require(pos < len(stream) and stream[pos] == '{', 'Expected method block')
    start, depth = pos, 0
    for pos in range(start, len(stream)):
        depth += (stream[pos] == '{') - (stream[pos] == '}')
        if depth == 0:
            return stream[start:pos+1]
    raise CodecError('Unterminated source method')


# Exact reviewed executable regions from Neo / NeoVM (MIT license),
# Copyright (C) 2015-2026 The Neo Project; provenance URLs below.
# These checks are independent of whole-file hash checks.
# Source facts are still a checked translation boundary, not a CLR semantics theorem.
SOURCE_FILES = {'BinarySerializer': ('neo',
                      'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
                      'src/Neo/SmartContract/BinarySerializer.cs',
                      'd74462dce89437070ca67deca40ba40de1e3a335f8a63726e5420ffb846ff150'),
 'StdLib': ('neo',
            'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
            'src/Neo/SmartContract/Native/StdLib.cs',
            '510dbd32f7896e99b0953096b6bc1df64fabfbee952ff4dc9f186789f084be05'),
 'MemoryReader': ('neo',
                  'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
                  'src/Neo.IO/MemoryReader.cs',
                  '38d763b1a6fcc2a9cbe8b1a6c5971b1c15421182f85990d9d442d73feb3aee50'),
 'BinaryWriterExtensions': ('neo',
                            'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d',
                            'src/Neo/Extensions/IO/BinaryWriterExtensions.cs',
                            '33b48ab08694b51a28f0700b41e149efa9613ffbd6a459f7e848fef80003512a'),
 'Integer': ('neo-vm',
             '004cd6070a940405818d9357638277dd44407e2e',
             'src/Neo.VM/Types/Integer.cs',
             'cb8c7bf8eed392c59b0bf59e281fd8c39b1fa0ef3894fa86e88fa3e0e90a137c'),
 'StackItemType': ('neo-vm',
                   '004cd6070a940405818d9357638277dd44407e2e',
                   'src/Neo.VM/Types/StackItemType.cs',
                   '5f84ba615857815350c46a93eb8c1400d548baa6138a2fa0e0a9242b77f28d16'),
 'Struct': ('neo-vm',
            '004cd6070a940405818d9357638277dd44407e2e',
            'src/Neo.VM/Types/Struct.cs',
            '12cb52e04fe9aba281798d1997ec347c6bea789f053e7dc4b8ec017fffdf8eba'),
 'PrimitiveType': ('neo-vm',
                   '004cd6070a940405818d9357638277dd44407e2e',
                   'src/Neo.VM/Types/PrimitiveType.cs',
                   'ba8e9cb00fbcedbe5ce67bb9b11e59e59c6cff9e676c08e17d611ca0469fae37'),
 'ByteString': ('neo-vm',
                '004cd6070a940405818d9357638277dd44407e2e',
                'src/Neo.VM/Types/ByteString.cs',
                '1f06948358fcb638bffd14429a3d0ea50916da88c68c2de8933dea734aec0f52'),
 'Buffer': ('neo-vm',
            '004cd6070a940405818d9357638277dd44407e2e',
            'src/Neo.VM/Types/Buffer.cs',
            'ca517919538c03e134c1c53b9ab6394ab0dab59738eab6352c15df97c43ea755')}
METHOD_BODIES = {('BinarySerializer', 'public static StackItem Deserialize(ReadOnlyMemory<byte> data, ExecutionEngineLimits limits)'): '{ '
                                                                                                                       'MemoryReader '
                                                                                                                       'reader '
                                                                                                                       '= '
                                                                                                                       'new '
                                                                                                                       '( '
                                                                                                                       'data '
                                                                                                                       ') '
                                                                                                                       '; '
                                                                                                                       'return '
                                                                                                                       'Deserialize '
                                                                                                                       '( '
                                                                                                                       'ref '
                                                                                                                       'reader '
                                                                                                                       ', '
                                                                                                                       '( '
                                                                                                                       'uint '
                                                                                                                       ') '
                                                                                                                       'Math '
                                                                                                                       '. '
                                                                                                                       'Min '
                                                                                                                       '( '
                                                                                                                       'data '
                                                                                                                       '. '
                                                                                                                       'Length '
                                                                                                                       ', '
                                                                                                                       'limits '
                                                                                                                       '. '
                                                                                                                       'MaxItemSize '
                                                                                                                       ') '
                                                                                                                       ', '
                                                                                                                       'limits '
                                                                                                                       '. '
                                                                                                                       'MaxStackSize '
                                                                                                                       ') '
                                                                                                                       '; '
                                                                                                                       '}',
 ('BinarySerializer', 'public static StackItem Deserialize(ref MemoryReader reader, uint maxSize, uint maxItems)'): '{ '
                                                                                                                    'Stack '
                                                                                                                    '< '
                                                                                                                    'StackItem '
                                                                                                                    '> '
                                                                                                                    'deserialized '
                                                                                                                    '= '
                                                                                                                    'new '
                                                                                                                    '( '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'var '
                                                                                                                    'undeserialized '
                                                                                                                    '= '
                                                                                                                    '1 '
                                                                                                                    '; '
                                                                                                                    'while '
                                                                                                                    '( '
                                                                                                                    'undeserialized '
                                                                                                                    '-- '
                                                                                                                    '> '
                                                                                                                    '0 '
                                                                                                                    ') '
                                                                                                                    '{ '
                                                                                                                    'var '
                                                                                                                    'type '
                                                                                                                    '= '
                                                                                                                    '( '
                                                                                                                    'StackItemType '
                                                                                                                    ') '
                                                                                                                    'reader '
                                                                                                                    '. '
                                                                                                                    'ReadByte '
                                                                                                                    '( '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'switch '
                                                                                                                    '( '
                                                                                                                    'type '
                                                                                                                    ') '
                                                                                                                    '{ '
                                                                                                                    'case '
                                                                                                                    'StackItemType '
                                                                                                                    '. '
                                                                                                                    'Any '
                                                                                                                    ': '
                                                                                                                    'deserialized '
                                                                                                                    '. '
                                                                                                                    'Push '
                                                                                                                    '( '
                                                                                                                    'StackItem '
                                                                                                                    '. '
                                                                                                                    'Null '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'break '
                                                                                                                    '; '
                                                                                                                    'case '
                                                                                                                    'StackItemType '
                                                                                                                    '. '
                                                                                                                    'Boolean '
                                                                                                                    ': '
                                                                                                                    'deserialized '
                                                                                                                    '. '
                                                                                                                    'Push '
                                                                                                                    '( '
                                                                                                                    'reader '
                                                                                                                    '. '
                                                                                                                    'ReadBoolean '
                                                                                                                    '( '
                                                                                                                    ') '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'break '
                                                                                                                    '; '
                                                                                                                    'case '
                                                                                                                    'StackItemType '
                                                                                                                    '. '
                                                                                                                    'Integer '
                                                                                                                    ': '
                                                                                                                    'deserialized '
                                                                                                                    '. '
                                                                                                                    'Push '
                                                                                                                    '( '
                                                                                                                    'new '
                                                                                                                    'BigInteger '
                                                                                                                    '( '
                                                                                                                    'reader '
                                                                                                                    '. '
                                                                                                                    'ReadVarMemory '
                                                                                                                    '( '
                                                                                                                    'Integer '
                                                                                                                    '. '
                                                                                                                    'MaxSize '
                                                                                                                    ') '
                                                                                                                    '. '
                                                                                                                    'Span '
                                                                                                                    ') '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'break '
                                                                                                                    '; '
                                                                                                                    'case '
                                                                                                                    'StackItemType '
                                                                                                                    '. '
                                                                                                                    'ByteString '
                                                                                                                    ': '
                                                                                                                    'deserialized '
                                                                                                                    '. '
                                                                                                                    'Push '
                                                                                                                    '( '
                                                                                                                    'reader '
                                                                                                                    '. '
                                                                                                                    'ReadVarMemory '
                                                                                                                    '( '
                                                                                                                    '( '
                                                                                                                    'int '
                                                                                                                    ') '
                                                                                                                    'maxSize '
                                                                                                                    ') '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'break '
                                                                                                                    '; '
                                                                                                                    'case '
                                                                                                                    'StackItemType '
                                                                                                                    '. '
                                                                                                                    'Buffer '
                                                                                                                    ': '
                                                                                                                    'var '
                                                                                                                    'memory '
                                                                                                                    '= '
                                                                                                                    'reader '
                                                                                                                    '. '
                                                                                                                    'ReadVarMemory '
                                                                                                                    '( '
                                                                                                                    '( '
                                                                                                                    'int '
                                                                                                                    ') '
                                                                                                                    'maxSize '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'deserialized '
                                                                                                                    '. '
                                                                                                                    'Push '
                                                                                                                    '( '
                                                                                                                    'new '
                                                                                                                    'Buffer '
                                                                                                                    '( '
                                                                                                                    'memory '
                                                                                                                    '. '
                                                                                                                    'Span '
                                                                                                                    ') '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'break '
                                                                                                                    '; '
                                                                                                                    'case '
                                                                                                                    'StackItemType '
                                                                                                                    '. '
                                                                                                                    'Array '
                                                                                                                    ': '
                                                                                                                    'case '
                                                                                                                    'StackItemType '
                                                                                                                    '. '
                                                                                                                    'Struct '
                                                                                                                    ': '
                                                                                                                    '{ '
                                                                                                                    'int '
                                                                                                                    'count '
                                                                                                                    '= '
                                                                                                                    '( '
                                                                                                                    'int '
                                                                                                                    ') '
                                                                                                                    'reader '
                                                                                                                    '. '
                                                                                                                    'ReadVarInt '
                                                                                                                    '( '
                                                                                                                    'maxItems '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'deserialized '
                                                                                                                    '. '
                                                                                                                    'Push '
                                                                                                                    '( '
                                                                                                                    'new '
                                                                                                                    'ContainerPlaceholder '
                                                                                                                    '( '
                                                                                                                    'type '
                                                                                                                    ', '
                                                                                                                    'count '
                                                                                                                    ') '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'undeserialized '
                                                                                                                    '+= '
                                                                                                                    'count '
                                                                                                                    '; '
                                                                                                                    '} '
                                                                                                                    'break '
                                                                                                                    '; '
                                                                                                                    'case '
                                                                                                                    'StackItemType '
                                                                                                                    '. '
                                                                                                                    'Map '
                                                                                                                    ': '
                                                                                                                    '{ '
                                                                                                                    'int '
                                                                                                                    'count '
                                                                                                                    '= '
                                                                                                                    '( '
                                                                                                                    'int '
                                                                                                                    ') '
                                                                                                                    'reader '
                                                                                                                    '. '
                                                                                                                    'ReadVarInt '
                                                                                                                    '( '
                                                                                                                    'maxItems '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'deserialized '
                                                                                                                    '. '
                                                                                                                    'Push '
                                                                                                                    '( '
                                                                                                                    'new '
                                                                                                                    'ContainerPlaceholder '
                                                                                                                    '( '
                                                                                                                    'type '
                                                                                                                    ', '
                                                                                                                    'count '
                                                                                                                    ') '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'undeserialized '
                                                                                                                    '+= '
                                                                                                                    'count '
                                                                                                                    '* '
                                                                                                                    '2 '
                                                                                                                    '; '
                                                                                                                    '} '
                                                                                                                    'break '
                                                                                                                    '; '
                                                                                                                    'default '
                                                                                                                    ': '
                                                                                                                    'throw '
                                                                                                                    'new '
                                                                                                                    'FormatException '
                                                                                                                    '( '
                                                                                                                    '$ '
                                                                                                                    '"Invalid '
                                                                                                                    'StackItemType({type})" '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    '} '
                                                                                                                    'if '
                                                                                                                    '( '
                                                                                                                    'deserialized '
                                                                                                                    '. '
                                                                                                                    'Count '
                                                                                                                    '> '
                                                                                                                    'maxItems '
                                                                                                                    ') '
                                                                                                                    'throw '
                                                                                                                    'new '
                                                                                                                    'FormatException '
                                                                                                                    '( '
                                                                                                                    '$ '
                                                                                                                    '"Deserialized '
                                                                                                                    'count({deserialized.Count}) '
                                                                                                                    'is '
                                                                                                                    'out '
                                                                                                                    'of '
                                                                                                                    'range '
                                                                                                                    '(max:{maxItems})" '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    '} '
                                                                                                                    'var '
                                                                                                                    'stackTemp '
                                                                                                                    '= '
                                                                                                                    'new '
                                                                                                                    'Stack '
                                                                                                                    '< '
                                                                                                                    'StackItem '
                                                                                                                    '> '
                                                                                                                    '( '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'while '
                                                                                                                    '( '
                                                                                                                    'deserialized '
                                                                                                                    '. '
                                                                                                                    'Count '
                                                                                                                    '> '
                                                                                                                    '0 '
                                                                                                                    ') '
                                                                                                                    '{ '
                                                                                                                    'StackItem '
                                                                                                                    'item '
                                                                                                                    '= '
                                                                                                                    'deserialized '
                                                                                                                    '. '
                                                                                                                    'Pop '
                                                                                                                    '( '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'if '
                                                                                                                    '( '
                                                                                                                    'item '
                                                                                                                    'is '
                                                                                                                    'ContainerPlaceholder '
                                                                                                                    'placeholder '
                                                                                                                    ') '
                                                                                                                    '{ '
                                                                                                                    'switch '
                                                                                                                    '( '
                                                                                                                    'placeholder '
                                                                                                                    '. '
                                                                                                                    'Type '
                                                                                                                    ') '
                                                                                                                    '{ '
                                                                                                                    'case '
                                                                                                                    'StackItemType '
                                                                                                                    '. '
                                                                                                                    'Array '
                                                                                                                    ': '
                                                                                                                    'Array '
                                                                                                                    'array '
                                                                                                                    '= '
                                                                                                                    'new '
                                                                                                                    '( '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'for '
                                                                                                                    '( '
                                                                                                                    'int '
                                                                                                                    'i '
                                                                                                                    '= '
                                                                                                                    '0 '
                                                                                                                    '; '
                                                                                                                    'i '
                                                                                                                    '< '
                                                                                                                    'placeholder '
                                                                                                                    '. '
                                                                                                                    'ElementCount '
                                                                                                                    '; '
                                                                                                                    'i '
                                                                                                                    '++ '
                                                                                                                    ') '
                                                                                                                    'array '
                                                                                                                    '. '
                                                                                                                    'Add '
                                                                                                                    '( '
                                                                                                                    'stackTemp '
                                                                                                                    '. '
                                                                                                                    'Pop '
                                                                                                                    '( '
                                                                                                                    ') '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'item '
                                                                                                                    '= '
                                                                                                                    'array '
                                                                                                                    '; '
                                                                                                                    'break '
                                                                                                                    '; '
                                                                                                                    'case '
                                                                                                                    'StackItemType '
                                                                                                                    '. '
                                                                                                                    'Struct '
                                                                                                                    ': '
                                                                                                                    'Struct '
                                                                                                                    '@ '
                                                                                                                    'struct '
                                                                                                                    '= '
                                                                                                                    'new '
                                                                                                                    '( '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'for '
                                                                                                                    '( '
                                                                                                                    'int '
                                                                                                                    'i '
                                                                                                                    '= '
                                                                                                                    '0 '
                                                                                                                    '; '
                                                                                                                    'i '
                                                                                                                    '< '
                                                                                                                    'placeholder '
                                                                                                                    '. '
                                                                                                                    'ElementCount '
                                                                                                                    '; '
                                                                                                                    'i '
                                                                                                                    '++ '
                                                                                                                    ') '
                                                                                                                    '@ '
                                                                                                                    'struct '
                                                                                                                    '. '
                                                                                                                    'Add '
                                                                                                                    '( '
                                                                                                                    'stackTemp '
                                                                                                                    '. '
                                                                                                                    'Pop '
                                                                                                                    '( '
                                                                                                                    ') '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'item '
                                                                                                                    '= '
                                                                                                                    '@ '
                                                                                                                    'struct '
                                                                                                                    '; '
                                                                                                                    'break '
                                                                                                                    '; '
                                                                                                                    'case '
                                                                                                                    'StackItemType '
                                                                                                                    '. '
                                                                                                                    'Map '
                                                                                                                    ': '
                                                                                                                    'Map '
                                                                                                                    'map '
                                                                                                                    '= '
                                                                                                                    'new '
                                                                                                                    '( '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'for '
                                                                                                                    '( '
                                                                                                                    'int '
                                                                                                                    'i '
                                                                                                                    '= '
                                                                                                                    '0 '
                                                                                                                    '; '
                                                                                                                    'i '
                                                                                                                    '< '
                                                                                                                    'placeholder '
                                                                                                                    '. '
                                                                                                                    'ElementCount '
                                                                                                                    '; '
                                                                                                                    'i '
                                                                                                                    '++ '
                                                                                                                    ') '
                                                                                                                    '{ '
                                                                                                                    'var '
                                                                                                                    'key '
                                                                                                                    '= '
                                                                                                                    'stackTemp '
                                                                                                                    '. '
                                                                                                                    'Pop '
                                                                                                                    '( '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'var '
                                                                                                                    'value '
                                                                                                                    '= '
                                                                                                                    'stackTemp '
                                                                                                                    '. '
                                                                                                                    'Pop '
                                                                                                                    '( '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    'map '
                                                                                                                    '[ '
                                                                                                                    '( '
                                                                                                                    'PrimitiveType '
                                                                                                                    ') '
                                                                                                                    'key '
                                                                                                                    '] '
                                                                                                                    '= '
                                                                                                                    'value '
                                                                                                                    '; '
                                                                                                                    '} '
                                                                                                                    'item '
                                                                                                                    '= '
                                                                                                                    'map '
                                                                                                                    '; '
                                                                                                                    'break '
                                                                                                                    '; '
                                                                                                                    '} '
                                                                                                                    '} '
                                                                                                                    'stackTemp '
                                                                                                                    '. '
                                                                                                                    'Push '
                                                                                                                    '( '
                                                                                                                    'item '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    '} '
                                                                                                                    'return '
                                                                                                                    'stackTemp '
                                                                                                                    '. '
                                                                                                                    'Peek '
                                                                                                                    '( '
                                                                                                                    ') '
                                                                                                                    '; '
                                                                                                                    '}',
 ('BinarySerializer', 'public static void Serialize(BinaryWriter writer, StackItem item, long maxSize, long maxItems)'): '{ '
                                                                                                                         'HashSet '
                                                                                                                         '< '
                                                                                                                         'CompoundType '
                                                                                                                         '> '
                                                                                                                         'serialized '
                                                                                                                         '= '
                                                                                                                         'new '
                                                                                                                         '( '
                                                                                                                         'ReferenceEqualityComparer '
                                                                                                                         '. '
                                                                                                                         'Instance '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'Stack '
                                                                                                                         '< '
                                                                                                                         'StackItem '
                                                                                                                         '> '
                                                                                                                         'unserialized '
                                                                                                                         '= '
                                                                                                                         'new '
                                                                                                                         '( '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'unserialized '
                                                                                                                         '. '
                                                                                                                         'Push '
                                                                                                                         '( '
                                                                                                                         'item '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'while '
                                                                                                                         '( '
                                                                                                                         'unserialized '
                                                                                                                         '. '
                                                                                                                         'Count '
                                                                                                                         '> '
                                                                                                                         '0 '
                                                                                                                         ') '
                                                                                                                         '{ '
                                                                                                                         'if '
                                                                                                                         '( '
                                                                                                                         '-- '
                                                                                                                         'maxItems '
                                                                                                                         '< '
                                                                                                                         '0 '
                                                                                                                         ') '
                                                                                                                         'throw '
                                                                                                                         'new '
                                                                                                                         'FormatException '
                                                                                                                         '( '
                                                                                                                         '"Too '
                                                                                                                         'many '
                                                                                                                         'items '
                                                                                                                         'to '
                                                                                                                         'serialize" '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'item '
                                                                                                                         '= '
                                                                                                                         'unserialized '
                                                                                                                         '. '
                                                                                                                         'Pop '
                                                                                                                         '( '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'writer '
                                                                                                                         '. '
                                                                                                                         'Write '
                                                                                                                         '( '
                                                                                                                         '( '
                                                                                                                         'byte '
                                                                                                                         ') '
                                                                                                                         'item '
                                                                                                                         '. '
                                                                                                                         'Type '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'switch '
                                                                                                                         '( '
                                                                                                                         'item '
                                                                                                                         ') '
                                                                                                                         '{ '
                                                                                                                         'case '
                                                                                                                         'Null '
                                                                                                                         '_ '
                                                                                                                         ': '
                                                                                                                         'break '
                                                                                                                         '; '
                                                                                                                         'case '
                                                                                                                         'Boolean '
                                                                                                                         '_ '
                                                                                                                         ': '
                                                                                                                         'writer '
                                                                                                                         '. '
                                                                                                                         'Write '
                                                                                                                         '( '
                                                                                                                         'item '
                                                                                                                         '. '
                                                                                                                         'GetBoolean '
                                                                                                                         '( '
                                                                                                                         ') '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'break '
                                                                                                                         '; '
                                                                                                                         'case '
                                                                                                                         'Integer '
                                                                                                                         '_ '
                                                                                                                         ': '
                                                                                                                         'case '
                                                                                                                         'ByteString '
                                                                                                                         '_ '
                                                                                                                         ': '
                                                                                                                         'case '
                                                                                                                         'Buffer '
                                                                                                                         '_ '
                                                                                                                         ': '
                                                                                                                         'writer '
                                                                                                                         '. '
                                                                                                                         'WriteVarBytes '
                                                                                                                         '( '
                                                                                                                         'item '
                                                                                                                         '. '
                                                                                                                         'GetSpan '
                                                                                                                         '( '
                                                                                                                         ') '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'break '
                                                                                                                         '; '
                                                                                                                         'case '
                                                                                                                         'Array '
                                                                                                                         'array '
                                                                                                                         ': '
                                                                                                                         'if '
                                                                                                                         '( '
                                                                                                                         '! '
                                                                                                                         'serialized '
                                                                                                                         '. '
                                                                                                                         'Add '
                                                                                                                         '( '
                                                                                                                         'array '
                                                                                                                         ') '
                                                                                                                         ') '
                                                                                                                         'throw '
                                                                                                                         'new '
                                                                                                                         'NotSupportedException '
                                                                                                                         '( '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'writer '
                                                                                                                         '. '
                                                                                                                         'WriteVarInt '
                                                                                                                         '( '
                                                                                                                         'array '
                                                                                                                         '. '
                                                                                                                         'Count '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'for '
                                                                                                                         '( '
                                                                                                                         'int '
                                                                                                                         'i '
                                                                                                                         '= '
                                                                                                                         'array '
                                                                                                                         '. '
                                                                                                                         'Count '
                                                                                                                         '- '
                                                                                                                         '1 '
                                                                                                                         '; '
                                                                                                                         'i '
                                                                                                                         '>= '
                                                                                                                         '0 '
                                                                                                                         '; '
                                                                                                                         'i '
                                                                                                                         '-- '
                                                                                                                         ') '
                                                                                                                         'unserialized '
                                                                                                                         '. '
                                                                                                                         'Push '
                                                                                                                         '( '
                                                                                                                         'array '
                                                                                                                         '[ '
                                                                                                                         'i '
                                                                                                                         '] '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'break '
                                                                                                                         '; '
                                                                                                                         'case '
                                                                                                                         'Map '
                                                                                                                         'map '
                                                                                                                         ': '
                                                                                                                         'if '
                                                                                                                         '( '
                                                                                                                         '! '
                                                                                                                         'serialized '
                                                                                                                         '. '
                                                                                                                         'Add '
                                                                                                                         '( '
                                                                                                                         'map '
                                                                                                                         ') '
                                                                                                                         ') '
                                                                                                                         'throw '
                                                                                                                         'new '
                                                                                                                         'NotSupportedException '
                                                                                                                         '( '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'writer '
                                                                                                                         '. '
                                                                                                                         'WriteVarInt '
                                                                                                                         '( '
                                                                                                                         'map '
                                                                                                                         '. '
                                                                                                                         'Count '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'foreach '
                                                                                                                         '( '
                                                                                                                         'var '
                                                                                                                         'pair '
                                                                                                                         'in '
                                                                                                                         'map '
                                                                                                                         '. '
                                                                                                                         'Reverse '
                                                                                                                         '( '
                                                                                                                         ') '
                                                                                                                         ') '
                                                                                                                         '{ '
                                                                                                                         'unserialized '
                                                                                                                         '. '
                                                                                                                         'Push '
                                                                                                                         '( '
                                                                                                                         'pair '
                                                                                                                         '. '
                                                                                                                         'Value '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'unserialized '
                                                                                                                         '. '
                                                                                                                         'Push '
                                                                                                                         '( '
                                                                                                                         'pair '
                                                                                                                         '. '
                                                                                                                         'Key '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         '} '
                                                                                                                         'break '
                                                                                                                         '; '
                                                                                                                         'default '
                                                                                                                         ': '
                                                                                                                         'throw '
                                                                                                                         'new '
                                                                                                                         'NotSupportedException '
                                                                                                                         '( '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         '} '
                                                                                                                         'writer '
                                                                                                                         '. '
                                                                                                                         'Flush '
                                                                                                                         '( '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         'if '
                                                                                                                         '( '
                                                                                                                         'writer '
                                                                                                                         '. '
                                                                                                                         'BaseStream '
                                                                                                                         '. '
                                                                                                                         'Position '
                                                                                                                         '> '
                                                                                                                         'maxSize '
                                                                                                                         ') '
                                                                                                                         'throw '
                                                                                                                         'new '
                                                                                                                         'InvalidOperationException '
                                                                                                                         '( '
                                                                                                                         ') '
                                                                                                                         '; '
                                                                                                                         '} '
                                                                                                                         '}',
 ('StdLib', 'private static byte[] Serialize(ApplicationEngine engine, StackItem item)'): '{ return '
                                                                                          'BinarySerializer '
                                                                                          '. Serialize ( '
                                                                                          'item , engine . '
                                                                                          'Limits ) ; }',
 ('StdLib', 'private static StackItem Deserialize(ApplicationEngine engine, byte[] data)'): '{ return '
                                                                                            'BinarySerializer '
                                                                                            '. Deserialize ( '
                                                                                            'data , engine . '
                                                                                            'Limits ) ; }',
 ('MemoryReader', 'public ulong ReadVarInt(ulong max = ulong.MaxValue)'): '{ var b = ReadByte ( ) ; var '
                                                                          'value = b switch { 0xfd => '
                                                                          'ReadUInt16 ( ) , 0xfe => '
                                                                          'ReadUInt32 ( ) , 0xff => '
                                                                          'ReadUInt64 ( ) , _ => b } ; if ( '
                                                                          'value > max ) throw new '
                                                                          'FormatException ( $ "VarInt value '
                                                                          'is greater than max: '
                                                                          '{value}/{max}" ) ; return value ; '
                                                                          '}',
 ('MemoryReader', 'public ReadOnlyMemory<byte> ReadMemory(int count)'): '{ EnsurePosition ( count ) ; var '
                                                                        'result = _memory . Slice ( _pos , '
                                                                        'count ) ; _pos += count ; return '
                                                                        'result ; }',
 ('BinaryWriterExtensions', 'public static void WriteVarBytes(this BinaryWriter writer, ReadOnlySpan<byte> value)'): '{ '
                                                                                                                     'writer '
                                                                                                                     '. '
                                                                                                                     'WriteVarInt '
                                                                                                                     '( '
                                                                                                                     'value '
                                                                                                                     '. '
                                                                                                                     'Length '
                                                                                                                     ') '
                                                                                                                     '; '
                                                                                                                     'writer '
                                                                                                                     '. '
                                                                                                                     'Write '
                                                                                                                     '( '
                                                                                                                     'value '
                                                                                                                     ') '
                                                                                                                     '; '
                                                                                                                     '}',
 ('BinaryWriterExtensions', 'public static void WriteVarInt(this BinaryWriter writer, long value)'): '{ if ( '
                                                                                                     'value '
                                                                                                     '< 0 ) '
                                                                                                     'throw '
                                                                                                     'new '
                                                                                                     'ArgumentOutOfRangeException '
                                                                                                     '( '
                                                                                                     'nameof '
                                                                                                     '( '
                                                                                                     'value '
                                                                                                     ') , '
                                                                                                     '"cannot '
                                                                                                     'be '
                                                                                                     'negative" '
                                                                                                     ') ; if '
                                                                                                     '( '
                                                                                                     'value '
                                                                                                     '< 0xFD '
                                                                                                     ') { '
                                                                                                     'writer '
                                                                                                     '. '
                                                                                                     'Write '
                                                                                                     '( ( '
                                                                                                     'byte ) '
                                                                                                     'value '
                                                                                                     ') ; } '
                                                                                                     'else '
                                                                                                     'if ( '
                                                                                                     'value '
                                                                                                     '<= '
                                                                                                     '0xFFFF '
                                                                                                     ') { '
                                                                                                     'writer '
                                                                                                     '. '
                                                                                                     'Write '
                                                                                                     '( ( '
                                                                                                     'byte ) '
                                                                                                     '0xFD ) '
                                                                                                     '; '
                                                                                                     'writer '
                                                                                                     '. '
                                                                                                     'Write '
                                                                                                     '( ( '
                                                                                                     'ushort '
                                                                                                     ') '
                                                                                                     'value '
                                                                                                     ') ; } '
                                                                                                     'else '
                                                                                                     'if ( '
                                                                                                     'value '
                                                                                                     '<= '
                                                                                                     '0xFFFFFFFF '
                                                                                                     ') { '
                                                                                                     'writer '
                                                                                                     '. '
                                                                                                     'Write '
                                                                                                     '( ( '
                                                                                                     'byte ) '
                                                                                                     '0xFE ) '
                                                                                                     '; '
                                                                                                     'writer '
                                                                                                     '. '
                                                                                                     'Write '
                                                                                                     '( ( '
                                                                                                     'uint ) '
                                                                                                     'value '
                                                                                                     ') ; } '
                                                                                                     'else { '
                                                                                                     'writer '
                                                                                                     '. '
                                                                                                     'Write '
                                                                                                     '( ( '
                                                                                                     'byte ) '
                                                                                                     '0xFF ) '
                                                                                                     '; '
                                                                                                     'writer '
                                                                                                     '. '
                                                                                                     'Write '
                                                                                                     '( '
                                                                                                     'value '
                                                                                                     ') ; } '
                                                                                                     '}',
 ('Integer', 'public Integer(BigInteger value)'): '{ if ( value . IsZero ) { Size = 0 ; } else { Size = '
                                                  'value . GetByteCount ( ) ; if ( Size > MaxSize ) throw '
                                                  'new ArgumentException ( $ "Integer size {Size} bytes '
                                                  'exceeds maximum allowed size of {MaxSize} bytes." , '
                                                  'nameof ( value ) ) ; } this . value = value ; }',
 ('BinarySerializer', 'public static byte[] Serialize(StackItem item, ExecutionEngineLimits limits)'): '{ '
                                                                                                       'return '
                                                                                                       'Serialize '
                                                                                                       '( '
                                                                                                       'item '
                                                                                                       ', '
                                                                                                       'limits '
                                                                                                       '. '
                                                                                                       'MaxItemSize '
                                                                                                       ', '
                                                                                                       'limits '
                                                                                                       '. '
                                                                                                       'MaxStackSize '
                                                                                                       ') ; '
                                                                                                       '}',
 ('BinarySerializer', 'public static byte[] Serialize(StackItem item, long maxSize, long maxItems)'): '{ '
                                                                                                      'using '
                                                                                                      'MemoryStream '
                                                                                                      'ms = '
                                                                                                      'new ( '
                                                                                                      ') ; '
                                                                                                      'using '
                                                                                                      'BinaryWriter '
                                                                                                      'writer '
                                                                                                      '= new '
                                                                                                      '( ms '
                                                                                                      ', '
                                                                                                      'Utility '
                                                                                                      '. '
                                                                                                      'StrictUTF8 '
                                                                                                      ', '
                                                                                                      'true '
                                                                                                      ') ; '
                                                                                                      'Serialize '
                                                                                                      '( '
                                                                                                      'writer '
                                                                                                      ', '
                                                                                                      'item '
                                                                                                      ', '
                                                                                                      'maxSize '
                                                                                                      ', '
                                                                                                      'maxItems '
                                                                                                      ') ; '
                                                                                                      'writer '
                                                                                                      '. '
                                                                                                      'Flush '
                                                                                                      '( ) ; '
                                                                                                      'return '
                                                                                                      'ms . '
                                                                                                      'ToArray '
                                                                                                      '( ) ; '
                                                                                                      '}',
 ('MemoryReader', 'private readonly void EnsurePosition(int move)'): '{ if ( _pos + move > _span . Length ) '
                                                                     'throw new FormatException ( $ '
                                                                     '"Position {_pos} + Wanted {move} is '
                                                                     'exceeded boundary({_span.Length})" ) ; '
                                                                     '}',
 ('MemoryReader', 'public byte ReadByte()'): '{ EnsurePosition ( 1 ) ; return _span [ _pos ++ ] ; }',
 ('MemoryReader', 'public ushort ReadUInt16()'): '{ EnsurePosition ( sizeof ( ushort ) ) ; var result = '
                                                 'BinaryPrimitives . ReadUInt16LittleEndian ( _span [ _pos . '
                                                 '. ] ) ; _pos += sizeof ( ushort ) ; return result ; }',
 ('MemoryReader', 'public uint ReadUInt32()'): '{ EnsurePosition ( sizeof ( uint ) ) ; var result = '
                                               'BinaryPrimitives . ReadUInt32LittleEndian ( _span [ _pos . . '
                                               '] ) ; _pos += sizeof ( uint ) ; return result ; }',
 ('MemoryReader', 'public ulong ReadUInt64()'): '{ EnsurePosition ( sizeof ( ulong ) ) ; var result = '
                                                'BinaryPrimitives . ReadUInt64LittleEndian ( _span [ _pos . '
                                                '. ] ) ; _pos += sizeof ( ulong ) ; return result ; }',
 ('PrimitiveType', 'public sealed override ReadOnlySpan<byte> GetSpan()'): '{ return Memory . Span ; }',
 ('ByteString', 'public ByteString(ReadOnlyMemory<byte> data)'): '{ Memory = data ; }',
 ('Buffer', 'public override ReadOnlySpan<byte> GetSpan()'): '{ return InnerBuffer . Span ; }',
 ('Buffer', 'public Buffer(int size, bool zeroInitialize = true)'): '{ _buffer = ArrayPool < byte > . Shared '
                                                                    '. Rent ( size ) ; InnerBuffer = new '
                                                                    'Memory < byte > ( _buffer , 0 , size ) '
                                                                    '; if ( zeroInitialize ) InnerBuffer . '
                                                                    'Span . Clear ( ) ; }',
 ('Buffer', 'public Buffer(ReadOnlySpan<byte> data) : this(data.Length, false)'): '{ data . CopyTo ( '
                                                                                  'InnerBuffer . Span ) ; }'}

def source_evidence(cache=None):
    cache = Path(cache) if cache else Path(tempfile.gettempdir()) / 'aa-pinned-ledger-codec-3101'
    cache.mkdir(parents=True, exist_ok=True)
    result = {}
    for name, (repo, commit, relative, expected) in SOURCE_FILES.items():
        path = cache / (name + '.cs')
        url = f'https://raw.githubusercontent.com/neo-project/{repo}/{commit}/{relative}'
        if not path.exists():
            raw = urllib.request.urlopen(url, timeout=30).read()
            require(hashlib.sha256(raw).hexdigest() == expected, 'Downloaded source digest mismatch')
            path.write_bytes(raw)
        raw = path.read_bytes()
        require(hashlib.sha256(raw).hexdigest() == expected, 'Pinned source digest mismatch: ' + name)
        result[name] = dict(path=str(path.resolve()), sha256=expected, url=url, source=raw.decode())
    validate_sources(result)
    return result


def validate_sources(evidence):
    require(set(evidence) == set(SOURCE_FILES), 'Incomplete pinned source set')
    facts = []
    for (name, signature), expected_body in METHOD_BODIES.items():
        actual = method_tokens(evidence[name]['source'], signature)
        require(actual == tokens(expected_body), 'Executable source changed: ' + name + ':' + signature)
        facts.append(name + ':' + signature)
    stream = tokens(evidence['Integer']['source'])
    required = 'public override ReadOnlyMemory<byte> Memory => value.IsZero ? ReadOnlyMemory<byte>.Empty : value.ToByteArray();'
    needle = tokens(required)
    require(sum(stream[i:i+len(needle)] == needle for i in range(len(stream)-len(needle)+1)) == 1, 'Integer serialization expression changed')
    for name, text in [
        ('Integer', 'public const int MaxSize = 32;'),
        ('MemoryReader', 'public ReadOnlyMemory<byte> ReadVarMemory(int max = 0x1000000) => ReadMemory((int)ReadVarInt((ulong)max));'),
        ('ByteString', 'public override StackItemType Type => StackItemType.ByteString;'),
        ('Buffer', 'public override StackItemType Type => StackItemType.Buffer;')]:
        haystack, expected = tokens(evidence[name]['source']), tokens(text)
        require(sum(haystack[i:i+len(expected)] == expected for i in range(len(haystack)-len(expected)+1)) == 1, 'Codec expression changed: ' + name)
    tags = tokens(evidence['StackItemType']['source'])
    for name, value in TAGS.items():
        needle = [name, '=', hex(value)]
        require(any([x.lower() if x.startswith('0x') else x for x in tags[i:i+3]] == needle for i in range(len(tags)-2)), 'VM tag changed: ' + name)
    struct = tokens(evidence['Struct']['source'])
    for text in ('public class Struct : Array', 'public override StackItemType Type => StackItemType.Struct;'):
        needle = tokens(text)
        require(sum(struct[i:i+len(needle)] == needle for i in range(len(struct)-len(needle)+1)) == 1, 'Struct serialization inheritance changed')
    return dict(checkedMethodBodies=facts, facts={
        'IntegerZeroPayload': 'empty', 'IntegerNonzeroPayload': 'signed-little-endian .NET ToByteArray',
        'IntegerMaximumBytes': 32, 'containerOrder': 'forward field order via reversed stack push',
        'nonminimalVarintsAccepted': True, 'trailingBytesAccepted': True,
        'ArrayStructTagsPreserved': True, 'ByteStringBufferTagsPreserved': True})


# Closed C# syntax frontend for the two actual BinarySerializer core bodies.
# Every token is consumed into an AST. This is a small explicit source dialect,
# not Roslyn/CLR equivalence. Calls to VM/.NET primitives below are a stated TCB.
SERIALIZE_SIGNATURE = 'public static void Serialize(BinaryWriter writer, StackItem item, long maxSize, long maxItems)'
DESERIALIZE_SIGNATURE = 'public static StackItem Deserialize(ref MemoryReader reader, uint maxSize, uint maxItems)'


class CodecSourceParser:
    PRECEDENCE = {'=': 1, '+=': 1, '||': 2, '&&': 3, '==': 4, '!=': 4,
                  '<': 5, '>': 5, '<=': 5, '>=': 5, 'is': 5,
                  '+': 6, '-': 6, '*': 7}
    TYPES = {'var', 'int', 'StackItem', 'Array', 'Struct', 'Map', 'Stack', 'HashSet'}
    CASTS = {'int', 'uint', 'byte', 'StackItemType', 'PrimitiveType'}

    def __init__(self, stream):
        self.stream, self.pos = stream, 0

    def peek(self):
        return self.stream[self.pos] if self.pos < len(self.stream) else '<EOF>'

    def pop(self, expected=None):
        value = self.peek()
        require(value != '<EOF>' and (expected is None or value == expected),
                'Unsupported codec source syntax at token '+str(self.pos)+': expected '+str(expected)+', found '+value)
        self.pos += 1
        return value

    def typename(self):
        name = self.pop()
        if self.peek() == '<':
            name += self.pop() + self.pop() + self.pop('>')
        return name

    def name(self):
        # C# permits @struct as an identifier. Preserve the name, not keyword semantics.
        prefix = self.pop() if self.peek() == '@' else ''
        value = self.pop()
        require(re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', value) is not None, 'Expected source identifier')
        return prefix + value

    def arguments(self):
        self.pop('(')
        args = []
        if self.peek() != ')':
            while True:
                args.append(self.expression())
                if self.peek() != ',':
                    break
                self.pop(',')
        self.pop(')')
        return args

    def expression(self, minimum=0):
        token = self.peek()
        if token in ('!', '--', '++', '-'):
            self.pop()
            left = ['unary', token, self.expression(8)]
        elif token == '(':
            self.pop()
            if self.peek() in self.CASTS and self.pos+1 < len(self.stream) and self.stream[self.pos+1] == ')':
                cast = self.pop()
                self.pop(')')
                left = ['cast', cast, self.expression(8)]
            else:
                left = self.expression()
                self.pop(')')
        elif token == 'new':
            self.pop()
            kind = None if self.peek() == '(' else self.typename()
            left = ['new', kind, self.arguments()]
        elif token.isdecimal() or token.startswith('0x'):
            left = ['literal', int(self.pop(), 0) if token.startswith('0x') else int(self.pop())]
        elif token in ('true', 'false'):
            left = ['literal', self.pop() == 'true']
        else:
            left = ['name', self.name()]
        while True:
            token = self.peek()
            if token == '.':
                self.pop()
                left = ['member', left, self.name()]
            elif token == '[':
                self.pop()
                index = self.expression()
                self.pop(']')
                left = ['index', left, index]
            elif token == '(':
                left = ['call', left, self.arguments()]
            elif token in ('++', '--'):
                left = ['postfix', self.pop(), left]
            elif token in self.PRECEDENCE and self.PRECEDENCE[token] >= minimum:
                operator = self.pop()
                if operator == 'is':
                    left = ['is', left, self.typename(), self.name()]
                else:
                    right = self.expression(self.PRECEDENCE[operator] + (0 if operator in ('=', '+=') else 1))
                    left = ['binary', operator, left, right]
            else:
                return left

    def statement(self, *, terminator=True):
        token = self.peek()
        if token == '{':
            self.pop()
            body = []
            while self.peek() != '}':
                body.append(self.statement())
            self.pop('}')
            return ['block', body]
        if token in ('while', 'if'):
            self.pop()
            self.pop('(')
            condition = self.expression()
            self.pop(')')
            body = self.statement()
            if token == 'while':
                return ['while', condition, body]
            alternate = None
            if self.peek() == 'else':
                self.pop()
                alternate = self.statement()
            return ['if', condition, body, alternate]
        if token == 'for':
            self.pop()
            self.pop('(')
            initialize = self.statement()
            condition = self.expression()
            self.pop(';')
            increment = self.expression()
            self.pop(')')
            return ['for', initialize, condition, increment, self.statement()]
        if token == 'foreach':
            self.pop()
            self.pop('(')
            declared_type, name = self.typename(), self.name()
            self.pop('in')
            collection = self.expression()
            self.pop(')')
            return ['foreach', declared_type, name, collection, self.statement()]
        if token == 'switch':
            self.pop()
            self.pop('(')
            value = self.expression()
            self.pop(')')
            self.pop('{')
            arms = []
            while self.peek() != '}':
                labels = []
                while self.peek() in ('case', 'default'):
                    label = self.pop()
                    if label == 'default':
                        labels.append(['default'])
                    else:
                        typename = self.typename()
                        if self.peek() == '.':
                            self.pop()
                            labels.append(['enum', typename, self.name()])
                        else:
                            labels.append(['pattern', typename, self.name()])
                    self.pop(':')
                require(labels, 'Switch arm without a label')
                body = []
                while self.peek() not in ('case', 'default', '}'):
                    body.append(self.statement())
                arms.append([labels, ['block', body]])
            self.pop('}')
            return ['switch', value, arms]
        if token == 'throw':
            self.pop()
            self.pop('new')
            exception = self.typename()
            self.pop('(')
            # Exception text has no data/control effect in this dialect. Parse its
            # exact token sequence (including interpolation) and retain it in AST.
            message, depth = [], 1
            while depth:
                value = self.pop()
                depth += (value == '(') - (value == ')')
                if depth:
                    message.append(value)
            self.pop(';')
            return ['throw', exception, message]
        if token == 'break':
            self.pop()
            self.pop(';')
            return ['break']
        if token == 'return':
            self.pop()
            value = self.expression()
            self.pop(';')
            return ['return', value]
        if token in self.TYPES:
            declared_type, name = self.typename(), self.name()
            self.pop('=')
            value = self.expression()
            result = ['declare', declared_type, name, value]
        else:
            result = ['expression', self.expression()]
        if terminator:
            self.pop(';')
        return result

    def program(self):
        result = self.statement()
        require(self.pos == len(self.stream), 'Unconsumed codec source tokens')
        return result


def project_codec_source(source):
    """Parse actual method bodies, without deriving control flow from codec output."""
    methods = {}
    for name, signature in [('serialize', SERIALIZE_SIGNATURE), ('deserialize', DESERIALIZE_SIGNATURE)]:
        stream = method_tokens(source, signature)
        methods[name] = {'signature': signature, 'tokenCount': len(stream),
                         'ast': CodecSourceParser(stream).program()}
    return {'dialect': 'closed-binaryserializer-csharp-core/v1',
            'sourceSha256': hashlib.sha256(source.encode()).hexdigest(), 'methods': methods,
            'externalContracts': ['C# scalar arithmetic and ordered evaluation on admitted bounds',
                                  'System.Collections.Generic Stack/HashSet reference identity',
                                  'VM StackItem conversion, Array/Struct inheritance and field order',
                                  'BinaryWriter varbytes/varint and MemoryReader primitive operations',
                                  '.NET BigInteger signed little-endian bytes and Neo Integer zero-empty override']}


@dataclass(eq=False)
class SourceVmItem:
    kind: str
    value: object


@dataclass(eq=False)
class SourcePlaceholder:
    kind: int
    count: int


class SourceStack:
    def __init__(self):
        self.items = []

    def push(self, value):
        if type(value) is int:
            value = SourceVmItem('Integer', value)
        elif type(value) is bool:
            value = SourceVmItem('Boolean', value)
        elif type(value) is bytes:
            value = SourceVmItem('ByteString', value)
        self.items.append(value)


class SourceReader:
    def __init__(self, data):
        self.data, self.position = data, 0

    def read(self, size):
        require(type(size) is int and size >= 0 and self.position+size <= len(self.data), 'Source reader bounds fault')
        raw = self.data[self.position:self.position+size]
        self.position += size
        return raw

    def varint(self, maximum=(1 << 64)-1):
        first = self.read(1)[0]
        value = int.from_bytes(self.read({253: 2, 254: 4, 255: 8}[first]), 'little') if first >= 253 else first
        require(value <= maximum, 'Source varint maximum fault')
        return value

    def varmemory(self, maximum):
        return self.read(self.varint(maximum))


class SourceWriter:
    def __init__(self):
        self.data = bytearray()

    def varint(self, value):
        require(type(value) is int and 0 <= value <= (1 << 63)-1, 'Source WriteVarInt long bounds')
        if value < 253:
            self.data.append(value)
        elif value <= 65535:
            self.data.extend(b'\xfd'+value.to_bytes(2, 'little'))
        elif value <= 0xffffffff:
            self.data.extend(b'\xfe'+value.to_bytes(4, 'little'))
        else:
            self.data.extend(b'\xff'+value.to_bytes(8, 'little'))


def source_integer_span(value):
    require(-(1 << 255) <= value < (1 << 255), 'Source Integer exceeds VM signed-256 bounds')
    if value == 0:
        return b''
    # Deliberately independent of encode_integer: platform signed conversion.
    for width in range(1, 33):
        try:
            return value.to_bytes(width, 'little', signed=True)
        except OverflowError:
            pass
    raise CodecError('Source integer serialization overflow')


class SourceReturn(Exception):
    def __init__(self, value):
        self.value = value


class SourceBreak(Exception):
    pass


class CodecSourceInterpreter:
    """Evaluate parsed C# core AST with explicit VM/.NET primitive contracts."""
    ALL_TAGS = dict(TAGS, Any=0, Boolean=32, Map=72)

    def __init__(self, environment, fuel=20000):
        self.env, self.fuel = dict(environment), fuel

    def tick(self):
        self.fuel -= 1
        require(self.fuel >= 0, 'Source interpreter fuel exhausted')

    def matches(self, value, typename):
        if typename == 'ContainerPlaceholder':
            return type(value) is SourcePlaceholder
        return type(value) is SourceVmItem and (value.kind == typename or typename == 'Array' and value.kind == 'Struct' or typename == 'Null' and value.kind == 'Any')

    def member(self, value, name):
        if isinstance(value, tuple) and value[0] == 'type':
            typename = value[1]
            if typename == 'StackItemType':
                require(name in self.ALL_TAGS, 'Unknown source stack type')
                return self.ALL_TAGS[name]
            if typename == 'Integer' and name == 'MaxSize':
                return 32
            if typename == 'StackItem' and name == 'Null':
                return SourceVmItem('Any', None)
            if typename == 'ReferenceEqualityComparer' and name == 'Instance':
                return ('reference-comparer',)
        if type(value) is SourcePlaceholder:
            return {'Type': value.kind, 'ElementCount': value.count}[name]
        if type(value) is SourceVmItem:
            if name == 'Type':
                return self.ALL_TAGS[value.kind]
            if name == 'Count':
                return len(value.value)
        if type(value) is SourceStack and name == 'Count':
            return len(value.items)
        if type(value) is bytes and name == 'Span':
            return value
        if type(value) is SourceWriter:
            if name == 'BaseStream':
                return value
            if name == 'Position':
                return len(value.data)
        if isinstance(value, tuple) and len(value) == 2 and name in ('Key', 'Value'):
            return value[0 if name == 'Key' else 1]
        return ('method', value, name)

    def invoke(self, target, arguments):
        require(isinstance(target, tuple) and target[0] == 'method', 'Unsupported source call target')
        _, receiver, method = target
        if type(receiver) is SourceStack:
            if method == 'Push':
                require(len(arguments) == 1, 'Push arity')
                receiver.push(arguments[0])
                return None
            if method in ('Pop', 'Peek'):
                require(not arguments and receiver.items, 'Source stack underflow or wrong arity')
                return receiver.items.pop() if method == 'Pop' else receiver.items[-1]
        if type(receiver) is SourceVmItem:
            if method == 'GetSpan':
                require(not arguments and receiver.kind in ('Integer', 'ByteString', 'Buffer'), 'Invalid GetSpan')
                return source_integer_span(receiver.value) if receiver.kind == 'Integer' else receiver.value
            if method == 'GetBoolean':
                require(not arguments and receiver.kind == 'Boolean', 'Invalid GetBoolean')
                return receiver.value
            if method == 'Add':
                require(len(arguments) == 1 and receiver.kind in ('Array', 'Struct'), 'Invalid array Add')
                receiver.value.append(arguments[0])
                return None
            if method == 'Reverse':
                require(not arguments and receiver.kind == 'Map', 'Invalid Map.Reverse')
                return list(reversed(list(receiver.value.items())))
        if type(receiver) is set and method == 'Add':
            require(len(arguments) == 1, 'Set.Add arity')
            identity = id(arguments[0])
            result = identity not in receiver
            receiver.add(identity)
            return result
        if type(receiver) is SourceReader:
            if method == 'ReadByte':
                require(not arguments, 'ReadByte arity')
                return receiver.read(1)[0]
            if method == 'ReadBoolean':
                require(not arguments, 'ReadBoolean arity')
                return receiver.read(1)[0] != 0
            if method == 'ReadVarInt':
                require(len(arguments) == 1, 'ReadVarInt arity')
                return receiver.varint(arguments[0])
            if method == 'ReadVarMemory':
                require(len(arguments) == 1, 'ReadVarMemory arity')
                return receiver.varmemory(arguments[0])
        if type(receiver) is SourceWriter:
            if method == 'Flush':
                require(not arguments, 'Flush arity')
                return None
            require(len(arguments) == 1, 'Writer arity')
            if method == 'Write':
                value = int(arguments[0])
                require(0 <= value <= 255, 'Writer byte range')
                receiver.data.append(value)
                return None
            if method == 'WriteVarInt':
                receiver.varint(arguments[0])
                return None
            if method == 'WriteVarBytes':
                require(type(arguments[0]) is bytes, 'WriteVarBytes expected bytes')
                receiver.varint(len(arguments[0]))
                receiver.data.extend(arguments[0])
                return None
        raise CodecError('Unsupported source call: '+method)

    def new(self, kind, arguments):
        if kind == 'Stack<StackItem>':
            require(not arguments, 'Stack constructor arity')
            return SourceStack()
        if kind == 'HashSet<CompoundType>':
            require(arguments == [('reference-comparer',)], 'HashSet comparer changed')
            return set()
        if kind in ('Array', 'Struct', 'Map'):
            require(not arguments, 'Container constructor arity')
            return SourceVmItem(kind, {} if kind == 'Map' else [])
        if kind == 'ContainerPlaceholder':
            require(len(arguments) == 2, 'Placeholder constructor arity')
            return SourcePlaceholder(*arguments)
        if kind == 'BigInteger':
            require(len(arguments) == 1 and type(arguments[0]) is bytes, 'BigInteger constructor input')
            return int.from_bytes(arguments[0], 'little', signed=True)
        if kind.endswith('Exception'):
            return ('exception', kind, arguments)
        if kind == 'Buffer':
            require(len(arguments) == 1 and type(arguments[0]) is bytes, 'Buffer constructor input')
            return SourceVmItem('Buffer', bytes(arguments[0]))
        raise CodecError('Unsupported source constructor: '+str(kind))

    def assign(self, target, value):
        if target[0] == 'name':
            require(target[1] in self.env, 'Assignment to undeclared local')
            self.env[target[1]] = value
        elif target[0] == 'index':
            receiver, index = self.expression(target[1]), self.expression(target[2])
            require(type(receiver) is SourceVmItem and receiver.kind == 'Map', 'Unsupported source index assignment')
            receiver.value[index] = value
        else:
            raise CodecError('Unsupported assignment target')
        return value

    def expression(self, node, expected_type=None):
        self.tick()
        kind = node[0]
        if kind == 'literal':
            return node[1]
        if kind == 'stackitem':
            stack = SourceStack()
            stack.push(self.expression(node[1]))
            return stack.items[0]
        if kind == 'string':
            return str(self.expression(node[1]))
        if kind == 'string_join':
            return ''.join(self.expression(part) for part in node[1])
        if kind == 'name':
            if node[1] in self.env:
                return self.env[node[1]]
            require(node[1] in ('StackItemType', 'Integer', 'StackItem', 'ReferenceEqualityComparer'), 'Unknown source name: '+node[1])
            return ('type', node[1])
        if kind == 'member':
            return self.member(self.expression(node[1]), node[2])
        if kind == 'call':
            return self.invoke(self.expression(node[1]), [self.expression(arg) for arg in node[2]])
        if kind == 'new':
            return self.new(node[1] or expected_type, [self.expression(arg) for arg in node[2]])
        if kind == 'index':
            receiver, index = self.expression(node[1]), self.expression(node[2])
            require(type(receiver) is SourceVmItem and receiver.kind in ('Array', 'Struct'), 'Unsupported source index')
            require(type(index) is int and 0 <= index < len(receiver.value), 'Source array index bounds')
            return receiver.value[index]
        if kind == 'cast':
            value = self.expression(node[2])
            if node[1] in ('int', 'uint', 'byte', 'StackItemType'):
                require(type(value) is int, 'Source numeric cast type mismatch')
                if node[1] == 'byte':
                    return value % 256
                if node[1] == 'uint':
                    return value % (1 << 32)
                if node[1] == 'int':
                    return (value+(1 << 31)) % (1 << 32)-(1 << 31)
            return value
        if kind == 'is':
            value = self.expression(node[1])
            result = self.matches(value, node[2])
            if result:
                self.env[node[3]] = value
            return result
        if kind in ('unary', 'postfix'):
            operator, target = node[1:]
            value = self.expression(target)
            if operator == '!':
                return not value
            if operator == '-':
                return -value
            changed = value+(1 if operator == '++' else -1)
            self.assign(target, changed)
            return changed if kind == 'unary' else value
        if kind == 'binary':
            operator, lhs, rhs = node[1:]
            if operator == '=':
                return self.assign(lhs, self.expression(rhs))
            left = self.expression(lhs)
            if operator == '&&':
                return bool(left) and bool(self.expression(rhs))
            if operator == '||':
                return bool(left) or bool(self.expression(rhs))
            right = self.expression(rhs)
            if operator == '+=':
                return self.assign(lhs, left+right)
            return {'+': lambda: left+right, '-': lambda: left-right, '*': lambda: left*right,
                    '<': lambda: left<right, '>': lambda: left>right, '<=': lambda: left<=right,
                    '>=': lambda: left>=right, '==': lambda: left==right, '!=': lambda: left!=right}[operator]()
        raise CodecError('Unsupported source expression: '+kind)

    def statement(self, node):
        self.tick()
        kind = node[0]
        if kind == 'block':
            for child in node[1]:
                self.statement(child)
        elif kind == 'declare':
            self.env[node[2]] = self.expression(node[3], node[1])
        elif kind == 'expression':
            self.expression(node[1])
        elif kind == 'if':
            selected = node[2] if self.expression(node[1]) else node[3]
            if selected is not None:
                self.statement(selected)
        elif kind == 'while':
            while self.expression(node[1]):
                try:
                    self.statement(node[2])
                except SourceBreak:
                    break
        elif kind == 'for':
            self.statement(node[1])
            while self.expression(node[2]):
                try:
                    self.statement(node[4])
                except SourceBreak:
                    break
                self.expression(node[3])
        elif kind == 'foreach':
            for value in self.expression(node[3]):
                self.env[node[2]] = value
                try:
                    self.statement(node[4])
                except SourceBreak:
                    break
        elif kind == 'switch':
            value = self.expression(node[1])
            for labels, body in node[2]:
                matched = False
                for label in labels:
                    if label[0] == 'default':
                        matched = True
                    elif label[0] == 'enum':
                        require(label[1] == 'StackItemType', 'Unknown source enum')
                        matched = value == self.ALL_TAGS[label[2]]
                    elif self.matches(value, label[1]):
                        matched = True
                        if label[2] != '_':
                            self.env[label[2]] = value
                    if matched:
                        break
                if matched:
                    try:
                        self.statement(body)
                    except SourceBreak:
                        pass
                    break
        elif kind == 'break':
            raise SourceBreak()
        elif kind == 'return':
            raise SourceReturn(self.expression(node[1]))
        elif kind == 'throw_expr':
            exception = self.expression(node[1])
            require(isinstance(exception, tuple) and exception[0] == 'exception', 'Invalid source throw value')
            raise CodecError('Source raised '+exception[1])
        elif kind == 'throw':
            raise CodecError('Source raised '+node[1])
        else:
            raise CodecError('Unsupported source statement: '+kind)

    def execute(self, program):
        try:
            self.statement(program)
        except SourceReturn as returned:
            return returned.value
        return None


def source_serialize_ledger(projection, ledger, *, max_size=131070, max_items=2048):
    require(type(ledger) is Ledger and ledger.kind in ('Array', 'Struct') and ledger.hash_kind in ('ByteString', 'Buffer'), 'Source ledger type')
    require(type(ledger.tx_hash) is bytes and len(ledger.tx_hash) == 32 and type(ledger.reserved) is int and 0 <= ledger.reserved < LIMIT, 'Source ledger domain')
    item = SourceVmItem(ledger.kind, [SourceVmItem(ledger.hash_kind, ledger.tx_hash), SourceVmItem('Integer', ledger.reserved)])
    writer = SourceWriter()
    machine = CodecSourceInterpreter(dict(writer=writer, item=item, maxSize=max_size, maxItems=max_items))
    machine.execute(projection['methods']['serialize']['ast'])
    return bytes(writer.data)


def source_deserialize_ledger(projection, data, *, max_size=131070, max_items=2048):
    require(type(data) is bytes, 'Source deserialize requires bytes')
    reader = SourceReader(data)
    machine = CodecSourceInterpreter(dict(reader=reader, maxSize=min(len(data), max_size), maxItems=max_items))
    item = machine.execute(projection['methods']['deserialize']['ast'])
    require(type(item) is SourceVmItem and item.kind in ('Array', 'Struct') and len(item.value) == 2, 'Source ledger container domain')
    tx_hash, reservation = item.value
    require(type(tx_hash) is SourceVmItem and tx_hash.kind in ('ByteString', 'Buffer') and len(tx_hash.value) == 32, 'Source ledger hash domain')
    require(type(reservation) is SourceVmItem and reservation.kind == 'Integer' and 0 <= reservation.value < LIMIT, 'Source ledger integer domain')
    return Ledger(item.kind, tx_hash.value, reservation.value, tx_hash.kind), data[reader.position:]
