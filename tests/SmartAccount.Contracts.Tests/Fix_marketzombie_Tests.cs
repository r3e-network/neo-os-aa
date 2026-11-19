using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Regression coverage for the zombie-listing finding in v4 terms. The retired owner-side
/// <c>forceCancelMarketEscrow</c> is replaced by callback-free recovery: executing it bumps
/// the control revision, so the stale 0x5D binding can never settle the account again
/// (<c>SA_MARKET_LOCKED</c>) and the physical markers are retired by the market's own
/// <c>cancelListing</c> cleanup claim. A listing therefore never becomes a settleable zombie,
/// a buyer's in-flight deposit stays refundable throughout, and only the contract recorded
/// on the listing may drive <c>abandonListing</c>.
/// </summary>
[TestClass]
public class Fix_MarketZombie_Tests
{
    // A griefer who owns their own account and tries to weaponise the escrow/abandon path
    // against a victim's listing.
    private static readonly UInt160 Attacker =
        UInt160.Parse("0x7777777777777777777777777777777777777777");

    private static readonly BigInteger Price = 100_000_000; // 1 GAS

    private static readonly byte StatusActive = 1;

    private static readonly byte StatusCancelled = 3;

    // Index of Status within the GetListing tuple:
    // [Id, SAContract, AccountId, Seller, Price, Title, MetadataUri, Status, Buyer, CreatedAt, UpdatedAt]
    private const int StatusIndex = 7;

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Market { get; }

        public P256SessionKey SellerKey { get; } = new();

        public P256SessionKey BuyerKey { get; } = new();

        public UInt160 Seller => RuntimeFixture.CustodyOf(SellerKey);

        public UInt160 Buyer => RuntimeFixture.CustodyOf(BuyerKey);

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            Market = Fx.Deploy("SAAddressMarket");
            Fx.CallVoid(Market, "setAllowedSA", Wallet, true);
            // The core admin registers the market as an approved escrow service.
            Fx.CallVoid(Wallet, "setMarketService", Market, true);
        }

        public UInt160 RegisterAccount(UInt160 owner)
        {
            Fx.SetSigners(owner);
            return Fx.CreateAccount(
                Wallet, owner, RuntimeFixture.Salt("zombie-" + owner), RuntimeFixture.MinRecoveryTimelockMs);
        }

        public BigInteger CreateListing(UInt160 accountId)
        {
            Fx.SetSigners(Seller);
            Fx.CallVoid(Market, "createListing", Wallet, accountId, Price, "SA address", "");
            return Fx.CallInteger(Market, "getListingCount");
        }

        public BigInteger ListingStatus(BigInteger listingId)
        {
            Neo.VM.Types.Array tuple = (Neo.VM.Types.Array)Fx.Call(Market, "getListing", listingId);
            return tuple[StatusIndex].GetInteger();
        }

        public void Deposit(BigInteger listingId)
        {
            Fx.FundGasFromValidators(Buyer, Price * 2);
            Fx.SetSigners(Buyer);
            Fx.TransferGas(Buyer, Market, Price, listingId);
        }

        /// <summary>Walks the owner escape through the v4 recovery flow.</summary>
        public void EscapeViaRecovery(UInt160 accountId, UInt160 owner)
        {
            Fx.SetSigners(owner);
            Fx.CallVoid(Wallet, "beginRecovery", accountId, UInt160.Zero);
            Fx.AdvanceTime(TimeSpan.FromMilliseconds((long)RuntimeFixture.MinRecoveryTimelockMs) + TimeSpan.FromSeconds(1));
            Fx.CallVoid(Wallet, "executeRecovery", accountId);
        }

        public UInt160 Custody(UInt160 accountId)
        {
            var record = (Neo.VM.Types.Array)Fx.Call(Wallet, "getAccount", accountId);
            return new UInt160(record[2].GetSpan());
        }

        public bool EscrowActive(UInt160 accountId) =>
            Fx.CallBoolean(Wallet, "isMarketEscrowActive", accountId);
    }

    [TestMethod]
    public void OwnerRecovery_FlipsListingOutOfActive_NoSettleableZombie()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(h.Seller);
        BigInteger listingId = h.CreateListing(accountId);
        Assert.AreEqual((BigInteger)StatusActive, h.ListingStatus(listingId), "Listing starts Active");

        // A buyer locks a deposit, then the owner escapes the stuck escrow through recovery.
        h.Deposit(listingId);
        h.EscapeViaRecovery(accountId, h.Seller);

        // The old-epoch lock is dead: the deposit cannot be converted into a sale.
        h.Fx.SetSigners(h.Buyer);
        TestException notSettleable = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Market, "settleListing", listingId, h.Buyer, h.Buyer));
        StringAssert.Contains(notSettleable.Message, "SA_MARKET_LOCKED");

        // The buyer refunds, then the market's cleanup claim retires the listing.
        h.Fx.CallVoid(h.Market, "refundPendingPayment", listingId, h.Buyer);
        h.Fx.SetSigners(h.Seller);
        h.Fx.CallVoid(h.Market, "cancelListing", listingId);

        Assert.IsFalse(h.EscrowActive(accountId));
        Assert.AreEqual((BigInteger)StatusCancelled, h.ListingStatus(listingId),
            "The cleanup claim must flip the market listing out of Active");
        Assert.AreEqual(h.Seller, h.Custody(accountId), "The owner keeps control of the account");

        h.Fx.FundGasFromValidators(h.Buyer, Price * 2);
        h.Fx.SetSigners(h.Buyer);
        TestException notActive = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Market, "settleListing", listingId, h.Buyer, h.Buyer));
        StringAssert.Contains(notActive.Message, "Listing not active");
    }

    [TestMethod]
    public void OwnerRecovery_WithBuyerDepositOutstanding_BuyerCanStillRefund()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(h.Seller);
        BigInteger listingId = h.CreateListing(accountId);

        // A buyer locks a deposit against the (later abandoned) listing.
        h.Deposit(listingId);
        Assert.AreEqual(Price, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, h.Buyer));
        BigInteger buyerAfterDeposit = h.Fx.GasBalanceOf(h.Buyer);

        h.EscapeViaRecovery(accountId, h.Seller);

        // The listing is still Active (only the market can retire it) but unsellable, and the
        // pending-payment guard keeps the seller-side cancel blocked until the deposit clears.
        Assert.AreEqual((BigInteger)StatusActive, h.ListingStatus(listingId));
        h.Fx.SetSigners(h.Seller);
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Market, "cancelListing", listingId));
        StringAssert.Contains(blocked.Message, "Pending payment in flight");
        Assert.AreEqual(Price, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, h.Buyer),
            "Buyer deposit is left intact by the owner escape");
        Assert.AreEqual(Price, h.Fx.GasBalanceOf(h.Market), "Market still escrows the buyer deposit");

        // The buyer can always pull the deposit back, even while the listing is stuck.
        h.Fx.SetSigners(h.Buyer);
        h.Fx.CallVoid(h.Market, "refundPendingPayment", listingId, h.Buyer);
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, h.Buyer));
        Assert.AreEqual(buyerAfterDeposit + Price, h.Fx.GasBalanceOf(h.Buyer), "Buyer fully recovers the deposit");
        Assert.AreEqual(BigInteger.Zero, h.Fx.GasBalanceOf(h.Market), "Market retains no GAS after the refund");
    }

    [TestMethod]
    public void MarketDrivenCancel_LeavesListingCancelled()
    {
        // The normal seller-driven cancelListing path still ends with a Cancelled listing; the
        // wallet's escrow unwind is idempotent and does not disturb it.
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(h.Seller);
        BigInteger listingId = h.CreateListing(accountId);

        h.Fx.SetSigners(h.Seller);
        h.Fx.CallVoid(h.Market, "cancelListing", listingId);

        Assert.IsFalse(h.EscrowActive(accountId));
        Assert.AreEqual((BigInteger)StatusCancelled, h.ListingStatus(listingId),
            "Market-driven cancel ends with a Cancelled listing");
    }

    [TestMethod]
    public void AbandonListing_OnlyCallableByListedSaContract()
    {
        // A third party (here the seller) cannot retire an Active listing directly: only the SA
        // contract recorded on the listing may, which is exactly the contract that holds the escrow.
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(h.Seller);
        BigInteger listingId = h.CreateListing(accountId);

        h.Fx.SetSigners(h.Seller);
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Market, "abandonListing", accountId, listingId));
        StringAssert.Contains(blocked.Message, "Only listed SA contract");
        Assert.AreEqual((BigInteger)StatusActive, h.ListingStatus(listingId), "Listing stays Active");
    }

    [TestMethod]
    public void EnterMarketEscrow_RejectsNonMarketCaller()
    {
        // The (market, listingId) escrow binding may only be armed by the market itself. A backup
        // owner calling enterMarketEscrow directly (no market in the call chain) is refused, which
        // is the root-cause guard for the abandon griefing vector.
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Attacker);

        h.Fx.SetSigners(Attacker);
        // CallingScriptHash here is the test entry script, not the market, so the binding is rejected
        // and no escrow is recorded against the attacker's account.
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "enterMarketEscrow", accountId, h.Market, (BigInteger)1));
        StringAssert.Contains(blocked.Message, "Caller is not the market");
        Assert.IsFalse(h.EscrowActive(accountId),
            "No escrow may be armed by a non-market caller");
    }

    [TestMethod]
    public void Attacker_CannotAbandonVictimListing_ViaOwnEscrow()
    {
        // The documented attack: the griefer owns account A, points an escrow at the VICTIM's
        // listing, then drives the owner escape so the wallet retires the victim's listing.
        // In v4 the attacker cannot even arm that escrow (enterMarketEscrow requires the market
        // to be the caller) and recovery is strictly per-account, so the victim is untouched.
        Harness h = new();

        // The victim has a genuine, market-armed Active listing.
        UInt160 victimAccount = h.RegisterAccount(h.Seller);
        BigInteger victimListing = h.CreateListing(victimAccount);
        Assert.AreEqual((BigInteger)StatusActive, h.ListingStatus(victimListing), "Victim listing starts Active");

        // The attacker owns a separate account and tries to bind its escrow to the victim's listing.
        UInt160 attackerAccount = h.RegisterAccount(Attacker);
        h.Fx.SetSigners(Attacker);
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "enterMarketEscrow", attackerAccount, h.Market, victimListing));
        StringAssert.Contains(blocked.Message, "Caller is not the market");

        // The attacker's account never entered escrow: it can recover (its own account only),
        // but there is no market claim to make on the victim's listing.
        Assert.IsFalse(h.EscrowActive(attackerAccount));
        h.EscapeViaRecovery(attackerAccount, Attacker);
        TestException noEscrow = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "cancelMarketEscrow", attackerAccount, victimListing));
        StringAssert.Contains(noEscrow.Message, "Market escrow not active");

        // The victim's listing is untouched and still settleable by a real buyer.
        Assert.AreEqual((BigInteger)StatusActive, h.ListingStatus(victimListing),
            "Victim listing must remain Active");
        h.Fx.FundGasFromValidators(h.Buyer, Price * 2);
        h.Fx.SetSigners(h.Buyer);
        h.Fx.TransferGas(h.Buyer, h.Market, Price, victimListing);
        h.Fx.CallVoid(h.Market, "settleListing", victimListing, h.Buyer, h.Buyer);
        Assert.AreEqual(h.Buyer, h.Custody(victimAccount),
            "Victim's legitimate sale still settles");
    }

    [TestMethod]
    public void LegitSettle_StillWorksEndToEnd()
    {
        // The honest market-armed flow (createListing -> settleListing) is unaffected by the
        // tightened enterMarketEscrow caller check, since createListing calls enterMarketEscrow with
        // CallingScriptHash == the market == the marketContract argument.
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(h.Seller);
        BigInteger listingId = h.CreateListing(accountId);
        Assert.IsTrue(h.EscrowActive(accountId), "Legit createListing arms the escrow");

        h.Fx.FundGasFromValidators(h.Buyer, Price * 2);
        h.Fx.SetSigners(h.Buyer);
        h.Fx.TransferGas(h.Buyer, h.Market, Price, listingId);
        h.Fx.CallVoid(h.Market, "settleListing", listingId, h.Buyer, h.Buyer);

        Assert.IsFalse(h.EscrowActive(accountId));
        Assert.AreEqual(h.Buyer, h.Custody(accountId),
            "Buyer receives the account on a legitimate settle");
    }
}
