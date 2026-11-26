using System;
using System.Linq;
using System.Numerics;
using System.Security.Cryptography;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Extensions;
using Neo.SmartContract.Testing.Exceptions;

namespace SmartAccount.Contracts.Tests;

/// <summary>
/// Valid and invalid signature vectors for the v4 module surface, executed against the
/// compiled contracts through a real Neo VM.
/// </summary>
/// <remarks>
/// SessionKeyValidator and SubscriptionValidator are driven at module level through the
/// protocol-v4 core stub: configuration happens in the Configuration writer phase, then
/// validation runs in the Validation phase exactly as the core dispatches it. The former
/// MultiSigValidator child-aggregation vectors now belong to the core-owned threshold
/// policy (spec §5/§11): each co-signer installs one MultiSigValidator member instance and
/// the threshold, the member set and the approval orchestration live in the core, so those
/// vectors run against the real core with member signature bundles.
/// </remarks>
[TestClass]
public class VerifierSignatureRuntimeTests
{
    private static readonly UInt160 AccountId =
        UInt160.Parse("0x1111111111111111111111111111111111111111");

    private static readonly UInt160 Recipient =
        UInt160.Parse("0x4444444444444444444444444444444444444444");

    private static readonly UInt160 Custody =
        UInt160.Parse("0x5555555555555555555555555555555555555555");

    // ========================================================================
    // Module-level harness (protocol-v4 core stub)
    // ========================================================================

    private sealed class ModuleHarness
    {
        public RuntimeFixture Fx { get; } = new();

        public UInt160 Core { get; }

        public UInt160 Target { get; }

        public UInt160 Module { get; }

        /// <summary>The single instance the stub core records for this module.</summary>
        public BigInteger ModuleId { get; } = 1;

        private const int PhaseValidation = 1;

        private const int PhaseCompletion = 5;

        private const int PhaseConfiguration = 6;

        public ModuleHarness(string contractPath)
        {
            Core = Fx.Deploy("MockVerifierCore");
            Target = Fx.Deploy("MockTransferTarget");
            Module = Fx.Deploy(contractPath, Core.ToArray());
            Fx.CallVoid(Core, "setModule", AccountId, ModuleId, (BigInteger)1, (BigInteger)1,
                true, false, false);
        }

        /// <summary>Runs <c>configure</c> under the Configuration writer phase (§10).</summary>
        public void Configure(params object?[] configData)
        {
            Fx.CallVoid(Core, "setAuthorizedModuleId", AccountId, (BigInteger)PhaseConfiguration, ModuleId);
            Fx.CallVoid(Core, "forward", Module, "configure",
                new object?[] { AccountId, ModuleId, (BigInteger)1, configData });
        }

        /// <summary>Runs <c>validateUserOp</c> under the Validation writer phase (§10).</summary>
        public bool Validate(byte[] operationDigest, object[] op)
        {
            Fx.CallVoid(Core, "setAuthorizedModuleId", AccountId, (BigInteger)PhaseValidation, ModuleId);
            return Fx.CallBoolean(Core, "forward", Module, "validateUserOp",
                new object?[] { AccountId, operationDigest, op });
        }

        /// <summary>Runs <c>onUserOpComplete</c> under the Completion writer phase (§10).</summary>
        public void Complete(object[] op, object result)
        {
            Fx.CallVoid(Core, "setAuthorizedModuleId", AccountId, (BigInteger)PhaseCompletion, ModuleId);
            Fx.CallVoid(Core, "forward", Module, "onUserOpComplete",
                new object?[] { AccountId, op, result });
        }

        /// <summary>Asset address the core derives for the account (§5).</summary>
        public UInt160 AssetAddress => Fx.CallUInt160(Core, "getProxyScriptHash", AccountId);

        public object?[] TransferArgs(BigInteger amount) =>
            new object?[] { AssetAddress, Recipient, amount, null };

        public object[] TransferOp(BigInteger amount, byte[] signature, BigInteger nonce = default) =>
            RuntimeFixture.UserOp(Target, "transfer", TransferArgs(amount), nonce, Fx.Now() + 600_000,
                signature, validatorId: ModuleId, credentialGeneration: 1);

        public byte[] Grant() => Fx.CallBytes(Module, "getGrantDigest", AccountId, ModuleId);

        /// <summary>
        /// Operation digest for a vector: the stub core exposes no digest query, so the
        /// vector binds every unsigned field (nonce included) the way the core's digest
        /// does — a signature produced for one nonce never validates another.
        /// </summary>
        public static byte[] Digest(RuntimeFixture fx, object[] op)
        {
            object[] probe = (object[])op.Clone();
            probe[11] = new byte[] { 0x00 };
            return SHA256.HashData(fx.StdLibSerialize(probe));
        }
    }

    // ========================================================================
    // SessionKeyValidator
    // ========================================================================

    private static ModuleHarness SetUpSessionKey(
        P256SessionKey key, BigInteger spendingLimit, BigInteger? validUntilOverride = null)
    {
        ModuleHarness h = new("validators/SessionKeyValidator");
        BigInteger validUntil = validUntilOverride ?? h.Fx.Now() + 24 * 3_600_000;
        h.Configure("setSessionKey",
            key.CompressedPublicKey, h.Target, "transfer", validUntil, spendingLimit, "vector suite");
        return h;
    }

    /// <summary>Signature DTO of §5: grantDigest(32) ‖ r‖s(64).</summary>
    private static byte[] SessionDto(ModuleHarness h, P256SessionKey key, byte[] operationDigest) =>
        h.Grant().Concat(key.Sign(operationDigest)).ToArray();

    [TestMethod]
    public void SessionKey_ValidSignature_Validates()
    {
        using P256SessionKey key = new();
        ModuleHarness h = SetUpSessionKey(key, spendingLimit: 0);

        object[] op = h.TransferOp(1000, new byte[] { 0x00 });
        byte[] digest = ModuleHarness.Digest(h.Fx, op);
        op[11] = SessionDto(h, key, digest);

        Assert.IsTrue(h.Validate(digest, op));
    }

    [TestMethod]
    public void SessionKey_ClearTakesEffectBeforeLaterValidation()
    {
        using P256SessionKey key = new();
        ModuleHarness h = SetUpSessionKey(key, spendingLimit: 0);

        object[] op = h.TransferOp(1000, new byte[] { 0x00 });
        byte[] digest = ModuleHarness.Digest(h.Fx, op);
        op[11] = SessionDto(h, key, digest);

        h.Configure("clearSessionKey");

        Assert.AreEqual(0, h.Grant().Length, "A cleared instance publishes no grant digest");
        Assert.IsFalse(h.Validate(digest, op), "A cleared session key authorizes nothing");
    }

    [TestMethod]
    public void SessionKey_TamperedSignature_IsRejected()
    {
        using P256SessionKey key = new();
        ModuleHarness h = SetUpSessionKey(key, spendingLimit: 0);

        object[] op = h.TransferOp(1000, new byte[] { 0x00 });
        byte[] digest = ModuleHarness.Digest(h.Fx, op);
        byte[] dto = SessionDto(h, key, digest);
        dto[^1] ^= 0x01;
        op[11] = dto;

        Assert.IsFalse(h.Validate(digest, op));
    }

    [TestMethod]
    public void SessionKey_SignatureOverDifferentNonce_IsRejected()
    {
        using P256SessionKey key = new();
        ModuleHarness h = SetUpSessionKey(key, spendingLimit: 0);

        object[] op = h.TransferOp(1000, new byte[] { 0x00 });
        byte[] digest = ModuleHarness.Digest(h.Fx, op);
        op[11] = SessionDto(h, key, digest);

        // The core digest binds the nonce: a signature for nonce 0 must not authorize nonce 8.
        object[] replay = (object[])op.Clone();
        replay[4] = (BigInteger)8;
        byte[] replayDigest = ModuleHarness.Digest(h.Fx, replay);

        Assert.AreNotEqual(Convert.ToHexString(digest), Convert.ToHexString(replayDigest),
            "The digest must commit to the nonce");
        Assert.IsFalse(h.Validate(replayDigest, replay));
    }

    [TestMethod]
    public void SessionKey_ForeignKeySignature_IsRejected()
    {
        using P256SessionKey authorized = new();
        using P256SessionKey attacker = new();
        ModuleHarness h = SetUpSessionKey(authorized, spendingLimit: 0);

        object[] op = h.TransferOp(1000, new byte[] { 0x00 });
        byte[] digest = ModuleHarness.Digest(h.Fx, op);
        op[11] = SessionDto(h, attacker, digest);

        Assert.IsFalse(h.Validate(digest, op));
    }

    [TestMethod]
    public void SessionKey_GrantDigestFromAnotherInstance_IsRejected()
    {
        using P256SessionKey key = new();
        ModuleHarness h = SetUpSessionKey(key, spendingLimit: 0);

        object[] op = h.TransferOp(1000, new byte[] { 0x00 });
        byte[] digest = ModuleHarness.Digest(h.Fx, op);
        byte[] dto = SessionDto(h, key, digest);
        dto[0] ^= 0x01;
        op[11] = dto;

        Assert.IsFalse(h.Validate(digest, op), "The DTO must carry this instance's grant digest");
    }

    [TestMethod]
    public void SessionKey_MethodOutsideScope_IsRejected()
    {
        using P256SessionKey key = new();
        ModuleHarness h = SetUpSessionKey(key, spendingLimit: 0);

        object[] op = RuntimeFixture.UserOp(
            h.Target, "burn", h.TransferArgs(1000), 0, h.Fx.Now() + 600_000, new byte[] { 0x00 },
            validatorId: h.ModuleId, credentialGeneration: 1);
        byte[] digest = ModuleHarness.Digest(h.Fx, op);
        op[11] = SessionDto(h, key, digest);

        Assert.IsFalse(h.Validate(digest, op), "The grant is scoped to one method");
    }

    [TestMethod]
    public void SessionKey_ExpiredKey_IsRejected()
    {
        using P256SessionKey key = new();
        ModuleHarness h = SetUpSessionKey(key, spendingLimit: 0);

        object[] op = h.TransferOp(1000, new byte[] { 0x00 }, h.Fx.Now() + 172_800_000);
        byte[] digest = ModuleHarness.Digest(h.Fx, op);
        op[11] = SessionDto(h, key, digest);

        h.Fx.AdvanceTime(TimeSpan.FromHours(25)); // the grant was valid for 24h

        Assert.IsFalse(h.Validate(digest, op), "An expired grant authorizes nothing");
    }

    [TestMethod]
    public void SessionKey_TransferAboveSpendingLimit_IsRejected()
    {
        using P256SessionKey key = new();
        ModuleHarness h = SetUpSessionKey(key, spendingLimit: 1000);

        object[] op = h.TransferOp(1500, new byte[] { 0x00 });
        byte[] digest = ModuleHarness.Digest(h.Fx, op);
        op[11] = SessionDto(h, key, digest);

        Assert.IsFalse(h.Validate(digest, op), "A transfer above the cap must not validate");
    }

    [TestMethod]
    public void SessionKey_IsNeverAMessageCheckOrPolicyRoute()
    {
        using P256SessionKey key = new();
        ModuleHarness h = SetUpSessionKey(key, spendingLimit: 0);

        object[] op = RuntimeFixture.UserOp(
            h.Target, "transfer", h.TransferArgs(1000), 0, h.Fx.Now() + 600_000, new byte[] { 0x00 },
            validatorId: (BigInteger)7, credentialGeneration: 1);
        byte[] digest = ModuleHarness.Digest(h.Fx, op);
        op[11] = SessionDto(h, key, digest);

        Assert.IsFalse(h.Validate(digest, op),
            "A session key answers only the standalone route that names it");
    }

    // ========================================================================
    // Threshold policies (core-owned; one MultiSigValidator member per co-signer)
    // ========================================================================

    private sealed class ThresholdHarness
    {
        private static int _sequence;

        public RuntimeFixture Fx { get; } = new();

        public UInt160 Core { get; }

        public UInt160 Target { get; }

        /// <summary>One MultiSigValidator contract; each co-signer is a separate instance.</summary>
        public UInt160 Member { get; }

        public UInt160 AccountId { get; private set; } = UInt160.Zero;

        private int _installed;

        /// <summary>Module ids allocate from 1 in install order, so the policy follows them.</summary>
        public BigInteger PolicyId => _installed + 1;

        public ThresholdHarness()
        {
            Core = Fx.Deploy("SmartAccount");
            Target = Fx.Deploy("MockTransferTarget");
            Member = Fx.Deploy("validators/MultiSigValidator", Core.ToArray());
        }

        /// <summary>Registers an account with the given configuration actions, applied atomically.</summary>
        public UInt160 Create(params object[] actions)
        {
            int sequence = System.Threading.Interlocked.Increment(ref _sequence);
            AccountId = Fx.CreateAccount(Core, Custody, RuntimeFixture.Salt("threshold-" + sequence),
                RuntimeFixture.MinRecoveryTimelockMs, actions);
            return AccountId;
        }

        public object[] MemberInstall(params P256SessionKey[] members)
        {
            _installed += members.Length;
            return members
                .Select(member => Fx.InstallValidator(Member, "setMemberKey", member.CompressedPublicKey))
                .ToArray();
        }

        public object[] Policy(int threshold, BigInteger[] members, bool active = true) =>
            RuntimeFixture.SetThresholdPolicy(0, threshold, members, active);

        public object[] ThresholdOp() =>
            RuntimeFixture.UserOp(Target, "supportsV3", new object?[0],
                Fx.PackedNonce(Core, AccountId, PolicyId), Fx.Now() + 3_600_000, new byte[] { 0x00 },
                validatorId: PolicyId, credentialGeneration: 1,
                configurationNonce: Fx.AccountConfigurationNonce(Core, AccountId));

        public byte[] OperationDigest(object[] op)
        {
            object[] probe = (object[])op.Clone();
            probe[11] = new byte[] { 0x00 };
            return Fx.CallBytes(Core, "getOperationDigest", AccountId, probe);
        }

        /// <summary>Member signature: 64-byte r‖s over the §5 member digest.</summary>
        public byte[] SignMember(UInt160 member, BigInteger memberId, P256SessionKey key, byte[] operationDigest)
        {
            byte[] digest = Fx.CallBytes(member, "getMemberDigest", AccountId, memberId, operationDigest);
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

        public bool Execute(object[] op) => Fx.CallBoolean(Core, "executeUserOp", AccountId, op);
    }

    private static TestException PolicyFault(ThresholdHarness h, object[] policyAction, P256SessionKey member1, P256SessionKey member2)
    {
        object[] actions = h.MemberInstall(member1, member2).Concat(new object[] { policyAction }).ToArray();
        return Assert.ThrowsExactly<TestException>(() => h.Create(actions));
    }

    [TestMethod]
    public void Threshold_BothMembersApprove_MeetsThreshold()
    {
        using P256SessionKey k1 = new();
        using P256SessionKey k2 = new();
        ThresholdHarness h = new();
        h.Create(h.MemberInstall(k1, k2).Concat(new object[] { h.Policy(2, new BigInteger[] { 1, 2 }) }).ToArray());

        object[] op = h.ThresholdOp();
        byte[] digest = h.OperationDigest(op);
        op[11] = h.Bundle(
            (BigInteger.One, h.SignMember(h.Member, 1, k1, digest)),
            ((BigInteger)2, h.SignMember(h.Member, 2, k2, digest)));

        Assert.IsTrue(h.Execute(op), "2-of-2 member approvals meet a threshold of 2");
    }

    [TestMethod]
    public void Threshold_OneBadMemberSignature_FailsThreshold()
    {
        using P256SessionKey k1 = new();
        using P256SessionKey k2 = new();
        ThresholdHarness h = new();
        h.Create(h.MemberInstall(k1, k2).Concat(new object[] { h.Policy(2, new BigInteger[] { 1, 2 }) }).ToArray());

        object[] op = h.ThresholdOp();
        byte[] digest = h.OperationDigest(op);
        byte[] tampered = h.SignMember(h.Member, 2, k2, digest);
        tampered[20] ^= 0x01;
        op[11] = h.Bundle((BigInteger.One, h.SignMember(h.Member, 1, k1, digest)), ((BigInteger)2, tampered));

        TestException rejected = Assert.ThrowsExactly<TestException>(() => h.Execute(op));
        StringAssert.Contains(rejected.Message, "SA_VALIDATION_REJECTED");
    }

    [TestMethod]
    public void Threshold_MissingMemberSignature_FailsThreshold()
    {
        using P256SessionKey k1 = new();
        using P256SessionKey k2 = new();
        ThresholdHarness h = new();
        h.Create(h.MemberInstall(k1, k2).Concat(new object[] { h.Policy(2, new BigInteger[] { 1, 2 }) }).ToArray());

        object[] op = h.ThresholdOp();
        byte[] digest = h.OperationDigest(op);
        // Only member 1 signed: one approval out of two.
        op[11] = h.Bundle((BigInteger.One, h.SignMember(h.Member, 1, k1, digest)));

        TestException rejected = Assert.ThrowsExactly<TestException>(() => h.Execute(op));
        StringAssert.Contains(rejected.Message, "SA_VALIDATION_REJECTED");
    }

    [TestMethod]
    public void Threshold_ThresholdOne_SingleMemberSuffices()
    {
        using P256SessionKey k1 = new();
        using P256SessionKey k2 = new();
        ThresholdHarness h = new();
        h.Create(h.MemberInstall(k1, k2).Concat(new object[] { h.Policy(1, new BigInteger[] { 1, 2 }) }).ToArray());

        object[] op = h.ThresholdOp();
        byte[] digest = h.OperationDigest(op);
        // Member 1 abstains; member 2 alone satisfies a threshold of 1.
        op[11] = h.Bundle(((BigInteger)2, h.SignMember(h.Member, 2, k2, digest)));

        Assert.IsTrue(h.Execute(op));
    }

    /// <summary>
    /// The advertised member maximum must actually validate: callbacks run inside the
    /// declared system fee of the transaction, not a per-call budget.
    /// </summary>
    [TestMethod]
    public void Threshold_MaximumMemberCount_ValidatesInsideTheAggregate()
    {
        P256SessionKey[] keys = Enumerable.Range(0, 10).Select(_ => new P256SessionKey()).ToArray();
        ThresholdHarness h = new();
        BigInteger[] members = Enumerable.Range(1, keys.Length).Select(id => (BigInteger)id).ToArray();
        h.Create(h.MemberInstall(keys).Concat(new object[] { h.Policy(keys.Length, members) }).ToArray());

        object[] op = h.ThresholdOp();
        byte[] digest = h.OperationDigest(op);
        op[11] = h.Bundle(keys
            .Select((key, index) => ((BigInteger)(index + 1), h.SignMember(h.Member, index + 1, key, digest)))
            .ToArray());

        Assert.IsTrue(h.Execute(op), "10-of-10 is the documented maximum and must fit the validation aggregate");
    }

    [TestMethod]
    public void Threshold_MemberBundleNotAscending_Faults()
    {
        using P256SessionKey k1 = new();
        using P256SessionKey k2 = new();
        ThresholdHarness h = new();
        h.Create(h.MemberInstall(k1, k2).Concat(new object[] { h.Policy(2, new BigInteger[] { 1, 2 }) }).ToArray());

        object[] op = h.ThresholdOp();
        byte[] digest = h.OperationDigest(op);
        // §5 requires strictly ascending member ids.
        op[11] = h.Bundle(
            ((BigInteger)2, h.SignMember(h.Member, 2, k2, digest)),
            (BigInteger.One, h.SignMember(h.Member, 1, k1, digest)));

        TestException malformed = Assert.ThrowsExactly<TestException>(() => h.Execute(op));
        StringAssert.Contains(malformed.Message, "Member signatures not strictly ascending");
    }

    [TestMethod]
    public void Threshold_EmptyMemberList_IsRejected()
    {
        using P256SessionKey k1 = new();
        using P256SessionKey k2 = new();
        ThresholdHarness h = new();

        // Array-shape limits are VM ABORT asserts, which no contract try/catch can
        // remap to the uniform malformed code.
        TestException rejected = PolicyFault(h, h.Policy(1, Array.Empty<BigInteger>()), k1, k2);
        StringAssert.Contains(rejected.Message, "SA_MODULE_LIMIT_MEMBERS");
    }

    [TestMethod]
    public void Threshold_MemberListAboveMaximum_IsRejected()
    {
        using P256SessionKey k1 = new();
        using P256SessionKey k2 = new();
        ThresholdHarness h = new();
        BigInteger[] members = Enumerable.Range(1, 11).Select(id => (BigInteger)id).ToArray();

        TestException rejected = PolicyFault(h, h.Policy(1, members), k1, k2);
        StringAssert.Contains(rejected.Message, "SA_MODULE_LIMIT_MEMBERS");
    }

    [TestMethod]
    public void Threshold_ZeroThreshold_IsRejected()
    {
        using P256SessionKey k1 = new();
        using P256SessionKey k2 = new();
        ThresholdHarness h = new();

        TestException rejected = PolicyFault(h, h.Policy(0, new BigInteger[] { 1 }), k1, k2);
        StringAssert.Contains(rejected.Message, "SA_MODULE_LIMIT_THRESHOLD");
    }

    [TestMethod]
    public void Threshold_AboveMemberCount_IsRejected()
    {
        using P256SessionKey k1 = new();
        using P256SessionKey k2 = new();
        ThresholdHarness h = new();

        // The member-count relationship is enforced by the executor, not the shape gate.
        TestException rejected = PolicyFault(h, h.Policy(3, new BigInteger[] { 1, 2 }), k1, k2);
        StringAssert.Contains(rejected.Message, "SA_MODULE_LIMIT_THRESHOLD");
    }

    [TestMethod]
    public void Threshold_DuplicateMember_IsRejected()
    {
        using P256SessionKey k1 = new();
        using P256SessionKey k2 = new();
        ThresholdHarness h = new();

        TestException rejected = PolicyFault(h, h.Policy(2, new BigInteger[] { 1, 1 }), k1, k2);
        StringAssert.Contains(rejected.Message, "SA_OPERATION_MALFORMED");
    }

    [TestMethod]
    public void Threshold_UnknownMemberModule_IsRejected()
    {
        using P256SessionKey k1 = new();
        using P256SessionKey k2 = new();
        ThresholdHarness h = new();

        TestException rejected = PolicyFault(h, h.Policy(1, new BigInteger[] { 1, 9 }), k1, k2);
        StringAssert.Contains(rejected.Message, "SA_MODULE_NOT_INSTALLED");
    }

    [TestMethod]
    public void Threshold_MemberMustBeThresholdEligible()
    {
        using P256SessionKey k1 = new();
        using P256SessionKey k2 = new();
        ThresholdHarness h = new();
        UInt160 sessionKey = h.Fx.Deploy("validators/SessionKeyValidator", h.Core.ToArray());

        object?[] command =
        {
            "setSessionKey", k1.CompressedPublicKey, h.Target, "transfer",
            h.Fx.Now() + 3_600_000, (BigInteger)0, "not a member"
        };
        object[] actions = h.MemberInstall(k1, k2)
            .Concat(new object[] { h.Fx.InstallValidator(sessionKey, command) })
            .Concat(new object[] { h.Policy(1, new BigInteger[] { 1, 3 }) })
            .ToArray();

        // A session key declares thresholdMemberEligible = false (§3.2).
        TestException rejected = Assert.ThrowsExactly<TestException>(() => h.Create(actions));
        StringAssert.Contains(rejected.Message, "SA_OPERATION_MALFORMED");
    }

    [TestMethod]
    public void Threshold_MemberIsNeverIndependentlyRoutable()
    {
        using P256SessionKey k1 = new();
        using P256SessionKey k2 = new();
        ThresholdHarness h = new();
        h.Create(h.MemberInstall(k1, k2).Concat(new object[] { h.Policy(2, new BigInteger[] { 1, 2 }) }).ToArray());

        // Routing the member directly would let one co-signer stand in for the policy.
        object[] op = RuntimeFixture.UserOp(
            h.Target, "supportsV3", new object?[0],
            h.Fx.PackedNonce(h.Core, h.AccountId, 1), h.Fx.Now() + 3_600_000, new byte[] { 0x00 },
            validatorId: 1, credentialGeneration: 1,
            configurationNonce: h.Fx.AccountConfigurationNonce(h.Core, h.AccountId));

        TestException rejected = Assert.ThrowsExactly<TestException>(() => h.Execute(op));
        StringAssert.Contains(rejected.Message, "SA_MODULE_NOT_ROUTABLE");
    }

    // ========================================================================
    // SubscriptionValidator
    // ========================================================================

    private static readonly UInt160 Merchant =
        UInt160.Parse("0x2222222222222222222222222222222222222222");

    private static readonly byte[] SubId = { 0xAB, 0xCD, 0xEF, 0x01 };

    private const long SubscriptionAmount = 1000;

    private const long PeriodSeconds = 2_592_000; // 30 days

    private static byte[] ValidationDigest() => Enumerable.Repeat((byte)0x5A, 32).ToArray();

    private static ModuleHarness SetUpSubscription()
    {
        ModuleHarness h = new("validators/SubscriptionValidator");
        h.Fx.AdvanceTime(TimeSpan.FromDays(31)); // ensure the current period is past zero
        h.Configure("createSubscription",
            SubId, Merchant, h.Target, (BigInteger)SubscriptionAmount, (BigInteger)PeriodSeconds);
        // The merchant pulls the charge, so the merchant witness rides on the transaction.
        h.Fx.SetSigners(Merchant);
        return h;
    }

    // A subscription pull moves the account's assets, which live at the core-derived proxy
    // script hash rather than at the account id; the validator rejects any other source.
    private static object[] SubscriptionOp(ModuleHarness h, byte[] subId) =>
        RuntimeFixture.UserOp(
            h.Target, "transfer",
            new object?[] { h.AssetAddress, Merchant, (BigInteger)SubscriptionAmount, null },
            0, h.Fx.Now() + 600_000, subId, validatorId: h.ModuleId, credentialGeneration: 1);

    [TestMethod]
    public void Subscription_ValidChargeVector_Validates()
    {
        ModuleHarness h = SetUpSubscription();

        Assert.IsTrue(h.Validate(ValidationDigest(), SubscriptionOp(h, SubId)));
    }

    [TestMethod]
    public void Subscription_UnknownSubscriptionId_IsRejected()
    {
        ModuleHarness h = SetUpSubscription();

        byte[] unknownSubId = { 0x01, 0x02, 0x03, 0x04 };
        Assert.IsFalse(h.Validate(ValidationDigest(), SubscriptionOp(h, unknownSubId)));
    }

    [TestMethod]
    public void Subscription_SecondChargeInSamePeriod_IsRejected()
    {
        ModuleHarness h = SetUpSubscription();
        object[] op = SubscriptionOp(h, SubId);

        Assert.IsTrue(h.Validate(ValidationDigest(), op));

        // Completion books the billing period (§5): at most one charge per period.
        h.Complete(op, true);
        Assert.IsFalse(h.Validate(ValidationDigest(), op),
            "A period already booked must not charge again");
    }
}
