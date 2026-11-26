using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.VM.Types;
using NeoArray = Neo.VM.Types.Array;

namespace SmartAccount.Module.Tests;

/// <summary>
/// ThresholdPolicyModule owns the member roster, the per-member weights, the
/// quorum, the credential generation and the active flag. It never re-implements
/// a leaf check: every configured member is dispatched through the native
/// <c>validateMember</c> sink, the loop never short-circuits at the quorum, and
/// the core records approvals so completion reaches approved members only.
/// </summary>
[TestClass]
public class ThresholdPolicyModuleTests
{
    private static readonly UInt160 Custody = UInt160.Parse("0x1111111111111111111111111111111111111111");
    private static readonly UInt160 OtherCustody = UInt160.Parse("0x2222222222222222222222222222222222222222");

    private ModuleHarness _h = null!;
    private UInt160 _account = UInt160.Zero;
    private BigInteger _composite;
    private readonly BigInteger[] _leaf = new BigInteger[3];

    [TestInitialize]
    public void SetUp()
    {
        _h = new ModuleHarness();
        _account = _h.CreateAccount("threshold", Custody);
        _composite = _h.Install(_account, "ThresholdPolicyModule", 1);
        for (int i = 0; i < _leaf.Length; i++)
            _leaf[i] = _h.Install(_account, "SigningModule", 1, null,
                new ModuleHarness.Flags(Eligible: true));
        Configure(3, _leaf, new[] { 1, 1, 1 });
    }

    [TestCleanup]
    public void TearDown() => _h.Dispose();

    private UInt160 Composite => _h.Contract("ThresholdPolicyModule");

    private static readonly int[] Weights111 = { 1, 1, 1 };

    private void Configure(BigInteger threshold, BigInteger[] members, int[] weights)
    {
        object[] ids = new object[members.Length];
        for (int i = 0; i < members.Length; i++) ids[i] = members[i];
        object[] ws = new object[weights.Length];
        for (int i = 0; i < weights.Length; i++) ws[i] = (BigInteger)weights[i];
        _h.Configure(_account, _composite, new object[] { threshold, ids, ws });
    }

    private NeoArray Policy() =>
        (NeoArray)_h.Call(Composite, "getThresholdPolicy", _account, _composite);

    /// <summary>A fresh 32-byte operation digest; the core keys visits by digest.</summary>
    private static byte[] Digest(byte tag)
    {
        byte[] digest = new byte[32];
        for (int i = 0; i < digest.Length; i++) digest[i] = (byte)(tag + i);
        return digest;
    }

    /// <summary>Runs the composite exactly as the core would: phase 1 and the phase 8 leaf route live.</summary>
    private bool Approve(byte[] digest) =>
        _h.InvokeComposite(_account, _composite, "validateUserOp", _account, digest, new object[0]);

    /// <summary>
    /// Drops a leaf's threshold-member eligibility. The core re-checks it on
    /// every dispatch, so the next sink call for that member faults — the only
    /// trace a read-only validation chain can leave.
    /// </summary>
    private void StripLeafEligibility(params BigInteger[] leaves)
    {
        _h.SetSigners(_h.Owner);
        foreach (BigInteger leaf in leaves)
            _h.CallVoid(_h.Core, "setModuleFlags", _account, leaf, true, true, false, false, false, false);
    }

    private static BigInteger[] Ints(NeoArray array)
    {
        BigInteger[] values = new BigInteger[array.Count];
        for (int i = 0; i < array.Count; i++) values[i] = array[i].GetInteger();
        return values;
    }

    // ---- policy ----

    [TestMethod]
    public void Configure_StoresRosterWeightsQuorumGenerationAndRevision()
    {
        NeoArray policy = Policy();
        Assert.AreEqual(6, policy.Count, "threshold, members, weights, generation, active, revision");
        Assert.AreEqual(3, (int)policy[0].GetInteger(), "quorum");
        CollectionAssert.AreEqual(_leaf, Ints((NeoArray)policy[1]), "the roster is stored in order");
        CollectionAssert.AreEqual(new BigInteger[] { 1, 1, 1 }, Ints((NeoArray)policy[2]), "weights");
        Assert.AreEqual(1, (int)policy[3].GetInteger(), "the install credential generation");
        Assert.IsTrue(policy[4].GetBoolean(), "active by default");
        Assert.AreEqual(1, (int)policy[5].GetInteger(), "first revision");

        // The bound instance answers a snapshot that names itself first.
        NeoArray snapshot = (NeoArray)_h.Call(Composite, "getPolicySnapshot", _account);
        Assert.AreEqual(7, snapshot.Count, "moduleId plus the six policy fields");
        Assert.AreEqual(_composite, snapshot[0].GetInteger(), "the bound instance");
        CollectionAssert.AreEqual(_leaf, Ints((NeoArray)snapshot[2]), "the snapshot carries the roster");
    }

    [TestMethod]
    public void Configure_RefusesAMalformedRosterWeightOrQuorum()
    {
        ModuleHarness.AssertFault("SA_MODULE_LIMIT_THRESHOLD", () => Configure(0, _leaf, new[] { 1, 1, 1 }));
        ModuleHarness.AssertFault("SA_MODULE_LIMIT_THRESHOLD", () => Configure(4, _leaf, new[] { 1, 1, 1 }));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED", () => Configure(1, _leaf, new[] { 1, 1 }));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED", () => Configure(1, _leaf, new[] { 1, 1, 0 }));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED",
            () => Configure(1, new[] { _leaf[0], _leaf[0] }, new[] { 1, 1 }));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED",
            () => Configure(1, new[] { _leaf[0], _composite }, new[] { 1, 1 }));
        ModuleHarness.AssertFault("SA_MODULE_LIMIT_MEMBERS", () => Configure(1, new BigInteger[]
        {
            (BigInteger)1, (BigInteger)2, (BigInteger)3, (BigInteger)4, (BigInteger)5, (BigInteger)6,
            (BigInteger)7, (BigInteger)8, (BigInteger)9, (BigInteger)10, (BigInteger)11,
        }, new[] { 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 }));
        ModuleHarness.AssertFault("SA_MODULE_NOT_INSTALLED", () =>
        {
            object[] ids = { _leaf[0], (BigInteger)99 };
            object[] ws = { (BigInteger)1, (BigInteger)1 };
            _h.Configure(_account, _composite, new object[] { (BigInteger)1, ids, ws });
        });
    }

    [TestMethod]
    public void Configure_RefusesIneligibleNestedAndCrossAccountLeaves()
    {
        // A validator that does not declare threshold-member eligibility.
        BigInteger plain = _h.Install(_account, "SigningModule", 1);
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED",
            () => Configure(1, new[] { plain }, new[] { 1 }));

        // A descriptor that is itself a composite layer may not be a leaf: the
        // hierarchy is exactly one layer deep.
        BigInteger nested = _h.Install(_account, "SigningModule", 1, null,
            new ModuleHarness.Flags(Isolation: true, Eligible: true, Composite: true));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED",
            () => Configure(1, new[] { nested }, new[] { 1 }));

        // A member id that belongs to another account names no descriptor here.
        // Module ids are allocated per account, so keep installing on the other
        // account until its id is one this account has never handed out.
        UInt160 other = _h.CreateAccount("threshold-other", OtherCustody);
        BigInteger foreign;
        do
        {
            foreign = _h.Install(other, "SigningModule", 1, null,
                new ModuleHarness.Flags(Eligible: true));
        }
        while (foreign == _composite || foreign == plain || foreign == nested
            || foreign == _leaf[0] || foreign == _leaf[1] || foreign == _leaf[2]);
        ModuleHarness.AssertFault("SA_MODULE_NOT_INSTALLED",
            () => Configure(1, new[] { foreign }, new[] { 1 }));
    }

    [TestMethod]
    public void Configure_RefusesALeafWhoseCodeBindingDrifted()
    {
        _h.DriftModuleCode(_account, _leaf[0]);
        ModuleHarness.AssertFault("SA_MODULE_CODE_BINDING_MISMATCH",
            () => Configure(1, new[] { _leaf[0] }, new[] { 1 }));
    }

    [TestMethod]
    public void Configure_IsOnlyReachableThroughTheCoreConfigurationFrame()
    {
        _h.SetSigners(_h.Owner);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED", () => _h.CallVoid(Composite, "configure",
            _account, _composite, (BigInteger)1,
            new object[] { (BigInteger)1, new object[] { _leaf[0] }, new object[] { (BigInteger)1 } }));
    }

    // ---- validation ----

    [TestMethod]
    public void ValidateUserOp_ApprovesWhenTheApprovedWeightReachesTheQuorum()
    {
        Assert.IsTrue(Approve(Digest(0x10)), "three of three reach the quorum");
    }

    /// <summary>
    /// The loop never stops at the quorum. Each leaf is stripped of its
    /// eligibility in turn: the sink faults on an ineligible member, so a loop
    /// that short-circuits the moment the quorum is met would answer <c>true</c>
    /// and the fault would never surface. A quorum of one over three members
    /// therefore proves the walk reaches the last leaf.
    /// </summary>
    [TestMethod]
    public void ValidateUserOp_WalksEveryLeafEvenAfterTheQuorumIsReached()
    {
        Configure(1, _leaf, Weights111);
        StripLeafEligibility(_leaf[2]);
        ModuleHarness.AssertFault("SA_MODULE_LIMIT_MEMBERS", () => Approve(Digest(0x20)));
    }

    [TestMethod]
    public void ValidateUserOp_RefusesBelowTheQuorumWhenALeafRefuses()
    {
        _h.SetMemberApproval(_account, _leaf[2], false);
        Assert.IsFalse(Approve(Digest(0x30)), "two of three is below a quorum of three");
    }

    [TestMethod]
    public void ValidateUserOp_SumsWeightsInsteadOfCountingMembers()
    {
        Configure(5, _leaf, new[] { 2, 3, 1 });
        Assert.IsTrue(Approve(Digest(0x40)), "weights 2 + 3 + 1 reach a quorum of 5");

        // The heavy pair is worth five: a quorum of six needs the third member
        // too, so a member count would answer true and a weight sum does not.
        _h.SetMemberApproval(_account, _leaf[2], false);
        Configure(6, _leaf, new[] { 2, 3, 1 });
        Assert.IsFalse(Approve(Digest(0x41)), "weights 2 + 3 fall short of a quorum of 6");
    }

    [TestMethod]
    public void ValidateUserOp_RefusesAnInactivePolicyWithoutVisitingAMember()
    {
        _h.Configure(_account, _composite, new object[] { false });
        Assert.IsFalse(Policy()[4].GetBoolean(), "the flag flipped");
        Assert.AreEqual(2, (int)Policy()[5].GetInteger(), "the flag write bumps the revision");

        // With every leaf ineligible, dispatching one would fault in the sink.
        // A plain false therefore proves the inactive policy dispatched nothing.
        StripLeafEligibility(_leaf);
        Assert.IsFalse(Approve(Digest(0x50)), "an inactive policy approves nothing");
    }

    [TestMethod]
    public void ValidateUserOp_FailsClosedAfterACredentialRevocation()
    {
        Assert.IsTrue(Approve(Digest(0x60)));

        _h.BumpModuleGeneration(_account, _composite);
        Assert.AreEqual(new BigInteger(2), _h.DescriptorInteger(_account, _composite, 8), "generation 2");

        byte[] stale = Digest(0x61);
        Assert.IsFalse(Approve(stale), "the policy is pinned to generation 1");

        Configure(3, _leaf, Weights111);
        Assert.AreEqual(new BigInteger(2), Policy()[3].GetInteger(), "the reconfigured policy re-captured generation 2");
        Assert.IsTrue(Approve(Digest(0x62)), "the reconfigured policy answers again");
    }

    [TestMethod]
    public void ValidateUserOp_RefusesADigestThatIsNot32Bytes()
    {
        byte[] shortDigest = new byte[31];
        Assert.IsFalse(Approve(shortDigest), "a 31-byte digest approves nothing");
    }

    [TestMethod]
    public void ValidateUserOp_IsOnlyReachableAsTheRoutedComposite()
    {
        _h.SetSigners(_h.Owner);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED", () => _h.CallVoid(Composite, "validateUserOp",
            _account, Digest(0x70), new object[0]));
    }

    [TestMethod]
    public void ValidateUserOp_RefusesALeafThatIsNoLongerEligible()
    {
        byte[] digest = Digest(0x80);
        Assert.IsTrue(Approve(digest));

        // The core re-checks eligibility on every leaf visit; the module does
        // not vouch for a member it merely recorded earlier.
        _h.SetSigners(_h.Owner);
        _h.CallVoid(_h.Core, "setModuleFlags", _account, _leaf[0], false, false, false, false, false, false);
        ModuleHarness.AssertFault("SA_MODULE_LIMIT_MEMBERS", () => Approve(Digest(0x81)));
    }

    // ---- lifetime and profile ----

    [TestMethod]
    public void Uninstall_ClearsThePolicyAndReleasesTheNamespace()
    {
        _h.SetSigners(_h.Owner);
        _h.CallVoid(_h.Core, "removeModule", _account, _composite, new object[0]);

        Assert.AreEqual(0, Policy().Count, "no policy survives uninstall");
        Assert.AreEqual(0, ((NeoArray)_h.Call(Composite, "getPolicySnapshot", _account)).Count,
            "the instance pointer was released");

        BigInteger replacement = _h.Install(_account, "ThresholdPolicyModule", 1);
        Assert.AreEqual(0, ((NeoArray)_h.Call(Composite, "getThresholdPolicy", _account, replacement)).Count,
            "the next instance starts empty");
    }

    [TestMethod]
    public void InstalledComposite_ReportsItsProfileAndSeat()
    {
        Assert.AreEqual(_composite, _h.ModuleIdOf(_account, "validator", Composite));
        Assert.AreEqual(new BigInteger(1), _h.DescriptorInteger(_account, _composite, 1), "module type 1");
        string profile = System.Text.Encoding.UTF8.GetString(_h.CallBytes(Composite, "getModuleProfile"));
        StringAssert.Contains(profile, "\"compositeLayer\":1");
        StringAssert.Contains(profile, "\"thresholdMemberEligible\":false");
        Assert.IsTrue(ModuleHarness.ModuleAbiMethodIsSafe("ThresholdPolicyModule", "validateUserOp"),
            "validation is declared safe");

        IReadOnlyList<string> abi = ModuleHarness.ModuleAbiMethods("ThresholdPolicyModule");
        CollectionAssert.DoesNotContain(abi.ToList(), "applyConfigurationActions",
            "the module does not demand a retired native entry");
    }
}
