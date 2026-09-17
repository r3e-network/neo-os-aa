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
        private static readonly byte[] Prefix_ContractAdmin = new byte[] { 0x11 };

        // AA-D-01: the core contract upgrade is timelocked. A single admin key must not be
        // able to instantly replace the authorization logic of EVERY bound account — that
        // contradicts the timelocked plugin upgrades (UpdateHook/ConfirmHookUpdate) and the
        // verifier authority upgrades (VerifierAuthority.ProposeUpdate/Update). The admin
        // first proposes the sha256 of the new NEF and manifest, then can only apply that
        // exact artifact pair after a >= 7-day window, giving account owners an escape
        // window. These prefixes were never written by previous deployments.
        private static readonly byte[] Prefix_PendingUpdateNefHash = new byte[] { 0x1A };
        private static readonly byte[] Prefix_PendingUpdateManifestHash = new byte[] { 0x1B };
        private static readonly byte[] Prefix_UpdateTimelock = new byte[] { 0x14 };
        private static readonly BigInteger MinUpgradeDelayMs = 7L * 24 * 60 * 60 * 1000;

        // AA-D-02: rotating the contract admin is itself timelocked. An instant Storage.Put
        // hand-off (the old TransferAdmin) was inconsistent with every other privileged role
        // rotation in the project (VerifierAuthority / HookAuthority / PaymasterAuthority all
        // use ProposeAdminTransfer/RotateAdmin -> a 7-day window -> ConfirmAdminRotation gated
        // on CheckWitness(newAdmin)). It also let a leaked admin key silently and instantly
        // burn the role to an address nobody controls. The hardened flow proposes the new
        // admin (current-admin-gated), then requires the new admin to confirm in person after
        // the same >= 7-day window, giving account owners an escape window and proving the new
        // admin key is live before the role moves. These prefixes were never written by
        // previous deployments. Reuses MinUpgradeDelayMs so the rotation window matches the
        // upgrade window.
        private static readonly byte[] Prefix_PendingContractAdmin = new byte[] { 0x15 };
        private static readonly byte[] Prefix_AdminTransferTimelock = new byte[] { 0x16 };

        public delegate void AdminTransferDelegate(UInt160 currentAdmin, UInt160 newAdmin, BigInteger availableAt);

        [DisplayName("AdminTransferProposed")]
        public static event AdminTransferDelegate OnAdminTransferProposed = null!;

        public delegate void AdminTransferConfirmedDelegate(UInt160 previousAdmin, UInt160 newAdmin);

        [DisplayName("AdminTransferConfirmed")]
        public static event AdminTransferConfirmedDelegate OnAdminTransferConfirmed = null!;

        [DisplayName("AdminTransferCancelled")]
        public static event AccountOnlyDelegate OnAdminTransferCancelled = null!;

        public static void _deploy(object data, bool update)
        {
            if (update) return;
            Storage.Put(Storage.CurrentContext, Prefix_ContractAdmin, (ByteString)(byte[])Runtime.Transaction.Sender);
        }

        /// <summary>
        /// Proposes a timelocked contract upgrade by pinning the sha256 of the new NEF and
        /// manifest. The proposal can only be applied via <see cref="Update"/> after the
        /// 7-day window elapses, and only with the exact artifact pair that hashes to the
        /// pinned values. Re-proposing overwrites the pending proposal and restarts the window.
        /// </summary>
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(nefHash != UInt256.Zero && nefHash.IsValid, "Invalid NEF hash");
            ExecutionEngine.Assert(manifestHash != UInt256.Zero && manifestHash.IsValid, "Invalid manifest hash");
            Storage.Delete(Storage.CurrentContext, LegacyStoragePrefix12);
            Storage.Delete(Storage.CurrentContext, LegacyStoragePrefix13);
            Storage.Put(Storage.CurrentContext, Prefix_PendingUpdateNefHash, (byte[])nefHash);
            Storage.Put(Storage.CurrentContext, Prefix_PendingUpdateManifestHash, (byte[])manifestHash);
            Storage.Put(Storage.CurrentContext, Prefix_UpdateTimelock, Runtime.Time);
        }

        /// <summary>Clears the pending upgrade proposal without applying it.</summary>
        public static void CancelUpdate()
        {
            ValidateAdmin();
            Storage.Delete(Storage.CurrentContext, Prefix_PendingUpdateNefHash);
            Storage.Delete(Storage.CurrentContext, Prefix_PendingUpdateManifestHash);
            Storage.Delete(Storage.CurrentContext, LegacyStoragePrefix12);
            Storage.Delete(Storage.CurrentContext, LegacyStoragePrefix13);
            Storage.Delete(Storage.CurrentContext, Prefix_UpdateTimelock);
        }

        /// <summary>
        /// Applies a previously proposed contract upgrade. Requires an existing proposal, the
        /// elapsed 7-day timelock, and that the supplied NEF/manifest hash to the pinned
        /// values. There is intentionally no instant upgrade path. The proposal is single-use:
        /// the next upgrade needs a fresh <see cref="ProposeUpdate"/> plus another window.
        /// </summary>
        public static void Update(ByteString nef, string manifest)
        {
            ValidateAdmin();
            ByteString? pendingNef = GetPendingUpdateNefHash();
            ExecutionEngine.Assert(pendingNef != null, "No pending update");
            ByteString? pendingManifest = GetPendingUpdateManifestHash();
            ExecutionEngine.Assert(pendingManifest != null, "No pending update");
            ByteString? timelockData = Storage.Get(Storage.CurrentContext, Prefix_UpdateTimelock);
            ExecutionEngine.Assert(timelockData != null, "No timelock set");
            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)timelockData! + MinUpgradeDelayMs, "Update timelock not expired");
            ExecutionEngine.Assert((UInt256)CryptoLib.Sha256(nef) == (UInt256)pendingNef!, "NEF hash mismatch");
            ExecutionEngine.Assert((UInt256)CryptoLib.Sha256(manifest) == (UInt256)pendingManifest!, "Manifest hash mismatch");
            Storage.Delete(Storage.CurrentContext, Prefix_PendingUpdateNefHash);
            Storage.Delete(Storage.CurrentContext, Prefix_PendingUpdateManifestHash);
            Storage.Delete(Storage.CurrentContext, LegacyStoragePrefix12);
            Storage.Delete(Storage.CurrentContext, LegacyStoragePrefix13);
            Storage.Delete(Storage.CurrentContext, Prefix_UpdateTimelock);
            ContractManagement.Update(nef, manifest);
        }

        private static ByteString? GetPendingUpdateNefHash()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_PendingUpdateNefHash);
            return value ?? Storage.Get(Storage.CurrentContext, LegacyStoragePrefix12);
        }

        private static ByteString? GetPendingUpdateManifestHash()
        {
            ByteString? value = Storage.Get(Storage.CurrentContext, Prefix_PendingUpdateManifestHash);
            return value ?? Storage.Get(Storage.CurrentContext, LegacyStoragePrefix13);
        }

        /// <summary>Alias for <see cref="Update"/>, mirroring the verifier/hook upgrade naming.</summary>
        public static void ConfirmUpdate(ByteString nef, string manifest)
        {
            Update(nef, manifest);
        }

        [Safe]
        public static UInt160 GetContractAdmin()
        {
            ByteString? val = Storage.Get(Storage.CurrentContext, Prefix_ContractAdmin);
            return val == null ? UInt160.Zero : (UInt160)val;
        }

        /// <summary>
        /// Proposes a timelocked transfer of the contract admin role. The current admin pins the
        /// proposed successor; the transfer can only be applied via <see cref="ConfirmAdminTransfer"/>
        /// after the <see cref="MinUpgradeDelayMs"/> (7-day) window elapses, and only by the proposed
        /// admin itself. There is intentionally no instant transfer path, mirroring the project's
        /// existing authority rotations (e.g. <c>HookAuthority.RotateAdmin/ConfirmAdminRotation</c>).
        /// Re-proposing overwrites the pending proposal and restarts the window.
        /// </summary>
        public static void ProposeAdminTransfer(UInt160 newAdmin)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(newAdmin != null && newAdmin != UInt160.Zero && newAdmin.IsValid, "Invalid admin");
            UInt160 current = (UInt160)Storage.Get(Storage.CurrentContext, Prefix_ContractAdmin)!;
            ExecutionEngine.Assert(newAdmin != current, "New admin must differ from current");
            Storage.Put(Storage.CurrentContext, Prefix_PendingContractAdmin, (ByteString)(byte[])newAdmin!);
            Storage.Put(Storage.CurrentContext, Prefix_AdminTransferTimelock, Runtime.Time);
            OnAdminTransferProposed(current, newAdmin!, Runtime.Time + MinUpgradeDelayMs);
        }

        /// <summary>Clears a pending admin-transfer proposal without applying it. Current-admin gated.</summary>
        public static void CancelAdminTransfer()
        {
            ValidateAdmin();
            Storage.Delete(Storage.CurrentContext, Prefix_PendingContractAdmin);
            Storage.Delete(Storage.CurrentContext, Prefix_AdminTransferTimelock);
            OnAdminTransferCancelled(GetContractAdmin());
        }

        /// <summary>
        /// Applies a previously proposed admin transfer. Requires an existing proposal, the elapsed
        /// 7-day timelock, and the witness of the proposed admin (so the role can only move to a key
        /// that is provably live and consents). The proposal is single-use: a further transfer needs a
        /// fresh <see cref="ProposeAdminTransfer"/> plus another window.
        /// </summary>
        public static void ConfirmAdminTransfer()
        {
            ByteString? pending = Storage.Get(Storage.CurrentContext, Prefix_PendingContractAdmin);
            ExecutionEngine.Assert(pending != null, "No pending admin transfer");
            ByteString? timelockData = Storage.Get(Storage.CurrentContext, Prefix_AdminTransferTimelock);
            ExecutionEngine.Assert(timelockData != null, "No timelock set");
            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)timelockData! + MinUpgradeDelayMs, "Admin transfer timelock not expired");
            UInt160 newAdmin = (UInt160)pending!;
            ExecutionEngine.Assert(Runtime.CheckWitness(newAdmin), "New admin must confirm transfer");
            UInt160 previousAdmin = GetContractAdmin();
            Storage.Put(Storage.CurrentContext, Prefix_ContractAdmin, (ByteString)(byte[])newAdmin);
            Storage.Delete(Storage.CurrentContext, Prefix_PendingContractAdmin);
            Storage.Delete(Storage.CurrentContext, Prefix_AdminTransferTimelock);
            OnAdminTransferConfirmed(previousAdmin, newAdmin);
        }

        /// <summary>The pending proposed admin, or <see cref="UInt160.Zero"/> when no transfer is pending.</summary>
        [Safe]
        public static UInt160 GetPendingContractAdmin()
        {
            ByteString? val = Storage.Get(Storage.CurrentContext, Prefix_PendingContractAdmin);
            return val == null ? UInt160.Zero : (UInt160)val;
        }

        /// <summary>Block time (ms) at which a pending admin transfer may be confirmed, or 0 when none is pending.</summary>
        [Safe]
        public static BigInteger GetAdminTransferAvailableAt()
        {
            ByteString? timelockData = Storage.Get(Storage.CurrentContext, Prefix_AdminTransferTimelock);
            return timelockData == null ? 0 : (BigInteger)timelockData + MinUpgradeDelayMs;
        }

        private static void ValidateAdmin()
        {
            ByteString? admin = Storage.Get(Storage.CurrentContext, Prefix_ContractAdmin);
            ExecutionEngine.Assert(admin != null, "No admin set");
            UInt160 adminHash = (UInt160)admin!;
            ExecutionEngine.Assert(Runtime.CheckWitness(adminHash), "Not admin");
        }
    }
}
