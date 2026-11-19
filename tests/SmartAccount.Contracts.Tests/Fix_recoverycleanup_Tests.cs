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
/// Regression coverage for the recovery service's account-scoped cleanup.
///
/// Protocol v4 retired the verifier model: the SA core no longer calls a verifier
/// callback (<c>clearAccount</c>) from <c>confirmVerifierUpdate</c>, an escape or a
/// Market settle. <c>SocialRecoveryService</c> is the account's recorded recovery
/// authority instead of an installed module, so the core's
/// <c>beginRecovery</c>/<c>executeRecovery</c> path is callback-free and this service
/// keeps its own row. Cleanup is therefore explicit and owner-gated:
/// <c>clearAccount</c> cancels any pending core recovery, wipes every account-scoped
/// recovery record, refunds GAS still earmarked for the account's Morpheus oracle to
/// the on-record owner, and retains the replay-protection markers (consumed action
/// nullifiers and the action epoch) so a later re-setup cannot accept an
/// already-executed ticket.
/// </summary>
[TestClass]
public class Fix_RecoveryCleanup_Tests
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
        /// Creates a protocol-v4 account whose custody is <paramref name="owner"/> and
        /// whose recorded recovery authority is this service. Registration installs the
        /// recovery policy atomically, so no 24 h configuration-intent wait separates
        /// creation from the recovery setup below.
        /// </summary>
        public UInt160 RegisterAccount(UInt160 owner)
        {
            _registrations += 1;
            byte[] salt = RuntimeFixture.Salt("cleanup-" + _registrations + "-" + owner);
            UInt160 accountId = Fx.CallUInt160(Wallet, "computeAccountIdentity", owner, salt);
            object[] actions =
            {
                RuntimeFixture.SetRecoveryPolicy(Recovery, RecoveryTimelockMs)
            };
            // Naming a non-zero recovery authority requires that subject's witness.
            Fx.SetSigners(owner, Recovery);
            Fx.CallVoid(Wallet, "createAccount", accountId, owner, salt, RecoveryTimelockMs, actions);
            Assert.AreEqual(Recovery, RecoveryAuthorityOf(accountId), "Precondition: recovery authority bound");
            return accountId;
        }

        public UInt160 RecoveryAuthorityOf(UInt160 accountId) =>
            new UInt160(Fx.AccountControl(Wallet, accountId)[3].GetSpan());

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
            Assert.AreEqual(amount, Fx.CallInteger(Recovery, "getOracleCredit", accountId), "Precondition: credit earmarked");
        }

        public void ClearAccount(UInt160 accountId, UInt160 signer)
        {
            Fx.SetSigners(signer);
            Fx.CallVoid(Recovery, "clearAccount", accountId);
        }

        /// <summary>The service's account-scoped records read back through its public getters.</summary>
        public void AssertRecoveryStateCleared(UInt160 accountId)
        {
            Assert.AreEqual(UInt160.Zero, Fx.CallUInt160(Recovery, "getOwner", accountId), "owner cleared");
            Assert.AreEqual(UInt160.Zero, Fx.CallUInt160(Recovery, "getSAContract", accountId), "sa contract cleared");
            Assert.AreEqual(UInt160.Zero, Fx.CallUInt160(Recovery, "getMorpheusOracle", accountId), "oracle cleared");
            Assert.AreEqual(BigInteger.Zero, Fx.CallInteger(Recovery, "getThreshold", accountId), "threshold cleared");
            Assert.AreEqual(BigInteger.Zero, Fx.CallInteger(Recovery, "getTimelock", accountId), "timelock cleared");
            Assert.AreEqual(BigInteger.Zero, Fx.CallInteger(Recovery, "getRecoveryNonce", accountId), "nonce cleared");
            Assert.AreEqual(BigInteger.Zero, Fx.CallInteger(Recovery, "getOracleCredit", accountId), "credit cleared");
            Neo.VM.Types.Array factors = (Neo.VM.Types.Array)Fx.Call(Recovery, "getMasterNullifiers", accountId);
            Assert.AreEqual(0, factors.Count, "factors cleared");
        }

        /// <summary>Starts the core-side recovery record directly (recovery-authority witness).</summary>
        public void BeginCoreRecovery(UInt160 accountId, UInt160 newCustody)
        {
            Fx.SetSigners(Owner, newCustody);
            Fx.CallVoid(Wallet, "beginRecovery", accountId, newCustody);
        }

        public Neo.VM.Types.Array CoreRecoveryStatus(UInt160 accountId) =>
            (Neo.VM.Types.Array)Fx.Call(Wallet, "getRecoveryStatus", accountId);

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

    private static byte[] Factor()
    {
        byte[] factor = new byte[32];
        for (int i = 0; i < factor.Length; i++) factor[i] = (byte)(i + 1);
        return factor;
    }

    // ============================================================================
    // The wipe itself: records gone, credit refunded, replay markers retained.
    // ============================================================================

    [TestMethod]
    public void ClearAccount_WipesRecoveryStateAndRefundsOracleCredit()
    {
        using P256SessionKey morpheusKey = new();
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Owner);
        h.SetupRecovery(accountId, Owner, morpheusKey);
        h.FundOracleCredit(accountId, OracleCredit);

        byte[] actionIdentity = new byte[32]; actionIdentity[0] = 0x71;
        h.Fx.SetSigners(Owner);
        h.Fx.CallVoid(h.Recovery, "setActionIdentity", accountId, actionIdentity, true);
        BigInteger epochBefore = h.Fx.CallInteger(h.Recovery, "getActionAuthorizationEpoch", accountId);
        BigInteger ownerBefore = h.Fx.GasBalanceOf(Owner);
        BigInteger verifierBefore = h.Fx.GasBalanceOf(h.Recovery);

        h.ClearAccount(accountId, Owner);
        // Notifications are captured per call, so read the cleanup event before any further query.
        Neo.VM.Types.Array cleared = h.Fx.SingleNotificationState(h.Recovery, "RecoveryCleared");
        Assert.AreEqual(accountId, new UInt160(cleared[0].GetSpan()));
        Assert.AreEqual(Owner, new UInt160(cleared[1].GetSpan()));
        Assert.AreEqual(OracleCredit, cleared[2].GetInteger());

        h.AssertRecoveryStateCleared(accountId);

        // The epoch is deliberately retained across cleanup: it is the replay guard that
        // keeps an in-flight action grant from reviving a later re-setup.
        BigInteger epochAfterClear = h.Fx.CallInteger(h.Recovery, "getActionAuthorizationEpoch", accountId);
        Assert.IsTrue(epochAfterClear > epochBefore, "clear must advance and retain the action epoch");
        Assert.IsFalse(h.Fx.CallBoolean(h.Recovery, "isAllowedActionIdentity", accountId, actionIdentity));

        // The earmarked oracle GAS goes back to the recovery owner instead of being orphaned.
        Assert.AreEqual(ownerBefore + OracleCredit, h.Fx.GasBalanceOf(Owner), "credit refunded to owner");
        Assert.AreEqual(verifierBefore - OracleCredit, h.Fx.GasBalanceOf(h.Recovery), "verifier no longer holds the credit");

        // Cleanup is service-scoped: the account itself stays fully controllable by its
        // custody (a config write still lands) and there is no residue to clear again.
        h.Fx.SetSigners(Owner);
        h.Fx.CallVoid(h.Wallet, "setMetadataUri", accountId, "ipfs://cleanup");
        TestException again = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Recovery, "clearAccount", accountId));
        StringAssert.Contains(again.Message, "Not owner");

        // Same core/raw account/owner setup must not reset authorization generation.
        h.SetupRecovery(accountId, Owner, morpheusKey);
        Assert.IsTrue(h.Fx.CallInteger(h.Recovery, "getActionAuthorizationEpoch", accountId) > epochAfterClear);
        Assert.IsFalse(h.Fx.CallBoolean(h.Recovery, "isAllowedActionIdentity", accountId, actionIdentity));
    }

    // ============================================================================
    // Ledger alignment: a core recovery pending on the SA side is cancelled first,
    // so the service row and the core record cannot diverge.
    // ============================================================================

    [TestMethod]
    public void ClearAccount_CancelsThePendingCoreRecovery()
    {
        using P256SessionKey morpheusKey = new();
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Owner);
        h.SetupRecovery(accountId, Owner, morpheusKey);

        h.BeginCoreRecovery(accountId, NewOwner);
        Neo.VM.Types.Array pending = h.CoreRecoveryStatus(accountId);
        Assert.AreEqual(5, pending.Count, "Precondition: the core holds a recovery record");
        Assert.IsTrue(pending[0].GetBoolean());
        Assert.AreEqual(NewOwner, new UInt160(pending[4].GetSpan()));

        h.ClearAccount(accountId, Owner);

        Assert.AreEqual(0, h.CoreRecoveryStatus(accountId).Count, "the core record must be cancelled, not orphaned");
        Assert.AreEqual(Owner, h.Fx.AccountCustody(h.Wallet, accountId), "custody untouched by a cancelled recovery");
        h.AssertRecoveryStateCleared(accountId);

        // A cancelled record can never settle later, so the account keeps its custody.
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(RecoveryTimelockMs + 60_000));
        TestException settle = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "executeRecovery", accountId));
        StringAssert.Contains(settle.Message, "SA_RECOVERY_PENDING");
        Assert.AreEqual(Owner, h.Fx.AccountCustody(h.Wallet, accountId));
    }

    // ============================================================================
    // Settlement: v4 rotates custody on the core and the service row follows, so the
    // cleanup (and its refund) belongs to the new custody — never the old one.
    // ============================================================================

    [TestMethod]
    public void ClearAccount_AfterCoreSettlement_BelongsToTheNewCustody()
    {
        using P256SessionKey morpheusKey = new();
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Owner);
        h.SetupRecovery(accountId, Owner, morpheusKey);
        h.FundOracleCredit(accountId, OracleCredit);
        BigInteger ownerAfterFunding = h.Fx.GasBalanceOf(Owner);

        string nonce = h.Fx.CallInteger(h.Recovery, "getRecoveryNonce", accountId).ToString();
        string expiresAt = (h.Fx.Now() + 600_000).ToString();
        string actionId = h.BuildRecoveryActionId(accountId, NewOwner, nonce);
        byte[] nullifier = Enumerable.Repeat((byte)0x31, 32).ToArray();
        byte[] signature = morpheusKey.Sign(h.ComputeRecoveryDigest(
            accountId, NewOwner, nonce, expiresAt, actionId, Factor(), nullifier));

        h.Fx.SetSigners(Owner);
        h.Fx.CallVoid(h.Recovery, "submitRecoveryTicket", accountId, NewOwner, nonce,
            expiresAt, actionId, Factor(), nullifier, signature);

        // The service timelock matures first; v4 then splits the old one-shot finalize
        // into the core record (finalizeRecovery -> beginRecovery, which also needs the
        // new custody's witness) and the custody rotation
        // (settleRecovery -> executeRecovery after the core timelock).
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(RecoveryTimelockMs));
        h.Fx.SetSigners(NewOwner);
        h.Fx.CallVoid(h.Recovery, "finalizeRecovery", accountId);
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds(RecoveryTimelockMs));
        h.Fx.CallVoid(h.Recovery, "settleRecovery", accountId);

        Assert.AreEqual(NewOwner, h.Fx.AccountCustody(h.Wallet, accountId), "custody rotated on the core");
        Assert.AreEqual(NewOwner, h.Fx.CallUInt160(h.Recovery, "getOwner", accountId), "service row followed the core");

        h.ClearAccount(accountId, NewOwner);
        Neo.VM.Types.Array cleared = h.Fx.SingleNotificationState(h.Recovery, "RecoveryCleared");
        Assert.AreEqual(NewOwner, new UInt160(cleared[1].GetSpan()), "the settled row belongs to the new custody");
        Assert.AreEqual(OracleCredit, cleared[2].GetInteger());

        Assert.AreEqual(ownerAfterFunding, h.Fx.GasBalanceOf(Owner), "the previous custody is not paid");
        Assert.AreEqual(OracleCredit, h.Fx.GasBalanceOf(NewOwner), "the refund follows the row owner");
        h.AssertRecoveryStateCleared(accountId);
    }

    // ============================================================================
    // Authorization: only the on-record owner's witness authorizes the wipe.
    // ============================================================================

    [TestMethod]
    public void ClearAccount_RejectsCallersOtherThanTheOnRecordOwner()
    {
        using P256SessionKey morpheusKey = new();
        Harness h = new();
        UInt160 accountId = h.RegisterAccount(Owner);

        // No setup yet means no on-record owner: even the account's own custody is refused,
        // which keeps the method idempotent rather than silently "clearing" a foreign row.
        TestException unset = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Recovery, "clearAccount", accountId));
        StringAssert.Contains(unset.Message, "Not owner");

        h.SetupRecovery(accountId, Owner, morpheusKey);

        // A stranger witnessing themselves is refused; the record names the custody.
        h.Fx.SetSigners(Stranger);
        TestException stranger = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Recovery, "clearAccount", accountId));
        StringAssert.Contains(stranger.Message, "Not owner");
        Assert.AreEqual(Owner, h.Fx.CallUInt160(h.Recovery, "getOwner", accountId), "configuration untouched");

        // The gate is the owner witness, not the caller's identity: a contract relaying
        // the call on a stranger's behalf is refused just the same.
        UInt160 impostor = h.Fx.Deploy("MockVerifierCore");
        TestException relayed = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(impostor, "forward", h.Recovery, "clearAccount", new object?[] { accountId }));
        StringAssert.Contains(relayed.Message, "Not owner");
        Assert.AreEqual(Owner, h.Fx.CallUInt160(h.Recovery, "getOwner", accountId), "configuration untouched");
    }

    // ============================================================================
    // Source pin: v4 grants the service only the core calls it makes, and the wipe
    // must keep the replay-protection families.
    // ============================================================================

    [TestMethod]
    public void RecoveryService_PinsTheOwnerGatedCleanupSurface()
    {
        string lifecycle = File.ReadAllText(
            Path.Combine(RepoRoot, "contracts", "plugins", "recovery", "SocialRecoveryService.Lifecycle.cs"));
        StringAssert.Contains(lifecycle, "public static void ClearAccount(UInt160 accountId)");
        StringAssert.Contains(lifecycle, "AssertOwner(accountId);");
        StringAssert.Contains(lifecycle, "CancelCoreRecoveryIfPending(accountId);");
        // Replay markers survive cleanup on purpose; every other account-scoped family is removed.
        Assert.IsFalse(lifecycle.Contains("Key(PREFIX_USED_ACTION, accountId)", StringComparison.Ordinal),
            "consumed action nullifiers are replay protection and must not be cleared");
        StringAssert.Contains(lifecycle, "DeleteAccountPrefixFamily(Key(PREFIX_APPROVAL, accountId));");
        // The cleanup must keep the two recovery ledgers aligned before wiping.
        StringAssert.Contains(lifecycle, "\"getRecoveryStatus\"");
        StringAssert.Contains(lifecycle, "\"cancelRecovery\"");

        string fixedSource = File.ReadAllText(
            Path.Combine(RepoRoot, "contracts", "plugins", "recovery", "SocialRecoveryService.Fixed.cs"));
        StringAssert.Contains(fixedSource, "[DisplayName(\"RecoveryCleared\")]");
        // v4 call surface: the core lifecycle the service drives, and no verifier callback.
        StringAssert.Contains(fixedSource, "[ContractPermission(\"*\", \"beginRecovery\")]");
        StringAssert.Contains(fixedSource, "[ContractPermission(\"*\", \"executeRecovery\")]");
        StringAssert.Contains(fixedSource, "[ContractPermission(\"*\", \"getRecoveryStatus\")]");
        StringAssert.Contains(fixedSource, "[ContractPermission(\"*\", \"cancelRecovery\")]");
        StringAssert.Contains(fixedSource, "[ContractPermission(\"*\", \"getAccount\")]");
        Assert.IsFalse(fixedSource.Contains("canConfigureVerifier", StringComparison.Ordinal),
            "protocol v4 retired the verifier-callback permission");
    }
}
