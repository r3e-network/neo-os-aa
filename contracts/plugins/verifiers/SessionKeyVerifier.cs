using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Verifiers
{
    /// <summary>
    /// Verifier for short-lived delegated session keys.
    /// </summary>
    /// <remarks>
    /// This plugin is intended for constrained delegation, such as a bot or game session that may
    /// call only one contract and one method until a fixed expiry time.
    /// </remarks>
    [DisplayName("SessionKeyVerifier")]
#if SMARTACCOUNT_NATIVE
    [ContractPermission("0x398dc3f0227d7efac5533ed5ce9937390c158084", "hasModuleContext", "getAuthorityEpoch", "getAuthorizationDomain", "getOperationDigest", "getAccountAddress", "canonicalP256PublicKey")]
    [ManifestExtra("SmartAccountProfile", "native-v2")]
#else
    [ContractPermission("*", "canConfigureVerifier")]
    [ContractPermission("*", "canExecuteVerifier")]
    [ContractPermission("*", "computeArgsHash")]
    [ContractPermission("*", "getProxyScriptHash")]
#endif
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
#if SMARTACCOUNT_NATIVE
        // Deterministic configured identity; never stores an operation approval.
        private static readonly byte[] Prefix_NativeSignerDomain = new byte[] { 0x05 };
        private static readonly byte[] Prefix_NativeLastUsedAt = new byte[] { 0x06 };
#endif
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

        // Revocation is ordered by Neo transaction execution. Consumers can use this event to
        // invalidate cached or pending session-key work; it does not rewrite an operation that
        // was already executed earlier in canonical chain order.
        public delegate void SessionKeyRevokedDelegate(UInt160 accountId);

        [DisplayName("SessionKeyRevoked")]
        public static event SessionKeyRevokedDelegate OnSessionKeyRevoked = null!;

        public static void _deploy(object data, bool update) => VerifierAuthority.Initialize(data, update);

        [Safe]
        public static bool SupportsV3() => true;

        [Safe]
        public static bool SupportsComposition() => false;

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

        // SA-D-01: timelocked upgrade — Update only succeeds for an artifact pair that was
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
        /// Registration-time initial session key, invoked by the core when the account is
        /// registered with verifier params (the account id already binds these bytes via
        /// computeRegistrationAccountId). First installation into an empty slot is
        /// immediate by protocol semantics; later changes still go through the core's
        /// timelocked configuration path.
        ///
        /// Blob layout (version 0x01, integers little-endian):
        ///   [0] version | [1] pubKeyLength + pubKey (33 or 65) | targetContract (20) |
        ///   methodLength (1) + method | validUntil ms (8) | spendingLimit datoshi (8) |
        ///   descriptionLength (1) + description (0-128)
        /// </summary>
        public static void SetPublicKey(UInt160 accountId, ByteString initialKeyBlob)
        {
            byte[] raw = (byte[])initialKeyBlob;
            ExecutionEngine.Assert(raw != null && raw.Length >= 1 + 1 + 33 + 20 + 1 + 8 + 8 + 1,
                "Invalid session key blob");
            ExecutionEngine.Assert(raw[0] == 0x01, "Unsupported session key blob version");

            int cursor = 1;
            int pubKeyLength = raw[cursor++];
            ExecutionEngine.Assert(pubKeyLength == 33 || pubKeyLength == 65, "Invalid public key length");
            ExecutionEngine.Assert(raw.Length >= cursor + pubKeyLength + 20 + 1 + 8 + 8 + 1,
                "Invalid session key blob length");
            ByteString pubKey = (ByteString)CopyBytes(raw, cursor, pubKeyLength);
            cursor += pubKeyLength;

            UInt160 targetContract = (UInt160)(ByteString)CopyBytes(raw, cursor, 20);
            cursor += 20;

            int methodLength = raw[cursor++];
            ExecutionEngine.Assert(methodLength > 0 && raw.Length >= cursor + methodLength + 8 + 8 + 1,
                "Invalid session key method");
            string method = (string)(ByteString)CopyBytes(raw, cursor, methodLength);
            cursor += methodLength;

            BigInteger validUntil = ReadUInt64LittleEndian(raw, cursor);
            cursor += 8;
            BigInteger spendingLimit = ReadUInt64LittleEndian(raw, cursor);
            cursor += 8;

            int descriptionLength = raw[cursor++];
            ExecutionEngine.Assert(raw.Length == cursor + descriptionLength, "Invalid session key blob length");
            string description = descriptionLength == 0
                ? string.Empty
                : (string)(ByteString)CopyBytes(raw, cursor, descriptionLength);

            // Delegate to the timelocked path's own implementation so every invariant
            // (expiry window, 30-day cap, spending-limit enforceability, description
            // bound, rotation bookkeeping) is enforced identically for registration-time
            // and post-registration configuration.
            SetSessionKey(accountId, pubKey, targetContract, method, validUntil, spendingLimit, description);
        }

        private static byte[] CopyBytes(byte[] source, int offset, int length)
        {
            byte[] result = new byte[length];
            for (int i = 0; i < length; i++)
            {
                result[i] = source[offset + i];
            }
            return result;
        }

        private static BigInteger ReadUInt64LittleEndian(byte[] source, int offset)
        {
            BigInteger value = 0;
            for (int i = 7; i >= 0; i--)
            {
                value = value * 256 + source[offset + i];
            }
            return value;
        }

        /// <summary>
        /// Configures the active session key and its target/method/expiry scope.
        /// </summary>
        public static void SetSessionKey(UInt160 accountId, ByteString pubKey, UInt160 targetContract, string method, BigInteger validUntil, BigInteger spendingLimit, string description)
        {
            ValidateSessionConfigCaller(accountId);
            ExecutionEngine.Assert(pubKey.Length == 33 || pubKey.Length == 65, "Invalid public key length");
#if SMARTACCOUNT_NATIVE
            // The native helper validates the complete curve point before returning
            // its compressed identity. The generic standard-account syscall alone
            // does not validate the y coordinate of an uncompressed encoding.
            object normalized = Contract.Call(NativeAuthority.SmartAccount, "canonicalP256PublicKey",
                // The native profile marks this helper as a pure, account-free
                // query and requires the exact None call flag. The ordinary
                // contract build remains outside this conditional while the
                // native module uses the profile's canonical invocation shape.
                CallFlags.None, new object[] { pubKey });
            ExecutionEngine.Assert(normalized is ByteString && ((ByteString)normalized).Length == 33,
                "Invalid canonical P256 public key");
            pubKey = (ByteString)normalized;
            UInt160 canonicalSigner = Contract.CreateStandardAccount((ECPoint)pubKey);
#endif
            ExecutionEngine.Assert(validUntil > Runtime.Time, "Session key must expire in the future");
            ExecutionEngine.Assert(validUntil <= Runtime.Time + MaxSessionDurationMs, "Session key lifetime exceeds maximum of 30 days");
            ExecutionEngine.Assert(spendingLimit >= 0, "Spending limit must be non-negative");
            // Fail closed: the spending limit can only be enforced on the value-moving "transfer"
            // path (see ExtractTransferValue). Reject a positive limit on any wildcard or
            // non-transfer session key so the configured cap is never silently unenforced.
            ExecutionEngine.Assert(spendingLimit == 0 || method == "transfer", "Spending limit only enforceable on transfer session keys");
            ExecutionEngine.Assert(description == null || description.Length <= 128, "Description too long (max 128 chars)");

            // Enforce key rotation cooldown to prevent spending limit bypass via rapid key rotation
            byte[] rotationKey = VerifierAuthority.AccountKey(Prefix_LastKeyRotation, accountId);
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

            byte[] key = VerifierAuthority.AccountKey(Prefix_SessionKeys, accountId);
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(data));
#if SMARTACCOUNT_NATIVE
            Storage.Put(Storage.CurrentContext, NativeSiblingKey(key, Prefix_NativeSignerDomain),
                SignerDomain.NativeScript(canonicalSigner));
            Storage.Put(Storage.CurrentContext, NativeSiblingKey(key, Prefix_NativeLastUsedAt), 0);
#endif

            // Store metadata
            SessionKeyMetadata metadata = new SessionKeyMetadata
            {
                CreatedAt = Runtime.Time,
                LastUsedAt = 0,
                Description = description ?? string.Empty
            };
            byte[] metadataKey = VerifierAuthority.AccountKey(Prefix_SessionMetadata, accountId);
            Storage.Put(Storage.CurrentContext, metadataKey, StdLib.Serialize(metadata));

            // Record rotation timestamp for cooldown enforcement
            byte[] rotationTsKey = VerifierAuthority.AccountKey(Prefix_LastKeyRotation, accountId);
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
            byte[] key = VerifierAuthority.AccountKey(Prefix_SessionKeys, accountId);
            Storage.Delete(Storage.CurrentContext, key);
            byte[] metadataKey = VerifierAuthority.AccountKey(Prefix_SessionMetadata, accountId);
            Storage.Delete(Storage.CurrentContext, metadataKey);
            byte[] spentKey = VerifierAuthority.AccountKey(Prefix_SpentAmount, accountId);
            Storage.Delete(Storage.CurrentContext, spentKey);
#if SMARTACCOUNT_NATIVE
            Storage.Delete(Storage.CurrentContext, NativeSiblingKey(spentKey, Prefix_NativeSignerDomain));
            Storage.Delete(Storage.CurrentContext, NativeSiblingKey(spentKey, Prefix_NativeLastUsedAt));
#endif
            // A successful clear is an explicit revocation command. Emit even when the key was
            // already absent so indexers can converge on the canonical ordering of the command.
            OnSessionKeyRevoked(accountId);
        }

#if SMARTACCOUNT_NATIVE
        private static BigInteger NativeLastUsedAt(byte[] key)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(data != null && data.Length <= 9, "Native last-use state is missing or invalid");
            BigInteger value = (BigInteger)data!;
            ExecutionEngine.Assert(value >= 0 && value < (BigInteger.One << 64)
                && data == (ByteString)value.ToByteArray(), "Invalid native last-use timestamp");
            return value;
        }

        // Used only within one callback, after deriving a fresh native account key.
        // No arbitrary contract call occurs between these sibling storage accesses.
        private static byte[] NativeSiblingKey(byte[] freshKey, byte[] prefix)
        {
            ExecutionEngine.Assert(freshKey.Length == 30 && freshKey[0] == 0xA2 && prefix.Length == 1,
                "Invalid authority-scoped storage key");
            byte[] key = new byte[30];
            for (int i = 0; i < 30; i++) key[i] = freshKey[i];
            key[1] = prefix[0];
            return key;
        }
#endif

        [Safe]
        public static SessionKeyData? GetSessionKey(UInt160 accountId)
        {
            byte[] key = VerifierAuthority.AccountKey(Prefix_SessionKeys, accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return null;
            return (SessionKeyData)StdLib.Deserialize(data!);
        }

        [Safe]
        public static SessionKeyMetadata? GetSessionKeyMetadata(UInt160 accountId)
        {
            byte[] key = VerifierAuthority.AccountKey(Prefix_SessionMetadata, accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return null;
#if SMARTACCOUNT_NATIVE
            SessionKeyMetadata metadata = (SessionKeyMetadata)StdLib.Deserialize(data!);
            metadata.LastUsedAt = NativeLastUsedAt(NativeSiblingKey(key, Prefix_NativeLastUsedAt));
            return metadata;
#else
            return (SessionKeyMetadata)StdLib.Deserialize(data!);
#endif
        }

        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId)
        {
#if SMARTACCOUNT_NATIVE
            // One P-256 key has one native authority identity, whether used as a
            // session signature or as a standard-account transaction witness.
            // It is written/deleted atomically with the active session key.
            ByteString? domain = Storage.Get(Storage.CurrentContext,
                VerifierAuthority.AccountKey(Prefix_NativeSignerDomain, accountId));
            ExecutionEngine.Assert(domain != null && domain.Length == 32, "Native signer domain is missing");
            return new ByteString[] { domain! };
#else
            SessionKeyData? sessionKey = GetSessionKey(accountId);
            ExecutionEngine.Assert(sessionKey != null, "No session key active");
            return new ByteString[] { SignerDomain.Secp256r1(sessionKey!.PubKey) };
#endif
        }

        [Safe]
        public static BigInteger GetSpentAmount(UInt160 accountId)
        {
            byte[] key = VerifierAuthority.AccountKey(Prefix_SpentAmount, accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            return data == null ? 0 : (BigInteger)data;
        }

        public static void ClearAccount(UInt160 accountId)
        {
#if SMARTACCOUNT_NATIVE
            NativeAuthority.Require(VerifierAuthority.AuthorizedCore(), accountId, "verifier", "cleanup");
            Storage.Delete(Storage.CurrentContext, VerifierAuthority.AccountKey(Prefix_SessionKeys, accountId));
            Storage.Delete(Storage.CurrentContext, VerifierAuthority.AccountKey(Prefix_SessionMetadata, accountId));
            Storage.Delete(Storage.CurrentContext, VerifierAuthority.AccountKey(Prefix_SpentAmount, accountId));
            Storage.Delete(Storage.CurrentContext, VerifierAuthority.AccountKey(Prefix_LastKeyRotation, accountId));
            Storage.Delete(Storage.CurrentContext, VerifierAuthority.AccountKey(Prefix_NativeSignerDomain, accountId));
            Storage.Delete(Storage.CurrentContext, VerifierAuthority.AccountKey(Prefix_NativeLastUsedAt, accountId));
            OnSessionKeyRevoked(accountId);
#else
            ClearSessionKey(accountId);
#endif
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
#if SMARTACCOUNT_NATIVE
        public static bool ValidateSignature(UInt160 accountId, object[] fields)
        {
            NativeAuthority.Require(VerifierAuthority.AuthorizedCore(), accountId, "verifier", "validation");
            return ValidateNativeSignature(accountId, NativeOperation.Decode(fields));
        }

        [Safe]
        public static bool ValidateSignatureForPostExecute(UInt160 accountId, object[] fields)
        {
            NativeAuthority.Require(VerifierAuthority.AuthorizedCore(), accountId, "verifier", "postExecute");
            return ValidateNativeSignature(accountId, NativeOperation.Decode(fields));
        }

        private static bool ValidateNativeSignature(UInt160 accountId, UserOperation op)
        {
#else
        public static bool ValidateSignature(UInt160 accountId, UserOperation op)
        {
            // Audit fix M-6: the ordinary-build validation entry is only reachable
            // through the SA core's execution context; direct callers are rejected.
            // v4: the core calls validators in the PhaseValidation phase, so this is
            // the read-only validation-phase authorization (not the completion one).
            VerifierAuthority.ValidateValidationCaller(accountId, Runtime.ExecutingScriptHash);
#endif
            SessionKeyData? sk = GetSessionKey(accountId);
            ExecutionEngine.Assert(sk != null, "No session key active");
            SessionKeyData sessionKey = sk!;

#if SMARTACCOUNT_NATIVE
            ExecutionEngine.Assert(VerifierClock.Now() <= sessionKey.ValidUntil, "Session key expired");
#else
            ExecutionEngine.Assert(Runtime.Time <= sessionKey.ValidUntil, "Session key expired");
#endif
            ExecutionEngine.Assert(op.TargetContract == sessionKey.TargetContract, "Target contract not permitted");
            if (sessionKey.Method != "*") // Allow wildcard method if configured
            {
                ExecutionEngine.Assert(op.Method == sessionKey.Method, "Method not permitted");
            }

#if !SMARTACCOUNT_NATIVE
            // NEP-17 transfers have one precise value-bearing ABI, even for uncapped keys.
            BigInteger operationValue = op.Method == "transfer" ? ExtractTransferValue(accountId, op) : 0;
#endif
            ExecutionEngine.Assert(op.Signature != null && op.Signature.Length == 64, "Invalid signature length");
            ByteString signature = op.Signature!;
#if SMARTACCOUNT_NATIVE
            byte[] payload = VerifierPayload.BuildValidationPayload(accountId, op.TargetContract, op.Method, op.Args, op.Nonce, op.Deadline);
#else
            byte[] payload = VerifierPayload.BuildPayload(accountId, op.TargetContract, op.Method, op.Args, op.Nonce, op.Deadline);
#endif

            // Verify against the raw payload; secp256r1SHA256 hashes internally.
            bool isValid = CryptoLib.VerifyWithECDsa((ByteString)payload, (ECPoint)sessionKey.PubKey, signature, NamedCurveHash.secp256r1SHA256);

            if (isValid && sessionKey.SpendingLimit > 0)
            {
                BigInteger spent = GetSpentAmount(accountId);
#if SMARTACCOUNT_NATIVE
                BigInteger operationValue = NativeTransferValue(accountId, op);
#endif
                // Audit fix M-2: a lowered cap can already be below historical spending.
                // Zero value must not bypass that policy boundary merely because it adds
                // no debit; both builds now enforce the identical unconditional check.
                ExecutionEngine.Assert(spent + operationValue <= sessionKey.SpendingLimit, "Session key spending limit exceeded");
            }

            return isValid;
        }

#if !SMARTACCOUNT_NATIVE
        /// <summary>Rejects ambiguous transfer encodings before applying the session cap.</summary>
        private static BigInteger ExtractTransferValue(UInt160 accountId, UserOperation op)
        {
            ExecutionEngine.Assert(op.Args != null && op.Args.Length == 4, "Invalid NEP-17 transfer args");
            ExecutionEngine.Assert(op.Args[2] is BigInteger, "Transfer amount must be an integer");
            BigInteger amount = (BigInteger)op.Args[2];
            ExecutionEngine.Assert(amount >= 0, "Transfer amount must be non-negative");
            UInt160 from = (UInt160)op.Args[0];
            UInt160 to = (UInt160)op.Args[1];
            ExecutionEngine.Assert(from != null && from.IsValid && to != null && to.IsValid, "Invalid transfer address");
            UInt160 core = VerifierAuthority.AuthorizedCore();
            ExecutionEngine.Assert(core != UInt160.Zero && core.IsValid, "SA core not configured");
            UInt160 proxy = (UInt160)Contract.Call(core, "getProxyScriptHash", CallFlags.ReadOnly, accountId);
            ExecutionEngine.Assert(from == proxy, "Transfer source must be the account asset address");
            return amount;
        }

#endif

#if SMARTACCOUNT_NATIVE
        private static BigInteger NativeTransferValue(UInt160 accountId, UserOperation op)
        {
            ExecutionEngine.Assert(op.Method == "transfer" && op.Args.Length == 4, "Capped session requires an exact transfer");
            object[] args = op.Args;
            ExecutionEngine.Assert(args[0] is ByteString && ((ByteString)args[0]).Length == 20, "Invalid transfer source");
            UInt160 proxy = (UInt160)Contract.Call(NativeAuthority.SmartAccount, "getAccountAddress", CallFlags.ReadOnly, new object[] { accountId });
            ExecutionEngine.Assert((UInt160)args[0] == proxy, "Transfer source is not the account address");
            ExecutionEngine.Assert(args[1] is ByteString && ((ByteString)args[1]).Length == 20 && (UInt160)args[1] != UInt160.Zero, "Invalid transfer recipient");
            ExecutionEngine.Assert(args[2] is BigInteger && (BigInteger)args[2] >= 0, "Invalid transfer amount");
            return (BigInteger)args[2];
        }

        public static void PostExecute(UInt160 accountId, object[] fields, object result)
        {
            UserOperation op = NativeOperation.Decode(fields);
#else
        public static void PostExecute(UInt160 accountId, UserOperation op, object result)
        {
#endif
            VerifierAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
#if SMARTACCOUNT_NATIVE
            byte[] freshKey = VerifierAuthority.AccountKey(Prefix_SessionKeys, accountId);
            ByteString? keyData = Storage.Get(Storage.CurrentContext, freshKey);
            ExecutionEngine.Assert(keyData != null, "No session key active");
            SessionKeyData? sk = (SessionKeyData)StdLib.Deserialize(keyData!);
            ExecutionEngine.Assert(sk != null, "No session key active");
#else
            SessionKeyData? sk = GetSessionKey(accountId);
            if (sk == null) return;
#endif
            SessionKeyData sessionKey = sk!;
#if SMARTACCOUNT_NATIVE
            ExecutionEngine.Assert(VerifierClock.Now() <= sessionKey.ValidUntil, "Session key expired");
            ExecutionEngine.Assert(op.TargetContract == sessionKey.TargetContract, "Target contract not permitted");
            ExecutionEngine.Assert(sessionKey.Method == "*" || op.Method == sessionKey.Method, "Method not permitted");
#endif
#if !SMARTACCOUNT_NATIVE
            BigInteger operationValue = 0;
            if (op.Method == "transfer")
            {
                // A token rejection must revert the entire user operation, including its
                // nonce and any token writes. Generic non-transfer business values are valid.
                ExecutionEngine.Assert(result is bool accepted && accepted, "NEP-17 transfer failed");
                operationValue = ExtractTransferValue(accountId, op);
            }
#endif
            if (sessionKey.SpendingLimit > 0)
            {
#if SMARTACCOUNT_NATIVE
                ExecutionEngine.Assert(result is bool && (bool)result, "Session transfer did not succeed");
                BigInteger operationValue = NativeTransferValue(accountId, op);
                // Read the current authority-scoped counter once for this callback.
                // The cap check and write must use the same fresh key and value.
                byte[] spentKey = NativeSiblingKey(freshKey, Prefix_SpentAmount);
                ByteString? spentData = Storage.Get(Storage.CurrentContext, spentKey);
                BigInteger spent = spentData == null ? 0 : (BigInteger)spentData;
                BigInteger newSpent = spent + operationValue;
                ExecutionEngine.Assert(newSpent <= sessionKey.SpendingLimit, "Session key spending limit exceeded");
                if (operationValue > 0)
                    Storage.Put(Storage.CurrentContext, spentKey, newSpent);
#else
                // Audit fix M-2: enforce the cap unconditionally (zero-value operations
                // included) so both builds share identical policy semantics; only the
                // debit write itself stays conditional on an actual balance change.
                BigInteger spent = GetSpentAmount(accountId);
                ExecutionEngine.Assert(spent + operationValue <= sessionKey.SpendingLimit, "Session key spending limit exceeded");
                if (operationValue > 0)
                {
                    byte[] spentKey = VerifierAuthority.AccountKey(Prefix_SpentAmount, accountId);
                    Storage.Put(Storage.CurrentContext, spentKey, spent + operationValue);
                }
#endif
            }

#if SMARTACCOUNT_NATIVE
            // A fixed-size timestamp update avoids rewriting the immutable description.
            byte[] lastUsedKey = NativeSiblingKey(freshKey, Prefix_NativeLastUsedAt);
            NativeLastUsedAt(lastUsedKey);
            Storage.Put(Storage.CurrentContext, lastUsedKey, Runtime.Time);
#else
            byte[] metadataKey = VerifierAuthority.AccountKey(Prefix_SessionMetadata, accountId);
            ByteString? metadataData = Storage.Get(Storage.CurrentContext, metadataKey);
            if (metadataData == null) return;
            SessionKeyMetadata metadata = (SessionKeyMetadata)StdLib.Deserialize(metadataData);
            metadata.LastUsedAt = Runtime.Time;
            Storage.Put(Storage.CurrentContext, metadataKey, StdLib.Serialize(metadata));
#endif
        }

        private static void ValidateSessionConfigCaller(UInt160 accountId)
        {
#if SMARTACCOUNT_NATIVE
            NativeAuthority.Require(VerifierAuthority.AuthorizedCore(), accountId, "verifier", "configuration");
#else
            // Audit fix M-1: the backup-owner direct-call branch is removed. Session
            // key configuration is only accepted through the SA core, which enforces
            // the 24h pending-call timelock (callVerifier / callVerifierChild); a
            // direct setSessionKey / clearSessionKey invocation is rejected here.
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
#endif
        }
    }
}
