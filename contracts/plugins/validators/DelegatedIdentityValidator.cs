using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Validators
{
    /// <summary>
    /// Validator for a delegated identity signer: a configured secp256r1 key
    /// (for example a Morpheus NeoDID oracle key) signs on behalf of a
    /// Web2-backed identity, and every approval publicly commits to the
    /// identity's provider, master nullifier and a per-action nullifier.
    /// </summary>
    /// <remarks>
    /// This contract verifies a signature against a configured key and checks
    /// that the presented identity commitment equals the configured one. It
    /// does not verify a zero-knowledge proof, a JWT or an OIDC token; the
    /// link between the signer key and the Web2 identity is established
    /// off-chain by the delegated signer.
    /// Signature DTO (docs/SA-MODULE-PROTOCOL.md §5), exact length
    /// <c>130 + providerLength</c> bytes:
    /// <c>0x01 ‖ U8(providerLength) ‖ provider ‖ masterNullifier(32) ‖
    /// actionNullifier(32) ‖ r‖s(64)</c>. The signature covers
    /// <c>SHA256("NeoSmartAccount/DelegatedIdentity" ‖ U1(4) ‖ signingDigest ‖
    /// U8(providerLength) ‖ provider ‖ masterNullifier ‖ actionNullifier)</c>,
    /// where <c>signingDigest</c> is <c>D = SHA256(opPreimage)</c> on a standalone
    /// route (or <c>D_i = SHA256(memberPreimage)</c> on a threshold route). The
    /// platform applies that single hash: the module hands
    /// <c>CryptoLib.verifyWithECDsa</c> the identity preimage, never the digest.
    /// </remarks>
    [DisplayName("DelegatedIdentityValidator")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getModule")]
    [ManifestExtra("Description", "Delegated-signer identity validator with public nullifier binding; no zero-knowledge verification")]
    public class DelegatedIdentityValidator : SmartContract
    {
        // Canonical bytes of DelegatedIdentityValidator.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":true},\"contractName\":\"DelegatedIdentityValidator\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        // (accountId, moduleId) -> serialized [signerPublicKey(33), provider, masterNullifier(32)]
        private static readonly byte[] Prefix_Config = new byte[] { 0x01 };

        // UTF8("NeoSmartAccount/DelegatedIdentity")
        private static readonly byte[] IdentityDomain = new byte[]
        {
            0x4E, 0x65, 0x6F, 0x53, 0x6D, 0x61, 0x72, 0x74,
            0x41, 0x63, 0x63, 0x6F, 0x75, 0x6E, 0x74, 0x2F,
            0x44, 0x65, 0x6C, 0x65, 0x67, 0x61, 0x74, 0x65,
            0x64, 0x49, 0x64, 0x65, 0x6E, 0x74, 0x69, 0x74,
            0x79
        };

        private const byte ProofVersion = 0x01;
        private const int NullifierLength = 32;
        private const int SignatureLength = 64;

        public static void _deploy(object data, bool update) => ValidatorAuthority.Initialize(data, update);

        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

        [Safe]
        public static UInt160 AuthorizedCore() => ValidatorAuthority.AuthorizedCore();

        public static void SetAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.SetAuthorizedCore(coreContract);
        // Audit fix M-7 (parity with hooks): timelocked core re-pointing.
        public static void ProposeAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.ProposeAuthorizedCore(coreContract);
        public static void ConfirmAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.ConfirmAuthorizedCore(coreContract);
        public static void CancelAuthorizedCoreChange() => ValidatorAuthority.CancelAuthorizedCoreChange();

        // SA-D-01: timelocked upgrade — Update only succeeds for an artifact pair that was
        // pinned via ProposeUpdate at least 7 days earlier.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => ValidatorAuthority.ProposeUpdate(nefHash, manifestHash);

        public static void ConfirmUpdate(ByteString nef, string manifest) => ValidatorAuthority.Update(nef, manifest);

        public static void CancelUpdate() => ValidatorAuthority.CancelUpdate();

        public static void Update(ByteString nef, string manifest) => ValidatorAuthority.Update(nef, manifest);

        /// <summary>
        /// <c>initData</c>: empty, or <c>["setConfig", signerPublicKey, provider, masterNullifier]</c>.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyConfig(accountId, moduleId, initData);
        }

        /// <summary>
        /// <c>configData</c>: <c>["setConfig", signerPublicKey, provider, masterNullifier]</c>.
        /// The key is a 33-byte compressed or 65-byte uncompressed secp256r1 key, the
        /// provider is 1–255 bytes and the master nullifier is exactly 32 bytes.
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] configData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            ApplyConfig(accountId, moduleId, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_Config, accountId, moduleId));
        }

        private static void ApplyConfig(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            ExecutionEngine.Assert(ModuleConfig.Command(data, 3) == "setConfig", "Unknown config command");
            ByteString signerPublicKey = ValidatorKeys.Compress((ByteString)data[1]);
            ByteString provider = (ByteString)data[2];
            ByteString masterNullifier = (ByteString)data[3];
            // The provider travels with a single-byte length prefix in the proof and
            // the signed preimage; reject values that cannot be encoded canonically.
            ExecutionEngine.Assert(provider != null && provider.Length > 0 && provider.Length <= 255, "Provider must be 1-255 bytes");
            ExecutionEngine.Assert(masterNullifier != null && masterNullifier.Length == NullifierLength, "Invalid master nullifier");

            Storage.Put(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_Config, accountId, moduleId),
                StdLib.Serialize(new object[] { signerPublicKey, provider, masterNullifier }));
        }

        /// <summary><c>[signerPublicKey, provider, masterNullifier]</c>, or an empty array when unconfigured.</summary>
        [Safe]
        public static object[] GetConfig(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_Config, accountId, moduleId));
            if (data == null) return new object[0];
            return (object[])StdLib.Deserialize(data);
        }

        [Safe]
        public static ByteString GetPublicKey(UInt160 accountId, BigInteger moduleId)
        {
            object[] config = GetConfig(accountId, moduleId);
            return config.Length == 3 ? (ByteString)config[0] : (ByteString)"";
        }

        [Safe]
        public static string GetProvider(UInt160 accountId, BigInteger moduleId)
        {
            object[] config = GetConfig(accountId, moduleId);
            return config.Length == 3 ? (string)config[1] : "";
        }

        [Safe]
        public static ByteString GetMasterNullifier(UInt160 accountId, BigInteger moduleId)
        {
            object[] config = GetConfig(accountId, moduleId);
            return config.Length == 3 ? (ByteString)config[2] : (ByteString)"";
        }

        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId, BigInteger moduleId)
        {
            ByteString publicKey = GetPublicKey(accountId, moduleId);
            ExecutionEngine.Assert(publicKey.Length == 33, "No delegated signer configured");
            return new ByteString[] { SignerDomain.Secp256r1(publicKey) };
        }

        /// <summary>
        /// Verifies the proof addressed to this instance. Rejects by returning false:
        /// an unconfigured instance, a malformed proof, an identity commitment that
        /// differs from the configured one and a bad signature all approve nothing.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            BigInteger moduleId = ValidatorAuthority.RequireValidation(accountId, operation);
            object[] config = GetConfig(accountId, moduleId);
            if (config.Length != 3) return false;
            ByteString provider = (ByteString)config[1];
            ByteString masterNullifier = (ByteString)config[2];

            // Exact-length canonical proof: no trailing bytes, so one approval has
            // exactly one encoding.
            byte[] proof = (byte[])ModuleOperation.MemberSignature(operation, moduleId);
            int expectedLength = 2 + provider.Length + NullifierLength + NullifierLength + SignatureLength;
            if (proof.Length != expectedLength) return false;
            if (proof[0] != ProofVersion) return false;
            if (proof[1] != provider.Length) return false;

            int cursor = 2;
            if ((ByteString)Helper.Range(proof, cursor, provider.Length) != provider) return false;
            cursor += provider.Length;
            if ((ByteString)Helper.Range(proof, cursor, NullifierLength) != masterNullifier) return false;
            cursor += NullifierLength;
            ByteString actionNullifier = (ByteString)Helper.Range(proof, cursor, NullifierLength);
            cursor += NullifierLength;
            ByteString signature = (ByteString)Helper.Range(proof, cursor, SignatureLength);

            byte[] signingPreimage = ValidatorPayload.VerifiedSigningPreimage(accountId, operationDigest, operation, moduleId);
            if (signingPreimage.Length == 0) return false;
            ByteString signingDigest = CryptoLib.Sha256((ByteString)signingPreimage);
            return ValidatorPayload.VerifyPreimage(
                IdentityPreimage(signingDigest, provider, masterNullifier, actionNullifier),
                (ByteString)config[0],
                signature);
        }

        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
        {
            ValidatorAuthority.RequireCompletion(accountId, operation);
        }

        /// <summary>
        /// The 32-byte digest the delegated signer signs for a standalone-routed
        /// operation of this instance: the core operation digest bound to the
        /// configured identity commitment and the chosen action nullifier.
        /// </summary>
        [Safe]
        public static ByteString GetSigningDigest(UInt160 accountId, BigInteger moduleId, ByteString operationDigest, ByteString actionNullifier)
        {
            ExecutionEngine.Assert(operationDigest != null && operationDigest.Length == 32, "Invalid operation digest");
            ExecutionEngine.Assert(actionNullifier != null && actionNullifier.Length == NullifierLength, "Invalid action nullifier");
            object[] config = GetConfig(accountId, moduleId);
            ExecutionEngine.Assert(config.Length == 3, "No delegated signer configured");
            return IdentityDigest(operationDigest!, (ByteString)config[1], (ByteString)config[2], actionNullifier!);
        }

        private static ByteString IdentityDigest(ByteString signingDigest, ByteString provider, ByteString masterNullifier, ByteString actionNullifier)
        {
            return CryptoLib.Sha256((ByteString)IdentityPreimage(signingDigest, provider, masterNullifier, actionNullifier));
        }

        private static byte[] IdentityPreimage(ByteString signingDigest, ByteString provider, ByteString masterNullifier, ByteString actionNullifier)
        {
            byte[] preimage = Helper.Concat(IdentityDomain, new byte[] { 4 });
            preimage = Helper.Concat(preimage, (byte[])signingDigest);
            preimage = Helper.Concat(preimage, new byte[] { (byte)provider.Length });
            preimage = Helper.Concat(preimage, (byte[])provider);
            preimage = Helper.Concat(preimage, (byte[])masterNullifier);
            preimage = Helper.Concat(preimage, (byte[])actionNullifier);
            return preimage;
        }
    }
}
