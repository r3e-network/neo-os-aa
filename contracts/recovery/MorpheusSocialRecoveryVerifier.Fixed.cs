using System;
using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace Neo.SmartContract.Examples
{
    [ManifestExtra("Author", "R3E Network")]
    [ManifestExtra("Description", "Morpheus NeoDID-powered social recovery verifier for Neo Abstract Account")]
    [ManifestExtra("Version", "2.0.0")]
    // AA-03: least-privilege method-scoped grants replacing the former wildcard.
    // Call surface (verified by source sweep):
    //   1. ContractManagement.Update          — the 7-day-timelocked self-upgrade
    //   2. core.getBackupOwner                — AA-06 setup-time ownership attestation
    //   3. oracle.request                     — recovery/action ticket submission
    //   4. GAS.transfer                       — Lifecycle credit deposits forwarded to the oracle
    [ContractPermission("0xfffdc93764dbaddd97c48f252a53ea4643faa3fd", "update")]
    [ContractPermission("*", "getBackupOwner")]
    [ContractPermission("*", "canExecuteVerifier")]
    [ContractPermission("*", "request")]
    [ContractPermission("0xd2a4cff31913016155e38e474a2c06d08be276cf", "transfer")]
    [DisplayName("SocialRecoveryVerifier")]
    public partial class SocialRecoveryVerifier : Framework.SmartContract
    {
        private const byte PREFIX_OWNER = 0x01;
        private const byte PREFIX_AA_CONTRACT = 0x02;
        private const byte PREFIX_ACCOUNT_ADDRESS = 0x03;
        private const byte PREFIX_NETWORK = 0x04;
        private const byte PREFIX_ACCOUNT_ID_TEXT = 0x05;
        private const byte PREFIX_THRESHOLD = 0x06;
        private const byte PREFIX_TIMELOCK = 0x07;
        private const byte PREFIX_MORPHEUS_VERIFIER = 0x08;
        private const byte PREFIX_RECOVERY_NONCE = 0x09;
        private const byte PREFIX_FACTORS = 0x0A;
        private const byte PREFIX_USED_ACTION = 0x0B;
        private const byte PREFIX_APPROVAL = 0x0C;
        private const byte PREFIX_MORPHEUS_ORACLE = 0x0D;
        private const byte PREFIX_PENDING = 0x0E;
        private const byte PREFIX_ORACLE_REQUEST = 0x0F;
        private const byte PREFIX_SESSION_NONCE = 0x10;
        private const byte PREFIX_ACTIVE_SESSION = 0x11;
        private const byte PREFIX_ORACLE_ACTION_REQUEST = 0x12;
        private const byte PREFIX_PENDING_NEW_OWNER = 0x13;
        private const byte PREFIX_PENDING_NONCE = 0x14;
        private const byte PREFIX_PENDING_APPROVED = 0x15;
        private const byte PREFIX_PENDING_INITIATED = 0x16;
        private const byte PREFIX_PENDING_EXECUTABLE = 0x17;
        private const byte PREFIX_PENDING_ACTIVE = 0x18;
        private const byte PREFIX_CONTRACT_ADMIN = 0xF0;
        // AA-D-01 (audit fix H5): timelocked contract upgrade. The admin first proposes the
        // sha256 of the new NEF and manifest, then can only apply that exact artifact pair
        // after the 7-day window. AA-D-02 (audit fix AA-04): admin rotation is timelocked
        // the same way. New prefixes — never written by previous deployments.
        private const byte PREFIX_PENDING_UPDATE_NEF_HASH = 0xF1;
        private const byte PREFIX_PENDING_UPDATE_MANIFEST_HASH = 0xF2;
        private const byte PREFIX_UPDATE_TIMELOCK = 0xF3;
        private const byte PREFIX_PENDING_ADMIN = 0xF4;
        private const byte PREFIX_ADMIN_ROTATION_TIMELOCK = 0xF5;
        // AA-06: the canonical AA core this verifier trusts for ownership attestation in
        // SetupRecovery. Design choice (mirroring the VerifierAuthority M-7 surface, adapted
        // to this contract's own GetContractAdmin/AssertContractAdmin idiom): the contract
        // admin binds the core exactly once via SetAuthorizedCore (initial-set-only, instant
        // is permitted ONLY while unset); re-pointing goes through the 7-day
        // Propose/ConfirmAuthorizedCore window reusing AdminRotationTimelockMs, so account
        // owners get an escape window before a new "core" could attest account ownership.
        // New prefixes — never written by previous deployments.
        private const byte PREFIX_AUTHORIZED_CORE = 0xF6;
        private const byte PREFIX_PENDING_CORE = 0xF7;
        private const byte PREFIX_CORE_TIMELOCK = 0xF8;

        private const int MAX_TEXT_LENGTH = 255;
        private const int MAX_ENCRYPTED_PARAMS_LENGTH = 4096;
        private const int MAX_FACTORS = 16;
        private const int FIXED_HASH_LENGTH = 32;
        private const int FIXED_SIGNATURE_LENGTH = 64;
        private const int COMPACT_TICKET_VERSION = 3;
        private const int COMPACT_ACTION_VERSION = 3;

        // 7-day window shared by the timelocked upgrade (H5) and admin rotation (AA-04),
        // matching the VerifierAuthority window used across the rest of the repo.
        private static readonly BigInteger AdminRotationTimelockMs = 7L * 24 * 60 * 60 * 1000;

        // ASCII("neodid-recovery-v1")
        private static readonly byte[] RECOVERY_DOMAIN = new byte[]
        {
            110, 101, 111, 100, 105, 100, 45, 114, 101, 99, 111, 118, 101, 114, 121, 45, 118, 49
        };
        private static readonly byte[] ACTION_DOMAIN = new byte[]
        {
            110, 101, 111, 100, 105, 100, 45, 97, 99, 116, 105, 111, 110, 45, 118, 49
        };

        public class PendingRecovery
        {
            public UInt160 NewOwner = UInt160.Zero;
            public BigInteger RecoveryNonce;
            public BigInteger ApprovedCount;
            public ulong InitiatedAt;
            public ulong ExecutableAt;
            public bool Active;
        }

        public class OracleRecoveryRequest
        {
            public UInt160 AccountId = UInt160.Zero;
            public UInt160 NewOwner = UInt160.Zero;
            public string RecoveryNonceText = string.Empty;
            public string ExpiresAtText = string.Empty;
            public string ActionId = string.Empty;
        }

        public class OracleActionRequest
        {
            public UInt160 AccountId = UInt160.Zero;
            public UInt160 Executor = UInt160.Zero;
            public string ActionId = string.Empty;
            public ulong ExpiresAt;
        }

        public class ActiveSession
        {
            public UInt160 Executor = UInt160.Zero;
            public string ActionId = string.Empty;
            public ByteString ActionNullifier = (ByteString)"";
            public ulong ExpiresAt;
            public bool Active;
        }

        private class CompactRecoveryTicket
        {
            public ByteString MasterNullifier = (ByteString)"";
            public ByteString ActionNullifier = (ByteString)"";
            public ByteString Signature = (ByteString)"";
        }

        private class CompactActionTicket
        {
            public ByteString ActionNullifier = (ByteString)"";
            public ByteString Signature = (ByteString)"";
        }

        public delegate void RecoverySetupHandler(UInt160 accountId, UInt160 owner, BigInteger threshold, ulong timelock, int factorCount);
        public delegate void RecoveryConfigUpdatedHandler(UInt160 accountId, BigInteger threshold, ulong timelock, int factorCount);
        public delegate void RecoveryTicketAcceptedHandler(UInt160 accountId, UInt160 newOwner, ByteString masterNullifier, ByteString actionNullifier, BigInteger approvedCount);
        public delegate void RecoveryReadyHandler(UInt160 accountId, UInt160 newOwner, BigInteger recoveryNonce, ulong executableAt);
        public delegate void RecoveryCancelledHandler(UInt160 accountId, BigInteger recoveryNonce);
        public delegate void RecoveryFinalizedHandler(UInt160 accountId, UInt160 oldOwner, UInt160 newOwner, BigInteger nextRecoveryNonce);
        public delegate void ActionSessionRequestedHandler(UInt160 accountId, UInt160 executor, string actionId, ulong expiresAt, BigInteger requestId);
        public delegate void ActionSessionActivatedHandler(UInt160 accountId, UInt160 executor, string actionId, ByteString actionNullifier, ulong expiresAt);
        public delegate void ActionSessionRevokedHandler(UInt160 accountId, UInt160 executor, string actionId);

        [DisplayName("RecoverySetup")]
        public static event RecoverySetupHandler OnRecoverySetup = default!;

        [DisplayName("RecoveryConfigUpdated")]
        public static event RecoveryConfigUpdatedHandler OnRecoveryConfigUpdated = default!;

        [DisplayName("RecoveryTicketAccepted")]
        public static event RecoveryTicketAcceptedHandler OnRecoveryTicketAccepted = default!;

        [DisplayName("RecoveryReady")]
        public static event RecoveryReadyHandler OnRecoveryReady = default!;

        [DisplayName("RecoveryCancelled")]
        public static event RecoveryCancelledHandler OnRecoveryCancelled = default!;

        [DisplayName("RecoveryFinalized")]
        public static event RecoveryFinalizedHandler OnRecoveryFinalized = default!;

        [DisplayName("ActionSessionRequested")]
        public static event ActionSessionRequestedHandler OnActionSessionRequested = default!;

        [DisplayName("ActionSessionActivated")]
        public static event ActionSessionActivatedHandler OnActionSessionActivated = default!;

        [DisplayName("ActionSessionRevoked")]
        public static event ActionSessionRevokedHandler OnActionSessionRevoked = default!;

        [Safe]
        public static string Version() => "2.0.0";

        public static void _deploy(object data, bool update)
        {
            if (update) return;
            if (Storage.Get(Storage.CurrentContext, new byte[] { PREFIX_CONTRACT_ADMIN }) != null) return;
            Storage.Put(Storage.CurrentContext, new byte[] { PREFIX_CONTRACT_ADMIN }, (ByteString)(byte[])Runtime.Transaction.Sender);
        }

        [Safe]
        public static UInt160 GetContractAdmin()
        {
            ByteString? admin = Storage.Get(Storage.CurrentContext, new byte[] { PREFIX_CONTRACT_ADMIN });
            return admin is null ? UInt160.Zero : (UInt160)admin;
        }

        // AA-D-01 (audit fix H5): contract upgrade is timelocked. This contract custodies
        // user GAS (the per-account oracle-credit pool funded via onNEP17Payment), so a
        // single admin key must not be able to instantly replace the contract logic.
        // ProposeUpdate pins the sha256 of the new NEF and manifest; Update/ConfirmUpdate
        // applies exactly that artifact pair only after the 7-day window. One-way: once
        // deployed, every future upgrade waits 7 days. Mirrors VerifierAuthority.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash)
        {
            AssertContractAdmin();
            ExecutionEngine.Assert(nefHash != UInt256.Zero && nefHash.IsValid, "Invalid NEF hash");
            ExecutionEngine.Assert(manifestHash != UInt256.Zero && manifestHash.IsValid, "Invalid manifest hash");
            Storage.Put(Storage.CurrentContext, new byte[] { PREFIX_PENDING_UPDATE_NEF_HASH }, (byte[])nefHash);
            Storage.Put(Storage.CurrentContext, new byte[] { PREFIX_PENDING_UPDATE_MANIFEST_HASH }, (byte[])manifestHash);
            Storage.Put(Storage.CurrentContext, new byte[] { PREFIX_UPDATE_TIMELOCK }, Runtime.Time);
        }

        public static void CancelUpdate()
        {
            AssertContractAdmin();
            Storage.Delete(Storage.CurrentContext, new byte[] { PREFIX_PENDING_UPDATE_NEF_HASH });
            Storage.Delete(Storage.CurrentContext, new byte[] { PREFIX_PENDING_UPDATE_MANIFEST_HASH });
            Storage.Delete(Storage.CurrentContext, new byte[] { PREFIX_UPDATE_TIMELOCK });
        }

        [Safe]
        public static UInt256 GetPendingUpdateNefHash()
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, new byte[] { PREFIX_PENDING_UPDATE_NEF_HASH });
            return data is null ? UInt256.Zero : (UInt256)data;
        }

        [Safe]
        public static UInt256 GetPendingUpdateManifestHash()
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, new byte[] { PREFIX_PENDING_UPDATE_MANIFEST_HASH });
            return data is null ? UInt256.Zero : (UInt256)data;
        }

        [Safe]
        public static BigInteger GetPendingUpdateAvailableAt()
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, new byte[] { PREFIX_UPDATE_TIMELOCK });
            return data is null ? 0 : (BigInteger)data + AdminRotationTimelockMs;
        }

        public static void Update(ByteString nef, string manifest)
        {
            AssertContractAdmin();
            ByteString? pendingNef = Storage.Get(Storage.CurrentContext, new byte[] { PREFIX_PENDING_UPDATE_NEF_HASH });
            ExecutionEngine.Assert(pendingNef != null, "No pending update");
            ByteString? pendingManifest = Storage.Get(Storage.CurrentContext, new byte[] { PREFIX_PENDING_UPDATE_MANIFEST_HASH });
            ExecutionEngine.Assert(pendingManifest != null, "No pending update");
            ByteString? timelockData = Storage.Get(Storage.CurrentContext, new byte[] { PREFIX_UPDATE_TIMELOCK });
            ExecutionEngine.Assert(timelockData != null, "No timelock set");
            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)timelockData + AdminRotationTimelockMs, "Update timelock not expired");
            ExecutionEngine.Assert((UInt256)CryptoLib.Sha256(nef) == (UInt256)pendingNef!, "NEF hash mismatch");
            ExecutionEngine.Assert((UInt256)CryptoLib.Sha256(manifest) == (UInt256)pendingManifest!, "Manifest hash mismatch");
            Storage.Delete(Storage.CurrentContext, new byte[] { PREFIX_PENDING_UPDATE_NEF_HASH });
            Storage.Delete(Storage.CurrentContext, new byte[] { PREFIX_PENDING_UPDATE_MANIFEST_HASH });
            Storage.Delete(Storage.CurrentContext, new byte[] { PREFIX_UPDATE_TIMELOCK });
            ContractManagement.Update(nef, manifest);
        }

        /// <summary>Alias for <see cref="Update"/>, mirroring the verifier/paymaster upgrade naming.</summary>
        public static void ConfirmUpdate(ByteString nef, string manifest) => Update(nef, manifest);

        // AA-D-02 (audit fix AA-04): rotating the contract admin is itself timelocked. The old
        // TransferAdmin did an instant Storage.Put with only the current-admin witness — a
        // single leaked admin key could silently and instantly burn the role to an address
        // nobody controls. The hardened flow mirrors VerifierAuthority.RotateAdmin/
        // ConfirmAdminRotation: propose (current-admin gated) -> 7-day window -> confirm gated
        // on CheckWitness(newAdmin), proving the new admin key is live before the role moves.
        public static void RotateAdmin(UInt160 newAdmin)
        {
            AssertContractAdmin();
            ValidateAddress(newAdmin, "newAdmin");
            ExecutionEngine.Assert(newAdmin != GetContractAdmin(), "New admin must differ from current");
            Storage.Put(Storage.CurrentContext, new byte[] { PREFIX_PENDING_ADMIN }, (ByteString)(byte[])newAdmin);
            Storage.Put(Storage.CurrentContext, new byte[] { PREFIX_ADMIN_ROTATION_TIMELOCK }, Runtime.Time);
        }

        public static void ConfirmAdminRotation(UInt160 newAdmin)
        {
            ByteString? pending = Storage.Get(Storage.CurrentContext, new byte[] { PREFIX_PENDING_ADMIN });
            ExecutionEngine.Assert(pending != null, "No pending admin rotation");
            ByteString? timelockData = Storage.Get(Storage.CurrentContext, new byte[] { PREFIX_ADMIN_ROTATION_TIMELOCK });
            ExecutionEngine.Assert(timelockData != null, "No timelock set");
            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)timelockData + AdminRotationTimelockMs, "Admin rotation timelock not expired");
            ExecutionEngine.Assert((UInt160)pending! == newAdmin, "Pending admin mismatch");
            ExecutionEngine.Assert(Runtime.CheckWitness(newAdmin), "New admin must confirm rotation");
            Storage.Put(Storage.CurrentContext, new byte[] { PREFIX_CONTRACT_ADMIN }, (ByteString)(byte[])newAdmin);
            Storage.Delete(Storage.CurrentContext, new byte[] { PREFIX_PENDING_ADMIN });
            Storage.Delete(Storage.CurrentContext, new byte[] { PREFIX_ADMIN_ROTATION_TIMELOCK });
        }

        public static void CancelAdminRotation()
        {
            AssertContractAdmin();
            Storage.Delete(Storage.CurrentContext, new byte[] { PREFIX_PENDING_ADMIN });
            Storage.Delete(Storage.CurrentContext, new byte[] { PREFIX_ADMIN_ROTATION_TIMELOCK });
        }

        // AA-06: canonical-AA-core administration, mirroring VerifierAuthority's M-7 surface
        // (SetAuthorizedCore initial-set-only; Propose/ConfirmAuthorizedCore with the 7-day
        // window; CancelAuthorizedCoreChange). SetupRecovery only accepts ownership
        // attestations from this pinned core.
        [Safe]
        public static UInt160 AuthorizedCore()
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, new byte[] { PREFIX_AUTHORIZED_CORE });
            return data is null ? UInt160.Zero : (UInt160)data;
        }

        public static void SetAuthorizedCore(UInt160 coreContract)
        {
            AssertContractAdmin();
            ExecutionEngine.Assert(coreContract != UInt160.Zero && coreContract.IsValid, "Invalid core contract");
            // Instant set is permitted ONLY for the initial (unset) configuration, mirroring
            // VerifierAuthority.SetAuthorizedCore. Re-pointing an already-configured core must
            // go through the timelocked Propose/ConfirmAuthorizedCore path.
            ExecutionEngine.Assert(AuthorizedCore() == UInt160.Zero, "core already set; use ProposeAuthorizedCore");
            Storage.Put(Storage.CurrentContext, new byte[] { PREFIX_AUTHORIZED_CORE }, (ByteString)(byte[])coreContract);
        }

        public static void ProposeAuthorizedCore(UInt160 coreContract)
        {
            AssertContractAdmin();
            ExecutionEngine.Assert(coreContract != UInt160.Zero && coreContract.IsValid, "Invalid core contract");
            Storage.Put(Storage.CurrentContext, new byte[] { PREFIX_PENDING_CORE }, (ByteString)(byte[])coreContract);
            Storage.Put(Storage.CurrentContext, new byte[] { PREFIX_CORE_TIMELOCK }, Runtime.Time);
        }

        public static void ConfirmAuthorizedCore(UInt160 coreContract)
        {
            AssertContractAdmin();
            ByteString? pending = Storage.Get(Storage.CurrentContext, new byte[] { PREFIX_PENDING_CORE });
            ExecutionEngine.Assert(pending != null, "No pending core change");
            ByteString? timelockData = Storage.Get(Storage.CurrentContext, new byte[] { PREFIX_CORE_TIMELOCK });
            ExecutionEngine.Assert(timelockData != null, "No timelock set");
            ExecutionEngine.Assert(Runtime.Time >= (BigInteger)timelockData + AdminRotationTimelockMs, "Core change timelock not expired");
            ExecutionEngine.Assert((UInt160)pending! == coreContract, "Pending core mismatch");
            Storage.Put(Storage.CurrentContext, new byte[] { PREFIX_AUTHORIZED_CORE }, (ByteString)(byte[])coreContract);
            Storage.Delete(Storage.CurrentContext, new byte[] { PREFIX_PENDING_CORE });
            Storage.Delete(Storage.CurrentContext, new byte[] { PREFIX_CORE_TIMELOCK });
        }

        public static void CancelAuthorizedCoreChange()
        {
            AssertContractAdmin();
            Storage.Delete(Storage.CurrentContext, new byte[] { PREFIX_PENDING_CORE });
            Storage.Delete(Storage.CurrentContext, new byte[] { PREFIX_CORE_TIMELOCK });
        }
    }
}
