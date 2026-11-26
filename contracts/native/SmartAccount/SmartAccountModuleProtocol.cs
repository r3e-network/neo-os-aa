// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccountModuleProtocol.cs file belongs to the neo project and is free software distributed under the MIT
// software license, see the accompanying file LICENSE in the main directory of the repository or
// http://www.opensource.org/licenses/mit-license.php for more details.
//
// Redistribution and use in source and binary forms with or without modifications are permitted.

// TRUE SOURCE: this is the only editable copy of this SmartAccount native
// contract file. The neo-native-core checkout carries a generated copy —
// regenerate it via scripts/sync_native_smartaccount.py.

using System;
using System.Buffers.Binary;
using System.Numerics;
using Neo.Extensions;

namespace Neo.SmartContract.Native
{
    /// <summary> Shared SA module-protocol constants (protocol version 4) for the native kernel. This file is the only carrier of
    /// the numeric values; a divergence from docs/SA-MODULE-PROTOCOL.md is a protocol defect. </summary>
    internal static class SmartAccountModuleProtocol
    {
        // 1. Protocol identity (spec §1, §4)
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
        // Field 12 carries per-hook proofs: module-defined, shape-checked by
        // the core, never interpreted, and always part of the digest.
        internal const int OpHookProofs = 12;

        // ERC-7579 type codes. The recovery seat (one instance, never routed)
        // alone may trigger the restricted reset; orchestrators are validators.
        internal const int ModuleTypeCodeValidator = 1;
        internal const int ModuleTypeCodeHook = 4;
        internal const int ModuleTypeCodeRecovery = 5;

        /// <summary>The single admission test for the three codes the core routes (ERC-7579 1/4/5).</summary>
        internal static bool IsModuleTypeCode(BigInteger code) =>
            code == ModuleTypeCodeValidator || code == ModuleTypeCodeHook || code == ModuleTypeCodeRecovery;

        internal static string ModuleTypeName(int moduleType) => moduleType switch
        {
            ModuleTypeCodeValidator => "validator",
            ModuleTypeCodeHook => "hook",
            ModuleTypeCodeRecovery => "recovery",
            _ => throw new InvalidOperationException(ErrorModuleTypeUnsupported),
        };

        // 2. Profile limits (spec §3): per-account instance caps per type (R-07-02).
        internal const int MaxValidatorModuleInstances = 32;
        internal const int MaxHookModuleInstances = 8;
        // R-12-12: exactly one recovery seat per account.
        internal const int MaxRecoveryModuleInstances = 1;
        internal const int MaxActionsPerRegistration = 16;
        internal const int MaxConfigurationActions = 16;
        internal const int MinEnumerationLimit = 1;
        internal const int MaxEnumerationLimit = 32;
        // Canonical module profile (spec §12).
        internal const int ModuleProfileVersion = 1;
        internal const int ModuleProfileBytesMax = 2048;

        // 3. Encoding bounds (spec §4)
        internal const int NonceSubkeySize = 32;
        internal const int NonceChannelSize = 24;          // 191-bit channel, BE, top bits zero
        internal const int MethodBytesMax = 128;
        internal const int MaxCompositeMemberValidators = 10;

        internal const int ArgsCountMax = 64;
        internal const int ArgsDepthMax = 8;
        internal const int ArgsSerializedSizeMax = 4096;
        // The serializer's item bound of the args tree (elements at every depth): a different limit from the byte bound.
        internal const int ArgsSerializedItemsMax = 4096;
        internal const int SignatureBytesMax = 8192;
        // Field 12 shape bounds (§4.2 R-04-03): each hook interprets its proof.
        internal const int HookDataBytesMax = 512;
        internal const string ErrorHookDataTooLarge = "SA_HOOK_DATA_TOO_LARGE";
        internal const int HookProofsEntriesMax = 8;
        internal const int HookProofBytesMax = 4096;
        // 16384 = args 4096 + signature 8192 + hook proofs 4096; only a backstop, an operation with all three sub-limits maxed together is rejected by it.
        internal const int OperationEncodedSizeMax = 16384;
        // The serializer's item bound of the whole operation tree: a different limit from the byte bound.
        internal const int OperationEncodedItemsMax = 16384;

        // 4. Storage prefixes (spec §7.1). Key shapes: 0x50 bare; 0x51/0x53
        // +acctId; 0x52 +acctId+moduleId[8 BE]; 0x56/0x5C +acctId+channel[24 BE]. A key is a platform
        // KeyBuilder over the prefix and these fixed-width fields, in this order. 0x50 is the reserved bare key
        // of the protocol information record: nothing is stored under it yet, and the pinned storage-key
        // vector and the IDL prefix table hold it to that byte.
        internal const byte PrefixProtocolInfo = 0x50;
        internal const byte PrefixAccountControl = 0x51;
        internal const byte PrefixModuleInstance = 0x52;
        internal const byte PrefixModuleIndex = 0x53;
        internal const byte PrefixNonceCursor = 0x56;
        internal const byte PrefixNonceNamespace = 0x5C;

        // 6b. Registration action codes: element 0 of an action Array.
        internal const int ActionInstallModule = 1;
        internal const int ActionUninstallModule = 2;
        internal const int ActionConfigureModule = 3;
        internal const int ActionSetBuiltinAuthorization = 5;
        internal const int ActionSetRequiredValidator = 7;

        // 5. The getModule reply carries the module id as a fixed-width big-endian UInt64 (spec §7.1).
        internal static byte[] UInt64ToBigEndian(ulong value)
        {
            byte[] result = new byte[8];
            BinaryPrimitives.WriteUInt64BigEndian(result, value);
            return result;
        }

        // 7. Error codes (spec §17).
        internal const string ErrorProtocolVersion = "SA_PROTOCOL_VERSION";
        internal const string ErrorOperationMalformed = "SA_OPERATION_MALFORMED";
        internal const string ErrorOperationFieldCount = "SA_OPERATION_FIELD_COUNT";
        internal const string ErrorModuleTypeUnsupported = "SA_MODULE_TYPE_UNSUPPORTED";
        internal const string ErrorModuleLimitValidator = "SA_MODULE_LIMIT_VALIDATOR";
        internal const string ErrorModuleLimitHook = "SA_MODULE_LIMIT_HOOK";
        internal const string ErrorModuleLimitRecovery = "SA_MODULE_LIMIT_RECOVERY";
        internal const string ErrorModuleLimitPlanner = "SA_MODULE_LIMIT_PLANNER";
        internal const string ErrorModuleLimitActions = "SA_MODULE_LIMIT_ACTIONS";
        internal const string ErrorModuleLimitBatch = "SA_MODULE_LIMIT_BATCH";
        internal const string ErrorModuleNotInstalled = "SA_MODULE_NOT_INSTALLED";
        internal const string ErrorModuleIdInvalid = "SA_MODULE_ID_INVALID";
        internal const string ErrorModuleInstanceIsolationRequired = "SA_MODULE_INSTANCE_ISOLATION_REQUIRED";
        internal const string ErrorModuleCodeBindingMismatch = "SA_MODULE_CODE_BINDING_MISMATCH";
        internal const string ErrorModuleNotRoutable = "SA_MODULE_NOT_ROUTABLE";
        internal const string ErrorValidationRejected = "SA_VALIDATION_REJECTED";
        internal const string ErrorValidatorNotFound = "SA_VALIDATOR_NOT_FOUND";
        // Audit L-1: a non-Boolean callback reply is a contract violation.
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
        // F-7: a grant, scope or release requested outside the authorized phase.
        internal const string ErrorPhaseViolation = "SA_PHASE_VIOLATION";
        internal const string ErrorUnauthorized = "SA_UNAUTHORIZED";
        // R-07-14/R-08-08: the account must never lose every route.
        internal const string ErrorBuiltinRouteRequired = "SA_BUILTIN_ROUTE_REQUIRED";

        // 8. Event display names (spec §18).
        internal const string EventNameModuleInstanceInstalled = "ModuleInstanceInstalled";
        internal const string EventNameModuleInstanceRemoved = "ModuleInstanceRemoved";
        internal const string EventNameNonceChannelOpened = "NonceChannelOpened";
        internal const string EventNameNonceChannelExhausted = "NonceChannelExhausted";
        internal const string EventNameAccountUnfrozen = "AccountUnfrozen";
        // Restricted landing-path events (spec §7.1/§12.5/§14.2).
        internal const string EventNameModuleCredentialsRevoked = "ModuleCredentialsRevoked";
        internal const string EventNameRequiredValidatorSet = "RequiredValidatorSet";
        internal const string EventNameAccountReset = "AccountReset";
        internal const string EventNameBuiltinAuthorizationSet = "BuiltinAuthorizationSet";
    }
}
