using System;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// F-2 (revocation replay) regression suite for protocol v4. Revocation is a
/// core-defined, callback-free one-way commit: <c>revokeCredentials</c> bumps the
/// instance's credential generation and the account's configuration nonce, and
/// both values are bound into the signed operation digest while the generation is
/// also bound into the session grant digest. An authorization produced before
/// revocation therefore cannot be replayed after the same key is re-granted —
/// unlike the retired v3 payload, which carried no epoch at all and left the
/// unconsumed-nonce window open.
/// </summary>
[TestClass]
public class Fix_SessionKeyRevocationReproTests
{
    private static readonly UInt160 Custody =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    /// <summary>Session lifetime that outlives every configuration window these tests use.</summary>
    private static readonly BigInteger SessionLifetimeMs = 25L * 24 * 60 * 60 * 1000;

    /// <summary>Deadline that outlives the two 24 h configuration windows of the longer tests.</summary>
    private static readonly BigInteger OperationDeadlineMs = 10L * 24 * 60 * 60 * 1000;

    private static int _sequence;

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Target { get; }

        public UInt160 Verifier { get; }

        public UInt160 AccountId { get; private set; } = UInt160.Zero;

        public P256SessionKey Key { get; } = new();

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            Target = Fx.Deploy("MockTransferTarget");
            Verifier = Fx.Deploy("validators/SessionKeyValidator", Wallet.ToArray());
        }

        /// <summary>The §9 <c>setSessionKey</c> command bound to this harness's key.</summary>
        public object?[] GrantCommand() =>
            new object?[]
            {
                "setSessionKey", Key.CompressedPublicKey, Target, "transfer",
                Fx.Now() + SessionLifetimeMs, (BigInteger)0, "F-2 v4 regression"
            };

        /// <summary>
        /// Registers the account with the validator installed and its grant
        /// committed atomically, so no configuration window precedes the test.
        /// </summary>
        public BigInteger Register()
        {
            int sequence = System.Threading.Interlocked.Increment(ref _sequence);
            AccountId = Fx.CreateAccount(
                Wallet, Custody, RuntimeFixture.Salt("revocation-" + sequence + "-" + Custody),
                RuntimeFixture.MinRecoveryTimelockMs,
                new object[] { Fx.InstallValidator(Verifier, GrantCommand()) });
            BigInteger moduleId = Fx.FindModuleId(
                Wallet, AccountId, RuntimeFixture.ModuleTypeNameValidator, Verifier);
            Assert.AreNotEqual(BigInteger.Zero, moduleId,
                "The session-key validator must be installed at registration");
            return moduleId;
        }

        /// <summary>The <c>getModule</c> projection: index 8 is the credential generation.</summary>
        public Neo.VM.Types.Array ModuleRecord(BigInteger moduleId) =>
            (Neo.VM.Types.Array)Fx.Call(Wallet, "getModule", AccountId, moduleId);

        public BigInteger Generation(BigInteger moduleId) => ModuleRecord(moduleId)[8].GetInteger();

        public BigInteger ConfigurationNonce => Fx.AccountConfigurationNonce(Wallet, AccountId);

        public BigInteger Sequence(BigInteger moduleId) =>
            RuntimeFixture.NonceSequence(Fx.PackedNonce(Wallet, AccountId, moduleId));

        public byte[] GrantDigest(BigInteger moduleId) =>
            Fx.CallBytes(Verifier, "getGrantDigest", AccountId, moduleId);

        /// <summary>
        /// Canonical v4 transfer op for this account, routed through the given
        /// instance under the given generation and configuration nonce. The
        /// nonce is read live, so it always matches the channel the core derives
        /// for that (validatorId, credentialGeneration) pair.
        /// </summary>
        public object[] Operation(
            BigInteger moduleId, BigInteger generation, BigInteger configurationNonce, BigInteger deadline, object signature)
        {
            object?[] args =
            {
                Fx.CallUInt160(Wallet, "getProxyScriptHash", AccountId), Recipient, (BigInteger)1000, null
            };
            BigInteger nonce = Fx.PackedNonce(Wallet, AccountId, moduleId);
            return RuntimeFixture.UserOp(
                Target, "transfer", args, nonce, deadline, signature,
                validatorId: moduleId, credentialGeneration: generation,
                configurationNonce: configurationNonce);
        }

        /// <summary>
        /// Session route signature (§5/§9): <c>grantDigest(32) ‖ raw P-256 signature</c>
        /// over the core's operation digest for the exact current routing state.
        /// </summary>
        public byte[] Sign(object[] op, BigInteger moduleId)
        {
            object[] probe = (object[])op.Clone();
            probe[11] = new byte[] { 0x00 };
            byte[] digest = Fx.CallBytes(Wallet, "getOperationDigest", AccountId, probe);
            byte[] grant = GrantDigest(moduleId);
            Assert.AreEqual(32, grant.Length, "A live grant publishes a 32-byte grant digest");
            return grant.Concat(Key.Sign(digest)).ToArray();
        }

        public bool Execute(object[] op) => Fx.CallBoolean(Wallet, "executeUserOp", AccountId, op);

        /// <summary><c>revokeCredentials</c> is custody-authorized and callback-free.</summary>
        public BigInteger Revoke(BigInteger moduleId)
        {
            Fx.SetSigners(Custody);
            Fx.CallVoid(Wallet, "revokeCredentials", AccountId, moduleId);
            Neo.VM.Types.Array revoked = Fx.SingleNotificationState(Wallet, "CredentialRevoked");
            Assert.AreEqual(3, revoked.Count, "CredentialRevoked carries [accountId, moduleId, generation]");
            Assert.AreEqual(moduleId, revoked[1].GetInteger());
            return revoked[2].GetInteger();
        }

        /// <summary>Re-grants the same key through the core's 24 h configuration intent.</summary>
        public void Regrant(BigInteger moduleId)
        {
            // A single-action intent is an array OF actions, hence the wrapper.
            object[] action = RuntimeFixture.ConfigureModule(moduleId, GrantCommand());
            Fx.ConfigureAfterTimelock(Wallet, AccountId, Custody, new object[] { action });
        }

        public void Uninstall(BigInteger moduleId)
        {
            // Last-validator rule (§10): removing the only validator must enable
            // the built-in route inside the same intent.
            Fx.ConfigureAfterTimelock(
                Wallet, AccountId, Custody,
                new object[] { 2, moduleId, new object[0] },
                new object[] { 5, true, false });
        }

        public BigInteger Reinstall()
        {
            object[] action = Fx.InstallValidator(Verifier, GrantCommand());
            Fx.ConfigureAfterTimelock(Wallet, AccountId, Custody, new object[] { action });
            BigInteger moduleId = Fx.FindModuleId(
                Wallet, AccountId, RuntimeFixture.ModuleTypeNameValidator, Verifier);
            Assert.AreNotEqual(BigInteger.Zero, moduleId, "The validator must be reinstalled");
            return moduleId;
        }
    }

    /// <summary>
    /// F-2 main regression: a session key signs a legitimate op that is never
    /// submitted, the key is then revoked and the SAME key re-granted. In v4 the
    /// pre-revocation authorization is dead on three independent bindings — the
    /// configuration nonce, the credential generation and the grant digest — while
    /// a fresh authorization under the new generation still executes.
    /// </summary>
    [TestMethod]
    public void RevokedSessionKey_OldUnconsumedSignature_IsDeadAfterSameKeyRegrant()
    {
        Harness h = new();
        BigInteger moduleId = h.Register();
        BigInteger deadline = h.Fx.Now() + OperationDeadlineMs;
        Assert.AreEqual(BigInteger.One, h.Generation(moduleId));

        // Signed while authorized, never submitted: sequence 0 stays unconsumed.
        object[] staleOp = h.Operation(moduleId, 1, h.ConfigurationNonce, deadline, new byte[] { 0x00 });
        staleOp[11] = h.Sign(staleOp, moduleId);
        byte[] staleSignature = (byte[])staleOp[11];
        Assert.AreEqual(BigInteger.Zero, h.Sequence(moduleId));

        // Revocation is a security configuration commit: generation 1 -> 2 plus a
        // configuration-nonce bump, both bound into the operation digest.
        BigInteger nonceBeforeRevoke = h.ConfigurationNonce;
        Assert.AreEqual((BigInteger)2, h.Revoke(moduleId));
        Assert.AreEqual((BigInteger)2, h.Generation(moduleId));
        Assert.AreEqual(nonceBeforeRevoke + 1, h.ConfigurationNonce);
        Assert.AreEqual(BigInteger.Zero, h.Sequence(moduleId),
            "Revocation must not consume or advance the never-submitted operation");

        // The stale op also carries the pre-revocation configuration nonce.
        TestException staleConfig = Assert.ThrowsExactly<TestException>(() => h.Execute(staleOp));
        StringAssert.Contains(staleConfig.Message, "SA_CONFIGURATION_NONCE_STALE");

        // With the current configuration nonce the credential generation gate
        // rejects the pre-revocation authorization on its own.
        object[] staleGeneration = (object[])staleOp.Clone();
        staleGeneration[10] = h.ConfigurationNonce;
        TestException staleGen = Assert.ThrowsExactly<TestException>(() => h.Execute(staleGeneration));
        StringAssert.Contains(staleGen.Message, "SA_CREDENTIAL_STALE");

        // Re-grant the SAME key. The grant is re-issued under generation 2, so the
        // grant digest it publishes is not the digest the old signature carries.
        byte[] oldGrant = staleSignature.Take(32).ToArray();
        h.Regrant(moduleId);
        byte[] newGrant = h.GrantDigest(moduleId);
        Assert.AreEqual(32, newGrant.Length, "The re-grant must publish a fresh grant digest");
        Assert.AreNotEqual(Convert.ToHexString(oldGrant), Convert.ToHexString(newGrant),
            "The grant digest commits to the credential generation");
        Assert.AreEqual((BigInteger)2, h.Generation(moduleId),
            "Re-configuration keeps the revoked generation; it does not reset it");

        // Replay the old signature under the current routing state: the module
        // refuses because the grant digest it now publishes is a different one.
        object[] replay = h.Operation(moduleId, 2, h.ConfigurationNonce, deadline, new byte[] { 0x00 });
        replay[11] = staleSignature;
        TestException rejected = Assert.ThrowsExactly<TestException>(() => h.Execute(replay));
        StringAssert.Contains(rejected.Message, "SA_VALIDATION_REJECTED");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(moduleId),
            "A rejected replay must not consume the channel");

        // A fresh authorization under the new generation executes normally.
        object[] fresh = h.Operation(moduleId, 2, h.ConfigurationNonce, deadline, new byte[] { 0x00 });
        fresh[11] = h.Sign(fresh, moduleId);
        Assert.IsTrue(h.Execute(fresh), "A fresh authorization under the re-granted key executes");
        Assert.AreEqual(BigInteger.One, h.Sequence(moduleId));
    }

    /// <summary>
    /// Control: the per-channel sequence cursor still rejects an exact replay before
    /// any revocation, and after a revoke/re-grant cycle the channel itself rotates
    /// (it commits to the generation), so the cursor is not the defense that kills
    /// the pre-revocation signature — the generation-bound grant digest is.
    /// </summary>
    [TestMethod]
    public void ConsumedNonce_ThenRevokeAndRegrant_ReplayStaysDead()
    {
        Harness h = new();
        BigInteger moduleId = h.Register();
        BigInteger deadline = h.Fx.Now() + OperationDeadlineMs;

        object[] first = h.Operation(moduleId, 1, h.ConfigurationNonce, deadline, new byte[] { 0x00 });
        first[11] = h.Sign(first, moduleId);
        Assert.IsTrue(h.Execute(first));
        Assert.AreEqual(BigInteger.One, h.Sequence(moduleId));

        // Control: the same generation channel refuses the identical op.
        TestException replayed = Assert.ThrowsExactly<TestException>(() => h.Execute(first));
        StringAssert.Contains(replayed.Message, "SA_NONCE_INVALID");

        h.Revoke(moduleId);
        h.Regrant(moduleId);

        // The channel commits to the credential generation, so the account is back
        // at sequence 0 on a fresh channel — the signature itself must fence.
        Assert.AreEqual(BigInteger.Zero, h.Sequence(moduleId),
            "Revocation opens a new nonce channel because the generation is part of it");

        object[] stale = h.Operation(moduleId, 2, h.ConfigurationNonce, deadline, new byte[] { 0x00 });
        stale[11] = first[11];
        TestException dead = Assert.ThrowsExactly<TestException>(() => h.Execute(stale));
        StringAssert.Contains(dead.Message, "SA_VALIDATION_REJECTED");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(moduleId),
            "The dead replay must not consume the fresh channel");
    }

    /// <summary>
    /// Lifecycle variant: uninstalling the validator retires the instance id and
    /// wipes its grant storage, and reinstalling allocates a new instance. The old
    /// signature cannot be routed to a missing instance and cannot satisfy a new
    /// one, because the grant digest names the instance it was issued for.
    /// </summary>
    [TestMethod]
    public void UninstalledValidator_OldSignature_IsDeadAfterReinstall()
    {
        Harness h = new();
        BigInteger moduleId = h.Register();
        BigInteger deadline = h.Fx.Now() + OperationDeadlineMs;

        object[] staleOp = h.Operation(moduleId, 1, h.ConfigurationNonce, deadline, new byte[] { 0x00 });
        staleOp[11] = h.Sign(staleOp, moduleId);
        byte[] staleGrant = ((byte[])staleOp[11]).Take(32).ToArray();

        // Uninstall: onUninstall wipes the instance storage; the id is retired.
        h.Uninstall(moduleId);
        Assert.AreEqual(0, h.ModuleRecord(moduleId).Count, "The instance must be uninstalled");
        Assert.AreEqual(0, h.GrantDigest(moduleId).Length,
            "onUninstall must wipe the session grant");

        // The stale op is routed at a retired instance.
        object[] staleCurrentConfig = (object[])staleOp.Clone();
        staleCurrentConfig[10] = h.ConfigurationNonce;
        TestException gone = Assert.ThrowsExactly<TestException>(() => h.Execute(staleCurrentConfig));
        StringAssert.Contains(gone.Message, "SA_VALIDATOR_NOT_FOUND");

        // Reinstall: a new instance id at generation 1 with a grant for the same key.
        BigInteger reinstalled = h.Reinstall();
        Assert.AreNotEqual(moduleId, reinstalled, "Reinstall allocates a new instance id");
        Assert.AreEqual(BigInteger.One, h.Generation(reinstalled));
        byte[] freshGrant = h.GrantDigest(reinstalled);
        Assert.AreEqual(32, freshGrant.Length);
        Assert.AreNotEqual(Convert.ToHexString(staleGrant), Convert.ToHexString(freshGrant),
            "The grant digest names the instance, so the old DTO cannot satisfy the new one");

        // The old signature cannot be pointed at the reinstalled instance either.
        object[] replay = h.Operation(reinstalled, 1, h.ConfigurationNonce, deadline, new byte[] { 0x00 });
        replay[11] = staleOp[11];
        TestException rejected = Assert.ThrowsExactly<TestException>(() => h.Execute(replay));
        StringAssert.Contains(rejected.Message, "SA_VALIDATION_REJECTED");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(reinstalled));

        // A fresh grant on the reinstalled instance executes.
        object[] fresh = h.Operation(reinstalled, 1, h.ConfigurationNonce, deadline, new byte[] { 0x00 });
        fresh[11] = h.Sign(fresh, reinstalled);
        Assert.IsTrue(h.Execute(fresh), "The reinstalled instance must authorize a fresh op");
        Assert.AreEqual(BigInteger.One, h.Sequence(reinstalled));
    }
}
