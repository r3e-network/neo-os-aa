using System;
using System.IO;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Behavioral VM tests for the AA-D-01 core-wallet upgrade hardening
/// (<c>UnifiedSmartWallet.Admin.cs</c>).
///
/// The core <c>update(nef, manifest)</c> used to gate only on the admin witness and instantly
/// call <c>ContractManagement.Update</c>, letting one admin key replace the authorization logic
/// of every bound account with no delay or escape window. The fix mirrors the project's
/// existing <c>VerifierAuthority.ProposeUpdate/Update</c> pattern: the admin pins
/// <c>sha256(nef)</c> + <c>sha256(manifest)</c> via <c>proposeUpdate</c>, and <c>update</c> /
/// <c>confirmUpdate</c> only applies that exact artifact pair after a 7-day window.
/// </summary>
[TestClass]
public class Fix_AdminTimelock_Tests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string CompiledContractsDir = Path.Combine(RepoRoot, "contracts", "bin", "v3");

    private static readonly UInt160 ContractManagementHash =
        UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd");

    private static readonly UInt160 Stranger =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly UInt160 NewAdmin =
        UInt160.Parse("0x9999999999999999999999999999999999999999");

    private static readonly TimeSpan Window = TimeSpan.FromDays(7);

    private const string WalletArtifact = "UnifiedSmartWalletV3";

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

    [TestMethod]
    public void Update_WithoutProposal_IsRejected()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy(WalletArtifact);
        (byte[] nef, string manifest) = ReadArtifact(WalletArtifact);

        TestException instant = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "update", nef, manifest),
            "Instant update without a proposal must be rejected");
        StringAssert.Contains(instant.Message, "No pending update");
        Assert.AreEqual(BigInteger.Zero, UpdateCounter(fx, wallet), "Wallet must not be updated");
    }

    [TestMethod]
    public void Update_ProposeConfirm_HonorsSevenDayWindowAndHashes()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy(WalletArtifact);
        (byte[] nef, string manifest) = ReadArtifact(WalletArtifact);
        (byte[] wrongNef, _) = ReadArtifact("MockTransferTarget");

        fx.CallVoid(wallet, "proposeUpdate", Sha256(nef), Sha256(manifest));

        // Confirm inside the window is rejected, including one second before expiry.
        TestException early = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "update", nef, manifest),
            "update inside the window must be rejected");
        StringAssert.Contains(early.Message, "Update timelock not expired");

        fx.AdvanceTime(Window - TimeSpan.FromSeconds(1));
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "update", nef, manifest),
            "update one second before expiry must be rejected");

        fx.AdvanceTime(TimeSpan.FromSeconds(1));

        // Artifacts that do not match the pinned hashes are rejected after the window.
        TestException badNef = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "update", wrongNef, manifest),
            "a NEF differing from the proposal must be rejected");
        StringAssert.Contains(badNef.Message, "NEF hash mismatch");

        TestException badManifest = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "update", nef, manifest + " "),
            "a manifest differing from the proposal must be rejected");
        StringAssert.Contains(badManifest.Message, "Manifest hash mismatch");

        Assert.AreEqual(BigInteger.Zero, UpdateCounter(fx, wallet), "nothing applied yet");

        // The exact pinned artifact pair applies cleanly after the window.
        fx.CallVoid(wallet, "update", nef, manifest);
        Assert.AreEqual(BigInteger.One, UpdateCounter(fx, wallet), "update applied");

        // The proposal is single-use: replay needs a fresh propose + window.
        TestException replay = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "update", nef, manifest),
            "a confirmed proposal must not be replayable");
        StringAssert.Contains(replay.Message, "No pending update");
    }

    [TestMethod]
    public void ConfirmUpdateAlias_AppliesPinnedArtifacts()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy(WalletArtifact);
        (byte[] nef, string manifest) = ReadArtifact(WalletArtifact);

        fx.CallVoid(wallet, "proposeUpdate", Sha256(nef), Sha256(manifest));
        fx.AdvanceTime(Window);
        fx.CallVoid(wallet, "confirmUpdate", nef, manifest);
        Assert.AreEqual(BigInteger.One, UpdateCounter(fx, wallet), "confirmUpdate applies the pinned artifacts");
    }

    [TestMethod]
    public void ReversedDigestProposal_CannotConfirmEvenAfterTimelock()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy(WalletArtifact);
        (byte[] nef, string manifest) = ReadArtifact(WalletArtifact);
        byte[] reversedNef = Sha256(nef);
        byte[] reversedManifest = Sha256(manifest);
        System.Array.Reverse(reversedNef);
        System.Array.Reverse(reversedManifest);
        fx.CallVoid(wallet, "proposeUpdate", reversedNef, reversedManifest);
        fx.AdvanceTime(Window);
        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "confirmUpdate", nef, manifest));
        StringAssert.Contains(rejected.Message, "NEF hash mismatch");
        Assert.AreEqual(BigInteger.Zero, UpdateCounter(fx, wallet));

        // The repair pins raw SHA-256 bytes and starts a fresh governance window.
        fx.CallVoid(wallet, "proposeUpdate", Sha256(nef), Sha256(manifest));
        fx.AdvanceTime(Window);
        fx.CallVoid(wallet, "confirmUpdate", nef, manifest);
        Assert.AreEqual(BigInteger.One, UpdateCounter(fx, wallet));
    }

    [TestMethod]
    public void CancelUpdate_ClearsPendingProposal()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy(WalletArtifact);
        (byte[] nef, string manifest) = ReadArtifact(WalletArtifact);

        fx.CallVoid(wallet, "proposeUpdate", Sha256(nef), Sha256(manifest));
        fx.AdvanceTime(Window);
        fx.CallVoid(wallet, "cancelUpdate");

        TestException cancelled = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "update", nef, manifest));
        StringAssert.Contains(cancelled.Message, "No pending update");
        Assert.AreEqual(BigInteger.Zero, UpdateCounter(fx, wallet), "Cancelled proposal cannot be applied");
    }

    [TestMethod]
    public void ProposeAndUpdate_RequireAdminWitness()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy(WalletArtifact);
        (byte[] nef, string manifest) = ReadArtifact(WalletArtifact);

        // A stranger cannot pin a proposal.
        fx.SetSigners(Stranger);
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "proposeUpdate", Sha256(nef), Sha256(manifest)),
            "Non-admin proposeUpdate must be rejected");

        // Admin pins a valid proposal and lets the window elapse.
        fx.SetSigners(fx.Engine.ValidatorsAddress);
        fx.CallVoid(wallet, "proposeUpdate", Sha256(nef), Sha256(manifest));
        fx.AdvanceTime(Window);

        // Even with a valid, matured proposal, a non-admin cannot apply the upgrade.
        fx.SetSigners(Stranger);
        TestException notAdmin = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "update", nef, manifest),
            "Non-admin update must be rejected");
        StringAssert.Contains(notAdmin.Message, "Not admin");
        Assert.AreEqual(BigInteger.Zero, UpdateCounter(fx, wallet), "Wallet not updated by non-admin");
    }

    [TestMethod]
    public void Update_AfterAdminTransfer_RequiresNewAdminAndStillTimelocked()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy(WalletArtifact);
        (byte[] nef, string manifest) = ReadArtifact(WalletArtifact);

        // The deploying validator is the initial admin; hand the role to NewAdmin via the
        // timelocked propose/confirm flow (there is no instant transfer path).
        fx.CallVoid(wallet, "proposeAdminTransfer", NewAdmin);
        fx.AdvanceTime(Window);
        fx.SetSigners(NewAdmin);
        fx.CallVoid(wallet, "confirmAdminTransfer");
        fx.SetSigners(fx.Engine.ValidatorsAddress);
        Assert.AreEqual(NewAdmin, fx.CallUInt160(wallet, "getContractAdmin"), "Admin transferred");

        // The previous admin can no longer pin a proposal.
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "proposeUpdate", Sha256(nef), Sha256(manifest)),
            "Former admin must lose proposal rights");

        // The new admin still goes through the full timelock — no instant upgrade.
        fx.SetSigners(NewAdmin);
        fx.CallVoid(wallet, "proposeUpdate", Sha256(nef), Sha256(manifest));
        TestException early = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "update", nef, manifest),
            "New admin upgrade inside the window must be rejected");
        StringAssert.Contains(early.Message, "Update timelock not expired");

        fx.AdvanceTime(Window);
        fx.CallVoid(wallet, "update", nef, manifest);
        Assert.AreEqual(BigInteger.One, UpdateCounter(fx, wallet), "New admin upgrade applies after the window");
    }

    // ------------------------------------------------------------------------------------------
    // AA-D-02: the contract admin role transfer is itself timelocked + new-admin-confirmed.
    //
    // The old TransferAdmin did an instant Storage.Put with only the current-admin witness —
    // a single leaked admin key could silently and instantly burn the role to an address nobody
    // controls, with no escape window. The hardened flow mirrors the project's other authority
    // rotations: proposeAdminTransfer (current-admin gated) -> 7-day window ->
    // confirmAdminTransfer (gated on CheckWitness(newAdmin)).
    // ------------------------------------------------------------------------------------------

    [TestMethod]
    public void TransferAdmin_InstantPath_IsGone()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy(WalletArtifact);

        // The legacy instant entrypoint must no longer exist on the contract ABI: a call to it
        // faults (the dispatcher finds no matching method) rather than instantly moving the role.
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "transferAdmin", NewAdmin),
            "The instant transferAdmin entrypoint must be removed");

        // The admin role is unchanged: still the deploying validator.
        Assert.AreEqual(fx.Engine.ValidatorsAddress, fx.CallUInt160(wallet, "getContractAdmin"),
            "Admin role must be unchanged when no transfer was confirmed");
    }

    [TestMethod]
    public void AdminTransfer_HonorsWindowAndRequiresNewAdminWitness()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy(WalletArtifact);
        UInt160 initialAdmin = fx.Engine.ValidatorsAddress;

        // A stranger cannot propose a transfer.
        fx.SetSigners(Stranger);
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "proposeAdminTransfer", NewAdmin),
            "Non-admin proposeAdminTransfer must be rejected");

        // The current admin pins the proposed successor.
        fx.SetSigners(initialAdmin);
        fx.CallVoid(wallet, "proposeAdminTransfer", NewAdmin);
        Assert.AreEqual(NewAdmin, fx.CallUInt160(wallet, "getPendingContractAdmin"), "Proposal pinned");
        Assert.AreEqual(initialAdmin, fx.CallUInt160(wallet, "getContractAdmin"),
            "Admin role must not move on propose");

        // Confirming inside the window is rejected, including one second before expiry.
        fx.SetSigners(NewAdmin);
        TestException early = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "confirmAdminTransfer"),
            "Confirm inside the window must be rejected");
        StringAssert.Contains(early.Message, "Admin transfer timelock not expired");

        fx.AdvanceTime(Window - TimeSpan.FromSeconds(1));
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "confirmAdminTransfer"),
            "Confirm one second before expiry must be rejected");

        fx.AdvanceTime(TimeSpan.FromSeconds(1));

        // After the window, only the proposed admin's witness can confirm.
        fx.SetSigners(Stranger);
        TestException notNew = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "confirmAdminTransfer"),
            "A witness other than the proposed admin must be rejected");
        StringAssert.Contains(notNew.Message, "New admin must confirm transfer");

        // The (still-current) initial admin cannot confirm on the new admin's behalf either.
        fx.SetSigners(initialAdmin);
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "confirmAdminTransfer"),
            "Even the current admin cannot confirm without the new admin's witness");

        // The proposed admin confirms and takes the role.
        fx.SetSigners(NewAdmin);
        fx.CallVoid(wallet, "confirmAdminTransfer");
        Assert.AreEqual(NewAdmin, fx.CallUInt160(wallet, "getContractAdmin"), "Role moved to the new admin");
        Assert.AreEqual(UInt160.Zero, fx.CallUInt160(wallet, "getPendingContractAdmin"),
            "Pending proposal cleared after confirm");

        // The proposal is single-use: replay needs a fresh propose + window.
        TestException replay = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "confirmAdminTransfer"),
            "A confirmed transfer must not be replayable");
        StringAssert.Contains(replay.Message, "No pending admin transfer");

        // The former admin has lost all admin rights.
        fx.SetSigners(initialAdmin);
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "proposeAdminTransfer", initialAdmin),
            "Former admin must lose the ability to propose a transfer");
    }

    [TestMethod]
    public void CancelAdminTransfer_ClearsPendingProposal()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy(WalletArtifact);
        UInt160 initialAdmin = fx.Engine.ValidatorsAddress;

        fx.CallVoid(wallet, "proposeAdminTransfer", NewAdmin);
        fx.AdvanceTime(Window);
        fx.CallVoid(wallet, "cancelAdminTransfer");
        Assert.AreEqual(UInt160.Zero, fx.CallUInt160(wallet, "getPendingContractAdmin"), "Proposal cleared");

        // A cancelled proposal cannot be confirmed, and the role stays with the original admin.
        fx.SetSigners(NewAdmin);
        TestException cancelled = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "confirmAdminTransfer"));
        StringAssert.Contains(cancelled.Message, "No pending admin transfer");
        Assert.AreEqual(initialAdmin, fx.CallUInt160(wallet, "getContractAdmin"),
            "Role unchanged after cancel");
    }

    [TestMethod]
    public void ProposeAdminTransfer_RejectsInvalidAndIdentitySuccessor()
    {
        RuntimeFixture fx = new();
        UInt160 wallet = fx.Deploy(WalletArtifact);
        UInt160 initialAdmin = fx.Engine.ValidatorsAddress;

        TestException zero = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "proposeAdminTransfer", UInt160.Zero),
            "The zero address must be rejected as a successor");
        StringAssert.Contains(zero.Message, "Invalid admin");

        TestException same = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(wallet, "proposeAdminTransfer", initialAdmin),
            "Proposing the current admin as successor must be rejected");
        StringAssert.Contains(same.Message, "New admin must differ from current");
    }
}
