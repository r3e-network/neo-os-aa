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
    /// Hook that enforces per-token daily transfer ceilings for an SA account.
    /// </summary>
    /// <remarks>
    /// Protocol v4: one hook instance per <c>(accountId, moduleId)</c>, configured
    /// through the core configuration gate (<c>onInstall</c> / <c>configure</c>)
    /// rather than a standalone setter, and every key is instance-scoped
    /// (docs/SA-MODULE-PROTOCOL.md §9, §12). The hook only reads the canonical
    /// operation view and meters the account's realized balance outflows, so
    /// value moved through an intermediary contract is charged against the same
    /// limit.
    /// </remarks>
    [DisplayName("DailyLimitHook")]
#if SMARTACCOUNT_NATIVE
    [ContractPermission("0x398dc3f0227d7efac5533ed5ce9937390c158084", "getAuthorizedModuleId", "getAccountAddress")]
    [ContractPermission("*", "balanceOf")]
    [ManifestExtra("SmartAccountProfile", "native-v4")]
#else
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getProxyScriptHash")]
    [ContractPermission("*", "balanceOf")]
#endif
    [ManifestExtra("Description", "Daily Limit Policy Hook Plugin for Neo N3 SA")]
    public class DailyLimitHook : SmartContract
    {
        // Canonical bytes of DailyLimitHook.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"preCheck\",\"postCheck\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"DailyLimitHook\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"hook\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_DailyLimit = new byte[] { 0x01 };
        private static readonly byte[] Prefix_SpentToday = new byte[] { 0x02 };
        private static readonly byte[] Prefix_LastReset = new byte[] { 0x03 };
        private static readonly byte[] Prefix_TransactionHistory = new byte[] { 0x04 };
        private static readonly byte[] Prefix_TransactionCounter = new byte[] { 0x05 };
        // Audit fix H-4: transient (same-tx) snapshot of a limited token's balance so a
        // non-"transfer" outflow (transferFrom/withdraw/swap) can be metered by delta.
        private static readonly byte[] Prefix_BalanceSnapshot = new byte[] { 0x06 };
        private static readonly BigInteger OneDayMs = 24L * 60 * 60 * 1000;
        private const int MaxHistorySize = 50; // Maximum historical transactions to track for rolling window
        private const int MaxConfiguredTokens = 16; // Bound callback work from balance snapshots

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

        public class LimitConfig
        {
            public BigInteger MaxAmount;         // Maximum allowed amount
            public bool UseRollingWindow;       // If true, use rolling 24h window; if false, fixed daily reset
        }

        public class TransactionRecord
        {
            public BigInteger Timestamp;
            public BigInteger Amount;
        }

        // ---- Lifecycle (core configuration gate, spec §9) ----

        /// <summary>
        /// <c>initData</c>: empty, or one command:
        /// <c>["setDailyLimit", token, maxAmount, useRollingWindow]</c>.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyConfig(accountId, moduleId, initData);
        }

        /// <summary>
        /// <c>configData</c>: <c>["setDailyLimit", token, maxAmount, useRollingWindow]</c>
        /// or <c>["clearDailyLimit", token]</c>. <c>maxAmount == 0</c> also clears.
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);
            ApplyConfig(accountId, moduleId, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData)
        {
            HookAuthority.RequireLifecycle(accountId, moduleId);

            HookAuthority.DeleteInstancePrefix(Prefix_DailyLimit, accountId, moduleId);
            HookAuthority.DeleteInstancePrefix(Prefix_SpentToday, accountId, moduleId);
            HookAuthority.DeleteInstancePrefix(Prefix_LastReset, accountId, moduleId);
            HookAuthority.DeleteInstancePrefix(Prefix_TransactionHistory, accountId, moduleId);
            HookAuthority.DeleteInstancePrefix(Prefix_TransactionCounter, accountId, moduleId);
            HookAuthority.DeleteInstancePrefix(Prefix_BalanceSnapshot, accountId, moduleId);
        }

        private static void ApplyConfig(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            string command = ModuleConfig.Name(data);
            if (command == "setDailyLimit")
            {
                ModuleConfig.RequireArgs(data, 3);
                SetDailyLimit(accountId, moduleId, (UInt160)data[1], (BigInteger)data[2], (bool)data[3]);
                return;
            }
            if (command == "clearDailyLimit")
            {
                ModuleConfig.RequireArgs(data, 1);
                SetDailyLimit(accountId, moduleId, (UInt160)data[1], 0, false);
                return;
            }
            ExecutionEngine.Assert(false, "Unknown config command");
        }

        /// <summary>
        /// Sets or clears the maximum amount a given token may transfer in a 24-hour window.
        /// UseRollingWindow enables rolling 24h window (true) vs fixed daily reset at first transaction (false).
        /// </summary>
        private static void SetDailyLimit(UInt160 accountId, BigInteger moduleId, UInt160 token, BigInteger maxAmount, bool useRollingWindow)
        {
            ExecutionEngine.Assert(maxAmount >= 0, "Negative daily limit");
            byte[] key = TokenKey(Prefix_DailyLimit, accountId, moduleId, token);
            if (maxAmount <= 0)
            {
                Storage.Delete(Storage.CurrentContext, key);
                // Clear history when removing limit
                ClearHistoryForToken(HistoryPrefix(accountId, moduleId, token));
                Storage.Delete(Storage.CurrentContext, TokenKey(Prefix_SpentToday, accountId, moduleId, token));
                Storage.Delete(Storage.CurrentContext, TokenKey(Prefix_LastReset, accountId, moduleId, token));
                Storage.Delete(Storage.CurrentContext, TokenKey(Prefix_BalanceSnapshot, accountId, moduleId, token));
                return;
            }

            ExecutionEngine.Assert(token != UInt160.Zero && token.IsValid, "Invalid limited token");
            if (Storage.Get(Storage.CurrentContext, key) == null)
            {
                Iterator iterator = Storage.Find(Storage.CurrentContext,
                    HookAuthority.InstanceKey(Prefix_DailyLimit, accountId, moduleId), FindOptions.KeysOnly);
                int configured = 0;
                while (iterator.Next()) configured++;
                ExecutionEngine.Assert(configured < MaxConfiguredTokens, "Too many limited tokens");
            }
            LimitConfig config = new LimitConfig { MaxAmount = maxAmount, UseRollingWindow = useRollingWindow };
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(config));
        }

        [Safe]
        public static BigInteger GetDailyLimit(UInt160 accountId, BigInteger moduleId, UInt160 token)
        {
            LimitConfig? config = GetLimitConfig(accountId, moduleId, token);
            return config == null ? 0 : config!.MaxAmount;
        }

        [Safe]
        public static bool IsRollingWindow(UInt160 accountId, BigInteger moduleId, UInt160 token)
        {
            LimitConfig? config = GetLimitConfig(accountId, moduleId, token);
            return config != null && config!.UseRollingWindow;
        }

        [Safe]
        public static LimitConfig? GetLimitConfig(UInt160 accountId, BigInteger moduleId, UInt160 token)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, TokenKey(Prefix_DailyLimit, accountId, moduleId, token));
            if (data == null) return null;
            return (LimitConfig)StdLib.Deserialize(data!);
        }

        // ---- Execution callbacks (spec §9) ----

        /// <summary>
        /// Rejects transfer calls that would exceed the configured daily token limit.
        /// Returns empty hookData: the transient snapshot lives in instance storage,
        /// which is rolled back with the transaction if postCheck never runs.
        /// </summary>
        public static ByteString PreCheck(UInt160 accountId, object[] operation)
        {
            BigInteger moduleId = HookAuthority.RequirePreCheck(accountId, operation);

            // Audit fix HIGH (daily-limit bypass): the per-token, direct-target check below only
            // inspects the operation target, so a call routed through a router/intermediary
            // contract moves value WITHOUT the limited token being the direct target — slipping
            // past the meter entirely. Snapshot the account's balance of EVERY token that has a
            // configured limit before the op runs; PostCheck then meters the realized outflow of
            // each against its limit regardless of which contract was called directly. Native
            // NEO/GAS are NEP-17 (they expose balanceOf), so they are metered identically.
            SnapshotAllLimitedBalances(accountId, moduleId);

            // The ABI fast path below is only taken for a direct NEP-17 transfer of a token
            // that this instance explicitly limits. Every other operation keeps the
            // balance-delta metering of the snapshots taken above and is never rejected here.
            if (!TryReadTrackedTransfer(accountId, moduleId, operation, out UInt160 targetContract, out UInt160 fromAccount, out BigInteger amount))
            {
                return (ByteString)new byte[0];
            }
            // Fail-fast pre-check for the common direct "transfer" path: reject an obviously
            // over-limit transfer before execution. The authoritative accounting is the
            // balance-delta metering in PostCheck, which catches every value-movement path.
            ExecutionEngine.Assert(amount > 0, "Transfer amount must be positive");
            ExecutionEngine.Assert(IsProtectedTransferSource(accountId, fromAccount), "Transfer source not permitted");
            // The helper only returns true for a target with a configured limit; the guard
            // stays as a defensive no-op so this path can never fail open on a future change.
            LimitConfig? config = GetLimitConfig(accountId, moduleId, targetContract);
            if (config == null) return (ByteString)new byte[0];

            BigInteger currentTime = Runtime.Time;
            BigInteger spentToday = config!.UseRollingWindow
                ? ReadRollingUsage(accountId, moduleId, targetContract, currentTime, false)[0]
                : GetFixedWindowSpent(accountId, moduleId, targetContract, currentTime);

            BigInteger newTotal = spentToday + amount;
            // Add overflow check to prevent integer overflow attacks
            ExecutionEngine.Assert(newTotal >= spentToday, "Integer overflow in daily limit check");
            ExecutionEngine.Assert(newTotal <= config.MaxAmount, "Daily limit exceeded");
            if (config.UseRollingWindow)
            {
                ExecutionEngine.Assert(
                    GetRollingWindowRecordCount(accountId, moduleId, targetContract, currentTime) < MaxHistorySize,
                    "Daily limit history full");
            }
            return (ByteString)new byte[0];
        }

        public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
        {
            BigInteger moduleId = HookAuthority.RequirePostCheck(accountId, operation);

            // A business-level false return does not imply storage rollback. Meter the
            // observed net outflow and clear every snapshot regardless of that value. For a
            // successful direct transfer, preserve declared-value accounting as a floor, but
            // never exclude its token from balance-delta checks.
            UInt160 directToken = UInt160.Zero;
            BigInteger declaredAmount = 0;
            if (result is bool accepted && accepted
                && TryReadTrackedTransfer(accountId, moduleId, operation, out UInt160 token, out UInt160 from, out BigInteger amount)
                && IsProtectedTransferSource(accountId, from))
            {
                directToken = token;
                declaredAmount = amount;
            }
            MeterAllLimitedOutflows(accountId, moduleId, directToken, declaredAmount);
        }

        // ---- Operation view ----

        /// <summary>
        /// Recognizes a direct NEP-17 <c>transfer(from, to, amount, data)</c> whose target token
        /// has a limit configured for this instance. Any other operation returns false and is
        /// therefore left to the balance-delta metering of the configured assets.
        /// </summary>
        private static bool TryReadTrackedTransfer(UInt160 accountId, BigInteger moduleId, object[] operation,
            out UInt160 targetContract, out UInt160 fromAccount, out BigInteger amount)
        {
            targetContract = UInt160.Zero;
            fromAccount = UInt160.Zero;
            amount = 0;

            if (ModuleOperation.Method(operation) != "transfer") return false;

            // Resolve the target before reading any argument (Mark finding #7): the precise
            // ABI fast check is only meaningful for a token this instance explicitly limits.
            // A hook that limits GAS must not read a NEP-11 transfer(to, tokenId, data) — whose
            // second argument is a token id rather than an address and whose third is the
            // callback data — as a NEP-17 transfer and reject a legitimate NFT operation.
            UInt160 token = ModuleOperation.Target(operation);
            if (token == UInt160.Zero || GetLimitConfig(accountId, moduleId, token) == null) return false;

            // Exact NEP-17 shape: [from(20 bytes), to(20 bytes, non-zero), amount(integer), data].
            // A payload that does not match is metered by balance delta instead of being
            // asserted on, so a foreign ABI can never be failed closed by this hook.
            object[] args = ModuleOperation.Args(operation);
            if (args.Length != 4) return false;
            if (!(args[0] is ByteString) || ((ByteString)args[0]).Length != 20) return false;
            if (!(args[1] is ByteString) || ((ByteString)args[1]).Length != 20) return false;
            if ((UInt160)args[1] == UInt160.Zero) return false;
            if (!(args[2] is BigInteger)) return false;

            targetContract = token;
            fromAccount = (UInt160)args[0];
            amount = (BigInteger)args[2];
            return true;
        }

        // ---- Audit fix HIGH: balance-delta metering across ALL configured-limit tokens ----
        // Closes the bypass where value is moved via an intermediary/router contract so the
        // limited token is never the direct call target. The meter is driven by the account's
        // configured-limit set (not by the op target), so every configured token's realized
        // outflow is counted no matter which contract was called.

        private static byte[] TokenKey(byte[] prefix, UInt160 accountId, BigInteger moduleId, UInt160 token)
        {
            return Helper.Concat(HookAuthority.InstanceKey(prefix, accountId, moduleId), (byte[])token);
        }

        private static byte[] HistoryPrefix(UInt160 accountId, BigInteger moduleId, UInt160 token)
        {
            return Helper.Concat(HookAuthority.InstanceKey(Prefix_TransactionHistory, accountId, moduleId), (byte[])token);
        }

        private static BigInteger TokenBalanceOf(UInt160 token, UInt160 account)
        {
            object balance = Contract.Call(token, "balanceOf", CallFlags.ReadOnly, new object[] { account });
            ExecutionEngine.Assert(balance is BigInteger && (BigInteger)balance >= 0, "Invalid token balance");
            return (BigInteger)balance;
        }

        /// <summary>
        /// Snapshots the account's balance of every token that currently has a configured daily
        /// limit, before the op runs. PostCheck compares against these to meter the realized
        /// outflow of each token regardless of the call path (direct, intermediary, or native).
        /// </summary>
        private static void SnapshotAllLimitedBalances(UInt160 accountId, BigInteger moduleId)
        {
            UInt160 assetAddress = HookAuthority.AssetAddress(accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext,
                HookAuthority.InstanceKey(Prefix_DailyLimit, accountId, moduleId),
                FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (iterator.Next())
            {
                UInt160 token = (UInt160)(ByteString)iterator.Value;
                BigInteger before = TokenBalanceOf(token, assetAddress);
                Storage.Put(Storage.CurrentContext, TokenKey(Prefix_BalanceSnapshot, accountId, moduleId, token), before);
            }
        }

        /// <summary>
        /// Meters every limited token once using max(realized net debit, successful declared
        /// direct transfer). Always clears snapshots, independent of the business return value.
        /// </summary>
        private static void MeterAllLimitedOutflows(UInt160 accountId, BigInteger moduleId, UInt160 directToken, BigInteger declaredAmount)
        {
            BigInteger currentTime = Runtime.Time;
            UInt160 assetAddress = HookAuthority.AssetAddress(accountId);

            Iterator iterator = Storage.Find(Storage.CurrentContext,
                HookAuthority.InstanceKey(Prefix_DailyLimit, accountId, moduleId),
                FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (iterator.Next())
            {
                UInt160 token = (UInt160)(ByteString)iterator.Value;
                byte[] snapKey = TokenKey(Prefix_BalanceSnapshot, accountId, moduleId, token);
                ByteString? snap = Storage.Get(Storage.CurrentContext, snapKey);
                // Always clear the transient snapshot so it cannot bleed into a future op.
                Storage.Delete(Storage.CurrentContext, snapKey);

                if (snap == null) continue;            // limit added mid-op; nothing to compare against

                LimitConfig? config = GetLimitConfig(accountId, moduleId, token);
                if (config == null) continue;          // limit cleared mid-op

                BigInteger before = (BigInteger)snap;
                BigInteger after = TokenBalanceOf(token, assetAddress);
                BigInteger outflow = before - after;
                if (token == directToken && declaredAmount > outflow) outflow = declaredAmount;
                if (outflow <= 0) continue;            // inflow or no movement

                BigInteger spentToday = config!.UseRollingWindow
                    ? ReadRollingUsage(accountId, moduleId, token, currentTime, true)[0]
                    : GetFixedWindowSpent(accountId, moduleId, token, currentTime);

                BigInteger newTotal = spentToday + outflow;
                ExecutionEngine.Assert(newTotal >= spentToday, "Integer overflow in daily limit check");
                ExecutionEngine.Assert(newTotal <= config.MaxAmount, "Daily limit exceeded");

                if (config.UseRollingWindow)
                {
                    ExecutionEngine.Assert(
                        GetRollingWindowRecordCount(accountId, moduleId, token, currentTime) < MaxHistorySize,
                        "Daily limit history full");
                    RecordTransaction(accountId, moduleId, token, currentTime, outflow);
                }
                else
                {
                    StoreFixedWindowSpent(accountId, moduleId, token, currentTime, spentToday + outflow);
                }
            }
        }

        private static void ClearHistoryForToken(byte[] historyPrefix)
        {
            Iterator iterator = Storage.Find(Storage.CurrentContext, historyPrefix, FindOptions.KeysOnly);
            while (iterator.Next())
            {
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
            }
        }

        // Fixed window (original behavior) - tracks total since last reset
        private static BigInteger GetFixedWindowSpent(UInt160 accountId, BigInteger moduleId, UInt160 token, BigInteger currentTime)
        {
            byte[] spentKey = TokenKey(Prefix_SpentToday, accountId, moduleId, token);
            byte[] resetKey = TokenKey(Prefix_LastReset, accountId, moduleId, token);

            ByteString? lastResetData = Storage.Get(Storage.CurrentContext, resetKey);
            BigInteger lastReset = lastResetData == null ? 0 : (BigInteger)lastResetData;
            if (currentTime >= lastReset + OneDayMs) return 0;

            ByteString? spentData = Storage.Get(Storage.CurrentContext, spentKey);
            return spentData == null ? 0 : (BigInteger)spentData;
        }

        private static void StoreFixedWindowSpent(UInt160 accountId, BigInteger moduleId, UInt160 token, BigInteger currentTime, BigInteger amount)
        {
            byte[] spentKey = TokenKey(Prefix_SpentToday, accountId, moduleId, token);
            byte[] resetKey = TokenKey(Prefix_LastReset, accountId, moduleId, token);
            ByteString? lastResetData = Storage.Get(Storage.CurrentContext, resetKey);
            if (lastResetData == null || currentTime >= (BigInteger)lastResetData + OneDayMs)
                Storage.Put(Storage.CurrentContext, resetKey, currentTime);
            Storage.Put(Storage.CurrentContext, spentKey, amount);
        }

        // Read each record once per callback. Pruning in postCheck is atomic
        // with the target operation; no live spending is discarded on overflow.
        private static BigInteger[] ReadRollingUsage(UInt160 accountId, BigInteger moduleId, UInt160 token, BigInteger currentTime, bool prune)
        {
            byte[] prefix = HistoryPrefix(accountId, moduleId, token);
            BigInteger cutoff = currentTime - OneDayMs;
            BigInteger total = 0;
            BigInteger count = 0;
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.None);
            while (iterator.Next())
            {
                object[] item = (object[])iterator.Value;
                TransactionRecord record = (TransactionRecord)StdLib.Deserialize((ByteString)item[1]);
                if (record.Timestamp >= cutoff)
                {
                    BigInteger prior = total;
                    total += record.Amount;
                    ExecutionEngine.Assert(total >= prior, "Integer overflow in rolling window calculation");
                    count++;
                }
                else if (prune) Storage.Delete(Storage.CurrentContext, (ByteString)item[0]);
            }
            return new BigInteger[] { total, count };
        }

        // Rolling window - tracks individual transactions and sums only those within 24h
        private static BigInteger GetRollingWindowRecordCount(UInt160 accountId, BigInteger moduleId, UInt160 token, BigInteger currentTime)
        {
            byte[] historyPrefix = HistoryPrefix(accountId, moduleId, token);
            BigInteger cutoffTime = currentTime - OneDayMs;
            BigInteger count = 0;

            Iterator iterator = Storage.Find(Storage.CurrentContext, historyPrefix, FindOptions.ValuesOnly);
            while (iterator.Next())
            {
                TransactionRecord record = (TransactionRecord)StdLib.Deserialize((ByteString)iterator.Value);
                if (record.Timestamp >= cutoffTime) count++;
            }
            return count;
        }

        private static void RecordTransaction(UInt160 accountId, BigInteger moduleId, UInt160 token, BigInteger timestamp, BigInteger amount)
        {
            byte[] historyPrefix = HistoryPrefix(accountId, moduleId, token);

            // Get and increment the instance sub-counter to handle multiple transactions
            // in the same block.
            byte[] counterKey = HookAuthority.InstanceKey(Prefix_TransactionCounter, accountId, moduleId);
            ByteString? counterData = Storage.Get(Storage.CurrentContext, counterKey);
            BigInteger counter = counterData == null ? 0 : (BigInteger)counterData;
            counter++;
            Storage.Put(Storage.CurrentContext, counterKey, counter);

            // Audit fix M-6: the previous key suffix concatenated two variable-length
            // little-endian BigIntegers (timestamp + counter) with no separator, so
            // distinct (timestamp,counter) pairs could serialize to identical bytes and
            // silently overwrite a record (under-counting spend => limit bypass). The
            // per-instance counter is monotonic and per-instance unique, and pruning reads
            // the record's own Timestamp field (not the key), so a self-delimiting
            // serialization of the counter alone yields a collision-free key.
            byte[] txKey = Helper.Concat(historyPrefix, (byte[])StdLib.Serialize(counter));

            TransactionRecord record = new TransactionRecord { Timestamp = timestamp, Amount = amount };
            Storage.Put(Storage.CurrentContext, txKey, StdLib.Serialize(record));
        }

        private static bool IsProtectedTransferSource(UInt160 accountId, UInt160 from)
        {
            // The account's assets leave from the proxy address, so a transfer that
            // names the accountId as the source is not the account's own funds moving.
            return from == HookAuthority.AssetAddress(accountId);
        }
    }
}
