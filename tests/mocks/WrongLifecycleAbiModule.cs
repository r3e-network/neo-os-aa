using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using System.ComponentModel;

namespace SmartAccount.Mocks
{
    /// <summary>
    /// Test-only validator whose canonical profile is well formed but whose lifecycle
    /// callback return type is deliberately wrong (<c>onInstall</c> returns Any instead
    /// of Void). The core must validate the manifest ABI shape, not only the method name
    /// (docs/SA-MODULE-PROTOCOL.md §9).
    /// </summary>
    [DisplayName("WrongLifecycleAbiModule")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only malformed validator lifecycle ABI")]
    public class WrongLifecycleAbiModule : SmartContract
    {
        // Canonical bytes of the profile this mock commits to; the validator capability
        // flags are irrelevant because binding must fail on the callback ABI.
        private const string ModuleProfileJson = "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"WrongLifecycleAbiModule\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

        // `object` compiles to ABI return type Any, not Void.
        public static object OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData) => true;

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] data) { }

        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData) { }

        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation) => true;

        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result) { }
    }
}
