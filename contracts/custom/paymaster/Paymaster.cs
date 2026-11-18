using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount
{
    /// <summary>
    /// On-chain Paymaster for sponsored/gasless transactions on Neo N3 SA.
    /// Sponsors deposit GAS, create policies for which accounts and operations to fund,
    /// and relays are reimbursed automatically after successful UserOp execution.
    /// </summary>
    [DisplayName("SAPaymaster")]
    [ContractPermission("0xd2a4cff31913016155e38e474a2c06d08be276cf", "transfer")]
    // Confused-deputy closure: settlement reads the core's execution-in-flight marker so it
    // can tell the sponsored unwind from an ordinary operation routed to this contract.
    [ContractPermission("*", "isUserOpExecutionActive")]
    [ManifestExtra("Description", "On-Chain Paymaster for Sponsored Transactions on Neo N3 SA")]
    public class Paymaster : SmartContract
    {
        // ========================================================================
        // Storage Prefixes
        // ========================================================================

        private static readonly byte[] Prefix_SponsorDeposit = new byte[] { 0x01 };
        private static readonly byte[] Prefix_Policy = new byte[] { 0x02 };
        private static readonly byte[] Prefix_DailySpent = new byte[] { 0x03 };
        private static readonly byte[] Prefix_DailyReset = new byte[] { 0x04 };
        private static readonly byte[] Prefix_TotalSpent = new byte[] { 0x05 };

        private static readonly BigInteger OneDayMs = 24L * 60 * 60 * 1000;

        // ========================================================================
        // Data Structures
        // ========================================================================

        public class SponsorshipPolicy
        {
            /// <summary>Target contract restriction (UInt160.Zero = any contract).</summary>
            public UInt160 TargetContract = UInt160.Zero;

            /// <summary>Method restriction (empty = any method).</summary>
            public string Method = string.Empty;

            /// <summary>Maximum GAS reimbursement per operation (in GAS fractions, 10^8).</summary>
            public BigInteger MaxPerOp;

            /// <summary>Maximum GAS spend per 24-hour window (0 = unlimited).</summary>
            public BigInteger DailyBudget;

            /// <summary>Maximum total GAS spend across all time (0 = unlimited).</summary>
            public BigInteger TotalBudget;

            /// <summary>Expiry timestamp (0 = no expiry).</summary>
            public BigInteger ValidUntil;
        }

        // ========================================================================
        // Events
        // ========================================================================

        public delegate void DepositDelegate(UInt160 sponsor, BigInteger amount);
        public delegate void WithdrawDelegate(UInt160 sponsor, BigInteger amount);
        public delegate void PolicyDelegate(UInt160 sponsor, UInt160 accountId);
        public delegate void ReimbursedDelegate(UInt160 sponsor, UInt160 accountId, UInt160 relay, BigInteger amount);

        [DisplayName("Deposited")]
        public static event DepositDelegate OnDeposited = null!;

        [DisplayName("Withdrawn")]
        public static event WithdrawDelegate OnWithdrawn = null!;

        [DisplayName("PolicyCreated")]
        public static event PolicyDelegate OnPolicyCreated = null!;

        [DisplayName("PolicyRevoked")]
        public static event PolicyDelegate OnPolicyRevoked = null!;

        [DisplayName("Reimbursed")]
        public static event ReimbursedDelegate OnReimbursed = null!;

        // ========================================================================
        // Lifecycle
        // ========================================================================

        public static void _deploy(object data, bool update) => PaymasterAuthority.Initialize(data, update);

        [Safe]
        public static UInt160 AuthorizedCore() => PaymasterAuthority.AuthorizedCore();

        [Safe]
        public static UInt160 Admin() => PaymasterAuthority.Admin();

        public static void SetAuthorizedCore(UInt160 coreContract) => PaymasterAuthority.SetAuthorizedCore(coreContract);
        // Audit fix M-7 (parity with HookAuthority): timelocked core re-pointing.
        public static void ProposeAuthorizedCore(UInt160 coreContract) => PaymasterAuthority.ProposeAuthorizedCore(coreContract);
        public static void ConfirmAuthorizedCore(UInt160 coreContract) => PaymasterAuthority.ConfirmAuthorizedCore(coreContract);
        public static void CancelAuthorizedCoreChange() => PaymasterAuthority.CancelAuthorizedCoreChange();

        public static void RotateAdmin(UInt160 newAdmin) => PaymasterAuthority.RotateAdmin(newAdmin);

        public static void ConfirmAdminRotation(UInt160 newAdmin) => PaymasterAuthority.ConfirmAdminRotation(newAdmin);

        public static void CancelAdminRotation() => PaymasterAuthority.CancelAdminRotation();

        // SA-D-01: contract upgrade is timelocked. The admin proposes the sha256 of the
        // new NEF and manifest, then can only apply that exact artifact pair after the
        // 7-day window. One-way: once deployed, every future upgrade waits 7 days.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => PaymasterAuthority.ProposeUpdate(nefHash, manifestHash);

        public static void ConfirmUpdate(ByteString nef, string manifest) => Update(nef, manifest);

        public static void CancelUpdate() => PaymasterAuthority.CancelUpdate();

        /// <summary>
        /// Upgrades the Paymaster contract. Admin-only, and only after a matching
        /// <c>ProposeUpdate</c> has aged past the 7-day timelock (SA-D-01).
        /// </summary>
        public static void Update(ByteString nef, string manifest)
        {
            UInt160 admin = PaymasterAuthority.Admin();
            ExecutionEngine.Assert(admin != UInt160.Zero, "No admin set");
            ExecutionEngine.Assert(Runtime.CheckWitness(admin), "Not admin");
            PaymasterAuthority.AssertConfirmableUpdate(nef, manifest);
            ContractManagement.Update(nef, manifest);
        }

        // ========================================================================
        // 1. GAS Deposits (NEP-17 Receive)
        // ========================================================================

        /// <summary>
        /// Accepts GAS deposits from sponsors. Called automatically when GAS is transferred
        /// to this contract via NEP-17 transfer. The sender is credited as the sponsor.
        /// </summary>
        public static void OnNEP17Payment(UInt160 from, BigInteger amount, object data)
        {
            ExecutionEngine.Assert(Runtime.CallingScriptHash == GAS.Hash, "Only GAS accepted");
            ExecutionEngine.Assert(amount > 0, "Amount must be positive");
            ExecutionEngine.Assert(from != null && from != UInt160.Zero, "Invalid sender");

            BigInteger current = GetSponsorDeposit(from!);
            BigInteger newBalance = current + amount;
            ExecutionEngine.Assert(newBalance >= current, "Deposit overflow");
            SetSponsorDeposit(from!, newBalance);

            OnDeposited(from!, amount);
        }

        /// <summary>
        /// Withdraws GAS from the sponsor's deposit back to their address.
        /// </summary>
        public static void WithdrawDeposit(BigInteger amount)
        {
            UInt160 sender = Runtime.Transaction.Sender;
            ExecutionEngine.Assert(Runtime.CheckWitness(sender), "Unauthorized");
            ExecutionEngine.Assert(amount > 0, "Amount must be positive");

            BigInteger balance = GetSponsorDeposit(sender);
            ExecutionEngine.Assert(amount <= balance, "Insufficient deposit");

            SetSponsorDeposit(sender, balance - amount);

            bool transferred = (bool)Contract.Call(
                GAS.Hash, "transfer", CallFlags.All,
                new object[] { Runtime.ExecutingScriptHash, sender, amount, null! });
            ExecutionEngine.Assert(transferred, "GAS transfer failed");

            OnWithdrawn(sender, amount);
        }

        // ========================================================================
        // 2. Policy Management
        // ========================================================================

        /// <summary>
        /// Creates or updates a sponsorship policy for an account.
        /// Use accountId = UInt160.Zero for a global policy that sponsors any account.
        /// </summary>
        public static void SetPolicy(
            UInt160 accountId,
            UInt160 targetContract,
            string method,
            BigInteger maxPerOp,
            BigInteger dailyBudget,
            BigInteger totalBudget,
            BigInteger validUntil)
        {
            UInt160 sponsor = Runtime.Transaction.Sender;
            ExecutionEngine.Assert(Runtime.CheckWitness(sponsor), "Unauthorized");
            ExecutionEngine.Assert(maxPerOp > 0, "MaxPerOp must be positive");
            ExecutionEngine.Assert(dailyBudget >= 0, "DailyBudget must be non-negative");
            ExecutionEngine.Assert(totalBudget >= 0, "TotalBudget must be non-negative");
            ExecutionEngine.Assert(validUntil >= 0, "ValidUntil must be non-negative");

            if (accountId == null) accountId = UInt160.Zero;
            if (targetContract == null) targetContract = UInt160.Zero;

            // Audit fix MEDIUM-b: a global policy (accountId = Zero sponsors ANY account) must carry
            // explicit, finite aggregate spend caps. With 0 treated as "unlimited", such a wildcard
            // policy lets any relay drain the entire sponsor deposit at MaxPerOp per op with no daily
            // or lifetime bound. For the global scope both DailyBudget and TotalBudget are therefore
            // mandatory (0 is rejected here rather than meaning unlimited). Account-specific policies
            // are inherently bounded to a single account and may keep 0 = unlimited.
            if (accountId == UInt160.Zero)
            {
                ExecutionEngine.Assert(dailyBudget > 0, "DailyBudget required for global policy");
                ExecutionEngine.Assert(totalBudget > 0, "TotalBudget required for global policy");
            }

            SponsorshipPolicy policy = new SponsorshipPolicy
            {
                TargetContract = targetContract,
                Method = method ?? string.Empty,
                MaxPerOp = maxPerOp,
                DailyBudget = dailyBudget,
                TotalBudget = totalBudget,
                ValidUntil = validUntil
            };

            byte[] key = BuildPolicyKey(sponsor, accountId);
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(policy));

            OnPolicyCreated(sponsor, accountId);
        }

        /// <summary>
        /// Revokes a sponsorship policy and clears its spending counters.
        /// </summary>
        public static void RevokePolicy(UInt160 accountId)
        {
            UInt160 sponsor = Runtime.Transaction.Sender;
            ExecutionEngine.Assert(Runtime.CheckWitness(sponsor), "Unauthorized");

            if (accountId == null) accountId = UInt160.Zero;

            byte[] key = BuildPolicyKey(sponsor, accountId);
            Storage.Delete(Storage.CurrentContext, key);

            ClearSpendingCounters(sponsor, accountId);

            OnPolicyRevoked(sponsor, accountId);
        }

        // ========================================================================
        // 3. Validation (Read-Only — for relay preflight)
        // ========================================================================

        /// <summary>
        /// Read-only validation of whether a sponsored operation would be accepted.
        /// Relays call this via invokeScript before submitting a transaction.
        /// </summary>
        [Safe]
        public static bool ValidatePaymasterOp(
            UInt160 sponsor,
            UInt160 accountId,
            UInt160 targetContract,
            string method,
            BigInteger reimbursementAmount)
        {
            if (sponsor == null || sponsor == UInt160.Zero) return false;
            if (accountId == null) accountId = UInt160.Zero;
            if (reimbursementAmount <= 0) return false;

            SponsorshipPolicy? policy = ResolvePolicy(sponsor, accountId, out UInt160 spendingKey);
            if (policy == null) return false;

            if (policy.ValidUntil > 0 && Runtime.Time > policy.ValidUntil) return false;

            if (policy.TargetContract != UInt160.Zero && policy.TargetContract != targetContract) return false;

            if (policy.Method.Length > 0 && policy.Method != method) return false;

            if (reimbursementAmount > policy.MaxPerOp) return false;

            if (policy.DailyBudget > 0)
            {
                BigInteger spentToday = GetDailySpent(sponsor, spendingKey);
                if (spentToday + reimbursementAmount > policy.DailyBudget) return false;
            }

            if (policy.TotalBudget > 0)
            {
                BigInteger spentTotal = GetTotalSpent(sponsor, spendingKey);
                if (spentTotal + reimbursementAmount > policy.TotalBudget) return false;
            }

            BigInteger deposit = GetSponsorDeposit(sponsor);
            if (deposit < reimbursementAmount) return false;

            return true;
        }

        // ========================================================================
        // 4. Settlement (called by SA Core after successful execution)
        // ========================================================================

        /// <summary>
        /// Settles a sponsored operation by validating the policy, deducting from the sponsor's
        /// deposit, updating spending counters, and transferring GAS to the relay.
        /// Only callable by the authorized SA core contract.
        /// </summary>
        public static void SettleReimbursement(
            UInt160 sponsor,
            UInt160 accountId,
            UInt160 targetContract,
            string method,
            UInt160 relay,
            BigInteger amount)
        {
            PaymasterAuthority.ValidateCoreCaller();

            // Confused-deputy closure: one core backs every virtual account, so "the caller is
            // the SA core" is also true for any account owner's ordinary user operation whose
            // target is this settlement entry. Settlement is only valid after a sponsored
            // execution completed, which is exactly when the core reports no user operation in
            // flight; the check is account-independent, so it also rejects a settlement that
            // names another account while some operation executes. The core address is read
            // through the internal authority helper rather than this contract's own ABI
            // method so the settlement frame does not re-enter the "authorizedCore" entry.
            UInt160 core = PaymasterAuthority.AuthorizedCore();
            bool executionInFlight = (bool)Contract.Call(
                core, "isUserOpExecutionActive", CallFlags.ReadOnly, new object[] { });
            ExecutionEngine.Assert(!executionInFlight,
                "Settlement must follow a completed sponsored execution");

            ExecutionEngine.Assert(sponsor != null && sponsor != UInt160.Zero, "Invalid sponsor");
            ExecutionEngine.Assert(relay != null && relay != UInt160.Zero, "Invalid relay");
            ExecutionEngine.Assert(amount > 0, "Amount must be positive");

            // Resolve policy (account-specific, then global fallback)
            // spendingKey is UInt160.Zero when a global policy is matched, ensuring
            // all accounts share a single daily/total budget under the global policy.
            SponsorshipPolicy? policy = ResolvePolicy(sponsor!, accountId, out UInt160 spendingKey);
            ExecutionEngine.Assert(policy != null, "No sponsorship policy");

            // Validate policy constraints
            if (policy!.ValidUntil > 0)
            {
                ExecutionEngine.Assert(Runtime.Time <= policy.ValidUntil, "Policy expired");
            }
            if (policy.TargetContract != UInt160.Zero)
            {
                ExecutionEngine.Assert(policy.TargetContract == targetContract, "Target contract not allowed by policy");
            }
            if (policy.Method.Length > 0)
            {
                ExecutionEngine.Assert(policy.Method == method, "Method not allowed by policy");
            }
            ExecutionEngine.Assert(amount <= policy.MaxPerOp, "Exceeds per-operation limit");

            // Check daily budget (spending keyed by resolved policy scope)
            if (policy.DailyBudget > 0)
            {
                BigInteger spentToday = GetDailySpent(sponsor!, spendingKey);
                BigInteger newDaily = spentToday + amount;
                ExecutionEngine.Assert(newDaily >= spentToday, "Daily spend overflow");
                ExecutionEngine.Assert(newDaily <= policy.DailyBudget, "Daily budget exceeded");
            }

            // Check total budget
            if (policy.TotalBudget > 0)
            {
                BigInteger spentTotal = GetTotalSpent(sponsor!, spendingKey);
                BigInteger newTotal = spentTotal + amount;
                ExecutionEngine.Assert(newTotal >= spentTotal, "Total spend overflow");
                ExecutionEngine.Assert(newTotal <= policy.TotalBudget, "Total budget exceeded");
            }

            // Deduct from sponsor deposit (checks-effects-interactions)
            BigInteger deposit = GetSponsorDeposit(sponsor!);
            ExecutionEngine.Assert(deposit >= amount, "Insufficient sponsor deposit");
            SetSponsorDeposit(sponsor!, deposit - amount);

            // Update spending counters (keyed by resolved policy scope)
            UpdateDailySpent(sponsor!, spendingKey, amount);
            UpdateTotalSpent(sponsor!, spendingKey, amount);

            // Transfer GAS to relay
            bool transferred = (bool)Contract.Call(
                GAS.Hash, "transfer", CallFlags.All,
                new object[] { Runtime.ExecutingScriptHash, relay!, amount, null! });
            ExecutionEngine.Assert(transferred, "Relay reimbursement failed");

            OnReimbursed(sponsor!, accountId, relay!, amount);
        }

        // ========================================================================
        // 5. State Queries
        // ========================================================================

        [Safe]
        public static BigInteger GetSponsorDeposit(UInt160 sponsor)
        {
            byte[] key = Helper.Concat(Prefix_SponsorDeposit, (byte[])sponsor);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            return data == null ? 0 : (BigInteger)data;
        }

        [Safe]
        public static SponsorshipPolicy? GetPolicy(UInt160 sponsor, UInt160 accountId)
        {
            return ReadPolicy(sponsor, accountId);
        }

        [Safe]
        public static BigInteger GetDailySpent(UInt160 sponsor, UInt160 accountId)
        {
            byte[] resetKey = BuildDailyResetKey(sponsor, accountId);
            ByteString? lastResetData = Storage.Get(Storage.CurrentContext, resetKey);
            BigInteger lastReset = lastResetData == null ? 0 : (BigInteger)lastResetData;

            if (Runtime.Time >= lastReset + OneDayMs) return 0;

            byte[] spentKey = BuildDailySpentKey(sponsor, accountId);
            ByteString? spentData = Storage.Get(Storage.CurrentContext, spentKey);
            return spentData == null ? 0 : (BigInteger)spentData;
        }

        [Safe]
        public static BigInteger GetTotalSpent(UInt160 sponsor, UInt160 accountId)
        {
            byte[] key = BuildTotalSpentKey(sponsor, accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            return data == null ? 0 : (BigInteger)data;
        }

        // ========================================================================
        // Private Helpers
        // ========================================================================

        private static void SetSponsorDeposit(UInt160 sponsor, BigInteger amount)
        {
            ExecutionEngine.Assert(amount >= 0, "Negative deposit balance");
            byte[] key = Helper.Concat(Prefix_SponsorDeposit, (byte[])sponsor);
            if (amount == 0)
            {
                Storage.Delete(Storage.CurrentContext, key);
            }
            else
            {
                Storage.Put(Storage.CurrentContext, key, amount);
            }
        }

        /// <summary>
        /// Resolves the applicable policy and returns the effective accountId key for spending tracking.
        /// When a global policy is matched, spendingAccountId is UInt160.Zero so all accounts share
        /// a single daily/total budget under the global policy.
        /// </summary>
        private static SponsorshipPolicy? ResolvePolicy(UInt160 sponsor, UInt160 accountId, out UInt160 spendingAccountId)
        {
            spendingAccountId = accountId;

            // Try account-specific policy first
            SponsorshipPolicy? policy = ReadPolicy(sponsor, accountId);
            if (policy != null) return policy;

            // Fall back to global policy (accountId = Zero) — spending tracks under Zero
            if (accountId != UInt160.Zero)
            {
                policy = ReadPolicy(sponsor, UInt160.Zero);
                if (policy != null)
                {
                    spendingAccountId = UInt160.Zero;
                    return policy;
                }
            }
            return null;
        }

        private static SponsorshipPolicy? ReadPolicy(UInt160 sponsor, UInt160 accountId)
        {
            byte[] key = BuildPolicyKey(sponsor, accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return null;
            return (SponsorshipPolicy)StdLib.Deserialize(data!);
        }

        private static byte[] BuildPolicyKey(UInt160 sponsor, UInt160 accountId)
        {
            return Helper.Concat(Helper.Concat(Prefix_Policy, (byte[])sponsor), (byte[])accountId);
        }

        private static byte[] BuildDailySpentKey(UInt160 sponsor, UInt160 accountId)
        {
            return Helper.Concat(Helper.Concat(Prefix_DailySpent, (byte[])sponsor), (byte[])accountId);
        }

        private static byte[] BuildDailyResetKey(UInt160 sponsor, UInt160 accountId)
        {
            return Helper.Concat(Helper.Concat(Prefix_DailyReset, (byte[])sponsor), (byte[])accountId);
        }

        private static byte[] BuildTotalSpentKey(UInt160 sponsor, UInt160 accountId)
        {
            return Helper.Concat(Helper.Concat(Prefix_TotalSpent, (byte[])sponsor), (byte[])accountId);
        }

        private static void UpdateDailySpent(UInt160 sponsor, UInt160 accountId, BigInteger amount)
        {
            byte[] spentKey = BuildDailySpentKey(sponsor, accountId);
            byte[] resetKey = BuildDailyResetKey(sponsor, accountId);

            ByteString? lastResetData = Storage.Get(Storage.CurrentContext, resetKey);
            BigInteger lastReset = lastResetData == null ? 0 : (BigInteger)lastResetData;

            BigInteger currentSpent;
            if (Runtime.Time >= lastReset + OneDayMs)
            {
                // New day — reset
                currentSpent = 0;
                Storage.Put(Storage.CurrentContext, resetKey, Runtime.Time);
            }
            else
            {
                ByteString? spentData = Storage.Get(Storage.CurrentContext, spentKey);
                currentSpent = spentData == null ? 0 : (BigInteger)spentData;
            }

            Storage.Put(Storage.CurrentContext, spentKey, currentSpent + amount);
        }

        private static void UpdateTotalSpent(UInt160 sponsor, UInt160 accountId, BigInteger amount)
        {
            byte[] key = BuildTotalSpentKey(sponsor, accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            BigInteger current = data == null ? 0 : (BigInteger)data;
            Storage.Put(Storage.CurrentContext, key, current + amount);
        }

        private static void ClearSpendingCounters(UInt160 sponsor, UInt160 accountId)
        {
            Storage.Delete(Storage.CurrentContext, BuildDailySpentKey(sponsor, accountId));
            Storage.Delete(Storage.CurrentContext, BuildDailyResetKey(sponsor, accountId));
            Storage.Delete(Storage.CurrentContext, BuildTotalSpentKey(sponsor, accountId));
        }
    }
}
