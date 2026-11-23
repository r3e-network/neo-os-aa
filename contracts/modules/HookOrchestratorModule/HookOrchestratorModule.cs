using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Modules
{
    /// <summary>
    /// Administration of hook order and credential revocation. All execution
    /// routes use the core's hook index. This module never authorizes a UserOp.
    /// </summary>
    [DisplayName("HookOrchestratorModule")]
    [ContractPermission("*", "getAccount")]
    [ContractPermission("*", "getModules")]
    [ContractPermission("*", "getModule")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "revokeModuleCredentials")]
    [ManifestExtra("Description", "Hook order and credential-revocation module (spec §14)")]
    public class HookOrchestratorModule : SmartContract
    {
        private const string ModuleProfileJson =
            "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"HookOrchestratorModule\",\"lifecycle\":[\"onInstall\",\"onUninstall\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_Credential = new byte[] { 0x02 };

        /// <summary>The per-operation hook proof array is bounded by spec §4.2.</summary>
        private const int MaxHookProofs = 8;

        public delegate void HookOrderUpdatedHandler(UInt160 accountId, int hookCount);

        public delegate void CredentialRevokedHandler(UInt160 accountId, BigInteger moduleId, BigInteger generation);

        [DisplayName("HookOrderUpdated")]
        public static event HookOrderUpdatedHandler OnHookOrderUpdated = default!;

        [DisplayName("CredentialRevoked")]
        public static event CredentialRevokedHandler OnCredentialRevoked = default!;

        public static void _deploy(object data, bool update) => ModuleSupport.Initialize(data, update);

        // ---- module admission (spec §7.3/§12, core AssertCallbackAbi) ----

        /// <summary><c>getModuleProfile()</c>: the canonical capability profile this deployment publishes.</summary>
        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

        [Safe]
        public static UInt160 AuthorizedCore() => ModuleSupport.Core();

        public static void SetAuthorizedCore(UInt160 coreContract) => ModuleSupport.SetAuthorizedCore(coreContract);

        // ---- lifecycle dispatched by the core (spec §9, Table 10) ----

        /// <summary>
        /// <c>onInstall(accountId, moduleId, moduleType, initData)</c>.
        ///
        /// <c>initData</c> is empty, or <c>[hookIds[]]</c> to publish the first order
        /// in the same call that installs the module.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ModuleSupport.RequireCore();
            object[] data = ModuleSupport.Copy(initData);
            if (data.Length == 1) ApplyOrder(accountId, (object[])data[0]);
            else ExecutionEngine.Assert(data.Length == 0, ModuleProtocol.ErrOperationMalformed);
        }

        /// <summary>
        /// Discard the local credential history for the removed instance.
        /// </summary>
        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            ModuleSupport.RequireCore();
            // Instance-scoped: the credential generation of THIS instance only.
            Storage.Delete(Storage.CurrentContext, ModuleSupport.Key(Prefix_Credential, accountId, moduleId));
        }

        // ---- §14 routing callbacks (validator-type admission, fail-closed) ----

        /// <summary>
        /// Management authority does not grant execution authority.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            ModuleSupport.RequireValidationInstance(accountId);
            return false;
        }

        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
            => ModuleSupport.RequireCore();

        // ---- §14 hook order ----

        /// <summary>
        /// <c>setHookOrder(accountId, hookIds[])</c>.
        ///
        /// The list is the account's published order: strictly ascending, no
        /// duplicates, no entry above the protocol's proof capacity — and
        /// R-14-01 makes the order a <b>permutation</b>: it must be exactly the
        /// account's installed hook set, so this entry can never be used to
        /// skip a hook or to name an uninstalled one. Set additions and removals
        /// happen only through install/uninstall actions (§14.2); the check is
        /// made here because the governance landing of action 4 (Table 19)
        /// relies on this module-side self-check.
        /// </summary>
        public static void SetHookOrder(UInt160 accountId, object[] hookIds)
        {
            ModuleSupport.RequireActiveAccount(accountId);
            ModuleSupport.RequireAccountAdministration(accountId);

            ApplyOrder(accountId, hookIds);
        }

        /// <summary>The effective order, including installations since the last administrative review.</summary>
        [Safe]
        public static object[] GetHookOrder(UInt160 accountId)
        {
            BigInteger[] ids = ModuleSupport.InstalledModuleIds(accountId, "hook", MaxHookProofs);
            object[] order = new object[ids.Length];
            for (int i = 0; i < ids.Length; i++) order[i] = ids[i];
            return order;
        }

        // ---- §14 credential revocation ----

        /// <summary>
        /// <c>revokeCredentials(accountId, moduleId)</c>: the operative
        /// revocation is the core's restricted landing entry
        /// <c>revokeModuleCredentials</c> (H-3): it bumps the validator
        /// instance's credential generation in the core 0x52 record and the
        /// account's configuration nonce in the same call frame, which is what
        /// actually invalidates every proof bound to the old generation. The
        /// core re-checks authority itself (custody witness or an installed
        /// validator contract — this module's own witness when it calls, since
        /// the orchestrator is an installed validator) and that the target is
        /// an installed validator instance; the module-side gate below mirrors
        /// the same rule for its own entry.
        ///
        /// The local <c>Prefix_Credential</c> generation below is kept as
        /// history only: it records the same monotone counter for
        /// <c>getCredentialGeneration</c> readers, but it is the core's
        /// generation (read back through the core's <c>getModule</c>) that is
        /// the effective one — the local copy never gates anything anymore.
        /// Revocation stays monotone: there is no call that lowers a
        /// generation again, so a revoked credential cannot be revived by
        /// replaying the call that revoked it.
        /// </summary>
        public static void RevokeCredentials(UInt160 accountId, BigInteger moduleId)
        {
            ModuleSupport.RequireActiveAccount(accountId);
            ModuleSupport.RequireAccountAdministration(accountId);
            ExecutionEngine.Assert(moduleId > 0, ModuleProtocol.ErrOperationMalformed + " module id");

            // The operative path (H-3): the core advances the 0x52 credential
            // generation and the account configurationNonce atomically.
            ModuleSupport.RevokeModuleCredentials(accountId, moduleId);

            // Local historical record of the same bump (kept for
            // getCredentialGeneration readers; see the method doc above).
            byte[] key = ModuleSupport.Key(Prefix_Credential, accountId, moduleId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            BigInteger generation = data == null ? BigInteger.One : (BigInteger)data! + 1;
            Storage.Put(Storage.CurrentContext, key, generation);
            OnCredentialRevoked(accountId, moduleId, generation);
        }

        /// <summary>
        /// <c>getCredentialGeneration(accountId, moduleId)</c>: 1 for an
        /// instance that was never revoked, 0 for a module id that was never
        /// issued to this account.
        /// </summary>
        [Safe]
        public static BigInteger GetCredentialGeneration(UInt160 accountId, BigInteger moduleId)
        {
            if (moduleId <= 0) return BigInteger.Zero;
            ByteString? data = Storage.Get(Storage.CurrentContext,
                ModuleSupport.Key(Prefix_Credential, accountId, moduleId));
            return data == null ? BigInteger.One : (BigInteger)data!;
        }

        // ---- internals ----

        /// <summary>Validates and stores one order; the install callback and the ABI share it.</summary>
        private static void ApplyOrder(UInt160 accountId, object[] hookIds)
        {
            object[] order = ModuleSupport.Copy(hookIds);
            object[] effective = GetHookOrder(accountId);
            ExecutionEngine.Assert(order.Length == effective.Length, ModuleProtocol.ErrOperationMalformed);
            for (int i = 0; i < order.Length; i++)
                ExecutionEngine.Assert((BigInteger)order[i] == (BigInteger)effective[i], ModuleProtocol.ErrProofInvalid);
            OnHookOrderUpdated(accountId, order.Length);
        }
    }
}
