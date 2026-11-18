using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    /// <summary>
    /// Built-in message signatures, ERC-1271 profile (protocol v4, spec §8):
    /// core P-256 single/threshold message verification with no plugin
    /// dependency, the 0x57 subject store, and the message-signature domain.
    ///
    /// Message validation is READ-ONLY: it never consumes operation nonces,
    /// never runs stateful quota hooks, and a transaction witness can never
    /// satisfy it — a contract custody passing CheckWitness does not thereby
    /// produce an offline message signature.
    /// </summary>
    public partial class SmartAccount
    {
        // UTF8("NeoSmartAccount/Message") — 23 bytes.
        private static readonly byte[] MessageDomainPrefix = new byte[]
        {
            0x4E, 0x65, 0x6F, 0x53, 0x6D, 0x61, 0x72, 0x74,
            0x41, 0x63, 0x63, 0x6F, 0x75, 0x6E, 0x74, 0x2F,
            0x4D, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65
        };

        // Canonical N3 P-256 verification script shape (40 bytes):
        //   PUSHDATA1(0x0C) 0x21 <33-byte compressed point> SYSCALL(0x41) 74 74 76 AA
        // where 747476aa = first 4 bytes of SHA256("Neo.Crypto.CheckSig").
        private const int CanonicalP256ScriptSize = 40;
        private static readonly byte[] CheckSigSyscallHash = new byte[] { 0x74, 0x74, 0x76, 0xAA };

        /// <summary>4-byte little-endian encoding of the network magic.</summary>
        private static byte[] U32LEBytes(uint value)
        {
            return new byte[]
            {
                (byte)(value & 0xFF),
                (byte)((value >> 8) & 0xFF),
                (byte)((value >> 16) & 0xFF),
                (byte)((value >> 24) & 0xFF)
            };
        }

        // ========================================================================
        // 1. Subject store (0x57)
        // ========================================================================

        private static MessageSubjectRecord? GetMessageSubjects(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext, MessageSubjectKey(accountId));
            return data == null ? null : (MessageSubjectRecord)StdLib.Deserialize(data!);
        }

        private static void PutMessageSubjects(UInt160 accountId, MessageSubjectRecord record)
        {
            Storage.Put(Storage.CurrentContext, MessageSubjectKey(accountId), StdLib.Serialize(record));
        }

        /// <summary>
        /// Registration default (spec §8: "new account registration must set a
        /// message subject (default = custody address)"). The default subject is
        /// the 20-byte custody account script hash: a canonical P-256 custody
        /// script hashes back to exactly that address, so the custody key can
        /// sign built-in messages IMMEDIATELY after registration instead of
        /// waiting 24h for a subject intent. 32-byte entries remain available for
        /// script-hash subjects configured through the intent path.
        /// </summary>
        private static void InitializeDefaultMessageSubjects(UInt160 accountId, AccountControl control)
        {
            MessageSubjectRecord record = new MessageSubjectRecord();
            record.Subjects = new ByteString[] { (ByteString)(byte[])control.Custody };
            record.Threshold = BigInteger.One;
            record.SubjectRevision = BigInteger.One;
            PutMessageSubjects(accountId, record);
        }

        /// <summary>
        /// Subject matching (spec §8). A 20-byte subject is the signer's account
        /// address (RIPEMD160(SHA256(script)) reversed, the N3 script hash); a
        /// 32-byte subject is the raw SHA256 of the signer's verification script.
        /// Both bind the signer SCRIPT, which is what the ECDSA check verifies.
        /// </summary>
        private static bool SubjectMatches(ByteString subject, ByteString script, ByteString scriptSha256)
        {
            if (subject.Length == 32) return subject == scriptSha256;
            if (subject.Length == 20) return (UInt160)subject == (UInt160)CryptoLib.Ripemd160(scriptSha256);
            return false;
        }

        /// <summary>
        /// setMessageSubjects configuration action (spec §9): custody-gated,
        /// 24h-timelocked through the intent path; every change advances
        /// subjectRevision, which is the built-in credentialGeneration.
        /// </summary>
        private static void ExecuteSetMessageSubjectsAction(UInt160 accountId, AccountControl control, object[] action)
        {
            // [ActionSetMessageSubjects, subjects(ByteString[32]...), threshold]
            ExecutionEngine.Assert(action.Length == 3, ErrorOperationMalformed);
            ByteString[] subjects = ToByteStringArray(action[1]);
            BigInteger threshold = (BigInteger)action[2];
            ExecutionEngine.Assert(subjects.Length <= MessageSubjectKeysMax, ErrorOperationMalformed);
            ExecutionEngine.Assert(threshold >= 1 && threshold <= subjects.Length, ErrorOperationMalformed);
            for (int i = 0; i < subjects.Length; i++)
            {
                // 20-byte account-address subjects and 32-byte script-hash
                // subjects are both accepted (see SubjectMatches).
                ExecutionEngine.Assert(subjects[i].Length == 20 || subjects[i].Length == 32,
                    ErrorOperationMalformed);
                for (int j = 0; j < i; j++)
                {
                    ExecutionEngine.Assert(subjects[j] != subjects[i], ErrorOperationMalformed);
                }
            }

            MessageSubjectRecord? record = GetMessageSubjects(accountId);
            if (record == null)
            {
                record = new MessageSubjectRecord();
                record.SubjectRevision = BigInteger.Zero;
            }
            record!.Subjects = subjects;
            record.Threshold = threshold;
            record.SubjectRevision += 1;
            PutMessageSubjects(accountId, record);
            OnMessageSubjectUpdated(accountId, subjects.Length, threshold, record.SubjectRevision);
        }

        // ========================================================================
        // 2. Message digest domain (spec §8)
        // ========================================================================

        /// <summary>
        /// messageDigest := SHA256( UTF8("NeoSmartAccount/Message") || U1(4) ||
        /// U32LE(network) || coreHash || accountId || originalSender ||
        /// U64BE(validatorId) || U64BE(credentialGeneration) || U64BE(authorityEpoch) || hash ).
        /// </summary>
        private static ByteString ComputeMessageDigest(
            UInt160 accountId, UInt160 originalSender, BigInteger validatorId,
            BigInteger credentialGeneration, BigInteger authorityEpoch, ByteString hash)
        {
            byte[] domain = Helper.Concat(MessageDomainPrefix, new byte[] { (byte)ModuleProtocolVersion });
            domain = Helper.Concat(domain, U32LEBytes(Runtime.GetNetwork()));
            domain = Helper.Concat(domain, (byte[])Runtime.ExecutingScriptHash);
            domain = Helper.Concat(domain, (byte[])accountId);
            domain = Helper.Concat(domain, (byte[])originalSender);
            domain = Helper.Concat(domain, UInt64DomainBytes(validatorId));
            domain = Helper.Concat(domain, UInt64DomainBytes(credentialGeneration));
            domain = Helper.Concat(domain, UInt64DomainBytes(authorityEpoch));
            return CryptoLib.Sha256((ByteString)Helper.Concat(domain, (byte[])hash));
        }

        // ========================================================================
        // 3. Canonical P-256 script validation
        // ========================================================================

        /// <summary>
        /// Extracts the 33-byte compressed point from a canonical N3 P-256
        /// verification script, or null when the script is not the standard
        /// wallet script-builder shape (off-curve points and non-canonical
        /// scripts are rejected here; curve membership is enforced by
        /// VerifyWithECDsa).
        /// </summary>
        private static byte[]? TryGetCanonicalP256Point(ByteString script)
        {
            byte[] bytes = (byte[])script;
            if (bytes.Length != CanonicalP256ScriptSize) return null;
            if (bytes[0] != 0x0C || bytes[1] != 0x21) return null;
            if (bytes[2] != 0x02 && bytes[2] != 0x03) return null;
            if (bytes[35] != 0x41) return null;
            for (int i = 0; i < CheckSigSyscallHash.Length; i++)
            {
                if (bytes[36 + i] != CheckSigSyscallHash[i]) return null;
            }
            byte[] point = new byte[33];
            for (int i = 0; i < 33; i++)
            {
                point[i] = bytes[2 + i];
            }
            return point;
        }

        // ========================================================================
        // 4. ERC-1271 entrypoint
        // ========================================================================

        /// <summary>
        /// ERC-1271-style message-signature check. Returns the strict 4-byte
        /// magic (bytes4, spec §8): 0x1626ba7e on success, 0xffffffff on ANY
        /// failure — throwing is never the success channel. Read-only: no nonce
        /// consumption, no quota hooks, no witness satisfaction.
        /// </summary>
        [Safe]
        public static ByteString isValidSignature(UInt160 accountId, ByteString hash, object signatureEnvelope)
        {
            try
            {
                return IsValidSignatureCore(accountId, hash, signatureEnvelope);
            }
            catch
            {
                return InvalidSignatureMagic();
            }
        }

        /// <summary>4-byte big-endian ERC-1271 magic value.</summary>
        private static ByteString MagicBytes(uint magic)
        {
            return (ByteString)new byte[]
            {
                (byte)((magic >> 24) & 0xFF),
                (byte)((magic >> 16) & 0xFF),
                (byte)((magic >> 8) & 0xFF),
                (byte)(magic & 0xFF)
            };
        }

        private static ByteString ValidSignatureMagic() => MagicBytes(MagicIsValidSignature);

        private static ByteString InvalidSignatureMagic() => MagicBytes(MagicInvalidSignature);

        private static ByteString IsValidSignatureCore(UInt160 accountId, ByteString hash, object signatureEnvelope)
        {
            ValidateAccountId(accountId);
            AccountControl control = RequireAccountControl(accountId);
            // Freeze reachability (#14): a frozen (or migration-required) account
            // is fully stopped — message authorization fails closed with the
            // invalid-signature magic instead of staying reachable.
            if (control.Status != AccountStatusActive) return InvalidSignatureMagic();
            if (hash == null || hash.Length != MessageHashSize) return InvalidSignatureMagic();

            object[] envelope = (object[])signatureEnvelope;
            if (envelope.Length != 4) return InvalidSignatureMagic();
            if ((BigInteger)envelope[0] != ModuleProtocolVersion) return InvalidSignatureMagic();
            BigInteger validatorId = (BigInteger)envelope[1];
            BigInteger credentialGeneration = (BigInteger)envelope[2];
            if (validatorId < 0) return InvalidSignatureMagic();
            object[] signaturePairs = (object[])envelope[3];
            if (signaturePairs.Length < 1 || signaturePairs.Length > MessageSubjectKeysMax) return InvalidSignatureMagic();

            UInt160 originalSender = Runtime.CallingScriptHash;

            if (validatorId == 0)
            {
                // Built-in route: gated by the default message authorization
                // switch and the 0x57 subject set.
                if (!control.DefaultMessageAuthorization) return InvalidSignatureMagic();
                MessageSubjectRecord? subjects = GetMessageSubjects(accountId);
                if (subjects == null) return InvalidSignatureMagic();
                if (subjects!.Subjects.Length == 0 || subjects.Threshold < 1) return InvalidSignatureMagic();
                if (credentialGeneration != subjects.SubjectRevision) return InvalidSignatureMagic();

                ByteString messageDigest = ComputeMessageDigest(
                    accountId, originalSender, validatorId, credentialGeneration,
                    control.AuthorityEpoch, hash);

                BigInteger approvals = BigInteger.Zero;
                for (int i = 0; i < signaturePairs.Length; i++)
                {
                    object[] pair = (object[])signaturePairs[i];
                    if (pair.Length != 2) return InvalidSignatureMagic();
                    ByteString script = (ByteString)pair[0];
                    ByteString signature = (ByteString)pair[1];
                    if (signature.Length != P256SignatureSize) return InvalidSignatureMagic();

                    byte[]? point = TryGetCanonicalP256Point(script);
                    if (point == null) return InvalidSignatureMagic();

                    ByteString scriptSha256 = CryptoLib.Sha256(script);
                    bool authorized = false;
                    for (int j = 0; j < subjects.Subjects.Length; j++)
                    {
                        if (SubjectMatches(subjects.Subjects[j], script, scriptSha256))
                        {
                            authorized = true;
                            break;
                        }
                    }
                    if (!authorized) return InvalidSignatureMagic();

                    // Scripts in the envelope must be pairwise distinct.
                    for (int j = 0; j < i; j++)
                    {
                        object[] previous = (object[])signaturePairs[j];
                        if ((ByteString)previous[0] == script) return InvalidSignatureMagic();
                    }

                    if (!CryptoLib.VerifyWithECDsa(
                            messageDigest, (ECPoint)point!, signature,
                            NamedCurveHash.secp256r1SHA256))
                    {
                        return InvalidSignatureMagic();
                    }
                    approvals += 1;
                }

                return approvals >= subjects.Threshold ? ValidSignatureMagic() : InvalidSignatureMagic();
            }

            // Module route: only validators whose profile declares
            // messageCapability (SA_MODULE_MESSAGE_CAPABILITY_ABSENT domain).
            ModuleInstance? module = GetModuleInstance(accountId, validatorId);
            if (module == null) return InvalidSignatureMagic();
            if (module.ModuleType != ModuleTypeCodeValidator) return InvalidSignatureMagic();
            if (!module.MessageCapability) return InvalidSignatureMagic();
            if (credentialGeneration != module.CredentialGeneration) return InvalidSignatureMagic();
            AssertCodeBindingUnchanged(module);

            ByteString moduleMessageDigest = ComputeMessageDigest(
                accountId, originalSender, validatorId, credentialGeneration,
                control.AuthorityEpoch, hash);

            // TODO(26): v4 forward ABI (accountId, originalSender, validatorId,
            // generation, hash, signatures). The legacy plugin ABI is
            // isValidSignature(accountId, hash, signature); the sanitized
            // payload forwarded today is the serialized signature-pair array.
            AssertCallbackGasBudget(ValidationAggregateGasLimit);
            long gasBefore = Runtime.GasLeft;
            bool accepted = (bool)CallModuleGasCapped(
                module.ContractHash, "isValidSignature", CallFlags.ReadOnly, ValidationAggregateGasLimit,
                new object[] { accountId, moduleMessageDigest, StdLib.Serialize(signaturePairs) });
            ChargeCallbackGas(null, GasPoolNone, gasBefore, ValidationAggregateGasLimit);
            return accepted ? ValidSignatureMagic() : InvalidSignatureMagic();
        }
    }
}
