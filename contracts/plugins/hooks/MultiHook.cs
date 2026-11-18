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
    /// Legacy hook combiner, retired in protocol v4.
    /// </summary>
    /// <remarks>
    /// The v4 core owns composition: one <c>hookOrder</c> list per account runs
    /// installed hooks in ascending order and replays them in reverse for
    /// <c>postCheck</c> (docs/SA-MODULE-PROTOCOL.md §1.2, §3). A migrated
    /// MultiHook account unfolds into that core-owned order, so this contract
    /// stops accepting new installs and refuses to run any callback. The
    /// contract keeps its governance surface only so the deployed artifact and
    /// its timelocked upgrade path stay addressable.
    /// </remarks>
    [DisplayName("MultiHook")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ManifestExtra("Description", "Retired composable hook; protocol v4 uses the core-owned hookOrder")]
    public class MultiHook : SmartContract
    {
        // Canonical bytes of MultiHook.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"preCheck\",\"postCheck\"],\"capabilities\":{\"compositeLayer\":1,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"MultiHook\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"hook\",\"profileVersion\":1}";

        public static void _deploy(object data, bool update) => HookAuthority.Initialize(data, update);

        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

        [Safe]
        public static UInt160 AuthorizedCore() => HookAuthority.AuthorizedCore();

        public static void SetAuthorizedCore(UInt160 coreContract) => HookAuthority.SetAuthorizedCore(coreContract);
        // Audit fix M-7: timelocked core re-pointing + exposed admin rotation lifecycle.
        public static void ProposeAuthorizedCore(UInt160 coreContract) => HookAuthority.ProposeAuthorizedCore(coreContract);
        public static void ConfirmAuthorizedCore(UInt160 coreContract) => HookAuthority.ConfirmAuthorizedCore(coreContract);
        public static void CancelAuthorizedCoreChange() => HookAuthority.CancelAuthorizedCoreChange();
        public static void RotateAdmin(UInt160 newAdmin) => HookAuthority.RotateAdmin(newAdmin);
        public static void ConfirmAdminRotation(UInt160 newAdmin) => HookAuthority.ConfirmAdminRotation(newAdmin);
        public static void CancelAdminRotation() => HookAuthority.CancelAdminRotation();

        // SA-D-01: timelocked upgrade — Update only succeeds for an artifact pair that was
        // pinned via ProposeUpdate at least 7 days earlier.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => HookAuthority.ProposeUpdate(nefHash, manifestHash);

        public static void ConfirmUpdate(ByteString nef, string manifest) => HookAuthority.Update(nef, manifest);

        public static void CancelUpdate() => HookAuthority.CancelUpdate();

        public static void Update(ByteString nef, string manifest) => HookAuthority.Update(nef, manifest);

        // ---- Lifecycle: no new installs (spec §1.2) ----

        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            ExecutionEngine.Assert(false, "MultiHook is not installable in protocol v4; use the core hookOrder");
        }

        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            ExecutionEngine.Assert(false, "MultiHook is retired in protocol v4");
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData)
        {
            // No instance storage exists: v4 never installs this contract.
            HookAuthority.RequireLifecycle(accountId, moduleId);
        }

        // ---- Execution: never runs in v4 ----

        public static ByteString PreCheck(UInt160 accountId, object[] operation)
        {
            HookAuthority.RequirePreCheck(accountId, operation);
            ExecutionEngine.Assert(false, "MultiHook is retired in protocol v4");
            return (ByteString)new byte[0];
        }

        public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
        {
            HookAuthority.RequirePostCheck(accountId, operation);
            ExecutionEngine.Assert(false, "MultiHook is retired in protocol v4");
        }
    }
}
