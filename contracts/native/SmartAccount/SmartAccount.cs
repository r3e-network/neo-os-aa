// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccount.cs file belongs to the neo project and is free software distributed under the MIT software license,
// see the accompanying file LICENSE in the main directory of the repository or
// http://www.opensource.org/licenses/mit-license.php for more details.
//
// Redistribution and use in source and binary forms with or without modifications are permitted.

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
    /// <summary> Hardfork-gated native SmartAccount service implementing the SA module protocol v4 (docs/SA-MODULE-PROTOCOL.md).
    /// The exported method names, argument positions and return layouts are the protocol surface; only the execution substrate
    /// (native storage and the engine-local invocation context) is specific to this build. </summary>
    public sealed partial class SmartAccount : NativeContract
    {
        private const long BaseCpuFee = 1 << 15;

        /// <summary> sha256("NeoSmartAccount/Profile" ‖ 0x04 ‖ canonical v4 parameter JSON), pinned in
        /// docs/proposals/smartaccount-native-profile-parameters.json. </summary>
        internal const string ParameterDigest = "f9692d8cf7d74333b37142525de479f5742b1442aaf8baff64d883c4d16002f1";

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
        [ContractEvent(Hardfork.HF_SmartAccountV1, 12, "AccountReset", "accountId", ContractParameterType.Hash160, "custody", ContractParameterType.Hash160, "authorityEpoch", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 13, "BuiltinAuthorizationSet", "accountId", ContractParameterType.Hash160, "defaultOperationAuthorization", ContractParameterType.Boolean, "defaultMessageAuthorization", ContractParameterType.Boolean)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 16, "ModuleInstanceConfigured", "accountId", ContractParameterType.Hash160, "moduleId", ContractParameterType.Integer, "credentialGeneration", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 17, "RequiredValidatorSet", "accountId", ContractParameterType.Hash160, "validatorId", ContractParameterType.Integer, "required", ContractParameterType.Boolean)]
        // Policy-specific event ids 11, 14 and 15 are retired. Their state is
        // module-owned; only generic core routing metadata is reported here.
        internal SmartAccount() { }

        protected override void OnManifestCompose(IsHardforkEnabledDelegate checker, uint height, ContractManifest manifest)
        {
            if (checker(Hardfork.HF_SmartAccountV1, height))
                manifest.Extra = new JObject { ["smartAccount"] = new JObject
                {
                    ["abiVersion"] = SmartAccountProtocol.Version, ["profileParameterDigest"] = ParameterDigest
                } };
        }

        // ======================================================================== 1. Storage, time and notification
        // helpers ========================================================================

        // Storage keys are platform KeyBuilders: the builder owns the native-id header, so a key is the
        // prefix byte plus the fixed-width fields in protocol order (spec §7.1).
        internal KeyBuilder Key(byte prefix) => new(Id, prefix);

        private static bool TryRead(IReadOnlyStore snapshot, StorageKey key, out ReadOnlyMemory<byte> value)
        {
            if (snapshot.TryGet(key, out StorageItem? item) && item is not null)
            {
                value = item.Value;
                return true;
            }
            value = default;
            return false;
        }

        private static void Write(ApplicationEngine engine, StorageKey key, byte[] value)
        {
            StorageItem? item = engine.SnapshotCache.GetAndChange(key);
            if (item is null)
                engine.SnapshotCache.Add(key, new StorageItem(value));
            else
                item.Value = value;
        }

        private static ulong Now(ApplicationEngine engine) => engine.PersistingBlock?.Timestamp ??
            Ledger.GetHeader(engine.SnapshotCache, Ledger.CurrentHash(engine.SnapshotCache))?.Timestamp ??
            throw new InvalidOperationException("SmartAccount requires a known ledger timestamp.");

        private static void RequireApplication(ApplicationEngine engine)
        {
            if (engine.Trigger != TriggerType.Application)
                throw new InvalidOperationException(
                    $"{SmartAccountModuleProtocol.ErrorUnauthorized} This SmartAccount method requires Application trigger.");
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

        private void RequireAuthorityAddress(ApplicationEngine engine, UInt160 address)
        {
            Require(!TryRead(engine.SnapshotCache, Key(ProxyPrefix).Add(address), out _)
                && address != Hash, SmartAccountModuleProtocol.ErrorUnauthorized);
        }

        private static bool Witness(ApplicationEngine engine, UInt160 address) =>
            address != UInt160.Zero && engine.CheckWitnessInternal(address);

        /// <summary> The only record shape: the tagged current one. Reads and writes never derive a shape from the
        /// executing engine, so a record can never be interpreted under a second, historical layout. </summary>
        private static void Require(bool condition, string error)
        {
            if (!condition) throw new InvalidOperationException(error);
        }

        private static void RequireAccountId(UInt160 accountId)
        {
            SmartAccountProtocol.RequireIdentity(accountId);
        }

        // ======================================================================== 2. Account control accessors
        // ========================================================================

        private AccountControl? TryControl(IReadOnlyStore snapshot, UInt160 accountId) =>
            TryRead(snapshot, Key(SmartAccountModuleProtocol.PrefixAccountControl).Add(accountId), out var value)
                ? AccountControl.Decode(value)
                : null;

        private AccountControl RequireControl(IReadOnlyStore snapshot, UInt160 accountId) =>
            TryControl(snapshot, accountId) ?? throw new InvalidOperationException(
                SmartAccountModuleProtocol.ErrorAccountNotFound);

        /// <summary> Persists the control record in the tagged canonical shape. </summary>
        private void SaveControl(ApplicationEngine engine, UInt160 accountId, AccountControl control) =>
            Write(engine, Key(SmartAccountModuleProtocol.PrefixAccountControl).Add(accountId), control.Serialize());

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

        // ======================================================================== 3. Registration (spec §10 exception list: atomic
        // initial install) ========================================================================

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask CreateAccount(ApplicationEngine engine, UInt160 accountId, UInt160 custody,
            byte[] salt, Array actions)
        {
            await CreateAccountCoreAsync(engine, accountId, custody, salt, actions);
        }

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask CreateAccounts(ApplicationEngine engine, UInt160[] accountIds, UInt160 custody,
            byte[][] salts)
        {
            RequireApplication(engine);
            if (accountIds is null || salts is null || accountIds.Length != salts.Length
                || accountIds.Length is 0 or > 64)
                throw new FormatException(
                    $"{SmartAccountModuleProtocol.ErrorModuleLimitBatch} The account batch requires 1..64 id/salt pairs.");
            for (int i = 0; i < accountIds.Length; i++)
                await CreateAccountCoreAsync(engine, accountIds[i], custody, salts[i], new Array());
        }

        private async ContractTask CreateAccountCoreAsync(ApplicationEngine engine, UInt160 accountId,
            UInt160 custody, byte[] salt, Array actions)
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
            actions ??= new Array();
            Require(actions.Count <= SmartAccountModuleProtocol.MaxActionsPerRegistration,
                SmartAccountModuleProtocol.ErrorModuleLimitActions);
            // Creation is the account's consent: the atomic initial group may install modules only. Remove,
            // configure, a built-in switch change and a required-validator pin are governance paths and are
            // rejected here rather than executed early.
            foreach (StackItem action in actions)
            {
                Require(ActionCode(RequireActionArray(action)) == SmartAccountModuleProtocol.ActionInstallModule,
                    SmartAccountModuleProtocol.ErrorOperationMalformed);
                ValidateActionShape(action);
            }
            UInt160 proxy = SmartAccountProtocol.GetAccountAddress(accountId);
            Require(proxy != custody && !TryRead(engine.SnapshotCache, Key(ProxyPrefix).Add(proxy), out _),
                SmartAccountModuleProtocol.ErrorUnauthorized);
            Write(engine, Key(ProxyPrefix).Add(proxy), accountId.ToArray());
            AccountControl control = AccountControl.Create(custody);
            SaveControl(engine, accountId, control);
            if (actions.Count > 0)
            {
                await ExecuteRegistrationActionsAsync(engine, accountId, control, actions);
                RequireFinalOperationRoute(engine, accountId, control);
                control.Advance();
                SaveControl(engine, accountId, control);
            }
            Notify(engine, "AccountRegistered", accountId.ToArray(), custody.ToArray());
        }

        // ======================================================================== 4. Freeze and unfreeze (spec
        // §7.5/§10) ========================================================================

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void FreezeAccount(ApplicationEngine engine, UInt160 accountId)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            // Freeze is the emergency path (spec §4): the custody witness may always stop the account, whatever
            // route is pinned.
            RequireCustody(engine, control);
            _ = RequireActive(control);
            control.Status = SmartAccountStatus.Frozen;
            control.AdvanceAuthority();
            SaveControl(engine, accountId, control);
            Notify(engine, "AccountFrozen", accountId.ToArray(), new BigInteger(control.AuthorityEpoch));
        }

        /// <summary> Ends a freeze (spec §10). Authorized by the account's bound, code-bound governance instance alone, like
        /// every other configuration landing (spec §4); the custody witness cannot thaw. The core holds no
        /// thaw timelock: delaying a thaw is the responsibility of the governance module that gated the call. The
        /// transition advances the authority epoch, the configuration nonce and the control revision, which kills
        /// every signature, configuration and nonce channel that predates the thaw. </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void UnfreezeAccount(ApplicationEngine engine, UInt160 accountId)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            Require(control.Status == SmartAccountStatus.Frozen, SmartAccountModuleProtocol.ErrorAccountStatus);
            RequireGovernanceCaller(engine, accountId);
            control.Status = SmartAccountStatus.Active;
            // §8: a thaw advances the authority epoch and the configuration nonce, so every operation and configuration signed
            // before the freeze is stale — and it advances the control revision because the control record changed. The core holds
            // no thaw delay of its own; a user-space governance module owns that policy.
            SettleConfiguration(engine, accountId, control, advanceAuthority: true);
            Notify(engine, SmartAccountModuleProtocol.EventNameAccountUnfrozen, accountId.ToArray(),
                new BigInteger(control.AuthorityEpoch));
        }

        // ======================================================================== 5. Protocol and account queries
        // (spec §3.3/§9) ========================================================================

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.None)]
        private static string GetAccountImplementationId() => AccountImplementationId;

        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.None)]
        private static Array GetProtocolInfo() => new Array([(int)SmartAccountProtocol.Version]);

        /// <summary> Aggregated account descriptor, non-faulting for unknown accounts. Layout: [exists, status,
        /// custody, authorityEpoch, configurationNonce, defaultOperationAuthorization, defaultMessageAuthorization,
        /// requiredValidatorId, controlRevision]. </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private Array GetAccount(ApplicationEngine engine, UInt160 accountId)
        {
            RequireAccountId(accountId);
            AccountControl? control = TryControl(engine.SnapshotCache, accountId);
            if (control is null)
                return new Array([false, (BigInteger)0, UInt160.Zero.ToArray(), (BigInteger)0,
                    (BigInteger)0, false, false, (BigInteger)0, (BigInteger)0]);
            return new Array([
                true, (int)control.Status, control.Custody.ToArray(), new BigInteger(control.AuthorityEpoch),
                new BigInteger(control.ConfigurationNonce), control.DefaultOperationAuthorization,
                control.DefaultMessageAuthorization, new BigInteger(control.RequiredValidatorId),
                new BigInteger(control.ControlRevision)]);
        }

        /// <summary> The deterministic external address of an account: the script hash of its fixed proxy
        /// verification script (spec §3.6/§9). Read-only and permissionless, it is how a module resolves the
        /// asset-holding address of the account instance it serves. </summary>
        [ContractMethod(CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        public UInt160 GetAccountAddress(UInt160 accountId)
        {
            RequireAccountId(accountId);
            return SmartAccountProtocol.GetAccountAddress(accountId);
        }
    }
}
