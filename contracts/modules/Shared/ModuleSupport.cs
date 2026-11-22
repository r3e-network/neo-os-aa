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

        internal const int MaxValidatorInstances = 32;

        // Registration / configuration action codes (spec §10/§11, Table 16).
        internal const int ActionInstallModule = 1;
        internal const int ActionUninstallModule = 2;
        internal const int ActionConfigureModule = 3;
        internal const int ActionSetHookOrder = 4;
        internal const int ActionSetBuiltinAuthorization = 5;
        internal const int ActionRebindModule = 6;
        internal const int ActionSetThresholdPolicy = 7;
        internal const int ActionSetMessageSubjects = 9;
        internal const int ActionMigrateImport = 10;
        internal const int ActionUnfreeze = 11;

        // Governance action 8: the restricted recovery-policy write. Its
        // timelock domain is the §12.5 / R-12-03 window (7–90 days); the core
        // re-validates it inside setRecoveryPolicy, so a proposal that passes
        // here can never smuggle an out-of-domain timelock to the core.
        internal const int ActionSetRecoveryPolicy = 8;
        internal const long RecoveryTimelockMinMs = 604_800_000L;
        internal const long RecoveryTimelockMaxMs = 7_776_000_000L;

        // Account status codes (spec §7.2).
        internal const int StatusActive = 0;
        internal const int StatusFrozen = 1;
        internal const int StatusMigrationRequired = 2;

        // Module error symbols (spec Appendix C, Table 45): the spellings are
        // normative; an assertion may append a detail suffix after a single
        // space, but the prefix must match the table byte for byte (C-25).
        internal const string ErrIntentImmature = "SA_INTENT_IMMATURE";
        internal const string ErrIntentExpired = "SA_INTENT_EXPIRED";
        internal const string ErrIntentConflict = "SA_INTENT_CONFLICT";
        internal const string ErrIntentNotFound = "SA_INTENT_NOT_FOUND";
        internal const string ErrIntentLimit = "SA_INTENT_LIMIT";
        internal const string ErrModuleLimitActions = "SA_MODULE_LIMIT_ACTIONS";
        internal const string ErrModuleLimitIntents = "SA_MODULE_LIMIT_INTENTS";
        internal const string ErrRecoveryPending = "SA_RECOVERY_PENDING";
        internal const string ErrRecoveryLocked = "SA_RECOVERY_LOCKED";
        internal const string ErrMessageInvalid = "SA_MESSAGE_INVALID";
        internal const string ErrModuleMessageCapabilityAbsent = "SA_MODULE_MESSAGE_CAPABILITY_ABSENT";
        internal const string ErrHookRejected = "SA_HOOK_REJECTED";
        internal const string ErrHookDataTooLarge = "SA_HOOK_DATA_TOO_LARGE";
        internal const string ErrProofInvalid = "SA_PROOF_INVALID";
        internal const string ErrModuleLimitMembers = "SA_MODULE_LIMIT_MEMBERS";

        // Core error symbols (Appendix C, Table 44) reused for module-side
        // cases Table 45 does not cover — nearest existing symbol per the
        // C-25 fallback rule; every reuse is listed in the task report.
        internal const string ErrOperationMalformed = "SA_OPERATION_MALFORMED";
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
    /// Shared plumbing for the standard user-space modules (§11-§15).
    ///
    /// The minimal native core publishes registration, freeze/unfreeze,
    /// execution and module administration. Everything the standard modules do
    /// on top of that is an ordinary contract call: they read the account
    /// descriptor from the core, apply their own storage, and drive the two
    /// module-administration entrypoints when a policy change is due.
    ///
    /// Authority is never a caller-declared value. A module asks the core for
    /// the account state and checks a witness:
    ///
    ///   * <see cref="RequireAccountAdministration"/> mirrors the core's own
    ///     rule for installModule/removeModule — the custody witness, or the
    ///     witness of an installed validator contract;
    ///   * <see cref="RequireCustody"/> is the narrower "the custodian asked for
    ///     this" gate a recovery module needs to start a recovery;
    ///   * <see cref="RequireCore"/> is the "the core is running this operation"
    ///     gate for callbacks the core dispatches.
    /// </summary>
    internal static class ModuleSupport
    {
        private static readonly byte[] Prefix_Admin = new byte[] { 0xF0 };
        private static readonly byte[] Prefix_Core = new byte[] { 0xF1 };

        private const string CoreGetAccount = "getAccount";
        private const string CoreGetAccountAddress = "getAccountAddress";
        private const string CoreGetModules = "getModules";
        private const string CoreGetModule = "getModule";
        private const string CoreGetAuthorizedModuleId = "getAuthorizedModuleId";
        private const string CoreInstallModule = "installModule";
        private const string CoreRemoveModule = "removeModule";
        private const string CoreUnfreezeAccount = "unfreezeAccount";
        private const string CoreSetRecoveryPolicy = "setRecoveryPolicy";
        private const string CoreRevokeModuleCredentials = "revokeModuleCredentials";
        private const string CoreResetAccount = "resetAccount";
        private const string CoreSetBuiltinAuthorization = "setBuiltinAuthorization";

        // getAccount(accountId) field indices (spec §7.2).
        private const int FieldExists = 0;
        private const int FieldStatus = 1;
        private const int FieldCustody = 2;
        private const int FieldRecoveryAuthority = 3;
        private const int FieldAuthorityEpoch = 4;
        private const int FieldConfigurationNonce = 5;
        private const int FieldRecoveryTimelockMs = 6;

        // getModules page / getModule descriptor indices (spec §3.3).
        private const int FieldModuleIds = 0;
        internal const int FieldModuleType = 1;
        internal const int FieldModuleContractHash = 2;
        internal const int FieldModuleMessageCapability = 10;

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
            ExecutionEngine.Assert(record.Length > FieldRecoveryTimelockMs, "SA_ACCOUNT_NOT_FOUND");
            ExecutionEngine.Assert((bool)record[FieldExists], "SA_ACCOUNT_NOT_FOUND");
            return record;
        }

        internal static BigInteger AccountStatus(UInt160 accountId) =>
            (BigInteger)AccountRecord(accountId)[FieldStatus];

        internal static UInt160 Custody(UInt160 accountId) =>
            (UInt160)AccountRecord(accountId)[FieldCustody];

        internal static UInt160 RecoveryAuthority(UInt160 accountId) =>
            (UInt160)AccountRecord(accountId)[FieldRecoveryAuthority];

        /// <summary>
        /// The delay the account itself recorded at registration. A module never
        /// invents a maturity window: it uses the one the account committed to.
        /// </summary>
        internal static BigInteger RecoveryTimelockMs(UInt160 accountId) =>
            (BigInteger)AccountRecord(accountId)[FieldRecoveryTimelockMs];

        /// <summary>The account's current authority epoch (getAccount field 4, spec §7.2).</summary>
        internal static BigInteger AccountAuthorityEpoch(UInt160 accountId) =>
            (BigInteger)AccountRecord(accountId)[FieldAuthorityEpoch];

        /// <summary>The account's current configuration nonce (getAccount field 5, spec §7.2).</summary>
        internal static BigInteger AccountConfigurationNonce(UInt160 accountId) =>
            (BigInteger)AccountRecord(accountId)[FieldConfigurationNonce];

        /// <summary>The script hash that holds the account's assets on this core.</summary>
        internal static UInt160 AssetAddress(UInt160 accountId) =>
            (UInt160)Contract.Call(RequireCoreConfigured(), CoreGetAccountAddress, CallFlags.ReadOnly,
                new object[] { accountId });

        internal static void RequireActiveAccount(UInt160 accountId)
        {
            ExecutionEngine.Assert(AccountStatus(accountId) == ModuleProtocol.StatusActive, "SA_ACCOUNT_STATUS");
        }

        /// <summary>
        /// The thaw path's status gate (audit H-2, spec §11/§12): a frozen account
        /// must still be able to propose and confirm the unfreeze intent that is
        /// its only way out, so `Active` and `Frozen` both pass. `MigrationRequired`
        /// and any other status is refused — an unfreeze must not give a migrating
        /// account execution capability (R-11-14).
        /// </summary>
        internal static void RequireActiveOrFrozenAccount(UInt160 accountId)
        {
            BigInteger status = AccountStatus(accountId);
            ExecutionEngine.Assert(
                status == ModuleProtocol.StatusActive || status == ModuleProtocol.StatusFrozen,
                "SA_ACCOUNT_STATUS");
        }

        // ---- authority ----

        /// <summary>
        /// The core's own module-administration rule: the custody witness, or
        /// the witness of one installed validator contract. The scan is bounded
        /// by the validator instance limit, so it is never unbounded work.
        /// </summary>
        internal static void RequireAccountAdministration(UInt160 accountId)
        {
            UInt160 custody = Custody(accountId);
            if (custody != UInt160.Zero && custody.IsValid && Runtime.CheckWitness(custody)) return;
            foreach (UInt160 contractHash in InstalledValidators(accountId))
                if (contractHash != UInt160.Zero && contractHash.IsValid && Runtime.CheckWitness(contractHash)) return;
            ExecutionEngine.Assert(false, "SA_UNAUTHORIZED");
        }

        internal static void RequireCustody(UInt160 accountId)
        {
            UInt160 custody = Custody(accountId);
            ExecutionEngine.Assert(custody != UInt160.Zero && custody.IsValid, "SA_UNAUTHORIZED");
            ExecutionEngine.Assert(Runtime.CheckWitness(custody), "SA_UNAUTHORIZED");
        }

        /// <summary>Custody witness, or the recovery authority the account recorded.</summary>
        internal static void RequireCustodyOrRecovery(UInt160 accountId)
        {
            UInt160 custody = Custody(accountId);
            if (custody != UInt160.Zero && custody.IsValid && Runtime.CheckWitness(custody)) return;
            UInt160 recovery = RecoveryAuthority(accountId);
            ExecutionEngine.Assert(recovery != UInt160.Zero && recovery.IsValid && Runtime.CheckWitness(recovery),
                "SA_UNAUTHORIZED");
        }

        /// <summary>Every installed validator contract hash of one account.</summary>
        internal static UInt160[] InstalledValidators(UInt160 accountId)
        {
            object[] page = (object[])Contract.Call(RequireCoreConfigured(), CoreGetModules, CallFlags.ReadOnly,
                new object[] { accountId, "validator", BigInteger.Zero, ModuleProtocol.MaxValidatorInstances });
            object[] ids = (object[])page[FieldModuleIds];
            UInt160[] hashes = new UInt160[ids.Length];
            for (int i = 0; i < ids.Length; i++)
            {
                object[] module = (object[])Contract.Call(RequireCoreConfigured(), CoreGetModule, CallFlags.ReadOnly,
                    new object[] { accountId, (BigInteger)ids[i] });
                hashes[i] = module.Length > FieldModuleContractHash
                    ? (UInt160)module[FieldModuleContractHash]
                    : UInt160.Zero;
            }
            return hashes;
        }

        /// <summary>
        /// The instance the core is currently running, for a callback that does
        /// not receive the module id (spec §9, validateUserOp).
        /// </summary>
        internal static BigInteger RequireValidationInstance(UInt160 accountId)
        {
            RequireCore();
            BigInteger moduleId = (BigInteger)Contract.Call(RequireCoreConfigured(), CoreGetAuthorizedModuleId,
                CallFlags.ReadOnly, new object[] { accountId, ModuleProtocol.PhaseValidation });
            ExecutionEngine.Assert(moduleId > 0, ErrUnauthorized);
            return moduleId;
        }

        /// <summary>Every installed instance id of one module kind ("validator", "hook", "recovery").</summary>
        internal static BigInteger[] InstalledModuleIds(UInt160 accountId, string moduleType, int limit)
        {
            object[] page = (object[])Contract.Call(RequireCoreConfigured(), CoreGetModules, CallFlags.ReadOnly,
                new object[] { accountId, moduleType, BigInteger.Zero, limit });
            object[] ids = (object[])page[FieldModuleIds];
            BigInteger[] result = new BigInteger[ids.Length];
            for (int i = 0; i < ids.Length; i++) result[i] = (BigInteger)ids[i];
            return result;
        }

        /// <summary>
        /// The full <c>getModule</c> descriptor of one installed instance:
        /// [moduleId, moduleType, contractHash, contractId, updateCounter,
        /// nefSha256, profileSha256, moduleRevision, credentialGeneration,
        /// instanceIsolation, messageCapability, thresholdMemberEligible].
        /// A short answer means the id is not installed on that account.
        /// </summary>
        internal static object[] ModuleDescriptor(UInt160 accountId, BigInteger moduleId)
        {
            ExecutionEngine.Assert(moduleId >= 1, ErrOperationMalformed);
            object[] module = (object[])Contract.Call(RequireCoreConfigured(), CoreGetModule, CallFlags.ReadOnly,
                new object[] { accountId, moduleId });
            ExecutionEngine.Assert(module.Length > FieldModuleMessageCapability, ErrModuleNotInstalled);
            return module;
        }

        // ---- core transitions ----

        /// <summary>
        /// <c>installModule(accountId, moduleType, contractHash, declaredDigest, initData)</c>:
        /// the core allocates the module id, so the module never guesses one.
        ///
        /// <paramref name="declaredDigest"/> is the 32-byte profile digest a
        /// governance proposal pinned when it reviewed the action (audit M-2). The
        /// core's public <c>installModule</c> ABI declares no digest — only the
        /// atomic registration actions of <c>createAccount</c> carry one and have
        /// the shared core compare it — so this module enforces the same
        /// comparison itself before handing the install to the core: the live
        /// <c>getModuleProfile()</c> reply of the contract being installed is
        /// hashed and must equal the declared digest, otherwise the reviewed
        /// profile and the installed profile differ and the install is refused.
        /// Pass null for an unreviewed install (parity with the core's public
        /// entry, which declares no digest).
        /// </summary>
        internal static BigInteger InstallModule(UInt160 accountId, int moduleType, UInt160 contractHash,
            ByteString? declaredDigest, object[] initData)
        {
            if (declaredDigest != null)
            {
                ExecutionEngine.Assert(declaredDigest.Length == 32, ErrOperationMalformed);
                ByteString profile = (ByteString)Contract.Call(contractHash, "getModuleProfile",
                    CallFlags.ReadOnly, new object[0]);
                ExecutionEngine.Assert(profile != null && profile.Length > 0, ErrModuleCodeBindingMismatch);
                ExecutionEngine.Assert(
                    StdLib.MemoryCompare(CryptoLib.Sha256(profile!), declaredDigest) == 0,
                    ErrModuleCodeBindingMismatch);
            }
            return (BigInteger)Contract.Call(RequireCoreConfigured(), CoreInstallModule, CallFlags.All,
                new object[] { accountId, moduleType, contractHash, initData });
        }

        /// <summary><c>removeModule(accountId, moduleId, deInitData)</c>.</summary>
        internal static void RemoveModule(UInt160 accountId, BigInteger moduleId, object[] deInitData)
        {
            Contract.Call(RequireCoreConfigured(), CoreRemoveModule, CallFlags.All,
                new object[] { accountId, moduleId, deInitData });
        }

        /// <summary><c>unfreezeAccount(accountId)</c>: leaving Frozen is immediate once it is confirmed.</summary>
        internal static void UnfreezeAccount(UInt160 accountId)
        {
            Contract.Call(RequireCoreConfigured(), CoreUnfreezeAccount, CallFlags.All,
                new object[] { accountId });
        }

        // ---- restricted core landing entries (spec §7.1/§11.5/§12.5, audit H-3/H-4) ----

        /// <summary><c>setRecoveryPolicy(accountId, recoveryAuthority, recoveryTimelockMs,
        /// ownerOnlyRecovery)</c>: the landing write of governance action 8.
        /// The core re-checks the authority domain (custody witness or an
        /// installed validator contract — a governance module calling this is
        /// the latter), the timelock window and the account state, so the four
        /// values are handed through as the confirmed intent named them.
        /// </summary>
        internal static void SetRecoveryPolicy(UInt160 accountId, UInt160 recoveryAuthority,
            BigInteger recoveryTimelockMs, bool ownerOnlyRecovery)
        {
            Contract.Call(RequireCoreConfigured(), CoreSetRecoveryPolicy, CallFlags.All,
                new object[] { accountId, recoveryAuthority, recoveryTimelockMs, ownerOnlyRecovery });
        }

        /// <summary>
        /// <c>setBuiltinAuthorization(accountId, defaultOperationAuthorization,
        /// defaultMessageAuthorization)</c>: the landing write of governance
        /// action 5 (spec §7.1/§11.5, R-07-14). The core re-checks the
        /// caller's authority (R-07-11 family — a governance module calling
        /// this is the installed-validator arm), the account state and the
        /// last-route guard (<c>SA_BUILTIN_ROUTE_REQUIRED</c>), so the two
        /// switch values are handed through as the confirmed intent named
        /// them. Aligned with <see cref="SetRecoveryPolicy"/>'s style.
        /// </summary>
        internal static void SetBuiltinAuthorization(UInt160 accountId, bool defaultOperationAuthorization,
            bool defaultMessageAuthorization)
        {
            Contract.Call(RequireCoreConfigured(), CoreSetBuiltinAuthorization, CallFlags.All,
                new object[] { accountId, defaultOperationAuthorization, defaultMessageAuthorization });
        }

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
        /// <c>resetAccount(accountId, newCustody)</c>: the §12.5 core-side reset,
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

        // ---- storage keys ----

        /// <summary><c>prefix ‖ accountId (20 raw bytes)</c>.</summary>
        internal static byte[] Key(byte[] prefix, UInt160 accountId) =>
            Helper.Concat(prefix, (byte[])accountId);

        /// <summary><c>prefix ‖ accountId ‖ id (8 bytes, big-endian)</c>.</summary>
        internal static byte[] Key(byte[] prefix, UInt160 accountId, BigInteger id) =>
            Helper.Concat(Helper.Concat(prefix, (byte[])accountId), U64BE(id));

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

        /// <summary>Deletes every key under one prefix.</summary>
        internal static void DeletePrefix(byte[] prefix)
        {
            Iterator iterator = Storage.Find(Storage.CurrentContext, prefix, FindOptions.KeysOnly);
            while (iterator.Next())
                Storage.Delete(Storage.CurrentContext, (ByteString)iterator.Value);
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
