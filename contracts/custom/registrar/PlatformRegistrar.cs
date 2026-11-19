using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    /// <summary>
    /// On-chain platform registrar service for Neo N3 SA.
    ///
    /// The service owns the pending platform-account owner rotations: the proposal
    /// records, their 7-day timelock, and cancellation. Account *state* itself
    /// (deterministic account ids, bindings, proxy indexes, the authoritative
    /// ownership write) stays in the SA core; the registrar orchestrates and the
    /// core re-validates every write through its registrar-gated entry points.
    /// </summary>
    [DisplayName("SAPlatformRegistrar")]
    // The registrar only ever calls its authorized SA core; each fixed callee method is
    // enumerated so the manifest documents the exact core surface it depends on.
    [ContractPermission("*", "computePlatformAccountId")]
    [ContractPermission("*", "computeStablePlatformAccountId")]
    [ContractPermission("*", "registerPlatformAccount")]
    [ContractPermission("*", "registerStablePlatformAccount")]
    [ContractPermission("*", "applyPlatformAccountOwnerRotation")]
    [ContractPermission("*", "getPlatformAccountBinding")]
    [ContractPermission("*", "getAccount")]
    [ManifestExtra("Description", "Platform Account Registrar Service for Neo N3 SA")]
    public class PlatformRegistrar : SmartContract
    {
        // ========================================================================
        // Storage Prefixes
        // ========================================================================

        // Pending platform-account owner rotations, keyed by accountId:
        // Prefix_PendingRotation + accountId -> serialized PendingRotation.
        private static readonly byte[] Prefix_PendingRotation = new byte[] { 0x01 };

        private static readonly BigInteger RotationTimelockMs = 7L * 24 * 60 * 60 * 1000;

        // ========================================================================
        // Data Structures
        // ========================================================================

        public class PendingRotation
        {
            /// <summary>The backup owner the account will rotate to once confirmed.</summary>
            public UInt160 NewBackupOwner = UInt160.Zero;

            /// <summary>
            /// The core backup owner recorded at proposal time. The core's
            /// <c>applyPlatformAccountOwnerRotation</c> rejects the confirmation as stale
            /// when this no longer matches the live account state (e.g. the account was
            /// sold through the market escrow after the proposal).
            /// </summary>
            public UInt160 PreviousOwner = UInt160.Zero;

            /// <summary>The platform app binding the rotation is scoped to.</summary>
            public ByteString AppBinding = (ByteString)new byte[0];

            public BigInteger InitiatedAt;
        }

        // ========================================================================
        // Events
        // ========================================================================

        public delegate void PlatformRotationProposedDelegate(UInt160 accountId, UInt160 previousOwner, UInt160 newOwner, BigInteger availableAt);
        public delegate void PlatformRotationCancelledDelegate(UInt160 accountId);

        [DisplayName("PlatformOwnerRotationProposed")]
        public static event PlatformRotationProposedDelegate OnPlatformRotationProposed = null!;

        [DisplayName("PlatformOwnerRotationCancelled")]
        public static event PlatformRotationCancelledDelegate OnPlatformRotationCancelled = null!;

        // ========================================================================
        // Lifecycle & Authority (delegates to PlatformRegistrarAuthority)
        // ========================================================================

        public static void _deploy(object data, bool update) => PlatformRegistrarAuthority.Initialize(data, update);

        [Safe]
        public static UInt160 AuthorizedCore() => PlatformRegistrarAuthority.AuthorizedCore();

        [Safe]
        public static UInt160 Admin() => PlatformRegistrarAuthority.Admin();

        public static void SetAuthorizedCore(UInt160 coreContract) => PlatformRegistrarAuthority.SetAuthorizedCore(coreContract);

        public static void ProposeAuthorizedCore(UInt160 coreContract) => PlatformRegistrarAuthority.ProposeAuthorizedCore(coreContract);

        public static void ConfirmAuthorizedCore(UInt160 coreContract) => PlatformRegistrarAuthority.ConfirmAuthorizedCore(coreContract);

        public static void CancelAuthorizedCoreChange() => PlatformRegistrarAuthority.CancelAuthorizedCoreChange();

        public static void RotateAdmin(UInt160 newAdmin) => PlatformRegistrarAuthority.RotateAdmin(newAdmin);

        public static void ConfirmAdminRotation(UInt160 newAdmin) => PlatformRegistrarAuthority.ConfirmAdminRotation(newAdmin);

        public static void CancelAdminRotation() => PlatformRegistrarAuthority.CancelAdminRotation();

        // Timelocked contract upgrade (SA-D-01 pattern).
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => PlatformRegistrarAuthority.ProposeUpdate(nefHash, manifestHash);

        public static void ConfirmUpdate(ByteString nef, string manifest) => Update(nef, manifest);

        public static void CancelUpdate() => PlatformRegistrarAuthority.CancelUpdate();

        /// <summary>
        /// Upgrades the registrar contract. Admin-only, and only after a matching
        /// <c>ProposeUpdate</c> has aged past the 7-day timelock.
        /// </summary>
        public static void Update(ByteString nef, string manifest)
        {
            UInt160 admin = PlatformRegistrarAuthority.Admin();
            ExecutionEngine.Assert(admin != UInt160.Zero, "No admin set");
            ExecutionEngine.Assert(Runtime.CheckWitness(admin), "Not admin");
            PlatformRegistrarAuthority.AssertConfirmableUpdate(nef, manifest);
            ContractManagement.Update(nef, manifest);
        }

        // ========================================================================
        // 1. Platform account registration (orchestration)
        // ========================================================================

        /// <summary>
        /// Computes the platform account id on the core and registers it. Admin-only:
        /// platform accounts are created by the platform operator through this service,
        /// and the core's <c>registerPlatformAccount</c> re-checks the registrar pointer,
        /// id determinism, and binding validity.
        /// </summary>
        public static UInt160 RegisterPlatformAccount(ByteString appBinding, UInt160 backupOwner, uint escapeTimelock)
        {
            PlatformRegistrarAuthority.ValidateAdmin();
            UInt160 core = AssertAuthorizedCore();
            UInt160 accountId = (UInt160)Contract.Call(
                core, "computePlatformAccountId", CallFlags.ReadOnly,
                new object[] { appBinding, backupOwner, escapeTimelock });
            Contract.Call(
                core, "registerPlatformAccount", CallFlags.All,
                new object[] { accountId, appBinding, backupOwner, escapeTimelock });
            return accountId;
        }

        /// <summary>
        /// Same as <see cref="RegisterPlatformAccount"/> but for the stable (ownerless)
        /// platform account family: the account id is derived from the app binding alone.
        /// </summary>
        public static UInt160 RegisterStablePlatformAccount(ByteString appBinding, UInt160 backupOwner, uint escapeTimelock)
        {
            PlatformRegistrarAuthority.ValidateAdmin();
            UInt160 core = AssertAuthorizedCore();
            UInt160 accountId = (UInt160)Contract.Call(
                core, "computeStablePlatformAccountId", CallFlags.ReadOnly,
                new object[] { appBinding, escapeTimelock });
            Contract.Call(
                core, "registerStablePlatformAccount", CallFlags.All,
                new object[] { accountId, appBinding, backupOwner, escapeTimelock });
            return accountId;
        }

        // ========================================================================
        // 2. Platform-account owner rotation (service-owned bookkeeping)
        // ========================================================================

        /// <summary>
        /// Starts a delayed platform-account owner rotation. Admin-only: the proposal is
        /// a platform-operator action, and the eventual ownership change still requires
        /// the *new* owner's witness through the core's
        /// <c>applyPlatformAccountOwnerRotation</c>. A pending record whose
        /// <c>PreviousOwner</c> no longer matches the core state (e.g. after a market
        /// sale) is replaceable, so a stale record cannot wedge the account.
        /// </summary>
        public static void ProposePlatformAccountOwnerRotation(UInt160 accountId, ByteString appBinding, UInt160 newBackupOwner)
        {
            PlatformRegistrarAuthority.ValidateAdmin();
            ValidatePlatformBinding(appBinding);
            ExecutionEngine.Assert(
                newBackupOwner != null && newBackupOwner != UInt160.Zero && newBackupOwner.IsValid,
                "Invalid platform backup owner");
            UInt160 core = AssertAuthorizedCore();

            // Fail fast on the same conditions the core will re-validate at apply time.
            ByteString? storedBinding = (ByteString?)Contract.Call(
                core, "getPlatformAccountBinding", CallFlags.ReadOnly,
                new object[] { accountId });
            ExecutionEngine.Assert(storedBinding != null, "Platform account binding not found");
            ExecutionEngine.Assert(
                StdLib.MemoryCompare(storedBinding!, appBinding!) == 0,
                "Platform account binding mismatch");
            object[] control = (object[])Contract.Call(
                core, "getAccount", CallFlags.ReadOnly,
                new object[] { accountId });
            ExecutionEngine.Assert((bool)control[0], "Platform account not registered");
            ExecutionEngine.Assert(!(bool)control[12], "Platform account recovery active");
            ExecutionEngine.Assert(!(bool)control[14], "Account locked in market escrow");

            UInt160 previousOwner = (UInt160)control[2];
            ExecutionEngine.Assert(previousOwner != UInt160.Zero, "Platform account not registered");
            ExecutionEngine.Assert(previousOwner != newBackupOwner, "Platform backup owner unchanged");

            byte[] pendingKey = Helper.Concat(Prefix_PendingRotation, (byte[])accountId);
            ByteString? existingData = Storage.Get(Storage.CurrentContext, pendingKey);
            if (existingData != null)
            {
                PendingRotation existing = (PendingRotation)StdLib.Deserialize(existingData!);
                // Staleness liveness: a record whose recorded owner no longer matches the
                // core state is replaceable; a live record blocks a second concurrent
                // proposal for the same account.
                ExecutionEngine.Assert(existing.PreviousOwner != previousOwner, "Platform owner rotation already pending");
            }

            Storage.Put(Storage.CurrentContext, pendingKey, StdLib.Serialize(new PendingRotation
            {
                NewBackupOwner = newBackupOwner!,
                PreviousOwner = previousOwner,
                AppBinding = appBinding!,
                InitiatedAt = Runtime.Time
            }));
            OnPlatformRotationProposed(
                accountId,
                previousOwner,
                newBackupOwner!,
                Runtime.Time + RotationTimelockMs);
        }

        /// <summary>
        /// Applies a pending rotation after the 7-day delay by calling the core's
        /// registrar-gated <c>applyPlatformAccountOwnerRotation</c>. The core re-validates
        /// the binding, configuration idleness, escrow, escape idleness, the
        /// <c>previousOwner</c> staleness guard, and the new owner's witness; a failed
        /// apply leaves this service's record intact for retry.
        /// </summary>
        public static void ConfirmPlatformAccountOwnerRotation(UInt160 accountId, ByteString appBinding)
        {
            ValidatePlatformBinding(appBinding);
            UInt160 core = AssertAuthorizedCore();
            PendingRotation? pending = ReadPendingRotation(accountId);
            ExecutionEngine.Assert(pending != null, "No pending platform owner rotation");
            ExecutionEngine.Assert(
                StdLib.MemoryCompare(pending!.AppBinding, appBinding!) == 0,
                "Platform account binding mismatch");
            ExecutionEngine.Assert(
                Runtime.Time >= pending.InitiatedAt + RotationTimelockMs,
                "Platform owner rotation timelock not expired");
            Contract.Call(
                core, "applyPlatformAccountOwnerRotation", CallFlags.All,
                new object[] { accountId, appBinding, pending.NewBackupOwner, pending.PreviousOwner });
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingRotation, (byte[])accountId));
        }

        /// <summary>
        /// Cancels a pending rotation. Requires the registrar admin or the account's
        /// current core backup owner to witness the cancellation.
        /// </summary>
        public static void CancelPlatformAccountOwnerRotation(UInt160 accountId, ByteString appBinding)
        {
            ValidatePlatformBinding(appBinding);
            UInt160 core = AssertAuthorizedCore();
            PendingRotation? pending = ReadPendingRotation(accountId);
            ExecutionEngine.Assert(pending != null, "No pending platform owner rotation");
            ExecutionEngine.Assert(
                StdLib.MemoryCompare(pending!.AppBinding, appBinding!) == 0,
                "Platform account binding mismatch");
            object[] control = (object[])Contract.Call(
                core, "getAccount", CallFlags.ReadOnly,
                new object[] { accountId });
            UInt160 currentOwner = (UInt160)control[2];
            bool owner = currentOwner != UInt160.Zero && Runtime.CheckWitness(currentOwner);
            UInt160 admin = PlatformRegistrarAuthority.Admin();
            bool registrarAdmin = admin != UInt160.Zero && Runtime.CheckWitness(admin);
            ExecutionEngine.Assert(owner || registrarAdmin, "Unauthorized platform owner rotation cancellation");
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_PendingRotation, (byte[])accountId));
            OnPlatformRotationCancelled(accountId);
        }

        // ========================================================================
        // 3. State Queries
        // ========================================================================

        [Safe]
        public static object[]? GetPendingPlatformOwnerRotation(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            PendingRotation? pending = ReadPendingRotation(accountId);
            if (pending == null) return null;
            return new object[]
            {
                pending!.NewBackupOwner,
                pending.PreviousOwner,
                pending.InitiatedAt,
                pending.InitiatedAt + RotationTimelockMs
            };
        }

        [Safe]
        public static BigInteger GetPlatformOwnerRotationAvailableAt(UInt160 accountId)
        {
            object[]? pending = GetPendingPlatformOwnerRotation(accountId);
            return pending == null ? 0 : (BigInteger)pending[3];
        }

        // ========================================================================
        // Private Helpers
        // ========================================================================

        private static UInt160 AssertAuthorizedCore()
        {
            UInt160 core = PlatformRegistrarAuthority.AuthorizedCore();
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "SA core not configured");
            return core;
        }

        private static PendingRotation? ReadPendingRotation(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            ByteString? data = Storage.Get(
                Storage.CurrentContext,
                Helper.Concat(Prefix_PendingRotation, (byte[])accountId));
            if (data == null) return null;
            return (PendingRotation)StdLib.Deserialize(data!);
        }

        private static void ValidateAccountId(UInt160 accountId)
        {
            ExecutionEngine.Assert(
                accountId != null && accountId.IsValid && accountId != UInt160.Zero,
                "Invalid account id");
        }

        private static void ValidatePlatformBinding(ByteString appBinding)
        {
            ExecutionEngine.Assert(appBinding != null && appBinding.Length > 0, "Platform app binding required");
            ExecutionEngine.Assert(appBinding!.Length <= 128, "Platform app binding too long");
        }
    }
}
