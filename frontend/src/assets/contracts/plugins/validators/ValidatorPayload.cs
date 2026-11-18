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
    /// </summary>
    internal static class ValidatorPayload
    {
        // UTF8("NeoSmartAccount/ThresholdMember")
        private static readonly byte[] ThresholdMemberDomain = new byte[] {
            0x4E, 0x65, 0x6F, 0x53, 0x6D, 0x61, 0x72, 0x74,
            0x41, 0x63, 0x63, 0x6F, 0x75, 0x6E, 0x74, 0x2F,
            0x54, 0x68, 0x72, 0x65, 0x73, 0x68, 0x6F, 0x6C,
            0x64, 0x4D, 0x65, 0x6D, 0x62, 0x65, 0x72
        };

        /// <summary>
        /// The 32-byte digest one validator instance verifies. Standalone route:
        /// the core operation digest. Threshold route (the operation names a
        /// policy id): the member digest
        /// <c>SHA256(domain ‖ U1(4) ‖ operationDigest ‖ U64BE(memberModuleId) ‖
        /// U64BE(memberCredentialGeneration))</c>, so one member's approval can
        /// never stand in for another member holding the same key and dies with
        /// that member's credential generation (spec §5).
        /// </summary>
        internal static ByteString SigningDigest(UInt160 accountId, ByteString operationDigest, object[] operation, BigInteger moduleId)
        {
            ExecutionEngine.Assert(operationDigest != null && operationDigest.Length == 32, "Invalid operation digest");
            if (ModuleOperation.ValidatorId(operation) == moduleId) return operationDigest!;
            return MemberDigest(operationDigest!, moduleId, ValidatorAuthority.CredentialGeneration(accountId, moduleId));
        }

        internal static ByteString MemberDigest(ByteString operationDigest, BigInteger moduleId, BigInteger credentialGeneration)
        {
            byte[] preimage = Helper.Concat(ThresholdMemberDomain, new byte[] { 4 });
            preimage = Helper.Concat(preimage, (byte[])operationDigest);
            preimage = Helper.Concat(preimage, ModuleContext.U64BE(moduleId));
            preimage = Helper.Concat(preimage, ModuleContext.U64BE(credentialGeneration));
            return CryptoLib.Sha256((ByteString)preimage);
        }

        /// <summary>
        /// secp256r1 / SHA-256 verification of a 64-byte <c>r‖s</c> signature
        /// over a digest, against a 33-byte compressed key.
        /// </summary>
        internal static bool VerifyP256(ByteString digest, ByteString compressedPublicKey, ByteString signature)
        {
            if (signature == null || signature.Length != 64) return false;
            if (compressedPublicKey == null || compressedPublicKey.Length != 33) return false;
            return CryptoLib.VerifyWithECDsa(digest, (ECPoint)compressedPublicKey, signature, NamedCurveHash.secp256r1SHA256);
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
