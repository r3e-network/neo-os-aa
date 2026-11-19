// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccount.Modules.cs file belongs to the neo project and is free
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
using Neo.IO;
using Neo.Persistence;
using Neo.VM;
using Neo.VM.Types;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using Array = Neo.VM.Types.Array;
using Boolean = Neo.VM.Types.Boolean;

namespace Neo.SmartContract.Native
{
    /// <summary>
    /// v4 module registry of the native kernel (spec §3/§5/§7.2/§9/§12): the
    /// 0x52 instance records, the 0x53 enumeration index, the core-owned 0x54
    /// hook order and 0x5B threshold policies, the configuration action
    /// executors, the resource keys intents conflict on, and every budgeted
    /// module callback. Semantics mirror the custom kernel exactly; only the
    /// execution substrate differs (engine-local phases and hard gas budgets).
    /// </summary>
    public sealed partial class SmartAccount
    {
        // ========================================================================
        // 1. Module instance records (0x52) and the 0x53 enumeration index
        // ========================================================================

        private ModuleInstance? TryModuleInstance(IReadOnlyStore snapshot, UInt160 accountId, BigInteger moduleId)
        {
            if (moduleId < 1 || moduleId >> 64 != BigInteger.Zero) return null;
            return TryRead(snapshot, SmartAccountProtocol.GetModuleInstanceKey(accountId, moduleId), out var value)
                ? ModuleInstance.Decode(value)
                : null;
        }

        private ModuleInstance RequireModuleInstance(IReadOnlyStore snapshot, UInt160 accountId, BigInteger moduleId) =>
            TryModuleInstance(snapshot, accountId, moduleId)
                ?? throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorModuleNotInstalled);

        private void SaveModuleInstance(ApplicationEngine engine, UInt160 accountId, BigInteger moduleId,
            ModuleInstance module)
        {
            Write(engine, SmartAccountProtocol.GetModuleInstanceKey(accountId, moduleId), module.Serialize());
            Write(engine, SmartAccountProtocol.GetModuleIndexKey(accountId, module.ModuleType, moduleId), [1]);
        }

        private void DeleteModuleInstance(ApplicationEngine engine, UInt160 accountId, BigInteger moduleId,
            ModuleInstance module)
        {
            Delete(engine, SmartAccountProtocol.GetModuleInstanceKey(accountId, moduleId));
            Delete(engine, SmartAccountProtocol.GetModuleIndexKey(accountId, module.ModuleType, moduleId));
        }

        private byte[] ModuleTypePrefix(UInt160 accountId, int moduleType) =>
            SmartAccountProtocol.Concat(
                new[] { SmartAccountModuleProtocol.PrefixModuleIndex },
                accountId.ToArray(),
                new[] { (byte)moduleType });

        private int CountModulesOfType(IReadOnlyStore snapshot, UInt160 accountId, int moduleType)
        {
            int count = 0;
            byte[] prefix = ModuleTypePrefix(accountId, moduleType);
            foreach (var _ in snapshot.Find(new StorageKey { Id = Id, Key = prefix })) count++;
            return count;
        }

        /// <summary>First installed moduleId of the given type bound to a contract hash, or 0.</summary>
        private BigInteger FindModuleIdByContract(IReadOnlyStore snapshot, UInt160 accountId, int moduleType,
            UInt160 contractHash)
        {
            foreach (BigInteger moduleId in EnumerateModuleIds(snapshot, accountId, moduleType, BigInteger.Zero,
                         int.MaxValue))
            {
                ModuleInstance? module = TryModuleInstance(snapshot, accountId, moduleId);
                if (module is not null && module.ContractHash == contractHash) return moduleId;
            }
            return BigInteger.Zero;
        }

        private int CountModuleInstancesOfContract(IReadOnlyStore snapshot, UInt160 accountId, int moduleType,
            UInt160 contractHash)
        {
            int count = 0;
            foreach (BigInteger moduleId in EnumerateModuleIds(snapshot, accountId, moduleType, BigInteger.Zero,
                         int.MaxValue))
            {
                ModuleInstance? module = TryModuleInstance(snapshot, accountId, moduleId);
                if (module is not null && module.ContractHash == contractHash) count++;
            }
            return count;
        }

        /// <summary>
        /// Ascending installed module ids of one type strictly greater than
        /// <paramref name="cursor"/> (spec §3.3: the cursor is a moduleId, never
        /// an array index), up to <paramref name="limit"/> entries. The 0x53
        /// index carries fixed-width big-endian ids, so key order IS numeric
        /// order and a page never needs to sort or scan twice.
        /// </summary>
        private IEnumerable<BigInteger> EnumerateModuleIds(IReadOnlyStore snapshot, UInt160 accountId,
            int moduleType, BigInteger cursor, int limit)
        {
            if (cursor < 0 || cursor >> 64 != BigInteger.Zero)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorModuleIdInvalid);
            if (limit < 1)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            byte[] prefix = ModuleTypePrefix(accountId, moduleType);
            int emitted = 0;
            foreach (var (key, _) in snapshot.Find(new StorageKey { Id = Id, Key = prefix }))
            {
                ReadOnlyMemory<byte> content = key.Key;
                if (!content.Span.StartsWith(prefix)) break;
                if (content.Length != prefix.Length + sizeof(ulong)) continue;
                BigInteger moduleId = new(content.Span.Slice(prefix.Length).ToArray(), isUnsigned: true,
                    isBigEndian: true);
                if (moduleId <= cursor) continue;
                yield return moduleId;
                if (++emitted == limit) yield break;
            }
        }

        /// <summary>[ids[], nextCursor]; nextCursor is 0 when the page is the last one.</summary>
        private Array EnumerateModulePage(IReadOnlyStore snapshot, UInt160 accountId, int moduleType,
            BigInteger cursor, BigInteger limit)
        {
            if (limit < SmartAccountModuleProtocol.MinEnumerationLimit
                || limit > SmartAccountModuleProtocol.MaxEnumerationLimit)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            int maximum = (int)limit;
            List<BigInteger> page = new(maximum);
            foreach (BigInteger moduleId in EnumerateModuleIds(snapshot, accountId, moduleType, cursor, maximum))
                page.Add(moduleId);
            Array ids = new();
            foreach (BigInteger moduleId in page) ids.Add(moduleId);
            BigInteger nextCursor = page.Count == maximum ? page[page.Count - 1] : BigInteger.Zero;
            return new Array(new StackItem[] { ids, nextCursor });
        }

        // ========================================================================
        // 2. Core-owned hook order (0x54)
        // ========================================================================

        private HookOrderRecord ReadHookOrder(IReadOnlyStore snapshot, UInt160 accountId) =>
            TryRead(snapshot, SmartAccountProtocol.GetHookOrderKey(accountId), out var value)
                ? HookOrderRecord.Decode(value)
                : new HookOrderRecord();

        /// <summary>
        /// The hook order must be exactly the installed hook set (spec §3.6):
        /// every installed hook runs, so a signature scheme cannot bypass
        /// account policy by omitting one from the order.
        /// </summary>
        private void ValidateHookOrder(IReadOnlyStore snapshot, UInt160 accountId, BigInteger[] hookIds)
        {
            Require(hookIds is not null && hookIds.Length <= SmartAccountModuleProtocol.MaxHookModuleInstances,
                SmartAccountModuleProtocol.ErrorModuleLimitHook);
            for (int i = 0; i < hookIds!.Length; i++)
            {
                ModuleInstance module = RequireModuleInstance(snapshot, accountId, hookIds[i]);
                Require(module.IsHook, SmartAccountModuleProtocol.ErrorOperationMalformed);
                for (int j = 0; j < i; j++)
                    Require(hookIds[j] != hookIds[i], SmartAccountModuleProtocol.ErrorOperationMalformed);
            }
            Require(hookIds.Length == CountModulesOfType(snapshot, accountId,
                    SmartAccountModuleProtocol.ModuleTypeCodeHook),
                SmartAccountModuleProtocol.ErrorModuleLimitHook);
        }

        private void SaveHookOrder(ApplicationEngine engine, UInt160 accountId, HookOrderRecord order)
        {
            ValidateHookOrder(engine.SnapshotCache, accountId, order.HookIds);
            Write(engine, SmartAccountProtocol.GetHookOrderKey(accountId), order.Serialize());
            Notify(engine, SmartAccountModuleProtocol.EventNameHookOrderSet, accountId.ToArray(),
                new BigInteger(order.Revision),
                new Array(order.HookIds.Select(id => (StackItem)id).ToArray()));
        }

        private HookOrderRecord AppendHook(ApplicationEngine engine, UInt160 accountId, BigInteger hookId)
        {
            HookOrderRecord order = ReadHookOrder(engine.SnapshotCache, accountId);
            BigInteger[] updated = new BigInteger[order.HookIds.Length + 1];
            System.Array.Copy(order.HookIds, updated, order.HookIds.Length);
            updated[order.HookIds.Length] = hookId;
            order.HookIds = updated;
            order.Revision += 1;
            SaveHookOrder(engine, accountId, order);
            return order;
        }

        private HookOrderRecord RemoveHook(ApplicationEngine engine, UInt160 accountId, BigInteger hookId)
        {
            HookOrderRecord order = ReadHookOrder(engine.SnapshotCache, accountId);
            List<BigInteger> updated = new(order.HookIds.Length);
            bool removed = false;
            foreach (BigInteger id in order.HookIds)
            {
                if (!removed && id == hookId)
                {
                    removed = true;
                    continue;
                }
                updated.Add(id);
            }
            Require(removed, SmartAccountModuleProtocol.ErrorModuleNotInstalled);
            order.HookIds = updated.ToArray();
            order.Revision += 1;
            SaveHookOrder(engine, accountId, order);
            return order;
        }

        // ========================================================================
        // 3. Core-owned threshold policies (0x5B)
        // ========================================================================

        private ThresholdPolicyRecord? TryThresholdPolicy(IReadOnlyStore snapshot, UInt160 accountId,
            BigInteger policyId)
        {
            if (policyId < 1 || policyId >> 64 != BigInteger.Zero) return null;
            return TryRead(snapshot, SmartAccountProtocol.GetThresholdPolicyKey(accountId, policyId), out var value)
                ? ThresholdPolicyRecord.Decode(value)
                : null;
        }

        private void SaveThresholdPolicy(ApplicationEngine engine, UInt160 accountId, BigInteger policyId,
            ThresholdPolicyRecord policy)
        {
            // Every rewrite bumps the policy generation: a member reshape kills
            // the policy's old nonce channels and signature bindings.
            policy.CredentialGeneration += 1;
            Write(engine, SmartAccountProtocol.GetThresholdPolicyKey(accountId, policyId), policy.Serialize());
        }

        /// <summary>
        /// True while the instance is a member of an ACTIVE threshold policy.
        /// Active-policy members are never independently routable (spec §5) and
        /// cannot be uninstalled while referenced. The member record carries the
        /// back-pointer, so routing and uninstall checks are one read.
        /// </summary>
        private static bool IsMemberOfActivePolicy(ModuleInstance module) =>
            module.ActivePolicyId != BigInteger.Zero;

        private static void AssertNotMemberOfOtherActivePolicy(ModuleInstance member, BigInteger policyId)
        {
            Require(member.ActivePolicyId == BigInteger.Zero || member.ActivePolicyId == policyId,
                SmartAccountModuleProtocol.ErrorIntentConflict);
        }

        /// <summary>
        /// Routing eligibility (spec §5): the selected validator must be an
        /// installed validator instance that is not a member of an active
        /// threshold policy — a single-member entry must never bypass the
        /// threshold.
        /// </summary>
        private ModuleInstance RequireRoutableValidator(IReadOnlyStore snapshot, UInt160 accountId,
            BigInteger validatorId)
        {
            ModuleInstance module = RequireModuleInstance(snapshot, accountId, validatorId);
            Require(module.IsValidator, SmartAccountModuleProtocol.ErrorModuleNotRoutable);
            Require(!IsMemberOfActivePolicy(module), SmartAccountModuleProtocol.ErrorModuleNotRoutable);
            return module;
        }

        private ModuleInstance RequireActiveValidator(IReadOnlyStore snapshot, UInt160 accountId,
            BigInteger validatorId)
        {
            ModuleInstance module = RequireModuleInstance(snapshot, accountId, validatorId);
            Require(module.IsValidator, SmartAccountModuleProtocol.ErrorValidatorNotFound);
            return module;
        }

        /// <summary>
        /// Resolves the credential generation bound to a routing subject:
        /// built-in → 1, validator instance → its generation, active threshold
        /// policy → the policy generation.
        /// </summary>
        private BigInteger ResolveCredentialGeneration(IReadOnlyStore snapshot, UInt160 accountId,
            BigInteger validatorId)
        {
            if (validatorId == BigInteger.Zero) return BigInteger.One;
            ModuleInstance? module = TryModuleInstance(snapshot, accountId, validatorId);
            if (module is not null)
            {
                Require(module.IsValidator, SmartAccountModuleProtocol.ErrorValidatorNotFound);
                return module.CredentialGeneration;
            }
            ThresholdPolicyRecord? policy = TryThresholdPolicy(snapshot, accountId, validatorId);
            if (policy is not null && policy.Active) return policy.CredentialGeneration;
            throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorValidatorNotFound);
        }

        // ========================================================================
        // 4. Configuration action executors (spec §9)
        //    Positional action Arrays; element 0 is the code. They run at intent
        //    confirmation (24h served) and at atomic v4 registration (fresh
        //    account, no timelock). The passed AccountControl is persisted once
        //    by the caller after the whole action set executed.
        // ========================================================================

        private async ContractTask ExecuteConfigurationActionsAsync(ApplicationEngine engine, UInt160 accountId,
            AccountControl control, Array actions)
        {
            foreach (StackItem item in actions)
            {
                Array action = RequireActionArray(item);
                if (control.OwnerOnlyRecovery)
                    Require(!ActionTouchesModuleModel(action), "Owner-only recovery is permanent");
                int code = ActionCode(action);
                switch (code)
                {
                    case SmartAccountModuleProtocol.ActionInstallModule:
                        await ExecuteInstallModuleActionAsync(engine, accountId, control, action);
                        break;
                    case SmartAccountModuleProtocol.ActionUninstallModule:
                        await ExecuteUninstallModuleActionAsync(engine, accountId, action);
                        break;
                    case SmartAccountModuleProtocol.ActionConfigureModule:
                        await ExecuteConfigureModuleActionAsync(engine, accountId, action);
                        break;
                    case SmartAccountModuleProtocol.ActionSetHookOrder:
                        ExecuteSetHookOrderAction(engine, accountId, action);
                        break;
                    case SmartAccountModuleProtocol.ActionRebindModuleCode:
                        await ExecuteRebindModuleCodeActionAsync(engine, accountId, action);
                        break;
                    case SmartAccountModuleProtocol.ActionSetThresholdPolicy:
                        ExecuteSetThresholdPolicyAction(engine, accountId, control, action);
                        break;
                    case SmartAccountModuleProtocol.ActionSetDefaultPolicy:
                        ExecuteSetDefaultPolicyAction(control, action);
                        break;
                    case SmartAccountModuleProtocol.ActionSetRecoveryPolicy:
                        ExecuteSetRecoveryPolicyAction(engine, control, action);
                        break;
                    case SmartAccountModuleProtocol.ActionSetMessageSubjects:
                        ExecuteSetMessageSubjectsAction(engine, accountId, action);
                        break;
                    case SmartAccountModuleProtocol.ActionMigrateAccount:
                        ExecuteMigrateAccountAction(engine, accountId, control, action);
                        break;
                    default:
                        throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorOperationMalformed);
                }
            }
        }

        /// <summary>Every action is a strict Array of positional fields (never a Struct).</summary>
        private static Array RequireActionArray(StackItem item)
        {
            if (item.Type != StackItemType.Array || item is not Array action)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            return action;
        }

        private static int ActionCode(Array action)
        {
            if (action.Count < 1 || action[0] is not Integer code || code.GetInteger() < int.MinValue
                || code.GetInteger() > int.MaxValue)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            return (int)code.GetInteger();
        }

        private async ContractTask ExecuteInstallModuleActionAsync(ApplicationEngine engine, UInt160 accountId,
            AccountControl control, Array action)
        {
            // [ActionInstallModule, type, contractHash, profileDigest32, initData[]]
            Require(action.Count == 5, SmartAccountModuleProtocol.ErrorOperationMalformed);
            int moduleType = (int)SmartAccountRecordCodec.Unsigned(action[1]);
            Require(moduleType is SmartAccountModuleProtocol.ModuleTypeCodeValidator
                or SmartAccountModuleProtocol.ModuleTypeCodeHook, SmartAccountModuleProtocol.ErrorModuleTypeUnsupported);
            UInt160 contractHash = SmartAccountRecordCodec.Address(action[2]);
            byte[] profileDigest = SmartAccountRecordCodec.Fixed(action[3], 32);
            Array initData = RequireActionArray(action[4]);
            Require(initData.Count <= SmartAccountModuleProtocol.ArgsCountMax,
                SmartAccountModuleProtocol.ErrorOperationMalformed);

            int existingCount = CountModulesOfType(engine.SnapshotCache, accountId, moduleType);
            Require(existingCount < (moduleType == SmartAccountModuleProtocol.ModuleTypeCodeValidator
                    ? SmartAccountModuleProtocol.MaxValidatorModuleInstances
                    : SmartAccountModuleProtocol.MaxHookModuleInstances),
                moduleType == SmartAccountModuleProtocol.ModuleTypeCodeValidator
                    ? SmartAccountModuleProtocol.ErrorModuleLimitValidator
                    : SmartAccountModuleProtocol.ErrorModuleLimitHook);

            SmartAccountModulePolicy.RequireModuleContractAddress(engine.SnapshotCache, contractHash);
            ContractState contract = SmartAccountModulePolicy.RequireDeployed(engine.SnapshotCache, contractHash);
            Require(contract.Nef is not null && contract.Nef.Script.Length > 0
                && !string.IsNullOrEmpty(contract.Manifest.Name),
                SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch);

            bool firstValidator = moduleType == SmartAccountModuleProtocol.ModuleTypeCodeValidator
                && existingCount == 0;

            ModuleInstance module = new() { ModuleType = (byte)moduleType };
            SmartAccountModulePolicy.CaptureCodeBinding(module, contract);
            module.ProfileSha256 = profileDigest;
            await SmartAccountModulePolicy.BindProfileAsync(engine, module, contract, profileDigest);
            module.ModuleRevision = 1;
            module.CredentialGeneration = 1;
            if (!module.InstanceIsolation)
                Require(FindModuleIdByContract(engine.SnapshotCache, accountId, moduleType, contractHash)
                    == BigInteger.Zero, SmartAccountModuleProtocol.ErrorModuleInstanceIsolationRequired);

            BigInteger moduleId = control.AllocateModuleId();
            SaveModuleInstance(engine, accountId, moduleId, module);
            if (module.IsHook) AppendHook(engine, accountId, moduleId);
            if (firstValidator)
            {
                // Spec §8/§15: the first validator disables the built-in
                // operation route. There is no automatic custody fallback.
                control.DefaultOperationAuthorization = false;
            }

            await CallModuleLifecycleAsync(engine, accountId, moduleId, module, "onInstall", initData);
            Notify(engine, SmartAccountModuleProtocol.EventNameModuleInstanceInstalled, accountId.ToArray(),
                moduleId, new BigInteger(module.ModuleType), contractHash.ToArray(),
                new BigInteger(module.CredentialGeneration));
            Notify(engine, "ModuleInstalled", accountId.ToArray(),
                SmartAccountModulePolicy.SmartAccountModuleTypeName(module.ModuleType), contractHash.ToArray());
        }

        private async ContractTask ExecuteUninstallModuleActionAsync(ApplicationEngine engine, UInt160 accountId,
            Array action)
        {
            // [ActionUninstallModule, moduleId, deInitData[]]
            Require(action.Count == 3, SmartAccountModuleProtocol.ErrorOperationMalformed);
            BigInteger moduleId = SmartAccountRecordCodec.Unsigned(action[1]);
            Array deInitData = RequireActionArray(action[2]);
            Require(deInitData.Count <= SmartAccountModuleProtocol.ArgsCountMax,
                SmartAccountModuleProtocol.ErrorOperationMalformed);
            ModuleInstance module = RequireModuleInstance(engine.SnapshotCache, accountId, moduleId);

            if (module.IsValidator)
                Require(!IsMemberOfActivePolicy(module), SmartAccountModuleProtocol.ErrorIntentConflict);
            // Callback first, while the instance is still installed and its
            // phase authorization is meaningful; a fault reverts the action.
            await CallModuleLifecycleAsync(engine, accountId, moduleId, module, "onUninstall", deInitData);
            DeleteModuleInstance(engine, accountId, moduleId, module);
            if (module.IsHook) RemoveHook(engine, accountId, moduleId);

            Notify(engine, SmartAccountModuleProtocol.EventNameModuleInstanceRemoved, accountId.ToArray(),
                moduleId);
            Notify(engine, "ModuleRemoved", accountId.ToArray(),
                SmartAccountModulePolicy.SmartAccountModuleTypeName(module.ModuleType),
                module.ContractHash.ToArray());
        }

        private async ContractTask ExecuteConfigureModuleActionAsync(ApplicationEngine engine, UInt160 accountId,
            Array action)
        {
            // [ActionConfigureModule, moduleId, configData[]]
            Require(action.Count == 3, SmartAccountModuleProtocol.ErrorOperationMalformed);
            BigInteger moduleId = SmartAccountRecordCodec.Unsigned(action[1]);
            Array configData = RequireActionArray(action[2]);
            Require(configData.Count <= SmartAccountModuleProtocol.ArgsCountMax,
                SmartAccountModuleProtocol.ErrorOperationMalformed);

            ModuleInstance module = RequireModuleInstance(engine.SnapshotCache, accountId, moduleId);
            await CallModuleLifecycleAsync(engine, accountId, moduleId, module, "configure", configData);
            module.ModuleRevision += 1;
            SaveModuleInstance(engine, accountId, moduleId, module);
            Notify(engine, SmartAccountModuleProtocol.EventNameModuleInstanceConfigured, accountId.ToArray(),
                moduleId, new BigInteger(module.CredentialGeneration));
            Notify(engine, "ModuleUpdateConfirmed", accountId.ToArray(),
                SmartAccountModulePolicy.SmartAccountModuleTypeName(module.ModuleType),
                module.ContractHash.ToArray());
        }

        private void ExecuteSetHookOrderAction(ApplicationEngine engine, UInt160 accountId, Array action)
        {
            // [ActionSetHookOrder, hookIds[]]
            Require(action.Count == 2, SmartAccountModuleProtocol.ErrorOperationMalformed);
            BigInteger[] hookIds = SmartAccountRecordCodec.Integers(action[1],
                SmartAccountModuleProtocol.MaxHookModuleInstances);
            HookOrderRecord order = ReadHookOrder(engine.SnapshotCache, accountId);
            order.HookIds = hookIds;
            order.Revision += 1;
            SaveHookOrder(engine, accountId, order);
        }

        private async ContractTask ExecuteRebindModuleCodeActionAsync(ApplicationEngine engine, UInt160 accountId,
            Array action)
        {
            // [ActionRebindModuleCode, moduleId, profileDigest32]
            Require(action.Count == 3, SmartAccountModuleProtocol.ErrorOperationMalformed);
            BigInteger moduleId = SmartAccountRecordCodec.Unsigned(action[1]);
            byte[] profileDigest = SmartAccountRecordCodec.Fixed(action[2], 32);

            ModuleInstance module = RequireModuleInstance(engine.SnapshotCache, accountId, moduleId);
            ContractState contract = SmartAccountModulePolicy.RequireDeployed(engine.SnapshotCache,
                module.ContractHash);
            bool wasThresholdMemberEligible = module.ThresholdMemberEligible;
            SmartAccountModulePolicy.CaptureCodeBinding(module, contract);
            module.ProfileSha256 = profileDigest;
            // The rebound code is re-profiled: its capability flags replace the
            // recorded ones, and a rebind may never strand state that depends on
            // a capability the new profile no longer declares.
            await SmartAccountModulePolicy.BindProfileAsync(engine, module, contract, profileDigest);
            if (!module.InstanceIsolation)
                Require(CountModuleInstancesOfContract(engine.SnapshotCache, accountId, module.ModuleType,
                    module.ContractHash) <= 1, SmartAccountModuleProtocol.ErrorModuleInstanceIsolationRequired);
            if (wasThresholdMemberEligible && !module.ThresholdMemberEligible)
                Require(!IsMemberOfActivePolicy(module), SmartAccountModuleProtocol.ErrorIntentConflict);
            module.ModuleRevision += 1;
            SaveModuleInstance(engine, accountId, moduleId, module);
            Notify(engine, SmartAccountModuleProtocol.EventNameModuleCodeRebound, accountId.ToArray(),
                moduleId, module.NefSha256);
            Notify(engine, "ModuleUpdateConfirmed", accountId.ToArray(),
                SmartAccountModulePolicy.SmartAccountModuleTypeName(module.ModuleType),
                module.ContractHash.ToArray());
        }

        private void ExecuteSetThresholdPolicyAction(ApplicationEngine engine, UInt160 accountId,
            AccountControl control, Array action)
        {
            // [ActionSetThresholdPolicy, policyId, threshold, memberIds[], active]
            // policyId 0 requests a NEW policy from the SAME monotonic allocator
            // as module instances, so a policy id can never alias a module id.
            Require(action.Count == 5, SmartAccountModuleProtocol.ErrorOperationMalformed);
            BigInteger requestedId = SmartAccountRecordCodec.Unsigned(action[1]);
            BigInteger threshold = SmartAccountRecordCodec.Unsigned(action[2]);
            BigInteger[] memberIds = SmartAccountRecordCodec.Integers(action[3],
                SmartAccountModuleProtocol.MaxThresholdPolicyMembers);
            bool active = SmartAccountRecordCodec.Boolean(action[4]);

            ThresholdPolicyRecord? existing = null;
            BigInteger policyId;
            if (requestedId == BigInteger.Zero)
            {
                Require(active, SmartAccountModuleProtocol.ErrorOperationMalformed);
                policyId = control.AllocateModuleId();
            }
            else
            {
                existing = TryThresholdPolicy(engine.SnapshotCache, accountId, requestedId);
                Require(existing is not null, SmartAccountModuleProtocol.ErrorModuleNotInstalled);
                policyId = requestedId;
            }

            ThresholdPolicyRecord policy = new()
            {
                Threshold = (ulong)threshold,
                MemberIds = memberIds,
                Active = active,
                CredentialGeneration = existing is null ? 0 : existing.CredentialGeneration,
            };
            if (active)
            {
                Require(threshold >= SmartAccountModuleProtocol.MinThresholdPolicyValue
                    && threshold <= SmartAccountModuleProtocol.MaxThresholdPolicyValue,
                    SmartAccountModuleProtocol.ErrorModuleLimitThreshold);
                Require(memberIds.Length > 0
                    && memberIds.Length <= SmartAccountModuleProtocol.MaxThresholdPolicyMembers,
                    SmartAccountModuleProtocol.ErrorModuleLimitMembers);
                Require(threshold <= memberIds.Length, SmartAccountModuleProtocol.ErrorModuleLimitThreshold);
                for (int i = 0; i < memberIds.Length; i++)
                {
                    ModuleInstance member = RequireActiveValidator(engine.SnapshotCache, accountId, memberIds[i]);
                    Require(member.ThresholdMemberEligible, SmartAccountModuleProtocol.ErrorOperationMalformed);
                    for (int j = 0; j < i; j++)
                        Require(memberIds[j] != memberIds[i],
                            SmartAccountModuleProtocol.ErrorOperationMalformed);
                    AssertNotMemberOfOtherActivePolicy(member, policyId);
                }
            }
            else Require(memberIds.Length == 0, SmartAccountModuleProtocol.ErrorOperationMalformed);

            // Member-side back-pointer maintenance: clearing runs first so a
            // reshape that reuses a member ends with exactly one pointer.
            if (existing is not null && existing.Active)
            {
                foreach (BigInteger previousId in existing.MemberIds)
                {
                    ModuleInstance? previous = TryModuleInstance(engine.SnapshotCache, accountId, previousId);
                    if (previous is not null && previous.ActivePolicyId == policyId)
                    {
                        previous.ActivePolicyId = BigInteger.Zero;
                        SaveModuleInstance(engine, accountId, previousId, previous);
                    }
                }
            }

            SaveThresholdPolicy(engine, accountId, policyId, policy);
            if (active)
            {
                foreach (BigInteger memberId in memberIds)
                {
                    ModuleInstance member = RequireActiveValidator(engine.SnapshotCache, accountId, memberId);
                    member.ActivePolicyId = policyId;
                    SaveModuleInstance(engine, accountId, memberId, member);
                }
            }
            Notify(engine, SmartAccountModuleProtocol.EventNameThresholdPolicySet, accountId.ToArray(),
                policyId, new BigInteger(policy.Threshold),
                new Array(policy.MemberIds.Select(id => (StackItem)id).ToArray()));
        }

        private void ExecuteSetDefaultPolicyAction(AccountControl control, Array action)
        {
            // [ActionSetDefaultPolicy, defaultOperationAuthorization, defaultMessageAuthorization]
            Require(action.Count == 3, SmartAccountModuleProtocol.ErrorOperationMalformed);
            control.DefaultOperationAuthorization = SmartAccountRecordCodec.Boolean(action[1]);
            control.DefaultMessageAuthorization = SmartAccountRecordCodec.Boolean(action[2]);
            control.DefaultPolicyRevision += 1;
        }

        private void ExecuteSetRecoveryPolicyAction(ApplicationEngine engine, AccountControl control, Array action)
        {
            // [ActionSetRecoveryPolicy, recoveryAuthority, recoveryTimelockMs, ownerOnlyRecovery]
            Require(action.Count == 4, SmartAccountModuleProtocol.ErrorOperationMalformed);
            UInt160 newAuthority = SmartAccountRecordCodec.Address(action[1]);
            BigInteger timelockMs = SmartAccountRecordCodec.Unsigned(action[2]);
            bool ownerOnly = SmartAccountRecordCodec.Boolean(action[3]);
            Require(timelockMs >= AccountControl.RecoveryTimelockMinMs
                && timelockMs <= AccountControl.RecoveryTimelockMaxMs,
                SmartAccountModuleProtocol.ErrorOperationMalformed);
            // A NEW non-zero control subject additionally requires that
            // subject's witness at confirmation time (spec §10).
            if (newAuthority != UInt160.Zero && newAuthority != control.RecoveryAuthority)
                Require(Witness(engine, newAuthority), SmartAccountModuleProtocol.ErrorUnauthorized);
            control.RecoveryAuthority = newAuthority;
            control.RecoveryTimelockMs = (ulong)timelockMs;
            // The legacy permanent owner-only constraint is monotonic.
            control.OwnerOnlyRecovery = control.OwnerOnlyRecovery || ownerOnly;
        }

        private void ExecuteMigrateAccountAction(ApplicationEngine engine, UInt160 accountId, AccountControl control,
            Array action)
        {
            // [ActionMigrateAccount, manifestDigest32, classification]
            Require(action.Count == 3, SmartAccountModuleProtocol.ErrorOperationMalformed);
            _ = SmartAccountRecordCodec.Fixed(action[1], 32);
            _ = SmartAccountRecordCodec.Text(action[2], 64);
            // The native kernel activates with the hardfork and therefore has no
            // legacy account rows to import: migration is a custom-kernel-only
            // path (spec §14). Fail closed instead of fabricating a state.
            _ = engine;
            _ = accountId;
            _ = control;
            throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorMigrationRequired);
        }

        // ========================================================================
        // 5. Action shape validation and resource keys (consumed at propose time)
        // ========================================================================

        private static void ValidateActionShape(StackItem item)
        {
            try
            {
                ValidateActionShapeCore(RequireActionArray(item));
            }
            catch
            {
                // Propose-time shape failures map uniformly to
                // SA_OPERATION_MALFORMED; executors re-validate precisely.
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            }
        }

        private static void ValidateActionShapeCore(Array action)
        {
            Require(action.Count >= 1, SmartAccountModuleProtocol.ErrorOperationMalformed);
            int code = ActionCode(action);
            switch (code)
            {
                case SmartAccountModuleProtocol.ActionInstallModule:
                    Require(action.Count == 5, SmartAccountModuleProtocol.ErrorOperationMalformed);
                    int moduleType = (int)SmartAccountRecordCodec.Unsigned(action[1]);
                    Require(moduleType is SmartAccountModuleProtocol.ModuleTypeCodeValidator
                        or SmartAccountModuleProtocol.ModuleTypeCodeHook,
                        SmartAccountModuleProtocol.ErrorModuleTypeUnsupported);
                    Require(SmartAccountRecordCodec.Address(action[2]) != UInt160.Zero,
                        SmartAccountModuleProtocol.ErrorOperationMalformed);
                    _ = SmartAccountRecordCodec.Fixed(action[3], 32);
                    Require(RequireActionArray(action[4]).Count <= SmartAccountModuleProtocol.ArgsCountMax,
                        SmartAccountModuleProtocol.ErrorOperationMalformed);
                    break;
                case SmartAccountModuleProtocol.ActionUninstallModule:
                case SmartAccountModuleProtocol.ActionConfigureModule:
                case SmartAccountModuleProtocol.ActionRebindModuleCode:
                    Require(action.Count == 3, SmartAccountModuleProtocol.ErrorOperationMalformed);
                    Require(SmartAccountRecordCodec.Unsigned(action[1]) >= 1,
                        SmartAccountModuleProtocol.ErrorModuleIdInvalid);
                    if (code == SmartAccountModuleProtocol.ActionRebindModuleCode)
                        _ = SmartAccountRecordCodec.Fixed(action[2], 32);
                    else
                        Require(RequireActionArray(action[2]).Count <= SmartAccountModuleProtocol.ArgsCountMax,
                            SmartAccountModuleProtocol.ErrorOperationMalformed);
                    break;
                case SmartAccountModuleProtocol.ActionSetHookOrder:
                {
                    Require(action.Count == 2, SmartAccountModuleProtocol.ErrorOperationMalformed);
                    BigInteger[] hookIds = SmartAccountRecordCodec.Integers(action[1],
                        SmartAccountModuleProtocol.MaxHookModuleInstances);
                    Require(hookIds.Length <= SmartAccountModuleProtocol.MaxHookModuleInstances,
                        SmartAccountModuleProtocol.ErrorModuleLimitHook);
                    for (int i = 0; i < hookIds.Length; i++)
                    {
                        Require(hookIds[i] >= 1, SmartAccountModuleProtocol.ErrorModuleIdInvalid);
                        for (int j = 0; j < i; j++)
                            Require(hookIds[j] != hookIds[i],
                                SmartAccountModuleProtocol.ErrorOperationMalformed);
                    }
                    break;
                }
                case SmartAccountModuleProtocol.ActionSetDefaultPolicy:
                    Require(action.Count == 3, SmartAccountModuleProtocol.ErrorOperationMalformed);
                    _ = SmartAccountRecordCodec.Boolean(action[1]);
                    _ = SmartAccountRecordCodec.Boolean(action[2]);
                    break;
                case SmartAccountModuleProtocol.ActionSetThresholdPolicy:
                {
                    Require(action.Count == 5, SmartAccountModuleProtocol.ErrorOperationMalformed);
                    BigInteger policyId = SmartAccountRecordCodec.Unsigned(action[1]);
                    BigInteger threshold = SmartAccountRecordCodec.Unsigned(action[2]);
                    BigInteger[] members = SmartAccountRecordCodec.Integers(action[3],
                        SmartAccountModuleProtocol.MaxThresholdPolicyMembers);
                    bool active = SmartAccountRecordCodec.Boolean(action[4]);
                    Require(policyId > 0 || active, SmartAccountModuleProtocol.ErrorOperationMalformed);
                    if (active)
                    {
                        Require(threshold >= SmartAccountModuleProtocol.MinThresholdPolicyValue
                            && threshold <= SmartAccountModuleProtocol.MaxThresholdPolicyValue,
                            SmartAccountModuleProtocol.ErrorModuleLimitThreshold);
                        Require(members.Length > 0
                            && members.Length <= SmartAccountModuleProtocol.MaxThresholdPolicyMembers,
                            SmartAccountModuleProtocol.ErrorModuleLimitMembers);
                        for (int i = 0; i < members.Length; i++)
                            for (int j = 0; j < i; j++)
                                Require(members[j] != members[i],
                                    SmartAccountModuleProtocol.ErrorOperationMalformed);
                    }
                    else Require(members.Length == 0, SmartAccountModuleProtocol.ErrorOperationMalformed);
                    break;
                }
                case SmartAccountModuleProtocol.ActionSetRecoveryPolicy:
                {
                    Require(action.Count == 4, SmartAccountModuleProtocol.ErrorOperationMalformed);
                    _ = SmartAccountRecordCodec.Address(action[1]);
                    BigInteger timelock = SmartAccountRecordCodec.Unsigned(action[2]);
                    Require(timelock >= AccountControl.RecoveryTimelockMinMs
                        && timelock <= AccountControl.RecoveryTimelockMaxMs,
                        SmartAccountModuleProtocol.ErrorOperationMalformed);
                    _ = SmartAccountRecordCodec.Boolean(action[3]);
                    break;
                }
                case SmartAccountModuleProtocol.ActionSetMessageSubjects:
                {
                    Require(action.Count == 3, SmartAccountModuleProtocol.ErrorOperationMalformed);
                    byte[][] subjects = SmartAccountRecordCodec.BytesArray(action[1],
                        SmartAccountModuleProtocol.MessageSubjectKeysMax, 32);
                    for (int i = 0; i < subjects.Length; i++)
                    {
                        Require(subjects[i].Length is 20 or 32,
                            SmartAccountModuleProtocol.ErrorOperationMalformed);
                        for (int j = 0; j < i; j++)
                            Require(!subjects[j].AsSpan().SequenceEqual(subjects[i]),
                                SmartAccountModuleProtocol.ErrorOperationMalformed);
                    }
                    BigInteger subjectThreshold = SmartAccountRecordCodec.Unsigned(action[2]);
                    Require(subjectThreshold >= 1 && subjectThreshold <= subjects.Length,
                        SmartAccountModuleProtocol.ErrorOperationMalformed);
                    break;
                }
                case SmartAccountModuleProtocol.ActionMigrateAccount:
                    Require(action.Count == 3, SmartAccountModuleProtocol.ErrorOperationMalformed);
                    _ = SmartAccountRecordCodec.Fixed(action[1], 32);
                    _ = SmartAccountRecordCodec.Text(action[2], 64);
                    break;
                default:
                    throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            }
        }

        private static readonly byte[] ResourceTagModuleContract = "module:"u8.ToArray();
        private static readonly byte[] ResourceTagModuleId = "moduleId:"u8.ToArray();
        private static readonly byte[] ResourceTagPolicy = "policy:"u8.ToArray();
        private static readonly byte[] ResourceTagHookOrder = "hookOrder"u8.ToArray();
        private static readonly byte[] ResourceTagDefaultPolicy = "defaultPolicy"u8.ToArray();
        private static readonly byte[] ResourceTagRecovery = "recovery"u8.ToArray();
        private static readonly byte[] ResourceTagMessageSubjects = "messageSubjects"u8.ToArray();
        private static readonly byte[] ResourceTagMigration = "migration"u8.ToArray();

        private static byte[] ModuleContractResource(UInt160 contractHash) =>
            SmartAccountProtocol.Concat(ResourceTagModuleContract, contractHash.ToArray());

        private static byte[] ModuleIdResource(BigInteger moduleId) =>
            SmartAccountProtocol.Concat(ResourceTagModuleId, SmartAccountProtocol.UInt64Be(moduleId));

        private static byte[] PolicyResource(BigInteger policyId) =>
            SmartAccountProtocol.Concat(ResourceTagPolicy, SmartAccountProtocol.UInt64Be(policyId));

        /// <summary>Bounded resource keys a configuration action reads or writes.</summary>
        private static byte[][] ResourceKeysForAction(Array action)
        {
            int code = ActionCode(action);
            switch (code)
            {
                case SmartAccountModuleProtocol.ActionInstallModule:
                    return [ModuleContractResource(SmartAccountRecordCodec.Address(action[2]))];
                case SmartAccountModuleProtocol.ActionUninstallModule:
                case SmartAccountModuleProtocol.ActionConfigureModule:
                case SmartAccountModuleProtocol.ActionRebindModuleCode:
                    return [ModuleIdResource(SmartAccountRecordCodec.Unsigned(action[1]))];
                case SmartAccountModuleProtocol.ActionSetHookOrder:
                    return [ResourceTagHookOrder];
                case SmartAccountModuleProtocol.ActionSetDefaultPolicy:
                    return [ResourceTagDefaultPolicy];
                case SmartAccountModuleProtocol.ActionSetThresholdPolicy:
                {
                    BigInteger policyId = SmartAccountRecordCodec.Unsigned(action[1]);
                    BigInteger[] members = SmartAccountRecordCodec.Integers(action[3],
                        SmartAccountModuleProtocol.MaxThresholdPolicyMembers);
                    byte[][] keys = new byte[members.Length + 1][];
                    keys[0] = PolicyResource(policyId);
                    for (int i = 0; i < members.Length; i++) keys[i + 1] = ModuleIdResource(members[i]);
                    return keys;
                }
                case SmartAccountModuleProtocol.ActionSetRecoveryPolicy:
                    return [ResourceTagRecovery];
                case SmartAccountModuleProtocol.ActionSetMessageSubjects:
                    return [ResourceTagMessageSubjects];
                case SmartAccountModuleProtocol.ActionMigrateAccount:
                    return [ResourceTagMigration];
                default:
                    throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            }
        }

        private static bool ActionTouchesModuleModel(Array action)
        {
            int code = ActionCode(action);
            return code is SmartAccountModuleProtocol.ActionInstallModule
                or SmartAccountModuleProtocol.ActionUninstallModule
                or SmartAccountModuleProtocol.ActionConfigureModule
                or SmartAccountModuleProtocol.ActionSetHookOrder
                or SmartAccountModuleProtocol.ActionRebindModuleCode
                or SmartAccountModuleProtocol.ActionSetThresholdPolicy;
        }

        // ========================================================================
        // 6. Module callbacks (spec §9/§11)
        //    Every callback is addressed to a recorded 0x52 instance, runs under
        //    a phase grant for exactly that instance and is capped by both a hard
        //    per-call budget and the envelope-scoped aggregate pool it charges.
        // ========================================================================

        /// <summary>
        /// Opens the engine-local execution state if the caller did not already
        /// own one (a batch owns a single envelope-wide state).
        /// </summary>
        private static SmartAccountInvocationContext.AccountExecution EnsureExecution(ApplicationEngine engine, UInt160 accountId,
            out bool owned)
        {
            SmartAccountInvocationContext context = Context(engine);
            if (context.TryGetExecution(accountId, out SmartAccountInvocationContext.AccountExecution? existing))
            {
                owned = false;
                return existing;
            }
            context.OpenExecution(accountId,
                SmartAccountModuleProtocol.ValidationAggregateGasLimit,
                SmartAccountModuleProtocol.HookAggregateGasLimit,
                SmartAccountModuleProtocol.CompletionAggregateGasLimit);
            owned = true;
            return context.Execution(accountId);
        }

        private static void ChargePool(SmartAccountInvocationContext context, UInt160 accountId,
            SmartAccountInvocationContext.AccountExecution execution, SmartAccountGasPool pool, long spent, long perCallCap)
        {
            if (spent < 0) spent = 0;
            if (spent > perCallCap)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorGasBudgetExceeded);
            context.Spend(execution, pool, spent);
            if (context.Remaining(execution, pool) < 0)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorGasBudgetExceeded);
        }

        private async ContractTask<StackItem> CallModuleAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, string method, SmartAccountCallbackPhase phase,
            CallFlags flags, long budget, SmartAccountGasPool pool, StackItem[] arguments)
        {
            SmartAccountModulePolicy.AssertCodeBinding(
                NativeContract.ContractManagement.GetContract(engine.SnapshotCache, module.ContractHash), module);
            SmartAccountInvocationContext context = Context(engine);
            SmartAccountInvocationContext.AccountExecution execution = EnsureExecution(engine, accountId, out bool ownedExecution);
            try
            {
                if (context.Remaining(execution, pool) <= 0)
                    throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorGasBudgetExceeded);
                long before = engine.GasLeft;
                long effective = Math.Min(budget, context.Remaining(execution, pool));
                var task = engine.CallFromNativeContractWithGasLimitAsync(SmartAccountProtocol.ServiceHash,
                    module.ContractHash, method, flags, effective, arguments);
                var anchor = engine.CurrentContext!.GetState<ExecutionContextState>();
                StackItem result;
                using (context.EnterModule(accountId, moduleId, module.ContractHash, phase, anchor))
                    result = (await task)!;
                ChargePool(context, accountId, execution, pool, before - engine.GasLeft, budget);
                return result;
            }
            finally
            {
                if (ownedExecution) context.CloseExecution(accountId);
            }
        }

        private async ContractTask CallModuleLifecycleAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, string callback, Array data)
        {
            _ = await CallModuleAsync(engine, accountId, moduleId, module, callback,
                SmartAccountCallbackPhase.Configuration, CallFlags.All,
                SmartAccountModuleProtocol.LifecycleCallbackGasLimit, SmartAccountGasPool.Completion,
                new StackItem[]
                {
                    accountId.ToArray(), moduleId, new BigInteger(module.CredentialGeneration), data,
                });
        }

        /// <summary>
        /// Signature validation by one validator instance (the routed validator
        /// or one threshold member). Read-only, charged to the shared validation
        /// aggregate, and approval is exactly Boolean true (spec §9 ABI).
        /// </summary>
        private async ContractTask<bool> CallValidatorValidateUserOpAsync(ApplicationEngine engine,
            UInt160 accountId, BigInteger moduleId, ModuleInstance module, Array operation,
            ReadOnlyMemory<byte> operationDigest)
        {
            StackItem reply = (await CallModuleAsync(engine, accountId, moduleId, module, "validateUserOp",
                SmartAccountCallbackPhase.Validation, CallFlags.ReadOnly,
                SmartAccountModuleProtocol.ValidationPerCallGasLimit, SmartAccountGasPool.Validation,
                new StackItem[]
                {
                    accountId.ToArray(), operationDigest.ToArray(), BuildCanonicalOperationView(operation, engine),
                }))!;
            if (reply is not Boolean approved)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorModuleTypeUnsupported);
            return approved.GetBoolean();
        }

        private async ContractTask CallValidatorCompletionAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, Array operation, StackItem result)
        {
            await CallModuleAsync(engine, accountId, moduleId, module, "onUserOpComplete",
                SmartAccountCallbackPhase.Completion, CallFlags.All,
                SmartAccountModuleProtocol.CompletionPerCallGasLimit, SmartAccountGasPool.Completion,
                new StackItem[]
                {
                    accountId.ToArray(), BuildCanonicalOperationView(operation, engine), CloneValue(engine, result),
                });
        }

        private async ContractTask<byte[]> CallHookPreCheckAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, Array operation)
        {
            StackItem reply = (await CallModuleAsync(engine, accountId, moduleId, module, "preCheck",
                SmartAccountCallbackPhase.HookPre, CallFlags.All,
                SmartAccountModuleProtocol.HookCallbackGasLimit, SmartAccountGasPool.Hook,
                new StackItem[] { accountId.ToArray(), BuildCanonicalOperationView(operation, engine) }))!;
            if (reply is Null) return [];
            if (reply is not ByteString hookData)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorModuleTypeUnsupported);
            if (hookData.Size > SmartAccountModuleProtocol.HookDataBytesMax)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorHookDataTooLarge);
            return hookData.GetSpan().ToArray();
        }

        private async ContractTask CallHookPostCheckAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, Array operation, StackItem result, byte[] hookData)
        {
            await CallModuleAsync(engine, accountId, moduleId, module, "postCheck",
                SmartAccountCallbackPhase.HookPost, CallFlags.All,
                SmartAccountModuleProtocol.HookCallbackGasLimit, SmartAccountGasPool.Hook,
                new StackItem[]
                {
                    accountId.ToArray(), BuildCanonicalOperationView(operation, engine),
                    CloneValue(engine, result), hookData,
                });
        }

        /// <summary>
        /// Canonical 13-field operation view handed to every callback: a fresh
        /// copy of the authenticated operation, so a module can never mutate the
        /// content the target executes (spec §4.1/§9).
        /// </summary>
        private static Array BuildCanonicalOperationView(Array operation, ApplicationEngine engine)
        {
            engine.AddNativeCpuFee(1 << 12);
            byte[] encoded = BinarySerializer.Serialize(operation,
                SmartAccountModuleProtocol.OperationEncodedSizeMax,
                SmartAccountModuleProtocol.OperationEncodedSizeMax);
            MemoryReader reader = new(encoded);
            return (Array)BinarySerializer.Deserialize(ref reader,
                SmartAccountModuleProtocol.OperationEncodedSizeMax,
                SmartAccountModuleProtocol.OperationEncodedSizeMax);
        }

        private static StackItem CloneValue(ApplicationEngine engine, StackItem value)
        {
            engine.AddNativeCpuFee(1 << 12);
            byte[] encoded = BinarySerializer.Serialize(value, engine.Limits);
            return BinarySerializer.Deserialize(encoded, engine.Limits);
        }

        // ========================================================================
        // 7. Read-only module queries (spec §3.3)
        // ========================================================================

        /// <summary>Page of installed moduleIds: [ids[], nextCursor, configurationNonce].</summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private Array GetModules(IReadOnlyStore snapshot, UInt160 accountId, string moduleType, BigInteger cursor,
            BigInteger limit)
        {
            RequireAccountId(accountId);
            int typeCode = ModuleTypeCodeFromName(moduleType);
            Array page = EnumerateModulePage(snapshot, accountId, typeCode, cursor, limit);
            AccountControl? control = TryControl(snapshot, accountId);
            return new Array(new StackItem[]
            {
                page[0], page[1], control is null ? BigInteger.Zero : new BigInteger(control.ConfigurationNonce),
            });
        }

        /// <summary>
        /// Full instance descriptor or an empty Array. Layout: [moduleId,
        /// moduleType, contractHash, contractId, updateCounter, nefSha256,
        /// profileSha256, moduleRevision, credentialGeneration,
        /// instanceIsolation, messageCapability, thresholdMemberEligible].
        /// </summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private Array GetModule(IReadOnlyStore snapshot, UInt160 accountId, BigInteger moduleId)
        {
            RequireAccountId(accountId);
            ModuleInstance? module = TryModuleInstance(snapshot, accountId, moduleId);
            if (module is null) return new Array();
            return new Array(new StackItem[]
            {
                SmartAccountProtocol.UInt64Be(moduleId), new BigInteger(module.ModuleType),
                module.ContractHash.ToArray(), new BigInteger(module.ContractId),
                new BigInteger(module.UpdateCounter), module.NefSha256, module.ProfileSha256,
                new BigInteger(module.ModuleRevision), new BigInteger(module.CredentialGeneration),
                module.InstanceIsolation, module.MessageCapability, module.ThresholdMemberEligible,
            });
        }

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private bool IsModuleInstalled(IReadOnlyStore snapshot, UInt160 accountId, string moduleType,
            UInt160 moduleHash, byte[] additionalContext)
        {
            RequireAccountId(accountId);
            _ = additionalContext;
            if (moduleHash is null || moduleHash == UInt160.Zero) return false;
            int typeCode = ModuleTypeCodeFromName(moduleType);
            return FindModuleIdByContract(snapshot, accountId, typeCode, moduleHash) != BigInteger.Zero;
        }

        /// <summary>Returns [hookIds[], revision] — the core-owned hook order.</summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private Array GetHookOrder(IReadOnlyStore snapshot, UInt160 accountId)
        {
            RequireAccountId(accountId);
            HookOrderRecord order = ReadHookOrder(snapshot, accountId);
            return new Array(new StackItem[]
            {
                new Array(order.HookIds.Select(id => (StackItem)id).ToArray()), new BigInteger(order.Revision),
            });
        }

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.None)]
        private static bool SupportsModuleType(string moduleType) =>
            moduleType is "validator" or "hook";

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.None)]
        private static bool SupportsExecutionMode(string mode) =>
            mode is "single" or "batch" or "batch-atomic";

        /// <summary>
        /// Phase-exact module authorization: the authorized moduleId while the
        /// caller IS the contract of the instance the recorded phase addresses,
        /// or -1. A module calls this from inside a callback to authenticate the
        /// core and learn which of its instances is being addressed.
        /// </summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private BigInteger GetAuthorizedModuleId(ApplicationEngine engine, UInt160 accountId, int phase)
        {
            RequireAccountId(accountId);
            if (phase < 1 || phase > (int)SmartAccountCallbackPhase.Cleanup) return BigInteger.MinusOne;
            SmartAccountInvocationContext context = Context(engine);
            if (!context.IsModuleAuthorized(engine, accountId, (SmartAccountCallbackPhase)phase))
                return BigInteger.MinusOne;
            SmartAccountInvocationContext.AccountExecution execution = context.Execution(accountId);
            return execution.ActiveModuleId;
        }

        private static int ModuleTypeCodeFromName(string moduleType) => moduleType switch
        {
            "validator" => SmartAccountModuleProtocol.ModuleTypeCodeValidator,
            "hook" => SmartAccountModuleProtocol.ModuleTypeCodeHook,
            _ => throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorModuleTypeUnsupported),
        };

        // ========================================================================
        // 8. Credential revocation (spec §10 exception list)
        //    Callback-free, immediate and one-way: the bumped generation makes
        //    every previously issued credential fail its binding.
        // ========================================================================

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void RevokeCredentials(ApplicationEngine engine, UInt160 accountId, BigInteger moduleId)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            _ = RequireActive(control);
            RequireCustody(engine, control);
            ModuleInstance module = RequireModuleInstance(engine.SnapshotCache, accountId, moduleId);
            Require(module.IsValidator, SmartAccountModuleProtocol.ErrorModuleNotRoutable);

            module.CredentialGeneration += 1;
            SaveModuleInstance(engine, accountId, moduleId, module);
            control.ConfigurationNonce += 1;
            SaveControl(engine, accountId, control);
            Notify(engine, SmartAccountModuleProtocol.EventNameCredentialRevoked, accountId.ToArray(),
                moduleId, new BigInteger(module.CredentialGeneration));
        }
    }
}
