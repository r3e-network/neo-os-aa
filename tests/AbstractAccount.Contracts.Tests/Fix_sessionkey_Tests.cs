using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Regression for the MEDIUM finding: a SessionKey spending limit is only enforced for the
/// literal method "transfer" (see SessionKeyVerifier.ExtractTransferValue). A wildcard ("*")
/// or non-transfer session key configured with spendingLimit &gt; 0 would carry a cap that is
/// never enforced. The fix fails closed in SetSessionKey by rejecting a positive spending limit
/// unless the session key's method is "transfer".
/// </summary>
[TestClass]
public class Fix_SessionKey_Tests
{
    private static readonly UInt160 AccountId =
        UInt160.Parse("0x1111111111111111111111111111111111111111");

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();
        public UInt160 Core { get; }
        public UInt160 Target { get; }
        public UInt160 Owner { get; } = UInt160.Parse("0x2222222222222222222222222222222222222222");
        public UInt160 Attacker { get; } = UInt160.Parse("0x3333333333333333333333333333333333333333");

        public Harness()
        {
            Core = Fx.Deploy("MockVerifierCore");
            Target = Fx.Deploy("MockTransferTarget");
            Fx.CallVoid(Core, "setBackupOwner", AccountId, Owner);
            Fx.SetSigners(Owner);
        }

        public UInt160 DeployVerifier() => Fx.Deploy("verifiers/SessionKeyVerifier", Core.ToArray());

        public void SetSessionKey(UInt160 verifier, byte[] pubKey, string method, BigInteger spendingLimit)
        {
            BigInteger validUntil = Fx.Now() + 86_400_000; // 24h
            Fx.CallVoid(Core, "forward", verifier, "setSessionKey",
                new object?[] { AccountId, pubKey, Target, method, validUntil, spendingLimit, "fix suite" });
        }

        public void SetSessionKeyDirect(UInt160 verifier, byte[] pubKey)
        {
            BigInteger validUntil = Fx.Now() + 86_400_000;
            Fx.CallVoid(verifier, "setSessionKey",
                AccountId, pubKey, Target, "transfer", validUntil, 1000, "direct owner suite");
        }
    }

    [TestMethod]
    public void WildcardSessionKey_WithSpendingLimit_IsRejectedAtConfig()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = h.DeployVerifier();

        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.SetSessionKey(verifier, key.CompressedPublicKey, "*", spendingLimit: 1000));
        StringAssert.Contains(rejected.Message, "Spending limit only enforceable on transfer session keys");
    }

    [TestMethod]
    public void NonTransferSessionKey_WithSpendingLimit_IsRejectedAtConfig()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = h.DeployVerifier();

        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.SetSessionKey(verifier, key.CompressedPublicKey, "burn", spendingLimit: 1000));
        StringAssert.Contains(rejected.Message, "Spending limit only enforceable on transfer session keys");
    }

    [TestMethod]
    public void WildcardSessionKey_WithZeroLimit_IsAllowed()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = h.DeployVerifier();

        // A wildcard key with no spending limit remains a legitimate configuration.
        h.SetSessionKey(verifier, key.CompressedPublicKey, "*", spendingLimit: 0);

        var stored = h.Fx.Call(verifier, "getSessionKey", AccountId);
        Assert.AreNotEqual(Neo.VM.Types.StackItem.Null, stored, "Wildcard session key without a limit must be configurable");
    }

    [TestMethod]
    public void TransferSessionKey_WithSpendingLimit_IsAllowed()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = h.DeployVerifier();

        // The enforceable transfer path keeps accepting a positive limit (no false rejection).
        h.SetSessionKey(verifier, key.CompressedPublicKey, "transfer", spendingLimit: 1000);

        var stored = h.Fx.Call(verifier, "getSessionKey", AccountId);
        Assert.AreNotEqual(Neo.VM.Types.StackItem.Null, stored, "Transfer session key with a limit must be configurable");
    }

    // SessionKeyGranted state layout:
    // [accountId, pubKey, targetContract, method, validUntil, spendingLimit, uncapped]
    private const int UncappedFlagIndex = 6;

    [TestMethod]
    public void WildcardSessionKey_EmitsGrantEvent_FlaggedUncapped()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = h.DeployVerifier();

        // A wildcard key carries no enforceable cap (any method moves value); the grant event must
        // advertise that so the UI can warn the key is value-uncapped, not "limited to one method".
        h.SetSessionKey(verifier, key.CompressedPublicKey, "*", spendingLimit: 0);

        Neo.VM.Types.Array state = h.Fx.SingleNotificationState(verifier, "SessionKeyGranted");
        Assert.IsTrue(state[UncappedFlagIndex].GetBoolean(), "Wildcard session key must be flagged uncapped");
    }

    [TestMethod]
    public void TransferSessionKey_WithSpendingLimit_EmitsGrantEvent_FlaggedCapped()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = h.DeployVerifier();

        // A transfer key with a positive limit is the one configuration with an enforced cap, so
        // the grant event must report it as capped.
        h.SetSessionKey(verifier, key.CompressedPublicKey, "transfer", spendingLimit: 1000);

        Neo.VM.Types.Array state = h.Fx.SingleNotificationState(verifier, "SessionKeyGranted");
        Assert.IsFalse(state[UncappedFlagIndex].GetBoolean(), "Capped transfer session key must not be flagged uncapped");
    }

    [TestMethod]
    public void TransferSessionKey_WithoutSpendingLimit_EmitsGrantEvent_FlaggedUncapped()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = h.DeployVerifier();

        // A transfer key with no limit (0 = unlimited) is also value-uncapped and must be flagged.
        h.SetSessionKey(verifier, key.CompressedPublicKey, "transfer", spendingLimit: 0);

        Neo.VM.Types.Array state = h.Fx.SingleNotificationState(verifier, "SessionKeyGranted");
        Assert.IsTrue(state[UncappedFlagIndex].GetBoolean(), "Zero-limit transfer session key must be flagged uncapped");
    }

    [TestMethod]
    public void BackupOwner_CanConfigureAndClearSessionKeyDirectly()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = h.DeployVerifier();

        h.SetSessionKeyDirect(verifier, key.CompressedPublicKey);
        Assert.AreNotEqual(Neo.VM.Types.StackItem.Null, h.Fx.Call(verifier, "getSessionKey", AccountId));

        h.Fx.CallVoid(verifier, "clearSessionKey", AccountId);
        Neo.VM.Types.Array state = h.Fx.SingleNotificationState(verifier, "SessionKeyRevoked");
        Assert.AreEqual(AccountId, (UInt160)Neo.SmartContract.Testing.Extensions.TestExtensions.ConvertTo(
            state[0], typeof(UInt160))!);
        Assert.AreEqual(Neo.VM.Types.StackItem.Null, h.Fx.Call(verifier, "getSessionKey", AccountId));
    }

    [TestMethod]
    public void NonOwner_CannotConfigureOrClearSessionKeyDirectly()
    {
        Harness h = new();
        using P256SessionKey key = new();
        UInt160 verifier = h.DeployVerifier();
        h.Fx.SetSigners(h.Attacker);

        TestException configureRejected = Assert.ThrowsExactly<TestException>(
            () => h.SetSessionKeyDirect(verifier, key.CompressedPublicKey));
        StringAssert.Contains(configureRejected.Message, "Backup owner witness required");

        TestException clearRejected = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(verifier, "clearSessionKey", AccountId));
        StringAssert.Contains(clearRejected.Message, "Backup owner witness required");
    }
}
