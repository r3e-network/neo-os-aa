using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    /// <summary>
    /// Market escrow under the minimal-lock model (protocol v4, spec §7.5 /
    /// design report §4.4).
    ///
    /// Physical markers 0x06 (market contract), 0x07 (listing id) and 0x1D
    /// (legacy cancel-initiated latch) remain Market-only writes: they are
    /// allocated as globally unique bytes in the STORAGE PREFIX MAP and are
    /// written at Market entrances (EnterMarketEscrow, driven by the market
    /// contract itself) and deleted only by Market-driven unwind paths
    /// (CancelMarketEscrow / SettleMarketEscrow). No owner-side path writes
    /// or deletes them — the retired owner-side 0x1D write and the
    /// ForceCancel/FinalizeEscapeToOwner marker deletions were kernel-batch
    /// bugs and are gone.
    ///
    /// The 0x5D MarketControlBinding pins, per account, the escrow lock, the
    /// account's control revision at entry and the listing id. The owner's
    /// escape from a stuck or hostile escrow is the core callback-free
    /// recovery flow (beginRecovery/executeRecovery in SmartAccount.Escape.cs):
    /// it writes only 0x59 records, never a legacy Market prefix, never calls
    /// the Market, and its control-epoch advance invalidates the old-epoch
    /// lock — an escaped account can no longer be settled under its old
    /// binding (SA_MARKET_LOCKED). Later Market claims (cancel) clean the
    /// physical markers.
    /// </summary>
    public partial class SmartAccount
    {
        // Market-only physical marker: timelocked escrow cancellation latch.
        // Written and deleted exclusively by Market-driven paths in this
        // partial; no owner-side path may touch it (spec §7.5).
        private static readonly byte[] Prefix_MarketEscrowCancelInitiated = new byte[] { 0x1D };

        // Registered market-service allowlist. EnterMarketEscrow requires BOTH
        // the caller to be the named market contract AND that market to be
        // admin-registered here: caller identity alone cannot stop an arbitrary
        // deployed contract from arming a fake escrow and settling the account
        // to an attacker-chosen owner without payment.
        private static readonly byte[] Prefix_MarketServiceRegistration = new byte[] { 0x29 };

        public delegate void MarketServiceChangedDelegate(UInt160 marketContract, bool allowed);

        [DisplayName("MarketServiceChanged")]
        public static event MarketServiceChangedDelegate OnMarketServiceChanged = null!;

        // ========================================================================
        // 0x5D control-epoch binding (spec §7.5)
        // ========================================================================

        private static MarketControlBinding? GetMarketControlBinding(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, MarketControlEpochKey(accountId));
            return data == null ? null : (MarketControlBinding)StdLib.Deserialize(data!);
        }

        private static void PutMarketControlBinding(UInt160 accountId, MarketControlBinding binding)
        {
            Storage.Put(Storage.CurrentContext, MarketControlEpochKey(accountId), StdLib.Serialize(binding));
        }

        private static void DeleteMarketControlBinding(UInt160 accountId)
        {
            Storage.Delete(Storage.CurrentContext, MarketControlEpochKey(accountId));
        }

        // ========================================================================
        // Market entrances
        // ========================================================================

        /// <summary>
        /// Locks an account into a market-controlled escrow state so it can be
        /// sold atomically. Called by the registered market contract itself
        /// (the listing's binding must be established by the market — see the
        /// caller-identity assert) with the custody witness of the account
        /// being sold. Writes the physical 0x06/0x07 markers and the 0x5D
        /// binding that pins the account's control revision at entry.
        /// </summary>
        public static void EnterMarketEscrow(UInt160 accountId, UInt160 marketContract, BigInteger listingId)
        {
            ValidateAccountId(accountId);
            AccountControl control = MaterializeAccountControl(accountId);
            RequireCustodyWitness(control);
            ExecutionEngine.Assert(control.Status == AccountStatusActive, ErrorAccountStatus);
            AssertAccountConfigurationIdle(accountId);
            AssertNoMarketEscrow(accountId);
            ExecutionEngine.Assert(GetMarketControlBinding(accountId) == null, ErrorMarketLocked);
            ExecutionEngine.Assert(marketContract != null && marketContract != UInt160.Zero, "Market contract required");
            ExecutionEngine.Assert(listingId > 0, "Listing id required");

            // The (marketContract, listingId) binding must be established by the market
            // itself: allowing any custody to record an arbitrary (market, listingId)
            // here would let an attacker point their own account's escrow at a
            // victim's listing and then drive that victim's listing through the
            // unwind paths.
            ExecutionEngine.Assert(Runtime.CallingScriptHash == marketContract!, "Caller is not the market");

            // Registration gate: the market driving this escrow must be one the
            // core admin registered. Listing on an unregistered market would
            // hand that contract unconditional settle authority over the
            // account without any payment guarantee.
            ExecutionEngine.Assert(IsRegisteredMarketService(marketContract!), "Market service not registered");

            byte[] marketKey = Helper.Concat(Prefix_MarketEscrowContract, (byte[])accountId);
            byte[] listingKey = Helper.Concat(Prefix_MarketEscrowListing, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, marketKey, (byte[])marketContract!);
            Storage.Put(Storage.CurrentContext, listingKey, listingId);

            // Entering an escrow is a control-epoch-relevant change: bump the
            // revision and pin it in the 0x5D binding. A later recovery bumps
            // the revision again, so this lock dies on the epoch check.
            control.ControlRevision += BigInteger.One;
            PutAccountControl(accountId, control);
            MarketControlBinding binding = new MarketControlBinding();
            binding.Market = marketContract!;
            binding.ListingId = listingId;
            binding.ControlEpoch = control.ControlRevision;
            PutMarketControlBinding(accountId, binding);

            OnMarketControlEpochBound(accountId, listingId, binding.ControlEpoch);
            OnMarketEscrowEntered(accountId, marketContract!, listingId);
        }

        // ========================================================================
        // Market-driven unwind
        // ========================================================================

        /// <summary>
        /// Clears an active market escrow without changing control (listing
        /// cancellation, driven by the market contract). If the 0x5D binding's
        /// control epoch no longer matches — the owner escaped through
        /// callback-free recovery — this is a cleanup claim: the invalidated
        /// lock is dropped, the physical markers are cleaned and
        /// <c>MarketLockInvalidated</c> is emitted; no state transfer happens.
        /// </summary>
        public static void CancelMarketEscrow(UInt160 accountId, BigInteger listingId)
        {
            ValidateAccountId(accountId);
            AccountControl control = MaterializeAccountControl(accountId);
            ExecutionEngine.Assert(control.Status == AccountStatusActive, ErrorAccountStatus);
            AssertAccountConfigurationIdle(accountId);
            AssertEscrowMarket(accountId, listingId);

            MarketControlBinding? binding = GetMarketControlBinding(accountId);
            if (binding != null && binding!.ControlEpoch != control.ControlRevision)
            {
                // Old-epoch lock: the owner already recovered. Cleanup only.
                DeleteMarketControlBinding(accountId);
                ClearMarketEscrow(accountId);
                OnMarketLockInvalidated(accountId, binding.ControlEpoch);
                OnMarketEscrowCancelled(accountId);
                return;
            }

            DeleteMarketControlBinding(accountId);
            ClearMarketEscrow(accountId);
            OnMarketEscrowCancelled(accountId);
        }

        /// <summary>
        /// Completes a market escrow sale by transferring only the SA shell:
        /// the buyer becomes the new custody and receives a clean account —
        /// every module instance, threshold policy, hook order, message
        /// subject set, pending intent, nonce channel and pending migration
        /// state is swept callback-free (no module cleanup callback
        /// can block or corrupt the settlement), and built-in authorization is
        /// enabled so the buyer can operate immediately. The 0x5D binding must
        /// still match the account's control revision: an account whose owner
        /// escaped through recovery can never be sold under its old binding.
        /// A pre-upgrade escrow (no binding) may settle only while the account
        /// was never recovered (authorityEpoch still at its materialization
        /// value).
        /// </summary>
        public static void SettleMarketEscrow(UInt160 accountId, BigInteger listingId, UInt160 newBackupOwner)
        {
            ValidateAccountId(accountId);
            AccountControl control = MaterializeAccountControl(accountId);
            ExecutionEngine.Assert(control.Status == AccountStatusActive, ErrorAccountStatus);
            AssertAccountConfigurationIdle(accountId);
            AssertEscrowMarket(accountId, listingId);
            ExecutionEngine.Assert(newBackupOwner != null && newBackupOwner != UInt160.Zero, "New backup owner required");

            MarketControlBinding? binding = GetMarketControlBinding(accountId);
            if (binding != null)
            {
                ExecutionEngine.Assert(binding!.ControlEpoch == control.ControlRevision, ErrorMarketLocked);
            }
            else
            {
                // Pre-upgrade escrow without a 0x5D binding: still sellable,
                // but only if the account was never frozen/recovered after
                // materialization (both advance the authority epoch).
                ExecutionEngine.Assert(control.AuthorityEpoch == BigInteger.One, ErrorMarketLocked);
            }

            // Callback-free clean sweep: no old plugin, market or oracle call.
            SweepAccountModulesAndPolicies(accountId);

            control.Custody = newBackupOwner!;
            control.RecoveryAuthority = UInt160.Zero;
            control.Status = AccountStatusActive;
            control.AuthorityEpoch += BigInteger.One;
            control.ConfigurationNonce += BigInteger.One;
            control.ControlRevision += BigInteger.One;
            control.DefaultOperationAuthorization = true;
            control.DefaultMessageAuthorization = true;
            PutAccountControl(accountId, control);
            // Spec §8: settlement replaces the custody, so the swept 0x57 set is
            // rebuilt against the BUYER rather than left empty.
            InitializeDefaultMessageSubjects(accountId, control);
            // Keep the legacy five-field row truthful as migration input: the
            // buyer is the new backup owner and no legacy pointer survives.
            byte[] stateKey = Helper.Concat(Prefix_AccountState, (byte[])accountId);
            ByteString? legacyRow = Storage.Get(Storage.CurrentContext, stateKey);
            if (legacyRow != null)
            {
                AccountState state = (AccountState)StdLib.Deserialize(legacyRow!);
                state.BackupOwner = newBackupOwner!;
                state.Verifier = UInt160.Zero;
                state.HookId = UInt160.Zero;
                state.EscapeTriggeredAt = BigInteger.Zero;
                Storage.Put(Storage.CurrentContext, stateKey, StdLib.Serialize(state));
            }

            // Drop the seller's stale legacy pending/cancel markers (core-owned
            // prefixes; the physical Market markers are cleared below).
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingVerifierUpdate, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingHookUpdate, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingVerifierCall, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingHookCall, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_EscapeLastInitiated, (byte[])accountId));

            DeleteMarketControlBinding(accountId);
            ClearMarketEscrow(accountId);
            OnMarketEscrowSettled(accountId, newBackupOwner!);
        }

        // ========================================================================
        // Market service registration (admin-gated allowlist)
        // ========================================================================

        /// <summary>
        /// Registers or unregisters a market service contract that may drive
        /// escrow locks. Admin-gated: only the core admin vets which deployed
        /// markets are trustworthy enough to hold settle authority over
        /// escrowed accounts.
        /// </summary>
        public static void SetMarketService(UInt160 marketContract, bool allowed)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(marketContract != null && marketContract != UInt160.Zero, "Market contract required");
            byte[] key = Helper.Concat(Prefix_MarketServiceRegistration, (byte[])marketContract!);
            if (allowed)
            {
                ExecutionEngine.Assert(ContractManagement.GetContract(marketContract!) != null,
                    "Market service not deployed");
                Storage.Put(Storage.CurrentContext, key, new byte[] { 1 });
            }
            else
            {
                Storage.Delete(Storage.CurrentContext, key);
            }
            OnMarketServiceChanged(marketContract!, allowed);
        }

        /// <summary>Returns whether <paramref name="marketContract"/> is a registered market service.</summary>
        [Safe]
        public static bool IsMarketService(UInt160 marketContract)
        {
            if (marketContract == null || marketContract == UInt160.Zero) return false;
            return IsRegisteredMarketService(marketContract);
        }

        private static bool IsRegisteredMarketService(UInt160 marketContract)
        {
            return Storage.Get(
                Storage.CurrentContext,
                Helper.Concat(Prefix_MarketServiceRegistration, (byte[])marketContract)) != null;
        }

        // ========================================================================
        // Internal gates
        // ========================================================================

        private static void AssertNoMarketEscrow(UInt160 accountId)
        {
            ExecutionEngine.Assert(!IsMarketEscrowActive(accountId), "Account locked in market escrow");
        }

        /// <summary>
        /// The caller must be the market contract the escrow points at, and
        /// the listing id must match the recorded one. The 0x5D epoch check
        /// lives in the individual unwind paths (cancel tolerates a stale
        /// epoch as a cleanup claim; settle never does).
        /// </summary>
        private static void AssertEscrowMarket(UInt160 accountId, BigInteger listingId)
        {
            UInt160 market = GetMarketEscrowContract(accountId);
            BigInteger currentListingId = GetMarketEscrowListingId(accountId);
            ExecutionEngine.Assert(market != UInt160.Zero, "Market escrow not active");
            ExecutionEngine.Assert(Runtime.CallingScriptHash == market, "Only escrow market");
            ExecutionEngine.Assert(currentListingId == listingId, "Listing mismatch");
        }

        private static void ClearMarketEscrow(UInt160 accountId)
        {
            byte[] marketKey = Helper.Concat(Prefix_MarketEscrowContract, (byte[])accountId);
            byte[] listingKey = Helper.Concat(Prefix_MarketEscrowListing, (byte[])accountId);
            byte[] ownerCancelKey = Helper.Concat(Prefix_MarketEscrowCancelInitiated, (byte[])accountId);
            Storage.Delete(Storage.CurrentContext, marketKey);
            Storage.Delete(Storage.CurrentContext, listingKey);
            Storage.Delete(Storage.CurrentContext, ownerCancelKey);
        }
    }
}
