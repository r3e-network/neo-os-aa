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
    /// Module registry of the native core (spec §3/§5/§9): the 0x52 instance
    /// records, the 0x53 enumeration index, the install/remove transition, the
    /// atomic registration actions, every budgeted module callback and the
    /// restricted landing entries of the module decisions (spec §7.1/§12.5).
    ///
    /// The core installs validator, hook and recovery-seat instances. Hook
    /// orchestration, threshold policies and composite layering stay
    /// user-space module concerns: they are not declared, stored or executed
    /// here; the core only lands their already-authorized state changes.
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
        // 2. Install / remove transition (spec §7.1)
        //    Both paths share one implementation: atomic registration actions and
        //    the two public entrypoints must produce byte-identical state.
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

        /// <summary>
        /// A v4 install type code. Only validator (1), hook (4) and recovery (5)
        /// exist; every other value — including the retired display alias 2 —
        /// is refused.
        /// </summary>
        private static int RequireModuleTypeCode(BigInteger moduleType)
        {
            if (moduleType == SmartAccountModuleProtocol.ModuleTypeCodeValidator)
                return SmartAccountModuleProtocol.ModuleTypeCodeValidator;
            if (moduleType == SmartAccountModuleProtocol.ModuleTypeCodeHook)
                return SmartAccountModuleProtocol.ModuleTypeCodeHook;
            if (moduleType == SmartAccountModuleProtocol.ModuleTypeCodeRecovery)
                return SmartAccountModuleProtocol.ModuleTypeCodeRecovery;
            throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorModuleTypeUnsupported);
        }

        private async ContractTask<BigInteger> InstallModuleCoreAsync(ApplicationEngine engine, UInt160 accountId,
            AccountControl control, int moduleType, UInt160 contractHash, ReadOnlyMemory<byte>? declaredProfileDigest,
            Array initData)
        {
            Require(moduleType is SmartAccountModuleProtocol.ModuleTypeCodeValidator
                or SmartAccountModuleProtocol.ModuleTypeCodeHook
                or SmartAccountModuleProtocol.ModuleTypeCodeRecovery,
                SmartAccountModuleProtocol.ErrorModuleTypeUnsupported);
            Require(initData.Count <= SmartAccountModuleProtocol.ArgsCountMax,
                SmartAccountModuleProtocol.ErrorOperationMalformed);

            int existingCount = CountModulesOfType(engine.SnapshotCache, accountId, moduleType);
            Require(existingCount < MaxModuleInstancesOfType(moduleType), ModuleLimitErrorOfType(moduleType));

            SmartAccountModulePolicy.RequireModuleContractAddress(engine.SnapshotCache, contractHash);
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

            BigInteger moduleId = control.AllocateModuleId();
            SaveModuleInstance(engine, accountId, moduleId, module);
            if (module.IsHook) control.HookOrderRevision = checked(control.HookOrderRevision + 1);
            // R-07-14: installing a module never rewrites the built-in
            // authorization switches. The first validator no longer implicitly
            // closes the built-in custody route — closing it is an explicit
            // setBuiltinAuthorization call, which is itself refused while no
            // validator instance is installed to remain as the routing subject
            // (R-08-08: no account may lose every route, and there is no
            // automatic custody fallback once the switch is closed).

            await CallModuleLifecycleAsync(engine, accountId, moduleId, module, "onInstall", initData);
            Notify(engine, SmartAccountModuleProtocol.EventNameModuleInstanceInstalled, accountId.ToArray(),
                moduleId, new BigInteger(module.ModuleType), contractHash.ToArray(), new BigInteger(module.CredentialGeneration));
            Notify(engine, "ModuleInstalled", accountId.ToArray(),
                SmartAccountModulePolicy.SmartAccountModuleTypeName(module.ModuleType), contractHash.ToArray());
            return moduleId;
        }

        private async ContractTask RemoveModuleCoreAsync(ApplicationEngine engine, UInt160 accountId,
            AccountControl control, BigInteger moduleId, Array deInitData)
        {
            Require(deInitData.Count <= SmartAccountModuleProtocol.ArgsCountMax,
                SmartAccountModuleProtocol.ErrorOperationMalformed);
            ModuleInstance module = RequireModuleInstance(engine.SnapshotCache, accountId, moduleId);

            // Callback first, while the instance is still installed and its
            // phase authorization is meaningful; a fault reverts the removal.
            await CallModuleLifecycleAsync(engine, accountId, moduleId, module, "onUninstall", deInitData);
            DeleteModuleInstance(engine, accountId, moduleId, module);
            if (module.IsHook) control.HookOrderRevision = checked(control.HookOrderRevision + 1);
            // R-08-08/R-11-12: removing a validator never rewrites the
            // built-in switches (R-07-14). An account whose operation switch
            // was closed explicitly keeps it closed here — but the custody can
            // re-open it through setBuiltinAuthorization at any time, so an
            // account that uninstalls down to zero validators is never
            // stranded; there is only no AUTOMATIC custody fallback.

            Notify(engine, SmartAccountModuleProtocol.EventNameModuleInstanceRemoved, accountId.ToArray(), moduleId);
            Notify(engine, "ModuleRemoved", accountId.ToArray(),
                SmartAccountModulePolicy.SmartAccountModuleTypeName(module.ModuleType),
                module.ContractHash.ToArray());
        }

        // ========================================================================
        // 3. Atomic registration actions (spec §10 exception list)
        //    Only the two module-model actions the minimal core still executes.
        // ========================================================================

        private async ContractTask ExecuteRegistrationActionsAsync(ApplicationEngine engine, UInt160 accountId,
            AccountControl control, Array actions)
        {
            foreach (StackItem item in actions)
            {
                Array action = RequireActionArray(item);
                switch (ActionCode(action))
                {
                    case SmartAccountModuleProtocol.ActionInstallModule:
                        // [ActionInstallModule, moduleType, moduleContractHash, profileDigest, initData[]]
                        Require(action.Count == 5, SmartAccountModuleProtocol.ErrorOperationMalformed);
                        await InstallModuleCoreAsync(engine, accountId, control,
                            RequireModuleTypeCode(SmartAccountRecordCodec.Unsigned(action[1])),
                            SmartAccountRecordCodec.Address(action[2]),
                            SmartAccountRecordCodec.Fixed(action[3], 32),
                            RequireActionArray(action[4]));
                        break;
                    case SmartAccountModuleProtocol.ActionUninstallModule:
                        // [ActionUninstallModule, moduleId, deInitData[]]
                        Require(action.Count == 3, SmartAccountModuleProtocol.ErrorOperationMalformed);
                        await RemoveModuleCoreAsync(engine, accountId, control,
                            SmartAccountRecordCodec.Unsigned(action[1]), RequireActionArray(action[2]));
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

        private static void ValidateActionShape(StackItem item)
        {
            try
            {
                ValidateActionShapeCore(RequireActionArray(item));
            }
            catch
            {
                // Shape failures map uniformly to SA_OPERATION_MALFORMED; the
                // executors re-validate precisely.
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            }
        }

        private static void ValidateActionShapeCore(Array action)
        {
            Require(action.Count >= 1, SmartAccountModuleProtocol.ErrorOperationMalformed);
            switch (ActionCode(action))
            {
                case SmartAccountModuleProtocol.ActionInstallModule:
                    // [ActionInstallModule, moduleType, contractHash, profileDigest, initData[]]
                    Require(action.Count == 5, SmartAccountModuleProtocol.ErrorOperationMalformed);
                    BigInteger installType = SmartAccountRecordCodec.Unsigned(action[1]);
                    Require(installType == SmartAccountModuleProtocol.ModuleTypeCodeValidator
                        || installType == SmartAccountModuleProtocol.ModuleTypeCodeHook
                        || installType == SmartAccountModuleProtocol.ModuleTypeCodeRecovery,
                        SmartAccountModuleProtocol.ErrorModuleTypeUnsupported);
                    Require(SmartAccountRecordCodec.Address(action[2]) != UInt160.Zero,
                        SmartAccountModuleProtocol.ErrorOperationMalformed);
                    Require(RequireActionArray(action[4]).Count <= SmartAccountModuleProtocol.ArgsCountMax,
                        SmartAccountModuleProtocol.ErrorOperationMalformed);
                    break;
                case SmartAccountModuleProtocol.ActionUninstallModule:
                    Require(action.Count == 3, SmartAccountModuleProtocol.ErrorOperationMalformed);
                    Require(SmartAccountRecordCodec.Unsigned(action[1]) >= 1,
                        SmartAccountModuleProtocol.ErrorModuleIdInvalid);
                    Require(RequireActionArray(action[2]).Count <= SmartAccountModuleProtocol.ArgsCountMax,
                        SmartAccountModuleProtocol.ErrorOperationMalformed);
                    break;
                default:
                    throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorOperationMalformed);
            }
        }

        // ========================================================================
        // 4. Public module administration (spec §7.1)
        //    Authorized by the custody witness OR by the witness of an already
        //    installed validator instance — the governance shape a user-space
        //    governance module uses to administer itself (R-07-11).
        // ========================================================================

        /// <summary>
        /// <c>installModule(accountId, moduleType, contractHash, initData)</c>.
        /// <paramref name="moduleType"/> is the v4 install code — validator (1)
        /// or hook (4). The core reads the module's own profile, so the public
        /// entry declares no digest; a registration action carries one and the
        /// shared core compares it.
        /// </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask<BigInteger> InstallModule(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleType, UInt160 moduleContractHash, Array initData)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            _ = RequireActive(control);
            AssertAccountIdle(engine, accountId);
            RequireModuleAdministration(engine, accountId, control);

            BigInteger moduleId = await InstallModuleCoreAsync(engine, accountId, control,
                RequireModuleTypeCode(moduleType), moduleContractHash, null, initData ?? new Array());
            control.Advance();
            SaveControl(engine, accountId, control);
            return moduleId;
        }

        /// <summary>
        /// <c>removeModule(accountId, moduleId, deInitData)</c> — the uninstall
        /// companion of <see cref="InstallModule"/>, with the same authority.
        /// </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask RemoveModule(ApplicationEngine engine, UInt160 accountId, BigInteger moduleId,
            Array deInitData)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            _ = RequireActive(control);
            AssertAccountIdle(engine, accountId);
            RequireModuleAdministration(engine, accountId, control);

            await RemoveModuleCoreAsync(engine, accountId, control, moduleId, deInitData ?? new Array());
            control.Advance();
            SaveControl(engine, accountId, control);
        }

        /// <summary>
        /// Administration authority of the module model: the custody witness or
        /// the witness of one installed module contract. The scan is bounded by
        /// the validator instance limit, so it can never be unbounded work.
        /// A witnessing instance must additionally still satisfy its recorded
        /// code binding (R-07-11: the authorized instance's code binding must be
        /// continuous) — the same check every execution callback replays — so a
        /// validator contract that has since been updated (NEF or UpdateCounter
        /// drift) loses its module-administration authority until it is
        /// re-bound.
        /// </summary>
        private void RequireModuleAdministration(ApplicationEngine engine, UInt160 accountId, AccountControl control)
        {
            if (Witness(engine, control.Custody)) return;
            foreach (BigInteger moduleId in EnumerateModuleIds(engine.SnapshotCache, accountId,
                         SmartAccountModuleProtocol.ModuleTypeCodeValidator, BigInteger.Zero,
                         SmartAccountModuleProtocol.MaxValidatorModuleInstances))
            {
                ModuleInstance? module = TryModuleInstance(engine.SnapshotCache, accountId, moduleId);
                if (module is not null && Witness(engine, module.ContractHash))
                {
                    AssertModuleCodeBinding(engine.SnapshotCache, module);
                    return;
                }
            }
            throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorUnauthorized);
        }

        // ========================================================================
        // 4b. Restricted landing entries (spec §7.1/§12.5, audit H-3/H-4)
        //     Core-owned state behind module decisions: the recovery-policy
        //     write, the built-in authorization switches, the credential-generation
        //     bump and the §12.5 account reset. They implement no policy — they
        //     land a decision a module (or the custody) already made, and
        //     re-verify authority inside the core.
        // ========================================================================

        /// <summary>
        /// <c>setRecoveryPolicy(accountId, recoveryAuthority, recoveryTimelockMs,
        /// ownerOnlyRecovery)</c> — the landing write of governance action 8
        /// (spec §11.5/§12.5). The governance module calls it once an intent has
        /// matured and been confirmed; the custody may call it directly on its
        /// own account. The authority domain is re-checked here because the
        /// core is the only writer of the 0x51 record.
        /// </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void SetRecoveryPolicy(ApplicationEngine engine, UInt160 accountId, UInt160 recoveryAuthority,
            BigInteger recoveryTimelockMs, bool ownerOnlyRecovery)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            _ = RequireActive(control);
            AssertAccountIdle(engine, accountId);
            RequireModuleAdministration(engine, accountId, control);

            Require(recoveryAuthority != UInt160.Zero && recoveryAuthority != control.Custody, SmartAccountModuleProtocol.ErrorOperationMalformed);
            Require(recoveryTimelockMs >= AccountControl.RecoveryTimelockMinMs
                && recoveryTimelockMs <= AccountControl.RecoveryTimelockMaxMs,
                SmartAccountModuleProtocol.ErrorOperationMalformed);

            RequireAuthorityAddress(engine, recoveryAuthority);
            if (recoveryAuthority != control.RecoveryAuthority)
                Require(Witness(engine, recoveryAuthority), SmartAccountModuleProtocol.ErrorUnauthorized);
            control.RecoveryAuthority = recoveryAuthority;
            control.RecoveryTimelockMs = (ulong)recoveryTimelockMs;
            control.OwnerOnlyRecovery = ownerOnlyRecovery;
            control.Advance();
            SaveControl(engine, accountId, control);
            Notify(engine, SmartAccountModuleProtocol.EventNameRecoveryPolicySet, accountId.ToArray(),
                recoveryAuthority.ToArray(), new BigInteger(control.RecoveryTimelockMs), ownerOnlyRecovery);
        }

        /// <summary>
        /// <c>setBuiltinAuthorization(accountId, defaultOperationAuthorization,
        /// defaultMessageAuthorization)</c> — the landing write of governance
        /// action 5 (spec §7.1/§7.5, R-07-14): both built-in authorization
        /// switches change ONLY here or through the §12.5 recovery reset;
        /// install/remove/revoke/recode/freeze never rewrite them implicitly.
        /// The state gate precedes the authority re-check, mirroring the other
        /// restricted landing entries; migration is answered with the generic
        /// account-status error because the account must be Active to reroute.
        /// </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void SetBuiltinAuthorization(ApplicationEngine engine, UInt160 accountId,
            bool defaultOperationAuthorization, bool defaultMessageAuthorization)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            Require(control.Status != SmartAccountStatus.Frozen,
                SmartAccountModuleProtocol.ErrorAccountFrozen);
            Require(control.Status == SmartAccountStatus.Active,
                SmartAccountModuleProtocol.ErrorAccountStatus);
            AssertAccountIdle(engine, accountId);
            RequireModuleAdministration(engine, accountId, control);

            // Last-route guard (R-07-14/R-08-08): closing the built-in operation
            // switch while no validator instance is installed would leave the
            // account without any routing subject — there is no automatic
            // custody fallback once the switch is closed. Closing the message
            // switch has no symmetric guard: the operation route, built-in or
            // validator, stays available.
            if (!defaultOperationAuthorization && CountModulesOfType(engine.SnapshotCache, accountId,
                    SmartAccountModuleProtocol.ModuleTypeCodeValidator) == 0)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorBuiltinRouteRequired);

            control.DefaultOperationAuthorization = defaultOperationAuthorization;
            control.DefaultMessageAuthorization = defaultMessageAuthorization;
            control.Advance();
            SaveControl(engine, accountId, control);
            Notify(engine, SmartAccountModuleProtocol.EventNameBuiltinAuthorizationSet, accountId.ToArray(),
                defaultOperationAuthorization, defaultMessageAuthorization);
        }

        /// <summary>
        /// <c>revokeModuleCredentials(accountId, moduleId)</c> — the landing
        /// write behind HookOrchestratorModule's <c>revokeCredentials</c> (spec
        /// §11.5/§14.2, R-11-13/R-14-11): bump one validator instance's
        /// credential generation and the account's configuration nonce in the
        /// same call frame. No callback, no delay. A hook or recovery seat has
        /// no routable credential and is refused by type.
        /// </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void RevokeModuleCredentials(ApplicationEngine engine, UInt160 accountId, BigInteger moduleId)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            _ = RequireActive(control);
            AssertAccountIdle(engine, accountId);
            RequireModuleAdministration(engine, accountId, control);

            ModuleInstance module = RequireModuleInstance(engine.SnapshotCache, accountId, moduleId);
            Require(module.IsValidator, SmartAccountModuleProtocol.ErrorModuleTypeUnsupported);
            if (module.CredentialGeneration == ulong.MaxValue)
                throw new InvalidOperationException("The credential generation is exhausted.");
            module.CredentialGeneration += 1;
            SaveModuleInstance(engine, accountId, moduleId, module);
            control.Advance();
            SaveControl(engine, accountId, control);
            Notify(engine, SmartAccountModuleProtocol.EventNameModuleCredentialsRevoked, accountId.ToArray(),
                moduleId, new BigInteger(module.CredentialGeneration));
        }

        /// <summary>
        /// <c>resetAccount(accountId, newCustody)</c> — the §12.5 core-side reset,
        /// called by the RecoveryModule's <c>executeRecovery</c> once its
        /// timelock has matured. The only caller the core accepts is the
        /// account's installed recovery seat (type 5, R-12-12): custody,
        /// validators and the governance module cannot reach this transition
        /// directly, so installing an ordinary hook can never become an
        /// instant custody rotation. The reset removes every module instance
        /// and nonce channel, rotates custody when a non-zero replacement is
        /// given (zero keeps the current one), restores the registration
        /// defaults and advances the authority epoch — atomically: any fault
        /// reverts the whole reset (R-12-08).
        /// </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void ResetAccount(ApplicationEngine engine, UInt160 accountId, UInt160 newCustody)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            if (control.Status != SmartAccountStatus.Frozen) _ = RequireActive(control);
            AssertAccountIdle(engine, accountId);
            // A recovery authority that was never configured names no recovery
            // to execute — the reset has no configuration to finish.
            Require(control.RecoveryAuthority != UInt160.Zero, SmartAccountModuleProtocol.ErrorAccountStatus);
            RequireRecoverySeat(engine, accountId);
            if (newCustody != UInt160.Zero) RequireAuthorityAddress(engine, newCustody);

            // Step 1 (§12.5): remove every module instance record and its 0x53
            // index — validators, hooks and the recovery seat itself. No
            // onUninstall is called (R-08-11/R-12-07); each removal is notified.
            List<(BigInteger Id, ModuleInstance Module)> instances = new();
            foreach (int type in new[]
                     {
                         SmartAccountModuleProtocol.ModuleTypeCodeValidator,
                         SmartAccountModuleProtocol.ModuleTypeCodeHook,
                         SmartAccountModuleProtocol.ModuleTypeCodeRecovery,
                     })
            {
                foreach (BigInteger id in EnumerateModuleIds(engine.SnapshotCache, accountId, type,
                             BigInteger.Zero, int.MaxValue))
                {
                    ModuleInstance? module = TryModuleInstance(engine.SnapshotCache, accountId, id);
                    if (module is not null) instances.Add((id, module));
                }
            }
            if (instances.Any(item => item.Module.IsHook)) control.HookOrderRevision = checked(control.HookOrderRevision + 1);
            foreach (var (id, module) in instances)
            {
                DeleteModuleInstance(engine, accountId, id, module);
                Notify(engine, SmartAccountModuleProtocol.EventNameModuleInstanceRemoved, accountId.ToArray(), id);
            }

            // Steps 2–3 (§12.5): every nonce cursor, every channel digest and
            // the migration state of the account. The core writes no 0x5A row
            // itself, but a legacy full-profile row may still sit there.
            DeleteAccountPrefix(engine, SmartAccountModuleProtocol.PrefixNonceCursor, accountId);
            DeleteAccountPrefix(engine, SmartAccountModuleProtocol.PrefixNonceNamespace, accountId);
            DeleteAccountPrefix(engine, SmartAccountModuleProtocol.PrefixMigrationState, accountId);

            // Steps 4–5 (§12.5): custody rotation (zero keeps the current
            // holder), registration defaults, epoch advance. The id allocator
            // is deliberately NOT reset (R-12-09).
            if (newCustody != UInt160.Zero) control.Custody = newCustody;
            control.RecoveryAuthority = UInt160.Zero;
            control.OwnerOnlyRecovery = false;
            control.DefaultOperationAuthorization = true;
            control.DefaultMessageAuthorization = true;
            control.Status = SmartAccountStatus.Active;
            control.AuthorityEpoch += 1;
            control.ConfigurationNonce += 1;
            control.ControlRevision += 1;
            SaveControl(engine, accountId, control);

            // Step 6 (§12.5).
            Notify(engine, SmartAccountModuleProtocol.EventNameAccountReset, accountId.ToArray(),
                control.Custody.ToArray(), new BigInteger(control.AuthorityEpoch));
        }

        /// <summary>
        /// The reset entry's exclusive witness (R-12-12): the caller must be the
        /// contract of the account's installed recovery seat, and that seat's
        /// code binding must still be continuous. Custody, validators and the
        /// governance module are all refused — the reset's proposal right
        /// belongs to the control subjects, its trigger right to the seat.
        /// </summary>
        private void RequireRecoverySeat(ApplicationEngine engine, UInt160 accountId)
        {
            foreach (BigInteger moduleId in EnumerateModuleIds(engine.SnapshotCache, accountId,
                         SmartAccountModuleProtocol.ModuleTypeCodeRecovery, BigInteger.Zero,
                         SmartAccountModuleProtocol.MaxRecoveryModuleInstances))
            {
                ModuleInstance? module = TryModuleInstance(engine.SnapshotCache, accountId, moduleId);
                if (module is not null && engine.CallingScriptHash == module.ContractHash)
                {
                    AssertModuleCodeBinding(engine.SnapshotCache, module);
                    return;
                }
            }
            throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorUnauthorized);
        }

        /// <summary>
        /// Deletes every core key under one prefix for one account (§12.5 steps
        /// 2–3). Keys are collected before deleting: a Find cursor over a store
        /// being mutated is not a stable iteration.
        /// </summary>
        private void DeleteAccountPrefix(ApplicationEngine engine, byte prefix, UInt160 accountId)
        {
            byte[] seek = SmartAccountProtocol.Concat(new[] { prefix }, accountId.ToArray());
            List<byte[]> found = new();
            foreach (var (key, _) in engine.SnapshotCache.Find(new StorageKey { Id = Id, Key = seek }))
            {
                if (!key.Key.Span.StartsWith(seek)) break;
                found.Add(key.Key.ToArray());
            }
            foreach (byte[] content in found) Delete(engine, content);
        }

        // ========================================================================
        // 5. Module callbacks (spec §9/§11)
        //    Every callback is addressed to a recorded 0x52 instance, runs under
        //    a phase grant for exactly that instance and is capped by its own
        //    hard per-call VM gas budget.
        // ========================================================================

        /// <summary>
        /// Opens the engine-local execution state if the caller did not already
        /// own one (a batch owns a single envelope-wide state).
        /// </summary>
        private static SmartAccountInvocationContext.AccountExecution EnsureExecution(ApplicationEngine engine,
            UInt160 accountId, out bool owned)
        {
            SmartAccountInvocationContext context = Context(engine);
            if (context.TryGetExecution(accountId, out SmartAccountInvocationContext.AccountExecution? existing))
            {
                owned = false;
                return existing;
            }
            context.OpenExecution(accountId);
            owned = true;
            return context.Execution(accountId);
        }

        /// <summary>
        /// Spec §7.3 "before commit": every instance that took part in this
        /// operation — the routing validator and every dispatched hook — must
        /// still resolve to the code pinned when it was dispatched. A target that
        /// updates or destroys a participating module faults the whole operation.
        /// </summary>
        private static void AssertCodeBindingsAtCommit(IReadOnlyStore snapshot, ValidationOutcome outcome)
        {
            if (outcome.Module is not null) AssertModuleCodeBinding(snapshot, outcome.Module);
        }

        private static void AssertModuleCodeBinding(IReadOnlyStore snapshot, ModuleInstance module) =>
            SmartAccountModulePolicy.AssertCodeBinding(
                NativeContract.ContractManagement.GetContract(snapshot, module.ContractHash), module);

        private async ContractTask<StackItem> CallModuleAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, string method, SmartAccountCallbackPhase phase,
            CallFlags flags, long budget, StackItem[] arguments)
        {
            SmartAccountModulePolicy.AssertCodeBinding(
                NativeContract.ContractManagement.GetContract(engine.SnapshotCache, module.ContractHash), module);
            SmartAccountInvocationContext context = Context(engine);
            // Fail before loading a child VM frame: a failed lease acquisition
            // must never leave an unawaited callback on the invocation stack.
            context.AssertModuleEntry(accountId, module.ContractHash, phase);
            _ = EnsureExecution(engine, accountId, out bool ownedExecution);
            try
            {
                bool isHook = phase is SmartAccountCallbackPhase.HookPre or SmartAccountCallbackPhase.HookPost;
                if (isHook)
                {
                    budget = Math.Min(budget, context.HookGasRemaining(accountId));
                    Require(budget > 0, SmartAccountModuleProtocol.ErrorGasBudgetExceeded);
                }
                long before = engine.GasLeft;
                try
                {
                    var task = engine.CallFromNativeContractWithGasLimitAsync(SmartAccountProtocol.ServiceHash,
                        module.ContractHash, method, flags, budget, arguments);
                    var anchor = engine.CurrentContext!.GetState<ExecutionContextState>();
                    StackItem result;
                    using (context.EnterModule(accountId, moduleId, module.ContractHash, phase, anchor))
                        result = (await task)!;
                    // Spec §7.3: the binding must still hold AFTER the callback. A
                    // callback that updates or destroys its own code (directly or
                    // through a nested module) faults the whole attempt here.
                    AssertModuleCodeBinding(engine.SnapshotCache, module);
                    if (before - engine.GasLeft > budget)
                        throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorGasBudgetExceeded);
                    return result;
                }
                finally
                {
                    // A callback that faults still consumed transaction GAS.
                    if (isHook) context.ChargeHook(accountId, before - engine.GasLeft);
                }
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
                SmartAccountModuleProtocol.LifecycleCallbackGasLimit,
                new StackItem[]
                {
                    // Table 10: onInstall/onUninstall(accountId, moduleId, moduleType, data).
                    accountId.ToArray(), moduleId, new BigInteger(module.ModuleType), data,
                });
        }

        /// <summary>
        /// Signature validation by the routed validator instance. Read-only and
        /// approval is exactly Boolean true (spec §9 ABI).
        /// </summary>
        private async ContractTask<bool> CallValidatorValidateUserOpAsync(ApplicationEngine engine,
            UInt160 accountId, BigInteger moduleId, ModuleInstance module, Array operation,
            ReadOnlyMemory<byte> operationDigest)
        {
            StackItem reply = (await CallModuleAsync(engine, accountId, moduleId, module, "validateUserOp",
                SmartAccountCallbackPhase.Validation, CallFlags.ReadOnly,
                SmartAccountModuleProtocol.ValidationPerCallGasLimit,
                new StackItem[]
                {
                    accountId.ToArray(), operationDigest.ToArray(), BuildCanonicalOperationView(operation, engine),
                }))!;
            if (reply is not Boolean approved)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorCallbackReturnType);
            return approved.GetBoolean();
        }

        private async ContractTask<byte[]> CallHookPreCheckAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, Array operation)
        {
            StackItem reply = (await CallModuleAsync(engine, accountId, moduleId, module, "preCheck",
                SmartAccountCallbackPhase.HookPre, CallFlags.All,
                SmartAccountModuleProtocol.HookCallbackGasLimit,
                new StackItem[] { accountId.ToArray(), BuildCanonicalOperationView(operation, engine) }))!;
            if (reply is Null) return [];
            if (reply is not ByteString hookData)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorCallbackReturnType);
            if (hookData.Size > SmartAccountModuleProtocol.HookDataBytesMax)
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorHookDataTooLarge);
            return hookData.GetSpan().ToArray();
        }

        private async ContractTask CallHookPostCheckAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, Array operation, StackItem result, byte[] hookData)
        {
            await CallModuleAsync(engine, accountId, moduleId, module, "postCheck",
                SmartAccountCallbackPhase.HookPost, CallFlags.All,
                SmartAccountModuleProtocol.HookCallbackGasLimit,
                new StackItem[]
                {
                    accountId.ToArray(), BuildCanonicalOperationView(operation, engine),
                    CloneValue(engine, result), hookData,
                });
        }

        private async ContractTask CallValidatorCompletionAsync(ApplicationEngine engine, UInt160 accountId,
            BigInteger moduleId, ModuleInstance module, Array operation, StackItem result)
        {
            await CallModuleAsync(engine, accountId, moduleId, module, "onUserOpComplete",
                SmartAccountCallbackPhase.Completion, CallFlags.All,
                SmartAccountModuleProtocol.CompletionPerCallGasLimit,
                new StackItem[]
                {
                    accountId.ToArray(), BuildCanonicalOperationView(operation, engine), CloneValue(engine, result),
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
        // 6. Read-only module queries (spec §3.3)
        // ========================================================================

        /// <summary>Page of installed moduleIds: [ids[], nextCursor, configurationNonce].</summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
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
        /// The two capability slots are retained for ABI stability and are
        /// always false: the native core does not negotiate them.
        /// </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
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

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private bool IsModuleInstalled(IReadOnlyStore snapshot, UInt160 accountId, string moduleType,
            UInt160 moduleHash, byte[] additionalContext)
        {
            RequireAccountId(accountId);
            _ = additionalContext;
            if (moduleHash is null || moduleHash == UInt160.Zero) return false;
            int typeCode = ModuleTypeCodeFromName(moduleType);
            return FindModuleIdByContract(snapshot, accountId, typeCode, moduleHash) != BigInteger.Zero;
        }

        /// <summary>
        /// Phase-exact module authorization: the authorized moduleId while the
        /// caller IS the contract of the instance the recorded phase addresses,
        /// or -1. A module calls this from inside a callback to authenticate the
        /// core and learn which of its instances is being addressed.
        /// </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
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
            "recovery" => SmartAccountModuleProtocol.ModuleTypeCodeRecovery,
            _ => throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorModuleTypeUnsupported),
        };
    }
}
