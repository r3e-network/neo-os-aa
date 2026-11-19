using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Regression for the MEDIUM finding: a SessionKey spending limit is only enforced on the
/// value-moving "transfer" path (see SessionKeyValidator.TransferValue). A wildcard ("*")
/// or non-transfer session key carrying spendingLimit &gt; 0 would advertise a cap that is
/// never enforced, so setSessionKey fails closed and rejects a positive limit unless the
/// method is "transfer".
/// </summary>
/// <remarks>
/// Protocol v4 shape: the grant is per module instance and is configured through the
/// core-dispatched <c>configure</c> command list
/// <c>["setSessionKey", pubKey, target, method, validUntil, spendingLimit, description]</c>
/// (spec §9); the grant record is
/// <c>[pubKey, target, method, validUntil, spendingLimit, generation, grantDigest]</c> and
/// the event appends the <c>moduleId</c> plus an <c>uncapped</c> flag.
/// </remarks>
[TestClass]
public class Fix_SessionKey_Tests
{
    private const int UncappedFlagIndex = 7;

    private const int GrantFieldCount = 7;

    private static readonly BigInteger SpendingLimit = 1000;

    // 24 h: inside the 30-day maximum session lifetime.
    private static readonly BigInteger LifetimeMs = 86_400_000;

    private static PluginModuleHarness NewHarness() => new("validators/SessionKeyValidator");

    private static BigInteger ValidUntil(PluginModuleHarness h) => h.Fx.Now() + LifetimeMs;

    private static void SetSessionKey(PluginModuleHarness h, P256SessionKey key, string method, BigInteger limit)
    {
        h.Configure("setSessionKey", key.CompressedPublicKey, h.Target, method, ValidUntil(h), limit, "fix suite");
    }

    private static Neo.VM.Types.Array SessionKey(PluginModuleHarness h) =>
        (Neo.VM.Types.Array)h.CallDirect("getSessionKey", h.AccountId, h.ModuleId)!;

    [TestMethod]
    public void WildcardSessionKey_WithSpendingLimit_IsRejectedAtConfig()
    {
        PluginModuleHarness h = NewHarness();
        using P256SessionKey key = new();

        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => SetSessionKey(h, key, "*", SpendingLimit));
        StringAssert.Contains(rejected.Message, "Spending limit only enforceable on transfer session keys");
        Assert.AreEqual(0, SessionKey(h).Count, "A rejected grant must leave nothing behind");
    }

    [TestMethod]
    public void NonTransferSessionKey_WithSpendingLimit_IsRejectedAtConfig()
    {
        PluginModuleHarness h = NewHarness();
        using P256SessionKey key = new();

        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => SetSessionKey(h, key, "burn", SpendingLimit));
        StringAssert.Contains(rejected.Message, "Spending limit only enforceable on transfer session keys");
        Assert.AreEqual(0, SessionKey(h).Count);
    }

    [TestMethod]
    public void WildcardSessionKey_WithZeroLimit_IsAllowed()
    {
        PluginModuleHarness h = NewHarness();
        using P256SessionKey key = new();

        // A wildcard key with no spending limit remains a legitimate configuration.
        SetSessionKey(h, key, "*", 0);

        Assert.AreEqual(GrantFieldCount, SessionKey(h).Count,
            "Wildcard session key without a limit must be configurable");
    }

    [TestMethod]
    public void TransferSessionKey_WithSpendingLimit_IsAllowed()
    {
        PluginModuleHarness h = NewHarness();
        using P256SessionKey key = new();

        // The enforceable transfer path keeps accepting a positive limit (no false rejection).
        SetSessionKey(h, key, "transfer", SpendingLimit);

        Assert.AreEqual(GrantFieldCount, SessionKey(h).Count,
            "Transfer session key with a limit must be configurable");
    }

    [TestMethod]
    public void WildcardSessionKey_EmitsGrantEvent_FlaggedUncapped()
    {
        PluginModuleHarness h = NewHarness();
        using P256SessionKey key = new();

        // A wildcard key carries no enforceable cap (any method moves value); the grant event
        // must advertise that so the UI can warn the key is value-uncapped.
        SetSessionKey(h, key, "*", 0);

        Neo.VM.Types.Array state = h.Fx.SingleNotificationState(h.Module, "SessionKeyGranted");
        Assert.AreEqual(h.ModuleId, state[1].GetInteger(), "The grant event is instance-scoped (§9)");
        Assert.IsTrue(state[UncappedFlagIndex].GetBoolean(), "Wildcard session key must be flagged uncapped");
    }

    [TestMethod]
    public void TransferSessionKey_WithSpendingLimit_EmitsGrantEvent_FlaggedCapped()
    {
        PluginModuleHarness h = NewHarness();
        using P256SessionKey key = new();

        SetSessionKey(h, key, "transfer", SpendingLimit);

        Neo.VM.Types.Array state = h.Fx.SingleNotificationState(h.Module, "SessionKeyGranted");
        Assert.IsFalse(state[UncappedFlagIndex].GetBoolean(), "Capped transfer session key must not be flagged uncapped");
        Assert.AreEqual(SpendingLimit, state[6].GetInteger(), "The event reports the enforced cap");
    }

    [TestMethod]
    public void TransferSessionKey_WithoutSpendingLimit_EmitsGrantEvent_FlaggedUncapped()
    {
        PluginModuleHarness h = NewHarness();
        using P256SessionKey key = new();

        // A transfer key with no limit (0 = unlimited) is also value-uncapped and must be flagged.
        SetSessionKey(h, key, "transfer", 0);

        Neo.VM.Types.Array state = h.Fx.SingleNotificationState(h.Module, "SessionKeyGranted");
        Assert.IsTrue(state[UncappedFlagIndex].GetBoolean(), "Zero-limit transfer session key must be flagged uncapped");
    }

    [TestMethod]
    public void DirectSessionKeyConfiguration_IsRejectedEvenForBackupOwner()
    {
        PluginModuleHarness h = NewHarness();
        using P256SessionKey key = new();
        h.Fx.SetSigners(h.AccountId);

        // Audit fix M-1: there is no owner-direct configuration path. setSessionKey /
        // clearSessionKey only ever run as a core-dispatched configuration callback, so a
        // direct call from the owner's own witness is rejected as an unauthorized caller.
        object?[] configData = { "setSessionKey", key.CompressedPublicKey, h.Target, "transfer", ValidUntil(h), SpendingLimit, "direct" };
        TestException configureRejected = Assert.ThrowsExactly<TestException>(
            () => h.CallDirect("configure", h.AccountId, h.ModuleId, h.Generation, configData));
        StringAssert.Contains(configureRejected.Message, "Unauthorized caller");
        Assert.AreEqual(0, SessionKey(h).Count);

        object?[] clearData = { "clearSessionKey" };
        TestException clearRejected = Assert.ThrowsExactly<TestException>(
            () => h.CallDirect("configure", h.AccountId, h.ModuleId, h.Generation, clearData));
        StringAssert.Contains(clearRejected.Message, "Unauthorized caller");
        Assert.AreEqual(0, SessionKey(h).Count);
    }

    [TestMethod]
    public void CoreMediatedConfigureAndClearSessionKey_StillWork()
    {
        PluginModuleHarness h = NewHarness();
        using P256SessionKey key = new();

        SetSessionKey(h, key, "transfer", SpendingLimit);
        Assert.AreEqual(GrantFieldCount, SessionKey(h).Count);

        h.Configure("clearSessionKey");
        Neo.VM.Types.Array revoked = h.Fx.SingleNotificationState(h.Module, "SessionKeyRevoked");
        Assert.AreEqual(h.AccountId,
            (UInt160)Neo.SmartContract.Testing.Extensions.TestExtensions.ConvertTo(revoked[0], typeof(UInt160))!);
        Assert.AreEqual(h.ModuleId, revoked[1].GetInteger());
        Assert.AreEqual(0, SessionKey(h).Count, "A cleared instance holds no grant");
        Assert.AreEqual(0, h.Grant().Length, "A cleared instance publishes no grant digest");
    }

    [TestMethod]
    public void NonOwner_CannotConfigureOrClearSessionKeyDirectly()
    {
        PluginModuleHarness h = NewHarness();
        using P256SessionKey key = new();
        h.Fx.SetSigners(UInt160.Parse("0x3333333333333333333333333333333333333333"));

        object?[] configData = { "setSessionKey", key.CompressedPublicKey, h.Target, "transfer", ValidUntil(h), SpendingLimit, "intruder" };
        TestException configureRejected = Assert.ThrowsExactly<TestException>(
            () => h.CallDirect("configure", h.AccountId, h.ModuleId, h.Generation, configData));
        StringAssert.Contains(configureRejected.Message, "Unauthorized caller");

        object?[] clearData = { "clearSessionKey" };
        TestException clearRejected = Assert.ThrowsExactly<TestException>(
            () => h.CallDirect("configure", h.AccountId, h.ModuleId, h.Generation, clearData));
        StringAssert.Contains(clearRejected.Message, "Unauthorized caller");
        Assert.AreEqual(0, SessionKey(h).Count);
    }

    [TestMethod]
    public void WrongPhaseConfiguration_IsRejected()
    {
        PluginModuleHarness h = NewHarness();
        using P256SessionKey key = new();

        // F-7 phase exactness: a configure call answered while the core records the
        // VALIDATION phase must not be mistaken for a configuration dispatch.
        h.Fx.CallVoid(h.Core, "setAuthorizedModuleId", h.AccountId, (BigInteger)PluginModuleHarness.PhaseValidation, h.ModuleId);
        object?[] configData = { "setSessionKey", key.CompressedPublicKey, h.Target, "transfer", ValidUntil(h), SpendingLimit, "phase" };
        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Core, "forward", h.Module, "configure",
                new object?[] { h.AccountId, h.ModuleId, h.Generation, configData }));
        StringAssert.Contains(rejected.Message, "Unauthorized");
        Assert.AreEqual(0, SessionKey(h).Count);
    }
}
