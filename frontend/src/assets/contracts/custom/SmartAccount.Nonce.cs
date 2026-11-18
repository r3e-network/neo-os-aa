using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    /// <summary>
    /// Nonce channels and namespace derivation (protocol v4, spec §6):
    /// 0x56 cursors with the new encoding, 0x5C full-derivation digests for
    /// truncation-collision fail-closed detection, the derived (never chosen)
    /// 191-bit channel, the 2^64 exhaustion sentinel, and the legacy 0x03
    /// cursor merge (read max(legacy, new); the new cursor never decreases).
    ///
    /// Channel := low 191 bits of SHA256( U1(4) || coreHash || accountId ||
    /// U64BE(authorityEpoch) || U64BE(validatorId) || U64BE(credentialGeneration)
    /// || nonceSubkey ).
    /// </summary>
    public partial class SmartAccount
    {
        // Sequence cursor value that marks a dead channel; no wrap-around.
        private static readonly BigInteger NonceExhaustionSentinel = BigInteger.One << 64;

        // ========================================================================
        // 1. Encoding helpers (fixed-width big-endian UInt64 domain)
        // ========================================================================

        /// <summary>8-byte big-endian encoding of a value in [0, 2^64).</summary>
        private static byte[] UInt64DomainBytes(BigInteger value)
        {
            ExecutionEngine.Assert(value >= 0 && (value >> 64) == BigInteger.Zero, ErrorNonceInvalid);
            byte[] encoded = new byte[8];
            for (int i = 0; i < 8; i++)
            {
                encoded[i] = (byte)((value >> (8 * (7 - i))) & 0xFF);
            }
            return encoded;
        }

        /// <summary>Big-endian bytes to BigInteger (any length).</summary>
        private static BigInteger BytesToBigInteger(byte[] bytes)
        {
            BigInteger value = BigInteger.Zero;
            for (int i = 0; i < bytes.Length; i++)
            {
                value = (value << 8) | (BigInteger)bytes[i];
            }
            return value;
        }

        /// <summary>
        /// 24-byte right-aligned big-endian channel key bytes with the top 7
        /// bits zero (the 191-bit channel domain, spec §6).
        /// </summary>
        private static byte[] ChannelKeyBytes(BigInteger channel)
        {
            ExecutionEngine.Assert(channel >= 0 && (channel >> 191) == BigInteger.Zero, ErrorNonceChannelCollision);
            byte[] encoded = new byte[24];
            for (int i = 0; i < 24; i++)
            {
                encoded[i] = (byte)((channel >> (8 * (23 - i))) & 0xFF);
            }
            return encoded;
        }

        // ========================================================================
        // 2. Channel derivation
        // ========================================================================

        /// <summary>
        /// The full 256-bit nonce-namespace derivation digest persisted under
        /// 0x5C for truncation-collision detection.
        /// </summary>
        private static ByteString ComputeNonceNamespaceDigest(
            UInt160 accountId, BigInteger authorityEpoch, BigInteger validatorId,
            BigInteger credentialGeneration, ByteString nonceSubkey)
        {
            byte[] preimage = Helper.Concat(new byte[] { (byte)ModuleProtocolVersion },
                (byte[])Runtime.ExecutingScriptHash);
            preimage = Helper.Concat(preimage, (byte[])accountId);
            preimage = Helper.Concat(preimage, UInt64DomainBytes(authorityEpoch));
            preimage = Helper.Concat(preimage, UInt64DomainBytes(validatorId));
            preimage = Helper.Concat(preimage, UInt64DomainBytes(credentialGeneration));
            preimage = Helper.Concat(preimage, (byte[])nonceSubkey);
            return CryptoLib.Sha256((ByteString)preimage);
        }

        /// <summary>
        /// The derived 191-bit channel bytes (24 bytes, top 7 bits zero) taken
        /// from the low 191 bits of the namespace digest.
        /// </summary>
        private static byte[] ChannelBytesFromDigest(ByteString namespaceDigest)
        {
            byte[] digest = (byte[])namespaceDigest;
            byte[] channel = new byte[24];
            channel[0] = (byte)(digest[8] & 0x01);
            for (int i = 1; i < 24; i++)
            {
                channel[i] = digest[8 + i];
            }
            return channel;
        }

        /// <summary>
        /// Resolves the credential generation bound to a routing subject:
        /// built-in → 1 (the initial generation, identical to a freshly
        /// registered validator instance; operations require generation ≥ 1);
        /// validator instance → its current generation; active threshold policy
        /// → the policy generation (bumped on every rewrite, so reshaped
        /// policies kill their old channels).
        /// </summary>
        private static BigInteger ResolveCredentialGeneration(UInt160 accountId, BigInteger validatorId)
        {
            if (validatorId == 0) return BigInteger.One;
            ModuleInstance? module = GetModuleInstance(accountId, validatorId);
            if (module != null)
            {
                ExecutionEngine.Assert(module.ModuleType == ModuleTypeCodeValidator, ErrorValidatorNotFound);
                return module.CredentialGeneration;
            }
            ThresholdPolicyRecord? policy = GetThresholdPolicy(accountId, validatorId);
            if (policy != null && policy.Active) return policy.CredentialGeneration;
            ExecutionEngine.Assert(false, ErrorValidatorNotFound);
            return BigInteger.Zero;
        }

        // ========================================================================
        // 3. Cursor storage (0x56 new encoding + legacy 0x03 merge)
        // ========================================================================

        /// <summary>
        /// The effective channel cursor: max(new 0x56 value, legacy 0x03 value
        /// for the same channel). The new cursor never decreases (spec §6/§14).
        /// </summary>
        private static BigInteger ReadNonceCursor(UInt160 accountId, byte[] channel)
        {
            ByteString? newData = Storage.Get(Storage.CurrentContext, NonceCursorKey(accountId, channel));
            BigInteger newCursor = newData == null ? BigInteger.Zero : (BigInteger)newData;

            BigInteger channelValue = BytesToBigInteger(channel);
            byte[] legacyKey = Helper.Concat(
                Helper.Concat(Prefix_Nonce, (byte[])accountId), channelValue.ToByteArray());
            ByteString? legacyData = Storage.Get(Storage.CurrentContext, legacyKey);
            BigInteger legacyCursor = legacyData == null ? BigInteger.Zero : (BigInteger)legacyData;

            return newCursor > legacyCursor ? newCursor : legacyCursor;
        }

        /// <summary>
        /// Read-only acceptance check used during the validation phase: the
        /// channel must not be exhausted and the sequence must be the current
        /// cursor. The 0x5C namespace digest, when already persisted, must
        /// match this derivation (collision fail-closed).
        /// </summary>
        private static void AssertOperationNonceAcceptable(
            UInt160 accountId, byte[] channel, ByteString namespaceDigest, BigInteger sequence)
        {
            BigInteger cursor = ReadNonceCursor(accountId, channel);
            ExecutionEngine.Assert(cursor != NonceExhaustionSentinel, ErrorNonceExhausted);
            ExecutionEngine.Assert(sequence == cursor, ErrorNonceInvalid);
            ByteString? stored = Storage.Get(Storage.CurrentContext, NonceNamespaceKey(accountId, channel));
            if (stored != null)
            {
                ExecutionEngine.Assert(stored == namespaceDigest, ErrorNonceChannelCollision);
            }
        }

        /// <summary>
        /// Consumes the nonce after successful validation: first use persists
        /// the full derivation digest (0x5C) and emits NonceChannelOpened;
        /// reaching the 2^64 sentinel kills the channel with no wrap-around.
        /// </summary>
        private static void ConsumeOperationNonce(
            UInt160 accountId, byte[] channel, ByteString namespaceDigest, BigInteger sequence)
        {
            BigInteger cursor = ReadNonceCursor(accountId, channel);
            ExecutionEngine.Assert(cursor != NonceExhaustionSentinel, ErrorNonceExhausted);
            ExecutionEngine.Assert(sequence == cursor, ErrorNonceInvalid);

            ByteString? stored = Storage.Get(Storage.CurrentContext, NonceNamespaceKey(accountId, channel));
            if (stored == null)
            {
                Storage.Put(Storage.CurrentContext, NonceNamespaceKey(accountId, channel), namespaceDigest);
                OnNonceChannelOpened(accountId, namespaceDigest);
            }
            else
            {
                ExecutionEngine.Assert(stored == namespaceDigest, ErrorNonceChannelCollision);
            }

            BigInteger next = cursor + 1;
            if (next >= NonceExhaustionSentinel)
            {
                next = NonceExhaustionSentinel;
                OnNonceChannelExhausted(accountId, namespaceDigest);
            }
            Storage.Put(Storage.CurrentContext, NonceCursorKey(accountId, channel), next);
        }

        // ========================================================================
        // 4. Public nonce queries (spec §3.3)
        // ========================================================================

        /// <summary>
        /// The packed nonce (channel ‖ current sequence) of the channel derived
        /// for the account's current authorityEpoch, the routing subject and
        /// the nonceSubkey.
        /// </summary>
        [Safe]
        public static BigInteger getNonce(UInt160 accountId, BigInteger validatorId, ByteString nonceSubkey)
        {
            ValidateAccountId(accountId);
            AccountControl control = RequireAccountControl(accountId);
            ExecutionEngine.Assert(nonceSubkey != null && nonceSubkey.Length == NonceSubkeySize, ErrorOperationMalformed);

            BigInteger credentialGeneration = ResolveCredentialGeneration(accountId, validatorId);
            ByteString namespaceDigest = ComputeNonceNamespaceDigest(
                accountId, control.AuthorityEpoch, validatorId, credentialGeneration, nonceSubkey!);
            byte[] channel = ChannelBytesFromDigest(namespaceDigest);
            BigInteger sequence = ReadNonceCursor(accountId, channel);
            return (BytesToBigInteger(channel) << 64) | sequence;
        }

        /// <summary>The current sequence cursor of an explicit channel.</summary>
        [Safe]
        public static BigInteger getNonceSequence(UInt160 accountId, BigInteger channel)
        {
            ValidateAccountId(accountId);
            byte[] channelBytes = ChannelKeyBytes(channel);
            return ReadNonceCursor(accountId, channelBytes);
        }
    }
}
