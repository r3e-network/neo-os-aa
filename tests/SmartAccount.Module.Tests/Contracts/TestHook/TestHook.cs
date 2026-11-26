using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;
using SmartAccount.Modules;

namespace SmartAccount.ModuleTests
{
    /// <summary>
    /// Bare hook contract used only as a hook-set member by the orchestrator
    /// tests. It stores nothing, so the same deployment can be installed twice
    /// under two module ids, which is exactly what an order test needs.
    /// </summary>
    [DisplayName("TestHook")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Hook-set member used by the module test suite")]
    public class TestHook : SmartContract
    {
        public delegate void CheckedHandler(UInt160 accountId, BigInteger moduleId);

        [DisplayName("HookPreChecked")]
        public static event CheckedHandler OnHookPreChecked = default!;

        public static void _deploy(object data, bool update) { }

        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData) { }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData) { }

        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] configData) { }

        public static void SetHookOrder(UInt160 accountId, BigInteger moduleId, object[] hookIds,
            BigInteger expectedRevision) { }

        public static ByteString PreCheck(UInt160 accountId, object[] operation)
        {
            ModuleSupportShim.Touch(accountId);
            return (ByteString)new byte[0];
        }

        public static bool PostCheck(UInt160 accountId, object[] operation, ByteString hookData) => true;

        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation) => false;

        /// <summary>
        /// Drives the production <see cref="P256"/> helper — the same source
        /// file the standard modules compile — so the module suite can pin a
        /// published fixed vector against the deployed platform path instead of
        /// trusting it. It adds no cryptography of its own.
        /// </summary>
        [Safe]
        public static bool VerifyP256(ByteString preimage, ByteString publicKey, ByteString signature)
        {
            if (preimage == null || publicKey == null || signature == null) return false;
            return P256.VerifyMessage((byte[])preimage, (byte[])publicKey, (byte[])signature);
        }

        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result) { }

        [Safe]
        public static string GetModuleProfile() =>
            "{\"callbacks\":[\"preCheck\",\"postCheck\"],\"capabilities\":{\"compositeLayer\":0,"
            + "\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},"
            + "\"contractName\":\"TestHook\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],"
            + "\"moduleType\":\"hook\",\"profileVersion\":1}";
    }

    /// <summary>Keeps the hook's pre-check from being a pure constant.</summary>
    internal static class ModuleSupportShim
    {
        internal static void Touch(UInt160 accountId)
        {
            ExecutionEngine.Assert(accountId != UInt160.Zero, "SA_OPERATION_MALFORMED");
        }
    }
}
