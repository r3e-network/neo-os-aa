using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Behavioral VM tests for audit finding AA-06: <c>SocialRecoveryVerifier.SetupRecovery</c>
/// was first-write-wins with NO proof of account control. Its <c>CheckWitness(owner)</c> did
/// not help — an attacker passes THEIR OWN address as <c>owner</c> (they can witness
/// themselves), binding a victim's known accountId to attacker-controlled nullifiers/verifier,
/// permanently DoSing the legit owner's setup and making the attacker the recovery root for
/// that accountId.
///
/// The fix mirrors the repo's plugin invariant (VerifierAuthority M-7): the verifier pins a
/// canonical AA core (<c>setAuthorizedCore</c>, initial-set-only and contract-admin gated;
/// re-pointing flows through the 7-day <c>proposeAuthorizedCore</c>/<c>confirmAuthorizedCore</c>
/// window), and <c>setupRecovery</c> requires <c>aaContract == authorizedCore()</c> plus the
/// core's <c>getBackupOwner(accountId)</c> — the registry of record — to attest the claimed
/// owner.
/// </summary>
[TestClass]
public class Fix_RecoverySquat_Tests
{
    private const string Network = "neo3-testnet";

    // 7 days in Runtime.Time milliseconds — the estate-standard minimum recovery timelock.
    private const ulong SevenDaysMs = 604_800_000;

    private static readonly UInt160 OwnerA =
        UInt160.Parse("0x1111111111111111111111111111111111111111");
    private static readonly UInt160 OwnerB =
        UInt160.Parse("0x2222222222222222222222222222222222222222");
    private static readonly UInt160 AccountAddress =
        UInt160.Parse("0x4444444444444444444444444444444444444444");
    private static readonly UInt160 Oracle =
        UInt160.Parse("0x5555555555555555555555555555555555555555");
    private static readonly UInt160 OtherCore =
        UInt160.Parse("0x7777777777777777777777777777777777777777");
    private static readonly UInt160 Stranger =
        UInt160.Parse("0x9999999999999999999999999999999999999999");

    private static readonly TimeSpan Window = TimeSpan.FromDays(7);

    private sealed class SquatHarness
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Core { get; }
        public UInt160 Verifier { get; }

        public SquatHarness(bool bindCore = true)
        {
            Core = Fx.Deploy("UnifiedSmartWalletV3");
            Verifier = Fx.Deploy("SocialRecoveryVerifier");
            if (bindCore)
            {
                // Deployer (validators) is the contract admin; bind the canonical core.
                Fx.CallVoid(Verifier, "setAuthorizedCore", Core);
            }
        }

        /// <summary>
        /// Registers an account on the real AA core with <paramref name="owner"/> as its backup
        /// owner and returns the core-derived 20-byte account id.
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

        /// <summary>Valid setup arguments for <paramref name="accountId"/>; vary one field per test.</summary>
        public object?[] SetupArgs(byte[] accountId, UInt160 owner, UInt160 aaContract, byte[] verifierPubKey)
        {
            return new object?[]
            {
                accountId, "acct-squat", Network, owner, aaContract, AccountAddress, Oracle,
                new object?[] { Factor() }, (BigInteger)1, SevenDaysMs, verifierPubKey
            };
        }
    }

    private static byte[] Factor()
    {
        byte[] factor = new byte[32];
        for (int i = 0; i < factor.Length; i++) factor[i] = (byte)(i + 1);
        return factor;
    }

    // ========================================================================
    // (a) happy path — correct core + registered account whose backupOwner == owner
    // ========================================================================

    [TestMethod]
    public void AA06_SetupRecovery_WithRegisteredOwner_Succeeds()
    {
        SquatHarness h = new();
        using P256SessionKey verifierKey = new();
        byte[] accountId = h.RegisterAccount(OwnerA);

        h.Fx.SetSigners(OwnerA);
        h.Fx.CallVoid(h.Verifier, "setupRecovery", h.SetupArgs(accountId, OwnerA, h.Core, verifierKey.CompressedPublicKey));

        Assert.AreEqual((BigInteger)SevenDaysMs, h.Fx.CallInteger(h.Verifier, "getTimelock", accountId),
            "Setup stored for the attested account");

        // The account is now first-write-locked: a second setup (even by the owner) is rejected.
        TestException duplicate = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Verifier, "setupRecovery", h.SetupArgs(accountId, OwnerA, h.Core, verifierKey.CompressedPublicKey)));
        StringAssert.Contains(duplicate.Message, "Recovery already setup");
    }

    // ========================================================================
    // (b) the squat shape — attacker witnesses their OWN key for a victim's accountId
    // ========================================================================

    [TestMethod]
    public void AA06_SetupRecovery_SquatWithOwnWitnessedKey_Faults()
    {
        SquatHarness h = new();
        using P256SessionKey verifierKey = new();

        // The victim's account is registered on the canonical core with OwnerA as backup owner.
        byte[] victimAccount = h.RegisterAccount(OwnerA);

        // The attacker witnesses their OWN key and passes their own address as owner — the old
        // first-write-wins check accepted exactly this. Now the core's registry contradicts the
        // claimed owner, so the squat is rejected and nothing is stored.
        h.Fx.SetSigners(OwnerB);
        TestException squat = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "setupRecovery",
                h.SetupArgs(victimAccount, OwnerB, h.Core, verifierKey.CompressedPublicKey)));
        StringAssert.Contains(squat.Message, "owner does not control account");

        // No DoS residue: the legit owner can still complete their own setup afterwards.
        h.Fx.SetSigners(OwnerA);
        h.Fx.CallVoid(h.Verifier, "setupRecovery", h.SetupArgs(victimAccount, OwnerA, h.Core, verifierKey.CompressedPublicKey));
        Assert.AreEqual((BigInteger)SevenDaysMs, h.Fx.CallInteger(h.Verifier, "getTimelock", victimAccount));
    }

    // ========================================================================
    // (c) caller-supplied aaContract that is not the pinned canonical core
    // ========================================================================

    [TestMethod]
    public void AA06_SetupRecovery_WithNonAuthorizedCore_Faults()
    {
        SquatHarness h = new();
        using P256SessionKey verifierKey = new();
        byte[] accountId = h.RegisterAccount(OwnerA);

        h.Fx.SetSigners(OwnerA);

        // A second, genuine AA core is still not THE pinned core — a squatter cannot route the
        // attestation through a core of their choosing.
        UInt160 foreignCore = h.Fx.Deploy("UnifiedSmartWalletV3");
        TestException foreign = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "setupRecovery",
                h.SetupArgs(accountId, OwnerA, foreignCore, verifierKey.CompressedPublicKey)));
        StringAssert.Contains(foreign.Message, "aaContract is not the authorized core");

        // An arbitrary address is rejected the same way.
        TestException arbitrary = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "setupRecovery",
                h.SetupArgs(accountId, OwnerA, Stranger, verifierKey.CompressedPublicKey)));
        StringAssert.Contains(arbitrary.Message, "aaContract is not the authorized core");
    }

    [TestMethod]
    public void AA06_SetupRecovery_WithoutAuthorizedCoreConfigured_Faults()
    {
        SquatHarness h = new(bindCore: false);
        using P256SessionKey verifierKey = new();
        byte[] accountId = h.RegisterAccount(OwnerA);

        h.Fx.SetSigners(OwnerA);
        TestException unbound = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "setupRecovery",
                h.SetupArgs(accountId, OwnerA, h.Core, verifierKey.CompressedPublicKey)));
        StringAssert.Contains(unbound.Message, "Authorized AA core not configured");
    }

    // ========================================================================
    // (e) unknown / malformed account ids
    // ========================================================================

    [TestMethod]
    public void AA06_SetupRecovery_UnknownAccount_Faults()
    {
        SquatHarness h = new();
        using P256SessionKey verifierKey = new();

        // A well-formed 20-byte id that was never registered: the canonical core's registry
        // has no state for it, so the attestation read itself faults.
        byte[] unknownAccount = AccountAddress.ToArray();
        h.Fx.SetSigners(OwnerA);
        TestException unknown = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "setupRecovery",
                h.SetupArgs(unknownAccount, OwnerA, h.Core, verifierKey.CompressedPublicKey)));
        StringAssert.Contains(unknown.Message, "Account not found");
    }

    [TestMethod]
    public void AA06_SetupRecovery_RejectsNonAccountShapedId()
    {
        SquatHarness h = new();
        using P256SessionKey verifierKey = new();

        // A non-20-byte id can never name a core-registered AA account.
        byte[] legacyTextId = System.Text.Encoding.ASCII.GetBytes("acct-legacy-text");
        h.Fx.SetSigners(OwnerA);
        TestException malformed = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(
                h.Verifier, "setupRecovery",
                h.SetupArgs(legacyTextId, OwnerA, h.Core, verifierKey.CompressedPublicKey)));
        StringAssert.Contains(malformed.Message, "invalid");
    }

    // ========================================================================
    // (d) AuthorizedCore administration — initial-set-only + 7-day re-pointing
    // ========================================================================

    [TestMethod]
    public void AA06_AuthorizedCore_InitialSetOnly_AndAdminGated()
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("UnifiedSmartWalletV3");
        UInt160 verifier = fx.Deploy("SocialRecoveryVerifier");

        Assert.AreEqual(UInt160.Zero, fx.CallUInt160(verifier, "authorizedCore"), "Core starts unset");

        // A stranger cannot bind the core.
        fx.SetSigners(Stranger);
        TestException notAdmin = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(verifier, "setAuthorizedCore", core));
        StringAssert.Contains(notAdmin.Message, "Not contract admin");

        // The contract admin binds the core exactly once.
        fx.SetSigners(fx.Engine.ValidatorsAddress);
        fx.CallVoid(verifier, "setAuthorizedCore", core);
        Assert.AreEqual(core, fx.CallUInt160(verifier, "authorizedCore"), "Initial set succeeds");

        // Instant re-pointing is rejected; the timelocked lane is the only way.
        TestException rebind = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(verifier, "setAuthorizedCore", OtherCore));
        StringAssert.Contains(rebind.Message, "core already set; use ProposeAuthorizedCore");
        Assert.AreEqual(core, fx.CallUInt160(verifier, "authorizedCore"), "Core unchanged after rejection");
    }

    [TestMethod]
    public void AA06_AuthorizedCore_ProposeConfirm_HonorsWindowAndCancel()
    {
        SquatHarness h = new();

        // A stranger cannot propose a re-pointing.
        h.Fx.SetSigners(Stranger);
        TestException notAdmin = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Verifier, "proposeAuthorizedCore", OtherCore));
        StringAssert.Contains(notAdmin.Message, "Not contract admin");

        // The admin pins the proposed core; re-pointing does not happen on propose.
        h.Fx.SetSigners(h.Fx.Engine.ValidatorsAddress);
        h.Fx.CallVoid(h.Verifier, "proposeAuthorizedCore", OtherCore);
        Assert.AreEqual(h.Core, h.Fx.CallUInt160(h.Verifier, "authorizedCore"), "Core must not move on propose");

        // Confirming inside the window is rejected, including one second before expiry.
        TestException early = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Verifier, "confirmAuthorizedCore", OtherCore),
            "Confirm inside the window must be rejected");
        StringAssert.Contains(early.Message, "Core change timelock not expired");

        h.Fx.AdvanceTime(Window - TimeSpan.FromSeconds(1));
        Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Verifier, "confirmAuthorizedCore", OtherCore),
            "Confirm one second before expiry must be rejected");

        h.Fx.AdvanceTime(TimeSpan.FromSeconds(1));

        // A mismatched confirmation target is rejected even after the window.
        TestException mismatch = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Verifier, "confirmAuthorizedCore", Stranger));
        StringAssert.Contains(mismatch.Message, "Pending core mismatch");

        // The exact proposed core is confirmed after the window; the proposal is single-use.
        h.Fx.CallVoid(h.Verifier, "confirmAuthorizedCore", OtherCore);
        Assert.AreEqual(OtherCore, h.Fx.CallUInt160(h.Verifier, "authorizedCore"), "Core re-pointed after the window");

        TestException replay = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Verifier, "confirmAuthorizedCore", OtherCore),
            "A confirmed change must not be replayable");
        StringAssert.Contains(replay.Message, "No pending core change");

        // Cancellation clears a pending change entirely.
        h.Fx.CallVoid(h.Verifier, "proposeAuthorizedCore", Stranger);
        h.Fx.CallVoid(h.Verifier, "cancelAuthorizedCoreChange");
        TestException cancelled = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Verifier, "confirmAuthorizedCore", Stranger));
        StringAssert.Contains(cancelled.Message, "No pending core change");
        Assert.AreEqual(OtherCore, h.Fx.CallUInt160(h.Verifier, "authorizedCore"), "Core unchanged after cancel");
    }
}
