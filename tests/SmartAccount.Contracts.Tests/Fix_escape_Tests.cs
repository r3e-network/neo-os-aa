using System;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Regression tests for the v4 escape hatch (spec §10): <c>beginRecovery</c> /
/// <c>executeRecovery</c> replace the retired v3
/// <c>initiateEscape</c>/<c>finalizeEscape</c> pair, and the finalize step no longer
/// rotates a verifier or calls any plugin. Recovery must hand the custody a clean
/// account instead of a half-swapped configuration: the callback-free sweep removes
/// every installed module instance, the hook order, the pending intents, the
/// threshold policies, the message-subject set, the metadata URI, the migration
/// state and the nonce channels, while the moduleId allocator is preserved so ids
/// are never reused. These tests pin that sweep, the two-stage authorization, the
/// timelock, the epoch-staleness guard and cancellation.
/// </summary>
[TestClass]
public class Fix_Escape_Tests
{
    private static readonly UInt160 NewCustody =
        UInt160.Parse("0x2222222222222222222222222222222222222222");

    private static readonly UInt160 Stranger =
        UInt160.Parse("0x9999999999999999999999999999999999999999");

    private static readonly UInt160 Target =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly TimeSpan RecoveryWindow =
        TimeSpan.FromMilliseconds((long)RuntimeFixture.MinRecoveryTimelockMs);

    private sealed class EscapeHarness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Core { get; }

        private int _registrations;

        public EscapeHarness()
        {
            Core = Fx.Deploy("SmartAccount");
        }

        /// <summary>
        /// Registers a v4 account. A custody key is used so the account can also run
        /// built-in operations; the caller supplies the initial action set.
        /// </summary>
        public UInt160 RegisterAccount(UInt160 custody, params object[] actions)
        {
            _registrations += 1;
            return Fx.CreateAccount(Core, custody, "escape-" + _registrations, actions);
        }

        public Neo.VM.Types.Array RecoveryStatus(UInt160 accountId) =>
            (Neo.VM.Types.Array)Fx.Call(Core, "getRecoveryStatus", accountId);

        public BigInteger[] ValidatorIds(UInt160 accountId) =>
            Fx.ModuleIds(Core, accountId, RuntimeFixture.ModuleTypeNameValidator);

        public BigInteger[] HookIds(UInt160 accountId) =>
            Fx.ModuleIds(Core, accountId, RuntimeFixture.ModuleTypeNameHook);

        public void Begin(UInt160 accountId, UInt160 newCustody, params UInt160[] signers)
        {
            Fx.SetSigners(signers.Length == 0 ? new[] { newCustody } : signers);
            Fx.CallVoid(Core, "beginRecovery", accountId, newCustody);
        }
    }

    // ============================================================================
    // The sweep: a recovered account is handed over clean.
    // ============================================================================

    [TestMethod]
    public void ExecuteRecovery_SweepsTheModuleModelAndRotatesCustody()
    {
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        EscapeHarness h = new();
        RuntimeFixture fx = h.Fx;
        UInt160 sessionKey = fx.Deploy("validators/SessionKeyValidator", h.Core.ToArray());
        UInt160 hook = fx.Deploy("hooks/WhitelistHook", h.Core.ToArray());

        object?[] command =
        {
            "setSessionKey", key.CompressedPublicKey, Target, "transfer",
            fx.Now() + 3_600_000, (BigInteger)0, "escape suite"
        };
        UInt160 accountId = h.RegisterAccount(
            custody,
            fx.InstallValidator(sessionKey, command),
            fx.InstallHook(hook, "allowTarget", Target));

        // Preconditions: a validator instance, a hook in the core hook order and metadata.
        BigInteger validatorId = fx.FindModuleId(
            h.Core, accountId, RuntimeFixture.ModuleTypeNameValidator, sessionKey);
        Assert.AreNotEqual(BigInteger.Zero, validatorId, "Precondition: validator installed");
        Assert.AreEqual(1, fx.HookOrderIds(h.Core, accountId).Length, "Precondition: hook in the order");
        fx.SetSigners(custody);
        fx.CallVoid(h.Core, "setMetadataUri", accountId, "ipfs://escape");
        BigInteger epochBefore = fx.AccountAuthorityEpoch(h.Core, accountId);

        h.Begin(accountId, NewCustody, custody, NewCustody);
        Neo.VM.Types.Array pending = h.RecoveryStatus(accountId);
        Assert.AreEqual(5, pending.Count, "A pending recovery is observable");
        Assert.IsTrue(pending[0].GetBoolean());
        Assert.AreEqual(NewCustody, new UInt160(pending[4].GetSpan()));
        Assert.IsTrue(pending[2].GetInteger() > fx.Now(), "The core record carries its own maturity");

        // The core timelock is enforced independently of the caller's diligence.
        TestException early = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(h.Core, "executeRecovery", accountId));
        StringAssert.Contains(early.Message, "SA_RECOVERY_LOCKED");
        Assert.AreEqual(NewCustody, new UInt160(h.RecoveryStatus(accountId)[4].GetSpan()),
            "A premature execute must not consume the record");

        fx.AdvanceTime(RecoveryWindow);
        // Settlement is permissionless once matured: no old plugin is consulted.
        fx.SetSigners(Stranger);
        fx.CallVoid(h.Core, "executeRecovery", accountId);
        Neo.VM.Types.Array executed = fx.SingleNotificationState(h.Core, "RecoveryExecuted");
        Assert.AreEqual(accountId, new UInt160(executed[0].GetSpan()));
        Neo.VM.Types.Array finalized = fx.SingleNotificationState(h.Core, "EscapeFinalized");
        Assert.AreEqual(NewCustody, new UInt160(finalized[1].GetSpan()), "The legacy escape feed mirrors recovery");

        Assert.AreEqual(NewCustody, fx.AccountCustody(h.Core, accountId), "Custody rotated on the core");
        Assert.AreEqual(0, h.ValidatorIds(accountId).Length, "Every validator instance is swept");
        Assert.AreEqual(0, h.HookIds(accountId).Length, "Every hook instance is swept");
        Assert.AreEqual(0, fx.HookOrderIds(h.Core, accountId).Length, "The hook order is dropped");
        Assert.AreEqual(string.Empty, fx.Call(h.Core, "getMetadataUri", accountId).GetString(), "Metadata is dropped");
        Assert.AreEqual(0, h.RecoveryStatus(accountId).Count, "The record is consumed");
        Assert.AreEqual(BigInteger.Zero, fx.AccountStatus(h.Core, accountId), "The account is Active");
        Assert.IsTrue(fx.AccountDefaultOperationAuthorization(h.Core, accountId),
            "Recovery re-enables the built-in operation route");
        Assert.IsTrue(fx.AccountControl(h.Core, accountId)[8].GetBoolean(),
            "Recovery re-enables the default message route");
        Assert.AreEqual(epochBefore + 1, fx.AccountAuthorityEpoch(h.Core, accountId),
            "Recovery advances the authority epoch exactly once");
        Assert.AreEqual(0, ((Neo.VM.Types.Array)fx.Call(h.Core, "getPendingConfigurationIntentIds", accountId)).Count,
            "No intent survives the sweep");

        // The moduleId allocator survives on purpose: ids are never reused.
        UInt160 second = fx.Deploy("validators/SessionKeyValidator", h.Core.ToArray());
        fx.ConfigureAfterTimelock(h.Core, accountId, NewCustody, (object)fx.InstallValidator(second));
        BigInteger secondId = fx.FindModuleId(
            h.Core, accountId, RuntimeFixture.ModuleTypeNameValidator, second);
        Assert.IsTrue(secondId > validatorId, "A post-recovery install must not reuse a swept module id");
    }

    [TestMethod]
    public void ExecuteRecovery_WithZeroCustody_ClearsTheAccountAndKeepsTheCustody()
    {
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        EscapeHarness h = new();
        RuntimeFixture fx = h.Fx;
        UInt160 hook = fx.Deploy("hooks/WhitelistHook", h.Core.ToArray());
        UInt160 accountId = h.RegisterAccount(custody, (object)fx.InstallHook(hook, "allowTarget", Target));

        h.Begin(accountId, UInt160.Zero, custody);
        Assert.AreEqual(UInt160.Zero, new UInt160(h.RecoveryStatus(accountId)[4].GetSpan()),
            "The record names no replacement custody");
        fx.AdvanceTime(RecoveryWindow);
        fx.CallVoid(h.Core, "executeRecovery", accountId);

        Assert.AreEqual(custody, fx.AccountCustody(h.Core, accountId), "Custody is kept when none is named");
        Assert.AreEqual(0, h.HookIds(accountId).Length, "The sweep still runs");
        Assert.AreEqual(0, fx.HookOrderIds(h.Core, accountId).Length);
        Assert.AreEqual(0, h.RecoveryStatus(accountId).Count);
    }

    // ============================================================================
    // Authorization: custody or the recorded recovery authority, plus the new
    // custody when one is named.
    // ============================================================================

    [TestMethod]
    public void BeginRecovery_RequiresCustodyOrRecoveryAuthority()
    {
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        EscapeHarness h = new();
        RuntimeFixture fx = h.Fx;
        UInt160 accountId = h.RegisterAccount(custody);

        fx.SetSigners(Stranger);
        TestException unauthorized = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(h.Core, "beginRecovery", accountId, NewCustody));
        StringAssert.Contains(unauthorized.Message, "SA_UNAUTHORIZED");
        Assert.AreEqual(0, h.RecoveryStatus(accountId).Count, "A refused request writes no record");
    }

    [TestMethod]
    public void BeginRecovery_RequiresTheNewCustodysWitness()
    {
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        EscapeHarness h = new();
        RuntimeFixture fx = h.Fx;
        UInt160 accountId = h.RegisterAccount(custody);

        // Naming a replacement custody is itself a custody change: that subject must sign.
        fx.SetSigners(custody);
        TestException unauthorized = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(h.Core, "beginRecovery", accountId, NewCustody));
        StringAssert.Contains(unauthorized.Message, "SA_UNAUTHORIZED");
        Assert.AreEqual(0, h.RecoveryStatus(accountId).Count);

        // With both witnesses the same request is accepted.
        h.Begin(accountId, NewCustody, custody, NewCustody);
        Assert.IsTrue(h.RecoveryStatus(accountId).Count > 0, "The request is recorded");
    }

    [TestMethod]
    public void BeginRecovery_RejectsASecondRecordWhileOneIsPending()
    {
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        EscapeHarness h = new();
        RuntimeFixture fx = h.Fx;
        UInt160 accountId = h.RegisterAccount(custody);

        h.Begin(accountId, NewCustody, custody, NewCustody);
        BigInteger initiatedAt = h.RecoveryStatus(accountId)[1].GetInteger();

        fx.AdvanceTime(TimeSpan.FromHours(1));
        TestException repeated = Assert.ThrowsExactly<TestException>(
            () => h.Begin(accountId, NewCustody, custody, NewCustody));
        StringAssert.Contains(repeated.Message, "SA_RECOVERY_PENDING");
        Assert.AreEqual(initiatedAt, h.RecoveryStatus(accountId)[1].GetInteger(),
            "A pending record is never restarted");
    }

    // ============================================================================
    // Guards: no record, epoch staleness, cancellation and re-arming.
    // ============================================================================

    [TestMethod]
    public void ExecuteRecovery_WithoutInitiation_Faults()
    {
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        EscapeHarness h = new();
        RuntimeFixture fx = h.Fx;
        UInt160 accountId = h.RegisterAccount(custody);

        TestException notInitiated = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(h.Core, "executeRecovery", accountId));
        StringAssert.Contains(notInitiated.Message, "SA_RECOVERY_PENDING");
        Assert.AreEqual(custody, fx.AccountCustody(h.Core, accountId));
    }

    [TestMethod]
    public void ExecuteRecovery_AfterAFreeze_FaultsOnTheStaleEpoch()
    {
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        EscapeHarness h = new();
        RuntimeFixture fx = h.Fx;
        UInt160 accountId = h.RegisterAccount(custody);

        h.Begin(accountId, NewCustody, custody, NewCustody);
        // Freezing advances the authority epoch, which is bound into the record: the
        // pre-freeze approval can never settle afterwards.
        fx.SetSigners(custody);
        fx.CallVoid(h.Core, "freezeAccount", accountId);

        fx.AdvanceTime(RecoveryWindow);
        TestException stale = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(h.Core, "executeRecovery", accountId));
        StringAssert.Contains(stale.Message, "SA_EPOCH_STALE");
        Assert.AreEqual(custody, fx.AccountCustody(h.Core, accountId), "A stale record cannot rotate custody");
        Assert.AreEqual(NewCustody, new UInt160(h.RecoveryStatus(accountId)[4].GetSpan()),
            "The stale record is left for an explicit cancellation");

        // Cancellation is reachable while frozen and re-arms the flow.
        fx.SetSigners(custody);
        fx.CallVoid(h.Core, "cancelRecovery", accountId);
        Neo.VM.Types.Array cancelled = fx.SingleNotificationState(h.Core, "RecoveryCancelled");
        Assert.AreEqual(accountId, new UInt160(cancelled[0].GetSpan()));
        Assert.AreEqual(0, h.RecoveryStatus(accountId).Count);
    }

    [TestMethod]
    public void CancelRecovery_ClearsTheRecordAndKeepsEverythingElse()
    {
        using P256SessionKey key = new();
        UInt160 custody = RuntimeFixture.CustodyOf(key);
        EscapeHarness h = new();
        RuntimeFixture fx = h.Fx;
        UInt160 hook = fx.Deploy("hooks/WhitelistHook", h.Core.ToArray());
        UInt160 accountId = h.RegisterAccount(custody, (object)fx.InstallHook(hook, "allowTarget", Target));

        h.Begin(accountId, NewCustody, custody, NewCustody);
        fx.AdvanceTime(TimeSpan.FromHours(1));
        fx.SetSigners(custody);
        fx.CallVoid(h.Core, "cancelRecovery", accountId);

        Assert.AreEqual(0, h.RecoveryStatus(accountId).Count, "Cancellation consumes the record");
        Assert.AreEqual(custody, fx.AccountCustody(h.Core, accountId));
        Assert.AreEqual(1, h.HookIds(accountId).Length, "Cancellation sweeps nothing");
        Assert.AreEqual(1, fx.HookOrderIds(h.Core, accountId).Length);

        TestException cancelled = Assert.ThrowsExactly<TestException>(
            () => fx.CallVoid(h.Core, "cancelRecovery", accountId));
        StringAssert.Contains(cancelled.Message, "SA_RECOVERY_PENDING");

        // The old record is gone, so a fresh request starts a fresh timelock.
        BigInteger now = fx.Now();
        h.Begin(accountId, NewCustody, custody, NewCustody);
        Assert.AreEqual(now, h.RecoveryStatus(accountId)[1].GetInteger());
    }
}
