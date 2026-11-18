using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    /// <summary>
    /// Versioned migration core-side state (protocol v4, spec §14 + design
    /// report §4.3).
    ///
    /// The in-place core update (`_deploy(update=true)`) ONLY opens the
    /// versioned migration mode: it never iterates accounts and never calls a
    /// plugin in the upgrade transaction. Once migration mode is open:
    ///
    /// * unmigrated legacy accounts are rejected fail-closed for execution
    ///   and message authorization (SA_MIGRATION_REQUIRED) through
    ///   <see cref="RequireV4AccountControl"/>; queries, freeze and
    ///   callback-free recovery remain reachable;
    /// * keepers mark legacy plugin accounts one by one through the
    ///   permissionless <see cref="markMigrationRequired"/>, materializing
    ///   the 0x51 control in the MigrationRequired status and writing the
    ///   0x5A record (this is the observable MigrationRequired transition —
    ///   the core never sweeps 407 accounts in one transaction);
    /// * the owner imports the approved configuration through a normal 24h
    ///   configuration intent whose ActionMigrateAccount entry (plus sibling
    ///   installModule/setHookOrder/setThresholdPolicy actions) performs the
    ///   atomic, idempotent import and switches the account to Active.
    ///
    /// Unknown plugins are never guess-migrated: the migration action rejects
    /// the `unknown-plugin` classification and such accounts leave
    /// MigrationRequired only through callback-free recovery.
    /// </summary>
    public partial class SmartAccount
    {
        // MigrationStateRecord.Status values.
        private const byte MigrationStatusRequired = 1;
        private const byte MigrationStatusImported = 2;

        // Classifications (docs/SA-MIGRATION-MANIFEST.md). The importable set
        // excludes `unknown-plugin` (fail-closed, never guess-migrated) and
        // `recovery-pending` (the legacy in-flight escape must resolve through
        // cancel or the new callback-free recovery first).
        private const string MigrationClassNoPlugin = "no-plugin";
        private const string MigrationClassScalarPlugin = "scalar-plugin";
        private const string MigrationClassMultihook = "multihook";
        private const string MigrationClassMultisig = "multisig";
        private const string MigrationClassOwnerOnly = "owner-only";
        private const string MigrationClassMarketLocked = "market-locked";

        // ========================================================================
        // 1. Protocol info record (0x50, bare)
        // ========================================================================

        private static object[] GetProtocolInfoRecord()
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, ProtocolInfoKey());
            if (data == null)
            {
                return new object[] { (BigInteger)ModuleProtocolVersion, false };
            }
            return (object[])StdLib.Deserialize(data!);
        }

        private static bool IsMigrationModeOpen()
        {
            object[] info = GetProtocolInfoRecord();
            return info.Length >= 2 && (bool)info[1];
        }

        /// <summary>
        /// Opens the versioned migration mode (idempotent). Called ONLY by
        /// `_deploy(update=true)`: the in-place update itself performs no
        /// per-account work.
        /// </summary>
        private static void OpenVersionedMigration()
        {
            object[] info = GetProtocolInfoRecord();
            if (info.Length >= 2 && (bool)info[1]) return;
            Storage.Put(Storage.CurrentContext, ProtocolInfoKey(),
                StdLib.Serialize(new object[] { (BigInteger)ModuleProtocolVersion, true }));
        }

        // ========================================================================
        // 2. Per-account migration state (0x5A)
        // ========================================================================

        private static MigrationStateRecord? GetMigrationState(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, MigrationStateKey(accountId));
            return data == null ? null : (MigrationStateRecord)StdLib.Deserialize(data!);
        }

        private static void PutMigrationState(UInt160 accountId, MigrationStateRecord state)
        {
            Storage.Put(Storage.CurrentContext, MigrationStateKey(accountId), StdLib.Serialize(state));
        }

        private static bool HasLegacyAccountRow(UInt160 accountId)
        {
            return Storage.Get(Storage.CurrentContext,
                Helper.Concat(Prefix_AccountState, (byte[])accountId)) != null;
        }

        private static BigInteger LegacyModuleCount(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext,
                Helper.Concat(Prefix_AccountState, (byte[])accountId));
            if (data == null) return BigInteger.Zero;
            AccountState state = (AccountState)StdLib.Deserialize(data!);
            BigInteger count = BigInteger.Zero;
            if (state.Verifier != null && state.Verifier != UInt160.Zero) count += BigInteger.One;
            if (state.HookId != null && state.HookId != UInt160.Zero) count += BigInteger.One;
            return count;
        }

        // ========================================================================
        // 3. Fail-closed execution/message gate for unmigrated accounts
        // ========================================================================

        /// <summary>
        /// The migration-aware account gate for execution and message
        /// authorization: an account with a 0x51 control record passes through
        /// (status checks are the caller's); a legacy account that still has
        /// its 0x01 row is rejected with SA_MIGRATION_REQUIRED (old pending
        /// state, old signatures, 0x12 and 0x1C are never authorization
        /// sources); an unknown account fails with SA_ACCOUNT_NOT_FOUND.
        /// </summary>
        private static AccountControl RequireV4AccountControl(UInt160 accountId)
        {
            AccountControl? control = GetAccountControl(accountId);
            if (control != null) return control!;
            if (HasLegacyAccountRow(accountId))
            {
                ExecutionEngine.Assert(false, ErrorMigrationRequired);
            }
            ExecutionEngine.Assert(false, ErrorAccountNotFound);
            return null!;
        }

        /// <summary>
        /// True when the account is an unmigrated legacy account under an open
        /// migration mode (fail-closed for execution and message
        /// authorization; queries, freeze and callback-free recovery stay).
        /// </summary>
        [Safe]
        public static bool isMigrationRequired(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            AccountControl? control = GetAccountControl(accountId);
            if (control != null) return control!.Status == AccountStatusMigrationRequired;
            return HasLegacyAccountRow(accountId) && IsMigrationModeOpen();
        }

        // ========================================================================
        // 4. Keeper-side MigrationRequired marking (permissionless)
        // ========================================================================

        /// <summary>
        /// Marks a legacy account as MigrationRequired: materializes the 0x51
        /// control in the MigrationRequired status and writes the 0x5A record.
        /// Permissionless and idempotent — keepers sweep the legacy account
        /// population one transaction at a time after the core update opens
        /// migration mode; the core never iterates accounts itself. Harmless
        /// for already-imported accounts (no-op).
        /// </summary>
        public static void markMigrationRequired(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            ExecutionEngine.Assert(IsMigrationModeOpen(), ErrorMigrationRequired);
            ExecutionEngine.Assert(HasLegacyAccountRow(accountId), ErrorAccountNotFound);

            MigrationStateRecord? existing = GetMigrationState(accountId);
            if (existing != null && existing!.Status == MigrationStatusImported) return;

            AccountControl control = MaterializeAccountControl(accountId);
            bool alreadyRequired = control.Status == AccountStatusMigrationRequired;
            if (!alreadyRequired)
            {
                control.Status = AccountStatusMigrationRequired;
                PutAccountControl(accountId, control);
            }

            MigrationStateRecord state = existing ?? new MigrationStateRecord();
            state.Status = MigrationStatusRequired;
            if (state.ManifestDigest.Length == 0) state.ManifestDigest = (ByteString)new byte[32];
            if (string.IsNullOrEmpty(state.Classification)) state.Classification = string.Empty;
            if (state.LegacyModuleCount == 0) state.LegacyModuleCount = LegacyModuleCount(accountId);
            state.LegacyScopeInvalidated = true;
            PutMigrationState(accountId, state);

            if (!alreadyRequired)
            {
                OnMigrationRequired(accountId, state.LegacyModuleCount);
            }
        }

        // ========================================================================
        // 5. Migration import action (spec §9 ActionMigrateAccount)
        //    [ActionMigrateAccount, manifestDigest32, classification]
        //    The import payload itself travels as SIBLING actions of the same
        //    configuration intent (installModule / setHookOrder /
        ///   setThresholdPolicy): one atomic, 24h-timelocked proposal.
        // ========================================================================

        private static void ExecuteMigrateAccountAction(UInt160 accountId, AccountControl control, object[] action)
        {
            ExecutionEngine.Assert(action.Length == 3, ErrorOperationMalformed);
            ByteString manifestDigest = (ByteString)action[1];
            string classification = (string)action[2];
            ExecutionEngine.Assert(manifestDigest != null && manifestDigest.Length == 32, ErrorOperationMalformed);

            bool importable =
                classification == MigrationClassNoPlugin
                || classification == MigrationClassScalarPlugin
                || classification == MigrationClassMultihook
                || classification == MigrationClassMultisig
                || classification == MigrationClassOwnerOnly
                || classification == MigrationClassMarketLocked;
            // Unknown plugins are never guess-migrated; a legacy in-flight
            // escape must resolve before the account can import.
            ExecutionEngine.Assert(importable, ErrorMigrationRequired);

            // Only legacy accounts migrate; v4 accounts have nothing to import.
            ExecutionEngine.Assert(HasLegacyAccountRow(accountId), ErrorOperationMalformed);

            // Idempotent against the manifest digest (design §4.3 step 11).
            MigrationStateRecord? existing = GetMigrationState(accountId);
            if (existing != null && existing!.Status == MigrationStatusImported)
            {
                ExecutionEngine.Assert(existing.ManifestDigest == manifestDigest, ErrorOperationMalformed);
                return;
            }

            // A frozen account must be unfrozen before importing.
            ExecutionEngine.Assert(control.Status != AccountStatusFrozen, ErrorAccountFrozen);

            // Market-locked import: bind the escrow lock to the post-migration
            // control revision so the Market can still settle/cancel it under
            // the 0x5D epoch check (design §4.4).
            if (classification == MigrationClassMarketLocked && IsMarketEscrowActive(accountId)
                && GetMarketControlBinding(accountId) == null)
            {
                control.ControlRevision += BigInteger.One;
                MarketControlBinding binding = new MarketControlBinding();
                binding.Market = GetMarketEscrowContract(accountId);
                binding.ListingId = GetMarketEscrowListingId(accountId);
                binding.ControlEpoch = control.ControlRevision;
                PutMarketControlBinding(accountId, binding);
                OnMarketControlEpochBound(accountId, binding.ListingId, binding.ControlEpoch);
            }

            MigrationStateRecord state = existing ?? new MigrationStateRecord();
            state.Status = MigrationStatusImported;
            state.ManifestDigest = manifestDigest!;
            state.Classification = classification;
            state.LegacyModuleCount = LegacyModuleCount(accountId);
            // Explicit invalidation declaration for retired 0x12/0x1C rows
            // (spec §7.4): the bytes exist as evidence only, never as an
            // authorization source.
            state.LegacyScopeInvalidated = true;
            state.ImportedAt = Runtime.Time;
            PutMigrationState(accountId, state);

            // Owner-only imports carry the permanent constraint forward and
            // authorize through the built-in route. No-plugin imports keep
            // operating on the built-in route exactly as their legacy
            // witness-based model did. Plugin imports leave the switches to
            // their sibling installModule actions (the first validator
            // install disables the built-in operation route by default).
            if (classification == MigrationClassOwnerOnly)
            {
                control.OwnerOnlyRecovery = true;
                control.DefaultOperationAuthorization = true;
                control.DefaultMessageAuthorization = true;
            }
            else if (classification == MigrationClassNoPlugin)
            {
                control.DefaultOperationAuthorization = true;
                control.DefaultMessageAuthorization = true;
            }

            // Atomic Active switch (status only; sibling actions install the
            // imported module set inside this same intent).
            control.Status = AccountStatusActive;

            OnMigrationImported(accountId, manifestDigest!, classification);
        }

        // ========================================================================
        // 6. Migration queries
        // ========================================================================

        /// <summary>
        /// Returns the per-account migration state
        /// [status, manifestDigest, classification, legacyModuleCount,
        /// legacyScopeInvalidated, importedAt]; status 0 = not started.
        /// </summary>
        [Safe]
        public static object[] getMigrationState(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            MigrationStateRecord? state = GetMigrationState(accountId);
            if (state == null)
            {
                return new object[] { (BigInteger)0, (ByteString)new byte[0], string.Empty,
                    LegacyModuleCount(accountId), false, (BigInteger)0 };
            }
            return new object[]
            {
                (BigInteger)state!.Status,
                state.ManifestDigest,
                state.Classification,
                state.LegacyModuleCount,
                state.LegacyScopeInvalidated,
                state.ImportedAt
            };
        }
    }
}
