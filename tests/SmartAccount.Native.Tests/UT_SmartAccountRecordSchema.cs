// Copyright (C) 2015-2026 The Neo Project.
//
// UT_SmartAccountRecordSchema.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo.Extensions;
using Neo.Persistence;
using Neo.SmartContract;
using Neo.SmartContract.Native;
using Neo.VM;
using Neo.VM.Types;
using System;
using System.Linq;
using System.Numerics;
using Array = Neo.VM.Types.Array;

namespace Neo.UnitTests.SmartContract.Native
{
    /// <summary>
    /// The v4.1 record schema has exactly one shape: the tagged
    /// <c>[kind, version=1, 9|14 fields]</c> Array. SmartAccount was never
    /// activated on any network, so no earlier shape is a record the native core
    /// ever wrote: an untagged AccountControl[9], the historical 14-field
    /// AccountControl and the 12-field ModuleInstance are all rejected at decode
    /// time and there is no migration, upgrade-on-write or <c>MigrationRequired</c>
    /// state to reach.
    /// </summary>
    [TestClass]
    public class UT_SmartAccountRecordSchema
    {
        private static UInt160 Address(byte n) => new(Enumerable.Repeat(n, 20).ToArray());
        private static byte[] Bytes(byte n) => Enumerable.Repeat(n, 32).ToArray();
        private static byte[] Encode(Array record) => SmartAccountRecordCodec.Encode(record);

        private static byte[] Mutate(byte[] bytes, Action<Array> change)
        {
            Array record = SmartAccountRecordCodec.Decode(bytes);
            change(record);
            return Encode(record);
        }

        private static StorageKey ControlKey(UInt160 id) => NativeContract.SmartAccount.Key(SmartAccountModuleProtocol.PrefixAccountControl).Add(id);

        private static StorageKey ModuleKey(UInt160 id, BigInteger moduleId) => NativeContract.SmartAccount.Key(SmartAccountModuleProtocol.PrefixModuleInstance).Add(id).AddBigEndian(SmartAccountProtocol.UInt64(moduleId));

        private static byte[] Stored(DataCache snapshot, StorageKey key) => snapshot[key]!.Value.ToArray();

        private static AccountControl Control()
        {
            AccountControl control = AccountControl.Create(Address(1));
            control.RequiredValidatorId = 9;
            control.AdvanceAuthority();
            return control;
        }

        private static ModuleInstance Module() => new()
        {
            ModuleType = (byte)SmartAccountModuleProtocol.ModuleTypeCodeValidator,
            ContractHash = Address(3),
            ContractId = 7,
            UpdateCounter = 2,
            NefSha256 = Bytes(4),
            ProfileSha256 = Bytes(5),
            ModuleRevision = 1,
            CredentialGeneration = 1,
            MessageCapability = true,
            ThresholdMemberEligible = true,
            InstanceIsolation = true,
        };

        /// <summary>
        /// The historical AccountControl[14]:
        /// [status, custody, recoveryAuthority, authorityEpoch, configurationNonce,
        ///  nextModuleId, nextIntentId, defaultOperationAuthorization,
        ///  defaultMessageAuthorization, recoveryTimelockMs, hookOrderRevision,
        ///  defaultPolicyRevision, controlRevision, ownerOnlyRecovery].
        /// </summary>
        private static Array LegacyControl(byte status = 0, byte recovery = 0, UInt160 custody = null,
            ulong controlRevision = 5)
        {
            custody ??= Address(1);
            return new Array(
            [
                new Integer(status),
                new ByteString(custody.ToArray()),
                new ByteString(Address(recovery).ToArray()),
                new Integer(1),               // authorityEpoch
                new Integer(0),               // configurationNonce
                new Integer(1),               // nextModuleId
                new Integer(7),               // nextIntentId (sunk allocator)
                StackItem.True,               // defaultOperationAuthorization
                StackItem.True,               // defaultMessageAuthorization
                new Integer(3_600_000),       // recoveryTimelockMs (module policy)
                new Integer(2),               // hookOrderRevision (module policy)
                new Integer(4),               // defaultPolicyRevision (module policy)
                new Integer(controlRevision), // controlRevision
                StackItem.True,               // ownerOnlyRecovery (retired switch)
            ]);
        }

        /// <summary>
        /// The historical ModuleInstance[12]:
        /// [moduleType, contractHash, contractId, updateCounter, nefSha256,
        ///  profileSha256, moduleRevision, credentialGeneration, instanceIsolation,
        ///  messageCapability, thresholdMemberEligible, activePolicyId].
        /// </summary>
        private static Array LegacyModule(BigInteger activePolicyId = default) => new Array(
        [
            new Integer(SmartAccountModuleProtocol.ModuleTypeCodeValidator),
            new ByteString(Address(3).ToArray()),
            new Integer(7),                   // contractId
            new Integer(2),                   // updateCounter
            new ByteString(Bytes(4)),         // nefSha256
            new ByteString(Bytes(5)),         // profileSha256
            new Integer(1),                   // moduleRevision
            new Integer(1),                   // credentialGeneration
            StackItem.False,                  // instanceIsolation
            StackItem.True,                   // messageCapability
            StackItem.True,                   // thresholdMemberEligible
            new Integer(activePolicyId),      // activePolicyId (retired back-pointer)
        ]);

        // =====================================================================
        // The single canonical shape
        // =====================================================================

        [TestMethod]
        public void AccountControlShapeIsTaggedAndVersioned()
        {
            AccountControl control = Control();
            byte[] tagged = control.Serialize();
            Array record = SmartAccountRecordCodec.Decode(tagged);

            Assert.AreEqual(SmartAccountRecordSchema.AccountControlTaggedFields, record.Count);
            Assert.AreEqual(SmartAccountRecordSchema.AccountControlFields + 2, record.Count);
            Assert.IsTrue(SmartAccountRecordSchema.IsAccountControlTag(record[0]));
            Assert.IsFalse(SmartAccountRecordSchema.IsModuleInstanceTag(record[0]));
            Assert.AreEqual(new BigInteger(SmartAccountRecordSchema.Version), record[1].GetInteger());
            Assert.AreEqual((int)SmartAccountStatus.Active, record[2].GetInteger());

            AccountControl decoded = AccountControl.Decode(tagged);
            Assert.AreEqual(control.Status, decoded.Status);
            Assert.AreEqual(control.Custody, decoded.Custody);
            Assert.AreEqual(control.AuthorityEpoch, decoded.AuthorityEpoch);
            Assert.AreEqual(control.ConfigurationNonce, decoded.ConfigurationNonce);
            Assert.AreEqual(control.NextModuleId, decoded.NextModuleId);
            Assert.AreEqual(control.DefaultOperationAuthorization, decoded.DefaultOperationAuthorization);
            Assert.AreEqual(control.DefaultMessageAuthorization, decoded.DefaultMessageAuthorization);
            Assert.AreEqual(control.RequiredValidatorId, decoded.RequiredValidatorId);
            Assert.AreEqual(control.ControlRevision, decoded.ControlRevision);
            Assert.AreSequenceEqual(tagged, decoded.Serialize());
        }

        [TestMethod]
        public void ModuleInstanceShapeIsTaggedAndVersioned()
        {
            ModuleInstance module = Module();
            byte[] tagged = module.Serialize();
            Array record = SmartAccountRecordCodec.Decode(tagged);

            Assert.AreEqual(SmartAccountRecordSchema.ModuleInstanceTaggedFields, record.Count);
            Assert.AreEqual(SmartAccountRecordSchema.ModuleInstanceFields + 2, record.Count);
            Assert.IsTrue(SmartAccountRecordSchema.IsModuleInstanceTag(record[0]));
            Assert.IsFalse(SmartAccountRecordSchema.IsAccountControlTag(record[0]));
            Assert.AreEqual(new BigInteger(SmartAccountRecordSchema.Version), record[1].GetInteger());

            ModuleInstance decoded = ModuleInstance.Decode(tagged);
            Assert.AreEqual(module.ModuleType, decoded.ModuleType);
            Assert.AreEqual(module.ContractHash, decoded.ContractHash);
            Assert.AreEqual(module.ContractId, decoded.ContractId);
            Assert.AreEqual(module.UpdateCounter, decoded.UpdateCounter);
            Assert.AreSequenceEqual(module.NefSha256, decoded.NefSha256);
            Assert.AreSequenceEqual(module.ProfileSha256, decoded.ProfileSha256);
            Assert.AreEqual(module.ModuleRevision, decoded.ModuleRevision);
            Assert.AreEqual(module.CredentialGeneration, decoded.CredentialGeneration);
            Assert.AreEqual(module.InstanceIsolation, decoded.InstanceIsolation);
            Assert.AreEqual(module.MessageCapability, decoded.MessageCapability);
            Assert.AreEqual(module.ThresholdMemberEligible, decoded.ThresholdMemberEligible);
            Assert.AreEqual(module.CompositeLayer, decoded.CompositeLayer);
            Assert.AreEqual(module.Governance, decoded.Governance);
            Assert.AreEqual(module.HookPlanner, decoded.HookPlanner);
            Assert.AreSequenceEqual(tagged, decoded.Serialize());
        }

        // =====================================================================
        // Reachability proof: no earlier shape is part of the protocol
        // =====================================================================

        /// <summary>
        /// Every shape an unactivated earlier SmartAccount revision would have
        /// written is rejected: there is no second decoder, no byte-count
        /// heuristic and therefore no migration decision to make.
        /// </summary>
        [TestMethod]
        public void UntaggedAndHistoricalShapesAreRejected()
        {
            // The bare 9-field shape an earlier control used has no kind/version.
            Array untaggedControl = Control().ToStackItem();
            untaggedControl.RemoveAt(1);
            untaggedControl.RemoveAt(0);
            Assert.AreEqual(SmartAccountRecordSchema.AccountControlFields, untaggedControl.Count);
            Assert.ThrowsExactly<FormatException>(() =>
                AccountControl.Decode(Encode(untaggedControl)));

            // The historical 14-field control, including one with a live native
            // recovery authority and one with a retired status code.
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(Encode(LegacyControl())));
            Assert.ThrowsExactly<FormatException>(() =>
                AccountControl.Decode(Encode(LegacyControl(recovery: 7))));
            Assert.ThrowsExactly<FormatException>(() =>
                AccountControl.Decode(Encode(LegacyControl(status: 2))));

            // The bare 14-field shape an earlier module used has no kind/version.
            Array untaggedModule = Module().ToStackItem();
            untaggedModule.RemoveAt(1);
            untaggedModule.RemoveAt(0);
            Assert.AreEqual(SmartAccountRecordSchema.ModuleInstanceFields, untaggedModule.Count);
            Assert.ThrowsExactly<FormatException>(() => ModuleInstance.Decode(Encode(untaggedModule)));

            // The historical 12-field module, including one with a policy
            // back-pointer that the current core does not model.
            Assert.ThrowsExactly<FormatException>(() => ModuleInstance.Decode(Encode(LegacyModule())));
            Assert.ThrowsExactly<FormatException>(() =>
                ModuleInstance.Decode(Encode(LegacyModule(activePolicyId: 1))));
        }

        // =====================================================================
        // Fail-closed decoding
        // =====================================================================

        [TestMethod]
        public void UnknownSchemaVersionAndWrongKindFailClosed()
        {
            byte[] tagged = Control().Serialize();

            byte[] futureVersion = Mutate(tagged, record => record[1] = new Integer(2));
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(futureVersion));

            byte[] otherKind = Mutate(tagged, record =>
                record[0] = SmartAccountRecordSchema.ModuleInstanceTag);
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(otherKind));

            byte[] versionType = Mutate(tagged, record => record[1] = new ByteString(new byte[] { 1 }));
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(versionType));

            byte[] integerTag = Mutate(tagged, record => record[0] = new Integer(1));
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(integerTag));

            byte[] module = Module().Serialize();
            byte[] moduleFutureVersion = Mutate(module, record => record[1] = new Integer(2));
            Assert.ThrowsExactly<FormatException>(() => ModuleInstance.Decode(moduleFutureVersion));

            byte[] moduleOtherKind = Mutate(module, record =>
                record[0] = SmartAccountRecordSchema.AccountControlTag);
            Assert.ThrowsExactly<FormatException>(() => ModuleInstance.Decode(moduleOtherKind));
        }

        [TestMethod]
        public void UnknownAritiesAreNotGuessedIntoAVersion()
        {
            // 10 fields is neither tagged control[11] nor a historical shape.
            byte[] tenFields = Mutate(Control().Serialize(), record => record.RemoveAt(10));
            Assert.AreEqual(10, SmartAccountRecordCodec.Decode(tenFields).Count);
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(tenFields));

            // 12 fields is a module arity, not an account control one.
            byte[] twelveControl = Mutate(Control().Serialize(), record => record.Add(new Integer(0)));
            Assert.AreEqual(12, SmartAccountRecordCodec.Decode(twelveControl).Count);
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(twelveControl));

            // 13 fields is neither tagged module[16] nor a historical shape.
            byte[] thirteenModule = Mutate(Module().Serialize(),
                record => record.RemoveAt(record.Count - 1));
            Assert.AreEqual(15, SmartAccountRecordCodec.Decode(thirteenModule).Count);
            Assert.ThrowsExactly<FormatException>(() => ModuleInstance.Decode(thirteenModule));

            // Extra field after a canonical tagged record.
            byte[] taggedControl = Mutate(Control().Serialize(), record => record.Add(new Integer(0)));
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(taggedControl));

            byte[] taggedModule = Mutate(Module().Serialize(), record => record.Add(new Integer(0)));
            Assert.ThrowsExactly<FormatException>(() => ModuleInstance.Decode(taggedModule));
        }

        [TestMethod]
        public void TruncatedAndNonCanonicalRecordsFailClosed()
        {
            byte[] tagged = Control().Serialize();
            Assert.ThrowsExactly<FormatException>(() =>
                AccountControl.Decode(tagged.AsSpan(0, tagged.Length - 1).ToArray()));
            byte[] extended = [.. tagged, 0];
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(extended));
            Assert.ThrowsExactly<FormatException>(() =>
                AccountControl.Decode(System.Array.Empty<byte>()));

            byte[] legacy = Encode(LegacyControl());
            Assert.ThrowsExactly<FormatException>(() =>
                AccountControl.Decode(legacy.AsSpan(0, legacy.Length - 1).ToArray()));

            byte[] module = Module().Serialize();
            Assert.ThrowsExactly<FormatException>(() =>
                ModuleInstance.Decode(module.AsSpan(0, module.Length - 1).ToArray()));
        }

        [TestMethod]
        public void FieldTypeAndRangeViolationsFailClosed()
        {
            byte[] tagged = Control().Serialize();

            byte[] status = Mutate(tagged, record => record[2] = new Integer(3));
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(status));

            byte[] custody = Mutate(tagged, record => record[3] = new Integer(1));
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(custody));

            byte[] zeroCustody = Mutate(tagged, record =>
                record[3] = new ByteString(UInt160.Zero.ToArray()));
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(zeroCustody));

            byte[] epoch = Mutate(tagged, record => record[4] = new Integer(BigInteger.One << 64));
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(epoch));

            byte[] negative = Mutate(tagged, record => record[4] = new Integer(-1));
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(negative));

            byte[] authorization = Mutate(tagged, record => record[7] = new Integer(1));
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(authorization));

            byte[] revision = Mutate(tagged, record => record[10] = new Integer(0));
            Assert.ThrowsExactly<FormatException>(() => AccountControl.Decode(revision));

            byte[] module = Module().Serialize();
            byte[] moduleType = Mutate(module, record => record[2] = new Integer(99));
            Assert.ThrowsExactly<FormatException>(() => ModuleInstance.Decode(moduleType));

            byte[] generation = Mutate(module, record => record[9] = new Integer(0));
            Assert.ThrowsExactly<FormatException>(() => ModuleInstance.Decode(generation));

            byte[] nef = Mutate(module, record => record[6] = new ByteString(new byte[31]));
            Assert.ThrowsExactly<FormatException>(() => ModuleInstance.Decode(nef));
        }

        // =====================================================================
        // Storage behaviour through the native methods
        // =====================================================================

        [TestMethod]
        public void ReadsNeverRewriteAStoredRecord()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccount.Register(snapshot);
            StorageKey key = ControlKey(id);
            byte[] stored = Stored(snapshot, key);
            Assert.AreEqual(SmartAccountRecordSchema.AccountControlTaggedFields,
                SmartAccountRecordCodec.Decode(stored).Count);

            using (ApplicationEngine read = UT_SmartAccount.Invoke(snapshot, "getAccount", [id]))
            {
                Assert.AreEqual(VMState.HALT, read.State, read.FaultException?.ToString());
                Array descriptor = (Array)read.ResultStack.Pop();
                Assert.IsTrue(descriptor[0].GetBoolean());
                Assert.AreEqual((int)SmartAccountStatus.Active, descriptor[1].GetInteger());
                // Committing proves the engine cache holds no rewritten record.
                read.SnapshotCache.Commit();
            }

            Assert.AreSequenceEqual(stored, Stored(snapshot, key),
                "a read-only query must not rewrite the stored record");
        }

        [TestMethod]
        public void AuthorizedWriteKeepsTheSingleShape()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccount.Register(snapshot);
            StorageKey key = ControlKey(id);
            int before = SmartAccountRecordCodec.Decode(Stored(snapshot, key)).Count;

            using (ApplicationEngine freeze = UT_SmartAccount.Invoke(snapshot, "freezeAccount", [id]))
            {
                Assert.AreEqual(VMState.HALT, freeze.State, freeze.FaultException?.ToString());
                freeze.SnapshotCache.Commit();
            }

            byte[] written = Stored(snapshot, key);
            Array record = SmartAccountRecordCodec.Decode(written);
            Assert.AreEqual(before, record.Count);
            Assert.AreEqual(SmartAccountRecordSchema.AccountControlTaggedFields, record.Count);
            Assert.IsTrue(SmartAccountRecordSchema.IsAccountControlTag(record[0]));
            Assert.AreEqual(new BigInteger(SmartAccountRecordSchema.Version), record[1].GetInteger());

            AccountControl control = AccountControl.Decode(written);
            Assert.AreEqual(SmartAccountStatus.Frozen, control.Status);
            Assert.AreEqual(2UL, control.AuthorityEpoch);
            Assert.AreEqual(1UL, control.ConfigurationNonce);
            Assert.AreEqual(2UL, control.ControlRevision);
        }

        /// <summary>
        /// A stored historical record has no reader and no writer: the native
        /// method faults, the bytes stay untouched and no later authorized write
        /// can interpret them either. This is the reachability proof that the
        /// retired migration/<c>MigrationRequired</c> state has no producer.
        /// </summary>
        [TestMethod]
        public void StoredHistoricalRecordsHaveNoMigrationPath()
        {
            var snapshot = UT_SmartAccount.Snapshot();
            UInt160 id = UT_SmartAccount.Register(snapshot);

            StorageKey key = ControlKey(id);
            byte[] planted = Encode(LegacyControl(custody: UT_SmartAccount.Custody, recovery: 7));
            snapshot.GetAndChange(key)!.Value = planted;

            using (ApplicationEngine read = UT_SmartAccount.Invoke(snapshot, "getAccount", [id]))
            {
                Assert.AreEqual(VMState.FAULT, read.State);
                Assert.Contains("unknown field count", read.FaultException!.ToString());
            }

            using (ApplicationEngine freeze = UT_SmartAccount.Invoke(snapshot, "freezeAccount", [id]))
            {
                Assert.AreEqual(VMState.FAULT, freeze.State,
                    "an authorized write must not adopt a record the core never wrote");
                Assert.Contains("unknown field count", freeze.FaultException!.ToString());
            }

            Assert.AreSequenceEqual(planted, Stored(snapshot, key),
                "a rejected record must stay byte-identical");

            // The same holds for a module record.
            StorageKey moduleKey = ModuleKey(id, 1);
            byte[] plantedModule = Encode(LegacyModule());
            snapshot.Add(moduleKey, new StorageItem { Value = plantedModule });
            using (ApplicationEngine module = UT_SmartAccount.Invoke(snapshot, "getModule", [id, (BigInteger)1]))
            {
                Assert.AreEqual(VMState.FAULT, module.State);
                Assert.Contains("unknown field count", module.FaultException!.ToString());
            }
            Assert.AreSequenceEqual(plantedModule, Stored(snapshot, moduleKey),
                "a rejected module record must stay byte-identical");
        }

        // =====================================================================
        // Identity stability
        // =====================================================================

        [TestMethod]
        public void IdentityAddressAndHashAreSchemaIndependent()
        {
            var native = NativeContract.SmartAccount;
            Assert.AreEqual(UInt160.Parse("0x398dc3f0227d7efac5533ed5ce9937390c158084"), native.Hash);

            UInt160 id = SmartAccountProtocol.GetAccountId(UT_SmartAccount.Custody, UT_SmartAccount.Salt);
            Assert.AreEqual(id,
                SmartAccountProtocol.GetAccountId(UT_SmartAccount.Custody, UT_SmartAccount.Salt));
            byte[] script = SmartAccountProtocol.CreateVerificationScript(id);
            UInt160 address = SmartAccountProtocol.GetAccountAddress(id);
            Assert.AreEqual(address, script.ToScriptHash());

            using ApplicationEngine engine = UT_SmartAccount.Invoke(UT_SmartAccount.Snapshot(),
                "getAccountAddress", [id]);
            Assert.AreEqual(VMState.HALT, engine.State, engine.FaultException?.ToString());
            Assert.AreEqual(address, new UInt160(engine.ResultStack.Pop().GetSpan().ToArray()));
        }
    }
}
