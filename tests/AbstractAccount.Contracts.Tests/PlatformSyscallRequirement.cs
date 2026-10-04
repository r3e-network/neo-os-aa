using System;
using System.Buffers.Binary;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.SmartContract;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Reports tests that execute a platform syscall which the Neo core under test does not register.
/// <para>
/// <c>System.Contract.CallWithGasLimit</c> is registered by no published Neo core, so the tests
/// that drive a verifier callback through the AA core cannot run on the published
/// <c>Neo.SmartContract.Testing</c> engine: its interop table has no entry for the syscall and the
/// call faults with a missing-key error. Such a test is reported as skipped with the reason instead
/// of failing for an environmental cause; where the engine does register the syscall it runs
/// normally. Set <c>NEOOS_REQUIRE_PLATFORM_SYSCALLS=1</c> in an environment that is expected to
/// register it and a missing syscall fails the run instead.
/// </para>
/// </summary>
internal static class PlatformSyscallRequirement
{
    /// <summary>
    /// Set to 1 to turn a missing platform syscall from a reported skip into a failure.
    /// </summary>
    public const string RequireEnvVar = "NEOOS_REQUIRE_PLATFORM_SYSCALLS";

    public const string CallWithGasLimit = "System.Contract.CallWithGasLimit";

    /// <summary>The interop hash the engine and the compiler derive from a syscall name.</summary>
    public static uint InteropHash(string name) =>
        BinaryPrimitives.ReadUInt32LittleEndian(SHA256.HashData(Encoding.ASCII.GetBytes(name)));

    public static bool IsRegistered(string name) => ApplicationEngine.Services.ContainsKey(InteropHash(name));

    /// <summary>
    /// Returns when the engine registers <paramref name="name"/>; otherwise skips the calling test
    /// (or fails it when <see cref="RequireEnvVar"/> is 1).
    /// </summary>
    public static void RequireRegistered(string name)
    {
        if (IsRegistered(name))
            return;

        string reason =
            $"SKIPPED (not run): the Neo core in this TestEngine does not register {name} " +
            $"(interop hash {InteropHash(name)}); no published Neo core does. The compiled AA core " +
            "emits that syscall for every verifier callback, so this test can only run on a core that " +
            $"registers it. Set {RequireEnvVar}=1 to make the missing syscall a failure.";

        if (Environment.GetEnvironmentVariable(RequireEnvVar) == "1")
            Assert.Fail(reason);

        Assert.Inconclusive(reason);
    }
}

/// <summary>
/// Pins the platform-syscall boundary: the detection itself, the interop hash that error messages
/// and documents quote, and the exact set of tests that are allowed to be skipped for it.
/// </summary>
[TestClass]
public class PlatformSyscallRequirementTests
{
    private static readonly string TestsDir = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "../../../../../", "tests", "AbstractAccount.Contracts.Tests"));

    private const string GuardCall = "PlatformSyscallRequirement.RequireRegistered(";

    [TestMethod]
    public void InteropHashMatchesTheValueQuotedInDiagnostics()
    {
        // The KeyNotFoundException raised by an engine without the syscall names this key.
        Assert.AreEqual(1371299780u, PlatformSyscallRequirement.InteropHash(PlatformSyscallRequirement.CallWithGasLimit));
    }

    [TestMethod]
    public void DetectionSeesSyscallsTheEngineRegistersAndOnlyThose()
    {
        // If detection returned false for everything, every guarded test would be skipped on a
        // core that does register the syscall, and the suite would pass while proving nothing.
        Assert.IsTrue(PlatformSyscallRequirement.IsRegistered("System.Contract.Call"));
        Assert.IsTrue(PlatformSyscallRequirement.IsRegistered("System.Runtime.CheckWitness"));
        Assert.IsFalse(PlatformSyscallRequirement.IsRegistered("System.Contract.NoSuchSyscall"));
    }

    [TestMethod]
    public void OnlyTheFourVerifierCallbackRuntimeTestsAreGuarded()
    {
        // A skip is a reduction in coverage. Adding one must be a reviewed decision, so the
        // guard may appear only in the four tests that drive a verifier callback through the core.
        string[] guardedFiles = Directory.EnumerateFiles(TestsDir, "*.cs")
            .Where(path => File.ReadAllText(path).Contains(GuardCall, StringComparison.Ordinal))
            .Where(path => !path.EndsWith("PlatformSyscallRequirement.cs", StringComparison.Ordinal))
            .Select(Path.GetFileName)
            .ToArray()!;
        CollectionAssert.AreEqual(new[] { "ExecuteUserOpRuntimeTests.cs" }, guardedFiles);

        string source = File.ReadAllText(Path.Combine(TestsDir, "ExecuteUserOpRuntimeTests.cs"));
        string[] guarded =
        {
            "ExecuteUserOp_RecoveryVerifier_EnforcesOwnerAndCoreContext",
            "ExecuteUserOp_VerifierPath_AcceptsValidSessionSignatureWithoutOwnerWitness",
            "ExecuteUserOp_VerifierPath_RejectsTamperedSessionSignature",
            "ExecuteUserOp_ActiveEscape_OnlyBackupOwnerWitnessMayExecute",
        };
        int calls = 0;
        foreach (string testName in guarded)
        {
            int start = source.IndexOf($"public void {testName}()", StringComparison.Ordinal);
            Assert.IsTrue(start >= 0, $"{testName} is missing");
            int next = source.IndexOf("[TestMethod]", start, StringComparison.Ordinal);
            string body = source.Substring(start, (next < 0 ? source.Length : next) - start);
            Assert.AreEqual(1, CountOccurrences(body, GuardCall), $"{testName} must call the platform guard once");
            calls++;
        }

        Assert.AreEqual(calls, CountOccurrences(source, GuardCall), "the guard is used outside the four named tests");
    }

    private static int CountOccurrences(string text, string needle)
    {
        int count = 0;
        for (int at = text.IndexOf(needle, StringComparison.Ordinal);
             at >= 0;
             at = text.IndexOf(needle, at + needle.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }
}
