using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Modules
{
    /// <summary>
    /// Module-owned weighted threshold policy (spec §3).
    ///
    /// The native core authenticates composite dispatch: only the routed
    /// composite instance may call <c>validateMember</c>, only for the exact
    /// operation bytes and digest of that validation, only for installed leaf
    /// validators, never for a nested composite and never twice for the same
    /// member. The core records every leaf approval in engine-local state and
    /// dispatches completion to approved members only.
    ///
    /// This module owns what the core deliberately does not store: the member
    /// roster, the per-member weights, the quorum, the credential generation
    /// the policy was written under and the active flag. It never re-implements
    /// the core's leaf checks; it calls the narrow <c>validateMember</c> sink
    /// for each configured member and sums the weights of the approvals.
    ///
    /// State is instance-scoped: every row lives under
    /// <c>0x01 ‖ accountId ‖ moduleId</c> and one account pointer (shared
    /// <c>0x80</c> namespace) names the instance that owns the namespace.
    /// </summary>
    [DisplayName("ThresholdPolicyModule")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getModule")]
    [ContractPermission("*", "getModules")]
    [ContractPermission("*", "validateMember")]
    [ManifestExtra("Description", "One-layer weighted threshold validator module")]
    public class ThresholdPolicyModule : SmartContract
    {
        private const string ModuleProfileJson =
            "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":1,\"instanceIsolation\":true,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"ThresholdPolicyModule\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_Policy = new byte[] { 0x01 };

        private const int MaxMembers = 10;
        private static readonly BigInteger MaxWeight = 1_000_000_000;
        private static readonly BigInteger MaxTotalWeight = (BigInteger.One << 64) - 1;

        // Policy record: [thresholdWeight, memberIds[], weights[], generation, active, revision]
        private const int PolicyLength = 6;
        private const int FieldThreshold = 0;
        private const int FieldMembers = 1;
        private const int FieldWeights = 2;
        private const int FieldGeneration = 3;
        private const int FieldActive = 4;
        private const int FieldRevision = 5;

        public delegate void ThresholdPolicyUpdatedHandler(UInt160 accountId, BigInteger moduleId,
            BigInteger threshold, int memberCount, BigInteger revision, bool active);

        [DisplayName("ThresholdPolicyUpdated")]
        public static event ThresholdPolicyUpdatedHandler OnThresholdPolicyUpdated = default!;

        public static void _deploy(object data, bool update) => ModuleSupport.Initialize(data, update);
        [Safe] public static string GetModuleProfile() => ModuleProfileJson;
        [Safe] public static UInt160 AuthorizedCore() => ModuleSupport.Core();
        public static void SetAuthorizedCore(UInt160 coreContract) => ModuleSupport.SetAuthorizedCore(coreContract);

        /// <summary>
        /// <c>initData</c> must be empty (protocol §9.3). The roster travels
        /// through the governed <c>configure</c> callback so that every policy
        /// change passes the account's configuration nonce.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            ExecutionEngine.Assert(initData.Length == 0, ModuleProtocol.ErrOperationMalformed);
            ModuleSupport.BindInstance(accountId, moduleId);
        }

        /// <summary>
        /// <c>configData</c> forms:
        /// <c>[thresholdWeight, memberIds[], weights[], active]</c> or
        /// <c>[thresholdWeight, memberIds[], weights[]]</c> (active defaults to
        /// true), or <c>[active]</c> to only flip the flag. An empty array is a
        /// byte-for-byte no-op so a generic configure call never faults.
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] configData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            ApplyPolicy(accountId, moduleId, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            ModuleSupport.DeleteInstancePrefix(Prefix_Policy, accountId, moduleId);
            ModuleSupport.ReleaseInstance(accountId, moduleId);
        }

        /// <summary>
        /// Approves exactly when the weights of the leaf approvals reach the
        /// quorum.
        ///
        /// Every configured member is dispatched through the native
        /// <c>validateMember</c> sink — the loop never stops early when the
        /// quorum is reached, so the core records (and later completes) every
        /// member that approved. The core itself rejects nested composites,
        /// ineligible leaves, duplicates, cross-account members and dead code
        /// bindings; this module only owns the roster, weights and quorum.
        /// A policy whose pinned credential generation no longer matches the
        /// installed instance fails closed until it is reconfigured.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            if (operationDigest == null || operationDigest.Length != 32) return false;
            BigInteger moduleId = ModuleSupport.RequireValidationInstance(accountId);
            object[]? policy = TryLoadPolicy(accountId, moduleId);
            if (policy == null) return false;
            if (!(bool)policy[FieldActive]) return false;

            object[] members = (object[])policy[FieldMembers];
            object[] weights = (object[])policy[FieldWeights];
            BigInteger threshold = (BigInteger)policy[FieldThreshold];
            if (threshold < 1 || members.Length == 0 || members.Length != weights.Length) return false;

            object[]? descriptor = ModuleSupport.TryModuleDescriptor(accountId, moduleId);
            if (descriptor == null) return false;
            if ((UInt160)descriptor[ModuleSupport.FieldModuleContractHash] != Runtime.ExecutingScriptHash) return false;
            if ((BigInteger)descriptor[ModuleSupport.FieldModuleCredentialGeneration]
                != (BigInteger)policy[FieldGeneration]) return false;
            if (!ModuleSupport.HasLiveCodeBinding(Runtime.ExecutingScriptHash, descriptor)) return false;

            UInt160 core = ModuleSupport.RequireCoreConfigured();
            BigInteger approvedWeight = BigInteger.Zero;
            for (int i = 0; i < members.Length; i++)
            {
                BigInteger memberId = (BigInteger)members[i];
                // A duplicate in stored state is corruption: refuse the whole
                // operation rather than let the core see the same leaf twice.
                for (int j = 0; j < i; j++)
                    if ((BigInteger)members[j] == memberId) return false;
                // The native sink is a safe, read-only entry (IDL: callFlags
                // ReadStates, "no persistent write"): it records the leaf approval
                // in the core's own invocation state, not in storage. ReadOnly is
                // ReadStates | AllowCall — reads plus the right to reach the core's
                // own storage — and a safe callee keeps exactly that pair while Neo
                // strips its write and notify flags, so the module asks for the
                // narrowest authority the sink can actually use.
                bool approved = (bool)Contract.Call(core, "validateMember", CallFlags.ReadOnly,
                    new object[] { accountId, memberId, (byte[])operationDigest, operation });
                if (approved) approvedWeight += (BigInteger)weights[i];
            }
            return approvedWeight >= threshold;
        }

        /// <summary>
        /// Completion phase. The core already dispatches completion to the
        /// approved members only; this module has no member callbacks to
        /// forward and owns no post-execution state, so it only authenticates
        /// the core caller.
        /// </summary>
        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
            => ModuleSupport.RequireCore();

        /// <summary>
        /// Returns <c>[thresholdWeight, memberIds[], weights[], generation,
        /// active, revision]</c>, or an empty array for an unconfigured
        /// instance. Never throws for a missing or malformed record.
        /// </summary>
        [Safe]
        public static object[] GetThresholdPolicy(UInt160 accountId, BigInteger moduleId)
        {
            if (moduleId < 1) return new object[0];
            object[]? policy = TryLoadPolicy(accountId, moduleId);
            return policy ?? new object[0];
        }

        /// <summary>The bound instance and its policy, or an empty array when this contract holds no seat.</summary>
        [Safe]
        public static object[] GetPolicySnapshot(UInt160 accountId)
        {
            BigInteger moduleId = ResolveInstance(accountId);
            if (moduleId == BigInteger.Zero) return new object[0];
            object[]? policy = TryLoadPolicy(accountId, moduleId);
            if (policy == null) return new object[] { moduleId };
            object[] snapshot = new object[policy.Length + 1];
            snapshot[0] = moduleId;
            for (int i = 0; i < policy.Length; i++) snapshot[i + 1] = policy[i];
            return snapshot;
        }

        private static void ApplyPolicy(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            ExecutionEngine.Assert(data != null, ModuleProtocol.ErrOperationMalformed);
            ExecutionEngine.Assert(moduleId >= 1, ModuleProtocol.ErrOperationMalformed);
            object[]? existing = TryLoadPolicy(accountId, moduleId);

            if (data!.Length == 0) return;
            if (data.Length == 1)
            {
                ExecutionEngine.Assert(data[0] is bool, ModuleProtocol.ErrOperationMalformed);
                ExecutionEngine.Assert(existing != null, ModuleProtocol.ErrOperationMalformed);
                object[] current = existing!;
                Store(accountId, moduleId, (BigInteger)current[FieldThreshold], (object[])current[FieldMembers],
                    (object[])current[FieldWeights], (BigInteger)current[FieldGeneration], (bool)data[0],
                    (BigInteger)current[FieldRevision] + 1);
                return;
            }

            ExecutionEngine.Assert(data.Length == 3 || data.Length == 4, ModuleProtocol.ErrOperationMalformed);
            ExecutionEngine.Assert(data[0] is BigInteger, ModuleProtocol.ErrOperationMalformed);
            ExecutionEngine.Assert(data.Length == 3 || data[3] is bool, ModuleProtocol.ErrOperationMalformed);

            BigInteger threshold = (BigInteger)data[0];
            object[] members = ModuleSupport.Copy((object[])data[1]);
            object[] weights = ModuleSupport.Copy((object[])data[2]);
            bool active = data.Length == 3 || (bool)data[3];
            ExecutionEngine.Assert(members.Length >= 1 && members.Length <= MaxMembers,
                ModuleProtocol.ErrModuleLimitMembers);
            ExecutionEngine.Assert(weights.Length == members.Length, ModuleProtocol.ErrOperationMalformed);

            BigInteger totalWeight = BigInteger.Zero;
            for (int i = 0; i < members.Length; i++)
            {
                ExecutionEngine.Assert(members[i] is BigInteger, ModuleProtocol.ErrOperationMalformed);
                ExecutionEngine.Assert(weights[i] is BigInteger, ModuleProtocol.ErrOperationMalformed);
                BigInteger memberId = (BigInteger)members[i];
                ExecutionEngine.Assert(memberId >= 1 && memberId < (BigInteger.One << 64),
                    ModuleProtocol.ErrOperationMalformed);
                ExecutionEngine.Assert(memberId != moduleId, ModuleProtocol.ErrOperationMalformed);
                for (int j = 0; j < i; j++)
                    ExecutionEngine.Assert((BigInteger)members[j] != memberId, ModuleProtocol.ErrOperationMalformed);

                // Eligibility is read from the native descriptor, never from
                // caller-supplied data: leaf validator, threshold-eligible and
                // not itself a composite layer.
                object[] descriptor = ModuleSupport.ModuleDescriptor(accountId, memberId);
                ExecutionEngine.Assert((BigInteger)descriptor[ModuleSupport.FieldModuleType]
                    == ModuleProtocol.ModuleTypeValidator, ModuleProtocol.ErrOperationMalformed);
                ExecutionEngine.Assert((bool)descriptor[ModuleSupport.FieldModuleThresholdMemberEligible]
                    && !(bool)descriptor[ModuleSupport.FieldModuleCompositeLayer],
                    ModuleProtocol.ErrOperationMalformed);
                ExecutionEngine.Assert((UInt160)descriptor[ModuleSupport.FieldModuleContractHash]
                    != Runtime.ExecutingScriptHash, ModuleProtocol.ErrOperationMalformed);
                ModuleSupport.RequireLiveCodeBinding(
                    (UInt160)descriptor[ModuleSupport.FieldModuleContractHash], descriptor);

                BigInteger weight = (BigInteger)weights[i];
                ExecutionEngine.Assert(weight >= 1 && weight <= MaxWeight, ModuleProtocol.ErrOperationMalformed);
                ExecutionEngine.Assert(totalWeight + weight <= MaxTotalWeight,
                    ModuleProtocol.ErrOperationMalformed);
                totalWeight += weight;
            }
            ExecutionEngine.Assert(threshold >= 1 && threshold <= totalWeight,
                ModuleProtocol.ErrModuleLimitThreshold);

            // The quorum is bound to the generation the core will validate
            // under; a credential revocation (generation bump) invalidates the
            // policy until it is written again.
            object[] self = ModuleSupport.ModuleDescriptor(accountId, moduleId);
            ExecutionEngine.Assert((UInt160)self[ModuleSupport.FieldModuleContractHash]
                == Runtime.ExecutingScriptHash, ModuleProtocol.ErrUnauthorized);
            ModuleSupport.RequireLiveCodeBinding(Runtime.ExecutingScriptHash, self);
            BigInteger generation = (BigInteger)self[ModuleSupport.FieldModuleCredentialGeneration];
            ExecutionEngine.Assert(generation >= 1, ModuleProtocol.ErrOperationMalformed);

            BigInteger revision = existing == null ? BigInteger.One
                : (BigInteger)existing[FieldRevision] + 1;
            Store(accountId, moduleId, threshold, members, weights, generation, active, revision);
        }

        private static void Store(UInt160 accountId, BigInteger moduleId, BigInteger threshold,
            object[] members, object[] weights, BigInteger generation, bool active, BigInteger revision)
        {
            object[] policy = new object[PolicyLength];
            policy[FieldThreshold] = threshold;
            policy[FieldMembers] = members;
            policy[FieldWeights] = weights;
            policy[FieldGeneration] = generation;
            policy[FieldActive] = active;
            policy[FieldRevision] = revision;
            Storage.Put(Storage.CurrentContext, PolicyKey(accountId, moduleId), StdLib.Serialize(policy));
            OnThresholdPolicyUpdated(accountId, moduleId, threshold, members.Length, revision, active);
        }

        /// <summary>
        /// Non-throwing read used by the validation path and the views. A
        /// malformed record is indistinguishable from an absent one, so a
        /// corrupted row fails closed instead of revealing state.
        /// </summary>
        private static object[]? TryLoadPolicy(UInt160 accountId, BigInteger moduleId)
        {
            if (accountId == UInt160.Zero || !accountId.IsValid || moduleId < 1) return null;
            ByteString? data = Storage.Get(Storage.CurrentContext, PolicyKey(accountId, moduleId));
            if (data == null) return null;
            object value = StdLib.Deserialize(data!);
            if (value == null) return null;
            object[] policy = (object[])value;
            if (policy.Length != PolicyLength) return null;
            if (!(policy[FieldThreshold] is BigInteger) || !(policy[FieldGeneration] is BigInteger)
                || !(policy[FieldActive] is bool) || !(policy[FieldRevision] is BigInteger)) return null;
            object[] members = (object[])policy[FieldMembers];
            object[] weights = (object[])policy[FieldWeights];
            if (members.Length == 0 || members.Length > MaxMembers || members.Length != weights.Length) return null;
            for (int i = 0; i < members.Length; i++)
            {
                if (!(members[i] is BigInteger) || !(weights[i] is BigInteger)) return null;
                if ((BigInteger)members[i] < 1 || (BigInteger)weights[i] < 1) return null;
            }
            return policy;
        }

        /// <summary>Bounded scan for the instance of this contract installed on the account.</summary>
        private static BigInteger ResolveInstance(UInt160 accountId)
        {
            if (ModuleSupport.Core() == UInt160.Zero) return BigInteger.Zero;
            BigInteger[] ids = ModuleSupport.InstalledModuleIds(accountId, "validator",
                ModuleProtocol.MaxValidatorInstances);
            for (int i = 0; i < ids.Length; i++)
            {
                object[]? descriptor = ModuleSupport.TryModuleDescriptor(accountId, ids[i]);
                if (descriptor == null) continue;
                if ((UInt160)descriptor[ModuleSupport.FieldModuleContractHash] != Runtime.ExecutingScriptHash)
                    continue;
                if ((bool)descriptor[ModuleSupport.FieldModuleCompositeLayer]) return ids[i];
            }
            return BigInteger.Zero;
        }

        private static byte[] PolicyKey(UInt160 accountId, BigInteger moduleId) =>
            ModuleSupport.Key(Prefix_Policy, accountId, moduleId);
    }
}
