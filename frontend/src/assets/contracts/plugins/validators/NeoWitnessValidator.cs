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
    /// Validator that approves an operation when enough configured Neo N3
    /// accounts have witnessed the enclosing transaction.
    /// </summary>
    /// <remarks>
    /// One instance holds a signer list and a quorum. The operation's signature
    /// field is not interpreted: authorization is the set of transaction
    /// witnesses, checked with <c>Runtime.CheckWitness</c>. Replay protection,
    /// deadline and field binding are the core's (nonce channel and operation
    /// digest); a witness authorizes the transaction that carries it and
    /// nothing else. The default single-witness authorization of an account is
    /// built into the core — this module is for multi-party witness quorums.
    /// </remarks>
    [DisplayName("NeoWitnessValidator")]
#if SMARTACCOUNT_NATIVE
    [ContractPermission("0x398dc3f0227d7efac5533ed5ce9937390c158084", "getAuthorizedModuleId", "getModule")]
    [ManifestExtra("SmartAccountProfile", "native-v4")]
#else
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getModule")]
#endif
    [ManifestExtra("Description", "Neo N3 transaction-witness quorum validator")]
    public class NeoWitnessValidator : SmartContract
    {
        // Canonical bytes of NeoWitnessValidator.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":true},\"contractName\":\"NeoWitnessValidator\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        // (accountId, moduleId) -> serialized [signers[], threshold]
        private static readonly byte[] Prefix_Config = new byte[] { 0x01 };
        private const int MaxSigners = 10;

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
        /// <c>initData</c>: empty, or <c>["setSigners", signers[], threshold]</c>.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyConfig(accountId, moduleId, initData);
        }

        /// <summary>
        /// <c>configData</c>: <c>["setSigners", signers[], threshold]</c> — 1 to 10
        /// distinct script hashes and a quorum between 1 and the signer count.
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            ApplyConfig(accountId, moduleId, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_Config, accountId, moduleId));
        }

        private static void ApplyConfig(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            ExecutionEngine.Assert(ModuleConfig.Command(data, 2) == "setSigners", "Unknown config command");
            object[] signers = (object[])data[1];
            BigInteger threshold = (BigInteger)data[2];
            ExecutionEngine.Assert(signers.Length > 0, "Empty signers list not allowed");
            ExecutionEngine.Assert(signers.Length <= MaxSigners, "Too many signers");
            ExecutionEngine.Assert(threshold > 0 && threshold <= signers.Length, "Invalid threshold");

            // Reject duplicate signers: one witness must never count twice toward the quorum.
            for (int i = 0; i < signers.Length; i++)
            {
                UInt160 signer = (UInt160)signers[i];
                ExecutionEngine.Assert(signer != UInt160.Zero && signer.IsValid, "Invalid signer address");
                for (int j = i + 1; j < signers.Length; j++)
                {
                    ExecutionEngine.Assert(signer != (UInt160)signers[j], "Duplicate signer");
                }
            }

            Storage.Put(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_Config, accountId, moduleId),
                StdLib.Serialize(new object[] { signers, threshold }));
        }

        private static object[]? ReadConfig(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_Config, accountId, moduleId));
            return data == null ? null : (object[])StdLib.Deserialize(data!);
        }

        /// <summary>Returns <c>[signers[], threshold]</c>, or an empty array when unconfigured.</summary>
        [Safe]
        public static object[] GetConfig(UInt160 accountId, BigInteger moduleId)
        {
            object[]? config = ReadConfig(accountId, moduleId);
            return config ?? new object[0];
        }

        [Safe]
        public static BigInteger GetThreshold(UInt160 accountId, BigInteger moduleId)
        {
            object[]? config = ReadConfig(accountId, moduleId);
            return config == null ? BigInteger.Zero : (BigInteger)config![1];
        }

        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId, BigInteger moduleId)
        {
            object[]? config = ReadConfig(accountId, moduleId);
            ExecutionEngine.Assert(config != null, "No signers configured");
            object[] signers = (object[])config![0];
            ByteString[] domains = new ByteString[signers.Length];
            for (int i = 0; i < signers.Length; i++)
            {
                domains[i] = SignerDomain.NativeScript((UInt160)signers[i]);
            }
            return domains;
        }

        /// <summary>
        /// Approves when at least the configured quorum of signers witnessed the
        /// transaction. Rejects by returning false; an unconfigured instance approves
        /// nothing.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            BigInteger moduleId = ValidatorAuthority.RequireValidation(accountId, operation);
            return HasWitnessQuorum(accountId, moduleId);
        }

        /// <summary>
        /// Re-checks the quorum at completion: the witness set of a transaction is
        /// fixed, so this only fails if the instance was reconfigured mid-operation.
        /// </summary>
        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
        {
            BigInteger moduleId = ValidatorAuthority.RequireCompletion(accountId, operation);
            ExecutionEngine.Assert(HasWitnessQuorum(accountId, moduleId), "Witness quorum changed after validation");
        }

        private static bool HasWitnessQuorum(UInt160 accountId, BigInteger moduleId)
        {
            object[]? config = ReadConfig(accountId, moduleId);
            if (config == null) return false;

            object[] signers = (object[])config![0];
            BigInteger threshold = (BigInteger)config[1];
            int witnessCount = 0;
            for (int i = 0; i < signers.Length; i++)
            {
                if (Runtime.CheckWitness((UInt160)signers[i]))
                {
                    witnessCount++;
                }
            }
            return witnessCount >= threshold;
        }
    }
}
