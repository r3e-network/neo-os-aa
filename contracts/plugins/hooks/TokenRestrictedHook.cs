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
    /// Hook that blocks interaction with specific token contracts for a given account.
    /// </summary>
    /// <remarks>
    /// Protocol v4: one hook instance per <c>(accountId, moduleId)</c>, configured
    /// through the core configuration gate (docs/SA-MODULE-PROTOCOL.md §9). The
    /// restriction is enforced twice: by call target in <c>preCheck</c> and by
    /// effect (a restricted token's balance must not fall) in <c>postCheck</c>,
    /// which also catches a call routed through an intermediary contract.
    /// </remarks>
    [DisplayName("TokenRestrictedHook")]
#if SMARTACCOUNT_NATIVE
    [ContractPermission("0x398dc3f0227d7efac5533ed5ce9937390c158084", "getAuthorizedModuleId", "getAccountAddress")]
    [ContractPermission("*", "balanceOf")]
    [ManifestExtra("SmartAccountProfile", "native-smartaccount")]
#else
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getProxyScriptHash")]
    [ContractPermission("*", "balanceOf")]
#endif
    [ManifestExtra("Description", "Hook to restrict interacting with specific high-value tokens")]
    public class TokenRestrictedHook : SmartContract
    {
        // Canonical bytes of TokenRestrictedHook.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"preCheck\",\"postCheck\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"TokenRestrictedHook\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"hook\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_RestrictedTokens = new byte[] { 0x01 };
        // Audit fix M-5: transient per-execution balance snapshot of restricted tokens, used to
        // enforce the restriction by EFFECT (balance must not fall) and not just by call target.
        private static readonly byte[] Prefix_RestrictedSnapshot = new byte[] { 0x02 };
        private const int MaxRestrictedTokens = 16; // Bound callback work from balance snapshots

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
        /// <c>["restrictToken", token]</c>.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyConfig(accountId, moduleId, initData);
        }

        /// <summary>
        /// <c>configData</c>: <c>["restrictToken", token]</c> or
        /// <c>["unrestrictToken", token]</c>.
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] configData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            ApplyConfig(accountId, moduleId, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            HookAuthority.DeleteInstancePrefix(Prefix_RestrictedTokens, accountId, moduleId);
            HookAuthority.DeleteInstancePrefix(Prefix_RestrictedSnapshot, accountId, moduleId);
        }

        private static void ApplyConfig(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            string command = ModuleConfig.Name(data);
            if (command == "restrictToken")
            {
                ModuleConfig.RequireArgs(data, 1);
                SetRestrictedToken(accountId, moduleId, (UInt160)data[1], true);
                return;
            }
            if (command == "unrestrictToken")
            {
                ModuleConfig.RequireArgs(data, 1);
                SetRestrictedToken(accountId, moduleId, (UInt160)data[1], false);
                return;
            }
            ExecutionEngine.Assert(false, "Unknown config command");
        }

        /// <summary>
        /// Marks a token contract as restricted or clears the restriction.
        /// </summary>
        private static void SetRestrictedToken(UInt160 accountId, BigInteger moduleId, UInt160 token, bool isRestricted)
        {
            byte[] key = TokenKey(Prefix_RestrictedTokens, accountId, moduleId, token);

            if (isRestricted)
            {
                ExecutionEngine.Assert(token != UInt160.Zero && token.IsValid, "Invalid restricted token");
                if (Storage.Get(Storage.CurrentContext, key) == null)
                {
                    Iterator iterator = Storage.Find(Storage.CurrentContext,
                        HookAuthority.InstanceKey(Prefix_RestrictedTokens, accountId, moduleId), FindOptions.KeysOnly);
                    int configured = 0;
                    while (iterator.Next()) configured++;
                    ExecutionEngine.Assert(configured < MaxRestrictedTokens, "Too many restricted tokens");
                }
                Storage.Put(Storage.CurrentContext, key, new byte[] { 1 });
                return;
            }

            Storage.Delete(Storage.CurrentContext, key);
            Storage.Delete(Storage.CurrentContext, TokenKey(Prefix_RestrictedSnapshot, accountId, moduleId, token));
        }

        [Safe]
        public static bool IsRestricted(UInt160 accountId, BigInteger moduleId, UInt160 token)
        {
            return Storage.Get(Storage.CurrentContext, TokenKey(Prefix_RestrictedTokens, accountId, moduleId, token)) != null;
        }

        // ---- Execution callbacks (spec §9) ----

        /// <summary>
        /// Aborts execution if the target contract is in the account's restricted-token set.
        /// </summary>
        public static ByteString PreCheck(UInt160 accountId, object[] operation)
        {
            BigInteger moduleId = HookAuthority.RequirePreCheck(accountId, operation);

            // Audit fix M-5: snapshot every restricted token's balance BEFORE the op runs. The
            // direct-target check below only sees the operation target, so a call routed through
            // a whitelisted intermediary (e.g. a DEX router) that internally moves a restricted
            // token would otherwise slip past. PostCheck compares against this snapshot and
            // reverts on any net outflow, enforcing the restriction by effect regardless of path.
            SnapshotRestrictedBalances(accountId, moduleId);

            UInt160 targetContract = ModuleOperation.Target(operation);

            // Abort if trying to interact with a restricted token (e.g. NEO/GAS)
            ExecutionEngine.Assert(
                Storage.Get(Storage.CurrentContext, TokenKey(Prefix_RestrictedTokens, accountId, moduleId, targetContract)) == null,
                "Interaction with restricted token is forbidden");
            return (ByteString)new byte[0];
        }

        public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
        {
            BigInteger moduleId = HookAuthority.RequirePostCheck(accountId, operation);
            // Audit fix M-5: a restricted token's balance must not have decreased during the op,
            // no matter which contract was called directly.
            EnforceRestrictedBalances(accountId, moduleId);
        }

        private static byte[] TokenKey(byte[] prefix, UInt160 accountId, BigInteger moduleId, UInt160 token)
        {
            return Helper.Concat(HookAuthority.InstanceKey(prefix, accountId, moduleId), (byte[])token);
        }

        private static BigInteger TokenBalanceOf(UInt160 token, UInt160 account)
        {
            // Audit fix L-4: align with the native build — a restricted token must report
            // a non-negative integer balance; the previous blind cast let a malformed or
            // attacker-controlled return value poison the M-5 outflow comparison.
            object value = Contract.Call(token, "balanceOf", CallFlags.ReadOnly, new object[] { account });
            ExecutionEngine.Assert(value is BigInteger && (BigInteger)value >= 0, "Invalid restricted token balance");
            return (BigInteger)value;
        }

        /// <summary>
        /// Records the account's current balance of every restricted token so PostCheck can
        /// detect an outflow caused by any call path. Restricted entries are NEP-17 tokens by
        /// design ("restrict interacting with specific high-value tokens").
        /// </summary>
        private static void SnapshotRestrictedBalances(UInt160 accountId, BigInteger moduleId)
        {
            UInt160 assetAddress = HookAuthority.AssetAddress(accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext,
                HookAuthority.InstanceKey(Prefix_RestrictedTokens, accountId, moduleId),
                FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (iterator.Next())
            {
                UInt160 token = (UInt160)(ByteString)iterator.Value;
                BigInteger before = TokenBalanceOf(token, assetAddress);
                Storage.Put(Storage.CurrentContext, TokenKey(Prefix_RestrictedSnapshot, accountId, moduleId, token), before);
            }
        }

        /// <summary>
        /// Asserts no restricted token left the account during the op and clears the snapshots.
        /// </summary>
        private static void EnforceRestrictedBalances(UInt160 accountId, BigInteger moduleId)
        {
            UInt160 assetAddress = HookAuthority.AssetAddress(accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext,
                HookAuthority.InstanceKey(Prefix_RestrictedTokens, accountId, moduleId),
                FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (iterator.Next())
            {
                UInt160 token = (UInt160)(ByteString)iterator.Value;
                byte[] snapKey = TokenKey(Prefix_RestrictedSnapshot, accountId, moduleId, token);
                ByteString? raw = Storage.Get(Storage.CurrentContext, snapKey);
                ExecutionEngine.Assert(raw != null, "Missing restricted balance snapshot");
                BigInteger before = (BigInteger)raw!;
                BigInteger after = TokenBalanceOf(token, assetAddress);
                Storage.Delete(Storage.CurrentContext, snapKey);
                ExecutionEngine.Assert(after >= before, "Restricted token outflow (incl. via intermediary) is forbidden");
            }
        }
    }
}
