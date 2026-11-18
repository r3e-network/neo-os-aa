using System.ComponentModel;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;

namespace SmartAccount
{
    /// <summary>
    /// Canonical Neo N3 SA core for the v4 module-model runtime.
    /// </summary>
    /// <remarks>
    /// This contract owns the v4 account control records (0x51), the
    /// multi-validator / multi-hook module collections (0x52/0x53), hook
    /// order (0x54), configuration intents (0x55/0x5E), nonce channels
    /// (0x56/0x5C), message subjects (0x57), F-7 phase gates (0x58),
    /// callback-free recovery records (0x59), migration state (0x5A),
    /// threshold policies (0x5B) and the Market control-epoch bindings
    /// (0x5D). Users normally:
    /// 1. create an account with <c>createAccount</c> (custody+salt
    ///    identity, atomic initial configuration install),
    /// 2. change module configuration through 24h configuration intents
    ///    (<c>proposeConfiguration</c> / <c>confirmConfiguration</c>),
    /// 3. submit canonical 13-field user operations through
    ///    <c>executeUserOp</c> / <c>executeUserOps</c>.
    /// Security-sensitive configuration is custody-witness gated and every
    /// module callback runs under the §11 Plan B gas hard budget and the
    /// 0x58 per-phase authorization gates.
    /// </remarks>
    [DisplayName("SmartAccount")]
    // Outbound-permission audit (converged with the v4 module model, plan
    // item #25 / design report §6.12): the wildcard pair is required for
    // exactly ONE axis — the operation envelope's TargetDispatch executes
    // Contract.Call(op.target, op.method, ...) against arbitrary
    // user-chosen contracts, so any fixed enumeration here would cap the
    // protocol's user-op target surface. This authorization is:
    //   * envelope-bound   : only a fully validated 13-field operation whose
    //                        routed validator accepted the digest reaches a
    //                        target call (AssertTargetIsNotProtocolOwned
    //                        bars protocol-owned addresses);
    //   * phase-exclusive : it exists only inside the 0x58 TargetDispatch
    //                        phase of one operation; validation callbacks
    //                        are read-only and can never reach it (F-7);
    //   * non-propagating: dispatched targets never inherit any module
    //                        authorization — module callbacks are addressed
    //                        exclusively to recorded 0x52 instances and
    //                        expire with their writer phase.
    // Every other outbound axis of this contract is fixed-shape and
    // enumerated below for review:
    //   * module callbacks        : getModuleProfile / onInstall /
    //                              onUninstall / configure /
    //                              validateUserOp / onUserOpComplete /
    //                              preCheck / postCheck / isValidSignature
    //                              on the account's recorded 0x52 module
    //                              instances (gas-capped)
    //   * paymaster settlement    : authorizedCore (read) +
    //                              settleReimbursement on the authorized
    //                              SAPaymaster
    //   * governed self-upgrade   : ContractManagement.Update; operation
    //                              targets are explicitly barred from it
    // The extracted service contracts (SAPaymaster, SAAddressMarket,
    // SAPlatformRegistrar) and all plugins (validators, hooks) use
    // least-privilege manifests; only the core needs the wildcard, and the
    // core never grants it onward.
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "ERC-7579-aligned SA module-model kernel for Neo N3")]
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
        //   +acctId+fixed-width integer suffix = per-account per-entity key; every
        //               integer key suffix is fixed-width big-endian (8 bytes for
        //               module/intent/policy ids, 24 bytes for nonce channels, 1 byte
        //               for the module-type index).
        //
        // LEGACY REGION (0x01-0x29, protocol <4): prefixes marked RETIRED are
        // permanently reserved and never re-allocated — they are no longer
        // written by v4 code; surviving rows are migration input or inert
        // evidence (spec §7.4). The v4 region is 0x50-0x5E; 0x5F is reserved.
        //
        // Byte  Field                              Owning partial            Key shape
        // ----  ---------------------------------  ------------------------  ---------
        // 0x01  Prefix_AccountState                Internal.cs               +acctId (legacy row: migration input)
        // 0x02  Prefix_VerifyContext               Internal.cs               +acctId
        // 0x03  Prefix_Nonce                       Internal.cs               +acctId+channel (legacy: migration input)
        // 0x04  — RETIRED (verifier config context, v4 F-7 gates live in 0x58)
        // 0x05  — RETIRED (hook config context)
        // 0x06  Prefix_MarketEscrowContract        Internal.cs               +acctId (Market-only writes, §7.5)
        // 0x07  Prefix_MarketEscrowListing         Internal.cs               +acctId (Market-only writes, §7.5)
        // 0x08  Prefix_EscapeLastInitiated         Internal.cs               +acctId (RETIRED)
        // 0x09  Prefix_PendingVerifierUpdate       Internal.cs               +acctId (RETIRED: legacy pending update)
        // 0x0A  Prefix_PendingHookUpdate           Internal.cs               +acctId (RETIRED)
        // 0x0B  Prefix_ExecutionLock               Internal.cs               +acctId
        // 0x0C  Prefix_MetadataUri                 Internal.cs               +acctId
        // 0x0D  Prefix_HookExecutionContext        Internal.cs               +acctId (RETIRED declaration)
        // 0x0E  Prefix_VerifierExecutionContext    Internal.cs               +acctId (RETIRED declaration)
        // 0x0F  Prefix_PendingVerifierCall         Internal.cs               +acctId (RETIRED declaration)
        // 0x10  Prefix_PendingHookCall              Internal.cs               +acctId (RETIRED declaration)
        // 0x11  Prefix_ContractAdmin               Admin.cs                  bare
        // 0x1A  Prefix_PendingUpdateNefHash        Admin.cs                  bare
        // 0x1B  Prefix_PendingUpdateManifestHash   Admin.cs                  bare
        // 0x1C  — RETIRED (per-account scope-target grant, F-1 fix; permanently reserved)
        // 0x1D  Prefix_MarketEscrowCancelInitiated MarketEscrow.cs           +acctId (Market-only writes, §7.5)
        // 0x14  Prefix_UpdateTimelock              Admin.cs                  bare
        // 0x15  Prefix_PendingContractAdmin        Admin.cs                  bare
        // 0x16  Prefix_AdminTransferTimelock       Admin.cs                  bare
        // 0x17  Prefix_PlatformRegistrar           PlatformRegistrar.cs      bare
        // 0x18  Prefix_PendingPlatformRegistrar    PlatformRegistrar.cs      bare
        // 0x19  Prefix_PlatformRegistrarTimelock   PlatformRegistrar.cs      bare
        // 0x1E  Prefix_PlatformAccountBinding     PlatformRegistrar.cs      +acctId
        // 0x1F  Prefix_PlatformProxyAccount        PlatformRegistrar.cs      +acctId(proxy)
        //
        // 0x21  Prefix_TransactionReimbursement    Paymaster.cs              bare
        // 0x22  Prefix_OwnerOnlyRecovery          Escape.cs                  +acctId (legacy latch: migration input)
        // 0x23  Prefix_HookDependencies            Internal.cs                +acctId (RETIRED declaration)
        // 0x24  Prefix_VerifierDependencies        Internal.cs                +acctId (RETIRED declaration)
        // 0x25  Prefix_DependencyMaintenance       Internal.cs                +acctId (RETIRED declaration)
        // 0x26  Prefix_ConfigurationContextDepth   Internal.cs                bare
        // 0x27  Prefix_AccountFrozen               Escape.cs                  +acctId (legacy latch: migration input)
        // 0x28  Prefix_UserOperationInFlight       Internal.cs                bare
        // 0x29  Prefix_MarketServiceRegistration   MarketEscrow.cs            +acctId(market)
        //
        // ---- V4 MODULE-MODEL REGION (spec §7.1; declared in ModuleProtocol.cs) -------------
        // 0x50  Prefix_ProtocolInfo                ModuleProtocol.cs          bare
        // 0x51  Prefix_AccountControl              ModuleProtocol.cs          +acctId
        // 0x52  Prefix_ModuleInstance              ModuleProtocol.cs          +acctId+moduleId[8 BE]
        // 0x53  Prefix_ModuleIndex                 ModuleProtocol.cs          +acctId+type[1]+moduleId[8 BE]
        // 0x54  Prefix_HookOrder                   ModuleProtocol.cs          +acctId
        // 0x55  Prefix_ConfigIntent                ModuleProtocol.cs          +acctId+intentId[8 BE]
        // 0x56  Prefix_NonceCursor                 ModuleProtocol.cs          +acctId+channel[24 BE]
        // 0x57  Prefix_MessageSubject              ModuleProtocol.cs          +acctId
        // 0x58  Prefix_ApplicationContext           ModuleProtocol.cs          +acctId
        // 0x59  Prefix_CoreRecovery                 ModuleProtocol.cs          +acctId
        // 0x5A  Prefix_MigrationState              ModuleProtocol.cs          +acctId
        // 0x5B  Prefix_ThresholdPolicy             ModuleProtocol.cs          +acctId+policyId[8 BE]
        // 0x5C  Prefix_NonceNamespace              ModuleProtocol.cs          +acctId+channel[24 BE]
        // 0x5D  Prefix_MarketControlEpoch          ModuleProtocol.cs          +acctId
        // 0x5E  Prefix_ConfigIntentIndex            ModuleProtocol.cs          +acctId
        // 0x5F  — RESERVED, never declared
        //
        // ACTIVE LAYOUT: every prefix byte is globally unique. StoragePrefixMapTests pins this map
        // against the source and rejects any future active prefix reuse.
        // =====================================================================================
    }
}
