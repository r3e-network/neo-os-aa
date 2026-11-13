using System.ComponentModel;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;

namespace SmartAccount
{
    /// <summary>
    /// Canonical Neo N3 AA core for the V3 runtime.
    /// </summary>
    /// <remarks>
    /// This contract owns account state, nonce management, verifier and hook routing,
    /// backup-owner recovery, and the final target-contract execution path. Users normally:
    /// 1. register an account with <c>RegisterAccount</c>,
    /// 2. optionally bind verifier and hook plugins,
    /// 3. submit one or more <c>UserOperation</c> payloads through <c>ExecuteUserOp</c>.
    /// Security-sensitive configuration changes are always gated by the backup owner witness.
    /// </remarks>
    [DisplayName("SmartAccountV3")]
    // Outbound-permission audit (converged with the Phase 1b service extraction):
    // the wildcard pair is required for exactly ONE axis — ExecuteUserOp
    // dispatches Contract.Call(op.TargetContract, op.Method, ...) to arbitrary
    // user-chosen contracts, so any fixed enumeration here would cap the
    // protocol's user-op target surface. Every other outbound axis of this
    // contract is fixed-shape and enumerated below for review:
    //   * verifier callbacks       : validateSignature / postExecute on the
    //                                account's configured verifier child
    //   * hook callbacks           : preExecute / postExecute (maintenance-budget
    //                                call) on the account's configured hook child
    //   * module-call allowlists   : callVerifierChild / callHookChild execute a
    //                                user-allowlisted (child, method) pair
    //   * paymaster settlement     : authorizedCore (read) + settleReimbursement
    //                                on the authorized AAPaymaster
    //   * market escape path       : abandonListing on the bound AAAddressMarket
    //   * registrar migration      : ingestPendingPlatformOwnerRotation on the
    //                                authorized AAPlatformRegistrar
    //   * governed self-upgrade    : ContractManagement.Update; user-op targets
    //                                are explicitly barred from it
    // The extracted service contracts (AAPaymaster, AAAddressMarket,
    // AAPlatformRegistrar) and all plugins (verifiers, hooks) use
    // least-privilege manifests; only the core needs the wildcard.
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "ERC-4337 Aligned Minimalist AA Engine for Neo N3")]
    public partial class SmartAccount : SmartContract
    {
        // =====================================================================================
        // STORAGE PREFIX MAP  (authoritative — pinned by StoragePrefixMapTests)
        // =====================================================================================
        // Every storage key in this contract begins with a one-byte prefix declared as
        // `private static readonly byte[] Prefix_* = new byte[] { 0xNN };`. The declarations are
        // spread across the partial-class files below. This map is the single source of truth for
        // the allocation: it lists each prefix byte, its owning partial, the Prefix_* field, and the
        // KEY SHAPE (how the prefix is combined into a full storage key).
        //
        // KEY SHAPES:
        //   bare      = the 1-byte prefix is the entire storage key (a single global slot).
        //   +acctId   = the prefix is concatenated with a 20-byte accountId
        //               (Helper.Concat(prefix, accountId)) -> a 21-byte per-account key.
        //
        // Byte  Field                              Owning partial            Key shape
        // ----  ---------------------------------  ------------------------  ---------
        // 0x01  Prefix_AccountState                Internal.cs               +acctId
        // 0x02  Prefix_VerifyContext               Internal.cs               +acctId
        // 0x03  Prefix_Nonce                       Internal.cs               +acctId(+channel)
        // 0x04  Prefix_VerifierConfigContext       Internal.cs               +acctId
        // 0x05  Prefix_HookConfigContext           Internal.cs               +acctId
        // 0x06  Prefix_MarketEscrowContract        Internal.cs               +acctId
        // 0x07  Prefix_MarketEscrowListing         Internal.cs               +acctId
        // 0x08  Prefix_EscapeLastInitiated         Internal.cs               +acctId
        // 0x09  Prefix_PendingVerifierUpdate       Internal.cs               +acctId
        // 0x0A  Prefix_PendingHookUpdate           Internal.cs               +acctId
        // 0x0B  Prefix_ExecutionLock               Internal.cs               +acctId
        // 0x0C  Prefix_MetadataUri                 Internal.cs               +acctId
        // 0x0D  Prefix_HookExecutionContext        Internal.cs               +acctId
        // 0x0E  Prefix_VerifierExecutionContext    Internal.cs               +acctId
        // 0x0F  Prefix_PendingVerifierCall         Internal.cs               +acctId
        // 0x10  Prefix_PendingHookCall             Internal.cs               +acctId
        // 0x11  Prefix_ContractAdmin               Admin.cs                  bare
        // 0x1A  Prefix_PendingUpdateNefHash        Admin.cs                  bare
        // 0x1B  Prefix_PendingUpdateManifestHash   Admin.cs                  bare
        // 0x1C  Prefix_VerifyScopeTarget           Internal.cs               +acctId
        // 0x1D  Prefix_MarketEscrowCancelInitiated MarketEscrow.cs           +acctId
        // 0x14  Prefix_UpdateTimelock              Admin.cs                  bare
        // 0x15  Prefix_PendingContractAdmin        Admin.cs                  bare
        // 0x16  Prefix_AdminTransferTimelock       Admin.cs                  bare
        // 0x17  Prefix_PlatformRegistrar           PlatformRegistrar.cs      bare
        // 0x18  Prefix_PendingPlatformRegistrar    PlatformRegistrar.cs      bare
        // 0x19  Prefix_PlatformRegistrarTimelock   PlatformRegistrar.cs      bare
        // 0x1E  Prefix_PlatformAccountBinding     PlatformRegistrar.cs      +acctId
        // 0x1F  Prefix_PlatformProxyAccount      PlatformRegistrar.cs      +acctId(proxy)
        //
        // 0x21  Prefix_TransactionReimbursement     Paymaster.cs              bare
        // 0x22  Prefix_OwnerOnlyRecovery            Escape.cs                 +acctId
        // 0x23  Prefix_HookDependencies             Internal.cs               +acctId
        // 0x24  Prefix_VerifierDependencies         Internal.cs               +acctId
        // 0x25  Prefix_DependencyMaintenance       Internal.cs               +acctId
        // 0x26  Prefix_ConfigurationContextDepth   Internal.cs               bare
        // 0x27  Prefix_AccountFrozen              Escape.cs                 +acctId
        // 0x28  Prefix_UserOperationInFlight      Internal.cs               bare
        // 0x29  Prefix_MarketServiceRegistration   MarketEscrow.cs           +acctId(market)
        // 0x2A  Prefix_PlatformOwnerRotationsMigrated PlatformRegistrar.cs   bare
        //
        // ACTIVE LAYOUT: every prefix byte is globally unique. StoragePrefixMapTests pins this map
        // against the source and rejects any future active prefix reuse.
        //
        // LEGACY COMPATIBILITY: LegacyStoragePrefix12, LegacyStoragePrefix13 and
        // LegacyStoragePrefix20 below are used only
        // to read and delete keys written by the pre-renumbered / pre-extraction layout. They are not active prefixes,
        // and all new writes use the unique 0x1A-0x1D allocation above. This keeps ContractManagement
        // upgrades state-compatible without carrying the old shape-based allocation forward.
        // LegacyStoragePrefix20 (pending platform owner rotations) is read exactly once by
        // MigratePlatformOwnerRotations, which moves those rows into the AAPlatformRegistrar
        // service contract and then never reads them again.
        // =====================================================================================

        private static readonly byte[] LegacyStoragePrefix12 = new byte[] { 0x12 };
        private static readonly byte[] LegacyStoragePrefix13 = new byte[] { 0x13 };
    }
}
