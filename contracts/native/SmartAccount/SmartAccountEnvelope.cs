// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccountEnvelope.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

// TRUE SOURCE: this is the only editable copy of this SmartAccount native
// contract file. The neo-native-core checkout carries a generated copy —
// regenerate it via scripts/sync_native_smartaccount.py.

using Neo.Extensions;
using Neo.IO;
using Neo.Network.P2P.Payloads;
using Neo.VM;
using Neo.VM.Types;
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Numerics;
using Array = Neo.VM.Types.Array;
using Boolean = Neo.VM.Types.Boolean;

namespace Neo.SmartContract.Native
{
    /// <summary>
    /// Canonical, inert transaction-envelope decoding for the native
    /// SmartAccount v4 entrypoints (spec §4.1): the initializer pushes exactly
    /// <c>[accountId, payload]</c> and calls <c>executeUserOp</c> (one
    /// operation Array) or <c>executeUserOps</c> (a batch Array) on the core.
    /// Anything else — additional values, foreign tails, noncanonical encodings
    /// — is rejected, so an envelope can never hide authority the operation
    /// bytes do not carry.
    /// </summary>
    internal sealed class SmartAccountEnvelope
    {
        internal const int BatchMax = SmartAccountModuleProtocol.MaxOperationsPerEnvelope;
        private const int ContainerDepthMax = SmartAccountModuleProtocol.ArgsDepthMax + 4;

        private readonly byte[][] _operations;
        private readonly byte[] _accountId;

        internal UInt160 AccountId => new(_accountId);
        internal bool IsBatch { get; }
        internal int Count => _operations.Length;

        private SmartAccountEnvelope(UInt160 accountId, bool isBatch, IReadOnlyList<Array> operations)
        {
            _accountId = accountId.ToArray();
            IsBatch = isBatch;
            _operations = new byte[operations.Count][];
            for (int i = 0; i < operations.Count; i++)
                _operations[i] = BinarySerializer.Serialize(operations[i],
                    SmartAccountModuleProtocol.OperationEncodedSizeMax,
                    SmartAccountModuleProtocol.OperationEncodedSizeMax);
        }

        /// <summary>A fresh, independent copy of one operation of the envelope.</summary>
        internal Array GetOperation(int index)
        {
            if ((uint)index >= _operations.Length)
                throw new ArgumentOutOfRangeException(nameof(index));
            MemoryReader reader = new(_operations[index]);
            return (Array)BinarySerializer.Deserialize(ref reader,
                SmartAccountModuleProtocol.OperationEncodedSizeMax,
                SmartAccountModuleProtocol.OperationEncodedSizeMax);
        }

        internal static byte[] CreateApplicationScript(UInt160 accountId, Array payload, bool isBatch)
        {
            RequireAccount(accountId);
            _ = ValidateOperations(payload, isBatch);
            using ScriptBuilder builder = new();
            EmitValue(builder, new Array([accountId.ToArray(), payload]));
            EmitTail(builder, isBatch);
            byte[] script = builder.ToArray();
            if (script.Length > Transaction.MaxTransactionSize)
                throw new FormatException("The SmartAccount envelope exceeds the maximum transaction size.");
            return script;
        }

        internal static SmartAccountEnvelope Parse(UInt160 accountId, ReadOnlySpan<byte> script)
        {
            RequireAccount(accountId);
            if (script.Length == 0 || script.Length > Transaction.MaxTransactionSize)
                throw new FormatException("The SmartAccount envelope length is outside the transaction domain.");

            byte[] singleTail = CreateTail(false);
            byte[] batchTail = CreateTail(true);
            bool isBatch;
            int prefixLength;
            if (script.EndsWith(singleTail))
            {
                isBatch = false;
                prefixLength = script.Length - singleTail.Length;
            }
            else if (script.EndsWith(batchTail))
            {
                isBatch = true;
                prefixLength = script.Length - batchTail.Length;
            }
            else
            {
                throw new FormatException(
                    "The script must call the exact native SmartAccount entrypoint for this account.");
            }

            Array arguments = DecodeInitializer(script[..prefixLength]);
            if (arguments.Type != StackItemType.Array || arguments.Count != 2
                || arguments[0] is not ByteString id || !id.GetSpan().SequenceEqual(accountId.ToArray())
                || arguments[1] is not Array payload)
                throw new FormatException("The SmartAccount entrypoint requires exactly accountId and payload.");
            IReadOnlyList<Array> operations = ValidateOperations(payload, isBatch);
            byte[] canonical = CreateApplicationScript(accountId, payload, isBatch);
            if (!script.SequenceEqual(canonical))
                throw new FormatException("The SmartAccount envelope uses a noncanonical initializer.");
            return new SmartAccountEnvelope(accountId, isBatch, operations);
        }

        private static IReadOnlyList<Array> ValidateOperations(Array payload, bool isBatch)
        {
            ArgumentNullException.ThrowIfNull(payload);
            if (payload.Type != StackItemType.Array)
                throw new FormatException("The operation or batch must use the Array type.");
            if (!isBatch)
                return [SmartAccountProtocol.ValidateUserOperation(payload)];

            if (payload.Count is 0 or > BatchMax)
                throw new FormatException("A SmartAccount batch must contain 1 through 32 operations.");
            List<Array> operations = new(payload.Count);
            foreach (StackItem item in payload)
                operations.Add(SmartAccountProtocol.ValidateUserOperation(item));
            return operations;
        }

        private static void RequireAccount(UInt160 accountId)
        {
            ArgumentNullException.ThrowIfNull(accountId);
            if (accountId == UInt160.Zero)
                throw new FormatException("The envelope requires a nonzero account identifier.");
        }

        private static byte[] CreateTail(bool isBatch)
        {
            using ScriptBuilder builder = new();
            EmitTail(builder, isBatch);
            return builder.ToArray();
        }

        private static void EmitTail(ScriptBuilder builder, bool isBatch)
        {
            builder.EmitPush((int)CallFlags.All).EmitPush(isBatch ? "executeUserOps" : "executeUserOp");
            builder.EmitPush(SmartAccountProtocol.ServiceHash.ToArray()).EmitSysCall(ApplicationEngine.System_Contract_Call);
        }

        private static void EmitValue(ScriptBuilder builder, StackItem item)
        {
            switch (item)
            {
                case Null:
                    builder.Emit(OpCode.PUSHNULL);
                    break;
                case Boolean boolean:
                    builder.EmitPush(boolean.GetBoolean());
                    break;
                case Integer integer:
                    builder.EmitPush(integer.GetInteger());
                    break;
                case ByteString bytes:
                    builder.EmitPush(bytes.GetSpan());
                    break;
                case Array array:
                    if (array.Count == 0)
                    {
                        builder.Emit(array is Struct ? OpCode.NEWSTRUCT0 : OpCode.NEWARRAY0);
                        break;
                    }
                    for (int i = array.Count - 1; i >= 0; i--)
                        EmitValue(builder, array[i]);
                    builder.EmitPush(array.Count).Emit(array is Struct ? OpCode.PACKSTRUCT : OpCode.PACK);
                    break;
                default:
                    throw new FormatException("Unsupported SmartAccount initializer type.");
            }
        }

        private readonly record struct DecodedValue(StackItem Item, int Depth);

        private static Array DecodeInitializer(ReadOnlySpan<byte> script)
        {
            Stack<DecodedValue> values = new();
            int offset = 0;
            while (offset < script.Length)
            {
                OpCode opcode = (OpCode)script[offset++];
                switch (opcode)
                {
                    case OpCode.PUSHNULL:
                        values.Push(new(StackItem.Null, 0));
                        break;
                    case OpCode.PUSHT:
                    case OpCode.PUSHF:
                        values.Push(new(opcode == OpCode.PUSHT ? StackItem.True : StackItem.False, 0));
                        break;
                    case >= OpCode.PUSHM1 and <= OpCode.PUSH16:
                        values.Push(new(new Integer((int)opcode - (int)OpCode.PUSH0), 0));
                        break;
                    case >= OpCode.PUSHINT8 and <= OpCode.PUSHINT256:
                        int width = 1 << ((int)opcode - (int)OpCode.PUSHINT8);
                        values.Push(new(new Integer(new BigInteger(ReadOperand(script, ref offset, width))), 0));
                        break;
                    case OpCode.PUSHDATA1:
                    case OpCode.PUSHDATA2:
                        int length = opcode == OpCode.PUSHDATA1
                            ? ReadOperand(script, ref offset, 1)[0]
                            : BinaryPrimitives.ReadUInt16LittleEndian(ReadOperand(script, ref offset, 2));
                        // Initializer literals are operation fields: the largest
                        // legal one is a serialized signature envelope
                        // (SignatureBytesMax), so the per-literal bound is the
                        // operation encoding bound, not the argument payload bound.
                        if (length > SmartAccountModuleProtocol.OperationEncodedSizeMax)
                            throw new FormatException(
                                "A SmartAccount initializer ByteString exceeds the profile bounds.");
                        values.Push(new(new ByteString(ReadOperand(script, ref offset, length).ToArray()), 0));
                        break;
                    case OpCode.NEWARRAY0:
                    case OpCode.NEWSTRUCT0:
                        values.Push(new(opcode == OpCode.NEWARRAY0 ? new Array() : new Struct(), 1));
                        break;
                    case OpCode.PACK:
                    case OpCode.PACKSTRUCT:
                        if (!values.TryPop(out var count) || count.Item is not Integer integer)
                            throw new FormatException("The initializer container count must be an Integer.");
                        BigInteger number = integer.GetInteger();
                        if (number <= 0 || number > values.Count)
                            throw new FormatException(
                                "The initializer container count is outside the available stack.");
                        Array array = opcode == OpCode.PACK ? new Array() : new Struct();
                        int depth = 0;
                        for (int i = 0; i < (int)number; i++)
                        {
                            DecodedValue child = values.Pop();
                            depth = Math.Max(depth, child.Depth);
                            array.Add(child.Item);
                        }
                        if (++depth > ContainerDepthMax)
                            throw new FormatException("The initializer exceeds the SmartAccount container depth.");
                        values.Push(new(array, depth));
                        break;
                    default:
                        throw new FormatException(
                            "The initializer contains an unsupported or executable opcode.");
                }
            }
            if (values.Count != 1 || values.Pop().Item is not Array payload)
                throw new FormatException("The initializer must produce exactly one argument Array.");
            return payload;
        }

        private static ReadOnlySpan<byte> ReadOperand(ReadOnlySpan<byte> script, ref int offset, int length)
        {
            if (length > script.Length - offset)
                throw new FormatException("The initializer contains a truncated operand.");
            ReadOnlySpan<byte> result = script.Slice(offset, length);
            offset += length;
            return result;
        }
    }
}
