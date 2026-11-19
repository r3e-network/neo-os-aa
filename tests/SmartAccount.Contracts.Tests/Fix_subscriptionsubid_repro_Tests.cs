using System;
using System.Numerics;
using System.Security.Cryptography;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// F-3 (subscription subId) regression suite for protocol v4. The retired verifier
/// kept a local per-subscription counter that <c>clearAccount</c> wiped while the
/// core's channel cursor survived, so re-creating the same subId could never line
/// up again. In v4 replay protection is the core's nonce alone (§5): the channel
/// commits to the instance id, the credential generation and a caller-chosen
/// nonceSubkey (here SHA-256 of the subId), so uninstall/reinstall or a credential
/// revocation simply opens a NEW channel while the retired one stays closed.
/// The billing-period gate is separate and survives re-configuration.
/// </summary>
[TestClass]
public class Fix_SubscriptionSubIdReproTests
{
    private static readonly UInt160 Custody =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Merchant =
        UInt160.Parse("0x2222222222222222222222222222222222222222");

    private static readonly byte[] SubIdA = { 0xAB, 0xCD, 0xEF, 0x01 };

    private const long Amount = 1000;

    private const long PeriodSeconds = 86_400; // one day

    private static readonly BigInteger PeriodMs = (BigInteger)PeriodSeconds * 1000;

    private static int _sequence;

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Token { get; }

        public UInt160 Validator { get; }

        public UInt160 AccountId { get; private set; } = UInt160.Zero;

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            Token = Fx.Deploy("MockTransferTarget");
            Validator = Fx.Deploy("validators/SubscriptionValidator", Wallet.ToArray());
        }

        /// <summary><c>["createSubscription", subId, merchant, token, amount, periodSeconds]</c>.</summary>
        public object?[] CommandFor(byte[] subId) =>
            new object?[]
            {
                "createSubscription", subId, Merchant, Token, (BigInteger)Amount, (BigInteger)PeriodSeconds
            };

        /// <summary>The channel a subscription pull uses: SHA-256 of the subId (32 bytes).</summary>
        public static byte[] ChannelKey(byte[] subId) => SHA256.HashData(subId);

        /// <summary>Registers the account with the validator and one subscription committed atomically.</summary>
        public BigInteger Register(byte[] subId)
        {
            int sequence = System.Threading.Interlocked.Increment(ref _sequence);
            AccountId = Fx.CreateAccount(
                Wallet, Custody, RuntimeFixture.Salt("sub-" + sequence + "-" + Custody),
                RuntimeFixture.MinRecoveryTimelockMs,
                new object[] { Fx.InstallValidator(Validator, CommandFor(subId)) });
            BigInteger moduleId = Fx.FindModuleId(
                Wallet, AccountId, RuntimeFixture.ModuleTypeNameValidator, Validator);
            Assert.AreNotEqual(BigInteger.Zero, moduleId, "The validator must be installed at registration");
            return moduleId;
        }

        public BigInteger Generation(BigInteger moduleId) =>
            ((Neo.VM.Types.Array)Fx.Call(Wallet, "getModule", AccountId, moduleId))[8].GetInteger();

        public BigInteger Sequence(BigInteger moduleId, byte[] subId) =>
            RuntimeFixture.NonceSequence(
                Fx.PackedNonce(Wallet, AccountId, moduleId, ChannelKey(subId)));

        public BigInteger LastCharged(BigInteger moduleId, byte[] subId) =>
            Fx.CallInteger(Validator, "getLastChargedPeriod", AccountId, moduleId, subId);

        /// <summary>Merchant pull: the merchant witnesses, the subId rides in field 11.</summary>
        public object[] ChargeOp(BigInteger moduleId, BigInteger generation, byte[] subId)
        {
            object?[] args =
            {
                Fx.CallUInt160(Wallet, "getProxyScriptHash", AccountId), Merchant, (BigInteger)Amount, null
            };
            return RuntimeFixture.UserOp(
                Token, "transfer", args,
                Fx.PackedNonce(Wallet, AccountId, moduleId, ChannelKey(subId)),
                Fx.Now() + 3_600_000, subId,
                validatorId: moduleId, credentialGeneration: generation,
                configurationNonce: Fx.AccountConfigurationNonce(Wallet, AccountId),
                nonceSubkey: ChannelKey(subId));
        }

        public bool Charge(BigInteger moduleId, BigInteger generation, byte[] subId)
        {
            Fx.SetSigners(Merchant);
            return Fx.CallBoolean(Wallet, "executeUserOp", AccountId, ChargeOp(moduleId, generation, subId));
        }

        /// <summary>Uninstall + built-in-route enable in one intent (last-validator rule).</summary>
        public void Uninstall(BigInteger moduleId)
        {
            Fx.ConfigureAfterTimelock(
                Wallet, AccountId, Custody,
                new object[] { 2, moduleId, new object[0] },
                new object[] { 5, true, false });
            Assert.AreEqual(0, ((Neo.VM.Types.Array)Fx.Call(Wallet, "getModule", AccountId, moduleId)).Count,
                "The instance must be uninstalled");
        }

        public BigInteger Reinstall(byte[] subId)
        {
            object[] install = Fx.InstallValidator(Validator, CommandFor(subId));
            Fx.ConfigureAfterTimelock(Wallet, AccountId, Custody, new object[] { install });
            BigInteger moduleId = Fx.FindModuleId(
                Wallet, AccountId, RuntimeFixture.ModuleTypeNameValidator, Validator);
            Assert.AreNotEqual(BigInteger.Zero, moduleId, "The validator must be reinstalled");
            return moduleId;
        }

        public void Revoke(BigInteger moduleId)
        {
            Fx.SetSigners(Custody);
            Fx.CallVoid(Wallet, "revokeCredentials", AccountId, moduleId);
        }

        public void AdvancePeriod() =>
            Fx.AdvanceTime(TimeSpan.FromMilliseconds((double)PeriodMs) + TimeSpan.FromMinutes(1));
    }

    /// <summary>
    /// F-3 main regression: a subId charged on one instance charges again on the
    /// reinstalled instance, because the nonce channel is keyed by the new instance
    /// id instead of a surviving counter. There is no permanently bricked subId.
    /// </summary>
    [TestMethod]
    public void SameSubId_ChargesAgainOnReinstalledInstance()
    {
        Harness h = new();
        BigInteger module1 = h.Register(SubIdA);
        Assert.IsTrue(h.Charge(module1, 1, SubIdA), "The first charge must succeed");
        Assert.AreEqual(BigInteger.One, h.Sequence(module1, SubIdA));
        Assert.IsTrue(h.LastCharged(module1, SubIdA) > BigInteger.Zero,
            "Completion must book the billing period");

        h.Uninstall(module1);
        BigInteger module2 = h.Reinstall(SubIdA);
        Assert.AreNotEqual(module1, module2, "Reinstall allocates a new instance id");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(module2, SubIdA),
            "The reinstalled instance starts a fresh channel for the same subId");

        Assert.IsTrue(h.Charge(module2, 1, SubIdA),
            "F-3: the same subId must charge again instead of being permanently unusable");
        Assert.AreEqual(BigInteger.One, h.Sequence(module2, SubIdA));
    }

    /// <summary>
    /// The billing-period gate is independent of the nonce: a second pull in the
    /// same period is rejected without consuming a nonce, and the next period accepts
    /// one. The nonce cursor advances only on success.
    /// </summary>
    [TestMethod]
    public void SecondChargeInSamePeriod_IsRejected_NextPeriodAccepted()
    {
        Harness h = new();
        BigInteger moduleId = h.Register(SubIdA);

        Assert.IsTrue(h.Charge(moduleId, 1, SubIdA));
        BigInteger booked = h.LastCharged(moduleId, SubIdA);
        Assert.IsTrue(booked > BigInteger.Zero);

        TestException samePeriod = Assert.ThrowsExactly<TestException>(
            () => h.Charge(moduleId, 1, SubIdA),
            "A second charge inside the same billing period must be rejected");
        StringAssert.Contains(samePeriod.Message, "SA_VALIDATION_REJECTED");
        Assert.AreEqual(BigInteger.One, h.Sequence(moduleId, SubIdA),
            "A rejected pull must not consume the channel");

        h.AdvancePeriod();
        Assert.IsTrue(h.Charge(moduleId, 1, SubIdA), "The next billing period accepts a fresh pull");
        Assert.IsTrue(h.LastCharged(moduleId, SubIdA) > booked,
            "Completion must book the later period");
        Assert.AreEqual((BigInteger)2, h.Sequence(moduleId, SubIdA));
    }

    /// <summary>
    /// <c>revokeCredentials</c> bumps the instance generation, which both the core
    /// routing gate and the stored subscription record check. The same subId must be
    /// re-created under the new generation before it can charge again, and it then
    /// bills in the new generation's channel.
    /// </summary>
    [TestMethod]
    public void Revocation_RequiresRecreatingTheSubscriptionUnderTheNewGeneration()
    {
        Harness h = new();
        BigInteger moduleId = h.Register(SubIdA);
        Assert.IsTrue(h.Charge(moduleId, 1, SubIdA));

        h.Revoke(moduleId);
        Assert.AreEqual((BigInteger)2, h.Generation(moduleId));

        // The pre-revocation authorization is dead at the core's routing gate.
        TestException stale = Assert.ThrowsExactly<TestException>(() => h.Charge(moduleId, 1, SubIdA));
        StringAssert.Contains(stale.Message, "SA_CREDENTIAL_STALE");

        // Re-create the subscription under generation 2: the record is re-stamped.
        object[] action = RuntimeFixture.ConfigureModule(moduleId, h.CommandFor(SubIdA));
        h.Fx.ConfigureAfterTimelock(h.Wallet, h.AccountId, Custody, new object[] { action });
        Neo.VM.Types.Array record = (Neo.VM.Types.Array)h.Fx.Call(
            h.Validator, "getSubscription", h.AccountId, moduleId, SubIdA);
        Assert.AreEqual((BigInteger)2, record[4].GetInteger(),
            "A re-created subscription records the generation it was issued under");

        // The channel rotated with the generation, and the period already booked
        // still gates a second charge in the same period.
        h.AdvancePeriod();
        Assert.IsTrue(h.Charge(moduleId, 2, SubIdA),
            "The re-created subscription must charge under the new generation");
        Assert.AreEqual(BigInteger.One, h.Sequence(moduleId, SubIdA),
            "The new generation's channel is independent of the revoked one");
    }
}
