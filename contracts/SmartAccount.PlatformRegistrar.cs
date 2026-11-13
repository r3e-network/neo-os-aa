using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    public partial class SmartAccount
    {
        // ========================================================================
        // 9. Platform Registrar boundary (service extraction, Phase 1b)
        // ========================================================================
        // Pending platform-account owner rotations moved to the AAPlatformRegistrar
        // service contract (contracts/registrar/). The core keeps the platform account
        // STATE: deterministic id computation, the registrar-gated registration entry
        // points, the registrar pointer with its 7-day timelock, the app binding, and
        // the proxy index. The authoritative ownership write happens only through
        // ApplyPlatformAccountOwnerRotation, gated on the registrar pointer and fully
        // re-validated here.

        private static readonly byte[] Prefix_PlatformRegistrar = new byte[] { 0x17 };
        private static readonly byte[] Prefix_PendingPlatformRegistrar = new byte[] { 0x18 };
        private static readonly byte[] Prefix_PlatformRegistrarTimelock = new byte[] { 0x19 };
        private static readonly byte[] Prefix_PlatformAccountBinding = new byte[] { 0x1E };
        // Reverse index for platform virtual-account witnesses.  The proxy hash
        // is the address that holds the account's assets and appears as the
        // witness/caller at platform contracts; accountId is the AA core's
        // authorization subject.  Only the platform registrar may create this
        // binding, and it is immutable for the lifetime of the account.
        private static readonly byte[] Prefix_PlatformProxyAccount = new byte[] { 0x1F };
        // Phase 1b migration: written by MigratePlatformOwnerRotations only after a
        // prefix scan over the legacy pending-rotation family (0x20) proves no row
        // remains, so a batched orchestration can never strand legacy rows behind the seal.
        private static readonly byte[] Prefix_PlatformOwnerRotationsMigrated = new byte[] { 0x2A };
        private static readonly byte[] StablePlatformAccountOwnerDomain = new byte[] { 0xAA, 0x52, 0x47, 0x02 };
        // Legacy compatibility: pending platform owner rotations under 0x20 were moved to
        // the AAPlatformRegistrar service. This prefix is read-only — consumed exactly once
        // by MigratePlatformOwnerRotations — and never written by the current layout.
        private static readonly byte[] LegacyStoragePrefix20 = new byte[] { 0x20 };

        public delegate void PlatformRegistrarProposalDelegate(UInt160 registrar, BigInteger availableAt);
        public delegate void PlatformAccountOwnerRotationDelegate(UInt160 accountId, UInt160 previousOwner, UInt160 newOwner);
        public delegate void PlatformOwnerRotationsMigratedDelegate(BigInteger accountCount);

        [DisplayName("PlatformRegistrarProposed")]
        public static event PlatformRegistrarProposalDelegate OnPlatformRegistrarProposed = null!;

        [DisplayName("PlatformRegistrarChanged")]
        public static event AdminTransferConfirmedDelegate OnPlatformRegistrarChanged = null!;

        // Audit fix 2026-10-24: the previous name, PlatformRegistrarProposalCancelled,
        // was 34 bytes and Neo caps notification names at 32, so the host threw
        // "Event name size 34 exceeds maximum allowed size of 32 bytes" and the whole
        // CancelPlatformRegistrar call reverted after deleting nothing. The entry
        // could never succeed on a chain. No indexer can have observed the old name
        // because the call that emits it always reverted.
        [DisplayName("PlatformRegistrarCancelled")]
        public static event AccountOnlyDelegate OnPlatformRegistrarCancelled = null!;

        // The proposed/cancelled rotation notifications now live in the registrar
        // service contract (same display names); the core only emits the final
        // ownership change once ApplyPlatformAccountOwnerRotation succeeds.
        [DisplayName("PlatformAccountOwnerRotated")]
        public static event PlatformAccountOwnerRotationDelegate OnPlatformAccountOwnerRotated = null!;

        [DisplayName("PlatformOwnerRotationsMigrated")]
        public static event PlatformOwnerRotationsMigratedDelegate OnPlatformOwnerRotationsMigrated = null!;

        [Safe]
        public static UInt160 ComputePlatformAccountId(ByteString appBinding, UInt160 backupOwner, uint escapeTimelock)
        {
            ValidatePlatformAccountBinding(appBinding);
            return ComputeRegistrationAccountId(UInt160.Zero, appBinding, UInt160.Zero, backupOwner, escapeTimelock);
        }

        [Safe]
        public static UInt160 ComputeStablePlatformAccountId(ByteString appBinding, uint escapeTimelock)
        {
            ValidatePlatformAccountBinding(appBinding);
            return ComputeRegistrationAccountId(
                UInt160.Zero,
                appBinding,
                UInt160.Zero,
                StablePlatformAccountOwner(appBinding),
                escapeTimelock);
        }

        public static void RegisterPlatformAccount(UInt160 accountId, ByteString appBinding, UInt160 backupOwner, uint escapeTimelock)
        {
            AssertPlatformRegistrar();
            ValidatePlatformAccountBinding(appBinding);
            RegisterAccountCore(
                accountId,
                UInt160.Zero,
                appBinding,
                UInt160.Zero,
                backupOwner!,
                escapeTimelock,
                false);
            Storage.Put(
                Storage.CurrentContext,
                Helper.Concat(Prefix_PlatformAccountBinding, (ByteString)accountId),
                appBinding);
            IndexPlatformProxy(accountId);
        }

        public static void RegisterStablePlatformAccount(UInt160 accountId, ByteString appBinding, UInt160 backupOwner, uint escapeTimelock)
        {
            AssertPlatformRegistrar();
            ValidatePlatformAccountBinding(appBinding);
            ExecutionEngine.Assert(
                backupOwner != null && backupOwner != UInt160.Zero && backupOwner.IsValid,
                "Invalid platform backup owner");
            RegisterAccountCore(
                accountId,
                UInt160.Zero,
                appBinding,
                UInt160.Zero,
                backupOwner!,
                escapeTimelock,
                false,
                ComputeStablePlatformAccountId(appBinding, escapeTimelock));
            Storage.Put(
                Storage.CurrentContext,
                Helper.Concat(Prefix_PlatformAccountBinding, (ByteString)accountId),
                appBinding);
            IndexPlatformProxy(accountId);
        }

        /// <summary>
        /// Applies a platform-account owner rotation proposed by the registrar service.
        /// This is the only state-changing platform entry besides registration: the
        /// registrar holds the timelock record, and the core re-validates everything it
        /// owns before writing — binding match, configuration idleness, no market escrow,
        /// escape idleness, the <paramref name="previousOwner"/> staleness guard, and the
        /// new owner's witness. A pre-sale rotation therefore can never be confirmed
        /// against a sold account.
        /// </summary>
        public static void ApplyPlatformAccountOwnerRotation(
            UInt160 accountId,
            ByteString appBinding,
            UInt160 newBackupOwner,
            UInt160 previousOwner)
        {
            AssertPlatformRegistrar();
            ValidatePlatformAccountBinding(appBinding);
            ExecutionEngine.Assert(
                newBackupOwner != null && newBackupOwner != UInt160.Zero && newBackupOwner.IsValid,
                "Invalid platform backup owner");
            AssertAccountConfigurationIdle(accountId!);

            byte[] bindingKey = Helper.Concat(Prefix_PlatformAccountBinding, (ByteString)accountId);
            ByteString? storedBinding = Storage.Get(Storage.CurrentContext, bindingKey);
            ExecutionEngine.Assert(storedBinding != null, "Platform account binding not found");
            ExecutionEngine.Assert(
                StdLib.MemoryCompare(storedBinding!, appBinding!) == 0,
                "Platform account binding mismatch");
            AssertNoMarketEscrow(accountId);

            AccountState state = GetAccountState(accountId);
            ExecutionEngine.Assert(state.EscapeTriggeredAt == 0, "Platform account escape active");
            ExecutionEngine.Assert(
                previousOwner != null && previousOwner == state.BackupOwner,
                "Platform owner rotation stale");
            ExecutionEngine.Assert(state.BackupOwner != newBackupOwner, "Platform backup owner unchanged");
            ExecutionEngine.Assert(Runtime.CheckWitness(newBackupOwner!), "New platform owner witness required");
            state.BackupOwner = newBackupOwner!;
            Storage.Put(
                Storage.CurrentContext,
                Helper.Concat(Prefix_AccountState, (ByteString)accountId),
                StdLib.Serialize(state));
            OnPlatformAccountOwnerRotated(accountId, previousOwner!, newBackupOwner!);
        }

        /// <summary>
        /// One-time migration of the legacy core-side pending platform owner rotations
        /// (prefix 0x20) into the registrar service's storage. Admin-gated; the
        /// <c>0x2A</c> flag makes it strictly one-shot. Migrated records keep their
        /// original <c>InitiatedAt</c>, so an in-flight rotation cannot be re-armed by
        /// the migration. Accounts without a pending row are skipped, but a listed
        /// account whose binding row is missing aborts the whole run.
        /// </summary>
        /// <remarks>
        /// Scan-based seal (audit High 1 / Medium 2): the <c>0x2A</c> flag is written only
        /// after a <see cref="Storage.Find"/> scan over the legacy 0x20 family proves that
        /// no row remains anywhere — not merely that the accounts listed in this call
        /// were processed. A batched orchestration therefore cannot strand rows behind
        /// the seal: a batch that leaves legacy rows behind simply returns unsealed, and
        /// the batch that empties the family writes the flag, after which the strictly
        /// one-shot entry assertion rejects any further run. This matters because the
        /// upgraded core never reads 0x20 again, so a row stranded behind an early seal
        /// would be permanently unmigratable.
        /// </remarks>
        public static void MigratePlatformOwnerRotations(UInt160[] accountIds)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(
                Storage.Get(Storage.CurrentContext, Prefix_PlatformOwnerRotationsMigrated) == null,
                "Platform owner rotations already migrated");
            UInt160 registrar = GetPlatformRegistrar();
            ExecutionEngine.Assert(registrar != UInt160.Zero, "Platform registrar not set");
            ExecutionEngine.Assert(accountIds != null && accountIds.Length > 0, "No accounts to migrate");

            BigInteger migrated = 0;
            foreach (UInt160 accountId in accountIds!)
            {
                byte[] pendingKey = Helper.Concat(LegacyStoragePrefix20, (byte[])accountId);
                ByteString? data = Storage.Get(Storage.CurrentContext, pendingKey);
                if (data == null) continue;
                PendingPlatformOwnerRotation pending = (PendingPlatformOwnerRotation)StdLib.Deserialize(data!);
                ByteString? binding = Storage.Get(
                    Storage.CurrentContext,
                    Helper.Concat(Prefix_PlatformAccountBinding, (byte[])accountId));
                ExecutionEngine.Assert(binding != null, "Platform account binding not found");
                UInt160 previousOwner = GetAccountState(accountId).BackupOwner;
                Contract.Call(
                    registrar,
                    "ingestPendingPlatformOwnerRotation",
                    CallFlags.All,
                    new object[]
                    {
                        accountId,
                        binding!,
                        pending.NewBackupOwner,
                        previousOwner,
                        pending.InitiatedAt
                    });
                Storage.Delete(Storage.CurrentContext, pendingKey);
                migrated++;
            }

            // The seal is derived from storage, not from the caller's batch position: only
            // a batch that empties the legacy family may write the flag, and a batch that
            // leaves rows behind returns unsealed so a later batch can pick them up.
            if (AnyLegacyOwnerRotationRowRemains()) return;

            Storage.Put(Storage.CurrentContext, Prefix_PlatformOwnerRotationsMigrated, new byte[] { 1 });
            OnPlatformOwnerRotationsMigrated(migrated);
        }

        /// <summary>
        /// Returns true once the legacy core-side pending platform owner rotations have been
        /// fully migrated and sealed. Read by the migration orchestration (and its report) to
        /// verify that a batched run actually drained the legacy 0x20 family before the seal.
        /// </summary>
        [Safe]
        public static bool IsPlatformOwnerRotationsMigrated()
        {
            return Storage.Get(Storage.CurrentContext, Prefix_PlatformOwnerRotationsMigrated) != null;
        }

        /// <summary>
        /// Resolves a platform virtual-account witness address to its AA
        /// account identifier.  The result is only populated by the trusted
        /// platform registrar during account creation; callers cannot register
        /// or overwrite an index row.
        /// </summary>
        [Safe]
        public static UInt160 GetAccountIdByProxy(UInt160 proxy)
        {
            ExecutionEngine.Assert(proxy != null && proxy.IsValid && proxy != UInt160.Zero,
                "Invalid platform proxy");
            ByteString? value = Storage.Get(
                Storage.CurrentContext,
                Helper.Concat(Prefix_PlatformProxyAccount, (ByteString)(byte[])proxy!));
            return value == null ? UInt160.Zero : (UInt160)value;
        }

        /// <summary>
        /// Returns the app binding of a platform account, or null when the account id is
        /// not a platform account. Read by the registrar service to scope rotation
        /// proposals without trusting the caller-supplied binding.
        /// </summary>
        [Safe]
        public static ByteString? GetPlatformAccountBinding(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            return Storage.Get(
                Storage.CurrentContext,
                Helper.Concat(Prefix_PlatformAccountBinding, (ByteString)accountId));
        }

        public static void ProposePlatformRegistrar(UInt160 registrar)
        {
            ValidateAdmin();
            AssertGlobalConfigurationIdle();
            ExecutionEngine.Assert(registrar != null && registrar != UInt160.Zero && registrar.IsValid, "Invalid platform registrar");
            ExecutionEngine.Assert(ContractManagement.GetContract(registrar!) != null, "platform registrar not deployed");
            ExecutionEngine.Assert(registrar != GetPlatformRegistrar(), "Platform registrar unchanged");
            Storage.Put(Storage.CurrentContext, Prefix_PendingPlatformRegistrar, (ByteString)(byte[])registrar!);
            Storage.Put(Storage.CurrentContext, Prefix_PlatformRegistrarTimelock, Runtime.Time);
            OnPlatformRegistrarProposed(registrar!, Runtime.Time + MinUpgradeDelayMs);
        }

        public static void ConfirmPlatformRegistrar()
        {
            ValidateAdmin();
            AssertGlobalConfigurationIdle();
            ByteString? pending = Storage.Get(Storage.CurrentContext, Prefix_PendingPlatformRegistrar);
            ExecutionEngine.Assert(pending != null, "No pending platform registrar");
            ByteString? proposedAt = Storage.Get(Storage.CurrentContext, Prefix_PlatformRegistrarTimelock);
            ExecutionEngine.Assert(proposedAt != null, "No platform registrar timelock");
            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)proposedAt! + MinUpgradeDelayMs, "Platform registrar timelock not expired");
            UInt160 previous = GetPlatformRegistrar();
            UInt160 registrar = (UInt160)pending!;
            Storage.Put(Storage.CurrentContext, Prefix_PlatformRegistrar, (ByteString)(byte[])registrar);
            Storage.Delete(Storage.CurrentContext, Prefix_PendingPlatformRegistrar);
            Storage.Delete(Storage.CurrentContext, Prefix_PlatformRegistrarTimelock);
            OnPlatformRegistrarChanged(previous, registrar);
        }

        public static void CancelPlatformRegistrar()
        {
            ValidateAdmin();
            AssertGlobalConfigurationIdle();
            Storage.Delete(Storage.CurrentContext, Prefix_PendingPlatformRegistrar);
            Storage.Delete(Storage.CurrentContext, Prefix_PlatformRegistrarTimelock);
            OnPlatformRegistrarCancelled(GetPlatformRegistrar());
        }

        [Safe]
        public static UInt160 GetPlatformRegistrar()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_PlatformRegistrar);
            return value == null ? UInt160.Zero : (UInt160)value;
        }

        [Safe]
        public static UInt160 GetPendingPlatformRegistrar()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_PendingPlatformRegistrar);
            return value == null ? UInt160.Zero : (UInt160)value;
        }

        [Safe]
        public static BigInteger GetPlatformRegistrarAvailableAt()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_PlatformRegistrarTimelock);
            return value == null ? 0 : (BigInteger)value + MinUpgradeDelayMs;
        }

        private static void AssertPlatformRegistrar()
        {
            UInt160 registrar = GetPlatformRegistrar();
            ExecutionEngine.Assert(registrar != UInt160.Zero, "Platform registrar not set");
            ExecutionEngine.Assert(Runtime.CallingScriptHash == registrar, "Unauthorized platform registrar");
        }

        /// <summary>
        /// Scans the legacy pending-rotation family for any remaining row. The migration
        /// seal may only be written when this returns false.
        /// </summary>
        private static bool AnyLegacyOwnerRotationRowRemains()
        {
            Iterator iterator = Storage.Find(
                Storage.CurrentContext, LegacyStoragePrefix20, FindOptions.KeysOnly);
            return iterator.Next();
        }

        private static void IndexPlatformProxy(UInt160 accountId)
        {
            UInt160 proxy = GetProxyScriptHash(accountId);
            byte[] key = Helper.Concat(Prefix_PlatformProxyAccount, (ByteString)(byte[])proxy);
            ByteString? existing = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(existing == null || (UInt160)existing == accountId,
                "Platform proxy already bound");
            Storage.Put(Storage.CurrentContext, key, (ByteString)(byte[])accountId);
        }

        private static UInt160 StablePlatformAccountOwner(ByteString appBinding)
        {
            ByteString payload = Helper.Concat(
                (ByteString)StablePlatformAccountOwnerDomain,
                appBinding);
            byte[] hash = (byte[])CryptoLib.Ripemd160(
                (ByteString)CryptoLib.Sha256(payload));
            return (UInt160)(ByteString)ReverseBytes(hash);
        }

        private static void ValidatePlatformAccountBinding(ByteString appBinding)
        {
            ExecutionEngine.Assert(appBinding != null && appBinding.Length > 0, "Platform app binding required");
            ByteString binding = appBinding!;
            ExecutionEngine.Assert(binding.Length <= 128, "Platform app binding too long");
        }
    }
}
