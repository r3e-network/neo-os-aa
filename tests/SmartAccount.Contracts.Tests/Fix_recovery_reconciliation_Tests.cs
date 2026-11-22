using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Regression coverage for the recovery service's idempotent reconciliation.
///
/// The core keeps <c>executeRecovery</c> permissionless and callback-free, so a third
/// party may complete a matured recovery between the service's <c>finalizeRecovery</c>
/// (which starts the core record) and <c>settleRecovery</c>. That used to strand the
/// service: <c>settleRecovery</c> re-entered <c>executeRecovery</c>, the core record was
/// already gone, the call faulted, and the service kept trusting the superseded owner —
/// including that owner's control of the GAS earmarked for the account's oracle.
///
/// The fix persists the core generation and target the service approved, verifies the
/// authoritative completion, and adopts it (owner, pending, nonce, action authorization,
/// session) without a second recovery. This suite pins that behaviour and the fact that
/// the superseded owner loses every owner-gated surface.
/// </summary>
[TestClass]
public class Fix_RecoveryReconciliation_Tests
{
    private const string Network = "neo3-testnet";

    // Estate-standard recovery timelock (Runtime.Time milliseconds).
    private const ulong RecoveryTimelockMs = 604_800_000;

    private static readonly byte[] RecoveryDomain = Encoding.ASCII.GetBytes("neodid-recovery-v2");

    private static readonly UInt160 Owner =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 NewOwner =
        UInt160.Parse("0x2222222222222222222222222222222222222222");

    private static readonly UInt160 Oracle =
        UInt160.Parse("0x5555555555555555555555555555555555555555");

    private static readonly UInt160 AccountAddress =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly UInt160 Stranger =
        UInt160.Parse("0x9999999999999999999999999999999999999999");

    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly BigInteger OracleCredit = 250_000_000; // 2.5 GAS

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Recovery { get; }

        private int _registrations;

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            Recovery = Fx.Deploy("SocialRecoveryService");
            Fx.CallVoid(Recovery, "setAuthorizedCore", Wallet);
        }

        /// <summary>
        /// Creates a protocol-v4 account whose custody is <paramref name="owner"/> and whose
        /// recorded recovery authority is this service, so the callback-free core recovery is
        /// the only path that can rotate custody.
        /// </summary>
        public UInt160 RegisterAccount(UInt160 owner)
        {
            _registrations += 1;
            byte[] salt = RuntimeFixture.Salt("reconcile-" + _registrations + "-" + owner);
            UInt160 accountId = Fx.CallUInt160(Wallet, "computeAccountIdentity", owner, salt);
            object[] actions = { RuntimeFixture.SetRecoveryPolicy(Recovery, RecoveryTimelockMs) };
            // Naming a non-zero recovery authority requires that subject's witness.
            Fx.SetSigners(owner, Recovery);
            Fx.CallVoid(Wallet, "createAccount", accountId, owner, salt, RecoveryTimelockMs, actions);
            Assert.AreEqual(Recovery, RecoveryAuthorityOf(accountId), "Precondition: recovery authority bound");
            return accountId;
        }

        public UInt160 RecoveryAuthorityOf(UInt160 accountId) =>
            new(Fx.AccountControl(Wallet, accountId)[3].GetSpan());

        public void SetupRecovery(UInt160 accountId, UInt160 owner, P256SessionKey morpheusKey)
        {
            Fx.SetSigners(owner);
            Fx.CallVoid(
                Recovery, "setupRecovery",
                accountId, accountId.ToString(), Network, owner, Wallet, AccountAddress, Oracle,
                new object?[] { Factor() }, (BigInteger)1, RecoveryTimelockMs, morpheusKey.CompressedPublicKey);
            Assert.AreEqual(owner, Fx.CallUInt160(Recovery, "getOwner", accountId), "Precondition: recovery configured");
        }

        public void FundOracleCredit(UInt160 accountId, BigInteger amount)
        {
            Fx.FundGasFromValidators(Owner, amount * 2);
            Fx.SetSigners(Owner);
            Fx.TransferGas(Owner, Recovery, amount, accountId);
            Assert.AreEqual(amount, Fx.CallInteger(Recovery, "getOracleCredit", accountId),
                "Precondition: credit earmarked");
        }

        /// <summary>Submits the single-factor ticket that reaches the threshold immediately.</summary>
        public void SubmitTicket(UInt160 accountId, UInt160 newOwner, P256SessionKey morpheusKey, byte nullifierFill)
        {
            string nonce = Fx.CallInteger(Recovery, "getRecoveryNonce", accountId).ToString();
            string expiresAt = (Fx.Now() + 600_000).ToString();
            string actionId = BuildRecoveryActionId(accountId, newOwner, nonce);
            byte[] nullifier = Enumerable.Repeat(nullifierFill, 32).ToArray();
            byte[] signature = morpheusKey.Sign(ComputeRecoveryDigest(
                accountId, newOwner, nonce, expiresAt, actionId, Factor(), nullifier));

            Fx.SetSigners(Owner);
            Fx.CallVoid(Recovery, "submitRecoveryTicket", accountId, newOwner, nonce,
                expiresAt, actionId, Factor(), nullifier, signature);
        }

        /// <summary>The service's approved start of the core recovery (needs the target's witness).</summary>
        public void FinalizeRecovery(UInt160 accountId, UInt160 newOwner)
        {
            Fx.SetSigners(newOwner);
            Fx.CallVoid(Recovery, "finalizeRecovery", accountId);
        }

        /// <summary>The permissionless core completion, driven by an unrelated account.</summary>
        public void ExecuteCoreRecovery(UInt160 accountId, UInt160 signer)
        {
            Fx.SetSigners(signer);
            Fx.CallVoid(Wallet, "executeRecovery", accountId);
        }

        public void SettleRecovery(UInt160 accountId, UInt160 signer)
        {
            Fx.SetSigners(signer);
            Fx.CallVoid(Recovery, "settleRecovery", accountId);
        }

        public Neo.VM.Types.Array CoreRecoveryStatus(UInt160 accountId) =>
            (Neo.VM.Types.Array)Fx.Call(Wallet, "getRecoveryStatus", accountId);

        public BigInteger ActionEpoch(UInt160 accountId) =>
            Fx.CallInteger(Recovery, "getActionAuthorizationEpoch", accountId);

        public string BuildRecoveryActionId(UInt160 accountId, UInt160 newOwner, string recoveryNonce)
        {
            List<byte> material = new();
            material.AddRange(Encoding.UTF8.GetBytes(Network));
            material.Add(0x1f);
            material.AddRange(Wallet.ToArray());
            material.Add(0x1f);
            material.AddRange(accountId.ToArray());
            material.Add(0x1f);
            material.AddRange(newOwner.ToArray());
            material.Add(0x1f);
            material.AddRange(Encoding.UTF8.GetBytes(recoveryNonce));
            return "sa_recovery:" + Convert.ToHexString(SHA256.HashData(material.ToArray())).ToLowerInvariant();
        }

        /// <summary>The ticket digest the service verifies (spec: recovery domain separation).</summary>
        public byte[] ComputeRecoveryDigest(
            UInt160 accountId, UInt160 newOwner, string recoveryNonce,
            string expiresAt, string actionId, byte[] masterNullifier, byte[] actionNullifier)
        {
            List<byte> payload = new();
            payload.AddRange(RecoveryDomain);
            payload.AddRange(Segment(Network));
            payload.AddRange(Wallet.ToArray());
            payload.AddRange(accountId.ToArray());
            payload.AddRange(Recovery.ToArray());
            payload.AddRange(AccountAddress.ToArray());
            payload.AddRange(Segment(accountId.ToString()));
            payload.AddRange(newOwner.ToArray());
            payload.AddRange(Segment(recoveryNonce));
            payload.AddRange(Segment(expiresAt));
            payload.AddRange(Segment(actionId));
            payload.AddRange(masterNullifier);
            payload.AddRange(actionNullifier);
            return SHA256.HashData(payload.ToArray());
        }

        private static byte[] Segment(string value)
        {
            byte[] body = Encoding.UTF8.GetBytes(value);
            byte[] encoded = new byte[body.Length + 1];
            encoded[0] = (byte)body.Length;
            System.Array.Copy(body, 0, encoded, 1, body.Length);
            return encoded;
        }
    }

    internal static byte[] Factor()
    {
        byte[] factor = new byte[32];
        for (int i = 0; i < factor.Length; i++) factor[i] = (byte)(i + 1);
        return factor;
    }

    // ============================================================================
    // The reported defect: third-party core completion, then service settlement.
    // ============================================================================

    [TestMethod]
    public void ThirdPartyCoreExecution_ThenSettle_AdoptsTheAuthoritativeOwner()
    {
        using P256SessionKey morpheusKey = new();
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Owner);
        h.SetupRecovery(accountId, Owner, morpheusKey);
        h.FundOracleCredit(accountId, OracleCredit);

        h.SubmitTicket(accountId, NewOwner, morpheusKey, nullifierFill: 0x41);
        BigInteger epochBefore = h.ActionEpoch(accountId);

        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(RecoveryTimelockMs));
        h.FinalizeRecovery(accountId, NewOwner);
        Assert.AreEqual(5, h.CoreRecoveryStatus(accountId).Count,
            "Precondition: finalizeRecovery started the core recovery");
        Assert.AreEqual(NewOwner, new UInt160(h.CoreRecoveryStatus(accountId)[4].GetSpan()));

        // A permissionless third party completes the recovery before the service settles.
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(RecoveryTimelockMs));
        h.ExecuteCoreRecovery(accountId, Stranger);
        Assert.AreEqual(NewOwner, h.Fx.AccountCustody(h.Wallet, accountId),
            "Precondition: the core rotated custody");
        Assert.AreEqual(0, h.CoreRecoveryStatus(accountId).Count,
            "Precondition: the core record is consumed");
        Assert.AreEqual(Owner, h.Fx.CallUInt160(h.Recovery, "getOwner", accountId),
            "Precondition: the service row is still stale");

        // Settlement adopts the authoritative result instead of re-running executeRecovery.
        h.SettleRecovery(accountId, Stranger);

        Assert.AreEqual(NewOwner, h.Fx.CallUInt160(h.Recovery, "getOwner", accountId),
            "the service owner must follow the core custody");
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(h.Recovery, "getRecoveryNonce", accountId),
            "the reconciled recovery consumes the service nonce");
        Assert.IsTrue(h.ActionEpoch(accountId) > epochBefore,
            "the reconciliation must invalidate prior action authorization");
        Assert.IsFalse(h.Fx.CallBoolean(h.Recovery, "isActionSessionAuthorized", accountId),
            "no pre-recovery session may survive");

        // Idempotent: settling again is a no-op rather than a fault, which also proves the
        // pending record and its binding were cleared.
        h.SettleRecovery(accountId, Stranger);
        Assert.AreEqual(NewOwner, h.Fx.CallUInt160(h.Recovery, "getOwner", accountId));
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(h.Recovery, "getRecoveryNonce", accountId));
    }

    // ============================================================================
    // The second half of the defect: the superseded owner must lose the credit.
    // ============================================================================

    [TestMethod]
    public void ReconciledRecovery_DeniesTheSupersededOwnerEveryOwnerSurface()
    {
        using P256SessionKey morpheusKey = new();
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Owner);
        h.SetupRecovery(accountId, Owner, morpheusKey);
        h.FundOracleCredit(accountId, OracleCredit);
        BigInteger ownerGasBefore = h.Fx.GasBalanceOf(Owner);

        h.SubmitTicket(accountId, NewOwner, morpheusKey, nullifierFill: 0x42);
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(RecoveryTimelockMs));
        h.FinalizeRecovery(accountId, NewOwner);
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(RecoveryTimelockMs));
        h.ExecuteCoreRecovery(accountId, Stranger);

        // The service row still names the old owner at this point. The owner gate therefore
        // reconciles before it checks the witness, so every attempt by the superseded owner
        // faults — and a fault rolls the reconciliation back, which is exactly why the credit
        // can never reach the old owner: the only successful path is one the new custody takes.
        Assert.AreEqual(Owner, h.Fx.CallUInt160(h.Recovery, "getOwner", accountId),
            "Precondition: the service row still names the superseded owner");

        h.Fx.SetSigners(Owner);
        TestException spend = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Recovery, "depositOracleCredits", accountId, (BigInteger)1));
        StringAssert.Contains(spend.Message, "Not owner");

        TestException clear = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Recovery, "clearAccount", accountId));
        StringAssert.Contains(clear.Message, "Not owner");

        h.Fx.SetSigners(Owner);
        TestException reconfigure = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Recovery, "updateRecoveryConfig", accountId, Oracle,
                new object?[] { Factor() }, (BigInteger)1, RecoveryTimelockMs,
                morpheusKey.CompressedPublicKey));
        StringAssert.Contains(reconfigure.Message, "Not owner");

        // Nothing leaked to the superseded owner and nothing was spent on its behalf.
        Assert.AreEqual(ownerGasBefore, h.Fx.GasBalanceOf(Owner), "the old owner received nothing");
        Assert.AreEqual(OracleCredit, h.Fx.CallInteger(h.Recovery, "getOracleCredit", accountId),
            "the old owner could not touch the earmarked credit");

        // The recovered owner's first successful call persists the reconciliation and moves
        // the credit under the new custody.
        h.Fx.SetSigners(NewOwner);
        h.Fx.CallVoid(h.Recovery, "depositOracleCredits", accountId, (BigInteger)100_000_000);
        Assert.AreEqual(NewOwner, h.Fx.CallUInt160(h.Recovery, "getOwner", accountId),
            "a successful owner call reconciles the row to the authoritative custody");
        Assert.AreEqual(OracleCredit - 100_000_000,
            h.Fx.CallInteger(h.Recovery, "getOracleCredit", accountId));

        // With the row reconciled, the old owner is refused outright.
        h.Fx.SetSigners(Owner);
        TestException stale = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Recovery, "depositOracleCredits", accountId, (BigInteger)1));
        StringAssert.Contains(stale.Message, "Not owner");

        h.Fx.SetSigners(NewOwner);
        h.Fx.CallVoid(h.Recovery, "clearAccount", accountId);
        Neo.VM.Types.Array cleared = h.Fx.SingleNotificationState(h.Recovery, "RecoveryCleared");
        Assert.AreEqual(NewOwner, new UInt160(cleared[1].GetSpan()),
            "the refund belongs to the recovered owner");
        Assert.AreEqual(OracleCredit - 100_000_000, cleared[2].GetInteger());
        Assert.AreEqual(UInt160.Zero, h.Fx.CallUInt160(h.Recovery, "getOwner", accountId));
    }

    // ============================================================================
    // Guards: settlement needs a service-approved core recovery, and finalize is
    // idempotent so the approval binding survives a repeated call.
    // ============================================================================

    [TestMethod]
    public void SettleRecovery_WithoutAServiceApproval_IsRejected()
    {
        using P256SessionKey morpheusKey = new();
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Owner);
        h.SetupRecovery(accountId, Owner, morpheusKey);

        h.SubmitTicket(accountId, NewOwner, morpheusKey, nullifierFill: 0x43);
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(RecoveryTimelockMs));

        // The threshold and service timelock matured, but the service never started the
        // core recovery. Settling here would be a custody rotation no approval covered.
        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.SettleRecovery(accountId, Stranger));
        StringAssert.Contains(rejected.Message, "Recovery not finalized");
        Assert.AreEqual(0, h.CoreRecoveryStatus(accountId).Count,
            "a rejected settlement must not touch the core");
        Assert.AreEqual(Owner, h.Fx.AccountCustody(h.Wallet, accountId));
        Assert.AreEqual(Owner, h.Fx.CallUInt160(h.Recovery, "getOwner", accountId));
    }

    [TestMethod]
    public void FinalizeRecovery_Twice_KeepsOneCoreRecoveryAndItsBinding()
    {
        using P256SessionKey morpheusKey = new();
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Owner);
        h.SetupRecovery(accountId, Owner, morpheusKey);

        h.SubmitTicket(accountId, NewOwner, morpheusKey, nullifierFill: 0x44);
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(RecoveryTimelockMs));
        h.FinalizeRecovery(accountId, NewOwner);

        // A second finalize must not restart (the core refuses a second record) and must
        // not overwrite the persisted generation.
        h.FinalizeRecovery(accountId, NewOwner);
        Neo.VM.Types.Array status = h.CoreRecoveryStatus(accountId);
        Assert.AreEqual(5, status.Count, "exactly one core recovery record");
        Assert.AreEqual(NewOwner, new UInt160(status[4].GetSpan()));

        // The approved generation is still recognised, so a third-party completion
        // reconciles exactly as it does after a single finalize.
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(RecoveryTimelockMs));
        h.ExecuteCoreRecovery(accountId, Stranger);
        h.SettleRecovery(accountId, Stranger);

        Assert.AreEqual(NewOwner, h.Fx.CallUInt160(h.Recovery, "getOwner", accountId));
        Assert.AreEqual(NewOwner, h.Fx.AccountCustody(h.Wallet, accountId));
        Assert.AreEqual(BigInteger.One, h.Fx.CallInteger(h.Recovery, "getRecoveryNonce", accountId));
    }

    // ============================================================================
    // Source pin: the reconciliation contract is present where it must be.
    // ============================================================================

    [TestMethod]
    public void RecoveryService_PinsTheIdempotentReconciliationSurface()
    {
        string lifecycle = File.ReadAllText(
            Path.Combine(RepoRoot, "contracts", "plugins", "recovery", "SocialRecoveryService.Lifecycle.cs"));
        StringAssert.Contains(lifecycle,
            "private static bool ReconcileAuthoritativeRecovery(UInt160 accountId)");
        StringAssert.Contains(lifecycle, "if (ReconcileAuthoritativeRecovery(accountId)) return;");
        StringAssert.Contains(lifecycle,
            "SaveRecoveryBinding(accountId, (BigInteger)status[3], pending.NewOwner);");
        StringAssert.Contains(lifecycle, "ExecutionEngine.Assert(HasRecoveryBinding(accountId), \"Recovery not finalized\");");
        // The core entry points stay permissionless and callback-free: the service only
        // calls the documented core surface, never a hook/verifier callback.
        StringAssert.Contains(lifecycle, "\"executeRecovery\"");
        StringAssert.Contains(lifecycle, "\"beginRecovery\"");

        string validation = File.ReadAllText(
            Path.Combine(RepoRoot, "contracts", "plugins", "recovery", "SocialRecoveryService.Validation.cs"));
        StringAssert.Contains(validation, "ReconcileAuthoritativeRecovery(accountId);");

        string fixedSource = File.ReadAllText(
            Path.Combine(RepoRoot, "contracts", "plugins", "recovery", "SocialRecoveryService.Fixed.cs"));
        StringAssert.Contains(fixedSource, "PREFIX_RECOVERY_BINDING_EPOCH = 0x1E");
        StringAssert.Contains(fixedSource, "PREFIX_RECOVERY_BINDING_TARGET = 0x1F");

        string storage = File.ReadAllText(
            Path.Combine(RepoRoot, "contracts", "plugins", "recovery", "SocialRecoveryService.Storage.cs"));
        StringAssert.Contains(storage, "ClearRecoveryBinding(accountId);");
    }
}
