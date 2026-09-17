using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace AbstractAccount.Verifiers
{
    /// <summary>
    /// Verifier for short-lived delegated session keys.
    /// </summary>
    /// <remarks>
    /// This plugin is intended for constrained delegation, such as a bot or game session that may
    /// call only one contract and one method until a fixed expiry time.
    /// </remarks>
    [DisplayName("SessionKeyVerifier")]
    [ContractPermission("*", "canConfigureVerifier")]
    [ContractPermission("*", "canExecuteVerifier")]
    [ContractPermission("*", "computeArgsHash")]
    [ContractPermission("*", "getBackupOwner")]
    [ManifestExtra("Description", "Temporary Session Key Verifier for High Frequency Actions")]
    [ManifestExtra("Version", "2.0.0")]
    public class SessionKeyVerifier : SmartContract
    {
        // AccountId -> SessionKeyData
        private static readonly byte[] Prefix_SessionKeys = new byte[] { 0x01 };
        // AccountId -> SessionKeyMetadata
        private static readonly byte[] Prefix_SessionMetadata = new byte[] { 0x02 };
        // AccountId -> SpentAmount (for spending limit tracking)
        private static readonly byte[] Prefix_SpentAmount = new byte[] { 0x03 };
        // AccountId -> LastKeyRotation timestamp (for rotation cooldown)
        private static readonly byte[] Prefix_LastKeyRotation = new byte[] { 0x04 };
        // Key rotation cooldown: 24 hours in milliseconds to match Runtime.Time
        private static readonly BigInteger KeyRotationCooldownMs = 24L * 60 * 60 * 1000;

        // Maximum session key lifetime: 30 days in milliseconds
        private static readonly BigInteger MaxSessionDurationMs = 30L * 24 * 60 * 60 * 1000;

        // Emitted whenever a session key is configured so off-chain consumers can audit its real
        // scope. The uncapped flag is true when the key carries no enforceable spending cap for its
        // target: a wildcard ("*") method authorizes value movement under any method, and a zero
        // SpendingLimit means no cap is tracked. Either way the key can move the account's whole
        // balance on a value-bearing target, which the one-target/one-method UI does not imply.
        public delegate void SessionKeyGrantedDelegate(
            UInt160 accountId, ByteString pubKey, UInt160 targetContract, string method,
            BigInteger validUntil, BigInteger spendingLimit, bool uncapped);

        [DisplayName("SessionKeyGranted")]
        public static event SessionKeyGrantedDelegate OnSessionKeyGranted = null!;

        public static void _deploy(object data, bool update) => VerifierAuthority.Initialize(data, update);

        [Safe]
        public static bool SupportsV3() => true;

        [Safe]
        public static bool SupportsMessageSignatures() => false;

        [Safe]
        public static string Version() => "2.0.0";

        [Safe]
        public static UInt160 AuthorizedCore() => VerifierAuthority.AuthorizedCore();

        public static void SetAuthorizedCore(UInt160 coreContract) => VerifierAuthority.SetAuthorizedCore(coreContract);
        // Audit fix M-7 (parity with hooks): timelocked core re-pointing.
        public static void ProposeAuthorizedCore(UInt160 coreContract) => VerifierAuthority.ProposeAuthorizedCore(coreContract);
        public static void ConfirmAuthorizedCore(UInt160 coreContract) => VerifierAuthority.ConfirmAuthorizedCore(coreContract);
        public static void CancelAuthorizedCoreChange() => VerifierAuthority.CancelAuthorizedCoreChange();

        // AA-D-01: timelocked upgrade — Update only succeeds for an artifact pair that was
        // pinned via ProposeUpdate at least 7 days earlier.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => VerifierAuthority.ProposeUpdate(nefHash, manifestHash);

        public static void ConfirmUpdate(ByteString nef, string manifest) => VerifierAuthority.Update(nef, manifest);

        public static void CancelUpdate() => VerifierAuthority.CancelUpdate();

        public static void Update(ByteString nef, string manifest) => VerifierAuthority.Update(nef, manifest);

        public class SessionKeyData
        {
            public ByteString PubKey = (ByteString)new byte[0];          // secp256r1 uncompressed
            public UInt160 TargetContract = UInt160.Zero;
            public string Method = string.Empty;
            public BigInteger ValidUntil;
            public BigInteger SpendingLimit;                             // Maximum total spend (0 = unlimited)
        }

        public class SessionKeyMetadata
        {
            public BigInteger CreatedAt;                                 // Session creation timestamp
            public BigInteger LastUsedAt;                                // Last successful use timestamp
            public string Description;                                    // Optional description (max 128 chars)
        }

        /// <summary>
        /// Configures the active session key and its target/method/expiry scope.
        /// </summary>
        public static void SetSessionKey(UInt160 accountId, ByteString pubKey, UInt160 targetContract, string method, BigInteger validUntil, BigInteger spendingLimit, string description)
        {
            ValidateSessionConfigCaller(accountId);
            ExecutionEngine.Assert(pubKey.Length == 33 || pubKey.Length == 65, "Invalid public key length");
            ExecutionEngine.Assert(validUntil > Runtime.Time, "Session key must expire in the future");
            ExecutionEngine.Assert(validUntil <= Runtime.Time + MaxSessionDurationMs, "Session key lifetime exceeds maximum of 30 days");
            ExecutionEngine.Assert(spendingLimit >= 0, "Spending limit must be non-negative");
            // Fail closed: the spending limit can only be enforced on the value-moving "transfer"
            // path (see ExtractTransferValue). Reject a positive limit on any wildcard or
            // non-transfer session key so the configured cap is never silently unenforced.
            ExecutionEngine.Assert(spendingLimit == 0 || method == "transfer", "Spending limit only enforceable on transfer session keys");
            ExecutionEngine.Assert(description == null || description.Length <= 128, "Description too long (max 128 chars)");

            // Enforce key rotation cooldown to prevent spending limit bypass via rapid key rotation
            byte[] rotationKey = Helper.Concat(Prefix_LastKeyRotation, (byte[])accountId);
            ByteString? lastRotationData = Storage.Get(Storage.CurrentContext, rotationKey);
            if (lastRotationData != null)
            {
                BigInteger lastRotation = (BigInteger)lastRotationData;
                ExecutionEngine.Assert(Runtime.Time >= lastRotation + KeyRotationCooldownMs, "Key rotation cooldown active (24h)");
            }

            SessionKeyData data = new SessionKeyData
            {
                PubKey = pubKey,
                TargetContract = targetContract,
                Method = method,
                ValidUntil = validUntil,
                SpendingLimit = spendingLimit
            };

            byte[] key = Helper.Concat(Prefix_SessionKeys, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(data));

            // Store metadata
            SessionKeyMetadata metadata = new SessionKeyMetadata
            {
                CreatedAt = Runtime.Time,
                LastUsedAt = 0,
                Description = description ?? string.Empty
            };
            byte[] metadataKey = Helper.Concat(Prefix_SessionMetadata, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, metadataKey, StdLib.Serialize(metadata));

            // Record rotation timestamp for cooldown enforcement
            byte[] rotationTsKey = Helper.Concat(Prefix_LastKeyRotation, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, rotationTsKey, Runtime.Time);

            // Do NOT reset spending tracking — prevent spending limit bypass via key rotation

            // Surface the key's true value exposure. A wildcard method, or any key with no spending
            // limit, can move the whole balance on a value-bearing target with no on-chain cap; the
            // SetSessionKey assert above only blocks a *positive* limit on a non-transfer key.
            bool uncapped = method == "*" || spendingLimit == 0;
            OnSessionKeyGranted(accountId, pubKey, targetContract, method, validUntil, spendingLimit, uncapped);
        }

        /// <summary>
        /// Removes the current delegated session key for the account.
        /// </summary>
        public static void ClearSessionKey(UInt160 accountId)
        {
            ValidateSessionConfigCaller(accountId);
            byte[] key = Helper.Concat(Prefix_SessionKeys, (byte[])accountId);
            Storage.Delete(Storage.CurrentContext, key);
            byte[] metadataKey = Helper.Concat(Prefix_SessionMetadata, (byte[])accountId);
            Storage.Delete(Storage.CurrentContext, metadataKey);
            byte[] spentKey = Helper.Concat(Prefix_SpentAmount, (byte[])accountId);
            Storage.Delete(Storage.CurrentContext, spentKey);
        }

        [Safe]
        public static SessionKeyData? GetSessionKey(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_SessionKeys, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return null;
            return (SessionKeyData)StdLib.Deserialize(data!);
        }

        [Safe]
        public static SessionKeyMetadata? GetSessionKeyMetadata(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_SessionMetadata, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return null;
            return (SessionKeyMetadata)StdLib.Deserialize(data!);
        }

        [Safe]
        public static BigInteger GetSpentAmount(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_SpentAmount, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            return data == null ? 0 : (BigInteger)data;
        }

        public static void ClearAccount(UInt160 accountId)
        {
            ClearSessionKey(accountId);
        }

        [Safe]
        /// <summary>
        /// Returns the exact payload bytes that the delegated session key must sign.
        /// </summary>
        public static ByteString GetPayload(UInt160 accountId, UInt160 targetContract, string method, object[] args, BigInteger nonce, BigInteger deadline)
        {
            return (ByteString)VerifierPayload.BuildPayload(accountId, targetContract, method, args, nonce, deadline);
        }

        /// <summary>
        /// Validates the delegated session signature and enforces its contract/method/expiry scope.
        /// </summary>
        public static bool ValidateSignature(UInt160 accountId, UserOperation op)
        {
            SessionKeyData? sk = GetSessionKey(accountId);
            ExecutionEngine.Assert(sk != null, "No session key active");
            SessionKeyData sessionKey = sk!;

            ExecutionEngine.Assert(Runtime.Time <= sessionKey.ValidUntil, "Session key expired");
            ExecutionEngine.Assert(op.TargetContract == sessionKey.TargetContract, "Target contract not permitted");
            if (sessionKey.Method != "*") // Allow wildcard method if configured
            {
                ExecutionEngine.Assert(op.Method == sessionKey.Method, "Method not permitted");
            }

            ExecutionEngine.Assert(op.Signature != null && op.Signature.Length == 64, "Invalid signature length");
            ByteString signature = op.Signature!;
            byte[] payload = VerifierPayload.BuildPayload(accountId, op.TargetContract, op.Method, op.Args, op.Nonce, op.Deadline);

            // Verify against the raw payload; secp256r1SHA256 hashes internally.
            bool isValid = CryptoLib.VerifyWithECDsa((ByteString)payload, (ECPoint)sessionKey.PubKey, signature, NamedCurveHash.secp256r1SHA256);

            if (isValid && sessionKey.SpendingLimit > 0)
            {
                BigInteger spent = GetSpentAmount(accountId);
                BigInteger operationValue = ExtractTransferValue(op);
                if (operationValue > 0)
                {
                    BigInteger newSpent = spent + operationValue;
                    ExecutionEngine.Assert(newSpent <= sessionKey.SpendingLimit, "Session key spending limit exceeded");
                }
            }

            return isValid;
        }

        /// <summary>
        /// Extracts the transfer value from a user operation if it's a transfer call.
        /// Returns 0 if not a transfer or value cannot be determined.
        /// </summary>
        private static BigInteger ExtractTransferValue(UserOperation op)
        {
            if (op.Args == null || op.Args.Length < 3) return 0;
            if (op.Method != "transfer") return 0;

            object[] args = (object[])op.Args;
            if (args.Length < 3) return 0;

            if (args[2] is BigInteger amount) return amount;
            return 0;
        }

        public static void PostExecute(UInt160 accountId, UserOperation op, object result)
        {
            VerifierAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
            SessionKeyData? sk = GetSessionKey(accountId);
            if (sk == null) return;

            SessionKeyData sessionKey = sk!;
            if (sessionKey.SpendingLimit > 0)
            {
                BigInteger operationValue = ExtractTransferValue(op);
                if (operationValue > 0)
                {
                    BigInteger spent = GetSpentAmount(accountId);
                    BigInteger newSpent = spent + operationValue;
                    ExecutionEngine.Assert(newSpent <= sessionKey.SpendingLimit, "Session key spending limit exceeded");
                    byte[] spentKey = Helper.Concat(Prefix_SpentAmount, (byte[])accountId);
                    Storage.Put(Storage.CurrentContext, spentKey, newSpent);
                }
            }

            byte[] metadataKey = Helper.Concat(Prefix_SessionMetadata, (byte[])accountId);
            ByteString? metadataData = Storage.Get(Storage.CurrentContext, metadataKey);
            if (metadataData == null) return;

            SessionKeyMetadata metadata = (SessionKeyMetadata)StdLib.Deserialize(metadataData);
            metadata.LastUsedAt = Runtime.Time;
            Storage.Put(Storage.CurrentContext, metadataKey, StdLib.Serialize(metadata));
        }

        private static void ValidateSessionConfigCaller(UInt160 accountId)
        {
            UInt160 core = VerifierAuthority.AuthorizedCore();
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "AA core not configured");

            if (Runtime.CallingScriptHash == core)
            {
                VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
                return;
            }

            UInt160 backupOwner = (UInt160)Contract.Call(
                core,
                "getBackupOwner",
                CallFlags.ReadOnly,
                new object[] { accountId });
            ExecutionEngine.Assert(backupOwner != UInt160.Zero && backupOwner.IsValid, "AA account not found");
            ExecutionEngine.Assert(Runtime.CheckWitness(backupOwner), "Backup owner witness required");
        }
    }
}
