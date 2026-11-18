using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;

namespace SmartAccount
{
    public partial class SmartAccount
    {
        private const string ModuleTypeVerifier = "verifier";
        private const string ModuleTypeHook = "hook";

        // NOTE: ModuleTypeVerifier/ModuleTypeHook above are OLD-MODEL event
        // labels kept only while legacy registration paths remain; the v4
        // protocol type codes live in SmartAccount.ModuleProtocol.cs.

        // Custom delegates matching nccs-supported pattern (see Nep17Token.cs).
        public delegate void AccountRegisteredDelegate(UInt160 accountId, UInt160 backupOwner, UInt160 verifier, UInt160 hookId);
        public delegate void AccountOnlyDelegate(UInt160 accountId);
        public delegate void ModuleLifecycleDelegate(UInt160 accountId, string moduleType, UInt160 moduleHash);
        public delegate void MetadataUriUpdatedDelegate(UInt160 accountId, string metadataUri);
        public delegate void UserOpExecutedDelegate(UInt160 accountId, UInt160 targetContract, string method, BigInteger nonce);
        public delegate void EscapeInitiatedDelegate(UInt160 accountId, UInt160 backupOwner);
        public delegate void MarketEscrowEnteredDelegate(UInt160 accountId, UInt160 marketContract, BigInteger listingId);
        public delegate void MarketEscrowSettledDelegate(UInt160 accountId, UInt160 newBackupOwner);

        [DisplayName("AccountRegistered")]
        public static event AccountRegisteredDelegate OnAccountRegistered = null!;

        [DisplayName("ModuleInstalled")]
        public static event ModuleLifecycleDelegate OnModuleInstalled = null!;

        [DisplayName("ModuleUpdateInitiated")]
        public static event ModuleLifecycleDelegate OnModuleUpdateInitiated = null!;

        [DisplayName("ModuleUpdateConfirmed")]
        public static event ModuleLifecycleDelegate OnModuleUpdateConfirmed = null!;

        [DisplayName("ModuleRemoved")]
        public static event ModuleLifecycleDelegate OnModuleRemoved = null!;

        [DisplayName("ModuleUpdateCancelled")]
        public static event ModuleLifecycleDelegate OnModuleUpdateCancelled = null!;

        // NOTE: the single-slot HookUpdate*/VerifierUpdate* events were removed
        // with the v4 protocol — module lifecycle is reported through
        // ModuleInstalled/ModuleRemoved/ModuleUpdate* above plus the v4
        // ModuleInstance* events (spec §18; removed without aliases, like
        // getVerifier/getHook/CallVerifier/CallHook).

        [DisplayName("MetadataUriUpdated")]
        public static event MetadataUriUpdatedDelegate OnMetadataUriUpdated = null!;

        [DisplayName("EscapeCancelled")]
        public static event AccountOnlyDelegate OnEscapeCancelled = null!;

        [DisplayName("UserOpExecuted")]
        public static event UserOpExecutedDelegate OnUserOpExecuted = null!;

        [DisplayName("EscapeInitiated")]
        public static event EscapeInitiatedDelegate OnEscapeInitiated = null!;

        public delegate void EscapeFinalizedDelegate(UInt160 accountId, UInt160 newCustody);

        [DisplayName("EscapeFinalized")]
        public static event EscapeFinalizedDelegate OnEscapeFinalized = null!;

        [DisplayName("MarketEscrowEntered")]
        public static event MarketEscrowEnteredDelegate OnMarketEscrowEntered = null!;

        [DisplayName("MarketEscrowCancelled")]
        public static event AccountOnlyDelegate OnMarketEscrowCancelled = null!;

        [DisplayName("MarketEscrowSettled")]
        public static event MarketEscrowSettledDelegate OnMarketEscrowSettled = null!;

        // --- Verify scope configuration ---
        // (Retired with the F-1 fix, protocol v4: VerifyScopeTargetSet no longer
        // exists and prefix 0x1C is permanently unallocated; see
        // SA-MODULE-PROTOCOL.md §18 and VerifyContext.cs.)

        // --- Paymaster / Sponsored Transactions ---

        public delegate void SponsoredUserOpExecutedDelegate(UInt160 accountId, UInt160 paymaster, UInt160 sponsor, UInt160 relay, BigInteger reimbursementAmount);

        [DisplayName("SponsoredUserOpExecuted")]
        public static event SponsoredUserOpExecutedDelegate OnSponsoredUserOpExecuted = null!;

        // ========================================================================
        // Module protocol v4 kernel events (spec §18) — emitted by
        // SmartAccount.Modules.cs and the other v4 kernel partials. Display
        // names match the EventName* constants in SmartAccount.ModuleProtocol.cs.
        // ========================================================================

        public delegate void ModuleInstanceInstalledDelegate(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, UInt160 contractHash, BigInteger credentialGeneration);

        [DisplayName("ModuleInstanceInstalled")]
        public static event ModuleInstanceInstalledDelegate OnModuleInstanceInstalled = null!;

        public delegate void ModuleInstanceConfiguredDelegate(UInt160 accountId, BigInteger moduleId, BigInteger credentialGeneration);

        [DisplayName("ModuleInstanceConfigured")]
        public static event ModuleInstanceConfiguredDelegate OnModuleInstanceConfigured = null!;

        public delegate void ModuleInstanceRemovedDelegate(UInt160 accountId, BigInteger moduleId);

        [DisplayName("ModuleInstanceRemoved")]
        public static event ModuleInstanceRemovedDelegate OnModuleInstanceRemoved = null!;

        public delegate void ModuleCodeReboundDelegate(UInt160 accountId, BigInteger moduleId, ByteString bindingDigest);

        [DisplayName("ModuleCodeRebound")]
        public static event ModuleCodeReboundDelegate OnModuleCodeRebound = null!;

        public delegate void HookOrderSetDelegate(UInt160 accountId, BigInteger hookOrderRevision, BigInteger[] hookIds);

        [DisplayName("HookOrderSet")]
        public static event HookOrderSetDelegate OnHookOrderSet = null!;

        public delegate void ThresholdPolicySetDelegate(UInt160 accountId, BigInteger policyId, BigInteger threshold, BigInteger[] memberIds);

        [DisplayName("ThresholdPolicySet")]
        public static event ThresholdPolicySetDelegate OnThresholdPolicySet = null!;

        public delegate void CredentialRevokedDelegate(UInt160 accountId, BigInteger moduleId, BigInteger credentialGeneration);

        [DisplayName("CredentialRevoked")]
        public static event CredentialRevokedDelegate OnCredentialRevoked = null!;

        public delegate void ConfigurationIntentProposedDelegate(UInt160 accountId, BigInteger intentId, BigInteger actionCount, ByteString actionDigest);

        [DisplayName("ConfigurationIntentProposed")]
        public static event ConfigurationIntentProposedDelegate OnConfigurationIntentProposed = null!;

        public delegate void ConfigurationIntentConfirmedDelegate(UInt160 accountId, BigInteger intentId, BigInteger configurationNonce);

        [DisplayName("ConfigurationIntentConfirmed")]
        public static event ConfigurationIntentConfirmedDelegate OnConfigurationIntentConfirmed = null!;

        public delegate void ConfigurationIntentCancelledDelegate(UInt160 accountId, BigInteger intentId);

        [DisplayName("ConfigurationIntentCancelled")]
        public static event ConfigurationIntentCancelledDelegate OnConfigurationIntentCancelled = null!;

        public delegate void ConfigurationIntentExpiredDelegate(UInt160 accountId, BigInteger intentId);

        [DisplayName("ConfigurationIntentExpired")]
        public static event ConfigurationIntentExpiredDelegate OnConfigurationIntentExpired = null!;

        public delegate void NonceChannelOpenedDelegate(UInt160 accountId, ByteString channelDigest);

        [DisplayName("NonceChannelOpened")]
        public static event NonceChannelOpenedDelegate OnNonceChannelOpened = null!;

        public delegate void NonceChannelExhaustedDelegate(UInt160 accountId, ByteString channelDigest);

        [DisplayName("NonceChannelExhausted")]
        public static event NonceChannelExhaustedDelegate OnNonceChannelExhausted = null!;

        // ========================================================================
        // Freeze / recovery / market-lock / migration events (spec §18).
        // ========================================================================

        public delegate void AccountEpochDelegate(UInt160 accountId, BigInteger authorityEpoch);

        [DisplayName("AccountFrozen")]
        public static event AccountEpochDelegate OnAccountFrozen = null!;

        [DisplayName("AccountUnfrozen")]
        public static event AccountEpochDelegate OnAccountUnfrozen = null!;

        public delegate void RecoveryInitiatedDelegate(UInt160 accountId, UInt160 newCustody, BigInteger matureAt);

        [DisplayName("RecoveryInitiated")]
        public static event RecoveryInitiatedDelegate OnRecoveryInitiated = null!;

        [DisplayName("RecoveryCancelled")]
        public static event AccountOnlyDelegate OnRecoveryCancelled = null!;

        public delegate void RecoveryExecutedDelegate(UInt160 accountId, BigInteger authorityEpoch, BigInteger configurationNonce);

        [DisplayName("RecoveryExecuted")]
        public static event RecoveryExecutedDelegate OnRecoveryExecuted = null!;

        public delegate void MarketControlEpochBoundDelegate(UInt160 accountId, BigInteger listingId, BigInteger controlEpoch);

        [DisplayName("MarketControlEpochBound")]
        public static event MarketControlEpochBoundDelegate OnMarketControlEpochBound = null!;

        public delegate void MarketLockInvalidatedDelegate(UInt160 accountId, BigInteger controlEpoch);

        [DisplayName("MarketLockInvalidated")]
        public static event MarketLockInvalidatedDelegate OnMarketLockInvalidated = null!;

        public delegate void CoreRecoveryRecordedDelegate(UInt160 accountId, BigInteger matureAt);

        [DisplayName("CoreRecoveryRecorded")]
        public static event CoreRecoveryRecordedDelegate OnCoreRecoveryRecorded = null!;

        public delegate void MigrationRequiredDelegate(UInt160 accountId, BigInteger legacyModuleCount);

        [DisplayName("MigrationRequired")]
        public static event MigrationRequiredDelegate OnMigrationRequired = null!;

        public delegate void MigrationImportedDelegate(UInt160 accountId, ByteString manifestDigest, string classification);

        [DisplayName("MigrationImported")]
        public static event MigrationImportedDelegate OnMigrationImported = null!;

        public delegate void MessageSubjectUpdatedDelegate(UInt160 accountId, BigInteger subjectCount, BigInteger threshold, BigInteger subjectRevision);

        [DisplayName("MessageSubjectUpdated")]
        public static event MessageSubjectUpdatedDelegate OnMessageSubjectUpdated = null!;
    }
}
