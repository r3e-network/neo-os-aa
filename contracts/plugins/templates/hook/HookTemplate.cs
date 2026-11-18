using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Hooks
{
    /// <summary>
    /// Minimal protocol v4 hook template: blocks an operation unless the target contract
    /// was explicitly enabled for the instance. Fail-closed by construction.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Copy this file and <c>HookTemplate.csproj</c>, rename the class, the
    /// <c>DisplayName</c>, the storage prefix and the profile literal, then replace the
    /// policy inside <see cref="PreCheck"/> with your own (spending limits, rate windows,
    /// token restrictions, …). Every ceremony method here is load-bearing: the SA core
    /// refuses to bind a hook whose manifest does not expose the exact v4 callback ABI
    /// (docs/SA-MODULE-PROTOCOL.md §9).
    /// </para>
    /// <para>
    /// Hooks are ordered by the core-owned <c>hookOrder</c> list; <c>preCheck</c> runs in
    /// ascending order and <c>postCheck</c> in reverse over the same snapshot. Do not
    /// build your own composition.
    /// </para>
    /// </remarks>
    [DisplayName("HookTemplate")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ManifestExtra("Description", "SmartAccount protocol v4 hook template")]
    public class HookTemplate : SmartContract
    {
        // Canonical module capability profile (spec §12): keys sorted, no whitespace,
        // no trailing newline. Hooks may never claim message or threshold capabilities.
        private const string ModuleProfileJson =
            "{\"callbacks\":[\"preCheck\",\"postCheck\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"HookTemplate\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"hook\",\"profileVersion\":1}";

        // Instance-scoped storage. Prefix 0x01 is local to THIS contract; pick your own
        // and never reuse the 0xE0-0xFA range the authority layer reserves.
        private static readonly byte[] Prefix_Target = new byte[] { 0x01 };

        // ------------------------------------------------------------------
        // Lifecycle and authority boilerplate (keep as-is)
        // ------------------------------------------------------------------

        public static void _deploy(object data, bool update) => HookAuthority.Initialize(data, update);

        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

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
        // Instance configuration (reached only through the SA core)
        // ------------------------------------------------------------------

        /// <summary>
        /// <c>initData</c>: empty, or one command <c>["allowTarget", targetContract]</c>.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyConfig(accountId, moduleId, initData);
        }

        /// <summary>
        /// <c>configData</c>: <c>["allowTarget", targetContract]</c> or
        /// <c>["denyTarget", targetContract]</c>. Replace this with your own policy
        /// configuration surface (limits, windows, quotas…).
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            ApplyConfig(accountId, moduleId, configData);
        }

        /// <summary>
        /// Mandatory lifecycle cleanup: delete every key this instance owns. The core calls
        /// it on uninstall and aborts the enclosing action on a fault, so it must be
        /// idempotent for never-configured instances.
        /// </summary>
        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            HookAuthority.DeleteInstancePrefix(Prefix_Target, accountId, moduleId);
        }

        private static void ApplyConfig(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            string command = ModuleConfig.Name(data);
            if (command == "allowTarget")
            {
                ModuleConfig.RequireArgs(data, 1);
                SetTargetAllowed(accountId, moduleId, (UInt160)data[1], true);
                return;
            }
            if (command == "denyTarget")
            {
                ModuleConfig.RequireArgs(data, 1);
                SetTargetAllowed(accountId, moduleId, (UInt160)data[1], false);
                return;
            }
            ExecutionEngine.Assert(false, "Unknown config command");
        }

        private static void SetTargetAllowed(UInt160 accountId, BigInteger moduleId, UInt160 targetContract, bool allowed)
        {
            byte[] key = Helper.Concat(HookAuthority.InstanceKey(Prefix_Target, accountId, moduleId), (byte[])targetContract);
            if (allowed) Storage.Put(Storage.CurrentContext, key, new byte[] { 1 });
            else Storage.Delete(Storage.CurrentContext, key);
        }

        [Safe]
        public static bool IsTargetAllowed(UInt160 accountId, BigInteger moduleId, UInt160 targetContract)
        {
            return Storage.Get(Storage.CurrentContext,
                Helper.Concat(HookAuthority.InstanceKey(Prefix_Target, accountId, moduleId), (byte[])targetContract)) != null;
        }

        // ------------------------------------------------------------------
        // Execution callbacks (the part you replace)
        // ------------------------------------------------------------------

        /// <summary>
        /// Core callback before target execution. Reject by faulting
        /// (<c>ExecutionEngine.Assert(false, …)</c>) — the whole operation then aborts
        /// atomically. Keep the work bounded (spec §11) and do not trust the shape: the
        /// core passes the canonical 13-field operation view, so read it through
        /// <see cref="ModuleOperation"/>. Return at most 512 bytes of hookData for the
        /// matching <see cref="PostCheck"/>; return an empty ByteString when none is needed.
        /// </summary>
        public static ByteString PreCheck(UInt160 accountId, object[] operation)
        {
            // Resolves the instance the core is running and rejects any other caller.
            BigInteger moduleId = HookAuthority.RequirePreCheck(accountId, operation);

            UInt160 targetContract = ModuleOperation.Target(operation);

            // Fail-closed default: nothing passes unless explicitly configured.
            ExecutionEngine.Assert(IsTargetAllowed(accountId, moduleId, targetContract), "Target not allowed");
            return (ByteString)new byte[0];
        }

        /// <summary>
        /// Core callback after target execution, receiving exactly the hookData this
        /// instance returned from <see cref="PreCheck"/>. Keep it caller-validated even as a
        /// no-op so future logic is guarded by construction; check the result actually
        /// signals success before booking any accounting.
        /// </summary>
        public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
        {
            HookAuthority.RequirePostCheck(accountId, operation);
        }
    }
}
