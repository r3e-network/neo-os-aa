using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Limited-gas-budget regression for the callback envelope: a module that overruns the per-call
/// gas cap (hooks 250_000_000 datoshi, validators 100_000_000) must fault closed — no state, no
/// nonce, no meter booking — and the pools must stay independent of each other and of the
/// daily-limit meter.
/// </summary>
/// <remarks>
/// The core bounds every callback softly and fail-closed: it asserts the remaining invocation
/// gas covers the cap before the call and charges the measured GasLeft delta afterwards. The
/// mocks burn a fixed amount strictly above their cap so these vectors exercise the accounting
/// rather than a business rule.
/// </remarks>
[TestClass]
public class GasBudgetRuntimeTests
{
    private static readonly UInt160 Recipient =
        UInt160.Parse("0x5151515151515151515151515151515151515151");

    [TestMethod]
    public void HookPreCheckOverrunIsRejectedBeforeDispatch()
    {
        AssetRuntimeHarness h = new();
        UInt160 token = h.DeployToken("MockNep17Token");
        UInt160 hook = h.DeployModule("GasBurningHook");
        h.CreateAccount("gas-hook-pre", h.Fx.InstallHook(hook, "setBurn", true, false));
        BigInteger hookId = h.HookId(hook);
        Assert.AreNotEqual(BigInteger.Zero, hookId, "The overrunning hook must be installed");
        SetupToken(h, token);

        TestException over = Assert.ThrowsExactly<TestException>(() => h.Execute(
            h.BuiltInOp(token, "transfer", new object?[] { h.Asset, Recipient, (BigInteger)10, null })));
        StringAssert.Contains(over.ToString(), "SA_GAS_BUDGET_EXCEEDED");

        Assert.AreEqual(new BigInteger(1000), h.Fx.CallInteger(token, "balanceOf", h.Asset),
            "A budget fault before dispatch must not move any value");
        Assert.AreEqual(BigInteger.Zero, h.BuiltInSequence, "A budget fault must not consume the nonce");
        Assert.IsFalse(h.ExecutionActive, "A budget fault must release the execution lock");

        // The envelope bounds one callback, it does not break the account: with the burn
        // disabled the very same operation executes normally.
        h.CommitModuleCommand(hookId, "setBurn", false, false);
        Assert.IsTrue(h.Execute(h.BuiltInOp(token, "transfer",
            new object?[] { h.Asset, Recipient, (BigInteger)10, null })));
        Assert.AreEqual(new BigInteger(990), h.Fx.CallInteger(token, "balanceOf", h.Asset));
        Assert.AreEqual(BigInteger.One, h.BuiltInSequence);
    }

    [TestMethod]
    public void HookPostCheckOverrunRollsBackTheDispatchedEffect()
    {
        AssetRuntimeHarness h = new();
        UInt160 token = h.DeployToken("MockNep17Token");
        UInt160 hook = h.DeployModule("GasBurningHook");
        h.CreateAccount("gas-hook-post", h.Fx.InstallHook(hook, "setBurn", false, true));
        Assert.AreNotEqual(BigInteger.Zero, h.HookId(hook));
        SetupToken(h, token);

        TestException over = Assert.ThrowsExactly<TestException>(() => h.Execute(
            h.BuiltInOp(token, "transfer", new object?[] { h.Asset, Recipient, (BigInteger)10, null })));
        StringAssert.Contains(over.ToString(), "SA_GAS_BUDGET_EXCEEDED");

        // The target call had already committed its debit when postCheck overran; the fault has
        // to roll the whole operation back, token storage included.
        Assert.AreEqual(new BigInteger(1000), h.Fx.CallInteger(token, "balanceOf", h.Asset));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(token, "balanceOf", Recipient));
        Assert.AreEqual(BigInteger.Zero, h.BuiltInSequence);
        Assert.IsFalse(h.ExecutionActive);
    }

    /// <summary>
    /// The validation pool is accounted separately from the hook pool: a validator that burns
    /// above <c>ValidationPerCallGasLimit</c> fails closed on its own meter even though no hook
    /// is installed, and disabling the burn makes the routed operation succeed.
    /// </summary>
    [TestMethod]
    public void ValidatorValidationOverrunUsesItsOwnBudgetAndRecovers()
    {
        AssetRuntimeHarness h = new();
        UInt160 token = h.DeployToken("MockNep17Token");
        UInt160 validator = h.DeployModule("GasBurningValidator");
        h.CreateAccount("gas-validator", h.Fx.InstallValidator(validator, "setBurn", true));
        BigInteger moduleId = h.ValidatorId(validator);
        Assert.AreNotEqual(BigInteger.Zero, moduleId, "The overrunning validator must be installed");
        SetupToken(h, token);

        object[] first = RoutedTransfer(h, token, moduleId);
        TestException over = Assert.ThrowsExactly<TestException>(() => h.ExecuteRouted(first, h.Asset));
        StringAssert.Contains(over.ToString(), "SA_GAS_BUDGET_EXCEEDED");
        Assert.AreEqual(new BigInteger(1000), h.Fx.CallInteger(token, "balanceOf", h.Asset));
        Assert.AreEqual(BigInteger.Zero, h.Sequence(moduleId), "A rejected operation consumes no nonce");

        h.CommitModuleCommand(moduleId, "setBurn", false);
        Assert.IsTrue(h.ExecuteRouted(RoutedTransfer(h, token, moduleId), h.Asset),
            "With the burn disabled the routed operation executes");
        Assert.AreEqual(new BigInteger(990), h.Fx.CallInteger(token, "balanceOf", h.Asset));
        Assert.AreEqual(BigInteger.One, h.Sequence(moduleId));
    }

    /// <summary>
    /// A hook combination under a limited budget: the daily limit and the gas envelope are
    /// independent gates, and a budget fault must not be booked by the daily meter. If the
    /// faulted 400 were counted, a following 500 could not still fit exactly under the 500
    /// limit.
    /// </summary>
    /// <remarks>
    /// The burn is armed for one hour only, so it lapses with plain block time. Disarming it
    /// through a configuration intent would advance the clock by 24 h + 1 min and thereby roll
    /// the fixed daily window over, which would make every later assertion vacuous.
    /// </remarks>
    [TestMethod]
    public void BudgetFaultIsNotBookedByTheDailyMeter()
    {
        AssetRuntimeHarness h = new();
        UInt160 token = h.DeployToken("MockNep17Token");
        UInt160 limit = h.DeployModule("hooks/DailyLimitHook");
        UInt160 burner = h.DeployModule("GasBurningHook");
        // preCheck runs in install order, so the daily gate approves the 400 before the
        // second hook overruns its callback budget.
        h.CreateAccount("gas-combined",
            h.Fx.InstallHook(limit, "setDailyLimit", token, (BigInteger)500, false),
            h.Fx.InstallHook(burner, "setBurnUntil", true, false, h.Fx.Now() + 3_600_000));
        Assert.AreNotEqual(BigInteger.Zero, h.HookId(limit), "The daily limit hook must be installed");
        Assert.AreNotEqual(BigInteger.Zero, h.HookId(burner), "The burning hook must be installed");
        SetupToken(h, token);

        TestException budget = Assert.ThrowsExactly<TestException>(() => h.Execute(Transfer(h, token, 400)));
        StringAssert.Contains(budget.ToString(), "SA_GAS_BUDGET_EXCEEDED");
        Assert.AreEqual(new BigInteger(1000), h.Fx.CallInteger(token, "balanceOf", h.Asset),
            "The budget fault must roll the debit back");
        Assert.AreEqual(BigInteger.Zero, h.BuiltInSequence, "A budget fault consumes no nonce");
        Assert.IsFalse(h.ExecutionActive, "A budget fault releases the execution lock");

        // Let the burn window lapse without touching the account configuration: the fixed 24 h
        // meter window is still the one the faulted operation ran in.
        h.Fx.AdvanceTime(TimeSpan.FromHours(2));

        Assert.IsTrue(h.Execute(Transfer(h, token, 500)),
            "The faulted operation must not have been booked against the daily limit");
        Assert.AreEqual(new BigInteger(500), h.Fx.CallInteger(token, "balanceOf", h.Asset),
            "500 is exactly the configured limit");
        Assert.AreEqual(BigInteger.One, h.BuiltInSequence);

        TestException dailyOver = Assert.ThrowsExactly<TestException>(() => h.Execute(Transfer(h, token, 1)));
        StringAssert.Contains(dailyOver.ToString(), "Daily limit exceeded");
        Assert.AreEqual(new BigInteger(500), h.Fx.CallInteger(token, "balanceOf", h.Asset));
    }

    private static void SetupToken(AssetRuntimeHarness h, UInt160 token)
    {
        h.AsTokenAdmin();
        h.Fx.CallVoid(token, "setTrustedCaller", h.Core);
        h.Fx.CallVoid(token, "mint", h.Asset, (BigInteger)1000);
    }

    private static object[] Transfer(AssetRuntimeHarness h, UInt160 token, long amount) =>
        h.BuiltInOp(token, "transfer", new object?[] { h.Asset, Recipient, (BigInteger)amount, null });

    private static object[] RoutedTransfer(AssetRuntimeHarness h, UInt160 token, BigInteger validatorId) =>
        h.RoutedOp(validatorId, token, "transfer",
            new object?[] { h.Asset, Recipient, (BigInteger)10, null });
}
