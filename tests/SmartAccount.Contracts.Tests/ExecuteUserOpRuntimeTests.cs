using System;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Behavioural VM tests for the v4 <c>executeUserOp</c> kernel (spec §3.6/§4/§5/§6):
/// the built-in custody-signature route, the module (session-key) route, the
/// derived nonce channel, envelope bounds, deadline/epoch/configuration gates
/// and the hook snapshot gate. The retired v3 witness fallback and escape hatch
/// are exercised through their v4 replacements (freeze/unfreeze and recovery,
/// covered by the dedicated recovery suites).
/// </summary>
[TestClass]
public class ExecuteUserOpRuntimeTests
{
    private static readonly UInt160 Custody =
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

        public WalletHarness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            Target = Fx.Deploy("MockTransferTarget");
        }

        public UInt160 RegisterAccount(UInt160 verifier, UInt160 custody, uint escapeTimelock, object?[]? verifierInitData = null)
        {
            if (verifier == UInt160.Zero)
            {
                return Fx.RegisterAccount(Wallet, UInt160.Zero, UInt160.Zero, custody, escapeTimelock);
            }
            int sequence = System.Threading.Interlocked.Increment(ref _sequence);
            object[] actions = { Fx.InstallValidator(verifier, verifierInitData ?? new object?[0]) };
            return Fx.CreateAccount(
                Wallet, custody, RuntimeFixture.Salt("module-" + sequence), RuntimeFixture.MinRecoveryTimelockMs, actions);
        }

        private int _sequence;

        public object?[] TransferArgs(UInt160 accountId) =>
            new object?[] { Fx.CallUInt160(Wallet, "getProxyScriptHash", accountId), Recipient, (BigInteger)1000, null };

        public object[] TransferOp(UInt160 accountId, BigInteger nonce, BigInteger deadline, object? signature = null) =>
            RuntimeFixture.UserOp(Target, "transfer", TransferArgs(accountId), nonce, deadline, signature ?? new byte[] { 0x00 });

        /// <summary>Signed built-in op: the custody key signs the core's operation digest.</summary>
        public object[] SignedTransferOp(UInt160 accountId, P256SessionKey key, BigInteger nonce, BigInteger deadline)
        {
            object[] op = TransferOp(accountId, nonce, deadline);
            op[11] = Fx.SignBuiltIn(Wallet, accountId, op, key);
            return op;
        }

        public bool ExecuteUserOp(UInt160 accountId, object[] op) =>
            Fx.CallBoolean(Wallet, "executeUserOp", accountId, op);

        public BigInteger Nonce(UInt160 accountId, BigInteger validatorId) =>
            Fx.PackedNonce(Wallet, accountId, validatorId);

        public BigInteger Nonce(UInt160 accountId, BigInteger validatorId, byte[] subkey) =>
            Fx.PackedNonce(Wallet, accountId, validatorId, subkey);

        /// <summary>Sequence part of the packed nonce — what consumption assertions look at.</summary>
        public BigInteger Sequence(UInt160 accountId, BigInteger validatorId) =>
            RuntimeFixture.NonceSequence(Nonce(accountId, validatorId));

        public BigInteger Sequence(UInt160 accountId, BigInteger validatorId, byte[] subkey) =>
            RuntimeFixture.NonceSequence(Nonce(accountId, validatorId, subkey));

        /// <summary>The account's live configurationNonce (registration already committed one).</summary>
        public BigInteger ConfigurationNonce(UInt160 accountId) =>
            Fx.AccountConfigurationNonce(Wallet, accountId);

        /// <summary>
        /// Deploys the SessionKeyValidator bound to this core and registers a wallet
        /// whose only routing subject is that module instance, configured through the
        /// registration-time initData command (§9: no 24h wait for the initial grant).
        /// </summary>
        public UInt160 RegisterSessionKeyAccount(P256SessionKey key, out UInt160 verifier, out BigInteger moduleId)
        {
            verifier = Fx.Deploy("validators/SessionKeyValidator", Wallet.ToArray());
            BigInteger validUntil = Fx.Now() + 3_600_000;
            object?[] command =
            {
                "setSessionKey", key.CompressedPublicKey, Target, "transfer", validUntil, (BigInteger)0, "runtime suite"
            };
            UInt160 accountId = RegisterAccount(verifier, Custody, EscapeTimelockSeconds, command);
            moduleId = Fx.FindModuleId(Wallet, accountId, RuntimeFixture.ModuleTypeNameValidator, verifier);
            Assert.AreNotEqual(BigInteger.Zero, moduleId, "The session-key validator must be installed at registration");
            return accountId;
        }

        /// <summary>Session route signature: grantDigest(32) ‖ raw P-256 signature, per §9.</summary>
        public byte[] SignSessionOp(P256SessionKey key, UInt160 verifier, BigInteger moduleId, UInt160 accountId, object[] op)
        {
            object[] probe = (object[])op.Clone();
            probe[11] = new byte[] { 0x00 };
            byte[] digest = Fx.CallBytes(Wallet, "getOperationDigest", accountId, probe);
            byte[] grantDigest = Fx.CallBytes(verifier, "getGrantDigest", accountId, moduleId);
            return grantDigest.Concat(key.Sign(digest)).ToArray();
        }
    }

    [TestMethod]
    public void ExecuteUserOp_BuiltInRouteExecutesWithCustodySignature()
    {
        RuntimeFixture fx = new();
        using P256SessionKey key = new();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 target = fx.Deploy("MockTransferTarget");
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 accountId = fx.CreateAccount(core, custody, "builtin-happy");
        fx.SetSigners(custody);

        BigInteger nonce = fx.PackedNonce(core, accountId, 0);
        object[] op = RuntimeFixture.UserOp(
            target, "supportsV3", new object?[0], nonce, fx.Now() + 60_000, new byte[] { 0x00 });
        op[11] = fx.SignBuiltIn(core, accountId, op, key);

        Assert.IsTrue(fx.CallBoolean(core, "executeUserOp", accountId, op));
        Assert.AreEqual(nonce + 1, fx.PackedNonce(core, accountId, 0),
            "A successful built-in operation consumes exactly one sequence");
    }

    [TestMethod]
    public void ExecuteUserOp_RejectsSignatureFromAnotherCustody()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        using P256SessionKey attacker = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 accountId = h.Fx.CreateAccount(h.Wallet, custody, "builtin-foreign-key");
        h.Fx.SetSigners(custody);

        BigInteger deadline = h.Fx.Now() + 3_600_000;
        object[] op = h.TransferOp(accountId, h.Nonce(accountId, 0), deadline);
        // A foreign key signs the same operation: the subject never matches.
        op[11] = h.Fx.SignBuiltIn(h.Wallet, accountId, op, attacker);

        TestException rejected = Assert.ThrowsExactly<TestException>(() => h.ExecuteUserOp(accountId, op));
        StringAssert.Contains(rejected.Message, "SA_VALIDATION_REJECTED");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(accountId, 0), "A rejected signature must not consume the nonce");
    }

    [TestMethod]
    public void ExecuteUserOp_RejectsReplayedNonce()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 accountId = h.Fx.CreateAccount(h.Wallet, custody, "builtin-replay");
        h.Fx.SetSigners(custody);

        BigInteger deadline = h.Fx.Now() + 3_600_000;
        object[] op = h.SignedTransferOp(accountId, key, h.Nonce(accountId, 0), deadline);

        Assert.IsTrue(h.ExecuteUserOp(accountId, op));

        TestException replay = Assert.ThrowsExactly<TestException>(() => h.ExecuteUserOp(accountId, op),
            "Replaying a consumed nonce must fault");
        StringAssert.Contains(replay.Message, "SA_NONCE_INVALID");
        Assert.AreEqual(BigInteger.One, h.Sequence(accountId, 0), "Failed replay must not advance the sequence");
    }

    [TestMethod]
    public void ExecuteUserOp_RejectsExpiredDeadline()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 accountId = h.Fx.CreateAccount(h.Wallet, custody, "builtin-expired");
        h.Fx.SetSigners(custody);
        BigInteger expiredDeadline = h.Fx.Now() - 1;

        object[] op = h.SignedTransferOp(accountId, key, h.Nonce(accountId, 0), expiredDeadline);
        TestException expired = Assert.ThrowsExactly<TestException>(() => h.ExecuteUserOp(accountId, op),
            "An op past its deadline must fault");
        StringAssert.Contains(expired.Message, "SA_DEADLINE_EXPIRED");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(accountId, 0), "Expired op must not consume the nonce");
    }

    [TestMethod]
    public void ExecuteUserOp_RejectsStaleAuthorityEpoch()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 accountId = h.Fx.CreateAccount(h.Wallet, custody, "builtin-stale-epoch");
        h.Fx.SetSigners(custody);
        BigInteger liveEpoch = h.Fx.AccountAuthorityEpoch(h.Wallet, accountId);

        BigInteger nonce = h.Nonce(accountId, 0);
        object[] op = RuntimeFixture.UserOp(
            h.Target, "transfer", h.TransferArgs(accountId), nonce, h.Fx.Now() + 3_600_000, new byte[] { 0x00 },
            authorityEpoch: liveEpoch + 1);
        op[11] = h.Fx.SignBuiltIn(h.Wallet, accountId, op, key);

        TestException stale = Assert.ThrowsExactly<TestException>(() => h.ExecuteUserOp(accountId, op));
        StringAssert.Contains(stale.Message, "SA_EPOCH_STALE");
    }

    [TestMethod]
    public void ExecuteUserOp_RejectsStaleConfigurationNonce()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 accountId = h.Fx.CreateAccount(h.Wallet, custody, "builtin-stale-cfgnonce");
        h.Fx.SetSigners(custody);

        object[] op = RuntimeFixture.UserOp(
            h.Target, "transfer", h.TransferArgs(accountId), h.Nonce(accountId, 0),
            h.Fx.Now() + 3_600_000, new byte[] { 0x00 }, configurationNonce: (BigInteger)7);
        op[11] = h.Fx.SignBuiltIn(h.Wallet, accountId, op, key);

        TestException stale = Assert.ThrowsExactly<TestException>(() => h.ExecuteUserOp(accountId, op));
        StringAssert.Contains(stale.Message, "SA_CONFIGURATION_NONCE_STALE");
    }

    [TestMethod]
    public void ExecuteUserOp_RejectsOversizedSignature()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 accountId = h.Fx.CreateAccount(h.Wallet, custody, "builtin-oversized-sig");
        h.Fx.SetSigners(custody);

        // §4.1 bounds the signature blob at SignatureBytesMax (8192).
        object[] op = h.TransferOp(accountId, h.Nonce(accountId, 0), h.Fx.Now() + 3_600_000, new byte[8193]);
        TestException rejected = Assert.ThrowsExactly<TestException>(() => h.ExecuteUserOp(accountId, op));
        StringAssert.Contains(rejected.Message, "SA_OPERATION_MALFORMED");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(accountId, 0),
            "Oversized signature bytes must be rejected before nonce consumption");
    }

    [TestMethod]
    public void ExecuteUserOp_RejectsOversizedArgumentShape()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 accountId = h.Fx.CreateAccount(h.Wallet, custody, "builtin-oversized-args");
        h.Fx.SetSigners(custody);

        object[] tooManyArguments = new object[65];
        object[] op = RuntimeFixture.UserOp(
            h.Target, "transfer", tooManyArguments, h.Nonce(accountId, 0), h.Fx.Now() + 3_600_000, new byte[] { 0x00 });

        TestException rejected = Assert.ThrowsExactly<TestException>(() => h.ExecuteUserOp(accountId, op));
        StringAssert.Contains(rejected.Message, "SA_OPERATION_MALFORMED");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(accountId, 0),
            "Oversized argument shapes must be rejected before nonce consumption");
    }

    [TestMethod]
    public void ExecuteUserOp_ParallelNonceSubkeysAdvanceIndependently()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 accountId = h.Fx.CreateAccount(h.Wallet, custody, "builtin-parallel-subkey");
        h.Fx.SetSigners(custody);
        byte[] parallelSubkey = Enumerable.Repeat((byte)0x11, 32).ToArray();
        BigInteger deadline = h.Fx.Now() + 3_600_000;

        Assert.AreEqual(BigInteger.Zero, h.Sequence(accountId, 0, parallelSubkey),
            "A fresh nonce subkey starts at its own sequence");

        object[] defaultOp = h.SignedTransferOp(accountId, key, h.Nonce(accountId, 0), deadline);
        Assert.IsTrue(h.ExecuteUserOp(accountId, defaultOp));
        Assert.AreEqual(BigInteger.One, h.Sequence(accountId, 0), "The default channel advances");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(accountId, 0, parallelSubkey),
            "Default-channel activity must not touch the parallel subkey");

        object[] parallelOp = RuntimeFixture.UserOp(
            h.Target, "transfer", h.TransferArgs(accountId), h.Nonce(accountId, 0, parallelSubkey), deadline,
            new byte[] { 0x00 }, nonceSubkey: parallelSubkey);
        parallelOp[11] = h.Fx.SignBuiltIn(h.Wallet, accountId, parallelOp, key);
        Assert.IsTrue(h.ExecuteUserOp(accountId, parallelOp));
        Assert.AreEqual(BigInteger.One, h.Sequence(accountId, 0, parallelSubkey), "The subkey sequence advances once");
        Assert.AreEqual(BigInteger.One, h.Sequence(accountId, 0), "The default channel is untouched by the subkey");
    }

    [TestMethod]
    public void ExecuteUserOp_ParallelNonceSubkeyRejectsReplay()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 accountId = h.Fx.CreateAccount(h.Wallet, custody, "builtin-subkey-replay");
        h.Fx.SetSigners(custody);
        byte[] parallelSubkey = Enumerable.Repeat((byte)0x22, 32).ToArray();

        object[] op = RuntimeFixture.UserOp(
            h.Target, "transfer", h.TransferArgs(accountId), h.Nonce(accountId, 0, parallelSubkey),
            h.Fx.Now() + 3_600_000, new byte[] { 0x00 }, nonceSubkey: parallelSubkey);
        op[11] = h.Fx.SignBuiltIn(h.Wallet, accountId, op, key);

        Assert.IsTrue(h.ExecuteUserOp(accountId, op));
        TestException replay = Assert.ThrowsExactly<TestException>(() => h.ExecuteUserOp(accountId, op));
        StringAssert.Contains(replay.Message, "SA_NONCE_INVALID");
        Assert.AreEqual(BigInteger.One, h.Sequence(accountId, 0, parallelSubkey),
            "A failed replay must not advance the subkey cursor");
    }

    [TestMethod]
    public void ExecuteUserOp_ParallelNonceSubkeyRejectsOutOfOrderSequence()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 accountId = h.Fx.CreateAccount(h.Wallet, custody, "builtin-subkey-gap");
        h.Fx.SetSigners(custody);
        byte[] parallelSubkey = Enumerable.Repeat((byte)0x33, 32).ToArray();

        // The subkey cursor is a sequence, not a threshold: skipping 0 must fail.
        BigInteger channel = h.Nonce(accountId, 0, parallelSubkey) >> 64;
        object[] op = RuntimeFixture.UserOp(
            h.Target, "transfer", h.TransferArgs(accountId), (channel << 64) | 1,
            h.Fx.Now() + 3_600_000, new byte[] { 0x00 }, nonceSubkey: parallelSubkey);
        op[11] = h.Fx.SignBuiltIn(h.Wallet, accountId, op, key);

        TestException gap = Assert.ThrowsExactly<TestException>(() => h.ExecuteUserOp(accountId, op),
            "An out-of-order subkey sequence must fault");
        StringAssert.Contains(gap.Message, "SA_NONCE_INVALID");
        Assert.AreEqual(BigInteger.Zero, h.Sequence(accountId, 0, parallelSubkey),
            "A rejected out-of-order op must not advance the cursor");
    }

    [TestMethod]
    public void ExecuteUserOp_FrozenAccountRejectsOperations()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 accountId = h.Fx.CreateAccount(h.Wallet, custody, "builtin-frozen");

        h.Fx.SetSigners(custody);
        h.Fx.CallVoid(h.Wallet, "freezeAccount", accountId);
        Assert.AreEqual(BigInteger.One, h.Fx.AccountStatus(h.Wallet, accountId), "Status 1 is Frozen");

        BigInteger nonce = h.Nonce(accountId, 0);
        object[] op = RuntimeFixture.UserOp(
            h.Target, "transfer", h.TransferArgs(accountId), nonce, h.Fx.Now() + 3_600_000, new byte[] { 0x00 },
            authorityEpoch: h.Fx.AccountAuthorityEpoch(h.Wallet, accountId),
            configurationNonce: h.Fx.AccountConfigurationNonce(h.Wallet, accountId));
        op[11] = h.Fx.SignBuiltIn(h.Wallet, accountId, op, key);

        TestException frozen = Assert.ThrowsExactly<TestException>(() => h.ExecuteUserOp(accountId, op));
        StringAssert.Contains(frozen.Message, "SA_ACCOUNT_FROZEN");

        h.Fx.SetSigners(custody);
        h.Fx.CallVoid(h.Wallet, "unfreezeAccount", accountId);
        Assert.AreEqual(BigInteger.Zero, h.Fx.AccountStatus(h.Wallet, accountId), "Status 0 is Active");
    }

    [TestMethod]
    public void ExecuteUserOp_SessionKeyRouteAcceptsGrantSignatureWithoutCustodyWitness()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 accountId = h.RegisterSessionKeyAccount(key, out UInt160 verifier, out BigInteger moduleId);

        BigInteger deadline = h.Fx.Now() + 3_600_000;
        BigInteger nonce = h.Nonce(accountId, moduleId);
        object[] op = RuntimeFixture.UserOp(
            h.Target, "transfer", h.TransferArgs(accountId), nonce, deadline, new byte[] { 0x00 }, validatorId: moduleId,
            configurationNonce: h.ConfigurationNonce(accountId));
        op[11] = h.SignSessionOp(key, verifier, moduleId, accountId, op);

        // The session key alone authorizes the operation: no custody witness attached.
        h.Fx.SetSigners(Stranger);
        Assert.IsTrue(h.ExecuteUserOp(accountId, op));
        Assert.AreEqual(RuntimeFixture.NonceSequence(nonce) + 1, h.Sequence(accountId, moduleId));
        Assert.IsFalse(h.Fx.AccountDefaultOperationAuthorization(h.Wallet, accountId),
            "Installing the first validator disables the built-in route (§8)");
    }

    [TestMethod]
    public void ExecuteUserOp_SessionKeyRouteRejectsTamperedSignature()
    {
        WalletHarness h = new();
        using P256SessionKey key = new();
        UInt160 accountId = h.RegisterSessionKeyAccount(key, out UInt160 verifier, out BigInteger moduleId);

        BigInteger nonce = h.Nonce(accountId, moduleId);
        object[] op = RuntimeFixture.UserOp(
            h.Target, "transfer", h.TransferArgs(accountId), nonce, h.Fx.Now() + 3_600_000,
            new byte[] { 0x00 }, validatorId: moduleId, configurationNonce: h.ConfigurationNonce(accountId));
        byte[] signature = h.SignSessionOp(key, verifier, moduleId, accountId, op);
        signature[^1] ^= 0xFF;
        op[11] = signature;

        h.Fx.SetSigners(Stranger);
        TestException rejected = Assert.ThrowsExactly<TestException>(() => h.ExecuteUserOp(accountId, op),
            "A tampered session signature must fault execution");
        StringAssert.Contains(rejected.Message, "SA_VALIDATION_REJECTED");
        Assert.AreEqual(RuntimeFixture.NonceSequence(nonce), h.Sequence(accountId, moduleId),
            "Rejected op must not consume the nonce");
    }

    [TestMethod]
    public void ExecuteUserOp_WhitelistHookRejectsUnlistedTarget()
    {
        RuntimeFixture fx = new();
        using P256SessionKey key = new();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 target = fx.Deploy("MockTransferTarget");
        UInt160 hook = fx.Deploy("hooks/WhitelistHook", core.ToArray());
        UInt160 custody = RuntimeFixture.CustodyOf(key);

        UInt160 accountId = fx.CreateAccount(core, custody, "hook-whitelist",
            new object[] { fx.InstallHook(hook, "allowTarget", target) });
        Assert.AreEqual(1, fx.HookOrderIds(core, accountId).Length, "The installed hook enters the core hook order");

        fx.SetSigners(custody);
        BigInteger deadline = fx.Now() + 3_600_000;
        BigInteger configurationNonce = fx.AccountConfigurationNonce(core, accountId);
        object[] allowed = RuntimeFixture.UserOp(
            target, "supportsV3", new object?[0], fx.PackedNonce(core, accountId, 0), deadline, new byte[] { 0x00 },
            configurationNonce: configurationNonce);
        allowed[11] = fx.SignBuiltIn(core, accountId, allowed, key);
        Assert.IsTrue(fx.CallBoolean(core, "executeUserOp", accountId, allowed),
            "The allowlisted target passes the canonical pre-hook");
        Assert.AreEqual(BigInteger.One, fx.CurrentNonceSequence(core, accountId, 0));

        object[] blocked = RuntimeFixture.UserOp(
            core, "getProtocolInfo", new object?[0], fx.PackedNonce(core, accountId, 0), deadline, new byte[] { 0x00 },
            configurationNonce: configurationNonce);
        blocked[11] = fx.SignBuiltIn(core, accountId, blocked, key);
        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => fx.CallBoolean(core, "executeUserOp", accountId, blocked),
            "A target outside the whitelist must be rejected by the pre-hook");
        StringAssert.Contains(rejected.Message, "Target contract not in whitelist");
        Assert.AreEqual(BigInteger.One, fx.CurrentNonceSequence(core, accountId, 0),
            "A rejected pre-hook must roll back nonce consumption");
    }
}
