using System;
using System.Linq;
using System.Numerics;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Real-core configuration of module instances that only trust the exact core
/// configuration phase (docs/SA-MODULE-PROTOCOL.md §5, §9, §10, §12).
///
/// The v3 suite pinned the retired composite-validator layer: a root verifier
/// that initialized "children" through <c>callVerifier</c> / <c>callVerifierChild</c>,
/// one single-occupancy pending child call, a stored topology commitment in the
/// root, and verifier dependency maintenance. v4 replaced that whole mechanism:
/// <list type="bullet">
///   <item>there is no root/child roster — the account installs one instance per
///   co-signer and the <em>core</em> owns the threshold policy (§3.5);</item>
///   <item>an instance is configured by the core during the configuration phase
///   (<c>onInstall</c> / <c>configure</c>), which the module authenticates against
///   <c>getAuthorizedModuleId(accountId, Configuration)</c> — a caller-declared
///   instance is never trusted;</item>
///   <item>every post-registration change is one atomic, 24h-timelocked
///   configuration intent bound to its exact action digest, with per-resource
///   conflicts instead of one overwritable pending slot.</item>
/// </list>
/// The v3 child-roster, pending-child-call and dependency-maintenance assertions
/// have no v4 counterpart at all; the tests below pin the v4 rules that carry the
/// same intent, plus the resource/rollback semantics that replace the retired
/// single-slot commitment.
/// </summary>
[TestClass]
public class MultiSigInstanceConfigurationRuntimeTests
{
    private static readonly UInt160 Stranger =
        UInt160.Parse("0x8282828282828282828282828282828282828282");

    private static readonly TimeSpan Window = TimeSpan.FromHours(24) + TimeSpan.FromMinutes(1);

    private sealed class Harness
    {
        private static int _sequence;

        public RuntimeFixture Fx { get; } = new();

        public UInt160 Core { get; }

        public UInt160 Target { get; }

        /// <summary>One <c>MultiSigValidator</c> contract: every co-signer is its own instance.</summary>
        public UInt160 Member { get; }

        /// <summary>A validator whose profile is <em>not</em> threshold-member eligible.</summary>
        public UInt160 Session { get; }

        public P256SessionKey CustodyKey { get; } = new();

        public P256SessionKey OtherKey { get; } = new();

        public P256SessionKey KeyA { get; } = new();

        public P256SessionKey KeyB { get; } = new();

        public UInt160 Custody { get; }

        public UInt160 OtherCustody { get; }

        public UInt160 Account { get; private set; } = UInt160.Zero;

        public Harness()
        {
            Core = Fx.Deploy("SmartAccount");
            Target = Fx.Deploy("MockTransferTarget");
            Member = Fx.Deploy("validators/MultiSigValidator", Core.ToArray());
            Session = Fx.Deploy("validators/SessionKeyValidator", Core.ToArray());
            Custody = RuntimeFixture.CustodyOf(CustodyKey);
            OtherCustody = RuntimeFixture.CustodyOf(OtherKey);
        }

        public UInt160 Create(params object[] actions)
        {
            Account = Fx.CreateAccount(Core, Custody,
                "instance-config-" + System.Threading.Interlocked.Increment(ref _sequence), actions);
            return Account;
        }

        /// <summary>Installs one member instance; a null key leaves it unconfigured.</summary>
        public object MemberInstall(P256SessionKey? key)
        {
            return key == null
                ? Fx.InstallValidator(Member)
                : Fx.InstallValidator(Member, "setMemberKey", key.CompressedPublicKey);
        }

        public object Policy(BigInteger threshold, BigInteger[] members) =>
            RuntimeFixture.SetThresholdPolicy(0, threshold, members, true);

        public object Configure(BigInteger moduleId, params object?[] configData) =>
            RuntimeFixture.ConfigureModule(moduleId, configData);

        /// <summary>Policy ids come from the same monotonic allocator as module ids.</summary>
        public BigInteger PolicyIdAfter(params BigInteger[] moduleIds)
        {
            BigInteger highest = BigInteger.Zero;
            for (int i = 0; i < moduleIds.Length; i++)
            {
                if (moduleIds[i] > highest) highest = moduleIds[i];
            }
            return highest + 1;
        }

        public BigInteger[] ValidatorIds() =>
            Fx.ModuleIds(Core, Account, RuntimeFixture.ModuleTypeNameValidator);

        public byte[] MemberKey(BigInteger moduleId) =>
            Fx.CallBytes(Member, "getMemberKey", Account, moduleId);

        public BigInteger Revision(BigInteger moduleId) =>
            ((Neo.VM.Types.Array)Fx.Call(Core, "getModule", Account, moduleId))[7].GetInteger();

        public BigInteger ConfigurationNonce() => Fx.AccountConfigurationNonce(Core, Account);

        public bool BuiltInRouteEnabled() => Fx.AccountDefaultOperationAuthorization(Core, Account);

        public BigInteger[] PendingIntents() =>
            ((Neo.VM.Types.Array)Fx.Call(Core, "getPendingConfigurationIntentIds", Account))
                .Select(item => item.GetInteger()).ToArray();

        public bool HasPending(BigInteger intentId)
        {
            return ((Neo.VM.Types.Array)Fx.Call(Core, "getPendingConfiguration", Account, intentId)).Count > 0;
        }

        public void Cancel(BigInteger intentId) =>
            Fx.CallVoid(Core, "cancelConfiguration", Account, intentId);

        public BigInteger Propose(params object[] actions) =>
            Fx.ProposeConfiguration(Core, Account, Custody, actions);

        public void Confirm(BigInteger intentId, params object[] actions) =>
            Fx.ConfirmConfiguration(Core, Account, Custody, intentId, actions);

        /// <summary>Built-in (validatorId 0) operation signed by the account's custody key.</summary>
        public object[] BuiltInOp(UInt160 account, P256SessionKey key, UInt160 target,
            string method, object?[] args, BigInteger sequence)
        {
            BigInteger mask = (BigInteger.One << 64) - 1;
            BigInteger packed = Fx.PackedNonce(Core, account, 0);
            object[] op = RuntimeFixture.UserOp(target, method, args, (packed & ~mask) | sequence,
                Fx.Now() + 3_600_000, new byte[] { 0x00 });
            op[11] = Fx.SignBuiltIn(Core, account, op, key);
            return op;
        }

        public object[] BuiltInOp(BigInteger sequence) =>
            BuiltInOp(Account, CustodyKey, Target, "supportsV3", new object?[0], sequence);

        /// <summary>A policy-routed operation at (policy channel ‖ <paramref name="sequence"/>).</summary>
        public object[] ThresholdOp(BigInteger policyId, BigInteger sequence)
        {
            BigInteger mask = (BigInteger.One << 64) - 1;
            BigInteger packed = Fx.PackedNonce(Core, Account, policyId);
            return RuntimeFixture.UserOp(Target, "supportsV3", new object?[0],
                (packed & ~mask) | sequence, Fx.Now() + 3_600_000, new byte[] { 0x00 },
                validatorId: policyId, credentialGeneration: 1,
                configurationNonce: Fx.AccountConfigurationNonce(Core, Account));
        }

        public byte[] OperationDigest(object[] op)
        {
            object[] probe = (object[])op.Clone();
            probe[11] = new byte[] { 0x00 };
            return Fx.CallBytes(Core, "getOperationDigest", Account, probe);
        }

        /// <summary>One member's 64-byte signature over the §5 member digest.</summary>
        public byte[] SignMember(BigInteger memberId, P256SessionKey key, byte[] operationDigest)
        {
            byte[] digest = Fx.CallBytes(Member, "getMemberDigest", Account, memberId, operationDigest);
            return key.Sign(digest);
        }

        /// <summary>Field 11 on a policy route: serialized [[memberId, signature], ...].</summary>
        public byte[] Bundle(params (BigInteger MemberId, byte[] Signature)[] entries)
        {
            object?[] list = new object?[entries.Length];
            for (int i = 0; i < entries.Length; i++)
            {
                list[i] = new object?[] { entries[i].MemberId, entries[i].Signature };
            }
            return Fx.StdLibSerialize(list);
        }

        public object[] SignedThresholdOp(BigInteger policyId, BigInteger sequence,
            params (BigInteger MemberId, P256SessionKey Key)[] signers)
        {
            object[] op = ThresholdOp(policyId, sequence);
            byte[] digest = OperationDigest(op);
            var entries = new (BigInteger, byte[])[signers.Length];
            for (int i = 0; i < signers.Length; i++)
            {
                entries[i] = (signers[i].MemberId,
                    SignMember(signers[i].MemberId, signers[i].Key, digest));
            }
            op[11] = Bundle(entries);
            return op;
        }

        public bool Execute(object[] op) => Fx.CallBoolean(Core, "executeUserOp", Account, op);
    }

    // ------------------------------------------------------------------
    // The core supplies the configuration phase; instances never trust
    // a caller-declared instance id
    // ------------------------------------------------------------------

    [TestMethod]
    public void MemberKeysBindAtomicallyUnderTheCoreInstallPhase()
    {
        Harness h = new();
        BigInteger[] members = { BigInteger.One, (BigInteger)2 };
        // Both instances are configured inside the same atomic registration, so
        // the core is the caller of onInstall and the phase authorization
        // (0x58 Configuration) names the exact instance being installed.
        h.Create((object)h.MemberInstall(h.KeyA), (object)h.MemberInstall(h.KeyB),
            (object)h.Policy(2, members));
        BigInteger policyId = h.PolicyIdAfter(members);

        CollectionAssert.AreEqual(h.KeyA.CompressedPublicKey, h.MemberKey(1),
            "onInstall must record the first member key under its own instance");
        CollectionAssert.AreEqual(h.KeyB.CompressedPublicKey, h.MemberKey(2));
        CollectionAssert.AreEqual(members, h.ValidatorIds());
        Assert.AreEqual(BigInteger.One, h.Revision(1),
            "onInstall is the instance's first revision");
        Assert.IsFalse(h.BuiltInRouteEnabled(),
            "Installing the first validator disables the built-in operation route");

        Assert.IsTrue(h.Execute(h.SignedThresholdOp(policyId, 0,
                (BigInteger.One, h.KeyA), ((BigInteger)2, h.KeyB))),
            "The configured member keys drive a real 2-of-2 policy route");
        Assert.AreEqual(BigInteger.One,
            h.Fx.CurrentNonceSequence(h.Core, h.Account, policyId));
    }

    [TestMethod]
    public void UnconfiguredInstanceIsConfiguredOnlyThroughAMaturedIntent()
    {
        Harness h = new();
        h.Create((object)h.MemberInstall(null));
        Assert.AreEqual(0, h.MemberKey(1).Length, "An install with empty initData is unconfigured");
        BigInteger committed = h.ConfigurationNonce();

        object configure = h.Configure(1, "setMemberKey", h.KeyA.CompressedPublicKey);
        BigInteger intentId = h.Propose((object)configure);

        TestException immature = Assert.ThrowsExactly<TestException>(() =>
            h.Confirm(intentId, (object)configure));
        StringAssert.Contains(immature.Message, "SA_INTENT_IMMATURE");
        Assert.AreEqual(0, h.MemberKey(1).Length);

        h.Fx.AdvanceTime(Window);
        h.Confirm(intentId, (object)configure);
        CollectionAssert.AreEqual(h.KeyA.CompressedPublicKey, h.MemberKey(1));
        Assert.AreEqual(new BigInteger(2), h.Revision(1),
            "configure bumps the instance revision installed at 1");
        Assert.AreEqual(committed + 1, h.ConfigurationNonce(),
            "A committed intent advances configurationNonce exactly once");

        // The instance is a policy member only: route through the policy the
        // core owns, not through the instance id.
        BigInteger policyId = h.PolicyIdAfter(1);
        h.Fx.ConfigureAfterTimelock(h.Core, h.Account, h.Custody,
            (object)h.Policy(1, new[] { BigInteger.One }));
        Assert.IsTrue(h.Execute(h.SignedThresholdOp(policyId, 0, (BigInteger.One, h.KeyA))));
    }

    [TestMethod]
    public void DirectPluginLifecycleCallsAreRejected()
    {
        Harness h = new();
        h.Create((object)h.MemberInstall(null));
        object[] command = { "setMemberKey", h.KeyA.CompressedPublicKey };

        // Every lifecycle entry point requires the trusted core as the caller
        // (ModuleContext.RequireCoreCaller): owning the account's witness is not
        // authority over module state.
        var calls = new (string Method, object?[] Args)[]
        {
            ("configure", new object?[] { h.Account, (BigInteger)1, (BigInteger)1, command }),
            ("onInstall", new object?[] { h.Account, (BigInteger)1, (BigInteger)1, Array.Empty<object?>() }),
            ("onUninstall", new object?[] { h.Account, (BigInteger)1, (BigInteger)1, Array.Empty<object?>() }),
        };
        foreach (var call in calls)
        {
            TestException denied = Assert.ThrowsExactly<TestException>(() =>
                h.Fx.CallVoid(h.Member, call.Method, call.Args));
            StringAssert.Contains(denied.Message, "Unauthorized",
                call.Method + " must reject a caller that is not the configured core");
        }

        Assert.AreEqual(0, h.MemberKey(1).Length);
    }

    [TestMethod]
    public void ConfigurationRequiresTheCustodyWitness()
    {
        Harness h = new();
        h.Create((object)h.MemberInstall(null));
        object configure = h.Configure(1, "setMemberKey", h.KeyA.CompressedPublicKey);

        h.Fx.SetSigners(Stranger);
        TestException denied = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.CallInteger(h.Core, "proposeConfiguration", h.Account,
                new object[] { configure }, new object[0]));
        StringAssert.Contains(denied.Message, "SA_UNAUTHORIZED");
        Assert.AreEqual(0, h.PendingIntents().Length);
    }

    // ------------------------------------------------------------------
    // Config data is decoded by the module, not hard-coded in the core
    // ------------------------------------------------------------------

    [TestMethod]
    public void ConfigureActionRejectsUnknownInstanceAndUndecodableData()
    {
        Harness h = new();
        h.Create((object)h.MemberInstall(null));
        BigInteger committed = h.ConfigurationNonce();

        var cases = new (object Action, string Message)[]
        {
            // A module id that was never installed: the core never dispatches.
            (h.Configure(99, "setMemberKey", h.KeyA.CompressedPublicKey), "SA_MODULE_NOT_INSTALLED"),
            // The core no longer hard-codes per-method allowlists; the module
            // decodes configData itself and rejects a wrong arity.
            (h.Configure(1, "setMemberKey"), "Invalid config arguments"),
            (h.Configure(1, "update", h.KeyA.CompressedPublicKey), "Unknown config command"),
        };
        foreach (var test in cases)
        {
            BigInteger intentId = h.Propose((object)test.Action);
            h.Fx.AdvanceTime(Window);
            TestException fault = Assert.ThrowsExactly<TestException>(() =>
                h.Confirm(intentId, (object)test.Action));
            StringAssert.Contains(fault.Message, test.Message);
            Assert.AreEqual(0, h.MemberKey(1).Length,
                "A faulting configure must leave the instance untouched");
            Assert.AreEqual(BigInteger.One, h.Revision(1));
            Assert.AreEqual(committed, h.ConfigurationNonce(),
                "A faulting confirmation commits nothing");
            // The failed intent survives the revert; drop it before the next case.
            Assert.IsTrue(h.HasPending(intentId));
            h.Cancel(intentId);
        }
        Assert.AreEqual(0, h.PendingIntents().Length);
    }

    [TestMethod]
    public void InstanceBoundToAnotherCoreIsRejectedAtInstall()
    {
        Harness h = new();
        h.Create();
        // The validator trusts a different core, so its own phase authorization
        // can never resolve this core's Configuration context.
        UInt160 foreign = h.Fx.Deploy("validators/MultiSigValidator", h.Target.ToArray());
        object install = h.Fx.InstallValidator(foreign, "setMemberKey", h.KeyA.CompressedPublicKey);

        BigInteger intentId = h.Propose((object)install);
        h.Fx.AdvanceTime(Window);
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            h.Confirm(intentId, (object)install));
        StringAssert.Contains(fault.Message, "Unauthorized caller");

        Assert.AreEqual(0, h.ValidatorIds().Length, "A rejected install allocates no instance");
        Assert.IsTrue(h.BuiltInRouteEnabled(),
            "The account keeps its built-in route when no validator binds");
    }

    // ------------------------------------------------------------------
    // Intents are atomic, digest-bound and resource-scoped
    // ------------------------------------------------------------------

    [TestMethod]
    public void FaultingConfigurationActionRollsBackTheWholeIntent()
    {
        Harness h = new();
        h.Create((object)h.MemberInstall(null));
        BigInteger committed = h.ConfigurationNonce();
        object good = h.Configure(1, "setMemberKey", h.KeyA.CompressedPublicKey);
        object bad = h.Configure(99, "setMemberKey", h.KeyB.CompressedPublicKey);

        BigInteger intentId = h.Propose((object)good, (object)bad);
        h.Fx.AdvanceTime(Window);
        TestException fault = Assert.ThrowsExactly<TestException>(() =>
            h.Confirm(intentId, (object)good, (object)bad));
        StringAssert.Contains(fault.Message, "SA_MODULE_NOT_INSTALLED");

        Assert.AreEqual(0, h.MemberKey(1).Length,
            "The action that succeeded before the fault must roll back with it");
        Assert.AreEqual(BigInteger.One, h.Revision(1));
        Assert.AreEqual(committed, h.ConfigurationNonce());
        Assert.IsTrue(h.HasPending(intentId), "A faulted confirmation keeps the proposal");

        // Cleanup plus a replay of the good action in a fresh intent.
        h.Cancel(intentId);
        h.Fx.ConfigureAfterTimelock(h.Core, h.Account, h.Custody, (object)good);
        CollectionAssert.AreEqual(h.KeyA.CompressedPublicKey, h.MemberKey(1));
    }

    [TestMethod]
    public void MaturedIntentCannotBeReplayedWithDifferentActions()
    {
        Harness h = new();
        h.Create((object)h.MemberInstall(null));
        object intended = h.Configure(1, "setMemberKey", h.KeyA.CompressedPublicKey);
        object swapped = h.Configure(1, "setMemberKey", h.KeyB.CompressedPublicKey);

        BigInteger intentId = h.Propose((object)intended);
        h.Fx.AdvanceTime(Window);

        // The intent is bound to SHA-256 of its exact action array; the retired
        // root-topology commitment has no v4 analogue because the digest is the
        // commitment.
        TestException swappedFault = Assert.ThrowsExactly<TestException>(() =>
            h.Confirm(intentId, (object)swapped));
        StringAssert.Contains(swappedFault.Message, "SA_OPERATION_MALFORMED");
        Assert.AreEqual(0, h.MemberKey(1).Length);

        h.Confirm(intentId, (object)intended);
        CollectionAssert.AreEqual(h.KeyA.CompressedPublicKey, h.MemberKey(1));
    }

    [TestMethod]
    public void ChangedArgumentsRequireANewProposal()
    {
        Harness h = new();
        h.Create((object)h.MemberInstall(null));
        object first = h.Configure(1, "setMemberKey", h.KeyA.CompressedPublicKey);
        object second = h.Configure(1, "setMemberKey", h.KeyB.CompressedPublicKey);

        BigInteger intentId = h.Propose((object)first);
        h.Fx.AdvanceTime(Window);

        // Re-specifying the same instance is a conflict, not a silent restart of
        // the matured intent (the v3 "changed arguments restart the timelock").
        TestException conflict = Assert.ThrowsExactly<TestException>(() => h.Propose((object)second));
        StringAssert.Contains(conflict.Message, "SA_INTENT_CONFLICT");
        Assert.AreEqual(0, h.MemberKey(1).Length);

        h.Confirm(intentId, (object)first);
        CollectionAssert.AreEqual(h.KeyA.CompressedPublicKey, h.MemberKey(1));
    }

    [TestMethod]
    public void PolicyIntentClaimsItsMembersAsResources()
    {
        Harness h = new();
        h.Create((object)h.MemberInstall(null), (object)h.MemberInstall(null));
        BigInteger committed = h.ConfigurationNonce();
        object policy = h.Policy(2, new[] { BigInteger.One, (BigInteger)2 });
        object configure = h.Configure(1, "setMemberKey", h.KeyA.CompressedPublicKey);
        object recovery = RuntimeFixture.SetRecoveryPolicy(UInt160.Zero, RuntimeFixture.MinRecoveryTimelockMs);

        BigInteger policyIntent = h.Propose((object)policy);
        // A policy action claims policy:<id> AND every member instance it names,
        // so a member cannot be reconfigured underneath a pending policy.
        TestException conflict = Assert.ThrowsExactly<TestException>(() => h.Propose((object)configure));
        StringAssert.Contains(conflict.Message, "SA_INTENT_CONFLICT");
        // An unrelated resource still proposes in parallel.
        BigInteger recoveryIntent = h.Propose((object)recovery);
        Assert.AreEqual(2, h.PendingIntents().Length);

        h.Cancel(policyIntent);
        BigInteger memberIntent = h.Propose((object)configure);
        Assert.AreEqual(2, h.PendingIntents().Length, "Cancelling frees the claimed resources");

        h.Fx.AdvanceTime(Window);
        h.Confirm(memberIntent, (object)configure);
        h.Confirm(recoveryIntent, (object)recovery);
        CollectionAssert.AreEqual(h.KeyA.CompressedPublicKey, h.MemberKey(1));
        Assert.AreEqual(committed + 2, h.ConfigurationNonce(),
            "Both independent intents committed, one nonce step each");
    }

    // ------------------------------------------------------------------
    // Core-owned threshold policy: membership rules and roster stability
    // ------------------------------------------------------------------

    [TestMethod]
    public void IneligibleInstanceCannotBecomeAPolicyMember()
    {
        Harness h = new();
        BigInteger[] members = { BigInteger.One, (BigInteger)2 };
        h.Create((object)h.MemberInstall(h.KeyA), (object)h.MemberInstall(h.KeyB),
            (object)h.Policy(2, members), (object)h.Fx.InstallValidator(h.Session));
        BigInteger policyId = h.PolicyIdAfter(members);
        BigInteger sessionId = h.PolicyIdAfter(members) + 1;

        // SessionKeyValidator declares thresholdMemberEligible:false, so the core
        // refuses it as a member even though it is installed and a validator.
        object ineligible = h.Policy(1, new[] { sessionId });
        BigInteger ineligibleIntent = h.Propose((object)ineligible);
        h.Fx.AdvanceTime(Window);
        TestException unsupported = Assert.ThrowsExactly<TestException>(() =>
            h.Confirm(ineligibleIntent, (object)ineligible));
        StringAssert.Contains(unsupported.Message, "SA_OPERATION_MALFORMED");
        h.Cancel(ineligibleIntent);

        // A threshold above the member count is rejected before any write.
        object tooHigh = h.Policy(3, members);
        BigInteger tooHighIntent = h.Propose((object)tooHigh);
        h.Fx.AdvanceTime(Window);
        TestException thresholdFault = Assert.ThrowsExactly<TestException>(() =>
            h.Confirm(tooHighIntent, (object)tooHigh));
        StringAssert.Contains(thresholdFault.Message, "SA_MODULE_LIMIT_THRESHOLD");
        h.Cancel(tooHighIntent);

        // The accepted roster is untouched by both rejections.
        Assert.IsTrue(h.Execute(h.SignedThresholdOp(policyId, 0,
                (BigInteger.One, h.KeyA), ((BigInteger)2, h.KeyB))),
            "A rejected policy change must leave the active roster intact");
    }

    [TestMethod]
    public void ActivePolicyMemberCannotBeUninstalledUntilThePolicyIsRetired()
    {
        Harness h = new();
        BigInteger[] members = { BigInteger.One, (BigInteger)2 };
        h.Create((object)h.MemberInstall(h.KeyA), (object)h.MemberInstall(h.KeyB),
            (object)h.Policy(2, members));
        BigInteger policyId = h.PolicyIdAfter(members);

        object uninstall = RuntimeFixture.UninstallModule(1);
        BigInteger intentId = h.Propose((object)uninstall);
        h.Fx.AdvanceTime(Window);
        TestException conflict = Assert.ThrowsExactly<TestException>(() =>
            h.Confirm(intentId, (object)uninstall));
        StringAssert.Contains(conflict.Message, "SA_INTENT_CONFLICT");
        Assert.AreEqual(33, h.MemberKey(1).Length,
            "A refused uninstall keeps the member key");
        h.Cancel(intentId);

        // Retire the policy (deactivation carries no members), then detach.
        h.Fx.ConfigureAfterTimelock(h.Core, h.Account, h.Custody,
            (object)RuntimeFixture.SetThresholdPolicy(policyId, 0, Array.Empty<BigInteger>(), false));
        h.Fx.ConfigureAfterTimelock(h.Core, h.Account, h.Custody, (object)uninstall);

        Assert.AreEqual(0, h.MemberKey(1).Length,
            "onUninstall must delete the instance-scoped member key");
        CollectionAssert.AreEqual(new[] { (BigInteger)2 }, h.ValidatorIds());

        // The retired policy no longer routes anything (routing is resolved
        // before any member callback, so no member signature is needed).
        TestException gone = Assert.ThrowsExactly<TestException>(() =>
            h.Execute(h.ThresholdOp(policyId, 0)));
        StringAssert.Contains(gone.Message, "SA_VALIDATOR_NOT_FOUND");
    }

    [TestMethod]
    public void ReconfiguringAMemberKeyRotatesItsSignature()
    {
        Harness h = new();
        h.Create((object)h.MemberInstall(h.KeyA), (object)h.Policy(1, new[] { BigInteger.One }));
        BigInteger policyId = h.PolicyIdAfter(1);

        Assert.IsTrue(h.Execute(h.SignedThresholdOp(policyId, 0, (BigInteger.One, h.KeyA))));
        h.Fx.ConfigureAfterTimelock(h.Core, h.Account, h.Custody,
            (object)h.Configure(1, "setMemberKey", h.KeyB.CompressedPublicKey));
        CollectionAssert.AreEqual(h.KeyB.CompressedPublicKey, h.MemberKey(1));

        TestException stale = Assert.ThrowsExactly<TestException>(() =>
            h.Execute(h.SignedThresholdOp(policyId, 1, (BigInteger.One, h.KeyA))));
        StringAssert.Contains(stale.Message, "SA_VALIDATION_REJECTED");
        Assert.AreEqual(BigInteger.One, h.Fx.CurrentNonceSequence(h.Core, h.Account, policyId),
            "A rejected signature must not consume the policy lane");

        Assert.IsTrue(h.Execute(h.SignedThresholdOp(policyId, 1, (BigInteger.One, h.KeyB))),
            "The rotated member key signs the next operation");
    }

    // ------------------------------------------------------------------
    // Execution and market gates still fence the configuration entry points
    // ------------------------------------------------------------------

    [TestMethod]
    public void ConfigurationIntentsCannotBeConfirmedInsideExecution()
    {
        Harness h = new();
        h.Create();
        // The intent path is a direct core entry point, never a user-operation
        // target: an operation that calls confirmConfiguration on itself is
        // inside the execution window, which the configuration gate refuses.
        object[] inner = { RuntimeFixture.ConfigureModule(1, "setMemberKey", h.KeyA.CompressedPublicKey) };
        object[] op = h.BuiltInOp(h.Account, h.CustodyKey, h.Core, "confirmConfiguration",
            new object?[] { h.Account, (BigInteger)1, inner }, 0);
        h.Fx.SetSigners(h.Custody);

        TestException nested = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.Call(h.Core, "executeUserOp", h.Account, op));
        StringAssert.Contains(nested.Message, "Account configuration context active");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CurrentNonceSequence(h.Core, h.Account, 0),
            "The reverted operation must not consume the nonce");
    }

    [TestMethod]
    public void EscrowedAccountCannotRouteThroughExecution()
    {
        Harness h = new();
        UInt160 market = h.Fx.Deploy("SAAddressMarket");
        // The core admin is the deploying transaction sender (the genesis
        // validators), so the service registration happens before the harness
        // switches signers to the account's custody.
        h.Fx.SetSigners(h.Fx.Engine.ValidatorsAddress);
        h.Fx.CallVoid(market, "setAllowedSA", h.Core, true);
        h.Fx.CallVoid(h.Core, "setMarketService", market, true);

        h.Create();
        h.Fx.SetSigners(h.Custody);
        h.Fx.CallVoid(market, "createListing", h.Core, h.Account, 100000000, "instance config escrow", "");
        Assert.IsTrue(h.Fx.CallBoolean(h.Core, "isMarketEscrowActive", h.Account));

        // The escrow gate sits in front of execution, so no configuration or
        // asset move can be driven while the listing stays open.
        TestException locked = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.Call(h.Core, "executeUserOp", h.Account, h.BuiltInOp(0)));
        StringAssert.Contains(locked.Message, "Account locked in market escrow");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CurrentNonceSequence(h.Core, h.Account, 0));
    }

    [TestMethod]
    public void AnotherAccountsConfirmationNeedsThatAccountsWitness()
    {
        Harness h = new();
        h.Create((object)h.MemberInstall(null));
        object configure = h.Configure(1, "setMemberKey", h.KeyA.CompressedPublicKey);
        BigInteger intentId = h.Propose((object)configure);
        h.Fx.AdvanceTime(Window);

        UInt160 other = h.Fx.CreateAccount(h.Core, h.OtherCustody, "instance-config-other");
        // v4 has no "dependency maintenance during execution" ban: the gate is
        // the target account's own custody witness, which another account's
        // operation cannot supply.
        object[] op = h.BuiltInOp(other, h.OtherKey, h.Core, "confirmConfiguration",
            new object?[] { h.Account, intentId, new object[] { configure } }, 0);
        h.Fx.SetSigners(h.OtherCustody);

        TestException denied = Assert.ThrowsExactly<TestException>(() =>
            h.Fx.Call(h.Core, "executeUserOp", other, op));
        StringAssert.Contains(denied.Message, "SA_UNAUTHORIZED");
        Assert.AreEqual(BigInteger.Zero, h.Fx.CurrentNonceSequence(h.Core, other, 0));
        Assert.AreEqual(0, h.MemberKey(1).Length);
    }
}
