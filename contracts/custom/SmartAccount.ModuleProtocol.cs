using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    /// <summary>
    /// Shared SA module-protocol constants (protocol version 4).
    ///
    /// This partial intentionally contains NO state, NO storage access and NO
    /// business logic: it only declares the shared protocol constants and the
    /// fixed-width key builders that both the ordinary kernel (#39) and — via the
    /// paired native file — the native kernel (#40) must consume. The authoritative
    /// specification is docs/SA-MODULE-PROTOCOL.md (Chinese counterpart
    /// docs/SA-MODULE-PROTOCOL.zh-CN.md).
    ///
    /// PAIRED FILE: contracts/native/SmartAccount/
    /// SmartAccountModuleProtocol.cs. The two files MUST carry identical numeric
    /// values at all times; a divergence is a protocol defect, not an
    /// implementation choice.
    /// </summary>
    public partial class SmartAccount
    {
        // ========================================================================
        // 1. Protocol identity (spec §1, §4)
        // ========================================================================

        private const int ModuleProtocolVersion = 4;
        private const int UserOperationFieldCount = 13;

        // Field indices of the canonical v4 UserOperation Array (spec §4.1).
        private const int OpVersion = 0;
        private const int OpTarget = 1;
        private const int OpMethod = 2;
        private const int OpArgs = 3;
        private const int OpNonce = 4;
        private const int OpNonceSubkey = 5;
        private const int OpDeadline = 6;
        private const int OpValidatorId = 7;
        private const int OpCredentialGeneration = 8;
        private const int OpAuthorityEpoch = 9;
        private const int OpConfigurationNonce = 10;
        private const int OpSignature = 11;
        private const int OpHookProofs = 12;

        // Module type codes (ERC-7579 numbering; only 1 and 4 are supported).
        // NOTE: the legacy string constants ModuleTypeVerifier/ModuleTypeHook in
        // SmartAccount.Events.cs are old-model event labels, not protocol codes.
        private const int ModuleTypeCodeValidator = 1;
        private const int ModuleTypeCodeHook = 4;

        // ========================================================================
        // 2. Profile limits (spec §3)
        // ========================================================================

        private const int MaxValidatorModuleInstances = 32;
        private const int MaxHookModuleInstances = 8;
        private const int MaxThresholdPolicyMembers = 10;
        private const int MinThresholdPolicyValue = 1;
        private const int MaxThresholdPolicyValue = 10;
        private const int MaxActionsPerConfigurationIntent = 16;
        private const int MaxActiveConfigurationIntents = 16;
        private const int MaxOperationsPerEnvelope = 32;
        private const int MinEnumerationLimit = 1;
        private const int MaxEnumerationLimit = 32;
        // Canonical module profile (spec §12).
        private const int ModuleProfileVersion = 1;
        private const int ModuleProfileBytesMax = 2048;
        private const int ModuleCompositeLayerMax = 1;

        // ========================================================================
        // 3. Encoding bounds (spec §4)
        // ========================================================================

        private const int NonceSubkeySize = 32;
        private const int NonceChannelSize = 24;          // 191-bit channel, BE, top bits zero
        private const int MethodBytesMax = 128;
        private const int ArgsCountMax = 64;
        private const int ArgsDepthMax = 8;
        private const int ArgsSerializedSizeMax = 4096;
        private const int SignatureBytesMax = 8192;
        private const int HookProofsEntriesMax = 8;
        private const int HookProofBytesMax = 4096;       // aggregate across entries
        private const int HookDataBytesMax = 512;
        private const int OperationEncodedSizeMax = 16384;
        private const int EnvelopeEncodedSizeMax = 65536;
        private const int MessageSubjectKeysMax = 16;
        private const int MessageHashSize = 32;
        private const int P256SignatureSize = 64;

        // ========================================================================
        // 4. Timelocks and validity windows (spec §10)
        // ========================================================================

        private const ulong ModuleChangeDelayMs = 86_400_000;        // 24 h
        private const ulong ConfigurationIntentExpiryMs = 604_800_000; // matureAt + 7 days
        private const ulong RecoveryTimelockMinMs = 604_800_000;    // 7 days
        private const ulong RecoveryTimelockMaxMs = 7_776_000_000;  // 90 days

        // ========================================================================
        // 5. Gas hard budget profile — approved Plan B (spec §11)
        //    Unit: datoshi, 1 GAS = 100_000_000. Values match the existing
        //    System.Contract.CallWithGasLimit unit used by this contract.
        // ========================================================================

        private const long GasFactorDatoshi = 100_000_000;
        private const long ValidationAggregateGasLimit = 100_000_000;  // 1 GAS, shared by the routed validator and all threshold members
        private const long HookCallbackGasLimit = 250_000_000;        // 2.5 GAS per preCheck/postCheck
        private const long ValidatorCompletionGasLimit = 100_000_000; // 1 GAS aggregate
        private const long LifecycleCallbackGasLimit = 250_000_000;    // 2.5 GAS per onInstall/onUninstall/configure

        // ========================================================================
        // 6. Signing domains and ERC-1271 magic (spec §4.3, §8)
        // ========================================================================

        private const string UserOperationDomain = "NeoSmartAccount/UserOperation";
        private const string MessageDomain = "NeoSmartAccount/Message";
        private const uint MagicIsValidSignature = 0x1626ba7e; // ERC-1271 MAGICVALUE
        private const uint MagicInvalidSignature = 0xffffffff;

        // ========================================================================
        // 7. Storage prefixes — shared 0x50–0x5F region (spec §7.1)
        //    Key shapes:
        //      0x50 bare
        //      0x51/0x54/0x57/0x58/0x59/0x5A/0x5D/0x5E  +acctId
        //      0x52 +acctId+moduleId[8 BE]
        //      0x53 +acctId+type[1]+moduleId[8 BE]
        //      0x55 +acctId+intentId[8 BE]
        //      0x56/0x5C +acctId+channel[24 BE]
        //      0x5B +acctId+policyId[8 BE]
        //    0x5F is reserved and never declared. All integer key suffixes are
        //    fixed-width big-endian; account bytes are the raw UInt160 bytes.
        //    Legacy prefixes 0x01 (migration input) and 0x12/0x1C (retired,
        //    invalidation declared in 0x5A) are NOT redeclared here.
        // ========================================================================

        private static readonly byte[] Prefix_ProtocolInfo = new byte[] { 0x50 };
        private static readonly byte[] Prefix_AccountControl = new byte[] { 0x51 };
        private static readonly byte[] Prefix_ModuleInstance = new byte[] { 0x52 };
        private static readonly byte[] Prefix_ModuleIndex = new byte[] { 0x53 };
        private static readonly byte[] Prefix_HookOrder = new byte[] { 0x54 };
        private static readonly byte[] Prefix_ConfigIntent = new byte[] { 0x55 };
        private static readonly byte[] Prefix_NonceCursor = new byte[] { 0x56 };
        private static readonly byte[] Prefix_MessageSubject = new byte[] { 0x57 };
        private static readonly byte[] Prefix_ApplicationContext = new byte[] { 0x58 };
        private static readonly byte[] Prefix_CoreRecovery = new byte[] { 0x59 };
        private static readonly byte[] Prefix_MigrationState = new byte[] { 0x5A };
        private static readonly byte[] Prefix_ThresholdPolicy = new byte[] { 0x5B };
        private static readonly byte[] Prefix_NonceNamespace = new byte[] { 0x5C };
        private static readonly byte[] Prefix_MarketControlEpoch = new byte[] { 0x5D };
        private static readonly byte[] Prefix_ConfigIntentIndex = new byte[] { 0x5E };

        // ========================================================================
        // 8. Canonical key builders (spec §7.1)
        //    Fixed-width big-endian integer suffixes; raw 20-byte account ids.
        //    The kernel partials compose these with Storage.CurrentContext.
        // ========================================================================

        private static byte[] UInt64ToBigEndian(ulong value)
        {
            byte[] result = new byte[8];
            ulong remaining = value;
            for (int i = 7; i >= 0; i--)
            {
                result[i] = (byte)(remaining & 0xFF);
                remaining >>= 8;
            }
            return result;
        }

        private static byte[] ProtocolInfoKey() => Prefix_ProtocolInfo;

        private static byte[] AccountControlKey(UInt160 accountId) =>
            Helper.Concat(Prefix_AccountControl, (byte[])accountId);

        private static byte[] ModuleInstanceKey(UInt160 accountId, ulong moduleId) =>
            Helper.Concat(Helper.Concat(Prefix_ModuleInstance, (byte[])accountId), UInt64ToBigEndian(moduleId));

        private static byte[] ModuleIndexKey(UInt160 accountId, int moduleType, ulong moduleId) =>
            Helper.Concat(
                Helper.Concat(Helper.Concat(Prefix_ModuleIndex, (byte[])accountId), new byte[] { (byte)moduleType }),
                UInt64ToBigEndian(moduleId));

        private static byte[] HookOrderKey(UInt160 accountId) =>
            Helper.Concat(Prefix_HookOrder, (byte[])accountId);

        private static byte[] ConfigIntentKey(UInt160 accountId, ulong intentId) =>
            Helper.Concat(Helper.Concat(Prefix_ConfigIntent, (byte[])accountId), UInt64ToBigEndian(intentId));

        private static byte[] NonceCursorKey(UInt160 accountId, byte[] channel) =>
            Helper.Concat(Helper.Concat(Prefix_NonceCursor, (byte[])accountId), channel);

        private static byte[] NonceNamespaceKey(UInt160 accountId, byte[] channel) =>
            Helper.Concat(Helper.Concat(Prefix_NonceNamespace, (byte[])accountId), channel);

        private static byte[] MessageSubjectKey(UInt160 accountId) =>
            Helper.Concat(Prefix_MessageSubject, (byte[])accountId);

        private static byte[] ApplicationContextKey(UInt160 accountId) =>
            Helper.Concat(Prefix_ApplicationContext, (byte[])accountId);

        private static byte[] CoreRecoveryKey(UInt160 accountId) =>
            Helper.Concat(Prefix_CoreRecovery, (byte[])accountId);

        private static byte[] MigrationStateKey(UInt160 accountId) =>
            Helper.Concat(Prefix_MigrationState, (byte[])accountId);

        private static byte[] ThresholdPolicyKey(UInt160 accountId, ulong policyId) =>
            Helper.Concat(Helper.Concat(Prefix_ThresholdPolicy, (byte[])accountId), UInt64ToBigEndian(policyId));

        private static byte[] MarketControlEpochKey(UInt160 accountId) =>
            Helper.Concat(Prefix_MarketControlEpoch, (byte[])accountId);

        private static byte[] ConfigIntentIndexKey(UInt160 accountId) =>
            Helper.Concat(Prefix_ConfigIntentIndex, (byte[])accountId);

        // ========================================================================
        // 9. Error codes (spec §17) — stable SA_* string constants shared
        //    verbatim with the native constants file.
        // ========================================================================

        private const string ErrorProtocolVersion = "SA_PROTOCOL_VERSION";
        private const string ErrorOperationMalformed = "SA_OPERATION_MALFORMED";
        private const string ErrorOperationFieldCount = "SA_OPERATION_FIELD_COUNT";
        private const string ErrorModuleTypeUnsupported = "SA_MODULE_TYPE_UNSUPPORTED";
        private const string ErrorModuleLimitValidator = "SA_MODULE_LIMIT_VALIDATOR";
        private const string ErrorModuleLimitHook = "SA_MODULE_LIMIT_HOOK";
        private const string ErrorModuleLimitThreshold = "SA_MODULE_LIMIT_THRESHOLD";
        private const string ErrorModuleLimitMembers = "SA_MODULE_LIMIT_MEMBERS";
        private const string ErrorModuleLimitActions = "SA_MODULE_LIMIT_ACTIONS";
        private const string ErrorModuleLimitIntents = "SA_MODULE_LIMIT_INTENTS";
        private const string ErrorModuleLimitBatch = "SA_MODULE_LIMIT_BATCH";
        private const string ErrorModuleNotInstalled = "SA_MODULE_NOT_INSTALLED";
        private const string ErrorModuleIdInvalid = "SA_MODULE_ID_INVALID";
        private const string ErrorModuleInstanceIsolationRequired = "SA_MODULE_INSTANCE_ISOLATION_REQUIRED";
        private const string ErrorModuleCodeBindingMismatch = "SA_MODULE_CODE_BINDING_MISMATCH";
        private const string ErrorModuleNotRoutable = "SA_MODULE_NOT_ROUTABLE";
        private const string ErrorModuleMessageCapabilityAbsent = "SA_MODULE_MESSAGE_CAPABILITY_ABSENT";
        private const string ErrorValidationRejected = "SA_VALIDATION_REJECTED";
        private const string ErrorValidatorNotFound = "SA_VALIDATOR_NOT_FOUND";
        private const string ErrorHookRejected = "SA_HOOK_REJECTED";
        private const string ErrorHookDataTooLarge = "SA_HOOK_DATA_TOO_LARGE";
        private const string ErrorProofInvalid = "SA_PROOF_INVALID";
        private const string ErrorNonceInvalid = "SA_NONCE_INVALID";
        private const string ErrorNonceExhausted = "SA_NONCE_EXHAUSTED";
        private const string ErrorNonceChannelCollision = "SA_NONCE_CHANNEL_COLLISION";
        private const string ErrorDeadlineExpired = "SA_DEADLINE_EXPIRED";
        private const string ErrorEpochStale = "SA_EPOCH_STALE";
        private const string ErrorConfigurationNonceStale = "SA_CONFIGURATION_NONCE_STALE";
        private const string ErrorCredentialStale = "SA_CREDENTIAL_STALE";
        private const string ErrorIntentImmature = "SA_INTENT_IMMATURE";
        private const string ErrorIntentExpired = "SA_INTENT_EXPIRED";
        private const string ErrorIntentConflict = "SA_INTENT_CONFLICT";
        private const string ErrorIntentNotFound = "SA_INTENT_NOT_FOUND";
        private const string ErrorIntentLimit = "SA_INTENT_LIMIT";
        private const string ErrorAccountNotFound = "SA_ACCOUNT_NOT_FOUND";
        private const string ErrorAccountFrozen = "SA_ACCOUNT_FROZEN";
        private const string ErrorAccountStatus = "SA_ACCOUNT_STATUS";
        private const string ErrorRecoveryPending = "SA_RECOVERY_PENDING";
        private const string ErrorRecoveryLocked = "SA_RECOVERY_LOCKED";
        private const string ErrorReentrancyForbidden = "SA_REENTRANCY_FORBIDDEN";
        private const string ErrorPhaseViolation = "SA_PHASE_VIOLATION";
        private const string ErrorGasBudgetExceeded = "SA_GAS_BUDGET_EXCEEDED";
        private const string ErrorMessageInvalid = "SA_MESSAGE_INVALID";
        private const string ErrorMigrationRequired = "SA_MIGRATION_REQUIRED";
        private const string ErrorMarketLocked = "SA_MARKET_LOCKED";
        private const string ErrorUnauthorized = "SA_UNAUTHORIZED";

        // ========================================================================
        // 10. Event display names (spec §18) — new module-model events;
        //     existing AA-free event names stay in SmartAccount.Events.cs.
        // ========================================================================

        private const string EventNameModuleInstanceInstalled = "ModuleInstanceInstalled";
        private const string EventNameModuleInstanceConfigured = "ModuleInstanceConfigured";
        private const string EventNameModuleInstanceRemoved = "ModuleInstanceRemoved";
        private const string EventNameModuleCodeRebound = "ModuleCodeRebound";
        private const string EventNameHookOrderSet = "HookOrderSet";
        private const string EventNameThresholdPolicySet = "ThresholdPolicySet";
        private const string EventNameConfigurationIntentProposed = "ConfigurationIntentProposed";
        private const string EventNameConfigurationIntentConfirmed = "ConfigurationIntentConfirmed";
        private const string EventNameConfigurationIntentCancelled = "ConfigurationIntentCancelled";
        private const string EventNameConfigurationIntentExpired = "ConfigurationIntentExpired";
        private const string EventNameCredentialRevoked = "CredentialRevoked";
        private const string EventNameNonceChannelOpened = "NonceChannelOpened";
        private const string EventNameNonceChannelExhausted = "NonceChannelExhausted";
        private const string EventNameMessageSubjectUpdated = "MessageSubjectUpdated";
        private const string EventNameAccountFrozen = "AccountFrozen";
        private const string EventNameAccountUnfrozen = "AccountUnfrozen";
        private const string EventNameRecoveryInitiated = "RecoveryInitiated";
        private const string EventNameRecoveryCancelled = "RecoveryCancelled";
        private const string EventNameRecoveryExecuted = "RecoveryExecuted";
        private const string EventNameMarketControlEpochBound = "MarketControlEpochBound";
        private const string EventNameMarketLockInvalidated = "MarketLockInvalidated";
        private const string EventNameCoreRecoveryRecorded = "CoreRecoveryRecorded";
        private const string EventNameMigrationRequired = "MigrationRequired";
        private const string EventNameMigrationImported = "MigrationImported";
    }
}
