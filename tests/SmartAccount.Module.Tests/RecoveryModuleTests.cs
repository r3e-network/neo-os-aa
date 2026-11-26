using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;

namespace SmartAccount.Module.Tests;

/// <summary>
/// RecoveryModule owns the guardian roster, the recovery authority, the 7–90 day
/// timelock and the pending request. The native core stores no recovery policy;
/// the only native landing is <c>resetAccount</c>, reachable by the account's
/// current, code-bound recovery seat. These tests prove the begin / cancel /
/// status / execute machine and its refusal modes.
/// </summary>
[TestClass]
public class RecoveryModuleTests
{
    private const long MinTimelock = 7L * 24 * 60 * 60 * 1000;
    private const long MaxTimelock = 90L * 24 * 60 * 60 * 1000;

    private static readonly UInt160 Custody = UInt160.Parse("0x1111111111111111111111111111111111111111");
    private static readonly UInt160 NewCustody = UInt160.Parse("0x2222222222222222222222222222222222222222");
    private static readonly UInt160 GuardianA = UInt160.Parse("0x4444444444444444444444444444444444444444");
    private static readonly UInt160 GuardianB = UInt160.Parse("0x5555555555555555555555555555555555555555");
    private static readonly UInt160 Authority = UInt160.Parse("0x6666666666666666666666666666666666666666");
    private static readonly UInt160 Stranger = UInt160.Parse("0x3333333333333333333333333333333333333333");

    private ModuleHarness _h = null!;
    private UInt160 _account = UInt160.Zero;
    private BigInteger _moduleId;

    [TestInitialize]
    public void SetUp()
    {
        _h = new ModuleHarness();
        _account = _h.CreateAccount("recovery", Custody);
        _moduleId = _h.Install(_account, "RecoveryModule", 5);
        Configure(Guardians(GuardianA, true), 1, MinTimelock);
    }

    [TestCleanup]
    public void TearDown() => _h.Dispose();

    private UInt160 Recovery => _h.Contract("RecoveryModule");

    private static object[] Guardians(UInt160 guardian, bool two)
    {
        if (!two) return new object[] { guardian };
        return new object[] { guardian, GuardianB };
    }

    private void Configure(object[] guardians, int threshold, long timelock, UInt160? authority = null)
    {
        object[] data = authority is null
            ? new object[] { guardians, (BigInteger)threshold, (BigInteger)timelock }
            : new object[] { guardians, (BigInteger)threshold, (BigInteger)timelock, authority };
        _h.Configure(_account, _moduleId, data);
    }

    private BigInteger Begin(UInt160 newCustody)
    {
        _h.SetSigners(Custody, newCustody);
        return _h.CallInteger(Recovery, "beginRecovery", _account, newCustody);
    }

    private void Execute()
    {
        _h.SetSigners(Stranger);
        _h.CallVoid(Recovery, "executeRecovery", _account);
    }

    private Neo.VM.Types.Array Status() =>
        (Neo.VM.Types.Array)_h.Call(Recovery, "getRecoveryStatus", _account);

    private Neo.VM.Types.Array Policy() =>
        (Neo.VM.Types.Array)_h.Call(Recovery, "getRecoveryPolicySnapshot", _account);

    [TestMethod]
    public void Configure_StoresPolicyAndTheSevenToNinetyDayBand()
    {
        Configure(Guardians(GuardianA, true), 2, MinTimelock, Authority);

        Neo.VM.Types.Array policy = Policy();
        Assert.AreEqual(6, policy.Count, "guardians, threshold, timelock, authority, revision, digest");
        Assert.AreEqual(2, ((Neo.VM.Types.Array)policy[0]).Count, "two guardians");
        Assert.AreEqual(2, (int)policy[1].GetInteger(), "threshold");
        Assert.AreEqual(MinTimelock, (long)policy[2].GetInteger(), "the 7 day floor is accepted");
        Assert.AreEqual(2, (int)policy[4].GetInteger(), "the second policy write bumps the revision");
        Assert.AreEqual(32, policy[5].GetSpan().Length, "policy digest");

        ModuleHarness.AssertFault("SA_MODULE_LIMIT_THRESHOLD", () => Configure(Guardians(GuardianA, true), 3, MinTimelock));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED", () => Configure(Guardians(GuardianA, true), 1, MinTimelock - 1));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED", () => Configure(Guardians(GuardianA, true), 1, MaxTimelock + 1));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED",
            () => Configure(new object[] { GuardianA, GuardianA }, 1, MinTimelock));
        ModuleHarness.AssertFault("SA_MODULE_LIMIT_MEMBERS", () => Configure(new object[]
        {
            GuardianA, GuardianB, UInt160.Parse("0x7777777777777777777777777777777777777777"),
            UInt160.Parse("0x8888888888888888888888888888888888888888"),
            UInt160.Parse("0x9999999999999999999999999999999999999999"),
            UInt160.Parse("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            UInt160.Parse("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
            UInt160.Parse("0xcccccccccccccccccccccccccccccccccccccccc"),
            UInt160.Parse("0xdddddddddddddddddddddddddddddddddddddddd"),
            UInt160.Parse("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"),
            UInt160.Parse("0xffffffffffffffffffffffffffffffffffffffff"),
        }, 1, MinTimelock));

        // 90 days is inside the band.
        Configure(Guardians(GuardianA, true), 1, MaxTimelock);
        Assert.AreEqual(MaxTimelock, (long)Policy()[2].GetInteger(), "the 90 day ceiling is accepted");
    }

    [TestMethod]
    public void Configure_IsOnlyReachableThroughTheCoreConfigurationFrame()
    {
        object[] data = new object[] { new object[] { GuardianA }, (BigInteger)1, (BigInteger)MinTimelock };
        _h.SetSigners(_h.Owner);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED", () => _h.CallVoid(Recovery, "configure",
            _account, _moduleId, (BigInteger)5, data));
    }

    [TestMethod]
    public void Begin_PinsTimelockEpochNonceAndPolicyDigest()
    {
        BigInteger before = _h.Now();
        BigInteger nonce = Begin(NewCustody);

        Neo.VM.Types.Array status = Status();
        Assert.AreEqual(12, status.Count, "twelve-field request record");
        Assert.AreEqual(nonce, status[0].GetInteger(), "nonce");
        Assert.AreEqual(before, status[2].GetInteger(), "startedAt");
        Assert.AreEqual(before + MinTimelock, status[3].GetInteger(), "executableAt is start + policy timelock");
        Assert.AreEqual(1, (int)status[4].GetInteger(), "pending");
        Assert.AreEqual(NewCustody, (UInt160)Neo.SmartContract.Testing.Extensions.TestExtensions
            .ConvertTo(status[5], typeof(UInt160))!, "the approved custodian");
        Assert.AreEqual(_h.Epoch(_account), status[6].GetInteger(), "epoch commitment");
        Assert.AreEqual(_h.ConfigurationNonce(_account), status[7].GetInteger(), "configuration-nonce commitment");
        Assert.AreEqual(32, status[8].GetSpan().Length, "policy digest commitment");
        Assert.AreEqual(1, (int)status[9].GetInteger(), "policy revision commitment");
    }

    [TestMethod]
    public void Begin_AcceptsTheGuardianQuorum()
    {
        Configure(Guardians(GuardianA, true), 2, MinTimelock);

        _h.SetSigners(GuardianA);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED", () => _h.CallVoid(Recovery, "beginRecovery", _account, NewCustody));

        _h.SetSigners(GuardianA, GuardianB, NewCustody);
        Assert.AreEqual(BigInteger.One, _h.CallInteger(Recovery, "beginRecovery", _account, NewCustody),
            "two of two guardians start the request");
    }

    [TestMethod]
    public void Begin_AcceptsTheConfiguredAuthority()
    {
        Configure(Guardians(GuardianA, true), 2, MinTimelock, Authority);
        _h.SetSigners(Authority, NewCustody);
        Assert.AreEqual(BigInteger.One, _h.CallInteger(Recovery, "beginRecovery", _account, NewCustody),
            "the authority named by policy needs no guardian, but the new custodian still consents");
    }

    [TestMethod]
    public void Begin_RequiresTheNewCustodianConsent()
    {
        _h.SetSigners(Custody);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED",
            () => _h.CallVoid(Recovery, "beginRecovery", _account, NewCustody));
    }

    [TestMethod]
    public void Begin_RefusesAStrangerAndASecondPendingRequest()
    {
        _h.SetSigners(Stranger);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED",
            () => _h.CallVoid(Recovery, "beginRecovery", _account, NewCustody));

        Begin(NewCustody);
        _h.SetSigners(Custody, NewCustody);
        ModuleHarness.AssertFault("SA_RECOVERY_PENDING",
            () => _h.CallVoid(Recovery, "beginRecovery", _account, NewCustody));
    }

    [TestMethod]
    public void Execute_IsLockedUntilTheTimelockElapses()
    {
        Begin(NewCustody);
        _h.AdvanceTime(TimeSpan.FromDays(7) - TimeSpan.FromMinutes(1));
        ModuleHarness.AssertFault("SA_RECOVERY_LOCKED", Execute);
    }

    [TestMethod]
    public void Execute_LandsThroughTheNativeResetAndRetiresTheInstance()
    {
        Begin(NewCustody);
        BigInteger epochBefore = _h.Epoch(_account);
        _h.AdvanceTime(TimeSpan.FromDays(7) + TimeSpan.FromMinutes(1));

        Execute();

        Assert.AreEqual(NewCustody, _h.Custody(_account), "the reset re-landed custody");
        Assert.AreEqual(epochBefore + 1, _h.Epoch(_account), "the reset advanced the authority epoch");
        Assert.AreEqual(BigInteger.One, _h.CallInteger(_h.Core, "getResetCount", _account), "one native reset");
        Assert.AreEqual(0, Status().Count, "the pending record is unreachable after the reset");
        Assert.AreEqual(BigInteger.Zero, _h.CallInteger(Recovery, "getExecutedRecoveryNonce", _account),
            "the old instance identity no longer resolves");
        Assert.AreEqual(0, Policy().Count, "the policy lands nowhere in native state");
    }

    [TestMethod]
    public void Execute_RefusesAStaleAuthorityEpoch()
    {
        Begin(NewCustody);
        _h.SetEpoch(_account, _h.Epoch(_account) + 1);
        _h.AdvanceTime(TimeSpan.FromDays(7) + TimeSpan.FromMinutes(1));

        ModuleHarness.AssertFault("SA_EPOCH_STALE", Execute);
    }

    [TestMethod]
    public void Execute_RefusesAChangedConfigurationNonce()
    {
        Begin(NewCustody);
        _h.SetConfigurationNonce(_account, _h.ConfigurationNonce(_account) + 1);
        _h.AdvanceTime(TimeSpan.FromDays(7) + TimeSpan.FromMinutes(1));

        ModuleHarness.AssertFault("SA_CONFIGURATION_NONCE_STALE", Execute);
    }

    [TestMethod]
    public void Execute_RefusesAChangedPolicy()
    {
        Begin(NewCustody);
        Configure(Guardians(GuardianA, false), 1, MinTimelock + 1000);
        _h.AdvanceTime(TimeSpan.FromDays(7) + TimeSpan.FromMinutes(1));

        ModuleHarness.AssertFault("SA_EPOCH_STALE", Execute);
    }

    [TestMethod]
    public void Cancel_WithdrawsTheRequestAndNeedsTheSameAuthority()
    {
        Begin(NewCustody);

        _h.SetSigners(Stranger);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED", () => _h.CallVoid(Recovery, "cancelRecovery", _account));

        _h.SetSigners(Custody);
        _h.CallVoid(Recovery, "cancelRecovery", _account);
        Assert.AreEqual(0, Status().Count, "no pending request remains");

        _h.AdvanceTime(TimeSpan.FromDays(8));
        ModuleHarness.AssertFault("SA_RECOVERY_PENDING", Execute);
    }

    [TestMethod]
    public void Execute_RefusesACrossAccountRecord()
    {
        UInt160 other = _h.CreateAccount("recovery-other",
            UInt160.Parse("0x1212121212121212121212121212121212121212"));
        Begin(NewCustody);
        _h.AdvanceTime(TimeSpan.FromDays(7) + TimeSpan.FromMinutes(1));

        _h.SetSigners(Stranger);
        ModuleHarness.AssertFault("SA_MODULE_NOT_INSTALLED",
            () => _h.CallVoid(Recovery, "executeRecovery", other));
    }

    [TestMethod]
    public void Core_RefusesAResetFromAnyoneButTheInstalledRecoverySeat()
    {
        _h.SetSigners(Custody);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED",
            () => _h.CallVoid(_h.Core, "resetAccount", _account, NewCustody));

        Assert.AreEqual(Custody, _h.Custody(_account), "no bypass re-landed custody");
    }

    [TestMethod]
    public void Uninstall_ClearsThePolicyAndReleasesTheNamespace()
    {
        Begin(NewCustody);
        _h.SetSigners(_h.Owner);
        _h.CallVoid(_h.Core, "removeModule", _account, _moduleId, new object[0]);

        Assert.AreEqual(0, Policy().Count, "no policy survives uninstall");
        Assert.AreEqual(0, Status().Count, "no request survives uninstall");

        // The released namespace is not adoptable by the next instance: the old
        // module id no longer names a recovery seat.
        _h.SetSigners(Custody, NewCustody);
        ModuleHarness.AssertFault("SA_MODULE_NOT_INSTALLED",
            () => _h.CallVoid(Recovery, "beginRecovery", _account, NewCustody));
    }

    [TestMethod]
    public void InstalledRecovery_ReportsItsProfileAndSeat()
    {
        Assert.AreEqual(_moduleId, _h.ModuleIdOf(_account, "recovery", Recovery));
        Assert.AreEqual(new BigInteger(5), _h.DescriptorInteger(_account, _moduleId, 1), "module type 5 is recorded");
        string profile = System.Text.Encoding.UTF8.GetString(_h.CallBytes(Recovery, "getModuleProfile"));
        StringAssert.Contains(profile, "\"moduleType\":\"recovery\"");
        StringAssert.Contains(profile, "\"callbacks\":[]");
    }
}
