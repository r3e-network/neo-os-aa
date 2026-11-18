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
        // Pending platform-account owner rotations moved to the SAPlatformRegistrar
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
        // witness/caller at platform contracts; accountId is the SA core's
        // authorization subject.  Only the platform registrar may create this
        // binding, and it is immutable for the lifetime of the account.
        private static readonly byte[] Prefix_PlatformProxyAccount = new byte[] { 0x1F };
        private static readonly byte[] StablePlatformAccountOwnerDomain = new byte[] { 0xAA, 0x52, 0x47, 0x02 };

        public delegate void PlatformRegistrarProposalDelegate(UInt160 registrar, BigInteger availableAt);
        public delegate void PlatformAccountOwnerRotationDelegate(UInt160 accountId, UInt160 previousOwner, UInt160 newOwner);

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
            // v4 registration core with the registrar's own authorization
            // (caller identity) and the LEGACY deterministic identity, so
            // platform account ids stay stable across the v4 upgrade. The
            // app binding doubles as the registration salt.
            CreateAccountCore(
                accountId,
                backupOwner!,
                appBinding,
                (BigInteger)escapeTimelock * 1000,
                new object[0],
                false,
                ComputePlatformAccountId(appBinding, backupOwner, escapeTimelock));
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
            // v4 registration core with the registrar's authorization (caller
            // identity) and the pinned stable platform identity.
            CreateAccountCore(
                accountId,
                backupOwner!,
                appBinding,
                (BigInteger)escapeTimelock * 1000,
                new object[0],
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

            // Rotation is custody-gated state change on the v4 control
            // record: frozen or migration-required accounts refuse it, a
            // pending recovery refuses it, and the control epoch advances so
            // stale intents and signatures die with the old custody.
            AccountControl control = MaterializeAccountControl(accountId!);
            ExecutionEngine.Assert(control.Status == AccountStatusActive, ErrorAccountStatus);
            ExecutionEngine.Assert(GetCoreRecoveryRecord(accountId) == null, "Platform account recovery active");
            ExecutionEngine.Assert(
                previousOwner != null && previousOwner == control.Custody,
                "Platform owner rotation stale");
            ExecutionEngine.Assert(control.Custody != newBackupOwner, "Platform backup owner unchanged");
            ExecutionEngine.Assert(Runtime.CheckWitness(newBackupOwner!), "New platform owner witness required");
            control.Custody = newBackupOwner!;
            control.AuthorityEpoch += BigInteger.One;
            control.ConfigurationNonce += BigInteger.One;
            control.ControlRevision += BigInteger.One;
            PutAccountControl(accountId!, control);

            // Keep the legacy five-field row truthful as migration input when
            // it still exists (pre-upgrade platform account).
            byte[] legacyKey = Helper.Concat(Prefix_AccountState, (ByteString)accountId);
            ByteString? legacyRow = Storage.Get(Storage.CurrentContext, legacyKey);
            if (legacyRow != null)
            {
                AccountState state = (AccountState)StdLib.Deserialize(legacyRow!);
                state.BackupOwner = newBackupOwner!;
                Storage.Put(Storage.CurrentContext, legacyKey, StdLib.Serialize(state));
            }
            OnPlatformAccountOwnerRotated(accountId, previousOwner!, newBackupOwner!);
        }

        /// <summary>
        /// Resolves a platform virtual-account witness address to its SA
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
