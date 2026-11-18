using System;
using System.IO;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Behavioral VM tests for audit findings H5 / H6 / SA-04: the two fund-holding auxiliary
/// contracts had INSTANT admin operations while the rest of the repo enforces the
/// SA-D-01/SA-D-02 7-day timelock standard.
///
///   H5  — <c>SocialRecoveryVerifier.Update</c> was instant although the contract custodies
///         user GAS (the per-account oracle-credit pool funded via <c>onNEP17Payment</c>).
///   SA-04 — <c>SocialRecoveryVerifier.TransferAdmin</c> was an instant role hand-off.
///   H6  — <c>SAAddressMarket.Update</c> and <c>SAAddressMarket.SetAdmin</c> were instant
///         although the contract holds in-flight buyer escrow.
///
/// The fix mirrors the shared <c>VerifierAuthority</c> idiom inline (neither contract routes
/// through an authority helper): <c>proposeUpdate(sha256(nef), sha256(manifest))</c> pins the
/// artifact pair and <c>update</c>/<c>confirmUpdate</c> applies exactly that pair after the
/// 7-day window; <c>rotateAdmin</c>/<c>confirmAdminRotation</c>/<c>cancelAdminRotation</c>
/// replace the instant <c>transferAdmin</c>/<c>setAdmin</c> hand-offs, with confirmation gated
/// on the proposed admin's own witness.
/// </summary>
[TestClass]
public class Fix_CustodyTimelock_Tests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string CompiledContractsDir = Path.Combine(RepoRoot, "contracts", "bin", "public");

    private static readonly UInt160 ContractManagementHash =
        UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd");

    private static readonly UInt160 Stranger =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly UInt160 NewAdmin =
        UInt160.Parse("0x9999999999999999999999999999999999999999");

    private static readonly TimeSpan Window = TimeSpan.FromDays(7);

    private const string RecoveryArtifact = "SocialRecoveryVerifier";
    private const string MarketArtifact = "SAAddressMarket";

    private static (byte[] Nef, string Manifest) ReadArtifact(string baseName)
    {
        byte[] nef = NefFile.Parse(
            File.ReadAllBytes(Path.Combine(CompiledContractsDir, baseName + ".nef")), verify: true).ToArray();
        string manifest = File.ReadAllText(Path.Combine(CompiledContractsDir, baseName + ".manifest.json"));
        return (nef, manifest);
    }

    private static byte[] Sha256(byte[] data) => System.Security.Cryptography.SHA256.HashData(data);

    private static byte[] Sha256(string text) => Sha256(System.Text.Encoding.UTF8.GetBytes(text));

    private static BigInteger UpdateCounter(RuntimeFixture fx, UInt160 contractHash)
    {
        var state = (Neo.VM.Types.Array)fx.Call(ContractManagementHash, "getContract", contractHash);
        return state[1].GetInteger();
    }

    /// <summary>
    /// Shared 7-day upgrade-window scenario: pins the artifact pair, proves the window is
    /// enforced to the second, proves hash pinning, then applies the exact proposed pair and
    /// proves the proposal is single-use.
    /// </summary>
    private static void AssertProposeConfirmHonorsWindowAndHashes(string artifact)
    {
        RuntimeFixture fx = new();
        UInt160 contract = fx.Deploy(artifact);
        (byte[] nef, string manifest) = ReadArtifact(artifact);
        (byte[] wrongNef, _) = ReadArtifact("MockTransferTarget");

        fx.CallVoid(contract, "proposeUpdate", Sha256(nef), Sha256(manifest));

        TestException early = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "update", nef, manifest),
            $"{artifact}: update inside the window must be rejected");
        StringAssert.Contains(early.Message, "Update timelock not expired", $"{artifact}: early-update reason");

        fx.AdvanceTime(Window - TimeSpan.FromSeconds(1));
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "update", nef, manifest),
            $"{artifact}: update one second before expiry must be rejected");

        fx.AdvanceTime(TimeSpan.FromSeconds(1));

        // Artifacts that do not match the pinned hashes are rejected after the window.
        TestException badNef = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "update", wrongNef, manifest),
            $"{artifact}: a NEF differing from the proposal must be rejected");
        StringAssert.Contains(badNef.Message, "NEF hash mismatch", $"{artifact}: NEF mismatch reason");

        TestException badManifest = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "update", nef, manifest + " "),
            $"{artifact}: a manifest differing from the proposal must be rejected");
        StringAssert.Contains(badManifest.Message, "Manifest hash mismatch", $"{artifact}: manifest mismatch reason");

        Assert.AreEqual(BigInteger.Zero, UpdateCounter(fx, contract), $"{artifact}: nothing applied yet");

        // The exact pinned artifact pair applies cleanly after the window.
        fx.CallVoid(contract, "update", nef, manifest);
        Assert.AreEqual(BigInteger.One, UpdateCounter(fx, contract), $"{artifact}: update applied");

        // The proposal is single-use: replay needs a fresh propose + window.
        TestException replay = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "update", nef, manifest),
            $"{artifact}: a confirmed proposal must not be replayable");
        StringAssert.Contains(replay.Message, "No pending update", $"{artifact}: replay reason");
    }

    /// <summary>
    /// Shared 7-day admin-rotation scenario: propose is current-admin gated, confirm waits the
    /// full window and requires the proposed admin's own witness, the proposal is single-use,
    /// and the former admin loses all admin rights afterwards.
    /// </summary>
    private static void AssertAdminRotationHonorsWindow(
        string artifact,
        string adminGetter,
        string notAdminReason)
    {
        RuntimeFixture fx = new();
        UInt160 contract = fx.Deploy(artifact);
        UInt160 initialAdmin = fx.Engine.ValidatorsAddress;

        // A stranger cannot propose a rotation.
        fx.SetSigners(Stranger);
        TestException notAdmin = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "rotateAdmin", NewAdmin),
            $"{artifact}: non-admin rotateAdmin must be rejected");
        StringAssert.Contains(notAdmin.Message, notAdminReason, $"{artifact}: non-admin reason");

        // The current admin pins the proposed successor; the role does not move on propose.
        fx.SetSigners(initialAdmin);
        fx.CallVoid(contract, "rotateAdmin", NewAdmin);
        Assert.AreEqual(initialAdmin, fx.CallUInt160(contract, adminGetter),
            $"{artifact}: admin role must not move on propose");

        // Confirming inside the window is rejected, including one second before expiry.
        fx.SetSigners(NewAdmin);
        TestException early = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "confirmAdminRotation", NewAdmin),
            $"{artifact}: confirm inside the window must be rejected");
        StringAssert.Contains(early.Message, "Admin rotation timelock not expired", $"{artifact}: early-confirm reason");

        fx.AdvanceTime(Window - TimeSpan.FromSeconds(1));
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "confirmAdminRotation", NewAdmin),
            $"{artifact}: confirm one second before expiry must be rejected");

        fx.AdvanceTime(TimeSpan.FromSeconds(1));

        // After the window the pending successor must match the proposal ...
        TestException mismatch = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "confirmAdminRotation", initialAdmin),
            $"{artifact}: confirming a different successor must be rejected");
        StringAssert.Contains(mismatch.Message, "Pending admin mismatch", $"{artifact}: mismatch reason");

        // ... and only the proposed admin's witness can confirm (a stranger cannot).
        fx.SetSigners(Stranger);
        TestException notNew = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "confirmAdminRotation", NewAdmin),
            $"{artifact}: a witness other than the proposed admin must be rejected");
        StringAssert.Contains(notNew.Message, "New admin must confirm rotation", $"{artifact}: witness reason");

        // The proposed admin confirms and takes the role.
        fx.SetSigners(NewAdmin);
        fx.CallVoid(contract, "confirmAdminRotation", NewAdmin);
        Assert.AreEqual(NewAdmin, fx.CallUInt160(contract, adminGetter), $"{artifact}: role moved");

        // The proposal is single-use: replay needs a fresh propose + window.
        TestException replay = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "confirmAdminRotation", NewAdmin),
            $"{artifact}: a confirmed rotation must not be replayable");
        StringAssert.Contains(replay.Message, "No pending admin rotation", $"{artifact}: replay reason");

        // The former admin has lost all admin rights.
        fx.SetSigners(initialAdmin);
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "rotateAdmin", initialAdmin),
            $"{artifact}: former admin must lose the ability to propose a rotation");
    }

    private static void AssertCancelFlows(string artifact, string notAdminReason)
    {
        RuntimeFixture fx = new();
        UInt160 contract = fx.Deploy(artifact);
        (byte[] nef, string manifest) = ReadArtifact(artifact);

        // cancelUpdate clears the pending upgrade; a matured proposal can no longer be applied.
        fx.CallVoid(contract, "proposeUpdate", Sha256(nef), Sha256(manifest));
        fx.AdvanceTime(Window);
        fx.CallVoid(contract, "cancelUpdate");

        TestException cancelledUpdate = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "update", nef, manifest),
            $"{artifact}: a cancelled upgrade proposal must not be applicable");
        StringAssert.Contains(cancelledUpdate.Message, "No pending update", $"{artifact}: cancelUpdate reason");
        Assert.AreEqual(BigInteger.Zero, UpdateCounter(fx, contract), $"{artifact}: contract not updated");

        // cancelAdminRotation clears the pending rotation; the role stays with the admin.
        fx.CallVoid(contract, "rotateAdmin", NewAdmin);
        fx.AdvanceTime(Window);

        fx.SetSigners(Stranger);
        TestException strangerCancel = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "cancelAdminRotation"),
            $"{artifact}: non-admin cancelAdminRotation must be rejected");
        StringAssert.Contains(strangerCancel.Message, notAdminReason, $"{artifact}: stranger-cancel reason");

        fx.SetSigners(fx.Engine.ValidatorsAddress);
        fx.CallVoid(contract, "cancelAdminRotation");

        fx.SetSigners(NewAdmin);
        TestException cancelledRotation = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(contract, "confirmAdminRotation", NewAdmin),
            $"{artifact}: a cancelled rotation must not be confirmable");
        StringAssert.Contains(cancelledRotation.Message, "No pending admin rotation", $"{artifact}: cancelRotation reason");
    }

    // ========================================================================
    // H5 — SocialRecoveryVerifier: timelocked upgrade
    // ========================================================================

    [TestMethod]
    public void H5_Recovery_Update_WithoutProposal_IsRejected()
    {
        RuntimeFixture fx = new();
        UInt160 verifier = fx.Deploy(RecoveryArtifact);
        (byte[] nef, string manifest) = ReadArtifact(RecoveryArtifact);

        TestException instant = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(verifier, "update", nef, manifest),
            "Instant update without a proposal must be rejected");
        StringAssert.Contains(instant.Message, "No pending update");
        Assert.AreEqual(BigInteger.Zero, UpdateCounter(fx, verifier), "Verifier must not be updated");
    }

    [TestMethod]
    public void H5_Recovery_Update_ProposeConfirm_HonorsWindowAndHashes()
    {
        AssertProposeConfirmHonorsWindowAndHashes(RecoveryArtifact);
    }

    [TestMethod]
    public void H5_Recovery_ConfirmUpdateAlias_AppliesPinnedArtifacts()
    {
        RuntimeFixture fx = new();
        UInt160 verifier = fx.Deploy(RecoveryArtifact);
        (byte[] nef, string manifest) = ReadArtifact(RecoveryArtifact);

        fx.CallVoid(verifier, "proposeUpdate", Sha256(nef), Sha256(manifest));
        fx.AdvanceTime(Window);
        fx.CallVoid(verifier, "confirmUpdate", nef, manifest);
        Assert.AreEqual(BigInteger.One, UpdateCounter(fx, verifier), "confirmUpdate applies the pinned artifacts");
    }

    [TestMethod]
    public void H5_Recovery_ProposeAndUpdate_RequireAdminWitness()
    {
        RuntimeFixture fx = new();
        UInt160 verifier = fx.Deploy(RecoveryArtifact);
        (byte[] nef, string manifest) = ReadArtifact(RecoveryArtifact);

        // A stranger cannot pin a proposal.
        fx.SetSigners(Stranger);
        TestException propose = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(verifier, "proposeUpdate", Sha256(nef), Sha256(manifest)),
            "Non-admin proposeUpdate must be rejected");
        StringAssert.Contains(propose.Message, "Not contract admin");

        // The admin pins a valid proposal and lets the window elapse.
        fx.SetSigners(fx.Engine.ValidatorsAddress);
        fx.CallVoid(verifier, "proposeUpdate", Sha256(nef), Sha256(manifest));
        fx.AdvanceTime(Window);

        // Even with a valid, matured proposal, a non-admin cannot apply the upgrade.
        fx.SetSigners(Stranger);
        TestException notAdmin = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(verifier, "update", nef, manifest),
            "Non-admin update must be rejected");
        StringAssert.Contains(notAdmin.Message, "Not contract admin");
        Assert.AreEqual(BigInteger.Zero, UpdateCounter(fx, verifier), "Verifier not updated by non-admin");
    }

    [TestMethod]
    public void H5_Recovery_CancelFlows_ClearPendingProposals()
    {
        AssertCancelFlows(RecoveryArtifact, "Not contract admin");
    }

    // ========================================================================
    // SA-04 — SocialRecoveryVerifier: timelocked admin rotation
    // ========================================================================

    [TestMethod]
    public void AA04_Recovery_TransferAdmin_InstantPath_IsGone()
    {
        RuntimeFixture fx = new();
        UInt160 verifier = fx.Deploy(RecoveryArtifact);

        // The legacy instant entrypoint must no longer exist on the contract ABI: a call to it
        // faults (the dispatcher finds no matching method) rather than instantly moving the role.
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(verifier, "transferAdmin", NewAdmin),
            "The instant transferAdmin entrypoint must be removed");

        Assert.AreEqual(fx.Engine.ValidatorsAddress, fx.CallUInt160(verifier, "getContractAdmin"),
            "Admin role must be unchanged when no rotation was confirmed");
    }

    [TestMethod]
    public void AA04_Recovery_AdminRotation_HonorsWindowAndRequiresNewAdminWitness()
    {
        AssertAdminRotationHonorsWindow(RecoveryArtifact, "getContractAdmin", "Not contract admin");
    }

    [TestMethod]
    public void AA04_Recovery_RotateAdmin_RejectsInvalidAndIdentitySuccessor()
    {
        RuntimeFixture fx = new();
        UInt160 verifier = fx.Deploy(RecoveryArtifact);
        UInt160 initialAdmin = fx.Engine.ValidatorsAddress;

        TestException zero = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(verifier, "rotateAdmin", UInt160.Zero),
            "The zero address must be rejected as a successor");
        StringAssert.Contains(zero.Message, "newAdmin is invalid");

        TestException same = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(verifier, "rotateAdmin", initialAdmin),
            "Proposing the current admin as successor must be rejected");
        StringAssert.Contains(same.Message, "New admin must differ from current");
    }

    // ========================================================================
    // H6 — SAAddressMarket: timelocked upgrade + timelocked admin rotation
    // ========================================================================

    [TestMethod]
    public void H6_Market_Update_WithoutProposal_IsRejected()
    {
        RuntimeFixture fx = new();
        UInt160 market = fx.Deploy(MarketArtifact);
        (byte[] nef, string manifest) = ReadArtifact(MarketArtifact);

        TestException instant = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(market, "update", nef, manifest),
            "Instant update without a proposal must be rejected");
        StringAssert.Contains(instant.Message, "No pending update");
        Assert.AreEqual(BigInteger.Zero, UpdateCounter(fx, market), "Market must not be updated");
    }

    [TestMethod]
    public void H6_Market_Update_ProposeConfirm_HonorsWindowAndHashes()
    {
        AssertProposeConfirmHonorsWindowAndHashes(MarketArtifact);
    }

    [TestMethod]
    public void H6_Market_ConfirmUpdateAlias_AppliesPinnedArtifacts()
    {
        RuntimeFixture fx = new();
        UInt160 market = fx.Deploy(MarketArtifact);
        (byte[] nef, string manifest) = ReadArtifact(MarketArtifact);

        fx.CallVoid(market, "proposeUpdate", Sha256(nef), Sha256(manifest));
        fx.AdvanceTime(Window);
        fx.CallVoid(market, "confirmUpdate", nef, manifest);
        Assert.AreEqual(BigInteger.One, UpdateCounter(fx, market), "confirmUpdate applies the pinned artifacts");
    }

    [TestMethod]
    public void H6_Market_ProposeAndUpdate_RequireAdminWitness()
    {
        RuntimeFixture fx = new();
        UInt160 market = fx.Deploy(MarketArtifact);
        (byte[] nef, string manifest) = ReadArtifact(MarketArtifact);

        // A stranger cannot pin a proposal.
        fx.SetSigners(Stranger);
        TestException propose = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(market, "proposeUpdate", Sha256(nef), Sha256(manifest)),
            "Non-admin proposeUpdate must be rejected");
        StringAssert.Contains(propose.Message, "Unauthorized admin");

        // The admin pins a valid proposal and lets the window elapse.
        fx.SetSigners(fx.Engine.ValidatorsAddress);
        fx.CallVoid(market, "proposeUpdate", Sha256(nef), Sha256(manifest));
        fx.AdvanceTime(Window);

        // Even with a valid, matured proposal, a non-admin cannot apply the upgrade.
        fx.SetSigners(Stranger);
        TestException notAdmin = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(market, "update", nef, manifest),
            "Non-admin update must be rejected");
        StringAssert.Contains(notAdmin.Message, "Unauthorized admin");
        Assert.AreEqual(BigInteger.Zero, UpdateCounter(fx, market), "Market not updated by non-admin");
    }

    [TestMethod]
    public void H6_Market_SetAdmin_InstantPath_IsGone()
    {
        RuntimeFixture fx = new();
        UInt160 market = fx.Deploy(MarketArtifact);

        // The legacy instant entrypoint must no longer exist on the contract ABI: a call to it
        // faults (the dispatcher finds no matching method) rather than instantly moving the role.
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(market, "setAdmin", NewAdmin),
            "The instant setAdmin entrypoint must be removed");

        Assert.AreEqual(fx.Engine.ValidatorsAddress, fx.CallUInt160(market, "admin"),
            "Admin role must be unchanged when no rotation was confirmed");
    }

    [TestMethod]
    public void H6_Market_AdminRotation_HonorsWindowAndRequiresNewAdminWitness()
    {
        AssertAdminRotationHonorsWindow(MarketArtifact, "admin", "Unauthorized admin");
    }

    [TestMethod]
    public void H6_Market_RotateAdmin_RejectsInvalidAndIdentitySuccessor()
    {
        RuntimeFixture fx = new();
        UInt160 market = fx.Deploy(MarketArtifact);
        UInt160 initialAdmin = fx.Engine.ValidatorsAddress;

        TestException zero = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(market, "rotateAdmin", UInt160.Zero),
            "The zero address must be rejected as a successor");
        StringAssert.Contains(zero.Message, "Invalid admin");

        TestException same = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(market, "rotateAdmin", initialAdmin),
            "Proposing the current admin as successor must be rejected");
        StringAssert.Contains(same.Message, "New admin must differ from current");
    }

    [TestMethod]
    public void H6_Market_CancelFlows_ClearPendingProposals()
    {
        AssertCancelFlows(MarketArtifact, "Unauthorized admin");
    }
}
