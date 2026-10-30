using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Regression coverage for the non-atomic-purchase griefing finding: while a buyer's GAS is
/// escrowed for a listing, the seller (the AA backup owner) must not be able to invalidate that
/// in-flight deposit via <c>cancelListing</c> or <c>updateListingPrice</c> (which would make
/// <c>settleListing</c> revert and lock the buyer's capital). Once the deposit clears — by
/// settlement or refund — the seller regains the ability to cancel/reprice.
/// </summary>
[TestClass]
public class FixMarketPendingPaymentTests
{
    private static readonly UInt160 Seller =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Buyer =
        UInt160.Parse("0x6666666666666666666666666666666666666666");

    private static readonly BigInteger Price = 100_000_000; // 1 GAS

    private sealed class MarketHarness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Market { get; }

        public MarketHarness()
        {
            Wallet = Fx.Deploy("SmartAccountV3");
            Market = Fx.Deploy("AAAddressMarket");
            // The market admin (the deploying validators account) allowlists the genuine AA core
            // so listings backed by it are accepted. Signers are the validators here by default.
            Fx.CallVoid(Market, "setAllowedAA", Wallet, true);
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
            Fx.CallVoid(Market, "createListing", Wallet, accountId, Price, "AA address", "");
            return Fx.CallInteger(Market, "getListingCount");
        }

        public BigInteger CreateAndFundedListing()
        {
            UInt160 accountId = RegisterAccount(Seller, 2_592_000);
            BigInteger listingId = CreateListing(accountId);

            Fx.FundGasFromValidators(Buyer, Price * 2);
            Fx.SetSigners(Buyer);
            Fx.TransferGas(Buyer, Market, Price, listingId);
            Assert.AreEqual(Price, Fx.CallInteger(Market, "getPendingPaymentOf", listingId, Buyer));
            return listingId;
        }
    }

    [TestMethod]
    public void CancelListing_WithPendingPayment_Faults()
    {
        MarketHarness h = new();
        BigInteger listingId = h.CreateAndFundedListing();

        h.Fx.SetSigners(Seller);
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Market, "cancelListing", listingId));
        StringAssert.Contains(blocked.Message, "Pending payment in flight");

        // The buyer's capital remains recoverable and the escrow still settles afterwards.
        Assert.AreEqual(Price, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, Buyer));
    }

    [TestMethod]
    public void UpdateListingPrice_WithPendingPayment_Faults()
    {
        MarketHarness h = new();
        BigInteger listingId = h.CreateAndFundedListing();

        h.Fx.SetSigners(Seller);
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Market, "updateListingPrice", listingId, Price * 2));
        StringAssert.Contains(blocked.Message, "Pending payment in flight");
    }

    [TestMethod]
    public void Settle_AfterPendingDeposit_StillSucceeds()
    {
        MarketHarness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        h.Fx.FundGasFromValidators(Buyer, Price * 2);
        BigInteger sellerBefore = h.Fx.GasBalanceOf(Seller);

        h.Fx.SetSigners(Buyer);
        h.Fx.TransferGas(Buyer, h.Market, Price, listingId);

        h.Fx.CallVoid(h.Market, "settleListing", listingId, Buyer, Buyer);

        Assert.AreEqual(sellerBefore + Price, h.Fx.GasBalanceOf(Seller));
        Assert.AreEqual(BigInteger.Zero, h.Fx.GasBalanceOf(h.Market));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, Buyer));
    }

    [TestMethod]
    public void RefundPendingPayment_ReleasesLock_ThenSellerMayCancel()
    {
        MarketHarness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        h.Fx.FundGasFromValidators(Buyer, Price * 2);
        h.Fx.SetSigners(Buyer);
        h.Fx.TransferGas(Buyer, h.Market, Price, listingId);
        Assert.AreEqual(Price, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, Buyer));

        // Buyer pulls the deposit back as a fallback.
        h.Fx.CallVoid(h.Market, "refundPendingPayment", listingId, Buyer);
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, Buyer));

        // With no in-flight payment the seller regains the ability to cancel and the account unlocks.
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Market, "cancelListing", listingId);
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));
    }

    [TestMethod]
    public void CreateListing_WithNonAllowlistedAaContract_Faults()
    {
        // A fresh market with no AA core allowlisted: any listing must be refused before the
        // contract trusts the AA contract for getBackupOwner/escrow calls, so a malicious or
        // arbitrary AA contract cannot be used to defraud buyers.
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy("SmartAccountV3");
        UInt160 market = fx.Deploy("AAAddressMarket");

        UInt160 accountId = fx.CallUInt160(
            wallet, "computeRegistrationAccountId",
            UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, Seller, 2_592_000u);
        fx.SetSigners(Seller);
        fx.CallVoid(
            wallet, "registerAccount",
            accountId, UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, Seller, 2_592_000u);

        Assert.IsFalse(fx.CallBoolean(market, "isAllowedAA", wallet));
        fx.SetSigners(Seller);
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(market, "createListing", wallet, accountId, Price, "AA address", ""));
        StringAssert.Contains(blocked.Message, "AA core not allowlisted");
    }

    [TestMethod]
    public void CreateListing_AfterAdminAllowlistsCore_Succeeds()
    {
        // The genuine AA core must be usable once the admin allowlists it: the standard
        // list -> deposit -> settle path completes end to end.
        MarketHarness h = new();
        Assert.IsTrue(h.Fx.CallBoolean(h.Market, "isAllowedAA", h.Wallet));

        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        h.Fx.FundGasFromValidators(Buyer, Price * 2);
        BigInteger sellerBefore = h.Fx.GasBalanceOf(Seller);

        h.Fx.SetSigners(Buyer);
        h.Fx.TransferGas(Buyer, h.Market, Price, listingId);
        h.Fx.CallVoid(h.Market, "settleListing", listingId, Buyer, Buyer);

        Assert.AreEqual(sellerBefore + Price, h.Fx.GasBalanceOf(Seller));
        Assert.AreEqual(Buyer, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", accountId));
    }
}
