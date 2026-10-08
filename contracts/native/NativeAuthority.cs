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

        internal static void Require(UInt160 configuredCore, UInt160 accountId, string role, string phase)
        {
            ExecutionEngine.Assert(configuredCore == Service, "Wrong native SmartAccount service");
            bool authorized = (bool)Contract.Call(Service, "hasModuleContext", CallFlags.ReadOnly,
                new object[] { accountId, role, Runtime.ExecutingScriptHash, phase });
            ExecutionEngine.Assert(authorized, "Missing native module invocation context");
        }
    }
}
