using System;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Audit fix L-2: hooks previously treated a malformed (short) <c>opParams</c> array as a
/// no-op and silently allowed the operation. The core always passes the fixed 6-element
/// operation shape [target, method, args, nonce, deadline, signature]; the hooks now
/// assert that shape exactly and fail closed on anything else.
/// </summary>
[TestClass]
public class Fix_HookFailClosed_Tests
{
    private static readonly UInt160 Account =
        UInt160.Parse("0x1111111111111111111111111111111111111111");

    private static readonly UInt160 Target =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

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

            // A 1-element opParams array used to slip past the old length check and allow
            // everything; it must now fault instead of silently permitting the operation.
            object[] shortParams = { Target };
            TestException shortFault = Assert.ThrowsExactly<TestException>(
                () => fx.CallVoid(hook, "preExecute", Account, shortParams),
                $"{hookName} must fail closed on a malformed opParams array");
            StringAssert.Contains(shortFault.Message, "Invalid hook operation params");

            // The canonical shape has exactly six elements; a seventh must fault too.
            object[] longParams =
            {
                Target, "transfer", new object?[] { Account, Account, 1, null }, 0, 0, Array.Empty<byte>(), null!
            };
            TestException longFault = Assert.ThrowsExactly<TestException>(
                () => fx.CallVoid(hook, "preExecute", Account, longParams),
                $"{hookName} must fail closed on an oversized opParams array");
            StringAssert.Contains(longFault.Message, "Invalid hook operation params");
        }
    }

    [TestMethod]
    public void WhitelistHook_AcceptsTheCanonicalSixElementOperationShape()
    {
        RuntimeFixture fx = new();
        UInt160 core = fx.Deploy("MockVerifierCore");
        UInt160 hook = fx.Deploy("hooks/WhitelistHook", core.ToArray());
        fx.CallVoid(core, "forward", hook, "setWhitelist", new object[] { Account, Target, true });

        // The canonical 6-element shape reaches the policy check and passes for an
        // allowlisted target — the fail-closed assert must not break the happy path.
        object[] opParams =
        {
            Target, "transfer", new object?[] { Account, Account, 1, null }, 0, 0, Array.Empty<byte>()
        };
        fx.CallVoid(hook, "preExecute", Account, opParams);

        // The same canonical shape still enforces the policy for a non-allowlisted target.
        object[] blockedParams =
        {
            core, "transfer", new object?[] { Account, Account, 1, null }, 0, 0, Array.Empty<byte>()
        };
        TestException blocked = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(hook, "preExecute", Account, blockedParams));
        StringAssert.Contains(blocked.Message, "Target contract not in whitelist");
    }
}
