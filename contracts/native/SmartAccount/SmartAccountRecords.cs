// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccountRecords.cs file belongs to the neo project and is free software distributed under the MIT software
// license, see the accompanying file LICENSE in the main directory of the repository or
// http://www.opensource.org/licenses/mit-license.php for more details.
//
// Redistribution and use in source and binary forms with or without modifications are permitted.

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

    /// <summary> Explicit v4.1 schema identity. A canonical record starts with <c>[kind, version]</c>, so an unknown
    /// version, a record of the other kind, or any untagged arity fails closed instead of being guessed into a version.
    /// There is exactly one record shape: the tagged current one. </summary>
    internal static class SmartAccountRecordSchema
    {
        internal const int Version = 1;

        internal const int AccountControlFields = 9;
        internal const int AccountControlTaggedFields = 2 + AccountControlFields;

        internal const int ModuleInstanceFields = 14;
        internal const int ModuleInstanceTaggedFields = 2 + ModuleInstanceFields;

        private static readonly byte[] AccountControlKind = "SA:AC"u8.ToArray();
        private static readonly byte[] ModuleInstanceKind = "SA:MI"u8.ToArray();

        internal static byte[] AccountControlTag => AccountControlKind;

        internal static byte[] ModuleInstanceTag => ModuleInstanceKind;

        internal static bool IsAccountControlTag(StackItem item) => IsTag(item, AccountControlKind);

        internal static bool IsModuleInstanceTag(StackItem item) => IsTag(item, ModuleInstanceKind);

        private static bool IsTag(StackItem item, byte[] kind) =>
            item is ByteString value && value.Size == kind.Length && value.GetSpan().SequenceEqual(kind);

        internal static void RequireVersion(StackItem item, string record)
        {
            if (SmartAccountRecordCodec.Unsigned(item) != Version)
                throw new FormatException($"The {record} schema version is not supported.");
        }
    }

    /// <summary> Canonical record codec. Every record is a positional Array encoded with the NeoVM binary serializer; decoding
    /// rejects any byte string that does not re-encode to itself, so a record can never carry two encodings. </summary>
    internal static class SmartAccountRecordCodec
    {
        private const uint MaxBytes = 16384;
        private const uint MaxItems = 16384;

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

        /// <summary> A record is a positional Array of scalars only: nested records are Arrays, leaves are Integer, ByteString or
        /// Boolean. Every other stack item (Struct, Buffer, Map, Null, interop) would carry a type marker that no record field ever
        /// produces, so it is rejected here instead of being silently flattened by whichever field reads it later. </summary>
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

        internal static byte[] Fixed(StackItem item, int size)
        {
            if (item is not ByteString value || value.Size != size)
                throw new FormatException("The SmartAccount record field must be a fixed-width ByteString.");
            return value.GetSpan().ToArray();
        }

        internal static UInt160 Address(StackItem item)
        {
            if (item is not ByteString value || value.Size != UInt160.Length)
                throw new FormatException("The SmartAccount record field must be a fixed-width ByteString.");
            return new UInt160(value.GetSpan());
        }

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
    }

    /// <summary>v4 account control metadata (spec §7.2, §10), stored under 0x51 + accountId: custody/status, replay
    /// counters, built-in route switches and the generic mandatory-validator route. Recovery, threshold,
    /// message-roster and hook-order policy belong to modules. The only recognized shape is the tagged current one:
    /// [kind, version, 9 fields]. </summary>
    internal sealed class AccountControl
    {
        internal SmartAccountStatus Status;
        internal UInt160 Custody = UInt160.Zero;
        internal ulong AuthorityEpoch;
        internal ulong ConfigurationNonce;
        internal ulong NextModuleId;
        internal bool DefaultOperationAuthorization;
        internal bool DefaultMessageAuthorization;
        internal ulong RequiredValidatorId;
        internal ulong ControlRevision;

        internal static AccountControl Create(UInt160 custody) => new()
        {
            Status = SmartAccountStatus.Active, Custody = custody, AuthorityEpoch = 1, ConfigurationNonce = 0,
            NextModuleId = 1, DefaultOperationAuthorization = true, DefaultMessageAuthorization = true,
            RequiredValidatorId = 0, ControlRevision = 1,
        };

        internal BigInteger AllocateModuleId()
        {
            if (NextModuleId == ulong.MaxValue)
                throw new InvalidOperationException("The module id allocator is exhausted.");
            return NextModuleId++;
        }

        /// <summary> Closes a configuration transition: the configuration nonce kills every operation that signed against the
        /// previous module model and the control revision records that the account was reshaped. </summary>
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

        internal Array ToStackItem()
        {
            Array record = new()
            {
                SmartAccountRecordSchema.AccountControlTag,
                SmartAccountRecordSchema.Version,
                (int)Status,
                Custody.ToArray(),
                AuthorityEpoch,
                ConfigurationNonce,
                NextModuleId,
                DefaultOperationAuthorization,
                DefaultMessageAuthorization,
                RequiredValidatorId,
                ControlRevision,
            };
            return record;
        }

        internal byte[] Serialize() => SmartAccountRecordCodec.Encode(ToStackItem());

        internal static AccountControl Decode(ReadOnlyMemory<byte> bytes)
        {
            Array record = SmartAccountRecordCodec.Decode(bytes);
            if (record.Count != SmartAccountRecordSchema.AccountControlTaggedFields)
                throw new FormatException("The account control record has an unknown field count.");
            if (!SmartAccountRecordSchema.IsAccountControlTag(record[0]))
                throw new FormatException("The tagged record is not an account control record.");
            SmartAccountRecordSchema.RequireVersion(record[1], "account control");
            AccountControl control = new()
            {
                Status = StatusOf(record[2]), Custody = SmartAccountRecordCodec.Address(record[3]),
                AuthorityEpoch = (ulong)SmartAccountRecordCodec.Unsigned(record[4]),
                ConfigurationNonce = (ulong)SmartAccountRecordCodec.Unsigned(record[5]),
                NextModuleId = (ulong)SmartAccountRecordCodec.Unsigned(record[6]),
                DefaultOperationAuthorization = SmartAccountRecordCodec.Boolean(record[7]),
                DefaultMessageAuthorization = SmartAccountRecordCodec.Boolean(record[8]),
                RequiredValidatorId = (ulong)SmartAccountRecordCodec.Unsigned(record[9]),
                ControlRevision = (ulong)SmartAccountRecordCodec.Unsigned(record[10]), };
            RequireDomain(control);
            return control;
        }

        private static SmartAccountStatus StatusOf(StackItem item)
        {
            BigInteger status = SmartAccountRecordCodec.Unsigned(item);
            if (status > (int)SmartAccountStatus.Frozen)
                throw new FormatException("The account status is not defined.");
            return (SmartAccountStatus)(int)status;
        }

        private static void RequireDomain(AccountControl control)
        {
            if (control.Custody == UInt160.Zero || control.AuthorityEpoch < 1 || control.NextModuleId < 1
                || control.ControlRevision < 1)
                throw new FormatException("The account control record is outside the protocol domain.");
        }
    }

    /// <summary> v4 module instance record (spec §7.2/§7.3), stored under 0x52 + accountId + moduleId[8 BE]. The core
    /// stores module identity, code binding, credential generation and generic capability metadata only. The only
    /// recognized shape is the tagged current one: [kind, version, 14 fields]. </summary>
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
        internal bool MessageCapability;
        internal bool ThresholdMemberEligible;
        internal bool CompositeLayer;
        internal bool Governance;
        internal bool HookPlanner;

        internal bool IsValidator => ModuleType == SmartAccountModuleProtocol.ModuleTypeCodeValidator;
        internal bool IsHook => ModuleType == SmartAccountModuleProtocol.ModuleTypeCodeHook;
        internal bool IsRecovery => ModuleType == SmartAccountModuleProtocol.ModuleTypeCodeRecovery;

        internal Array ToStackItem() => new()
        {
            SmartAccountRecordSchema.ModuleInstanceTag,
            SmartAccountRecordSchema.Version,
            (int)ModuleType,
            ContractHash.ToArray(),
            ContractId,
            UpdateCounter,
            NefSha256,
            ProfileSha256,
            ModuleRevision,
            CredentialGeneration,
            InstanceIsolation,
            MessageCapability,
            ThresholdMemberEligible,
            CompositeLayer,
            Governance,
            HookPlanner,
        };

        internal byte[] Serialize() => SmartAccountRecordCodec.Encode(ToStackItem());

        internal static ModuleInstance Decode(ReadOnlyMemory<byte> bytes)
        {
            Array record = SmartAccountRecordCodec.Decode(bytes);
            if (record.Count != SmartAccountRecordSchema.ModuleInstanceTaggedFields)
                throw new FormatException("The module instance record has an unknown field count.");
            if (!SmartAccountRecordSchema.IsModuleInstanceTag(record[0]))
                throw new FormatException("The tagged record is not a module instance record.");
            SmartAccountRecordSchema.RequireVersion(record[1], "module instance");
            return Read(record, 2);
        }

        private static ModuleInstance Read(Array record, int offset)
        {
            BigInteger type = SmartAccountRecordCodec.Unsigned(record[offset]);
            if (!SmartAccountModuleProtocol.IsModuleTypeCode(type))
                throw new FormatException("The module type code is not supported.");
            ModuleInstance module = new()
            {
                ModuleType = (byte)type, ContractHash = SmartAccountRecordCodec.Address(record[offset + 1]),
                ContractId = (ulong)SmartAccountRecordCodec.Unsigned(record[offset + 2]),
                UpdateCounter = (ulong)SmartAccountRecordCodec.Unsigned(record[offset + 3]),
                NefSha256 = SmartAccountRecordCodec.Fixed(record[offset + 4], 32),
                ProfileSha256 = SmartAccountRecordCodec.Fixed(record[offset + 5], 32),
                ModuleRevision = (ulong)SmartAccountRecordCodec.Unsigned(record[offset + 6]),
                CredentialGeneration = (ulong)SmartAccountRecordCodec.Unsigned(record[offset + 7]),
                InstanceIsolation = SmartAccountRecordCodec.Boolean(record[offset + 8]),
                MessageCapability = SmartAccountRecordCodec.Boolean(record[offset + 9]),
                ThresholdMemberEligible = SmartAccountRecordCodec.Boolean(record[offset + 10]),
                CompositeLayer = SmartAccountRecordCodec.Boolean(record[offset + 11]),
                Governance = SmartAccountRecordCodec.Boolean(record[offset + 12]),
                HookPlanner = SmartAccountRecordCodec.Boolean(record[offset + 13]),
            };
            if (module.ContractHash == UInt160.Zero || module.ModuleRevision < 1 || module.CredentialGeneration < 1)
                throw new FormatException("The module instance record is outside the protocol domain.");
            return module;
        }
    }
}
