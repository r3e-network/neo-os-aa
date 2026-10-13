using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount
{
    internal static class NativeAuthority
    {
        [InitialValue("0xd9421d07adf206e9dc4be746a02e8e087fa61741", ContractParameterType.Hash160)]
        internal static readonly UInt160 Service = default!;

        // ABI 2 policy state belongs to one recovery authority generation. The
        // leading tag makes prefix scans disjoint from old account-only keys.
        internal static byte[] AccountKey(byte[] prefix, UInt160 accountId)
        {
            object raw = Contract.Call(Service, "getAuthorityEpoch", CallFlags.ReadOnly, new object[] { accountId });
            ExecutionEngine.Assert(raw is BigInteger, "Invalid authority epoch type");
            BigInteger epoch = (BigInteger)raw;
            ExecutionEngine.Assert(epoch >= 0 && epoch < (BigInteger.One << 64), "Invalid authority epoch range");
            byte[] encoded = new byte[8];
            for (int i = 0; i < 8; i++)
            {
                encoded[i] = (byte)(epoch & 255);
                epoch >>= 8;
            }
            return Helper.Concat(Helper.Concat(Helper.Concat(new byte[] { 0xA2 }, prefix), (byte[])accountId), encoded);
        }

        internal static void Require(UInt160 configuredCore, UInt160 accountId, string role, string phase)
        {
            ExecutionEngine.Assert(configuredCore == Service, "Wrong native SmartAccount service");
            bool authorized = (bool)Contract.Call(Service, "hasModuleContext", CallFlags.ReadOnly,
                new object[] { accountId, role, Runtime.ExecutingScriptHash, phase });
            ExecutionEngine.Assert(authorized, "Missing native module invocation context");
        }
    }
}
