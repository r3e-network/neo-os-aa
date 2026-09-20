# Protocol Completeness Audit: vs ERC-4337 & ERC-7579

**Date:** 2026-09-13
**Auditor:** NeoOS protocol remediation review
**Status:** Conditional compatibility; Neo-native implementation with explicit adapters

> **Snapshot notice:** This is a 2026-09-13 compatibility snapshot. Its
> historical finding list and recommendations are not the current remediation
> ledger. For current source status, bounded formal evidence, and explicit
> unresolved boundaries, use `docs/SECURITY_MODEL.md`,
> `docs/AA-FORMAL-VERIFICATION.md`, and the dated build receipt under
> `docs/reports/`.

---

## Executive Summary

The Neo N3 Abstract Account protocol is a **Neo-native account system inspired by ERC-4337/ERC-7579**, not a drop-in Ethereum implementation. It does not expose an EntryPoint, Ethereum UserOperation ABI, bundler RPC, ERC-7579 executor/module interface, or Ethereum paymaster staking lifecycle. Those differences are protocol boundaries and must be visible to integrators.

The core now exposes a standards-friendly discovery surface (`getAccountImplementationId`, `supportsExecutionMode`, `supportsModuleType`, `isModuleInstalled`, and `previewUserOpValidation`) plus an ERC-1271-compatible result adapter. `isValidSignature` returns `0x1626ba7e` only when the installed verifier explicitly supports message signatures; UserOperation validation is never silently reused as message validation. The currently shipped Web3Auth verifier implements that adapter for compact 64-byte and recoverable 65-byte ECDSA signatures. Other verifiers advertise `false` and fail closed.

This is **interoperability at the adapter boundary**, not a claim of full ERC-4337/ERC-7579 conformance. Ethereum clients still need a Neo transport adapter, Neo RPC, Neo transaction witnesses, and the documented Neo UserOperation layout.

| # | Requirement | Status | Notes |
|---|---|---|---|
| 1 | Plugin Lifecycle (install/update/remove) | ✓ | Complete with timelocks and events |
| 2 | 2D Nonce Management (channel+sequence, salt mode) | ✓ Neo equivalent | Sequential channel/sequence semantics match the relevant ERC-4337 shape; the surrounding UserOperation and transport remain Neo-specific |
| 3 | Escape Hatch Mechanism (timelock, cooldown, finalization) | ✓ | Production-grade L1 escape |
| 4 | Storage Patterns (gas-efficient for Neo N3) | ✓ | Optimized prefix-key storage |
| 5 | Account State Management (atomic) | ✓ | Atomic state updates |
| 6 | Market Escrow (cancellation, expiry, dispute) | ✓ | Complete with edge cases |
| 7 | Verification Scripts Integration | ✓ | Native script model properly used |
| 8 | Paymaster/Sponsor Flow | ✓ | Off-chain Morpheus integration |
| 9 | Documentation Accuracy | ✓ | Docs accurately reflect implementation |
| 10 | ERC-1271 message validation adapter | ✓ | Core returns standard magic/invalid values; verifier capability is explicit |
| 11 | Full ERC-4337 EntryPoint/bundler compatibility | — | Not implemented; Neo-native relay and RPC are required |
| 12 | Full ERC-7579 executor/module ABI compatibility | — | Not implemented; lifecycle is exposed through the Neo module ABI |

---

## Detailed Analysis

### 1. Plugin Lifecycle (install/update/remove) ✓

**Implementation Location:** `contracts/UnifiedSmartWallet.Accounts.cs`

**Features:**
- **Installation:** `RegisterAccount()` sets initial verifier and hook
- **Update with Timelock:** `UpdateVerifier()` and `UpdateHook()` create pending updates with 7-day (604,800s) ConfigUpdateTimelock
- **Confirmation:** `ConfirmVerifierUpdate()` and `ConfirmHookUpdate()` allow completion after timelock
- **Cancellation:** `CancelVerifierUpdate()` and `CancelHookUpdate()` allow immediate cancel
- **Authorization:** All config changes require `BackupOwner` native witness
- **Authority Checks:** `VerifierAuthority.CanConfigureVerifier()` and `HookAuthority.CanConfigureHook()`
- **Events:** All lifecycle events emitted (ModuleInstalled, ModuleUpdateInitiated, ModuleUpdateConfirmed, ModuleUpdateCancelled, ModuleRemoved)

**Comparison to ERC-7579:**
- ERC-7579 `onInstall(bytes32)` → Neo's `RegisterAccount()` with direct call
- ERC-7579 `onUninstall(bytes32)` → Neo's authorization-based removal
- ERC-7579 timelock not specified → Neo enforces 7-day minimum
- Neo is **more conservative** with 7-day hard minimum (vs no requirement)

**Assessment:** ✓ Production-grade implementation

---

### 2. Neo 2D Nonce Management (channel+sequence, salt mode) ✓

**Implementation Location:** `contracts/UnifiedSmartWallet.Execution.cs` lines 156-204

**Sequential Mode (nonce < 1,000,000,000,000,000):**
```csharp
BigInteger channel = nonce >> 64;
BigInteger sequence = nonce & 0xFFFFFFFFFFFFFFFF;
```
- Matches the relevant ERC-4337 2D sequential nonce shape
- Channel 0: 0, 1, 2, 3... | Channel 1: 0, 1, 2, 3...
- Used for standard transactions requiring ordering

**Salt/UUID Mode (nonce >= 1,000,000,000,000,000):**
```csharp
byte[] saltKey = Helper.Concat(Prefix_Nonce, (byte[])accountId);
key = Helper.Concat(key, nonce.ToByteArray());
```
- Used salts tracked to prevent reuse
- Prevents collisions by storing used salts
- Intended for high-frequency TEE/SessionKey concurrency
- Similar to ERC-4337 EIP-4337 "random nonce mode" proposals

**Replay Protection:**
- `IsNonceAcceptable()` prevents re-execution
- `ConsumeNonce()` advances sequence atomically
- `Deadline` check in `ExecuteUserOp()` prevents expired replay
- `Runtime.GetNetwork()` in signing payload prevents cross-chain replay

**Comparison to ERC-4337:**
- ERC-4337: `nonce = key << 64 + sequence`
- Neo: **Equivalent semantics** for sequential mode
- Neo: adds a Neo-specific UUID/salt mode for concurrency

**Assessment:** ✓ Exceeds ERC-4337 with UUID mode support

---

### 3. Escape Hatch Mechanism (timelock, cooldown, finalization) ✓

**Implementation Location:** `contracts/UnifiedSmartWallet.Escape.cs`

**Flow:**
```mermaid
stateDiagram-v2
    [*] --> Configured: BackupOwner set
    Configured --> EscapeInitiated: InitiateEscape() called
    EscapeInitiated --> [*]: Normal op cancels escape
    EscapeInitiated --> EscapeFinalized: Timelock expires + FinalizeEscape()
    EscapeFinalized --> [*]: Verifier reset to BackupOwner
```

**Features:**
- **Timelock:** Configurable 7-90 days (604,800-7,776,000 seconds)
- **Cooldown:** 7-day minimum between escape initiation attempts
- **Cancel-on-Use:** Any normal `ExecuteUserOp()` cancels in-progress escape
- **Activity Cancellation:** Backup owner can cancel active escape
- **Finalization:** `FinalizeEscape()` rotates to new verifier and clears state
- **Events:** `EscapeInitiated`, `EscapeFinalized`, `EscapeCancelled` emitted

**Security Properties:**
- **Delayed Takeover:** 7-90 day minimum prevents immediate takeover
- **No Oracle Dependency:** Pure on-chain state machine
- **No Per-Account Deployment:** Works with virtual accounts
- **Audit Trail:** All escape events emitted

**Comparison to ERC-4337/7579:**
- Ethereum AA: No native recovery specified (wallet-specific)
- Neo: **More robust** L1 escape hatch
- Neo: **Advantage**: Works with virtual accounts (zero deployment cost)

**Assessment:** ✓ Superior to Ethereum AA patterns

---

### 4. Storage Patterns (gas-efficient for Neo N3) ✓

**Storage Layout:**
- `Prefix_AccountState` → `accountId` → `AccountState` (large struct)
- `Prefix_Nonce` → `accountId` + `channel` → `sequence`
- `Prefix_Nonce` + `accountId` + `nonce` → `used` (for UUID mode)
- `Prefix_EscapeLastInitiated` → `accountId` → timestamp
- `Prefix_PendingVerifierUpdate` → `accountId` → `PendingConfigUpdate`
- `Prefix_PendingHookUpdate` → `accountId` → `PendingConfigUpdate`
- `Prefix_MetadataUri` → `accountId` → `string`
- `Prefix_MarketEscrowContract` → `accountId` → `contract`
- `Prefix_MarketEscrowListing` → `accountId` → `listingId`

**Gas Efficiency:**
- **Single-Write Per Op:** `ConsumeNonce()` writes sequence once
- **Batch-Write:** Market settlement clears all state in one transaction
- **Lazy-Load:** `GetAccountState()` loads once per operation
- **No Redundant Writes:** Pending updates stored once

**Neo N3 Optimization:**
- Uses Neo's efficient `Storage.Put()` API
- Struct serialization via `StdLib.Serialize()`
- Concatenation via `Helper.Concat()` (optimized byte array ops)

**Assessment:** ✓ Production-optimized for Neo N3

---

### 5. Account State Management (atomic) ✓

**Implementation Location:** `contracts/UnifiedSmartWallet.State.cs`

**State Structure:**
```csharp
public struct AccountState {
    UInt160 Verifier;      // Which verifier validates operations
    UInt160 HookId;        // Which hook policy is applied
    UInt160 BackupOwner;   // Who can initiate recovery
    uint EscapeTimelock;    // Recovery delay in seconds
    BigInteger EscapeTriggeredAt;  // When recovery was started
}
```

**Atomicity Guarantees:**
1. **State Snapshot:** `GetAccountState()` reads complete state atomically
2. **Execution Lock:** `SetExecutionLock()` / `ClearExecutionLock()` prevents reentrancy
3. **Verify Context:** `SetVerifyContext(accountId)` limits signature verification window
4. **Hook Context:** `SetHookExecutionContext(accountId)` limits hook execution scope
5. **Single Transaction:** State update in `ExecuteUserOp()` is atomic

**Reentrancy Protection:**
```csharp
ExecutionEngine.Assert(!IsAnyExecutionActive(), "Reentrant call rejected");
```
- Global execution lock across all operations
- Fails immediately if any op is in-flight

**Comparison to ERC-4337:**
- ERC-4337: Relies on EntryPoint immutable state + reentrancy guards
- Neo: **Similar approach** with execution lock
- Neo: **Additional protection** via hook/verifier context isolation

**Assessment:** ✓ Production-grade atomic state management

---

### 6. Market Escrow (cancellation, expiry, dispute) ✓

**Implementation Location:** `contracts/UnifiedSmartWallet.MarketEscrow.cs`

**Features:**
- **Entry:** `EnterMarketEscrow(accountId, marketContract, listingId)`
- **Block:** While escrow is active, normal operations and config changes are blocked
- **Cancellation:** `CancelMarketEscrow(accountId, listingId)` clears escrow without changing control
- **Settlement:** `SettleMarketEscrow(accountId, listingId, newBackupOwner)` transfers shell, wipes prior state
- **Exclusivity:** Both market contract and escrow listing must match
- **Clean Account:** Settlement removes verifier, hook, and escape state

**Security Properties:**
```csharp
ExecutionEngine.Assert(!IsMarketEscrowActive(accountId), "Account locked in market escrow");
```
- Prevents concurrent operations during active listing

**Edge Cases Handled:**
- ✓ Listing cancellation (seller-initiated)
- ✓ Settlement completion (buyer-initiated)
- ✓ Verification of contract authorization
- ✓ State cleanup (removes prior plugins)
- ✓ Backup owner rotation requirement

**Comparison to ERC-4337:**
- ERC-4337: No native market escrow specified
- Neo: **Native advantage** with integrated escrow
- Neo: **Cleaner** state management (complete state wipe)

**Assessment:** ✓ Complete production-grade market escrow

---

### 7. Verification Scripts Integration ✓

**Implementation Location:** Multiple verifier plugins in `contracts/verifiers/`

**Plugin Interfaces:**
```csharp
public interface IVerifier {
    bool validateSignature(UInt160 accountId, UserOperation op);
    ByteString getPayload(...);
}
```

**Native Script Model Integration:**
```csharp
// From UnifiedSmartWallet.Execution.cs
SetVerifyContext(accountId);
...
object result = Contract.Call(op.TargetContract, op.Method, CallFlags.All, op.Args);
...
ClearVerifyContext(accountId);
```

**Security Model:**
- **Verify Context:** Limits `CheckWitness(accountId)` to specific execution
- **No State Changes:** Verifiers called with `CallFlags.ReadOnly`
- **Isolation:** Verifiers cannot directly access account state
- **Authority Gating:** `VerifierAuthority.CanConfigureVerifier()` checks permissions

**Supported Verifiers:**
- **Web3AuthVerifier:** EVM EIP-712 signatures
- **WebAuthnVerifier:** Hardware biometrics
- **TEEVerifier:** Trusted execution environment
- **SessionKeyVerifier:** Temporary delegation
- **MultiSigVerifier:** Threshold approval
- **SubscriptionVerifier:** Off-chain allowance

**SDK Integration:**
- `buildContractCompatibleStructHash()` matches contract encoding exactly
- `buildWeb3AuthSigningPayload()` creates complete 66-byte signing payload
- `signMessage()` applies EIP-191 wrapper (expected by verifiers)

**Assessment:** ✓ Full Neo native script model compatibility

---

### 8. Paymaster/Sponsor Flow ✓

**Implementation Location:** Off-chain Morpheus service

**Authorization Flow:**
```
Relay Server → Paymaster API: POST /api/paymaster/authorize
Response: { approved: boolean, reason?: string }
```

**Features:**
- **Off-chain Authorization:** Paymaster decisions made externally
- **Sponsorship:** Covers gas for approved UserOperations
- **Rejection:** Can decline with explicit reason
- **Network Isolation:** Testnet/Mainnet separation

**Comparison to ERC-4337:**
- ERC-4337: On-chain `validatePaymasterUserOp()` contract
- Neo: **Off-chain only** - simpler but less verifiable on-chain
- Neo: **Advantage:** No per-op gas estimation overhead
- Neo: **Trade-off:** Reduced on-chain transparency

**Security Note:** `SECURITY_MODEL.md` documents the off-chain authorization design. This is a **conscious architectural choice** for Neo ecosystem, not a vulnerability.

**Assessment:** ✓ Production-grade off-chain paymaster integration

---

### 9. Documentation Accuracy ✓

**Documentation Files:**

| File | Purpose | Accuracy |
|---|---|---|
| `docs/ETHEREUM_AA_COMPARISON.md` | ERC-4337/7579 mapping | ✓ Accurate |
| `docs/SECURITY_MODEL.md` | Threat model & security properties | ✓ Accurate |
| `docs/PLUGIN_MATRIX.md` | Plugin compatibility matrix | ✓ Accurate |
| `docs/AA_V3_ARCHITECTURE.zh-CN.md` | V3 architecture (bilingual) | ✓ Accurate |
| `contracts/*.cs` | Inline XML documentation | ✓ Complete |

**Key Documented Claims:**
- ✓ "ERC-4337 Aligned Minimalist AA Engine" (ManifestExtra)
- ✓ 2D nonce with sequential and UUID modes
- ✓ 7-90 day escape timelock
- ✓ L1 native fallback via BackupOwner witness
- ✓ Reentrancy protection via ExecutionLock
- ✓ Cross-chain replay via Network ID in signing payload
- ✓ Verifier isolation (no direct state access)
- ✓ Hook policy enforcement (allow/deny only)
- ✓ Market escrow with clean state management

**Known Limitations (as documented):**
- **VULN-001:** The current AA artifact has no non-bypassable verifier gas cap;
  the platform extension is prototyped but not integrated or activated.
- **VULN-002:** Market/escape and settlement cleanup require deployed/refinement
  evidence; current source paths are hardened and tested fail-closed.
- **VULN-003:** Session-key revocation follows canonical execution order and
  cannot retroactively cancel an already ordered transaction.
- **VULN-004:** MultiSig configuration guards now include self-reference and
  child lifecycle-ABI/deployment preflight; bounded policy proofs exist, while
  child-key independence, arbitrary cycles and cryptographic refinement remain open.
- **VULN-005:** Known-plugin cleanup faults closed; arbitrary future-plugin
  cleanup remains outside the generic proof boundary.

**Assessment:** ✓ Documentation accurately reflects implementation and known limitations

---

## Summary of Findings

### Strengths vs ERC-4337

| Feature | Neo AA | ERC-4337 | Verdict |
|---|---|---|---|
| Zero-deployment virtual accounts | ✓ | ✗ | **Neo Advantage** |
| Heterogeneous signature schemes | ✓ | Limited | **Neo Advantage** |
| L1 native escape hatch | ✓ | Not specified | **Neo Advantage** |
| 2D nonce with UUID mode | ✓ | Proposed | **Neo Advantage** |
| Market escrow integration | ✓ | None | **Neo Advantage** |
| Cross-chain replay protection | ✓ | ✓ | **Parity** |
| Reentrancy protection | ✓ | ✓ | **Parity** |

### Areas Where Neo Exceeds ERC-4337

1. **On-chain Paymaster Verification** - Neo uses off-chain only (reduced transparency)
2. **Per-Operation Gas Limits** - the current AA artifact still lacks a
   non-bypassable verifier cap; a platform extension is drafted and prototyped
   separately in `docs/proposals/AA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.md`
3. **Staking Sponsorships** - Off-chain model vs ERC-4337 on-chain staking

### Areas Where ERC-4337 Exceeds Neo

1. **Native Paymaster** - Built-in gas sponsorship vs off-chain service
2. **Standardized Aggregation** - No aggregator role needed for Neo
3. **Per-Op Estimation** - ERC-4337 has preVerificationGas, Neo doesn't

---

## Recommendations

### High Priority (Security)

1. **Integrate the platform verifier gas budget** (VULN-001)
   - Do not add a caller-controlled `maxVerificationGas` parameter to
     `validateSignature()`; an ABI parameter alone cannot cap VM execution.
   - Activate and version `System.Contract.CallWithGasLimit` as specified in
     `docs/proposals/AA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.md`.
   - Recompile the AA core against the matching DevPack, then complete private
     NeoExpress and deployed-byte parity gates before changing the status.

2. **Preserve the current market/escape hardening**
   - Keep `IsMarketEscrowActive()` checks on normal escape/configuration paths.
   - Keep market settlement and owner-force-cancel cleanup fail-closed, and
     add a concrete cleanup/refinement proof for every future plugin profile.
     The manifest lifecycle preflight rejects marker-only, wrong-typed, or incomplete
     modules, including nested MultiSig/MultiHook children, but cannot prove the
     implementation of a declared method is semantically correct.

3. **Keep explicit session-key execution-order semantics**
   - Canonical state is read when validation executes; a later clear rejects a
     later operation but cannot retroactively cancel an already ordered one.
   - Wallets and relayers must re-check canonical state before submission.

4. **Extend MultiSig refinement coverage**
   - The empty, oversized, invalid-threshold and duplicate configuration
     checks now also reject self-reference and undeployed/incomplete or
     wrong-typed child lifecycle ABIs before storage. This is a concrete
     deployment/ABI guard,
     not a proof of independent child keys, arbitrary-cycle freedom,
     cryptographic correctness or full child-call refinement.

### Medium Priority (Enhancement)

5. **Complete plugin cleanup refinement**
   - Known-plugin cleanup now faults closed when `clearAccount` fails, and
     binding rejects a marker-only, wrong-typed, or incomplete module before
     storing its address.
   - A generic proof for arbitrary future plugins is not possible from a
     manifest alone; require an audited plugin manifest/profile and a concrete
     storage/refinement proof.

6. **Add Per-Account Gas Limits**
   - Implement account-level gas cap configuration
   - Store `maxDailyGas` in `AccountState`
   - Enforce in `ExecuteUserOp()` before execution

7. **Implement On-chain Paymaster Option**
   - Add `validatePaymasterUserOp()` method to `PaymasterVerifier`
   - Allow on-chain paymaster sponsorship as alternative to off-chain

### Low Priority (Documentation)

8. **Document Nonce Space Constraints**
   - Add documentation on recommended salt space sizing
   - Document trade-offs: larger space = lower collision probability = higher storage cost

9. **Add Paymaster Staking Guide**
   - Document how to register as Morpheus paymaster
   - Explain staking requirements and expected returns

---

## Conclusion

The Neo N3 Abstract Account protocol is production-oriented, with a clearly bounded Neo-native protocol and explicit compatibility adapters. It should be integrated as a Neo AA protocol. The ERC-1271 message adapter is now safe to consume because unsupported verifiers return the invalid magic value instead of falling back to a different signature domain.

- **Zero-cost virtual accounts** enable frictionless onboarding
- **Heterogeneous signatures** support multiple security models
- **Native L1 escape** provides robust recovery
- **Integrated market escrow** enables secure account transfer

The remaining Ethereum compatibility work is architectural rather than a method-name rename: a real ERC-4337 bridge would need a Neo EntryPoint-equivalent, UserOperation translation with domain separation, bundler/simulation endpoints, and an accountable paymaster policy. A real ERC-7579 bridge would need an executor/module ABI translation layer and lifecycle mapping. Those components must be deployed and tested as separate adapters before claiming ecosystem compatibility.

**Overall Assessment:** Neo-native AA is locally verified and the ERC-1271 adapter is implemented; full ERC-4337/ERC-7579 compatibility remains intentionally unclaimed.
