using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Behavioural VM tests for <c>SubscriptionValidator</c> on the protocol-v4 module ABI.
/// Every vector runs the compiled plugin through the <c>MockVerifierCore</c> writer
/// phases the real core dispatches, so the billing-period throttle, the merchant
/// witness requirement and the NEP-17 argument shape are validated by actual VM
/// behaviour rather than by reading the source.
/// </summary>
[TestClass]
public class SubscriptionValidatorRuntimeTests
{
    private static readonly UInt160 Merchant =
        UInt160.Parse("0x2222222222222222222222222222222222222222");

    private static readonly UInt160 Stranger =
        UInt160.Parse("0x9999999999999999999999999999999999999999");

    private static readonly byte[] SubId = { 0xAB, 0xCD, 0xEF, 0x01 };

    private const long Amount = 1000;

    private const long PeriodSeconds = 2_592_000; // 30 days

    private static readonly BigInteger PeriodMs = (BigInteger)PeriodSeconds * 1000;

    /// <summary>
    /// Deploys the validator and creates the subscription under the Configuration
    /// writer phase, one full billing period past genesis so the current period is
    /// never zero.
    /// </summary>
    private static PluginModuleHarness SetUp(UInt160? merchant = null)
    {
        PluginModuleHarness h = new("validators/SubscriptionValidator", instanceIsolation: false);
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds((double)PeriodMs));
        h.Configure("createSubscription", SubId, merchant ?? Merchant, h.Target,
            (BigInteger)Amount, (BigInteger)PeriodSeconds);
        // The merchant pulls the charge, so the merchant witness rides on the call.
        h.Fx.SetSigners(Merchant);
        return h;
    }

    /// <summary>The stored record is [merchant, token, amount, periodSeconds, generation, lastChargedPeriod].</summary>
    private static Neo.VM.Types.Array Subscription(PluginModuleHarness h)
    {
        return (Neo.VM.Types.Array)h.CallDirect("getSubscription", h.AccountId, h.ModuleId, SubId)!;
    }

    private static bool ValidateCharge(PluginModuleHarness h, object[] op)
    {
        byte[] digest = PluginModuleHarness.Digest(h.Fx, op);
        return h.Validate(digest, op);
    }

    /// <summary>
    /// At most one charge is booked per billing period: a second pull in the same
    /// period is rejected, and the next period accepts a fresh one.
    /// </summary>
    [TestMethod]
    public void Validate_RejectsSecondChargeInSamePeriod_AllowsNextPeriod()
    {
        PluginModuleHarness h = SetUp();
        Assert.AreEqual(6, Subscription(h).Count, "The subscription must be configured");

        object[] charge1 = h.TransferOp(h.Target, Amount, Merchant, SubId);
        Assert.IsTrue(ValidateCharge(h, charge1), "The first charge of a period must validate");
        h.Complete(charge1, true);

        BigInteger booked = h.Fx.CallInteger(
            h.Module, "getLastChargedPeriod", h.AccountId, h.ModuleId, SubId);
        Assert.IsTrue(booked > BigInteger.Zero, "Completion must book the charged period");

        object[] charge2 = h.TransferOp(h.Target, Amount, Merchant, SubId);
        Assert.IsFalse(ValidateCharge(h, charge2),
            "A second charge inside the same billing period must be rejected");

        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds((double)PeriodMs));
        object[] charge3 = h.TransferOp(h.Target, Amount, Merchant, SubId);
        Assert.IsTrue(ValidateCharge(h, charge3),
            "A charge in the next billing period must be accepted");
    }

    /// <summary>
    /// The signature field carries the public subscription id, which is not a
    /// cryptographic proof: without the configured merchant's witness any observer
    /// of the subId could trigger the pull (audit fix M-8).
    /// </summary>
    [TestMethod]
    public void Validate_RequiresMerchantWitness()
    {
        PluginModuleHarness h = SetUp();
        h.Fx.SetSigners(Stranger);

        object[] charge = h.TransferOp(h.Target, Amount, Merchant, SubId);
        Assert.IsFalse(ValidateCharge(h, charge),
            "A pull without the merchant's witness must be rejected");
    }

    /// <summary>
    /// A virtual account never holds a balance at its account id: assets sit at the
    /// core-derived asset address, which is the only <c>from</c> a pull may name.
    /// </summary>
    [TestMethod]
    public void Validate_RejectsTransferSourcedFromTheAccountId()
    {
        PluginModuleHarness h = SetUp();
        Assert.AreNotEqual(h.AccountId, h.AssetAddress);

        object[] charge = RuntimeFixture.UserOp(
            h.Target, "transfer",
            new object?[] { h.AccountId, Merchant, (BigInteger)Amount, null },
            0, h.Fx.Now() + 600_000, SubId,
            validatorId: h.ModuleId, credentialGeneration: h.Generation);

        Assert.IsFalse(ValidateCharge(h, charge),
            "A pull sourced from the account id must be rejected");
    }

    /// <summary>
    /// The generation recorded with the subscription ties it to the instance's
    /// credentials: an operation carrying any other generation never validates, even
    /// when every other field matches (spec §10 revocation).
    /// </summary>
    [TestMethod]
    public void Validate_RejectsStaleCredentialGeneration()
    {
        PluginModuleHarness h = SetUp();
        h.SetGeneration(2);
        h.Configure("createSubscription", SubId, Merchant, h.Target,
            (BigInteger)Amount, (BigInteger)PeriodSeconds);

        // The re-created record is stamped with generation 2.
        Assert.AreEqual((BigInteger)2, Subscription(h)[4]);

        object[] stale = RuntimeFixture.UserOp(
            h.Target, "transfer",
            new object?[] { h.AssetAddress, Merchant, (BigInteger)Amount, null },
            0, h.Fx.Now() + 600_000, SubId,
            validatorId: h.ModuleId, credentialGeneration: 1);

        Assert.IsFalse(ValidateCharge(h, stale),
            "A pull issued under the pre-revocation generation must be rejected");
        Assert.IsTrue(ValidateCharge(h, h.TransferOp(h.Target, Amount, Merchant, SubId)),
            "The re-created subscription must charge under the new generation");
    }
}
