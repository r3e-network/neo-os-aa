using System.Numerics;
using System.ComponentModel;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    /// <summary>
    /// Core-native freeze and callback-free recovery (protocol v4, spec §10 /
    /// design report §6.7/§6.8).
    ///
    /// Freeze: the custody witness freezes an account immediately; while
    /// frozen, only read queries, recovery and unfreeze remain reachable (the
    /// frozen-state ABI sweep). Freeze advances the authority epoch, so every
    /// intent and signature bound to the previous epoch dies.
    ///
    /// Recovery: core-built-in, callback-free. beginRecovery writes a 0x59
    /// record (never overwritten or restarted); executeRecovery is
    /// permissionless once matured, performs no external call whatsoever (no
    /// old validator/hook/Market/Oracle), removes every module instance,
    /// policy, subject set, intent and nonce channel, voids the pending
    /// migration state, enables built-in authorization and advances
    /// authorityEpoch/configurationNonce/controlRevision. The control-epoch
    /// advance also invalidates any 0x5D Market binding of the account
    /// (spec §7.5 owner escape); the physical 0x06/0x07/0x1D Market markers
    /// are deliberately left for the Market's own later cleanup claims.
    /// </summary>
    public partial class SmartAccount
    {
        // Legacy permanent owner-only latch (0x22). Read as migration input and
        // folded into AccountControl.OwnerOnlyRecovery at materialization; the
        // flag is monotonic and never cleared. New owner-only elections are
        // written through the ActionSetRecoveryPolicy configuration action.
        private static readonly byte[] Prefix_OwnerOnlyRecovery = new byte[] { 0x22 };

        // Legacy freeze latch (0x27). Read as migration input: a legacy row
        // materializes its AccountControl in the Frozen status. The v4 freeze
        // state itself lives in AccountControl.Status (0x51); this latch is
        // cleared when the account is unfrozen.
        private static readonly byte[] Prefix_AccountFrozen = new byte[] { 0x27 };

        // ========================================================================
        // 1. Legacy-account materialization (0x51 from 0x01, spec §7.4)
        // ========================================================================

        /// <summary>
        /// Returns the account's 0x51 control record, materializing it from
        /// the legacy five-field 0x01 row when absent (bounded materialization
        /// for legacy accounts that reach freeze, recovery, market entry or
        /// migration before importing a module set — design report §4.3).
        /// The materialized record is fail-closed: no module instances exist
        /// and both built-in authorization switches default to OFF, so a
        /// materialized legacy account cannot route operations until its
        /// custody explicitly configures it or imports a migrated set.
        /// </summary>
        private static AccountControl MaterializeAccountControl(UInt160 accountId)
        {
            AccountControl? existing = GetAccountControl(accountId);
            if (existing != null) return existing!;

            AccountState state = GetAccountState(accountId); // asserts SA_ACCOUNT_NOT_FOUND
            AccountControl control = new AccountControl();
            control.Status = HasLegacyFrozenLatch(accountId) ? AccountStatusFrozen : AccountStatusActive;
            control.Custody = state.BackupOwner;
            control.RecoveryAuthority = UInt160.Zero;
            control.AuthorityEpoch = BigInteger.One;
            control.ConfigurationNonce = BigInteger.Zero;
            control.NextModuleId = BigInteger.One;
            control.NextIntentId = BigInteger.One;
            control.DefaultOperationAuthorization = false;
            control.DefaultMessageAuthorization = false;
            BigInteger timelockMs = state.EscapeTimelock * 1000;
            if (timelockMs < RecoveryTimelockMinMs) timelockMs = RecoveryTimelockMinMs;
            if (timelockMs > RecoveryTimelockMaxMs) timelockMs = RecoveryTimelockMaxMs;
            control.RecoveryTimelockMs = timelockMs;
            control.HookOrderRevision = BigInteger.Zero;
            control.DefaultPolicyRevision = BigInteger.Zero;
            control.ControlRevision = BigInteger.One;
            control.OwnerOnlyRecovery = HasLegacyOwnerOnlyLatch(accountId);
            PutAccountControl(accountId, control);
            return control;
        }

        private static bool HasLegacyFrozenLatch(UInt160 accountId)
        {
            return Storage.Get(Storage.CurrentContext,
                Helper.Concat(Prefix_AccountFrozen, (byte[])accountId)) != null;
        }

        private static bool HasLegacyOwnerOnlyLatch(UInt160 accountId)
        {
            return Storage.Get(Storage.CurrentContext,
                Helper.Concat(Prefix_OwnerOnlyRecovery, (byte[])accountId)) != null;
        }

        private static bool HasOwnerOnlyRecovery(UInt160 accountId)
        {
            AccountControl? control = GetAccountControl(accountId);
            if (control != null && control!.OwnerOnlyRecovery) return true;
            return HasLegacyOwnerOnlyLatch(accountId);
        }

        // ========================================================================
        // 2. Freeze / unfreeze (spec §10)
        // ========================================================================

        /// <summary>
        /// Freezes the account immediately (custody witness). While frozen,
        /// every state-changing ABI except recovery and unfreeze is
        /// unreachable. Freeze advances the authority epoch AND the
        /// configuration nonce: pending intents, in-flight operation signatures
        /// and the configuration nonce bound into the operation digest all die.
        /// Freeze is an idle-context operation: it can never run from inside a
        /// module callback or a target dispatch.
        /// </summary>
        public static void freezeAccount(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            AccountControl control = MaterializeAccountControl(accountId);
            RequireCustodyWitness(control);
            AssertAccountConfigurationIdle(accountId);
            ExecutionEngine.Assert(control.Status != AccountStatusFrozen, ErrorAccountFrozen);

            control.Status = AccountStatusFrozen;
            control.AuthorityEpoch += BigInteger.One;
            control.ConfigurationNonce += BigInteger.One;
            control.ControlRevision += BigInteger.One;
            PutAccountControl(accountId, control);
            OnAccountFrozen(accountId, control.AuthorityEpoch);
        }

        /// <summary>
        /// Removes the freeze (custody witness). A legacy account that has
        /// not yet imported a migrated configuration returns to the
        /// MigrationRequired status instead of Active, so unfreeze can never
        /// become a silent migration bypass. Unfreeze advances the authority
        /// epoch and the configuration nonce exactly like freeze, so the two
        /// are a symmetric composition and no pre-freeze template (intent,
        /// signature, nonce channel) becomes reusable after the round trip.
        /// </summary>
        public static void unfreezeAccount(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            AccountControl control = MaterializeAccountControl(accountId);
            RequireCustodyWitness(control);
            AssertAccountConfigurationIdle(accountId);
            ExecutionEngine.Assert(control.Status == AccountStatusFrozen, ErrorAccountStatus);

            control.Status = UnfreezeTargetStatus(accountId, control);
            control.AuthorityEpoch += BigInteger.One;
            control.ConfigurationNonce += BigInteger.One;
            control.ControlRevision += BigInteger.One;
            PutAccountControl(accountId, control);
            Storage.Delete(Storage.CurrentContext,
                Helper.Concat(Prefix_AccountFrozen, (byte[])accountId));
            OnAccountUnfrozen(accountId, control.AuthorityEpoch);
        }

        private static byte UnfreezeTargetStatus(UInt160 accountId, AccountControl control)
        {
            if (control.Status != AccountStatusFrozen) return control.Status;
            // A v4 account (no legacy row) or a fully imported one returns to
            // Active; a still-unmigrated legacy account stays fail-closed.
            if (Storage.Get(Storage.CurrentContext, Helper.Concat(Prefix_AccountState, (byte[])accountId)) == null)
            {
                return AccountStatusActive;
            }
            MigrationStateRecord? migration = GetMigrationState(accountId);
            if (migration != null && migration!.Status == MigrationStatusImported)
            {
                return AccountStatusActive;
            }
            return AccountStatusMigrationRequired;
        }

        /// <summary>
        /// True while the account is frozen. Reads the v4 status when the 0x51
        /// record exists and otherwise consults the legacy 0x27 latch, so a
        /// read-only probe never faults on an unknown or unmigrated account.
        /// </summary>
        [Safe]
        public static bool IsAccountFrozen(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            AccountControl? control = GetAccountControl(accountId);
            if (control != null) return control!.Status == AccountStatusFrozen;
            return HasLegacyFrozenLatch(accountId);
        }

        /// <summary>True while the permanent owner-only constraint is in force.</summary>
        [Safe]
        public static bool IsOwnerOnlyRecovery(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            return HasOwnerOnlyRecovery(accountId);
        }

        // ========================================================================
        // 3. Callback-free recovery (0x59, spec §10 / §7.5)
        // ========================================================================

        private static CoreRecoveryRecord? GetCoreRecoveryRecord(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, CoreRecoveryKey(accountId));
            return data == null ? null : (CoreRecoveryRecord)StdLib.Deserialize(data!);
        }

        /// <summary>
        /// Begins the core recovery flow. Authorized by the custody witness or
        /// the configured recovery authority. A non-zero <paramref name="newCustody"/>
        /// additionally requires that subject's witness, exactly like a
        /// recovery-policy change. The 0x59 record is never overwritten or
        /// restarted by another request: while one is pending, beginning again
        /// is rejected (SA_RECOVERY_PENDING). Beginning recovery stays
        /// reachable on Frozen and MigrationRequired accounts, and while a
        /// Market escrow lock is active — the owner-side Market escape is this
        /// exact flow (spec §7.5), and it never calls the Market.
        /// </summary>
        public static void beginRecovery(UInt160 accountId, UInt160 newCustody)
        {
            ValidateAccountId(accountId);
            AccountControl control = MaterializeAccountControl(accountId);
            AssertAccountConfigurationIdle(accountId);

            bool byCustody = control.Custody != null && control.Custody != UInt160.Zero
                && Runtime.CheckWitness(control.Custody!);
            bool byAuthority = control.RecoveryAuthority != null && control.RecoveryAuthority != UInt160.Zero
                && Runtime.CheckWitness(control.RecoveryAuthority!);
            ExecutionEngine.Assert(byCustody || byAuthority, ErrorUnauthorized);
            if (newCustody != null && newCustody != UInt160.Zero)
            {
                ExecutionEngine.Assert(Runtime.CheckWitness(newCustody!), ErrorUnauthorized);
            }

            ExecutionEngine.Assert(GetCoreRecoveryRecord(accountId) == null, ErrorRecoveryPending);

            CoreRecoveryRecord record = new CoreRecoveryRecord();
            record.InitiatedAt = Runtime.Time;
            record.MatureAt = record.InitiatedAt + control.RecoveryTimelockMs;
            record.AuthorityEpochAtInit = control.AuthorityEpoch;
            record.NewCustody = newCustody == null ? UInt160.Zero : newCustody;
            Storage.Put(Storage.CurrentContext, CoreRecoveryKey(accountId), StdLib.Serialize(record));

            OnRecoveryInitiated(accountId, record.NewCustody, record.MatureAt);
            // §18 reused-event mirror: the legacy EscapeInitiated feed keeps
            // flowing for recovery-authority and Market-owner escapes.
            OnEscapeInitiated(accountId, record.NewCustody);
            // The same 0x59 record doubles as the core recovery record of a
            // Market owner escape while an escrow lock is active.
            if (IsMarketEscrowActive(accountId))
            {
                OnCoreRecoveryRecorded(accountId, record.MatureAt);
            }
        }

        /// <summary>Cancels a pending recovery (custody or recovery authority witness).</summary>
        public static void cancelRecovery(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            AccountControl control = MaterializeAccountControl(accountId);

            bool byCustody = control.Custody != null && control.Custody != UInt160.Zero
                && Runtime.CheckWitness(control.Custody!);
            bool byAuthority = control.RecoveryAuthority != null && control.RecoveryAuthority != UInt160.Zero
                && Runtime.CheckWitness(control.RecoveryAuthority!);
            ExecutionEngine.Assert(byCustody || byAuthority, ErrorUnauthorized);

            CoreRecoveryRecord? record = GetCoreRecoveryRecord(accountId);
            ExecutionEngine.Assert(record != null, ErrorRecoveryPending + " none in progress");

            Storage.Delete(Storage.CurrentContext, CoreRecoveryKey(accountId));
            OnRecoveryCancelled(accountId);
            // §18 reused-event mirror.
            OnEscapeCancelled(accountId);
        }

        /// <summary>
        /// Executes a matured recovery. Permissionless. Applies the exact
        /// approved result (custody rotation), makes no external call
        /// whatsoever (callback-free — no old validator, hook, Market or
        /// Oracle can block or observe it), removes every module instance,
        /// threshold policy, hook order, message-subject set, pending intent,
        /// nonce channel and pending migration state, enables built-in
        /// authorization and advances authorityEpoch, configurationNonce and
        /// the control revision. The control-epoch advance invalidates any
        /// 0x5D Market binding; the physical Market markers are left for the
        /// Market's own later cleanup (spec §7.5).
        /// </summary>
        public static void executeRecovery(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            AccountControl control = MaterializeAccountControl(accountId);
            AssertAccountConfigurationIdle(accountId);

            CoreRecoveryRecord? pending = GetCoreRecoveryRecord(accountId);
            ExecutionEngine.Assert(pending != null, ErrorRecoveryPending + " none in progress");
            ExecutionEngine.Assert(Runtime.Time >= pending!.MatureAt, ErrorRecoveryLocked);
            ExecutionEngine.Assert(pending.AuthorityEpochAtInit == control.AuthorityEpoch, ErrorEpochStale);

            MarketControlBinding? marketBinding = GetMarketControlBinding(accountId);

            // Callback-free sweep: no external call is made anywhere below.
            SweepAccountModulesAndPolicies(accountId);
            Storage.Delete(Storage.CurrentContext, CoreRecoveryKey(accountId));

            if (pending.NewCustody != null && pending.NewCustody != UInt160.Zero)
            {
                control.Custody = pending.NewCustody;
            }
            control.RecoveryAuthority = UInt160.Zero;
            control.Status = AccountStatusActive;
            control.AuthorityEpoch += BigInteger.One;
            control.ConfigurationNonce += BigInteger.One;
            control.ControlRevision += BigInteger.One;
            control.DefaultOperationAuthorization = true;
            control.DefaultMessageAuthorization = true;
            PutAccountControl(accountId, control);
            // Spec §8/§14: the sweep drops the old 0x57 set (its signers belong
            // to the replaced custody), so recovery REBUILDS the default subject
            // against the NEW custody. It must never leave the account without a
            // usable message subject.
            InitializeDefaultMessageSubjects(accountId, control);

            if (marketBinding != null)
            {
                // The old-epoch Market lock is dead: settle/cancel will reject
                // the epoch mismatch (SA_MARKET_LOCKED) and a later Market
                // claim cleans the physical markers.
                OnMarketLockInvalidated(accountId, marketBinding!.ControlEpoch);
            }
            OnRecoveryExecuted(accountId, control.AuthorityEpoch, control.ConfigurationNonce);
            // §18 reused-event mirror: recovery finalization is the legacy
            // escape finalization (custody rotated, epoch advanced).
            OnEscapeFinalized(accountId, control.Custody!);
        }

        /// <summary>Returns [exists, initiatedAt, matureAt, authorityEpochAtInit, newCustody].</summary>
        [Safe]
        public static object[] getRecoveryStatus(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            CoreRecoveryRecord? record = GetCoreRecoveryRecord(accountId);
            if (record == null) return new object[0];
            return new object[]
            {
                true,
                record!.InitiatedAt,
                record.MatureAt,
                record.AuthorityEpochAtInit,
                record.NewCustody
            };
        }

        // ========================================================================
        // 4. Callback-free account sweep (recovery + Market settle)
        //    Deletes every v4 module-model row of the account without calling
        //    any module: instances (0x52/0x53), hook order (0x54), intents
        //    (0x55/0x5E), nonce channels (0x56/0x5C), message subjects (0x57),
        //    application context (0x58), threshold policies (0x5B), migration
        //    state (0x5A) and the metadata URI (0x0C). The moduleId allocator
        //    in 0x51 is preserved: ids are never reused. The legacy 0x01 row
        //    is left untouched as migration evidence.
        // ========================================================================

        private static void SweepAccountModulesAndPolicies(UInt160 accountId)
        {
            // Module instances: read records first (type needed to delete the
            // 0x53 index rows), then delete; each removal emits its event.
            byte[] instancePrefix = Helper.Concat(Prefix_ModuleInstance, (byte[])accountId);
            BigInteger[] removedIds = new BigInteger[MaxValidatorModuleInstances + MaxHookModuleInstances];
            byte[] removedTypes = new byte[MaxValidatorModuleInstances + MaxHookModuleInstances];
            int removed = 0;
            Iterator it = Storage.Find(Storage.CurrentContext, instancePrefix, FindOptions.KeysOnly | FindOptions.RemovePrefix);
            while (it.Next())
            {
                ExecutionEngine.Assert(removed < removedIds.Length, ErrorOperationMalformed);
                BigInteger moduleId = ModuleIdFromKeyBytes((byte[])(ByteString)it.Value);
                ModuleInstance? module = GetModuleInstance(accountId, moduleId);
                ExecutionEngine.Assert(module != null, ErrorModuleNotInstalled);
                removedIds[removed] = moduleId;
                removedTypes[removed] = module!.ModuleType;
                removed++;
            }
            for (int i = 0; i < removed; i++)
            {
                ModuleInstance module = new ModuleInstance();
                module.ModuleType = removedTypes[i];
                DeleteModuleInstance(accountId, removedIds[i], module);
                OnModuleInstanceRemoved(accountId, removedIds[i]);
            }

            Storage.Delete(Storage.CurrentContext, HookOrderKey(accountId));

            // Pending configuration intents and the unresolved-intent index.
            byte[] intentPrefix = Helper.Concat(Prefix_ConfigIntent, (byte[])accountId);
            Iterator intents = Storage.Find(Storage.CurrentContext, intentPrefix, FindOptions.KeysOnly);
            while (intents.Next())
            {
                Storage.Delete(Storage.CurrentContext, (byte[])intents.Value);
            }
            Storage.Delete(Storage.CurrentContext, ConfigIntentIndexKey(accountId));

            // Threshold policies.
            byte[] policyPrefix = Helper.Concat(Prefix_ThresholdPolicy, (byte[])accountId);
            Iterator policies = Storage.Find(Storage.CurrentContext, policyPrefix, FindOptions.KeysOnly);
            while (policies.Next())
            {
                Storage.Delete(Storage.CurrentContext, (byte[])policies.Value);
            }

            // Message subjects, application context, migration state, metadata.
            Storage.Delete(Storage.CurrentContext, MessageSubjectKey(accountId));
            Storage.Delete(Storage.CurrentContext, ApplicationContextKey(accountId));
            Storage.Delete(Storage.CurrentContext, MigrationStateKey(accountId));
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_MetadataUri, (byte[])accountId));

            // Nonce channels and derived namespace digests (fresh start; ids
            // and generations are never reused, so stale keys cannot alias).
            byte[] cursorPrefix = Helper.Concat(Prefix_NonceCursor, (byte[])accountId);
            Iterator cursors = Storage.Find(Storage.CurrentContext, cursorPrefix, FindOptions.KeysOnly);
            while (cursors.Next())
            {
                Storage.Delete(Storage.CurrentContext, (byte[])cursors.Value);
            }
            byte[] namespacePrefix = Helper.Concat(Prefix_NonceNamespace, (byte[])accountId);
            Iterator namespaces = Storage.Find(Storage.CurrentContext, namespacePrefix, FindOptions.KeysOnly);
            while (namespaces.Next())
            {
                Storage.Delete(Storage.CurrentContext, (byte[])namespaces.Value);
            }
        }
    }
}
