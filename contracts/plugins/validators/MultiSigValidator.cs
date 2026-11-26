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
    /// Threshold-policy member validator: one instance holds one secp256r1
    /// member key and approves an operation only as a member of a core-owned
    /// threshold policy.
    /// </summary>
    /// <remarks>
    /// The threshold, the member set, the approval receipts and the callback
    /// orchestration live in the core (docs/SA-MODULE-PROTOCOL.md §5, §11). This
    /// contract no longer calls child validators and keeps no policy state: an
    /// account installs one instance per co-signer and names those instances in
    /// a threshold policy. An instance is never independently routable — an
    /// operation whose <c>validatorId</c> is the instance itself is rejected, so
    /// a single member key can never stand in for the policy.
    /// Member signature: 64-byte <c>r‖s</c> over the threshold member digest
    /// <c>D_i = SHA256(memberPreimage)</c> (<see cref="ValidatorPayload.MemberDigest"/>),
    /// which binds the core operation digest (and through it the policy id and
    /// its generation), the member instance id and the member's credential
    /// generation. The platform applies that single hash, so the module hands
    /// <c>CryptoLib.verifyWithECDsa</c> the 80-byte member preimage, never the
    /// 32-byte digest.
    /// </remarks>
    [DisplayName("MultiSigValidator")]
#if SMARTACCOUNT_NATIVE
    [ContractPermission("0x398dc3f0227d7efac5533ed5ce9937390c158084", "getAuthorizedModuleId", "getModule")]
    [ManifestExtra("SmartAccountProfile", "native-smartaccount")]
#else
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getModule")]
#endif
    [ManifestExtra("Description", "Threshold-policy member validator; threshold orchestration is owned by the core")]
    public class MultiSigValidator : SmartContract
    {
        // Canonical bytes of MultiSigValidator.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":true,\"messageCapability\":false,\"thresholdMemberEligible\":true},\"contractName\":\"MultiSigValidator\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        // (accountId, moduleId) -> 33-byte compressed secp256r1 member key
        private static readonly byte[] Prefix_MemberKey = new byte[] { 0x01 };

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
        /// <c>initData</c>: empty, or <c>["setMemberKey", publicKey]</c>.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyConfig(accountId, moduleId, initData);
        }

        /// <summary>
        /// <c>configData</c>: <c>["setMemberKey", publicKey]</c> (33-byte compressed or
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
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_MemberKey, accountId, moduleId));
        }

        private static void ApplyConfig(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            ExecutionEngine.Assert(ModuleConfig.Command(data, 1) == "setMemberKey", "Unknown config command");
            Storage.Put(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_MemberKey, accountId, moduleId),
                ValidatorKeys.Compress((ByteString)data[1]));
        }

        /// <summary>The configured 33-byte compressed member key, or empty when unconfigured.</summary>
        [Safe]
        public static ByteString GetMemberKey(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_MemberKey, accountId, moduleId));
            return data ?? (ByteString)"";
        }

        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId, BigInteger moduleId)
        {
            ByteString publicKey = GetMemberKey(accountId, moduleId);
            ExecutionEngine.Assert(publicKey.Length == 33, "No member key configured");
            return new ByteString[] { SignerDomain.Secp256r1(publicKey) };
        }

        /// <summary>
        /// The 32-byte digest this member signs for an operation routed to a threshold
        /// policy, given the core operation digest of that operation.
        /// </summary>
        [Safe]
        public static ByteString GetMemberDigest(UInt160 accountId, BigInteger moduleId, ByteString operationDigest)
        {
            ExecutionEngine.Assert(operationDigest != null && operationDigest.Length == 32, "Invalid operation digest");
            return ValidatorPayload.MemberDigest(operationDigest!, moduleId,
                ValidatorAuthority.CredentialGeneration(accountId, moduleId));
        }

        /// <summary>
        /// Verifies this member's entry of the policy signature list. Rejects by
        /// returning false: standalone routing, an unconfigured instance, a missing
        /// entry and a bad signature all approve nothing, and the core counts the
        /// remaining members against the policy threshold.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            BigInteger moduleId = ValidatorAuthority.RequireValidation(accountId, operation);
            // Policy member only: never the routed validator itself.
            if (ModuleOperation.ValidatorId(operation) == moduleId) return false;

            ByteString publicKey = GetMemberKey(accountId, moduleId);
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
