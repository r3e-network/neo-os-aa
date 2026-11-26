using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount.Validators
{
    /// <summary>
    /// What a validator signature commits to. Protocol v4 validators do not
    /// build their own operation payload: the core computes the operation
    /// digest (docs/SA-MODULE-PROTOCOL.md §4.3), which already binds protocol
    /// version, network, core hash, account, validatorId, credentialGeneration,
    /// authorityEpoch, configurationNonce and every unsigned operation field,
    /// and passes it to <c>validateUserOp</c>.
    ///
    /// <para>
    /// Platform P-256 verification hashes exactly once: the CryptoLib native
    /// entry <c>verifyWithECDsa(..., secp256r1SHA256)</c> applies one SHA-256 to
    /// its <c>message</c> argument and no platform entry verifies a raw digest.
    /// Every helper here therefore reconstructs the digest PREIMAGE and hands
    /// that to CryptoLib, so the platform's single hash is the spec hash:
    /// <c>D = SHA256(opPreimage)</c> on a standalone route and
    /// <c>D_i = SHA256(memberPreimage)</c> on a threshold route. Passing a
    /// 32-byte digest to CryptoLib would hash it a second time and reject every
    /// genuine signature (locked by a negative vector).
    /// </para>
    /// <para>
    /// Signature format is fixed by the native entry: 64-byte IEEE P1363
    /// <c>r‖s</c> against a 33-byte compressed public key. No curve arithmetic
    /// lives here.
    /// </para>
    /// </summary>
    internal static class ValidatorPayload
    {
        // UTF8("NeoSmartAccount/UserOperation"), the §4.3 domain.
        private static readonly byte[] OperationDomain = new byte[] {
            0x4E, 0x65, 0x6F, 0x53, 0x6D, 0x61, 0x72, 0x74,
            0x41, 0x63, 0x63, 0x6F, 0x75, 0x6E, 0x74, 0x2F,
            0x55, 0x73, 0x65, 0x72, 0x4F, 0x70, 0x65, 0x72,
            0x61, 0x74, 0x69, 0x6F, 0x6E
        };

        // UTF8("NeoSmartAccount/ThresholdMember")
        private static readonly byte[] ThresholdMemberDomain = new byte[] {
            0x4E, 0x65, 0x6F, 0x53, 0x6D, 0x61, 0x72, 0x74,
            0x41, 0x63, 0x63, 0x6F, 0x75, 0x6E, 0x74, 0x2F,
            0x54, 0x68, 0x72, 0x65, 0x73, 0x68, 0x6F, 0x6C,
            0x64, 0x4D, 0x65, 0x6D, 0x62, 0x65, 0x72
        };

        private const byte ProtocolVersion = 4;

        /// <summary>
        /// The §4.3 digest preimage of one operation:
        /// <c>UTF8("NeoSmartAccount/UserOperation") ‖ U1(4) ‖ U32LE(network) ‖
        /// coreHash(20) ‖ accountId(20) ‖ U64BE(validatorId) ‖
        /// U64BE(credentialGeneration) ‖ U64BE(authorityEpoch) ‖
        /// U64BE(configurationNonce) ‖ serialized canonical operation</c>.
        /// The canonical view is the 13-field envelope with the signature field
        /// replaced by the empty byte string, serialized exactly as the core
        /// serializes it (NeoVM binary serializer).
        /// </summary>
        internal static byte[] OperationPreimage(UInt160 accountId, object[] operation)
        {
            ModuleOperation.RequireShape(operation);
            byte[] domain = Helper.Concat(Helper.Concat(
                Helper.Concat(OperationDomain, new byte[] { ProtocolVersion }),
                ModuleContext.U32LE(Runtime.GetNetwork())),
                (byte[])ValidatorAuthority.Core());
            domain = Helper.Concat(domain, (byte[])accountId);
            domain = Helper.Concat(domain, ModuleContext.U64BE(ModuleOperation.ValidatorId(operation)));
            domain = Helper.Concat(domain, ModuleContext.U64BE((BigInteger)operation[ModuleOperation.FieldCredentialGeneration]));
            domain = Helper.Concat(domain, ModuleContext.U64BE((BigInteger)operation[9]));
            domain = Helper.Concat(domain, ModuleContext.U64BE((BigInteger)operation[10]));
            return Helper.Concat(domain, (byte[])SerializeCanonical(operation));
        }

        // The 13-field operation with field 11 (signature) replaced by the empty
        // ByteString, serialized by the platform so the bytes equal the core's.
        // The replacement must be a ByteString, not `new byte[0]`: the compiler
        // encodes a `byte[]` as a VM Buffer (type 0x30), while the core writes
        // ByteString.Empty (type 0x28), and one type byte changes the digest.
        private static ByteString SerializeCanonical(object[] operation)
        {
            object[] canonical = new object[ModuleOperation.FieldCount];
            for (int i = 0; i < canonical.Length; i++) canonical[i] = operation[i];
            canonical[ModuleOperation.FieldSignature] = (ByteString)new byte[0];
            return StdLib.Serialize(canonical);
        }

        /// <summary>
        /// The 80-byte threshold member preimage
        /// <c>domain(31) ‖ U1(4) ‖ D(32) ‖ U64BE(memberModuleId) ‖
        /// U64BE(memberCredentialGeneration)</c>. <c>SHA256</c> of these bytes is
        /// the member digest <c>D_i</c>: one member's approval can never stand in
        /// for another member holding the same key and dies with that member's
        /// credential generation (spec §5).
        /// </summary>
        internal static byte[] MemberPreimage(ByteString operationDigest, BigInteger moduleId, BigInteger credentialGeneration)
        {
            byte[] preimage = Helper.Concat(ThresholdMemberDomain, new byte[] { ProtocolVersion });
            preimage = Helper.Concat(preimage, (byte[])operationDigest);
            preimage = Helper.Concat(preimage, ModuleContext.U64BE(moduleId));
            preimage = Helper.Concat(preimage, ModuleContext.U64BE(credentialGeneration));
            return preimage;
        }

        internal static ByteString MemberDigest(ByteString operationDigest, BigInteger moduleId, BigInteger credentialGeneration)
        {
            ExecutionEngine.Assert(operationDigest != null && operationDigest.Length == 32, "Invalid operation digest");
            return CryptoLib.Sha256((ByteString)MemberPreimage(operationDigest!, moduleId, credentialGeneration));
        }

        /// <summary>
        /// The 32-byte digest one validator instance verifies, for callers that
        /// expose it (EIP-712 payloads, member digest views). Standalone route:
        /// the core operation digest. Threshold route: <c>SHA256(memberPreimage)</c>.
        /// </summary>
        internal static ByteString SigningDigest(UInt160 accountId, ByteString operationDigest, object[] operation, BigInteger moduleId)
        {
            ExecutionEngine.Assert(operationDigest != null && operationDigest.Length == 32, "Invalid operation digest");
            if (ModuleOperation.ValidatorId(operation) == moduleId) return operationDigest!;
            return MemberDigest(operationDigest!, moduleId, ValidatorAuthority.CredentialGeneration(accountId, moduleId));
        }

        /// <summary>
        /// The preimage the platform must hash for this instance: the operation
        /// preimage on a standalone route, the 80-byte member preimage on a
        /// threshold route. Fails closed with an empty array when the supplied
        /// digest is not <c>SHA256(opPreimage)</c> (a stale or foreign digest, a
        /// different account or a different network yields a different preimage).
        /// </summary>
        internal static byte[] VerifiedSigningPreimage(UInt160 accountId, ByteString operationDigest, object[] operation, BigInteger moduleId)
        {
            if (operationDigest == null || operationDigest!.Length != 32) return new byte[0];
            byte[] preimage = OperationPreimage(accountId, operation);
            if (StdLib.MemoryCompare(CryptoLib.Sha256((ByteString)preimage), operationDigest) != 0) return new byte[0];
            if (ModuleOperation.ValidatorId(operation) == moduleId) return preimage;
            return MemberPreimage(operationDigest, moduleId, ValidatorAuthority.CredentialGeneration(accountId, moduleId));
        }

        /// <summary>
        /// secp256r1 / SHA-256 verification of a 64-byte <c>r‖s</c> signature
        /// over <c>SHA256(preimage)</c>, against a 33-byte compressed key. The
        /// platform applies the only hash: never pass a digest here.
        /// </summary>
        internal static bool VerifyPreimage(byte[] preimage, ByteString compressedPublicKey, ByteString signature)
        {
            if (preimage == null || preimage.Length == 0) return false;
            if (signature == null || signature!.Length != 64) return false;
            if (compressedPublicKey == null || compressedPublicKey!.Length != 33) return false;
            byte[] raw = (byte[])compressedPublicKey;
            if (raw[0] != 0x02 && raw[0] != 0x03) return false;
            ECPoint point = (ECPoint)compressedPublicKey;
            if (!point.IsValid) return false;
            return CryptoLib.VerifyWithECDsa((ByteString)preimage, point, signature!, NamedCurveHash.secp256r1SHA256);
        }

        /// <summary>32-byte big-endian word of a non-negative integer.</summary>
        internal static byte[] ToUint256Word(BigInteger value)
        {
            ExecutionEngine.Assert(value >= 0, "Invalid uint256");
            byte[] little = value.ToByteArray();
            int length = little.Length;
            if (length > 0 && little[length - 1] == 0)
            {
                length--;
            }
            ExecutionEngine.Assert(length <= 32, "Uint256 overflow");

            byte[] result = new byte[32];
            for (int i = 0; i < length; i++)
            {
                result[31 - i] = little[i];
            }
            return result;
        }
    }
}
