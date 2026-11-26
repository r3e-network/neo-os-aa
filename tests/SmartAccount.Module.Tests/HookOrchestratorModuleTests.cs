using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.VM.Types;
using NeoArray = Neo.VM.Types.Array;

namespace SmartAccount.Module.Tests;

/// <summary>
/// HookOrchestratorModule owns the hook order and the snapshot it was written
/// for (spec §3, §9.4). The native core keeps the bracket itself — forward
/// <c>preCheck</c>, reverse <c>postCheck</c>, <c>hookData</c> pairing, veto-only
/// semantics and the GAS budgets — so these tests prove the module-side
/// contract and nothing the core owns:
///
///   * the order is a snapshot seeded from the installed hook set, carrying a
///     revision and a domain-separated digest, and it is written only inside the
///     native configuration frame;
///   * planning is read-only and refuses a stale snapshot or a hook whose code
///     binding drifted, instead of silently re-ordering;
///   * every installed hook stays in every plan, so a vetoing hook can never be
///     dropped or reordered around — and the planner never approves an operation
///     on its own.
/// </summary>
[TestClass]
public class HookOrchestratorModuleTests
{
    private static readonly UInt160 Custody = UInt160.Parse("0x4444444444444444444444444444444444444444");
    private static readonly UInt160 Sender = UInt160.Parse("0x5555555555555555555555555555555555555555");

    /// <summary>A fixed 32-byte operation digest; the planner only binds it, never reads it.</summary>
    private static readonly byte[] OperationDigest =
        Enumerable.Range(0, 32).Select(i => (byte)(0x90 + i)).ToArray();

    private static readonly object[] Operation = { (BigInteger)7 };

    private ModuleHarness _h = null!;
    private UInt160 _account = UInt160.Zero;
    private BigInteger _hookA;
    private BigInteger _hookB;
    private BigInteger _planner = BigInteger.Zero;

    [TestInitialize]
    public void SetUp()
    {
        _h = new ModuleHarness();
        _account = _h.CreateAccount("hook-order", Custody);
        // Hooks first: the planner seeds its snapshot from the installed set at
        // install time, which is exactly what the core does.
        _hookA = _h.InstallHook(_account);
        _hookB = _h.InstallHook(_account);
        _planner = _h.Install(_account, "HookOrchestratorModule", 1);
    }

    [TestCleanup]
    public void TearDown() => _h.Dispose();

    private UInt160 Planner => _h.Contract("HookOrchestratorModule");

    private NeoArray Snapshot() => (NeoArray)_h.Call(Planner, "getHookSnapshot", _account);

    private static BigInteger[] Ints(StackItem item)
    {
        NeoArray array = (NeoArray)item;
        BigInteger[] values = new BigInteger[array.Count];
        for (int i = 0; i < array.Count; i++) values[i] = array[i].GetInteger();
        return values;
    }

    private BigInteger[] Order() => Ints(_h.Call(Planner, "getHookOrder", _account));

    private BigInteger Revision() => Snapshot()[1].GetInteger();

    private byte[] SnapshotDigest() => Snapshot()[2].GetSpan().ToArray();

    /// <summary>Writes an order the way the core does: as a <c>configure</c> callback.</summary>
    private void Write(BigInteger[] order, int expectedRevision) =>
        _h.Configure(_account, _planner,
            new object[] { order.Cast<object>().ToArray(), (BigInteger)expectedRevision });

    private BigInteger[] Plan()
    {
        // Phase 9 is the planner route the core establishes before it asks for
        // the order; anything else would not authenticate the seat.
        NeoArray plan = _h.InvokeArray(_account, _planner, 9, "planHooks", _account, OperationDigest,
            Operation);
        return Ints(plan);
    }

    // ---- the snapshot ----

    [TestMethod]
    public void Install_SeedsTheSnapshotFromTheInstalledHookSet()
    {
        NeoArray snapshot = Snapshot();
        Assert.AreEqual(5, snapshot.Count, "moduleId, revision, digest, order, set");
        Assert.AreEqual(_planner, snapshot[0].GetInteger(), "the snapshot names the planner instance");
        Assert.AreEqual(BigInteger.One, Revision(), "the first write is revision 1");
        Assert.AreEqual(32, SnapshotDigest().Length, "the digest is a SHA-256");
        CollectionAssert.AreEqual(new[] { _hookA, _hookB }, Ints(snapshot[3]), "order");
        CollectionAssert.AreEqual(new[] { _hookA, _hookB }, Ints(snapshot[4]), "the bound hook set");

        CollectionAssert.AreEqual(new[] { _hookA, _hookB }, Order(), "the order view agrees");
        CollectionAssert.AreEqual(new[] { _hookA, _hookB }, Plan(), "planning returns the seeded order");
    }

    [TestMethod]
    public void Install_RefusesAnExplicitSetThatIsNotTheInstalledSet()
    {
        UInt160 account = _h.CreateAccount("hook-order-explicit", Custody);
        BigInteger first = _h.InstallHook(account);
        BigInteger second = _h.InstallHook(account);

        ModuleHarness.AssertFault("SA_PROOF_INVALID", () => _h.Install(account, "HookOrchestratorModule", 1,
            new object[] { new object[] { second, first } }));
        ModuleHarness.AssertFault("SA_PROOF_INVALID", () => _h.Install(account, "HookOrchestratorModule", 1,
            new object[] { new object[] { first } }));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED", () => _h.Install(account, "HookOrchestratorModule", 1,
            new object[] { new object[] { first, second }, (BigInteger)1 }));

        // The exact set is accepted, in the ascending order the core reports.
        BigInteger planner = _h.Install(account, "HookOrchestratorModule", 1,
            new object[] { new object[] { first, second } });
        CollectionAssert.AreEqual(new[] { first, second },
            Ints(_h.Call(Planner, "getHookOrder", account)), "the explicit set became the order");
        Assert.AreEqual(planner, ((NeoArray)_h.Call(Planner, "getHookSnapshot", account))[0].GetInteger(),
            "the snapshot names that instance");
    }

    [TestMethod]
    public void Configure_WritesTheOrderAndBumpsTheRevision()
    {
        byte[] before = SnapshotDigest();

        Write(new[] { _hookB, _hookA }, 1);

        Assert.AreEqual(new BigInteger(2), Revision(), "the write bumps the revision");
        CollectionAssert.AreEqual(new[] { _hookB, _hookA }, Order(), "the reversal is stored");
        CollectionAssert.AreEqual(new[] { _hookB, _hookA }, Plan(), "planning follows the stored order");
        CollectionAssert.AreNotEqual(before, SnapshotDigest(), "the digest covers the order");
        CollectionAssert.AreEqual(new[] { _hookA, _hookB }, Ints(Snapshot()[4]),
            "the bound hook set did not change with the order");

        // Writing the set back in ascending order is a new revision, and the
        // digest is a function of (instance, revision, order), not of the order
        // alone.
        Write(new[] { _hookA, _hookB }, 2);
        Assert.AreEqual(new BigInteger(3), Revision(), "each write is a new revision");
        CollectionAssert.AreEqual(new[] { _hookA, _hookB }, Plan(), "order restored");
    }

    // ---- configuration-frame-only writes ----

    [TestMethod]
    public void SetHookOrder_IsOnlyReachableThroughTheConfigurationFrame()
    {
        _h.SetSigners(_h.Owner);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED", () => _h.CallVoid(Planner, "setHookOrder",
            _account, _planner, new object[] { _hookB, _hookA }, (BigInteger)1));

        // A custody witness is still not a configuration frame: the write exists
        // only as a core callback, so it cannot bypass the configuration nonce.
        _h.SetSigners(Custody);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED", () => _h.CallVoid(Planner, "setHookOrder",
            _account, _planner, new object[] { _hookB, _hookA }, (BigInteger)1));
        ModuleHarness.AssertFault("SA_UNAUTHORIZED", () => _h.CallVoid(Planner, "configure",
            _account, _planner, (BigInteger)1,
            new object[] { new object[] { _hookB, _hookA }, (BigInteger)1 }));

        CollectionAssert.AreEqual(new[] { _hookA, _hookB }, Order(), "no direct call moved the order");
        Assert.AreEqual(BigInteger.One, Revision(), "and no revision was consumed");
    }

    [TestMethod]
    public void Configure_RefusesAStaleRevision()
    {
        Write(new[] { _hookB, _hookA }, 1);

        ModuleHarness.AssertFault("stale hook snapshot", () => Write(new[] { _hookA, _hookB }, 1));
        ModuleHarness.AssertFault("stale hook snapshot", () => Write(new[] { _hookA, _hookB }, 0));

        CollectionAssert.AreEqual(new[] { _hookB, _hookA }, Order(), "the refused write changed nothing");
        Assert.AreEqual(new BigInteger(2), Revision(), "and consumed no revision");
    }

    [TestMethod]
    public void Configure_RefusesAnOrderThatIsNotAPermutationOfTheSet()
    {
        ModuleHarness.AssertFault("SA_PROOF_INVALID", () => Write(new[] { _hookA }, 1));
        ModuleHarness.AssertFault("SA_PROOF_INVALID", () => Write(new[] { _hookA, _hookB, _hookA }, 1));
        ModuleHarness.AssertFault("SA_PROOF_INVALID", () => Write(new[] { _hookA, (BigInteger)99 }, 1));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED", () => Write(new[] { _hookA, _hookA }, 1));

        // A foreign account's hook is not in this account's set. Module ids are
        // allocated per account, so the fixture takes the foreign account's
        // third id — the only one this account's hook set (1, 2) cannot hold.
        UInt160 foreign = _h.CreateAccount("hook-order-foreign", Custody);
        _h.InstallHook(foreign);
        _h.InstallHook(foreign);
        BigInteger foreignHook = _h.InstallHook(foreign);
        Assert.AreNotEqual(_hookA, foreignHook);
        Assert.AreNotEqual(_hookB, foreignHook);
        ModuleHarness.AssertFault("SA_PROOF_INVALID", () => Write(new[] { _hookA, foreignHook }, 1));

        // A non-integer member and a malformed frame are refused before anything
        // is compared to the set.
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED", () => _h.Configure(_account, _planner,
            new object[] { new object[] { _hookA, "hookB" }, (BigInteger)1 }));
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED", () => _h.Configure(_account, _planner,
            new object[] { new object[] { _hookA, _hookB }, (BigInteger)1, (BigInteger)2 }));

        CollectionAssert.AreEqual(new[] { _hookA, _hookB }, Order(), "the seeded order survived");
        Assert.AreEqual(BigInteger.One, Revision(), "no refused write was persisted");
    }

    // ---- planning ----

    [TestMethod]
    public void PlanHooks_IsUnauthorizedForAnythingButTheRoutedPlanner()
    {
        ModuleHarness.AssertFault("SA_UNAUTHORIZED", () => _h.CallVoid(Planner, "planHooks",
            _account, OperationDigest, Operation));

        // The instance loses the planner capability the core parsed from its
        // profile: the same code, installed without the seat, cannot plan.
        _h.CallVoid(_h.Core, "setModuleFlags", _account, _planner, true, false, false, false, false, false);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED", () => Plan());
    }

    [TestMethod]
    public void PlanHooks_RefusesAStaleSnapshotAfterTheHookSetChanges()
    {
        Write(new[] { _hookB, _hookA }, 1);
        BigInteger hookC = _h.InstallHook(_account);

        // A fourth hook arrived after the snapshot was taken; the snapshot no
        // longer describes the account's hook set, so it is refused rather than
        // silently re-ordered.
        ModuleHarness.AssertFault("stale hook snapshot", () => Plan());

        // Reseeding from the installed set (empty configData) is the recovery
        // path, and it is still a configuration-frame write.
        _h.Configure(_account, _planner, new object[0]);
        Assert.AreEqual(new BigInteger(3), Revision(), "the reseed is a new revision");
        CollectionAssert.AreEqual(new[] { _hookA, _hookB, hookC }, Plan(), "the reseeded order");
    }

    [TestMethod]
    public void PlanHooks_RefusesADriftedHookCodeBinding()
    {
        _h.DriftModuleCode(_account, _hookB);

        ModuleHarness.AssertFault("SA_MODULE_CODE_BINDING_MISMATCH", () => Plan());
        ModuleHarness.AssertFault("SA_MODULE_CODE_BINDING_MISMATCH",
            () => Write(new[] { _hookB, _hookA }, 1));
    }

    [TestMethod]
    public void PlanHooks_KeepsAVetoingHookInTheOrderAndNeverApprovesItself()
    {
        Write(new[] { _hookB, _hookA }, 1);

        // The core runs every hook it is given and vetoes when one refuses; the
        // module's only lever is the order, and the order must be the whole set.
        // A plan that dropped the vetoing hook is refused, so a veto cannot be
        // skipped by re-planning.
        ModuleHarness.AssertFault("SA_PROOF_INVALID", () => Write(new[] { _hookA }, 2));
        CollectionAssert.AreEqual(new[] { _hookB, _hookA }, Plan(), "both hooks are still planned");

        // The planner seat never approves an operation: authenticating the core
        // is the whole callback, and the answer is always false.
        Assert.IsFalse(_h.InvokeBool(_account, _planner, 1, "validateUserOp", _account, OperationDigest,
            Operation), "a hook planner does not approve spending");
        ModuleHarness.AssertFault("SA_UNAUTHORIZED", () => _h.CallVoid(Planner, "validateUserOp",
            _account, OperationDigest, Operation));
    }

    [TestMethod]
    public void PlanHooks_WritesNothing()
    {
        BigInteger nonce = _h.ConfigurationNonce(_account);
        byte[] digest = SnapshotDigest();

        Assert.AreEqual(2, Plan().Length);
        Assert.AreEqual(2, Plan().Length);

        Assert.AreEqual(nonce, _h.ConfigurationNonce(_account), "planning does not consume the nonce");
        CollectionAssert.AreEqual(digest, SnapshotDigest(), "planning does not rewrite the snapshot");
    }

    // ---- instance lifetime and the immediate revocation path ----

    [TestMethod]
    public void OnUninstall_DropsTheStoredOrder()
    {
        Write(new[] { _hookB, _hookA }, 1);

        _h.SetSigners(_h.Owner);
        _h.CallVoid(_h.Core, "removeModule", _account, _planner, new object[0]);

        Assert.AreEqual(0, Order().Length, "the retired instance holds no order");
        Assert.AreEqual(0, Snapshot().Count, "and no snapshot");
        ModuleHarness.AssertFault("SA_MODULE_NOT_INSTALLED", () => Plan());
    }

    [TestMethod]
    public void RevokeCredentials_IsImmediateAndCustodyOnly()
    {
        Assert.AreEqual(BigInteger.One, _h.CallInteger(Planner, "getCredentialGeneration",
            _account, _planner), "the install generation");

        _h.SetSigners(Sender);
        ModuleHarness.AssertFault("SA_UNAUTHORIZED", () => _h.CallVoid(Planner, "revokeCredentials",
            _account, _planner));

        // Revocation is the one credential transition that is never delayed: it
        // lands on the spot, from custody, without a governance intent.
        _h.SetSigners(Custody);
        _h.CallVoid(Planner, "revokeCredentials", _account, _planner);

        Assert.AreEqual(new BigInteger(2), _h.CallInteger(Planner, "getCredentialGeneration",
            _account, _planner), "the generation advanced immediately");
        Assert.AreEqual(new BigInteger(2), _h.DescriptorInteger(_account, _planner, 8),
            "the descriptor carries the new generation");
        ModuleHarness.AssertFault("SA_OPERATION_MALFORMED", () => _h.CallVoid(Planner, "revokeCredentials",
            _account, BigInteger.Zero));
    }

    [TestMethod]
    public void ModuleProfile_RecordsThePlannerSeatAndItsCallbacks()
    {
        string profile = System.Text.Encoding.UTF8.GetString(_h.CallBytes(Planner, "getModuleProfile"));
        StringAssert.Contains(profile, "\"hookPlanner\":true");
        StringAssert.Contains(profile, "\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\",\"planHooks\"]");
        StringAssert.Contains(profile, "\"instanceIsolation\":true");
        StringAssert.Contains(profile, "\"messageCapability\":false");

        Assert.IsTrue(ModuleHarness.ModuleAbiMethodIsSafe("HookOrchestratorModule", "planHooks"),
            "planning is declared safe");
        Assert.IsTrue(ModuleHarness.ModuleAbiMethodIsSafe("HookOrchestratorModule", "getHookSnapshot"),
            "the snapshot view is declared safe");
        Assert.IsTrue(ModuleHarness.ModuleAbiMethodIsSafe("HookOrchestratorModule", "validateUserOp"),
            "the validation callback is declared safe");
        Assert.IsFalse(ModuleHarness.ModuleAbiMethodIsSafe("HookOrchestratorModule", "setHookOrder"),
            "the order write is not safe");
    }
}
