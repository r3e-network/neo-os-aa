using System;
using System.IO;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Regression coverage for the owner escape from a market escrow whose market cannot take the
/// wallet's <c>abandonListing</c> callback. A NeoVM <c>catch</c> only intercepts a callee
/// <c>THROW</c>; a call into a contract that lacks the method, or into a destroyed contract,
/// faults the whole transaction uncatchably. Before the fix the "best-effort" notification in
/// <c>forceCancelMarketEscrow</c> / <c>cancelMarketEscrow</c> therefore faulted against such a
/// market and the account stayed frozen: no execution, no configuration change and no escape
/// hatch, forever. The wallet now pre-flights the market through
/// <c>ContractManagement.GetContract</c> and only calls <c>abandonListing</c> when the manifest
/// declares it, so the owner reclaims the account regardless.
///
/// <c>MockVerifierCore</c> plays the market here: it can forward an arbitrary call so the wallet
/// observes it as <c>Runtime.CallingScriptHash</c> (the only way to arm an escrow), and it does
/// not implement <c>abandonListing</c>.
/// </summary>
[TestClass]
public class Fix_MarketNotify_Tests
{
    private static readonly UInt160 Owner =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private const uint EscapeTimelockSeconds = 2_592_000;

    // Must exceed the contract's 7-day MarketEscrowOwnerCancelTimelockMs.
    private static readonly TimeSpan OwnerCancelTimelock = TimeSpan.FromDays(7);

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        /// <summary>A contract that can arm an escrow but exposes no <c>abandonListing</c>.</summary>
        public UInt160 SilentMarket { get; }

        public UInt160 Target { get; }

        public Harness()
        {
            Wallet = Fx.Deploy("UnifiedSmartWalletV3");
            SilentMarket = Fx.Deploy("MockVerifierCore");
            Target = Fx.Deploy("MockTransferTarget");
        }

        public UInt160 RegisterAccount()
        {
            UInt160 accountId = Fx.CallUInt160(
                Wallet, "computeRegistrationAccountId",
                UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, Owner, EscapeTimelockSeconds);

            Fx.SetSigners(Owner);
            Fx.CallVoid(
                Wallet, "registerAccount",
                accountId, UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, Owner, EscapeTimelockSeconds);
            return accountId;
        }

        /// <summary>
        /// Arms the escrow exactly as a market's createListing does: the market itself calls
        /// enterMarketEscrow naming itself as the market contract, with the owner's witness.
        /// </summary>
        public void ArmEscrow(UInt160 accountId, BigInteger listingId)
        {
            Fx.SetSigners(Owner);
            Fx.CallVoid(
                SilentMarket, "forward", Wallet, "enterMarketEscrow",
                new object?[] { accountId, SilentMarket, listingId });
            Assert.IsTrue(Fx.CallBoolean(Wallet, "isMarketEscrowActive", accountId), "Precondition: escrow armed");
            Assert.AreEqual(SilentMarket, Fx.CallUInt160(Wallet, "getMarketEscrowContract", accountId));
        }

        public void ExecuteTransferOp(UInt160 accountId, BigInteger nonce)
        {
            Fx.SetSigners(Owner);
            object[] op = RuntimeFixture.UserOp(
                Target, "transfer",
                new object?[] { accountId, Recipient, (BigInteger)1000, null },
                nonce, Fx.Now() + 3_600_000, Array.Empty<byte>());
            Assert.IsTrue(Fx.CallBoolean(Wallet, "executeUserOp", accountId, op));
        }
    }

    [TestMethod]
    public void OwnerForceCancel_SucceedsWhenMarketHasNoAbandonListing()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount();
        h.ArmEscrow(accountId, listingId: 1);

        // The frozen account cannot execute or escape while the escrow is armed.
        h.Fx.SetSigners(Owner);
        Assert.ThrowsExactly<Neo.SmartContract.Testing.Exceptions.TestException>(
            () => h.Fx.CallVoid(h.Wallet, "initiateEscape", accountId),
            "Escrow must block the escape hatch");

        h.Fx.SetSigners(Owner);
        h.Fx.CallVoid(h.Wallet, "initiateMarketEscrowCancel", accountId);
        h.Fx.AdvanceTime(OwnerCancelTimelock);
        h.Fx.SetSigners(Owner);
        h.Fx.CallVoid(h.Wallet, "forceCancelMarketEscrow", accountId);

        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId),
            "The owner must reclaim the account even though the market cannot be notified");
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "hasMarketEscrowOwnerCancel", accountId));
        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Wallet, "getMarketEscrowContract", accountId));
        Assert.AreEqual(Owner, h.Fx.CallUInt160(h.Wallet, "getBackupOwner", accountId),
            "Owner escape must not transfer control");

        // The reclaimed account is fully usable again.
        h.ExecuteTransferOp(accountId, nonce: 0);
        h.Fx.SetSigners(Owner);
        h.Fx.CallVoid(h.Wallet, "initiateEscape", accountId);
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isEscapeActive", accountId));
    }

    [TestMethod]
    public void MarketDrivenCancel_SucceedsWhenMarketHasNoAbandonListing()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount();
        h.ArmEscrow(accountId, listingId: 7);

        // The market clears its own escrow; the wallet's courtesy callback must not fault
        // because the market never implemented it.
        h.Fx.SetSigners(Owner);
        h.Fx.CallVoid(
            h.SilentMarket, "forward", h.Wallet, "cancelMarketEscrow",
            new object?[] { accountId, (BigInteger)7 });

        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));
        h.ExecuteTransferOp(accountId, nonce: 0);
    }

    [TestMethod]
    public void OwnerForceCancel_StillRefusesBeforeTimelockAndWithoutInitiation()
    {
        // The pre-flight must not weaken the escape's own guards.
        Harness h = new();
        UInt160 accountId = h.RegisterAccount();
        h.ArmEscrow(accountId, listingId: 3);

        h.Fx.SetSigners(Owner);
        Neo.SmartContract.Testing.Exceptions.TestException notInitiated =
            Assert.ThrowsExactly<Neo.SmartContract.Testing.Exceptions.TestException>(
                () => h.Fx.CallVoid(h.Wallet, "forceCancelMarketEscrow", accountId));
        StringAssert.Contains(notInitiated.Message, "Owner cancel not initiated");

        h.Fx.CallVoid(h.Wallet, "initiateMarketEscrowCancel", accountId);
        Neo.SmartContract.Testing.Exceptions.TestException early =
            Assert.ThrowsExactly<Neo.SmartContract.Testing.Exceptions.TestException>(
                () => h.Fx.CallVoid(h.Wallet, "forceCancelMarketEscrow", accountId));
        StringAssert.Contains(early.Message, "Owner cancel timelock active");
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isMarketEscrowActive", accountId));
    }

    [TestMethod]
    public void AbandonNotification_IsPreflightedAgainstTheMarketManifest()
    {
        // Source pin: the only NeoVM defence against a missing contract or method is to inspect
        // the manifest before calling, because try/catch cannot intercept those faults.
        string source = File.ReadAllText(Path.Combine(RepoRoot, "contracts", "UnifiedSmartWallet.MarketEscrow.cs"));
        StringAssert.Contains(source, "if (!MarketExposesAbandonListing(market)) return;");
        StringAssert.Contains(source, "ContractManagement.GetContract(market)");
        StringAssert.Contains(source, "methods[i].Parameters.Length == MarketAbandonListingParameterCount");
        StringAssert.Contains(source, "private const string MarketAbandonListingMethod = \"abandonListing\";");
        StringAssert.Contains(source, "private const int MarketAbandonListingParameterCount = 2;");
    }
}
