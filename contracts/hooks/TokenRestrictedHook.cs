using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace AbstractAccount.Hooks
{
    /// <summary>
    /// Hook that blocks interaction with specific token contracts for a given account.
    /// </summary>
    /// <remarks>
    /// This is useful for forbidding calls into sensitive or governance-critical assets even if
    /// the rest of the AA account remains broadly usable.
    /// </remarks>
    [DisplayName("TokenRestrictedHook")]
#if SMARTACCOUNT_NATIVE
    [ContractPermission("0xd9421d07adf206e9dc4be746a02e8e087fa61741", "hasModuleContext", "getAccountAddress", "getAuthorityEpoch")]
    [ContractPermission("*", "balanceOf")]
    [ManifestExtra("SmartAccountProfile", "native-v2")]
#else
    [ContractPermission("*", "canExecuteHook")]
    [ContractPermission("*", "canConfigureHook")]
    [ContractPermission("*", "getProxyScriptHash")]
#endif
    [ManifestExtra("Description", "Hook to restrict interacting with specific high-value tokens")]
    public class TokenRestrictedHook : SmartContract
    {
        private static readonly byte[] Prefix_RestrictedTokens = new byte[] { 0x01 };
        // Audit fix M-5: transient per-execution balance snapshot of restricted tokens, used to
        // enforce the restriction by EFFECT (balance must not fall) and not just by call target.
        private static readonly byte[] Prefix_RestrictedSnapshot = new byte[] { 0x02 };

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
        /// Marks a token contract as restricted or clears the restriction.
        /// </summary>
        public static void SetRestrictedToken(UInt160 accountId, UInt160 token, bool isRestricted)
        {
            HookAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
#if SMARTACCOUNT_NATIVE
            ExecutionEngine.Assert(token != UInt160.Zero && token.IsValid, "Invalid restricted token");
#endif
            byte[] key = HookAuthority.AccountKey(Prefix_RestrictedTokens, accountId);
            key = Helper.Concat(key, (byte[])token);
            
            if (isRestricted)
            {
                Storage.Put(Storage.CurrentContext, key, new byte[] { 1 });
            }
            else
            {
                Storage.Delete(Storage.CurrentContext, key);
#if SMARTACCOUNT_NATIVE
                Storage.Delete(Storage.CurrentContext, SnapshotKey(accountId, token));
#endif
            }
        }

        /// <summary>
        /// Aborts execution if the target contract is in the account's restricted-token set.
        /// </summary>
        public static void PreExecute(UInt160 accountId, object[] opParams)
        {
#if SMARTACCOUNT_NATIVE
            NativeAuthority.Require(HookAuthority.AuthorizedCore(), accountId, "hook", "preExecute");
            ExecutionEngine.Assert(opParams.Length == 6 && opParams[0] is ByteString && ((ByteString)opParams[0]).Length == 20,
                "Invalid native operation shape");
#else
            HookAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
#endif

            // Audit fix M-5: snapshot every restricted token's balance BEFORE the op runs. The
            // direct-target check below only sees op.TargetContract, so a call routed through a
            // whitelisted intermediary (e.g. a DEX router) that internally moves a restricted
            // token would otherwise slip past. PostExecute compares against this snapshot and
            // reverts on any net outflow, enforcing the restriction by effect regardless of path.
            SnapshotRestrictedBalances(accountId);

            if (opParams.Length < 2) return;
            UInt160 targetContract = (UInt160)opParams[0];

            byte[] key = HookAuthority.AccountKey(Prefix_RestrictedTokens, accountId);
            key = Helper.Concat(key, (byte[])targetContract);

            // Abort if trying to interact with a restricted token (e.g. NEO/GAS)
            ExecutionEngine.Assert(Storage.Get(Storage.CurrentContext, key) == null, "Interaction with restricted token is forbidden");
        }

        public static void PostExecute(UInt160 accountId, object[] opParams, object result)
        {
#if SMARTACCOUNT_NATIVE
            NativeAuthority.Require(HookAuthority.AuthorizedCore(), accountId, "hook", "postExecute");
#else
            HookAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
#endif
            // Audit fix M-5: a restricted token's balance must not have decreased during the op,
            // no matter which contract was called directly.
            EnforceRestrictedBalances(accountId);
        }

        private static ByteString SnapshotKey(UInt160 accountId, UInt160 token) =>
            (ByteString)Helper.Concat(HookAuthority.AccountKey(Prefix_RestrictedSnapshot, accountId), (byte[])token);

        /// <summary>
        /// Address that actually holds this account's assets on chain - the core's
        /// proxy script hash, not the accountId, which never holds a balance.
        /// </summary>
        private static UInt160 AssetAddressOf(UInt160 accountId)
        {
            UInt160 core = HookAuthority.AuthorizedCore();
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "authorized core not set");
#if SMARTACCOUNT_NATIVE
            return (UInt160)Contract.Call(core, "getAccountAddress", CallFlags.ReadOnly, accountId);
#else
            return (UInt160)Contract.Call(core, "getProxyScriptHash", CallFlags.ReadOnly, accountId);
#endif
        }

#if SMARTACCOUNT_NATIVE
        private static BigInteger TokenBalanceOf(UInt160 token, UInt160 account)
        {
            object value = Contract.Call(token, "balanceOf", CallFlags.ReadOnly, new object[] { account });
            ExecutionEngine.Assert(value is BigInteger && (BigInteger)value >= 0, "Invalid restricted token balance");
            return (BigInteger)value;
        }
#else
        private static BigInteger TokenBalanceOf(UInt160 token, UInt160 account) =>
            (BigInteger)Contract.Call(token, "balanceOf", CallFlags.ReadOnly, new object[] { account });
#endif

        /// <summary>
        /// Records the account's current balance of every restricted token so PostExecute can
        /// detect an outflow caused by any call path. Restricted entries are NEP-17 tokens by
        /// design ("restrict interacting with specific high-value tokens").
        /// </summary>
        private static void SnapshotRestrictedBalances(UInt160 accountId)
        {
            byte[] prefix = HookAuthority.AccountKey(Prefix_RestrictedTokens, accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (iterator.Next())
            {
                UInt160 token = (UInt160)(ByteString)iterator.Value;
                BigInteger before = TokenBalanceOf(token, AssetAddressOf(accountId));
                Storage.Put(Storage.CurrentContext, SnapshotKey(accountId, token), before);
            }
        }

        /// <summary>
        /// Asserts no restricted token left the account during the op and clears the snapshots.
        /// </summary>
        private static void EnforceRestrictedBalances(UInt160 accountId)
        {
            byte[] prefix = HookAuthority.AccountKey(Prefix_RestrictedTokens, accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (iterator.Next())
            {
                UInt160 token = (UInt160)(ByteString)iterator.Value;
                ByteString snapKey = SnapshotKey(accountId, token);
#if SMARTACCOUNT_NATIVE
                ByteString? raw = Storage.Get(Storage.CurrentContext, snapKey);
                ExecutionEngine.Assert(raw != null, "Missing restricted balance snapshot");
                BigInteger before = (BigInteger)raw!;
#else
                ByteString raw = Storage.Get(Storage.CurrentContext, snapKey);
                BigInteger before = raw == null ? 0 : (BigInteger)raw;
#endif
                BigInteger after = TokenBalanceOf(token, AssetAddressOf(accountId));
                Storage.Delete(Storage.CurrentContext, snapKey);
                ExecutionEngine.Assert(after >= before, "Restricted token outflow (incl. via intermediary) is forbidden");
            }
        }

        public static void ClearAccount(UInt160 accountId)
        {
#if SMARTACCOUNT_NATIVE
            NativeAuthority.Require(HookAuthority.AuthorizedCore(), accountId, "hook", "cleanup");
            ClearPrefix(HookAuthority.AccountKey(Prefix_RestrictedTokens, accountId));
            ClearPrefix(HookAuthority.AccountKey(Prefix_RestrictedSnapshot, accountId));
#else
            HookAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);

            byte[] prefix = HookAuthority.AccountKey(Prefix_RestrictedTokens, accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly);
            while (iterator.Next())
            {
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
            }
#endif
        }

#if SMARTACCOUNT_NATIVE
        private static void ClearPrefix(byte[] prefix)
        {
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly);
            while (iterator.Next())
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
        }
#endif
    }
}
