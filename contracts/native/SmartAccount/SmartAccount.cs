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
    /// argument positions and return layouts are identical to the custom
    /// kernel: only the execution substrate (native storage and the
    /// engine-local invocation context) differs.
    /// </summary>
    public sealed partial class SmartAccount : NativeContract
    {
        private const long BaseCpuFee = 1 << 15;

        /// <summary>
        /// sha256("NeoSmartAccount/Profile" ‖ 0x04 ‖ canonical v4 parameter
        /// JSON), pinned in docs/proposals/smartaccount-native-profile-v4-parameters.json.
        /// </summary>
        internal const string ParameterDigest = "a19f919c57da04c9546e8db27913a6421b577273b1803545d92a7c4361d53635";

        /// <summary>Legacy 0x11 index of registered native proxy addresses (read-only input).</summary>
        private const byte ProxyPrefix = 0x11;

        internal const string AccountImplementationId = "NativeSmartAccount/v4";

        public override ImmutableHashSet<Hardfork?> Activations => [Hardfork.HF_SmartAccountV1];

        [ContractEvent(Hardfork.HF_SmartAccountV1, 0, "AccountRegistered", "accountId", ContractParameterType.Hash160, "backupOwner", ContractParameterType.Hash160, "verifier", ContractParameterType.Hash160, "hookId", ContractParameterType.Hash160)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 1, "ModuleInstalled", "accountId", ContractParameterType.Hash160, "moduleType", ContractParameterType.String, "moduleHash", ContractParameterType.Hash160)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 2, "ModuleUpdateInitiated", "accountId", ContractParameterType.Hash160, "moduleType", ContractParameterType.String, "moduleHash", ContractParameterType.Hash160)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 3, "ModuleUpdateConfirmed", "accountId", ContractParameterType.Hash160, "moduleType", ContractParameterType.String, "moduleHash", ContractParameterType.Hash160)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 4, "ModuleRemoved", "accountId", ContractParameterType.Hash160, "moduleType", ContractParameterType.String, "moduleHash", ContractParameterType.Hash160)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 5, "ModuleUpdateCancelled", "accountId", ContractParameterType.Hash160, "moduleType", ContractParameterType.String, "moduleHash", ContractParameterType.Hash160)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 6, "UserOpExecuted", "accountId", ContractParameterType.Hash160, "targetContract", ContractParameterType.Hash160, "method", ContractParameterType.String, "nonce", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 7, "ModuleInstanceInstalled", "accountId", ContractParameterType.Hash160, "moduleId", ContractParameterType.Integer, "moduleType", ContractParameterType.Integer, "contractHash", ContractParameterType.Hash160, "credentialGeneration", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 8, "ModuleInstanceConfigured", "accountId", ContractParameterType.Hash160, "moduleId", ContractParameterType.Integer, "credentialGeneration", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 9, "ModuleInstanceRemoved", "accountId", ContractParameterType.Hash160, "moduleId", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 10, "ModuleCodeRebound", "accountId", ContractParameterType.Hash160, "moduleId", ContractParameterType.Integer, "bindingDigest", ContractParameterType.ByteArray)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 11, "HookOrderSet", "accountId", ContractParameterType.Hash160, "hookOrderRevision", ContractParameterType.Integer, "hookIds", ContractParameterType.Array)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 12, "ThresholdPolicySet", "accountId", ContractParameterType.Hash160, "policyId", ContractParameterType.Integer, "threshold", ContractParameterType.Integer, "memberIds", ContractParameterType.Array)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 13, "CredentialRevoked", "accountId", ContractParameterType.Hash160, "moduleId", ContractParameterType.Integer, "credentialGeneration", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 14, "ConfigurationIntentProposed", "accountId", ContractParameterType.Hash160, "intentId", ContractParameterType.Integer, "actionCount", ContractParameterType.Integer, "actionDigest", ContractParameterType.ByteArray)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 15, "ConfigurationIntentConfirmed", "accountId", ContractParameterType.Hash160, "intentId", ContractParameterType.Integer, "configurationNonce", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 16, "ConfigurationIntentCancelled", "accountId", ContractParameterType.Hash160, "intentId", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 17, "ConfigurationIntentExpired", "accountId", ContractParameterType.Hash160, "intentId", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 18, "NonceChannelOpened", "accountId", ContractParameterType.Hash160, "channelDigest", ContractParameterType.ByteArray)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 19, "NonceChannelExhausted", "accountId", ContractParameterType.Hash160, "channelDigest", ContractParameterType.ByteArray)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 20, "AccountFrozen", "accountId", ContractParameterType.Hash160, "authorityEpoch", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 21, "AccountUnfrozen", "accountId", ContractParameterType.Hash160, "authorityEpoch", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 22, "RecoveryInitiated", "accountId", ContractParameterType.Hash160, "newCustody", ContractParameterType.Hash160, "matureAt", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 23, "RecoveryCancelled", "accountId", ContractParameterType.Hash160)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 24, "RecoveryExecuted", "accountId", ContractParameterType.Hash160, "authorityEpoch", ContractParameterType.Integer, "configurationNonce", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 25, "CoreRecoveryRecorded", "accountId", ContractParameterType.Hash160, "matureAt", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 26, "MessageSubjectUpdated", "accountId", ContractParameterType.Hash160, "subjectCount", ContractParameterType.Integer, "threshold", ContractParameterType.Integer, "subjectRevision", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 27, "MigrationRequired", "accountId", ContractParameterType.Hash160, "legacyModuleCount", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 28, "MigrationImported", "accountId", ContractParameterType.Hash160, "manifestDigest", ContractParameterType.ByteArray, "classification", ContractParameterType.String)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 29, "MarketControlEpochBound", "accountId", ContractParameterType.Hash160, "listingId", ContractParameterType.Integer, "controlEpoch", ContractParameterType.Integer)]
        [ContractEvent(Hardfork.HF_SmartAccountV1, 30, "MarketLockInvalidated", "accountId", ContractParameterType.Hash160, "controlEpoch", ContractParameterType.Integer)]
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

        internal override ContractTask InitializeAsync(ApplicationEngine engine, Hardfork? hardfork)
        {
            if (hardfork == Hardfork.HF_SmartAccountV1)
                engine.SnapshotCache.Add(Key(SmartAccountProtocol.GetProtocolKey()), new StorageItem(
                    BinarySerializer.Serialize(new Array([(int)SmartAccountProtocol.Version, false]), 128, 8)));
            return ContractTask.CompletedTask;
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

        private static bool AuthorityWitness(ApplicationEngine engine, AccountControl control) =>
            Witness(engine, control.Custody) || Witness(engine, control.RecoveryAuthority);

        private static SmartAccountStatus RequireActive(AccountControl control)
        {
            switch (control.Status)
            {
                case SmartAccountStatus.Frozen:
                    throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorAccountFrozen);
                case SmartAccountStatus.MigrationRequired:
                    throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorMigrationRequired);
                case SmartAccountStatus.Active:
                    return SmartAccountStatus.Active;
                default:
                    throw new InvalidOperationException(SmartAccountModuleProtocol.ErrorAccountStatus);
            }
        }

        // ========================================================================
        // 3. Registration (spec §10 exception list: atomic initial install)
        // ========================================================================

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private async ContractTask CreateAccount(ApplicationEngine engine, UInt160 accountId, UInt160 custody,
            byte[] salt, BigInteger recoveryTimelockMs, Array actions)
        {
            await CreateAccountCoreAsync(engine, accountId, custody, salt, recoveryTimelockMs, actions);
        }

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
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
            Require(actions.Count <= SmartAccountModuleProtocol.MaxActionsPerConfigurationIntent,
                SmartAccountModuleProtocol.ErrorModuleLimitActions);
            foreach (StackItem action in actions)
                ValidateActionShape(action);

            AccountControl control = AccountControl.Create(custody, timelock);
            SaveControl(engine, accountId, control);
            InitializeDefaultMessageSubjects(engine, accountId, custody);

            if (actions.Count > 0)
            {
                await ExecuteConfigurationActionsAsync(engine, accountId, control, actions);
                if (CountModulesOfType(engine.SnapshotCache, accountId,
                        SmartAccountModuleProtocol.ModuleTypeCodeValidator) == 0)
                    Require(control.DefaultOperationAuthorization, SmartAccountModuleProtocol.ErrorOperationMalformed);
                control.Advance();
                SaveControl(engine, accountId, control);
            }

            Notify(engine, "AccountRegistered", accountId.ToArray(), custody.ToArray(),
                UInt160.Zero.ToArray(), UInt160.Zero.ToArray());
        }

        // ========================================================================
        // 4. Freeze and callback-free recovery (spec §7.5/§10)
        // ========================================================================

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void FreezeAccount(ApplicationEngine engine, UInt160 accountId)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            RequireCustody(engine, control);
            AssertAccountIdle(engine, accountId);
            Require(control.Status != SmartAccountStatus.Frozen, SmartAccountModuleProtocol.ErrorAccountFrozen);

            control.Status = SmartAccountStatus.Frozen;
            control.AuthorityEpoch += 1;
            control.ConfigurationNonce += 1;
            control.ControlRevision += 1;
            SaveControl(engine, accountId, control);
            Notify(engine, "AccountFrozen", accountId.ToArray(), new BigInteger(control.AuthorityEpoch));
        }

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void UnfreezeAccount(ApplicationEngine engine, UInt160 accountId)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            RequireCustody(engine, control);
            AssertAccountIdle(engine, accountId);
            Require(control.Status == SmartAccountStatus.Frozen, SmartAccountModuleProtocol.ErrorAccountStatus);

            control.Status = SmartAccountStatus.Active;
            control.AuthorityEpoch += 1;
            control.ConfigurationNonce += 1;
            control.ControlRevision += 1;
            SaveControl(engine, accountId, control);
            Notify(engine, "AccountUnfrozen", accountId.ToArray(), new BigInteger(control.AuthorityEpoch));
        }

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void BeginRecovery(ApplicationEngine engine, UInt160 accountId, UInt160 newCustody)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            AssertAccountIdle(engine, accountId);
            Require(AuthorityWitness(engine, control), SmartAccountModuleProtocol.ErrorUnauthorized);
            if (newCustody is not null && newCustody != UInt160.Zero)
                Require(Witness(engine, newCustody), SmartAccountModuleProtocol.ErrorUnauthorized);
            Require(!TryRead(engine.SnapshotCache, SmartAccountProtocol.GetCoreRecoveryKey(accountId), out _),
                SmartAccountModuleProtocol.ErrorRecoveryPending);

            ulong now = Now(engine);
            ulong mature = checked(now + control.RecoveryTimelockMs);
            CoreRecoveryRecord record = new()
            {
                InitiatedAt = now,
                MatureAt = mature,
                AuthorityEpochAtInit = control.AuthorityEpoch,
                NewCustody = newCustody ?? UInt160.Zero,
            };
            Write(engine, SmartAccountProtocol.GetCoreRecoveryKey(accountId), record.Serialize());
            Notify(engine, "RecoveryInitiated", accountId.ToArray(), record.NewCustody.ToArray(),
                new BigInteger(mature));
        }

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void CancelRecovery(ApplicationEngine engine, UInt160 accountId)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            Require(AuthorityWitness(engine, control), SmartAccountModuleProtocol.ErrorUnauthorized);
            Require(TryRead(engine.SnapshotCache, SmartAccountProtocol.GetCoreRecoveryKey(accountId), out _),
                SmartAccountModuleProtocol.ErrorRecoveryPending);
            Delete(engine, SmartAccountProtocol.GetCoreRecoveryKey(accountId));
            Notify(engine, "RecoveryCancelled", accountId.ToArray());
        }

        /// <summary>
        /// Permissionless execution of a matured recovery. Callback-free: no
        /// module, hook or market contract is called; every module-model row of
        /// the account is deleted and the built-in routes are re-enabled.
        /// </summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.All)]
        private void ExecuteRecovery(ApplicationEngine engine, UInt160 accountId)
        {
            RequireApplication(engine);
            RequireAccountId(accountId);
            using var locked = Context(engine).EnterAccount(accountId);
            AccountControl control = RequireControl(engine.SnapshotCache, accountId);
            AssertAccountIdle(engine, accountId);
            byte[] key = SmartAccountProtocol.GetCoreRecoveryKey(accountId);
            Require(TryRead(engine.SnapshotCache, key, out var pendingBytes),
                SmartAccountModuleProtocol.ErrorRecoveryPending);
            CoreRecoveryRecord pending = CoreRecoveryRecord.Decode(pendingBytes);
            Require(Now(engine) >= (ulong)pending.MatureAt, SmartAccountModuleProtocol.ErrorRecoveryLocked);
            Require(pending.AuthorityEpochAtInit == control.AuthorityEpoch, SmartAccountModuleProtocol.ErrorEpochStale);

            SweepAccountRows(engine, accountId);
            Delete(engine, key);

            if (pending.NewCustody != UInt160.Zero) control.Custody = pending.NewCustody;
            control.RecoveryAuthority = UInt160.Zero;
            control.Status = SmartAccountStatus.Active;
            control.AuthorityEpoch += 1;
            control.ConfigurationNonce += 1;
            control.ControlRevision += 1;
            control.DefaultOperationAuthorization = true;
            control.DefaultMessageAuthorization = true;
            SaveControl(engine, accountId, control);
            InitializeDefaultMessageSubjects(engine, accountId, control.Custody);
            Notify(engine, "RecoveryExecuted", accountId.ToArray(),
                new BigInteger(control.AuthorityEpoch), new BigInteger(control.ConfigurationNonce));
        }

        /// <summary>
        /// Callback-free deletion of every v4 module-model row of an account.
        /// The module-id allocator in 0x51 is preserved: ids are never reused.
        /// </summary>
        private void SweepAccountRows(ApplicationEngine engine, UInt160 accountId)
        {
            foreach (BigInteger moduleId in EnumerateModuleIds(engine.SnapshotCache, accountId,
                         SmartAccountModuleProtocol.ModuleTypeCodeValidator, BigInteger.Zero, int.MaxValue))
                Delete(engine, SmartAccountProtocol.GetModuleInstanceKey(accountId, moduleId));
            foreach (BigInteger moduleId in EnumerateModuleIds(engine.SnapshotCache, accountId,
                         SmartAccountModuleProtocol.ModuleTypeCodeHook, BigInteger.Zero, int.MaxValue))
                Delete(engine, SmartAccountProtocol.GetModuleInstanceKey(accountId, moduleId));
            DeletePrefix(engine, SmartAccountModuleProtocol.PrefixModuleIndex, accountId);
            DeletePrefix(engine, SmartAccountModuleProtocol.PrefixConfigIntent, accountId);
            DeletePrefix(engine, SmartAccountModuleProtocol.PrefixThresholdPolicy, accountId);
            DeletePrefix(engine, SmartAccountModuleProtocol.PrefixNonceCursor, accountId);
            DeletePrefix(engine, SmartAccountModuleProtocol.PrefixNonceNamespace, accountId);
            Delete(engine, SmartAccountProtocol.GetHookOrderKey(accountId));
            Delete(engine, SmartAccountProtocol.GetMessageSubjectKey(accountId));
            Delete(engine, SmartAccountProtocol.GetConfigIntentIndexKey(accountId));
            Delete(engine, SmartAccountProtocol.GetMigrationStateKey(accountId));
        }

        private void DeletePrefix(ApplicationEngine engine, byte prefix, UInt160 accountId)
        {
            byte[] match = SmartAccountProtocol.Concat(new[] { prefix }, accountId.ToArray());
            List<byte[]> keys = new();
            foreach (var (key, _) in engine.SnapshotCache.Find(new StorageKey { Id = Id, Key = match }))
            {
                if (!key.Key.Span.StartsWith(match)) break;
                keys.Add(key.Key.ToArray());
            }
            foreach (byte[] key in keys) engine.SnapshotCache.Delete(Key(key));
        }

        // ========================================================================
        // 5. Protocol and account queries (spec §3.3/§9)
        // ========================================================================

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.None)]
        private static string GetAccountImplementationId() => AccountImplementationId;

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private Array GetProtocolInfo(IReadOnlyStore snapshot)
        {
            // [version, migrationModeOpen] — identical to the custom kernel.
            // A core that has not opened its migration mode yet (or a snapshot
            // that was never initialized with the hardfork) answers the default
            // instead of faulting a read-only query.
            if (!TryRead(snapshot, SmartAccountProtocol.GetProtocolKey(), out var value))
                return new Array([(BigInteger)SmartAccountProtocol.Version, false]);
            Array record = SmartAccountRecordCodec.Decode(value);
            return new Array([record[0], record[1]]);
        }

        /// <summary>
        /// Aggregated account descriptor, non-faulting for unknown accounts.
        /// Layout: [exists, status, custody, recoveryAuthority, authorityEpoch,
        /// configurationNonce, recoveryTimelockMs, defaultOperationAuthorization,
        /// defaultMessageAuthorization, ownerOnlyRecovery, hookOrderRevision,
        /// controlRevision, recoveryPending, recoveryMatureAt,
        /// marketEscrowActive, legacyRow].
        /// </summary>
        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private Array GetAccount(IReadOnlyStore snapshot, UInt160 accountId)
        {
            RequireAccountId(accountId);
            AccountControl? control = TryControl(snapshot, accountId);
            if (control is null)
                return new Array([false, (BigInteger)0, UInt160.Zero.ToArray(), UInt160.Zero.ToArray(),
                    (BigInteger)0, (BigInteger)0, (BigInteger)0, false, false, false,
                    (BigInteger)0, (BigInteger)0, false, (BigInteger)0, false, false]);
            CoreRecoveryRecord? recovery = TryRead(snapshot,
                SmartAccountProtocol.GetCoreRecoveryKey(accountId), out var pendingBytes)
                ? CoreRecoveryRecord.Decode(pendingBytes)
                : null;
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
                recovery is not null,
                recovery is null ? BigInteger.Zero : recovery.MatureAt,
                false,
                false]);
        }

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.ReadStates)]
        private Array GetRecoveryStatus(IReadOnlyStore snapshot, UInt160 accountId)
        {
            RequireAccountId(accountId);
            _ = RequireControl(snapshot, accountId);
            if (!TryRead(snapshot, SmartAccountProtocol.GetCoreRecoveryKey(accountId), out var pendingBytes))
                return new Array();
            CoreRecoveryRecord record = CoreRecoveryRecord.Decode(pendingBytes);
            return new Array([true, record.InitiatedAt, record.MatureAt, record.AuthorityEpochAtInit,
                record.NewCustody.ToArray()]);
        }

        [ContractMethod(Hardfork.HF_SmartAccountV1, CpuFee = BaseCpuFee, RequiredCallFlags = CallFlags.None)]
        private static byte[] CanonicalP256PublicKey([P256PublicKey] byte[] publicKey)
        {
            byte[] compressed;
            if (publicKey.Length == 33 && publicKey[0] is 2 or 3)
                compressed = publicKey;
            else if (publicKey.Length == 65 && publicKey[0] == 4)
            {
                compressed = new byte[33];
                compressed[0] = (byte)(2 | (publicKey[64] & 1));
                publicKey.AsSpan(1, 32).CopyTo(compressed.AsSpan(1));
            }
            else throw new FormatException("A canonical P-256 public key requires a 33-byte compressed or 65-byte uncompressed encoding.");

            var point = Neo.Cryptography.ECC.ECPoint.DecodePoint(compressed, Neo.Cryptography.ECC.ECCurve.Secp256r1);
            if (publicKey.Length == 65 && !publicKey.AsSpan().SequenceEqual(point.EncodePoint(false)))
                throw new FormatException("The uncompressed P-256 public key is not a point on the curve.");
            return point.EncodePoint(true).AsSpan().ToArray();
        }
    }
}
