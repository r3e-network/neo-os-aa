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
            AccountControl.Create(Address(1), AccountControl.RecoveryTimelockMinMs);

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
            // A configuration transition advances both counters by exactly one;
            // intent ids are user-space now, so the intent allocator is inert.
            control.Advance();
            Assert.AreEqual(1UL, control.ConfigurationNonce);
            Assert.AreEqual(2UL, control.ControlRevision);
            Assert.AreEqual(1UL, control.NextIntentId, "the reserved intent slot is never advanced");
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

        /// <summary>
        /// H-3 internal readiness (R-11-13/R-14-11): an immediate credential
        /// revocation advances the instance's CredentialGeneration in place —
        /// the instance record, its storage and its hook order all survive, so
        /// the record codec must round-trip every incremented generation the
        /// native advancement path (whose authorized entry is still to be
        /// defined by the spec) will ever write.
        /// </summary>
        [TestMethod]
        public void ModuleInstanceCarriesEveryIncrementedCredentialGeneration()
        {
            foreach (ulong generation in new ulong[] { 2, 3, ulong.MaxValue })
            {
                var module = Module();
                module.CredentialGeneration = generation;
                var decoded = ModuleInstance.Decode(module.Serialize());
                Assert.AreEqual(generation, decoded.CredentialGeneration);
                Assert.AreSequenceEqual(module.Serialize(), decoded.Serialize());
            }
        }

        /// <summary>
        /// H-4 internal readiness (§12.1/R-12-02): the recovery model needs the
        /// account control record to carry a non-zero recovery authority (set
        /// by a governance action-8 restricted write whose native entry is
        /// still to be defined by the spec) alongside the 7—90 day timelock
        /// domain the decoder already enforces on both ends.
        /// </summary>
        [TestMethod]
        public void AccountControlCarriesARecoveryAuthorityAndTheFullTimelockDomain()
        {
            var control = Control();
            control.RecoveryAuthority = Address(9);
            control.RecoveryTimelockMs = AccountControl.RecoveryTimelockMaxMs;
            var decoded = AccountControl.Decode(control.Serialize());
            Assert.AreEqual(Address(9), decoded.RecoveryAuthority);
            Assert.AreEqual(AccountControl.RecoveryTimelockMaxMs, decoded.RecoveryTimelockMs);
            Assert.AreSequenceEqual(control.Serialize(), decoded.Serialize());

            var aboveMax = Control().ToStackItem();
            aboveMax[9] = new Integer(new BigInteger(AccountControl.RecoveryTimelockMaxMs) + 1);
            Malformed(aboveMax, AccountControl.Decode);
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
        }
    }
}
