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
    /// Placeholder verifier reserved for a future zkEmail proof flow.
    /// </summary>
    /// <remarks>
    /// The contract intentionally stays disabled until a real proof verifier is added.
    /// It is kept in the tree so integrators can see the intended configuration surface.
    /// </remarks>
    [DisplayName("ZKEmailVerifier")]
    [ContractPermission("*", "canConfigureVerifier")]
    [ContractPermission("*", "computeArgsHash")]
    [ManifestExtra("Description", "ZK-SNARK Email Proof Verifier")]
    public class ZKEmailVerifier : SmartContract
    {
        private static readonly byte[] Prefix_AccountDKIM = new byte[] { 0x01 };

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
        /// Stores the DKIM root or registry hash that a future zkEmail proof should bind against.
        /// </summary>
        public static void SetDKIMRegistry(UInt160 accountId, ByteString dkimHash)
        {
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            byte[] key = Helper.Concat(Prefix_AccountDKIM, (byte[])accountId);
            Storage.Put(Storage.CurrentContext, key, dkimHash);
        }

        public static void PostExecute(UInt160 accountId, UserOperation op, object result)
        {
            VerifierAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
        }

        /// <summary>
        /// Always faults today because the verifier is intentionally disabled pending real proof verification.
        /// </summary>
        public static bool ValidateSignature(UInt160 accountId, UserOperation op)
        {
            byte[] key = Helper.Concat(Prefix_AccountDKIM, (byte[])accountId);
            ByteString? dkim = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(dkim != null, "No DKIM configured");

            // This verifier was previously a placeholder that accepted any
            // non-empty proof blob, which is unsafe for production use.
            ExecutionEngine.Assert(false, "ZKEmailVerifier disabled pending real proof verification");
            return false; 
        }

        public static void ClearAccount(UInt160 accountId)
        {
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            Storage.Delete(Storage.CurrentContext, Helper.Concat(Prefix_AccountDKIM, (byte[])accountId));
        }
    }
}
