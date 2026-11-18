using System;
using System.Numerics;
using System.Security.Cryptography;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Audit candidate F-3 (subscription subId permanent failure):
/// <c>SubscriptionVerifier</c> derives its expected nonce as (SHA256(subId)[0..8] &lt;&lt; 64) +
/// local counter, while the SA core's channel cursor for that same subTag channel is never
/// deleted. <c>ClearAccount</c> wipes the verifier's local counter, so after a verifier
/// uninstall/reinstall (clearAccount via confirmVerifierUpdate) and re-creating the SAME
/// subscription id, the local counter (0) can never again line up with the surviving core
/// cursor — every pull faults. The two exact-match checks (core sequence == cursor, verifier
/// nonce == subTag&lt;&lt;64 + local counter) also mean there is no path where a lowered local
/// counter lets an already-consumed charge pass again: this is an availability defect, not a
/// double-spend.
/// </summary>
[TestClass]
public class Fix_SubscriptionSubIdReproTests
{
    private static readonly UInt160 BackupOwner =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Merchant =
        UInt160.Parse("0x2222222222222222222222222222222222222222");

    // Two distinct subscription ids: the affected one and the control.
    private static readonly byte[] SubIdA = { 0xAB, 0xCD, 0xEF, 0x01 };
    private static readonly byte[] SubIdB = { 0x12, 0x34, 0x56, 0x78 };

    private const long Amount = 1000;
    private const long PeriodSeconds = 3600;
    private const uint EscapeTimelockSeconds = 2_592_000;
    private static readonly TimeSpan ConfigUpdateWindow = TimeSpan.FromHours(24);

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Token { get; }

        public UInt160 Verifier { get; }

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            Token = Fx.Deploy("MockTransferTarget");
            Verifier = Fx.Deploy("verifiers/SubscriptionVerifier", Wallet.ToArray());
        }

        public UInt160 RegisterAccount()
        {
            UInt160 accountId = Fx.CallUInt160(
                Wallet, "computeRegistrationAccountId",
                Verifier, Array.Empty<byte>(), UInt160.Zero, BackupOwner, EscapeTimelockSeconds);
            Fx.SetSigners(BackupOwner);
            Fx.CallVoid(
                Wallet, "registerAccount",
                accountId, Verifier, Array.Empty<byte>(), UInt160.Zero, BackupOwner, EscapeTimelockSeconds);
            return accountId;
        }

        /// <summary>Creates (or re-creates) a subscription through the core's 24h pending-call path.</summary>
        public void CreateSubscription(UInt160 accountId, byte[] subId)
        {
            object?[] config =
            {
                accountId, subId, Merchant, Token, (BigInteger)Amount, (BigInteger)PeriodSeconds
            };
            Fx.SetSigners(BackupOwner);
            Assert.IsFalse(Fx.CallBoolean(Wallet, "callVerifier", accountId, "createSubscription", config),
                "The first callVerifier invocation must only stage the pending createSubscription call");
            Fx.AdvanceTime(ConfigUpdateWindow);
            Fx.SetSigners(BackupOwner);
            Fx.CallVoid(Wallet, "callVerifier", accountId, "createSubscription", config);
        }

        public object[] ChargeOpFor(byte[] subId, UInt160 accountId, BigInteger nonce)
        {
            UInt160 proxy = Fx.CallUInt160(Wallet, "getProxyScriptHash", accountId);
            return RuntimeFixture.UserOp(
                Token, "transfer",
                new object?[] { proxy, Merchant, (BigInteger)Amount, null },
                nonce, Fx.Now() + 3_600_000, subId);
        }

        /// <summary>Merchant pull: executeUserOp with the merchant's witness attached.</summary>
        public bool Charge(UInt160 accountId, byte[] subId, BigInteger nonce)
        {
            Fx.SetSigners(Merchant);
            return Fx.CallBoolean(Wallet, "executeUserOp", accountId, ChargeOpFor(subId, accountId, nonce));
        }

        /// <summary>
        /// Uninstalls the verifier (confirmVerifierUpdate routes clearAccount through the core,
        /// wiping the subscription config, local nonce counters and last-period markers) and
        /// reinstalls the same SubscriptionVerifier immediately afterwards.
        /// </summary>
        public void ClearVerifierState(UInt160 accountId)
        {
            Fx.SetSigners(BackupOwner);
            Fx.CallVoid(Wallet, "updateVerifier", accountId, UInt160.Zero, Array.Empty<byte>());
            Assert.IsTrue(Fx.CallBoolean(Wallet, "hasPendingVerifierUpdate", accountId));
            Fx.AdvanceTime(ConfigUpdateWindow);
            Fx.SetSigners(BackupOwner);
            Fx.CallVoid(Wallet, "confirmVerifierUpdate", accountId);
            Assert.AreEqual(UInt160.Zero, Fx.CallUInt160(Wallet, "getVerifier", accountId),
                "The SubscriptionVerifier must be detached");

            // Reinstall: with no verifier bound, updateVerifier takes effect immediately.
            Fx.SetSigners(BackupOwner);
            Fx.CallVoid(Wallet, "updateVerifier", accountId, Verifier, Array.Empty<byte>());
            Assert.AreEqual(Verifier, Fx.CallUInt160(Wallet, "getVerifier", accountId),
                "The same SubscriptionVerifier must be reinstalled");
        }

        public BigInteger GetNonce(UInt160 accountId, BigInteger channel) =>
            Fx.CallInteger(Wallet, "getNonce", accountId, channel);
    }

    /// <summary>
    /// Reproduces the verifier's channel derivation: the first eight bytes of SHA-256(subId),
    /// read big-endian, form the per-subscription nonce channel.
    /// </summary>
    private static BigInteger SubTag(byte[] subId)
    {
        byte[] digest = SHA256.HashData(subId);
        BigInteger tag = 0;
        for (int i = 0; i < 8; i++)
        {
            tag = (tag << 8) + digest[i];
        }
        return tag;
    }

    /// <summary>
    /// F-3 main repro: one successful charge leaves the core's subTag channel cursor at 1;
    /// clearAccount (verifier uninstall) resets the verifier's local counter to 0; re-creating
    /// the SAME subId then leaves the two sides permanently misaligned. Sequence 0 (what the
    /// verifier demands) is rejected by the core cursor; sequence 1 (what the core demands) is
    /// rejected by the verifier's reset counter. The subscription id is bricked forever.
    /// </summary>
    [TestMethod]
    public void SameSubId_IsPermanentlyUnusableAfterClearAccount()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount();
        h.CreateSubscription(accountId, SubIdA);

        BigInteger subTag = SubTag(SubIdA);
        BigInteger nonce0 = subTag << 64;

        // Charge #1 succeeds: both the core cursor and the verifier's local counter become 1.
        Assert.IsTrue(h.Charge(accountId, SubIdA, nonce0), "The first charge must succeed");
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, subTag),
            "Core cursor for the subTag channel is now 1");

        // clearAccount via verifier uninstall wipes the local counter/last-period markers.
        h.ClearVerifierState(accountId);
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, subTag),
            "The core nonce cursor must survive clearAccount — it is never deleted anywhere");

        // Re-create the SAME subscription id on the reinstalled verifier.
        h.CreateSubscription(accountId, SubIdA);

        // Merchant pull with the verifier's fresh local counter (sequence 0): the core rejects it
        // because the channel cursor is already 1.
        TestException counterZero = Assert.ThrowsExactly<TestException>(
            () => h.Charge(accountId, SubIdA, nonce0),
            "The local counter's expected nonce must be refused by the surviving core cursor");
        StringAssert.Contains(counterZero.Message, "Invalid sequence for channel");

        // Merchant pull adapted to the core cursor (sequence 1): the core accepts the sequence but
        // the verifier's reset local counter demands sequence 0.
        TestException cursorOne = Assert.ThrowsExactly<TestException>(
            () => h.Charge(accountId, SubIdA, nonce0 + 1),
            "The core cursor's expected nonce must be refused by the reset local counter");
        StringAssert.Contains(cursorOne.Message, "Subscription nonce mismatch");

        // No path advances: the subId channel is permanently stuck between the two exact matches,
        // and the already-consumed charge (nonce0) cannot be replayed either — fail-safe.
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, subTag),
            "Neither failed pull may move the cursor; the subId can never charge again");
    }

    /// <summary>
    /// Control: a DIFFERENT subscription id created after the clearAccount gets a fresh core
    /// channel (cursor 0) and a fresh local counter (0), so it keeps working. Only the subId
    /// that was live across the clear is affected.
    /// </summary>
    [TestMethod]
    public void DifferentSubId_StillWorksAfterClearAccount()
    {
        Harness h = new();
        UInt160 accountId = h.RegisterAccount();
        h.CreateSubscription(accountId, SubIdA);

        BigInteger subTagA = SubTag(SubIdA);
        Assert.IsTrue(h.Charge(accountId, SubIdA, subTagA << 64), "The first charge must succeed");
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, subTagA));

        h.ClearVerifierState(accountId);

        h.CreateSubscription(accountId, SubIdB);
        BigInteger subTagB = SubTag(SubIdB);
        Assert.AreEqual(BigInteger.Zero, h.GetNonce(accountId, subTagB),
            "A fresh subId gets a fresh core channel");

        Assert.IsTrue(h.Charge(accountId, SubIdB, subTagB << 64),
            "Only the previously-charged subId is affected; a new subId must keep working");
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, subTagB));
    }
}
