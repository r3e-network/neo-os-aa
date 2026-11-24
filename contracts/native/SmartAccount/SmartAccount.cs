// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccount.cs file belongs to the neo project and is free
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
using Neo.Json;
using Neo.Persistence;
using Neo.SmartContract.Manifest;
using Neo.VM.Types;
using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Numerics;
using Array = Neo.VM.Types.Array;
using Boolean = Neo.VM.Types.Boolean;

namespace Neo.SmartContract.Native
{
    /// <summary>
    /// Hardfork-gated native SmartAccount service implementing the SA module
    /// protocol v4 (docs/SA-MODULE-PROTOCOL.md). The exported method names,
    /// argument positions and return layouts are the protocol surface; only the
    /// execution substrate (native storage and the engine-local invocation
    /// context) is specific to this build.
    /// </summary>
    public sealed partial class SmartAccount : NativeContract
    {
        private const long BaseCpuFee = 1 << 15;

        /// <summary>
        /// sha256("NeoSmartAccount/Profile" ‖ 0x04 ‖ canonical v4 parameter
        /// JSON), pinned in docs/proposals/smartaccount-native-profile-parameters.json.
        /// </summary>
        internal const string ParameterDigest = "0cab62cf2a69b5682bf0d976406ddce15d7afbd67db4c1bc4e4950cf180a6dd0";

        /// <summary>Reverse index of registered native proxy addresses.</summary>
        private const byte ProxyPrefix = 0x11;

        internal const string AccountImplementationId = "NativeSmartAccount";

        public override ImmutableHashSet<Hardfork?> Activations => [Hardfork.HF_SmartAccountV1];

        [ContractEvent(Hardfork.HF_SmartAccountV1, 0, "AccountRegistered", "accountId", ContractParameterType.Hash160, "custody", ContractParameterType.Hash160)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 1, "ModuleInstalled", "accountId", ContractParameterType.Hash160, "moduleType", ContractParameterType.String, "moduleHash", ContractParameterType.Hash160)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 2, "ModuleRemoved", "accountId", ContractParameterType.Hash160, "moduleType", ContractParameterType.String, "moduleHash", ContractParameterType.Hash160)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 3, "UserOpExecuted", "accountId", ContractParameterType.Hash160, "targetContract", ContractParameterType.Hash160, "method", ContractParameterType.String, "nonce", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 4, "ModuleInstanceInstalled", "accountId", ContractParameterType.Hash160, "moduleId", ContractParameterType.Integer, "moduleType", ContractParameterType.Integer, "contractHash", ContractParameterType.Hash160, "credentialGeneration", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 5, "ModuleInstanceRemoved", "accountId", ContractParameterType.Hash160, "moduleId", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 6, "NonceChannelOpened", "accountId", ContractParameterType.Hash160, "channelDigest", ContractParameterType.ByteArray)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 7, "NonceChannelExhausted", "accountId", ContractParameterType.Hash160, "channelDigest", ContractParameterType.ByteArray)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 8, "AccountFrozen", "accountId", ContractParameterType.Hash160, "authorityEpoch", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 9, "AccountUnfrozen", "accountId", ContractParameterType.Hash160, "authorityEpoch", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 10, "ModuleCredentialsRevoked", "accountId", ContractParameterType.Hash160, "moduleId", ContractParameterType.Integer, "credentialGeneration", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 11, "RecoveryPolicySet", "accountId", ContractParameterType.Hash160, "recoveryAuthority", ContractParameterType.Hash160, "recoveryTimelockMs", ContractParameterType.Integer, "ownerOnlyRecovery", ContractParameterType.Boolean)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 12, "AccountReset", "accountId", ContractParameterType.Hash160, "custody", ContractParameterType.Hash160, "authorityEpoch", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 13, "BuiltinAuthorizationSet", "accountId", ContractParameterType.Hash160, "defaultOperationAuthorization", ContractParameterType.Boolean, "defaultMessageAuthorization", ContractParameterType.Boolean)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 14, "ThresholdPolicySet", "accountId", ContractParameterType.Hash160, "policyId", ContractParameterType.Integer, "threshold", ContractParameterType.Integer, "memberIds", ContractParameterType.Array)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 15, "MessageSubjectUpdated", "accountId", ContractParameterType.Hash160, "subjectCount", ContractParameterType.Integer, "threshold", ContractParameterType.Integer, "subjectRevision", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 16, "ModuleInstanceConfigured", "accountId", ContractParameterType.Hash160, "moduleId", ContractParameterType.Integer, "credentialGeneration", ContractParameterType.Integer)]
        // Intent and message-signature lifecycle events are gone with their
        // features: those transitions are user-space module concerns and this
        // core can no longer reach them. The four landing-path events above
        // are different: the state they report is core-owned (0x51/0x52), so
        // only the core can emit them (spec §7.1/§12.5/§14.2, R-07-14).
        internal SmartAccount() { }

        protected override void OnManifestCompose(IsHardforkEnabledDelegate checker, uint height, ContractManifest manifest)
        {
            if (checker(Hardfork.HF_SmartAccountV1, height))
                manifest.Extra = new JObject { ["smartAccount"] = new JObject
                {
                    ["abiVersion"] = SmartAccountProtocol.Version,
                    ["profileParameterDigest"] = ParameterDigest
                } };
        }

        // ========================================================================
        // 1. Storage, time and notification helpers
        // ========================================================================

        private StorageKey Key(byte[] content) => new() { Id = Id, Key = content };

        private bool TryRead(IReadOnlyStore snapshot, byte[] content, out ReadOnlyMemory<byte> value)
        {
            if (snapshot.TryGet(Key(content), out StorageItem? item) && item is not null)
            {
                value = item.Value;
                return true;
            }
            value = default;
            return false;
        }

        private byte[] Read(IReadOnlyStore snapshot, byte[] content) =>
            TryRead(snapshot, content, out var value)
                ? value.ToArray()
                : throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorAccountNotFound);

        private void Write(ApplicationEngine engine, byte[] content, byte[] value) =>
            engine.Put(new StorageContext { Id = Id }, content, value);

        private void Delete(ApplicationEngine engine, byte[] content) =>
            engine.SnapshotCache.Delete(Key(content));

        private static ulong Now(ApplicationEngine engine) => engine.PersistingBlock?.Timestamp ??
            Ledger.GetHeader(engine.SnapshotCache, Ledger.CurrentHash(engine.SnapshotCache))?.Timestamp ??
            throw new InvalidOperationException("SmartAccount requires a known ledger timestamp.");

        private static void RequireApplication(ApplicationEngine engine)
        {
            if (engine.Trigger != TriggerType.Application)
                throw new InvalidOperationException("This SmartAccount method requires Application trigger.");
        }

        private static SmartAccountInvocationContext Context(ApplicationEngine engine)
        {
            var context = engine.GetState<SmartAccountInvocationContext>();
            if (context is null)
            {
                context = new SmartAccountInvocationContext();
                engine.SetState(context);
            }
            return context;
        }

        private void Notify(ApplicationEngine engine, string name, params StackItem[] fields) =>
            engine.SendNotification(Hash, name, new Array(fields));

        private static byte[] ProxyIndexKey(UInt160 address) =>
            SmartAccountProtocol.Concat(new[] { ProxyPrefix }, address.ToArray());

        private void RequireAuthorityAddress(ApplicationEngine engine, UInt160 address)
        {
            Require(!TryRead(engine.SnapshotCache, ProxyIndexKey(address), out _)
                && address != Hash, SmartAccountModuleProtocol.ErrorUnauthorized);
        }

        private static bool Witness(ApplicationEngine engine, UInt160 address) =>
            address != UInt160.Zero && engine.CheckWitnessInternal(address);

        private static void Require(bool condition, string error)
        {
            if (!condition) throw new InvalidOperationException(error);
        }

        private static void RequireAccountId(UInt160 accountId)
        {
            SmartAccountProtocol.RequireIdentity(accountId);
        }

        // ========================================================================
        // 2. Account control accessors
        // ========================================================================

        private AccountControl? TryControl(IReadOnlyStore snapshot, UInt160 accountId) =>
            TryRead(snapshot, SmartAccountProtocol.GetAccountControlKey(accountId), out var value)
                ? AccountControl.Decode(value)
                : null;

        private AccountControl RequireControl(IReadOnlyStore snapshot, UInt160 accountId) =>
            TryControl(snapshot, accountId) ?? throw new InvalidOperationException(
                SmartAccountModuleProtocol.ErrorAccountNotFound);

        private void SaveControl(ApplicationEngine engine, UInt160 accountId, AccountControl control) =>
            Write(engine, SmartAccountProtocol.GetAccountControlKey(accountId), control.Serialize());

        /// <summary>A configuration transition requires an idle account execution context.</summary>
        private static void AssertAccountIdle(ApplicationEngine engine, UInt160 accountId)
        {
            if (Context(engine).TryGetExecution(accountId, out _))
                throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorReentrancyForbidden);
        }

        private static void RequireCustody(ApplicationEngine engine, AccountControl control)
        {
            Require(Witness(engine, control.Custody), SmartAccountModuleProtocol.ErrorUnauthorized);
        }

        private static SmartAccountStatus RequireActive(AccountControl control)
        {
            switch (control.Status)
            {
                case SmartAccountStatus.Frozen:
                    throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorAccountFrozen);
                case SmartAccountStatus.Active:
                    return SmartAccountStatus.Active;
                default:
                    throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorAccountStatus);
            }
        }

        // ========================================================================
        // 3. Registration (spec §10 exception list: atomic initial install)
        // ========================================================================

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask CreateAccount(ApplicationEngine engine, UInt160 accountId, UInt160 custody,
            byte[] salt, BigInteger recoveryTimelockMs, Array actions)
        {
            await CreateAccountCoreAsync(engine, accountId, custody, salt, recoveryTimelockMs, actions);
        }

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask CreateAccounts(ApplicationEngine engine, UInt160[] accountIds, UInt160 custody,
            byte[][] salts, BigInteger recoveryTimelockMs)
        {
            RequireApplication(engine);
            if (accountIds is null || salts is null || accountIds.Length != salts.Length
                || accountIds.Length is 0 or > 64)
                throw new FormatException("The account batch requires 1..64 id/salt pairs.");
            for (int i = 0; i < accountIds.Length; i++)
                await CreateAccountCoreAsync(engine, accountIds[i], custody, salts[i], recoveryTimelockMs, new Array());
        }

        private async ContractTask CreateAccountCoreAsync(ApplicationEngine engine, UInt160 accountId,
            UInt160 custody, byte[] salt, BigInteger recoveryTimelockMs, Array actions)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            SmartAccountProtocol.RequireIdentity(custody);
            Require(salt is not null, SmartAccountModuleProtocol.ErrorOperationMalformed);
            RequireAuthorityAddress(engine, custody);
            Require(Witness(engine, custody), SmartAccountModuleProtocol.ErrorUnauthorized);

            using var locked = Context(engine).EnterAccount(accountId);
            Require(TryControl(engine.SnapshotCache, accountId) is null,
                SmartAccountModuleProtocol.ErrorOperationMalformed);
            Require(SmartAccountProtocol.GetAccountId(custody, salt) == accountId,
                SmartAccountModuleProtocol.ErrorOperationMalformed);
            AssertAccountIdle(engine, accountId);

            ulong timelock = (ulong)SmartAccountProtocol.UInt64(recoveryTimelockMs == 0
                ? new BigInteger(AccountControl.RecoveryTimelockMinMs)
                : recoveryTimelockMs);
            Require(timelock >= AccountControl.RecoveryTimelockMinMs
                && timelock <= AccountControl.RecoveryTimelockMaxMs,
                SmartAccountModuleProtocol.ErrorOperationMalformed);

            actions ??= new Array();
            Require(actions.Count <= SmartAccountModuleProtocol.MaxActionsPerRegistration,
                SmartAccountModuleProtocol.ErrorModuleLimitActions);
            foreach (StackItem action in actions)
                ValidateActionShape(action);

            UInt160 proxy = SmartAccountProtocol.GetAccountAddress(accountId);
            Require(proxy != custody && !TryRead(engine.SnapshotCache, ProxyIndexKey(proxy), out _),
                SmartAccountModuleProtocol.ErrorUnauthorized);
            Write(engine, ProxyIndexKey(proxy), accountId.ToArray());
            AccountControl control = AccountControl.Create(custody, timelock);
            SaveControl(engine, accountId, control);

            if (actions.Count > 0)
            {
                await ExecuteRegistrationActionsAsync(engine, accountId, control, actions);
                if (CountModulesOfType(engine.SnapshotCache, accountId,
                        SmartAccountModuleProtocol.ModuleTypeCodeValidator) == 0)
                    Require(control.DefaultOperationAuthorization, SmartAccountModuleProtocol.ErrorOperationMalformed);
                control.Advance();
                SaveControl(engine, accountId, control);
            }

            Notify(engine, "AccountRegistered", accountId.ToArray(), custody.ToArray());
        }

        // ========================================================================
        // 4. Freeze and unfreeze (spec §7.5/§10)
        // ========================================================================

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void FreezeAccount(ApplicationEngine engine, UInt160 accountId)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            Require(control.RequiredPolicyId == 0, SmartAccountModuleProtocol.ErrorUnauthorized);
            RequireCustody(engine, control);
            AssertAccountIdle(engine, accountId);
            _ = RequireActive(control);

            control.Status = SmartAccountStatus.Frozen;
            control.AdvanceAuthority();
            SaveControl(engine, accountId, control);
            Notify(engine, "AccountFrozen", accountId.ToArray(), new BigInteger(control.AuthorityEpoch));
        }

        /// <summary>
        /// Ends a freeze (spec §10). Authorized by the custody witness or by the
        /// witness of an already installed module contract — the governance shape
        /// a user-space governance module uses. The core holds no thaw timelock:
        /// delaying a thaw is the responsibility of the governance module that
        /// gated the call. The transition advances the authority epoch, the
        /// configuration nonce and the control revision, which kills every
        /// signature, configuration and nonce channel that predates the thaw.
        /// </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void UnfreezeAccount(ApplicationEngine engine, UInt160 accountId)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            AssertAccountIdle(engine, accountId);
            Require(control.Status == SmartAccountStatus.Frozen, SmartAccountModuleProtocol.ErrorAccountStatus);
            RequireModuleAdministration(engine, accountId, control);

            control.Status = SmartAccountStatus.Active;
            // §8: a thaw advances the authority epoch and the configuration
            // nonce, so every operation and configuration signed before the
            // freeze is stale — and it advances the control revision because
            // the control record changed. The core holds no thaw delay of its
            // own; a user-space governance module owns that policy.
            control.AdvanceAuthority();
            SaveControl(engine, accountId, control);
            Notify(engine, SmartAccountModuleProtocol.EventNameAccountUnfrozen, accountId.ToArray(),
                new BigInteger(control.AuthorityEpoch));
        }

        // ========================================================================
        // 5. Protocol and account queries (spec §3.3/§9)
        // ========================================================================

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.None)]
        private static string GetAccountImplementationId() => AccountImplementationId;

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.None)]
        private static Array GetProtocolInfo() => new Array([(int)SmartAccountProtocol.Version]);

        /// <summary>
        /// Aggregated account descriptor, non-faulting for unknown accounts.
        /// Layout: [exists, status, custody, recoveryAuthority, authorityEpoch,
        /// configurationNonce, recoveryTimelockMs, defaultOperationAuthorization,
        /// defaultMessageAuthorization, ownerOnlyRecovery, hookOrderRevision,
        /// controlRevision, recoveryPending, recoveryMatureAt,
        /// marketEscrowActive]. The recovery, message and hook slots
        /// are retained for ABI stability and report their inactive value: those
        /// transitions are user-space module concerns.
        /// </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private Array GetAccount(IReadOnlyStore snapshot, UInt160 accountId)
        {
            RequireAccountId(accountId);
            AccountControl? control = TryControl(snapshot, accountId);
            if (control is null)
                return new Array([false, (BigInteger)0, UInt160.Zero.ToArray(), UInt160.Zero.ToArray(),
                    (BigInteger)0, (BigInteger)0, (BigInteger)0, false, false, false,
                    (BigInteger)0, (BigInteger)0, false, (BigInteger)0, false]);
            return new Array([
                true,
                (int)control.Status,
                control.Custody.ToArray(),
                control.RecoveryAuthority.ToArray(),
                new BigInteger(control.AuthorityEpoch),
                new BigInteger(control.ConfigurationNonce),
                new BigInteger(control.RecoveryTimelockMs),
                control.DefaultOperationAuthorization,
                control.DefaultMessageAuthorization,
                control.OwnerOnlyRecovery,
                new BigInteger(control.HookOrderRevision),
                new BigInteger(control.ControlRevision),
                false,
                (BigInteger)0,
                false]);
        }

        /// <summary>
        /// The deterministic external address of an account: the script hash of
        /// its fixed proxy verification script (spec §3.6/§9). Read-only and
        /// permissionless, it is how a module resolves the asset-holding address
        /// of the account instance it serves.
        /// </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        public UInt160 GetAccountAddress(UInt160 accountId)
        {
            RequireAccountId(accountId);
            return SmartAccountProtocol.GetAccountAddress(accountId);
        }
    }
}
