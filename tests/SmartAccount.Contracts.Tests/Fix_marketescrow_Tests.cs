using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Regression coverage for the market-escrow DoS fix: an account that is locked into a
/// market escrow whose market contract becomes unresponsive (destroyed, upgraded away, or
/// simply never settling) must still have an owner-side escape. The backup owner can
/// initiate a timelocked cancellation and, once the delay elapses, force-cancel to reclaim
/// control. The timelock protects an honest market's settle window, and the normal
/// market-driven settle/cancel paths remain authoritative.
/// </summary>
[TestClass]
public class Fix_MarketEscrow_OwnerEscapeTests
{
    private static readonly UInt160 Seller =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Buyer =
        UInt160.Parse("0x6666666666666666666666666666666666666666");

    private static readonly UInt160 Stranger =
        UInt160.Parse("0x5555555555555555555555555555555555555555");

    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly BigInteger Price = 100_000_000; // 1 GAS

    // Must exceed the contract's 7-day MarketEscrowOwnerCancelTimelockMs.
    private static readonly TimeSpan OwnerCancelTimelock = TimeSpan.FromDays(7);

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Market { get; }

        public UInt160 Target { get; }

        public Harness()
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
    public void OwnerForceCancel_UnlocksStuckEscrowAfterTimelock()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        h.CreateListing(accountId);
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));

        // The market is now (simulated) unresponsive: it never settles or cancels. The owner
        // initiates the timelocked escape.
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "initiateMarketEscrowCancel", accountId);
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "hasMarketEscrowOwnerCancel", accountId));

        // Before the timelock elapses the force-cancel must be refused.
        TestException early = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "forceCancelMarketEscrow", accountId));
        StringAssert.Contains(early.Message, "Owner cancel timelock active");
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));

        // After the delay the owner reclaims the account; ownership is unchanged.
        h.Fx.AdvanceTime(OwnerCancelTimelock);
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "forceCancelMarketEscrow", accountId);

        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "hasMarketEscrowOwnerCancel", accountId));
        Assert.AreEqual(Seller, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", accountId),
            "Owner escape must not transfer control");
        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Wallet, "getMarketEscrowContract", accountId));

        // And the unlocked account is usable again through the native path.
        h.ExecuteTransferOp(accountId, Seller, nonce: 0);
    }

    [TestMethod]
    public void OwnerCancel_RequiresBackupOwnerWitness()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        h.CreateListing(accountId);

        // A non-owner cannot initiate the escape.
        h.Fx.SetSigners(Stranger);
        TestException initBlocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "initiateMarketEscrowCancel", accountId));
        StringAssert.Contains(initBlocked.Message, "Unauthorized");

        // The legitimate owner initiates.
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "initiateMarketEscrowCancel", accountId);
        h.Fx.AdvanceTime(OwnerCancelTimelock);

        // A non-owner cannot finish it either, even after the timelock.
        h.Fx.SetSigners(Stranger);
        TestException forceBlocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "forceCancelMarketEscrow", accountId));
        StringAssert.Contains(forceBlocked.Message, "Unauthorized");
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));
    }

    [TestMethod]
    public void OwnerForceCancel_RequiresPriorInitiation()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        h.CreateListing(accountId);

        h.Fx.SetSigners(Seller);
        TestException notInitiated = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "forceCancelMarketEscrow", accountId));
        StringAssert.Contains(notInitiated.Message, "Owner cancel not initiated");
    }

    [TestMethod]
    public void OwnerCancel_RequiresActiveEscrow()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        // No listing => no escrow.

        h.Fx.SetSigners(Seller);
        TestException noEscrow = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "initiateMarketEscrowCancel", accountId));
        StringAssert.Contains(noEscrow.Message, "Market escrow not active");
    }

    [TestMethod]
    public void NormalMarketSettle_StillWorksAndClearsPendingOwnerCancel()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Seller, 2_592_000);
        BigInteger listingId = h.CreateListing(accountId);

        // Owner starts an escape, but the honest market settles within the window.
        h.Fx.SetSigners(Seller);
        h.Fx.CallVoid(h.Wallet, "initiateMarketEscrowCancel", accountId);
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "hasMarketEscrowOwnerCancel", accountId));

        h.Fx.FundGasFromValidators(Buyer, Price * 2);
        h.Fx.SetSigners(Buyer);
        h.Fx.TransferGas(Buyer, h.Market, Price, listingId);
        h.Fx.CallVoid(h.Market, "settleListing", listingId, Buyer, Buyer);

        // Sale completed: buyer owns a clean shell and the stale owner-cancel marker is gone.
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "hasMarketEscrowOwnerCancel", accountId));
        Assert.AreEqual(Buyer, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", accountId));
        h.ExecuteTransferOp(accountId, Buyer, nonce: 0);
    }
}
