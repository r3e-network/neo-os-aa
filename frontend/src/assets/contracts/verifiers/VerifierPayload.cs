using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace AbstractAccount.Verifiers
{
    /// <summary>
    /// Shared payload builder for cryptographic signature verification across all verifier plugins.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This module provides a canonical way to construct the signed message payload for
    /// UserOperation verification. All verifiers that use EVM-style signature verification
    /// (e.g., Web3AuthVerifier, WebAuthnVerifier, ZkLoginVerifier) rely on this payload
    /// format to ensure cryptographic signatures can be verified consistently.
    /// </para>
    /// <para>
    /// <b>Note on NeoNativeVerifier:</b>
    /// The NeoNativeVerifier does NOT use this payload builder because it leverages Neo's
    /// native CheckWitness API instead of EVM-style signature verification. This makes it
    /// significantly more gas-efficient and simpler to use, but only works within the Neo
    /// ecosystem where native witness verification is available.
    /// </para>
    /// <para>
    /// <b>Payload format:</b>
    /// <code>
    ///   network (uint256, big-endian) ||
    ///   verifierHash (20 bytes) ||
    ///   authorizedCoreHash (20 bytes) ||
    ///   accountId (20 bytes) ||
    ///   targetContract (20 bytes) ||
    ///   method (serialized) ||
    ///   args (serialized) ||
    ///   nonce (uint256, big-endian) ||
    ///   deadline (uint256, big-endian)
    /// </code>
    /// </para>
    /// <para>
    /// <b>Extensibility:</b>
    /// The BuildPayload method can be extended to support additional context data
    /// such as:
    /// <list type="bullet">
    ///   <item>Chain-specific metadata for cross-chain operations</item>
    ///   <item>Session identifiers for multi-step transaction flows</item>
    ///   <item>Timestamp-based anti-replay extensions</item>
    ///   <item>Custom verification contexts for specialized verifiers</item>
    /// </list>
    /// </para>
    /// </remarks>
    internal static class VerifierPayload
    {
        /// <summary>
        /// Constructs the canonical signed message payload for UserOperation verification.
        /// </summary>
        /// <param name="accountId">The AA account identifier</param>
        /// <param name="targetContract">The contract being called</param>
        /// <param name="method">The method name being invoked</param>
        /// <param name="args">The arguments to the method</param>
        /// <param name="nonce">The anti-replay nonce value</param>
        /// <param name="deadline">The expiration timestamp for the UserOperation</param>
        /// <returns>The byte array that should be signed by the verifying identity</returns>
        internal static byte[] BuildPayload(UInt160 accountId, UInt160 targetContract, string method, object[] args, BigInteger nonce, BigInteger deadline)
        {
            byte[] argsSerialized = (byte[])StdLib.Serialize(args);
            byte[] methodBytes = (byte[])StdLib.Serialize(method);
            return Helper.Concat(
                Helper.Concat(
                    Helper.Concat(
                        Helper.Concat(
                            Helper.Concat(
                                ToUint256Word((BigInteger)Runtime.GetNetwork()),
                                Helper.Concat(
                                    (byte[])Runtime.ExecutingScriptHash,
                                    (byte[])VerifierAuthority.AuthorizedCore()
                                )
                            ),
                            Helper.Concat((byte[])accountId, (byte[])targetContract)
                        ),
                        methodBytes
                    ),
                    argsSerialized
                ),
                Helper.Concat(ToUint256Word(nonce), ToUint256Word(deadline))
            );
        }

        /// <summary>
        /// Converts a BigInteger to a 32-byte big-endian uint256 word.
        /// </summary>
        /// <remarks>
        /// This conversion is necessary because Neo's BigInteger uses little-endian
        /// serialization, while Ethereum-style cryptographic signatures typically expect
        /// big-endian encoding for uint256 values.
        /// </remarks>
        /// <param name="value">The value to convert (must be non-negative)</param>
        /// <returns>A 32-byte array containing the value in big-endian format</returns>
        /// <exception cref="Exception">Thrown if value is negative or exceeds 256 bits</exception>
        private static byte[] ToUint256Word(BigInteger value)
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
