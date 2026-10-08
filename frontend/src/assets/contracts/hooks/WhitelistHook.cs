using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace AbstractAccount.Hooks
{
    /// <summary>
    /// Hook that restricts an AA account to an explicit target-contract allowlist.
    /// </summary>
    /// <remarks>
    /// Use this hook when an account should only talk to a small, reviewed set of contracts.
    /// Configuration must still flow through the AA core via <c>canConfigureHook</c>.
    /// </remarks>
    [DisplayName("WhitelistHook")]
#if SMARTACCOUNT_NATIVE
    [ContractPermission("0xd9421d07adf206e9dc4be746a02e8e087fa61741", "hasModuleContext")]
    [ManifestExtra("SmartAccountProfile", "native-v1")]
#else
    [ContractPermission("*", "canExecuteHook")]
    [ContractPermission("*", "canConfigureHook")]
#endif
    [ManifestExtra("Description", "Target Contract Whitelist Hook")]
    public class WhitelistHook : SmartContract
    {
        private static readonly byte[] Prefix_Whitelist = new byte[] { 0x01 };

        public static void _deploy(object data, bool update) => HookAuthority.Initialize(data, update);

        [Safe]
        public static bool SupportsV3() => true;

        [Safe]
        public static bool SupportsComposition() => false;

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

        // AA-D-01: timelocked upgrade — Update only succeeds for an artifact pair that was
        // pinned via ProposeUpdate at least 7 days earlier.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => HookAuthority.ProposeUpdate(nefHash, manifestHash);

        public static void ConfirmUpdate(ByteString nef, string manifest) => HookAuthority.Update(nef, manifest);

        public static void CancelUpdate() => HookAuthority.CancelUpdate();

        public static void Update(ByteString nef, string manifest) => HookAuthority.Update(nef, manifest);

        /// <summary>
        /// Adds or removes a target contract from the account's allowlist.
        /// </summary>
        public static void SetWhitelist(UInt160 accountId, UInt160 targetContract, bool allowed)
        {
            HookAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            byte[] key = Helper.Concat(Prefix_Whitelist, (byte[])accountId);
            key = Helper.Concat(key, (byte[])targetContract);
            if (allowed) Storage.Put(Storage.CurrentContext, key, new byte[] { 1 });
            else Storage.Delete(Storage.CurrentContext, key);
        }

        /// <summary>
        /// Blocks execution unless the target contract is explicitly allowlisted for the account.
        /// </summary>
        public static void PreExecute(UInt160 accountId, object[] opParams)
        {
#if SMARTACCOUNT_NATIVE
            NativeAuthority.Require(HookAuthority.AuthorizedCore(), accountId, "hook", "preExecute");
#else
            HookAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
#endif
            if (opParams.Length < 1) return;
            UInt160 targetContract = (UInt160)opParams[0];

            ExecutionEngine.Assert(IsWhitelisted(accountId, targetContract), "Target contract not in whitelist");
        }

        public static void PostExecute(UInt160 accountId, object[] opParams, object result)
        {
            // Invariant (audit low): every exec path validates its caller, even a
            // no-op — future logic added here is guarded by construction.
#if SMARTACCOUNT_NATIVE
            NativeAuthority.Require(HookAuthority.AuthorizedCore(), accountId, "hook", "postExecute");
#else
            HookAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
#endif
        }

        [Safe]
        public static bool IsWhitelisted(UInt160 accountId, UInt160 targetContract)
        {
            byte[] key = Helper.Concat(Prefix_Whitelist, (byte[])accountId);
            key = Helper.Concat(key, (byte[])targetContract);
            return Storage.Get(Storage.CurrentContext, key) != null;
        }

        public static void ClearAccount(UInt160 accountId)
        {
#if SMARTACCOUNT_NATIVE
            NativeAuthority.Require(HookAuthority.AuthorizedCore(), accountId, "hook", "cleanup");
#else
            HookAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
#endif

            byte[] prefix = Helper.Concat(Prefix_Whitelist, (byte[])accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly);
            while (iterator.Next())
            {
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
            }
        }
    }
}
