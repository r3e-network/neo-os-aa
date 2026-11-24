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
    /// Validator that approves an operation on either the account's recovery
    /// authority witness or the witness of a valid action-session executor.
    /// </summary>
    /// <remarks>
    /// Recovery and action-session state live in the optional, non-module
    /// <c>SocialRecoveryService</c>; this module only reads which executor a
    /// session currently authorizes and checks that executor's witness itself,
    /// so a signer scoped to this contract is enough and the service is never
    /// trusted to authorize a user operation. The recovery authority comes from
    /// the core's account record (<c>getAccount(accountId)[3]</c>), so a custody
    /// rotation by the callback-free core recovery takes effect here without a
    /// configuration change.
    ///
    /// One instance holds one service binding per account. The module never
    /// answers message checks and is never a threshold-policy member: it is a
    /// dynamic-witness authorization, not a scalar credential.
    /// </remarks>
    [DisplayName("ActionSessionValidator")]
#if SMARTACCOUNT_NATIVE
    [ContractPermission("0x398dc3f0227d7efac5533ed5ce9937390c158084", "getAuthorizedModuleId", "getAccount")]
    [ManifestExtra("SmartAccountProfile", "native-smartaccount")]
#else
    [ContractPermission("*", "getAuthorizedModuleId")]
    [ContractPermission("*", "getAccount")]
#endif
    [ContractPermission("*", "GetAuthorizedSessionExecutor")]
    [ManifestExtra("Description", "Recovery-authority and action-session witness validator")]
    public class ActionSessionValidator : SmartContract
    {
        // Canonical bytes of ActionSessionValidator.profile.json (scripts/sync-module-profiles.mjs).
        private const string ModuleProfileJson = "{\"callbacks\":[\"validateUserOp\",\"onUserOpComplete\"],\"capabilities\":{\"compositeLayer\":0,\"instanceIsolation\":false,\"messageCapability\":false,\"thresholdMemberEligible\":false},\"contractName\":\"ActionSessionValidator\",\"lifecycle\":[\"onInstall\",\"onUninstall\",\"configure\"],\"moduleType\":\"validator\",\"profileVersion\":1}";

        // (accountId, moduleId) -> recovery service script hash
        private static readonly byte[] Prefix_Service = new byte[] { 0x01 };

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
        /// <c>initData</c>: empty, or one <c>setRecoveryService</c> command.
        /// </summary>
        public static void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            if (initData.Length > 0) ApplyConfig(accountId, moduleId, initData);
        }

        /// <summary>
        /// <c>configData</c>: <c>["setRecoveryService", service]</c> or
        /// <c>["clearRecoveryService"]</c>.
        /// </summary>
        public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            ApplyConfig(accountId, moduleId, configData);
        }

        public static void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData)
        {
            ValidatorAuthority.RequireLifecycle(accountId, moduleId);
            Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_Service, accountId, moduleId));
        }

        private static void ApplyConfig(UInt160 accountId, BigInteger moduleId, object[] data)
        {
            string command = ModuleConfig.Name(data);
            if (command == "setRecoveryService")
            {
                ModuleConfig.RequireArgs(data, 1);
                UInt160 service = (UInt160)data[1];
                ExecutionEngine.Assert(service != null && service.IsValid && service != UInt160.Zero,
                    "Invalid recovery service");
                Storage.Put(Storage.CurrentContext,
                    ValidatorAuthority.InstanceKey(Prefix_Service, accountId, moduleId), (byte[])service!);
                return;
            }
            if (command == "clearRecoveryService")
            {
                ModuleConfig.RequireArgs(data, 0);
                Storage.Delete(Storage.CurrentContext, ValidatorAuthority.InstanceKey(Prefix_Service, accountId, moduleId));
                return;
            }
            ExecutionEngine.Assert(false, "Unknown config command");
        }

        /// <summary>The configured recovery service, or <see cref="UInt160.Zero"/>.</summary>
        [Safe]
        public static UInt160 GetRecoveryService(UInt160 accountId, BigInteger moduleId)
        {
            ByteString? data = Storage.Get(Storage.CurrentContext,
                ValidatorAuthority.InstanceKey(Prefix_Service, accountId, moduleId));
            return data == null ? UInt160.Zero : (UInt160)data;
        }

        /// <summary>The account's recovery authority as recorded by the core, or zero.</summary>
        [Safe]
        public static UInt160 GetRecoveryAuthority(UInt160 accountId)
        {
            UInt160 core = ValidatorAuthority.Core();
            if (core == UInt160.Zero || !core.IsValid) return UInt160.Zero;
            return ReadRecoveryAuthority(core, accountId);
        }

        // Authorization is a dynamic witness set (recovery authority or session
        // executor), so the instance has no static signer commitment to publish.
        [Safe]
        public static ByteString[] GetSignerDomains(UInt160 accountId, BigInteger moduleId) => new ByteString[] { };

        /// <summary>
        /// Approves when the account's recovery authority or the currently valid
        /// action-session executor witnessed the transaction. Rejects by
        /// returning false.
        /// </summary>
        [Safe]
        public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
        {
            BigInteger moduleId = ValidatorAuthority.RequireValidation(accountId, operation);
            // Standalone route only: on a policy route the signature field is a
            // member list, not an authorization for a dynamic witness.
            if (ModuleOperation.ValidatorId(operation) != moduleId) return false;
            if (operationDigest == null || operationDigest.Length != 32) return false;

            UInt160 core = ValidatorAuthority.Core();
            if (core == UInt160.Zero || !core.IsValid) return false;

            UInt160 authority = ReadRecoveryAuthority(core, accountId);
            if (authority != UInt160.Zero && authority.IsValid && Runtime.CheckWitness(authority)) return true;

            UInt160 service = GetRecoveryService(accountId, moduleId);
            if (service == UInt160.Zero || !service.IsValid) return false;
            UInt160 executor = (UInt160)Contract.Call(service, "GetAuthorizedSessionExecutor", CallFlags.ReadOnly,
                new object[] { accountId });
            return executor != UInt160.Zero && executor.IsValid && Runtime.CheckWitness(executor);
        }

        /// <summary>No post-execution accounting; the completion gate only authenticates the core.</summary>
        public static void OnUserOpComplete(UInt160 accountId, object[] operation, object result)
        {
            ValidatorAuthority.RequireCompletion(accountId, operation);
        }

        private static UInt160 ReadRecoveryAuthority(UInt160 core, UInt160 accountId)
        {
            // getAccount layout (spec §9): [exists, status, custody, recoveryAuthority, ...].
            object[] account = (object[])Contract.Call(core, "getAccount", CallFlags.ReadOnly,
                new object[] { accountId });
            if (account.Length <= 3 || !(bool)account[0]) return UInt160.Zero;
            UInt160 authority = (UInt160)account[3];
            return authority.IsValid ? authority : UInt160.Zero;
        }
    }
}
