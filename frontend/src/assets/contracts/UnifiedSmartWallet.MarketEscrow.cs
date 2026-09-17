using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount
{
    public partial class UnifiedSmartWallet
    {
        // ========================================================================
        // 7. Market Escrow (address transfer)
        // ========================================================================

        // Storage prefix for the owner-driven, timelocked escrow cancellation marker.
        // The active layout is globally unique; reads and deletes also cover the legacy 0x13 key.
        private static readonly byte[] Prefix_MarketEscrowCancelInitiated = new byte[] { 0x1D };

        // Delay the backup owner must wait between requesting and forcing an escrow
        // cancellation. Gives an honest market its full opportunity to settle while still
        // guaranteeing the owner can always reclaim a stuck/abandoned escrow.
        private static readonly BigInteger MarketEscrowOwnerCancelTimelockMs = 7L * 24 * 60 * 60 * 1000;

        public delegate void MarketEscrowOwnerCancelInitiatedDelegate(UInt160 accountId, UInt160 backupOwner, BigInteger availableAt);

        [DisplayName("MarketEscrowOwnerCancelInitiated")]
        public static event MarketEscrowOwnerCancelInitiatedDelegate OnMarketEscrowOwnerCancelInitiated = null!;

        [DisplayName("MarketEscrowOwnerCancelled")]
        public static event AccountOnlyDelegate OnMarketEscrowOwnerCancelled = null!;

        /// <summary>
        /// Locks an account into a market-controlled escrow state so it can be sold atomically.
        /// While escrow is active, normal execution and configuration flows are blocked.
        /// </summary>
        public static void EnterMarketEscrow(UInt160 accountId, UInt160 marketContract, BigInteger listingId)
        {
            AssertBackupOwner(accountId);
            AssertNoMarketEscrow(accountId);
            ExecutionEngine.Assert(marketContract != null && marketContract != UInt160.Zero, "Market contract required");
            ExecutionEngine.Assert(listingId > 0, "Listing id required");

            // The (marketContract, listingId) binding must be established by the market itself.
            // A listing's later abandon/settle/cancel calls are authorised purely by
            // CallingScriptHash == the recorded marketContract, so allowing any backup owner to
            // record an arbitrary (market, listingId) here would let an attacker point their own
            // account's escrow at a victim's listing and then drive that victim's listing through
            // the abandon path. Requiring the real market to be the caller that arms the escrow
            // keeps the binding honest: the only on-chain path is the market's own CreateListing,
            // which calls in passing itself (Runtime.ExecutingScriptHash) as marketContract.
            ExecutionEngine.Assert(Runtime.CallingScriptHash == marketContract!, "Caller is not the market");

            byte[] marketKey = Helper.Concat(Prefix_MarketEscrowContract, (byte[])accountId);
            byte[] listingKey = Helper.Concat(Prefix_MarketEscrowListing, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, marketKey, (byte[])marketContract!);
            Storage.Put(Storage.CurrentContext, listingKey, listingId);
            OnMarketEscrowEntered(accountId, marketContract!, listingId);
        }

        /// <summary>
        /// Clears an active market escrow without changing control. Intended for listing cancellation.
        /// </summary>
        public static void CancelMarketEscrow(UInt160 accountId, BigInteger listingId)
        {
            AssertEscrowMarket(accountId, listingId);
            UInt160 market = GetMarketEscrowContract(accountId);
            ClearMarketEscrow(accountId);
            NotifyMarketListingAbandoned(market, accountId, listingId);
            OnMarketEscrowCancelled(accountId);
        }

        /// <summary>
        /// Completes a market escrow sale by transferring only the AA shell and wiping prior plugin state.
        /// The buyer receives a clean account with a new backup owner and no inherited verifier/hook bindings.
        /// </summary>
        public static void SettleMarketEscrow(UInt160 accountId, BigInteger listingId, UInt160 newBackupOwner)
        {
            AssertEscrowMarket(accountId, listingId);
            ExecutionEngine.Assert(newBackupOwner != null && newBackupOwner != UInt160.Zero, "New backup owner required");

            AccountState state = GetAccountState(accountId);
            UInt160 previousVerifier = state.Verifier;
            UInt160 previousHook = state.HookId;

            // Clear old plugin state before wiping pointers
            // Must set config context so the plugin's ValidateConfigCaller succeeds
            if (previousVerifier != UInt160.Zero)
            {
                SetVerifierConfigContext(accountId, previousVerifier);
                try { Contract.Call(previousVerifier, "clearAccount", CallFlags.All, new object[] { accountId }); }
                catch { } // Plugin may not implement clearAccount
                finally { ClearVerifierConfigContext(accountId); }
            }
            if (previousHook != UInt160.Zero)
            {
                SetHookConfigContext(accountId, previousHook);
                try { Contract.Call(previousHook, "clearAccount", CallFlags.All, new object[] { accountId }); }
                catch { } // Plugin may not implement clearAccount
                finally { ClearHookConfigContext(accountId); }
            }

            state.BackupOwner = newBackupOwner!;
            state.Verifier = UInt160.Zero;
            state.HookId = UInt160.Zero;
            state.EscapeTriggeredAt = 0;

            byte[] key = Helper.Concat(Prefix_AccountState, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(state));

            // Hand the buyer a genuinely clean shell: wipe every per-account marker the previous
            // owner could have left behind. Beyond the pending plugin *updates*, this also clears
            // any pending timelocked plugin *calls*, a stale escape-cooldown stamp (so the buyer is
            // not locked out of InitiateEscape), and the seller's off-chain metadata URI.
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingVerifierUpdate, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingHookUpdate, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingVerifierCall, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingHookCall, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_EscapeLastInitiated, (byte[])accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_MetadataUri, (byte[])accountId));

            if (previousVerifier != UInt160.Zero)
            {
                OnModuleRemoved(accountId, ModuleTypeVerifier, previousVerifier);
            }
            if (previousHook != UInt160.Zero)
            {
                OnModuleRemoved(accountId, ModuleTypeHook, previousHook);
            }

            ClearMarketEscrow(accountId);
            OnMarketEscrowSettled(accountId, newBackupOwner!);
        }

        /// <summary>
        /// Begins the backup-owner escape from a market escrow. This is the owner-side counterpart
        /// to the market-driven <see cref="CancelMarketEscrow"/>: it lets the account's backup owner
        /// unwind a stuck or abandoned escrow (e.g. a market contract that was destroyed, upgraded
        /// away, or never settles) instead of leaving the account permanently bricked.
        ///
        /// The actual cancellation is timelocked via <see cref="ForceCancelMarketEscrow"/> so an
        /// honest market still has its full window to settle the sale before the owner can reclaim
        /// control. Re-invoking restarts the timer.
        /// </summary>
        public static void InitiateMarketEscrowCancel(UInt160 accountId)
        {
            AssertBackupOwner(accountId);
            ExecutionEngine.Assert(IsMarketEscrowActive(accountId), "Market escrow not active");

            byte[] key = Helper.Concat(Prefix_MarketEscrowCancelInitiated, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, Runtime.Time);
            Storage.Delete(Storage.CurrentContext, Helper.Concat(LegacyStoragePrefix13, (byte[])accountId));

            AccountState state = GetAccountState(accountId);
            OnMarketEscrowOwnerCancelInitiated(accountId, state.BackupOwner!, Runtime.Time + MarketEscrowOwnerCancelTimelockMs);
        }

        /// <summary>
        /// Completes the backup-owner escape after the timelock elapses, clearing the escrow and
        /// returning full control to the existing backup owner without changing ownership. Preserves
        /// the normal market settle/cancel paths; this only guarantees the owner is never permanently
        /// locked out by an unresponsive market.
        /// </summary>
        public static void ForceCancelMarketEscrow(UInt160 accountId)
        {
            AssertBackupOwner(accountId);
            ExecutionEngine.Assert(IsMarketEscrowActive(accountId), "Market escrow not active");

            ByteString? initiated = GetMarketEscrowOwnerCancelInitiated(accountId);
            ExecutionEngine.Assert(initiated != null, "Owner cancel not initiated");
            BigInteger initiatedAt = (BigInteger)initiated!;
            ExecutionEngine.Assert(Runtime.Time >= initiatedAt + MarketEscrowOwnerCancelTimelockMs, "Owner cancel timelock active");

            // Capture the listing the escrow points at before wiping the local markers so the
            // market can be told to retire the listing too — otherwise the owner reclaims the
            // account but the market keeps an Active listing that can never settle (a zombie).
            UInt160 market = GetMarketEscrowContract(accountId);
            BigInteger listingId = GetMarketEscrowListingId(accountId);
            ClearMarketEscrow(accountId);
            NotifyMarketListingAbandoned(market, accountId, listingId);
            OnMarketEscrowOwnerCancelled(accountId);
        }

        /// <summary>
        /// Returns whether the backup owner has an in-flight timelocked escrow cancellation.
        /// </summary>
        [Safe]
        public static bool HasMarketEscrowOwnerCancel(UInt160 accountId)
        {
            return GetMarketEscrowOwnerCancelInitiated(accountId) != null;
        }

        /// <summary>
        /// Returns the timestamp (ms) at which the backup owner may force-cancel the escrow, or 0
        /// if no owner cancellation is in flight.
        /// </summary>
        [Safe]
        public static BigInteger GetMarketEscrowOwnerCancelTime(UInt160 accountId)
        {
            ByteString? initiated = GetMarketEscrowOwnerCancelInitiated(accountId);
            return initiated == null ? 0 : (BigInteger)initiated! + MarketEscrowOwnerCancelTimelockMs;
        }

        private static ByteString? GetMarketEscrowOwnerCancelInitiated(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_MarketEscrowCancelInitiated, (byte[])accountId);
            ByteString? value = Storage.Get(Storage.CurrentContext, key);
            if (value != null) return value;
            return Storage.Get(Storage.CurrentContext, Helper.Concat(LegacyStoragePrefix13, (byte[])accountId));
        }

        private static void AssertNoMarketEscrow(UInt160 accountId)
        {
            ExecutionEngine.Assert(!IsMarketEscrowActive(accountId), "Account locked in market escrow");
        }

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
            byte[] legacyOwnerCancelKey = Helper.Concat(LegacyStoragePrefix13, (byte[])accountId);
            Storage.Delete(Storage.CurrentContext, marketKey);
            Storage.Delete(Storage.CurrentContext, listingKey);
            Storage.Delete(Storage.CurrentContext, ownerCancelKey);
            Storage.Delete(Storage.CurrentContext, legacyOwnerCancelKey);
        }

        /// <summary>
        /// Asks the market contract to retire the listing this escrow was bound to so a wallet-side
        /// escrow clear (owner force-cancel or market-driven cancel) never leaves an Active listing
        /// the market can no longer settle. The call is best-effort: a market that was destroyed or
        /// upgraded away (the very situation the owner escape exists for) must not be able to block
        /// the owner from reclaiming the account, and the AbandonListing transition is idempotent
        /// so overlapping with the market's own cancel path is harmless.
        /// </summary>
        private static void NotifyMarketListingAbandoned(UInt160 market, UInt160 accountId, BigInteger listingId)
        {
            if (market == UInt160.Zero || listingId <= 0) return;
            try
            {
                Contract.Call(market, "abandonListing", CallFlags.All, new object[] { accountId, listingId });
            }
            catch
            {
                // Market unreachable/incompatible: the local escrow is already cleared, so the
                // owner keeps control regardless. A still-Active listing on an unresponsive market
                // cannot settle anyway because the wallet no longer recognises it as the escrow holder.
            }
        }
    }
}
