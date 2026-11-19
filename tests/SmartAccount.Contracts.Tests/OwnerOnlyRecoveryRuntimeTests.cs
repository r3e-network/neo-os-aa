using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Behavioural VM tests for the owner-only recovery latch in protocol v4.
///
/// The v3 suite pinned a custody-rotation flow around verifier/hook callbacks
/// (<c>initiateEscape</c>/<c>finalizeEscapeToOwner</c>). v4 replaced both: the
/// account's permanent "recovered to owner-only" election is a monotonic flag on
/// <c>AccountControl</c> (elected through the <c>setRecoveryPolicy</c> configuration
/// action), and it is enforced against the module model it was meant to freeze —
/// install, uninstall, configure, hook order, code rebind and threshold policy. The
/// flag never blocks the custody's own execution, non-model configuration, freeze
/// or a later core recovery; it survives all of them, including a custody rotation.
/// </summary>
[TestClass]
public class OwnerOnlyRecoveryRuntimeTests
{
    private static readonly UInt160 Stranger =
        UInt160.Parse("0x8181818181818181818181818181818181818181");

    private static readonly UInt160 NewCustody =
        UInt160.Parse("0x2222222222222222222222222222222222222222");

    private static readonly UInt160 Target =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly BigInteger Timelock = RuntimeFixture.MinRecoveryTimelockMs;

    private const string Permanent = "Owner-only recovery is permanent";

    private sealed class Harness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Core { get; }

        public UInt160 Target { get; }

        public UInt160 Hook { get; }

        public UInt160 SessionKey { get; }

        public P256SessionKey Key { get; }

        public UInt160 Custody { get; }

        private int _registrations;

        public Harness(P256SessionKey custodyKey)
        {
            Core = Fx.Deploy("SmartAccount");
            Target = Fx.Deploy("MockTransferTarget");
            Hook = Fx.Deploy("hooks/WhitelistHook", Core.ToArray());
            SessionKey = Fx.Deploy("validators/SessionKeyValidator", Core.ToArray());
            Key = custodyKey;
            Custody = RuntimeFixture.CustodyOf(custodyKey);
        }

        public UInt160 CreateAccount(string label, params object[] actions)
        {
            _registrations += 1;
            return Fx.CreateAccount(Core, Custody, label + "-" + _registrations, actions);
        }

        /// <summary>The session-key validator's registration-time init command.</summary>
        public object?[] SessionCommand() =>
            new object?[]
            {
                "setSessionKey", Key.CompressedPublicKey, Target, "transfer",
                Fx.Now() + 3_600_000, (BigInteger)0, "owner-only suite"
            };

        /// <summary>
        /// The owner-only election is a configuration action like any other; it is
        /// ordered last so it cannot block the module installs in the same batch.
        /// </summary>
        public object[] ElectOwnerOnly() =>
            RuntimeFixture.SetRecoveryPolicy(UInt160.Zero, Timelock, ownerOnlyRecovery: true);

        public bool OwnerOnly(UInt160 accountId) =>
            Fx.CallBoolean(Core, "isOwnerOnlyRecovery", accountId);

        public BigInteger[] ValidatorIds(UInt160 accountId) =>
            Fx.ModuleIds(Core, accountId, RuntimeFixture.ModuleTypeNameValidator);

        public BigInteger[] HookIds(UInt160 accountId) =>
            Fx.ModuleIds(Core, accountId, RuntimeFixture.ModuleTypeNameHook);

        /// <summary>Executes a built-in (custody-signed) transfer of one unit at the current sequence.</summary>
        public bool ExecuteTransfer(UInt160 accountId, P256SessionKey signer)
        {
            // The digest binds the live authority epoch and configuration nonce; a
            // recovery or freeze advances both, so they are read back, never assumed.
            Neo.VM.Types.Array control = Fx.AccountControl(Core, accountId);
            object[] op = RuntimeFixture.UserOp(
                Target, "transfer",
                new object?[]
                {
                    Fx.CallUInt160(Core, "getProxyScriptHash", accountId), Stranger, (BigInteger)1, null
                },
                Fx.PackedNonce(Core, accountId, 0),
                Fx.Now() + 600_000, new byte[] { 0x00 },
                authorityEpoch: control[4].GetInteger(), configurationNonce: control[5].GetInteger());
            op[11] = Fx.SignBuiltIn(Core, accountId, op, signer);
            Fx.SetSigners(CustodyOf(signer));
            return Fx.CallBoolean(Core, "executeUserOp", accountId, op);
        }

        private static UInt160 CustodyOf(P256SessionKey signer) => RuntimeFixture.CustodyOf(signer);
    }

    // ============================================================================
    // The latch itself and what it freezes.
    // ============================================================================

    [TestMethod]
    public void OwnerOnlyRecovery_LatchesAndSurvivesARecovery()
    {
        using P256SessionKey key = new();
        using P256SessionKey newKey = new();
        UInt160 rotated = RuntimeFixture.CustodyOf(newKey);
        Harness h = new(key);
        UInt160 accountId = h.CreateAccount("owner-only-latch",
            h.Fx.InstallHook(h.Hook, "allowTarget", h.Target),
            h.Fx.InstallValidator(h.SessionKey, h.SessionCommand()),
            h.ElectOwnerOnly());

        Assert.IsTrue(h.OwnerOnly(accountId), "The election is recorded on AccountControl");
        Assert.AreEqual(1, h.HookIds(accountId).Length, "Precondition: hook installed");
        Assert.AreEqual(1, h.ValidatorIds(accountId).Length, "Precondition: validator installed");

        // A recovery is still available to the custody and it still sweeps the model.
        h.Fx.SetSigners(h.Custody, rotated);
        h.Fx.CallVoid(h.Core, "beginRecovery", accountId, rotated);
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds((long)Timelock));
        h.Fx.CallVoid(h.Core, "executeRecovery", accountId);

        Assert.AreEqual(rotated, h.Fx.AccountCustody(h.Core, accountId), "Custody rotated");
        Assert.AreEqual(0, h.HookIds(accountId).Length, "Recovery sweeps the hook instance");
        Assert.AreEqual(0, h.ValidatorIds(accountId).Length, "Recovery sweeps the validator instance");
        Assert.IsTrue(h.OwnerOnly(accountId), "The latch is monotonic across recovery");

        // The recovered account executes again on the built-in route with the new custody ...
        Assert.IsTrue(h.ExecuteTransfer(accountId, newKey), "Execution stays available");
        // ... and the module model stays permanently closed, even after the sweep.
        TestException reinstall = Assert.ThrowsExactly<TestException>(
            () => h.Fx.ProposeConfiguration(
                h.Core, accountId, rotated,
                (object)h.Fx.InstallValidator(h.SessionKey, h.SessionCommand())));
        StringAssert.Contains(reinstall.Message, Permanent);
    }

    [TestMethod]
    public void OwnerOnlyRecovery_RejectsEveryModuleModelActionUpFront()
    {
        using P256SessionKey key = new();
        Harness h = new(key);
        UInt160 accountId = h.CreateAccount("owner-only-reject", (object)h.ElectOwnerOnly());

        object[][] modelActions =
        {
            // 1 = install
            h.Fx.InstallValidator(h.SessionKey, h.SessionCommand()),
            // 2 = uninstall
            new object[] { 2, (BigInteger)1 },
            // 3 = configure
            RuntimeFixture.ConfigureModule(1, h.SessionCommand()),
            // 4 = hook order
            RuntimeFixture.SetHookOrder(1),
            // 6 = rebind module code
            new object[] { 6, (BigInteger)1, new byte[32] },
            // 7 = threshold policy
            RuntimeFixture.SetThresholdPolicy(1, 1, new[] { BigInteger.One }, true)
        };

        foreach (object[] action in modelActions)
        {
            TestException rejected = Assert.ThrowsExactly<TestException>(
                () => h.Fx.ProposeConfiguration(h.Core, accountId, h.Custody, (object)action));
            StringAssert.Contains(rejected.Message, Permanent);
        }

        // Rejections happen before an intent is allocated, so nothing waits out the
        // 24h window only to fail at confirmation.
        Assert.AreEqual(0,
            ((Neo.VM.Types.Array)h.Fx.Call(h.Core, "getPendingConfigurationIntentIds", accountId)).Count,
            "A rejected proposal leaves no pending intent");
        Assert.AreEqual(0, h.HookIds(accountId).Length);
        Assert.AreEqual(0, h.ValidatorIds(accountId).Length);
    }

    [TestMethod]
    public void OwnerOnlyRecovery_IsMonotonicAndCannotBeCleared()
    {
        using P256SessionKey key = new();
        Harness h = new(key);
        UInt160 accountId = h.CreateAccount("owner-only-monotonic", (object)h.ElectOwnerOnly());

        // Re-electing with ownerOnly = false must not clear the earlier election.
        object[] rewrite = RuntimeFixture.SetRecoveryPolicy(Stranger, Timelock, ownerOnlyRecovery: false);
        BigInteger intentId = h.Fx.ProposeConfiguration(h.Core, accountId, h.Custody, (object)rewrite);
        h.Fx.AdvanceTime(TimeSpan.FromHours(24) + TimeSpan.FromMinutes(1));
        // Naming a new recovery authority requires that subject's witness at confirmation.
        h.Fx.SetSigners(h.Custody, Stranger);
        h.Fx.CallVoid(h.Core, "confirmConfiguration", accountId, intentId, new object[] { rewrite });
        Assert.IsTrue(h.OwnerOnly(accountId), "The latch survives a policy rewrite");
        Assert.AreEqual(Stranger, new UInt160(h.Fx.AccountControl(h.Core, accountId)[3].GetSpan()),
            "The unrelated recovery-authority change is applied");

        // Clearing the authority back to zero behaves the same way.
        h.Fx.ConfigureAfterTimelock(
            h.Core, accountId, h.Custody,
            (object)RuntimeFixture.SetRecoveryPolicy(UInt160.Zero, Timelock, ownerOnlyRecovery: false));
        Assert.IsTrue(h.OwnerOnly(accountId), "The latch is a one-way election");
    }

    [TestMethod]
    public void OwnerOnlyRecovery_DoesNotConstrainExecutionOrNonModelConfiguration()
    {
        using P256SessionKey key = new();
        Harness h = new(key);
        UInt160 accountId = h.CreateAccount("owner-only-open", (object)h.ElectOwnerOnly());

        // Non-model configuration still confirms after the 24h window.
        h.Fx.ConfigureAfterTimelock(h.Core, accountId, h.Custody,
            (object)RuntimeFixture.SetRecoveryPolicy(UInt160.Zero, Timelock));
        Assert.IsTrue(h.OwnerOnly(accountId));

        h.Fx.SetSigners(h.Custody);
        h.Fx.CallVoid(h.Core, "setMetadataUri", accountId, "ipfs://owner-only");
        Assert.AreEqual("ipfs://owner-only", h.Fx.Call(h.Core, "getMetadataUri", accountId).GetString());

        Assert.IsTrue(h.ExecuteTransfer(accountId, key), "The built-in route stays authorized");
        Assert.AreEqual(BigInteger.One, h.Fx.CurrentNonceSequence(h.Core, accountId, 0));
    }

    [TestMethod]
    public void OwnerOnlyRecovery_LatchSurvivesFreezeUnfreezeAndCustodyRotation()
    {
        using P256SessionKey key = new();
        Harness h = new(key);
        UInt160 accountId = h.CreateAccount("owner-only-freeze", (object)h.ElectOwnerOnly());

        h.Fx.SetSigners(h.Custody);
        h.Fx.CallVoid(h.Core, "freezeAccount", accountId);
        h.Fx.CallVoid(h.Core, "unfreezeAccount", accountId);
        Assert.AreEqual(BigInteger.Zero, h.Fx.AccountStatus(h.Core, accountId), "Active again");
        Assert.IsTrue(h.OwnerOnly(accountId), "Freeze/unfreeze does not touch the latch");

        // A recovery to a fresh custody inherits the permanent restriction.
        h.Fx.SetSigners(h.Custody, NewCustody);
        h.Fx.CallVoid(h.Core, "beginRecovery", accountId, NewCustody);
        h.Fx.AdvanceTime(TimeSpan.FromMilliseconds((long)Timelock));
        h.Fx.CallVoid(h.Core, "executeRecovery", accountId);
        Assert.AreEqual(NewCustody, h.Fx.AccountCustody(h.Core, accountId));
        Assert.IsTrue(h.OwnerOnly(accountId), "The new custody inherits the latch");

        TestException rejected = Assert.ThrowsExactly<TestException>(
            () => h.Fx.ProposeConfiguration(h.Core, accountId, NewCustody,
                (object)h.Fx.InstallValidator(h.SessionKey, h.SessionCommand())));
        StringAssert.Contains(rejected.Message, Permanent);
    }

    [TestMethod]
    public void OwnerOnlyRecovery_DoesNotChangePeerAccounts()
    {
        using P256SessionKey key = new();
        Harness h = new(key);
        UInt160 accountId = h.CreateAccount("owner-only-subject", (object)h.ElectOwnerOnly());

        // A peer account with the same core and a different custody is untouched.
        UInt160 peer = h.Fx.CreateAccount(h.Core, Stranger, "owner-only-peer",
            (object)h.Fx.InstallValidator(h.SessionKey, h.SessionCommand()));
        Assert.IsFalse(h.OwnerOnly(peer));
        Assert.AreEqual(1, h.ValidatorIds(peer).Length, "The peer may install modules");

        // The peer can still add a hook through the ordinary timelocked path.
        h.Fx.ConfigureAfterTimelock(h.Core, peer, Stranger,
            (object)h.Fx.InstallHook(h.Hook, "allowTarget", h.Target));
        Assert.AreEqual(1, h.HookIds(peer).Length);
        Assert.IsTrue(h.OwnerOnly(accountId), "The subject account is unaffected");
    }

    [TestMethod]
    public void OwnerOnlyRecovery_RejectsMalformedAndUnknownAccountIds()
    {
        using P256SessionKey key = new();
        Harness h = new(key);

        Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallBoolean(h.Core, "isOwnerOnlyRecovery", new byte[19]));
        Assert.ThrowsExactly<TestException>(
            () => h.Fx.CallBoolean(h.Core, "isOwnerOnlyRecovery", UInt160.Zero));

        // A well-formed id with no account state is reported as not latched (fail-closed read).
        Assert.IsFalse(h.Fx.CallBoolean(h.Core, "isOwnerOnlyRecovery", Stranger));
    }
}
