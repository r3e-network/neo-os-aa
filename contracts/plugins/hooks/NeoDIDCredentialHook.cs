using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Hooks
{
    /// <summary>
    /// Hook that gates target-contract access on account-local NeoDID credential markers.
    /// </summary>
    /// <remarks>
    /// This hook does not perform off-chain verification itself. Instead, a trusted orchestration
    /// path issues or revokes credential flags after NeoDID or Oracle workflows succeed, and this
    /// hook enforces those flags at execution time. Protocol v4: one hook instance per
    /// <c>(accountId, moduleId)</c>, configured through the core configuration gate
    /// (docs/SA-MODULE-PROTOCOL.md §9); the registry reference stays contract-global.
    /// </remarks>
    [DisplayName("NeoDIDCredentialHook")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getBinding")]
    [ContractPermission("*", "getClaimCommitment")]
    [ManifestExtra("Description", "NeoDID Credential Check Hook")]
    public class NeoDIDCredentialHook : SmartContract
    {
        // Canonical bytes of NeoDIDCredentialHook.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"preCheck\",\"postCheck\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"NeoDIDCredentialHook\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"hook\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_RequiredProvider = new byte[] { 0x01 };
        private static readonly byte[] Prefix_RequiredClaimType = new byte[] { 0x02 };
        private static readonly byte[] Prefix_RequiredClaimCommitment = new byte[] { 0x03 };

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

        public static void ProposeRegistry(UInt160 registryContract) => HookAuthority.ProposeRegistry(registryContract);
        public static void ConfirmRegistry(UInt160 registryContract) => HookAuthority.ConfirmRegistry(registryContract);
        public static void CancelRegistryChange() => HookAuthority.CancelRegistryChange();

        // SA-D-01: timelocked upgrade — Update only succeeds for an artifact pair that was
        // pinned via ProposeUpdate at least 7 days earlier.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => HookAuthority.ProposeUpdate(nefHash, manifestHash);

        public static void ConfirmUpdate(ByteString nef, string manifest) => HookAuthority.Update(nef, manifest);

        public static void CancelUpdate() => HookAuthority.CancelUpdate();

        public static void Update(ByteString nef, string manifest) => HookAuthority.Update(nef, manifest);

        [Safe]
        public static UInt160 GetRegistry()
        {
            return HookAuthority.Registry();
        }

        public static void SetRegistry(UInt160 registryContract)
        {
            HookAuthority.SetRegistry(registryContract);
        }

        // ---- Lifecycle (core configuration gate, spec §9) ----

        /// <summary>
        /// <c>initData</c>: empty, or one command:
        /// <c>["requireCredential", targetContract, provider, claimType, claimCommitment]</c>.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyConfig(accountId, moduleId, initData);
        }

        /// <summary>
        /// <c>configData</c>: <c>["requireCredential", targetContract, provider, claimType,
        /// claimCommitment]</c> or <c>["clearRequirement", targetContract]</c>.
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            ApplyConfig(accountId, moduleId, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            HookAuthority.DeleteInstancePrefix(Prefix_RequiredProvider, accountId, moduleId);
            HookAuthority.DeleteInstancePrefix(Prefix_RequiredClaimType, accountId, moduleId);
            HookAuthority.DeleteInstancePrefix(Prefix_RequiredClaimCommitment, accountId, moduleId);
        }

        private static void ApplyConfig(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            string command = ModuleConfig.Name(data);
            if (command == "requireCredential")
            {
                ModuleConfig.RequireArgs(data, 4);
                RequireCredentialCommitmentForContract(accountId, moduleId,
                    (UInt160)data[1], (string)data[2], (string)data[3], (ByteString)data[4]);
                return;
            }
            if (command == "clearRequirement")
            {
                ModuleConfig.RequireArgs(data, 1);
                ClearRequirement(accountId, moduleId, (UInt160)data[1]);
                return;
            }
            ExecutionEngine.Assert(false, "Unknown config command");
        }

        /// <summary>
        /// Declares the exact privacy-preserving NeoDID commitment required before the account may call a target contract.
        /// Plaintext claim values are deliberately not accepted or stored.
        /// </summary>
        private static void RequireCredentialCommitmentForContract(
            UInt160 accountId,
            BigInteger moduleId,
            UInt160 targetContract,
            string provider,
            string claimType,
            ByteString claimCommitment)
        {
            ExecutionEngine.Assert(targetContract != UInt160.Zero && targetContract.IsValid, "Invalid target contract");
            if (string.IsNullOrEmpty(provider) || string.IsNullOrEmpty(claimType))
            {
                ClearRequirement(accountId, moduleId, targetContract);
                return;
            }

            ExecutionEngine.Assert(claimCommitment != null && claimCommitment.Length == 32,
                "claim commitment must be 32 bytes");

            Storage.Put(Storage.CurrentContext, BuildTargetScopedKey(Prefix_RequiredProvider, accountId, moduleId, targetContract), provider);
            Storage.Put(Storage.CurrentContext, BuildTargetScopedKey(Prefix_RequiredClaimType, accountId, moduleId, targetContract), claimType);
            Storage.Put(Storage.CurrentContext,
                BuildTargetScopedKey(Prefix_RequiredClaimCommitment, accountId, moduleId, targetContract),
                (byte[])claimCommitment!);
        }

        [Safe]
        public static string GetRequiredProvider(UInt160 accountId, BigInteger moduleId, UInt160 targetContract)
        {
            return ReadRequiredString(Prefix_RequiredProvider, accountId, moduleId, targetContract);
        }

        [Safe]
        public static string GetRequiredClaimType(UInt160 accountId, BigInteger moduleId, UInt160 targetContract)
        {
            return ReadRequiredString(Prefix_RequiredClaimType, accountId, moduleId, targetContract);
        }

        // ---- Execution callbacks (spec §9) ----

        /// <summary>
        /// Rejects execution when the target contract requires a NeoDID binding that is not active on the registry.
        /// </summary>
        public static ByteString PreCheck(UInt160 accountId, object[] operation)
        {
            BigInteger moduleId = HookAuthority.RequirePreCheck(accountId, operation);
            UInt160 targetContract = ModuleOperation.Target(operation);

            string provider = ReadRequiredString(Prefix_RequiredProvider, accountId, moduleId, targetContract);
            string claimType = ReadRequiredString(Prefix_RequiredClaimType, accountId, moduleId, targetContract);
            if (provider.Length == 0 || claimType.Length == 0) return (ByteString)new byte[0];

            UInt160 registry = GetRegistry();
            ExecutionEngine.Assert(registry != UInt160.Zero && registry.IsValid, "NeoDID registry not configured");

            object bindingObject = Contract.Call(
                registry,
                "getBinding",
                CallFlags.ReadOnly,
                new object[] { accountId, provider, claimType });
            object[] binding = (object[])bindingObject;
            ExecutionEngine.Assert(binding.Length >= 9, "NeoDID binding malformed");

            bool active = (bool)binding[8];
            ExecutionEngine.Assert(active, "NeoDID Credential Missing");

            ByteString? expectedCommitment = Storage.Get(
                Storage.CurrentContext,
                BuildTargetScopedKey(Prefix_RequiredClaimCommitment, accountId, moduleId, targetContract));
            ExecutionEngine.Assert(expectedCommitment != null && expectedCommitment.Length == 32,
                "NeoDID commitment requirement missing");

            ByteString actualCommitment = (ByteString)Contract.Call(
                registry,
                "getClaimCommitment",
                CallFlags.ReadOnly,
                new object[] { accountId, provider, claimType });
            ExecutionEngine.Assert(actualCommitment != null && actualCommitment.Length == 32,
                "NeoDID commitment missing");
            ExecutionEngine.Assert(StdLib.MemoryCompare(actualCommitment!, expectedCommitment!) == 0,
                "NeoDID commitment mismatch");
            return (ByteString)new byte[0];
        }

        public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
        {
            // Invariant (audit low): every exec path validates its caller, even a
            // no-op — future logic added here is guarded by construction.
            HookAuthority.RequirePostCheck(accountId, operation);
        }

        private static void ClearRequirement(UInt160 accountId, BigInteger moduleId, UInt160 targetContract)
        {
            Storage.Delete(Storage.CurrentContext, BuildTargetScopedKey(Prefix_RequiredProvider, accountId, moduleId, targetContract));
            Storage.Delete(Storage.CurrentContext, BuildTargetScopedKey(Prefix_RequiredClaimType, accountId, moduleId, targetContract));
            Storage.Delete(Storage.CurrentContext, BuildTargetScopedKey(Prefix_RequiredClaimCommitment, accountId, moduleId, targetContract));
        }

        private static byte[] BuildTargetScopedKey(byte[] prefix, UInt160 accountId, BigInteger moduleId, UInt160 targetContract)
        {
            return Helper.Concat(HookAuthority.InstanceKey(prefix, accountId, moduleId), (byte[])targetContract);
        }

        private static string ReadRequiredString(byte[] prefix, UInt160 accountId, BigInteger moduleId, UInt160 targetContract)
        {
            ByteString? raw = Storage.Get(Storage.CurrentContext, BuildTargetScopedKey(prefix, accountId, moduleId, targetContract));
            return raw == null ? "" : (string)raw;
        }
    }
}
