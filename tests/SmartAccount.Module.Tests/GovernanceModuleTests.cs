using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;

namespace SmartAccount.Module.Tests;

/// <summary>
/// GovernanceModule owns the 24 h review delay, the 7 d confirmation window,
/// the action commitment, the read-set conflicts and the epoch /
/// configuration-nonce commitment. These tests drive the deployed module
/// through a core double that reproduces the v4.1 seams.
/// </summary>
[TestClass]
public class GovernanceModuleTests
{
    private const int ActionInstallModule = 1;
    private const int ActionUninstallModule = 2;
    private const int ActionSetBuiltinAuthorization = 5;
    private const int ActionUnfreeze = 11;

    private static readonly UInt160 Custody = UInt160.Parse("0x1111111111111111111111111111111111111111");
    private static readonly UInt160 Stranger = UInt160.Parse("0x3333333333333333333333333333333333333333");
    private static readonly UInt160 NewCustody = UInt160.Parse("0x2222222222222222222222222222222222222222");

    private ModuleHarness _h = null!;
    private UInt160 _account = UInt160.Zero;
    private BigInteger _moduleId;

    [TestInitialize]
    public void SetUp()
    {
        _h = new ModuleHarness();
        _account = _h.CreateAccount("governance", Custody);
        _moduleId = _h.Install(_account, "GovernanceModule", 1);
    }

    [TestCleanup]
    public void TearDown() => _h.Dispose();

    private UInt160 Governance => _h.Contract("GovernanceModule");

    private static object[] List(params object[][] items)
    {
        object[] result = new object[items.Length];
        for (int i = 0; i < items.Length; i++) result[i] = items[i];
        return result;
    }

    private static object[] BuiltinAction(bool operation, bool message) =>
        new object[] { (BigInteger)ActionSetBuiltinAuthorization, operation, message };

    private static object[] UninstallAction(int id) =>
        new object[] { (BigInteger)ActionUninstallModule, (BigInteger)id, new object[0] };

    private BigInteger Propose(object[] actions, object[]? readSet = null)
    {
        _h.SetSigners(Custody);
        return _h.CallInteger(Governance, "proposeConfiguration", _account, actions, readSet ?? new object[0]);
    }

    private void Confirm(BigInteger intentId, object[] actions)
    {
        _h.SetSigners(Custody);
        _h.CallVoid(Governance, "confirmConfiguration", _account, intentId, actions);
    }

    private void Mature() => _h.AdvanceTime(TimeSpan.FromHours(24) + TimeSpan.FromMinutes(1));

    [TestMethod]
    public void Proposal_PinsKindTimingEpochNonceAndDigest()
    {
        object[] actions = List(BuiltinAction(true, false));
        BigInteger before = _h.Now();
        BigInteger intentId = Propose(actions, new object[] { new byte[] { 0x41 } });

        Neo.VM.Types.Array view = (Neo.VM.Types.Array)_h.Call(Governance, "getPendingConfiguration",
            _account, intentId);
        Assert.AreEqual(intentId, view[0].GetInteger(), "intent id");
        Assert.AreEqual("configure", view[1].GetString(), "kind");
        Assert.AreEqual(before, view[2].GetInteger(), "proposedAt");
        Assert.AreEqual(before + 24L * 60 * 60 * 1000, view[3].GetInteger(), "matureAt is exactly 24 h");
        Assert.AreEqual(before + 24L * 60 * 60 * 1000 + 7L * 24 * 60 * 60 * 1000, view[4].GetInteger(),
            "expiry is mature + 7 d");
        Assert.AreEqual(_h.Epoch(_account), view[5].GetInteger(), "epoch commitment");
        Assert.AreEqual(_h.ConfigurationNonce(_account), view[6].GetInteger(), "nonce commitment");
        Assert.AreEqual(32, view[7].GetSpan().Length, "commitment digest is 32 bytes");
        Assert.AreEqual(1, (int)view[8].GetInteger(), "action count");

        Assert.AreEqual(new BigInteger(24L * 60 * 60 * 1000), _h.CallInteger(Governance, "configurationMaturity"));
        Assert.AreEqual(new BigInteger(7L * 24 * 60 * 60 * 1000),
            _h.CallInteger(Governance, "configurationExpiryWindow"));
    }

    [TestMethod]
    public void Proposal_RequiresAccountAdministration()
    {
        _h.SetSigners(Stranger);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED",
            () => _h.CallVoid(Governance, "proposeConfiguration", _account,
                List(BuiltinAction(true, false)), new object[0]));
    }

    /// <summary>
    /// The module side keeps one administration witness, the custodian. A pinned
    /// required validator is not a term of the module gate (the core dropped that
    /// term from its v4.1 landing rule), so it neither blocks nor substitutes
    /// for the custody witness on propose or confirm.
    /// </summary>
    [TestMethod]
    public void ProposalAndConfirm_NeedCustodyRegardlessOfAPinnedRequiredValidator()
    {
        _h.CallVoid(_h.Core, "setRequiredValidator", _account, new BigInteger(7));
        Assert.AreEqual(new BigInteger(7), _h.AccountField(_account, 7), "the route is pinned");
        object[] actions = List(BuiltinAction(true, false));

        // The pin alone lends no authority: without the custody witness nothing is queued.
        _h.SetSigners(Stranger);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED",
            () => _h.CallVoid(Governance, "proposeConfiguration", _account, actions, new object[0]));
        Assert.AreEqual(0, ((Neo.VM.Types.Array)_h.Call(Governance, "getPendingConfigurationIntentIds",
            _account)).Count, "no intent was allocated");

        // And it does not block the custodian either.
        BigInteger intentId = Propose(actions);
        Assert.AreEqual(new BigInteger(1), intentId);
        Mature();

        _h.SetSigners(Stranger);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED",
            () => _h.CallVoid(Governance, "confirmConfiguration", _account, intentId, actions));
        Assert.AreEqual(1, ((Neo.VM.Types.Array)_h.Call(Governance, "getPendingConfigurationIntentIds",
            _account)).Count, "the refused confirmation leaves the intent pending");
        Assert.AreEqual(BigInteger.Zero, _h.CallInteger(_h.Core, "getAppliedActionCount", _account),
            "a confirmation without the custody witness lands nothing");

        _h.SetSigners(Custody);
        Confirm(intentId, actions);
        Assert.AreEqual(new BigInteger(1), _h.CallInteger(_h.Core, "getAppliedActionCount", _account),
            "the custody witness confirms under the pinned route");
    }

    [TestMethod]
    public void Confirm_IsRefusedBeforeTheDelayElapses()
    {
        object[] actions = List(BuiltinAction(true, false));
        BigInteger intentId = Propose(actions);

        _h.AdvanceTime(TimeSpan.FromHours(24) - TimeSpan.FromSeconds(1));
        ModuleHarness.AssertFault("SA_INTENT_IMMATURE", () => Confirm(intentId, actions));
    }

    [TestMethod]
    public void Confirm_LandsExactlyOnceAndAdvancesTheNonceOnce()
    {
        object[] actions = List(BuiltinAction(true, false));
        BigInteger intentId = Propose(actions);
        BigInteger nonceBefore = _h.ConfigurationNonce(_account);
        BigInteger epochBefore = _h.Epoch(_account);

        Mature();
        Confirm(intentId, actions);

        Assert.AreEqual(nonceBefore + 1, _h.ConfigurationNonce(_account), "one nonce advance");
        Assert.AreEqual(epochBefore, _h.Epoch(_account), "a configuration write keeps the epoch");
        Assert.AreEqual(1, (int)_h.CallInteger(_h.Core, "getAppliedActionCount", _account), "one landing");
        Assert.AreEqual(0, ((Neo.VM.Types.Array)_h.Call(Governance, "getPendingConfiguration", _account,
            intentId)).Count, "the intent is consumed");

        ModuleHarness.AssertFault("SA_INTENT_NOT_FOUND", () => Confirm(intentId, actions));
        Assert.AreEqual(nonceBefore + 1, _h.ConfigurationNonce(_account), "the replay did not land");
    }

    [TestMethod]
    public void Confirm_IsRefusedAfterTheWindowCloses()
    {
        object[] actions = List(BuiltinAction(true, false));
        BigInteger intentId = Propose(actions);
        _h.AdvanceTime(TimeSpan.FromHours(24) + TimeSpan.FromDays(7) + TimeSpan.FromSeconds(1));

        ModuleHarness.AssertFault("SA_INTENT_EXPIRED", () => Confirm(intentId, actions));
    }

    [TestMethod]
    public void ExpiredIntent_CanBeCleanedWithoutCustody()
    {
        BigInteger intentId = Propose(List(BuiltinAction(true, false)));
        _h.AdvanceTime(TimeSpan.FromHours(24) + TimeSpan.FromDays(7) + TimeSpan.FromSeconds(1));

        _h.SetSigners(Stranger);
        _h.CallVoid(Governance, "cancelConfiguration", _account, intentId);
        Assert.AreEqual(0, ((Neo.VM.Types.Array)_h.Call(Governance, "getPendingConfiguration", _account,
            intentId)).Count, "an expired intent is gone");
    }

    [TestMethod]
    public void Cancel_RequiresCustodyWhileTheWindowIsOpen()
    {
        BigInteger intentId = Propose(List(BuiltinAction(true, false)));
        _h.SetSigners(Stranger);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED",
            () => _h.CallVoid(Governance, "cancelConfiguration", _account, intentId));

        _h.SetSigners(Custody);
        _h.CallVoid(Governance, "cancelConfiguration", _account, intentId);
        ModuleHarness.AssertFault("SA_INTENT_NOT_FOUND",
            () => _h.CallVoid(Governance, "cancelConfiguration", _account, intentId));
    }

    [TestMethod]
    public void Confirm_RejectsAStaleConfigurationNonce()
    {
        object[] actions = List(BuiltinAction(true, false));
        BigInteger intentId = Propose(actions);
        _h.SetConfigurationNonce(_account, _h.ConfigurationNonce(_account) + 1);
        Mature();

        ModuleHarness.AssertFault("SA_CONFIGURATION_NONCE_STALE", () => Confirm(intentId, actions));
    }

    [TestMethod]
    public void Confirm_RejectsAStaleAuthorityEpoch()
    {
        object[] actions = List(BuiltinAction(true, false));
        BigInteger intentId = Propose(actions);
        _h.SetEpoch(_account, _h.Epoch(_account) + 1);
        Mature();

        ModuleHarness.AssertFault("SA_EPOCH_STALE", () => Confirm(intentId, actions));
    }

    [TestMethod]
    public void Confirm_RejectsDifferentActionBytes()
    {
        object[] actions = List(BuiltinAction(true, false));
        BigInteger intentId = Propose(actions);
        Mature();

        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED",
            () => Confirm(intentId, List(BuiltinAction(true, true))));
    }

    [TestMethod]
    public void Propose_RejectsADuplicateOrConflictingAction()
    {
        object[] actions = List(BuiltinAction(true, false));
        Propose(actions);

        ModuleHarness.AssertFault("SA_INTENT_CONFLICT", () => Propose(actions));
        ModuleHarness.AssertFault("SA_INTENT_CONFLICT",
            () => Propose(List(BuiltinAction(false, true))));

        // A disjoint resource is accepted: the conflict is per resource, not global.
        BigInteger second = Propose(List(UninstallAction(9)));
        Assert.AreEqual(2, second, "the disjoint intent is accepted");
    }

    [TestMethod]
    public void Propose_RejectsAReadSetConflict()
    {
        Propose(List(BuiltinAction(true, false)), new object[] { new byte[] { 0x10 } });
        ModuleHarness.AssertFault("SA_INTENT_CONFLICT",
            () => Propose(List(UninstallAction(9)), new object[] { new byte[] { 0x10 } }));
    }

    [TestMethod]
    public void Propose_RejectsAnOversizedActionList()
    {
        object[][] items = new object[17][];
        for (int i = 0; i < items.Length; i++) items[i] = UninstallAction(i + 1);
        ModuleHarness.AssertFault("SA_MODULE_LIMIT_ACTIONS", () => Propose(List(items)));
    }

    [TestMethod]
    public void Propose_RejectsMoreThanSixteenPendingIntents()
    {
        for (int i = 1; i <= 16; i++) Propose(List(UninstallAction(i)));
        ModuleHarness.AssertFault("SA_INTENT_LIMIT", () => Propose(List(UninstallAction(17))));
    }

    [TestMethod]
    public void Propose_RejectsAnActionThatIsNotACoreAction()
    {
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED",
            () => Propose(List(new object[] { (BigInteger)4, new object[] { (BigInteger)1 } })));
    }

    [TestMethod]
    public void Unfreeze_TravelsAloneAndLeavesFrozenImmediatelyWhenMature()
    {
        _h.SetStatus(_account, 1);
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED",
            () => Propose(List(new object[] { (BigInteger)ActionUnfreeze }, BuiltinAction(true, false))));

        _h.SetSigners(Custody);
        BigInteger intentId = _h.CallInteger(Governance, "unfreezeAccount", _account);
        BigInteger epochBefore = _h.Epoch(_account);

        // Freeze never blocks its own thaw, but the review delay still applies.
        ModuleHarness.AssertFault("SA_INTENT_IMMATURE",
            () => Confirm(intentId, List(new object[] { (BigInteger)ActionUnfreeze })));

        Mature();
        Confirm(intentId, List(new object[] { (BigInteger)ActionUnfreeze }));
        Assert.AreEqual(0, _h.Status(_account), "the account is active again");
        Assert.AreEqual(epochBefore + 1, _h.Epoch(_account), "the thaw advances the epoch");
    }

    [TestMethod]
    public void Propose_RejectsAConfigurationIntentWhileFrozen()
    {
        _h.SetStatus(_account, 1);
        ModuleHarness.AssertFault("SA_ACCOUNT_FROZEN", () => Propose(List(BuiltinAction(true, false))));
    }

    [TestMethod]
    public void Custody_CannotReachTheNativeLandingDirectly()
    {
        object[] actions = List(BuiltinAction(true, false));
        _h.SetSigners(Custody);

        ModuleHarness.AssertFault("SA_UNAUTHORIZED",
            () => _h.CallVoid(_h.Core, "applyConfigurationActions", _account, actions));
        ModuleHarness.AssertFault("SA_UNAUTHORIZED",
            () => _h.CallVoid(_h.Core, "setBuiltinAuthorization", _account, true, false));
        // The module never republishes the custody landing, so custody has no
        // module-side entry that could stand in for the core's own sink.
        CollectionAssert.DoesNotContain(ModuleHarness.ModuleAbiMethods("GovernanceModule").ToList(),
            "applyConfigurationActions", "the module never republishes the custody landing");
        CollectionAssert.DoesNotContain(ModuleHarness.ModuleAbiMethods("GovernanceModule").ToList(),
            "setBuiltinAuthorization", "the module never republishes the builtin authorization sink");

        Assert.AreEqual(0, (int)_h.CallInteger(_h.Core, "getAppliedActionCount", _account),
            "no bypass reached the landing");
    }

    [TestMethod]
    public void InstalledModules_ReportTheGovernanceProfile()
    {
        Assert.AreEqual(_moduleId, _h.ModuleIdOf(_account, "validator", Governance));
        Assert.AreEqual(BigInteger.One, _h.DescriptorInteger(_account, _moduleId, 13),
            "governance capability is published");
        string profile = System.Text.Encoding.UTF8.GetString(_h.CallBytes(Governance, "getModuleProfile"));
        StringAssert.Contains(profile, "\"governance\":true");
        StringAssert.Contains(profile, "\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"]");
    }

    [TestMethod]
    public void Uninstall_ClearsTheNamespaceAndReleasesTheSeat()
    {
        Propose(List(BuiltinAction(true, false)));
        _h.SetSigners(_h.Owner);
        _h.CallVoid(_h.Core, "removeModule", _account, _moduleId, new object[0]);

        Neo.VM.Types.Array pending = (Neo.VM.Types.Array)_h.Call(Governance, "getPendingConfigurationIntentIds",
            _account);
        Assert.AreEqual(0, pending.Count, "no intent survives uninstall");
        Assert.AreEqual(BigInteger.Zero, _h.ModuleIdOf(_account, "validator", Governance));

        // The released seat cannot be re-entered by the next instance without a
        // fresh governed install; proposing now fails closed.
        _h.SetSigners(Custody);
        ModuleHarness.AssertFault("SA_MODULE_NOT_INSTALLED", () => Propose(List(BuiltinAction(true, false))));
    }

    [TestMethod]
    public void NewCustodyNamesCannotUnfreezeWithoutTheCustodianWitness()
    {
        _h.SetStatus(_account, 1);
        _h.SetSigners(Custody);
        BigInteger intentId = _h.CallInteger(Governance, "unfreezeAccount", _account);
        Mature();

        _h.SetSigners(NewCustody);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED",
            () => _h.CallVoid(Governance, "confirmConfiguration", _account, intentId,
                List(new object[] { (BigInteger)ActionUnfreeze })));
    }

    [TestMethod]
    public void InstallAction_RequiresAWellFormedReviewedShape()
    {
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED", () => Propose(List(
            new object[]
            {
                (BigInteger)ActionInstallModule, (BigInteger)1, Governance, new byte[31], new object[0],
            })));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED", () => Propose(List(
            new object[]
            {
                (BigInteger)ActionInstallModule, (BigInteger)2, Governance, new byte[32], new object[0],
            })));
    }
}
