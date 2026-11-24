using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Modules
{
    /// <summary>Read adapter for governed account policy. Policy identities and revisions are owned by the native core.</summary>
    [DisplayName("ThresholdPolicyModule")]
    [ContractPermission("*", "getThresholdPolicy")]
    public class ThresholdPolicyModule : SmartContract
    {
        private const string ModuleProfileJson =
            "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"ThresholdPolicyModule\",\"lifecycle\":[\"onInstall\",\"onUninstall\"],\"moduleType\":\"validator\",\"profileVersion\":1}";
        public static void _deploy(object data, bool update) => ModuleSupport.Initialize(data, update);
        [Safe] public static string GetModuleProfile() => ModuleProfileJson;
        [Safe] public static UInt160 AuthorizedCore() => ModuleSupport.Core();
        public static void SetAuthorizedCore(UInt160 coreContract) => ModuleSupport.SetAuthorizedCore(coreContract);

        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(initData.Length == 0, ModuleProtocol.ErrOperationMalformed);
        }
        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData) => ModuleSupport.RequireCore();
        [Safe] public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation) => false;
        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result) => ModuleSupport.RequireCore();
        [Safe] public static object[] GetThresholdPolicy(UInt160 accountId, BigInteger policyId) =>
            (object[])Contract.Call(ModuleSupport.RequireCoreConfigured(), "getThresholdPolicy", CallFlags.ReadOnly, new object[] { accountId, policyId });
    }
}
