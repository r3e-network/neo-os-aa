using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Native;

namespace SmartAccount.Modules
{
    /// <summary>
    /// P-256 verification for the message path (SA-SPEC §8 and §14).
    ///
    /// No curve arithmetic, no key handling and no hashing live here. The only
    /// verification primitive is the platform's CryptoLib native contract,
    /// reached through <c>CryptoLib.VerifyWithECDsa</c>, which compiles to a
    /// call on the <c>verifyWithECDsa</c> native entry. The only key type is
    /// the platform's <c>ECPoint</c> primitive.
    ///
    /// Neo 3.10.1 exposes exactly four curve-hash modes — <c>secp256k1SHA256</c>
    /// (22), <c>secp256r1SHA256</c> (23), <c>secp256k1Keccak256</c> (122) and
    /// <c>secp256r1Keccak256</c> (123) — and every one of them hashes the
    /// message before verifying it. Verified in the node sources of this
    /// workspace (<c>Neo/SmartContract/Native/CryptoLib.cs</c>): all three ABI
    /// generations, <c>VerifyWithECDsaV0</c>, <c>V1</c> and <c>V2</c>, end in
    /// <c>Crypto.VerifySignature*</c>, which applies exactly one SHA-256 to the
    /// <c>message</c> argument (<c>ECDsa.VerifyData</c>) for the SHA-256 modes.
    /// This platform release has no ABI at all that verifies a raw 32-byte
    /// digest, so a contract cannot ask the node to check a signature over an
    /// already-computed digest.
    ///
    /// The message path needs exactly one SHA-256 between the signed bytes and
    /// the curve: the §8 digest is SHA-256 over the domain string, the bound
    /// account/sender/validator/generation/epoch fields and the message hash.
    /// The caller therefore hands the platform the *preimage* of that digest,
    /// so the platform's own hash step is the §8 hash — one hash, exactly as
    /// the spec requires. The subject still signs the digest; handing the
    /// digest to this helper instead would hash it a second time and reject
    /// every valid signature (locked by a negative vector).
    ///
    /// Two platform limits shape the guards below, and neither is papered over
    /// with local cryptography:
    ///
    ///   * <c>ECPoint</c> is a 33-byte compressed key and nothing else. The
    ///     framework conversion throws for any other length and
    ///     <c>ECPoint.IsValid</c> checks the shape only, never the curve, so
    ///     this helper refuses every other shape itself before converting.
    ///   * <c>verifyWithECDsa</c> faults when the key cannot be decoded (an X
    ///     coordinate that is not a point on the curve) instead of answering
    ///     <c>false</c>, and Neo does not let a contract catch a fault raised
    ///     inside another contract's execution — a <c>try/catch</c> around this
    ///     call is provably inert (see the documented-boundary test). There is
    ///     no platform entry that validates a point without verifying a
    ///     signature, so an undecodable key cannot be turned into a boolean
    ///     here without re-implementing the curve, which this lane must not do.
    ///
    /// The caller's contract therefore keeps key material reachable only
    /// through a roster-bound canonical script: every pair handed to this
    /// helper must hash to a subject the account configured, so the key is the
    /// account's own published key and never a caller-supplied blob. For every
    /// key the platform can decode, this helper answers a boolean.
    ///
    /// Why this class exists and nothing more: two call sites must agree on
    /// the same input contract — <c>SigningModule.IsValidSignature</c> (the
    /// production path) and the test vector driver <c>TestHook.verifyP256</c>,
    /// which compiles this file verbatim. It holds no curve math, no hashing
    /// and no key derivation: only the 33-byte key shape, the 64-byte
    /// signature shape and the "preimage, never digest" rule, which is what
    /// keeps the platform's single hash equal to the §8 hash. The compiled
    /// evidence is the NEF method token <c>verifyWithECDsa</c> on the CryptoLib
    /// native contract (no local implementation exists to call).
    /// </summary>
    internal static class P256
    {
        /// <summary>The platform native entry this class uses (evidence for the IDL checker and tests).</summary>
        internal const string NativeEntry = "verifyWithECDsa";

        /// <summary>The only key shape the platform <c>ECPoint</c> primitive accepts.</summary>
        private const int CompressedPointSize = 33;

        /// <summary>IEEE P1363 <c>r ‖ s</c>, which is the shape the native entry reads.</summary>
        private const int SignatureSize = 64;

        /// <summary>
        /// Verifies <paramref name="signature"/> over <c>SHA-256(preimage)</c> — the §8
        /// message digest — with the platform's P-256 verification.
        /// </summary>
        internal static bool VerifyMessage(byte[]? preimage, byte[]? publicKey, byte[]? signature)
        {
            if (preimage == null || preimage.Length == 0) return false;
            if (signature == null || signature.Length != SignatureSize) return false;
            if (publicKey == null || publicKey.Length != CompressedPointSize) return false;
            if (publicKey[0] != 0x02 && publicKey[0] != 0x03) return false;

            // The framework conversion re-checks the length; the platform
            // primitive's IsValid re-checks the shape. Neither is curve math.
            ECPoint point = (ECPoint)publicKey;
            if (!point.IsValid) return false;

            return CryptoLib.VerifyWithECDsa((ByteString)preimage, point, (ByteString)signature,
                NamedCurveHash.secp256r1SHA256);
        }
    }
}
