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
    /// Hook that enforces per-token daily transfer ceilings for an AA account.
    /// </summary>
    /// <remarks>
    /// This hook only inspects transfer-style calls and maintains rolling daily spend state
    /// inside its own storage. It is meant for treasury and user-wallet safety policies.
    /// </remarks>
    [DisplayName("DailyLimitHook")]
    [ContractPermission("*", "canExecuteHook")]
    [ContractPermission("*", "canConfigureHook")]
    [ManifestExtra("Description", "Daily Limit Policy Hook Plugin for Neo N3 AA")]
    public class DailyLimitHook : SmartContract
    {
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

        // Configuration: Only AA account can configure its own limits
        /// <summary>
        /// Sets or clears the maximum amount a given token may transfer in a 24-hour window.
        /// UseRollingWindow enables rolling 24h window (true) vs fixed daily reset at first transaction (false).
        /// </summary>
        public static void SetDailyLimit(UInt160 accountId, UInt160 token, BigInteger maxAmount, bool useRollingWindow)
        {
            HookAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            byte[] key = Helper.Concat(Helper.Concat(Prefix_DailyLimit, (byte[])accountId), (byte[])token);
            if (maxAmount <= 0)
            {
                Storage.Delete(Storage.CurrentContext, key);
                // Clear history when removing limit
                byte[] historyPrefix = Helper.Concat(Prefix_TransactionHistory, (byte[])accountId);
                ClearHistoryForToken(historyPrefix, token);
            }
            else
            {
                LimitConfig config = new LimitConfig { MaxAmount = maxAmount, UseRollingWindow = useRollingWindow };
                Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(config));
            }
        }

        [Safe]
        public static BigInteger GetDailyLimit(UInt160 accountId, UInt160 token)
        {
            byte[] key = Helper.Concat(Helper.Concat(Prefix_DailyLimit, (byte[])accountId), (byte[])token);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return 0;
            LimitConfig config = (LimitConfig)StdLib.Deserialize(data!);
            return config.MaxAmount;
        }

        [Safe]
        public static bool IsRollingWindow(UInt160 accountId, UInt160 token)
        {
            byte[] key = Helper.Concat(Helper.Concat(Prefix_DailyLimit, (byte[])accountId), (byte[])token);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return false;
            LimitConfig config = (LimitConfig)StdLib.Deserialize(data!);
            return config.UseRollingWindow;
        }

        [Safe]
        public static LimitConfig? GetLimitConfig(UInt160 accountId, UInt160 token)
        {
            byte[] key = Helper.Concat(Helper.Concat(Prefix_DailyLimit, (byte[])accountId), (byte[])token);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return null;
            return (LimitConfig)StdLib.Deserialize(data!);
        }

        /// <summary>
        /// Rejects transfer calls that would exceed the configured daily token limit.
        /// </summary>
        public static void PreExecute(UInt160 accountId, object[] opParams)
        {
            HookAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);

            // Audit fix HIGH (daily-limit bypass): the per-token, direct-target check below only
            // inspects op.TargetContract, so a call routed through a router/intermediary contract
            // or the native NEO/GAS transfer path moves value WITHOUT the limited token being the
            // direct target — slipping past the meter entirely. Mirroring TokenRestrictedHook,
            // snapshot the account's balance of EVERY token that has a configured limit before the
            // op runs; PostExecute then meters the realized outflow of each against its limit
            // regardless of which contract was called directly. Native NEO/GAS are NEP-17 (they
            // expose balanceOf), so a configured NEO/GAS limit is metered identically. Fails closed.
            SnapshotAllLimitedBalances(accountId);

            if (!TryReadTrackedTransfer(opParams, out UInt160 targetContract, out UInt160 fromAccount, out BigInteger amount))
            {
                return;
            }
            // Fail-fast pre-check for the common direct "transfer" path: reject an obviously
            // over-limit transfer before execution. The authoritative accounting is the
            // balance-delta metering in PostExecute, which catches every value-movement path.
            ExecutionEngine.Assert(amount > 0, "Transfer amount must be positive");
            ExecutionEngine.Assert(IsProtectedTransferSource(accountId, fromAccount), "Transfer source not permitted");
            LimitConfig? config = GetLimitConfig(accountId, targetContract);
            if (config == null) return; // No limit configured for this token

            BigInteger currentTime = Runtime.Time;
            BigInteger spentToday;
            if (config.UseRollingWindow)
            {
                spentToday = GetRollingWindowSpent(accountId, targetContract, currentTime);
            }
            else
            {
                spentToday = GetFixedWindowSpent(accountId, targetContract, currentTime);
            }

            BigInteger newTotal = spentToday + amount;
            // Add overflow check to prevent integer overflow attacks
            ExecutionEngine.Assert(newTotal >= spentToday, "Integer overflow in daily limit check");
            ExecutionEngine.Assert(newTotal <= config.MaxAmount, "Daily limit exceeded");
            if (config.UseRollingWindow)
            {
                ExecutionEngine.Assert(GetRollingWindowRecordCount(accountId, targetContract, currentTime) < MaxHistorySize, "Daily limit history full");
            }
        }

        public static void PostExecute(UInt160 accountId, object[] opParams, object result)
        {
            HookAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);

            // A failed op moves no funds, so nothing is accrued. The transient PreExecute
            // snapshots left behind are harmless: every PreExecute re-snapshots ALL configured
            // tokens (overwriting any stale value) before the next meter reads them.
            if (!DidExecutionSucceed(result)) return;

            // Account the directly-targeted "transfer" of a configured token by its declared
            // amount (unchanged original behaviour), then exclude that token from the balance-delta
            // pass below to avoid double counting.
            UInt160 directlyRecorded = UInt160.Zero;
            if (TryReadTrackedTransfer(opParams, out UInt160 targetContract, out UInt160 fromAccount, out BigInteger amount)
                && IsProtectedTransferSource(accountId, fromAccount))
            {
                LimitConfig? config = GetLimitConfig(accountId, targetContract);
                if (config != null)
                {
                    BigInteger currentTime = Runtime.Time;
                    if (config.UseRollingWindow)
                    {
                        RecordTransaction(accountId, targetContract, currentTime, amount);
                    }
                    else
                    {
                        BigInteger spentToday = GetFixedWindowSpent(accountId, targetContract, currentTime);
                        StoreFixedWindowSpent(accountId, targetContract, currentTime, spentToday + amount);
                    }
                    directlyRecorded = targetContract;
                }
            }

            // Audit fix HIGH: meter the realized balance delta of EVERY OTHER configured-limit
            // token against its limit. This covers transferFrom/withdraw/swap, router/intermediary-
            // routed moves, and the native NEO/GAS path, so value moved without the limited token
            // being the direct "transfer" target is still counted. Reverts the whole tx if any
            // token's limit would be exceeded. Fails closed.
            MeterAllLimitedOutflows(accountId, directlyRecorded);
        }

        public static void ClearAccount(UInt160 accountId)
        {
            HookAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);

            ClearPrefixForAccount(Prefix_DailyLimit, accountId);
            ClearPrefixForAccount(Prefix_SpentToday, accountId);
            ClearPrefixForAccount(Prefix_LastReset, accountId);
            ClearPrefixForAccount(Prefix_TransactionHistory, accountId);
            ClearPrefixForAccount(Prefix_TransactionCounter, accountId);
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

        private static void ClearHistoryForToken(byte[] historyPrefix, UInt160 token)
        {
            byte[] tokenPrefix = Helper.Concat(historyPrefix, (byte[])token);
            Iterator iterator = Storage.Find(Storage.CurrentContext, tokenPrefix, FindOptions.KeysOnly);
            while (iterator.Next())
            {
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
            }
        }

        private static bool TryReadTrackedTransfer(object[] opParams, out UInt160 targetContract, out UInt160 fromAccount, out BigInteger amount)
        {
            targetContract = UInt160.Zero;
            fromAccount = UInt160.Zero;
            amount = 0;

            if (opParams.Length < 3) return false;
            targetContract = (UInt160)opParams[0];

            string method = (string)opParams[1];
            if (method != "transfer") return false;

            object[] args = (object[])opParams[2];
            if (args.Length < 3) return false;

            fromAccount = (UInt160)args[0];
            amount = (BigInteger)args[2];
            return true;
        }

        // ---- Audit fix HIGH: balance-delta metering across ALL configured-limit tokens ----
        // Closes the bypass where value is moved via an intermediary/router contract or the
        // native NEO/GAS path so the limited token is never the direct call target. The meter is
        // driven by the account's configured-limit set (not by the op target), so every configured
        // token's realized outflow is counted no matter which contract was called.

        private static byte[] BuildBalanceSnapshotKey(UInt160 accountId, UInt160 token)
        {
            return Helper.Concat(Helper.Concat(Prefix_BalanceSnapshot, (byte[])accountId), (byte[])token);
        }

        private static BigInteger TokenBalanceOf(UInt160 token, UInt160 account)
        {
            return (BigInteger)Contract.Call(token, "balanceOf", CallFlags.ReadOnly, new object[] { account });
        }

        /// <summary>
        /// Snapshots the account's balance of every token that currently has a configured daily
        /// limit, before the op runs. PostExecute compares against these to meter the realized
        /// outflow of each token regardless of the call path (direct, intermediary, or native).
        /// </summary>
        private static void SnapshotAllLimitedBalances(UInt160 accountId)
        {
            byte[] prefix = Helper.Concat(Prefix_DailyLimit, (byte[])accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (iterator.Next())
            {
                UInt160 token = (UInt160)(ByteString)iterator.Value;
                BigInteger before = TokenBalanceOf(token, accountId);
                Storage.Put(Storage.CurrentContext, BuildBalanceSnapshotKey(accountId, token), before);
            }
        }

        /// <summary>
        /// For every configured-limit token other than <paramref name="directlyRecorded"/> (which
        /// the direct "transfer" path already accounted by its declared amount), computes the
        /// realized outflow (pre-balance minus post-balance) and meters it against that token's
        /// daily limit. Asserts (reverting the whole transaction) if any token's limit is exceeded,
        /// then records the spend. Every token's transient snapshot is cleared so stale snapshots
        /// cannot leak into a later op. Driven by the configured-limit set, so an indirect/native
        /// move is still counted no matter which contract was the direct call target. Only called
        /// after PostExecute has confirmed the op succeeded.
        /// </summary>
        private static void MeterAllLimitedOutflows(UInt160 accountId, UInt160 directlyRecorded)
        {
            BigInteger currentTime = Runtime.Time;

            byte[] prefix = Helper.Concat(Prefix_DailyLimit, (byte[])accountId);
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (iterator.Next())
            {
                UInt160 token = (UInt160)(ByteString)iterator.Value;
                byte[] snapKey = BuildBalanceSnapshotKey(accountId, token);
                ByteString? snap = Storage.Get(Storage.CurrentContext, snapKey);
                // Always clear the transient snapshot so it cannot bleed into a future op.
                Storage.Delete(Storage.CurrentContext, snapKey);

                // The directly-transferred token was already accounted by declared amount above.
                if (token == directlyRecorded) continue;
                if (snap == null) continue;            // limit added mid-op; nothing to compare against

                LimitConfig? config = GetLimitConfig(accountId, token);
                if (config == null) continue;          // limit cleared mid-op

                BigInteger before = (BigInteger)snap;
                BigInteger after = TokenBalanceOf(token, accountId);
                BigInteger outflow = before - after;
                if (outflow <= 0) continue;            // inflow or no movement

                BigInteger spentToday = config.UseRollingWindow
                    ? GetRollingWindowSpent(accountId, token, currentTime)
                    : GetFixedWindowSpent(accountId, token, currentTime);

                BigInteger newTotal = spentToday + outflow;
                ExecutionEngine.Assert(newTotal >= spentToday, "Integer overflow in daily limit check");
                ExecutionEngine.Assert(newTotal <= config.MaxAmount, "Daily limit exceeded");

                if (config.UseRollingWindow)
                {
                    ExecutionEngine.Assert(GetRollingWindowRecordCount(accountId, token, currentTime) < MaxHistorySize, "Daily limit history full");
                    RecordTransaction(accountId, token, currentTime, outflow);
                }
                else
                {
                    StoreFixedWindowSpent(accountId, token, currentTime, spentToday + outflow);
                }
            }
        }

        private static byte[] BuildTrackedKey(byte[] prefix, UInt160 accountId, UInt160 token)
        {
            return Helper.Concat(Helper.Concat(prefix, (byte[])accountId), (byte[])token);
        }

        // Fixed window (original behavior) - tracks total since last reset
        private static BigInteger GetFixedWindowSpent(UInt160 accountId, UInt160 token, BigInteger currentTime)
        {
            byte[] spentKey = BuildTrackedKey(Prefix_SpentToday, accountId, token);
            byte[] resetKey = BuildTrackedKey(Prefix_LastReset, accountId, token);

            ByteString? lastResetData = Storage.Get(Storage.CurrentContext, resetKey);
            BigInteger lastReset = lastResetData == null ? 0 : (BigInteger)lastResetData;
            if (currentTime >= lastReset + OneDayMs) return 0;

            ByteString? spentData = Storage.Get(Storage.CurrentContext, spentKey);
            return spentData == null ? 0 : (BigInteger)spentData;
        }

        private static void StoreFixedWindowSpent(UInt160 accountId, UInt160 token, BigInteger currentTime, BigInteger amount)
        {
            byte[] spentKey = BuildTrackedKey(Prefix_SpentToday, accountId, token);
            byte[] resetKey = BuildTrackedKey(Prefix_LastReset, accountId, token);
            Storage.Put(Storage.CurrentContext, resetKey, currentTime);
            Storage.Put(Storage.CurrentContext, spentKey, amount);
        }

        // Rolling window - tracks individual transactions and sums only those within 24h
        private static BigInteger GetRollingWindowSpent(UInt160 accountId, UInt160 token, BigInteger currentTime)
        {
            byte[] historyPrefix = Helper.Concat(Helper.Concat(Prefix_TransactionHistory, (byte[])accountId), (byte[])token);
            BigInteger total = 0;
            BigInteger cutoffTime = currentTime - OneDayMs;

            Iterator iterator = Storage.Find(Storage.CurrentContext, historyPrefix, FindOptions.ValuesOnly);
            while (iterator.Next())
            {
                ByteString recordData = (ByteString)iterator.Value;
                TransactionRecord record = (TransactionRecord)StdLib.Deserialize(recordData);
                if (record.Timestamp >= cutoffTime)
                {
                    BigInteger previousTotal = total;
                    total += record.Amount;
                    // Add overflow check to prevent integer overflow attacks
                    ExecutionEngine.Assert(total >= previousTotal, "Integer overflow in rolling window calculation");
                }
            }
            return total;
        }

        private static int GetRollingWindowRecordCount(UInt160 accountId, UInt160 token, BigInteger currentTime)
        {
            byte[] historyPrefix = Helper.Concat(Helper.Concat(Prefix_TransactionHistory, (byte[])accountId), (byte[])token);
            BigInteger cutoffTime = currentTime - OneDayMs;
            int count = 0;

            Iterator iterator = Storage.Find(Storage.CurrentContext, historyPrefix, FindOptions.ValuesOnly);
            while (iterator.Next())
            {
                ByteString recordData = (ByteString)iterator.Value;
                TransactionRecord record = (TransactionRecord)StdLib.Deserialize(recordData);
                if (record.Timestamp >= cutoffTime)
                {
                    count++;
                }
            }
            return count;
        }

        private static void RecordTransaction(UInt160 accountId, UInt160 token, BigInteger timestamp, BigInteger amount)
        {
            byte[] historyPrefix = Helper.Concat(Helper.Concat(Prefix_TransactionHistory, (byte[])accountId), (byte[])token);

            // Remove expired records first, then refuse to discard live spend records.
            PruneOldRecords(historyPrefix, timestamp - OneDayMs);
            ExecutionEngine.Assert(GetRollingWindowRecordCount(accountId, token, timestamp) < MaxHistorySize, "Daily limit history full");

            // Get and increment sub-counter to handle multiple transactions in the same block
            byte[] counterKey = Helper.Concat(Prefix_TransactionCounter, (byte[])accountId);
            ByteString? counterData = Storage.Get(Storage.CurrentContext, counterKey);
            BigInteger counter = counterData == null ? 0 : (BigInteger)counterData;
            counter++;
            Storage.Put(Storage.CurrentContext, counterKey, counter);

            // Audit fix M-6: the previous key suffix concatenated two variable-length
            // little-endian BigIntegers (timestamp + counter) with no separator, so
            // distinct (timestamp,counter) pairs could serialize to identical bytes and
            // silently overwrite a record (under-counting spend => limit bypass). The
            // per-account counter is monotonic and globally unique, and pruning reads the
            // record's own Timestamp field (not the key), so a self-delimiting serialization
            // of the counter alone yields a collision-free key.
            byte[] txKey = Helper.Concat(historyPrefix, (byte[])StdLib.Serialize(counter));

            TransactionRecord record = new TransactionRecord { Timestamp = timestamp, Amount = amount };
            Storage.Put(Storage.CurrentContext, txKey, StdLib.Serialize(record));
        }

        private static void PruneOldRecords(byte[] historyPrefix, BigInteger cutoffTime)
        {
            // Iterate all history entries, deserialize each to check timestamp, and delete expired ones
            Iterator iterator = Storage.Find(Storage.CurrentContext, historyPrefix, FindOptions.KeysOnly);
            int pruned = 0;
            while (iterator.Next() && pruned < MaxHistorySize)
            {
                ByteString fullKey = (ByteString)iterator.Value;
                ByteString? recordData = Storage.Get(Storage.CurrentContext, fullKey);
                if (recordData != null)
                {
                    TransactionRecord record = (TransactionRecord)StdLib.Deserialize(recordData);
                    if (record.Timestamp < cutoffTime)
                    {
                        Storage.Delete(Storage.CurrentContext, fullKey);
                        pruned++;
                    }
                }
            }
        }

        private static bool DidExecutionSucceed(object result)
        {
            if (result is bool asBool) return asBool;
            if (result is BigInteger asInteger) return asInteger != 0;
            return true;
        }

        private static bool IsProtectedTransferSource(UInt160 accountId, UInt160 from)
        {
            return from == accountId;
        }
    }
}
