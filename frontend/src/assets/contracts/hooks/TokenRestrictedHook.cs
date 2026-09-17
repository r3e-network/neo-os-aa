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
    [ContractPermission("*", "canExecuteHook")]
    [ContractPermission("*", "canConfigureHook")]
    [ManifestExtra("Description", "Hook to restrict interacting with specific high-value tokens")]
    public class TokenRestrictedHook : SmartContract
    {
        private static readonly byte[] Prefix_RestrictedTokens = new byte[] { 0x01 };
        // Audit fix M-5: transient per-execution balance snapshot of restricted tokens, used to
        // enforce the restriction by EFFECT (balance must not fall) and not just by call target.
        private static readonly byte[] Prefix_RestrictedSnapshot = new byte[] { 0x02 };

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
            byte[] key = Helper.Concat(Prefix_RestrictedTokens, (byte[])accountId);
            key = Helper.Concat(key, (byte[])token);
            
            if (isRestricted)
            {
                Storage.Put(Storage.CurrentContext, key, new byte[] { 1 });
            }
            else
            {
                Storage.Delete(Storage.CurrentContext, key);
            }
        }

        /// <summary>
        /// Aborts execution if the target contract is in the account's restricted-token set.
        /// </summary>
        public static void PreExecute(UInt160 accountId, object[] opParams)
        {
            HookAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);

            // Audit fix M-5: snapshot every restricted token's balance BEFORE the op runs. The
            // direct-target check below only sees op.TargetContract, so a call routed through a
            // whitelisted intermediary (e.g. a DEX router) that internally moves a restricted
            // token would otherwise slip past. PostExecute compares against this snapshot and
            // reverts on any net outflow, enforcing the restriction by effect regardless of path.
            SnapshotRestrictedBalances(accountId);

            if (opParams.Length < 2) return;
            UInt160 targetContract = (UInt160)opParams[0];

            byte[] key = Helper.Concat(Prefix_RestrictedTokens, (byte[])accountId);
            key = Helper.Concat(key, (byte[])targetContract);

            // Abort if trying to interact with a restricted token (e.g. NEO/GAS)
            ExecutionEngine.Assert(Storage.Get(Storage.CurrentContext, key) == null, "Interaction with restricted token is forbidden");
        }

        public static void PostExecute(UInt160 accountId, object[] opParams, object result)
        {
            HookAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
            // Audit fix M-5: a restricted token's balance must not have decreased during the op,
            // no matter which contract was called directly.
            EnforceRestrictedBalances(accountId);
        }

        private static ByteString SnapshotKey(UInt160 accountId, UInt160 token) =>
            (ByteString)Helper.Concat(Helper.Concat(Prefix_RestrictedSnapshot, (byte[])accountId), (byte[])token);

        private static BigInteger TokenBalanceOf(UInt160 token, UInt160 account) =>
            (BigInteger)Contract.Call(token, "balanceOf", CallFlags.ReadOnly, new object[] { account });

        /// <summary>
        /// Records the account's current balance of every restricted token so PostExecute can
        /// detect an outflow caused by any call path. Restricted entries are NEP-17 tokens by
        /// design ("restrict interacting with specific high-value tokens").
        /// </summary>
        private static void SnapshotRestrictedBalances(UInt160 accountId)
        {
            byte[] prefix = Helper.Concat(Prefix_RestrictedTokens, (byte[])accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (iterator.Next())
            {
                UInt160 token = (UInt160)(ByteString)iterator.Value;
                BigInteger before = TokenBalanceOf(token, accountId);
                Storage.Put(Storage.CurrentContext, SnapshotKey(accountId, token), before);
            }
        }

        /// <summary>
        /// Asserts no restricted token left the account during the op and clears the snapshots.
        /// </summary>
        private static void EnforceRestrictedBalances(UInt160 accountId)
        {
            byte[] prefix = Helper.Concat(Prefix_RestrictedTokens, (byte[])accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (iterator.Next())
            {
                UInt160 token = (UInt160)(ByteString)iterator.Value;
                ByteString snapKey = SnapshotKey(accountId, token);
                ByteString raw = Storage.Get(Storage.CurrentContext, snapKey);
                BigInteger before = raw == null ? 0 : (BigInteger)raw;
                BigInteger after = TokenBalanceOf(token, accountId);
                Storage.Delete(Storage.CurrentContext, snapKey);
                ExecutionEngine.Assert(after >= before, "Restricted token outflow (incl. via intermediary) is forbidden");
            }
        }

        public static void ClearAccount(UInt160 accountId)
        {
            HookAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);

            byte[] prefix = Helper.Concat(Prefix_RestrictedTokens, (byte[])accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly);
            while (iterator.Next())
            {
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
            }
        }
    }
}
