using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace SmartAccount
{
    /// <summary>
    /// v4 query surface (spec §9) plus the legacy market-marker readers the
    /// §7.5 minimal-lock model still consumes. The legacy single-pointer
    /// queries (GetVerifier/GetHook, DescribeAccount, SimulateValidation, the
    /// verifier-dispatched IsValidSignature, the pending-update/pending-call
    /// queries and CancelVerifierUpdate/CancelHookUpdate) are removed with the
    /// old model: getVerifier/getHook/CallVerifier/CallHook/*Child surfaces are
    /// removed without aliases in both kernels. Message validation is the
    /// built-in P-256/0x57 flow in SmartAccount.Message.cs.
    /// </summary>
    public partial class SmartAccount
    {
        private const string AccountImplementationId = "org.r3e.neo.smart-account.v4";

        /// <summary>
        /// Legacy five-field row decoder (spec §7.4): the ONLY authorized
        /// consumer of the old Verifier/HookId pointers is the migration
        /// input. Faults on unknown accounts.
        /// </summary>
        private static AccountState GetAccountState(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_AccountState, (byte[])accountId);
            ByteString? data = Storage.Get(Storage.CurrentContext, key);
            ExecutionEngine.Assert(data != null, ErrorAccountNotFound);
            return (AccountState)StdLib.Deserialize(data!);
        }

        [Safe]
        public static string GetAccountImplementationId()
        {
            return AccountImplementationId;
        }

        // ========================================================================
        // 1. Protocol / account queries (spec §9)
        // ========================================================================

        /// <summary>
        /// Returns [protocolVersion, migrationModeOpen]. Migration mode opens
        /// only through the versioned in-place update (spec §14).
        /// </summary>
        [Safe]
        public static object[] getProtocolInfo()
        {
            object[] info = GetProtocolInfoRecord();
            return new object[] { info[0], info[1] };
        }

        /// <summary>
        /// Aggregated account descriptor. Non-faulting for unknown accounts
        /// (counterfactual probing) and legacy-only accounts (read-only: the
        /// legacy five-field row and the legacy freeze latch are migration
        /// inputs). Layout:
        /// [exists, status, custody, recoveryAuthority, authorityEpoch,
        ///  configurationNonce, recoveryTimelockMs, defaultOperationAuthorization,
        ///  defaultMessageAuthorization, ownerOnlyRecovery, hookOrderRevision,
        ///  controlRevision, recoveryPending, recoveryMatureAt,
        ///  marketEscrowActive, legacyRow].
        /// Status: 0 Active / 1 Frozen / 2 MigrationRequired.
        /// </summary>
        [Safe]
        public static object[] getAccount(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            AccountControl? control = GetAccountControl(accountId);
            if (control != null)
            {
                CoreRecoveryRecord? recovery = GetCoreRecoveryRecord(accountId);
                return new object[]
                {
                    true,
                    (BigInteger)control!.Status,
                    control.Custody,
                    control.RecoveryAuthority,
                    control.AuthorityEpoch,
                    control.ConfigurationNonce,
                    control.RecoveryTimelockMs,
                    control.DefaultOperationAuthorization,
                    control.DefaultMessageAuthorization,
                    control.OwnerOnlyRecovery,
                    control.HookOrderRevision,
                    control.ControlRevision,
                    recovery != null,
                    recovery == null ? BigInteger.Zero : recovery!.MatureAt,
                    IsMarketEscrowActive(accountId),
                    HasLegacyAccountRow(accountId)
                };
            }

            ByteString? legacy = Storage.Get(Storage.CurrentContext,
                Helper.Concat(Prefix_AccountState, (byte[])accountId));
            if (legacy != null)
            {
                AccountState state = (AccountState)StdLib.Deserialize(legacy!);
                // A legacy row without a 0x51 record: the frozen latch decides
                // between Frozen and MigrationRequired (post-update, an
                // unmigrated legacy account can neither execute nor authorize
                // messages until its owner imports the approved configuration).
                BigInteger status = HasLegacyFrozenLatch(accountId)
                    ? (BigInteger)AccountStatusFrozen
                    : (BigInteger)AccountStatusMigrationRequired;
                BigInteger timelockMs = state.EscapeTimelock * 1000;
                if (timelockMs < RecoveryTimelockMinMs) timelockMs = RecoveryTimelockMinMs;
                if (timelockMs > RecoveryTimelockMaxMs) timelockMs = RecoveryTimelockMaxMs;
                return new object[]
                {
                    true,
                    status,
                    state.BackupOwner,
                    UInt160.Zero,
                    BigInteger.Zero,
                    BigInteger.Zero,
                    timelockMs,
                    false,
                    false,
                    HasLegacyOwnerOnlyLatch(accountId),
                    BigInteger.Zero,
                    BigInteger.Zero,
                    false,
                    BigInteger.Zero,
                    IsMarketEscrowActive(accountId),
                    true
                };
            }

            return new object[]
            {
                false, (BigInteger)0, UInt160.Zero, UInt160.Zero,
                BigInteger.Zero, BigInteger.Zero, BigInteger.Zero,
                false, false, false, BigInteger.Zero, BigInteger.Zero,
                false, BigInteger.Zero, false, false
            };
        }

        /// <summary>
        /// ERC-7579-style module capability discovery: only validator (type
        /// code 1) and hook (type code 4) are supported; executor and
        /// fallback are not (spec §2).
        /// </summary>
        [Safe]
        public static bool SupportsModuleType(string moduleType)
        {
            return moduleType == "validator" || moduleType == "hook";
        }

        [Safe]
        public static bool SupportsExecutionMode(string mode)
        {
            return mode == "single" || mode == "batch" || mode == "batch-atomic";
        }

        private static int ModuleTypeCodeFromName(string moduleType)
        {
            if (moduleType == "validator") return ModuleTypeCodeValidator;
            if (moduleType == "hook") return ModuleTypeCodeHook;
            ExecutionEngine.Assert(false, ErrorModuleTypeUnsupported);
            return 0;
        }

        /// <summary>
        /// Canonical v4 module-type label used by the §18 reused lifecycle
        /// events (ModuleInstalled/ModuleRemoved/ModuleUpdate*) — these keep
        /// the ERC-7579-style string labels the old model already emitted.
        /// </summary>
        internal static string ModuleTypeNameFromCode(int code)
        {
            return code == ModuleTypeCodeValidator ? "validator" : "hook";
        }

        /// <summary>
        /// Page of installed moduleIds of the given type, strictly ascending
        /// past <paramref name="cursor"/> (the cursor is a moduleId — ids are
        /// never reused, so pages can never alias). Returns
        /// [ids[], nextCursor, configurationNonce]; nextCursor is 0 when
        /// exhausted (spec §3.3).
        /// </summary>
        [Safe]
        public static object[] getModules(UInt160 accountId, string moduleType, BigInteger cursor, BigInteger limit)
        {
            ValidateAccountId(accountId);
            int typeCode = ModuleTypeCodeFromName(moduleType);
            object[] page = EnumerateModuleIds(accountId, typeCode, cursor, limit);
            AccountControl? control = GetAccountControl(accountId);
            BigInteger configurationNonce = control == null ? BigInteger.Zero : control!.ConfigurationNonce;
            return new object[] { page[0], page[1], configurationNonce };
        }

        /// <summary>
        /// Full module-instance descriptor, or an empty array when the id is
        /// not installed on the account. Layout:
        /// [moduleId, moduleType, contractHash, contractId, updateCounter,
        ///  nefSha256, profileSha256, moduleRevision, credentialGeneration,
        ///  instanceIsolation, messageCapability, thresholdMemberEligible].
        /// </summary>
        [Safe]
        public static object[] getModule(UInt160 accountId, BigInteger moduleId)
        {
            ValidateAccountId(accountId);
            ModuleInstance? module = GetModuleInstance(accountId, moduleId);
            if (module == null) return new object[0];
            return new object[]
            {
                moduleId,
                (BigInteger)module!.ModuleType,
                module.ContractHash,
                module.ContractId,
                module.UpdateCounter,
                module.NefSha256,
                module.ProfileSha256,
                module.ModuleRevision,
                module.CredentialGeneration,
                module.InstanceIsolation,
                module.MessageCapability,
                module.ThresholdMemberEligible
            };
        }

        /// <summary>
        /// True when the account has an installed module instance of the
        /// given type whose contract hash matches. The additionalContext
        /// parameter is kept for ERC-7579 signature alignment and is not
        /// interpreted: instances are addressed by moduleId (getModule /
        /// getModules), never by an opaque context blob.
        /// </summary>
        [Safe]
        public static bool IsModuleInstalled(UInt160 accountId, string moduleType, UInt160 moduleHash, ByteString additionalContext)
        {
            ValidateAccountId(accountId);
            if (moduleHash == null || moduleHash == UInt160.Zero) return false;
            int typeCode = ModuleTypeCodeFromName(moduleType);
            return FindModuleIdByContract(accountId, typeCode, moduleHash) != 0;
        }

        /// <summary>Returns [hookIds[], revision] — the core-owned hook order.</summary>
        [Safe]
        public static object[] getHookOrder(UInt160 accountId)
        {
            ValidateAccountId(accountId);
            HookOrderRecord order = GetHookOrder(accountId);
            return new object[] { order.HookIds, order.Revision };
        }

        // ========================================================================
        // 2. Legacy market markers (spec §7.5 minimal-lock model)
        //    0x06/0x07 are Market-owned physical markers; the readers stay
        //    read-only queries on both legacy and v4 accounts.
        // ========================================================================

        [Safe]
        public static UInt160 GetMarketEscrowContract(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_MarketEscrowContract, (byte[])accountId);
            ByteString? market = Storage.Get(Storage.CurrentContext, key);
            return market == null ? UInt160.Zero : (UInt160)market;
        }

        [Safe]
        public static BigInteger GetMarketEscrowListingId(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_MarketEscrowListing, (byte[])accountId);
            ByteString? listing = Storage.Get(Storage.CurrentContext, key);
            return listing == null ? 0 : (BigInteger)listing;
        }

        [Safe]
        public static bool IsMarketEscrowActive(UInt160 accountId)
        {
            return GetMarketEscrowContract(accountId) != UInt160.Zero && GetMarketEscrowListingId(accountId) > 0;
        }

        // ========================================================================
        // 3. Legacy nonce channel query (0x03) — read-only migration input.
        //    The v4 channels (0x56/0x5C) are queried through
        //    getNonce(accountId, validatorId, nonceSubkey) and
        //    getNonceSequence(accountId, channel) in SmartAccount.Nonce.cs;
        //    the legacy merge rule is applied there at consumption time.
        // ========================================================================

        [Safe]
        public static BigInteger GetNonce(UInt160 accountId, BigInteger channel)
        {
            ValidateAccountId(accountId);
            ExecutionEngine.Assert(channel >= 0 && IsUnsignedIntegerWithinBytes(channel, 24), "Invalid channel");
            byte[] key = Helper.Concat(Prefix_Nonce, (byte[])accountId);
            key = Helper.Concat(key, channel.ToByteArray());

            ByteString? currentData = Storage.Get(Storage.CurrentContext, key);
            return currentData == null ? 0 : (BigInteger)currentData;
        }

        [Safe]
        public static ByteString ComputeArgsHash(object[] args)
        {
            ByteString serialized = (ByteString)StdLib.Serialize(args);
            return (ByteString)Contract.Call(
                Neo.SmartContract.Framework.Native.CryptoLib.Hash,
                "keccak256",
                CallFlags.ReadOnly,
                new object[] { serialized });
        }

        // ========================================================================
        // 4. Account metadata URI (custody-gated, active-account-gated)
        // ========================================================================

        /// <summary>
        /// Sets the off-chain metadata URI for an account. Deletes the key if cleared.
        /// </summary>
        public static void SetMetadataUri(UInt160 accountId, string metadataUri)
        {
            ValidateAccountId(accountId);
            AccountControl control = RequireAccountActive(accountId!);
            RequireCustodyWitness(control);
            AssertAccountConfigurationIdle(accountId!);
            byte[] key = Helper.Concat(Prefix_MetadataUri, (byte[])accountId!);
            if (metadataUri == null || metadataUri.Length == 0)
            {
                Storage.Delete(Storage.CurrentContext, key);
                return;
            }

            ExecutionEngine.Assert(metadataUri.Length <= MaxMetadataUriLength, "MetadataUri too long");
            Storage.Put(Storage.CurrentContext, key, metadataUri);
            OnMetadataUriUpdated(accountId!, metadataUri);
        }

        /// <summary>
        /// Returns the off-chain metadata URI for an account, or empty string if unset.
        /// </summary>
        [Safe]
        public static string GetMetadataUri(UInt160 accountId)
        {
            byte[] key = Helper.Concat(Prefix_MetadataUri, (byte[])accountId);
            ByteString? uri = Storage.Get(Storage.CurrentContext, key);
            return uri == null ? string.Empty : (string)uri;
        }
    }
}
