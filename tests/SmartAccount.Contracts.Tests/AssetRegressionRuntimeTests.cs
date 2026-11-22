using System;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;
using VmArray = Neo.VM.Types.Array;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Real-NeoVM asset regression suite for protocol v4: standard NEP-17 accounting, malicious
/// NEP-17 tokens (business false, post-move fault, post-move re-entry), both NEP-11 shapes with
/// their payment callbacks, the core's forward-pre / reverse-post hook order, per-account
/// instance isolation, and the transience of the daily-limit balance snapshots.
/// </summary>
/// <remarks>
/// Every vector runs through <c>executeUserOp</c> against the compiled core and the compiled
/// test tokens, so the assertions cover the policy verdict, the token's own accounting and the
/// core's rollback together. Assets live at the account's proxy address (spec §5), which is
/// therefore the transaction sender whenever an operation moves them.
/// </remarks>
[TestClass]
public class AssetRegressionRuntimeTests
{
    private static readonly UInt160 Recipient =
        UInt160.Parse("0x5151515151515151515151515151515151515151");

    private static byte[] TokenId(byte seed) => new byte[] { seed, 0x11, 0x22 };

    private static readonly byte[] DivisibleTokenId = { 9, 8, 7, 6, 5 };

    // ------------------------------------------------------------------------
    // NEP-17: the standard path
    // ------------------------------------------------------------------------

    [TestMethod]
    public void Nep17StandardTransferMovesValueAndNotifiesTheRecipient()
    {
        AssetRuntimeHarness h = new();
        UInt160 token = h.DeployToken("MockNep17Token");
        UInt160 receiver = h.DeployToken("MockNepPaymentReceiver");
        h.CreateAccount("nep17-standard");
        SetupStandardToken(h, token, receiver, (BigInteger)1000);

        Assert.IsTrue(h.Execute(h.BuiltInOp(token, "transfer",
            new object?[] { h.Asset, receiver, (BigInteger)400, null })));

        Assert.AreEqual(new BigInteger(600), h.Fx.CallInteger(token, "balanceOf", h.Asset));
        Assert.AreEqual(new BigInteger(400), h.Fx.CallInteger(token, "balanceOf", receiver));
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(receiver, "calls"),
            "The recipient contract must be told about the payment exactly once");
        Assert.AreEqual("nep17", h.Fx.Call(receiver, "lastKind").GetString());
        Assert.AreEqual(h.Asset, h.Fx.CallUInt160(receiver, "lastFrom"));
        Assert.AreEqual(new BigInteger(400), h.Fx.CallInteger(receiver, "lastAmount"));
        Assert.AreEqual(new BigInteger(1), h.BuiltInSequence,
            "An accepted operation consumes exactly one nonce");
    }

    /// <summary>
    /// A token that moves the value and then answers false has still debited the account, so the
    /// daily meter books the realized outflow even though the operation reports failure. The
    /// very next unit is rejected, which could not happen if the false return had hidden the
    /// 500 already spent.
    /// </summary>
    [TestMethod]
    public void Nep17FalseReturnIsStillMeteredByTheDailyLimit()
    {
        AssetRuntimeHarness h = new();
        UInt160 token = h.DeployToken("MockNep17Token");
        UInt160 hook = h.DeployModule("hooks/DailyLimitHook");
        h.CreateAccount("nep17-false", h.Fx.InstallHook(hook, "setDailyLimit", token, (BigInteger)500, false));
        h.AsTokenAdmin();
        h.Fx.CallVoid(token, "setTrustedCaller", h.Core);
        h.Fx.CallVoid(token, "setMode", (BigInteger)1);
        h.Fx.CallVoid(token, "mint", h.Asset, (BigInteger)1000);

        Assert.IsFalse(h.Execute(h.BuiltInOp(token, "transfer",
                new object?[] { h.Asset, Recipient, (BigInteger)500, null })),
            "The token answers false after moving the value");
        Assert.AreEqual(new BigInteger(500), h.Fx.CallInteger(token, "balanceOf", h.Asset),
            "A business false return does not roll the token's own storage back");
        Assert.AreEqual(new BigInteger(500), h.Fx.CallInteger(token, "balanceOf", Recipient));

        TestException over = Assert.ThrowsExactly<TestException>(() => h.Execute(
            h.BuiltInOp(token, "transfer", new object?[] { h.Asset, Recipient, (BigInteger)1, null })));
        StringAssert.Contains(over.Message, "Daily limit exceeded");
        Assert.AreEqual(new BigInteger(500), h.Fx.CallInteger(token, "balanceOf", h.Asset),
            "The rejected unit must not move");
        Assert.AreEqual(new BigInteger(500), h.Fx.CallInteger(token, "balanceOf", Recipient));
        Assert.IsFalse(h.ExecutionActive);
    }

    /// <summary>
    /// A post-move fault reverts the whole user operation — nonce, token storage and execution
    /// lock included — and the same operation can be retried once the token behaves.
    /// </summary>
    [TestMethod]
    public void Nep17FaultAfterMoveRollsBackEverythingAndCanBeRetried()
    {
        AssetRuntimeHarness h = new();
        UInt160 token = h.DeployToken("MockNep17Token");
        h.CreateAccount("nep17-fault");
        h.AsTokenAdmin();
        h.Fx.CallVoid(token, "setTrustedCaller", h.Core);
        h.Fx.CallVoid(token, "mint", h.Asset, (BigInteger)1000);
        h.Fx.CallVoid(token, "setMode", (BigInteger)2);

        TestException fault = Assert.ThrowsExactly<TestException>(() => h.Execute(
            h.BuiltInOp(token, "transfer", new object?[] { h.Asset, Recipient, (BigInteger)400, null })));
        StringAssert.Contains(fault.ToString(), "Mock NEP-17 transfer failed");
        Assert.AreEqual(new BigInteger(1000), h.Fx.CallInteger(token, "balanceOf", h.Asset),
            "The stored debit must roll back with the fault");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(token, "balanceOf", Recipient));
        Assert.AreEqual(BigInteger.Zero, h.BuiltInSequence, "A faulted operation consumes no nonce");
        Assert.IsFalse(h.ExecutionActive, "A faulted operation releases the execution lock");

        h.AsTokenAdmin();
        h.Fx.CallVoid(token, "setMode", (BigInteger)0);
        Assert.IsTrue(h.Execute(h.BuiltInOp(token, "transfer",
            new object?[] { h.Asset, Recipient, (BigInteger)400, null })));
        Assert.AreEqual(new BigInteger(600), h.Fx.CallInteger(token, "balanceOf", h.Asset));
        Assert.AreEqual(new BigInteger(400), h.Fx.CallInteger(token, "balanceOf", Recipient));
        Assert.AreEqual(BigInteger.One, h.BuiltInSequence);
    }

    /// <summary>
    /// A token that re-enters the account in the middle of its own transfer must be stopped by
    /// the execution lock before any second operation content is read.
    /// </summary>
    [TestMethod]
    public void ReentrantTransferIsRejectedByTheExecutionLock()
    {
        AssetRuntimeHarness h = new();
        UInt160 token = h.DeployToken("MockNep17Token");
        UInt160 receiver = h.DeployToken("MockNepPaymentReceiver");
        h.CreateAccount("nep17-reenter");
        h.AsTokenAdmin();
        h.Fx.CallVoid(token, "setTrustedCaller", h.Core);
        h.Fx.CallVoid(token, "mint", h.Asset, (BigInteger)1000);
        h.Fx.CallVoid(token, "setMode", (BigInteger)3);

        // The re-entry plan: call executeUserOp for this same account while the outer
        // operation still holds the execution lock.
        object[] inner = h.BuiltInOp(receiver, "onNEP17Payment",
            new object?[] { h.Asset, (BigInteger)1, null });
        inner[11] = h.Fx.SignBuiltIn(h.Core, h.AccountId, inner, h.Key);
        object[] plan =
        {
            h.Core, "executeUserOp", new object[] { h.AccountId, inner }
        };

        TestException reentrant = Assert.ThrowsExactly<TestException>(() => h.Execute(
            h.BuiltInOp(token, "transfer", new object?[] { h.Asset, Recipient, (BigInteger)10, plan })));
        StringAssert.Contains(reentrant.ToString(), "SA_REENTRANCY_FORBIDDEN");

        Assert.AreEqual(new BigInteger(1000), h.Fx.CallInteger(token, "balanceOf", h.Asset),
            "The re-entrant operation must roll the outer transfer back");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(receiver, "calls"),
            "The inner operation never reached its target");
        Assert.AreEqual(BigInteger.Zero, h.BuiltInSequence);
        Assert.IsFalse(h.ExecutionActive);
    }

    // ------------------------------------------------------------------------
    // NEP-11: non-divisible and divisible transfers with their payment callbacks
    // ------------------------------------------------------------------------

    [TestMethod]
    public void Nep11TransfersReachThePaymentCallbackWithTheRightShape()
    {
        AssetRuntimeHarness h = new();
        UInt160 nft = h.DeployToken("MockNep11Token");
        UInt160 divisible = h.DeployToken("MockDivisibleNep11Token");
        UInt160 receiver = h.DeployToken("MockNepPaymentReceiver");
        h.CreateAccount("nep11-payments");
        h.AsTokenAdmin();
        h.Fx.CallVoid(nft, "setTrustedCaller", h.Core);
        h.Fx.CallVoid(nft, "setPaymentReceiver", receiver);
        h.Fx.CallVoid(nft, "mint", h.Asset, TokenId(7));
        h.Fx.CallVoid(divisible, "setTrustedCaller", h.Core);
        h.Fx.CallVoid(divisible, "setPaymentReceiver", receiver);
        h.Fx.CallVoid(divisible, "mint", h.Asset, DivisibleTokenId, (BigInteger)100);

        // Non-divisible: transfer(to, tokenId, data) — one whole token moves.
        Assert.IsTrue(h.Execute(h.BuiltInOp(nft, "transfer",
            new object?[] { receiver, TokenId(7), null })));
        Assert.AreEqual(receiver, h.Fx.CallUInt160(nft, "ownerOf", TokenId(7)));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(nft, "balanceOf", h.Asset));
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(receiver, "calls"));
        Assert.AreEqual("nep11", h.Fx.Call(receiver, "lastKind").GetString());
        Assert.AreEqual(h.Asset, h.Fx.CallUInt160(receiver, "lastFrom"));
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(receiver, "lastAmount"));
        CollectionAssert.AreEqual(TokenId(7), h.Fx.CallBytes(receiver, "lastTokenId"));

        // Divisible: transfer(from, to, amount, tokenId, data) — a balance inside one token id.
        Assert.IsTrue(h.Execute(h.BuiltInOp(divisible, "transfer",
            new object?[] { h.Asset, receiver, (BigInteger)40, DivisibleTokenId, null })));
        Assert.AreEqual(new BigInteger(40),
            h.Fx.CallInteger(divisible, "balanceOf", receiver, DivisibleTokenId));
        Assert.AreEqual(new BigInteger(60),
            h.Fx.CallInteger(divisible, "balanceOf", h.Asset, DivisibleTokenId));
        Assert.AreEqual(new BigInteger(2), h.Fx.CallInteger(receiver, "calls"),
            "Each transfer notifies the recipient once");
        Assert.AreEqual("nep11", h.Fx.Call(receiver, "lastKind").GetString());
        Assert.AreEqual(new BigInteger(40), h.Fx.CallInteger(receiver, "lastAmount"));
        CollectionAssert.AreEqual(DivisibleTokenId, h.Fx.CallBytes(receiver, "lastTokenId"));
    }

    // ------------------------------------------------------------------------
    // Core-owned hook order and instance scoping
    // ------------------------------------------------------------------------

    /// <summary>
    /// Two instances of one isolating hook contract run their pre-checks in the core's recorded
    /// order and their post-checks in exactly the reverse order (spec §3.6). The hook records
    /// every callback, so the order is observed rather than assumed.
    /// </summary>
    [TestMethod]
    public void HookCallbacksRunForwardOnPreCheckAndReverseOnPostCheck()
    {
        AssetRuntimeHarness h = new();
        UInt160 hook = h.DeployModule("GasBurningHook");
        h.CreateAccount("hook-order", h.Fx.InstallHook(hook), h.Fx.InstallHook(hook));

        BigInteger[] installed = h.Fx.ModuleIds(h.Core, h.AccountId, RuntimeFixture.ModuleTypeNameHook);
        Assert.AreEqual(2, installed.Length,
            "GasBurningHook declares instanceIsolation, so a second instance is installable");
        CollectionAssert.AreEqual(installed, h.Fx.HookOrderIds(h.Core, h.AccountId),
            "The core-owned order is the install order");

        UInt160 token = h.DeployToken("MockNep17Token");
        SetupStandardToken(h, token, null, (BigInteger)10);
        Assert.IsTrue(h.Execute(h.BuiltInOp(token, "transfer",
            new object?[] { h.Asset, Recipient, (BigInteger)1, null })));

        VmArray log = (VmArray)h.Fx.Call(hook, "getCallbackLog", h.AccountId);
        Assert.AreEqual(4, log.Count, "Two hooks, one pre and one post callback each");
        AssertLogEntry(log, 0, installed[0], 2);
        AssertLogEntry(log, 1, installed[1], 2);
        AssertLogEntry(log, 2, installed[1], 4);
        AssertLogEntry(log, 3, installed[0], 4);
    }

    /// <summary>
    /// Instance state is keyed by <c>(accountId, moduleId)</c> (spec §10): two accounts running
    /// the very same hook contract keep independent meters, and a hook whose profile does not
    /// declare instance isolation cannot be installed twice on one account.
    /// </summary>
    [TestMethod]
    public void HookInstanceStateIsScopedPerAccountAndDuplicatesRequireIsolation()
    {
        AssetRuntimeHarness h = new();
        UInt160 hook = h.DeployModule("hooks/DailyLimitHook");
        UInt160 accountA = h.CreateAccount("iso-a",
            h.Fx.InstallHook(hook, "setDailyLimit", h.Fx.GasHash, (BigInteger)100, false));
        UInt160 accountB = h.CreateSiblingAccount("iso-b",
            h.Fx.InstallHook(hook, "setDailyLimit", h.Fx.GasHash, (BigInteger)10, false));
        Assert.AreNotEqual(BigInteger.Zero, h.HookIdFor(accountA, hook));
        Assert.AreNotEqual(BigInteger.Zero, h.HookIdFor(accountB, hook),
            "The same contract installs normally on a different account");

        h.Fx.FundGasFromValidators(h.AssetOf(accountA), (BigInteger)1000);
        h.Fx.FundGasFromValidators(h.AssetOf(accountB), (BigInteger)1000);

        Assert.IsTrue(h.ExecuteFor(accountA, Spend(h, accountA, 60)), "A's own limit allows 60");
        Assert.IsTrue(h.ExecuteFor(accountB, Spend(h, accountB, 10)), "B's own limit allows exactly 10");

        TestException bOver = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteFor(accountB, Spend(h, accountB, 1)));
        StringAssert.Contains(bOver.Message, "Daily limit exceeded");
        Assert.AreEqual(new BigInteger(990), h.Fx.GasBalanceOf(h.AssetOf(accountB)),
            "B's rejected unit must not move");

        Assert.IsTrue(h.ExecuteFor(accountA, Spend(h, accountA, 40)),
            "B's spending never counts against A");
        TestException aOver = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteFor(accountA, Spend(h, accountA, 1)));
        StringAssert.Contains(aOver.Message, "Daily limit exceeded");
        Assert.AreEqual(new BigInteger(900), h.Fx.GasBalanceOf(h.AssetOf(accountA)));

        // DailyLimitHook declares instanceIsolation = false: a second instance of the same
        // contract on one account is rejected instead of silently sharing a meter.
        TestException duplicate = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.ConfigureAfterTimelock(h.Core, accountA, h.Custody,
                new object[] { h.Fx.InstallHook(hook) }));
        StringAssert.Contains(duplicate.ToString(), "SA_MODULE_INSTANCE_ISOLATION_REQUIRED");
    }

    /// <summary>
    /// The daily-limit balance snapshot lives in instance storage for the duration of one
    /// operation only: it is cleared after metering and rolled back with a rejected operation,
    /// so no stale pre-balance can under-count a later transfer.
    /// </summary>
    [TestMethod]
    public void BalanceSnapshotsAreTransientAcrossEveryOutcome()
    {
        AssetRuntimeHarness h = new();
        UInt160 hook = h.DeployModule("hooks/DailyLimitHook");
        h.CreateAccount("snapshot", h.Fx.InstallHook(hook, "setDailyLimit", h.Fx.GasHash, (BigInteger)50, false));
        BigInteger hookId = h.HookId(hook);
        byte[] gas = h.Fx.GasHash.ToArray();
        Assert.IsFalse(h.HasInstanceStorage(hook, 0x06, hookId, gas),
            "No snapshot exists before any operation runs");

        h.Fx.FundGasFromValidators(h.Asset, (BigInteger)1000);
        Assert.IsTrue(h.Execute(h.BuiltInOp(h.Fx.GasHash, "transfer",
            new object?[] { h.Asset, Recipient, (BigInteger)30, null })));
        Assert.IsFalse(h.HasInstanceStorage(hook, 0x06, hookId, gas),
            "Metering clears the transient snapshot");
        Assert.IsTrue(h.HasInstanceStorage(hook, 0x02, hookId, gas),
            "The spend counter survives the operation");

        TestException over = Assert.ThrowsExactly<TestException>(() => h.Execute(
            h.BuiltInOp(h.Fx.GasHash, "transfer", new object?[] { h.Asset, Recipient, (BigInteger)30, null })));
        StringAssert.Contains(over.Message, "Daily limit exceeded");
        Assert.IsFalse(h.HasInstanceStorage(hook, 0x06, hookId, gas),
            "A rejected operation leaves no snapshot behind");
        Assert.AreEqual(new BigInteger(970), h.Fx.GasBalanceOf(h.Asset),
            "The rejected debit rolled back");
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    private static void SetupStandardToken(AssetRuntimeHarness h, UInt160 token, UInt160 receiver, BigInteger amount)
    {
        h.AsTokenAdmin();
        h.Fx.CallVoid(token, "setTrustedCaller", h.Core);
        if (receiver != null) h.Fx.CallVoid(token, "setPaymentReceiver", receiver);
        h.Fx.CallVoid(token, "mint", h.Asset, amount);
    }

    private static object[] Spend(AssetRuntimeHarness h, UInt160 accountId, long amount) =>
        h.BuiltInOpFor(accountId, h.Fx.GasHash, "transfer",
            new object?[] { h.AssetOf(accountId), Recipient, (BigInteger)amount, null });

    private static void AssertLogEntry(VmArray log, int index, BigInteger moduleId, int phase)
    {
        VmArray entry = (VmArray)log[index];
        Assert.AreEqual(2, entry.Count, "A callback log entry is [moduleId, phase]");
        Assert.AreEqual(moduleId, entry[0].GetInteger());
        Assert.AreEqual((BigInteger)phase, entry[1].GetInteger());
    }
}
