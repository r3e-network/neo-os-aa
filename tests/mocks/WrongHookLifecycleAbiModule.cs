using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using System.ComponentModel;

namespace SmartAccount.Mocks
{
    /// <summary>
    /// Test-only hook whose canonical profile is well formed but whose pre callback
    /// return type is deliberately wrong (<c>preCheck</c> returns Any instead of
    /// ByteArray). The core must validate the manifest ABI shape, not only the method
    /// name (docs/SA-MODULE-PROTOCOL.md §9).
    /// </summary>
    [DisplayName("WrongHookLifecycleAbiModule")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only malformed hook lifecycle ABI")]
    public class WrongHookLifecycleAbiModule : SmartContract
    {
        // Canonical bytes of the profile this mock commits to; binding must fail on the
        // callback ABI, not on the profile.
        private const string ModuleProfileJson = "{\"callbacks\":[\"preCheck\",\"postCheck\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"WrongHookLifecycleAbiModule\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"hook\",\"profileVersion\":1}";

        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData) { }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] data) { }

        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData) { }

        // `object` compiles to ABI return type Any, not ByteArray.
        public static object PreCheck(UInt160 accountId, object[] operation) => null!;

        public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData) { }
    }
}
