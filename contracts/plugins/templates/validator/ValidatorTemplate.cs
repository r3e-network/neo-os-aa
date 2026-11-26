using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Validators
{
    /// <summary>
    /// Minimal protocol v4 validator template: one secp256r1 key per instance
    /// authorizes operations.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Copy this file and <c>ValidatorTemplate.csproj</c>, rename the class, the
    /// <c>DisplayName</c>, the storage prefix and the profile literal, then replace the
    /// single-key check in <see cref="ValidateUserOp"/> with your own credential logic.
    /// Every ceremony method here is load-bearing: the SA core refuses to bind a module
    /// whose manifest does not expose the exact v4 callback ABI, so keep the method names
    /// and signatures intact (docs/SA-MODULE-PROTOCOL.md §9).
    /// </para>
    /// <para>
    /// The instance is addressed by <c>(accountId, moduleId)</c>, never by an account-only
    /// key: two installations of the same contract on one account are two independent
    /// credentials.
    /// </para>
    /// </remarks>
    [DisplayName("ValidatorTemplate")]
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ManifestExtra("Description", "SmartAccount protocol v4 validator template")]
    public class ValidatorTemplate : SmartContract
    {
        // Canonical module capability profile (spec §12): keys sorted, no whitespace,
        // no trailing newline. The core hashes these exact bytes into the install-time
        // profile digest, so edit the literal and the bind-time digest together.
        private const string ModuleProfileJson =
            "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":true},\"contractName\":\"ValidatorTemplate\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        // Instance-scoped storage. Prefix 0x01 is local to THIS contract; pick your own
        // and never reuse the 0xE0-0xFA range the authority layer reserves.
        private static readonly byte[] Prefix_AccountPubKey = new byte[] { 0x01 };

        // ------------------------------------------------------------------
        // Lifecycle and authority boilerplate (keep as-is)
        // ------------------------------------------------------------------

        public static void _deploy(object data, bool update) => ValidatorAuthority.Initialize(data, update);

        [Safe]
        public static string GetModuleProfile() => ModuleProfileJson;

        [Safe]
        public static UInt160 AuthorizedCore() => ValidatorAuthority.AuthorizedCore();

        public static void SetAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.SetAuthorizedCore(coreContract);

        // Timelocked core re-pointing (7 days): instant re-pointing would let a new "core"
        // reconfigure every bound account.
        public static void ProposeAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.ProposeAuthorizedCore(coreContract);
        public static void ConfirmAuthorizedCore(UInt160 coreContract) => ValidatorAuthority.ConfirmAuthorizedCore(coreContract);
        public static void CancelAuthorizedCoreChange() => ValidatorAuthority.CancelAuthorizedCoreChange();

        // Timelocked admin rotation (7 days), confirmed by the NEW admin's witness.
        public static void RotateAdmin(UInt160 newAdmin) => ValidatorAuthority.RotateAdmin(newAdmin);
        public static void ConfirmAdminRotation(UInt160 newAdmin) => ValidatorAuthority.ConfirmAdminRotation(newAdmin);
        public static void CancelAdminRotation() => ValidatorAuthority.CancelAdminRotation();

        // Timelocked self-upgrade (7 days): ProposeUpdate pins sha256(nef)/sha256(manifest);
        // ConfirmUpdate applies exactly that pair after the window.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => ValidatorAuthority.ProposeUpdate(nefHash, manifestHash);
        public static void ConfirmUpdate(ByteString nef, string manifest) => ValidatorAuthority.Update(nef, manifest);
        public static void CancelUpdate() => ValidatorAuthority.CancelUpdate();

        // ------------------------------------------------------------------
        // Account configuration (reached only through the SA core)
        // ------------------------------------------------------------------

        /// <summary>
        /// <c>initData</c>: empty, or one command <c>["setPublicKey", publicKey]</c>.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyConfig(accountId, moduleId, initData);
        }

        /// <summary>
        /// <c>configData</c>: <c>["setPublicKey", publicKey]</c>.
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] configData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            ApplyConfig(accountId, moduleId, configData);
        }

        /// <summary>
        /// Mandatory lifecycle cleanup: delete every key this instance owns. The core calls
        /// it on uninstall and aborts the enclosing action on a fault, so it must be
        /// idempotent for never-configured instances.
        /// </summary>
        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            Storage.Delete(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_AccountPubKey, accountId, moduleId));
        }

        private static void ApplyConfig(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            ExecutionEngine.Assert(ModuleConfig.Command(data, 1) == "setPublicKey", "Unknown config command");
            // Accepts 33-byte compressed or 65-byte uncompressed and always stores the
            // canonical 33-byte form.
            ByteString pubKey = ValidatorKeys.Compress((ByteString)data[1]);
            Storage.Put(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_AccountPubKey, accountId, moduleId), pubKey);
        }

        [Safe]
        public static ByteString GetPublicKey(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_AccountPubKey, accountId, moduleId));
            return data ?? (ByteString)"";
        }

        /// <summary>
        /// Stable commitment to the configured credential. Threshold policies use these to
        /// reject accidental signer reuse across member instances.
        /// </summary>
        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId, BigInteger moduleId)
        {
            ByteString publicKey = GetPublicKey(accountId, moduleId);
            ExecutionEngine.Assert(publicKey.Length == 33, "No public key configured");
            return new ByteString[] { SignerDomain.Secp256r1(publicKey) };
        }

        // ------------------------------------------------------------------
        // Validation (the part you replace)
        // ------------------------------------------------------------------

        /// <summary>
        /// Core callback. Must stay read-only, bounded and boolean — a fault here aborts
        /// the operation, so reject by returning false wherever possible. The core hands
        /// over the canonical 13-field operation view and its domain-separated digest
        /// <c>D = SHA256(opPreimage)</c>;
        /// <see cref="ValidatorPayload.VerifiedSigningPreimage"/> re-derives the preimage
        /// and refuses a digest that does not hash back to it, so a stale or foreign
        /// digest approves nothing.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            // The instance is resolved from the core's writer phase, never from a
            // caller-declared id (spec §10).
            BigInteger moduleId = ValidatorAuthority.RequireValidation(accountId, operation);

            ByteString publicKey = GetPublicKey(accountId, moduleId);
            if (publicKey.Length != 33) return false;
            if (operationDigest == null || operationDigest.Length != 32) return false;

            // Standalone route: the signature field is addressed to this instance.
            // Inside a threshold policy the core routes each member separately and the
            // field carries the member list, so use ModuleOperation.MemberSignature.
            ByteString signature = ModuleOperation.Signature(operation);
            if (signature.Length != 64) return false;

            // The platform hashes the preimage once: never hand it a 32-byte digest.
            byte[] preimage = ValidatorPayload.VerifiedSigningPreimage(accountId, operationDigest, operation, moduleId);
            return ValidatorPayload.VerifyPreimage(preimage, publicKey, signature);
        }

        /// <summary>
        /// Core callback after target execution. Keep it caller-validated even as a no-op
        /// so future state updates are guarded by construction.
        /// </summary>
        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
        {
            ValidatorAuthority.RequireCompletion(accountId, operation);
        }
    }
}
