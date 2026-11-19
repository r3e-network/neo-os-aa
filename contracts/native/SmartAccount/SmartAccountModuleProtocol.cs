// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccountModuleProtocol.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

// TRUE SOURCE: this is the only editable copy of this SmartAccount native
// contract file. The neo-native-core checkout carries a generated copy —
// regenerate it via scripts/sync_native_smartaccount.py.

using System;
using System.Buffers.Binary;
using Neo.Extensions;

namespace Neo.SmartContract.Native
{
    /// <summary>
    /// Shared SA module-protocol constants (protocol version 4) for the native
    /// SmartAccount kernel. This class declares NO state and NO business logic:
    /// it only pins the shared protocol constants and the fixed-width key
    /// builders that the native kernel (#40) consumes. The authoritative
    /// specification is docs/SA-MODULE-PROTOCOL.md (Chinese counterpart
    /// docs/SA-MODULE-PROTOCOL.zh-CN.md).
    ///
    /// PAIRED FILE: contracts/custom/SmartAccount.ModuleProtocol.cs (custom
    /// kernel, #39). The two files MUST carry identical numeric values at all times; a
    /// divergence is a protocol defect, not an implementation choice.
    /// </summary>
    internal static class SmartAccountModuleProtocol
    {
        // ------------------------------------------------------------------
        // 1. Protocol identity (spec §1, §4)
        // ------------------------------------------------------------------

        internal const byte ModuleProtocolVersion = 4;
        internal const int UserOperationFieldCount = 13;

        // Field indices of the canonical v4 UserOperation Array (spec §4.1).
        internal const int OpVersion = 0;
        internal const int OpTarget = 1;
        internal const int OpMethod = 2;
        internal const int OpArgs = 3;
        internal const int OpNonce = 4;
        internal const int OpNonceSubkey = 5;
        internal const int OpDeadline = 6;
        internal const int OpValidatorId = 7;
        internal const int OpCredentialGeneration = 8;
        internal const int OpAuthorityEpoch = 9;
        internal const int OpConfigurationNonce = 10;
        internal const int OpSignature = 11;
        internal const int OpHookProofs = 12;

        // Module type codes (ERC-7579 numbering; only 1 and 4 are supported).
        internal const int ModuleTypeCodeValidator = 1;
        internal const int ModuleTypeCodeHook = 4;

        // ------------------------------------------------------------------
        // 2. Profile limits (spec §3)
        // ------------------------------------------------------------------

        internal const int MaxValidatorModuleInstances = 32;
        internal const int MaxHookModuleInstances = 8;
        internal const int MaxThresholdPolicyMembers = 10;
        internal const int MinThresholdPolicyValue = 1;
        internal const int MaxThresholdPolicyValue = 10;
        internal const int MaxActionsPerConfigurationIntent = 16;
        internal const int MaxActiveConfigurationIntents = 16;
        internal const int MaxOperationsPerEnvelope = 32;
        internal const int MinEnumerationLimit = 1;
        internal const int MaxEnumerationLimit = 32;
        // Canonical module profile (spec §12).
        internal const int ModuleProfileVersion = 1;
        internal const int ModuleProfileBytesMax = 2048;
        internal const int ModuleCompositeLayerMax = 1;

        // ------------------------------------------------------------------
        // 3. Encoding bounds (spec §4)
        // ------------------------------------------------------------------

        internal const int NonceSubkeySize = 32;
        internal const int NonceChannelSize = 24;          // 191-bit channel, BE, top bits zero
        internal const int MethodBytesMax = 128;
        internal const int ArgsCountMax = 64;
        internal const int ArgsDepthMax = 8;
        internal const int ArgsSerializedSizeMax = 4096;
        internal const int SignatureBytesMax = 8192;
        internal const int HookProofsEntriesMax = 8;
        internal const int HookProofBytesMax = 4096;       // aggregate across entries
        internal const int HookDataBytesMax = 512;
        internal const int OperationEncodedSizeMax = 16384;
        internal const int EnvelopeEncodedSizeMax = 65536;
        internal const int MessageSubjectKeysMax = 16;
        internal const int MessageHashSize = 32;
        internal const int P256SignatureSize = 64;

        // ------------------------------------------------------------------
        // 4. Timelocks and validity windows (spec §10)
        // ------------------------------------------------------------------

        internal const ulong ModuleChangeDelayMs = 86_400_000;           // 24 h
        internal const ulong ConfigurationIntentExpiryMs = 604_800_000;  // matureAt + 7 days
        internal const ulong RecoveryTimelockMinMs = 604_800_000;        // 7 days
        internal const ulong RecoveryTimelockMaxMs = 7_776_000_000;      // 90 days

        // ------------------------------------------------------------------
        // 5. Gas hard budget profile — approved Plan B (spec §11)
        //    Unit: datoshi, 1 GAS = 100_000_000.
        // ------------------------------------------------------------------

        internal const long GasFactorDatoshi = 100_000_000;
        internal const long ValidationPerCallGasLimit = 100_000_000;     // 1 GAS per validateUserOp
        internal const long CompletionPerCallGasLimit = 100_000_000;     // 1 GAS per onUserOpComplete
        internal const long HookCallbackGasLimit = 250_000_000;          // 2.5 GAS per preCheck/postCheck
        internal const long LifecycleCallbackGasLimit = 250_000_000;     // 2.5 GAS per onInstall/onUninstall/configure

        // Envelope-scoped aggregate pools (spec §11). A pool is the per-call
        // cap times the maximum multiplicity of one envelope, so one maximal
        // threshold round always fits. The per-call cap — never the pool — is
        // the bound on an individual module.
        internal const long ValidationAggregateGasLimit =
            ValidationPerCallGasLimit * (1 + MaxThresholdPolicyMembers);
        internal const long CompletionAggregateGasLimit =
            CompletionPerCallGasLimit * (1 + MaxThresholdPolicyMembers);
        internal const long HookAggregateGasLimit =
            HookCallbackGasLimit * MaxHookModuleInstances;

        // ------------------------------------------------------------------
        // 6. Signing domains and ERC-1271 magic (spec §4.3, §8)
        // ------------------------------------------------------------------

        internal const string UserOperationDomain = "NeoSmartAccount/UserOperation";
        internal const string MessageDomain = "NeoSmartAccount/Message";
        internal const uint MagicIsValidSignature = 0x1626ba7e; // ERC-1271 MAGICVALUE
        internal const uint MagicInvalidSignature = 0xffffffff;

        // ------------------------------------------------------------------
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
        //    The native legacy prefixes (0x10 account, 0x11 proxy, 0x20 nonce,
        //    0x30 pending call, 0x40 dependency) are legacy inputs, not part of
        //    the new module model.
        // ------------------------------------------------------------------

        internal const byte PrefixProtocolInfo = 0x50;
        internal const byte PrefixAccountControl = 0x51;
        internal const byte PrefixModuleInstance = 0x52;
        internal const byte PrefixModuleIndex = 0x53;
        internal const byte PrefixHookOrder = 0x54;
        internal const byte PrefixConfigIntent = 0x55;
        internal const byte PrefixNonceCursor = 0x56;
        internal const byte PrefixMessageSubject = 0x57;
        internal const byte PrefixApplicationContext = 0x58;
        internal const byte PrefixCoreRecovery = 0x59;
        internal const byte PrefixMigrationState = 0x5A;
        internal const byte PrefixThresholdPolicy = 0x5B;
        internal const byte PrefixNonceNamespace = 0x5C;
        internal const byte PrefixMarketControlEpoch = 0x5D;
        internal const byte PrefixConfigIntentIndex = 0x5E;

        // ------------------------------------------------------------------
        // 7b. Configuration action codes (spec §9) — element 0 of an action
        //     Array; identical numbering in both kernels.
        // ------------------------------------------------------------------

        internal const int ActionInstallModule = 1;
        internal const int ActionUninstallModule = 2;
        internal const int ActionConfigureModule = 3;
        internal const int ActionSetHookOrder = 4;
        internal const int ActionSetDefaultPolicy = 5;
        internal const int ActionRebindModuleCode = 6;
        internal const int ActionSetThresholdPolicy = 7;
        internal const int ActionSetRecoveryPolicy = 8;
        internal const int ActionSetMessageSubjects = 9;
        internal const int ActionMigrateAccount = 10;

        // ------------------------------------------------------------------
        // 8. Canonical key builders (spec §7.1)
        //    Each builder returns the key CONTENT that follows the one-byte
        //    prefix; the kernel composes it with StorageKey.Create(Id, prefix,
        //    content). Fixed-width big-endian integer suffixes; raw 20-byte
        //    account ids (UInt160.ToArray(), no display-order reversal).
        // ------------------------------------------------------------------

        internal static byte[] UInt64ToBigEndian(ulong value)
        {
            byte[] result = new byte[8];
            BinaryPrimitives.WriteUInt64BigEndian(result, value);
            return result;
        }

        internal static byte[] AccountControlKeyContent(UInt160 accountId)
        {
            ArgumentNullException.ThrowIfNull(accountId);
            return accountId.ToArray();
        }

        internal static byte[] ModuleInstanceKeyContent(UInt160 accountId, ulong moduleId)
        {
            ArgumentNullException.ThrowIfNull(accountId);
            byte[] result = new byte[UInt160.Length + sizeof(ulong)];
            accountId.ToArray().CopyTo(result, 0);
            BinaryPrimitives.WriteUInt64BigEndian(result.AsSpan(UInt160.Length), moduleId);
            return result;
        }

        internal static byte[] ModuleIndexKeyContent(UInt160 accountId, int moduleType, ulong moduleId)
        {
            ArgumentNullException.ThrowIfNull(accountId);
            if (moduleType is not (ModuleTypeCodeValidator or ModuleTypeCodeHook))
                throw new ArgumentOutOfRangeException(nameof(moduleType));
            byte[] result = new byte[UInt160.Length + 1 + sizeof(ulong)];
            accountId.ToArray().CopyTo(result, 0);
            result[UInt160.Length] = (byte)moduleType;
            BinaryPrimitives.WriteUInt64BigEndian(result.AsSpan(UInt160.Length + 1), moduleId);
            return result;
        }

        internal static byte[] HookOrderKeyContent(UInt160 accountId) => AccountControlShape(accountId);

        internal static byte[] ConfigIntentKeyContent(UInt160 accountId, ulong intentId)
        {
            ArgumentNullException.ThrowIfNull(accountId);
            byte[] result = new byte[UInt160.Length + sizeof(ulong)];
            accountId.ToArray().CopyTo(result, 0);
            BinaryPrimitives.WriteUInt64BigEndian(result.AsSpan(UInt160.Length), intentId);
            return result;
        }

        internal static byte[] NonceCursorKeyContent(UInt160 accountId, ReadOnlySpan<byte> channel)
        {
            ArgumentNullException.ThrowIfNull(accountId);
            if (channel.Length != NonceChannelSize)
                throw new ArgumentException("The nonce channel must contain exactly 24 bytes.", nameof(channel));
            byte[] result = new byte[UInt160.Length + NonceChannelSize];
            accountId.ToArray().CopyTo(result, 0);
            channel.CopyTo(result.AsSpan(UInt160.Length));
            return result;
        }

        internal static byte[] NonceNamespaceKeyContent(UInt160 accountId, ReadOnlySpan<byte> channel) =>
            NonceCursorKeyContent(accountId, channel);

        internal static byte[] MessageSubjectKeyContent(UInt160 accountId) => AccountControlShape(accountId);

        internal static byte[] ApplicationContextKeyContent(UInt160 accountId) => AccountControlShape(accountId);

        internal static byte[] CoreRecoveryKeyContent(UInt160 accountId) => AccountControlShape(accountId);

        internal static byte[] MigrationStateKeyContent(UInt160 accountId) => AccountControlShape(accountId);

        internal static byte[] ThresholdPolicyKeyContent(UInt160 accountId, ulong policyId)
        {
            ArgumentNullException.ThrowIfNull(accountId);
            byte[] result = new byte[UInt160.Length + sizeof(ulong)];
            accountId.ToArray().CopyTo(result, 0);
            BinaryPrimitives.WriteUInt64BigEndian(result.AsSpan(UInt160.Length), policyId);
            return result;
        }

        internal static byte[] MarketControlEpochKeyContent(UInt160 accountId) => AccountControlShape(accountId);

        internal static byte[] ConfigIntentIndexKeyContent(UInt160 accountId) => AccountControlShape(accountId);

        // ------------------------------------------------------------------
        // 9. Error codes (spec §17) — stable SA_* string constants shared
        //    verbatim with the custom constants file.
        // ------------------------------------------------------------------

        internal const string ErrorProtocolVersion = "SA_PROTOCOL_VERSION";
        internal const string ErrorOperationMalformed = "SA_OPERATION_MALFORMED";
        internal const string ErrorOperationFieldCount = "SA_OPERATION_FIELD_COUNT";
        internal const string ErrorModuleTypeUnsupported = "SA_MODULE_TYPE_UNSUPPORTED";
        internal const string ErrorModuleLimitValidator = "SA_MODULE_LIMIT_VALIDATOR";
        internal const string ErrorModuleLimitHook = "SA_MODULE_LIMIT_HOOK";
        internal const string ErrorModuleLimitThreshold = "SA_MODULE_LIMIT_THRESHOLD";
        internal const string ErrorModuleLimitMembers = "SA_MODULE_LIMIT_MEMBERS";
        internal const string ErrorModuleLimitActions = "SA_MODULE_LIMIT_ACTIONS";
        internal const string ErrorModuleLimitIntents = "SA_MODULE_LIMIT_INTENTS";
        internal const string ErrorModuleLimitBatch = "SA_MODULE_LIMIT_BATCH";
        internal const string ErrorModuleNotInstalled = "SA_MODULE_NOT_INSTALLED";
        internal const string ErrorModuleIdInvalid = "SA_MODULE_ID_INVALID";
        internal const string ErrorModuleInstanceIsolationRequired = "SA_MODULE_INSTANCE_ISOLATION_REQUIRED";
        internal const string ErrorModuleCodeBindingMismatch = "SA_MODULE_CODE_BINDING_MISMATCH";
        internal const string ErrorModuleNotRoutable = "SA_MODULE_NOT_ROUTABLE";
        internal const string ErrorModuleMessageCapabilityAbsent = "SA_MODULE_MESSAGE_CAPABILITY_ABSENT";
        internal const string ErrorValidationRejected = "SA_VALIDATION_REJECTED";
        internal const string ErrorValidatorNotFound = "SA_VALIDATOR_NOT_FOUND";
        internal const string ErrorHookRejected = "SA_HOOK_REJECTED";
        internal const string ErrorHookDataTooLarge = "SA_HOOK_DATA_TOO_LARGE";
        internal const string ErrorProofInvalid = "SA_PROOF_INVALID";
        internal const string ErrorNonceInvalid = "SA_NONCE_INVALID";
        internal const string ErrorNonceExhausted = "SA_NONCE_EXHAUSTED";
        internal const string ErrorNonceChannelCollision = "SA_NONCE_CHANNEL_COLLISION";
        internal const string ErrorDeadlineExpired = "SA_DEADLINE_EXPIRED";
        internal const string ErrorEpochStale = "SA_EPOCH_STALE";
        internal const string ErrorConfigurationNonceStale = "SA_CONFIGURATION_NONCE_STALE";
        internal const string ErrorCredentialStale = "SA_CREDENTIAL_STALE";
        internal const string ErrorIntentImmature = "SA_INTENT_IMMATURE";
        internal const string ErrorIntentExpired = "SA_INTENT_EXPIRED";
        internal const string ErrorIntentConflict = "SA_INTENT_CONFLICT";
        internal const string ErrorIntentNotFound = "SA_INTENT_NOT_FOUND";
        internal const string ErrorIntentLimit = "SA_INTENT_LIMIT";
        internal const string ErrorAccountNotFound = "SA_ACCOUNT_NOT_FOUND";
        internal const string ErrorAccountFrozen = "SA_ACCOUNT_FROZEN";
        internal const string ErrorAccountStatus = "SA_ACCOUNT_STATUS";
        internal const string ErrorRecoveryPending = "SA_RECOVERY_PENDING";
        internal const string ErrorRecoveryLocked = "SA_RECOVERY_LOCKED";
        internal const string ErrorReentrancyForbidden = "SA_REENTRANCY_FORBIDDEN";
        internal const string ErrorPhaseViolation = "SA_PHASE_VIOLATION";
        internal const string ErrorGasBudgetExceeded = "SA_GAS_BUDGET_EXCEEDED";
        internal const string ErrorMessageInvalid = "SA_MESSAGE_INVALID";
        internal const string ErrorMigrationRequired = "SA_MIGRATION_REQUIRED";
        internal const string ErrorMarketLocked = "SA_MARKET_LOCKED";
        internal const string ErrorUnauthorized = "SA_UNAUTHORIZED";

        // ------------------------------------------------------------------
        // 10. Event display names (spec §18) — new module-model events;
        //     existing AA-free event names stay in SmartAccount.Events.cs
        //     (custom) / SmartAccount.Events.cs (native).
        // ------------------------------------------------------------------

        internal const string EventNameModuleInstanceInstalled = "ModuleInstanceInstalled";
        internal const string EventNameModuleInstanceConfigured = "ModuleInstanceConfigured";
        internal const string EventNameModuleInstanceRemoved = "ModuleInstanceRemoved";
        internal const string EventNameModuleCodeRebound = "ModuleCodeRebound";
        internal const string EventNameHookOrderSet = "HookOrderSet";
        internal const string EventNameThresholdPolicySet = "ThresholdPolicySet";
        internal const string EventNameConfigurationIntentProposed = "ConfigurationIntentProposed";
        internal const string EventNameConfigurationIntentConfirmed = "ConfigurationIntentConfirmed";
        internal const string EventNameConfigurationIntentCancelled = "ConfigurationIntentCancelled";
        internal const string EventNameConfigurationIntentExpired = "ConfigurationIntentExpired";
        internal const string EventNameCredentialRevoked = "CredentialRevoked";
        internal const string EventNameNonceChannelOpened = "NonceChannelOpened";
        internal const string EventNameNonceChannelExhausted = "NonceChannelExhausted";
        internal const string EventNameMessageSubjectUpdated = "MessageSubjectUpdated";
        internal const string EventNameAccountFrozen = "AccountFrozen";
        internal const string EventNameAccountUnfrozen = "AccountUnfrozen";
        internal const string EventNameRecoveryInitiated = "RecoveryInitiated";
        internal const string EventNameRecoveryCancelled = "RecoveryCancelled";
        internal const string EventNameRecoveryExecuted = "RecoveryExecuted";
        internal const string EventNameMarketControlEpochBound = "MarketControlEpochBound";
        internal const string EventNameMarketLockInvalidated = "MarketLockInvalidated";
        internal const string EventNameCoreRecoveryRecorded = "CoreRecoveryRecorded";
        internal const string EventNameMigrationRequired = "MigrationRequired";
        internal const string EventNameMigrationImported = "MigrationImported";

        private static byte[] AccountControlShape(UInt160 accountId)
        {
            ArgumentNullException.ThrowIfNull(accountId);
            return accountId.ToArray();
        }
    }
}
