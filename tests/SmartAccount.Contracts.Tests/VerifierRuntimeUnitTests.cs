using System;
using System.IO;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace SmartAccount.Contracts.Tests;

[TestClass]
public class VerifierRuntimeUnitTests
{
    private static readonly string RepoRoot =
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));

    private static readonly string VerifiersDir = Path.Combine(RepoRoot, "contracts", "plugins", "validators");

    private static string Read(string fileName) =>
        File.ReadAllText(Path.Combine(VerifiersDir, fileName));

    [TestMethod]
    public void SessionKeyValidator_UsesRuntimeMillisecondsForExpiryAndRotation()
    {
        string source = Read("SessionKeyValidator.cs");

        StringAssert.Contains(source, "KeyRotationCooldownMs = 24L * 60 * 60 * 1000");
        StringAssert.Contains(source, "MaxSessionDurationMs = 30L * 24 * 60 * 60 * 1000");
        StringAssert.Contains(source, "validUntil <= Runtime.Time + MaxSessionDurationMs");
        StringAssert.Contains(source, "Runtime.Time >= lastRotation + KeyRotationCooldownMs");
        Assert.IsFalse(source.Contains("KeyRotationCooldownSeconds", StringComparison.Ordinal));
        Assert.IsFalse(source.Contains("MaxSessionDurationSeconds", StringComparison.Ordinal));
    }

    [TestMethod]
    public void SubscriptionValidator_UsesMillisecondsForBillingPeriods()
    {
        string source = Read("SubscriptionValidator.cs");

        // v4 keeps the period in seconds in the stored record and converts to the
        // millisecond clock at comparison time, in both the validation and the
        // completion path.
        StringAssert.Contains(source, "BigInteger currentPeriod = Now() / (periodSeconds * 1000);");
        StringAssert.Contains(source, "periodSeconds * 1000");
        Assert.IsFalse(source.Contains("Now() / periodSeconds", StringComparison.Ordinal));
        Assert.IsFalse(source.Contains("Runtime.Time / config.PeriodSeconds", StringComparison.Ordinal));
        Assert.IsFalse(source.Contains("PeriodSecondsSeconds", StringComparison.Ordinal));
    }
}
