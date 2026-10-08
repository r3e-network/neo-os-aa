using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount.Verifiers
{
    /// <summary>
    /// Canonical signer-domain commitments used by the threshold composition profile.
    ///
    /// A domain is not a signature or a proof of possession. It is a stable commitment
    /// to the configured authorization identity which lets MultiSig reject accidental
    /// reuse of one signer across two child verifiers. The native profile still treats
    /// arbitrary third-party verifier honesty and cryptographic soundness as separate
    /// trust boundaries.
    /// </summary>
    internal static class SignerDomain
    {
        private static readonly byte[] Prefix = new byte[] {
            0x4E, 0x65, 0x6F, 0x53, 0x6D, 0x61, 0x72, 0x74,
            0x41, 0x63, 0x63, 0x6F, 0x75, 0x6E, 0x74, 0x2F,
            0x53, 0x69, 0x67, 0x6E, 0x65, 0x72, 0x44, 0x6F,
            0x6D, 0x61, 0x69, 0x6E, 0x01
        };

        public static ByteString Secp256k1(ByteString publicKey) =>
            Commit(0x01, CanonicalPublicKey(publicKey));

        public static ByteString Secp256r1(ByteString publicKey) =>
            Commit(0x02, CanonicalPublicKey(publicKey));

        public static ByteString NativeScript(UInt160 signer) =>
            Commit(0x03, (byte[])signer);

        public static ByteString DkimRegistry(ByteString registry) =>
            Commit(0x04, (byte[])registry);

        private static ByteString Commit(byte scheme, byte[] material)
        {
            return CryptoLib.Sha256((ByteString)Helper.Concat(
                Helper.Concat(Prefix, new byte[] { scheme }), material));
        }

        private static byte[] CanonicalPublicKey(ByteString publicKey)
        {
            ExecutionEngine.Assert(publicKey != null &&
                (publicKey.Length == 33 || publicKey.Length == 65),
                "Invalid public key");

            if (publicKey.Length == 33)
            {
                return (byte[])publicKey;
            }

            byte[] raw = (byte[])publicKey;
            byte[] compressed = new byte[33];
            compressed[0] = (raw[64] % 2 == 0) ? (byte)0x02 : (byte)0x03;
            for (int i = 0; i < 32; i++)
            {
                compressed[i + 1] = raw[i + 1];
            }
            return compressed;
        }
    }
}
