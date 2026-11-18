using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Regression coverage for the zombie-listing finding: when the wallet clears a market escrow on
/// its own side — via the backup owner's timelocked <c>forceCancelMarketEscrow</c> escape, or via
/// the market-driven <c>cancelMarketEscrow</c> — it must notify the market so the listing leaves
/// the Active state. Otherwise the account is reclaimed but the market keeps an Active listing
/// that can never settle (its <c>settleMarketEscrow</c> call back into the wallet faults) and that
/// cannot be cleaned while a buyer's payment is outstanding. After the wallet's notification the
/// listing is Cancelled, <c>settleListing</c> is refused, and any in-flight buyer deposit stays
/// recoverable through <c>refundPendingPayment</c>.
/// </summary>
[TestClass]
public class Fix_MarketZombie_Tests
{
    private static readonly UInt160 Seller =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Buyer =
        UInt160.Parse("0x6666666666666666666666666666666666666666");

    // A griefer who owns their own account and tries to weaponise the escrow/abandon path
    // against a victim's listing.
    private static readonly UInt160 Attacker =
        UInt160.Parse("0x7777777777777777777777777777777777777777");

    private static readonly BigInteger Price = 100_000_000; // 1 GAS

    private const byte StatusActive = 1;
    private const byte StatusCancelled = 3;

    // Index of Status within the GetListing tuple:
    // [Id, SAContract, AccountId, Seller, Price, Title, MetadataUri, Status, Buyer, CreatedAt, UpdatedAt]
    private const int StatusIndex = 7;

    // Must exceed the contract's 7-day MarketEscrowOwnerCancelTimelockMs.
    private static readonly TimeSpan OwnerCancelTimelock = TimeSpan.FromDays(7);

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Market { get; }

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            Market = Fx.Deploy("SAAddressMarket");
            Fx.CallVoid(Market, "setAllowedSA", Wallet, true);
            // Phase 1b: the core admin registers the market as an approved escrow service.
            Fx.CallVoid(Wallet, "setMarketService", Market, true);
        }

        public UInt160 RegisterAccount(UInt160 backupOwner, uint escapeTimelock)
        {
            UInt160 accountId = Fx.CallUInt160(
                Wallet, "computeRegistrationAccountId",
                UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, backupOwner, escapeTimelock);

            Fx.SetSigners(backupOwner);
            Fx.CallVoid(
                Wallet, "registerAccount",
                accountId, UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, backupOwner, escapeTimelock);
            return accountId;
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
    }

    [TestMethod]
    public void OwnerForceCancel_FlipsListingOutOfActive_NoSettleableZombie()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);
        Assert.AreEqual((BigInteger)StatusActive, h.ListingStatus(listingId), "Listing starts Active");

        // The backup owner escapes a stuck escrow via the timelocked path.
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "initiateMarketEscrowCancel", accountId);
        h.Fx.AdvanceTime(OwnerCancelTimelock);
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "forceCancelMarketEscrow", accountId);

        // The account is reclaimed AND the market listing is no longer a zombie.
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));
        Assert.AreEqual((BigInteger)StatusCancelled, h.ListingStatus(listingId),
            "Force-cancel must flip the market listing out of Active");

        // The settle path is now refused: no zombie listing can be settled.
        h.Fx.FundGasFromValidators(Buyer, Price * 2);
        h.Fx.SetSigners(Buyer);
        TestException notActive = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Market, "settleListing", listingId, Buyer, Buyer));
        StringAssert.Contains(notActive.Message, "Listing not active");
    }

    [TestMethod]
    public void OwnerForceCancel_WithBuyerDepositOutstanding_BuyerCanStillRefund()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        // A buyer locks a deposit against the (later abandoned) listing.
        h.Fx.FundGasFromValidators(Buyer, Price * 2);
        h.Fx.SetSigners(Buyer);
        h.Fx.TransferGas(Buyer, h.Market, Price, listingId);
        Assert.AreEqual(Price, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, Buyer));
        BigInteger buyerAfterDeposit = h.Fx.GasBalanceOf(Buyer);

        // While the deposit is in flight the owner cannot escape (the timelock arming itself is
        // allowed, but the listing's pending-payment guard keeps the seller-side cancel blocked).
        // The owner still has the unilateral force-cancel escape available after the timelock.
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "initiateMarketEscrowCancel", accountId);
        h.Fx.AdvanceTime(OwnerCancelTimelock);
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "forceCancelMarketEscrow", accountId);

        // The listing is retired but the buyer's capital is untouched and still escrowed.
        Assert.AreEqual((BigInteger)StatusCancelled, h.ListingStatus(listingId));
        Assert.AreEqual(Price, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, Buyer),
            "Buyer deposit is left intact when the listing is abandoned");
        Assert.AreEqual(Price, h.Fx.GasBalanceOf(h.Market), "Market still escrows the buyer deposit");

        // The buyer can always pull the deposit back, even after the listing is Cancelled.
        h.Fx.SetSigners(Buyer);
        h.Fx.CallVoid(h.Market, "refundPendingPayment", listingId, Buyer);
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, Buyer));
        Assert.AreEqual(buyerAfterDeposit + Price, h.Fx.GasBalanceOf(Buyer), "Buyer fully recovers the deposit");
        Assert.AreEqual(BigInteger.Zero, h.Fx.GasBalanceOf(h.Market), "Market retains no GAS after the refund");
    }

    [TestMethod]
    public void MarketDrivenCancel_LeavesListingCancelled()
    {
        // The normal seller-driven cancelListing path still ends with a Cancelled listing; the
        // wallet's extra abandon notification is idempotent and does not disturb it.
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Market, "cancelListing", listingId);

        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));
        Assert.AreEqual((BigInteger)StatusCancelled, h.ListingStatus(listingId),
            "Market-driven cancel ends with a Cancelled listing");
    }

    [TestMethod]
    public void AbandonListing_OnlyCallableByListedSaContract()
    {
        // A third party (here the seller) cannot retire an Active listing directly: only the SA
        // contract recorded on the listing may, which is exactly the contract that holds the escrow.
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        h.Fx.SetSigners(Seller);
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
        UInt160 accountId = h.RegisterAccount(Attacker, 2_592_000);

        h.Fx.SetSigners(Attacker);
        // CallingScriptHash here is the test entry script, not the market, so the binding is rejected
        // and no escrow is recorded against the attacker's account.
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "enterMarketEscrow", accountId, h.Market, (BigInteger)1));
        StringAssert.Contains(blocked.Message, "Caller is not the market");
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId),
            "No escrow may be armed by a non-market caller");
    }

    [TestMethod]
    public void Attacker_CannotAbandonVictimListing_ViaOwnEscrow()
    {
        // The documented attack: the griefer owns account A, points an escrow at the VICTIM's
        // listing, then drives the owner force-cancel escape so the wallet calls
        // abandonListing(victimListing) with CallingScriptHash == the canonical core. After the
        // fix the attacker cannot even arm that escrow (enterMarketEscrow requires the market to be
        // the caller), so the victim's Active listing is never disturbed.
        Harness h = new();

        // The victim has a genuine, market-armed Active listing.
        UInt160 victimAccount = h.RegisterAccount(Seller, 2_592_000);
        BigInteger victimListing = h.CreateListing(victimAccount);
        Assert.AreEqual((BigInteger)StatusActive, h.ListingStatus(victimListing), "Victim listing starts Active");

        // The attacker owns a separate account and tries to bind its escrow to the victim's listing.
        UInt160 attackerAccount = h.RegisterAccount(Attacker, 2_592_000);
        h.Fx.SetSigners(Attacker);
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "enterMarketEscrow", attackerAccount, h.Market, victimListing));
        StringAssert.Contains(blocked.Message, "Caller is not the market");

        // The attacker's account never entered escrow, so the timelocked escape path is unavailable
        // and there is nothing to force-cancel.
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", attackerAccount));
        h.Fx.SetSigners(Attacker);
        TestException noEscrow = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "initiateMarketEscrowCancel", attackerAccount));
        StringAssert.Contains(noEscrow.Message, "Market escrow not active");

        // The victim's listing is untouched and still settleable by a real buyer.
        Assert.AreEqual((BigInteger)StatusActive, h.ListingStatus(victimListing),
            "Victim listing must remain Active");
        h.Fx.FundGasFromValidators(Buyer, Price * 2);
        h.Fx.SetSigners(Buyer);
        h.Fx.TransferGas(Buyer, h.Market, Price, victimListing);
        h.Fx.CallVoid(h.Market, "settleListing", victimListing, Buyer, Buyer);
        Assert.AreEqual(Buyer, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", victimAccount),
            "Victim's legitimate sale still settles");
    }

    [TestMethod]
    public void LegitSettle_StillWorksEndToEnd()
    {
        // The honest market-armed flow (createListing -> settleListing) is unaffected by the
        // tightened enterMarketEscrow caller check, since createListing calls enterMarketEscrow with
        // CallingScriptHash == the market == the marketContract argument.
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId),
            "Legit createListing arms the escrow");

        h.Fx.FundGasFromValidators(Buyer, Price * 2);
        h.Fx.SetSigners(Buyer);
        h.Fx.TransferGas(Buyer, h.Market, Price, listingId);
        h.Fx.CallVoid(h.Market, "settleListing", listingId, Buyer, Buyer);

        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));
        Assert.AreEqual(Buyer, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", accountId),
            "Buyer receives the account on a legitimate settle");
    }
}
