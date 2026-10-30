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
    /// Trustless GAS escrow market for deterministic Neo Abstract Account addresses.
    /// The seller lists an account and atomically locks it in the AA core's market escrow.
    /// The buyer atomically pays GAS and settles the transfer in one transaction.
    /// </summary>
    [DisplayName("AAAddressMarket")]
    [ManifestExtra("Description", "Trustless escrow market for Neo Abstract Account addresses")]
    [ContractPermission("*", "getBackupOwner")]
    [ContractPermission("*", "enterMarketEscrow")]
    [ContractPermission("*", "cancelMarketEscrow")]
    [ContractPermission("*", "settleMarketEscrow")]
    [ContractPermission("*", "transfer")]
    public class AAAddressMarket : SmartContract
    {
        private static readonly byte[] Prefix_NextListingId = new byte[] { 0x01 };
        private static readonly byte[] Prefix_Listing = new byte[] { 0x02 };
        private static readonly byte[] Prefix_PendingPayment = new byte[] { 0x03 };
        // Per-listing count of in-flight escrowed payments. While > 0 the listing has buyer
        // capital locked, so the seller must not be able to invalidate it (cancel/reprice).
        private static readonly byte[] Prefix_PendingCount = new byte[] { 0x04 };
        // Admin-managed allowlist of canonical AA core hashes a listing may be backed by. A
        // listing trusts its AA contract for getBackupOwner/escrow calls, so only audited cores
        // may be referenced — otherwise a seller could back a listing with a malicious contract.
        private static readonly byte[] Prefix_AllowedAA = new byte[] { 0x05 };
        private static readonly byte[] Prefix_Admin = new byte[] { 0xF0 };
        // AA-D-01 (audit fix H6): timelocked contract upgrade. The admin first proposes the
        // sha256 of the new NEF and manifest, then can only apply that exact artifact pair
        // after the 7-day window. AA-D-02 (audit fix H6): admin rotation is timelocked the
        // same way. New prefixes — never written by previous deployments.
        private static readonly byte[] Prefix_PendingUpdateNefHash = new byte[] { 0xF1 };
        private static readonly byte[] Prefix_PendingUpdateManifestHash = new byte[] { 0xF2 };
        private static readonly byte[] Prefix_UpdateTimelock = new byte[] { 0xF3 };
        private static readonly byte[] Prefix_PendingAdmin = new byte[] { 0xF4 };
        private static readonly byte[] Prefix_AdminRotationTimelock = new byte[] { 0xF5 };

        private const byte StatusActive = 1;
        private const byte StatusSold = 2;
        private const byte StatusCancelled = 3;
        private const int MaxTitleLength = 80;
        private const int MaxMetadataUriLength = 240;

        // Price bounds (GAS has 8 decimals, so 1000 GAS = 100_000_000_000)
        private static readonly BigInteger MinListingPrice = 1_000_000;  // Minimum 0.01 GAS
        private static readonly BigInteger MaxListingPrice = 100_000_000_000;  // Maximum 1000 GAS

        // 7-day window shared by the timelocked upgrade and admin rotation (H6), matching
        // the VerifierAuthority window used across the rest of the repo.
        private static readonly BigInteger AdminRotationTimelockMs = 7L * 24 * 60 * 60 * 1000;

        public class Listing
        {
            public BigInteger Id;
            public UInt160 AAContract = UInt160.Zero;
            public UInt160 AccountId = UInt160.Zero;
            public UInt160 Seller = UInt160.Zero;
            public BigInteger Price;
            public string Title = string.Empty;
            public string MetadataUri = string.Empty;
            public byte Status;
            public UInt160 Buyer = UInt160.Zero;
            public BigInteger CreatedAt;
            public BigInteger UpdatedAt;
        }

        public static void _deploy(object data, bool update)
        {
            if (update) return;
            Storage.Put(Storage.CurrentContext, Prefix_Admin, Runtime.Transaction.Sender);
        }

        [Safe]
        public static UInt160 Admin()
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Prefix_Admin);
            return data == null ? UInt160.Zero : (UInt160)data;
        }

        // AA-D-01 (audit fix H6): contract upgrade is timelocked. This contract holds
        // in-flight buyer escrow (pending GAS payments), so a single admin key must not be
        // able to instantly replace the contract logic. ProposeUpdate pins the sha256 of the
        // new NEF and manifest; Update/ConfirmUpdate applies exactly that artifact pair only
        // after the 7-day window. One-way: once deployed, every future upgrade waits 7 days.
        // Mirrors VerifierAuthority.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(nefHash != UInt256.Zero && nefHash.IsValid, "Invalid NEF hash");
            ExecutionEngine.Assert(manifestHash != UInt256.Zero && manifestHash.IsValid, "Invalid manifest hash");
            Storage.Put(Storage.CurrentContext, Prefix_PendingUpdateNefHash, (byte[])nefHash);
            Storage.Put(Storage.CurrentContext, Prefix_PendingUpdateManifestHash, (byte[])manifestHash);
            Storage.Put(Storage.CurrentContext, Prefix_UpdateTimelock, Runtime.Time);
        }

        public static void CancelUpdate()
        {
            ValidateAdmin();
            Storage.Delete(Storage.CurrentContext, Prefix_PendingUpdateNefHash);
            Storage.Delete(Storage.CurrentContext, Prefix_PendingUpdateManifestHash);
            Storage.Delete(Storage.CurrentContext, Prefix_UpdateTimelock);
        }

        public static void Update(ByteString nef, string manifest)
        {
            ValidateAdmin();
            ByteString? pendingNef = Storage.Get(Storage.CurrentContext, Prefix_PendingUpdateNefHash);
            ExecutionEngine.Assert(pendingNef != null, "No pending update");
            ByteString? pendingManifest = Storage.Get(Storage.CurrentContext, Prefix_PendingUpdateManifestHash);
            ExecutionEngine.Assert(pendingManifest != null, "No pending update");
            ByteString? timelockData = Storage.Get(Storage.CurrentContext, Prefix_UpdateTimelock);
            ExecutionEngine.Assert(timelockData != null, "No timelock set");
            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)timelockData + AdminRotationTimelockMs, "Update timelock not expired");
            ExecutionEngine.Assert((UInt256)CryptoLib.Sha256(nef) == (UInt256)pendingNef!, "NEF hash mismatch");
            ExecutionEngine.Assert((UInt256)CryptoLib.Sha256(manifest) == (UInt256)pendingManifest!, "Manifest hash mismatch");
            Storage.Delete(Storage.CurrentContext, Prefix_PendingUpdateNefHash);
            Storage.Delete(Storage.CurrentContext, Prefix_PendingUpdateManifestHash);
            Storage.Delete(Storage.CurrentContext, Prefix_UpdateTimelock);
            ContractManagement.Update(nef, manifest);
        }

        /// <summary>Alias for <see cref="Update"/>, mirroring the verifier/paymaster upgrade naming.</summary>
        public static void ConfirmUpdate(ByteString nef, string manifest) => Update(nef, manifest);

        // AA-D-02 (audit fix H6): rotating the contract admin is itself timelocked. The old
        // SetAdmin did an instant Storage.Put with only the current-admin witness — a single
        // leaked admin key could silently and instantly burn the role to an address nobody
        // controls. The hardened flow mirrors VerifierAuthority.RotateAdmin/
        // ConfirmAdminRotation: propose (current-admin gated) -> 7-day window -> confirm gated
        // on CheckWitness(newAdmin), proving the new admin key is live before the role moves.
        public static void RotateAdmin(UInt160 newAdmin)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(newAdmin != null && newAdmin != UInt160.Zero && newAdmin.IsValid, "Invalid admin");
            ExecutionEngine.Assert(newAdmin != Admin(), "New admin must differ from current");
            Storage.Put(Storage.CurrentContext, Prefix_PendingAdmin, (byte[])newAdmin!);
            Storage.Put(Storage.CurrentContext, Prefix_AdminRotationTimelock, Runtime.Time);
        }

        public static void ConfirmAdminRotation(UInt160 newAdmin)
        {
            ByteString? pending = Storage.Get(Storage.CurrentContext, Prefix_PendingAdmin);
            ExecutionEngine.Assert(pending != null, "No pending admin rotation");
            ByteString? timelockData = Storage.Get(Storage.CurrentContext, Prefix_AdminRotationTimelock);
            ExecutionEngine.Assert(timelockData != null, "No timelock set");
            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)timelockData + AdminRotationTimelockMs, "Admin rotation timelock not expired");
            ExecutionEngine.Assert((UInt160)pending! == newAdmin, "Pending admin mismatch");
            ExecutionEngine.Assert(Runtime.CheckWitness(newAdmin), "New admin must confirm rotation");
            Storage.Put(Storage.CurrentContext, Prefix_Admin, (byte[])newAdmin);
            Storage.Delete(Storage.CurrentContext, Prefix_PendingAdmin);
            Storage.Delete(Storage.CurrentContext, Prefix_AdminRotationTimelock);
        }

        public static void CancelAdminRotation()
        {
            ValidateAdmin();
            Storage.Delete(Storage.CurrentContext, Prefix_PendingAdmin);
            Storage.Delete(Storage.CurrentContext, Prefix_AdminRotationTimelock);
        }

        public static void SetAllowedAA(UInt160 core, bool allowed)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(core != null && core != UInt160.Zero && core.IsValid, "Invalid AA core");
            if (allowed)
            {
                Storage.Put(Storage.CurrentContext, AllowedAAKey(core!), 1);
            }
            else
            {
                Storage.Delete(Storage.CurrentContext, AllowedAAKey(core!));
            }
        }

        [Safe]
        public static bool IsAllowedAA(UInt160 core)
        {
            if (core == null || core == UInt160.Zero) return false;
            return Storage.Get(Storage.CurrentContext, AllowedAAKey(core)) != null;
        }

        public static void CreateListing(UInt160 aaContract, UInt160 accountId, BigInteger price, string title, string metadataUri)
        {
            ExecutionEngine.Assert(aaContract != null && aaContract != UInt160.Zero, "AA contract required");
            ExecutionEngine.Assert(IsAllowedAA(aaContract!), "AA core not allowlisted");
            ExecutionEngine.Assert(accountId != null && accountId != UInt160.Zero, "Account id required");
            ExecutionEngine.Assert(price >= MinListingPrice, "Price below minimum");
            ExecutionEngine.Assert(price <= MaxListingPrice, "Price exceeds maximum");
            ValidateListingText(title, metadataUri);

            UInt160 seller = RequireBackupOwner(aaContract!, accountId!);
            ExecutionEngine.Assert(Runtime.CheckWitness(seller), "Seller witness required");

            BigInteger listingId = AllocateListingId();
            Listing listing = new Listing
            {
                Id = listingId,
                AAContract = aaContract!,
                AccountId = accountId!,
                Seller = seller,
                Price = price,
                Title = title ?? "",
                MetadataUri = metadataUri ?? "",
                Status = StatusActive,
                Buyer = UInt160.Zero,
                CreatedAt = Runtime.Time,
                UpdatedAt = Runtime.Time
            };

            Contract.Call(aaContract!, "enterMarketEscrow", CallFlags.All, new object[] { accountId!, Runtime.ExecutingScriptHash, listingId });
            PutListing(listing);
        }

        public static void UpdateListingPrice(BigInteger listingId, BigInteger newPrice)
        {
            ExecutionEngine.Assert(newPrice >= MinListingPrice, "Price below minimum");
            ExecutionEngine.Assert(newPrice <= MaxListingPrice, "Price exceeds maximum");
            Listing listing = GetExistingListing(listingId);
            ExecutionEngine.Assert(listing.Status == StatusActive, "Listing not active");
            ExecutionEngine.Assert(Runtime.CheckWitness(listing.Seller), "Seller witness required");
            ExecutionEngine.Assert(GetPendingCount(listingId) == 0, "Pending payment in flight");

            listing.Price = newPrice;
            listing.UpdatedAt = Runtime.Time;
            PutListing(listing);
        }

        public static void CancelListing(BigInteger listingId)
        {
            Listing listing = GetExistingListing(listingId);
            ExecutionEngine.Assert(listing.Status == StatusActive, "Listing not active");
            ExecutionEngine.Assert(Runtime.CheckWitness(listing.Seller), "Seller witness required");
            ExecutionEngine.Assert(GetPendingCount(listingId) == 0, "Pending payment in flight");

            Contract.Call(listing.AAContract, "cancelMarketEscrow", CallFlags.All, new object[] { listing.AccountId, listingId });

            listing.Status = StatusCancelled;
            listing.UpdatedAt = Runtime.Time;
            PutListing(listing);
        }

        public static void SettleListing(BigInteger listingId, UInt160 payer, UInt160 newBackupOwner)
        {
            Listing listing = GetExistingListing(listingId);
            ExecutionEngine.Assert(listing.Status == StatusActive, "Listing not active");
            ExecutionEngine.Assert(payer != null && payer != UInt160.Zero, "Payer required");
            ExecutionEngine.Assert(Runtime.CheckWitness(payer!), "Payer witness required");
            ExecutionEngine.Assert(newBackupOwner != null && newBackupOwner != UInt160.Zero, "New backup owner required");

            BigInteger pendingPayment = GetPendingPayment(listingId, payer!);
            ExecutionEngine.Assert(pendingPayment == listing.Price, "Pending payment mismatch");
            ClearPendingPayment(listingId, payer!);

            ExecutionEngine.Assert(
                GAS.Transfer(Runtime.ExecutingScriptHash, listing.Seller, listing.Price, (ByteString)new byte[0]),
                "Seller payout failed");

            Contract.Call(
                listing.AAContract,
                "settleMarketEscrow",
                CallFlags.All,
                new object[] { listing.AccountId, listingId, newBackupOwner! });

            listing.Status = StatusSold;
            listing.Buyer = payer!;
            listing.UpdatedAt = Runtime.Time;
            PutListing(listing);
        }

        public static void RefundPendingPayment(BigInteger listingId, UInt160 payer)
        {
            ExecutionEngine.Assert(payer != null && payer != UInt160.Zero, "Payer required");
            ExecutionEngine.Assert(Runtime.CheckWitness(payer!), "Payer witness required");

            BigInteger pendingPayment = GetPendingPayment(listingId, payer!);
            ExecutionEngine.Assert(pendingPayment > 0, "No pending payment");

            ClearPendingPayment(listingId, payer!);
            ExecutionEngine.Assert(
                GAS.Transfer(Runtime.ExecutingScriptHash, payer!, pendingPayment, (ByteString)new byte[0]),
                "Refund failed");
        }

        /// <summary>
        /// Flips a listing out of the Active state at the request of the AA core that backs it.
        /// The AA core invokes this whenever it unilaterally clears its side of the escrow — most
        /// notably the backup owner's timelocked <c>ForceCancelMarketEscrow</c> escape — so the
        /// listing does not linger as a settleable zombie after the account is no longer escrowed.
        ///
        /// The caller must be the AA contract recorded on the listing AND must name the listing's
        /// own escrowed account: a single canonical AA core backs every listing, so
        /// <c>CallingScriptHash == listing.AAContract</c> alone only proves "the canonical core
        /// called", not "the core is acting for this listing's escrow". Binding the call to the
        /// listing's <c>AccountId</c> — which the core forwards from its own escrow record — stops
        /// an attacker from pointing a different account's escrow at a victim's listing and driving
        /// the victim's Active listing through this abandon path. Any in-flight buyer deposits are
        /// deliberately left untouched: the listing becoming Cancelled stops further
        /// <c>settleListing</c> attempts while <c>RefundPendingPayment</c> stays open, so buyer
        /// capital is always recoverable.
        ///
        /// The transition is idempotent: a listing that is already Cancelled or Sold is left as-is
        /// so the normal market-driven <c>cancelListing</c>/<c>settleListing</c> paths (which also
        /// notify the AA core) remain safe even when they overlap this callback.
        /// </summary>
        public static void AbandonListing(UInt160 accountId, BigInteger listingId)
        {
            Listing listing = GetExistingListing(listingId);
            ExecutionEngine.Assert(Runtime.CallingScriptHash == listing.AAContract, "Only listed AA contract");
            ExecutionEngine.Assert(accountId != null && listing.AccountId == accountId, "Account mismatch");
            if (listing.Status != StatusActive) return;

            listing.Status = StatusCancelled;
            listing.UpdatedAt = Runtime.Time;
            PutListing(listing);
        }

        public static void OnNEP17Payment(UInt160 from, BigInteger amount, object data)
        {
            if (Runtime.CallingScriptHash != GAS.Hash)
            {
                if (from == Runtime.ExecutingScriptHash) return;
                ExecutionEngine.Assert(false, "Only GAS accepted");
                return;
            }

            if (from == Runtime.ExecutingScriptHash) return;
            ExecutionEngine.Assert(amount > 0, "Invalid amount");

            BigInteger listingId = ParseListingId(data);
            Listing listing = GetExistingListing(listingId);
            ExecutionEngine.Assert(listing.Status == StatusActive, "Listing not active");
            ExecutionEngine.Assert(amount == listing.Price, "Payment must equal listing price");
            ExecutionEngine.Assert(GetPendingPayment(listingId, from) == 0, "Pending payment already exists");

            PutPendingPayment(listingId, from, amount);
        }

        [Safe]
        public static BigInteger GetListingCount()
        {
            ByteString? current = Storage.Get(Storage.CurrentContext, Prefix_NextListingId);
            if (current == null) return 0;
            BigInteger next = (BigInteger)current;
            return next <= 1 ? 0 : next - 1;
        }

        [Safe]
        public static object[] GetListing(BigInteger listingId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, ListingKey(listingId));
            if (data == null) return new object[] { };

            Listing listing = (Listing)StdLib.Deserialize(data!);
            return new object[]
            {
                listing.Id,
                listing.AAContract,
                listing.AccountId,
                listing.Seller,
                listing.Price,
                listing.Title,
                listing.MetadataUri,
                listing.Status,
                listing.Buyer,
                listing.CreatedAt,
                listing.UpdatedAt
            };
        }

        [Safe]
        public static BigInteger GetPendingPaymentOf(BigInteger listingId, UInt160 payer)
        {
            return GetPendingPayment(listingId, payer);
        }

        private static void ValidateListingText(string title, string metadataUri)
        {
            string safeTitle = title ?? "";
            string safeMetadataUri = metadataUri ?? "";
            ExecutionEngine.Assert(safeTitle.Length <= MaxTitleLength, "Title too long");
            ExecutionEngine.Assert(safeMetadataUri.Length <= MaxMetadataUriLength, "Metadata URI too long");
        }

        private static UInt160 RequireBackupOwner(UInt160 aaContract, UInt160 accountId)
        {
            UInt160 backupOwner = (UInt160)Contract.Call(aaContract, "getBackupOwner", CallFlags.ReadOnly, new object[] { accountId });
            ExecutionEngine.Assert(backupOwner != null && backupOwner != UInt160.Zero, "Backup owner not configured");
            return backupOwner!;
        }

        private static BigInteger AllocateListingId()
        {
            ByteString? current = Storage.Get(Storage.CurrentContext, Prefix_NextListingId);
            BigInteger next = current == null ? 1 : (BigInteger)current;
            Storage.Put(Storage.CurrentContext, Prefix_NextListingId, next + 1);
            return next;
        }

        private static Listing GetExistingListing(BigInteger listingId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, ListingKey(listingId));
            ExecutionEngine.Assert(data != null, "Listing not found");
            return (Listing)StdLib.Deserialize(data!);
        }

        private static void PutListing(Listing listing)
        {
            Storage.Put(Storage.CurrentContext, ListingKey(listing.Id), StdLib.Serialize(listing));
        }

        private static byte[] ListingKey(BigInteger listingId)
        {
            return Helper.Concat(Prefix_Listing, listingId.ToByteArray());
        }

        private static byte[] AllowedAAKey(UInt160 core)
        {
            return Helper.Concat(Prefix_AllowedAA, (byte[])core);
        }

        private static byte[] PendingPaymentKey(BigInteger listingId, UInt160 payer)
        {
            byte[] key = Helper.Concat(Prefix_PendingPayment, listingId.ToByteArray());
            return Helper.Concat(key, (byte[])payer);
        }

        private static void PutPendingPayment(BigInteger listingId, UInt160 payer, BigInteger amount)
        {
            Storage.Put(Storage.CurrentContext, PendingPaymentKey(listingId, payer), amount);
            Storage.Put(Storage.CurrentContext, PendingCountKey(listingId), GetPendingCount(listingId) + 1);
        }

        private static BigInteger GetPendingPayment(BigInteger listingId, UInt160 payer)
        {
            ByteString? pending = Storage.Get(Storage.CurrentContext, PendingPaymentKey(listingId, payer));
            return pending == null ? 0 : (BigInteger)pending;
        }

        private static void ClearPendingPayment(BigInteger listingId, UInt160 payer)
        {
            Storage.Delete(Storage.CurrentContext, PendingPaymentKey(listingId, payer));
            BigInteger remaining = GetPendingCount(listingId) - 1;
            if (remaining <= 0)
            {
                Storage.Delete(Storage.CurrentContext, PendingCountKey(listingId));
            }
            else
            {
                Storage.Put(Storage.CurrentContext, PendingCountKey(listingId), remaining);
            }
        }

        private static byte[] PendingCountKey(BigInteger listingId)
        {
            return Helper.Concat(Prefix_PendingCount, listingId.ToByteArray());
        }

        private static BigInteger GetPendingCount(BigInteger listingId)
        {
            ByteString? count = Storage.Get(Storage.CurrentContext, PendingCountKey(listingId));
            return count == null ? 0 : (BigInteger)count;
        }

        private static BigInteger ParseListingId(object data)
        {
            ExecutionEngine.Assert(data != null, "Listing id required");

            if (data is BigInteger bigInteger)
            {
                ExecutionEngine.Assert(bigInteger > 0, "Listing id required");
                return bigInteger;
            }

            if (data is ByteString raw)
            {
                ExecutionEngine.Assert(raw.Length > 0, "Listing id required");
                BigInteger listingId = (BigInteger)raw;
                ExecutionEngine.Assert(listingId > 0, "Listing id required");
                return listingId;
            }

            ExecutionEngine.Assert(false, "Listing id required");
            return 0;
        }

        private static void ValidateAdmin()
        {
            UInt160 admin = Admin();
            ExecutionEngine.Assert(admin != UInt160.Zero && admin.IsValid, "Admin not set");
            ExecutionEngine.Assert(Runtime.CheckWitness(admin), "Unauthorized admin");
        }
    }
}
