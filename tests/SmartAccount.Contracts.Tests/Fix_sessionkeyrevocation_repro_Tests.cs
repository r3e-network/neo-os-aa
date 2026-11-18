using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Audit candidate F-2 (revocation replay): <c>VerifierPayload.BuildPayload</c> binds only
/// network / verifier / core / account / target / method / args / nonce / deadline — there is no
/// configuration epoch or revocation generation in the signed payload. A session-key signature
/// produced while a key was authorized therefore stays cryptographically valid after the key is
/// revoked, provided the SAME key is later re-granted and the op's nonce channel cursor has not
/// moved. These tests execute the compiled V3 contracts through the real engine.
/// </summary>
[TestClass]
public class Fix_SessionKeyRevocationReproTests
{
    private static readonly UInt160 BackupOwner =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Stranger =
        UInt160.Parse("0x9999999999999999999999999999999999999999");

    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private const uint EscapeTimelockSeconds = 2_592_000;

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Target { get; }

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            Target = Fx.Deploy("MockTransferTarget");
        }

        public UInt160 DeploySessionKeyVerifier() => Fx.Deploy("verifiers/SessionKeyVerifier", Wallet.ToArray());

        public UInt160 RegisterAccount(UInt160 verifier)
        {
            UInt160 accountId = Fx.CallUInt160(
                Wallet, "computeRegistrationAccountId",
                verifier, Array.Empty<byte>(), UInt160.Zero, BackupOwner, EscapeTimelockSeconds);
            Fx.SetSigners(BackupOwner);
            Fx.CallVoid(
                Wallet, "registerAccount",
                accountId, verifier, Array.Empty<byte>(), UInt160.Zero, BackupOwner, EscapeTimelockSeconds);
            return accountId;
        }

        /// <summary>Grants (or re-grants) a session key through the core's 24h pending-call path.</summary>
        public void GrantSessionKey(UInt160 verifier, UInt160 accountId, P256SessionKey key)
        {
            BigInteger validUntil = Fx.Now() + 25L * 24 * 60 * 60 * 1000;
            object?[] config =
            {
                accountId, key.CompressedPublicKey, Target, "transfer", validUntil, BigInteger.Zero, "F-2 repro"
            };
            Fx.SetSigners(BackupOwner);
            Assert.IsFalse(Fx.CallBoolean(Wallet, "callVerifier", accountId, "setSessionKey", config),
                "The first callVerifier invocation must only stage the pending session-key call");
            Fx.AdvanceTime(TimeSpan.FromHours(24));
            Fx.SetSigners(BackupOwner);
            Fx.CallVoid(Wallet, "callVerifier", accountId, "setSessionKey", config);
        }

        /// <summary>Revokes the session key through the core's 24h pending-call path.</summary>
        public void RevokeSessionKey(UInt160 accountId)
        {
            object?[] config = { accountId };
            Fx.SetSigners(BackupOwner);
            Assert.IsFalse(Fx.CallBoolean(Wallet, "callVerifier", accountId, "clearSessionKey", config),
                "The first callVerifier invocation must only stage the pending clearSessionKey call");
            Fx.AdvanceTime(TimeSpan.FromHours(24));
            Fx.SetSigners(BackupOwner);
            Fx.CallVoid(Wallet, "callVerifier", accountId, "clearSessionKey", config);
        }

        /// <summary>Uninstalls and reinstalls the verifier via updateVerifier/confirmVerifierUpdate.</summary>
        public void UninstallAndReinstallVerifier(UInt160 accountId, UInt160 verifier)
        {
            Fx.SetSigners(BackupOwner);
            Fx.CallVoid(Wallet, "updateVerifier", accountId, UInt160.Zero, Array.Empty<byte>());
            Assert.IsTrue(Fx.CallBoolean(Wallet, "hasPendingVerifierUpdate", accountId));
            Fx.AdvanceTime(TimeSpan.FromHours(24));
            Fx.SetSigners(BackupOwner);
            Fx.CallVoid(Wallet, "confirmVerifierUpdate", accountId);
            Assert.AreEqual(UInt160.Zero, Fx.CallUInt160(Wallet, "getVerifier", accountId),
                "The verifier must be detached");

            // Reinstall: with no verifier bound, updateVerifier takes effect immediately.
            Fx.SetSigners(BackupOwner);
            Fx.CallVoid(Wallet, "updateVerifier", accountId, verifier, Array.Empty<byte>());
            Assert.AreEqual(verifier, Fx.CallUInt160(Wallet, "getVerifier", accountId));
        }

        public object?[] TransferArgs(UInt160 accountId)
        {
            UInt160 proxy = Fx.CallUInt160(Wallet, "getProxyScriptHash", accountId);
            return new object?[] { proxy, Recipient, (BigInteger)1000, null };
        }

        public byte[] SignTransferOp(
            P256SessionKey key, UInt160 verifier, UInt160 accountId, BigInteger nonce, BigInteger deadline)
        {
            byte[] payload = Fx.CallBytes(
                verifier, "getPayload", accountId, Target, "transfer", TransferArgs(accountId), nonce, deadline);
            return key.Sign(payload);
        }

        public object[] TransferOp(UInt160 accountId, BigInteger nonce, BigInteger deadline, byte[] signature) =>
            RuntimeFixture.UserOp(Target, "transfer", TransferArgs(accountId), nonce, deadline, signature);

        public bool ExecuteUserOp(UInt160 accountId, object[] op) =>
            Fx.CallBoolean(Wallet, "executeUserOp", accountId, op);

        public BigInteger GetNonce(UInt160 accountId) =>
            Fx.CallInteger(Wallet, "getNonce", accountId, BigInteger.Zero);
    }

    /// <summary>
    /// F-2 main repro: a session key signs a legitimate op that is NOT submitted, the key is then
    /// revoked, and the SAME key is re-granted. The pre-revocation signature still executes: the
    /// signed payload contains no revocation epoch, so revocation never invalidates unconsumed
    /// authorizations — it only removes the key until it is re-granted.
    /// </summary>
    [TestMethod]
    public void RevokedSessionKey_OldUnconsumedSignature_ExecutesAfterSameKeyRegrant()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = h.DeploySessionKeyVerifier();
        UInt160 accountId = h.RegisterAccount(verifier);
        h.GrantSessionKey(verifier, accountId, key);

        // Sign a legitimate op with the session key, but do NOT submit it (nonce 0 unconsumed).
        // The deadline must outlive the two 24h config windows that follow.
        BigInteger deadline = h.Fx.Now() + 10L * 24 * 60 * 60 * 1000;
        byte[] staleSignature = h.SignTransferOp(key, verifier, accountId, 0, deadline);
        object[] staleOp = h.TransferOp(accountId, 0, deadline, staleSignature);

        // Revoke the session key.
        h.RevokeSessionKey(accountId);
        Assert.AreEqual(Neo.VM.Types.StackItem.Null, h.Fx.Call(verifier, "getSessionKey", accountId),
            "Revocation must actually remove the session key");
        Assert.AreEqual(BigInteger.Zero, h.GetNonce(accountId),
            "The never-submitted op must not have consumed its nonce");

        // While revoked the stale signature is correctly rejected (revocation itself works).
        h.Fx.SetSigners(Stranger);
        TestException whileRevoked = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteUserOp(accountId, staleOp),
            "A revoked session key must not validate the old signature");
        StringAssert.Contains(whileRevoked.Message, "No session key active");

        // Re-grant the SAME key on the SAME verifier.
        h.GrantSessionKey(verifier, accountId, key);

        // F-2: the pre-revocation signature now executes — no owner witness is attached.
        h.Fx.SetSigners(Stranger);
        Assert.IsTrue(h.ExecuteUserOp(accountId, staleOp),
            "F-2: a pre-revocation signature must execute once the same key is re-granted");
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId),
            "The stale op consumed the still-fresh nonce channel");
    }

    /// <summary>
    /// Control: with the nonce already consumed, revoke + re-grant the same key cannot resurrect
    /// the old op. The core's per-channel cursor is the only thing standing between a re-granted
    /// key and the pre-revocation signature — proving the cursor itself works and F-2 is exactly
    /// the unconsumed-nonce window.
    /// </summary>
    [TestMethod]
    public void RevokedSessionKey_OldSignatureWithConsumedNonce_FailsAfterRegrant()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = h.DeploySessionKeyVerifier();
        UInt160 accountId = h.RegisterAccount(verifier);
        h.GrantSessionKey(verifier, accountId, key);

        BigInteger deadline = h.Fx.Now() + 10L * 24 * 60 * 60 * 1000;
        byte[] signature = h.SignTransferOp(key, verifier, accountId, 0, deadline);
        object[] op = h.TransferOp(accountId, 0, deadline, signature);

        // Consume nonce 0 first.
        h.Fx.SetSigners(Stranger);
        Assert.IsTrue(h.ExecuteUserOp(accountId, op));
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId));

        // Revoke and re-grant the same key.
        h.RevokeSessionKey(accountId);
        h.GrantSessionKey(verifier, accountId, key);

        // The old op now fails on the channel cursor, not on the signature.
        h.Fx.SetSigners(Stranger);
        TestException replay = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteUserOp(accountId, op),
            "A consumed nonce must not validate again after a revoke/re-grant cycle");
        StringAssert.Contains(replay.Message, "Invalid sequence for channel");
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId),
            "The rejected replay must not advance the cursor");
    }

    /// <summary>
    /// F-2 variant via the verifier lifecycle path: uninstalling the verifier (confirmVerifierUpdate
    /// routes clearAccount through the core, which for SessionKeyVerifier is clearSessionKey) and
    /// reinstalling the same verifier + same key also leaves the old unconsumed signature valid.
    /// </summary>
    [TestMethod]
    public void UninstalledVerifier_OldUnconsumedSignature_ExecutesAfterReinstallAndSameKeyRegrant()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = h.DeploySessionKeyVerifier();
        UInt160 accountId = h.RegisterAccount(verifier);
        h.GrantSessionKey(verifier, accountId, key);

        BigInteger deadline = h.Fx.Now() + 10L * 24 * 60 * 60 * 1000;
        byte[] staleSignature = h.SignTransferOp(key, verifier, accountId, 0, deadline);
        object[] staleOp = h.TransferOp(accountId, 0, deadline, staleSignature);

        // Uninstall and reinstall the same verifier; the uninstall's clearAccount wipes the key.
        h.UninstallAndReinstallVerifier(accountId, verifier);
        Assert.AreEqual(Neo.VM.Types.StackItem.Null, h.Fx.Call(verifier, "getSessionKey", accountId),
            "clearAccount must have removed the session key");
        Assert.AreEqual(BigInteger.Zero, h.GetNonce(accountId));

        h.Fx.SetSigners(Stranger);
        TestException whileUninstalled = Assert.ThrowsExactly<TestException>(
            () => h.ExecuteUserOp(accountId, staleOp),
            "With the key cleared the old signature must be rejected");
        StringAssert.Contains(whileUninstalled.Message, "No session key active");

        // Re-grant the same key on the reinstalled verifier.
        h.GrantSessionKey(verifier, accountId, key);

        h.Fx.SetSigners(Stranger);
        Assert.IsTrue(h.ExecuteUserOp(accountId, staleOp),
            "F-2: reinstall + same-key re-grant must accept the pre-revocation signature");
        Assert.AreEqual(BigInteger.One, h.GetNonce(accountId));
    }
}
