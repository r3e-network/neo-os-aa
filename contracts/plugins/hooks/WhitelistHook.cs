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
    /// Hook that restricts an SA account to an explicit target-contract allowlist.
    /// </summary>
    /// <remarks>
    /// Protocol v4: one hook instance per <c>(accountId, moduleId)</c>, configured
    /// through the core configuration gate (docs/SA-MODULE-PROTOCOL.md §9). The
    /// allowlist is instance-scoped, so two whitelist instances on the same
    /// account are two independent policies.
    /// </remarks>
    [DisplayName("WhitelistHook")]
#if SMARTACCOUNT_NATIVE
    [ContractPermission("0x398dc3f0227d7efac5533ed5ce9937390c158084", "getAuthorizedModuleId")]
    [ManifestExtra("SmartAccountProfile", "native-v4")]
#else
    [ContractPermission("*", "getAuthorizedModuleId")]
#endif
    [ManifestExtra("Description", "Target Contract Whitelist Hook")]
    public class WhitelistHook : SmartContract
    {
        // Canonical bytes of WhitelistHook.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"preCheck\",\"postCheck\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"WhitelistHook\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"hook\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_Whitelist = new byte[] { 0x01 };

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

        // ---- Lifecycle (core configuration gate, spec §9) ----

        /// <summary>
        /// <c>initData</c>: empty, or one command:
        /// <c>["allowTarget", targetContract]</c>.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyConfig(accountId, moduleId, initData);
        }

        /// <summary>
        /// <c>configData</c>: <c>["allowTarget", targetContract]</c> or
        /// <c>["denyTarget", targetContract]</c>.
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            ApplyConfig(accountId, moduleId, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            HookAuthority.DeleteInstancePrefix(Prefix_Whitelist, accountId, moduleId);
        }

        private static void ApplyConfig(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            string command = ModuleConfig.Name(data);
            if (command == "allowTarget")
            {
                ModuleConfig.RequireArgs(data, 1);
                SetWhitelist(accountId, moduleId, (UInt160)data[1], true);
                return;
            }
            if (command == "denyTarget")
            {
                ModuleConfig.RequireArgs(data, 1);
                SetWhitelist(accountId, moduleId, (UInt160)data[1], false);
                return;
            }
            ExecutionEngine.Assert(false, "Unknown config command");
        }

        /// <summary>
        /// Adds or removes a target contract from the instance's allowlist.
        /// </summary>
        private static void SetWhitelist(UInt160 accountId, BigInteger moduleId, UInt160 targetContract, bool allowed)
        {
            ExecutionEngine.Assert(targetContract != UInt160.Zero && targetContract.IsValid, "Invalid whitelisted target");
            byte[] key = Helper.Concat(HookAuthority.InstanceKey(Prefix_Whitelist, accountId, moduleId), (byte[])targetContract);
            if (allowed) Storage.Put(Storage.CurrentContext, key, new byte[] { 1 });
            else Storage.Delete(Storage.CurrentContext, key);
        }

        [Safe]
        public static bool IsWhitelisted(UInt160 accountId, BigInteger moduleId, UInt160 targetContract)
        {
            return Storage.Get(Storage.CurrentContext,
                Helper.Concat(HookAuthority.InstanceKey(Prefix_Whitelist, accountId, moduleId), (byte[])targetContract)) != null;
        }

        // ---- Execution callbacks (spec §9) ----

        /// <summary>
        /// Blocks execution unless the target contract is explicitly allowlisted for the instance.
        /// </summary>
        public static ByteString PreCheck(UInt160 accountId, object[] operation)
        {
            BigInteger moduleId = HookAuthority.RequirePreCheck(accountId, operation);

            UInt160 targetContract = ModuleOperation.Target(operation);
            ExecutionEngine.Assert(IsWhitelisted(accountId, moduleId, targetContract), "Target contract not in whitelist");
            return (ByteString)new byte[0];
        }

        public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
        {
            // Invariant (audit low): every exec path validates its caller, even a
            // no-op — future logic added here is guarded by construction.
            HookAuthority.RequirePostCheck(accountId, operation);
        }
    }
}
