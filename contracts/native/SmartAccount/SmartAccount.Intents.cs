// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccount.Intents.cs file belongs to the neo project and is free
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

#pragma warning disable IDE0051

using Neo.Extensions;
using Neo.Persistence;
using Neo.VM.Types;
using System;
using System.Collections.Generic;
using System.Numerics;
using System.Security.Cryptography;
using Array = Neo.VM.Types.Array;

namespace Neo.SmartContract.Native
{
    /// <summary>
    /// Configuration intents of the native kernel (spec §10): the 0x55 intent
    /// records and the bounded 0x5E unresolved-intent index. Every normal
    /// configuration change is one atomic, 24h-timelocked intent — there is no
    /// timelock bypass through batching. Registration, emergency freeze,
    /// callback-free credential revocation and callback-free recovery are the
    /// only immediate paths and never route through this file.
    /// </summary>
    public sealed partial class SmartAccount
    {
        // ========================================================================
        // 1. Intent records (0x55) and the bounded index (0x5E)
        // ========================================================================

        private ConfigurationIntentRecord? TryIntent(IReadOnlyStore snapshot, UInt160 accountId,
            BigInteger intentId)
        {
            if (intentId < 1 || intentId >> 64 != BigInteger.Zero) return null;
            return TryRead(snapshot, SmartAccountProtocol.GetConfigIntentKey(accountId, intentId), out var value)
                ? ConfigurationIntentRecord.Decode(value)
                : null;
        }

        private void SaveIntent(ApplicationEngine engine, UInt160 accountId, ConfigurationIntentRecord intent) =>
            Write(engine, SmartAccountProtocol.GetConfigIntentKey(accountId, intent.IntentId), intent.Serialize());

        private BigInteger[] GetIntentIndex(IReadOnlyStore snapshot, UInt160 accountId)
        {
            if (!TryRead(snapshot, SmartAccountProtocol.GetConfigIntentIndexKey(accountId), out var value))
                return [];
            Array record = SmartAccountRecordCodec.Decode(value);
            return SmartAccountRecordCodec.Integers(record,
                SmartAccountModuleProtocol.MaxActiveConfigurationIntents + 16);
        }

        private void SaveIntentIndex(ApplicationEngine engine, UInt160 accountId, BigInteger[] intentIds)
        {
            if (intentIds.Length == 0)
            {
                Delete(engine, SmartAccountProtocol.GetConfigIntentIndexKey(accountId));
                return;
            }
            Write(engine, SmartAccountProtocol.GetConfigIntentIndexKey(accountId),
                SmartAccountRecordCodec.Encode(SmartAccountRecordCodec.IntegerArray(intentIds)));
        }

        private void DropIntent(ApplicationEngine engine, UInt160 accountId, BigInteger intentId)
        {
            Delete(engine, SmartAccountProtocol.GetConfigIntentKey(accountId, intentId));
            BigInteger[] index = GetIntentIndex(engine.SnapshotCache, accountId);
            List<BigInteger> remaining = new(index.Length);
            foreach (BigInteger id in index)
                if (id != intentId) remaining.Add(id);
            if (remaining.Count != index.Length) SaveIntentIndex(engine, accountId, remaining.ToArray());
        }

        // ========================================================================
        // 2. Digest and resource helpers
        // ========================================================================

        /// <summary>
        /// The exact action digest an intent is bound to. Confirmation re-binds
        /// the submitted actions by recomputing this digest, so a matured intent
        /// can never be covertly replaced.
        /// </summary>
        private static byte[] ComputeActionsDigest(Array actions) =>
            SHA256.HashData(BinarySerializer.Serialize(actions,
                SmartAccountModuleProtocol.OperationEncodedSizeMax,
                SmartAccountModuleProtocol.OperationEncodedSizeMax));

        private static byte[][] CollectActionResources(Array actions, IReadOnlyList<byte[]> readSet)
        {
            List<byte[]> resources = new(readSet.Count + actions.Count);
            foreach (byte[] key in readSet)
            {
                Require(key.Length <= 64, SmartAccountModuleProtocol.ErrorOperationMalformed);
                resources.Add(key);
            }
            foreach (StackItem item in actions)
                resources.AddRange(ResourceKeysForAction(RequireActionArray(item)));
            return resources.ToArray();
        }

        private static bool ResourcesIntersect(byte[][] left, byte[][] right)
        {
            foreach (byte[] l in left)
                foreach (byte[] r in right)
                    if (l.AsSpan().SequenceEqual(r)) return true;
            return false;
        }

        /// <summary>Permissionless housekeeping: intents past expiry are cleaned (spec §10).</summary>
        private void PruneExpiredIntents(ApplicationEngine engine, UInt160 accountId, ulong now)
        {
            foreach (BigInteger intentId in GetIntentIndex(engine.SnapshotCache, accountId))
            {
                ConfigurationIntentRecord? intent = TryIntent(engine.SnapshotCache, accountId, intentId);
                if (intent is null) continue;
                if ((ulong)intent.ExpiresAt >= now) continue;
                DropIntent(engine, accountId, intentId);
                Notify(engine, SmartAccountModuleProtocol.EventNameConfigurationIntentExpired,
                    accountId.ToArray(), intentId);
            }
        }

        // ========================================================================
        // 3. Public lifecycle API (spec §3.3)
        // ========================================================================

        /// <summary>
        /// Proposes one atomic configuration intent: it matures after the
        /// uniform 24h module-change delay and expires 7 days after maturity.
        /// Same-resource conflicts with an unresolved intent are rejected up
        /// front, so conflicting proposals never run in parallel.
        /// </summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private BigInteger ProposeConfiguration(ApplicationEngine engine, UInt160 accountId, Array actions,
            Array readSet)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireConfigurationControl(engine.SnapshotCache, accountId, actions);
            RequireCustody(engine, control);

            Require(actions is not null && actions.Count > 0
                && actions.Count <= SmartAccountModuleProtocol.MaxActionsPerConfigurationIntent,
                SmartAccountModuleProtocol.ErrorModuleLimitActions);
            readSet ??= new Array();
            Require(readSet.Type == StackItemType.Array
                && readSet.Count <= SmartAccountModuleProtocol.MaxActionsPerConfigurationIntent,
                SmartAccountModuleProtocol.ErrorModuleLimitActions);
            List<byte[]> declared = new(readSet.Count);
            foreach (StackItem item in readSet)
            {
                if (item is not ByteString key || key.Size > 64)
                    throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorOperationMalformed);
                declared.Add(key.GetSpan().ToArray());
            }
            // An owner-only account rejects module-model proposals up front so
            // its owner never waits 24h for an intent that cannot confirm.
            foreach (StackItem item in actions!)
            {
                RequireActionArray(item);
                if (control.OwnerOnlyRecovery)
                    Require(!ActionTouchesModuleModel(RequireActionArray(item)), "Owner-only recovery is permanent");
                ValidateActionShape(item);
            }

            byte[][] resources = CollectActionResources(actions, declared);
            ulong now = Now(engine);
            PruneExpiredIntents(engine, accountId, now);
            BigInteger[] pending = GetIntentIndex(engine.SnapshotCache, accountId);
            Require(pending.Length < SmartAccountModuleProtocol.MaxActiveConfigurationIntents,
                SmartAccountModuleProtocol.ErrorIntentLimit);
            foreach (BigInteger otherId in pending)
            {
                ConfigurationIntentRecord? other = TryIntent(engine.SnapshotCache, accountId, otherId);
                if (other is not null && ResourcesIntersect(other.Resources, resources))
                    throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorIntentConflict);
            }

            BigInteger intentId = new(control.NextIntentId);
            Require(intentId >> 64 == BigInteger.Zero, SmartAccountModuleProtocol.ErrorModuleIdInvalid);
            control.NextIntentId += 1;
            SaveControl(engine, accountId, control);

            ConfigurationIntentRecord intent = new()
            {
                IntentId = intentId,
                ProposedAt = new BigInteger(now),
                MatureAt = new BigInteger(checked(now + SmartAccountModuleProtocol.ModuleChangeDelayMs)),
                AuthorityEpoch = new BigInteger(control.AuthorityEpoch),
                ActionDigest = ComputeActionsDigest(actions),
                Actions = (Array)CloneValue(engine, actions),
                Resources = resources,
            };
            intent.ExpiresAt = intent.MatureAt + SmartAccountModuleProtocol.ConfigurationIntentExpiryMs;
            SaveIntent(engine, accountId, intent);

            BigInteger[] updated = new BigInteger[pending.Length + 1];
            System.Array.Copy(pending, updated, pending.Length);
            updated[pending.Length] = intentId;
            SaveIntentIndex(engine, accountId, updated);

            Notify(engine, SmartAccountModuleProtocol.EventNameConfigurationIntentProposed, accountId.ToArray(),
                intentId, new BigInteger(actions.Count), intent.ActionDigest);
            EmitModuleUpdateMirror(engine, accountId, actions, true);
            return intentId;
        }

        /// <summary>
        /// Confirms a matured intent: re-requires the custody witness, the
        /// recorded authorityEpoch and an exact action-digest match, executes
        /// the actions atomically, advances configurationNonce once, then
        /// invalidates only the stale/conflicting remaining intents.
        /// </summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask ConfirmConfiguration(ApplicationEngine engine, UInt160 accountId,
            BigInteger intentId, Array actions)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireConfigurationControl(engine.SnapshotCache, accountId, actions);
            RequireCustody(engine, control);
            AssertAccountIdle(engine, accountId);

            ConfigurationIntentRecord record = TryIntent(engine.SnapshotCache, accountId, intentId)
                ?? throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorIntentNotFound);
            ulong now = Now(engine);
            Require(now >= (ulong)record.MatureAt, SmartAccountModuleProtocol.ErrorIntentImmature);
            Require(now <= (ulong)record.ExpiresAt, SmartAccountModuleProtocol.ErrorIntentExpired);
            Require(record.AuthorityEpoch == control.AuthorityEpoch,
                SmartAccountModuleProtocol.ErrorEpochStale);
            Require(actions is not null, SmartAccountModuleProtocol.ErrorOperationMalformed);
            Require(ComputeActionsDigest(actions!).AsSpan().SequenceEqual(record.ActionDigest),
                SmartAccountModuleProtocol.ErrorOperationMalformed);

            await ExecuteConfigurationActionsAsync(engine, accountId, control, actions!);
            // Last-validator rule (spec §10): with no validator installed the
            // built-in route must be enabled within the same intent.
            if (CountModulesOfType(engine.SnapshotCache, accountId,
                    SmartAccountModuleProtocol.ModuleTypeCodeValidator) == 0)
                Require(control.DefaultOperationAuthorization, SmartAccountModuleProtocol.ErrorOperationMalformed);

            control.ConfigurationNonce += 1;
            SaveControl(engine, accountId, control);

            byte[][] committed = record.Resources;
            DropIntent(engine, accountId, intentId);
            foreach (BigInteger otherId in GetIntentIndex(engine.SnapshotCache, accountId))
            {
                ConfigurationIntentRecord? other = TryIntent(engine.SnapshotCache, accountId, otherId);
                if (other is null) continue;
                bool stale = other.AuthorityEpoch != control.AuthorityEpoch;
                if (!stale && !ResourcesIntersect(other.Resources, committed)) continue;
                DropIntent(engine, accountId, otherId);
                Notify(engine, SmartAccountModuleProtocol.EventNameConfigurationIntentCancelled,
                    accountId.ToArray(), otherId);
            }

            Notify(engine, SmartAccountModuleProtocol.EventNameConfigurationIntentConfirmed, accountId.ToArray(),
                intentId, new BigInteger(control.ConfigurationNonce));
        }

        /// <summary>
        /// Status gate shared by propose and confirm (spec §14): the migration
        /// import action is the ONLY way out of MigrationRequired, so an intent
        /// carrying it may be proposed and confirmed in that status; everything
        /// else stays Active-only.
        /// </summary>
        private AccountControl RequireConfigurationControl(IReadOnlyStore snapshot, UInt160 accountId,
            Array actions)
        {
            AccountControl control = RequireControl(snapshot, accountId);
            if (control.Status == SmartAccountStatus.Active) return control;
            Require(control.Status == SmartAccountStatus.MigrationRequired && ContainsMigrateAction(actions),
                SmartAccountModuleProtocol.ErrorAccountStatus);
            return control;
        }

        private static bool ContainsMigrateAction(Array actions)
        {
            if (actions is null) return false;
            foreach (StackItem item in actions)
            {
                if (item.Type != StackItemType.Array || item is not Array action || action.Count < 1) continue;
                if (action[0] is Integer code
                    && code.GetInteger() == SmartAccountModuleProtocol.ActionMigrateAccount)
                    return true;
            }
            return false;
        }

        /// <summary>
        /// Cancels an unresolved intent. A live intent requires the custody
        /// witness on an active account; an expired intent may be cleaned by
        /// anyone (explicit expiry cleanup).
        /// </summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void CancelConfiguration(ApplicationEngine engine, UInt160 accountId, BigInteger intentId)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            ConfigurationIntentRecord record = TryIntent(engine.SnapshotCache, accountId, intentId)
                ?? throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorIntentNotFound);
            if (Now(engine) > (ulong)record.ExpiresAt)
            {
                DropIntent(engine, accountId, intentId);
                Notify(engine, SmartAccountModuleProtocol.EventNameConfigurationIntentExpired,
                    accountId.ToArray(), intentId);
                return;
            }

            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            _ = RequireActive(control);
            RequireCustody(engine, control);
            DropIntent(engine, accountId, intentId);
            Notify(engine, SmartAccountModuleProtocol.EventNameConfigurationIntentCancelled,
                accountId.ToArray(), intentId);
            EmitModuleUpdateMirror(engine, accountId, record.Actions, false);
        }

        /// <summary>
        /// §18 reused-event mirror for a module-affecting intent: the first
        /// module action names its type and contract hash directly (install) or
        /// resolves them from the recorded instance (uninstall/configure/
        /// rebind). Non-module intents emit no legacy mirror.
        /// </summary>
        private void EmitModuleUpdateMirror(ApplicationEngine engine, UInt160 accountId, Array actions,
            bool initiated)
        {
            foreach (StackItem item in actions)
            {
                if (item.Type != StackItemType.Array || item is not Array action || action.Count < 1) continue;
                if (action[0] is not Integer codeItem) continue;
                int code = (int)codeItem.GetInteger();
                int typeCode;
                UInt160 contractHash;
                if (code == SmartAccountModuleProtocol.ActionInstallModule)
                {
                    if (action.Count != 5 || action[1] is not Integer typeItem) continue;
                    typeCode = (int)typeItem.GetInteger();
                    contractHash = SmartAccountRecordCodec.Address(action[2]);
                }
                else if (code is SmartAccountModuleProtocol.ActionUninstallModule
                    or SmartAccountModuleProtocol.ActionConfigureModule
                    or SmartAccountModuleProtocol.ActionRebindModuleCode)
                {
                    ModuleInstance? module = TryModuleInstance(engine.SnapshotCache, accountId,
                        SmartAccountRecordCodec.Unsigned(action[1]));
                    if (module is null) continue;
                    typeCode = module.ModuleType;
                    contractHash = module.ContractHash;
                }
                else continue;
                Notify(engine, initiated ? "ModuleUpdateInitiated" : "ModuleUpdateCancelled",
                    accountId.ToArray(), SmartAccountModulePolicy.SmartAccountModuleTypeName((byte)typeCode),
                    contractHash.ToArray());
                return;
            }
        }

        // ========================================================================
        // 4. Intent queries (spec §3.3)
        // ========================================================================

        /// <summary>
        /// [exists, intentId, proposedAt, matureAt, expiresAt, authorityEpoch,
        /// actionDigest, actions[]], or an empty Array when the intent does not
        /// exist.
        /// </summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private Array GetPendingConfiguration(IReadOnlyStore snapshot, UInt160 accountId, BigInteger intentId)
        {
            RequireAccountId(accountId);
            ConfigurationIntentRecord? record = TryIntent(snapshot, accountId, intentId);
            if (record is null) return new Array();
            return new Array(new StackItem[]
            {
                true, record.IntentId, record.ProposedAt, record.MatureAt, record.ExpiresAt,
                record.AuthorityEpoch, record.ActionDigest, record.Actions,
            });
        }

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private Array GetPendingConfigurationIntentIds(IReadOnlyStore snapshot, UInt160 accountId)
        {
            RequireAccountId(accountId);
            return SmartAccountRecordCodec.IntegerArray(GetIntentIndex(snapshot, accountId));
        }
    }
}
