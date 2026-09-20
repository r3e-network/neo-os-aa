using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using System.ComponentModel;

namespace AbstractAccount.Mocks
{
    /// <summary>
    /// Test-only module whose method names are present but whose validation return type is
    /// deliberately wrong. A V3 marker and method-count check must not be enough to bind it.
    /// </summary>
    [DisplayName("WrongLifecycleAbiModule")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only malformed AA lifecycle ABI")]
    public class WrongLifecycleAbiModule : SmartContract
    {
        [Safe]
        public static bool SupportsV3() => true;

        // `object` compiles to ABI return type Any, not Boolean.
        public static object ValidateSignature(UInt160 accountId, object op) => true;

        public static void PostExecute(UInt160 accountId, object op, object result) { }

        public static void ClearAccount(UInt160 accountId) { }
    }
}
