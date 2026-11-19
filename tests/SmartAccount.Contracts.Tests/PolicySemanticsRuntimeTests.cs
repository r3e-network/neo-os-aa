using System;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Policy behaviour against compiled NEFs, driven by the real v4 core instead of a
/// stub relay: <c>executeUserOp</c> runs validation → nonce → hook pre → dispatch →
/// hook post → completion, so every vector proves both the policy verdict and the
/// core-side rollback (nonce, token storage and policy state) of a rejected op.
/// </summary>
/// <remarks>
/// <c>PolicyExecutionProbe.transfer(from, to, amount, data)</c> debits
/// <c>data[0]</c> and returns <c>data[1]</c>, so a test can declare one amount,
/// move another, and answer with any business value — the adversarial shapes the
/// daily-limit hook, the session-key validator and the subscription validator must
/// fail closed on.
/// </remarks>
[TestClass]
public class PolicySemanticsRuntimeTests
{
    private static readonly UInt160 Merchant =
        UInt160.Parse("0x2222222222222222222222222222222222222222");

    private static readonly UInt160 Stranger =
        UInt160.Parse("0x1111111111111111111111111111111111111111");

    private static readonly byte[] SubId = { 0x71, 0x72 };

    private const long SubscriptionAmount = 100;

    private const long SubscriptionPeriodSeconds = 60;

    /// <summary>Session lifetime that outlives every configuration window these tests use.</summary>
    private static readonly BigInteger SessionLifetimeMs = 20L * 24 * 60 * 60 * 1000;

    private static int _sequence;

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Token { get; }

        public UInt160 AccountId { get; private set; } = UInt160.Zero;

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            Token = Fx.Deploy("PolicyExecutionProbe");
        }

        /// <summary>Asset address the core derives for the account (spec §5).</summary>
        public UInt160 Asset => Fx.CallUInt160(Wallet, "getProxyScriptHash", AccountId);

        public BigInteger Balance => Fx.CallInteger(Token, "balanceOf", Asset);

        public UInt160 DeployModule(string contractPath) => Fx.Deploy(contractPath, Wallet.ToArray());

        /// <summary>
        /// Registers the custody-owned account with its modules and funds the asset address.
        /// Each argument is one action array: the registration intent is a list of actions,
        /// never a flat field list.
        /// </summary>
        public void Register(P256SessionKey custodyKey, params object[] actions)
        {
            for (int i = 0; i < actions.Length; i++)
                Assert.IsTrue(actions[i] is object[],
                    "Registration element " + i + " must be an action array, not a scalar field");
            int sequence = System.Threading.Interlocked.Increment(ref _sequence);
            AccountId = Fx.CreateAccount(
                Wallet, RuntimeFixture.CustodyOf(custodyKey),
                RuntimeFixture.Salt("policy-" + sequence + "-" + RuntimeFixture.CustodyOf(custodyKey)),
                RuntimeFixture.MinRecoveryTimelockMs, actions);
            Fx.CallVoid(Token, "setBalance", Asset, 1000);
        }

        public BigInteger ConfigurationNonce => Fx.AccountConfigurationNonce(Wallet, AccountId);

        public BigInteger Generation(BigInteger moduleId) =>
            ((Neo.VM.Types.Array)Fx.Call(Wallet, "getModule", AccountId, moduleId))[8].GetInteger();

        public BigInteger ModuleId(UInt160 module) =>
            Fx.FindModuleId(Wallet, AccountId, RuntimeFixture.ModuleTypeNameValidator, module);

        public BigInteger BuiltInSequence => Fx.CurrentNonceSequence(Wallet, AccountId, 0);

        public BigInteger Sequence(BigInteger moduleId, byte[]? subkey = null) =>
            subkey == null
                ? Fx.CurrentNonceSequence(Wallet, AccountId, moduleId)
                : Fx.CurrentNonceSequence(Wallet, AccountId, moduleId, subkey);

        // ---- built-in (custody-signature) route --------------------------------

        public object[] BuiltInOp(string method, object?[] args) =>
            RuntimeFixture.UserOp(Token, method, args, Fx.PackedNonce(Wallet, AccountId, 0),
                Fx.Now() + 600_000, new byte[] { 0x00 }, configurationNonce: ConfigurationNonce);

        public bool ExecuteBuiltIn(object[] op, P256SessionKey custodyKey)
        {
            op[11] = Fx.SignBuiltIn(Wallet, AccountId, op, custodyKey);
            Fx.SetSigners(RuntimeFixture.CustodyOf(custodyKey));
            return Fx.CallBoolean(Wallet, "executeUserOp", AccountId, op);
        }

        /// <summary>Token args <c>[from, to, declared, [actual debit, business result]]</c>.</summary>
        public object?[] TokenArgs(BigInteger declared, BigInteger debit, object? result) =>
            new object?[] { Asset, Merchant, declared, new object?[] { debit, result } };

        // ---- module routes (session key, subscription) -------------------------

        /// <summary>Module-routed op with a placeholder signature; the route signs it after.</summary>
        public object[] RoutedOp(BigInteger moduleId, string method, object?[] args, byte[]? subkey = null)
        {
            byte[] channel = subkey ?? RuntimeFixture.DefaultNonceSubkey();
            return RuntimeFixture.UserOp(Token, method, args,
                Fx.PackedNonce(Wallet, AccountId, moduleId, channel), Fx.Now() + 600_000, new byte[] { 0x00 },
                validatorId: moduleId, credentialGeneration: Generation(moduleId),
                configurationNonce: ConfigurationNonce, nonceSubkey: channel);
        }

        public bool ExecuteModule(object[] op) =>
            Fx.CallBoolean(Wallet, "executeUserOp", AccountId, op);

        public bool ExecutionActive => Fx.CallBoolean(Wallet, "isExecutionActive", AccountId);

        /// <summary>Session route signature (spec §5): <c>grantDigest(32) ‖ raw P-256 signature</c>.</summary>
        public byte[] SignSession(UInt160 verifier, BigInteger moduleId, P256SessionKey key, object[] op)
        {
            object[] probe = (object[])op.Clone();
            probe[11] = new byte[] { 0x00 };
            byte[] digest = Fx.CallBytes(Wallet, "getOperationDigest", AccountId, probe);
            byte[] grant = Fx.CallBytes(verifier, "getGrantDigest", AccountId, moduleId);
            return grant.Concat(key.Sign(digest)).ToArray();
        }

        public BigInteger Spent(UInt160 verifier, BigInteger moduleId) =>
            Fx.CallInteger(verifier, "getSpentAmount", AccountId, moduleId);

        public BigInteger LastCharged(UInt160 validator, BigInteger moduleId) =>
            Fx.CallInteger(validator, "getLastChargedPeriod", AccountId, moduleId, SubId);
    }

    /// <summary>Installs a daily-limit hook at registration and returns the hook contract.</summary>
    private static UInt160 InstallDailyLimit(Harness h, P256SessionKey key, BigInteger limit, bool rolling)
    {
        UInt160 hook = h.DeployModule("hooks/DailyLimitHook");
        object?[] command = { "setDailyLimit", h.Token, limit, rolling };
        h.Register(key, new object[] { h.Fx.InstallHook(hook, command) });
        Assert.AreEqual(1, h.Fx.HookOrderIds(h.Wallet, h.AccountId).Length,
            "An installed hook enters the core-owned hook order");
        return hook;
    }

    /// <summary>Installs a session-key validator with one grant committed at registration.</summary>
    private static BigInteger InstallSession(
        Harness h, P256SessionKey key, UInt160 verifier, int cap, string method = "transfer")
    {
        object?[] command =
        {
            "setSessionKey", key.CompressedPublicKey, h.Token, method,
            h.Fx.Now() + SessionLifetimeMs, (BigInteger)cap, "policy semantics"
        };
        h.Register(key, new object[] { h.Fx.InstallValidator(verifier, command) });
        BigInteger moduleId = h.ModuleId(verifier);
        Assert.AreNotEqual(BigInteger.Zero, moduleId,
            "The session-key validator must be installed at registration");
        return moduleId;
    }

    /// <summary>Installs a subscription validator with one subscription committed at registration.</summary>
    private static BigInteger InstallSubscription(Harness h, P256SessionKey key, UInt160 validator)
    {
        object?[] command =
        {
            "createSubscription", SubId, Merchant, h.Token,
            (BigInteger)SubscriptionAmount, (BigInteger)SubscriptionPeriodSeconds
        };
        h.Register(key, new object[] { h.Fx.InstallValidator(validator, command) });
        BigInteger moduleId = h.ModuleId(validator);
        Assert.AreNotEqual(BigInteger.Zero, moduleId,
            "The subscription validator must be installed at registration");
        return moduleId;
    }

    /// <summary>The 32-byte channel a subscription pull commits to: SHA-256 of its subId.</summary>
    private static byte[] ChannelKey(byte[] subId) => SHA256.HashData(subId);

    private static object[] SessionOp(
        Harness h, UInt160 verifier, BigInteger moduleId, P256SessionKey key, object?[] args)
    {
        object[] op = h.RoutedOp(moduleId, "transfer", args);
        op[11] = h.SignSession(verifier, moduleId, key, op);
        return op;
    }

    // ========================================================================
    // Daily limit (balance-delta metering, spec §9)
    // ========================================================================

    /// <summary>
    /// A business-level false or zero return does not undo the debit the target performed,
    /// so the post-check must meter the realized outflow of an indirect (non-"transfer")
    /// path. Both windows meter identically, and the rejection rolls the debit back.
    /// </summary>
    [TestMethod]
    public void DailyLimit_FalseAndZeroReturnCannotHideIndirectOutflow()
    {
        foreach (object result in new object[] { false, BigInteger.Zero })
            foreach (bool rolling in new[] { false, true })
            {
                Harness h = new();
                using P256SessionKey key = new();
                InstallDailyLimit(h, key, 50, rolling);

                object[] op = h.BuiltInOp("move", new object?[] { h.Asset, (BigInteger)60, result });
                TestException fault = Assert.ThrowsExactly<TestException>(() => h.ExecuteBuiltIn(op, key));
                StringAssert.Contains(fault.Message, "Daily limit exceeded");
                Assert.AreEqual(new BigInteger(1000), h.Balance,
                    "A post-execution policy failure must roll back the token debit.");
                Assert.AreEqual(BigInteger.Zero, h.BuiltInSequence,
                    "A post-execution policy failure must roll back nonce consumption.");
                Assert.IsFalse(h.ExecutionActive, "The execution lock must be released by the rollback.");
            }
    }

    /// <summary>
    /// A successful direct transfer is accounted at max(declared, realized): the extra debit
    /// is charged, and the declared amount is never added on top of the realized one.
    /// </summary>
    [TestMethod]
    public void DailyLimit_DirectTransferMetersExtraDebitAndDoesNotDoubleCount()
    {
        foreach (bool rolling in new[] { false, true })
        {
            Harness h = new();
            using P256SessionKey key = new();
            InstallDailyLimit(h, key, 50, rolling);

            Assert.IsTrue(h.ExecuteBuiltIn(h.BuiltInOp("transfer", h.TokenArgs(20, 40, true)), key));
            Assert.AreEqual(new BigInteger(960), h.Balance);
            Assert.AreEqual(BigInteger.One, h.BuiltInSequence);

            TestException fault = Assert.ThrowsExactly<TestException>(
                () => h.ExecuteBuiltIn(h.BuiltInOp("transfer", h.TokenArgs(10, 11, true)), key));
            StringAssert.Contains(fault.Message, "Daily limit exceeded");
            Assert.AreEqual(new BigInteger(960), h.Balance);
            Assert.AreEqual(BigInteger.One, h.BuiltInSequence,
                "The rejected post-check must not consume the nonce.");

            Assert.IsTrue(h.ExecuteBuiltIn(h.BuiltInOp("transfer", h.TokenArgs(10, 10, true)), key));
            Assert.AreEqual(new BigInteger(950), h.Balance,
                "Declared and actual spend must not be added twice.");
            Assert.AreEqual((BigInteger)2, h.BuiltInSequence);
        }
    }

    /// <summary>
    /// A transfer that reports failure still moved value; only the realized outflow is
    /// charged, not the declared amount the target ignored.
    /// </summary>
    [TestMethod]
    public void DailyLimit_FalseDirectTransferMetersOnlyActualOutflow()
    {
        Harness h = new();
        using P256SessionKey key = new();
        InstallDailyLimit(h, key, 50, false);

        Assert.IsFalse(h.ExecuteBuiltIn(h.BuiltInOp("transfer", h.TokenArgs(40, 20, false)), key),
            "The target's business result is returned unchanged.");
        Assert.IsTrue(h.ExecuteBuiltIn(h.BuiltInOp("transfer", h.TokenArgs(30, 30, true)), key));
        Assert.AreEqual(new BigInteger(950), h.Balance);

        TestException fault = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteBuiltIn(h.BuiltInOp("transfer", h.TokenArgs(1, 1, true)), key));
        StringAssert.Contains(fault.Message, "Daily limit exceeded");
        Assert.AreEqual(new BigInteger(950), h.Balance);
    }

    /// <summary>The fixed window resets 24 h after the first spend, not at a calendar boundary.</summary>
    [TestMethod]
    public void DailyLimit_FixedWindowResetsFromFirstSpend()
    {
        Harness h = new();
        using P256SessionKey key = new();
        InstallDailyLimit(h, key, 50, false);

        Assert.IsTrue(h.ExecuteBuiltIn(h.BuiltInOp("transfer", h.TokenArgs(30, 30, true)), key));
        h.Fx.AdvanceTime(TimeSpan.FromHours(23));
        Assert.IsTrue(h.ExecuteBuiltIn(h.BuiltInOp("transfer", h.TokenArgs(20, 20, true)), key));
        h.Fx.AdvanceTime(TimeSpan.FromHours(2));
        Assert.IsTrue(h.ExecuteBuiltIn(h.BuiltInOp("transfer", h.TokenArgs(50, 50, true)), key));
        Assert.AreEqual(new BigInteger(900), h.Balance);
    }

    // ========================================================================
    // Session key (canonical transfer ABI, spec §5/§9)
    // ========================================================================

    /// <summary>
    /// A session signature is only valid over the one canonical NEP-17 transfer ABI:
    /// <c>[asset, recipient, non-negative integer amount, data]</c>. Every other shape is
    /// rejected, with or without a spending cap.
    /// </summary>
    [TestMethod]
    public void SessionKey_RejectsNonCanonicalTransferEvenWithValidSignature()
    {
        foreach (int cap in new[] { 0, 100 })
            foreach (int variant in new[] { 0, 1, 2, 3, 4, 5 })
            {
                Harness h = new();
                using P256SessionKey key = new();
                UInt160 verifier = h.DeployModule("validators/SessionKeyValidator");
                BigInteger moduleId = InstallSession(h, key, verifier, cap);
                object?[] args = variant switch
                {
                    0 => new object?[] { h.Asset, Merchant, 1 },
                    1 => new object?[] { h.Asset, Merchant, 1, null, null },
                    2 => new object?[] { Stranger, Merchant, 1, null },
                    3 => new object?[] { h.Asset, Merchant, -1, null },
                    4 => new object?[] { h.Asset, Merchant, new byte[] { 1 }, null },
                    _ => new object?[] { h.Asset, Merchant, true, null }
                };
                object[] op = SessionOp(h, verifier, moduleId, key, args);
                TestException rejected = Assert.ThrowsExactly<TestException>(
                    () => h.ExecuteModule(op),
                    $"Malformed transfer variant {variant}, cap {cap} must fail closed.");
                StringAssert.Contains(rejected.Message, "SA_VALIDATION_REJECTED");
                Assert.AreEqual(BigInteger.Zero, h.Sequence(moduleId),
                    "A rejected operation must not consume the channel.");
            }
    }

    /// <summary>
    /// Completion treats a false or non-boolean transfer result as a failed NEP-17 transfer:
    /// token debit, nonce and booked spend all revert, and the retry executes.
    /// </summary>
    [TestMethod]
    public void SessionKey_FalseOrNonBooleanTransferRollsBackTokenAndMeter()
    {
        foreach (object? result in new object?[] { false, BigInteger.Zero, BigInteger.One, null })
        {
            Harness h = new();
            using P256SessionKey key = new();
            UInt160 verifier = h.DeployModule("validators/SessionKeyValidator");
            BigInteger moduleId = InstallSession(h, key, verifier, 100);

            object[] op = SessionOp(h, verifier, moduleId, key, h.TokenArgs(30, 30, result));
            TestException fault = Assert.ThrowsExactly<TestException>(() => h.ExecuteModule(op));
            StringAssert.Contains(fault.Message, "NEP-17 transfer failed");
            Assert.AreEqual(new BigInteger(1000), h.Balance, "The failed transfer must be rolled back.");
            Assert.AreEqual(BigInteger.Zero, h.Spent(verifier, moduleId));
            Assert.AreEqual(BigInteger.Zero, h.Sequence(moduleId));
            Assert.IsFalse(h.ExecutionActive);

            Assert.IsTrue(h.ExecuteModule(
                SessionOp(h, verifier, moduleId, key, h.TokenArgs(30, 30, true))));
            Assert.AreEqual(new BigInteger(970), h.Balance);
            Assert.AreEqual(new BigInteger(30), h.Spent(verifier, moduleId));
            Assert.AreEqual(BigInteger.One, h.Sequence(moduleId));
        }
    }

    /// <summary>
    /// A zero-value canonical transfer is valid and books nothing; a non-transfer method on
    /// an uncapped grant keeps ordinary business semantics (a false result is not a policy
    /// failure) and moves no value.
    /// </summary>
    [TestMethod]
    public void SessionKey_ZeroValueTransferIsValidAndNonTransferFalseRetainsBusinessSemantics()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = h.DeployModule("validators/SessionKeyValidator");
        BigInteger moduleId = InstallSession(h, key, verifier, 100);
        Assert.IsTrue(h.ExecuteModule(
            SessionOp(h, verifier, moduleId, key, h.TokenArgs(0, 0, true))));
        Assert.AreEqual(BigInteger.Zero, h.Spent(verifier, moduleId));
        Assert.AreEqual(new BigInteger(1000), h.Balance);

        Harness generic = new();
        UInt160 genericVerifier = generic.DeployModule("validators/SessionKeyValidator");
        BigInteger genericId = InstallSession(generic, key, genericVerifier, cap: 0, method: "move");
        object[] moveOp = generic.RoutedOp(
            genericId, "move", new object?[] { generic.Asset, (BigInteger)0, false });
        moveOp[11] = generic.SignSession(genericVerifier, genericId, key, moveOp);
        Assert.IsFalse(generic.ExecuteModule(moveOp),
            "A non-transfer business failure is returned, not raised by the policy.");
        Assert.AreEqual(new BigInteger(1000), generic.Balance);
        Assert.AreEqual(BigInteger.One, generic.Sequence(genericId));
    }

    /// <summary>
    /// One whole-envelope rollback across both routing kinds: a failed NEP-17 transfer leaves
    /// the token balance, the channel cursor and the policy state untouched, and the same
    /// operation shape then succeeds exactly once.
    /// </summary>
    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public void RealCore_FailedTransferRollsBackNonceTokenAndPolicyState(bool subscription)
    {
        Harness h = new();
        using P256SessionKey key = new();
        byte[] channel = ChannelKey(SubId);
        UInt160 module;
        BigInteger moduleId;
        Func<bool, object[]> buildOp;

        if (subscription)
        {
            module = h.DeployModule("validators/SubscriptionValidator");
            moduleId = InstallSubscription(h, key, module);
            buildOp = accepted =>
            {
                object[] op = h.RoutedOp(moduleId, "transfer", h.TokenArgs(30, 30, accepted), channel);
                op[11] = SubId; // the signature field carries the subId
                return op;
            };
            h.Fx.SetSigners(Merchant); // the merchant witnesses the pull
        }
        else
        {
            module = h.DeployModule("validators/SessionKeyValidator");
            moduleId = InstallSession(h, key, module, 100);
            buildOp = accepted => SessionOp(h, module, moduleId, key, h.TokenArgs(30, 30, accepted));
        }

        TestException fault = Assert.ThrowsExactly<TestException>(() => h.ExecuteModule(buildOp(false)));
        StringAssert.Contains(fault.Message, "NEP-17 transfer failed");
        Assert.AreEqual(new BigInteger(1000), h.Balance, "A failed NEP-17 transfer must be rolled back.");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(moduleId, subscription ? channel : null));
        Assert.IsFalse(h.ExecutionActive, "The execution lock must be released by the rollback.");
        if (subscription)
            Assert.AreEqual(BigInteger.Zero, h.LastCharged(module, moduleId),
                "A failed pull must not book the billing period.");
        else
            Assert.AreEqual(BigInteger.Zero, h.Spent(module, moduleId));

        Assert.IsTrue(h.ExecuteModule(buildOp(true)));
        Assert.AreEqual(new BigInteger(970), h.Balance);
        Assert.AreEqual(BigInteger.One, h.Sequence(moduleId, subscription ? channel : null));
        Assert.IsFalse(h.ExecutionActive);
        if (subscription)
            Assert.IsTrue(h.LastCharged(module, moduleId) > BigInteger.Zero,
                "Completion books the billing period.");
        else
            Assert.AreEqual(new BigInteger(30), h.Spent(module, moduleId));
    }

    /// <summary>
    /// A cap lowered below historical spending rejects even a zero-value operation, so the
    /// cap cannot be bypassed with an approve-style call (audit fix M-2).
    /// </summary>
    [TestMethod]
    public void SessionKey_LoweredCapRejectsZeroValueOperationOnceOverspent()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = h.DeployModule("validators/SessionKeyValidator");
        BigInteger moduleId = InstallSession(h, key, verifier, 100);
        Assert.IsTrue(h.ExecuteModule(
            SessionOp(h, verifier, moduleId, key, h.TokenArgs(30, 30, true))));
        Assert.AreEqual(new BigInteger(30), h.Spent(verifier, moduleId));

        // The configuration window is 24 h; the same cooldown also gates key rotation.
        object?[] lowered =
        {
            "setSessionKey", key.CompressedPublicKey, h.Token, "transfer",
            h.Fx.Now() + SessionLifetimeMs, (BigInteger)20, "lowered cap"
        };
        h.Fx.ConfigureAfterTimelock(
            h.Wallet, h.AccountId, RuntimeFixture.CustodyOf(key),
            new object[] { RuntimeFixture.ConfigureModule(moduleId, lowered) });
        Neo.VM.Types.Array grant = (Neo.VM.Types.Array)h.Fx.Call(verifier, "getSessionKey", h.AccountId, moduleId);
        Assert.AreEqual(new BigInteger(20), grant[4].GetInteger(),
            "The lowered cap is live while the spend booked under the old cap is preserved.");

        TestException rejected = Assert.ThrowsExactly<TestException>(() => h.ExecuteModule(
            SessionOp(h, verifier, moduleId, key, h.TokenArgs(0, 0, true))));
        StringAssert.Contains(rejected.Message, "SA_VALIDATION_REJECTED");
        Assert.AreEqual(new BigInteger(30), h.Spent(verifier, moduleId),
            "The rejected zero-value operation must not change the spent amount.");
    }

    // ========================================================================
    // Subscription (billing period, spec §5/§9)
    // ========================================================================

    /// <summary>
    /// A failed pull does not book the period: the same charge succeeds afterwards, and the
    /// booked period then rejects a second pull until time advances.
    /// </summary>
    [TestMethod]
    public void Subscription_FalseOrNonBooleanTransferPreservesBillingPeriodAndToken()
    {
        foreach (object? result in new object?[] { false, BigInteger.Zero, BigInteger.One, null })
        {
            Harness h = new();
            using P256SessionKey key = new();
            UInt160 validator = h.DeployModule("validators/SubscriptionValidator");
            BigInteger moduleId = InstallSubscription(h, key, validator);
            byte[] channel = ChannelKey(SubId);
            h.Fx.SetSigners(Merchant);

            object[] Charge(object? businessResult)
            {
                object[] op = h.RoutedOp(moduleId, "transfer", h.TokenArgs(30, 30, businessResult), channel);
                op[11] = SubId;
                return op;
            }

            TestException fault = Assert.ThrowsExactly<TestException>(() => h.ExecuteModule(Charge(result)));
            StringAssert.Contains(fault.Message, "NEP-17 transfer failed");
            Assert.AreEqual(new BigInteger(1000), h.Balance);
            Assert.AreEqual(BigInteger.Zero, h.LastCharged(validator, moduleId),
                "A failed pull must not book the billing period.");
            Assert.AreEqual(BigInteger.Zero, h.Sequence(moduleId, channel));

            Assert.IsTrue(h.ExecuteModule(Charge(true)));
            Assert.AreEqual(new BigInteger(970), h.Balance);
            Assert.IsTrue(h.LastCharged(validator, moduleId) > BigInteger.Zero);

            TestException samePeriod = Assert.ThrowsExactly<TestException>(() => h.ExecuteModule(Charge(true)));
            StringAssert.Contains(samePeriod.Message, "SA_VALIDATION_REJECTED");
            Assert.AreEqual(BigInteger.One, h.Sequence(moduleId, channel),
                "A pull rejected by the period gate must not consume the channel.");
        }
    }

    /// <summary>Every non-canonical or non-positive pull amount is rejected by the validator.</summary>
    [TestMethod]
    public void Subscription_RejectsMalformedAndNonPositiveAmounts()
    {
        foreach (object?[] args in new object?[][]
        {
            new object?[] { Stranger, Merchant, 1 },
            new object?[] { Stranger, Merchant, 1, null, null },
            new object?[] { Stranger, Merchant, -1, null },
            new object?[] { Stranger, Merchant, 0, null },
            new object?[] { Stranger, Merchant, new byte[] { 1 }, null },
            new object?[] { Stranger, Merchant, true, null },
            new object?[] { Stranger, Stranger, 1, null }
        })
        {
            Harness h = new();
            using P256SessionKey key = new();
            UInt160 validator = h.DeployModule("validators/SubscriptionValidator");
            BigInteger moduleId = InstallSubscription(h, key, validator);
            h.Fx.SetSigners(Merchant);

            args[0] = h.Asset; // a well-formed source, so the rejection comes from the pull shape
            object[] op = h.RoutedOp(moduleId, "transfer", args, ChannelKey(SubId));
            op[11] = SubId;
            TestException rejected = Assert.ThrowsExactly<TestException>(() => h.ExecuteModule(op));
            StringAssert.Contains(rejected.Message, "SA_VALIDATION_REJECTED");
        }
    }
}
