// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccountRecords.cs file belongs to the neo project and is free
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

using Neo.Extensions;
using Neo.IO;
using Neo.VM.Types;
using System;
using System.Collections.Generic;
using System.Numerics;
using Array = Neo.VM.Types.Array;

namespace Neo.SmartContract.Native
{
    internal enum SmartAccountStatus { Active, Frozen }

    /// <summary>
    /// Canonical record codec. Every record is a positional Array encoded with
    /// the NeoVM binary serializer; decoding rejects any byte string that does
    /// not re-encode to itself, so a record can never carry two encodings.
    /// </summary>
    internal static class SmartAccountRecordCodec
    {
        private const uint MaxBytes = 16384;
        private const uint MaxItems = 16384;
        private static readonly System.Text.UTF8Encoding StrictUtf8 = new(false, true);

        internal static byte[] Encode(Array record) => BinarySerializer.Serialize(record, MaxBytes, MaxItems);

        internal static Array Decode(ReadOnlyMemory<byte> bytes)
        {
            if (bytes.Length == 0) throw new FormatException("A SmartAccount record is empty.");
            MemoryReader reader = new(bytes);
            StackItem item = BinarySerializer.Deserialize(ref reader, MaxBytes, MaxItems);
            if (reader.Position != bytes.Length || item.Type != StackItemType.Array)
                throw new FormatException("A SmartAccount record must be one canonical Array.");
            Array record = (Array)item;
            ValidateRecordTree(record);
            if (!bytes.Span.SequenceEqual(Encode(record)))
                throw new FormatException("A SmartAccount record must have a canonical byte encoding.");
            return record;
        }

        /// <summary>
        /// A record is a positional Array of scalars only: nested records are
        /// Arrays, leaves are Integer, ByteString or Boolean. Every other stack
        /// item (Struct, Buffer, Map, Null, interop) would carry a type marker
        /// that no record field ever produces, so it is rejected here instead of
        /// being silently flattened by whichever field reads it later.
        /// </summary>
        private static void ValidateRecordTree(StackItem root)
        {
            Stack<StackItem> pending = new();
            pending.Push(root);
            while (pending.Count > 0)
            {
                StackItem item = pending.Pop();
                switch (item)
                {
                    case Neo.VM.Types.Boolean:
                    case Integer:
                    case ByteString:
                        break;
                    case Struct:
                        throw new FormatException("A SmartAccount record field is outside the record type domain.");
                    case Array array:
                        foreach (StackItem child in array) pending.Push(child);
                        break;
                    default:
                        throw new FormatException("A SmartAccount record field is outside the record type domain.");
                }
            }
        }

        internal static Array Exact(StackItem item, int count)
        {
            if (item.Type != StackItemType.Array || item is not Array array || array.Count != count)
                throw new FormatException("The SmartAccount record field must be an exact Array of the specified size.");
            return array;
        }

        internal static byte[] Fixed(StackItem item, int size)
        {
            if (item is not ByteString value || value.Size != size)
                throw new FormatException("The SmartAccount record field must be a fixed-width ByteString.");
            return value.GetSpan().ToArray();
        }

        internal static byte[] Bytes(StackItem item, int maximum)
        {
            if (item is not ByteString value || value.Size > maximum)
                throw new FormatException("The SmartAccount record field must be a bounded ByteString.");
            return value.GetSpan().ToArray();
        }

        internal static UInt160 Address(StackItem item) => new(Fixed(item, UInt160.Length));

        internal static BigInteger Unsigned(StackItem item)
        {
            if (item is not Integer value || value.GetInteger() < 0 || (value.GetInteger() >> 64) != BigInteger.Zero)
                throw new FormatException("The SmartAccount record field must be an unsigned 64-bit Integer.");
            return value.GetInteger();
        }

        internal static bool Boolean(StackItem item)
        {
            if (item is not Neo.VM.Types.Boolean value)
                throw new FormatException("The SmartAccount record field must be a Boolean.");
            return value.GetBoolean();
        }

        internal static string Text(StackItem item, int maximum)
        {
            if (item is not ByteString value || value.Size > maximum)
                throw new FormatException("The SmartAccount record field must be a bounded String.");
            try
            {
                return StrictUtf8.GetString(value.GetSpan());
            }
            catch (Exception exception)
            {
                throw new FormatException("The SmartAccount record string is not valid UTF-8.", exception);
            }
        }

        internal static BigInteger[] Integers(StackItem item, int maximum)
        {
            if (item.Type != StackItemType.Array || item is not Array array || array.Count > maximum)
                throw new FormatException("The SmartAccount record field must be a bounded Integer Array.");
            BigInteger[] result = new BigInteger[array.Count];
            for (int i = 0; i < array.Count; i++) result[i] = Unsigned(array[i]);
            return result;
        }

        internal static byte[][] BytesArray(StackItem item, int maximum, int entryMaximum)
        {
            if (item.Type != StackItemType.Array || item is not Array array || array.Count > maximum)
                throw new FormatException("The SmartAccount record field must be a bounded ByteString Array.");
            byte[][] result = new byte[array.Count][];
            for (int i = 0; i < array.Count; i++) result[i] = Bytes(array[i], entryMaximum);
            return result;
        }
        internal static Array BytesArray(IReadOnlyList<byte[]> values)
        {
            Array array = new();
            for (int i = 0; i < values.Count; i++) array.Add(values[i]);
            return array;
        }

        internal static Array IntegerArray(IReadOnlyList<BigInteger> values)
        {
            Array array = new();
            for (int i = 0; i < values.Count; i++) array.Add(values[i]);
            return array;
        }
    }

    /// <summary>
    /// v4 account control metadata (spec §7.2), stored under 0x51 + accountId.
    ///
    /// The record layout is retained verbatim from the full profile so persisted
    /// accounts keep decoding: fields that only the removed higher-level
    /// features used (message authorization, owner-only recovery, hook order)
    /// stay in the encoded shape and are simply no longer advanced by this core.
    /// </summary>
    internal sealed class AccountControl
    {
        internal const ulong RecoveryTimelockMinMs = 604_800_000;        // 7 days
        internal const ulong RecoveryTimelockMaxMs = 7_776_000_000;      // 90 days

        internal SmartAccountStatus Status;
        internal UInt160 Custody = UInt160.Zero;
        internal UInt160 RecoveryAuthority = UInt160.Zero;
        internal ulong AuthorityEpoch;
        internal ulong ConfigurationNonce;
        internal ulong NextModuleId;
        internal ulong NextIntentId;                     // reserved (intents are user-space)
        internal bool DefaultOperationAuthorization;
        internal bool DefaultMessageAuthorization;       // reserved
        internal ulong RecoveryTimelockMs;
        internal ulong HookOrderRevision;
        internal ulong RequiredPolicyId;
        internal ulong ControlRevision;
        internal bool OwnerOnlyRecovery;                 // retained layout field; must stay false

        internal static AccountControl Create(UInt160 custody, ulong recoveryTimelockMs) => new()
        {
            Status = SmartAccountStatus.Active,
            Custody = custody,
            RecoveryAuthority = UInt160.Zero,
            AuthorityEpoch = 1,
            ConfigurationNonce = 0,
            NextModuleId = 1,
            NextIntentId = 1,
            DefaultOperationAuthorization = true,
            DefaultMessageAuthorization = true,
            RecoveryTimelockMs = recoveryTimelockMs,
            HookOrderRevision = 0,
            RequiredPolicyId = 0,
            ControlRevision = 1,
            OwnerOnlyRecovery = false,
        };

        internal BigInteger AllocateModuleId()
        {
            if (NextModuleId == ulong.MaxValue)
                throw new InvalidOperationException("The module id allocator is exhausted.");
            return NextModuleId++;
        }

        /// <summary>
        /// Closes a configuration transition: the configuration nonce kills every
        /// operation that signed against the previous module model and the
        /// control revision records that the account was reshaped.
        /// </summary>
        internal void Advance()
        {
            (ConfigurationNonce, ControlRevision) = (checked(ConfigurationNonce + 1), checked(ControlRevision + 1));
        }

        internal void AdvanceAuthority()
        {
            ulong epoch = checked(AuthorityEpoch + 1);
            Advance();
            AuthorityEpoch = epoch;
        }

        internal Array ToStackItem() => new(new StackItem[]
        {
            (int)Status, Custody.ToArray(), RecoveryAuthority.ToArray(),
            AuthorityEpoch, ConfigurationNonce, NextModuleId, NextIntentId,
            DefaultOperationAuthorization, DefaultMessageAuthorization,
            RecoveryTimelockMs, HookOrderRevision, RequiredPolicyId,
            ControlRevision, OwnerOnlyRecovery,
        });

        internal byte[] Serialize() => SmartAccountRecordCodec.Encode(ToStackItem());

        internal static AccountControl Decode(ReadOnlyMemory<byte> bytes)
        {
            Array record = SmartAccountRecordCodec.Exact(SmartAccountRecordCodec.Decode(bytes), 14);
            BigInteger status = SmartAccountRecordCodec.Unsigned(record[0]);
            if (status > (int)SmartAccountStatus.Frozen)
                throw new FormatException("The account status is not defined.");
            AccountControl control = new()
            {
                Status = (SmartAccountStatus)(int)status,
                Custody = SmartAccountRecordCodec.Address(record[1]),
                RecoveryAuthority = SmartAccountRecordCodec.Address(record[2]),
                AuthorityEpoch = (ulong)SmartAccountRecordCodec.Unsigned(record[3]),
                ConfigurationNonce = (ulong)SmartAccountRecordCodec.Unsigned(record[4]),
                NextModuleId = (ulong)SmartAccountRecordCodec.Unsigned(record[5]),
                NextIntentId = (ulong)SmartAccountRecordCodec.Unsigned(record[6]),
                DefaultOperationAuthorization = SmartAccountRecordCodec.Boolean(record[7]),
                DefaultMessageAuthorization = SmartAccountRecordCodec.Boolean(record[8]),
                RecoveryTimelockMs = (ulong)SmartAccountRecordCodec.Unsigned(record[9]),
                HookOrderRevision = (ulong)SmartAccountRecordCodec.Unsigned(record[10]),
                RequiredPolicyId = (ulong)SmartAccountRecordCodec.Unsigned(record[11]),
                ControlRevision = (ulong)SmartAccountRecordCodec.Unsigned(record[12]),
                OwnerOnlyRecovery = SmartAccountRecordCodec.Boolean(record[13]),
            };
            if (control.Custody == UInt160.Zero || control.AuthorityEpoch < 1 || control.NextModuleId < 1
                || control.NextIntentId < 1 || control.ControlRevision < 1
                || control.RecoveryTimelockMs < RecoveryTimelockMinMs
                || control.RecoveryTimelockMs > RecoveryTimelockMaxMs)
                throw new FormatException("The account control record is outside the protocol domain.");
            return control;
        }
    }

    /// <summary>
    /// v4 module instance record (spec §7.2/§7.3), stored under
    /// 0x52 + accountId + moduleId[8 BE].
    ///
    /// The core registers validator, hook and recovery-seat modules (the
    /// recovery seat is the exclusive caller of the reset entry, spec
    /// §7.1/§12.5). The encoded shape is retained from the full profile, so the
    /// capability and policy back-pointer fields survive a decode; the core
    /// never sets them.
    /// </summary>
    internal sealed class ModuleInstance
    {
        internal byte ModuleType;
        internal UInt160 ContractHash = UInt160.Zero;
        internal ulong ContractId;
        internal ulong UpdateCounter;
        internal byte[] NefSha256 = new byte[32];
        internal byte[] ProfileSha256 = new byte[32];
        internal ulong ModuleRevision;
        internal ulong CredentialGeneration;
        internal bool InstanceIsolation;
        internal bool MessageCapability;                 // reserved
        internal bool ThresholdMemberEligible;           // reserved
        internal BigInteger ActivePolicyId = BigInteger.Zero; // reserved

        internal bool IsValidator => ModuleType == SmartAccountModuleProtocol.ModuleTypeCodeValidator;
        internal bool IsHook => ModuleType == SmartAccountModuleProtocol.ModuleTypeCodeHook;
        internal bool IsRecovery => ModuleType == SmartAccountModuleProtocol.ModuleTypeCodeRecovery;

        internal Array ToStackItem() => new(new StackItem[]
        {
            (int)ModuleType, ContractHash.ToArray(), ContractId, UpdateCounter,
            NefSha256, ProfileSha256, ModuleRevision, CredentialGeneration,
            InstanceIsolation, MessageCapability, ThresholdMemberEligible, ActivePolicyId,
        });

        internal byte[] Serialize() => SmartAccountRecordCodec.Encode(ToStackItem());

        internal static ModuleInstance Decode(ReadOnlyMemory<byte> bytes)
        {
            Array record = SmartAccountRecordCodec.Exact(SmartAccountRecordCodec.Decode(bytes), 12);
            BigInteger type = SmartAccountRecordCodec.Unsigned(record[0]);
            if (type != SmartAccountModuleProtocol.ModuleTypeCodeValidator
                && type != SmartAccountModuleProtocol.ModuleTypeCodeHook
                && type != SmartAccountModuleProtocol.ModuleTypeCodeRecovery)
                throw new FormatException("The module type code is not supported.");
            ModuleInstance module = new()
            {
                ModuleType = (byte)type,
                ContractHash = SmartAccountRecordCodec.Address(record[1]),
                ContractId = (ulong)SmartAccountRecordCodec.Unsigned(record[2]),
                UpdateCounter = (ulong)SmartAccountRecordCodec.Unsigned(record[3]),
                NefSha256 = SmartAccountRecordCodec.Fixed(record[4], 32),
                ProfileSha256 = SmartAccountRecordCodec.Fixed(record[5], 32),
                ModuleRevision = (ulong)SmartAccountRecordCodec.Unsigned(record[6]),
                CredentialGeneration = (ulong)SmartAccountRecordCodec.Unsigned(record[7]),
                InstanceIsolation = SmartAccountRecordCodec.Boolean(record[8]),
                MessageCapability = SmartAccountRecordCodec.Boolean(record[9]),
                ThresholdMemberEligible = SmartAccountRecordCodec.Boolean(record[10]),
                ActivePolicyId = SmartAccountRecordCodec.Unsigned(record[11]),
            };
            if (module.ContractHash == UInt160.Zero || module.ModuleRevision < 1 || module.CredentialGeneration < 1)
                throw new FormatException("The module instance record is outside the protocol domain.");
            return module;
        }
    }
    /// <summary>Core-owned threshold policy (spec §3.5), stored under 0x5B + accountId + policyId[8 BE].</summary>
    internal sealed class ThresholdPolicyRecord
    {
        internal ulong Threshold;
        internal BigInteger[] MemberIds = [];
        internal bool Active;
        internal ulong CredentialGeneration;

        internal Array ToStackItem() => new(new StackItem[]
        {
            Threshold, SmartAccountRecordCodec.IntegerArray(MemberIds), Active, CredentialGeneration,
        });

        internal byte[] Serialize() => SmartAccountRecordCodec.Encode(ToStackItem());

        internal static ThresholdPolicyRecord Decode(ReadOnlyMemory<byte> bytes)
        {
            Array record = SmartAccountRecordCodec.Exact(SmartAccountRecordCodec.Decode(bytes), 4);
            ThresholdPolicyRecord policy = new()
            {
                Threshold = (ulong)SmartAccountRecordCodec.Unsigned(record[0]),
                MemberIds = SmartAccountRecordCodec.Integers(record[1],
                    SmartAccountModuleProtocol.MaxThresholdPolicyMembers),
                Active = SmartAccountRecordCodec.Boolean(record[2]),
                CredentialGeneration = (ulong)SmartAccountRecordCodec.Unsigned(record[3]),
            };
            // The policy record mirrors the write rules of both kernels: an
            // active policy is routable, so its threshold, member count and
            // membership must all be inside the profile; a deactivated policy
            // carries no members. A repeated member would count twice towards
            // the threshold, so membership is always distinct.
            if (policy.Active)
            {
                if (policy.Threshold < (ulong)SmartAccountModuleProtocol.MinThresholdPolicyValue
                    || policy.Threshold > (ulong)SmartAccountModuleProtocol.MaxThresholdPolicyValue)
                    throw new FormatException("The threshold policy record has an out-of-range threshold.");
                if (policy.MemberIds.Length < 1
                    || policy.MemberIds.Length > SmartAccountModuleProtocol.MaxThresholdPolicyMembers
                    || policy.Threshold > (ulong)policy.MemberIds.Length)
                    throw new FormatException("The threshold policy record exceeds the member domain.");
            }
            else if (policy.MemberIds.Length != 0)
                throw new FormatException("A deactivated threshold policy carries no members.");
            for (int i = 0; i < policy.MemberIds.Length; i++)
            {
                if (policy.MemberIds[i] < 1)
                    throw new FormatException("The threshold policy record carries a non-positive member id.");
                for (int j = 0; j < i; j++)
                    if (policy.MemberIds[j] == policy.MemberIds[i])
                        throw new FormatException("The threshold policy record repeats a member id.");
            }
            return policy;
        }
    }
    /// <summary>Message policy payload held by its governance provider and committed by the core.</summary>
    internal sealed class MessageSubjectRecord
    {
        internal byte[][] Subjects = [];
        internal ulong Threshold;
        internal ulong SubjectRevision;

        internal Array ToStackItem() => new(new StackItem[]
        {
            SmartAccountRecordCodec.BytesArray(Subjects), Threshold, SubjectRevision,
        });

        internal byte[] Serialize() => SmartAccountRecordCodec.Encode(ToStackItem());

        internal static MessageSubjectRecord Decode(ReadOnlyMemory<byte> bytes)
        {
            Array record = SmartAccountRecordCodec.Exact(SmartAccountRecordCodec.Decode(bytes), 3);
            MessageSubjectRecord subjects = new()
            {
                Subjects = SmartAccountRecordCodec.BytesArray(record[0],
                    SmartAccountModuleProtocol.MessageSubjectKeysMax, 32),
                Threshold = (ulong)SmartAccountRecordCodec.Unsigned(record[1]),
                SubjectRevision = (ulong)SmartAccountRecordCodec.Unsigned(record[2]),
            };
            if (subjects.Subjects.Length > SmartAccountModuleProtocol.MessageSubjectKeysMax
                || subjects.Threshold > (ulong)subjects.Subjects.Length)
                throw new FormatException("The message subject record exceeds the profile bound.");
            return subjects;
        }
    }
}
