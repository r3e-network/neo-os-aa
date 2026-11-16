using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace SmartAccount.Verifiers
{
    /// <summary>
    /// Minimal verifier template: one secp256r1 key per account authorizes operations.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Copy this file and <c>VerifierTemplate.csproj</c>, rename the class, the
    /// <c>DisplayName</c> and the storage prefix, then replace the single-key check in
    /// <see cref="ValidateSignature"/> with your own credential logic. Every ceremony
    /// method here is load-bearing: the AA core refuses to bind a verifier whose
    /// manifest does not expose the exact ABI this template compiles to, so keep the
    /// method names and signatures intact.
    /// </para>
    /// <para>
    /// The security rules behind each call are documented in
    /// <c>docs/PLUGIN_DEVELOPER_GUIDE.md</c>; the checklist references (PG-01 … PG-07)
    /// appear inline where they apply.
    /// </para>
    /// </remarks>
    [DisplayName("VerifierTemplate")]
    // The core calls back into canConfigureVerifier / canExecuteVerifier on itself;
    // computeArgsHash is read by EVM-style payload builders. Do not widen these grants.
    [ContractPermission("*", "canConfigureVerifier")]
    [ContractPermission("*", "canExecuteVerifier")]
    [ContractPermission("*", "computeArgsHash")]
    [ManifestExtra("Description", "SmartAccount verifier plugin template")]
    public class VerifierTemplate : SmartContract
    {
        // Account-scoped storage (PG: shared state across accounts is forbidden).
        // Prefix 0x01 here is local to THIS contract; pick your own and never reuse the
        // 0xE0-0xE8 range, which VerifierAuthority reserves for admin/core/update state.
        private static readonly byte[] Prefix_AccountPubKey = new byte[] { 0x01 };

        // ------------------------------------------------------------------
        // Lifecycle and authority boilerplate (keep as-is)
        // ------------------------------------------------------------------

        public static void _deploy(object data, bool update) => VerifierAuthority.Initialize(data, update);

        [Safe]
        public static bool SupportsV3() => true;

        // Composite containers (MultiSigVerifier/MultiHook) must return true here and are
        // rejected as children; a leaf verifier returns false.
        [Safe]
        public static bool SupportsComposition() => false;

        // Return true only after implementing isValidSignature(accountId, hash, signature)
        // for ERC-1271 message validation; the core fail-closes when this is absent.
        [Safe]
        public static bool SupportsMessageSignatures() => false;

        [Safe]
        public static UInt160 AuthorizedCore() => VerifierAuthority.AuthorizedCore();

        public static void SetAuthorizedCore(UInt160 coreContract) => VerifierAuthority.SetAuthorizedCore(coreContract);

        // Timelocked core re-pointing (7 days): instant re-pointing would let a new "core"
        // reconfigure every bound account.
        public static void ProposeAuthorizedCore(UInt160 coreContract) => VerifierAuthority.ProposeAuthorizedCore(coreContract);
        public static void ConfirmAuthorizedCore(UInt160 coreContract) => VerifierAuthority.ConfirmAuthorizedCore(coreContract);
        public static void CancelAuthorizedCoreChange() => VerifierAuthority.CancelAuthorizedCoreChange();

        // Timelocked admin rotation (7 days), confirmed by the NEW admin's witness.
        public static void RotateAdmin(UInt160 newAdmin) => VerifierAuthority.RotateAdmin(newAdmin);
        public static void ConfirmAdminRotation(UInt160 newAdmin) => VerifierAuthority.ConfirmAdminRotation(newAdmin);
        public static void CancelAdminRotation() => VerifierAuthority.CancelAdminRotation();

        // Timelocked self-upgrade (7 days): ProposeUpdate pins sha256(nef)/sha256(manifest);
        // ConfirmUpdate applies exactly that pair after the window.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => VerifierAuthority.ProposeUpdate(nefHash, manifestHash);
        public static void ConfirmUpdate(ByteString nef, string manifest) => VerifierAuthority.Update(nef, manifest);
        public static void CancelUpdate() => VerifierAuthority.CancelUpdate();

        // ------------------------------------------------------------------
        // Account configuration (reached only through the AA core)
        // ------------------------------------------------------------------

        /// <summary>
        /// Stores the secp256r1 public key (33-byte compressed or 65-byte uncompressed)
        /// that authorizes this account's operations.
        /// </summary>
        public static void SetPublicKey(UInt160 accountId, ByteString pubKey)
        {
            // Configuration enters through the core (canConfigureVerifier); a direct
            // external call faults here (PG: authority validation).
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            ExecutionEngine.Assert(pubKey.Length == 33 || pubKey.Length == 65, "Invalid public key length");
            Storage.Put(Storage.CurrentContext,
                VerifierAuthority.AccountKey(Prefix_AccountPubKey, accountId), pubKey);
        }

        [Safe]
        public static ByteString GetPublicKey(UInt160 accountId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext,
                VerifierAuthority.AccountKey(Prefix_AccountPubKey, accountId));
            return data ?? (ByteString)"";
        }

        /// <summary>
        /// Stable commitment to the configured credential. MultiSigVerifier uses these to
        /// reject accidental signer reuse across child verifiers.
        /// </summary>
        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId)
        {
            ByteString publicKey = GetPublicKey(accountId);
            ExecutionEngine.Assert(publicKey.Length == 33 || publicKey.Length == 65,
                "No public key configured");
            return new ByteString[] { SignerDomain.Secp256r1(publicKey) };
        }

        // ------------------------------------------------------------------
        // Validation (the part you replace)
        // ------------------------------------------------------------------

        /// <summary>
        /// Core callback. Must stay read-only (PG-02), bounded (PG-03) and boolean — a
        /// fault here aborts the operation, so reject by returning false where possible.
        /// </summary>
        public static bool ValidateSignature(UInt160 accountId, UserOperation op)
        {
            // Only the core's execution context may invoke validation (PG: context validation).
            VerifierAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);

            ByteString pubKey = GetPublicKey(accountId);
            if (pubKey.Length == 0) return false;

            // Exact length first (PG-04: length-extension forgery).
            if (op.Signature == null || op.Signature.Length != 64) return false;

            // Canonical payload binds network, account, verifier, target, method, args,
            // nonce and deadline (PG-01 replay protection). Never hand-roll concatenation.
            byte[] payload = VerifierPayload.BuildPayload(
                accountId, op.TargetContract, op.Method, op.Args, op.Nonce, op.Deadline);

            return CryptoLib.VerifyWithECDsa((ByteString)payload, (ECPoint)pubKey,
                op.Signature!, NamedCurveHash.secp256r1SHA256);
        }

        /// <summary>
        /// Returns the exact bytes a signer must sign. Wallets and test tooling call this
        /// instead of re-implementing the payload layout off-chain.
        /// </summary>
        [Safe]
        public static ByteString GetPayload(UInt160 accountId, UInt160 targetContract, string method, object[] args, BigInteger nonce, BigInteger deadline)
        {
            return (ByteString)VerifierPayload.BuildPayload(accountId, targetContract, method, args, nonce, deadline);
        }

        /// <summary>
        /// Core callback after target execution. Keep it caller-validated even as a no-op
        /// so future logic is guarded by construction.
        /// </summary>
        public static void PostExecute(UInt160 accountId, UserOperation op, object result)
        {
            VerifierAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
        }

        /// <summary>
        /// Mandatory lifecycle cleanup: delete every account-scoped key this contract owns
        /// for the account. Must be idempotent for never-configured accounts and must fault
        /// on failure — the core aborts the enclosing rotation/transfer on a fault here.
        /// </summary>
        public static void ClearAccount(UInt160 accountId)
        {
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            Storage.Delete(Storage.CurrentContext,
                VerifierAuthority.AccountKey(Prefix_AccountPubKey, accountId));
        }
    }
}
