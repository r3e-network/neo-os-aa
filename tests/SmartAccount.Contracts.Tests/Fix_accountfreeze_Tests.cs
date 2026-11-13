using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Audit fix M-4: account-level freeze. <c>freezeAccount</c>/<c>unfreezeAccount</c> are
/// backup-owner gated; a frozen account rejects user-operation execution and every plugin
/// configuration path, while the escape path stays reachable as the backup owner's
/// unconditional recovery route. Escape finalization clears the freeze and the account
/// comes back unfrozen.
/// </summary>
[TestClass]
public class Fix_AccountFreeze_Tests
{
    private static readonly UInt160 BackupOwner =
        UInt160.Parse("0x13ef519c362973f9a34648a9eac5b71250b2a80a");

    private static readonly UInt160 Stranger =
        UInt160.Parse("0x9999999999999999999999999999999999999999");

    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private const uint EscapeTimelockSeconds = 2_592_000;

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Target { get; }

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccountV3");
            Target = Fx.Deploy("MockTransferTarget");
        }

        /// <summary>Registers a native-fallback account (no verifier, no hook) owned by the backup owner.</summary>
        public UInt160 RegisterAccount()
        {
            UInt160 accountId = Fx.CallUInt160(
                Wallet, "computeRegistrationAccountId",
                UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, BackupOwner, EscapeTimelockSeconds);
            Fx.SetSigners(BackupOwner);
            Fx.CallVoid(
                Wallet, "registerAccount",
                accountId, UInt160.Zero, Array.Empty<byte>(), UInt160.Zero, BackupOwner, EscapeTimelockSeconds);
            return accountId;
        }

        public object?[] TransferArgs(UInt160 accountId) => new object?[]
        {
            Fx.CallUInt160(Wallet, "getProxyScriptHash", accountId), Recipient, (BigInteger)1000, null
        };

        public object[] TransferOp(UInt160 accountId, BigInteger nonce, BigInteger deadline) =>
            RuntimeFixture.UserOp(Target, "transfer", TransferArgs(accountId), nonce, deadline, Array.Empty<byte>());

        public BigInteger Nonce(UInt160 accountId) => Fx.CallInteger(Wallet, "getNonce", accountId, 0);
    }

    private static UInt160 EventAccount(Neo.VM.Types.Array state) =>
        (UInt160)Neo.SmartContract.Testing.Extensions.TestExtensions.ConvertTo(state[0], typeof(UInt160))!;

    [TestMethod]
    public void Freeze_BlocksUserOpExecution_AndUnfreezeRestoresIt()
    {
        Harness h = new();
        UInt160 account = h.RegisterAccount();
        h.Fx.SetSigners(BackupOwner);
        BigInteger deadline = h.Fx.Now() + 3_600_000;
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "executeUserOp", account, h.TransferOp(account, 0, deadline)));

        h.Fx.CallVoid(h.Wallet, "freezeAccount", account);
        Assert.AreEqual(account, EventAccount(h.Fx.SingleNotificationState(h.Wallet, "AccountFrozen")));
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", account));

        // A frozen account executes nothing — not even for the backup owner's own witness;
        // only escape and unfreeze stay reachable.
        TestException blocked = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallBoolean(h.Wallet, "executeUserOp", account, h.TransferOp(account, 1, deadline)));
        StringAssert.Contains(blocked.Message, "Account frozen");
        Assert.AreEqual(BigInteger.One, h.Nonce(account),
            "A frozen rejection must not consume the sequence.");

        h.Fx.CallVoid(h.Wallet, "unfreezeAccount", account);
        Assert.AreEqual(account, EventAccount(h.Fx.SingleNotificationState(h.Wallet, "AccountUnfrozen")));
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "executeUserOp", account, h.TransferOp(account, 1, deadline)),
            "Execution must work again after unfreezing");
    }

    [TestMethod]
    public void IsAccountFrozen_ReportsFalseForUnknownAccounts()
    {
        // Audit Low 5: a [Safe] query reports a zero value for an unknown account
        // instead of faulting, matching the read-only convention of the other safe
        // entries. Format validation still applies to the account id itself.
        Harness h = new();
        UInt160 unknown = UInt160.Parse("0x5555555555555555555555555555555555555555");
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", unknown),
            "An unknown account must report not frozen");

        TestException invalid = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", UInt160.Zero));
        StringAssert.Contains(invalid.Message, "Account id required");

        // Registered accounts keep the same observable behavior as before.
        UInt160 account = h.RegisterAccount();
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", account));
        h.Fx.SetSigners(BackupOwner);
        h.Fx.CallVoid(h.Wallet, "freezeAccount", account);
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", account));
    }

    [TestMethod]
    public void OnlyBackupOwner_CanFreezeAndUnfreeze()
    {
        Harness h = new();
        UInt160 account = h.RegisterAccount();

        h.Fx.SetSigners(Stranger);
        TestException strangerFreeze = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "freezeAccount", account));
        StringAssert.Contains(strangerFreeze.Message, "Unauthorized");
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", account),
            "A rejected freeze must not latch the account.");

        h.Fx.SetSigners(BackupOwner);
        h.Fx.CallVoid(h.Wallet, "freezeAccount", account);
        TestException doubleFreeze = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "freezeAccount", account));
        StringAssert.Contains(doubleFreeze.Message, "Account already frozen");

        h.Fx.SetSigners(Stranger);
        TestException strangerUnfreeze = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "unfreezeAccount", account));
        StringAssert.Contains(strangerUnfreeze.Message, "Unauthorized");
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", account),
            "A rejected unfreeze must keep the freeze latched.");

        h.Fx.SetSigners(BackupOwner);
        h.Fx.CallVoid(h.Wallet, "unfreezeAccount", account);
        TestException redundantUnfreeze = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "unfreezeAccount", account));
        StringAssert.Contains(redundantUnfreeze.Message, "Account not frozen");
    }

    [TestMethod]
    public void FrozenAccount_RejectsPluginConfigurationPaths()
    {
        Harness h = new();
        UInt160 account = h.RegisterAccount();
        h.Fx.SetSigners(BackupOwner);
        h.Fx.CallVoid(h.Wallet, "freezeAccount", account);

        // setMetadataUri is one of the configuration paths gated by the freeze latch.
        TestException metadata = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallVoid(h.Wallet, "setMetadataUri", account, "https://metadata.invalid"));
        StringAssert.Contains(metadata.Message, "Account frozen");

        // callVerifier (and its child variant) is the 24h timelocked plugin-call path:
        // a frozen account rejects it before any pending-call staging.
        TestException verifierCall = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallBoolean(h.Wallet, "callVerifier", account, "setSessionKey", new object?[] { account }));
        StringAssert.Contains(verifierCall.Message, "Account frozen");
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "hasPendingVerifierCall", account),
            "A frozen account must not stage plugin calls.");

        // updateVerifier is an installation path; it is rejected as well.
        TestException update = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallVoid(h.Wallet, "updateVerifier", account, UInt160.Zero, Array.Empty<byte>()));
        StringAssert.Contains(update.Message, "Account frozen");
    }

    [TestMethod]
    public void FrozenAccount_EscapeStaysReachable_AndFinalizeUnfreezes()
    {
        Harness h = new();
        UInt160 account = h.RegisterAccount();
        h.Fx.SetSigners(BackupOwner);
        h.Fx.CallVoid(h.Wallet, "freezeAccount", account);

        // The escape path is deliberately NOT gated by the freeze: it is the backup
        // owner's unconditional recovery route while the account is frozen.
        h.Fx.CallVoid(h.Wallet, "initiateEscape", account);
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isEscapeActive", account));

        h.Fx.AdvanceTime(TimeSpan.FromSeconds(EscapeTimelockSeconds));
        h.Fx.CallVoid(h.Wallet, "finalizeEscapeToOwner", account);
        Assert.AreEqual(account, EventAccount(h.Fx.SingleNotificationState(h.Wallet, "AccountUnfrozen")),
            "Escape finalization must unfreeze and announce it.");
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", account));

        // The finalized account is clean and unfrozen: backup-owner execution works again.
        BigInteger deadline = h.Fx.Now() + 3_600_000;
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "executeUserOp", account, h.TransferOp(account, 0, deadline)));
    }
}
