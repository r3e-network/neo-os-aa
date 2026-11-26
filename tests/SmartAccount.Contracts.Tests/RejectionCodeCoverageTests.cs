using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Behavioural proof for rejection codes the shared constants file declares but
/// no suite named yet. <c>rejection-regression.json</c> recomputes a row's
/// status from these literals, so each test both drives the rejection and names
/// the code it drives: a code that stops being enforced fails here instead of
/// quietly staying "covered".
///
/// The suites that cover the remaining codes are the execution-path ones
/// (hooks, proofs, nonce channels); this file takes the codes that
/// are reachable through the configuration and query surface.
/// </summary>
[TestClass]
public class RejectionCodeCoverageTests
{
    /// <summary>A whitelisted target that is never the operation's target.</summary>
    private static readonly UInt160 AllowedTarget =
        UInt160.Parse("0x00000000000000000000000000000000000000aa");

    [TestMethod]
    public void CancellingAnUnknownIntentReportsIntentNotFound()
    {
        using P256SessionKey key = new();
        var fx = new RuntimeFixture();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 account = fx.CreateAccount(core, custody, "rejection-intent-not-found");
        fx.SetSigners(custody);

        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CallVoid(core, "cancelConfiguration", account, (BigInteger)99));
        StringAssert.Contains(fault.Message, "SA_INTENT_NOT_FOUND",
            "an unknown intentId is reported, never silently ignored");
    }

    [TestMethod]
    public void AnIntentOverTheActionLimitIsRejected()
    {
        using P256SessionKey key = new();
        var fx = new RuntimeFixture();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 account = fx.CreateAccount(core, custody, "rejection-action-limit");
        fx.SetSigners(custody);

        // The §9 bound is 16 actions per intent; the limit is checked before any
        // single action is inspected.
        object[] actions = Enumerable.Range(0, 17)
            .Select(_ => (object)new object[]
            {
                RuntimeFixture.ActionSetRecoveryPolicy, custody, (BigInteger)0,
            })
            .ToArray();

        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CallVoid(core, "proposeConfiguration", account, actions, new object[0]));
        StringAssert.Contains(fault.Message, "SA_MODULE_LIMIT_ACTIONS",
            "an oversized action set never reaches resource analysis");
    }

    [TestMethod]
    public void ASecondInstanceOfANonIsolatedModuleIsRejected()
    {
        var fx = new RuntimeFixture();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 hook = fx.Deploy("hooks/WhitelistHook", core.ToArray());
        UInt160 custody = UInt160.Parse("0x3333333333333333333333333333333333333333");

        // WhitelistHook's canonical profile declares instanceIsolation = false, so
        // the same contract address may be installed at most once per account.
        object[] actions =
        [
            fx.InstallHook(hook, "allowTarget", AllowedTarget),
            fx.InstallHook(hook, "allowTarget", AllowedTarget),
        ];
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CreateAccount(core, custody, "rejection-instance-isolation", actions));
        StringAssert.Contains(fault.Message, "SA_MODULE_INSTANCE_ISOLATION_REQUIRED",
            "a non-isolated module address is a single slot");
    }

    [TestMethod]
    public void DuplicateHookProofIdsAreRejected()
    {
        using P256SessionKey key = new();
        var fx = new RuntimeFixture();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 target = fx.Deploy("MockTransferTarget");
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        UInt160 account = fx.CreateAccount(core, custody, "rejection-proof-invalid");

        // §4.1: proofs are unique and strictly ascending by hookId. The envelope
        // gate rejects a duplicate before any signature is looked at.
        object[] op = RuntimeFixture.UserOp(target, "supportsV3", Array.Empty<object?>(),
            (BigInteger)0, fx.Now() + 60_000, new byte[] { 0x00 },
            hookProofs: new object[]
            {
                new object?[] { (BigInteger)1, Array.Empty<byte>() },
                new object?[] { (BigInteger)1, Array.Empty<byte>() },
            });

        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CallVoid(core, "executeUserOp", account, op));
        StringAssert.Contains(fault.Message, "SA_PROOF_INVALID",
            "a repeated hookId is tampering, not a threshold");
    }

    /// <summary>
    /// A hook veto stops the operation. The core does not wrap the veto: it
    /// declares <c>SA_HOOK_REJECTED</c> but never raises it, so the observable is
    /// the hook's own abort message reaching the caller unchanged (see the
    /// <c>SA_HOOK_REJECTED</c> note in <c>rejection-regression.json</c>).
    /// </summary>
    [TestMethod]
    public void AHookThatRejectsTheTargetStopsTheOperation()
    {
        using P256SessionKey key = new();
        var fx = new RuntimeFixture();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 target = fx.Deploy("MockTransferTarget");
        UInt160 hook = fx.Deploy("hooks/WhitelistHook", core.ToArray());
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        // The hook whitelists a different target: the operation's own target is
        // not on the list, so the hook refuses and the operation must fault.
        UInt160 account = fx.CreateAccount(core, custody, "rejection-hook",
            (object)fx.InstallHook(hook, "allowTarget", AllowedTarget));
        fx.SetSigners(custody);

        BigInteger nonce = fx.PackedNonce(core, account, 0);
        object[] op = RuntimeFixture.UserOp(target, "supportsV3", Array.Empty<object?>(),
            nonce, fx.Now() + 60_000, new byte[] { 0x00 },
            configurationNonce: fx.AccountConfigurationNonce(core, account));
        op[11] = fx.SignBuiltIn(core, account, op, key);

        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            fx.CallVoid(core, "executeUserOp", account, op));
        StringAssert.Contains(fault.Message, "not in whitelist",
            "a hook veto stops the operation before the target runs, with its own reason");
    }
}
