using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Behavioral VM tests for <c>UnifiedSmartWalletV3.ExecuteUserOp</c>: the happy path, replay
/// protection, deadline expiry, witness enforcement on the native fallback path, the verifier
/// delegation path with real secp256r1 signatures, and the escape-hatch interaction that only
/// the backup owner may implicitly cancel an active escape by executing.
/// </summary>
[TestClass]
public class ExecuteUserOpRuntimeTests
{
    private static readonly UInt160 BackupOwner =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Stranger =
        UInt160.Parse("0x9999999999999999999999999999999999999999");

    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private const uint EscapeTimelockSeconds = 2_592_000;

    private sealed class WalletHarness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Target { get; }

        public UInt160 Core { get; }

        public WalletHarness()
        {
            Wallet = Fx.Deploy("UnifiedSmartWalletV3");
            Target = Fx.Deploy("MockTransferTarget");
            Core = Fx.Deploy("MockVerifierCore");
        }

        public UInt160 RegisterAccount(UInt160 verifier, UInt160 backupOwner, uint escapeTimelock)
        {
            UInt160 accountId = Fx.CallUInt160(
                Wallet, "computeRegistrationAccountId",
                verifier, Array.Empty<byte>(), UInt160.Zero, backupOwner, escapeTimelock);

            Fx.SetSigners(backupOwner);
            Fx.CallVoid(
                Wallet, "registerAccount",
                accountId, verifier, Array.Empty<byte>(), UInt160.Zero, backupOwner, escapeTimelock);
            return accountId;
        }

        public object?[] TransferArgs(UInt160 accountId) => new object?[] { accountId, Recipient, (BigInteger)1000, null };

        public object[] TransferOp(UInt160 accountId, BigInteger nonce, BigInteger deadline, object? signature = null) =>
            RuntimeFixture.UserOp(Target, "transfer", TransferArgs(accountId), nonce, deadline, signature ?? Array.Empty<byte>());

        public bool ExecuteUserOp(UInt160 accountId, object[] op) =>
            Fx.CallBoolean(Wallet, "executeUserOp", accountId, op);

        public BigInteger GetNonce(UInt160 accountId, BigInteger channel) =>
            Fx.CallInteger(Wallet, "getNonce", accountId, channel);

        /// <summary>
        /// Deploys a SessionKeyVerifier bound to the mock AA core, registers a wallet account
        /// using it, and authorizes <paramref name="key"/> for transfer calls on the mock target.
        /// </summary>
        public UInt160 RegisterSessionKeyAccount(P256SessionKey key, out UInt160 verifier)
        {
            verifier = Fx.Deploy("verifiers/SessionKeyVerifier", Core.ToArray());
            UInt160 accountId = RegisterAccount(verifier, BackupOwner, EscapeTimelockSeconds);

            BigInteger validUntil = Fx.Now() + 86_400_000; // 24h
            Fx.CallVoid(Core, "forward", verifier, "setSessionKey", new object?[]
            {
                accountId, key.CompressedPublicKey, Target, "transfer", validUntil, BigInteger.Zero, "runtime suite"
            });
            return accountId;
        }

        public byte[] SignTransferOp(P256SessionKey key, UInt160 verifier, UInt160 accountId, BigInteger nonce, BigInteger deadline)
        {
            byte[] payload = Fx.CallBytes(
                verifier, "getPayload", accountId, Target, "transfer", TransferArgs(accountId), nonce, deadline);
            return key.Sign(payload);
        }
    }

    [TestMethod]
    [DataRow(false, false, true)]
    [DataRow(true, false, false)]
    [DataRow(false, true, false)]
    public void ExecuteUserOp_VerifyContextIsAccountAndTargetScoped(
        bool otherAccount, bool indirectCaller, bool expected)
    {
        WalletHarness h = new();
        UInt160 accountId = h.RegisterAccount(UInt160.Zero, BackupOwner, EscapeTimelockSeconds);
        UInt160 otherId = h.RegisterAccount(UInt160.Zero, Stranger, EscapeTimelockSeconds);
        // A second deployment with a different sender gives the nested caller
        // a distinct script hash without mocking AA's verification result.
        h.Fx.SetSigners(Stranger);
        UInt160 relay = h.Fx.Deploy("MockVerifierCore");
        h.Fx.Engine.SetTransactionSigners(new Signer
        {
            Account = BackupOwner,
            Scopes = WitnessScope.CustomContracts,
            AllowedContracts = new[] { h.Wallet },
        });
        UInt160 checkedId = otherAccount ? otherId : accountId;
        object?[] verifyArgs = { h.Wallet, "verify", new object?[] { checkedId } };
        object?[] args = indirectCaller
            ? new object?[] { relay, "forward", verifyArgs }
            : verifyArgs;
        object[] op = RuntimeFixture.UserOp(h.Core, "forward", args,
            BigInteger.Zero, h.Fx.Now() + 60_000, Array.Empty<byte>());

        Assert.AreEqual(expected, h.ExecuteUserOp(accountId, op));
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, 0));
        Assert.AreEqual(BigInteger.Zero, h.GetNonce(otherId, 0));
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isExecutionActive", accountId));
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "forward", h.Wallet, "verify",
            new object?[] { accountId }), "Target authority must end with the operation");
    }

    [TestMethod]
    public void ExecuteUserOp_WrongOwnerScopeDoesNotConsumeNonceOrLeaveAuthority()
    {
        WalletHarness h = new();
        UInt160 accountId = h.RegisterAccount(UInt160.Zero, BackupOwner, EscapeTimelockSeconds);
        var signer = new Signer
        {
            Account = BackupOwner,
            Scopes = WitnessScope.CustomContracts,
            AllowedContracts = new[] { h.Core },
        };
        h.Fx.Engine.SetTransactionSigners(signer);
        object[] op = RuntimeFixture.UserOp(h.Core, "forward",
            new object?[] { h.Wallet, "verify", new object?[] { accountId } },
            BigInteger.Zero, h.Fx.Now() + 60_000, Array.Empty<byte>());
        TestException rejected = Assert.ThrowsExactly<TestException>(() => h.ExecuteUserOp(accountId, op));
        StringAssert.Contains(rejected.Message, "Native witness failed");
        Assert.AreEqual(BigInteger.Zero, h.GetNonce(accountId, 0));
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isExecutionActive", accountId));
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "forward", h.Wallet, "verify",
            new object?[] { accountId }));

        signer.AllowedContracts = new[] { h.Wallet };
        h.Fx.Engine.SetTransactionSigners(signer);
        Assert.IsTrue(h.ExecuteUserOp(accountId, op));
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, 0));
    }

    [TestMethod]
    public void ExecuteUserOp_NativeFallback_ExecutesAndConsumesChannelNonce()
    {
        WalletHarness h = new();
        UInt160 accountId = h.RegisterAccount(UInt160.Zero, BackupOwner, EscapeTimelockSeconds);

        h.Fx.SetSigners(BackupOwner);
        BigInteger deadline = h.Fx.Now() + 3_600_000;

        Assert.AreEqual(BigInteger.Zero, h.GetNonce(accountId, 0), "Fresh account starts at sequence 0");
        Assert.IsTrue(h.ExecuteUserOp(accountId, h.TransferOp(accountId, nonce: 0, deadline)),
            "Mock transfer target should report success");
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, 0), "Channel 0 sequence advances exactly once");
    }

    [TestMethod]
    public void RegisterAccount_AcceptsRecoveryVerifierWithV3Marker()
    {
        WalletHarness h = new();
        UInt160 recoveryVerifier = h.Fx.Deploy("SocialRecoveryVerifier");
        h.Fx.CallVoid(recoveryVerifier, "setAuthorizedCore", h.Wallet);
        UInt160 accountId = h.Fx.CallUInt160(
            h.Wallet, "computeRegistrationAccountId",
            recoveryVerifier, Array.Empty<byte>(), UInt160.Zero, BackupOwner, EscapeTimelockSeconds);

        h.Fx.SetSigners(BackupOwner);
        h.Fx.CallVoid(
            h.Wallet, "registerAccount",
            accountId, recoveryVerifier, Array.Empty<byte>(), UInt160.Zero, BackupOwner, EscapeTimelockSeconds);

        Assert.AreEqual(recoveryVerifier, h.Fx.CallUInt160(h.Wallet, "getVerifier", accountId));
    }

    [TestMethod]
    public void ExecuteUserOp_RecoveryVerifier_EnforcesOwnerAndCoreContext()
    {
        WalletHarness h = new();
        UInt160 recoveryVerifier = h.Fx.Deploy("SocialRecoveryVerifier");
        h.Fx.CallVoid(recoveryVerifier, "setAuthorizedCore", h.Wallet);

        UInt160 accountId = h.Fx.CallUInt160(
            h.Wallet, "computeRegistrationAccountId",
            recoveryVerifier, Array.Empty<byte>(), UInt160.Zero, BackupOwner, EscapeTimelockSeconds);

        h.Fx.SetSigners(BackupOwner);
        h.Fx.CallVoid(
            h.Wallet, "registerAccount",
            accountId, recoveryVerifier, Array.Empty<byte>(), UInt160.Zero, BackupOwner, EscapeTimelockSeconds);

        using P256SessionKey morpheusKey = new();
        byte[] factor = new byte[32];
        for (int i = 0; i < factor.Length; i++) factor[i] = (byte)(i + 1);
        h.Fx.CallVoid(
            recoveryVerifier,
            "setupRecovery",
            accountId.ToArray(),
            accountId.ToString(),
            "neo3-testnet",
            BackupOwner,
            h.Wallet,
            accountId,
            Recipient,
            new object?[] { factor },
            (BigInteger)1,
            (ulong)604_800_000,
            morpheusKey.CompressedPublicKey);

        BigInteger deadline = h.Fx.Now() + 3_600_000;
        object[] op = h.TransferOp(accountId, nonce: 0, deadline);

        h.Fx.SetSigners(Stranger);
        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteUserOp(accountId, op),
            "An unrelated witness must not authorize the recovery-bound account");
        StringAssert.Contains(rejected.Message, "Verifier rejected signature");
        Assert.AreEqual(BigInteger.Zero, h.GetNonce(accountId, 0));

        TestException directValidate = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallBoolean(recoveryVerifier, "validateSignature", accountId, op),
            "validateSignature must only run inside the bound AA Core execution context");
        StringAssert.Contains(directValidate.Message, "Unauthorized AA core caller");

        TestException directPost = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(recoveryVerifier, "postExecute", accountId, op, true),
            "postExecute must only run inside the bound AA Core execution context");
        StringAssert.Contains(directPost.Message, "Unauthorized AA core caller");

        h.Fx.SetSigners(BackupOwner);
        Assert.IsTrue(h.ExecuteUserOp(accountId, op));
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, 0));
    }

    [TestMethod]
    public void ExecuteUserOp_RejectsReplayedNonce()
    {
        WalletHarness h = new();
        UInt160 accountId = h.RegisterAccount(UInt160.Zero, BackupOwner, EscapeTimelockSeconds);

        h.Fx.SetSigners(BackupOwner);
        BigInteger deadline = h.Fx.Now() + 3_600_000;
        object[] op = h.TransferOp(accountId, nonce: 0, deadline);

        Assert.IsTrue(h.ExecuteUserOp(accountId, op));

        TestException replay = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteUserOp(accountId, op),
            "Replaying a consumed nonce must fault");
        StringAssert.Contains(replay.Message, "Invalid sequence for channel");
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, 0), "Failed replay must not advance the sequence");
    }

    [TestMethod]
    public void ExecuteUserOp_ParallelChannel_AdvancesIndependentlyOfChannelZero()
    {
        WalletHarness h = new();
        UInt160 accountId = h.RegisterAccount(UInt160.Zero, BackupOwner, EscapeTimelockSeconds);

        h.Fx.SetSigners(BackupOwner);
        BigInteger deadline = h.Fx.Now() + 3_600_000;

        // Channel 1 is a parallel lane: nonce = (channel << 64) | sequence. Its cursor must be
        // reachable and independent of channel 0 — under the old value-threshold split this lane
        // was dead because nonce >> 64 was always 0 for sub-threshold nonces.
        BigInteger channelOneSeq0 = BigInteger.One << 64;

        Assert.AreEqual(BigInteger.Zero, h.GetNonce(accountId, 1), "Fresh channel 1 starts at sequence 0");

        // Consume channel 0 once; channel 1 must stay untouched.
        Assert.IsTrue(h.ExecuteUserOp(accountId, h.TransferOp(accountId, nonce: 0, deadline)));
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, 0), "Channel 0 advances");
        Assert.AreEqual(BigInteger.Zero, h.GetNonce(accountId, 1), "Channel 0 activity must not touch channel 1");

        // Channel 1, sequence 0 is accepted and advances ONLY channel 1.
        Assert.IsTrue(h.ExecuteUserOp(accountId, h.TransferOp(accountId, nonce: channelOneSeq0, deadline)));
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, 1), "Channel 1 sequence advances exactly once");
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, 0), "Channel 1 activity must not touch channel 0");

        // Channel 1, sequence 1 (the successor) is accepted next.
        Assert.IsTrue(h.ExecuteUserOp(accountId, h.TransferOp(accountId, nonce: channelOneSeq0 + 1, deadline)));
        Assert.AreEqual((BigInteger)2, h.GetNonce(accountId, 1), "Channel 1 advances independently of channel 0");
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, 0), "Channel 0 remains at its own cursor");
    }

    [TestMethod]
    public void ExecuteUserOp_ParallelChannel_RejectsReplayedSequence()
    {
        WalletHarness h = new();
        UInt160 accountId = h.RegisterAccount(UInt160.Zero, BackupOwner, EscapeTimelockSeconds);

        h.Fx.SetSigners(BackupOwner);
        BigInteger deadline = h.Fx.Now() + 3_600_000;
        BigInteger channelOneSeq0 = BigInteger.One << 64;
        object[] op = h.TransferOp(accountId, nonce: channelOneSeq0, deadline);

        Assert.IsTrue(h.ExecuteUserOp(accountId, op));

        TestException replay = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteUserOp(accountId, op),
            "Replaying a consumed channel-1 sequence must fault");
        StringAssert.Contains(replay.Message, "Invalid sequence for channel");
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, 1), "Failed replay must not advance the channel-1 cursor");
    }

    [TestMethod]
    public void ExecuteUserOp_ParallelChannel_RejectsOutOfOrderSequence()
    {
        WalletHarness h = new();
        UInt160 accountId = h.RegisterAccount(UInt160.Zero, BackupOwner, EscapeTimelockSeconds);

        h.Fx.SetSigners(BackupOwner);
        BigInteger deadline = h.Fx.Now() + 3_600_000;
        BigInteger channelOneSeq0 = BigInteger.One << 64;

        // Skipping sequence 0 (the fresh cursor) and presenting sequence 1 first must be rejected.
        TestException gap = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteUserOp(accountId, h.TransferOp(accountId, nonce: channelOneSeq0 + 1, deadline)),
            "An out-of-order channel-1 sequence must fault");
        StringAssert.Contains(gap.Message, "Invalid sequence for channel");
        Assert.AreEqual(BigInteger.Zero, h.GetNonce(accountId, 1), "A rejected out-of-order op must not advance the cursor");
    }

    [TestMethod]
    public void ExecuteUserOp_RejectsExpiredDeadline()
    {
        WalletHarness h = new();
        UInt160 accountId = h.RegisterAccount(UInt160.Zero, BackupOwner, EscapeTimelockSeconds);

        h.Fx.SetSigners(BackupOwner);
        BigInteger expiredDeadline = h.Fx.Now() - 1;

        TestException expired = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteUserOp(accountId, h.TransferOp(accountId, nonce: 0, expiredDeadline)),
            "An op past its deadline must fault");
        StringAssert.Contains(expired.Message, "UserOp expired");
        Assert.AreEqual(BigInteger.Zero, h.GetNonce(accountId, 0), "Expired op must not consume the nonce");
    }

    [TestMethod]
    public void ExecuteUserOp_NativeFallback_RejectsMissingBackupOwnerWitness()
    {
        WalletHarness h = new();
        UInt160 accountId = h.RegisterAccount(UInt160.Zero, BackupOwner, EscapeTimelockSeconds);

        h.Fx.SetSigners(Stranger);
        BigInteger deadline = h.Fx.Now() + 3_600_000;

        TestException unauthorized = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteUserOp(accountId, h.TransferOp(accountId, nonce: 0, deadline)),
            "Without a verifier, only the backup owner witness may execute");
        StringAssert.Contains(unauthorized.Message, "Native witness failed");
    }

    [TestMethod]
    public void ExecuteUserOp_VerifierPath_AcceptsValidSessionSignatureWithoutOwnerWitness()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 accountId = h.RegisterSessionKeyAccount(key, out UInt160 verifier);

        BigInteger deadline = h.Fx.Now() + 3_600_000;
        byte[] signature = h.SignTransferOp(key, verifier, accountId, nonce: 0, deadline);

        // The session key alone authorizes — no backup-owner witness attached.
        h.Fx.SetSigners(Stranger);
        Assert.IsTrue(h.ExecuteUserOp(accountId, h.TransferOp(accountId, 0, deadline, signature)));
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, 0));
    }

    [TestMethod]
    public void ExecuteUserOp_VerifierPath_RejectsTamperedSessionSignature()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 accountId = h.RegisterSessionKeyAccount(key, out UInt160 verifier);

        BigInteger deadline = h.Fx.Now() + 3_600_000;
        byte[] signature = h.SignTransferOp(key, verifier, accountId, nonce: 0, deadline);
        signature[0] ^= 0xFF;

        h.Fx.SetSigners(Stranger);
        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteUserOp(accountId, h.TransferOp(accountId, 0, deadline, signature)),
            "A tampered session signature must fault execution");
        StringAssert.Contains(rejected.Message, "Verifier rejected signature");
        Assert.AreEqual(BigInteger.Zero, h.GetNonce(accountId, 0), "Rejected op must not consume the nonce");
    }

    [TestMethod]
    public void ExecuteUserOp_ActiveEscape_OnlyBackupOwnerWitnessMayExecute()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 accountId = h.RegisterSessionKeyAccount(key, out UInt160 verifier);

        h.Fx.SetSigners(BackupOwner);
        h.Fx.CallVoid(h.Wallet, "initiateEscape", accountId);
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isEscapeActive", accountId));

        BigInteger deadline = h.Fx.Now() + 3_600_000;
        byte[] signature = h.SignTransferOp(key, verifier, accountId, nonce: 0, deadline);
        object[] op = h.TransferOp(accountId, 0, deadline, signature);

        // A valid verifier signature is NOT enough while an escape is pending: an attacker who
        // compromised the session key must not be able to silently cancel the escape hatch.
        h.Fx.SetSigners(Stranger);
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteUserOp(accountId, op),
            "Execution during an active escape requires the backup owner witness");
        StringAssert.Contains(blocked.Message, "Only backup owner can cancel escape");
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isEscapeActive", accountId), "Escape must survive the rejected op");

        // The backup owner executing the same operation implicitly cancels the escape.
        h.Fx.SetSigners(BackupOwner);
        Assert.IsTrue(h.ExecuteUserOp(accountId, op));
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isEscapeActive", accountId), "Owner execution cancels the escape");
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId, 0));
    }
}
