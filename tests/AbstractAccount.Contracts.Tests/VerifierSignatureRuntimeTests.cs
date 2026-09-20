using System;
using System.Numerics;
using System.Security.Cryptography;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Valid and invalid signature vectors for the verifier plugins with deterministic local key
/// flows, executed against the compiled contracts through a real Neo VM:
/// SessionKeyVerifier (secp256r1 payload signatures), MultiSigVerifier (threshold over
/// heterogeneous children), and SubscriptionVerifier (nonce/identity binding).
/// </summary>
[TestClass]
public class VerifierSignatureRuntimeTests
{
    private static readonly UInt160 AccountId =
        UInt160.Parse("0x1111111111111111111111111111111111111111");

    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly UInt160 NativeSigner =
        UInt160.Parse("0x5555555555555555555555555555555555555555");

    private static readonly UInt160 Stranger =
        UInt160.Parse("0x9999999999999999999999999999999999999999");

    private sealed class VerifierHarness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Core { get; }

        public UInt160 Target { get; }

        public VerifierHarness()
        {
            Core = Fx.Deploy("MockVerifierCore");
            Target = Fx.Deploy("MockTransferTarget");
        }

        public UInt160 DeployVerifier(string baseName) => Fx.Deploy("verifiers/" + baseName, Core.ToArray());

        public void Configure(UInt160 verifier, string method, params object?[] args) =>
            Fx.CallVoid(Core, "forward", verifier, method, args);

        public object?[] TransferArgs(BigInteger amount) => new object?[] { AccountId, Recipient, amount, null };

        public object[] TransferOp(BigInteger amount, BigInteger nonce, BigInteger deadline, object? signature) =>
            RuntimeFixture.UserOp(Target, "transfer", TransferArgs(amount), nonce, deadline, signature);

        public byte[] SignTransferOp(P256SessionKey key, UInt160 verifier, BigInteger amount, BigInteger nonce, BigInteger deadline)
        {
            byte[] payload = Fx.CallBytes(
                verifier, "getPayload", AccountId, Target, "transfer", TransferArgs(amount), nonce, deadline);
            return key.Sign(payload);
        }
    }

    // ========================================================================
    // SessionKeyVerifier
    // ========================================================================

    private static UInt160 SetUpSessionKey(VerifierHarness h, P256SessionKey key, BigInteger spendingLimit)
    {
        UInt160 verifier = h.DeployVerifier("SessionKeyVerifier");
        BigInteger validUntil = h.Fx.Now() + 86_400_000; // 24h
        h.Configure(verifier, "setSessionKey",
            AccountId, key.CompressedPublicKey, h.Target, "transfer", validUntil, spendingLimit, "vector suite");
        return verifier;
    }

    [TestMethod]
    public void SessionKey_ValidSignature_Validates()
    {
        VerifierHarness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = SetUpSessionKey(h, key, spendingLimit: 0);

        BigInteger deadline = h.Fx.Now() + 600_000;
        byte[] signature = h.SignTransferOp(key, verifier, amount: 1000, nonce: 7, deadline);

        Assert.IsTrue(h.Fx.CallBoolean(
            verifier, "validateSignature", AccountId, h.TransferOp(1000, 7, deadline, signature)));
    }

    [TestMethod]
    public void SessionKey_ClearTakesEffectBeforeLaterValidation()
    {
        VerifierHarness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = SetUpSessionKey(h, key, spendingLimit: 0);

        BigInteger deadline = h.Fx.Now() + 600_000;
        byte[] signature = h.SignTransferOp(key, verifier, 1000, 7, deadline);
        object[] op = h.TransferOp(1000, 7, deadline, signature);

        h.Configure(verifier, "clearSessionKey", AccountId);

        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallBoolean(verifier, "validateSignature", AccountId, op));
        StringAssert.Contains(rejected.Message, "No session key active");
    }

    [TestMethod]
    public void SessionKey_TamperedSignature_IsRejected()
    {
        VerifierHarness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = SetUpSessionKey(h, key, spendingLimit: 0);

        BigInteger deadline = h.Fx.Now() + 600_000;
        byte[] signature = h.SignTransferOp(key, verifier, 1000, 7, deadline);
        signature[10] ^= 0x01;

        Assert.IsFalse(h.Fx.CallBoolean(
            verifier, "validateSignature", AccountId, h.TransferOp(1000, 7, deadline, signature)));
    }

    [TestMethod]
    public void SessionKey_SignatureOverDifferentNonce_IsRejected()
    {
        VerifierHarness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = SetUpSessionKey(h, key, spendingLimit: 0);

        BigInteger deadline = h.Fx.Now() + 600_000;
        byte[] signature = h.SignTransferOp(key, verifier, 1000, nonce: 7, deadline);

        // The payload binds the nonce: a signature for nonce 7 must not authorize nonce 8.
        Assert.IsFalse(h.Fx.CallBoolean(
            verifier, "validateSignature", AccountId, h.TransferOp(1000, 8, deadline, signature)));
    }

    [TestMethod]
    public void SessionKey_ForeignKeySignature_IsRejected()
    {
        VerifierHarness h = new();
        using P256SessionKey authorized = new();
        using P256SessionKey attacker = new();
        UInt160 verifier = SetUpSessionKey(h, authorized, spendingLimit: 0);

        BigInteger deadline = h.Fx.Now() + 600_000;
        byte[] signature = h.SignTransferOp(attacker, verifier, 1000, 7, deadline);

        Assert.IsFalse(h.Fx.CallBoolean(
            verifier, "validateSignature", AccountId, h.TransferOp(1000, 7, deadline, signature)));
    }

    [TestMethod]
    public void SessionKey_MethodOutsideScope_Faults()
    {
        VerifierHarness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = SetUpSessionKey(h, key, spendingLimit: 0);

        BigInteger deadline = h.Fx.Now() + 600_000;
        byte[] signature = h.SignTransferOp(key, verifier, 1000, 7, deadline);
        object[] op = RuntimeFixture.UserOp(h.Target, "burn", h.TransferArgs(1000), 7, deadline, signature);

        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallBoolean(verifier, "validateSignature", AccountId, op));
        StringAssert.Contains(rejected.Message, "Method not permitted");
    }

    [TestMethod]
    public void SessionKey_ExpiredKey_Faults()
    {
        VerifierHarness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = SetUpSessionKey(h, key, spendingLimit: 0);

        BigInteger deadline = h.Fx.Now() + 172_800_000; // beyond key expiry, op deadline is not the gate here
        byte[] signature = h.SignTransferOp(key, verifier, 1000, 7, deadline);

        h.Fx.AdvanceTime(TimeSpan.FromHours(25)); // session key was valid for 24h

        TestException expired = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallBoolean(verifier, "validateSignature", AccountId, h.TransferOp(1000, 7, deadline, signature)));
        StringAssert.Contains(expired.Message, "Session key expired");
    }

    [TestMethod]
    public void SessionKey_TransferAboveSpendingLimit_Faults()
    {
        VerifierHarness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = SetUpSessionKey(h, key, spendingLimit: 1000);

        BigInteger deadline = h.Fx.Now() + 600_000;
        byte[] signature = h.SignTransferOp(key, verifier, amount: 1500, nonce: 7, deadline);

        TestException overLimit = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallBoolean(verifier, "validateSignature", AccountId, h.TransferOp(1500, 7, deadline, signature)));
        StringAssert.Contains(overLimit.Message, "Session key spending limit exceeded");
    }

    // ========================================================================
    // MultiSigVerifier (children: SessionKeyVerifier + NeoNativeVerifier)
    // ========================================================================

    private static (UInt160 MultiSig, UInt160 SessionChild) SetUpMultiSig(VerifierHarness h, P256SessionKey key, int threshold)
    {
        UInt160 sessionChild = SetUpSessionKey(h, key, spendingLimit: 0);
        UInt160 nativeChild = h.DeployVerifier("NeoNativeVerifier");
        h.Configure(nativeChild, "setConfig", AccountId, new object?[] { NativeSigner }, 1);

        UInt160 multiSig = h.DeployVerifier("MultiSigVerifier");
        h.Configure(multiSig, "setConfig", AccountId, new object?[] { sessionChild, nativeChild }, threshold);
        return (multiSig, sessionChild);
    }

    private static byte[] BundleSignatures(VerifierHarness h, byte[]? sessionSignature, byte[]? nativePlaceholder)
    {
        return h.Fx.StdLibSerialize(new object?[] { sessionSignature, nativePlaceholder });
    }

    [TestMethod]
    public void MultiSig_BothChildrenValid_MeetsThreshold()
    {
        VerifierHarness h = new();
        using P256SessionKey key = new();
        (UInt160 multiSig, UInt160 sessionChild) = SetUpMultiSig(h, key, threshold: 2);

        BigInteger deadline = h.Fx.Now() + 600_000;
        byte[] sessionSignature = h.SignTransferOp(key, sessionChild, 1000, 7, deadline);
        byte[] bundle = BundleSignatures(h, sessionSignature, new byte[] { 0x01 });

        h.Fx.SetSigners(NativeSigner); // native child checks the transaction witness
        Assert.IsTrue(h.Fx.CallBoolean(
            multiSig, "validateSignature", AccountId, h.TransferOp(1000, 7, deadline, bundle)));
    }

    [TestMethod]
    public void MultiSig_OneInvalidChild_FailsThreshold()
    {
        VerifierHarness h = new();
        using P256SessionKey key = new();
        (UInt160 multiSig, UInt160 sessionChild) = SetUpMultiSig(h, key, threshold: 2);

        BigInteger deadline = h.Fx.Now() + 600_000;
        byte[] tampered = h.SignTransferOp(key, sessionChild, 1000, 7, deadline);
        tampered[20] ^= 0x01;
        byte[] bundle = BundleSignatures(h, tampered, new byte[] { 0x01 });

        h.Fx.SetSigners(NativeSigner);
        Assert.IsFalse(h.Fx.CallBoolean(
            multiSig, "validateSignature", AccountId, h.TransferOp(1000, 7, deadline, bundle)),
            "One valid child out of two must not meet a 2-of-2 threshold");
    }

    [TestMethod]
    public void MultiSig_MissingNativeWitness_FailsThreshold()
    {
        VerifierHarness h = new();
        using P256SessionKey key = new();
        (UInt160 multiSig, UInt160 sessionChild) = SetUpMultiSig(h, key, threshold: 2);

        BigInteger deadline = h.Fx.Now() + 600_000;
        byte[] sessionSignature = h.SignTransferOp(key, sessionChild, 1000, 7, deadline);
        byte[] bundle = BundleSignatures(h, sessionSignature, new byte[] { 0x01 });

        h.Fx.SetSigners(Stranger); // the authorized native signer did not witness
        Assert.IsFalse(h.Fx.CallBoolean(
            multiSig, "validateSignature", AccountId, h.TransferOp(1000, 7, deadline, bundle)));
    }

    [TestMethod]
    public void MultiSig_ThresholdOne_NativeWitnessAloneSuffices()
    {
        VerifierHarness h = new();
        using P256SessionKey key = new();
        (UInt160 multiSig, UInt160 _) = SetUpMultiSig(h, key, threshold: 1);

        BigInteger deadline = h.Fx.Now() + 600_000;
        byte[] bundle = BundleSignatures(h, null, new byte[] { 0x01 }); // session child abstains

        h.Fx.SetSigners(NativeSigner);
        Assert.IsTrue(h.Fx.CallBoolean(
            multiSig, "validateSignature", AccountId, h.TransferOp(1000, 7, deadline, bundle)));
    }

    [TestMethod]
    public void MultiSig_SignatureArrayLengthMismatch_Faults()
    {
        VerifierHarness h = new();
        using P256SessionKey key = new();
        (UInt160 multiSig, UInt160 _) = SetUpMultiSig(h, key, threshold: 2);

        BigInteger deadline = h.Fx.Now() + 600_000;
        byte[] bundle = h.Fx.StdLibSerialize(new object?[] { new byte[] { 0x01 } }); // 1 entry for 2 children

        TestException mismatch = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallBoolean(multiSig, "validateSignature", AccountId, h.TransferOp(1000, 7, deadline, bundle)));
        StringAssert.Contains(mismatch.Message, "Signature array length mismatch");
    }

    [TestMethod]
    public void MultiSig_EmptyConfig_IsRejected()
    {
        VerifierHarness h = new();
        UInt160 multiSig = h.DeployVerifier("MultiSigVerifier");

        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Configure(multiSig, "setConfig", AccountId, Array.Empty<object?>(), 1));
        StringAssert.Contains(rejected.Message, "Empty verifier list not allowed");
    }

    [TestMethod]
    public void MultiSig_ConfigAboveMaximum_IsRejected()
    {
        VerifierHarness h = new();
        UInt160 multiSig = h.DeployVerifier("MultiSigVerifier");
        object?[] verifiers = new object?[11];
        for (int i = 0; i < verifiers.Length; i++)
        {
            verifiers[i] = UInt160.Parse($"0x{i + 1:X40}");
        }

        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Configure(multiSig, "setConfig", AccountId, verifiers, 1));
        StringAssert.Contains(rejected.Message, "Maximum 10 child verifiers allowed");
    }

    [TestMethod]
    public void MultiSig_ZeroThreshold_IsRejected()
    {
        VerifierHarness h = new();
        UInt160 multiSig = h.DeployVerifier("MultiSigVerifier");
        object?[] verifiers = { UInt160.Parse("0x1010101010101010101010101010101010101010") };

        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Configure(multiSig, "setConfig", AccountId, verifiers, 0));
        StringAssert.Contains(rejected.Message, "Invalid threshold");
    }

    [TestMethod]
    public void MultiSig_ThresholdAboveVerifierCount_IsRejected()
    {
        VerifierHarness h = new();
        UInt160 multiSig = h.DeployVerifier("MultiSigVerifier");
        object?[] verifiers =
        {
            UInt160.Parse("0x2020202020202020202020202020202020202020"),
            UInt160.Parse("0x3030303030303030303030303030303030303030")
        };

        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Configure(multiSig, "setConfig", AccountId, verifiers, 3));
        StringAssert.Contains(rejected.Message, "Invalid threshold");
    }

    [TestMethod]
    public void MultiSig_DuplicateVerifier_IsRejected()
    {
        VerifierHarness h = new();
        UInt160 multiSig = h.DeployVerifier("MultiSigVerifier");
        UInt160 duplicate = UInt160.Parse("0x4040404040404040404040404040404040404040");
        object?[] verifiers = { duplicate, duplicate };

        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Configure(multiSig, "setConfig", AccountId, verifiers, 2));
        StringAssert.Contains(rejected.Message, "Duplicate verifier");
    }

    [TestMethod]
    public void MultiSig_RejectsSelfAndIncompleteChildModulesBeforeStorage()
    {
        VerifierHarness h = new();
        UInt160 multiSig = h.DeployVerifier("MultiSigVerifier");
        UInt160 markerOnly = h.Fx.Deploy("MarkerOnlyModule");

        TestException self = Assert.ThrowsExactly<TestException>(() =>
            h.Configure(multiSig, "setConfig", AccountId, new object?[] { multiSig }, 1));
        StringAssert.Contains(self.Message, "MultiSig verifier cannot contain itself");

        TestException incomplete = Assert.ThrowsExactly<TestException>(() =>
            h.Configure(multiSig, "setConfig", AccountId, new object?[] { markerOnly }, 1));
        StringAssert.Contains(incomplete.Message, "Child verifier validation ABI missing");
    }

    // ========================================================================
    // SubscriptionVerifier
    // ========================================================================

    private static readonly UInt160 Merchant =
        UInt160.Parse("0x2222222222222222222222222222222222222222");

    private static readonly byte[] SubId = { 0xAB, 0xCD, 0xEF, 0x01 };

    private const long SubscriptionAmount = 1000;
    private const long PeriodSeconds = 2_592_000; // 30 days
    private static readonly BigInteger PeriodMs = (BigInteger)PeriodSeconds * 1000;

    private static UInt160 SetUpSubscription(VerifierHarness h)
    {
        UInt160 verifier = h.DeployVerifier("SubscriptionVerifier");
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds((double)PeriodMs)); // ensure currentPeriod > 0
        h.Configure(verifier, "createSubscription",
            AccountId, SubId, Merchant, h.Target, (BigInteger)SubscriptionAmount, (BigInteger)PeriodSeconds);
        // The merchant pulls the charge, so the merchant witness rides on the transaction.
        h.Fx.SetSigners(Merchant);
        return verifier;
    }

    // A subscription pull moves the account's assets, which live at the core-derived proxy
    // script hash rather than at the account id; the verifier rejects any other source.
    private static object[] SubscriptionOp(VerifierHarness h, byte[] subId, BigInteger nonce) =>
        RuntimeFixture.UserOp(
            h.Target, "transfer",
            new object?[] { h.Fx.CallUInt160(h.Core, "getProxyScriptHash", AccountId), Merchant, (BigInteger)SubscriptionAmount },
            nonce, BigInteger.Zero, subId);

    /// <summary>
    /// Reproduces the verifier's canonical ERC-4337 2D nonce derivation:
    /// (subTag &lt;&lt; 64) + nonceCounter, where subTag is the first eight bytes of SHA-256(subId)
    /// read big-endian and forms the per-subscription channel, and nonceCounter is the in-channel
    /// sequence. The billing period is enforced separately and is not encoded in the nonce.
    /// </summary>
    private static BigInteger ExpectedSubscriptionNonce(byte[] subId, BigInteger currentPeriod, BigInteger nonceCounter)
    {
        _ = currentPeriod;
        byte[] digest = SHA256.HashData(subId);
        BigInteger subTag = 0;
        for (int i = 0; i < 8 && i < digest.Length; i++)
        {
            subTag = (subTag << 8) + digest[i];
        }
        return (subTag << 64) + nonceCounter;
    }

    [TestMethod]
    public void Subscription_ValidChargeVector_Validates()
    {
        VerifierHarness h = new();
        UInt160 verifier = SetUpSubscription(h);

        BigInteger period = h.Fx.Now() / PeriodMs;
        BigInteger nonce = ExpectedSubscriptionNonce(SubId, period, nonceCounter: 0);

        Assert.IsTrue(h.Fx.CallBoolean(verifier, "validateSignature", AccountId, SubscriptionOp(h, SubId, nonce)));
    }

    [TestMethod]
    public void Subscription_UnknownSubscriptionId_Faults()
    {
        VerifierHarness h = new();
        UInt160 verifier = SetUpSubscription(h);

        byte[] unknownSubId = { 0x01, 0x02, 0x03, 0x04 };
        BigInteger period = h.Fx.Now() / PeriodMs;
        BigInteger nonce = ExpectedSubscriptionNonce(unknownSubId, period, nonceCounter: 0);

        TestException unknown = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallBoolean(verifier, "validateSignature", AccountId, SubscriptionOp(h, unknownSubId, nonce)));
        StringAssert.Contains(unknown.Message, "Subscription not found");
    }

    [TestMethod]
    public void Subscription_NonceNotBoundToPeriodAndCounter_Faults()
    {
        VerifierHarness h = new();
        UInt160 verifier = SetUpSubscription(h);

        BigInteger period = h.Fx.Now() / PeriodMs;
        BigInteger wrongNonce = ExpectedSubscriptionNonce(SubId, period, nonceCounter: 0) + 1;

        TestException mismatch = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallBoolean(verifier, "validateSignature", AccountId, SubscriptionOp(h, SubId, wrongNonce)));
        StringAssert.Contains(mismatch.Message, "Subscription nonce mismatch");
    }
}
