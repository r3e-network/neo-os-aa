using System;
using System.IO;
using System.Text.RegularExpressions;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace SmartAccount.Contracts.Tests;

// ---------------------------------------------------------------------------
// Regression coverage for the VerifyContext native-asset scoping fix.
//
// Finding (MEDIUM): During ExecuteUserOp, Verify(accountId) returned true for ANY
// native NEO/GAS callback (CallingScriptHash == NEO.Hash || GAS.Hash) with no scoping
// to the operation that was actually authorized. A target authorized only for a single
// non-financial method on some other contract could therefore make the account's full
// NEO/GAS move during execution, defeating session-key / method scoping.
//
// Fix: the native callback is only honored when the user-signed operation explicitly
// targeted that same native asset (the stored VerifyContext target == NEO/GAS), which is
// exactly the value transfer the owner signed. Targets bound to any other contract can no
// longer satisfy the wallet's witness check for native transfers.
//
// These assertions are source-level (mirroring the existing SourceInvariantTests style)
// so they pin the security invariant against the contract source authoritatively and
// without relying on a bespoke malicious target contract being compiled into bin/public.
// ---------------------------------------------------------------------------

[TestClass]
public class FixVerifyContextTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string CoreDir = Path.Combine(RepoRoot, "contracts", "custom");

    private static string VerifyContextSource() =>
        File.ReadAllText(Path.Combine(CoreDir, "SmartAccount.VerifyContext.cs"));

    /// <summary>
    /// Isolates the body of <c>Verify</c> so assertions about the native-asset branch are not
    /// satisfied accidentally by unrelated code elsewhere in the file.
    /// </summary>
    private static string VerifyMethodBody()
    {
        string source = VerifyContextSource();
        int signatureIdx = source.IndexOf("public static bool Verify(UInt160 accountId)", StringComparison.Ordinal);
        Assert.IsTrue(signatureIdx >= 0, "Verify(UInt160) entrypoint must exist");

        int braceStart = source.IndexOf('{', signatureIdx);
        Assert.IsTrue(braceStart >= 0, "Verify body opening brace must exist");

        int depth = 1;
        int pos = braceStart + 1;
        while (pos < source.Length && depth > 0)
        {
            if (source[pos] == '{') depth++;
            else if (source[pos] == '}') depth--;
            pos++;
        }
        return source[braceStart..pos];
    }

    [TestMethod, Timeout(120_000)]
    public void Fix_VerifyContext_NativeBranchIsScopedToTheSignedAssetTarget()
    {
        string verify = VerifyMethodBody();

        // The vulnerable blanket authorization must be gone: returning true for ANY caller that
        // merely happens to be NEO or GAS, regardless of the operation that was authorized.
        Assert.IsFalse(
            Regex.IsMatch(verify, @"return\s+Runtime\.CallingScriptHash\s*==\s*NEO\.Hash\s*\|\|\s*Runtime\.CallingScriptHash\s*==\s*GAS\.Hash\s*;"),
            "The blanket native NEO/GAS authorization (return CallingScriptHash == NEO.Hash || GAS.Hash) must be removed");

        // The native callback must instead be gated on the active op target being that same asset.
        StringAssert.Contains(verify, "Runtime.CallingScriptHash == NEO.Hash) return activeTarget == NEO.Hash",
            "NEO callback must require the signed op target to be NEO");
        StringAssert.Contains(verify, "Runtime.CallingScriptHash == GAS.Hash) return activeTarget == GAS.Hash",
            "GAS callback must require the signed op target to be GAS");
    }

    [TestMethod, Timeout(120_000)]
    public void Fix_VerifyContext_UnmatchedNativeCallerIsRejected()
    {
        string verify = VerifyMethodBody();

        // A caller that is neither the active target nor a native asset whose op was signed for it
        // must fall through to an explicit rejection rather than any permissive default.
        StringAssert.Contains(verify, "return false;",
            "The Application branch must explicitly reject callers that fail every scoped check");

        // The stored VerifyContext target must still be read and compared first, preserving the
        // legitimate direct-call path (target contract == calling contract).
        StringAssert.Contains(verify, "Prefix_VerifyContext", "Verify must read the active execution context");
        StringAssert.Contains(verify, "activeTarget == Runtime.CallingScriptHash) return true",
            "Direct authorized-target calls must still be honored");
    }
}
