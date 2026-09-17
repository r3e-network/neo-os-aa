using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace AbstractAccount.Hooks
{
    /// <summary>
    /// Hook that gates target-contract access on account-local NeoDID credential markers.
    /// </summary>
    /// <remarks>
    /// This hook does not perform off-chain verification itself. Instead, a trusted orchestration
    /// path issues or revokes credential flags after NeoDID or Oracle workflows succeed, and this
    /// hook enforces those flags at execution time.
    /// </remarks>
    [DisplayName("NeoDIDCredentialHook")]
    [ContractPermission("*", "canExecuteHook")]
    [ContractPermission("*", "canConfigureHook")]
    [ContractPermission("*", "getBinding")]
    [ContractPermission("*", "getClaimCommitment")]
    [ManifestExtra("Description", "NeoDID Credential Check Hook")]
    public class NeoDIDCredentialHook : SmartContract
    {
        private static readonly byte[] Prefix_RequiredProvider = new byte[] { 0x01 };
        private static readonly byte[] Prefix_RequiredClaimType = new byte[] { 0x02 };
        private static readonly byte[] Prefix_RequiredClaimCommitment = new byte[] { 0x03 };
        public static void _deploy(object data, bool update) => HookAuthority.Initialize(data, update);

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

        // AA-D-01: timelocked upgrade — Update only succeeds for an artifact pair that was
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

        /// <summary>
        /// Declares the exact privacy-preserving NeoDID commitment required before the account may call a target contract.
        /// </summary>
        public static void RequireCredentialCommitmentForContract(
            UInt160 accountId,
            UInt160 targetContract,
            string provider,
            string claimType,
            ByteString claimCommitment)
        {
            HookAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            if (string.IsNullOrEmpty(provider) || string.IsNullOrEmpty(claimType))
            {
                ClearRequirement(accountId, targetContract);
                return;
            }

            ExecutionEngine.Assert(claimCommitment != null && claimCommitment.Length == 32,
                "claim commitment must be 32 bytes");

            Storage.Put(Storage.CurrentContext, BuildTargetScopedKey(Prefix_RequiredProvider, accountId, targetContract), provider);
            Storage.Put(Storage.CurrentContext, BuildTargetScopedKey(Prefix_RequiredClaimType, accountId, targetContract), claimType);

            Storage.Put(Storage.CurrentContext, BuildTargetScopedKey(Prefix_RequiredClaimCommitment, accountId, targetContract),
                (byte[])claimCommitment!);
        }

        /// <summary>
        /// Rejects execution when the target contract requires a NeoDID binding that is not active on the registry.
        /// </summary>
        public static void PreExecute(UInt160 accountId, object[] opParams)
        {
            HookAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
            if (opParams.Length < 1) return;
            UInt160 targetContract = (UInt160)opParams[0];

            string provider = ReadRequiredString(Prefix_RequiredProvider, accountId, targetContract);
            string claimType = ReadRequiredString(Prefix_RequiredClaimType, accountId, targetContract);
            if (provider.Length == 0 || claimType.Length == 0) return;

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

            ByteString? expectedCommitment = Storage.Get(Storage.CurrentContext,
                BuildTargetScopedKey(Prefix_RequiredClaimCommitment, accountId, targetContract));
            ExecutionEngine.Assert(expectedCommitment != null && expectedCommitment.Length == 32,
                "NeoDID commitment requirement missing");
            ByteString actualCommitment = (ByteString)Contract.Call(registry, "getClaimCommitment", CallFlags.ReadOnly,
                new object[] { accountId, provider, claimType });
            ExecutionEngine.Assert(actualCommitment != null && actualCommitment.Length == 32,
                "NeoDID commitment missing");
            ExecutionEngine.Assert(StdLib.MemoryCompare(actualCommitment!, expectedCommitment!) == 0,
                "NeoDID commitment mismatch");
        }

        public static void PostExecute(UInt160 accountId, object[] opParams, object result)
        {
            // Invariant (audit low): every exec path validates its caller, even a
            // no-op — future logic added here is guarded by construction.
            HookAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
        }

        public static void ClearAccount(UInt160 accountId)
        {
            HookAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);

            ClearPrefixForAccount(Prefix_RequiredProvider, accountId);
            ClearPrefixForAccount(Prefix_RequiredClaimType, accountId);
            ClearPrefixForAccount(Prefix_RequiredClaimCommitment, accountId);
        }

        private static void ClearPrefixForAccount(byte[] prefix, UInt160 accountId)
        {
            byte[] accountPrefix = Helper.Concat(prefix, (byte[])accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext, accountPrefix, FindOptions.KeysOnly);
            while (iterator.Next())
            {
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
            }
        }

        private static void ClearRequirement(UInt160 accountId, UInt160 targetContract)
        {
            Storage.Delete(Storage.CurrentContext, BuildTargetScopedKey(Prefix_RequiredProvider, accountId, targetContract));
            Storage.Delete(Storage.CurrentContext, BuildTargetScopedKey(Prefix_RequiredClaimType, accountId, targetContract));
            Storage.Delete(Storage.CurrentContext, BuildTargetScopedKey(Prefix_RequiredClaimCommitment, accountId, targetContract));
        }

        private static byte[] BuildTargetScopedKey(byte[] prefix, UInt160 accountId, UInt160 targetContract)
        {
            return Helper.Concat(Helper.Concat(prefix, (byte[])accountId), (byte[])targetContract);
        }

        private static string ReadRequiredString(byte[] prefix, UInt160 accountId, UInt160 targetContract)
        {
            ByteString? raw = Storage.Get(Storage.CurrentContext, BuildTargetScopedKey(prefix, accountId, targetContract));
            return raw == null ? "" : (string)raw;
        }

    }
}
