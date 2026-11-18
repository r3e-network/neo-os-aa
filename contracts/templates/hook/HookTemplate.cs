using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Hooks
{
    /// <summary>
    /// Minimal hook template: blocks an operation unless the target contract was
    /// explicitly enabled for the account. Fail-closed by construction.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Copy this file and <c>HookTemplate.csproj</c>, rename the class, the
    /// <c>DisplayName</c> and the storage prefix, then replace the policy inside
    /// <see cref="PreExecute"/> with your own (spending limits, rate windows, token
    /// restrictions, …). Every ceremony method here is load-bearing: the SA core refuses
    /// to bind a hook whose manifest does not expose the exact ABI this template compiles
    /// to, so keep the method names and signatures intact.
    /// </para>
    /// <para>
    /// The security rules behind each call are documented in
    /// <c>docs/PLUGIN_DEVELOPER_GUIDE.md</c>; the checklist references (PG-05 … PG-07)
    /// appear inline where they apply.
    /// </para>
    /// </remarks>
    [DisplayName("HookTemplate")]
    // The core calls back into canConfigureHook / canExecuteHook on itself.
    // Do not widen these grants.
    [ContractPermission("*", "canExecuteHook")]
    [ContractPermission("*", "canConfigureHook")]
    [ManifestExtra("Description", "SmartAccount hook plugin template")]
    public class HookTemplate : SmartContract
    {
        // Account-scoped storage (PG: shared state across accounts is forbidden).
        // Prefix 0x01 here is local to THIS contract; pick your own and never reuse the
        // 0xE0-0xE8 range, which HookAuthority reserves for admin/core/update state.
        private static readonly byte[] Prefix_Target = new byte[] { 0x01 };

        // ------------------------------------------------------------------
        // Lifecycle and authority boilerplate (keep as-is)
        // ------------------------------------------------------------------

        public static void _deploy(object data, bool update) => HookAuthority.Initialize(data, update);

        [Safe]
        public static bool SupportsV3() => true;

        // Composite containers (MultiHook) must return true here and are rejected as
        // children; a leaf hook returns false.
        [Safe]
        public static bool SupportsComposition() => false;

        [Safe]
        public static UInt160 AuthorizedCore() => HookAuthority.AuthorizedCore();

        public static void SetAuthorizedCore(UInt160 coreContract) => HookAuthority.SetAuthorizedCore(coreContract);

        // Timelocked core re-pointing (7 days): instant re-pointing would let a new "core"
        // reconfigure every bound account.
        public static void ProposeAuthorizedCore(UInt160 coreContract) => HookAuthority.ProposeAuthorizedCore(coreContract);
        public static void ConfirmAuthorizedCore(UInt160 coreContract) => HookAuthority.ConfirmAuthorizedCore(coreContract);
        public static void CancelAuthorizedCoreChange() => HookAuthority.CancelAuthorizedCoreChange();

        // Timelocked admin rotation (7 days), confirmed by the NEW admin's witness.
        public static void RotateAdmin(UInt160 newAdmin) => HookAuthority.RotateAdmin(newAdmin);
        public static void ConfirmAdminRotation(UInt160 newAdmin) => HookAuthority.ConfirmAdminRotation(newAdmin);
        public static void CancelAdminRotation() => HookAuthority.CancelAdminRotation();

        // Timelocked self-upgrade (7 days): ProposeUpdate pins sha256(nef)/sha256(manifest);
        // ConfirmUpdate applies exactly that pair after the window.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => HookAuthority.ProposeUpdate(nefHash, manifestHash);
        public static void ConfirmUpdate(ByteString nef, string manifest) => HookAuthority.Update(nef, manifest);
        public static void CancelUpdate() => HookAuthority.CancelUpdate();

        // ------------------------------------------------------------------
        // Account configuration (reached only through the SA core)
        // ------------------------------------------------------------------

        /// <summary>
        /// Enables or disables one target contract for the account. Replace this with your
        /// own policy configuration surface (limits, windows, quotas…).
        /// </summary>
        public static void SetTargetAllowed(UInt160 accountId, UInt160 targetContract, bool allowed)
        {
            // Configuration enters through the core (canConfigureHook); a direct external
            // call faults here (PG: authority validation).
            HookAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            byte[] key = Helper.Concat(HookAuthority.AccountKey(Prefix_Target, accountId), (byte[])targetContract);
            if (allowed) Storage.Put(Storage.CurrentContext, key, new byte[] { 1 });
            else Storage.Delete(Storage.CurrentContext, key);
        }

        [Safe]
        public static bool IsTargetAllowed(UInt160 accountId, UInt160 targetContract)
        {
            byte[] key = Helper.Concat(HookAuthority.AccountKey(Prefix_Target, accountId), (byte[])targetContract);
            return Storage.Get(Storage.CurrentContext, key) != null;
        }

        // ------------------------------------------------------------------
        // Execution callbacks (the part you replace)
        // ------------------------------------------------------------------

        /// <summary>
        /// Core callback before target execution. Reject by faulting
        /// (<c>ExecutionEngine.Assert(false, …)</c>) — the whole operation then aborts
        /// atomically. Never call external contracts here (PG-05 reentrancy); stage state
        /// in <c>preExecute</c> and consume it in <c>postExecute</c> instead.
        /// </summary>
        public static void PreExecute(UInt160 accountId, object[] opParams)
        {
            // Only the core's execution context may invoke policy checks.
            HookAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);

            // The core always passes the fixed 6-element operation shape
            // [target, method, args, nonce, deadline, signature]; assert it before reading
            // so a malformed callback cannot silently allow everything.
            ExecutionEngine.Assert(opParams.Length == 6, "Invalid hook operation params");
            UInt160 targetContract = (UInt160)opParams[0];

            // Fail-closed default: nothing passes unless explicitly configured.
            ExecutionEngine.Assert(IsTargetAllowed(accountId, targetContract), "Target not allowed");
        }

        /// <summary>
        /// Core callback after target execution. Keep it caller-validated even as a no-op
        /// so future logic is guarded by construction. If you consume staged state here,
        /// make it idempotent and check the result actually signals success (PG-06/PG-07).
        /// </summary>
        public static void PostExecute(UInt160 accountId, object[] opParams, object result)
        {
            HookAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
        }

        /// <summary>
        /// Mandatory lifecycle cleanup: delete every account-scoped key this contract owns
        /// for the account. Must be idempotent for never-configured accounts and must fault
        /// on failure — the core aborts the enclosing rotation/transfer on a fault here.
        /// </summary>
        public static void ClearAccount(UInt160 accountId)
        {
            HookAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            byte[] prefix = HookAuthority.AccountKey(Prefix_Target, accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly);
            while (iterator.Next())
            {
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
            }
        }
    }
}
