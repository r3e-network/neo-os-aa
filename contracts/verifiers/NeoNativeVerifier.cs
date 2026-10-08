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
    /// Verifier that uses Neo N3's native witness verification system.
    /// This is the most gas-efficient verifier as it leverages Neo's built-in
    /// signature checking without any external crypto calls.
    /// </summary>
    [DisplayName("NeoNativeVerifier")]
#if SMARTACCOUNT_NATIVE
    [ContractPermission("0xd9421d07adf206e9dc4be746a02e8e087fa61741", "hasModuleContext", "getAuthorityEpoch")]
    [ManifestExtra("SmartAccountProfile", "native-v2")]
#else
    [ContractPermission("*", "canConfigureVerifier")]
    [ContractPermission("*", "computeArgsHash")]
#endif
    [ManifestExtra("Description", "Neo N3 Native Witness Verifier Plugin")]
    public class NeoNativeVerifier : SmartContract
    {
        // AccountId -> array of authorized signer UInt160 hashes
        private static readonly byte[] Prefix_AuthorizedSigners = new byte[] { 0x01 };
        // AccountId -> required threshold (for multisig)
        private static readonly byte[] Prefix_Threshold = new byte[] { 0x02 };
#if SMARTACCOUNT_NATIVE
        private static readonly byte[] Prefix_NativeSignerDomains = new byte[] { 0x03 };
#endif
        private const int MaxSigners = 10;

        public static void _deploy(object data, bool update) => VerifierAuthority.Initialize(data, update);

        [Safe]
        public static bool SupportsV3() => true;

        [Safe]
        public static bool SupportsComposition() => false;

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

        public class NativeVerifierConfig
        {
            public UInt160[] Signers;
            public int Threshold;
        }

        /// <summary>
        /// Stores the authorized signers and threshold for the account.
        /// </summary>
        public static void SetConfig(UInt160 accountId, UInt160[] signers, int threshold)
        {
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
            ExecutionEngine.Assert(signers != null && signers.Length > 0, "Empty signers list not allowed");
            ExecutionEngine.Assert(signers.Length <= MaxSigners, $"Maximum {MaxSigners} signers allowed");
            ExecutionEngine.Assert(threshold > 0 && threshold <= signers.Length, "Invalid threshold");

            // Reject duplicate signers to prevent single-signature threshold bypass
            for (int i = 0; i < signers.Length; i++)
            {
                ExecutionEngine.Assert(signers[i] != UInt160.Zero && signers[i].IsValid, "Invalid signer address");
                for (int j = i + 1; j < signers.Length; j++)
                {
                    ExecutionEngine.Assert(signers[i] != signers[j], "Duplicate signer");
                }
            }

            NativeVerifierConfig config = new NativeVerifierConfig { Signers = signers, Threshold = threshold };
            byte[] key = VerifierAuthority.AccountKey(Prefix_AuthorizedSigners, accountId);
            Storage.Put(Storage.CurrentContext, key, StdLib.Serialize(config));

            byte[] thresholdKey = VerifierAuthority.AccountKey(Prefix_Threshold, accountId);
            Storage.Put(Storage.CurrentContext, thresholdKey, threshold);
#if SMARTACCOUNT_NATIVE
            // Deterministic configured identities, atomically replaced with signers.
            byte[] domains = new byte[signers.Length * 32];
            for (int i = 0; i < signers.Length; i++)
            {
                ByteString domain = SignerDomain.NativeScript(signers[i]);
                for (int j = 0; j < 32; j++) domains[i * 32 + j] = domain[j];
            }
            Storage.Put(Storage.CurrentContext, VerifierAuthority.AccountKey(Prefix_NativeSignerDomains, accountId), domains);
#endif
        }

        [Safe]
        public static NativeVerifierConfig? GetConfig(UInt160 accountId)
        {
            byte[] key = VerifierAuthority.AccountKey(Prefix_AuthorizedSigners, accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            if (data == null) return null;

            object? deserialized = StdLib.Deserialize(data!);
            return deserialized == null ? null : (NativeVerifierConfig)deserialized;
        }

        [Safe]
        public static int GetThreshold(UInt160 accountId)
        {
            byte[] key = VerifierAuthority.AccountKey(Prefix_Threshold, accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            return data == null ? 0 : (int)(BigInteger)data!;
        }

        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId)
        {
#if SMARTACCOUNT_NATIVE
            ByteString? data = Storage.Get(Storage.CurrentContext,
                VerifierAuthority.AccountKey(Prefix_NativeSignerDomains, accountId));
            ExecutionEngine.Assert(data != null && data.Length > 0 && data.Length <= MaxSigners * 32
                && data.Length % 32 == 0, "Native signer domains are missing or invalid");
            ByteString[] domains = new ByteString[data!.Length / 32];
            for (int i = 0; i < domains.Length; i++)
                domains[i] = (ByteString)Helper.Range((byte[])data, i * 32, 32);
            return domains;
#else
            NativeVerifierConfig? config = GetConfig(accountId);
            ExecutionEngine.Assert(config != null, "No NeoNativeVerifier config");
            ByteString[] domains = new ByteString[config!.Signers.Length];
            for (int i = 0; i < config.Signers.Length; i++)
            {
                domains[i] = SignerDomain.NativeScript(config.Signers[i]);
            }
            return domains;
#endif
        }

#if SMARTACCOUNT_NATIVE
        public static void PostExecute(UInt160 accountId, object[] op, object result)
#else
        public static void PostExecute(UInt160 accountId, UserOperation op, object result)
#endif
        {
            // Invariant (audit low): every exec path validates its caller, even a
            // no-op — future logic added here is guarded by construction.
            VerifierAuthority.ValidateExecutionCaller(accountId, Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
#if SMARTACCOUNT_NATIVE
            ExecutionEngine.Assert(ValidateNativeWitnesses(accountId), "Native witness quorum changed after validation");
#endif
        }

        /// <summary>
        /// Validates a user operation by checking that enough authorized signers
        /// have witnessed the transaction via Runtime.CheckWitness.
        /// </summary>
        /// <remarks>
        /// The UserOperation's Signature field is NOT used - instead, Neo's native
        /// transaction witnesses are checked via Runtime.CheckWitness.
        /// </remarks>
#if SMARTACCOUNT_NATIVE
        public static bool ValidateSignature(UInt160 accountId, object[] op)
        {
            NativeAuthority.Require(VerifierAuthority.AuthorizedCore(), accountId, "verifier", "validation");
            return ValidateNativeWitnesses(accountId);
        }

        [Safe]
        public static bool ValidateSignatureForPostExecute(UInt160 accountId, object[] fields)
        {
            NativeAuthority.Require(VerifierAuthority.AuthorizedCore(), accountId, "verifier", "postExecute");
            return ValidateNativeWitnesses(accountId);
        }

        private static bool ValidateNativeWitnesses(UInt160 accountId)
#else
        public static bool ValidateSignature(UInt160 accountId, UserOperation op)
#endif
        {
            byte[] key = VerifierAuthority.AccountKey(Prefix_AuthorizedSigners, accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(data != null, "No NeoNativeVerifier config");

            object? deserialized = StdLib.Deserialize(data!);
            ExecutionEngine.Assert(deserialized != null, "Failed to deserialize config");
            NativeVerifierConfig config = (NativeVerifierConfig)deserialized!;

            int witnessCount = 0;
            for (int i = 0; i < config.Signers.Length; i++)
            {
                if (Runtime.CheckWitness(config.Signers[i]))
                {
                    witnessCount++;
                }
            }

            return witnessCount >= config.Threshold;
        }

        public static void ClearAccount(UInt160 accountId)
        {
#if SMARTACCOUNT_NATIVE
            NativeAuthority.Require(VerifierAuthority.AuthorizedCore(), accountId, "verifier", "cleanup");
#else
            VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
#endif
            Storage.Delete(Storage.CurrentContext, VerifierAuthority.AccountKey(Prefix_AuthorizedSigners, accountId));
            Storage.Delete(Storage.CurrentContext, VerifierAuthority.AccountKey(Prefix_Threshold, accountId));
#if SMARTACCOUNT_NATIVE
            Storage.Delete(Storage.CurrentContext, VerifierAuthority.AccountKey(Prefix_NativeSignerDomains, accountId));
#endif
        }
    }
}
