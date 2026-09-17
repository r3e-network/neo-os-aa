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
/// Behavioral VM tests for the AA-D-01 authority hardening:
/// (1) <c>setAuthorizedCore</c> is initial-set-only on every shared verifier and on the
///     paymaster (M-7 parity with <c>HookAuthority</c>) — re-pointing the trusted AA core
///     must flow through <c>proposeAuthorizedCore</c>/<c>confirmAuthorizedCore</c> with a
///     7-day window;
/// (2) contract upgrades on the verifier/hook/paymaster family are timelocked —
///     <c>proposeUpdate(sha256(nef), sha256(manifest))</c> pins the artifact pair, and
///     <c>update</c>/<c>confirmUpdate</c> only applies that exact pair after 7 days.
/// </summary>
[TestClass]
public class AuthorityTimelockRuntimeTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string CompiledContractsDir = Path.Combine(RepoRoot, "contracts", "bin", "v3");

    private static readonly UInt160 ContractManagementHash =
        UInt160.Parse("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd");

    private static readonly UInt160 ProposedCore =
        UInt160.Parse("0x9999999999999999999999999999999999999999");

    private static readonly UInt160 OtherCore =
        UInt160.Parse("0x5555555555555555555555555555555555555555");

    private static readonly UInt160 Stranger =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly TimeSpan Window = TimeSpan.FromDays(7);

    /// <summary>Every deployable contract compiled with <c>VerifierAuthority</c>, plus the paymaster.</summary>
    private static readonly string[] VerifierAndPaymasterArtifacts =
    {
        "verifiers/NeoNativeVerifier",
        "verifiers/TEEVerifier",
        "verifiers/Web3AuthVerifier",
        "verifiers/WebAuthnVerifier",
        "verifiers/ZKEmailVerifier",
        "verifiers/ZkLoginVerifier",
        "verifiers/MultiSigVerifier",
        "verifiers/SubscriptionVerifier",
        "verifiers/SessionKeyVerifier",
        "AAPaymaster",
    };

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

    // ========================================================================
    // 1. setAuthorizedCore — initial-set-only (M-7 parity)
    // ========================================================================

    [TestMethod]
    public void AuthorityCore_InstantRepointing_IsRejectedAcrossVerifiersAndPaymaster()
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("MockVerifierCore");

        foreach (string artifact in VerifierAndPaymasterArtifacts)
        {
            UInt160 contract = fx.Deploy(artifact, core.ToArray());
            Assert.AreEqual(core, fx.CallUInt160(contract, "authorizedCore"), $"{artifact}: core bound at deploy");

            TestException repoint = Assert.ThrowsExactly<TestException>(
                () => fx.CallVoid(contract, "setAuthorizedCore", ProposedCore),
                $"{artifact}: instant core re-pointing must be rejected");
            StringAssert.Contains(repoint.Message, "core already set", $"{artifact}: rejection reason");

            Assert.AreEqual(core, fx.CallUInt160(contract, "authorizedCore"), $"{artifact}: core unchanged");
        }
    }

    [TestMethod]
    public void AuthorityCore_InitialSet_AllowedOnceThenLocked()
    {
        RuntimeFixture fx = new();
        UInt160 verifier = fx.Deploy("verifiers/NeoNativeVerifier");
        Assert.AreEqual(UInt160.Zero, fx.CallUInt160(verifier, "authorizedCore"), "Core starts unset");

        fx.CallVoid(verifier, "setAuthorizedCore", ProposedCore);
        Assert.AreEqual(ProposedCore, fx.CallUInt160(verifier, "authorizedCore"), "Initial set succeeds");

        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(verifier, "setAuthorizedCore", OtherCore),
            "Second instant set must be rejected");
        Assert.AreEqual(ProposedCore, fx.CallUInt160(verifier, "authorizedCore"), "Core unchanged after rejection");
    }

    [TestMethod]
    public void AuthorityCore_ProposeConfirm_HonorsSevenDayWindow()
    {
        foreach (string artifact in new[] { "verifiers/NeoNativeVerifier", "AAPaymaster" })
        {
            RuntimeFixture fx = new();
            UInt160 core = fx.Deploy("MockVerifierCore");
            UInt160 contract = fx.Deploy(artifact, core.ToArray());

            fx.CallVoid(contract, "proposeAuthorizedCore", ProposedCore);

            TestException early = Assert.ThrowsExactly<TestException>(
                () => fx.CallVoid(contract, "confirmAuthorizedCore", ProposedCore),
                $"{artifact}: confirm inside the window must be rejected");
            StringAssert.Contains(early.Message, "timelock not expired", $"{artifact}: early-confirm reason");

            fx.AdvanceTime(Window - TimeSpan.FromSeconds(1));
            Assert.ThrowsExactly<TestException>(
                () => fx.CallVoid(contract, "confirmAuthorizedCore", ProposedCore),
                $"{artifact}: confirm one second before expiry must be rejected");

            fx.AdvanceTime(TimeSpan.FromSeconds(1));
            fx.CallVoid(contract, "confirmAuthorizedCore", ProposedCore);
            Assert.AreEqual(ProposedCore, fx.CallUInt160(contract, "authorizedCore"),
                $"{artifact}: core re-pointed after the full window");
        }
    }

    [TestMethod]
    public void AuthorityCore_ConfirmMismatchOrCancel_IsRejected()
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("MockVerifierCore");
        UInt160 verifier = fx.Deploy("verifiers/NeoNativeVerifier", core.ToArray());

        // Mismatched confirmation target is rejected even after the window.
        fx.CallVoid(verifier, "proposeAuthorizedCore", ProposedCore);
        fx.AdvanceTime(Window);
        TestException mismatch = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(verifier, "confirmAuthorizedCore", OtherCore));
        StringAssert.Contains(mismatch.Message, "Pending core mismatch");

        // Cancellation clears the pending change entirely.
        fx.CallVoid(verifier, "cancelAuthorizedCoreChange");
        TestException cancelled = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(verifier, "confirmAuthorizedCore", ProposedCore));
        StringAssert.Contains(cancelled.Message, "No pending core change");
        Assert.AreEqual(core, fx.CallUInt160(verifier, "authorizedCore"), "Core unchanged throughout");
    }

    [TestMethod]
    public void NeoDidRegistry_InitialSetThenRepoint_HonorsSevenDayWindow()
    {
        RuntimeFixture fx = new();
        UInt160 hook = fx.Deploy("hooks/NeoDIDCredentialHook");

        fx.CallVoid(hook, "setRegistry", ProposedCore);
        Assert.AreEqual(ProposedCore, fx.CallUInt160(hook, "getRegistry"), "Initial registry set succeeds");

        TestException instant = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(hook, "setRegistry", OtherCore),
            "Registry re-pointing must not remain instant");
        StringAssert.Contains(instant.Message, "registry already set; use ProposeRegistry");

        fx.CallVoid(hook, "proposeRegistry", OtherCore);
        TestException early = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(hook, "confirmRegistry", OtherCore),
            "Registry confirmation inside the window must be rejected");
        StringAssert.Contains(early.Message, "Registry change timelock not expired");

        fx.AdvanceTime(Window - TimeSpan.FromSeconds(1));
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(hook, "confirmRegistry", OtherCore),
            "Registry confirmation one second before expiry must be rejected");

        fx.AdvanceTime(TimeSpan.FromSeconds(1));
        fx.CallVoid(hook, "confirmRegistry", OtherCore);
        Assert.AreEqual(OtherCore, fx.CallUInt160(hook, "getRegistry"), "Registry re-pointed after the full window");
    }

    // ========================================================================
    // 2. update — timelocked upgrades (AA-D-01)
    // ========================================================================

    [TestMethod]
    public void AuthorityUpdate_WithoutProposal_IsRejected()
    {
        foreach (string artifact in new[] { "verifiers/NeoNativeVerifier", "hooks/WhitelistHook", "AAPaymaster" })
        {
            RuntimeFixture fx = new();
            UInt160 contract = fx.Deploy(artifact);
            (byte[] nef, string manifest) = ReadArtifact(artifact);

            TestException instant = Assert.ThrowsExactly<TestException>(
                () => fx.CallVoid(contract, "update", nef, manifest),
                $"{artifact}: instant update without a proposal must be rejected");
            StringAssert.Contains(instant.Message, "No pending update", $"{artifact}: rejection reason");
            Assert.AreEqual(BigInteger.Zero, UpdateCounter(fx, contract), $"{artifact}: contract not updated");
        }
    }

    [TestMethod]
    public void AuthorityUpdate_ProposeConfirm_HonorsWindowAndHashes()
    {
        foreach (string artifact in new[] { "verifiers/NeoNativeVerifier", "hooks/WhitelistHook", "AAPaymaster" })
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

            // Artifacts that do not match the proposed hashes are rejected after the window.
            TestException badNef = Assert.ThrowsExactly<TestException>(
                () => fx.CallVoid(contract, "update", wrongNef, manifest),
                $"{artifact}: a NEF differing from the proposal must be rejected");
            StringAssert.Contains(badNef.Message, "NEF hash mismatch", $"{artifact}: NEF mismatch reason");

            TestException badManifest = Assert.ThrowsExactly<TestException>(
                () => fx.CallVoid(contract, "update", nef, manifest + " "),
                $"{artifact}: a manifest differing from the proposal must be rejected");
            StringAssert.Contains(badManifest.Message, "Manifest hash mismatch", $"{artifact}: manifest mismatch reason");

            Assert.AreEqual(BigInteger.Zero, UpdateCounter(fx, contract), $"{artifact}: nothing applied yet");

            // The exact proposed artifact pair applies cleanly after the window.
            fx.CallVoid(contract, "update", nef, manifest);
            Assert.AreEqual(BigInteger.One, UpdateCounter(fx, contract), $"{artifact}: update applied");

            // The proposal is single-use: the next upgrade needs a fresh propose + window.
            TestException replay = Assert.ThrowsExactly<TestException>(
                () => fx.CallVoid(contract, "update", nef, manifest),
                $"{artifact}: a confirmed proposal must not be replayable");
            StringAssert.Contains(replay.Message, "No pending update", $"{artifact}: replay reason");
        }
    }

    [TestMethod]
    public void AuthorityUpdate_ConfirmUpdateAlias_AppliesProposedArtifacts()
    {
        RuntimeFixture fx = new();
        UInt160 hook = fx.Deploy("hooks/WhitelistHook");
        (byte[] nef, string manifest) = ReadArtifact("hooks/WhitelistHook");

        fx.CallVoid(hook, "proposeUpdate", Sha256(nef), Sha256(manifest));
        fx.AdvanceTime(Window);
        fx.CallVoid(hook, "confirmUpdate", nef, manifest);
        Assert.AreEqual(BigInteger.One, UpdateCounter(fx, hook), "confirmUpdate applies the proposed artifacts");
    }

    [TestMethod]
    public void AuthorityUpdate_Cancel_ClearsPendingUpdate()
    {
        RuntimeFixture fx = new();
        UInt160 paymaster = fx.Deploy("AAPaymaster");
        (byte[] nef, string manifest) = ReadArtifact("AAPaymaster");

        fx.CallVoid(paymaster, "proposeUpdate", Sha256(nef), Sha256(manifest));
        fx.AdvanceTime(Window);
        fx.CallVoid(paymaster, "cancelUpdate");

        TestException cancelled = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(paymaster, "update", nef, manifest));
        StringAssert.Contains(cancelled.Message, "No pending update");
        Assert.AreEqual(BigInteger.Zero, UpdateCounter(fx, paymaster), "Cancelled proposal cannot be applied");
    }

    [TestMethod]
    public void AuthorityUpdate_ProposeRequiresAdminWitness()
    {
        RuntimeFixture fx = new();
        UInt160 verifier = fx.Deploy("verifiers/NeoNativeVerifier");
        (byte[] nef, string manifest) = ReadArtifact("verifiers/NeoNativeVerifier");

        fx.SetSigners(Stranger);
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(verifier, "proposeUpdate", Sha256(nef), Sha256(manifest)),
            "Non-admin proposeUpdate must be rejected");
        Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(verifier, "proposeAuthorizedCore", ProposedCore),
            "Non-admin proposeAuthorizedCore must be rejected");
    }
}
