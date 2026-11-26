//
// SmartAccountTestSupport.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Native;
using Neo.VM;
using Neo.VM.Types;
using System;
using Array = Neo.VM.Types.Array;
using Boolean = Neo.VM.Types.Boolean;

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// Test-side helpers for the protocol surface the native core no longer exposes: the canonical
    /// unsigned operation bytes (what the core validates and signs) and the application script of
    /// one operation.
    /// </summary>
    internal static class SmartAccountTestSupport
    {
        /// <summary>The §4.2 canonical unsigned operation bytes (field 11 blanked) of a valid operation.</summary>
        internal static byte[] Canonical(StackItem operation) =>
            SmartAccountProtocol.ValidateOperation(operation).UnsignedBytes;

        /// <summary>
        /// The application script of one operation: the bytes the shared SDK emits for
        /// <c>codec.dynamicCall(core, "executeUserOp", [accountId, operation])</c>, NEWARRAY0 included for
        /// an empty array. The kernel only recognizes this script; it never builds one.
        /// </summary>
        internal static byte[] ExecuteUserOp(UInt160 accountId, StackItem operation)
        {
            using ScriptBuilder builder = new();
            // dynamicCall pushes the arguments in reverse (operation, then accountId), then their count and
            // PACK, so the array reads [accountId, operation].
            Push(builder, operation);
            builder.EmitPush(accountId.ToArray());
            builder.EmitPush(2).Emit(OpCode.PACK).EmitPush((int)CallFlags.All).EmitPush("executeUserOp")
                .EmitPush(SmartAccountProtocol.ServiceHash.ToArray())
                .EmitSysCall(ApplicationEngine.System_Contract_Call);
            return builder.ToArray();
        }

        private static void Push(ScriptBuilder builder, StackItem item)
        {
            switch (item)
            {
                case Null:
                    builder.Emit(OpCode.PUSHNULL);
                    break;
                case Boolean value:
                    builder.EmitPush(value.GetBoolean());
                    break;
                case Integer value:
                    builder.EmitPush(value.GetInteger());
                    break;
                case ByteString value:
                    builder.EmitPush(value.GetSpan().ToArray());
                    break;
                case Array values:
                    if (values.Count == 0)
                    {
                        builder.Emit(OpCode.NEWARRAY0);
                        break;
                    }
                    for (int i = values.Count - 1; i >= 0; i--) Push(builder, values[i]);
                    builder.EmitPush(values.Count).Emit(OpCode.PACK);
                    break;
                default:
                    throw new NotSupportedException($"The test script cannot push a {item.Type}.");
            }
        }
    }
}
