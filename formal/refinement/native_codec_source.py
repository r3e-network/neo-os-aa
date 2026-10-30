"""Resolved Roslyn-operation projection for the pinned native codec dialect.

This executes source control flow with declared external primitive contracts.
It is not a theorem about the CLR or the general .NET/Neo runtime.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import ledger_codec as codec

ROOT = Path(__file__).resolve().parent
ROSLYN_SHA256 = '53302acca07700e9bb10dcf21034435d6e0454c8eebf2481164ec13e520004c9'
# Reviewed exact resolved external overloads, including arguments and assemblies.
# The source AST itself is independently interpreted; no expected AST template.
EXTERNAL_SYMBOLS = {'F:Neo.VM.Types.Integer.MaxSize': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                    'display': 'MaxSize',
                                    'id': 'F:Neo.VM.Types.Integer.MaxSize',
                                    'isStatic': True,
                                    'kind': 'Field',
                                    'name': 'MaxSize',
                                    'parameters': None,
                                    'type': 'int'},
 'F:Neo.VM.Types.StackItemType.Any': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                      'display': 'Any',
                                      'id': 'F:Neo.VM.Types.StackItemType.Any',
                                      'isStatic': True,
                                      'kind': 'Field',
                                      'name': 'Any',
                                      'parameters': None,
                                      'type': 'global::Neo.VM.Types.StackItemType'},
 'F:Neo.VM.Types.StackItemType.Array': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                        'display': 'Array',
                                        'id': 'F:Neo.VM.Types.StackItemType.Array',
                                        'isStatic': True,
                                        'kind': 'Field',
                                        'name': 'Array',
                                        'parameters': None,
                                        'type': 'global::Neo.VM.Types.StackItemType'},
 'F:Neo.VM.Types.StackItemType.Boolean': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                          'display': 'Boolean',
                                          'id': 'F:Neo.VM.Types.StackItemType.Boolean',
                                          'isStatic': True,
                                          'kind': 'Field',
                                          'name': 'Boolean',
                                          'parameters': None,
                                          'type': 'global::Neo.VM.Types.StackItemType'},
 'F:Neo.VM.Types.StackItemType.Buffer': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                         'display': 'Buffer',
                                         'id': 'F:Neo.VM.Types.StackItemType.Buffer',
                                         'isStatic': True,
                                         'kind': 'Field',
                                         'name': 'Buffer',
                                         'parameters': None,
                                         'type': 'global::Neo.VM.Types.StackItemType'},
 'F:Neo.VM.Types.StackItemType.ByteString': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                             'display': 'ByteString',
                                             'id': 'F:Neo.VM.Types.StackItemType.ByteString',
                                             'isStatic': True,
                                             'kind': 'Field',
                                             'name': 'ByteString',
                                             'parameters': None,
                                             'type': 'global::Neo.VM.Types.StackItemType'},
 'F:Neo.VM.Types.StackItemType.Integer': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                          'display': 'Integer',
                                          'id': 'F:Neo.VM.Types.StackItemType.Integer',
                                          'isStatic': True,
                                          'kind': 'Field',
                                          'name': 'Integer',
                                          'parameters': None,
                                          'type': 'global::Neo.VM.Types.StackItemType'},
 'F:Neo.VM.Types.StackItemType.Map': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                      'display': 'Map',
                                      'id': 'F:Neo.VM.Types.StackItemType.Map',
                                      'isStatic': True,
                                      'kind': 'Field',
                                      'name': 'Map',
                                      'parameters': None,
                                      'type': 'global::Neo.VM.Types.StackItemType'},
 'F:Neo.VM.Types.StackItemType.Struct': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                         'display': 'Struct',
                                         'id': 'F:Neo.VM.Types.StackItemType.Struct',
                                         'isStatic': True,
                                         'kind': 'Field',
                                         'name': 'Struct',
                                         'parameters': None,
                                         'type': 'global::Neo.VM.Types.StackItemType'},
 'M:Neo.Extensions.BinaryWriterExtensions.WriteVarBytes(System.IO.BinaryWriter,System.ReadOnlySpan{System.Byte})': {'assembly': 'Neo, '
                                                                                                                                'Version=3.10.1.0, '
                                                                                                                                'Culture=neutral, '
                                                                                                                                'PublicKeyToken=null',
                                                                                                                    'display': 'WriteVarBytes',
                                                                                                                    'id': 'M:Neo.Extensions.BinaryWriterExtensions.WriteVarBytes(System.IO.BinaryWriter,System.ReadOnlySpan{System.Byte})',
                                                                                                                    'isStatic': True,
                                                                                                                    'kind': 'Method',
                                                                                                                    'name': 'WriteVarBytes',
                                                                                                                    'parameters': [{'Ordinal': 0,
                                                                                                                                    'name': 'writer',
                                                                                                                                    'refKind': 'None',
                                                                                                                                    'type': 'global::System.IO.BinaryWriter'},
                                                                                                                                   {'Ordinal': 1,
                                                                                                                                    'name': 'value',
                                                                                                                                    'refKind': 'None',
                                                                                                                                    'type': 'global::System.ReadOnlySpan<byte>'}],
                                                                                                                    'type': 'void'},
 'M:Neo.Extensions.BinaryWriterExtensions.WriteVarInt(System.IO.BinaryWriter,System.Int64)': {'assembly': 'Neo, Version=3.10.1.0, '
                                                                                                          'Culture=neutral, '
                                                                                                          'PublicKeyToken=null',
                                                                                              'display': 'WriteVarInt',
                                                                                              'id': 'M:Neo.Extensions.BinaryWriterExtensions.WriteVarInt(System.IO.BinaryWriter,System.Int64)',
                                                                                              'isStatic': True,
                                                                                              'kind': 'Method',
                                                                                              'name': 'WriteVarInt',
                                                                                              'parameters': [{'Ordinal': 0,
                                                                                                              'name': 'writer',
                                                                                                              'refKind': 'None',
                                                                                                              'type': 'global::System.IO.BinaryWriter'},
                                                                                                             {'Ordinal': 1,
                                                                                                              'name': 'value',
                                                                                                              'refKind': 'None',
                                                                                                              'type': 'long'}],
                                                                                              'type': 'void'},
 'M:Neo.IO.MemoryReader.ReadBoolean': {'assembly': 'Neo.IO, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                       'display': 'ReadBoolean',
                                       'id': 'M:Neo.IO.MemoryReader.ReadBoolean',
                                       'isStatic': False,
                                       'kind': 'Method',
                                       'name': 'ReadBoolean',
                                       'parameters': [],
                                       'type': 'bool'},
 'M:Neo.IO.MemoryReader.ReadByte': {'assembly': 'Neo.IO, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                    'display': 'ReadByte',
                                    'id': 'M:Neo.IO.MemoryReader.ReadByte',
                                    'isStatic': False,
                                    'kind': 'Method',
                                    'name': 'ReadByte',
                                    'parameters': [],
                                    'type': 'byte'},
 'M:Neo.IO.MemoryReader.ReadVarInt(System.UInt64)': {'assembly': 'Neo.IO, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                                     'display': 'ReadVarInt',
                                                     'id': 'M:Neo.IO.MemoryReader.ReadVarInt(System.UInt64)',
                                                     'isStatic': False,
                                                     'kind': 'Method',
                                                     'name': 'ReadVarInt',
                                                     'parameters': [{'Ordinal': 0, 'name': 'max', 'refKind': 'None', 'type': 'ulong'}],
                                                     'type': 'ulong'},
 'M:Neo.IO.MemoryReader.ReadVarMemory(System.Int32)': {'assembly': 'Neo.IO, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                                       'display': 'ReadVarMemory',
                                                       'id': 'M:Neo.IO.MemoryReader.ReadVarMemory(System.Int32)',
                                                       'isStatic': False,
                                                       'kind': 'Method',
                                                       'name': 'ReadVarMemory',
                                                       'parameters': [{'Ordinal': 0, 'name': 'max', 'refKind': 'None', 'type': 'int'}],
                                                       'type': 'global::System.ReadOnlyMemory<byte>'},
 'M:Neo.SmartContract.BinarySerializer.ContainerPlaceholder.#ctor(Neo.VM.Types.StackItemType,System.Int32)': {'assembly': 'PinnedNativeCodecSource, '
                                                                                                                          'Version=0.0.0.0, '
                                                                                                                          'Culture=neutral, '
                                                                                                                          'PublicKeyToken=null',
                                                                                                              'display': 'ContainerPlaceholder',
                                                                                                              'id': 'M:Neo.SmartContract.BinarySerializer.ContainerPlaceholder.#ctor(Neo.VM.Types.StackItemType,System.Int32)',
                                                                                                              'isStatic': False,
                                                                                                              'kind': 'Method',
                                                                                                              'name': '.ctor',
                                                                                                              'parameters': [{'Ordinal': 0,
                                                                                                                              'name': 'type',
                                                                                                                              'refKind': 'None',
                                                                                                                              'type': 'global::Neo.VM.Types.StackItemType'},
                                                                                                                             {'Ordinal': 1,
                                                                                                                              'name': 'count',
                                                                                                                              'refKind': 'None',
                                                                                                                              'type': 'int'}],
                                                                                                              'type': 'void'},
 'M:Neo.VM.Types.Array.#ctor(System.Collections.Generic.IEnumerable{Neo.VM.Types.StackItem})': {'assembly': 'Neo.VM, Version=3.10.1.0, '
                                                                                                            'Culture=neutral, '
                                                                                                            'PublicKeyToken=null',
                                                                                                'display': 'Array',
                                                                                                'id': 'M:Neo.VM.Types.Array.#ctor(System.Collections.Generic.IEnumerable{Neo.VM.Types.StackItem})',
                                                                                                'isStatic': False,
                                                                                                'kind': 'Method',
                                                                                                'name': '.ctor',
                                                                                                'parameters': [{'Ordinal': 0,
                                                                                                                'name': 'items',
                                                                                                                'refKind': 'None',
                                                                                                                'type': 'global::System.Collections.Generic.IEnumerable<global::Neo.VM.Types.StackItem>'}],
                                                                                                'type': 'void'},
 'M:Neo.VM.Types.Array.Add(Neo.VM.Types.StackItem)': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                                      'display': 'Add',
                                                      'id': 'M:Neo.VM.Types.Array.Add(Neo.VM.Types.StackItem)',
                                                      'isStatic': False,
                                                      'kind': 'Method',
                                                      'name': 'Add',
                                                      'parameters': [{'Ordinal': 0,
                                                                      'name': 'item',
                                                                      'refKind': 'None',
                                                                      'type': 'global::Neo.VM.Types.StackItem'}],
                                                      'type': 'void'},
 'M:Neo.VM.Types.Buffer.#ctor(System.ReadOnlySpan{System.Byte})': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, '
                                                                               'PublicKeyToken=null',
                                                                   'display': 'Buffer',
                                                                   'id': 'M:Neo.VM.Types.Buffer.#ctor(System.ReadOnlySpan{System.Byte})',
                                                                   'isStatic': False,
                                                                   'kind': 'Method',
                                                                   'name': '.ctor',
                                                                   'parameters': [{'Ordinal': 0,
                                                                                   'name': 'data',
                                                                                   'refKind': 'None',
                                                                                   'type': 'global::System.ReadOnlySpan<byte>'}],
                                                                   'type': 'void'},
 'M:Neo.VM.Types.Map.#ctor': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                              'display': 'Map',
                              'id': 'M:Neo.VM.Types.Map.#ctor',
                              'isStatic': False,
                              'kind': 'Method',
                              'name': '.ctor',
                              'parameters': [],
                              'type': 'void'},
 'M:Neo.VM.Types.StackItem.GetBoolean': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                         'display': 'GetBoolean',
                                         'id': 'M:Neo.VM.Types.StackItem.GetBoolean',
                                         'isStatic': False,
                                         'kind': 'Method',
                                         'name': 'GetBoolean',
                                         'parameters': [],
                                         'type': 'bool'},
 'M:Neo.VM.Types.StackItem.GetSpan': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                      'display': 'GetSpan',
                                      'id': 'M:Neo.VM.Types.StackItem.GetSpan',
                                      'isStatic': False,
                                      'kind': 'Method',
                                      'name': 'GetSpan',
                                      'parameters': [],
                                      'type': 'global::System.ReadOnlySpan<byte>'},
 'M:Neo.VM.Types.StackItem.op_Implicit(System.Boolean)~Neo.VM.Types.StackItem': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, '
                                                                                             'PublicKeyToken=null',
                                                                                 'display': 'implicit operator '
                                                                                            'global::Neo.VM.Types.StackItem',
                                                                                 'id': 'M:Neo.VM.Types.StackItem.op_Implicit(System.Boolean)~Neo.VM.Types.StackItem',
                                                                                 'isStatic': True,
                                                                                 'kind': 'Method',
                                                                                 'name': 'op_Implicit',
                                                                                 'parameters': [{'Ordinal': 0,
                                                                                                 'name': 'value',
                                                                                                 'refKind': 'None',
                                                                                                 'type': 'bool'}],
                                                                                 'type': 'global::Neo.VM.Types.StackItem'},
 'M:Neo.VM.Types.StackItem.op_Implicit(System.Numerics.BigInteger)~Neo.VM.Types.StackItem': {'assembly': 'Neo.VM, Version=3.10.1.0, '
                                                                                                         'Culture=neutral, '
                                                                                                         'PublicKeyToken=null',
                                                                                             'display': 'implicit operator '
                                                                                                        'global::Neo.VM.Types.StackItem',
                                                                                             'id': 'M:Neo.VM.Types.StackItem.op_Implicit(System.Numerics.BigInteger)~Neo.VM.Types.StackItem',
                                                                                             'isStatic': True,
                                                                                             'kind': 'Method',
                                                                                             'name': 'op_Implicit',
                                                                                             'parameters': [{'Ordinal': 0,
                                                                                                             'name': 'value',
                                                                                                             'refKind': 'None',
                                                                                                             'type': 'global::System.Numerics.BigInteger'}],
                                                                                             'type': 'global::Neo.VM.Types.StackItem'},
 'M:Neo.VM.Types.StackItem.op_Implicit(System.ReadOnlyMemory{System.Byte})~Neo.VM.Types.StackItem': {'assembly': 'Neo.VM, '
                                                                                                                 'Version=3.10.1.0, '
                                                                                                                 'Culture=neutral, '
                                                                                                                 'PublicKeyToken=null',
                                                                                                     'display': 'implicit operator '
                                                                                                                'global::Neo.VM.Types.StackItem',
                                                                                                     'id': 'M:Neo.VM.Types.StackItem.op_Implicit(System.ReadOnlyMemory{System.Byte})~Neo.VM.Types.StackItem',
                                                                                                     'isStatic': True,
                                                                                                     'kind': 'Method',
                                                                                                     'name': 'op_Implicit',
                                                                                                     'parameters': [{'Ordinal': 0,
                                                                                                                     'name': 'value',
                                                                                                                     'refKind': 'None',
                                                                                                                     'type': 'global::System.ReadOnlyMemory<byte>'}],
                                                                                                     'type': 'global::Neo.VM.Types.StackItem'},
 'M:Neo.VM.Types.Struct.#ctor(System.Collections.Generic.IEnumerable{Neo.VM.Types.StackItem})': {'assembly': 'Neo.VM, Version=3.10.1.0, '
                                                                                                             'Culture=neutral, '
                                                                                                             'PublicKeyToken=null',
                                                                                                 'display': 'Struct',
                                                                                                 'id': 'M:Neo.VM.Types.Struct.#ctor(System.Collections.Generic.IEnumerable{Neo.VM.Types.StackItem})',
                                                                                                 'isStatic': False,
                                                                                                 'kind': 'Method',
                                                                                                 'name': '.ctor',
                                                                                                 'parameters': [{'Ordinal': 0,
                                                                                                                 'name': 'fields',
                                                                                                                 'refKind': 'None',
                                                                                                                 'type': 'global::System.Collections.Generic.IEnumerable<global::Neo.VM.Types.StackItem>'}],
                                                                                                 'type': 'void'},
 'M:System.Collections.Generic.HashSet{Neo.VM.Types.CompoundType}.#ctor(System.Collections.Generic.IEqualityComparer{Neo.VM.Types.CompoundType})': {'assembly': 'System.Private.CoreLib, '
                                                                                                                                                                'Version=10.0.0.0, '
                                                                                                                                                                'Culture=neutral, '
                                                                                                                                                                'PublicKeyToken=7cec85d7bea7798e',
                                                                                                                                                    'display': 'HashSet',
                                                                                                                                                    'id': 'M:System.Collections.Generic.HashSet{Neo.VM.Types.CompoundType}.#ctor(System.Collections.Generic.IEqualityComparer{Neo.VM.Types.CompoundType})',
                                                                                                                                                    'isStatic': False,
                                                                                                                                                    'kind': 'Method',
                                                                                                                                                    'name': '.ctor',
                                                                                                                                                    'parameters': [{'Ordinal': 0,
                                                                                                                                                                    'name': 'comparer',
                                                                                                                                                                    'refKind': 'None',
                                                                                                                                                                    'type': 'global::System.Collections.Generic.IEqualityComparer<global::Neo.VM.Types.CompoundType>'}],
                                                                                                                                                    'type': 'void'},
 'M:System.Collections.Generic.HashSet{Neo.VM.Types.CompoundType}.Add(Neo.VM.Types.CompoundType)': {'assembly': 'System.Private.CoreLib, '
                                                                                                                'Version=10.0.0.0, '
                                                                                                                'Culture=neutral, '
                                                                                                                'PublicKeyToken=7cec85d7bea7798e',
                                                                                                    'display': 'Add',
                                                                                                    'id': 'M:System.Collections.Generic.HashSet{Neo.VM.Types.CompoundType}.Add(Neo.VM.Types.CompoundType)',
                                                                                                    'isStatic': False,
                                                                                                    'kind': 'Method',
                                                                                                    'name': 'Add',
                                                                                                    'parameters': [{'Ordinal': 0,
                                                                                                                    'name': 'item',
                                                                                                                    'refKind': 'None',
                                                                                                                    'type': 'global::Neo.VM.Types.CompoundType'}],
                                                                                                    'type': 'bool'},
 'M:System.Collections.Generic.Stack{Neo.VM.Types.StackItem}.#ctor': {'assembly': 'System.Collections, Version=10.0.0.0, Culture=neutral, '
                                                                                  'PublicKeyToken=b03f5f7f11d50a3a',
                                                                      'display': 'Stack',
                                                                      'id': 'M:System.Collections.Generic.Stack{Neo.VM.Types.StackItem}.#ctor',
                                                                      'isStatic': False,
                                                                      'kind': 'Method',
                                                                      'name': '.ctor',
                                                                      'parameters': [],
                                                                      'type': 'void'},
 'M:System.Collections.Generic.Stack{Neo.VM.Types.StackItem}.Peek': {'assembly': 'System.Collections, Version=10.0.0.0, Culture=neutral, '
                                                                                 'PublicKeyToken=b03f5f7f11d50a3a',
                                                                     'display': 'Peek',
                                                                     'id': 'M:System.Collections.Generic.Stack{Neo.VM.Types.StackItem}.Peek',
                                                                     'isStatic': False,
                                                                     'kind': 'Method',
                                                                     'name': 'Peek',
                                                                     'parameters': [],
                                                                     'type': 'global::Neo.VM.Types.StackItem'},
 'M:System.Collections.Generic.Stack{Neo.VM.Types.StackItem}.Pop': {'assembly': 'System.Collections, Version=10.0.0.0, Culture=neutral, '
                                                                                'PublicKeyToken=b03f5f7f11d50a3a',
                                                                    'display': 'Pop',
                                                                    'id': 'M:System.Collections.Generic.Stack{Neo.VM.Types.StackItem}.Pop',
                                                                    'isStatic': False,
                                                                    'kind': 'Method',
                                                                    'name': 'Pop',
                                                                    'parameters': [],
                                                                    'type': 'global::Neo.VM.Types.StackItem'},
 'M:System.Collections.Generic.Stack{Neo.VM.Types.StackItem}.Push(Neo.VM.Types.StackItem)': {'assembly': 'System.Collections, '
                                                                                                         'Version=10.0.0.0, '
                                                                                                         'Culture=neutral, '
                                                                                                         'PublicKeyToken=b03f5f7f11d50a3a',
                                                                                             'display': 'Push',
                                                                                             'id': 'M:System.Collections.Generic.Stack{Neo.VM.Types.StackItem}.Push(Neo.VM.Types.StackItem)',
                                                                                             'isStatic': False,
                                                                                             'kind': 'Method',
                                                                                             'name': 'Push',
                                                                                             'parameters': [{'Ordinal': 0,
                                                                                                             'name': 'item',
                                                                                                             'refKind': 'None',
                                                                                                             'type': 'global::Neo.VM.Types.StackItem'}],
                                                                                             'type': 'void'},
 'M:System.FormatException.#ctor(System.String)': {'assembly': 'System.Private.CoreLib, Version=10.0.0.0, Culture=neutral, '
                                                               'PublicKeyToken=7cec85d7bea7798e',
                                                   'display': 'FormatException',
                                                   'id': 'M:System.FormatException.#ctor(System.String)',
                                                   'isStatic': False,
                                                   'kind': 'Method',
                                                   'name': '.ctor',
                                                   'parameters': [{'Ordinal': 0, 'name': 'message', 'refKind': 'None', 'type': 'string'}],
                                                   'type': 'void'},
 'M:System.IO.BinaryWriter.Flush': {'assembly': 'System.Private.CoreLib, Version=10.0.0.0, Culture=neutral, '
                                                'PublicKeyToken=7cec85d7bea7798e',
                                    'display': 'Flush',
                                    'id': 'M:System.IO.BinaryWriter.Flush',
                                    'isStatic': False,
                                    'kind': 'Method',
                                    'name': 'Flush',
                                    'parameters': [],
                                    'type': 'void'},
 'M:System.IO.BinaryWriter.Write(System.Boolean)': {'assembly': 'System.Private.CoreLib, Version=10.0.0.0, Culture=neutral, '
                                                                'PublicKeyToken=7cec85d7bea7798e',
                                                    'display': 'Write',
                                                    'id': 'M:System.IO.BinaryWriter.Write(System.Boolean)',
                                                    'isStatic': False,
                                                    'kind': 'Method',
                                                    'name': 'Write',
                                                    'parameters': [{'Ordinal': 0, 'name': 'value', 'refKind': 'None', 'type': 'bool'}],
                                                    'type': 'void'},
 'M:System.IO.BinaryWriter.Write(System.Byte)': {'assembly': 'System.Private.CoreLib, Version=10.0.0.0, Culture=neutral, '
                                                             'PublicKeyToken=7cec85d7bea7798e',
                                                 'display': 'Write',
                                                 'id': 'M:System.IO.BinaryWriter.Write(System.Byte)',
                                                 'isStatic': False,
                                                 'kind': 'Method',
                                                 'name': 'Write',
                                                 'parameters': [{'Ordinal': 0, 'name': 'value', 'refKind': 'None', 'type': 'byte'}],
                                                 'type': 'void'},
 'M:System.InvalidOperationException.#ctor': {'assembly': 'System.Private.CoreLib, Version=10.0.0.0, Culture=neutral, '
                                                          'PublicKeyToken=7cec85d7bea7798e',
                                              'display': 'InvalidOperationException',
                                              'id': 'M:System.InvalidOperationException.#ctor',
                                              'isStatic': False,
                                              'kind': 'Method',
                                              'name': '.ctor',
                                              'parameters': [],
                                              'type': 'void'},
 'M:System.Linq.Enumerable.Reverse``1(System.Collections.Generic.IEnumerable{System.Collections.Generic.KeyValuePair{Neo.VM.Types.PrimitiveType,Neo.VM.Types.StackItem}})': {'assembly': 'System.Linq, '
                                                                                                                                                                                         'Version=10.0.0.0, '
                                                                                                                                                                                         'Culture=neutral, '
                                                                                                                                                                                         'PublicKeyToken=b03f5f7f11d50a3a',
                                                                                                                                                                             'display': 'Reverse<global::System.Collections.Generic.KeyValuePair<global::Neo.VM.Types.PrimitiveType, '
                                                                                                                                                                                        'global::Neo.VM.Types.StackItem>>',
                                                                                                                                                                             'id': 'M:System.Linq.Enumerable.Reverse``1(System.Collections.Generic.IEnumerable{System.Collections.Generic.KeyValuePair{Neo.VM.Types.PrimitiveType,Neo.VM.Types.StackItem}})',
                                                                                                                                                                             'isStatic': True,
                                                                                                                                                                             'kind': 'Method',
                                                                                                                                                                             'name': 'Reverse',
                                                                                                                                                                             'parameters': [{'Ordinal': 0,
                                                                                                                                                                                             'name': 'source',
                                                                                                                                                                                             'refKind': 'None',
                                                                                                                                                                                             'type': 'global::System.Collections.Generic.IEnumerable<global::System.Collections.Generic.KeyValuePair<global::Neo.VM.Types.PrimitiveType, '
                                                                                                                                                                                                     'global::Neo.VM.Types.StackItem>>'}],
                                                                                                                                                                             'type': 'global::System.Collections.Generic.IEnumerable<global::System.Collections.Generic.KeyValuePair<global::Neo.VM.Types.PrimitiveType, '
                                                                                                                                                                                     'global::Neo.VM.Types.StackItem>>'},
 'M:System.NotSupportedException.#ctor': {'assembly': 'System.Private.CoreLib, Version=10.0.0.0, Culture=neutral, '
                                                      'PublicKeyToken=7cec85d7bea7798e',
                                          'display': 'NotSupportedException',
                                          'id': 'M:System.NotSupportedException.#ctor',
                                          'isStatic': False,
                                          'kind': 'Method',
                                          'name': '.ctor',
                                          'parameters': [],
                                          'type': 'void'},
 'M:System.Numerics.BigInteger.#ctor(System.ReadOnlySpan{System.Byte},System.Boolean,System.Boolean)': {'assembly': 'System.Runtime.Numerics, '
                                                                                                                    'Version=10.0.0.0, '
                                                                                                                    'Culture=neutral, '
                                                                                                                    'PublicKeyToken=b03f5f7f11d50a3a',
                                                                                                        'display': 'BigInteger',
                                                                                                        'id': 'M:System.Numerics.BigInteger.#ctor(System.ReadOnlySpan{System.Byte},System.Boolean,System.Boolean)',
                                                                                                        'isStatic': False,
                                                                                                        'kind': 'Method',
                                                                                                        'name': '.ctor',
                                                                                                        'parameters': [{'Ordinal': 0,
                                                                                                                        'name': 'value',
                                                                                                                        'refKind': 'None',
                                                                                                                        'type': 'global::System.ReadOnlySpan<byte>'},
                                                                                                                       {'Ordinal': 1,
                                                                                                                        'name': 'isUnsigned',
                                                                                                                        'refKind': 'None',
                                                                                                                        'type': 'bool'},
                                                                                                                       {'Ordinal': 2,
                                                                                                                        'name': 'isBigEndian',
                                                                                                                        'refKind': 'None',
                                                                                                                        'type': 'bool'}],
                                                                                                        'type': 'void'},
 'P:Neo.SmartContract.BinarySerializer.ContainerPlaceholder.ElementCount': {'assembly': 'PinnedNativeCodecSource, Version=0.0.0.0, '
                                                                                        'Culture=neutral, PublicKeyToken=null',
                                                                            'display': 'ElementCount',
                                                                            'id': 'P:Neo.SmartContract.BinarySerializer.ContainerPlaceholder.ElementCount',
                                                                            'isStatic': False,
                                                                            'kind': 'Property',
                                                                            'name': 'ElementCount',
                                                                            'parameters': None,
                                                                            'type': 'int'},
 'P:Neo.SmartContract.BinarySerializer.ContainerPlaceholder.Type': {'assembly': 'PinnedNativeCodecSource, Version=0.0.0.0, '
                                                                                'Culture=neutral, PublicKeyToken=null',
                                                                    'display': 'Type',
                                                                    'id': 'P:Neo.SmartContract.BinarySerializer.ContainerPlaceholder.Type',
                                                                    'isStatic': False,
                                                                    'kind': 'Property',
                                                                    'name': 'Type',
                                                                    'parameters': None,
                                                                    'type': 'global::Neo.VM.Types.StackItemType'},
 'P:Neo.VM.Types.Array.Count': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                'display': 'Count',
                                'id': 'P:Neo.VM.Types.Array.Count',
                                'isStatic': False,
                                'kind': 'Property',
                                'name': 'Count',
                                'parameters': None,
                                'type': 'int'},
 'P:Neo.VM.Types.Array.Item(System.Int32)': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                             'display': 'this',
                                             'id': 'P:Neo.VM.Types.Array.Item(System.Int32)',
                                             'isStatic': False,
                                             'kind': 'Property',
                                             'name': 'this[]',
                                             'parameters': None,
                                             'type': 'global::Neo.VM.Types.StackItem'},
 'P:Neo.VM.Types.Map.Count': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                              'display': 'Count',
                              'id': 'P:Neo.VM.Types.Map.Count',
                              'isStatic': False,
                              'kind': 'Property',
                              'name': 'Count',
                              'parameters': None,
                              'type': 'int'},
 'P:Neo.VM.Types.Map.Item(Neo.VM.Types.PrimitiveType)': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                                         'display': 'this',
                                                         'id': 'P:Neo.VM.Types.Map.Item(Neo.VM.Types.PrimitiveType)',
                                                         'isStatic': False,
                                                         'kind': 'Property',
                                                         'name': 'this[]',
                                                         'parameters': None,
                                                         'type': 'global::Neo.VM.Types.StackItem'},
 'P:Neo.VM.Types.StackItem.Null': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                   'display': 'Null',
                                   'id': 'P:Neo.VM.Types.StackItem.Null',
                                   'isStatic': True,
                                   'kind': 'Property',
                                   'name': 'Null',
                                   'parameters': None,
                                   'type': 'global::Neo.VM.Types.StackItem'},
 'P:Neo.VM.Types.StackItem.Type': {'assembly': 'Neo.VM, Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                   'display': 'Type',
                                   'id': 'P:Neo.VM.Types.StackItem.Type',
                                   'isStatic': False,
                                   'kind': 'Property',
                                   'name': 'Type',
                                   'parameters': None,
                                   'type': 'global::Neo.VM.Types.StackItemType'},
 'P:System.Collections.Generic.KeyValuePair{Neo.VM.Types.PrimitiveType,Neo.VM.Types.StackItem}.Key': {'assembly': 'System.Private.CoreLib, '
                                                                                                                  'Version=10.0.0.0, '
                                                                                                                  'Culture=neutral, '
                                                                                                                  'PublicKeyToken=7cec85d7bea7798e',
                                                                                                      'display': 'Key',
                                                                                                      'id': 'P:System.Collections.Generic.KeyValuePair{Neo.VM.Types.PrimitiveType,Neo.VM.Types.StackItem}.Key',
                                                                                                      'isStatic': False,
                                                                                                      'kind': 'Property',
                                                                                                      'name': 'Key',
                                                                                                      'parameters': None,
                                                                                                      'type': 'global::Neo.VM.Types.PrimitiveType'},
 'P:System.Collections.Generic.KeyValuePair{Neo.VM.Types.PrimitiveType,Neo.VM.Types.StackItem}.Value': {'assembly': 'System.Private.CoreLib, '
                                                                                                                    'Version=10.0.0.0, '
                                                                                                                    'Culture=neutral, '
                                                                                                                    'PublicKeyToken=7cec85d7bea7798e',
                                                                                                        'display': 'Value',
                                                                                                        'id': 'P:System.Collections.Generic.KeyValuePair{Neo.VM.Types.PrimitiveType,Neo.VM.Types.StackItem}.Value',
                                                                                                        'isStatic': False,
                                                                                                        'kind': 'Property',
                                                                                                        'name': 'Value',
                                                                                                        'parameters': None,
                                                                                                        'type': 'global::Neo.VM.Types.StackItem'},
 'P:System.Collections.Generic.ReferenceEqualityComparer.Instance': {'assembly': 'System.Private.CoreLib, Version=10.0.0.0, '
                                                                                 'Culture=neutral, PublicKeyToken=7cec85d7bea7798e',
                                                                     'display': 'Instance',
                                                                     'id': 'P:System.Collections.Generic.ReferenceEqualityComparer.Instance',
                                                                     'isStatic': True,
                                                                     'kind': 'Property',
                                                                     'name': 'Instance',
                                                                     'parameters': None,
                                                                     'type': 'global::System.Collections.Generic.ReferenceEqualityComparer'},
 'P:System.Collections.Generic.Stack{Neo.VM.Types.StackItem}.Count': {'assembly': 'System.Collections, Version=10.0.0.0, Culture=neutral, '
                                                                                  'PublicKeyToken=b03f5f7f11d50a3a',
                                                                      'display': 'Count',
                                                                      'id': 'P:System.Collections.Generic.Stack{Neo.VM.Types.StackItem}.Count',
                                                                      'isStatic': False,
                                                                      'kind': 'Property',
                                                                      'name': 'Count',
                                                                      'parameters': None,
                                                                      'type': 'int'},
 'P:System.IO.BinaryWriter.BaseStream': {'assembly': 'System.Private.CoreLib, Version=10.0.0.0, Culture=neutral, '
                                                     'PublicKeyToken=7cec85d7bea7798e',
                                         'display': 'BaseStream',
                                         'id': 'P:System.IO.BinaryWriter.BaseStream',
                                         'isStatic': False,
                                         'kind': 'Property',
                                         'name': 'BaseStream',
                                         'parameters': None,
                                         'type': 'global::System.IO.Stream'},
 'P:System.IO.Stream.Position': {'assembly': 'System.Private.CoreLib, Version=10.0.0.0, Culture=neutral, PublicKeyToken=7cec85d7bea7798e',
                                 'display': 'Position',
                                 'id': 'P:System.IO.Stream.Position',
                                 'isStatic': False,
                                 'kind': 'Property',
                                 'name': 'Position',
                                 'parameters': None,
                                 'type': 'long'},
 'P:System.ReadOnlyMemory{System.Byte}.Span': {'assembly': 'System.Private.CoreLib, Version=10.0.0.0, Culture=neutral, '
                                                           'PublicKeyToken=7cec85d7bea7798e',
                                               'display': 'Span',
                                               'id': 'P:System.ReadOnlyMemory{System.Byte}.Span',
                                               'isStatic': False,
                                               'kind': 'Property',
                                               'name': 'Span',
                                               'parameters': None,
                                               'type': 'global::System.ReadOnlySpan<byte>'}}

OPERATION_SCHEMAS = {'Argument:': ['IArgumentOperation.ArgumentKind',
               'IArgumentOperation.InConversion',
               'IArgumentOperation.OutConversion',
               'IArgumentOperation.Parameter',
               'IArgumentOperation.Value'],
 'Binary:': ['IBinaryOperation.ConstrainedToType',
             'IBinaryOperation.IsChecked',
             'IBinaryOperation.IsCompareText',
             'IBinaryOperation.IsLifted',
             'IBinaryOperation.LeftOperand',
             'IBinaryOperation.OperatorKind',
             'IBinaryOperation.OperatorMethod',
             'IBinaryOperation.RightOperand'],
 'Block:': ['IBlockOperation.Locals', 'IBlockOperation.Operations'],
 'Branch:': ['IBranchOperation.BranchKind', 'IBranchOperation.Target'],
 'CaseClause:Default': ['ICaseClauseOperation.CaseKind', 'ICaseClauseOperation.Label'],
 'CaseClause:Pattern': ['ICaseClauseOperation.CaseKind',
                        'ICaseClauseOperation.Label',
                        'IPatternCaseClauseOperation.Guard',
                        'IPatternCaseClauseOperation.Label',
                        'IPatternCaseClauseOperation.Pattern'],
 'CaseClause:SingleValue': ['ICaseClauseOperation.CaseKind', 'ICaseClauseOperation.Label', 'ISingleValueCaseClauseOperation.Value'],
 'CompoundAssignment:': ['IAssignmentOperation.Target',
                         'IAssignmentOperation.Value',
                         'ICompoundAssignmentOperation.ConstrainedToType',
                         'ICompoundAssignmentOperation.InConversion',
                         'ICompoundAssignmentOperation.IsChecked',
                         'ICompoundAssignmentOperation.IsLifted',
                         'ICompoundAssignmentOperation.OperatorKind',
                         'ICompoundAssignmentOperation.OperatorMethod',
                         'ICompoundAssignmentOperation.OutConversion'],
 'Conditional:': ['IConditionalOperation.Condition',
                  'IConditionalOperation.IsRef',
                  'IConditionalOperation.WhenFalse',
                  'IConditionalOperation.WhenTrue'],
 'Conversion:': ['IConversionOperation.ConstrainedToType',
                 'IConversionOperation.Conversion',
                 'IConversionOperation.IsChecked',
                 'IConversionOperation.IsTryCast',
                 'IConversionOperation.Operand',
                 'IConversionOperation.OperatorMethod'],
 'DeclarationPattern:': ['IDeclarationPatternOperation.DeclaredSymbol',
                         'IDeclarationPatternOperation.MatchedType',
                         'IDeclarationPatternOperation.MatchesNull',
                         'IPatternOperation.InputType',
                         'IPatternOperation.NarrowedType'],
 'Decrement:': ['IIncrementOrDecrementOperation.ConstrainedToType',
                'IIncrementOrDecrementOperation.IsChecked',
                'IIncrementOrDecrementOperation.IsLifted',
                'IIncrementOrDecrementOperation.IsPostfix',
                'IIncrementOrDecrementOperation.OperatorMethod',
                'IIncrementOrDecrementOperation.Target'],
 'DefaultValue:': [],
 'ExpressionStatement:': ['IExpressionStatementOperation.Operation'],
 'FieldReference:': ['IFieldReferenceOperation.Field',
                     'IFieldReferenceOperation.IsDeclaration',
                     'IMemberReferenceOperation.ConstrainedToType',
                     'IMemberReferenceOperation.Instance',
                     'IMemberReferenceOperation.Member'],
 'Increment:': ['IIncrementOrDecrementOperation.ConstrainedToType',
                'IIncrementOrDecrementOperation.IsChecked',
                'IIncrementOrDecrementOperation.IsLifted',
                'IIncrementOrDecrementOperation.IsPostfix',
                'IIncrementOrDecrementOperation.OperatorMethod',
                'IIncrementOrDecrementOperation.Target'],
 'InterpolatedString:': ['IInterpolatedStringOperation.Parts'],
 'InterpolatedStringText:': ['IInterpolatedStringTextOperation.Text'],
 'Interpolation:': ['IInterpolationOperation.Alignment', 'IInterpolationOperation.Expression', 'IInterpolationOperation.FormatString'],
 'Invocation:': ['IInvocationOperation.Arguments',
                 'IInvocationOperation.ConstrainedToType',
                 'IInvocationOperation.Instance',
                 'IInvocationOperation.IsVirtual',
                 'IInvocationOperation.TargetMethod'],
 'IsPattern:': ['IIsPatternOperation.Pattern', 'IIsPatternOperation.Value'],
 'Literal:': [],
 'LocalReference:': ['ILocalReferenceOperation.IsDeclaration', 'ILocalReferenceOperation.Local'],
 'Loop:For': ['IForLoopOperation.AtLoopBottom',
              'IForLoopOperation.Before',
              'IForLoopOperation.Condition',
              'IForLoopOperation.ConditionLocals',
              'ILoopOperation.Body',
              'ILoopOperation.ContinueLabel',
              'ILoopOperation.ExitLabel',
              'ILoopOperation.Locals',
              'ILoopOperation.LoopKind'],
 'Loop:ForEach': ['IForEachLoopOperation.Collection',
                  'IForEachLoopOperation.IsAsynchronous',
                  'IForEachLoopOperation.LoopControlVariable',
                  'IForEachLoopOperation.NextVariables',
                  'ILoopOperation.Body',
                  'ILoopOperation.ContinueLabel',
                  'ILoopOperation.ExitLabel',
                  'ILoopOperation.Locals',
                  'ILoopOperation.LoopKind'],
 'Loop:While': ['ILoopOperation.Body',
                'ILoopOperation.ContinueLabel',
                'ILoopOperation.ExitLabel',
                'ILoopOperation.Locals',
                'ILoopOperation.LoopKind',
                'IWhileLoopOperation.Condition',
                'IWhileLoopOperation.ConditionIsTop',
                'IWhileLoopOperation.ConditionIsUntil',
                'IWhileLoopOperation.IgnoredCondition'],
 'ObjectCreation:': ['IObjectCreationOperation.Arguments', 'IObjectCreationOperation.Constructor', 'IObjectCreationOperation.Initializer'],
 'ParameterReference:': ['IParameterReferenceOperation.Parameter'],
 'PropertyReference:': ['IMemberReferenceOperation.ConstrainedToType',
                        'IMemberReferenceOperation.Instance',
                        'IMemberReferenceOperation.Member',
                        'IPropertyReferenceOperation.Arguments',
                        'IPropertyReferenceOperation.Property'],
 'Return:': ['IReturnOperation.ReturnedValue'],
 'SimpleAssignment:': ['IAssignmentOperation.Target', 'IAssignmentOperation.Value', 'ISimpleAssignmentOperation.IsRef'],
 'Switch:': ['ISwitchOperation.Cases', 'ISwitchOperation.ExitLabel', 'ISwitchOperation.Locals', 'ISwitchOperation.Value'],
 'SwitchCase:': ['ISwitchCaseOperation.Body', 'ISwitchCaseOperation.Clauses', 'ISwitchCaseOperation.Locals'],
 'Throw:': ['IThrowOperation.Exception'],
 'Unary:': ['IUnaryOperation.ConstrainedToType',
            'IUnaryOperation.IsChecked',
            'IUnaryOperation.IsLifted',
            'IUnaryOperation.Operand',
            'IUnaryOperation.OperatorKind',
            'IUnaryOperation.OperatorMethod'],
 'VariableDeclaration:': ['IVariableDeclarationOperation.Declarators',
                          'IVariableDeclarationOperation.IgnoredDimensions',
                          'IVariableDeclarationOperation.Initializer'],
 'VariableDeclarationGroup:': ['IVariableDeclarationGroupOperation.Declarations'],
 'VariableDeclarator:': ['IVariableDeclaratorOperation.IgnoredArguments',
                         'IVariableDeclaratorOperation.Initializer',
                         'IVariableDeclaratorOperation.Symbol'],
 'VariableInitializer:': ['ISymbolInitializerOperation.Locals', 'ISymbolInitializerOperation.Value']}

OPERATION_TYPES = [None,
 'bool',
 'byte',
 'global::Neo.IO.MemoryReader',
 'global::Neo.SmartContract.BinarySerializer.ContainerPlaceholder',
 'global::Neo.VM.Types.Array',
 'global::Neo.VM.Types.Buffer',
 'global::Neo.VM.Types.CompoundType',
 'global::Neo.VM.Types.Map',
 'global::Neo.VM.Types.PrimitiveType',
 'global::Neo.VM.Types.StackItem',
 'global::Neo.VM.Types.StackItemType',
 'global::Neo.VM.Types.Struct',
 'global::System.Collections.Generic.HashSet<global::Neo.VM.Types.CompoundType>',
 'global::System.Collections.Generic.IEnumerable<global::Neo.VM.Types.StackItem>',
 'global::System.Collections.Generic.IEnumerable<global::System.Collections.Generic.KeyValuePair<global::Neo.VM.Types.PrimitiveType, '
 'global::Neo.VM.Types.StackItem>>',
 'global::System.Collections.Generic.IEqualityComparer<global::Neo.VM.Types.CompoundType>',
 'global::System.Collections.Generic.KeyValuePair<global::Neo.VM.Types.PrimitiveType, global::Neo.VM.Types.StackItem>',
 'global::System.Collections.Generic.ReferenceEqualityComparer',
 'global::System.Collections.Generic.Stack<global::Neo.VM.Types.StackItem>',
 'global::System.Exception',
 'global::System.FormatException',
 'global::System.IO.BinaryWriter',
 'global::System.IO.Stream',
 'global::System.InvalidOperationException',
 'global::System.NotSupportedException',
 'global::System.Numerics.BigInteger',
 'global::System.ReadOnlyMemory<byte>',
 'global::System.ReadOnlySpan<byte>',
 'int',
 'long',
 'string',
 'uint',
 'ulong',
 'void']


INVOCATION_VIRTUAL = {'M:Neo.Extensions.BinaryWriterExtensions.WriteVarBytes(System.IO.BinaryWriter,System.ReadOnlySpan{System.Byte})': False,
 'M:Neo.Extensions.BinaryWriterExtensions.WriteVarInt(System.IO.BinaryWriter,System.Int64)': False,
 'M:Neo.IO.MemoryReader.ReadBoolean': False,
 'M:Neo.IO.MemoryReader.ReadByte': False,
 'M:Neo.IO.MemoryReader.ReadVarInt(System.UInt64)': False,
 'M:Neo.IO.MemoryReader.ReadVarMemory(System.Int32)': False,
 'M:Neo.VM.Types.Array.Add(Neo.VM.Types.StackItem)': False,
 'M:Neo.VM.Types.StackItem.GetBoolean': True,
 'M:Neo.VM.Types.StackItem.GetSpan': True,
 'M:System.Collections.Generic.HashSet{Neo.VM.Types.CompoundType}.Add(Neo.VM.Types.CompoundType)': False,
 'M:System.Collections.Generic.Stack{Neo.VM.Types.StackItem}.Peek': False,
 'M:System.Collections.Generic.Stack{Neo.VM.Types.StackItem}.Pop': False,
 'M:System.Collections.Generic.Stack{Neo.VM.Types.StackItem}.Push(Neo.VM.Types.StackItem)': False,
 'M:System.IO.BinaryWriter.Flush': True,
 'M:System.IO.BinaryWriter.Write(System.Boolean)': True,
 'M:System.IO.BinaryWriter.Write(System.Byte)': True,
 'M:System.Linq.Enumerable.Reverse``1(System.Collections.Generic.IEnumerable{System.Collections.Generic.KeyValuePair{Neo.VM.Types.PrimitiveType,Neo.VM.Types.StackItem}})': False}

CORE_SYMBOLS = {'Deserialize': {'assembly': 'PinnedNativeCodecSource, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null',
                 'display': 'Deserialize',
                 'id': 'M:Neo.SmartContract.BinarySerializer.Deserialize(Neo.IO.MemoryReader@,System.UInt32,System.UInt32)',
                 'isStatic': True,
                 'kind': 'Method',
                 'name': 'Deserialize',
                 'parameters': [{'Ordinal': 0, 'name': 'reader', 'refKind': 'Ref', 'type': 'global::Neo.IO.MemoryReader'},
                                {'Ordinal': 1, 'name': 'maxSize', 'refKind': 'None', 'type': 'uint'},
                                {'Ordinal': 2, 'name': 'maxItems', 'refKind': 'None', 'type': 'uint'}],
                 'type': 'global::Neo.VM.Types.StackItem'},
 'Serialize': {'assembly': 'PinnedNativeCodecSource, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null',
               'display': 'Serialize',
               'id': 'M:Neo.SmartContract.BinarySerializer.Serialize(System.IO.BinaryWriter,Neo.VM.Types.StackItem,System.Int64,System.Int64)',
               'isStatic': True,
               'kind': 'Method',
               'name': 'Serialize',
               'parameters': [{'Ordinal': 0, 'name': 'writer', 'refKind': 'None', 'type': 'global::System.IO.BinaryWriter'},
                              {'Ordinal': 1, 'name': 'item', 'refKind': 'None', 'type': 'global::Neo.VM.Types.StackItem'},
                              {'Ordinal': 2, 'name': 'maxSize', 'refKind': 'None', 'type': 'long'},
                              {'Ordinal': 3, 'name': 'maxItems', 'refKind': 'None', 'type': 'long'}],
               'type': 'void'}}

CONVERSION_SIGNATURES = ['["bool", "global::Neo.VM.Types.StackItem", {"Exists": true, "IsIdentity": false, "IsImplicit": true, "IsNullable": false, "IsNumeric": '
 'false, "IsReference": false, "IsUserDefined": true, "method": {"assembly": "Neo.VM, Version=3.10.1.0, Culture=neutral, '
 'PublicKeyToken=null", "display": "implicit operator global::Neo.VM.Types.StackItem", "id": '
 '"M:Neo.VM.Types.StackItem.op_Implicit(System.Boolean)~Neo.VM.Types.StackItem", "isStatic": true, "kind": "Method", "name": '
 '"op_Implicit", "parameters": [{"Ordinal": 0, "name": "value", "refKind": "None", "type": "bool"}], "type": '
 '"global::Neo.VM.Types.StackItem"}}]',
 '["byte", "global::Neo.VM.Types.StackItemType", {"Exists": true, "IsIdentity": false, "IsImplicit": false, "IsNullable": false, '
 '"IsNumeric": false, "IsReference": false, "IsUserDefined": false, "method": null}]',
 '["global::Neo.SmartContract.BinarySerializer.ContainerPlaceholder", "global::Neo.VM.Types.StackItem", {"Exists": true, "IsIdentity": '
 'false, "IsImplicit": true, "IsNullable": false, "IsNumeric": false, "IsReference": true, "IsUserDefined": false, "method": null}]',
 '["global::Neo.VM.Types.Array", "global::Neo.VM.Types.Array", {"Exists": true, "IsIdentity": false, "IsImplicit": true, "IsNullable": '
 'false, "IsNumeric": false, "IsReference": false, "IsUserDefined": false, "method": null}]',
 '["global::Neo.VM.Types.Array", "global::Neo.VM.Types.CompoundType", {"Exists": true, "IsIdentity": false, "IsImplicit": true, '
 '"IsNullable": false, "IsNumeric": false, "IsReference": true, "IsUserDefined": false, "method": null}]',
 '["global::Neo.VM.Types.Array", "global::Neo.VM.Types.StackItem", {"Exists": true, "IsIdentity": false, "IsImplicit": true, "IsNullable": '
 'false, "IsNumeric": false, "IsReference": true, "IsUserDefined": false, "method": null}]',
 '["global::Neo.VM.Types.Buffer", "global::Neo.VM.Types.StackItem", {"Exists": true, "IsIdentity": false, "IsImplicit": true, '
 '"IsNullable": false, "IsNumeric": false, "IsReference": true, "IsUserDefined": false, "method": null}]',
 '["global::Neo.VM.Types.Map", "global::Neo.VM.Types.CompoundType", {"Exists": true, "IsIdentity": false, "IsImplicit": true, '
 '"IsNullable": false, "IsNumeric": false, "IsReference": true, "IsUserDefined": false, "method": null}]',
 '["global::Neo.VM.Types.Map", "global::Neo.VM.Types.Map", {"Exists": true, "IsIdentity": false, "IsImplicit": true, "IsNullable": false, '
 '"IsNumeric": false, "IsReference": false, "IsUserDefined": false, "method": null}]',
 '["global::Neo.VM.Types.Map", "global::Neo.VM.Types.StackItem", {"Exists": true, "IsIdentity": false, "IsImplicit": true, "IsNullable": '
 'false, "IsNumeric": false, "IsReference": true, "IsUserDefined": false, "method": null}]',
 '["global::Neo.VM.Types.Map", '
 '"global::System.Collections.Generic.IEnumerable<global::System.Collections.Generic.KeyValuePair<global::Neo.VM.Types.PrimitiveType, '
 'global::Neo.VM.Types.StackItem>>", {"Exists": true, "IsIdentity": false, "IsImplicit": true, "IsNullable": false, "IsNumeric": false, '
 '"IsReference": true, "IsUserDefined": false, "method": null}]',
 '["global::Neo.VM.Types.PrimitiveType", "global::Neo.VM.Types.StackItem", {"Exists": true, "IsIdentity": false, "IsImplicit": true, '
 '"IsNullable": false, "IsNumeric": false, "IsReference": true, "IsUserDefined": false, "method": null}]',
 '["global::Neo.VM.Types.StackItem", "global::Neo.VM.Types.PrimitiveType", {"Exists": true, "IsIdentity": false, "IsImplicit": false, '
 '"IsNullable": false, "IsNumeric": false, "IsReference": true, "IsUserDefined": false, "method": null}]',
 '["global::Neo.VM.Types.StackItemType", "byte", {"Exists": true, "IsIdentity": false, "IsImplicit": false, "IsNullable": false, '
 '"IsNumeric": false, "IsReference": false, "IsUserDefined": false, "method": null}]',
 '["global::Neo.VM.Types.Struct", "global::Neo.VM.Types.StackItem", {"Exists": true, "IsIdentity": false, "IsImplicit": true, '
 '"IsNullable": false, "IsNumeric": false, "IsReference": true, "IsUserDefined": false, "method": null}]',
 '["global::Neo.VM.Types.Struct", "global::Neo.VM.Types.Struct", {"Exists": true, "IsIdentity": false, "IsImplicit": true, "IsNullable": '
 'false, "IsNumeric": false, "IsReference": false, "IsUserDefined": false, "method": null}]',
 '["global::System.Collections.Generic.HashSet<global::Neo.VM.Types.CompoundType>", '
 '"global::System.Collections.Generic.HashSet<global::Neo.VM.Types.CompoundType>", {"Exists": true, "IsIdentity": false, "IsImplicit": '
 'true, "IsNullable": false, "IsNumeric": false, "IsReference": false, "IsUserDefined": false, "method": null}]',
 '["global::System.Collections.Generic.IEnumerable<global::System.Collections.Generic.KeyValuePair<global::Neo.VM.Types.PrimitiveType, '
 'global::Neo.VM.Types.StackItem>>", '
 '"global::System.Collections.Generic.IEnumerable<global::System.Collections.Generic.KeyValuePair<global::Neo.VM.Types.PrimitiveType, '
 'global::Neo.VM.Types.StackItem>>", {"Exists": true, "IsIdentity": true, "IsImplicit": true, "IsNullable": false, "IsNumeric": false, '
 '"IsReference": false, "IsUserDefined": false, "method": null}]',
 '["global::System.Collections.Generic.ReferenceEqualityComparer", '
 '"global::System.Collections.Generic.IEqualityComparer<global::Neo.VM.Types.CompoundType>", {"Exists": true, "IsIdentity": false, '
 '"IsImplicit": true, "IsNullable": false, "IsNumeric": false, "IsReference": true, "IsUserDefined": false, "method": null}]',
 '["global::System.Collections.Generic.Stack<global::Neo.VM.Types.StackItem>", '
 '"global::System.Collections.Generic.Stack<global::Neo.VM.Types.StackItem>", {"Exists": true, "IsIdentity": false, "IsImplicit": true, '
 '"IsNullable": false, "IsNumeric": false, "IsReference": false, "IsUserDefined": false, "method": null}]',
 '["global::System.FormatException", "global::System.Exception", {"Exists": true, "IsIdentity": false, "IsImplicit": true, "IsNullable": '
 'false, "IsNumeric": false, "IsReference": true, "IsUserDefined": false, "method": null}]',
 '["global::System.InvalidOperationException", "global::System.Exception", {"Exists": true, "IsIdentity": false, "IsImplicit": true, '
 '"IsNullable": false, "IsNumeric": false, "IsReference": true, "IsUserDefined": false, "method": null}]',
 '["global::System.NotSupportedException", "global::System.Exception", {"Exists": true, "IsIdentity": false, "IsImplicit": true, '
 '"IsNullable": false, "IsNumeric": false, "IsReference": true, "IsUserDefined": false, "method": null}]',
 '["global::System.Numerics.BigInteger", "global::Neo.VM.Types.StackItem", {"Exists": true, "IsIdentity": false, "IsImplicit": true, '
 '"IsNullable": false, "IsNumeric": false, "IsReference": false, "IsUserDefined": true, "method": {"assembly": "Neo.VM, Version=3.10.1.0, '
 'Culture=neutral, PublicKeyToken=null", "display": "implicit operator global::Neo.VM.Types.StackItem", "id": '
 '"M:Neo.VM.Types.StackItem.op_Implicit(System.Numerics.BigInteger)~Neo.VM.Types.StackItem", "isStatic": true, "kind": "Method", "name": '
 '"op_Implicit", "parameters": [{"Ordinal": 0, "name": "value", "refKind": "None", "type": "global::System.Numerics.BigInteger"}], "type": '
 '"global::Neo.VM.Types.StackItem"}}]',
 '["global::System.ReadOnlyMemory<byte>", "global::Neo.VM.Types.StackItem", {"Exists": true, "IsIdentity": false, "IsImplicit": true, '
 '"IsNullable": false, "IsNumeric": false, "IsReference": false, "IsUserDefined": true, "method": {"assembly": "Neo.VM, Version=3.10.1.0, '
 'Culture=neutral, PublicKeyToken=null", "display": "implicit operator global::Neo.VM.Types.StackItem", "id": '
 '"M:Neo.VM.Types.StackItem.op_Implicit(System.ReadOnlyMemory{System.Byte})~Neo.VM.Types.StackItem", "isStatic": true, "kind": "Method", '
 '"name": "op_Implicit", "parameters": [{"Ordinal": 0, "name": "value", "refKind": "None", "type": '
 '"global::System.ReadOnlyMemory<byte>"}], "type": "global::Neo.VM.Types.StackItem"}}]',
 '["int", "long", {"Exists": true, "IsIdentity": false, "IsImplicit": true, "IsNullable": false, "IsNumeric": true, "IsReference": false, '
 '"IsUserDefined": false, "method": null}]',
 '["uint", "int", {"Exists": true, "IsIdentity": false, "IsImplicit": false, "IsNullable": false, "IsNumeric": true, "IsReference": false, '
 '"IsUserDefined": false, "method": null}]',
 '["uint", "long", {"Exists": true, "IsIdentity": false, "IsImplicit": true, "IsNullable": false, "IsNumeric": true, "IsReference": false, '
 '"IsUserDefined": false, "method": null}]',
 '["uint", "ulong", {"Exists": true, "IsIdentity": false, "IsImplicit": true, "IsNullable": false, "IsNumeric": true, "IsReference": '
 'false, "IsUserDefined": false, "method": null}]',
 '["ulong", "int", {"Exists": true, "IsIdentity": false, "IsImplicit": false, "IsNullable": false, "IsNumeric": true, "IsReference": '
 'false, "IsUserDefined": false, "method": null}]']

def short_type(typename):
    special = {
        'global::System.Collections.Generic.Stack<global::Neo.VM.Types.StackItem>': 'Stack<StackItem>',
        'global::System.Collections.Generic.HashSet<global::Neo.VM.Types.CompoundType>': 'HashSet<CompoundType>',
    }
    return special.get(typename, typename.removeprefix('global::').rsplit('.', 1)[-1])


class BoundProjection:
    def __init__(self, source):
        self.source = source
        self.nodes = 0
        self.bindings = set()

    def metadata(self, value, child_count):
        if isinstance(value, dict):
            kind = value.get('kind')
            if kind == 'symbol':
                symbol = value['value']
                codec.require(set(value) == {'kind', 'value'} and set(symbol) == {'id','name','kind','type','isStatic','assembly','display','parameters'}, 'Incomplete symbol metadata')
                if symbol['kind'] in ('Method','Property','Field'):
                    codec.require(EXTERNAL_SYMBOLS.get(symbol['id']) == symbol, 'Changed resolved external overload: '+symbol['id'])
                    self.bindings.add(symbol['id'])
                else:
                    codec.require(symbol['kind'] in ('Local','Parameter','Label','NamedType','ArrayType'), 'Unsupported bound symbol kind')
                    codec.require(symbol['type'] in OPERATION_TYPES or symbol['kind'] == 'NamedType', 'Unknown bound local type')
                    codec.require(type(symbol['isStatic']) is bool, 'Invalid bound static flag')
                return []
            if kind == 'operation':
                codec.require(set(value) == {'kind','childIndex'} and type(value['childIndex']) is int and 0 <= value['childIndex'] < child_count, 'Invalid bound child reference')
                return [value['childIndex']]
            if kind == 'collection':
                codec.require(set(value) == {'kind','complete','items'} and value['complete'] is True and type(value['items']) is list, 'Incomplete semantic collection')
                indices = [index for item in value['items'] for index in self.metadata(item, child_count)]
                codec.require(len(indices) == len(set(indices)), 'Duplicate operation collection member')
                return indices
            if kind == 'conversion':
                codec.require(set(value) == {'kind','value'}, 'Incomplete conversion')
                conversion = value['value']
                codec.require(set(conversion) == {'Exists','IsIdentity','IsImplicit','IsNumeric','IsReference','IsNullable','IsUserDefined','method'}, 'Incomplete conversion fields')
                codec.require(all(type(conversion[k]) is bool for k in conversion if k != 'method') and conversion['Exists'] is True and not conversion['IsNullable'], 'Unsupported conversion flags')
                if conversion['method'] is not None:
                    self.metadata({'kind':'symbol', 'value':conversion['method']}, child_count)
                    codec.require(conversion['IsUserDefined'], 'Unmarked user conversion')
                else:
                    codec.require(not conversion['IsUserDefined'], 'Missing user conversion symbol')
                return []
            raise codec.CodecError('Unsupported semantic metadata record')
        codec.require(value is None or type(value) in (str, bool, int), 'Unsupported semantic metadata value')
        return []

    def validate(self, node):
        codec.require(set(node) == {'kind','type','isImplicit','constant','syntax','metadata','metadataComplete','children'}, 'Unexpected source operation keys')
        codec.require(node['metadataComplete'] is True and type(node['isImplicit']) is bool and node['type'] in OPERATION_TYPES, 'Incomplete or unknown source operation')
        syntax, metadata, children = node['syntax'], node['metadata'], node['children']
        codec.require(set(syntax) == {'kind','start','length','text'} and all(type(syntax[k]) is int for k in ('start','length')), 'Malformed syntax attribution')
        codec.require(syntax['start'] >= 0 and syntax['length'] >= 0 and self.source[syntax['start']:syntax['start']+syntax['length']] == syntax['text'], 'Bound operation source span differs')
        key = node['kind']+':'+str(metadata.get('ILoopOperation.LoopKind',metadata.get('ICaseClauseOperation.CaseKind','')))
        codec.require(sorted(metadata) == OPERATION_SCHEMAS.get(key), 'Changed operation semantic interface: '+key)
        referenced = [index for value in metadata.values() for index in self.metadata(value, len(children))]
        codec.require(set(referenced) == set(range(len(children))), 'Unattributed operation child')
        for key, value in metadata.items():
            if key.endswith(('.IsChecked','.IsLifted','.IsTryCast','.IsCompareText','.IsRef','.IsAsynchronous','.MatchesNull')):
                codec.require(value is False, 'Unsupported semantic flag: '+key)
            if key == 'IConversionOperation.OperatorMethod':
                conversion_method = metadata['IConversionOperation.Conversion']['value']['method']
                codec.require((None if value is None else value['value']) == conversion_method, 'Conversion operator differs')
                continue
            if key.endswith(('.ConstrainedToType','.OperatorMethod','.IgnoredCondition','.Guard','.Alignment','.FormatString')):
                codec.require(value is None, 'Unsupported extra semantics: '+key)
            if key.endswith(('.IgnoredArguments','.IgnoredDimensions','.NextVariables','.ConditionLocals')):
                codec.require(value['items'] == [], 'Nonempty ignored semantic collection: '+key)
        self.nodes += 1
        for child in children:
            self.validate(child)

    @staticmethod
    def child(node, key):
        ref = node['metadata'][key]
        return None if ref is None else node['children'][ref['childIndex']]

    @staticmethod
    def children(node, key):
        return [node['children'][ref['childIndex']] for ref in node['metadata'][key]['items']]

    @staticmethod
    def symbol(node, key):
        return node['metadata'][key]['value']

    def check_arguments(self, arguments, method):
        for argument, expected in zip(arguments,method['parameters']):
            codec.require(argument['kind'] == 'Argument', 'Nonargument invocation child')
            parameter = self.symbol(argument,'IArgumentOperation.Parameter')
            codec.require(parameter['name'] == expected['name'] and parameter['type'] == expected['type'] and expected['refKind'] == 'None', 'Wrong source parameter binding/order')

    def project(self, node):
        kind, meta = node['kind'], node['metadata']
        def child(key):
            selected = self.child(node,key)
            return None if selected is None else self.project(selected)
        def children(key):
            return [self.project(c) for c in self.children(node,key)]
        def symbol(key):
            return self.symbol(node,key)
        if kind == 'Block':
            return ['block',children('IBlockOperation.Operations')]
        if kind == 'VariableDeclarationGroup':
            return ['block',children('IVariableDeclarationGroupOperation.Declarations')]
        if kind == 'VariableDeclaration':
            codec.require(meta['IVariableDeclarationOperation.Initializer'] is None, 'Group initializer unsupported')
            return ['block',children('IVariableDeclarationOperation.Declarators')]
        if kind == 'VariableDeclarator':
            local = symbol('IVariableDeclaratorOperation.Symbol')
            value = child('IVariableDeclaratorOperation.Initializer')
            return ['declare',short_type(local['type']),local['name'],value]
        if kind == 'VariableInitializer':
            return child('ISymbolInitializerOperation.Value')
        if kind in ('Literal','DefaultValue'):
            codec.require(node['constant'] is not None and node['constant']['hasValue'] is True, 'Literal has no bound constant')
            return ['literal',node['constant']['value']]
        if kind in ('LocalReference','ParameterReference'):
            key = 'ILocalReferenceOperation.Local' if kind == 'LocalReference' else 'IParameterReferenceOperation.Parameter'
            local = symbol(key)
            codec.require(local['type'] == node['type'], 'Local reference type mismatch')
            return ['name',local['name']]
        if kind == 'Conversion':
            conversion_signature = json.dumps([self.child(node,'IConversionOperation.Operand')['type'],node['type'],meta['IConversionOperation.Conversion']['value']],sort_keys=True)
            codec.require(conversion_signature in CONVERSION_SIGNATURES, 'Unsupported source conversion signature')
            value = child('IConversionOperation.Operand')
            conversion = meta['IConversionOperation.Conversion']['value']
            if conversion['IsUserDefined']:
                method = conversion['method']['id']
                codec.require(method.startswith('M:Neo.VM.Types.StackItem.op_Implicit('), 'Unsupported source user conversion')
                return ['stackitem',value]
            if node['type'] in ('int','uint','byte') or node['type'] == 'global::Neo.VM.Types.StackItemType':
                return ['cast',short_type(node['type']),value]
            return value
        if kind == 'Argument':
            codec.require(meta['IArgumentOperation.ArgumentKind'] in ('Explicit','DefaultValue'), 'Unknown argument mode')
            for key in ('IArgumentOperation.InConversion','IArgumentOperation.OutConversion'):
                codec.require(meta[key]['value']['IsIdentity'], 'Nonidentity argument conversion')
            return child('IArgumentOperation.Value')
        if kind == 'ObjectCreation':
            constructor = symbol('IObjectCreationOperation.Constructor')
            codec.require(meta['IObjectCreationOperation.Initializer'] is None, 'Object initializer unsupported')
            arguments = children('IObjectCreationOperation.Arguments')
            codec.require(len(arguments) == len(constructor['parameters']), 'Constructor arity drift')
            self.check_arguments(self.children(node,'IObjectCreationOperation.Arguments'),constructor)
            typename = short_type(node['type'])
            if typename == 'BigInteger':
                codec.require(arguments[1:] == [['literal',False],['literal',False]], 'BigInteger unsigned/endian defaults changed')
                arguments = arguments[:1]
            if typename in ('Array','Struct'):
                codec.require(arguments == [['literal',None]], 'Container enumerable initializer unsupported')
                arguments = []
            return ['new',typename,arguments]
        if kind in ('PropertyReference','FieldReference'):
            key = 'IPropertyReferenceOperation.Property' if kind == 'PropertyReference' else 'IFieldReferenceOperation.Field'
            member = symbol(key)
            codec.require(member == symbol('IMemberReferenceOperation.Member') and member['type'] == node['type'], 'Member binding inconsistency')
            receiver = child('IMemberReferenceOperation.Instance')
            arguments = children('IPropertyReferenceOperation.Arguments') if kind == 'PropertyReference' else []
            if arguments:
                codec.require(member['name'] == 'this[]' and len(arguments) == 1 and receiver is not None, 'Unsupported source indexer')
                return ['index',receiver,arguments[0]]
            if receiver is None:
                static_receivers = {'Null':'StackItem','MaxSize':'Integer','Instance':'ReferenceEqualityComparer'}
                owner = 'StackItemType' if member['id'].startswith('F:Neo.VM.Types.StackItemType.') else static_receivers[member['name']]
                receiver = ['name',owner]
            return ['member',receiver,member['name']]
        if kind == 'Invocation':
            method = symbol('IInvocationOperation.TargetMethod')
            arguments = children('IInvocationOperation.Arguments')
            codec.require(len(arguments) == len(method['parameters']), 'Invocation arity drift')
            self.check_arguments(self.children(node,'IInvocationOperation.Arguments'),method)
            codec.require(meta['IInvocationOperation.IsVirtual'] is INVOCATION_VIRTUAL[method['id']], 'Changed source virtual dispatch flag')
            receiver = child('IInvocationOperation.Instance')
            if method['isStatic']:
                codec.require(receiver is None and method['name'] in ('WriteVarBytes','WriteVarInt','Reverse') and arguments, 'Unsupported static source call')
                receiver, arguments = arguments[0], arguments[1:]
            codec.require(receiver is not None, 'Missing source call receiver')
            return ['call',['member',receiver,method['name']],arguments]
        if kind == 'ExpressionStatement':
            return ['expression',child('IExpressionStatementOperation.Operation')]
        if kind in ('Binary','CompoundAssignment','SimpleAssignment'):
            if kind == 'Binary':
                left,right = child('IBinaryOperation.LeftOperand'),child('IBinaryOperation.RightOperand')
                operator = meta['IBinaryOperation.OperatorKind']
            else:
                left,right = child('IAssignmentOperation.Target'),child('IAssignmentOperation.Value')
                operator = meta['ICompoundAssignmentOperation.OperatorKind'] if kind == 'CompoundAssignment' else '='
                codec.require(kind != 'CompoundAssignment' or operator == 'Add', 'Unsupported compound assignment operator')
            operators = {'GreaterThan':'>','LessThan':'<','GreaterThanOrEqual':'>=','LessThanOrEqual':'<=','Add':'+','Subtract':'-','Multiply':'*','=':'='}
            codec.require(operator in operators, 'Unknown source binary operator')
            return ['binary','+=' if kind == 'CompoundAssignment' else operators[operator],left,right]
        if kind in ('Increment','Decrement'):
            return ['postfix' if meta['IIncrementOrDecrementOperation.IsPostfix'] else 'unary','++' if kind == 'Increment' else '--',child('IIncrementOrDecrementOperation.Target')]
        if kind == 'Unary':
            codec.require(meta['IUnaryOperation.OperatorKind'] == 'Not', 'Unknown unary operator')
            return ['unary','!',child('IUnaryOperation.Operand')]
        if kind == 'Conditional':
            return ['if',child('IConditionalOperation.Condition'),child('IConditionalOperation.WhenTrue'),child('IConditionalOperation.WhenFalse')]
        if kind == 'Loop':
            body = child('ILoopOperation.Body')
            loop = meta['ILoopOperation.LoopKind']
            if loop == 'While':
                codec.require(meta['IWhileLoopOperation.ConditionIsTop'] is True and meta['IWhileLoopOperation.ConditionIsUntil'] is False, 'Unknown while ordering')
                return ['while',child('IWhileLoopOperation.Condition'),body]
            if loop == 'For':
                before,bottom = children('IForLoopOperation.Before'),children('IForLoopOperation.AtLoopBottom')
                codec.require(len(bottom) == 1 and bottom[0][0] == 'expression', 'Unsupported loop bottom')
                return ['for',['block',before],child('IForLoopOperation.Condition'),bottom[0][1],body]
            control = child('IForEachLoopOperation.LoopControlVariable')
            codec.require(control[0] == 'declare' and control[3] is None, 'Unsupported foreach declaration')
            return ['foreach',control[1],control[2],child('IForEachLoopOperation.Collection'),body]
        if kind == 'Switch':
            return ['switch',child('ISwitchOperation.Value'),children('ISwitchOperation.Cases')]
        if kind == 'SwitchCase':
            return [children('ISwitchCaseOperation.Clauses'),['block',children('ISwitchCaseOperation.Body')]]
        if kind == 'CaseClause':
            case = meta['ICaseClauseOperation.CaseKind']
            if case == 'Default':
                return ['default']
            if case == 'SingleValue':
                expression = child('ISingleValueCaseClauseOperation.Value')
                codec.require(expression[:2] == ['member',['name','StackItemType']], 'Unknown switch label')
                return ['enum','StackItemType',expression[2]]
            pattern = child('IPatternCaseClauseOperation.Pattern')
            return ['pattern',*pattern]
        if kind == 'DeclarationPattern':
            type_info = symbol('IDeclarationPatternOperation.MatchedType')
            declared = meta['IDeclarationPatternOperation.DeclaredSymbol']
            return [short_type(type_info['type']), '_' if declared is None else declared['value']['name']]
        if kind == 'IsPattern':
            return ['is',child('IIsPatternOperation.Value'),*child('IIsPatternOperation.Pattern')]
        if kind == 'Branch':
            codec.require(meta['IBranchOperation.BranchKind'] == 'Break', 'Unsupported source branch')
            return ['break']
        if kind == 'Return':
            return ['return',child('IReturnOperation.ReturnedValue')]
        if kind == 'Throw':
            return ['throw_expr',child('IThrowOperation.Exception')]
        if kind == 'InterpolatedString':
            return ['string_join',children('IInterpolatedStringOperation.Parts')]
        if kind == 'InterpolatedStringText':
            return child('IInterpolatedStringTextOperation.Text')
        if kind == 'Interpolation':
            return ['string',child('IInterpolationOperation.Expression')]
        raise codec.CodecError('Unsupported bound source node: '+kind)


def _project_inventory(inventory, expected_source_sha):
    codec.require(inventory['schema'] == 'neoos-aa-native-codec-source/v1' and inventory['status'] == 'TYPED_SOURCE_INVENTORY_ONLY', 'Unknown native source inventory')
    codec.require(inventory['compilationErrorCount'] == 0 and inventory['semanticMetadataComplete'] is True and all(d['severity'] != 'Error' for d in inventory['diagnostics']), 'Unresolved native source')
    codec.require(inventory['roslyn']['sha256'] == ROSLYN_SHA256, 'Unpinned Roslyn frontend')
    source = inventory['source']['text']
    codec.require(hashlib.sha256(source.encode()).hexdigest() == inventory['source']['sha256'], 'Source inventory text hash mismatch')
    codec.require(inventory['source']['sha256'] == expected_source_sha, 'Source inventory is not pinned BinarySerializer')
    codec.require(len(inventory['methods']) == 2 and {m['name'] for m in inventory['methods']} == {'Serialize','Deserialize'}, 'Missing/duplicate native core')
    frontend = BoundProjection(source)
    methods = {}
    codec.require(inventory['inputs'].get(inventory['source']['path']) == inventory['source']['sha256'], 'Missing original source input identity')
    for method in inventory['methods']:
        codec.require(method['symbol'] == CORE_SYMBOLS[method['name']], 'Wrong native core resolved signature')
        codec.require(method['operation']['syntax']['start'] == method['bodyStart'] and method['operation']['syntax']['length'] == method['bodyLength'], 'Wrong native core body span')
        frontend.validate(method['operation'])
        methods[method['name'].lower()] = {'ast':frontend.project(method['operation']), 'symbol':method['symbol']}
    result = {'dialect':'resolved-roslyn-binaryserializer-core/v1', 'sourceSha256':inventory['source']['sha256'],
              'methods':methods, 'operationCount':frontend.nodes, 'resolvedExternalSymbols':sorted(frontend.bindings),
              'externalContracts':codec.project_codec_source(source)['externalContracts'],
              'kernelChecked':False, 'runtimeSourceSimulationProven':False}
    result['projectionSha256'] = hashlib.sha256(json.dumps(result,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return result


def project_inventory(inventory):
    return _project_inventory(inventory,codec.SOURCE_FILES['BinarySerializer'][3])


def _export_raw_inventory(source_path, output_path):
    output_path = Path(output_path)
    codec.require(not output_path.exists(), 'Native inventory output already exists')
    result = subprocess.run(['dotnet','run','--project',str(ROOT/'native_export'/'NativeCodecExport.csproj'),'--',str(source_path),str(output_path)], text=True,capture_output=True,timeout=600)
    codec.require(result.returncode == 0, 'Native Roslyn export failed: '+(result.stdout+result.stderr)[-4000:])
    raw = output_path.read_bytes()
    inventory = json.loads(raw)
    return raw, inventory


def export_inventory(source_path, output_path):
    raw,inventory = _export_raw_inventory(source_path,output_path)
    return raw,inventory,project_inventory(inventory)


SOURCE_MUTATIONS = {
    'array-field-order': ('for (int i = array.Count - 1; i >= 0; i--)', 'for (int i = 0; i < array.Count; i++)', 'serialize'),
    'array-field-count': ('writer.WriteVarInt(array.Count);', 'writer.WriteVarInt(array.Count + 1);', 'serialize'),
    'struct-constructor': ('Struct @struct = new();', 'Array @struct = new();', 'deserialize'),
    'pending-item-count': ('undeserialized += count;', 'undeserialized += count * 2;', 'deserialize'),
    'item-limit-off-by-one': ('if (--maxItems < 0)', 'if (--maxItems < 1)', 'serialize'),
}


def source_semantic_controls(source, output_directory, *, include_projections=False):
    """Recompile real C# mutants, project resolved operations, reject old behavior."""
    output = Path(output_directory)
    output.mkdir(parents=True,exist_ok=False)
    baseline = codec.Ledger('Struct',bytes(range(32)),128,'Buffer')
    expected_wire = codec.encode_ledger(baseline)
    result, projections = {}, {}
    for name,(old,new,operation) in SOURCE_MUTATIONS.items():
        codec.require(source.count(old) == 1, 'Ambiguous actual source mutation: '+name)
        modified = source.replace(old,new)
        path = output/(name+'.cs')
        path.write_bytes(modified.encode())
        raw, inventory = _export_raw_inventory(path,output/(name+'.json'))
        projection = _project_inventory(inventory,hashlib.sha256(modified.encode()).hexdigest())
        projections[name] = projection
        try:
            actual = (codec.source_serialize_ledger(projection,baseline,max_items=3) if operation == 'serialize'
                      else codec.source_deserialize_ledger(projection,expected_wire,max_items=3))
            rejected = actual != (expected_wire if operation == 'serialize' else (baseline,b''))
        except codec.CodecError:
            rejected = True
        codec.require(rejected, 'Actual C# source mutation escaped source interpreter: '+name)
        result[name] = dict(typedCompilationSucceeded=True,resolvedOperationProjectionSucceeded=True,
                           originalBehaviorRejected=True,sourceSha256=inventory['source']['sha256'],
                           inventorySha256=hashlib.sha256(raw).hexdigest(),projectionSha256=projection['projectionSha256'])
    return (result,projections) if include_projections else result


def coq_string(value):
    codec.require(type(value) is str and '\n' not in value and '\r' not in value and all(ord(c)<128 for c in value), 'Unsupported Coq source string')
    return '"'+value.replace('"','""')+'"'


def coq_expression(node):
    kind = node[0]
    def e(value):
        return coq_expression(value)
    def es(values):
        return '['+';'.join(e(v) for v in values)+']'
    def q(value):
        return coq_string(value)
    if kind == 'literal':
        value = node[1]
        if value is None:
            return 'XNull'
        if type(value) is bool:
            return '(XBool '+str(value).lower()+')'
        if type(value) is int:
            return '(XNum ('+str(value)+')%Z)'
        return '(XText '+q(value)+')'
    if kind == 'name':
        return '(XName '+q(node[1])+')'
    if kind == 'member':
        return '(XMember '+e(node[1])+' '+q(node[2])+')'
    if kind == 'call':
        return '(XCall '+e(node[1])+' '+es(node[2])+')'
    if kind == 'new':
        return '(XNew '+q(node[1])+' '+es(node[2])+')'
    if kind == 'index':
        return '(XIndex '+e(node[1])+' '+e(node[2])+')'
    if kind in ('cast','unary','postfix'):
        return '('+{'cast':'XCast','unary':'XUnary','postfix':'XPost'}[kind]+' '+q(node[1])+' '+e(node[2])+')'
    if kind == 'binary':
        return '(XBinary '+q(node[1])+' '+e(node[2])+' '+e(node[3])+')'
    if kind == 'is':
        return '(XIs '+e(node[1])+' '+q(node[2])+' '+q(node[3])+')'
    if kind in ('stackitem','string'):
        return '('+('XBox' if kind == 'stackitem' else 'XString')+' '+e(node[1])+')'
    if kind == 'string_join':
        return '(XJoin '+es(node[1])+')'
    raise codec.CodecError('Unsupported Coq source expression: '+kind)


def coq_statement(node):
    kind = node[0]
    e,q,s = coq_expression,coq_string,coq_statement
    if kind == 'block':
        return '(SBlock ['+';'.join(s(child) for child in node[1])+'])'
    if kind == 'declare':
        return '(SDeclare '+q(node[1])+' '+q(node[2])+' '+('XNull' if node[3] is None else e(node[3]))+')'
    if kind == 'expression':
        return '(SExpression '+e(node[1])+')'
    if kind == 'if':
        return '(SConditional '+e(node[1])+' '+s(node[2])+' '+('(SBlock [])' if node[3] is None else s(node[3]))+')'
    if kind == 'while':
        return '(SWhile '+e(node[1])+' '+s(node[2])+')'
    if kind == 'for':
        return '(SFor '+s(node[1])+' '+e(node[2])+' '+e(node[3])+' '+s(node[4])+')'
    if kind == 'foreach':
        return '(SForeach '+q(node[1])+' '+q(node[2])+' '+e(node[3])+' '+s(node[4])+')'
    if kind == 'switch':
        arms = []
        for labels,body in node[2]:
            rendered = [('LDefault' if label[0] == 'default' else '('+('LPattern' if label[0] == 'pattern' else 'LEnum')+' '+q(label[1])+' '+q(label[2])+')') for label in labels]
            arms.append('(['+';'.join(rendered)+'],'+s(body)+')')
        return '(SSwitch '+e(node[1])+' ['+';'.join(arms)+'])'
    if kind == 'break':
        return 'SBreak'
    if kind in ('return','throw_expr'):
        return '('+('SReturn' if kind == 'return' else 'SThrow')+' '+e(node[1])+')'
    raise codec.CodecError('Unsupported Coq source statement: '+kind)


def coq_program(projection):
    header = 'From Coq Require Import ZArith List String.\nRequire Import NativeCodecSource.\nImport ListNotations. Open Scope string_scope. Open Scope Z_scope.\n'
    return header+'\n'.join('Definition actual_'+name+' : CS := '+coq_statement(method['ast'])+'.\n' for name,method in projection['methods'].items())


def source_kernel_certificate(projection, *, counterexample_first=False):
    """Universal two-field execution theorems over the independently rendered AST."""
    program = coq_program(projection).replace('Import ZArith List String.', 'Import ZArith List String Lia.').replace('Require Import NativeCodecSource.', 'Require Import CapMethodVm NumericCoercions LedgerCodec NativeCodecSource.')
    proof = r'''
Theorem source_serializer_all_payloads : forall is_struct is_buffer hash payload,
 List.length hash = 32%nat -> (List.length payload <= 32)%nat ->
 serialize_source_bytes actual_serialize is_struct is_buffer hash payload =
 Some (List.app [if is_struct then 65%nat else 64%nat;2%nat;if is_buffer then 48%nat else 40%nat;32%nat]
       (List.app hash (33%nat::List.length payload::payload))).
Proof.
 intros is_struct is_buffer hash payload Hhash Hpayload.
 do 32 (let x := fresh "h" in destruct hash as [|x hash]; [discriminate|cbn [List.length] in Hhash]).
 destruct hash; [|discriminate].
 do 33 (destruct payload as [|? payload]; [destruct is_struct; destruct is_buffer; vm_compute; reflexivity|cbn [List.length] in Hpayload]).
 lia.
Qed.
Print Assumptions source_serializer_all_payloads.

Theorem actual_serializer_ledger_refinement : forall l, legal_ledger l ->
 serialize_source_bytes actual_serialize
   (match ledger_kind l with ArrayKind => false | StructKind => true end)
   (hash_buffer l) (hash_bytes l) (encode_integer (reserved l)) = Some (encode_ledger l).
Proof.
 intros [kind buffer hash z] [Hhash [Hbytes Hz]].
 pose proof (integer_encode_decode_roundtrip z Hz) as [_ [_ Hpayload]].
 destruct kind; cbn [ledger_kind hash_buffer hash_bytes reserved encode_ledger kind_tag hash_tag];
 apply source_serializer_all_payloads; assumption.
Qed.
Print Assumptions actual_serializer_ledger_refinement.

Theorem source_serializer_reference_decoder_roundtrip : forall l tail, legal_ledger l ->
 option_map (fun bytes => decode_ledger_prefix (List.app bytes tail))
   (serialize_source_bytes actual_serialize
     (match ledger_kind l with ArrayKind => false | StructKind => true end)
     (hash_buffer l) (hash_bytes l) (encode_integer (reserved l))) = Some (Some (l,tail)).
Proof.
 intros l tail Hlegal. rewrite actual_serializer_ledger_refinement by exact Hlegal.
 change (Some (decode_ledger_prefix (List.app (encode_ledger l) tail)) = Some (Some (l,tail))).
 rewrite ledger_encode_decode_roundtrip by exact Hlegal. reflexivity.
Qed.
Print Assumptions source_serializer_reference_decoder_roundtrip.
Theorem source_deserializer_all_payloads : forall (is_struct is_buffer:bool) hash payload tail,
 List.length hash = 32%nat -> (List.length payload <= 32)%nat ->
 deserialize_source_ledger actual_deserialize
   (List.app [if is_struct then 65%nat else 64%nat;2%nat;if is_buffer then 48%nat else 40%nat;32%nat]
    (List.app hash (33%nat::List.length payload::List.app payload tail))) =
 Some (ledger (if is_struct then StructKind else ArrayKind) is_buffer hash (signed_le payload),tail).
Proof.
 intros is_struct is_buffer hash payload tail Hhash Hpayload.
 do 32 (let x := fresh "h" in destruct hash as [|x hash]; [discriminate|cbn [List.length] in Hhash]).
 destruct hash; [|discriminate].
 do 33 (destruct payload as [|? payload]; [destruct is_struct; destruct is_buffer; cbv - [signed_le]; reflexivity|cbn [List.length] in Hpayload]).
 lia.
Qed.
Print Assumptions source_deserializer_all_payloads.

Theorem actual_deserializer_ledger_refinement : forall l tail, legal_ledger l ->
 deserialize_source_ledger actual_deserialize (List.app (encode_ledger l) tail) = Some (l,tail).
Proof.
 intros [kind buffer hash z] tail [Hhash [Hbytes Hz]].
 pose proof (integer_encode_decode_roundtrip z Hz) as [Hsigned [_ Hpayload]].
 pose proof (source_deserializer_all_payloads
   (match kind with ArrayKind => false | StructKind => true end)
   buffer hash (encode_integer z) tail Hhash Hpayload) as Hactual.
 rewrite Hsigned in Hactual.
 destruct kind; unfold encode_ledger; cbn [ledger_kind hash_buffer hash_bytes reserved kind_tag hash_tag];
 repeat rewrite <- app_assoc; exact Hactual.
Qed.
Print Assumptions actual_deserializer_ledger_refinement.


Theorem actual_source_codec_roundtrip : forall l tail, legal_ledger l ->
 option_map (fun bytes => deserialize_source_ledger actual_deserialize (List.app bytes tail))
   (serialize_source_bytes actual_serialize
     (match ledger_kind l with ArrayKind => false | StructKind => true end)
     (hash_buffer l) (hash_bytes l) (encode_integer (reserved l))) = Some (Some (l,tail)).
Proof.
 intros l tail Hlegal. rewrite actual_serializer_ledger_refinement by exact Hlegal.
 change (Some (deserialize_source_ledger actual_deserialize (List.app (encode_ledger l) tail)) = Some (Some (l,tail))).
 rewrite actual_deserializer_ledger_refinement by exact Hlegal. reflexivity.
Qed.
Print Assumptions actual_source_codec_roundtrip.
'''
    if counterexample_first:
        # Same universal statement, but test the empty-suffix branch first.
        # A broken pending-count loop would otherwise normalize a huge symbolic
        # read past the ledger before reaching its concrete counterexample.
        anchor = 'intros is_struct is_buffer hash payload tail Hhash Hpayload.'
        codec.require(proof.count(anchor) == 1, 'Ambiguous source proof control anchor')
        proof = proof.replace(anchor, anchor+' destruct tail as [|? tail].')
        begin = proof.index('Theorem source_deserializer_all_payloads')
        end = proof.index('Qed.',begin)
        body = proof[begin:end]
        for tactic in (' do 32 ', ' destruct hash;', ' do 33 ', ' lia.'):
            body = body.replace('\n'+tactic, '\n all:'+tactic)
        proof = proof[:begin]+body+proof[end:]
    return program+proof
