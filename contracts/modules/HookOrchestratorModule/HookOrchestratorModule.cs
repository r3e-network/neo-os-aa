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
    /// §14 hook-orchestration module (skeleton).
    ///
    /// A v4 operation carries a per-hook proof array (operation field 12) plus
    /// the module id of every hook it names. The minimal native core shape-checks
    /// that array and never interprets it; deciding which hooks run, in which
    /// order, and whether a credential was revoked is orchestration, and
    /// orchestration is this module.
    ///
    /// The module owns two account policies:
    ///
    ///   * the hook order — the ids a caller must satisfy in the order the
    ///     account published, so a hook set is a reviewed list rather than
    ///     whatever the operation happens to name;
    ///   * the credential generation of an instance — revoking a credential
    ///     raises the generation, and every proof bound to an older generation
    ///     stops verifying without the hook being reinstalled.
    ///
    /// The module is a <b>validator-type</b> routing instance (spec §14.1: an
    /// account routes an operation to it and it runs the pre-hook chain inside
    /// its own validation callback and the post-hook chain inside its completion
    /// callback), so the core admission gate requires the
    /// <c>getModuleProfile</c> reader plus the
    /// <c>validateUserOp</c>/<c>onUserOpComplete</c> routing pair. Both routing
    /// callbacks stay fail-closed in this skeleton — inner-credential
    /// verification and pre/post hook dispatch are the integrator's policy — so
    /// an operation routed here is always rejected rather than approved without
    /// a verified credential.
    ///
    /// Storage ownership (audit L-2):
    ///   * the hook order is <b>account-level</b> — spec §14.3, table 29 fixes its
    ///     key as one record per account (<c>0x54 ‖ accountId</c>, at most one per
    ///     account) — so <see cref="OnUninstall"/> still clears the whole
    ///     account's order record; that assumption is fixed here and in the
    ///     profile (instanceIsolation false, the core refuses a second instance
    ///     of this contract on the same account);
    ///   * the credential generation is <b>instance-scoped</b> —
    ///     <c>0x02 ‖ accountId ‖ moduleId(8 BE)</c> — so uninstall clears exactly
    ///     the leaving instance's key, never the whole account prefix.
    ///
    ///   <c>0x01 ‖ accountId</c>             → serialized hook id list (account-level)
    ///   <c>0x02 ‖ accountId ‖ moduleId(8 BE)</c> → current credential generation (instance-level)
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
        // Canonical module capability profile (docs/SA-MODULE-PROTOCOL.md §12):
        // keys sorted, no whitespace, no trailing newline. The core hashes these
        // exact bytes into the install-time profile digest. The orchestrator is
        // the one composition point of the account (§14: hooks run inside its
        // routing callbacks), so it declares compositeLayer 1; it composes no
        // message domain, is not a threshold member (§15.1 forbids members being
        // the orchestration module), and the account-level hook order forces
        // instanceIsolation false.
        private const string ModuleProfileJson =
            "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":1,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"HookOrchestratorModule\",\"lifecycle\":[\"onInstall\",\"onUninstall\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_HookOrder = new byte[] { 0x01 };
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
        /// <c>onUninstall(accountId, moduleId, moduleType, deInitData)</c>: audit L-2 —
        /// the two records leave at different scopes. The credential generation is
        /// instance-scoped (<c>accountId ‖ moduleId</c>), so exactly the leaving
        /// instance's key is deleted; another instance's revoked-credential history
        /// survives an unrelated uninstall. The hook order is account-level by spec
        /// §14.3 (one <c>order ‖ accountId</c> record per account), so that record
        /// still leaves with the whole account — the assumption is pinned in the
        /// profile (instanceIsolation false) and in the class documentation.
        /// </summary>
        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            ModuleSupport.RequireCore();
            // Instance-scoped: the credential generation of THIS instance only.
            Storage.Delete(Storage.CurrentContext, ModuleSupport.Key(Prefix_Credential, accountId, moduleId));
            // Account-level (spec §14.3): the shared order record of the account.
            Storage.Delete(Storage.CurrentContext, ModuleSupport.Key(Prefix_HookOrder, accountId));
        }

        // ---- §14 routing callbacks (validator-type admission, fail-closed) ----

        /// <summary>
        /// <c>validateUserOp(accountId, operationDigest, operation)</c>: the core
        /// calls this when an operation is routed to this instance. Per spec §14.4
        /// the orchestrator must, inside this one callback, verify the inner
        /// credential and run the pre-hook chain over the order snapshot. This
        /// skeleton implements neither, so it fails closed: every operation routed
        /// here is rejected — an approval without a verified credential or the
        /// pre-hook chain would be a validation hole, not a placeholder.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            BigInteger moduleId = ModuleSupport.RequireValidationInstance(accountId);
            object[] view = ModuleSupport.Copy(operation);
            if (view.Length < 12) return false;
            if ((BigInteger)view[7] != moduleId) return false;
            // Inner credential verification and pre-hook dispatch (§14.4) are not
            // implemented in this skeleton: reject rather than approve blindly.
            return false;
        }

        /// <summary>
        /// <c>onUserOpComplete(accountId, operation, result)</c>: caller-validated
        /// no-op. Per spec §14.4 the post-hook chain would run here, in reverse
        /// order over the same snapshot; nothing the skeleton approved can reach
        /// completion, so the gate stays without the dispatch.
        /// </summary>
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

            // R-14-01: the order must be exactly the installed hook set.
            object[] order = ModuleSupport.Copy(hookIds);
            BigInteger[] installed = ModuleSupport.InstalledModuleIds(accountId, "hook", MaxHookProofs);
            ExecutionEngine.Assert(installed.Length == order.Length,
                ModuleProtocol.ErrOperationMalformed + " hook order must equal the installed hooks");
            for (int i = 0; i < installed.Length; i++)
            {
                bool found = false;
                for (int j = 0; j < order.Length && !found; j++)
                    if ((BigInteger)order[j] == installed[i]) found = true;
                ExecutionEngine.Assert(found,
                    ModuleProtocol.ErrOperationMalformed + " hook order must equal the installed hooks");
            }

            ApplyOrder(accountId, hookIds);
        }

        /// <summary><c>getHookOrder(accountId) → hookIds[]</c>, or an empty array when none was published.</summary>
        [Safe]
        public static object[] GetHookOrder(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, ModuleSupport.Key(Prefix_HookOrder, accountId));
            if (data == null) return new object[0];
            return (object[])StdLib.Deserialize(data!);
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
            // Table 45: SA_PROOF_INVALID covers proofs that are duplicated,
            // unsorted or too long — the shared 8-entry capacity is the proof
            // capacity this order lives under (§14.6).
            ExecutionEngine.Assert(order.Length <= MaxHookProofs, ModuleProtocol.ErrProofInvalid);

            BigInteger previous = BigInteger.Zero;
            for (int i = 0; i < order.Length; i++)
            {
                BigInteger hookId = (BigInteger)order[i];
                // R-14-02: elements of 0 or negative are SA_OPERATION_MALFORMED.
                ExecutionEngine.Assert(hookId > 0, ModuleProtocol.ErrOperationMalformed);
                ExecutionEngine.Assert(hookId > previous, ModuleProtocol.ErrProofInvalid);
                previous = hookId;
            }

            Storage.Put(Storage.CurrentContext, ModuleSupport.Key(Prefix_HookOrder, accountId),
                StdLib.Serialize(order));
            OnHookOrderUpdated(accountId, order.Length);
        }
    }
}
