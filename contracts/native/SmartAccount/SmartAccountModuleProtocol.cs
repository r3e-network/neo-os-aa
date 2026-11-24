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
    /// it only pins the core protocol constants and the fixed-width key
    /// builders the native kernel consumes. The authoritative specification is
    /// docs/SA-MODULE-PROTOCOL.md (Chinese counterpart
    /// docs/SA-MODULE-PROTOCOL.zh-CN.md).
    ///
    /// The native kernel is the minimal core: registration, freeze/unfreeze,
    /// operation execution, nonce cursors, digest derivation and the base
    /// module registry. Higher-level features (configuration intents,
    /// recovery, message signatures and threshold
    /// policies) live in user-space modules and are NOT part of this surface.
    ///
    /// This file is the only carrier of the numeric values: a divergence against
    /// the published constants is a protocol defect, not an implementation choice.
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
        // Field 12 of the v4 envelope carries per-hook proofs. The core treats
        // it as module-defined, core-carried data: shape-checked here, never
        // interpreted, and always part of the digest.
        internal const int OpHookProofs = 12;

        // Module type codes (ERC-7579 numbering). v4 accepts exactly the three
        // kinds the standard module layer is built on: validator (1), hook (4)
        // and recovery (5). The recovery seat is the single installed instance
        // that may trigger the core-side account reset (spec §7.1/§12.5,
        // R-12-12); it is never routed. Threshold policies and composite
        // orchestration carry no install type code — they are installed as
        // validators, like any orchestrator.
        internal const int ModuleTypeCodeValidator = 1;
        internal const int ModuleTypeCodeHook = 4;
        internal const int ModuleTypeCodeRecovery = 5;

        // ------------------------------------------------------------------
        // 2. Profile limits (spec §3)
        // ------------------------------------------------------------------

        // Per-account instance caps, per type (spec §7.2 R-07-02).
        internal const int MaxValidatorModuleInstances = 32;
        internal const int MaxHookModuleInstances = 8;
        // Spec §7.2 R-07-02/R-12-12: exactly one recovery seat per account.
        internal const int MaxRecoveryModuleInstances = 1;
        internal const int MaxOperationsPerEnvelope = 32;
        internal const int MaxActionsPerRegistration = 16;
        internal const int MaxConfigurationActions = 16;
        internal const int MinEnumerationLimit = 1;
        internal const int MaxEnumerationLimit = 32;
        // Canonical module profile (spec §12).
        internal const int ModuleProfileVersion = 1;
        internal const int ModuleProfileBytesMax = 2048;

        // ------------------------------------------------------------------
        // 3. Encoding bounds (spec §4)
        // ------------------------------------------------------------------

        internal const int NonceSubkeySize = 32;
        internal const int NonceChannelSize = 24;          // 191-bit channel, BE, top bits zero
        internal const int MethodBytesMax = 128;
        internal const string ErrorModuleLimitThreshold = "SA_MODULE_LIMIT_THRESHOLD";
        internal const string ErrorModuleLimitMembers = "SA_MODULE_LIMIT_MEMBERS";
        internal const int MaxThresholdPolicyMembers = 10;
        internal const int MinThresholdPolicyValue = 1;
        internal const int MaxThresholdPolicyValue = 10;
        internal const int MessageSubjectKeysMax = 16;
        internal const int MessageHashSize = 32;
        internal const uint MagicIsValidSignature = 0x1626ba7e; // ERC-1271 MAGICVALUE
        internal const uint MagicInvalidSignature = 0xffffffff;
        internal const byte PrefixThresholdPolicy = 0x5B;
        internal const int ActionSetThresholdPolicy = 7;
        internal const int ActionSetMessageSubjects = 9;
        internal const string EventNameThresholdPolicySet = "ThresholdPolicySet";
        internal const string EventNameMessageSubjectUpdated = "MessageSubjectUpdated";
        internal const string ErrorIntentConflict = "SA_INTENT_CONFLICT";

        internal const int ArgsCountMax = 64;
        internal const int ArgsDepthMax = 8;
        internal const int ArgsSerializedSizeMax = 4096;
        internal const int SignatureBytesMax = 8192;
        // Field 12 shape bounds (§4.2 R-04-03). The core bounds the array but
        // checks the named hook ids; each hook interprets its own proof.
        internal const int HookDataBytesMax = 512;
        internal const string ErrorHookDataTooLarge = "SA_HOOK_DATA_TOO_LARGE";
        internal const int HookProofsEntriesMax = 8;
        internal const int HookProofBytesMax = 4096;
        internal const int OperationEncodedSizeMax = 16384;
        internal const int EnvelopeEncodedSizeMax = 65536;

        // ------------------------------------------------------------------
        // 4. Gas hard budget profile — approved Plan B (spec §11)
        //    Unit: datoshi, 1 GAS = 100_000_000.
        // ------------------------------------------------------------------

        internal const long HookCallbackGasLimit = 250_000_000;
        internal const long HookAggregateGasLimit = HookCallbackGasLimit * MaxHookModuleInstances;
        internal const long ValidationPerCallGasLimit = 100_000_000;     // 1 GAS per validateUserOp
        internal const long CompletionPerCallGasLimit = 100_000_000;     // 1 GAS per onUserOpComplete
        internal const long ValidationAggregateGasLimit = ValidationPerCallGasLimit * (1 + MaxThresholdPolicyMembers);
        internal const long CompletionAggregateGasLimit = CompletionPerCallGasLimit * (1 + MaxThresholdPolicyMembers);
        internal const long LifecycleCallbackGasLimit = 250_000_000;     // 2.5 GAS per onInstall/onUninstall

        // ------------------------------------------------------------------
        // 5. Storage prefixes — core 0x50–0x53 region (spec §7.1)
        //    Key shapes:
        //      0x50 bare
        //      0x51/0x53 +acctId
        //      0x52 +acctId+moduleId[8 BE]
        //      0x56/0x5C +acctId+channel[24 BE]
        //    All integer key suffixes are fixed-width big-endian; account bytes
        //    are the raw UInt160 bytes. Higher-level features that are no
        //    longer native reserve their former prefixes and never declare them.
        // ------------------------------------------------------------------

        internal const byte PrefixProtocolInfo = 0x50;
        internal const byte PrefixAccountControl = 0x51;
        internal const byte PrefixModuleInstance = 0x52;
        internal const byte PrefixModuleIndex = 0x53;
        internal const byte PrefixNonceCursor = 0x56;
        internal const byte PrefixNonceNamespace = 0x5C;

        // ------------------------------------------------------------------
        // 6b. Registration action codes — element 0 of an action Array passed
        //     to createAccount. Only the module-model actions the minimal core
        //     still executes at atomic registration are declared.
        // ------------------------------------------------------------------

        internal const int ActionInstallModule = 1;
        internal const int ActionUninstallModule = 2;
        internal const int ActionConfigureModule = 3;
        internal const int ActionSetBuiltinAuthorization = 5;
        internal const int ActionSetRecoveryPolicy = 8;

        // ------------------------------------------------------------------
        // 7. Canonical key builders (spec §7.1)
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
            if (moduleType is not (ModuleTypeCodeValidator or ModuleTypeCodeHook or ModuleTypeCodeRecovery))
                throw new ArgumentOutOfRangeException(nameof(moduleType));
            byte[] result = new byte[UInt160.Length + 1 + sizeof(ulong)];
            accountId.ToArray().CopyTo(result, 0);
            result[UInt160.Length] = (byte)moduleType;
            BinaryPrimitives.WriteUInt64BigEndian(result.AsSpan(UInt160.Length + 1), moduleId);
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

        // ------------------------------------------------------------------
        // 8. Error codes (spec §17) — stable SA_* string constants shared
        //    verbatim with the custom constants file.
        // ------------------------------------------------------------------

        internal const string ErrorProtocolVersion = "SA_PROTOCOL_VERSION";
        internal const string ErrorOperationMalformed = "SA_OPERATION_MALFORMED";
        internal const string ErrorOperationFieldCount = "SA_OPERATION_FIELD_COUNT";
        internal const string ErrorModuleTypeUnsupported = "SA_MODULE_TYPE_UNSUPPORTED";
        internal const string ErrorModuleLimitValidator = "SA_MODULE_LIMIT_VALIDATOR";
        internal const string ErrorModuleLimitHook = "SA_MODULE_LIMIT_HOOK";
        // Spec §7.1/appendix C: the recovery seat is capped at one instance
        // per account (R-12-12).
        internal const string ErrorModuleLimitRecovery = "SA_MODULE_LIMIT_RECOVERY";
        internal const string ErrorModuleLimitActions = "SA_MODULE_LIMIT_ACTIONS";
        internal const string ErrorModuleLimitBatch = "SA_MODULE_LIMIT_BATCH";
        internal const string ErrorModuleNotInstalled = "SA_MODULE_NOT_INSTALLED";
        internal const string ErrorModuleIdInvalid = "SA_MODULE_ID_INVALID";
        internal const string ErrorModuleInstanceIsolationRequired = "SA_MODULE_INSTANCE_ISOLATION_REQUIRED";
        internal const string ErrorModuleCodeBindingMismatch = "SA_MODULE_CODE_BINDING_MISMATCH";
        internal const string ErrorModuleNotRoutable = "SA_MODULE_NOT_ROUTABLE";
        internal const string ErrorValidationRejected = "SA_VALIDATION_REJECTED";
        internal const string ErrorValidatorNotFound = "SA_VALIDATOR_NOT_FOUND";
        // Core-side addition (audit L-1): a validator's validateUserOp reply
        // that is not Boolean true/false is a callback contract violation, not
        // a module-type error. Registered in the spec's appendix C table 44.
        internal const string ErrorCallbackReturnType = "SA_CALLBACK_RETURN_TYPE";
        internal const string ErrorProofInvalid = "SA_PROOF_INVALID";
        internal const string ErrorNonceInvalid = "SA_NONCE_INVALID";
        internal const string ErrorNonceExhausted = "SA_NONCE_EXHAUSTED";
        internal const string ErrorNonceChannelCollision = "SA_NONCE_CHANNEL_COLLISION";
        internal const string ErrorDeadlineExpired = "SA_DEADLINE_EXPIRED";
        internal const string ErrorEpochStale = "SA_EPOCH_STALE";
        internal const string ErrorConfigurationNonceStale = "SA_CONFIGURATION_NONCE_STALE";
        internal const string ErrorCredentialStale = "SA_CREDENTIAL_STALE";
        internal const string ErrorAccountNotFound = "SA_ACCOUNT_NOT_FOUND";
        internal const string ErrorAccountFrozen = "SA_ACCOUNT_FROZEN";
        internal const string ErrorAccountStatus = "SA_ACCOUNT_STATUS";
        internal const string ErrorReentrancyForbidden = "SA_REENTRANCY_FORBIDDEN";
        internal const string ErrorGasBudgetExceeded = "SA_GAS_BUDGET_EXCEEDED";
        internal const string ErrorUnauthorized = "SA_UNAUTHORIZED";
        // Spec §7.1/R-07-14/R-08-08: closing the built-in operation switch
        // while the account holds no installed validator instance would leave
        // it without any routing subject and without an automatic custody
        // fallback — the account must never lose every route.
        internal const string ErrorBuiltinRouteRequired = "SA_BUILTIN_ROUTE_REQUIRED";

        // ------------------------------------------------------------------
        // 9. Event display names (spec §18) — core module-model events.
        // ------------------------------------------------------------------

        internal const string EventNameModuleInstanceInstalled = "ModuleInstanceInstalled";
        internal const string EventNameModuleInstanceRemoved = "ModuleInstanceRemoved";
        internal const string EventNameNonceChannelOpened = "NonceChannelOpened";
        internal const string EventNameNonceChannelExhausted = "NonceChannelExhausted";
        internal const string EventNameAccountFrozen = "AccountFrozen";
        internal const string EventNameAccountUnfrozen = "AccountUnfrozen";
        // Restricted landing-path events (spec §7.1/§12.5/§14.2).
        internal const string EventNameModuleCredentialsRevoked = "ModuleCredentialsRevoked";
        internal const string EventNameRecoveryPolicySet = "RecoveryPolicySet";
        internal const string EventNameAccountReset = "AccountReset";
        internal const string EventNameBuiltinAuthorizationSet = "BuiltinAuthorizationSet";
    }
}
