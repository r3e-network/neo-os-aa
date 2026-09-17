using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;

namespace AbstractAccount
{
    public partial class UnifiedSmartWallet
    {
        private const string ModuleTypeVerifier = "verifier";
        private const string ModuleTypeHook = "hook";

        // Custom delegates matching nccs-supported pattern (see Nep17Token.cs).
        public delegate void AccountRegisteredDelegate(UInt160 accountId, UInt160 backupOwner, UInt160 verifier, UInt160 hookId);
        public delegate void HookUpdateDelegate(UInt160 accountId, UInt160 hookId);
        public delegate void VerifierUpdateDelegate(UInt160 accountId, UInt160 verifier);
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

        [DisplayName("HookUpdateConfirmed")]
        public static event HookUpdateDelegate OnHookUpdateConfirmed = null!;

        [DisplayName("HookUpdateInitiated")]
        public static event HookUpdateDelegate OnHookUpdateInitiated = null!;

        [DisplayName("VerifierUpdateConfirmed")]
        public static event VerifierUpdateDelegate OnVerifierUpdateConfirmed = null!;

        [DisplayName("VerifierUpdateInitiated")]
        public static event VerifierUpdateDelegate OnVerifierUpdateInitiated = null!;

        [DisplayName("VerifierUpdateCancelled")]
        public static event AccountOnlyDelegate OnVerifierUpdateCancelled = null!;

        [DisplayName("HookUpdateCancelled")]
        public static event AccountOnlyDelegate OnHookUpdateCancelled = null!;

        [DisplayName("MetadataUriUpdated")]
        public static event MetadataUriUpdatedDelegate OnMetadataUriUpdated = null!;

        [DisplayName("EscapeCancelled")]
        public static event AccountOnlyDelegate OnEscapeCancelled = null!;

        [DisplayName("UserOpExecuted")]
        public static event UserOpExecutedDelegate OnUserOpExecuted = null!;

        [DisplayName("EscapeInitiated")]
        public static event EscapeInitiatedDelegate OnEscapeInitiated = null!;

        [DisplayName("EscapeFinalized")]
        public static event VerifierUpdateDelegate OnEscapeFinalized = null!;

        [DisplayName("MarketEscrowEntered")]
        public static event MarketEscrowEnteredDelegate OnMarketEscrowEntered = null!;

        [DisplayName("MarketEscrowCancelled")]
        public static event AccountOnlyDelegate OnMarketEscrowCancelled = null!;

        [DisplayName("MarketEscrowSettled")]
        public static event MarketEscrowSettledDelegate OnMarketEscrowSettled = null!;

        // --- Verify scope configuration ---

        /// <summary>Emitted whenever an account's verify-scope target changes.</summary>
        public delegate void VerifyScopeTargetDelegate(UInt160 accountId, UInt160 targetContract);

        [DisplayName("VerifyScopeTargetSet")]
        public static event VerifyScopeTargetDelegate OnVerifyScopeTargetSet = null!;

        // --- Paymaster / Sponsored Transactions ---

        public delegate void SponsoredUserOpExecutedDelegate(UInt160 accountId, UInt160 paymaster, UInt160 sponsor, UInt160 relay, BigInteger reimbursementAmount);

        [DisplayName("SponsoredUserOpExecuted")]
        public static event SponsoredUserOpExecutedDelegate OnSponsoredUserOpExecuted = null!;
    }
}
