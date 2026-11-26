// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccount.Modules.cs file belongs to the neo project and is free software distributed under the MIT software
// license, see the accompanying file LICENSE in the main directory of the repository or
// http://www.opensource.org/licenses/mit-license.php for more details.
//
// Redistribution and use in source and binary forms with or without modifications are permitted.

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
    /// <summary> Generic module registry and callback kernel. The core stores identity, code binding, credentials and capability
    /// metadata only. Threshold, message, recovery and hook-order policy are owned by user-space modules. </summary>
    public sealed partial class SmartAccount
    {
        // ======================================================================== 1. Module instance records (0x52)
        // and the 0x53 enumeration index ========================================================================

        private ModuleInstance? TryModuleInstance(IReadOnlyStore snapshot, UInt160 accountId, BigInteger moduleId)
        {
            if (moduleId < 1 || moduleId >> 64 != BigInteger.Zero) return null;
            return TryRead(snapshot,
                Key(SmartAccountModuleProtocol.PrefixModuleInstance).Add(accountId)
                    .AddBigEndian(SmartAccountProtocol.UInt64(moduleId)), out var value)
                ? ModuleInstance.Decode(value)
                : null;
        }

        private ModuleInstance RequireModuleInstance(IReadOnlyStore snapshot, UInt160 accountId, BigInteger moduleId) =>
            TryModuleInstance(snapshot, accountId, moduleId)
                ?? throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorModuleNotInstalled);

        /// <summary> Persists the instance in the tagged canonical shape. </summary>
        private void SaveModuleInstance(ApplicationEngine engine, UInt160 accountId, BigInteger moduleId,
            ModuleInstance module)
        {
            ulong id = SmartAccountProtocol.UInt64(moduleId);
            Write(engine, Key(SmartAccountModuleProtocol.PrefixModuleInstance).Add(accountId).AddBigEndian(id),
                module.Serialize());
            // The 0x53 index row (prefix ‖ account ‖ type ‖ id) is what the per-type enumeration seeks.
            Write(engine, Key(SmartAccountModuleProtocol.PrefixModuleIndex).Add(accountId).Add(module.ModuleType)
                .AddBigEndian(id), [1]);
        }

        private void DeleteModuleInstance(ApplicationEngine engine, UInt160 accountId, BigInteger moduleId,
            ModuleInstance module)
        {
            ulong id = SmartAccountProtocol.UInt64(moduleId);
            engine.SnapshotCache.Delete(Key(SmartAccountModuleProtocol.PrefixModuleInstance).Add(accountId).AddBigEndian(id));
            engine.SnapshotCache.Delete(Key(SmartAccountModuleProtocol.PrefixModuleIndex).Add(accountId)
                .Add(module.ModuleType).AddBigEndian(id));
        }

        private int CountModulesOfType(IReadOnlyStore snapshot, UInt160 accountId, int moduleType)
        {
            int count = 0;
            foreach (var _ in snapshot.Find(
                Key(SmartAccountModuleProtocol.PrefixModuleIndex).Add(accountId).Add((byte)moduleType))) count++;
            return count;
        }

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

        private IEnumerable<BigInteger> EnumerateModuleIds(IReadOnlyStore snapshot, UInt160 accountId,
            int moduleType, BigInteger cursor, int limit)
        {
            if (cursor < 0 || cursor >> 64 != BigInteger.Zero)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorModuleIdInvalid);
            if (limit < 1)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            // The enumeration seeks the 0x53 index prefix ‖ account ‖ type; the module id is the 8-byte suffix.
            StorageKey prefix = Key(SmartAccountModuleProtocol.PrefixModuleIndex).Add(accountId).Add((byte)moduleType);
            int emitted = 0;
            // Find already returns exactly the rows under this prefix, in key order.
            foreach (var (key, _) in snapshot.Find(prefix))
            {
                ReadOnlyMemory<byte> content = key.Key;
                if (content.Length != prefix.Key.Length + sizeof(ulong)) continue;
                // BigInteger reads the big-endian suffix in place; no suffix copy.
                BigInteger moduleId = new(content.Span[prefix.Key.Length..], isUnsigned: true,
                    isBigEndian: true);
                if (moduleId <= cursor) continue;
                yield return moduleId;
                if (++emitted == limit) yield break;
            }
        }

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

        /// <summary>Live installed instances of one type, in ascending id order.</summary>
        private IEnumerable<(BigInteger Id, ModuleInstance Module)> EnumerateModulesOfType(IReadOnlyStore snapshot,
            UInt160 accountId, int moduleType, int limit)
        {
            foreach (BigInteger moduleId in EnumerateModuleIds(snapshot, accountId, moduleType, BigInteger.Zero, limit))
            {
                ModuleInstance? module = TryModuleInstance(snapshot, accountId, moduleId);
                if (module is not null) yield return (moduleId, module);
            }
        }

        private IEnumerable<(BigInteger Id, ModuleInstance Module)> EnumerateValidatorModules(IReadOnlyStore snapshot,
            UInt160 accountId) =>
            EnumerateModulesOfType(snapshot, accountId, SmartAccountModuleProtocol.ModuleTypeCodeValidator,
                SmartAccountModuleProtocol.MaxValidatorModuleInstances);

        // ======================================================================== 2. Install / remove transition
        // ========================================================================

        private static int MaxModuleInstancesOfType(int moduleType) => moduleType switch
        {
            SmartAccountModuleProtocol.ModuleTypeCodeValidator => SmartAccountModuleProtocol.MaxValidatorModuleInstances,
            SmartAccountModuleProtocol.ModuleTypeCodeHook => SmartAccountModuleProtocol.MaxHookModuleInstances,
            SmartAccountModuleProtocol.ModuleTypeCodeRecovery => SmartAccountModuleProtocol.MaxRecoveryModuleInstances,
            _ => 0,
        };

        private static string ModuleLimitErrorOfType(int moduleType) => moduleType switch
        {
            SmartAccountModuleProtocol.ModuleTypeCodeHook => SmartAccountModuleProtocol.ErrorModuleLimitHook,
            SmartAccountModuleProtocol.ModuleTypeCodeRecovery => SmartAccountModuleProtocol.ErrorModuleLimitRecovery,
            _ => SmartAccountModuleProtocol.ErrorModuleLimitValidator,
        };

        /// <summary>Action arity by code (spec §4); an unknown code is malformed.</summary>
        private static int ActionArity(int code) => code switch
        {
            SmartAccountModuleProtocol.ActionInstallModule => 5,
            SmartAccountModuleProtocol.ActionUninstallModule
                or SmartAccountModuleProtocol.ActionConfigureModule
                or SmartAccountModuleProtocol.ActionSetBuiltinAuthorization
                or SmartAccountModuleProtocol.ActionSetRequiredValidator => 3,
            _ => throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorOperationMalformed),
        };

        private static int RequireModuleTypeCode(BigInteger moduleType)
        {
            Require(SmartAccountModuleProtocol.IsModuleTypeCode(moduleType),
                SmartAccountModuleProtocol.ErrorModuleTypeUnsupported);
            return (int)moduleType;
        }

        private async ContractTask<BigInteger> InstallModuleCoreAsync(ApplicationEngine engine, UInt160 accountId,
            AccountControl control, int moduleType, UInt160 contractHash, ReadOnlyMemory<byte>? declaredProfileDigest,
            Array initData)
        {
            Require(SmartAccountModuleProtocol.IsModuleTypeCode(moduleType),
                SmartAccountModuleProtocol.ErrorModuleTypeUnsupported);
            initData ??= new Array();
            Require(initData.Count <= SmartAccountModuleProtocol.ArgsCountMax,
                SmartAccountModuleProtocol.ErrorOperationMalformed);
            Require(CountModulesOfType(engine.SnapshotCache, accountId, moduleType)
                < MaxModuleInstancesOfType(moduleType), ModuleLimitErrorOfType(moduleType));
            ContractState contract = SmartAccountModulePolicy.RequireDeployed(engine.SnapshotCache, contractHash);
            Require(contract.Nef is not null && contract.Nef.Script.Length > 0
                && !string.IsNullOrEmpty(contract.Manifest.Name),
                SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch);
            ModuleInstance module = new() { ModuleType = (byte)moduleType };
            SmartAccountModulePolicy.CaptureCodeBinding(module, contract);
            await SmartAccountModulePolicy.BindProfileAsync(engine, module, contract);
            if (declaredProfileDigest is { } declared)
                Require(declared.Span.SequenceEqual(module.ProfileSha256),
                    SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch);
            module.ModuleRevision = 1;
            module.CredentialGeneration = 1;
            if (!module.InstanceIsolation)
                Require(FindModuleIdByContract(engine.SnapshotCache, accountId, moduleType, contractHash)
                    == BigInteger.Zero, SmartAccountModuleProtocol.ErrorModuleInstanceIsolationRequired);
            if (module.HookPlanner)
                Require(FindHookPlanner(engine.SnapshotCache, accountId) is null,
                    SmartAccountModuleProtocol.ErrorModuleLimitPlanner);
            BigInteger moduleId = control.AllocateModuleId();
            SaveModuleInstance(engine, accountId, moduleId, module);
            await CallModuleLifecycleAsync(engine, accountId, moduleId, module, "onInstall", initData);
            Notify(engine, SmartAccountModuleProtocol.EventNameModuleInstanceInstalled, accountId.ToArray(),
                moduleId, new BigInteger(module.ModuleType), contractHash.ToArray(),
                new BigInteger(module.CredentialGeneration));
            Notify(engine, "ModuleInstalled", accountId.ToArray(),
                SmartAccountModuleProtocol.ModuleTypeName(module.ModuleType), contractHash.ToArray());
            return moduleId;
        }

        private async ContractTask RemoveModuleCoreAsync(ApplicationEngine engine, UInt160 accountId,
            AccountControl control, BigInteger moduleId, Array deInitData)
        {
            deInitData ??= new Array();
            Require(deInitData.Count <= SmartAccountModuleProtocol.ArgsCountMax,
                SmartAccountModuleProtocol.ErrorOperationMalformed);
            ModuleInstance module = RequireModuleInstance(engine.SnapshotCache, accountId, moduleId);

            // Callback first, while the instance is still installed and authorized.
            await CallModuleLifecycleAsync(engine, accountId, moduleId, module, "onUninstall", deInitData);
            DeleteModuleInstance(engine, accountId, moduleId, module);
            Notify(engine, SmartAccountModuleProtocol.EventNameModuleInstanceRemoved, accountId.ToArray(), moduleId);
            Notify(engine, "ModuleRemoved", accountId.ToArray(),
                SmartAccountModuleProtocol.ModuleTypeName(module.ModuleType),
                module.ContractHash.ToArray());
        }

        // ======================================================================== 3. Generic registration and
        // configuration actions ========================================================================

        private async ContractTask ExecuteRegistrationActionsAsync(ApplicationEngine engine, UInt160 accountId,
            AccountControl control, Array actions)
        {
            foreach (StackItem item in actions)
                await ApplyModuleActionAsync(engine, accountId, control, RequireActionArray(item), governed: false);
        }

        private async ContractTask ApplyModuleActionAsync(ApplicationEngine engine, UInt160 accountId,
            AccountControl control, Array action, bool governed)
        {
            int code = ActionCode(action);
            Require(action.Count == ActionArity(code), SmartAccountModuleProtocol.ErrorOperationMalformed);
            switch (code)
            {
                case SmartAccountModuleProtocol.ActionInstallModule:
                    await InstallModuleCoreAsync(engine, accountId, control,
                        RequireModuleTypeCode(SmartAccountRecordCodec.Unsigned(action[1])),
                        SmartAccountRecordCodec.Address(action[2]), SmartAccountRecordCodec.Fixed(action[3], 32),
                        RequireActionArray(action[4]));
                    break;
                case SmartAccountModuleProtocol.ActionUninstallModule:
                    await RemoveModuleCoreAsync(engine, accountId, control,
                        SmartAccountRecordCodec.Unsigned(action[1]), RequireActionArray(action[2]));
                    break;
                case SmartAccountModuleProtocol.ActionConfigureModule:
                    if (governed) RequireGovernanceCaller(engine, accountId);
                    await ConfigureModuleCoreAsync(engine, accountId,
                        SmartAccountRecordCodec.Unsigned(action[1]), RequireActionArray(action[2]));
                    break;
                case SmartAccountModuleProtocol.ActionSetBuiltinAuthorization:
                    ApplyBuiltinPolicy(engine, accountId, control, SmartAccountRecordCodec.Boolean(action[1]),
                        SmartAccountRecordCodec.Boolean(action[2]));
                    break;
                default:
                    if (governed) RequireGovernanceCaller(engine, accountId);
                    ApplyRequiredValidator(engine, accountId, control,
                        SmartAccountRecordCodec.Unsigned(action[1]), SmartAccountRecordCodec.Boolean(action[2]));
                    break;
            }
        }

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

        private static void ValidateActionShape(StackItem item)
        {
            try
            {
                ValidateActionShapeCore(RequireActionArray(item));
            }
            catch
            {
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            }
        }

        private static void ValidateActionShapeCore(Array action)
        {
            Require(action.Count >= 1, SmartAccountModuleProtocol.ErrorOperationMalformed);
            int code = ActionCode(action);
            Require(action.Count == ActionArity(code), SmartAccountModuleProtocol.ErrorOperationMalformed);
            switch (code)
            {
                case SmartAccountModuleProtocol.ActionInstallModule:
                    Require(SmartAccountModuleProtocol.IsModuleTypeCode(SmartAccountRecordCodec.Unsigned(action[1])),
                        SmartAccountModuleProtocol.ErrorModuleTypeUnsupported);
                    Require(SmartAccountRecordCodec.Address(action[2]) != UInt160.Zero,
                        SmartAccountModuleProtocol.ErrorOperationMalformed);
                    _ = SmartAccountRecordCodec.Fixed(action[3], 32);
                    Require(RequireActionArray(action[4]).Count <= SmartAccountModuleProtocol.ArgsCountMax,
                        SmartAccountModuleProtocol.ErrorOperationMalformed);
                    break;
                case SmartAccountModuleProtocol.ActionUninstallModule:
                case SmartAccountModuleProtocol.ActionConfigureModule:
                    Require(SmartAccountRecordCodec.Unsigned(action[1]) >= 1,
                        SmartAccountModuleProtocol.ErrorModuleIdInvalid);
                    Require(RequireActionArray(action[2]).Count <= SmartAccountModuleProtocol.ArgsCountMax,
                        SmartAccountModuleProtocol.ErrorOperationMalformed);
                    break;
                case SmartAccountModuleProtocol.ActionSetBuiltinAuthorization:
                    _ = SmartAccountRecordCodec.Boolean(action[1]);
                    _ = SmartAccountRecordCodec.Boolean(action[2]);
                    break;
                default:
                    _ = SmartAccountRecordCodec.Unsigned(action[1]);
                    _ = SmartAccountRecordCodec.Boolean(action[2]);
                    break;
            }
        }

        // ======================================================================== 4. Public module administration
        // ========================================================================

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask<BigInteger> InstallModule(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleType, UInt160 moduleContractHash, Array initData)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            _ = RequireActive(control);
            RequireGovernanceCaller(engine, accountId);
            BigInteger moduleId = await InstallModuleCoreAsync(engine, accountId, control,
                RequireModuleTypeCode(moduleType), moduleContractHash, null, initData ?? new Array());
            SettleConfiguration(engine, accountId, control);
            return moduleId;
        }

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask RemoveModule(ApplicationEngine engine, UInt160 accountId, BigInteger moduleId,
            Array deInitData)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            _ = RequireActive(control);
            RequireGovernanceCaller(engine, accountId);
            await RemoveModuleCoreAsync(engine, accountId, control, moduleId, deInitData ?? new Array());
            RequireFinalOperationRoute(engine, accountId, control);
            SettleConfiguration(engine, accountId, control);
        }

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask ConfigureModule(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, Array data)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            _ = RequireActive(control);
            // A mandatory validator is an authorization boundary, not merely a routing preference: every module
            // reshape is a governance landing.
            RequireGovernanceCaller(engine, accountId);
            await ConfigureModuleCoreAsync(engine, accountId, moduleId, data ?? new Array());
            SettleConfiguration(engine, accountId, control);
        }

        /// <summary> Settlement of a configuration: the transition advances the configuration nonce exactly once. Every
        /// entry holds the account lock for the whole landing, so nothing inside the batch can advance it and an action loop
        /// can never consume a second step. </summary>
        private void SettleConfiguration(ApplicationEngine engine, UInt160 accountId, AccountControl control,
            bool advanceAuthority = false)
        {
            if (advanceAuthority) control.AdvanceAuthority();
            else control.Advance();
            SaveControl(engine, accountId, control);
        }

        private bool TryRequireGovernanceCaller(ApplicationEngine engine, UInt160 accountId)
        {
            UInt160 caller = engine.CallingScriptHash ?? UInt160.Zero;
            if (caller == UInt160.Zero) return false;
            foreach (var (_, module) in EnumerateValidatorModules(engine.SnapshotCache, accountId))
            {
                if (module.ContractHash != caller || !module.Governance) continue;
                AssertModuleCodeBinding(engine.SnapshotCache, module);
                return true;
            }
            return false;
        }

        /// <summary> Configuration landing (spec §4): install, remove, configure, setBuiltinAuthorization,
        /// applyConfigurationActions and an ordinary thaw take effect only through the account's currently bound, code-bound
        /// governance instance. The custody key of the account is not a module-administration principal. </summary>
        private void RequireGovernanceCaller(ApplicationEngine engine, UInt160 accountId) =>
            Require(TryRequireGovernanceCaller(engine, accountId), SmartAccountModuleProtocol.ErrorUnauthorized);

        // ======================================================================== 5. Generic configuration and
        // restricted account transitions ========================================================================

        private async ContractTask ConfigureModuleCoreAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, Array data)
        {
            Require(data.Count <= SmartAccountModuleProtocol.ArgsCountMax,
                SmartAccountModuleProtocol.ErrorOperationMalformed);
            ModuleInstance module = RequireModuleInstance(engine.SnapshotCache, accountId, moduleId);
            Require(module.ModuleRevision != ulong.MaxValue,
                SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch);
            ContractState target = SmartAccountModulePolicy.RequireDeployed(engine.SnapshotCache, module.ContractHash);
            Require(SmartAccountModulePolicy.HasMethod(target, "configure", 4),
                SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch);
            module.ModuleRevision++;
            SaveModuleInstance(engine, accountId, moduleId, module);
            await CallModuleLifecycleAsync(engine, accountId, moduleId, module, "configure", data);
            Notify(engine, "ModuleInstanceConfigured", accountId.ToArray(), moduleId,
                new BigInteger(module.CredentialGeneration));
        }

        private void ApplyRequiredValidator(ApplicationEngine engine, UInt160 accountId, AccountControl control,
            BigInteger validatorId, bool required)
        {
            if (required)
            {
                ModuleInstance module = RequireModuleInstance(engine.SnapshotCache, accountId, validatorId);
                Require(module.IsValidator, SmartAccountModuleProtocol.ErrorModuleNotRoutable);
                control.RequiredValidatorId = (ulong)validatorId;
            }
            else
            {
                Require(control.RequiredValidatorId == (ulong)validatorId,
                    SmartAccountModuleProtocol.ErrorOperationMalformed);
                control.RequiredValidatorId = 0;
            }
            Notify(engine, SmartAccountModuleProtocol.EventNameRequiredValidatorSet, accountId.ToArray(),
                validatorId, required);
        }

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void SetBuiltinAuthorization(ApplicationEngine engine, UInt160 accountId,
            bool defaultOperationAuthorization, bool defaultMessageAuthorization)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            _ = RequireActive(control);
            RequireGovernanceCaller(engine, accountId);
            ApplyBuiltinPolicy(engine, accountId, control, defaultOperationAuthorization,
                defaultMessageAuthorization);
            RequireFinalOperationRoute(engine, accountId, control);
            SettleConfiguration(engine, accountId, control);
        }

        private void RequireFinalOperationRoute(ApplicationEngine engine, UInt160 accountId, AccountControl control)
        {
            if (control.RequiredValidatorId != 0)
            {
                ModuleInstance module = RequireModuleInstance(engine.SnapshotCache, accountId,
                    control.RequiredValidatorId);
                Require(module.IsValidator, SmartAccountModuleProtocol.ErrorModuleNotRoutable);
                return;
            }
            Require(control.DefaultOperationAuthorization || CountModulesOfType(engine.SnapshotCache, accountId,
                SmartAccountModuleProtocol.ModuleTypeCodeValidator) > 0,
                SmartAccountModuleProtocol.ErrorBuiltinRouteRequired);
        }

        private void ApplyBuiltinPolicy(ApplicationEngine engine, UInt160 accountId, AccountControl control,
            bool operationEnabled, bool messageEnabled)
        {
            control.DefaultOperationAuthorization = operationEnabled;
            control.DefaultMessageAuthorization = messageEnabled;
            Notify(engine, SmartAccountModuleProtocol.EventNameBuiltinAuthorizationSet, accountId.ToArray(),
                operationEnabled, messageEnabled);
        }

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask ApplyConfigurationActions(ApplicationEngine engine, UInt160 accountId, Array actions)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            Require(actions is { Count: > 0 }, SmartAccountModuleProtocol.ErrorOperationMalformed);
            Require(actions.Count <= SmartAccountModuleProtocol.MaxConfigurationActions,
                SmartAccountModuleProtocol.ErrorModuleLimitActions);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            _ = RequireActive(control);
            // Restricted post-reset initialization (spec §12): the seat that just reset this account in this
            // engine may install exactly the new composition. It cannot reach custody, uninstall, configure, the
            // built-in switches or the required-validator pin, and any other caller still needs the bound, code-bound
            // governance instance. The epoch binds the claim to the reset that opened it, so a later transaction has
            // no claim to use.
            bool restricted = Context(engine).IsResetInitialization(accountId,
                engine.CallingScriptHash ?? UInt160.Zero, control.AuthorityEpoch);
            if (restricted)
            {
                foreach (StackItem item in actions)
                    Require(ActionCode(RequireActionArray(item)) == SmartAccountModuleProtocol.ActionInstallModule,
                        SmartAccountModuleProtocol.ErrorUnauthorized);
            }
            else RequireGovernanceCaller(engine, accountId);
            bool hasPriorAction = false;
            foreach (StackItem item in actions)
            {
                Array action = RequireActionArray(item);
                if (hasPriorAction) SaveControl(engine, accountId, control);
                await ApplyModuleActionAsync(engine, accountId, control, action, governed: true);
                hasPriorAction = true;
            }
            RequireFinalOperationRoute(engine, accountId, control);
            if (restricted)
            {
                // The restricted landing must leave a usable, governable account: a composition without any
                // governance-capable validator would lock every future configuration out. It also must not consume a
                // second configuration step: the reset already advanced epoch, nonce and control revision exactly once.
                RequireGovernanceInstalled(engine.SnapshotCache, accountId);
                SaveControl(engine, accountId, control);
                // Only the claim is consumed; the row stays because the engine checks it again when the script halts.
                Context(engine).CloseResetInitialization(accountId);
                return;
            }
            SettleConfiguration(engine, accountId, control);
        }

        /// <summary> End-of-execution check, called by <see cref="ApplicationEngine.Execute()"/> when a run halts (spec §12).
        /// The reset is designed as one transaction: the seat resets and lands the new composition through the restricted
        /// initialization of the same engine. Every configuration entry of a later transaction needs the governance caller,
        /// so a transaction that ends on a reset without a code-bound governance validator would leave an account that
        /// can never be configured again. Such a transaction faults as a whole, exactly like a landing that fails inside
        /// it. The engine-local record of the resets is read here, so a validator that a later call of the same
        /// transaction removed is caught as well; nothing is persisted. </summary>
        internal void AssertResetsLanded(ApplicationEngine engine)
        {
            if (engine.GetState<SmartAccountInvocationContext>() is not { } context) return;
            foreach (UInt160 accountId in context.ResetAccounts)
                RequireGovernanceInstalled(engine.SnapshotCache, accountId);
        }

        /// <summary>A recovered composition is usable only when at least one installed validator retains the
        /// governance capability and its code binding is still intact.</summary>
        private void RequireGovernanceInstalled(IReadOnlyStore snapshot, UInt160 accountId)
        {
            foreach (var (_, module) in EnumerateValidatorModules(snapshot, accountId))
            {
                if (!module.Governance) continue;
                AssertModuleCodeBinding(snapshot, module);
                return;
            }
            throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorUnauthorized);
        }

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void RevokeModuleCredentials(ApplicationEngine engine, UInt160 accountId, BigInteger moduleId)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            _ = RequireActive(control);
            // Emergency revocation stays immediate and callback-free (spec §4): the custody witness may always
            // revoke, and the bound governance instance may revoke as part of its module authority. Any other
            // validator witness is no longer an administration principal.
            Require(Witness(engine, control.Custody) || TryRequireGovernanceCaller(engine, accountId),
                SmartAccountModuleProtocol.ErrorUnauthorized);
            ModuleInstance module = RequireModuleInstance(engine.SnapshotCache, accountId, moduleId);
            Require(module.IsValidator, SmartAccountModuleProtocol.ErrorModuleTypeUnsupported);
            Require(module.CredentialGeneration != ulong.MaxValue, SmartAccountModuleProtocol.ErrorCredentialStale);
            module.CredentialGeneration++;
            SaveModuleInstance(engine, accountId, moduleId, module);
            control.Advance();
            SaveControl(engine, accountId, control);
            Notify(engine, SmartAccountModuleProtocol.EventNameModuleCredentialsRevoked, accountId.ToArray(),
                moduleId, new BigInteger(module.CredentialGeneration));
        }

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void ResetAccount(ApplicationEngine engine, UInt160 accountId, UInt160 newCustody)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            if (control.Status != SmartAccountStatus.Frozen) _ = RequireActive(control);
            RequireRecoverySeat(engine, accountId);
            if (newCustody != UInt160.Zero) RequireAuthorityAddress(engine, newCustody);
            // Reduced reset (spec §12): the seat may land one reset per account in this engine, and the account it
            // resets has to keep a governance validator until the engine halts (AssertResetsLanded). Custody and governance
            // never reset through this path, and the landing advances the epoch exactly once below.
            UInt160 seat = engine.CallingScriptHash ?? UInt160.Zero;
            Require(!Context(engine).HasResetInitialization(accountId), SmartAccountModuleProtocol.ErrorPhaseViolation);
            List<(BigInteger Id, ModuleInstance Module)> instances = new();
            foreach (int type in new[]
                     {
                         SmartAccountModuleProtocol.ModuleTypeCodeValidator,
                         SmartAccountModuleProtocol.ModuleTypeCodeHook,
                         SmartAccountModuleProtocol.ModuleTypeCodeRecovery, })
            {
                foreach (BigInteger id in EnumerateModuleIds(engine.SnapshotCache, accountId, type,
                             BigInteger.Zero, int.MaxValue))
                {
                    ModuleInstance? module = TryModuleInstance(engine.SnapshotCache, accountId, id);
                    if (module is not null) instances.Add((id, module));
                }
            }
            foreach (var (id, _) in instances)
            {
                ModuleInstance module = RequireModuleInstance(engine.SnapshotCache, accountId, id);
                DeleteModuleInstance(engine, accountId, id, module);
                Notify(engine, SmartAccountModuleProtocol.EventNameModuleInstanceRemoved, accountId.ToArray(), id);
            }
            DeleteAccountPrefix(engine, SmartAccountModuleProtocol.PrefixNonceCursor, accountId);
            DeleteAccountPrefix(engine, SmartAccountModuleProtocol.PrefixNonceNamespace, accountId);
            if (newCustody != UInt160.Zero) control.Custody = newCustody;
            control.RequiredValidatorId = 0;
            control.DefaultOperationAuthorization = true;
            control.DefaultMessageAuthorization = true;
            control.Status = SmartAccountStatus.Active;
            control.AdvanceAuthority();
            SaveControl(engine, accountId, control);
            // The reset advanced epoch, configuration nonce and control revision exactly once. The same seat may now
            // restore one install-only composition in this engine; nothing else can use that claim. The row this adds
            // outlives the claim: it is the record the engine reads at the end of the script.
            Context(engine).OpenResetInitialization(accountId, seat, control.AuthorityEpoch);
            Notify(engine, SmartAccountModuleProtocol.EventNameAccountReset, accountId.ToArray(),
                control.Custody.ToArray(), new BigInteger(control.AuthorityEpoch));
        }

        private void RequireRecoverySeat(ApplicationEngine engine, UInt160 accountId)
        {
            foreach (var (_, module) in EnumerateModulesOfType(engine.SnapshotCache, accountId,
                         SmartAccountModuleProtocol.ModuleTypeCodeRecovery,
                         SmartAccountModuleProtocol.MaxRecoveryModuleInstances))
            {
                if (engine.CallingScriptHash != module.ContractHash) continue;
                AssertModuleCodeBinding(engine.SnapshotCache, module);
                return;
            }
            throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorUnauthorized);
        }

        private void DeleteAccountPrefix(ApplicationEngine engine, byte prefix, UInt160 accountId)
        {
            foreach (var (key, _) in engine.SnapshotCache.Find(Key(prefix).Add(accountId)).ToArray())
                engine.SnapshotCache.Delete(key);
        }

        // ======================================================================== 6. Module callbacks
        // ========================================================================

        private void AssertCodeBindingsAtCommit(IReadOnlyStore snapshot, UInt160 accountId,
            BigInteger validatorId, ValidationOutcome outcome)
        {
            if (outcome.Module is not null)
                AssertInstalledModuleBinding(snapshot, accountId, validatorId, outcome.Module);
            if (outcome.Planner is not null)
                AssertInstalledModuleBinding(snapshot, accountId, outcome.PlannerId, outcome.Planner);
            for (int i = 0; i < outcome.ApprovedIds.Length; i++)
                AssertInstalledModuleBinding(snapshot, accountId, outcome.ApprovedIds[i],
                    outcome.ApprovedModules[i]);
            for (int i = 0; i < outcome.HookIds.Length; i++)
            {
                ModuleInstance hook = RequireModuleInstance(snapshot, accountId, outcome.HookIds[i]);
                Require(hook.IsHook, SmartAccountModuleProtocol.ErrorModuleNotInstalled);
                AssertInstalledModuleBinding(snapshot, accountId, outcome.HookIds[i], hook);
            }
        }

        private void AssertInstalledModuleBinding(IReadOnlyStore snapshot, UInt160 accountId,
            BigInteger moduleId, ModuleInstance expected)
        {
            ModuleInstance current = RequireModuleInstance(snapshot, accountId, moduleId);
            Require(current.ContractHash == expected.ContractHash
                && current.ContractId == expected.ContractId
                && current.UpdateCounter == expected.UpdateCounter
                && current.NefSha256.AsSpan().SequenceEqual(expected.NefSha256)
                && current.ProfileSha256.AsSpan().SequenceEqual(expected.ProfileSha256)
                && current.CredentialGeneration == expected.CredentialGeneration,
                SmartAccountModuleProtocol.ErrorModuleCodeBindingMismatch);
            AssertModuleCodeBinding(snapshot, current);
        }

        private static void AssertModuleCodeBinding(IReadOnlyStore snapshot, ModuleInstance module) =>
            SmartAccountModulePolicy.AssertCodeBinding(
                NativeContract.ContractManagement.GetContract(snapshot, module.ContractHash), module);

        private async ContractTask<StackItem> CallModuleAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, string method, SmartAccountCallbackPhase phase,
            CallFlags flags, StackItem[] arguments)
        {
            AssertModuleCodeBinding(engine.SnapshotCache, module);
            SmartAccountInvocationContext context = Context(engine);
            // A callback runs inside the declared system fee of the transaction. One that overspends faults the engine
            // and the platform rolls the whole transaction back, so the loss is bounded by that fee and no per-call
            // limit is needed.
            var task = engine.CallFromNativeContractRawAsync(SmartAccountProtocol.ServiceHash, module.ContractHash,
                method, flags, arguments);
            var anchor = engine.CurrentContext!.GetState<ExecutionContextState>();
            var suspended = context.EnterCallback(accountId, moduleId, module.ContractHash, phase, anchor);
            try
            {
                StackItem result = (await task)!;
                // The instance's code identity is re-asserted as soon as its callback returns, and again before the commit.
                AssertModuleCodeBinding(engine.SnapshotCache, module);
                return result;
            }
            finally
            {
                context.ExitCallback(suspended);
            }
        }

        private async ContractTask CallModuleLifecycleAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, string callback, Array data)
        {
            _ = await CallModuleAsync(engine, accountId, moduleId, module, callback,
                SmartAccountCallbackPhase.Configuration, CallFlags.All, new StackItem[]
                {
                    accountId.ToArray(), moduleId, new BigInteger(module.ModuleType), data, });
        }

        private async ContractTask<bool> CallValidatorValidateUserOpAsync(ApplicationEngine engine,
            UInt160 accountId, BigInteger moduleId, ModuleInstance module, byte[] operationBytes,
            ReadOnlyMemory<byte> operationDigest, SmartAccountCallbackPhase phase)
        {
            StackItem reply = (await CallModuleAsync(engine, accountId, moduleId, module, "validateUserOp",
                phase, CallFlags.ReadOnly, new StackItem[]
                {
                    accountId.ToArray(), operationDigest.ToArray(), BuildCanonicalOperationView(operationBytes, engine),
                }))!;
            if (reply is not Boolean approved)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorCallbackReturnType);
            return approved.GetBoolean();
        }

        private async ContractTask<StackItem> CallHookPlannerAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, byte[] operationBytes, ReadOnlyMemory<byte> operationDigest)
        {
            return (await CallModuleAsync(engine, accountId, moduleId, module, "planHooks",
                SmartAccountCallbackPhase.HookPlanning, CallFlags.ReadOnly, new StackItem[]
                {
                    accountId.ToArray(), operationDigest.ToArray(), BuildCanonicalOperationView(operationBytes, engine),
                }))!;
        }

        private async ContractTask<byte[]> CallHookPreCheckAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, byte[] operationBytes)
        {
            StackItem reply = (await CallModuleAsync(engine, accountId, moduleId, module, "preCheck",
                SmartAccountCallbackPhase.HookPre, CallFlags.All,
                new StackItem[] { accountId.ToArray(), BuildCanonicalOperationView(operationBytes, engine) }))!;
            if (reply is Null) return [];
            if (reply is not ByteString hookData)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorCallbackReturnType);
            if (hookData.Size > SmartAccountModuleProtocol.HookDataBytesMax)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorHookDataTooLarge);
            return hookData.GetSpan().ToArray();
        }

        private async ContractTask CallHookPostCheckAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, byte[] operationBytes, StackItem result, byte[] hookData)
        {
            await CallModuleAsync(engine, accountId, moduleId, module, "postCheck",
                SmartAccountCallbackPhase.HookPost, CallFlags.All, new StackItem[]
                {
                    accountId.ToArray(), BuildCanonicalOperationView(operationBytes, engine),
                    result.DeepCopy(), hookData, });
        }

        private async ContractTask CallValidatorCompletionAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, byte[] operationBytes, StackItem result)
        {
            await CallModuleAsync(engine, accountId, moduleId, module, "onUserOpComplete",
                SmartAccountCallbackPhase.Completion, CallFlags.All, new StackItem[]
                {
                    accountId.ToArray(), BuildCanonicalOperationView(operationBytes, engine), result.DeepCopy(),
                });
        }

        /// <summary>Every callback receives its own bounded decode of the one validated signed encoding, so no mutable tree is
        /// shared between frames. The CPU fee the decode charges is not waived for the native frame.</summary>
        private static Array BuildCanonicalOperationView(byte[] encoded, ApplicationEngine engine)
        {
            engine.AddNativeCpuFee(1 << 12);
            MemoryReader reader = new(encoded);
            return (Array)BinarySerializer.Deserialize(ref reader, SmartAccountModuleProtocol.OperationEncodedSizeMax,
                SmartAccountModuleProtocol.OperationEncodedItemsMax);
        }

        // ======================================================================== 7. Read-only module queries
        // ========================================================================

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private Array GetModules(ApplicationEngine engine, UInt160 accountId, string moduleType, BigInteger cursor,
            BigInteger limit)
        {
            RequireAccountId(accountId);
            int typeCode = ModuleTypeCodeFromName(moduleType);
            Array page = EnumerateModulePage(engine.SnapshotCache, accountId, typeCode, cursor, limit);
            AccountControl? control = TryControl(engine.SnapshotCache, accountId);
            return new Array(new StackItem[]
            {
                page[0], page[1], control is null ? BigInteger.Zero : new BigInteger(control.ConfigurationNonce), });
        }

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private Array GetModule(ApplicationEngine engine, UInt160 accountId, BigInteger moduleId)
        {
            RequireAccountId(accountId);
            ModuleInstance? module = TryModuleInstance(engine.SnapshotCache, accountId, moduleId);
            if (module is null) return new Array();
            return new Array(new StackItem[]
            {
                SmartAccountModuleProtocol.UInt64ToBigEndian(SmartAccountProtocol.UInt64(moduleId)),
                new BigInteger(module.ModuleType),
                module.ContractHash.ToArray(), new BigInteger(module.ContractId),
                new BigInteger(module.UpdateCounter), module.NefSha256, module.ProfileSha256,
                new BigInteger(module.ModuleRevision), new BigInteger(module.CredentialGeneration),
                module.InstanceIsolation, module.MessageCapability, module.ThresholdMemberEligible,
                module.CompositeLayer, module.Governance, module.HookPlanner, });
        }

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private bool IsModuleInstalled(ApplicationEngine engine, UInt160 accountId, string moduleType,
            UInt160 moduleHash, byte[] additionalContext)
        {
            RequireAccountId(accountId);
            // additionalContext is a parameter of the frozen v4.1 ABI that the IDL declares as accepted and
            // ignored: the answer comes from the installed instances of the type, so it is not read here.
            if (moduleHash is null || moduleHash == UInt160.Zero) return false;
            int typeCode = ModuleTypeCodeFromName(moduleType);
            return FindModuleIdByContract(engine.SnapshotCache, accountId, typeCode, moduleHash) != BigInteger.Zero;
        }

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private BigInteger GetAuthorizedModuleId(ApplicationEngine engine, UInt160 accountId, int phase)
        {
            RequireAccountId(accountId);
            if (phase < 1 || phase > (int)SmartAccountCallbackPhase.HookPlanning) return BigInteger.MinusOne;
            SmartAccountInvocationContext context = Context(engine);
            if (!context.IsModuleAuthorized(engine, accountId, (SmartAccountCallbackPhase)phase))
                return BigInteger.MinusOne;
            return context.CallbackModuleId;
        }

        private static int ModuleTypeCodeFromName(string moduleType) => moduleType switch
        {
            "validator" => SmartAccountModuleProtocol.ModuleTypeCodeValidator,
            "hook" => SmartAccountModuleProtocol.ModuleTypeCodeHook,
            "recovery" => SmartAccountModuleProtocol.ModuleTypeCodeRecovery,
            _ => throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorModuleTypeUnsupported),
        };
    }
}
