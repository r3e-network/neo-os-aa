using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;
using System.ComponentModel;

namespace AbstractAccount.Verifiers
{
    /// <summary>
    /// Verifier for a bare secp256r1 (P-256) signature over the AA payload.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This plugin lets a V3 AA account be controlled by a P-256 key after the
    /// corresponding public key has been provisioned through the AA core.
    /// </para>
    /// <para>
    /// It is <b>not</b> a WebAuthn relying party. <c>ValidateSignature</c> is
    /// <c>CryptoLib.VerifyWithECDsa(payload, pubKey, signature, secp256r1SHA256)</c>
    /// and the contract stores nothing else, so none of the WebAuthn ceremony is
    /// present or checked: no <c>challenge</c> binding, no <c>rpIdHash</c>, no
    /// <c>clientDataJSON</c> origin check, no <c>authenticatorData</c> flags, and no
    /// sign-counter monotonicity. A caller who can obtain a P-256 signature over the
    /// payload from any source - including a browser WebAuthn assertion whose
    /// challenge and origin the relying party never validates on chain - satisfies
    /// this verifier. Renaming or re-documenting this contract does not add those
    /// properties; implementing them is separate work.
    /// </para>
    /// </remarks>
    [DisplayName("WebAuthnVerifier")]
    [ContractPermission("*", "canConfigureVerifier")]
    [ContractPermission("*", "computeArgsHash")]
    [ManifestExtra("Description", "secp256r1 (P-256) signature verifier; no WebAuthn ceremony or origin binding")]
    public class WebAuthnVerifier : SmartContract
    {
        private static readonly byte[] Prefix_AccountPubKey = new byte[] { 0x01 };

        public static void _deploy(object data, bool update) => VerifierAuthority.Initialize(data, update);

        [Safe]
        public static bool SupportsV3() => true;

        [Safe]
        public static bool SupportsMessageSignatures() => false;

        [Safe]
        public static UInt160 AuthorizedCore() => VerifierAuthority.AuthorizedCore();

        public static void SetAuthorizedCore(UInt160 coreContract) => VerifierAuthority.SetAuthorizedCore(coreContract);
        // Audit fix M-7 (parity with hooks): timelocked core re-pointing.
        public static void ProposeAuthorizedCore(UInt160 coreContract) => VerifierAuthority.ProposeAuthorizedCore(coreContract);
        public static void ConfirmAuthorizedCore(UInt160 coreContract) => VerifierAuthority.ConfirmAuthorizedCore(coreContract);
        public static void CancelAuthorizedCoreChange() => VerifierAuthority.CancelAuthorizedCoreChange();

        // AA-D-01: timelocked upgrade — Update only succeeds for an artifact pair that was
        // pinned via ProposeUpdate at least 7 days earlier.
        public static void ProposeUpdate(UInt256 nefHash, UInt256 manifestHash) => VerifierAuthority.ProposeUpdate(nefHash, manifestHash);

        public static void ConfirmUpdate(ByteString nef, string manifest) => VerifierAuthority.Update(nef, manifest);

        public static void CancelUpdate() => VerifierAuthority.CancelUpdate();

        public static void Update(ByteString nef, string manifest) => VerifierAuthority.Update(nef, manifest);

        /// <summary>
        /// Stores the passkey public key for an AA account.
        /// </summary>
        public static void SetPublicKey(UInt160 accountId, ByteString pubKey)
        {
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            ExecutionEngine.Assert(pubKey.Length == 33 || pubKey.Length == 65, "Invalid public key length");
            byte[] key = Helper.Concat(Prefix_AccountPubKey, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, pubKey);
        }

        [Safe]
        public static ByteString GetPublicKey(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_AccountPubKey, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            return data ?? (ByteString)"";
        }

        public static void PostExecute(UInt160 accountId, UserOperation op, object result)
        {
            VerifierAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
        }

        public static void ClearAccount(UInt160 accountId)
        {
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_AccountPubKey, (byte[])accountId));
        }

        [Safe]
        /// <summary>
        /// Returns the payload bytes that a WebAuthn signer must approve.
        /// </summary>
        public static ByteString GetPayload(UInt160 accountId, UInt160 targetContract, string method, object[] args, BigInteger nonce, BigInteger deadline)
        {
            return (ByteString)VerifierPayload.BuildPayload(accountId, targetContract, method, args, nonce, deadline);
        }

        /// <summary>
        /// Validates the WebAuthn secp256r1 signature for the given user operation.
        /// </summary>
        public static bool ValidateSignature(UInt160 accountId, UserOperation op)
        {
            ByteString pubKey = GetPublicKey(accountId);
            ExecutionEngine.Assert(pubKey.Length > 0, "No WebAuthn pubkey configured");

            ExecutionEngine.Assert(op.Signature != null && op.Signature.Length == 64, "Invalid signature length");
            ByteString signature = op.Signature!;
            byte[] payload = VerifierPayload.BuildPayload(accountId, op.TargetContract, op.Method, op.Args, op.Nonce, op.Deadline);
            
            return CryptoLib.VerifyWithECDsa((ByteString)payload, (ECPoint)pubKey, signature, NamedCurveHash.secp256r1SHA256);
        }
    }
}
