using Neo.SmartContract.Framework;

namespace SmartAccount.Validators
{
    /// <summary>
    /// Shared credential model for validators that store an elliptic-curve
    /// public key: keys are always persisted in their 33-byte compressed form,
    /// so one key has exactly one stored representation and one signer domain.
    /// </summary>
    internal static class ValidatorKeys
    {
        /// <summary>33-byte compressed form of a 33- or 65-byte P-256 / secp256k1 public key.</summary>
        internal static ByteString Compress(ByteString publicKey)
        {
            ExecutionEngine.Assert(publicKey != null && (publicKey.Length == 33 || publicKey.Length == 65),
                "Invalid public key length");
            byte[] raw = (byte[])publicKey!;
            if (raw.Length == 33)
            {
                ExecutionEngine.Assert(raw[0] == 0x02 || raw[0] == 0x03, "Invalid public key prefix");
                return publicKey!;
            }

            ExecutionEngine.Assert(raw[0] == 0x04, "Invalid public key prefix");
            byte[] compressed = new byte[33];
            compressed[0] = (raw[64] % 2 == 0) ? (byte)0x02 : (byte)0x03;
            for (int i = 0; i < 32; i++)
            {
                compressed[i + 1] = raw[i + 1];
            }
            return (ByteString)compressed;
        }
    }
}
