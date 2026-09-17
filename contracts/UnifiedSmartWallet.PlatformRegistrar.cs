using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount
{
    public partial class UnifiedSmartWallet
    {
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
        private static readonly byte[] StablePlatformAccountOwnerDomain = new byte[] { 0xAA, 0x52, 0x47, 0x02 };

        public delegate void PlatformRegistrarProposalDelegate(UInt160 registrar, BigInteger availableAt);
        public delegate void PlatformAccountOwnerRotationDelegate(UInt160 accountId, UInt160 previousOwner, UInt160 newOwner);

        [DisplayName("PlatformRegistrarProposed")]
        public static event PlatformRegistrarProposalDelegate OnPlatformRegistrarProposed = null!;

        [DisplayName("PlatformRegistrarChanged")]
        public static event AdminTransferConfirmedDelegate OnPlatformRegistrarChanged = null!;

        [DisplayName("PlatformRegistrarProposalCancelled")]
        public static event AccountOnlyDelegate OnPlatformRegistrarProposalCancelled = null!;

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

        public static void RotatePlatformAccountOwner(UInt160 accountId, ByteString appBinding, UInt160 newBackupOwner)
        {
            AssertPlatformRegistrar();
            ValidatePlatformAccountBinding(appBinding);
            ExecutionEngine.Assert(
                newBackupOwner != null && newBackupOwner != UInt160.Zero && newBackupOwner.IsValid,
                "Invalid platform backup owner");

            byte[] bindingKey = Helper.Concat(Prefix_PlatformAccountBinding, (ByteString)accountId);
            ByteString? storedBinding = Storage.Get(Storage.CurrentContext, bindingKey);
            ExecutionEngine.Assert(storedBinding != null, "Platform account binding not found");
            ExecutionEngine.Assert(
                StdLib.MemoryCompare(storedBinding!, appBinding!) == 0,
                "Platform account binding mismatch");
            AssertNoMarketEscrow(accountId);
            AccountState state = GetAccountState(accountId);
            ExecutionEngine.Assert(state.EscapeTriggeredAt == 0, "Platform account escape active");

            UInt160 previousOwner = state.BackupOwner;
            ExecutionEngine.Assert(previousOwner != newBackupOwner, "Platform backup owner unchanged");
            state.BackupOwner = newBackupOwner!;
            Storage.Put(
                Storage.CurrentContext,
                Helper.Concat(Prefix_AccountState, (ByteString)accountId),
                StdLib.Serialize(state));
            OnPlatformAccountOwnerRotated(accountId, previousOwner, newBackupOwner!);
        }

        public static void ProposePlatformRegistrar(UInt160 registrar)
        {
            ValidateAdmin();
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
            Storage.Delete(Storage.CurrentContext, Prefix_PendingPlatformRegistrar);
            Storage.Delete(Storage.CurrentContext, Prefix_PlatformRegistrarTimelock);
            OnPlatformRegistrarProposalCancelled(GetPlatformRegistrar());
        }

        [Safe]
        public static UInt160 GetPlatformRegistrar()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_PlatformRegistrar);
            return value == null ? UInt160.Zero : (UInt160)value;
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
