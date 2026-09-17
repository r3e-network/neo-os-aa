using System;
using System.Collections.Generic;
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
public class FixRecoveryTests
{
    private const string Network = "neo3-testnet";

    // Estate-standard recovery timelock window (Runtime.Time milliseconds): 7–90 days,
    // mirroring the AA core escape hatch's 604800–7776000 seconds.
    private const ulong MinRecoveryTimelockMs = 604_800_000;
    private const ulong MaxRecoveryTimelockMs = 7_776_000_000;

    // ASCII("neodid-action-v1") — the action domain tag baked into the contract.
    private static readonly byte[] ActionDomain = Encoding.ASCII.GetBytes("neodid-action-v1");

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
            ulong timelock = MinRecoveryTimelockMs)
        {
            byte[] accountId = RegisterAccount(owner);
            byte[] factor = Factor();

            Fx.SetSigners(owner);
            Fx.CallVoid(
                Verifier, "setupRecovery",
                accountId, accountIdText, Network, owner, Core, AccountAddress, Oracle,
                new object?[] { factor }, (BigInteger)1, timelock, verifierPubKey);
            return accountId;
        }

        /// <summary>
        /// Host-side mirror of the contract's <c>ComputeActionDigest</c>:
        /// SHA256( ACTION_DOMAIN || seg(network) || verifierScriptHash || seg(accountIdText)
        ///         || executor || seg(actionId) || seg(expiresAt) || actionNullifier ).
        /// </summary>
        public byte[] ComputeActionDigest(
            string accountIdText,
            UInt160 executor,
            string actionId,
            ulong expiresAt,
            byte[] actionNullifier)
        {
            List<byte> payload = new();
            payload.AddRange(ActionDomain);
            payload.AddRange(Segment(Network));
            payload.AddRange(Verifier.ToArray());
            payload.AddRange(Segment(accountIdText));
            payload.AddRange(executor.ToArray());
            payload.AddRange(Segment(actionId));
            payload.AddRange(Segment(expiresAt.ToString()));
            payload.AddRange(actionNullifier);
            return SHA256.HashData(payload.ToArray());
        }
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

        // Two accounts share the SAME Morpheus verifier key.
        byte[] accountA = h.SetupAccount("acct-A", OwnerA, keyBytes);
        byte[] accountB = h.SetupAccount("acct-B", OwnerB, keyBytes);

        ulong expiresAt = (ulong)(h.Fx.Now() + 600_000);
        string actionId = "aa_proxy:test-action";
        byte[] actionNullifier = new byte[32];
        for (int i = 0; i < actionNullifier.Length; i++) actionNullifier[i] = (byte)(0x40 + i);

        // Sign the digest the contract computes for account A.
        byte[] digestA = h.ComputeActionDigest("acct-A", Executor, actionId, expiresAt, actionNullifier);
        byte[] signatureA = verifierKey.Sign(digestA);

        // Replaying account A's signature against account B must fail (digest mismatch),
        // proving the signature is bound to the account / contract / network / expiry.
        h.Fx.SetSigners(Executor);
        TestException replay = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "submitActionTicket",
                accountB, Executor, actionId, expiresAt, actionNullifier, signatureA));
        StringAssert.Contains(replay.Message, "Invalid Morpheus action signature");

        // The same signature succeeds for the account it was issued for.
        h.Fx.CallVoid(
            h.Verifier, "submitActionTicket",
            accountA, Executor, actionId, expiresAt, actionNullifier, signatureA);

        // And the session is now active for account A.
        Assert.IsTrue(h.Fx.CallBoolean(h.Verifier, "verifyExecution", accountA));
    }

    // ========================================================================
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
