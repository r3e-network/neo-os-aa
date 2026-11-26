using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Validators
{
    /// <summary>
    /// Validator for a bare secp256r1 (P-256) signature over the core operation digest.
    /// </summary>
    /// <remarks>
    /// <para>
    /// One instance holds one P-256 public key. The signature field of a routed
    /// operation is the raw 64-byte <c>r‖s</c> over
    /// <c>D = SHA256(opPreimage)</c> on a standalone route, or over
    /// <c>D_i = SHA256(memberPreimage)</c> on a threshold route
    /// (docs/SA-MODULE-PROTOCOL.md §4.3, §5). The platform applies that one
    /// hash: this module hands <c>CryptoLib.verifyWithECDsa</c> the preimage,
    /// never the digest.
    /// </para>
    /// <para>
    /// It is <b>not</b> a WebAuthn relying party. Nothing of the WebAuthn ceremony is
    /// present or checked: no <c>challenge</c> binding, no <c>rpIdHash</c>, no
    /// <c>clientDataJSON</c> origin check, no <c>authenticatorData</c> flags and no
    /// sign-counter monotonicity. A caller who can obtain a P-256 signature over the
    /// digest from any source satisfies this validator.
    /// </para>
    /// </remarks>
    [DisplayName("P256Validator")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getModule")]
    [ManifestExtra("Description", "secp256r1 (P-256) signature validator; no WebAuthn ceremony or origin binding")]
    [ManifestExtra("Capabilities", "rawP256")]
    public class P256Validator : SmartContract
    {
        // Canonical bytes of P256Validator.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":true},\"contractName\":\"P256Validator\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        private static readonly byte[] Prefix_PublicKey = new byte[] { 0x01 };

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
        /// 65-byte uncompressed P-256 key).
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

        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId, BigInteger moduleId)
        {
            ByteString publicKey = GetPublicKey(accountId, moduleId);
            ExecutionEngine.Assert(publicKey.Length == 33, "No pubkey configured");
            return new ByteString[] { SignerDomain.Secp256r1(publicKey) };
        }

        /// <summary>
        /// Verifies the 64-byte P-256 signature addressed to this instance. Rejects by
        /// returning false; an unconfigured instance approves nothing.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            BigInteger moduleId = ValidatorAuthority.RequireValidation(accountId, operation);
            ByteString publicKey = GetPublicKey(accountId, moduleId);
            if (publicKey.Length != 33) return false;

            ByteString signature = ModuleOperation.MemberSignature(operation, moduleId);
            if (signature.Length != 64) return false;
            byte[] preimage = ValidatorPayload.VerifiedSigningPreimage(accountId, operationDigest, operation, moduleId);
            return ValidatorPayload.VerifyPreimage(preimage, publicKey, signature);
        }

        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
        {
            ValidatorAuthority.RequireCompletion(accountId, operation);
        }
    }
}
