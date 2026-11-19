using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Regression coverage for the market-escrow griefing fix (spec §7.5) in v4 terms.
/// The retired owner-side <c>initiateMarketEscrowCancel</c>/<c>forceCancelMarketEscrow</c>
/// pair is replaced by the callback-free recovery flow: while an escrow lock is active the
/// owner may begin recovery, and executing it advances the control revision so the old
/// 0x5D binding can never settle the account again. The physical Market markers are then
/// cleaned by the market's own later claim (<c>MarketLockInvalidated</c>), which keeps the
/// honest settle path authoritative inside the timelock window.
/// </summary>
[TestClass]
public class Fix_MarketEscrow_OwnerEscapeTests
{
    private static readonly UInt160 Stranger =
        UInt160.Parse("0x5555555555555555555555555555555555555555");

    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly BigInteger Price = 100_000_000; // 1 GAS

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Market { get; }

        public UInt160 Target { get; }

        public P256SessionKey SellerKey { get; } = new();

        public P256SessionKey BuyerKey { get; } = new();

        /// <summary>The seller's custody script (a P-256 script so v4 operations sign).</summary>
        public UInt160 Seller => RuntimeFixture.CustodyOf(SellerKey);

        public UInt160 Buyer => RuntimeFixture.CustodyOf(BuyerKey);

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            Market = Fx.Deploy("SAAddressMarket");
            Target = Fx.Deploy("MockTransferTarget");
            // The market admin allowlists the genuine SA core, and the core admin
            // registers the market as an approved escrow service (both gates required).
            Fx.CallVoid(Market, "setAllowedSA", Wallet, true);
            Fx.CallVoid(Wallet, "setMarketService", Market, true);
        }

        public UInt160 RegisterAccount(UInt160 owner)
        {
            Fx.SetSigners(owner);
            return Fx.CreateAccount(
                Wallet, owner, RuntimeFixture.Salt("escrow-owner"), RuntimeFixture.MinRecoveryTimelockMs);
        }

        public BigInteger CreateListing(UInt160 accountId)
        {
            Fx.SetSigners(Seller);
            Fx.CallVoid(Market, "createListing", Wallet, accountId, Price, "SA address", "");
            return Fx.CallInteger(Market, "getListingCount");
        }

        public void ExecuteTransferOp(UInt160 accountId, P256SessionKey key)
        {
            var record = (Neo.VM.Types.Array)Fx.Call(Wallet, "getAccount", accountId);
            object[] op = RuntimeFixture.UserOp(
                Target, "transfer",
                new object?[] { accountId, Recipient, (BigInteger)1000, null },
                Fx.PackedNonce(Wallet, accountId, 0), Fx.Now() + 3_600_000, new byte[] { 0x00 },
                authorityEpoch: record[4].GetInteger(),
                configurationNonce: record[5].GetInteger());
            op[11] = Fx.SignBuiltIn(Wallet, accountId, op, key);
            Fx.SetSigners(RuntimeFixture.CustodyOf(key));
            Assert.IsTrue(Fx.CallBoolean(Wallet, "executeUserOp", accountId, op));
        }

        public UInt160 Custody(UInt160 accountId)
        {
            var record = (Neo.VM.Types.Array)Fx.Call(Wallet, "getAccount", accountId);
            return new UInt160(record[2].GetSpan());
        }

        public bool EscrowActive(UInt160 accountId) =>
            Fx.CallBoolean(Wallet, "isMarketEscrowActive", accountId);

        public bool RecoveryPending(UInt160 accountId) =>
            ((Neo.VM.Types.Array)Fx.Call(Wallet, "getRecoveryStatus", accountId)).Count > 0;

        public void AdvancePastRecoveryTimelock() =>
            Fx.AdvanceTime(TimeSpan.FromMilliseconds((long)RuntimeFixture.MinRecoveryTimelockMs) + TimeSpan.FromSeconds(1));
    }

    [TestMethod]
    public void OwnerRecovery_InvalidatesStuckEscrowAfterTimelock()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(h.Seller);
        BigInteger listingId = h.CreateListing(accountId);
        Assert.IsTrue(h.EscrowActive(accountId));

        // The market is now (simulated) unresponsive: it never settles or cancels. The
        // owner-side escape is the callback-free recovery flow, which never calls the market.
        h.Fx.SetSigners(h.Seller);
        h.Fx.CallVoid(h.Wallet, "beginRecovery", accountId, UInt160.Zero);
        Assert.IsTrue(h.RecoveryPending(accountId));

        // Before the timelock elapses the recovery cannot be executed.
        TestException early = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "executeRecovery", accountId));
        StringAssert.Contains(early.Message, "SA_RECOVERY_LOCKED");
        Assert.IsTrue(h.EscrowActive(accountId));

        // After the delay the matured recovery sweeps the account and bumps the control
        // revision; it is permissionless and makes no external call.
        h.AdvancePastRecoveryTimelock();
        h.Fx.CallVoid(h.Wallet, "executeRecovery", accountId);
        Assert.IsFalse(h.RecoveryPending(accountId));
        Assert.AreEqual(h.Seller, h.Custody(accountId), "Recovery must not transfer control");

        // The stale 0x5D binding can no longer settle: the buyer's GAS is never taken
        // and the sale is refused under the old epoch.
        h.Fx.FundGasFromValidators(h.Buyer, Price * 2);
        h.Fx.SetSigners(h.Buyer);
        h.Fx.TransferGas(h.Buyer, h.Market, Price, listingId);
        TestException locked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Market, "settleListing", listingId, h.Buyer, h.Buyer));
        StringAssert.Contains(locked.Message, "SA_MARKET_LOCKED");

        // The buyer pulls the deposit back, then the market's cancel claim cleans the
        // physical markers (a cleanup-only claim) and the seller is usable again.
        h.Fx.CallVoid(h.Market, "refundPendingPayment", listingId, h.Buyer);
        h.Fx.SetSigners(h.Seller);
        h.Fx.CallVoid(h.Market, "cancelListing", listingId);

        Assert.IsFalse(h.EscrowActive(accountId));
        Assert.AreEqual(h.Seller, h.Custody(accountId), "The cleanup claim must not move control");
        h.ExecuteTransferOp(accountId, h.SellerKey);
    }

    [TestMethod]
    public void OwnerRecovery_RequiresCustodyWitness()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(h.Seller);
        h.CreateListing(accountId);

        // A non-owner cannot initiate the escape.
        h.Fx.SetSigners(Stranger);
        TestException initBlocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "beginRecovery", accountId, UInt160.Zero));
        StringAssert.Contains(initBlocked.Message, "SA_UNAUTHORIZED");

        // The legitimate owner initiates, and only the owner (or the recovery authority)
        // may cancel it back out — executing a matured recovery itself is permissionless.
        h.Fx.SetSigners(h.Seller);
        h.Fx.CallVoid(h.Wallet, "beginRecovery", accountId, UInt160.Zero);
        h.AdvancePastRecoveryTimelock();

        h.Fx.SetSigners(Stranger);
        TestException cancelBlocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "cancelRecovery", accountId));
        StringAssert.Contains(cancelBlocked.Message, "SA_UNAUTHORIZED");
        Assert.IsTrue(h.EscrowActive(accountId));
        Assert.IsTrue(h.RecoveryPending(accountId));
    }

    [TestMethod]
    public void OwnerRecovery_ExecuteRequiresPriorInitiation()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(h.Seller);
        h.CreateListing(accountId);

        h.Fx.SetSigners(h.Seller);
        TestException notInitiated = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "executeRecovery", accountId));
        StringAssert.Contains(notInitiated.Message, "SA_RECOVERY_PENDING");
        Assert.IsTrue(h.EscrowActive(accountId));
    }

    [TestMethod]
    public void MarketCleanupClaim_RequiresActiveEscrow()
    {
        // The only owner-facing escrow primitive left is the market's own cancel claim;
        // it must refuse an account that is not locked.
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(h.Seller);

        h.Fx.SetSigners(h.Seller);
        TestException noEscrow = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "cancelMarketEscrow", accountId, (BigInteger)1));
        StringAssert.Contains(noEscrow.Message, "Market escrow not active");
    }

    [TestMethod]
    public void NormalMarketSettle_StillWorksAndKillsThePendingRecovery()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(h.Seller);
        BigInteger listingId = h.CreateListing(accountId);

        // The owner starts an escape, but the honest market settles inside the window:
        // beginning recovery does not bump the control revision, so the sale stands.
        h.Fx.SetSigners(h.Seller);
        h.Fx.CallVoid(h.Wallet, "beginRecovery", accountId, UInt160.Zero);
        Assert.IsTrue(h.RecoveryPending(accountId));

        h.Fx.FundGasFromValidators(h.Buyer, Price * 2);
        h.Fx.SetSigners(h.Buyer);
        h.Fx.TransferGas(h.Buyer, h.Market, Price, listingId);
        h.Fx.CallVoid(h.Market, "settleListing", listingId, h.Buyer, h.Buyer);

        // Sale completed: the buyer owns a clean shell and the seller's pending recovery
        // died with the custody change instead of wedging the buyer's recovery channel.
        Assert.IsFalse(h.EscrowActive(accountId));
        Assert.AreEqual(h.Buyer, h.Custody(accountId));
        Assert.IsFalse(h.RecoveryPending(accountId));

        TestException stale = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "executeRecovery", accountId));
        StringAssert.Contains(stale.Message, "SA_RECOVERY_PENDING");

        h.ExecuteTransferOp(accountId, h.BuyerKey);
    }
}
