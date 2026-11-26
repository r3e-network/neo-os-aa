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
    /// Validator for a configured enclave key: a secp256r1 signature over the
    /// core operation digest, produced by a key the account registered as its
    /// enclave key.
    /// </summary>
    /// <remarks>
    /// This contract verifies a signature against a configured key and nothing
    /// else. It does not verify a remote-attestation quote, an enclave
    /// measurement or a certificate chain; whether the key really lives inside
    /// an enclave is established off-chain before the account configures it.
    /// Signature DTO (docs/SA-MODULE-PROTOCOL.md §5), 96 bytes:
    /// <c>keyId(32) ‖ r‖s(64)</c>, where <c>keyId = SHA256(compressedPublicKey)</c>
    /// must equal the id of the instance's configured key.
    /// </remarks>
    [DisplayName("TeeKeyValidator")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getModule")]
    [ManifestExtra("Description", "Configured enclave-key signature validator; no remote-attestation verification")]
    public class TeeKeyValidator : SmartContract
    {
        // Canonical bytes of TeeKeyValidator.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":true},\"contractName\":\"TeeKeyValidator\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_PublicKey = new byte[] { 0x01 };

        private const int KeyIdLength = 32;
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
        /// <c>initData</c>: empty, or <c>["setPublicKey", publicKey]</c>.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyConfig(accountId, moduleId, initData);
        }

        /// <summary>
        /// <c>configData</c>: <c>["setPublicKey", publicKey]</c> (33-byte compressed or
        /// 65-byte uncompressed secp256r1 key).
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] configData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            ApplyConfig(accountId, moduleId, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_PublicKey, accountId, moduleId));
        }

        private static void ApplyConfig(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            ExecutionEngine.Assert(ModuleConfig.Command(data, 1) == "setPublicKey", "Unknown config command");
            Storage.Put(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_PublicKey, accountId, moduleId),
                ValidatorKeys.Compress((ByteString)data[1]));
        }

        [Safe]
        public static ByteString GetPublicKey(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_PublicKey, accountId, moduleId));
            return data ?? (ByteString)"";
        }

        /// <summary>SHA-256 of the configured compressed key, or empty when unconfigured.</summary>
        [Safe]
        public static ByteString GetKeyId(UInt160 accountId, BigInteger moduleId)
        {
            ByteString publicKey = GetPublicKey(accountId, moduleId);
            return publicKey.Length == 33 ? CryptoLib.Sha256(publicKey) : (ByteString)"";
        }

        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId, BigInteger moduleId)
        {
            ByteString publicKey = GetPublicKey(accountId, moduleId);
            ExecutionEngine.Assert(publicKey.Length == 33, "No enclave key configured");
            return new ByteString[] { SignerDomain.Secp256r1(publicKey) };
        }

        /// <summary>
        /// Verifies <c>keyId ‖ r‖s</c> addressed to this instance. Rejects by returning
        /// false; an unconfigured instance approves nothing.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            BigInteger moduleId = ValidatorAuthority.RequireValidation(accountId, operation);
            ByteString publicKey = GetPublicKey(accountId, moduleId);
            if (publicKey.Length != 33) return false;

            ByteString dto = ModuleOperation.MemberSignature(operation, moduleId);
            if (dto.Length != KeyIdLength + SignatureLength) return false;
            byte[] raw = (byte[])dto;
            if ((ByteString)Helper.Range(raw, 0, KeyIdLength) != CryptoLib.Sha256(publicKey)) return false;

            byte[] preimage = ValidatorPayload.VerifiedSigningPreimage(accountId, operationDigest, operation, moduleId);
            return ValidatorPayload.VerifyPreimage(preimage, publicKey, (ByteString)Helper.Range(raw, KeyIdLength, SignatureLength));
        }

        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
        {
            ValidatorAuthority.RequireCompletion(accountId, operation);
        }
    }
}
