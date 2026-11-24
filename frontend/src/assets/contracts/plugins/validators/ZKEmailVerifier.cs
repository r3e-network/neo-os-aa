using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Validators
{
    /// <summary>
    /// Disabled placeholder reserved for a future zkEmail proof flow.
    /// </summary>
    /// <remarks>
    /// The contract stays disabled until a real proof verifier exists: every
    /// lifecycle callback faults, so the core cannot install it (the install
    /// action is rejected) and no account can ever route an operation to it.
    /// It is kept in the tree so integrators can see the intended protocol v4
    /// surface and its profile.
    /// </remarks>
    [DisplayName("ZKEmailVerifier")]
#if SMARTACCOUNT_NATIVE
    [ContractPermission("0x398dc3f0227d7efac5533ed5ce9937390c158084", "getAuthorizedModuleId")]
    [ManifestExtra("SmartAccountProfile", "native-smartaccount")]
#else
    [ContractPermission("*", "getAuthorizedModuleId")]
#endif
    [ManifestExtra("Description", "Disabled placeholder for a future zkEmail proof validator")]
    public class ZKEmailVerifier : SmartContract
    {
        // Canonical bytes of ZKEmailVerifier.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"ZKEmailVerifier\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        private const string Disabled = "ZKEmailVerifier disabled pending real proof verification";

        public static void _deploy(object data, bool update) => ValidatorAuthority.Initialize(data, update);

        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

        [Safe]
        public static UInt160 AuthorizedCore() => ValidatorAuthority.AuthorizedCore();

        public static void SetAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.SetAuthorizedCore(coreContract);
        // Audit fix M-7 (parity with hooks): timelocked core re-pointing.
        public static void ProposeAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.ProposeAuthorizedCore(coreContract);
        public static void ConfirmAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.ConfirmAuthorizedCore(coreContract);
        public static void CancelAuthorizedCoreChange() => ValidatorAuthority.CancelAuthorizedCoreChange();

        // SA-D-01: timelocked upgrade — Update only succeeds for an artifact pair that was
        // pinned via ProposeUpdate at least 7 days earlier.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => ValidatorAuthority.ProposeUpdate(nefHash, manifestHash);

        public static void ConfirmUpdate(ByteString nef, string manifest) => ValidatorAuthority.Update(nef, manifest);

        public static void CancelUpdate() => ValidatorAuthority.CancelUpdate();

        public static void Update(ByteString nef, string manifest) => ValidatorAuthority.Update(nef, manifest);

        /// <summary>
        /// Rejects installation: a bound instance could never authorize anything,
        /// so the only correct answer is to fail the install action outright.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            ExecutionEngine.Assert(false, Disabled);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            ExecutionEngine.Assert(false, Disabled);
        }

        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            ExecutionEngine.Assert(false, Disabled);
        }

        /// <summary>Nothing is ever authorized until a real proof verifier exists.</summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation) => false;

        /// <summary>Required v4 validator callback; reached only after a successful validation.</summary>
        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
        {
            ValidatorAuthority.RequireCompletion(accountId, operation);
            ExecutionEngine.Assert(false, Disabled);
        }

        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId, BigInteger moduleId) => new ByteString[] { };
    }
}
