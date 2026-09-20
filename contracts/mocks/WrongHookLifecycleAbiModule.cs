using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using System.ComponentModel;

namespace AbstractAccount.Mocks
{
    /// <summary>
    /// Test-only hook whose lifecycle method names exist but whose pre callback return
    /// type is deliberately wrong. The core must validate the ABI type, not only arity.
    /// </summary>
    [DisplayName("WrongHookLifecycleAbiModule")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only malformed hook lifecycle ABI")]
    public class WrongHookLifecycleAbiModule : SmartContract
    {
        [Safe]
        public static bool SupportsV3() => true;

        // `object` compiles to ABI return type Any, not Void.
        public static object PreExecute(UInt160 accountId, object[] opParams) => null!;

        public static void PostExecute(UInt160 accountId, object[] opParams, object result) { }

        public static void ClearAccount(UInt160 accountId) { }
    }
}
