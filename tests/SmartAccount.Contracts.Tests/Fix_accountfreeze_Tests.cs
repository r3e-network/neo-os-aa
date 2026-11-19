using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Account-level freeze (audit fix M-4, spec §10). <c>freezeAccount</c>/<c>unfreezeAccount</c>
/// are custody-gated; a frozen account executes nothing and every configuration
/// path is closed with <c>SA_ACCOUNT_STATUS</c>, while the callback-free recovery
/// flow stays reachable as the custody's unconditional route and rewrites the
/// control status back to Active.
/// </summary>
[TestClass]
public class Fix_AccountFreeze_Tests
{
    private static readonly UInt160 Stranger =
        UInt160.Parse("0x9999999999999999999999999999999999999999");

    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Wallet { get; }

        public UInt160 Target { get; }

        public P256SessionKey Key { get; } = new();

        public UInt160 Custody { get; }

        private int _sequence;

        public Harness()
        {
            Wallet = Fx.Deploy("SmartAccount");
            Target = Fx.Deploy("MockTransferTarget");
            Custody = RuntimeFixture.CustodyOf(Key);
        }

        /// <summary>
        /// Creates a v4 account whose built-in route (validatorId 0) is enabled with
        /// the custody key as its only message subject, so a custody signature
        /// executes without any installed module.
        /// </summary>
        public UInt160 RegisterAccount() =>
            Fx.CreateAccount(Wallet, Custody, "freeze-" + (++_sequence));

        public object?[] TransferArgs(UInt160 accountId) => new object?[]
        {
            Fx.CallUInt160(Wallet, "getProxyScriptHash", accountId), Recipient, (BigInteger)1000, null
        };

        /// <summary>Built-in operation signed by the custody key (spec §5/§8).</summary>
        public object[] SignedTransferOp(UInt160 accountId, BigInteger deadline)
        {
            // The digest binds the live authority epoch and configuration nonce,
            // so both are read back instead of assumed after a freeze/recovery.
            Neo.VM.Types.Array control = Fx.AccountControl(Wallet, accountId);
            object[] op = RuntimeFixture.UserOp(
                Target, "transfer", TransferArgs(accountId),
                Fx.PackedNonce(Wallet, accountId, 0), deadline, new byte[] { 0x00 },
                authorityEpoch: control[4].GetInteger(), configurationNonce: control[5].GetInteger());
            op[11] = Fx.SignBuiltIn(Wallet, accountId, op, Key);
            return op;
        }

        /// <summary>Consumed sequence of the built-in channel.</summary>
        public BigInteger Sequence(UInt160 accountId) =>
            RuntimeFixture.NonceSequence(Fx.PackedNonce(Wallet, accountId, 0));
    }

    private static UInt160 EventAccount(Neo.VM.Types.Array state) =>
        (UInt160)Neo.SmartContract.Testing.Extensions.TestExtensions.ConvertTo(state[0], typeof(UInt160))!;

    [TestMethod]
    public void Freeze_BlocksUserOpExecution_AndUnfreezeRestoresIt()
    {
        Harness h = new();
        UInt160 account = h.RegisterAccount();
        h.Fx.SetSigners(h.Custody);
        BigInteger deadline = h.Fx.Now() + 3_600_000;
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "executeUserOp", account, h.SignedTransferOp(account, deadline)));

        h.Fx.CallVoid(h.Wallet, "freezeAccount", account);
        Assert.AreEqual(account, EventAccount(h.Fx.SingleNotificationState(h.Wallet, "AccountFrozen")));
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", account));

        // A frozen account executes nothing — not even with the custody's own
        // signature; only unfreeze and recovery stay reachable. Freezing advanced
        // the authority epoch, so the post-freeze channel starts at sequence 0 and
        // the rejected operation must leave it there.
        BigInteger frozenSequence = h.Sequence(account);
        TestException blocked = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallBoolean(h.Wallet, "executeUserOp", account, h.SignedTransferOp(account, deadline)));
        StringAssert.Contains(blocked.Message, "SA_ACCOUNT_FROZEN");
        Assert.AreEqual(frozenSequence, h.Sequence(account),
            "A frozen rejection must not consume the sequence.");

        h.Fx.CallVoid(h.Wallet, "unfreezeAccount", account);
        Assert.AreEqual(account, EventAccount(h.Fx.SingleNotificationState(h.Wallet, "AccountUnfrozen")));
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", account));
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "executeUserOp", account, h.SignedTransferOp(account, deadline)),
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
        h.Fx.SetSigners(h.Custody);
        h.Fx.CallVoid(h.Wallet, "freezeAccount", account);
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", account));
    }

    [TestMethod]
    public void OnlyCustody_CanFreezeAndUnfreeze()
    {
        Harness h = new();
        UInt160 account = h.RegisterAccount();

        h.Fx.SetSigners(Stranger);
        TestException strangerFreeze = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "freezeAccount", account));
        StringAssert.Contains(strangerFreeze.Message, "SA_UNAUTHORIZED");
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", account),
            "A rejected freeze must not latch the account.");

        h.Fx.SetSigners(h.Custody);
        h.Fx.CallVoid(h.Wallet, "freezeAccount", account);
        TestException doubleFreeze = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "freezeAccount", account));
        StringAssert.Contains(doubleFreeze.Message, "SA_ACCOUNT_FROZEN");

        h.Fx.SetSigners(Stranger);
        TestException strangerUnfreeze = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "unfreezeAccount", account));
        StringAssert.Contains(strangerUnfreeze.Message, "SA_UNAUTHORIZED");
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", account),
            "A rejected unfreeze must keep the freeze latched.");

        h.Fx.SetSigners(h.Custody);
        h.Fx.CallVoid(h.Wallet, "unfreezeAccount", account);
        TestException redundantUnfreeze = Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallVoid(h.Wallet, "unfreezeAccount", account));
        StringAssert.Contains(redundantUnfreeze.Message, "SA_ACCOUNT_STATUS");
    }

    [TestMethod]
    public void FrozenAccount_RejectsEveryConfigurationPath()
    {
        Harness h = new();
        UInt160 account = h.RegisterAccount();
        UInt160 web = h.Fx.Deploy("validators/Web3AuthValidator", h.Wallet.ToArray());
        h.Fx.SetSigners(h.Custody);
        h.Fx.CallVoid(h.Wallet, "freezeAccount", account);

        // The metadata row is custody-gated AND active-account-gated.
        TestException metadata = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallVoid(h.Wallet, "setMetadataUri", account, "https://metadata.invalid"));
        StringAssert.Contains(metadata.Message, "SA_ACCOUNT_STATUS");

        // Installing a module goes through the configuration-intent path, which
        // only accepts an Active account: a frozen account stages nothing.
        object[] install = h.Fx.InstallValidator(web);
        TestException propose = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallInteger(h.Wallet, "proposeConfiguration", account, new object[] { install }, new object[0]));
        StringAssert.Contains(propose.Message, "SA_ACCOUNT_STATUS");
        Assert.AreEqual(0,
            ((Neo.VM.Types.Array)h.Fx.Call(h.Wallet, "getPendingConfigurationIntentIds", account)).Count,
            "A frozen account must not stage a configuration intent.");

        // Recovery policy changes take the same path and are equally closed.
        object[] policy = RuntimeFixture.SetRecoveryPolicy(h.Custody, RuntimeFixture.MinRecoveryTimelockMs);
        TestException policyFault = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallInteger(h.Wallet, "proposeConfiguration", account, new object[] { policy }, new object[0]));
        StringAssert.Contains(policyFault.Message, "SA_ACCOUNT_STATUS");
    }

    [TestMethod]
    public void FrozenAccount_RecoveryStaysReachable_AndExecutionReturns()
    {
        Harness h = new();
        UInt160 account = h.RegisterAccount();
        h.Fx.SetSigners(h.Custody);
        h.Fx.CallVoid(h.Wallet, "freezeAccount", account);

        // The recovery flow is deliberately NOT gated by the freeze: it is the
        // custody's unconditional route while the account is frozen, and it makes
        // no external call at all.
        h.Fx.CallVoid(h.Wallet, "beginRecovery", account, UInt160.Zero);
        Assert.AreEqual(5,
            ((Neo.VM.Types.Array)h.Fx.Call(h.Wallet, "getRecoveryStatus", account)).Count,
            "A pending recovery record is visible while the account is frozen.");

        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds((long)RuntimeFixture.MinRecoveryTimelockMs));
        h.Fx.CallVoid(h.Wallet, "executeRecovery", account);

        // v4 recovery rewrites the control status directly instead of going
        // through unfreeze, so the account is Active again with no recovery left.
        Assert.IsFalse(h.Fx.CallBoolean(h.Wallet, "isAccountFrozen", account));
        Assert.AreEqual(0,
            ((Neo.VM.Types.Array)h.Fx.Call(h.Wallet, "getRecoveryStatus", account)).Count);

        // The finalized account is clean and unfrozen: custody execution works again.
        BigInteger deadline = h.Fx.Now() + 3_600_000;
        Assert.IsTrue(h.Fx.CallBoolean(h.Wallet, "executeUserOp", account, h.SignedTransferOp(account, deadline)));
    }
}
