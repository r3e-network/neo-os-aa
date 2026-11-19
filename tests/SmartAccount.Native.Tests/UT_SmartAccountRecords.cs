// Copyright (C) 2015-2026 The Neo Project.
//
// UT_SmartAccountRecords.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.Extensions;
using Neo.IO;
using Neo.SmartContract.Native;
using Neo.VM.Types;
using System;
using System.Linq;
using System.Numerics;
using Array = Neo.VM.Types.Array;
using Boolean = Neo.VM.Types.Boolean;

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// Canonical record codec of the v4 native kernel (spec §7.2/§7.3): every
    /// record is a positional Array whose only legal encoding is the one it
    /// re-encodes to, and every record is validated back into the protocol
    /// domain on decode.
    /// </summary>
    [TestClass]
    public class UT_SmartAccountRecords
    {
        private static UInt160 Address(byte n) => new(Enumerable.Repeat(n, 20).ToArray());
        private static byte[] Bytes(byte n) => Enumerable.Repeat(n, 32).ToArray();
        private static byte[] Encode(StackItem item) => SmartAccountRecordCodec.Encode((Array)item);

        /// <summary>The generic codec alone must reject the encoding.</summary>
        private static void Malformed(Array record) =>
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Decode(Encode(record)));

        /// <summary>The typed record decoder must reject the value domain.</summary>
        private static void Malformed(Array record, Func<ReadOnlyMemory<byte>, object> decode) =>
            Assert.ThrowsExactly<FormatException>(() => decode(Encode(record)));

        private static AccountControl Control() =>
            AccountControl.Create(Address(1), SmartAccountModuleProtocol.RecoveryTimelockMinMs);

        private static ModuleInstance Module(byte type = (byte)SmartAccountModuleProtocol.ModuleTypeCodeValidator) => new()
        {
            ModuleType = type,
            ContractHash = Address(3),
            ContractId = 7,
            UpdateCounter = 2,
            NefSha256 = Bytes(4),
            ProfileSha256 = Bytes(5),
            ModuleRevision = 1,
            CredentialGeneration = 1,
        };

        [TestMethod]
        public void AccountControlRoundTripsThroughTheCanonicalCodec()
        {
            var control = Control();
            Assert.AreEqual(SmartAccountStatus.Active, control.Status);
            Assert.AreEqual(BigInteger.One, control.AllocateModuleId());
            Assert.AreEqual(new BigInteger(2), control.AllocateModuleId());
            Assert.AreEqual(BigInteger.One, control.AllocateIntentId());
            control.Advance();
            control.HookOrderRevision += 1;
            control.OwnerOnlyRecovery = true;

            byte[] encoded = control.Serialize();
            var decoded = AccountControl.Decode(encoded);
            Assert.AreEqual(14, SmartAccountRecordCodec.Decode(encoded).Count);
            Assert.AreEqual(control.Status, decoded.Status);
            Assert.AreEqual(control.Custody, decoded.Custody);
            Assert.AreEqual(control.RecoveryAuthority, decoded.RecoveryAuthority);
            Assert.AreEqual(control.AuthorityEpoch, decoded.AuthorityEpoch);
            Assert.AreEqual(control.ConfigurationNonce, decoded.ConfigurationNonce);
            Assert.AreEqual(control.NextModuleId, decoded.NextModuleId);
            Assert.AreEqual(control.NextIntentId, decoded.NextIntentId);
            Assert.IsTrue(decoded.DefaultOperationAuthorization);
            Assert.IsTrue(decoded.DefaultMessageAuthorization);
            Assert.AreEqual(control.RecoveryTimelockMs, decoded.RecoveryTimelockMs);
            Assert.AreEqual(control.HookOrderRevision, decoded.HookOrderRevision);
            Assert.AreEqual(control.ControlRevision, decoded.ControlRevision);
            Assert.IsTrue(decoded.OwnerOnlyRecovery);
            Assert.AreSequenceEqual(encoded, decoded.Serialize());
        }

        [TestMethod]
        public void AccountControlRejectsRecordsOutsideTheProtocolDomain()
        {
            foreach (var (index, value) in new (int, StackItem)[]
            {
                (0, new Integer(3)),                       // undefined status
                (1, new ByteString(UInt160.Zero.ToArray())), // zero custody
                (3, new Integer(0)),                       // epoch below one
                (5, new Integer(0)),                       // module id allocator reset
                (6, new Integer(0)),                       // intent id allocator reset
                (9, new Integer(1)),                       // timelock below the floor
                (12, new Integer(0)),                      // control revision reset
            })
            {
                var record = Control().ToStackItem();
                record[index] = value;
                Malformed(record, AccountControl.Decode);
            }
            var shortRecord = Control().ToStackItem();
            shortRecord.Add(new Integer(1));
            Malformed(shortRecord, AccountControl.Decode);
        }

        [TestMethod]
        public void AccountControlAllocatorsAreExhaustible()
        {
            var control = Control();
            control.NextModuleId = ulong.MaxValue;
            Assert.ThrowsExactly<InvalidOperationException>(() => control.AllocateModuleId());
            control.NextIntentId = ulong.MaxValue;
            Assert.ThrowsExactly<InvalidOperationException>(() => control.AllocateIntentId());
            control.ConfigurationNonce = ulong.MaxValue;
            Assert.ThrowsExactly<InvalidOperationException>(() => control.Advance());
        }

        [TestMethod]
        public void ModuleInstanceRoundTripsAndKeepsItsRoleAndPolicyBackPointer()
        {
            var module = Module();
            module.ActivePolicyId = new BigInteger(9);
            module.MessageCapability = true;
            var decoded = ModuleInstance.Decode(module.Serialize());
            Assert.AreEqual(12, SmartAccountRecordCodec.Decode(module.Serialize()).Count);
            Assert.IsTrue(module.IsValidator);
            Assert.IsFalse(module.IsHook);
            Assert.AreEqual(module.ContractHash, decoded.ContractHash);
            Assert.AreEqual(module.ContractId, decoded.ContractId);
            Assert.AreEqual(module.UpdateCounter, decoded.UpdateCounter);
            Assert.AreSequenceEqual(module.NefSha256, decoded.NefSha256);
            Assert.AreSequenceEqual(module.ProfileSha256, decoded.ProfileSha256);
            Assert.AreEqual(module.CredentialGeneration, decoded.CredentialGeneration);
            Assert.IsTrue(decoded.MessageCapability);
            Assert.AreEqual(module.ActivePolicyId, decoded.ActivePolicyId);
            Assert.AreSequenceEqual(module.Serialize(), decoded.Serialize());

            var hook = Module((byte)SmartAccountModuleProtocol.ModuleTypeCodeHook);
            Assert.IsTrue(hook.IsHook);
            Assert.IsFalse(hook.IsValidator);
        }

        [TestMethod]
        public void ModuleInstanceRejectsUnknownTypesAndOutOfDomainFields()
        {
            var unknownType = Module().ToStackItem();
            unknownType[0] = new Integer(99);
            Malformed(unknownType, ModuleInstance.Decode);

            var zeroContract = Module().ToStackItem();
            zeroContract[1] = new ByteString(UInt160.Zero.ToArray());
            Malformed(zeroContract, ModuleInstance.Decode);

            var zeroRevision = Module().ToStackItem();
            zeroRevision[6] = new Integer(0);
            Malformed(zeroRevision, ModuleInstance.Decode);

            var zeroGeneration = Module().ToStackItem();
            zeroGeneration[7] = new Integer(0);
            Malformed(zeroGeneration, ModuleInstance.Decode);

            var shortNef = Module().ToStackItem();
            shortNef[4] = new ByteString(new byte[31]);
            Malformed(shortNef, ModuleInstance.Decode);
        }

        [TestMethod]
        public void HookOrderThresholdPolicyAndMessageSubjectsRoundTrip()
        {
            var order = new HookOrderRecord { HookIds = [new BigInteger(4), new BigInteger(2)], Revision = 3 };
            var decodedOrder = HookOrderRecord.Decode(order.Serialize());
            Assert.AreEqual(2, SmartAccountRecordCodec.Decode(order.Serialize()).Count);
            Assert.AreSequenceEqual([new BigInteger(4), new BigInteger(2)], decodedOrder.HookIds);
            Assert.AreEqual(3UL, decodedOrder.Revision);

            var policy = new ThresholdPolicyRecord { Threshold = 2, MemberIds = [BigInteger.One, new BigInteger(2)], Active = true, CredentialGeneration = 5 };
            var decodedPolicy = ThresholdPolicyRecord.Decode(policy.Serialize());
            Assert.AreEqual(4, SmartAccountRecordCodec.Decode(policy.Serialize()).Count);
            Assert.AreEqual(2UL, decodedPolicy.Threshold);
            Assert.AreSequenceEqual(policy.MemberIds, decodedPolicy.MemberIds);
            Assert.IsTrue(decodedPolicy.Active);
            Assert.AreEqual(5UL, decodedPolicy.CredentialGeneration);

            var subjects = new MessageSubjectRecord { Subjects = [Address(1).ToArray(), Bytes(6)], Threshold = 1, SubjectRevision = 4 };
            var decodedSubjects = MessageSubjectRecord.Decode(subjects.Serialize());
            Assert.AreEqual(3, SmartAccountRecordCodec.Decode(subjects.Serialize()).Count);
            Assert.HasCount(2, decodedSubjects.Subjects);
            Assert.AreEqual(1UL, decodedSubjects.Threshold);
            Assert.AreEqual(4UL, decodedSubjects.SubjectRevision);
        }

        [TestMethod]
        public void ThresholdPolicyAndHookOrderRejectOutOfDomainValues()
        {
            var policy = new ThresholdPolicyRecord { Threshold = 2, MemberIds = [BigInteger.One, new BigInteger(2)], Active = true, CredentialGeneration = 1 };
            var shortMembers = policy.ToStackItem();
            shortMembers[1] = SmartAccountRecordCodec.IntegerArray([BigInteger.One]);
            Malformed(shortMembers, ThresholdPolicyRecord.Decode);

            var repeatedMembers = policy.ToStackItem();
            repeatedMembers[1] = SmartAccountRecordCodec.IntegerArray([BigInteger.One, BigInteger.One]);
            Malformed(repeatedMembers, ThresholdPolicyRecord.Decode);

            // An active policy is routable, so a zero threshold never decodes.
            var zeroThreshold = policy.ToStackItem();
            zeroThreshold[0] = new Integer(0);
            Malformed(zeroThreshold, ThresholdPolicyRecord.Decode);

            // Deactivation clears the member set (both kernels write it that way).
            var inactiveWithMembers = policy.ToStackItem();
            inactiveWithMembers[2] = StackItem.False;
            Malformed(inactiveWithMembers, ThresholdPolicyRecord.Decode);

            var repeatedHooks = new HookOrderRecord { HookIds = [BigInteger.One, BigInteger.One], Revision = 1 };
            Malformed(repeatedHooks.ToStackItem(), HookOrderRecord.Decode);

            var zeroHook = new HookOrderRecord { HookIds = [BigInteger.Zero], Revision = 1 };
            Malformed(zeroHook.ToStackItem(), HookOrderRecord.Decode);
        }

        [TestMethod]
        public void ConfigurationRecoveryAndMigrationRecordsRoundTrip()
        {
            var proposed = (BigInteger)1000;
            var intent = new ConfigurationIntentRecord
            {
                IntentId = new BigInteger(3),
                ProposedAt = proposed,
                MatureAt = proposed + SmartAccountModuleProtocol.ModuleChangeDelayMs,
                ExpiresAt = proposed + SmartAccountModuleProtocol.ModuleChangeDelayMs
                    + SmartAccountModuleProtocol.ConfigurationIntentExpiryMs,
                AuthorityEpoch = new BigInteger(2),
                ActionDigest = Bytes(7),
                Actions = new Array([new Integer(SmartAccountModuleProtocol.ActionInstallModule)]),
                Resources = [new byte[] { 1, 2 }, new byte[] { 3 }],
            };
            var decodedIntent = ConfigurationIntentRecord.Decode(intent.Serialize());
            Assert.AreEqual(8, SmartAccountRecordCodec.Decode(intent.Serialize()).Count);
            Assert.AreEqual(intent.ProposedAt, decodedIntent.ProposedAt);
            Assert.AreEqual(intent.MatureAt, decodedIntent.MatureAt);
            Assert.AreEqual(intent.ExpiresAt, decodedIntent.ExpiresAt);
            Assert.AreEqual(intent.AuthorityEpoch, decodedIntent.AuthorityEpoch);
            Assert.AreEqual(intent.IntentId, decodedIntent.IntentId);
            Assert.AreSequenceEqual(intent.ActionDigest, decodedIntent.ActionDigest);
            Assert.AreEqual(1, decodedIntent.Actions.Count);
            Assert.HasCount(2, decodedIntent.Resources);

            // The timelock window is part of the record domain: a manually
            // shortened maturity or expiry never decodes.
            var earlyMaturity = intent.ToStackItem();
            earlyMaturity[2] = proposed + 1;
            Malformed(earlyMaturity, ConfigurationIntentRecord.Decode);
            var shortWindow = intent.ToStackItem();
            shortWindow[3] = proposed + SmartAccountModuleProtocol.ModuleChangeDelayMs + 1;
            Malformed(shortWindow, ConfigurationIntentRecord.Decode);
            var emptyActions = intent.ToStackItem();
            emptyActions[6] = new Array();
            Malformed(emptyActions, ConfigurationIntentRecord.Decode);
            var zeroIntent = intent.ToStackItem();
            zeroIntent[0] = new Integer(0);
            Malformed(zeroIntent, ConfigurationIntentRecord.Decode);

            var recovery = new CoreRecoveryRecord
            {
                NewCustody = Address(8),
                InitiatedAt = new BigInteger(10),
                MatureAt = new BigInteger(20),
                AuthorityEpochAtInit = new BigInteger(1),
            };
            var decodedRecovery = CoreRecoveryRecord.Decode(recovery.Serialize());
            Assert.AreEqual(4, SmartAccountRecordCodec.Decode(recovery.Serialize()).Count);
            Assert.AreEqual(recovery.NewCustody, decodedRecovery.NewCustody);
            Assert.AreEqual(recovery.MatureAt, decodedRecovery.MatureAt);

            var migration = new MigrationStateRecord
            {
                Status = (byte)SmartAccountStatus.MigrationRequired,
                ManifestDigest = Bytes(9),
                Classification = "legacy-v3",
                LegacyModuleCount = 4,
                ImportedAt = 1_700_000_000_000,
            };
            var decodedMigration = MigrationStateRecord.Decode(migration.Serialize());
            Assert.AreEqual(5, SmartAccountRecordCodec.Decode(migration.Serialize()).Count);
            Assert.AreEqual(migration.Status, decodedMigration.Status);
            Assert.AreSequenceEqual(migration.ManifestDigest, decodedMigration.ManifestDigest);
            Assert.AreEqual(migration.Classification, decodedMigration.Classification);
            Assert.AreEqual(migration.LegacyModuleCount, decodedMigration.LegacyModuleCount);
            Assert.AreEqual(migration.ImportedAt, decodedMigration.ImportedAt);

            var undefinedStatus = migration.ToStackItem();
            undefinedStatus[0] = new Integer(3);
            Malformed(undefinedStatus, MigrationStateRecord.Decode);
            var longClassification = migration.ToStackItem();
            longClassification[2] = new ByteString(new byte[65]);
            Malformed(longClassification, MigrationStateRecord.Decode);
            // Record strings are canonical UTF-8, not replacement-decoded bytes.
            var invalidUtf8 = migration.ToStackItem();
            invalidUtf8[2] = new ByteString(new byte[] { 0xC3, 0x28 });
            Malformed(invalidUtf8, MigrationStateRecord.Decode);
        }

        [TestMethod]
        public void CodecRejectsNonCanonicalAndOversizedRecordBytes()
        {
            var record = Control().ToStackItem();
            byte[] canonical = Encode(record);
            Array decoded = SmartAccountRecordCodec.Decode(canonical);
            Assert.AreSequenceEqual(canonical, SmartAccountRecordCodec.Encode(decoded));

            // A trailing byte is a second encoding of the same record.
            byte[] extended = [.. canonical, 0];
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Decode(extended));
            // A truncated encoding cannot be deserialized.
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Decode(canonical.AsSpan(0, canonical.Length - 1).ToArray()));
            // A container that is not an Array is never a record.
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Decode(Encode(new Struct(record))));
            // Struct, Buffer and Map can never be a record field: a nested Struct
            // is rejected even though it re-encodes to the same bytes.
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Decode(Encode(new Array([new Struct([new Integer(1)])]))));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Decode(Encode(new Array([new Neo.VM.Types.Buffer(new byte[1])]))));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Decode(Encode(new Array([new Map()]))));
            // A non-minimal VarInt header is a second encoding of the same record.
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Decode(
                new byte[] { 0xFD, (byte)record.Count, 0x00 }.Concat(canonical[1..]).ToArray()));
        }

        [TestMethod]
        public void TypedAccessorsValidateTheirDomain()
        {
            Assert.AreEqual(BigInteger.One, SmartAccountRecordCodec.Unsigned(new Integer(1)));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Unsigned(new Integer(-1)));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Unsigned(new ByteString(new byte[1])));
            Assert.IsTrue(SmartAccountRecordCodec.Boolean(StackItem.True));
            Assert.IsFalse(SmartAccountRecordCodec.Boolean(StackItem.False));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Boolean(new Integer(1)));
            Assert.AreEqual(Address(1), SmartAccountRecordCodec.Address(new ByteString(Address(1).ToArray())));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Address(new ByteString(new byte[19])));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Fixed(new ByteString(new byte[33]), 32));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Bytes(new ByteString(new byte[9]), 8));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Text(new ByteString(new byte[] { 0xFF }), 8));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Exact(new Array([new Integer(1)]), 2));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.Integers(new Array([new ByteString(new byte[1])]), 4));
            Assert.ThrowsExactly<FormatException>(() => SmartAccountRecordCodec.BytesArray(new Array([new Integer(1)]), 4, 8));
        }
    }
}
