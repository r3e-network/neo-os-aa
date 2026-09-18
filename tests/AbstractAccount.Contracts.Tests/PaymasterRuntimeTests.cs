using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Behavioral VM tests for <c>AAPaymaster</c>: GAS deposits, withdrawal limits, and settlement
/// policy enforcement (per-op cap, daily window, total budget, deposit backing, core-only
/// caller) with real GAS balance assertions. The paymaster is bound to the MockVerifierCore
/// stub so settlements can be driven through the authorized-core call path.
/// </summary>
[TestClass]
public class PaymasterRuntimeTests
{
    private static readonly UInt160 Sponsor =
        UInt160.Parse("0x7777777777777777777777777777777777777777");

    private static readonly UInt160 Relay =
        UInt160.Parse("0x8888888888888888888888888888888888888888");

    private static readonly UInt160 AccountId =
        UInt160.Parse("0x1111111111111111111111111111111111111111");

    private static readonly UInt160 TargetContract =
        UInt160.Parse("0x3333333333333333333333333333333333333333");

    private const long OneGas = 100_000_000;

    private sealed class PaymasterHarness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Core { get; }

        public UInt160 Paymaster { get; }

        public PaymasterHarness(BigInteger depositAmount)
        {
            Core = Fx.Deploy("MockVerifierCore");
            Paymaster = Fx.Deploy("AAPaymaster", Core.ToArray());

            Fx.FundGasFromValidators(Sponsor, depositAmount * 2);
            Fx.SetSigners(Sponsor);
            Fx.TransferGas(Sponsor, Paymaster, depositAmount, null);
        }

        public void SetPolicy(BigInteger maxPerOp, BigInteger dailyBudget, BigInteger totalBudget)
        {
            Fx.SetSigners(Sponsor);
            Fx.CallVoid(Paymaster, "setPolicy",
                AccountId, UInt160.Zero, "", maxPerOp, dailyBudget, totalBudget, BigInteger.Zero);
        }

        /// <summary>Settles through the mock core so the paymaster observes the authorized core as caller.</summary>
        public void SettleViaCore(BigInteger amount)
        {
            Fx.CallVoid(Core, "forward", Paymaster, "settleReimbursement",
                new object?[] { Sponsor, AccountId, TargetContract, "transfer", Relay, amount });
        }

        public BigInteger Deposit() => Fx.CallInteger(Paymaster, "getSponsorDeposit", Sponsor);
    }

    [TestMethod]
    public void Paymaster_Deposit_CreditsSponsorWithTransferredGas()
    {
        PaymasterHarness h = new(depositAmount: 5 * OneGas);

        Assert.AreEqual(5 * OneGas, h.Deposit());
        Assert.AreEqual(5 * OneGas, h.Fx.GasBalanceOf(h.Paymaster), "Contract holds the deposited GAS");
    }

    [TestMethod]
    public void Paymaster_Withdraw_ReturnsGasAndEnforcesBalance()
    {
        PaymasterHarness h = new(depositAmount: 5 * OneGas);
        BigInteger sponsorBefore = h.Fx.GasBalanceOf(Sponsor);

        h.Fx.SetSigners(Sponsor);
        h.Fx.CallVoid(h.Paymaster, "withdrawDeposit", (BigInteger)(2 * OneGas));

        Assert.AreEqual(3 * OneGas, h.Deposit());
        Assert.AreEqual(sponsorBefore + 2 * OneGas, h.Fx.GasBalanceOf(Sponsor));

        TestException overdraw = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Paymaster, "withdrawDeposit", (BigInteger)(4 * OneGas)));
        StringAssert.Contains(overdraw.Message, "Insufficient deposit");
        Assert.AreEqual(3 * OneGas, h.Deposit(), "Failed withdrawal must not change the deposit");
    }

    [TestMethod]
    [DataRow(1L)]
    [DataRow(100_000_000L)]
    [DataRow(500_000_000L)]
    public void Paymaster_DepositWithdraw_RoundTripPreservesBalancesAndOtherSponsor(long rawAmount)
    {
        BigInteger amount = rawAmount;
        PaymasterHarness h = new(depositAmount: 3 * OneGas);
        // Relay is a second sponsor for this test, not a reimbursement recipient.
        h.Fx.FundGasFromValidators(Relay, amount * 2);
        h.Fx.SetSigners(Relay);
        BigInteger walletBefore = h.Fx.GasBalanceOf(Relay);
        BigInteger contractBefore = h.Fx.GasBalanceOf(h.Paymaster);
        BigInteger firstSponsorBefore = h.Deposit();
        BigInteger firstWalletBefore = h.Fx.GasBalanceOf(Sponsor);
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Paymaster, "getSponsorDeposit", Relay));

        h.Fx.TransferGas(Relay, h.Paymaster, amount, null);
        Assert.AreEqual(amount, h.Fx.CallInteger(h.Paymaster, "getSponsorDeposit", Relay));
        Assert.AreEqual(walletBefore - amount, h.Fx.GasBalanceOf(Relay));
        Assert.AreEqual(contractBefore + amount, h.Fx.GasBalanceOf(h.Paymaster));
        Assert.AreEqual(firstSponsorBefore, h.Deposit());

        h.Fx.CallVoid(h.Paymaster, "withdrawDeposit", amount);
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Paymaster, "getSponsorDeposit", Relay));
        Assert.AreEqual(walletBefore, h.Fx.GasBalanceOf(Relay), "Round trip restores the second sponsor's GAS");
        Assert.AreEqual(contractBefore, h.Fx.GasBalanceOf(h.Paymaster), "Other sponsor's backing is retained");
        Assert.AreEqual(firstSponsorBefore, h.Deposit());
        Assert.AreEqual(firstWalletBefore, h.Fx.GasBalanceOf(Sponsor));

        TestException empty = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Paymaster, "withdrawDeposit", BigInteger.One));
        StringAssert.Contains(empty.Message, "Insufficient deposit");
        Assert.AreEqual(walletBefore, h.Fx.GasBalanceOf(Relay));
        Assert.AreEqual(contractBefore, h.Fx.GasBalanceOf(h.Paymaster));
        Assert.AreEqual(firstSponsorBefore, h.Deposit());
    }

    [TestMethod]
    public void Paymaster_Settlement_ReimbursesRelayWithinBudgets()
    {
        PaymasterHarness h = new(depositAmount: 5 * OneGas);
        h.SetPolicy(maxPerOp: OneGas, dailyBudget: 3 * OneGas / 2, totalBudget: 2 * OneGas);

        BigInteger relayBefore = h.Fx.GasBalanceOf(Relay);
        h.SettleViaCore(OneGas);

        Assert.AreEqual(relayBefore + OneGas, h.Fx.GasBalanceOf(Relay), "Relay receives the reimbursement");
        Assert.AreEqual(4 * OneGas, h.Deposit(), "Reimbursement is deducted from the sponsor deposit");
        Assert.AreEqual((BigInteger)OneGas, h.Fx.CallInteger(h.Paymaster, "getDailySpent", Sponsor, AccountId));
        Assert.AreEqual((BigInteger)OneGas, h.Fx.CallInteger(h.Paymaster, "getTotalSpent", Sponsor, AccountId));
    }

    [TestMethod]
    public void Paymaster_Settlement_EnforcesPerOperationLimit()
    {
        PaymasterHarness h = new(depositAmount: 5 * OneGas);
        h.SetPolicy(maxPerOp: OneGas, dailyBudget: 0, totalBudget: 0);

        TestException overCap = Assert.ThrowsExactly<TestException>(
            () => h.SettleViaCore(OneGas + 1));
        StringAssert.Contains(overCap.Message, "Exceeds per-operation limit");
        Assert.AreEqual(5 * OneGas, h.Deposit(), "Rejected settlement must not touch the deposit");
    }

    [TestMethod]
    public void Paymaster_Settlement_EnforcesDailyBudgetUntilWindowResets()
    {
        PaymasterHarness h = new(depositAmount: 5 * OneGas);
        h.SetPolicy(maxPerOp: OneGas, dailyBudget: 3 * OneGas / 2, totalBudget: 0);

        h.SettleViaCore(OneGas);

        TestException overDaily = Assert.ThrowsExactly<TestException>(
            () => h.SettleViaCore(OneGas));
        StringAssert.Contains(overDaily.Message, "Daily budget exceeded");
        Assert.AreEqual(4 * OneGas, h.Deposit(), "Rejected settlement must not touch the deposit");

        // A new 24h window admits fresh spending up to the daily budget.
        h.Fx.AdvanceTime(TimeSpan.FromHours(25));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Paymaster, "getDailySpent", Sponsor, AccountId));
        h.SettleViaCore(OneGas);
        Assert.AreEqual(3 * OneGas, h.Deposit());
    }

    [TestMethod]
    public void Paymaster_Settlement_EnforcesTotalBudgetAcrossWindows()
    {
        PaymasterHarness h = new(depositAmount: 5 * OneGas);
        h.SetPolicy(maxPerOp: OneGas, dailyBudget: 0, totalBudget: 2 * OneGas);

        h.SettleViaCore(OneGas);
        h.Fx.AdvanceTime(TimeSpan.FromHours(25));
        h.SettleViaCore(OneGas);
        h.Fx.AdvanceTime(TimeSpan.FromHours(25));

        TestException overTotal = Assert.ThrowsExactly<TestException>(
            () => h.SettleViaCore(OneGas / 2));
        StringAssert.Contains(overTotal.Message, "Total budget exceeded");
        Assert.AreEqual(2 * OneGas, h.Fx.CallInteger(h.Paymaster, "getTotalSpent", Sponsor, AccountId));
    }

    [TestMethod]
    public void Paymaster_Settlement_RequiresSponsorDepositBacking()
    {
        PaymasterHarness h = new(depositAmount: OneGas / 2);
        h.SetPolicy(maxPerOp: OneGas, dailyBudget: 0, totalBudget: 0);

        TestException unbacked = Assert.ThrowsExactly<TestException>(
            () => h.SettleViaCore(OneGas));
        StringAssert.Contains(unbacked.Message, "Insufficient sponsor deposit");
    }

    [TestMethod]
    public void Paymaster_Settlement_RejectsCallersOtherThanAuthorizedCore()
    {
        PaymasterHarness h = new(depositAmount: 5 * OneGas);
        h.SetPolicy(maxPerOp: OneGas, dailyBudget: 0, totalBudget: 0);

        // Direct invocation: the paymaster sees the entry script, not the authorized core.
        TestException unauthorized = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Paymaster, "settleReimbursement",
                Sponsor, AccountId, TargetContract, "transfer", Relay, (BigInteger)OneGas));
        StringAssert.Contains(unauthorized.Message, "Unauthorized caller");
    }

    [TestMethod]
    public void Paymaster_Settlement_RequiresAPolicy()
    {
        PaymasterHarness h = new(depositAmount: 5 * OneGas);

        TestException missing = Assert.ThrowsExactly<TestException>(
            () => h.SettleViaCore(OneGas));
        StringAssert.Contains(missing.Message, "No sponsorship policy");
    }
}
