using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using static SmartAccount.Modules.ModuleProtocol;

namespace SmartAccount.Modules
{
    /// <summary>
    /// Protocol constants a user-space standard module needs. The values are
    /// the published ones (docs/SA-MODULE-PROTOCOL.md §2/§7/§9); a module never
    /// re-derives them, it names them.
    /// </summary>
    internal static class ModuleProtocol
    {
        internal const int ModuleTypeValidator = 1;
        internal const int ModuleTypeHook = 4;
        internal const int ModuleTypeRecovery = 5;

        // Phase codes the core passes to getAuthorizedModuleId (spec §9).
        internal const int PhaseValidation = 1;
        internal const int PhaseConfiguration = 6;
        internal const int PhaseMemberValidation = 8;
        internal const int PhaseHookPlanning = 9;

        internal const int MaxValidatorInstances = 32;

        // Generic registration / configuration action codes. Policy-specific
        // actions are intentionally absent: modules interpret their own data.
        internal const int ActionInstallModule = 1;
        internal const int ActionUninstallModule = 2;
        internal const int ActionConfigureModule = 3;
        internal const int ActionSetBuiltinAuthorization = 5;
        internal const int ActionSetRequiredValidator = 7;
        internal const int ActionUnfreeze = 11;

        // Account status codes (spec §7.2).
        internal const int StatusActive = 0;
        internal const int StatusFrozen = 1;

        // Module error symbols (spec §17): the spellings are normative; an
        // assertion may append a detail suffix after a single space, but the
        // prefix must match the table byte for byte (C-25).
        internal const string ErrIntentImmature = "SA_INTENT_IMMATURE";
        internal const string ErrIntentExpired = "SA_INTENT_EXPIRED";
        internal const string ErrIntentConflict = "SA_INTENT_CONFLICT";
        internal const string ErrIntentNotFound = "SA_INTENT_NOT_FOUND";
        internal const string ErrIntentLimit = "SA_INTENT_LIMIT";
        internal const string ErrModuleLimitActions = "SA_MODULE_LIMIT_ACTIONS";
        internal const string ErrRecoveryPending = "SA_RECOVERY_PENDING";
        internal const string ErrRecoveryLocked = "SA_RECOVERY_LOCKED";
        internal const string ErrHookDataTooLarge = "SA_HOOK_DATA_TOO_LARGE";
        internal const string ErrProofInvalid = "SA_PROOF_INVALID";
        internal const string ErrModuleLimitMembers = "SA_MODULE_LIMIT_MEMBERS";
        internal const string ErrConfigurationNonceStale = "SA_CONFIGURATION_NONCE_STALE";

        // Core error symbols (spec §17) reused for module-side cases the
        // module rows do not cover — nearest existing symbol per the C-25
        // fallback rule; every reuse is listed in the task report.
        internal const string ErrOperationMalformed = "SA_OPERATION_MALFORMED";
        internal const string ErrAccountNotFound = "SA_ACCOUNT_NOT_FOUND";
        internal const string ErrAccountFrozen = "SA_ACCOUNT_FROZEN";
        internal const string ErrAccountStatus = "SA_ACCOUNT_STATUS";
        internal const string ErrEpochStale = "SA_EPOCH_STALE";
        internal const string ErrModuleNotInstalled = "SA_MODULE_NOT_INSTALLED";
        internal const string ErrModuleCodeBindingMismatch = "SA_MODULE_CODE_BINDING_MISMATCH";
        internal const string ErrModuleLimitThreshold = "SA_MODULE_LIMIT_THRESHOLD";
        internal const string ErrPhaseViolation = "SA_PHASE_VIOLATION";
        internal const string ErrUnauthorized = "SA_UNAUTHORIZED";
    }

    /// <summary>
    /// Shared plumbing for the standard user-space modules (spec §9/§10).
    ///
    /// The minimal native core publishes registration, freeze/unfreeze,
    /// execution and module administration. A module reaches the core through
    /// the descriptor reads below and through the landing entries its role
    /// permits: <c>applyConfigurationActions</c> (a mature governance intent),
    /// <c>unfreezeAccount</c>, <c>revokeModuleCredentials</c> and
    /// <c>resetAccount</c> (the mature recovery seat). There is deliberately no
    /// wrapper for <c>installModule</c>, <c>removeModule</c>,
    /// <c>configureModule</c> or <c>setBuiltinAuthorization</c>: those topology
    /// changes exist in a module only as action codes inside a reviewed intent
    /// batch, so no module code path can land them outside the governance delay.
    ///
    /// Authority is never a caller-declared value. A module asks the core for
    /// the account state and checks a witness:
    ///
    ///   * <see cref="RequireCustody"/> is the only administration gate on the
    ///     module side ("the custodian asked for this"): it reads the custody
    ///     from the core and checks that one witness. The module layer keeps no
    ///     copy of the native landing rule — under v4.1 the core answers a
    ///     configuration landing to the bound governance caller alone, and a
    ///     validator witness is not an administration principal either side;
    ///   * <see cref="RequireCore"/> is the "the core is running this operation"
    ///     gate for callbacks the core dispatches.
    /// </summary>
    internal static class ModuleSupport
    {
        private static readonly byte[] Prefix_Admin = new byte[] { 0xF0 };
        private static readonly byte[] Prefix_Core = new byte[] { 0xF1 };
        // One pointer per account names the module instance that owns the
        // account's private namespace. A reset allocates a new module id, so
        // the old namespace becomes unreachable without native traversal.
        private static readonly byte[] Prefix_Instance = new byte[] { 0x80 };

        private const string CoreGetAccount = "getAccount";
        private const string CoreGetModules = "getModules";
        private const string CoreGetModule = "getModule";
        private const string CoreGetAuthorizedModuleId = "getAuthorizedModuleId";
        private const string CoreUnfreezeAccount = "unfreezeAccount";
        private const string CoreRevokeModuleCredentials = "revokeModuleCredentials";
        private const string CoreResetAccount = "resetAccount";
        private const string CoreApplyConfigurationActions = "applyConfigurationActions";

        // getAccount(accountId) field indices (spec §7.2).
        private const int FieldExists = 0;
        internal const int FieldStatus = 1;
        private const int FieldCustody = 2;
        internal const int FieldAuthorityEpoch = 3;
        internal const int FieldConfigurationNonce = 4;
        internal const int FieldDefaultOperationAuthorization = 5;
        internal const int FieldDefaultMessageAuthorization = 6;
        private const int FieldControlRevision = 8;

        // getModules page / getModule descriptor indices (spec §9).
        private const int FieldModuleIds = 0;
        internal const int FieldModuleType = 1;
        internal const int FieldModuleContractHash = 2;
        internal const int FieldModuleContractId = 3;
        internal const int FieldModuleUpdateCounter = 4;
        internal const int FieldModuleProfileHash = 6;
        internal const int FieldModuleRevision = 7;
        internal const int FieldModuleCredentialGeneration = 8;
        internal const int FieldModuleInstanceIsolation = 9;
        internal const int FieldModuleMessageCapability = 10;
        internal const int FieldModuleThresholdMemberEligible = 11;
        internal const int FieldModuleCompositeLayer = 12;
        internal const int FieldModuleGovernance = 13;
        internal const int FieldModuleHookPlanner = 14;

        // ---- deployment, identity and admin ----

        /// <summary>
        /// <c>_deploy</c>: the deployer becomes the admin, and the trusted core
        /// may be pinned in the deployment data as the only optional input.
        /// </summary>
        internal static void Initialize(object data, bool update)
        {
            if (update) return;
            Storage.Put(Storage.CurrentContext, Prefix_Admin, Runtime.Transaction.Sender);
            if (data is byte[] rawCore && rawCore.Length == 20)
                Storage.Put(Storage.CurrentContext, Prefix_Core, rawCore);
            else if (data is ByteString coreBytes && coreBytes.Length == 20)
                Storage.Put(Storage.CurrentContext, Prefix_Core, (byte[])coreBytes);
        }

        internal static UInt160 Admin()
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Prefix_Admin);
            return data == null ? UInt160.Zero : (UInt160)data;
        }

        /// <summary>The native SmartAccount core this module serves, or zero.</summary>
        internal static UInt160 Core()
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Prefix_Core);
            return data == null ? UInt160.Zero : (UInt160)data;
        }

        /// <summary>
        /// Instant core pinning is allowed only while the pin is unset: a module
        /// that could silently re-point its core could silently forget every
        /// policy it ever wrote.
        /// </summary>
        internal static void SetAuthorizedCore(UInt160 coreContract)
        {
            UInt160 admin = Admin();
            ExecutionEngine.Assert(admin != UInt160.Zero && admin.IsValid, ErrUnauthorized);
            ExecutionEngine.Assert(Runtime.CheckWitness(admin), ErrUnauthorized);
            ExecutionEngine.Assert(coreContract != UInt160.Zero && coreContract.IsValid, ErrOperationMalformed);
            ExecutionEngine.Assert(Core() == UInt160.Zero, ErrPhaseViolation + " core already pinned");
            Storage.Put(Storage.CurrentContext, Prefix_Core, (byte[])coreContract);
        }

        internal static UInt160 RequireCoreConfigured()
        {
            UInt160 core = Core();
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, ErrPhaseViolation + " core not configured");
            return core;
        }

        /// <summary>Only the trusted core may run this entry point.</summary>
        internal static UInt160 RequireCore()
        {
            UInt160 core = RequireCoreConfigured();
            ExecutionEngine.Assert(Runtime.CallingScriptHash == core, ErrUnauthorized);
            return core;
        }

        // ---- account state, read from the core ----

        /// <summary>The full <c>getAccount</c> descriptor, asserted to exist.</summary>
        internal static object[] AccountRecord(UInt160 accountId)
        {
            ExecutionEngine.Assert(accountId != UInt160.Zero && accountId.IsValid, ErrOperationMalformed);
            object[] record = (object[])Contract.Call(RequireCoreConfigured(), CoreGetAccount,
                CallFlags.ReadOnly, new object[] { accountId });
            ExecutionEngine.Assert(record.Length > FieldControlRevision, ErrAccountNotFound);
            ExecutionEngine.Assert((bool)record[FieldExists], ErrAccountNotFound);
            return record;
        }

        internal static BigInteger AccountStatus(UInt160 accountId) =>
            (BigInteger)AccountRecord(accountId)[FieldStatus];

        internal static UInt160 Custody(UInt160 accountId) =>
            (UInt160)AccountRecord(accountId)[FieldCustody];

        /// <summary>The account's current authority epoch (getAccount field 3, spec §7.2).</summary>
        internal static BigInteger AccountAuthorityEpoch(UInt160 accountId) =>
            (BigInteger)AccountRecord(accountId)[FieldAuthorityEpoch];

        /// <summary>The account's current configuration nonce (getAccount field 4, spec §7.2).</summary>
        internal static BigInteger AccountConfigurationNonce(UInt160 accountId) =>
            (BigInteger)AccountRecord(accountId)[FieldConfigurationNonce];

        internal static void RequireActiveAccount(UInt160 accountId)
        {
            ExecutionEngine.Assert(AccountStatus(accountId) == ModuleProtocol.StatusActive, ErrAccountStatus);
        }

        /// <summary>
        /// The thaw path's status gate (audit H-2, spec §10): a frozen account
        /// must still be able to propose and confirm the unfreeze intent that is
        /// its only way out, so `Active` and `Frozen` both pass. `MigrationRequired`
        /// and any other status is refused — an unfreeze must not give a migrating
        /// account execution capability (§10).
        /// </summary>
        internal static void RequireActiveOrFrozenAccount(UInt160 accountId)
        {
            BigInteger status = AccountStatus(accountId);
            ExecutionEngine.Assert(
                status == ModuleProtocol.StatusActive || status == ModuleProtocol.StatusFrozen,
                ErrAccountStatus);
        }

        // ---- authority ----

        /// <summary>
        /// The descriptor's <c>contractId</c>/<c>updateCounter</c> are the values
        /// bound at install (spec §7.3). A contract that was updated since then
        /// is a different code identity until the account rebinds it.
        /// </summary>
        internal static void RequireLiveCodeBinding(UInt160 contractHash, object[] descriptor)
        {
            Contract? deployed = ContractManagement.GetContract(contractHash);
            ExecutionEngine.Assert(deployed != null, ErrUnauthorized);
            ExecutionEngine.Assert(
                (BigInteger)deployed!.Id == (BigInteger)descriptor[FieldModuleContractId]
                && (BigInteger)deployed.UpdateCounter == (BigInteger)descriptor[FieldModuleUpdateCounter],
                ErrModuleCodeBindingMismatch);
        }

        internal static void RequireCustody(UInt160 accountId)
        {
            UInt160 custody = Custody(accountId);
            ExecutionEngine.Assert(custody != UInt160.Zero && custody.IsValid, ErrUnauthorized);
            ExecutionEngine.Assert(Runtime.CheckWitness(custody), ErrUnauthorized);
        }

        /// <summary>
        /// Non-throwing code-binding check for the read-only message path: a
        /// contract that was updated or destroyed after install is not the code
        /// identity the account bound.
        /// </summary>
        internal static bool HasLiveCodeBinding(UInt160 contractHash, object[] descriptor)
        {
            if (descriptor.Length <= FieldModuleUpdateCounter) return false;
            Contract? deployed = ContractManagement.GetContract(contractHash);
            return deployed != null
                && (BigInteger)deployed!.Id == (BigInteger)descriptor[FieldModuleContractId]
                && (BigInteger)deployed.UpdateCounter == (BigInteger)descriptor[FieldModuleUpdateCounter];
        }

        /// <summary>
        /// Non-throwing account read for public, fail-closed entry points (the
        /// message query and status views). Returns null when the core is not
        /// pinned or the account does not exist.
        /// </summary>
        internal static object[]? TryAccountRecord(UInt160 accountId)
        {
            UInt160 core = Core();
            if (core == UInt160.Zero || !core.IsValid || accountId == UInt160.Zero || !accountId.IsValid)
                return null;
            object[] record = (object[])Contract.Call(core, CoreGetAccount, CallFlags.ReadOnly,
                new object[] { accountId });
            if (record.Length <= FieldControlRevision || !(bool)record[FieldExists]) return null;
            return record;
        }

        /// <summary>
        /// Non-throwing descriptor read. A short reply means the id is not an
        /// installed instance on that account.
        /// </summary>
        internal static object[]? TryModuleDescriptor(UInt160 accountId, BigInteger moduleId)
        {
            UInt160 core = Core();
            if (core == UInt160.Zero || !core.IsValid || moduleId < 1) return null;
            object[] module = (object[])Contract.Call(core, CoreGetModule, CallFlags.ReadOnly,
                new object[] { accountId, moduleId });
            return module.Length > FieldModuleHookPlanner ? module : null;
        }

        /// <summary>
        /// Binds an account to the module instance that owns its private state.
        /// A second, live instance may not adopt an existing namespace. A native
        /// reset retires every instance id without running the old lifecycle
        /// callbacks, so a pointer that names a no-longer-installed id may be
        /// adopted by the fresh instance the restricted landing installs.
        /// </summary>
        internal static void BindInstance(UInt160 accountId, BigInteger moduleId)
        {
            ExecutionEngine.Assert(accountId != UInt160.Zero && accountId.IsValid, ErrOperationMalformed);
            ExecutionEngine.Assert(moduleId >= 1, ErrOperationMalformed);
            ByteString? existing = Storage.Get(Storage.CurrentContext, Key(Prefix_Instance, accountId));
            if (existing != null && (BigInteger)existing! != moduleId)
            {
                object[]? previous = TryModuleDescriptor(accountId, (BigInteger)existing!);
                ExecutionEngine.Assert(previous == null, ErrPhaseViolation + " instance already bound");
            }
            Storage.Put(Storage.CurrentContext, Key(Prefix_Instance, accountId), moduleId);
        }

        /// <summary>The instance id bound to the account, or zero.</summary>
        internal static BigInteger Instance(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, Key(Prefix_Instance, accountId));
            return data == null ? BigInteger.Zero : (BigInteger)data!;
        }

        internal static BigInteger RequireInstanceBinding(UInt160 accountId)
        {
            BigInteger moduleId = Instance(accountId);
            ExecutionEngine.Assert(moduleId >= 1, ErrModuleNotInstalled);
            return moduleId;
        }

        /// <summary>Clears the pointer only when it still names the leaving instance.</summary>
        internal static void ReleaseInstance(UInt160 accountId, BigInteger moduleId)
        {
            if (Instance(accountId) == moduleId)
                Storage.Delete(Storage.CurrentContext, Key(Prefix_Instance, accountId));
        }

        /// <summary>Deletes every key of one instance namespace: <c>prefix ‖ accountId ‖ moduleId</c>.</summary>
        internal static void DeleteInstancePrefix(byte[] prefix, UInt160 accountId, BigInteger moduleId)
        {
            Storage.Delete(Storage.CurrentContext, Key(prefix, accountId, moduleId));
            Iterator iterator = Storage.Find(Storage.CurrentContext, Key(prefix, accountId, moduleId),
                FindOptions.KeysOnly);
            while (iterator.Next())
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
        }

        /// <summary>The pinned core as raw 20 bytes, for digest domains.</summary>
        internal static byte[] CoreHash()
        {
            UInt160 core = RequireCoreConfigured();
            return (byte[])core;
        }

        /// <summary>
        /// The instance the core is currently running, for a callback that does
        /// not receive the module id (spec §9, validateUserOp).
        /// </summary>
        internal static BigInteger RequireValidationInstance(UInt160 accountId) =>
            RequireInstance(accountId, ModuleProtocol.PhaseValidation);

        internal static BigInteger RequireConfigurationInstance(UInt160 accountId) =>
            RequireInstance(accountId, ModuleProtocol.PhaseConfiguration);

        internal static BigInteger RequirePlanningInstance(UInt160 accountId) =>
            RequireInstance(accountId, ModuleProtocol.PhaseHookPlanning);

        private static BigInteger RequireInstance(UInt160 accountId, int phase)
        {
            RequireCore();
            BigInteger moduleId = (BigInteger)Contract.Call(RequireCoreConfigured(), CoreGetAuthorizedModuleId,
                CallFlags.ReadOnly, new object[] { accountId, phase });
            ExecutionEngine.Assert(moduleId > 0, ErrUnauthorized);
            return moduleId;
        }

        /// <summary>Every installed instance id of one module kind ("validator", "hook", "recovery").</summary>
        internal static BigInteger[] InstalledModuleIds(UInt160 accountId, string moduleType, int limit)
        {
            object[] page = InstalledModulePage(accountId, moduleType, BigInteger.Zero, limit);
            object[] ids = (object[])page[FieldModuleIds];
            BigInteger[] result = new BigInteger[ids.Length];
            for (int i = 0; i < ids.Length; i++) result[i] = (BigInteger)ids[i];
            return result;
        }

        /// <summary>One <c>getModules</c> page: <c>[ids, nextCursor, configurationNonce]</c>. The core limits
        /// a page to 1..32 entries, so a composition larger than one page is read by advancing the cursor.</summary>
        internal static object[] InstalledModulePage(UInt160 accountId, string moduleType, BigInteger cursor, int limit) =>
            (object[])Contract.Call(RequireCoreConfigured(), CoreGetModules, CallFlags.ReadOnly,
                new object[] { accountId, moduleType, cursor, limit });

        /// <summary>
        /// The full <c>getModule</c> descriptor of one installed instance:
        /// [moduleId, moduleType, contractHash, contractId, updateCounter,
        /// nefSha256, profileSha256, moduleRevision, credentialGeneration,
        /// instanceIsolation, messageCapability, thresholdMemberEligible,
        /// compositeLayer, governance, hookPlanner].
        /// A short answer means the id is not installed on that account.
        /// </summary>
        internal static object[] ModuleDescriptor(UInt160 accountId, BigInteger moduleId)
        {
            ExecutionEngine.Assert(moduleId >= 1, ErrOperationMalformed);
            object[] module = (object[])Contract.Call(RequireCoreConfigured(), CoreGetModule, CallFlags.ReadOnly,
                new object[] { accountId, moduleId });
            ExecutionEngine.Assert(module.Length > FieldModuleHookPlanner, ErrModuleNotInstalled);
            return module;
        }

        // ---- core transitions ----

        /// <summary><c>unfreezeAccount(accountId)</c>: leaving Frozen is immediate once it is confirmed.</summary>
        internal static void UnfreezeAccount(UInt160 accountId)
        {
            Contract.Call(RequireCoreConfigured(), CoreUnfreezeAccount, CallFlags.All,
                new object[] { accountId });
        }

        // ---- restricted core landing entries (spec §9/§10) ----

        /// <summary>
        /// <c>revokeModuleCredentials(accountId, moduleId)</c>: the landing write
        /// behind the orchestrator's <c>revokeCredentials</c> — the core bumps
        /// the validator instance's credential generation and the account's
        /// configuration nonce in the same call frame. The core re-checks that
        /// the target is an installed validator and the caller's authority
        /// (custody witness, or an installed validator contract witnessing —
        /// which is this module itself when it calls).
        /// </summary>
        internal static void RevokeModuleCredentials(UInt160 accountId, BigInteger moduleId)
        {
            Contract.Call(RequireCoreConfigured(), CoreRevokeModuleCredentials, CallFlags.All,
                new object[] { accountId, moduleId });
        }

        /// <summary>
        /// <c>resetAccount(accountId, newCustody)</c>: the §10 core-side reset,
        /// the only transition that re-lands an account at its registration
        /// defaults. The core accepts exactly one caller — the account's
        /// installed recovery seat (module type 5) — so this helper exists for
        /// the RecoveryModule's mature <c>executeRecovery</c> alone; a validator
        /// or governance module has no business calling it.
        /// </summary>
        internal static void ResetAccount(UInt160 accountId, UInt160 newCustody)
        {
            Contract.Call(RequireCoreConfigured(), CoreResetAccount, CallFlags.All,
                new object[] { accountId, newCustody });
        }

        /// <summary>
        /// <c>applyConfigurationActions(accountId, actions)</c>: from the reset seat, inside the
        /// same transaction as the reset, the core accepts one install-only composition on
        /// the epoch the reset just opened. Any other caller reaches the normal governance
        /// landing and fails closed.
        /// </summary>
        internal static void ApplyConfigurationActions(UInt160 accountId, object[] actions)
        {
            Contract.Call(RequireCoreConfigured(), CoreApplyConfigurationActions, CallFlags.All,
                new object[] { accountId, actions });
        }

        // ---- storage keys ----

        /// <summary><c>prefix ‖ accountId (20 raw bytes)</c>.</summary>
        internal static byte[] Key(byte[] prefix, UInt160 accountId) =>
            Helper.Concat(prefix, (byte[])accountId);

        /// <summary><c>prefix ‖ accountId ‖ id (8 bytes, big-endian)</c>.</summary>
        internal static byte[] Key(byte[] prefix, UInt160 accountId, BigInteger id) =>
            Helper.Concat(Helper.Concat(prefix, (byte[])accountId), U64BE(id));

        /// <summary><c>prefix ‖ accountId ‖ moduleId ‖ id</c>, for instance-scoped rows with a second key.</summary>
        internal static byte[] Key(byte[] prefix, UInt160 accountId, BigInteger moduleId, BigInteger id) =>
            Helper.Concat(Helper.Concat(Helper.Concat(prefix, (byte[])accountId), U64BE(moduleId)), U64BE(id));

        internal static byte[] U64BE(BigInteger value)
        {
            ExecutionEngine.Assert(value >= 0 && value < (BigInteger.One << 64), ErrOperationMalformed);
            byte[] encoded = new byte[8];
            for (int i = 7; i >= 0; i--)
            {
                encoded[i] = (byte)(value & 255);
                value >>= 8;
            }
            return encoded;
        }

        internal static byte[] U32LE(BigInteger value)
        {
            ExecutionEngine.Assert(value >= 0 && value < (BigInteger.One << 32), ErrOperationMalformed);
            byte[] encoded = new byte[4];
            for (int i = 0; i < 4; i++)
            {
                encoded[i] = (byte)(value & 255);
                value >>= 8;
            }
            return encoded;
        }

        /// <summary>Strict copy of a value array so a caller mutating its input cannot rewrite stored state.</summary>
        internal static object[] Copy(object[]? source)
        {
            ExecutionEngine.Assert(source != null, ErrOperationMalformed);
            object[] copy = new object[source!.Length];
            for (int i = 0; i < source.Length; i++) copy[i] = source[i];
            return copy;
        }
    }
}
