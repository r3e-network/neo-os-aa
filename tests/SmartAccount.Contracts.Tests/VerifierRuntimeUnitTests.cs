using System;
using System.IO;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace SmartAccount.Contracts.Tests;

[TestClass]
public class VerifierRuntimeUnitTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string VerifiersDir = Path.Combine(RepoRoot, "contracts", "plugins", "verifiers");

    private static string Read(string fileName) =>
        File.ReadAllText(Path.Combine(VerifiersDir, fileName));

    [TestMethod]
    public void SessionKeyVerifier_UsesRuntimeMillisecondsForExpiryAndRotation()
    {
        string source = Read("SessionKeyVerifier.cs");

        StringAssert.Contains(source, "KeyRotationCooldownMs = 24L * 60 * 60 * 1000");
        StringAssert.Contains(source, "MaxSessionDurationMs = 30L * 24 * 60 * 60 * 1000");
        StringAssert.Contains(source, "validUntil <= Runtime.Time + MaxSessionDurationMs");
        StringAssert.Contains(source, "Runtime.Time >= lastRotation + KeyRotationCooldownMs");
        Assert.IsFalse(source.Contains("KeyRotationCooldownSeconds", StringComparison.Ordinal));
        Assert.IsFalse(source.Contains("MaxSessionDurationSeconds", StringComparison.Ordinal));
    }

    [TestMethod]
    public void SubscriptionVerifier_UsesMillisecondsForBillingPeriods()
    {
        string source = Read("SubscriptionVerifier.cs");

        StringAssert.Contains(source, "BigInteger billingPeriodMs = config.PeriodSeconds * 1000");
        StringAssert.Contains(source, "BigInteger currentPeriod = Runtime.Time / billingPeriodMs");
        Assert.IsFalse(source.Contains("Runtime.Time / config.PeriodSeconds", StringComparison.Ordinal));
    }
}
