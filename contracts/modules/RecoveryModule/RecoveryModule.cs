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
    /// Module-owned delayed recovery (SA-MODULE-PROTOCOL §10).
    ///
    /// Guardians, the configured recovery authority, the 7–90 day timelock and
    /// the pending request are module state. The native core stores no recovery
    /// policy and exposes exactly one landing: <c>resetAccount</c>, callable
    /// only by the account's currently installed, code-bound recovery seat.
    ///
    /// Flow:
    ///   begin   — custody, the configured authority or the guardian quorum
    ///             starts a request; a named new custodian must witness it;
    ///   cancel  — the same authority withdraws an unexpired request;
    ///   execute — permissionless once the timelock elapsed, provided the
    ///             account epoch, configuration nonce and policy digest are
    ///             unchanged; it then hands the approved custody to the native
    ///             reset.
    ///
    /// Storage is per account and per module instance
    /// (<c>prefix ‖ accountId ‖ moduleId</c>); a reset allocates a new module id
    /// and leaves the old namespace unreachable without native traversal.
    /// </summary>
    [DisplayName("RecoveryModule")]
    [ContractPermission("*", "getAccount")]
    [ContractPermission("*", "getModules")]
    [ContractPermission("*", "getModule")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getContract")]
    [ContractPermission("*", "resetAccount")]
    [ContractPermission("*", "applyConfigurationActions")]
    [ManifestExtra("Description", "Module-owned guardian quorum and delayed custody recovery")]
    public class RecoveryModule : SmartContract
    {
        private const string ModuleProfileJson =
            "{\"callbacks\":[],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"RecoveryModule\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"recovery\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_Recovery = new byte[] { 0x01 };
        private static readonly byte[] Prefix_Nonce = new byte[] { 0x02 };
        private static readonly byte[] Prefix_Policy = new byte[] { 0x03 };

        private const int MaxGuardians = 10;
        private const long RecoveryTimelockMinMs = 7L * 24 * 60 * 60 * 1000;
        private const long RecoveryTimelockMaxMs = 90L * 24 * 60 * 60 * 1000;

        private const int FieldNonce = 0;
        private const int FieldInitiator = 1;
        private const int FieldStartedAt = 2;
        private const int FieldExecutableAt = 3;
        private const int FieldStatus = 4;
        private const int FieldNewCustody = 5;
        private const int FieldAuthorityEpochAtInit = 6;
        private const int FieldConfigurationNonceAtInit = 7;
        private const int FieldPolicyDigest = 8;
        private const int FieldPolicyRevision = 9;
        private const int FieldAccountId = 10;
        private const int FieldModuleId = 11;
        private const int RecordFields = 12;

        private const int FieldGuardians = 0;
        private const int FieldThreshold = 1;
        private const int FieldTimelock = 2;
        private const int FieldAuthority = 3;
        private const int FieldRevision = 4;
        private const int PolicyFields = 5;

        private const int StatusNone = 0;
        private const int StatusPending = 1;
        private const int StatusExecuted = 2;

        // The recovered composition is the account's installed set captured before the reset: the core removes every
        // instance, so the same transaction reinstalls the reviewed contracts under fresh module ids, credential
        // generations and the advanced authority epoch. Native state (account id, proxy, allocator) is untouched and
        // module-private policy rows stay unreachable under the retired instance ids. The landing is one
        // applyConfigurationActions call, so the composition is bounded by the core's per-batch action limit; when a
        // pathological account holds more instances than that, the recovery seat and the governance-capable validators
        // are restored first so the account stays recoverable and governable.
        private const int ActionInstallModule = 1;
        private const int CompositionPageLimit = 32;    // core MaxEnumerationLimit
        private const int CompositionActionLimit = 16;  // core MaxConfigurationActions

        public delegate void RecoveryStartedHandler(UInt160 accountId, BigInteger nonce, BigInteger executableAt);
        public delegate void RecoveryCancelledHandler(UInt160 accountId, BigInteger nonce);
        public delegate void RecoveryExecutedHandler(UInt160 accountId, BigInteger nonce, UInt160 newCustody);
        public delegate void RecoveryPolicyUpdatedHandler(UInt160 accountId, BigInteger revision);

        [DisplayName("RecoveryStarted")]
        public static event RecoveryStartedHandler OnRecoveryStarted = default!;
        [DisplayName("RecoveryCancelled")]
        public static event RecoveryCancelledHandler OnRecoveryCancelled = default!;
        [DisplayName("RecoveryExecuted")]
        public static event RecoveryExecutedHandler OnRecoveryExecuted = default!;
        [DisplayName("RecoveryPolicyUpdated")]
        public static event RecoveryPolicyUpdatedHandler OnRecoveryPolicyUpdated = default!;

        public static void _deploy(object data, bool update) => ModuleSupport.Initialize(data, update);
        [Safe] public static string GetModuleProfile() => ModuleProfileJson;
        [Safe] public static UInt160 AuthorizedCore() => ModuleSupport.Core();
        public static void SetAuthorizedCore(UInt160 coreContract) => ModuleSupport.SetAuthorizedCore(coreContract);

        // ---- lifecycle ----

        /// <summary><c>initData</c> must be empty; the policy arrives through a governed configure.</summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            ExecutionEngine.Assert(moduleType == ModuleProtocol.ModuleTypeRecovery, ModuleProtocol.ErrOperationMalformed);
            ExecutionEngine.Assert(initData == null || initData.Length == 0, ModuleProtocol.ErrOperationMalformed);
            ModuleSupport.BindInstance(accountId, moduleId);
        }

        /// <summary><c>configData</c> is <c>[guardians[], threshold, timelockMs]</c>
        /// or <c>[guardians[], threshold, timelockMs, authority]</c>.</summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] configData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            ExecutionEngine.Assert(moduleType == ModuleProtocol.ModuleTypeRecovery, ModuleProtocol.ErrOperationMalformed);
            ApplyPolicy(accountId, moduleId, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            ModuleSupport.RequireCore();
            ExecutionEngine.Assert(ModuleSupport.RequireConfigurationInstance(accountId) == moduleId,
                ModuleProtocol.ErrUnauthorized);
            ModuleSupport.DeleteInstancePrefix(Prefix_Recovery, accountId, moduleId);
            ModuleSupport.DeleteInstancePrefix(Prefix_Nonce, accountId, moduleId);
            ModuleSupport.DeleteInstancePrefix(Prefix_Policy, accountId, moduleId);
            ModuleSupport.ReleaseInstance(accountId, moduleId);
        }

        // ---- recovery lifecycle ----

        /// <summary>Starts a request after custody, the configured authority or the guardian quorum approves.</summary>
        public static BigInteger BeginRecovery(UInt160 accountId, UInt160 newCustody)
        {
            ModuleSupport.RequireActiveOrFrozenAccount(accountId);
            BigInteger moduleId = RequireInstalledSeat(accountId);
            object[] policy = RequirePolicy(accountId, moduleId);
            RequireRecoveryAuthority(accountId, policy);
            if (newCustody != UInt160.Zero)
            {
                ExecutionEngine.Assert(newCustody.IsValid, ModuleProtocol.ErrOperationMalformed);
                ExecutionEngine.Assert(Runtime.CheckWitness(newCustody), ModuleProtocol.ErrUnauthorized);
            }

            object[] existing = LoadRecord(accountId, moduleId);
            ExecutionEngine.Assert((BigInteger)existing[FieldStatus] != StatusPending,
                ModuleProtocol.ErrRecoveryPending);
            BigInteger nonce = (BigInteger)existing[FieldNonce] + 1;
            BigInteger startedAt = Runtime.Time;
            BigInteger executableAt = startedAt + (BigInteger)policy[FieldTimelock];
            object[] record = new object[RecordFields];
            record[FieldNonce] = nonce;
            record[FieldInitiator] = Runtime.CallingScriptHash;
            record[FieldStartedAt] = startedAt;
            record[FieldExecutableAt] = executableAt;
            record[FieldStatus] = StatusPending;
            record[FieldNewCustody] = newCustody;
            record[FieldAuthorityEpochAtInit] = ModuleSupport.AccountAuthorityEpoch(accountId);
            record[FieldConfigurationNonceAtInit] = ModuleSupport.AccountConfigurationNonce(accountId);
            record[FieldPolicyDigest] = PolicyDigest(policy);
            record[FieldPolicyRevision] = policy[FieldRevision];
            record[FieldAccountId] = accountId;
            record[FieldModuleId] = moduleId;
            Storage.Put(Storage.CurrentContext, RecordKey(accountId, moduleId), StdLib.Serialize(record));
            OnRecoveryStarted(accountId, nonce, executableAt);
            return nonce;
        }

        /// <summary>Withdraws a pending request after the same authority approves.</summary>
        public static void CancelRecovery(UInt160 accountId)
        {
            ModuleSupport.RequireActiveOrFrozenAccount(accountId);
            BigInteger moduleId = RequireInstalledSeat(accountId);
            object[] policy = RequirePolicy(accountId, moduleId);
            RequireRecoveryAuthority(accountId, policy);
            object[] record = RequirePending(accountId, moduleId);
            record[FieldStatus] = StatusNone;
            Storage.Put(Storage.CurrentContext, RecordKey(accountId, moduleId), StdLib.Serialize(record));
            OnRecoveryCancelled(accountId, (BigInteger)record[FieldNonce]);
        }

        /// <summary>Permissionless completion of a matured, unchanged request.</summary>
        public static void ExecuteRecovery(UInt160 accountId)
        {
            ModuleSupport.RequireActiveOrFrozenAccount(accountId);
            BigInteger moduleId = RequireInstalledSeat(accountId);
            object[] record = RequirePending(accountId, moduleId);
            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)record[FieldExecutableAt],
                ModuleProtocol.ErrRecoveryLocked);
            ExecutionEngine.Assert(StdLib.MemoryCompare((ByteString)record[FieldAccountId],
                (ByteString)(byte[])accountId) == 0
                && (BigInteger)record[FieldModuleId] == moduleId, ModuleProtocol.ErrProofInvalid);
            ExecutionEngine.Assert(ModuleSupport.AccountAuthorityEpoch(accountId)
                == (BigInteger)record[FieldAuthorityEpochAtInit], ModuleProtocol.ErrEpochStale);
            ExecutionEngine.Assert(ModuleSupport.AccountConfigurationNonce(accountId)
                == (BigInteger)record[FieldConfigurationNonceAtInit], ModuleProtocol.ErrConfigurationNonceStale);
            object[] policy = RequirePolicy(accountId, moduleId);
            ExecutionEngine.Assert((BigInteger)policy[FieldRevision] == (BigInteger)record[FieldPolicyRevision],
                ModuleProtocol.ErrEpochStale);
            ExecutionEngine.Assert(StdLib.MemoryCompare(PolicyDigest(policy),
                (ByteString)record[FieldPolicyDigest]) == 0, ModuleProtocol.ErrEpochStale);

            BigInteger nonce = (BigInteger)record[FieldNonce];
            UInt160 newCustody = (UInt160)record[FieldNewCustody];
            // Capture the composition while the descriptors are still readable; the reset deletes every instance.
            object[] composition = ComposeResetActions(accountId);
            record[FieldStatus] = StatusExecuted;
            Storage.Put(Storage.CurrentContext, RecordKey(accountId, moduleId), StdLib.Serialize(record));
            Storage.Put(Storage.CurrentContext, NonceKey(accountId, moduleId), nonce);
            // The only native landing this module may reach. The core re-checks
            // that the caller is the installed, code-bound recovery seat and
            // removes every instance in the same frame.
            ModuleSupport.ResetAccount(accountId, newCustody);
            // The reset retired every instance id, so each reinstalled module adopts its stale per-account pointer
            // (BindInstance accepts an id that is no longer installed). Land the install-only composition inside the
            // same transaction and the same reset epoch; a fault in any install rolls back the reset with the whole
            // transaction.
            ModuleSupport.ApplyConfigurationActions(accountId, composition);
            ModuleSupport.DeleteInstancePrefix(Prefix_Policy, accountId, moduleId);
            OnRecoveryExecuted(accountId, nonce, newCustody);
        }

        /// <summary>Rebuilds the account's installed module set as install-only core actions.</summary>
        private static object[] ComposeResetActions(UInt160 accountId)
        {
            object[] actions = new object[CompositionActionLimit];
            int at = AppendInstallActions(accountId, "recovery", actions, 0, -1);
            at = AppendInstallActions(accountId, "validator", actions, at, 1);
            at = AppendInstallActions(accountId, "validator", actions, at, 0);
            at = AppendInstallActions(accountId, "hook", actions, at, -1);
            object[] composed = new object[at];
            for (int i = 0; i < at; i++) composed[i] = actions[i];
            return composed;
        }

        /// <summary>Appends install actions for one module kind, advancing the getModules cursor so more instances
        /// than one page still reach the composition. <paramref name="governanceFilter"/> selects every instance
        /// (-1), governance-capable validators only (1) or plain validators only (0).</summary>
        private static int AppendInstallActions(UInt160 accountId, string moduleType, object[] actions, int at,
            int governanceFilter)
        {
            BigInteger cursor = BigInteger.Zero;
            while (at < CompositionActionLimit)
            {
                object[] page = ModuleSupport.InstalledModulePage(accountId, moduleType, cursor,
                    CompositionPageLimit);
                object[] ids = (object[])page[0];
                if (ids.Length == 0) return at;
                for (int i = 0; i < ids.Length && at < CompositionActionLimit; i++)
                {
                    object[] descriptor = ModuleSupport.ModuleDescriptor(accountId, (BigInteger)ids[i]);
                    if (governanceFilter >= 0
                        && (bool)descriptor[ModuleSupport.FieldModuleGovernance] != (governanceFilter == 1))
                        continue;
                    actions[at++] = new object[]
                    {
                        ActionInstallModule,
                        (BigInteger)descriptor[ModuleSupport.FieldModuleType],
                        (UInt160)descriptor[ModuleSupport.FieldModuleContractHash],
                        (ByteString)descriptor[ModuleSupport.FieldModuleProfileHash],
                        new object[0],
                    };
                }
                BigInteger next = (BigInteger)page[1];
                if (next == 0) return at;
                cursor = next;
            }
            return at;
        }

        // ---- reads ----

        /// <summary>Returns the twelve-field request record, or empty when none exists.</summary>
        [Safe]
        public static object[] GetRecoveryStatus(UInt160 accountId)
        {
            BigInteger moduleId = ResolveSeat(accountId);
            if (moduleId < 1) return new object[0];
            object[] record = LoadRecord(accountId, moduleId);
            return (BigInteger)record[FieldStatus] == StatusNone ? new object[0] : record;
        }

        /// <summary>Returns <c>[guardians[], threshold, timelockMs, authority, revision, digest]</c>, or empty.</summary>
        [Safe]
        public static object[] GetRecoveryPolicySnapshot(UInt160 accountId)
        {
            BigInteger moduleId = ResolveSeat(accountId);
            if (moduleId < 1) return new object[0];
            object[] policy = LoadPolicy(accountId, moduleId);
            if (policy.Length == 0) return new object[0];
            return new object[]
            {
                policy[FieldGuardians], policy[FieldThreshold], policy[FieldTimelock],
                policy[FieldAuthority], policy[FieldRevision], PolicyDigest(policy),
            };
        }

        [Safe]
        public static BigInteger GetExecutedRecoveryNonce(UInt160 accountId)
        {
            BigInteger moduleId = ResolveSeat(accountId);
            if (moduleId < 1) return BigInteger.Zero;
            ByteString? data = Storage.Get(Storage.CurrentContext, NonceKey(accountId, moduleId));
            return data == null ? BigInteger.Zero : (BigInteger)data!;
        }

        // ---- policy ----

        private static void ApplyPolicy(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            ExecutionEngine.Assert(data != null, ModuleProtocol.ErrOperationMalformed);
            ExecutionEngine.Assert(data!.Length == 3 || data.Length == 4, ModuleProtocol.ErrOperationMalformed);
            object[] guardians = ModuleSupport.Copy((object[])data[0]);
            ExecutionEngine.Assert(guardians.Length >= 1 && guardians.Length <= MaxGuardians,
                ModuleProtocol.ErrModuleLimitMembers);
            ExecutionEngine.Assert(data[1] is BigInteger && data[2] is BigInteger,
                ModuleProtocol.ErrOperationMalformed);
            BigInteger threshold = (BigInteger)data[1];
            BigInteger timelock = (BigInteger)data[2];
            ExecutionEngine.Assert(threshold >= 1 && threshold <= guardians.Length,
                ModuleProtocol.ErrModuleLimitThreshold);
            ExecutionEngine.Assert(timelock >= (BigInteger)RecoveryTimelockMinMs
                && timelock <= (BigInteger)RecoveryTimelockMaxMs, ModuleProtocol.ErrOperationMalformed);

            for (int i = 0; i < guardians.Length; i++)
            {
                ExecutionEngine.Assert(guardians[i] is ByteString, ModuleProtocol.ErrOperationMalformed);
                UInt160 guardian = (UInt160)guardians[i];
                ExecutionEngine.Assert(guardian != UInt160.Zero && guardian.IsValid,
                    ModuleProtocol.ErrOperationMalformed);
                for (int j = 0; j < i; j++)
                    ExecutionEngine.Assert((UInt160)guardians[j] != guardian, ModuleProtocol.ErrOperationMalformed);
            }

            UInt160 authority = UInt160.Zero;
            if (data.Length == 4)
            {
                ExecutionEngine.Assert(data[3] is ByteString, ModuleProtocol.ErrOperationMalformed);
                authority = (UInt160)data[3];
                ExecutionEngine.Assert(authority == UInt160.Zero || authority.IsValid,
                    ModuleProtocol.ErrOperationMalformed);
            }

            BigInteger revision = LoadRevision(accountId, moduleId) + 1;
            object[] policy = new object[] { guardians, threshold, timelock, authority, revision };
            Storage.Put(Storage.CurrentContext, PolicyKey(accountId, moduleId), StdLib.Serialize(policy));
            OnRecoveryPolicyUpdated(accountId, revision);
        }

        private static void RequireRecoveryAuthority(UInt160 accountId, object[] policy)
        {
            UInt160 custody = ModuleSupport.Custody(accountId);
            if (custody != UInt160.Zero && custody.IsValid && Runtime.CheckWitness(custody)) return;
            UInt160 authority = (UInt160)policy[FieldAuthority];
            if (authority != UInt160.Zero && authority.IsValid && Runtime.CheckWitness(authority)) return;
            object[] guardians = (object[])policy[FieldGuardians];
            BigInteger threshold = (BigInteger)policy[FieldThreshold];
            int approved = 0;
            for (int i = 0; i < guardians.Length; i++)
                if (Runtime.CheckWitness((UInt160)guardians[i])) approved++;
            ExecutionEngine.Assert((BigInteger)approved >= threshold, ModuleProtocol.ErrUnauthorized);
        }

        private static object[] RequirePolicy(UInt160 accountId, BigInteger moduleId)
        {
            object[] policy = LoadPolicy(accountId, moduleId);
            ExecutionEngine.Assert(policy.Length == PolicyFields,
                ModuleProtocol.ErrOperationMalformed + " recovery policy not configured");
            return policy;
        }

        private static object[] LoadPolicy(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, PolicyKey(accountId, moduleId));
            if (data == null) return new object[0];
            object[] policy = (object[])StdLib.Deserialize(data!);
            ExecutionEngine.Assert(policy.Length == PolicyFields, ModuleProtocol.ErrOperationMalformed);
            return policy;
        }

        private static BigInteger LoadRevision(UInt160 accountId, BigInteger moduleId)
        {
            object[] policy = LoadPolicy(accountId, moduleId);
            return policy.Length == 0 ? BigInteger.Zero : (BigInteger)policy[FieldRevision];
        }

        private static ByteString PolicyDigest(object[] policy) =>
            CryptoLib.Sha256(StdLib.Serialize(policy));

        // ---- records ----

        private static object[] RequirePending(UInt160 accountId, BigInteger moduleId)
        {
            object[] record = LoadRecord(accountId, moduleId);
            ExecutionEngine.Assert((BigInteger)record[FieldStatus] == StatusPending,
                ModuleProtocol.ErrRecoveryPending);
            return record;
        }

        private static object[] LoadRecord(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, RecordKey(accountId, moduleId));
            if (data == null) return EmptyRecord();
            object[] record = (object[])StdLib.Deserialize(data!);
            ExecutionEngine.Assert(record.Length == RecordFields, ModuleProtocol.ErrOperationMalformed);
            return record;
        }

        private static object[] EmptyRecord()
        {
            object[] record = new object[RecordFields];
            record[FieldNonce] = BigInteger.Zero;
            record[FieldInitiator] = UInt160.Zero;
            record[FieldStartedAt] = BigInteger.Zero;
            record[FieldExecutableAt] = BigInteger.Zero;
            record[FieldStatus] = StatusNone;
            record[FieldNewCustody] = UInt160.Zero;
            record[FieldAuthorityEpochAtInit] = BigInteger.Zero;
            record[FieldConfigurationNonceAtInit] = BigInteger.Zero;
            record[FieldPolicyDigest] = new byte[0];
            record[FieldPolicyRevision] = BigInteger.Zero;
            record[FieldAccountId] = UInt160.Zero;
            record[FieldModuleId] = BigInteger.Zero;
            return record;
        }

        // ---- instance binding ----

        /// <summary>The account's current seat, asserted to be this contract's live, bound instance.</summary>
        private static BigInteger RequireInstalledSeat(UInt160 accountId)
        {
            BigInteger moduleId = ModuleSupport.RequireInstanceBinding(accountId);
            object[] descriptor = ModuleSupport.ModuleDescriptor(accountId, moduleId);
            ExecutionEngine.Assert((UInt160)descriptor[ModuleSupport.FieldModuleContractHash]
                == Runtime.ExecutingScriptHash, ModuleProtocol.ErrUnauthorized);
            ExecutionEngine.Assert((BigInteger)descriptor[ModuleSupport.FieldModuleType]
                == ModuleProtocol.ModuleTypeRecovery, ModuleProtocol.ErrUnauthorized);
            ModuleSupport.RequireLiveCodeBinding(Runtime.ExecutingScriptHash, descriptor);
            return moduleId;
        }

        /// <summary>Non-throwing seat resolution for public reads.</summary>
        private static BigInteger ResolveSeat(UInt160 accountId)
        {
            BigInteger moduleId = ModuleSupport.Instance(accountId);
            if (moduleId < 1) return BigInteger.Zero;
            object[]? descriptor = ModuleSupport.TryModuleDescriptor(accountId, moduleId);
            if (descriptor == null) return BigInteger.Zero;
            if ((UInt160)descriptor![ModuleSupport.FieldModuleContractHash] != Runtime.ExecutingScriptHash)
                return BigInteger.Zero;
            if ((BigInteger)descriptor[ModuleSupport.FieldModuleType] != ModuleProtocol.ModuleTypeRecovery)
                return BigInteger.Zero;
            return moduleId;
        }

        private static byte[] RecordKey(UInt160 accountId, BigInteger moduleId) =>
            ModuleSupport.Key(Prefix_Recovery, accountId, moduleId);

        private static byte[] NonceKey(UInt160 accountId, BigInteger moduleId) =>
            ModuleSupport.Key(Prefix_Nonce, accountId, moduleId);

        private static byte[] PolicyKey(UInt160 accountId, BigInteger moduleId) =>
            ModuleSupport.Key(Prefix_Policy, accountId, moduleId);
    }
}
