using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Behavioral VM tests for the market-escrow lifecycle across <c>AAAddressMarket</c> and
/// <c>SmartAccountV3</c>: listing locks the account, escrow blocks execution, settlement
/// pays the seller with real GAS and hands the buyer a clean shell, cancellation unlocks, and
/// only the escrow market contract may drive the wallet's escrow transitions.
/// </summary>
[TestClass]
public class MarketEscrowRuntimeTests
{
    private static readonly UInt160 Seller =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Buyer =
        UInt160.Parse("0x6666666666666666666666666666666666666666");

    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly BigInteger Price = 100_000_000; // 1 GAS

    private sealed class MarketHarness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Market { get; }

        public UInt160 Target { get; }

        public MarketHarness()
        {
            Wallet = Fx.Deploy("SmartAccountV3");
            Market = Fx.Deploy("AAAddressMarket");
            Target = Fx.Deploy("MockTransferTarget");
            // The market admin (the deploying validators account) allowlists the genuine AA core
            // so escrow listings backed by it are accepted. Signers are the validators by default.
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

        public void ExecuteTransferOp(UInt160 accountId, UInt160 owner, BigInteger nonce)
        {
            Fx.SetSigners(owner);
            object[] op = RuntimeFixture.UserOp(
                Target, "transfer",
                new object?[] { accountId, Recipient, (BigInteger)1000, null },
                nonce, Fx.Now() + 3_600_000, Array.Empty<byte>());
            Assert.IsTrue(Fx.CallBoolean(Wallet, "executeUserOp", accountId, op));
        }
    }

    [TestMethod]
    public void MarketEscrow_Enter_LocksAccountAndBlocksExecution()
    {
        MarketHarness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));
        Assert.AreEqual(h.Market, h.Fx.CallUInt160(h.Wallet, "getMarketEscrowContract", accountId));
        Assert.AreEqual(listingId, h.Fx.CallInteger(h.Wallet, "getMarketEscrowListingId", accountId));

        // Escrowed accounts must refuse user operations even from the backup owner.
        h.Fx.SetSigners(Seller);
        object[] op = RuntimeFixture.UserOp(
            h.Target, "transfer",
            new object?[] { accountId, Recipient, (BigInteger)1000, null },
            0, h.Fx.Now() + 3_600_000, Array.Empty<byte>());
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallBoolean(h.Wallet, "executeUserOp", accountId, op));
        StringAssert.Contains(blocked.Message, "Account locked in market escrow");
    }

    [TestMethod]
    public void MarketEscrow_Settle_PaysSellerAndTransfersCleanShellToBuyer()
    {
        MarketHarness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        h.Fx.FundGasFromValidators(Buyer, Price * 2);
        BigInteger sellerBefore = h.Fx.GasBalanceOf(Seller);
        BigInteger buyerBefore = h.Fx.GasBalanceOf(Buyer);

        // Buyer locks the exact price into the market with the listing id as transfer data.
        h.Fx.SetSigners(Buyer);
        h.Fx.TransferGas(Buyer, h.Market, Price, listingId);
        Assert.AreEqual(Price, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, Buyer));
        Assert.AreEqual(Price, h.Fx.GasBalanceOf(h.Market), "Market escrows the payment until settlement");

        h.Fx.CallVoid(h.Market, "settleListing", listingId, Buyer, Buyer);

        // Balances: the seller received exactly the price, the market keeps nothing.
        Assert.AreEqual(sellerBefore + Price, h.Fx.GasBalanceOf(Seller), "Seller is paid the listing price");
        Assert.AreEqual(buyerBefore - Price, h.Fx.GasBalanceOf(Buyer), "Buyer paid exactly the listing price");
        Assert.AreEqual(BigInteger.Zero, h.Fx.GasBalanceOf(h.Market), "Market retains no GAS after settlement");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Market, "getPendingPaymentOf", listingId, Buyer));

        // The buyer received a clean shell: new backup owner, no inherited modules, unlocked.
        Assert.AreEqual(Buyer, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", accountId));
        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Wallet, "getVerifier", accountId));
        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Wallet, "getHook", accountId));
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));

        // And the buyer controls it through the native fallback path.
        h.ExecuteTransferOp(accountId, Buyer, nonce: 0);
    }

    [TestMethod]
    public void MarketEscrow_Cancel_UnlocksAccountForSeller()
    {
        MarketHarness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));

        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Market, "cancelListing", listingId);

        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));
        Assert.AreEqual(Seller, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", accountId), "Cancel keeps the seller in control");
        h.ExecuteTransferOp(accountId, Seller, nonce: 0);
    }

    [TestMethod]
    public void MarketEscrow_SettleWithoutLockedPayment_Faults()
    {
        MarketHarness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        h.Fx.SetSigners(Buyer);
        TestException mismatch = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Market, "settleListing", listingId, Buyer, Buyer));
        StringAssert.Contains(mismatch.Message, "Pending payment mismatch");
    }

    [TestMethod]
    public void MarketEscrow_OnlyEscrowMarketMayCancelOrSettleOnWallet()
    {
        MarketHarness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        // Direct calls to the wallet from anyone other than the escrow market must fault,
        // even with the seller's witness attached.
        h.Fx.SetSigners(Seller);
        TestException cancelBlocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "cancelMarketEscrow", accountId, listingId));
        StringAssert.Contains(cancelBlocked.Message, "Only escrow market");

        TestException settleBlocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "settleMarketEscrow", accountId, listingId, Buyer));
        StringAssert.Contains(settleBlocked.Message, "Only escrow market");
    }
}
