using System;
using System.Collections.Generic;
using System.Linq;
using Neo.SmartContract;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Regression tests for the three security fixes in <c>SocialRecoveryVerifier</c>:
///   1. Per-account oracle-credit accounting — <c>OnNEP17Payment</c> earmarks GAS to the
///      account named in the payment memo, and <c>DepositOracleCredits</c> may only be driven by
///      that account's owner and only spends that account's credited balance (no shared-pool drain).
///   2. Domain separation for action-session signatures — <c>ComputeActionDigest</c> binds the
///      verifier contract, network, account and expiry so a signature cannot be replayed for a
///      different account.
///   3. Recovery timelock bounds — <c>SetupRecovery</c> / <c>UpdateRecoveryConfig</c> enforce
///      the estate-standard 7–90 day window (rejecting both shorter and longer timelocks),
///      matching the AA core escape-hatch bounds. Previously 1h minimum / no maximum
///      (audit finding: recovery timelock bounds).
/// Executed against the compiled contract under <c>contracts/bin/v3</c> through a real Neo VM.
/// </summary>
[TestClass]
public partial class FixRecoveryTests
{
    private const string Network = "neo3-testnet";

    // Estate-standard recovery timelock window (Runtime.Time milliseconds): 7–90 days,
    // mirroring the AA core escape hatch's 604800–7776000 seconds.
    private const ulong MinRecoveryTimelockMs = 604_800_000;
    private const ulong MaxRecoveryTimelockMs = 7_776_000_000;

    private static readonly byte[] ActionDomain = Encoding.ASCII.GetBytes("neodid-action-v2");
    private static readonly byte[] RecoveryDomain = Encoding.ASCII.GetBytes("neodid-recovery-v2");

    private static readonly UInt160 OwnerA =
        UInt160.Parse("0x1111111111111111111111111111111111111111");
    private static readonly UInt160 OwnerB =
        UInt160.Parse("0x2222222222222222222222222222222222222222");
    private static readonly UInt160 AccountAddress =
        UInt160.Parse("0x4444444444444444444444444444444444444444");
    private static readonly UInt160 Oracle =
        UInt160.Parse("0x5555555555555555555555555555555555555555");
    private static readonly UInt160 Executor =
        UInt160.Parse("0x6666666666666666666666666666666666666666");
    private static readonly UInt160 Attacker =
        UInt160.Parse("0x9999999999999999999999999999999999999999");

    private sealed class RecoveryHarness
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Core { get; }
        public UInt160 Verifier { get; }

        public RecoveryHarness()
        {
            Core = Fx.Deploy("UnifiedSmartWalletV3");
            Verifier = Fx.Deploy("SocialRecoveryVerifier");
            // AA-06: setup is only accepted for accounts attested by the admin-pinned
            // canonical AA core (deployer = validators is the contract admin).
            Fx.CallVoid(Verifier, "setAuthorizedCore", Core);
        }

        /// <summary>
        /// Registers an account on the real AA core with <paramref name="owner"/> as its backup
        /// owner and returns the core-derived 20-byte account id. <c>getBackupOwner</c> on the
        /// core then attests the owner — the AA-06 anti-squat precondition for setup.
        /// </summary>
        public byte[] RegisterAccount(UInt160 owner)
        {
            UInt160 accountId = Fx.CallUInt160(
                Core, "computeRegistrationAccountId",
                UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, owner, 2_592_000u);

            Fx.SetSigners(owner);
            Fx.CallVoid(
                Core, "registerAccount",
                accountId, UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, owner, 2_592_000u);
            return accountId.ToArray();
        }

        public byte[] SetupAccount(
            string accountIdText,
            UInt160 owner,
            byte[] verifierPubKey,
            ulong timelock = MinRecoveryTimelockMs, UInt160? oracle = null)
        {
            byte[] accountId = RegisterAccount(owner);
            byte[] factor = Factor();

            Fx.SetSigners(owner);
            Fx.CallVoid(
                Verifier, "setupRecovery",
                accountId, accountIdText, Network, owner, Core, AccountAddress, oracle ?? Oracle,
                new object?[] { factor }, (BigInteger)1, timelock, verifierPubKey);
            return accountId;
        }

        // Synthetic pre-v4 storage shape, not a claim of a historical deployment fixture.
        public void DeleteNewActionStorage(byte[] accountId, byte prefix)
        {
            var state = (Neo.VM.Types.Array)Fx.Call(
                UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"), "getContract", Verifier);
            Fx.Engine.Storage.Snapshot.Delete(new StorageKey
            {
                Id = (int)state[0].GetInteger(),
                Key = new[] { prefix }.Concat(accountId).ToArray()
            });
        }

        // Synthetic stored request for the callback boundary. This does not
        // claim a real Oracle transport/request integration execution.
        public void SeedActionOracleRequest(BigInteger requestId, byte[] accountId, UInt160 executor,
            string actionId, ulong expiresAt, BigInteger epoch)
        {
            var state = (Neo.VM.Types.Array)Fx.Call(
                UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd"), "getContract", Verifier);
            int id = (int)state[0].GetInteger();
            byte[] serialized = Fx.CallBytes(Fx.StdLibHash, "serialize", (object)new object?[] { accountId, executor, actionId, expiresAt });
            Fx.Engine.Storage.Snapshot.Add(new StorageKey { Id = id, Key = new byte[] { 0x12 }.Concat(requestId.ToByteArray()).ToArray() }, new StorageItem { Value = serialized });
            Fx.Engine.Storage.Snapshot.Add(new StorageKey { Id = id, Key = new byte[] { 0x1D }.Concat(requestId.ToByteArray()).ToArray() }, new StorageItem { Value = epoch.ToByteArray() });
        }

        public string BuildActionId(byte[] accountId, UInt160 executor, ulong expiresAt)
        {
            List<byte> material = new();
            material.AddRange(Encoding.UTF8.GetBytes(Network));
            material.Add(0x1f);
            material.AddRange(Core.ToArray());
            material.Add(0x1f);
            material.AddRange(accountId);
            material.Add(0x1f);
            material.AddRange(executor.ToArray());
            material.Add(0x1f);
            material.AddRange(Encoding.UTF8.GetBytes(Fx.CallInteger(Verifier, "getSessionNonce", accountId).ToString()));
            material.Add(0x1f);
            material.AddRange(Encoding.UTF8.GetBytes(expiresAt.ToString()));
            return "aa_proxy:" + Hex(material);
        }

        public string BuildRecoveryActionId(byte[] accountId, UInt160 newOwner, string recoveryNonce)
        {
            List<byte> material = new();
            material.AddRange(Encoding.UTF8.GetBytes(Network));
            material.Add(0x1f);
            material.AddRange(Core.ToArray());
            material.Add(0x1f);
            material.AddRange(accountId);
            material.Add(0x1f);
            material.AddRange(newOwner.ToArray());
            material.Add(0x1f);
            material.AddRange(Encoding.UTF8.GetBytes(recoveryNonce));
            return "aa_recovery:" + Hex(material);
        }

        public byte[] ComputeActionDigest(
            byte[] accountId,
            string accountIdText,
            UInt160 executor,
            string actionId,
            ulong expiresAt,
            byte[] actionNullifier)
        {
            List<byte> payload = new();
            payload.AddRange(ActionDomain);
            payload.AddRange(Segment(Network));
            payload.AddRange(Core.ToArray());
            payload.AddRange(accountId);
            payload.AddRange(Verifier.ToArray());
            payload.AddRange(Segment(accountIdText));
            payload.AddRange(executor.ToArray());
            payload.AddRange(Segment(actionId));
            payload.AddRange(Segment(expiresAt.ToString()));
            payload.AddRange(actionNullifier);
            return SHA256.HashData(payload.ToArray());
        }

        public byte[] ComputeActionDigestV4(byte[] accountId, string text, UInt160 executor,
            string actionId, ulong expiry, byte[] master, BigInteger epoch, byte[] nullifier,
            string? signingNetwork = null, UInt160? signingVerifier = null)
        {
            List<byte> bytes = new();
            bytes.AddRange(Encoding.ASCII.GetBytes("neodid-aa-action-v3"));
            bytes.AddRange(Segment(signingNetwork ?? Network)); bytes.AddRange(Core.ToArray()); bytes.AddRange(accountId);
            bytes.AddRange((signingVerifier ?? Verifier).ToArray()); bytes.AddRange(Segment(text)); bytes.AddRange(executor.ToArray());
            bytes.AddRange(Segment(actionId)); bytes.AddRange(Segment(expiry.ToString()));
            bytes.AddRange(nullifier); bytes.AddRange(master); bytes.AddRange(Segment(epoch.ToString()));
            return SHA256.HashData(bytes.ToArray());
        }

        public byte[] ComputeRecoveryDigest(
            byte[] accountId,
            string accountIdText,
            UInt160 newOwner,
            string recoveryNonce,
            string expiresAt,
            string actionId,
            byte[] masterNullifier,
            byte[] actionNullifier)
        {
            List<byte> payload = new();
            payload.AddRange(RecoveryDomain);
            payload.AddRange(Segment(Network));
            payload.AddRange(Core.ToArray());
            payload.AddRange(accountId);
            payload.AddRange(Verifier.ToArray());
            payload.AddRange(AccountAddress.ToArray());
            payload.AddRange(Segment(accountIdText));
            payload.AddRange(newOwner.ToArray());
            payload.AddRange(Segment(recoveryNonce));
            payload.AddRange(Segment(expiresAt));
            payload.AddRange(Segment(actionId));
            payload.AddRange(masterNullifier);
            payload.AddRange(actionNullifier);
            return SHA256.HashData(payload.ToArray());
        }

        private static string Hex(List<byte> material) =>
            Convert.ToHexString(SHA256.HashData(material.ToArray())).ToLowerInvariant();
    }

    private static byte[] Factor()
    {
        byte[] factor = new byte[32];
        for (int i = 0; i < factor.Length; i++) factor[i] = (byte)(i + 1);
        return factor;
    }

    private static byte[] Segment(string value)
    {
        byte[] body = Encoding.UTF8.GetBytes(value);
        byte[] result = new byte[body.Length + 1];
        result[0] = (byte)body.Length;
        Array.Copy(body, 0, result, 1, body.Length);
        return result;
    }

    // ========================================================================
    // Fix 1 — per-account oracle credit accounting
    // ========================================================================

    [TestMethod]
    public void Fix1_DepositOracleCredits_RequiresOwnerWitness()
    {
        RecoveryHarness h = new();
        using P256SessionKey verifierKey = new();
        byte[] accountId = h.SetupAccount("acct-fix1-owner", OwnerA, verifierKey.CompressedPublicKey);

        // Fund the account's oracle credit via a memo-tagged GAS payment.
        h.Fx.FundGasFromValidators(OwnerA, 10_000_000);
        h.Fx.SetSigners(OwnerA);
        h.Fx.TransferGas(OwnerA, h.Verifier, 4_000_000, accountId);
        Assert.AreEqual((BigInteger)4_000_000, h.Fx.CallInteger(h.Verifier, "getOracleCredit", accountId));

        // A non-owner cannot spend the account's credit.
        h.Fx.SetSigners(Attacker);
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Verifier, "depositOracleCredits", accountId, (BigInteger)1_000_000));
        StringAssert.Contains(blocked.Message, "Not owner");

        // Credit untouched after the failed attempt.
        Assert.AreEqual((BigInteger)4_000_000, h.Fx.CallInteger(h.Verifier, "getOracleCredit", accountId));
    }

    [TestMethod]
    public void Fix1_DepositOracleCredits_CannotExceedCreditedBalance()
    {
        RecoveryHarness h = new();
        using P256SessionKey verifierKey = new();
        byte[] accountId = h.SetupAccount("acct-fix1-balance", OwnerA, verifierKey.CompressedPublicKey);

        h.Fx.FundGasFromValidators(OwnerA, 10_000_000);
        h.Fx.SetSigners(OwnerA);
        h.Fx.TransferGas(OwnerA, h.Verifier, 3_000_000, accountId);

        // Spending more than was earmarked for this account is rejected.
        TestException overspend = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Verifier, "depositOracleCredits", accountId, (BigInteger)3_000_001));
        StringAssert.Contains(overspend.Message, "Insufficient oracle credit");

        // A legitimate spend within balance succeeds and decrements the credit.
        BigInteger oracleBefore = h.Fx.GasBalanceOf(Oracle);
        h.Fx.CallVoid(h.Verifier, "depositOracleCredits", accountId, (BigInteger)2_000_000);
        Assert.AreEqual((BigInteger)1_000_000, h.Fx.CallInteger(h.Verifier, "getOracleCredit", accountId));
        Assert.AreEqual(oracleBefore + 2_000_000, h.Fx.GasBalanceOf(Oracle));
    }

    [TestMethod]
    public void Fix1_OneAccountCannotDrainAnotherAccountsCredit()
    {
        RecoveryHarness h = new();
        using P256SessionKey keyA = new();
        using P256SessionKey keyB = new();
        byte[] victim = h.SetupAccount("acct-victim", OwnerA, keyA.CompressedPublicKey);
        byte[] attackerAccount = h.SetupAccount("acct-attacker", OwnerB, keyB.CompressedPublicKey);

        // Victim funds the pool generously; attacker funds nothing.
        h.Fx.FundGasFromValidators(OwnerA, 100_000_000);
        h.Fx.SetSigners(OwnerA);
        h.Fx.TransferGas(OwnerA, h.Verifier, 50_000_000, victim);

        // The attacker (owner of attackerAccount, with zero credit) tries to drain the pool
        // through their own account — must fail since their account has no credit.
        h.Fx.SetSigners(OwnerB);
        TestException drain = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Verifier, "depositOracleCredits", attackerAccount, (BigInteger)50_000_000));
        StringAssert.Contains(drain.Message, "Insufficient oracle credit");

        // Victim's earmarked credit is fully intact.
        Assert.AreEqual((BigInteger)50_000_000, h.Fx.CallInteger(h.Verifier, "getOracleCredit", victim));
        Assert.AreEqual((BigInteger)0, h.Fx.CallInteger(h.Verifier, "getOracleCredit", attackerAccount));
    }

    [TestMethod]
    public void Fix1_OnNEP17Payment_RejectsUnconfiguredAccountMemo()
    {
        RecoveryHarness h = new();
        h.Fx.FundGasFromValidators(OwnerA, 10_000_000);
        h.Fx.SetSigners(OwnerA);

        byte[] unknownAccount = AccountAddress.ToArray();
        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Fx.TransferGas(OwnerA, h.Verifier, 1_000_000, unknownAccount));
        StringAssert.Contains(rejected.Message, "Recovery not setup");
    }

    // ========================================================================
    // Fix 2 — action-session signature domain separation (no cross-account replay)
    // ========================================================================

    [TestMethod]
    public void Fix2_ActionSignatureIsBoundToAccount_AndCannotBeReplayed()
    {
        RecoveryHarness h = new();
        using P256SessionKey verifierKey = new();
        byte[] keyBytes = verifierKey.CompressedPublicKey;

        byte[] accountA = h.SetupAccount("acct-A", OwnerA, keyBytes);
        byte[] accountB = h.SetupAccount("acct-B", OwnerB, keyBytes);
        ulong expiresAt = (ulong)(h.Fx.Now() + 600_000);
        string actionIdA = h.BuildActionId(accountA, Executor, expiresAt);
        string actionIdB = h.BuildActionId(accountB, Executor, expiresAt);
        byte[] actionNullifier = new byte[32];
        for (int i = 0; i < actionNullifier.Length; i++) actionNullifier[i] = (byte)(0x40 + i);

        byte[] digestA = h.ComputeActionDigest(accountA, "acct-A", Executor, actionIdA, expiresAt, actionNullifier);
        byte[] signatureA = verifierKey.Sign(digestA);

        h.Fx.SetSigners(OwnerA, OwnerB, Executor);
        TestException replay = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "submitActionTicket",
                accountB, Executor, actionIdB, expiresAt, actionNullifier, signatureA));
        StringAssert.Contains(replay.Message, "Invalid Morpheus action signature");

        h.Fx.CallVoid(
            h.Verifier, "submitActionTicket",
            accountA, Executor, actionIdA, expiresAt, actionNullifier, signatureA);
        h.Fx.SetSigners(Executor);
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "verifyExecution", accountA));
    }

    [TestMethod]
    public void Fix2_ActionSignatureCannotReplayAcrossSameTextAccounts()
    {
        RecoveryHarness h = new();
        using P256SessionKey verifierKey = new();
        byte[] keyBytes = verifierKey.CompressedPublicKey;
        byte[] accountA = h.SetupAccount("shared-account", OwnerA, keyBytes);
        byte[] accountB = h.SetupAccount("shared-account", OwnerB, keyBytes);
        ulong expiresAt = (ulong)(h.Fx.Now() + 600_000);
        string actionIdA = h.BuildActionId(accountA, Executor, expiresAt);
        string actionIdB = h.BuildActionId(accountB, Executor, expiresAt);
        byte[] actionNullifier = new byte[32];
        byte[] signature = verifierKey.Sign(
            h.ComputeActionDigest(accountA, "shared-account", Executor, actionIdA, expiresAt, actionNullifier));

        h.Fx.SetSigners(OwnerA, OwnerB, Executor);
        h.Fx.CallVoid(h.Verifier, "submitActionTicket",
            accountA, Executor, actionIdA, expiresAt, actionNullifier, signature);
        TestException replay = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(
            h.Verifier, "submitActionTicket",
            accountB, Executor, actionIdB, expiresAt, actionNullifier, signature));
        StringAssert.Contains(replay.Message, "Invalid Morpheus action signature");
    }

    [TestMethod]
    public void Fix2_RecoverySignatureCannotReplayAcrossSameTextAccounts()
    {
        RecoveryHarness h = new();
        using P256SessionKey verifierKey = new();
        byte[] keyBytes = verifierKey.CompressedPublicKey;
        byte[] accountA = h.SetupAccount("shared-account", OwnerA, keyBytes);
        byte[] accountB = h.SetupAccount("shared-account", OwnerB, keyBytes);
        string expiresAt = (h.Fx.Now() + 600_000).ToString();
        string actionIdA = h.BuildRecoveryActionId(accountA, Attacker, "0");
        string actionIdB = h.BuildRecoveryActionId(accountB, Attacker, "0");
        byte[] actionNullifier = new byte[32];
        byte[] factor = Factor();
        byte[] signature = verifierKey.Sign(h.ComputeRecoveryDigest(
            accountA, "shared-account", Attacker, "0", expiresAt, actionIdA, factor, actionNullifier));

        h.Fx.CallVoid(h.Verifier, "submitRecoveryTicket",
            accountA, Attacker, "0", expiresAt, actionIdA, factor, actionNullifier, signature);
        TestException replay = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(
            h.Verifier, "submitRecoveryTicket",
            accountB, Attacker, "0", expiresAt, actionIdB, factor, actionNullifier, signature));
        StringAssert.Contains(replay.Message, "Invalid Morpheus recovery signature");
    }

    [TestMethod]
    public void Fix2_DirectTicketSubmissionRejectsForeignActionIds()
    {
        RecoveryHarness h = new();
        using P256SessionKey verifierKey = new();
        byte[] accountId = h.SetupAccount("action-binding", OwnerA, verifierKey.CompressedPublicKey);
        ulong actionExpiresAt = (ulong)(h.Fx.Now() + 600_000);
        string recoveryExpiresAt = actionExpiresAt.ToString();
        byte[] actionNullifier = new byte[32];
        byte[] factor = Factor();
        const string foreignRecoveryAction = "aa_recovery:foreign";
        const string foreignSessionAction = "aa_proxy:foreign";
        byte[] recoverySignature = verifierKey.Sign(h.ComputeRecoveryDigest(
            accountId, "action-binding", Attacker, "0", recoveryExpiresAt,
            foreignRecoveryAction, factor, actionNullifier));
        byte[] actionSignature = verifierKey.Sign(h.ComputeActionDigest(
            accountId, "action-binding", Executor, foreignSessionAction,
            actionExpiresAt, actionNullifier));

        TestException recovery = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(
            h.Verifier, "submitRecoveryTicket", accountId, Attacker, "0", recoveryExpiresAt,
            foreignRecoveryAction, factor, actionNullifier, recoverySignature));
        StringAssert.Contains(recovery.Message, "Recovery action does not match the account");

        h.Fx.SetSigners(OwnerA, OwnerB, Executor);
        TestException session = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(
            h.Verifier, "submitActionTicket", accountId, Executor, foreignSessionAction,
            actionExpiresAt, actionNullifier, actionSignature));
        StringAssert.Contains(session.Message, "Action session does not match the account");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Verifier, "getSessionNonce", accountId));
    }

    // ========================================================================
    [TestMethod]
    public void LegacyActionTicket_ExecutorOnlyMustNotActivate()
    {
        // This witness uses only pre-v4 APIs, so baseline failure must be an
        // accepted unauthorized session, not a missing new method.
        RecoveryHarness h = new(); using P256SessionKey key = new();
        byte[] account = h.SetupAccount("legacy", OwnerA, key.CompressedPublicKey), nullifier = new byte[32];
        ulong expiry = (ulong)(h.Fx.Now() + 600_000); string id = h.BuildActionId(account, Executor, expiry);
        byte[] signature = key.Sign(h.ComputeActionDigest(account, "legacy", Executor, id, expiry, nullifier));
        h.Fx.SetSigners(Executor);
        Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Verifier, "submitActionTicket", account, Executor, id, expiry, nullifier, signature));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Verifier, "getSessionNonce", account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "isActionNullifierUsed", account, nullifier));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
    }

    // DID-R1 v4 regressions: authored against the existing real contract harness.
    // Not executed by the source-only author phase; freshly built NEFs are required.
    [TestMethod]
    public void ActionV4_RecoveryFactorAloneCannotActivateAndRollsBack()
    {
        RecoveryHarness h = new(); using P256SessionKey key = new();
        byte[] account = h.SetupAccount("v4", OwnerA, key.CompressedPublicKey);
        byte[] master = Factor(), nullifier = new byte[32];
        BigInteger epoch = h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account);
        ulong expiry = (ulong)(h.Fx.Now() + 600_000);
        string id = h.BuildActionId(account, Executor, expiry);
        byte[] signature = key.Sign(h.ComputeActionDigestV4(account, "v4", Executor, id, expiry, master, epoch, nullifier));
        h.Fx.SetSigners(Executor);
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "isAllowedMasterNullifier", account, master));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "isAllowedActionIdentity", account, master));
        TestException error = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Verifier, "submitActionTicketV4",
            account, Executor, id, expiry, master, epoch, nullifier, signature));
        StringAssert.Contains(error.Message, "Action identity not enrolled");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Verifier, "getSessionNonce", account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "isActionNullifierUsed", account, nullifier));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
    }

    [TestMethod]
    public void ActionV4_ExplicitEnrollmentAllowsOwnerlessSessionAndRevocationInvalidates()
    {
        RecoveryHarness h = new(); using P256SessionKey key = new();
        byte[] account = h.SetupAccount("v4", OwnerA, key.CompressedPublicKey), master = Factor(), nullifier = new byte[32];
        h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, true);
        BigInteger epoch = h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account);
        ulong expiry = (ulong)(h.Fx.Now() + 600_000); string id = h.BuildActionId(account, Executor, expiry);
        byte[] signature = key.Sign(h.ComputeActionDigestV4(account, "v4", Executor, id, expiry, master, epoch, nullifier));
        h.Fx.SetSigners(Executor);
        h.Fx.CallVoid(h.Verifier, "submitActionTicketV4", account, Executor, id, expiry, master, epoch, nullifier, signature);
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "verifyExecutionMetaTx", account, new object?[] { Executor }));
        h.Fx.SetSigners(OwnerA); h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, false);
        Assert.IsTrue(h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account) > epoch);
        h.Fx.SetSigners(Executor);
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "verifyExecutionMetaTx", account, new object?[] { Executor }));
        Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Verifier, "submitActionTicketV4",
            account, Executor, id, expiry, master, epoch, nullifier, signature));
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(h.Verifier, "getSessionNonce", account));
    }

    [TestMethod]
    public void ActionV4_EnrollmentNeedsCurrentOwnerAndDoesNotBlessLegacySessions()
    {
        RecoveryHarness h = new(); using P256SessionKey key = new();
        byte[] account = h.SetupAccount("v4", OwnerA, key.CompressedPublicKey), master = Factor();
        BigInteger epoch = h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account);
        h.Fx.SetSigners(Attacker);
        Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, true));
        Assert.AreEqual(epoch, h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "isAllowedActionIdentity", account, master));
    }

    [TestMethod]
    public void ActionV4_LegacyDirectTicketRequiresRealOwnerWitness()
    {
        RecoveryHarness h = new(); using P256SessionKey key = new();
        byte[] account = h.SetupAccount("legacy", OwnerA, key.CompressedPublicKey), nullifier = new byte[32];
        h.DeleteNewActionStorage(account, 0x1A);
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account));
        ulong expiry = (ulong)(h.Fx.Now() + 600_000); string id = h.BuildActionId(account, Executor, expiry);
        byte[] signature = key.Sign(h.ComputeActionDigest(account, "legacy", Executor, id, expiry, nullifier));
        h.Fx.SetSigners(Executor);
        TestException error = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Verifier, "submitActionTicket",
            account, Executor, id, expiry, nullifier, signature));
        StringAssert.Contains(error.Message, "Not owner");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Verifier, "getSessionNonce", account));
        h.Fx.SetSigners(OwnerA, Executor);
        h.Fx.CallVoid(h.Verifier, "submitActionTicket", account, Executor, id, expiry, nullifier, signature);
        h.Fx.SetSigners(Executor); Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
        Assert.IsTrue(h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account) > 0);
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "isAllowedActionIdentity", account, Factor()));
    }

    [TestMethod]
    public void ActionV4_AddingAnotherIdentityPreservesGrantsButInvalidatesOldEpoch()
    {
        RecoveryHarness h = new(); using P256SessionKey key = new();
        byte[] account = h.SetupAccount("v4", OwnerA, key.CompressedPublicKey), master = Factor(), second = new byte[32];
        second[0] = 0x71;
        h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, true);
        BigInteger oldEpoch = h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account);
        h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, second, true);
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "isAllowedActionIdentity", account, master));
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "isAllowedActionIdentity", account, second));
        byte[] nullifier = new byte[32]; ulong expiry = (ulong)(h.Fx.Now() + 600_000);
        string id = h.BuildActionId(account, Executor, expiry);
        byte[] signature = key.Sign(h.ComputeActionDigestV4(account, "v4", Executor, id, expiry, master, oldEpoch, nullifier));
        h.Fx.SetSigners(Executor);
        TestException error = Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Verifier, "submitActionTicketV4",
            account, Executor, id, expiry, master, oldEpoch, nullifier, signature));
        StringAssert.Contains(error.Message, "Stale action authorization epoch");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Verifier, "getSessionNonce", account));
    }

    [TestMethod]
    public void ActionV4_UnmarkedLegacySessionNeedsExactCurrentOwnerReauthorization()
    {
        RecoveryHarness h = new(); using P256SessionKey key = new();
        byte[] account = h.SetupAccount("legacy", OwnerA, key.CompressedPublicKey), nullifier = new byte[32];
        ulong expiry = (ulong)(h.Fx.Now() + 600_000); string id = h.BuildActionId(account, Executor, expiry);
        byte[] signature = key.Sign(h.ComputeActionDigest(account, "legacy", Executor, id, expiry, nullifier));
        h.Fx.SetSigners(OwnerA, Executor);
        h.Fx.CallVoid(h.Verifier, "submitActionTicket", account, Executor, id, expiry, nullifier, signature);
        h.DeleteNewActionStorage(account, 0x1A); h.DeleteNewActionStorage(account, 0x1C);
        h.Fx.SetSigners(Executor);
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "isActionSessionAuthorized", account));
        h.Fx.SetSigners(Attacker);
        Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Verifier, "reauthorizeActiveActionSession", account, Executor, id, expiry, nullifier));
        h.Fx.SetSigners(OwnerA);
        Assert.ThrowsExactly<TestException>(() => h.Fx.CallVoid(h.Verifier, "reauthorizeActiveActionSession", account, Attacker, id, expiry, nullifier));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account));
        h.Fx.CallVoid(h.Verifier, "reauthorizeActiveActionSession", account, Executor, id, expiry, nullifier);
        h.Fx.SetSigners(Executor); Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "isActionSessionAuthorized", account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "isAllowedActionIdentity", account, Factor()));
    }

    [TestMethod]
    public void ActionV4_ExecutionAndAuthorizationGetterAgreeAtExactExpiry()
    {
        RecoveryHarness h = new(); using P256SessionKey key = new();
        byte[] account = h.SetupAccount("legacy", OwnerA, key.CompressedPublicKey), nullifier = new byte[32];
        ulong expiry = (ulong)(h.Fx.Now() + 1_000); string id = h.BuildActionId(account, Executor, expiry);
        byte[] signature = key.Sign(h.ComputeActionDigest(account, "legacy", Executor, id, expiry, nullifier));
        h.Fx.SetSigners(OwnerA, Executor);
        h.Fx.CallVoid(h.Verifier, "submitActionTicket", account, Executor, id, expiry, nullifier, signature);
        h.Fx.SetSigners(Executor); h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(999));
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "isActionSessionAuthorized", account));
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(1));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "isActionSessionAuthorized", account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "verifyExecutionMetaTx", account, new object?[] { Executor }));
    }

    [TestMethod]
    public void ActionV4_OracleCallbackRequiresCurrentGrantAndOriginalEpoch()
    {
        RecoveryHarness h = new(); using P256SessionKey key = new();
        UInt160 oracle = h.Fx.Deploy("MockVerifierCore");
        byte[] account = h.SetupAccount("oracle", OwnerA, key.CompressedPublicKey, oracle: oracle), master = Factor();
        h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, true);
        BigInteger epoch = h.Fx.CallInteger(h.Verifier, "getActionAuthorizationEpoch", account);
        ulong expiry = (ulong)(h.Fx.Now() + 600_000);
        string id = h.BuildActionId(account, Executor, expiry);
        byte[] badMaster = new byte[32], badNullifier = new byte[32]; badMaster[0] = 0x7a; badNullifier[0] = 0x31;
        byte[] badSignature = key.Sign(h.ComputeActionDigestV4(account, "oracle", Executor, id, expiry, badMaster, epoch, badNullifier));
        h.SeedActionOracleRequest(1, account, Executor, id, expiry, epoch);
        string Packet(byte[] factor, BigInteger generation, byte[] nullifier, byte[] signature) =>
            "4|" + Convert.ToBase64String(factor) + "|" + generation + "|" + Convert.ToBase64String(nullifier) + "|" + Convert.ToBase64String(signature);
        void Deliver(int request, string packet) => h.Fx.CallVoid(oracle, "forward", h.Verifier, "onOracleResult",
            new object?[] { (BigInteger)request, "neodid_action_ticket", true, Encoding.UTF8.GetBytes(packet), "" });
        h.Fx.SetSigners(Executor);
        Assert.ThrowsExactly<TestException>(() => Deliver(1, Packet(badMaster, epoch, badNullifier, badSignature)));
        Assert.AreEqual(BigInteger.Zero, h.Fx.CallInteger(h.Verifier, "getSessionNonce", account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "isActionNullifierUsed", account, badNullifier));
        // The failed callback rolls back deletion of request 1, which can then
        // receive a valid response for the same exact request context.
        byte[] goodNullifier = new byte[32]; goodNullifier[0] = 0x32;
        byte[] signature = key.Sign(h.ComputeActionDigestV4(account, "oracle", Executor, id, expiry, master, epoch, goodNullifier));
        Deliver(1, Packet(master, epoch, goodNullifier, signature));
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
        string nextId = h.BuildActionId(account, Executor, expiry);
        byte[] nextNullifier = new byte[32]; nextNullifier[0] = 0x33;
        byte[] staleSignature = key.Sign(h.ComputeActionDigestV4(account, "oracle", Executor, nextId, expiry, master, epoch, nextNullifier));
        h.SeedActionOracleRequest(2, account, Executor, nextId, expiry, epoch);
        h.Fx.SetSigners(OwnerA);
        h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, false);
        h.Fx.CallVoid(h.Verifier, "setActionIdentity", account, master, true);
        h.Fx.SetSigners(Executor);
        Assert.ThrowsExactly<TestException>(() => Deliver(2, Packet(master, epoch, nextNullifier, staleSignature)));
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(h.Verifier, "getSessionNonce", account));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "isActionNullifierUsed", account, nextNullifier));
        Assert.IsFalse(h.Fx.CallBoolean(h.Verifier, "verifyExecution", account));
    }

    // Fix 3 — recovery timelock bounds (estate-standard 7–90 day window)
    // ========================================================================

    [TestMethod]
    public void Fix3_SetupRecovery_RejectsTimelockBelowMinimum()
    {
        RecoveryHarness h = new();
        using P256SessionKey verifierKey = new();
        byte[] keyBytes = verifierKey.CompressedPublicKey;

        // AA-06: setup now requires a core-registered account; register one up front. The
        // timelock assert runs before the anti-squat checks, so the rejections below fault
        // on the timelock alone.
        byte[] accountId = h.RegisterAccount(OwnerA);
        byte[] factor = Factor();

        h.Fx.SetSigners(OwnerA);

        // timelock = 0 (instant seizure) is rejected.
        TestException zero = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "setupRecovery",
                accountId, "acct-fix3-setup", Network, OwnerA, h.Core, AccountAddress, Oracle,
                new object?[] { factor }, (BigInteger)1, (ulong)0, keyBytes));
        StringAssert.Contains(zero.Message, "Timelock below minimum");

        // The old 1h floor is also below the estate-standard minimum now.
        TestException oldFloor = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "setupRecovery",
                accountId, "acct-fix3-setup", Network, OwnerA, h.Core, AccountAddress, Oracle,
                new object?[] { factor }, (BigInteger)1, (ulong)3_600_000, keyBytes));
        StringAssert.Contains(oldFloor.Message, "Timelock below minimum");

        // Just below the 7-day minimum is rejected.
        TestException tooSmall = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "setupRecovery",
                accountId, "acct-fix3-setup", Network, OwnerA, h.Core, AccountAddress, Oracle,
                new object?[] { factor }, (BigInteger)1, MinRecoveryTimelockMs - 1, keyBytes));
        StringAssert.Contains(tooSmall.Message, "Timelock below minimum");

        // Exactly 7 days (MIN boundary) is accepted.
        h.Fx.CallVoid(
            h.Verifier, "setupRecovery",
            accountId, "acct-fix3-setup", Network, OwnerA, h.Core, AccountAddress, Oracle,
            new object?[] { factor }, (BigInteger)1, MinRecoveryTimelockMs, keyBytes);
        Assert.AreEqual((BigInteger)MinRecoveryTimelockMs, h.Fx.CallInteger(h.Verifier, "getTimelock", accountId));
    }

    [TestMethod]
    public void Fix3_SetupRecovery_RejectsTimelockAboveMaximum()
    {
        RecoveryHarness h = new();
        using P256SessionKey verifierKey = new();
        byte[] keyBytes = verifierKey.CompressedPublicKey;

        byte[] accountId = h.RegisterAccount(OwnerA);
        byte[] factor = Factor();

        h.Fx.SetSigners(OwnerA);

        // Just above the 90-day maximum is rejected.
        TestException tooLarge = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "setupRecovery",
                accountId, "acct-fix3-setup-max", Network, OwnerA, h.Core, AccountAddress, Oracle,
                new object?[] { factor }, (BigInteger)1, MaxRecoveryTimelockMs + 1, keyBytes));
        StringAssert.Contains(tooLarge.Message, "Timelock above maximum");

        // Exactly 90 days (MAX boundary) is accepted.
        h.Fx.CallVoid(
            h.Verifier, "setupRecovery",
            accountId, "acct-fix3-setup-max", Network, OwnerA, h.Core, AccountAddress, Oracle,
            new object?[] { factor }, (BigInteger)1, MaxRecoveryTimelockMs, keyBytes);
        Assert.AreEqual((BigInteger)MaxRecoveryTimelockMs, h.Fx.CallInteger(h.Verifier, "getTimelock", accountId));
    }

    [TestMethod]
    public void Fix3_UpdateRecoveryConfig_RejectsTimelockBelowMinimum()
    {
        RecoveryHarness h = new();
        using P256SessionKey verifierKey = new();
        byte[] keyBytes = verifierKey.CompressedPublicKey;
        byte[] accountId = h.SetupAccount("acct-fix3-update", OwnerA, keyBytes, MinRecoveryTimelockMs);

        byte[] factor = Factor();

        h.Fx.SetSigners(OwnerA);
        TestException tooSmall = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "updateRecoveryConfig",
                accountId, Oracle, new object?[] { factor }, (BigInteger)1, (ulong)0, keyBytes));
        StringAssert.Contains(tooSmall.Message, "Timelock below minimum");

        // Just below the 7-day minimum is rejected as well.
        TestException belowMin = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "updateRecoveryConfig",
                accountId, Oracle, new object?[] { factor }, (BigInteger)1, MinRecoveryTimelockMs - 1, keyBytes));
        StringAssert.Contains(belowMin.Message, "Timelock below minimum");

        // A valid update at twice the minimum succeeds.
        h.Fx.CallVoid(
            h.Verifier, "updateRecoveryConfig",
            accountId, Oracle, new object?[] { factor }, (BigInteger)1, MinRecoveryTimelockMs * 2, keyBytes);
        Assert.AreEqual((BigInteger)(MinRecoveryTimelockMs * 2), h.Fx.CallInteger(h.Verifier, "getTimelock", accountId));
    }

    [TestMethod]
    public void Fix3_UpdateRecoveryConfig_RejectsTimelockAboveMaximum()
    {
        RecoveryHarness h = new();
        using P256SessionKey verifierKey = new();
        byte[] keyBytes = verifierKey.CompressedPublicKey;
        byte[] accountId = h.SetupAccount("acct-fix3-update-max", OwnerA, keyBytes);

        byte[] factor = Factor();

        h.Fx.SetSigners(OwnerA);

        // Just above the 90-day maximum is rejected.
        TestException tooLarge = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "updateRecoveryConfig",
                accountId, Oracle, new object?[] { factor }, (BigInteger)1, MaxRecoveryTimelockMs + 1, keyBytes));
        StringAssert.Contains(tooLarge.Message, "Timelock above maximum");

        // Exactly 90 days (MAX boundary) is accepted.
        h.Fx.CallVoid(
            h.Verifier, "updateRecoveryConfig",
            accountId, Oracle, new object?[] { factor }, (BigInteger)1, MaxRecoveryTimelockMs, keyBytes);
        Assert.AreEqual((BigInteger)MaxRecoveryTimelockMs, h.Fx.CallInteger(h.Verifier, "getTimelock", accountId));
    }
}
