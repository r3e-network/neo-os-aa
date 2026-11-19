using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Audit fix L-2: a hook must never treat a malformed operation view as a no-op.
///
/// v3 hooks received a free-form parameter array and only checked that it was long
/// enough. v4 hands every callback the canonical 13-field operation view
/// (docs/SA-MODULE-PROTOCOL.md §4.1) and every hook re-checks the exact field count
/// before reading anything, so a short or oversized view faults instead of
/// permitting the operation. The shape gate runs before the caller gate, which is
/// why a foreign caller still gets the shape verdict for a malformed view.
/// </summary>
[TestClass]
public class Fix_HookFailClosed_Tests
{
    private static readonly UInt160 Account =
        UInt160.Parse("0x1111111111111111111111111111111111111111");

    private static readonly UInt160 Target =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    /// <summary>The canonical 13-field v4 operation view (spec §4.1).</summary>
    private static object[] CanonicalView() => new object[]
    {
        4,                                  // version
        Target,                             // target
        "transfer",                         // method
        new object?[] { Account, Account, 1, null }, // args
        0,                                  // nonce
        new byte[32],                       // nonceSubkey
        0,                                  // deadline
        0,                                  // validatorId
        1,                                  // credentialGeneration
        1,                                  // authorityEpoch
        1,                                  // configurationNonce
        Array.Empty<byte>(),                // signature
        Array.Empty<object>(),              // hookProofs
    };

    [TestMethod]
    public void Hooks_FailClosed_OnMalformedOperationParams()
    {
        foreach (string hookName in new[]
                 {
                     "hooks/WhitelistHook", "hooks/TokenRestrictedHook", "hooks/NeoDIDCredentialHook",
                 })
        {
            RuntimeFixture fx = new();
            UInt160 core = fx.Deploy("MockVerifierCore");
            UInt160 hook = fx.Deploy(hookName, core.ToArray());

            // A one-element view used to slip past the old length check and allow
            // everything; it must now fault instead of silently permitting the operation.
            object[] shortParams = { Target };
            TestException shortFault = Assert.ThrowsExactly<TestException>(
                () => fx.CallVoid(hook, "preCheck", Account, shortParams),
                $"{hookName} must fail closed on a truncated operation view");
            StringAssert.Contains(shortFault.Message, "Invalid operation shape");

            // The canonical view has exactly thirteen fields; a fourteenth must fault too.
            object[] longParams = new object[CanonicalView().Length + 1];
            CanonicalView().CopyTo(longParams, 0);
            longParams[^1] = null!;
            TestException longFault = Assert.ThrowsExactly<TestException>(
                () => fx.CallVoid(hook, "preCheck", Account, longParams),
                $"{hookName} must fail closed on an oversized operation view");
            StringAssert.Contains(longFault.Message, "Invalid operation shape");
        }
    }

    [TestMethod]
    public void WhitelistHook_AcceptsTheCanonicalThirteenFieldOperationShape()
    {
        RuntimeFixture fx = new();
        using P256SessionKey key = new();
        UInt160 core = fx.Deploy("SmartAccount");
        UInt160 target = fx.Deploy("MockTransferTarget");
        UInt160 hook = fx.Deploy("hooks/WhitelistHook", core.ToArray());
        UInt160 custody = RuntimeFixture.CustodyOf(key);

        UInt160 accountId = fx.CreateAccount(core, custody, "hook-fail-closed",
            new object[] { fx.InstallHook(hook, "allowTarget", target) });

        // The core's own view passes the shape gate and reaches the policy check, which
        // allows the allowlisted target: the fail-closed assert must not break the happy path.
        fx.SetSigners(custody);
        BigInteger deadline = fx.Now() + 3_600_000;
        BigInteger configurationNonce = fx.AccountConfigurationNonce(core, accountId);
        object[] allowed = RuntimeFixture.UserOp(
            target, "supportsV3", new object?[0], fx.PackedNonce(core, accountId, 0), deadline,
            new byte[] { 0x00 }, configurationNonce: configurationNonce);
        allowed[11] = fx.SignBuiltIn(core, accountId, allowed, key);
        Assert.IsTrue(fx.CallBoolean(core, "executeUserOp", accountId, allowed),
            "The allowlisted target must pass the canonical pre-hook");

        // The same canonical shape still enforces the policy: a target outside the
        // instance allowlist is rejected by preCheck.
        object[] blocked = RuntimeFixture.UserOp(
            core, "getProtocolInfo", new object?[0], fx.PackedNonce(core, accountId, 0), deadline,
            new byte[] { 0x00 }, configurationNonce: configurationNonce);
        blocked[11] = fx.SignBuiltIn(core, accountId, blocked, key);
        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => fx.CallBoolean(core, "executeUserOp", accountId, blocked));
        StringAssert.Contains(rejected.Message, "Target contract not in whitelist");

        // Called directly, the same canonical view passes the shape gate and stops at
        // authorization: the hook never trusts a caller-declared instance.
        TestException unauthorized = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(hook, "preCheck", accountId, CanonicalView()));
        StringAssert.Contains(unauthorized.Message, "Unauthorized caller");
    }
}
