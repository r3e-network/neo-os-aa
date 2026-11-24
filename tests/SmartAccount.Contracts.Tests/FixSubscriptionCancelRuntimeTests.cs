using System;
using System.Numerics;
using System.Security.Cryptography;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.SmartContract.Testing.Exceptions;
using StackItem = Neo.VM.Types.StackItem;
using VmArray = Neo.VM.Types.Array;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Regression for audit finding #9 (Mark): cancelling a subscription deleted the
/// <c>LastChargedPeriod</c> record together with the subscription itself. The owner could
/// therefore cancel and re-create the very same <c>subId</c> with an identical period
/// definition while the already-billed period was still running, and the merchant could
/// collect a second time inside that one period — a direct violation of the
/// "at most one charge per billing period" rule.
/// </summary>
/// <remarks>
/// The fix keeps the last-charged period as a tombstone on cancel, so the anti-double-charge
/// record outlives the subscription record it belonged to. Both vectors below drive the real
/// validator: the first over the module ABI (<see cref="PluginModuleHarness"/>), the second
/// through the full core pipeline, including the two 24 h configuration intents the
/// cancel/re-create needs. The second vector deliberately aligns the clock to the start of a
/// billing period so the whole cancel → re-create sequence provably happens inside the single
/// period that was already booked.
/// </remarks>
[TestClass]
public class FixSubscriptionCancelRuntimeTests
{
    private const long Amount = 1000;

    /// <summary>A 30-day billing period: long enough that two 24 h timelocks cannot end it.</summary>
    private const long PeriodSeconds = 30L * 24 * 60 * 60;

    private static readonly BigInteger PeriodMs = (BigInteger)PeriodSeconds * 1000;

    private static readonly UInt160 Merchant =
        UInt160.Parse("0x2222222222222222222222222222222222222222");

    private static readonly byte[] SubId = { 0x19, 0x0A, 0x02 };

    /// <summary>The channel a subscription pull uses: SHA-256 of the subId (spec §6).</summary>
    private static byte[] ChannelKey(byte[] subId) => SHA256.HashData(subId);

    [TestMethod]
    [DataRow(60, 10, false)]
    [DataRow(10, 60, true)]
    [DataRow(13, 19, false)]
    [DataRow(19, 13, true)]
    [DataRow(13, 13, false)]
    public void NewScheduleWaitsForBothBookedWindows(int original, int replacement, bool cancel)
    {
        PluginModuleHarness h = new("validators/SubscriptionValidator", instanceIsolation: false);
        byte[] id = new byte[255];
        void SetPeriod(int seconds) =>
            h.Configure("createSubscription", id, Merchant, h.Target, (BigInteger)Amount, (BigInteger)seconds);
        SetPeriod(original);
        h.Fx.SetSigners(Merchant);
        BigInteger now = h.Fx.Now();
        // Book within a minute; include schedules whose windows do not divide one another.
        BigInteger minute = (now / 60000 + 1) * 60000;
        void AdvanceTo(BigInteger ms) => h.Fx.AdvanceTime(TimeSpan.FromMilliseconds((long)(ms - h.Fx.Now())));
        AdvanceTo(minute + 5000);
        object[] op = h.TransferOp(h.Target, Amount, Merchant, id);
        bool Due() => h.Validate(PluginModuleHarness.Digest(h.Fx, op), op);
        Assert.IsTrue(Due());
        h.Complete(op, true);
        if (cancel) h.Configure("cancelSubscription", id);
        SetPeriod(replacement);
        var fields = (VmArray)h.CallDirect("getSubscription", h.AccountId, h.ModuleId, id)!;
        Assert.AreEqual((minute / 1000 + 5) / original, fields[5].GetInteger());
        BigInteger booked = minute / 1000 + 5;
        BigInteger firstEligibleMs = BigInteger.Max(
            (booked / original + 1) * original,
            (booked / replacement + 1) * replacement) * 1000;
        AdvanceTo(firstEligibleMs - 1);
        Assert.IsFalse(Due());
        AdvanceTo(firstEligibleMs);
        Assert.IsTrue(Due());
        h.Complete(op, true);
        Assert.IsFalse(Due());
    }

    [TestMethod]
    public void SubscriptionIdsUseTheirFullBytes()
    {
        PluginModuleHarness h = new("validators/SubscriptionValidator", instanceIsolation: false);
        byte[] first = new byte[255], second = new byte[255];
        second[254] = 1;
        void Add(byte[] id, int cap) =>
            h.Configure("createSubscription", id, Merchant, h.Target, (BigInteger)cap, (BigInteger)60);
        BigInteger Cap(byte[] id) =>
            ((VmArray)h.CallDirect("getSubscription", h.AccountId, h.ModuleId, id)!)[2].GetInteger();
        Add(first, 1);
        Add(second, 2);
        Assert.AreEqual(BigInteger.One, Cap(first));
        Assert.AreEqual(new BigInteger(2), Cap(second));
        Add(new byte[1], 3);
        Assert.AreEqual(new BigInteger(3), Cap(new byte[1]));
        Assert.ThrowsExactly<TestException>(() => Add(new byte[256], 4));
        Assert.ThrowsExactly<TestException>(() => Add(new byte[0], 4));
        Assert.AreEqual(BigInteger.One, Cap(first));
    }

    [TestMethod]
    public void SubscriptionConfigurationRequiresIntegerFields()
    {
        PluginModuleHarness h = new("validators/SubscriptionValidator", instanceIsolation: false);
        void Configure(object cap, object period) =>
            h.Configure("createSubscription", SubId, Merchant, h.Target, cap, period);
        Configure((BigInteger)9, (BigInteger)60);
        Assert.ThrowsExactly<TestException>(() => Configure(true, (BigInteger)60));
        Assert.ThrowsExactly<TestException>(() => Configure((BigInteger)9, new byte[] { 60 }));
        var fields = (VmArray)h.CallDirect("getSubscription", h.AccountId, h.ModuleId, SubId)!;
        Assert.AreEqual(new BigInteger(9), fields[2].GetInteger());
        Assert.AreEqual(new BigInteger(60), fields[3].GetInteger());
    }

    // ------------------------------------------------------------------------
    // Module ABI: the cancel branch is what removes the record, so the tombstone
    // has to be observable at the module boundary as well.
    // ------------------------------------------------------------------------

    [TestMethod]
    public void RenewedSubscriptionUsesCurrentDescriptorGeneration()
    {
        PluginModuleHarness h = new("validators/SubscriptionValidator", instanceIsolation: false);
        h.SetGeneration(3);
        h.Configure("createSubscription", SubId, Merchant, h.Target, (BigInteger)Amount, (BigInteger)PeriodSeconds);
        var fields = (VmArray)h.CallDirect("getSubscription", h.AccountId, h.ModuleId, SubId)!;
        Assert.AreEqual(h.Generation, fields[4].GetInteger());
    }

    [TestMethod]
    public void CancelKeepsTheLastChargedPeriodTombstone()
    {
        PluginModuleHarness h = new("validators/SubscriptionValidator", instanceIsolation: false);
        h.Install("createSubscription", SubId, Merchant, h.Target, (BigInteger)Amount,
            (BigInteger)PeriodSeconds);
        // The merchant is the puller, so its witness rides on the validate call:
        // validateUserOp requires Runtime.CheckWitness(merchant) (audit fix M-8).
        h.Fx.SetSigners(Merchant);
        Assert.AreEqual(6, SubscriptionFields(h),
            "An installed subscription exposes its definition and its last charged period");

        object[] first = h.TransferOp(h.Target, Amount, Merchant, SubId);
        Assert.IsTrue(h.Validate(PluginModuleHarness.Digest(h.Fx, first), first),
            "The first pull of a never-billed period must be authorized");
        h.Complete(first, true);
        BigInteger booked = LastCharged(h);
        Assert.IsTrue(booked > BigInteger.Zero, "Completion books the billing period");

        // Cancel: the definition goes away, the anti-double-charge tombstone does not.
        h.Configure("cancelSubscription", SubId);
        Assert.AreEqual(0, SubscriptionFields(h), "Cancelling removes the subscription record");
        Assert.AreEqual(booked, LastCharged(h),
            "Mark finding #9: the last charged period must survive the cancellation");

        // Re-create an identical subscription: same subId, same merchant, same amount, same
        // period. Without the tombstone this reset the billing gate and unlocked a second pull.
        h.Configure("createSubscription", SubId, Merchant, h.Target, (BigInteger)Amount,
            (BigInteger)PeriodSeconds);
        Assert.AreEqual(6, SubscriptionFields(h), "The re-created subscription is visible again");
        Assert.AreEqual(booked, SubscriptionPeriod(h),
            "The re-created subscription inherits the period already booked");

        object[] second = h.TransferOp(h.Target, Amount, Merchant, SubId, 1);
        Assert.IsFalse(h.Validate(PluginModuleHarness.Digest(h.Fx, second), second),
            "A second pull inside the already-booked period must be rejected");

        // The next period is a fresh billing opportunity.
        h.Fx.AdvanceTime(TimeSpan.FromSeconds(PeriodSeconds + 60));
        object[] third = h.TransferOp(h.Target, Amount, Merchant, SubId, 2);
        Assert.IsTrue(h.Validate(PluginModuleHarness.Digest(h.Fx, third), third),
            "The billing gate opens again in the next period");
        h.Complete(third, true);
        Assert.IsTrue(LastCharged(h) > booked, "Completion books the later period");
    }

    private static int SubscriptionFields(PluginModuleHarness h) =>
        ((VmArray)h.CallDirect("getSubscription", h.AccountId, h.ModuleId, SubId)!).Count;

    private static BigInteger SubscriptionPeriod(PluginModuleHarness h) =>
        ((VmArray)h.CallDirect("getSubscription", h.AccountId, h.ModuleId, SubId)!)[5].GetInteger();

    private static BigInteger LastCharged(PluginModuleHarness h) =>
        ((StackItem)h.CallDirect("getLastChargedPeriod", h.AccountId, h.ModuleId, SubId)!).GetInteger();

    // ------------------------------------------------------------------------
    // Real core: cancel and re-create both need a 24 h configuration intent, so
    // the vector starts at the opening hour of a billing period and proves from
    // the clock that both intents still mature inside the booked period.
    // ------------------------------------------------------------------------

    [TestMethod]
    public void CancelAndRecreateInTheSamePeriodCannotChargeTwice()
    {
        AssetRuntimeHarness h = new();
        UInt160 token = h.DeployToken("MockNep17Token");
        UInt160 validator = h.DeployModule("validators/SubscriptionValidator");
        h.CreateAccount("sub-cancel", new object[]
        {
            h.Fx.InstallValidator(validator, "createSubscription", SubId, Merchant, token,
                (BigInteger)Amount, (BigInteger)PeriodSeconds)
        });
        BigInteger moduleId = h.ValidatorId(validator);
        Assert.AreNotEqual(BigInteger.Zero, moduleId, "The subscription validator must be installed");

        h.AsTokenAdmin();
        h.Fx.CallVoid(token, "setTrustedCaller", h.Core);
        h.Fx.CallVoid(token, "mint", h.Asset, (BigInteger)5000);

        // Start one hour into a billing period so the two 24 h intents of the cancel and the
        // re-create both mature while the period that will be booked is still current.
        AlignToPeriodStart(h);

        byte[] channel = ChannelKey(SubId);
        Assert.IsTrue(Charge(h, token, moduleId, channel), "The first pull must be accepted");
        BigInteger booked = h.Fx.CallInteger(validator, "getLastChargedPeriod", h.AccountId, moduleId, SubId);
        Assert.IsTrue(booked > BigInteger.Zero, "Completion books the billing period");
        Assert.AreEqual(new BigInteger(1), h.Sequence(moduleId, channel),
            "The pull consumes the channel sequence exactly once");
        Assert.AreEqual(new BigInteger(5000 - Amount), h.Fx.CallInteger(token, "balanceOf", h.Asset));

        // Owner cancels — one 24 h intent.
        h.CommitModuleCommand(moduleId, "cancelSubscription", SubId);
        Assert.AreEqual(0, ((VmArray)h.Fx.Call(validator, "getSubscription", h.AccountId, moduleId, SubId)).Count,
            "Cancelling removes the subscription record");
        Assert.AreEqual(booked,
            h.Fx.CallInteger(validator, "getLastChargedPeriod", h.AccountId, moduleId, SubId),
            "Mark finding #9: the tombstone must survive the cancellation");

        // Owner re-creates the identical subscription — a second 24 h intent.
        h.CommitModuleCommand(moduleId, "createSubscription", SubId, Merchant, token,
            (BigInteger)Amount, (BigInteger)PeriodSeconds);
        VmArray recreated = (VmArray)h.Fx.Call(validator, "getSubscription", h.AccountId, moduleId, SubId);
        Assert.AreEqual(6, recreated.Count, "The re-created subscription is visible again");
        Assert.AreEqual(booked, recreated[5].GetInteger(),
            "The re-created subscription reports the period already booked");

        // Precondition of the vector: the whole cancel/re-create still sits in that period.
        BigInteger currentPeriod = h.Fx.Now() / PeriodMs;
        Assert.AreEqual(booked, currentPeriod,
            "The two timelocks must not leave the period whose charge is being defended");

        // The merchant tries to pull again inside the same period.
        TestException second = Assert.ThrowsExactly<TestException>(() => Charge(h, token, moduleId, channel));
        StringAssert.Contains(second.Message, "SA_VALIDATION_REJECTED");
        Assert.AreEqual(new BigInteger(1), h.Sequence(moduleId, channel),
            "A rejected pull must not consume the channel");
        Assert.AreEqual(new BigInteger(5000 - Amount), h.Fx.CallInteger(token, "balanceOf", h.Asset),
            "A rejected pull must not move any value");
        Assert.IsFalse(h.ExecutionActive, "The execution lock must be released");

        // The next period accepts exactly one pull.
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds((double)PeriodMs));
        Assert.IsTrue(Charge(h, token, moduleId, channel), "The next period opens a fresh pull");
        Assert.AreEqual(new BigInteger(2), h.Sequence(moduleId, channel));
        Assert.IsTrue(
            h.Fx.CallInteger(validator, "getLastChargedPeriod", h.AccountId, moduleId, SubId) > booked,
            "Completion books the later period");
        Assert.AreEqual(new BigInteger(5000 - (2 * Amount)),
            h.Fx.CallInteger(token, "balanceOf", h.Asset),
            "Exactly one charge per period reached the token");
    }

    /// <summary>One merchant pull routed through the subscription validator.</summary>
    private static bool Charge(AssetRuntimeHarness h, UInt160 token, BigInteger moduleId, byte[] channel)
    {
        object[] op = h.RoutedOp(moduleId, token, "transfer",
            new object?[] { h.Asset, Merchant, (BigInteger)Amount, null }, channel);
        // The signature field carries the subscription id, never a cryptographic proof (M-8).
        op[11] = SubId;
        h.Fx.SetSigners(Merchant);
        return h.Fx.CallBoolean(h.Core, "executeUserOp", h.AccountId, op);
    }

    private static void AlignToPeriodStart(AssetRuntimeHarness h)
    {
        BigInteger now = h.Fx.Now();
        BigInteger untilBoundary = PeriodMs - (now % PeriodMs);
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds((double)(untilBoundary + 3_600_000)));
    }
}
