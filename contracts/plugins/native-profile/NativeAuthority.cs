using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;

namespace SmartAccount
{
    /// <summary>
    /// Native-profile builds trust exactly one core: the native SmartAccount
    /// contract. Instance authentication and per-instance storage keys are the
    /// same protocol v4 mechanism as the custom profile (ModuleContext); the
    /// only native-specific rule is that the configured core must be this
    /// pinned hash.
    /// </summary>
    internal static class NativeAuthority
    {
        [InitialValue("0x398dc3f0227d7efac5533ed5ce9937390c158084", ContractParameterType.Hash160)]
        internal static readonly UInt160 SmartAccount = default!;

        internal static void RequirePinnedCore(UInt160 configuredCore)
        {
            ExecutionEngine.Assert(configuredCore == SmartAccount, "Wrong native SmartAccount contract");
        }
    }
}
