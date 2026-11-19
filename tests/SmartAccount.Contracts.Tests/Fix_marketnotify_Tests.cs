using System;
using System.IO;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Regression coverage for escaping a market escrow whose market cannot take a wallet callback
/// (destroyed, upgraded away, or simply never implementing the notification). A NeoVM
/// <c>catch</c> only intercepts a callee <c>THROW</c>; a call into a contract that lacks the
/// method faults the whole transaction uncatchably, so v4 removed every external call from the
/// unwind. The owner-side escape is callback-free recovery and the market unwind is initiated by
/// the market itself, which means an unresponsive market can neither block the escape nor be
/// able to fault it.
///
/// <c>MockVerifierCore</c> plays the market here: it can forward an arbitrary call so the wallet
/// observes it as <c>Runtime.CallingScriptHash</c> (the only way to arm or claim an escrow), and
/// it does not implement any market notification.
/// </summary>
[TestClass]
public class Fix_MarketNotify_Tests
{
    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        /// <summary>A contract that can arm an escrow but exposes no market notification.</summary>
        public UInt160 SilentMarket { get; }

        public UInt160 Target { get; }

        public P256SessionKey OwnerKey { get; } = new();

        public UInt160 Owner => RuntimeFixture.CustodyOf(OwnerKey);

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            SilentMarket = Fx.Deploy("MockVerifierCore");
            Target = Fx.Deploy("MockTransferTarget");
            // The core admin registers the forwarding market stand-in as an escrow service.
            Fx.CallVoid(Wallet, "setMarketService", SilentMarket, true);
        }

        public UInt160 RegisterAccount()
        {
            Fx.SetSigners(Owner);
            return Fx.CreateAccount(
                Wallet, Owner, RuntimeFixture.Salt("market-notify"), RuntimeFixture.MinRecoveryTimelockMs);
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

        /// <summary>The market's own claim — the only thing that can clean the physical markers.</summary>
        public void ClaimCancellation(UInt160 accountId, BigInteger listingId)
        {
            Fx.SetSigners(Owner);
            Fx.CallVoid(
                SilentMarket, "forward", Wallet, "cancelMarketEscrow",
                new object?[] { accountId, listingId });
        }

        public void ExecuteTransferOp(UInt160 accountId)
        {
            var record = (Neo.VM.Types.Array)Fx.Call(Wallet, "getAccount", accountId);
            object[] op = RuntimeFixture.UserOp(
                Target, "transfer",
                new object?[] { accountId, Recipient, (BigInteger)1000, null },
                Fx.PackedNonce(Wallet, accountId, 0), Fx.Now() + 3_600_000, new byte[] { 0x00 },
                authorityEpoch: record[4].GetInteger(),
                configurationNonce: record[5].GetInteger());
            op[11] = Fx.SignBuiltIn(Wallet, accountId, op, OwnerKey);
            Fx.SetSigners(Owner);
            Assert.IsTrue(Fx.CallBoolean(Wallet, "executeUserOp", accountId, op));
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
    public void OwnerRecovery_EscapesUnresponsiveMarketAndKeepsControl()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount();
        h.ArmEscrow(accountId, listingId: 1);

        // The escape is reachable while the escrow is armed and never talks to the market:
        // there is no callback that a silent market could fault.
        h.Fx.SetSigners(h.Owner);
        h.Fx.CallVoid(h.Wallet, "beginRecovery", accountId, UInt160.Zero);

        // Before the timelock elapses the recovery cannot be executed.
        TestException early = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "executeRecovery", accountId));
        StringAssert.Contains(early.Message, "SA_RECOVERY_LOCKED");
        Assert.IsTrue(h.EscrowActive(accountId));

        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds((long)RuntimeFixture.MinRecoveryTimelockMs) + TimeSpan.FromSeconds(1));
        h.Fx.CallVoid(h.Wallet, "executeRecovery", accountId);
        Assert.AreEqual(h.Owner, h.Custody(accountId), "Owner escape must not transfer control");

        // The market's own claim cleans the physical markers (a cleanup-only claim under the
        // stale epoch), after which the reclaimed account is fully usable again.
        h.ClaimCancellation(accountId, listingId: 1);
        Assert.IsFalse(h.EscrowActive(accountId),
            "The owner must reclaim the account even though the market cannot be notified");
        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Wallet, "getMarketEscrowContract", accountId));
        h.ExecuteTransferOp(accountId);
    }

    [TestMethod]
    public void MarketDrivenCancel_CleansUpWithoutAnyWalletCallback()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount();
        h.ArmEscrow(accountId, listingId: 7);

        // The market clears its own escrow; no wallet-side notification is involved, so a
        // market that never implemented one cannot fault the unwind.
        h.ClaimCancellation(accountId, listingId: 7);

        Assert.IsFalse(h.EscrowActive(accountId));
        h.ExecuteTransferOp(accountId);
    }

    [TestMethod]
    public void Recovery_RefusesBeforeMaturityAndWithoutInitiation()
    {
        // The escape's own guards must stay intact.
        Harness h = new();
        UInt160 accountId = h.RegisterAccount();
        h.ArmEscrow(accountId, listingId: 3);

        h.Fx.SetSigners(h.Owner);
        TestException notInitiated = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "executeRecovery", accountId));
        StringAssert.Contains(notInitiated.Message, "SA_RECOVERY_PENDING");

        h.Fx.CallVoid(h.Wallet, "beginRecovery", accountId, UInt160.Zero);
        TestException early = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "executeRecovery", accountId));
        StringAssert.Contains(early.Message, "SA_RECOVERY_LOCKED");
        Assert.IsTrue(h.EscrowActive(accountId));
    }

    [TestMethod]
    public void RecoveryAndMarketUnwind_AreCallbackFree()
    {
        // Source pin: the only defence against a missing contract or method is to never call
        // out during the unwind at all (try/catch cannot intercept those faults). Both the
        // owner escape (0x59 recovery) and the market unwind are callback-free by construction.
        string escape = File.ReadAllText(Path.Combine(RepoRoot, "contracts", "custom", "SmartAccount.Escape.cs"));
        StringAssert.Contains(escape, "SweepAccountModulesAndPolicies(accountId);");
        StringAssert.Contains(escape, "OnMarketLockInvalidated(accountId, marketBinding!.ControlEpoch);");
        Assert.IsFalse(escape.Contains("Contract.Call("), "The owner escape must make no external call");
        Assert.IsFalse(escape.Contains("abandonListing"), "The owner escape must not notify the market");

        string marketEscrow = File.ReadAllText(Path.Combine(RepoRoot, "contracts", "custom", "SmartAccount.MarketEscrow.cs"));
        StringAssert.Contains(marketEscrow, "SweepAccountModulesAndPolicies(accountId);");
        Assert.IsFalse(marketEscrow.Contains("Contract.Call("), "The market unwind must make no external call");
        Assert.IsFalse(marketEscrow.Contains("abandonListing"), "The market unwind must not notify the market");
    }
}
