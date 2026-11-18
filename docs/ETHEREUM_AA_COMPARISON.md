# Ethereum ERC-4337/ERC-7579 vs Neo N3 Smart Account Comparison

## Executive Summary

This document maps Ethereum ERC-4337 (Account Abstraction) and ERC-7579 (Modular Smart Account) concepts to the Neo N3 Smart Account implementation. Understanding these mappings helps developers familiar with Ethereum AA adapt to the Neo ecosystem.

> **Current-status note (2026-09-21):** This comparison is conceptual and
> retains historical published-runtime limitation wording. The current private
> SA artifact uses `System.Contract.CallWithGasLimit` with a 10 GAS verifier
> callback cap; matching NeoExpress evidence is recorded in
> `docs/reports/sa-neoexpress-gas-cap-20260921.json`. Public activation and
> deployment remain pending.

<!-- docs-truth: no fence claims for solidity; reason: the document compares Neo with Ethereum, so every solidity block lists the Ethereum interface (IValidator, IPaymaster, the ECDSA helper), not a Neo entrypoint. -->

---

## 1. Core Concept Mapping

| Ethereum Concept | Neo N3 Equivalent | Implementation Notes |
| --- | --- | --- |
| **EntryPoint Contract** | `SmartAccount` | Global singleton contract serving all accounts. No per-account deployment needed. |
| **Smart Account** | Virtual Account (`accountId`) | Deterministic address derived from `verify(accountId)` script, not a deployed contract. |
| **WalletContract** | N/A | Neo uses native `CheckWitness` with `VerifyContext` instead of separate wallet contract. |
| **Paymaster** | `SAPaymaster` Contract + Off-chain Morpheus | On-chain Paymaster contract for trustless sponsorship with deposit/policy/settlement, plus optional off-chain Morpheus integration. |
| **Bundler** | Relay Server | Packages `UserOperation`s into Neo transactions. |
| **Aggregator** | MultiHook | Combines multiple validation/policy modules (hooks) into one. |
| **Validator** | Verifier Plugin | Signature verification logic (ECDSA, WebAuthn, TEE, etc.). |
| **Executor** | N/A | Core contract directly executes; no separate executor needed. |
| **Fallback Handler** | `BackupOwner` Native Witness | L1 escape hatch for when verifiers fail. |
| **UserOperation** | `UserOperation` struct | Nearly identical: target, method, args, nonce, deadline, signature. |

---

## 2. UserOperation Structure Comparison

### Ethereum ERC-4337 UserOperation

```solidity
struct UserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    uint256 callGasLimit;
    uint256 verificationGasLimit;
    uint256 preVerificationGas;
    uint256 maxFeePerGas;
    uint256 maxPriorityFeePerGas;
    bytes paymasterAndData;
}
```

### Neo N3 UserOperation

```csharp
public class UserOperation
{
    public UInt160 TargetContract;  // ~ callData.to
    public string Method;           // ~ callData.selector (full method name)
    public object[] Args;           // ~ callData
    public BigInteger Nonce;         // ~ nonce
    public BigInteger Deadline;        // ~ paymaster.sponsorshipPolicy (time-based expiry)
    public ByteString Signature;       // ~ signature
}
```

**Key Differences:**
- Neo uses `TargetContract + Method + Args` instead of encoded `callData`
- Neo combines gas fields into network/system fee calculated at submission
- Neo uses `Deadline` (absolute timestamp) instead of gas price caps
- Neo excludes `initCode` (no per-account deployment needed)

---

## 3. Validation Flow Comparison

### Ethereum ERC-4337

```mermaid
flowchart TD
    Bundler[Bundler] --> EntryPoint[EntryPoint]
    EntryPoint --> Validate[_validateUserOp]
    Validate --> ValidateSig[validateUserOpLogic]
    ValidateSig --> Validator[Aggregator/Validator]
    Validator --> Paymaster[Paymaster]
    Paymaster --> Execute[_callUserOp]
    Execute --> Post[postOpPostExecutionChecks]
```

**Security Properties:**
- Validation and execution in separate calls
- Gas limits enforced per operation
- Paymaster can sponsor or decline
- Aggregators can batch multiple userOps

### Neo N3 Smart Account

```mermaid
flowchart TD
    Relay[Relay / Client] --> Core[SmartAccount]
    Core --> Execute[executeUserOp]
    Execute --> Auth{Verifier or BackupOwner?}
    Auth -- Yes --> Nonce[Consume Nonce]
    Nonce --> Pre[preExecute Hook]
    Pre --> Call[Contract.Call Target]
    Call --> Post[postExecute Hook]
    Post --> Return[Return Result]
    Auth -- No --> Reject[Reject]
```

**Security Properties:**
- Single atomic transaction (no pre-validation separate call)
- Verifier called with `CallFlags.ReadOnly` (no state changes)
- Hooks enforce policies around execution
- Per-verifier callback cap is available in the current private artifact via
  the platform extension; public activation remains pending
- Paymaster optional (on-chain SAPaymaster or off-chain Morpheus)

**Historical critical difference:** the published runtime represented by this
comparison did not enforce independent verifier gas limits. The current
private integrated artifact does so with `CallWithGasLimit`; this is not yet a
public-network activation claim.

---

## 4. Nonce Management Comparison

### Ethereum ERC-4337 2D Nonce

- **Sequential Mode:** `nonce = key << 64 + sequence`
  - Channel 0: 0, 1, 2, 3...
  - Channel 1: 0, 1, 2, 3...
- **Used for:** Standard DeFi transactions requiring ordering

### Neo N3 2D Nonce

- **Canonical NeoVM signed domain (`0 <= nonce < 2^255`):**
  ```csharp
  BigInteger channel = nonce >> 64;
  BigInteger sequence = nonce & 0xFFFFFFFFFFFFFFFF;
  ```
  - The low 64 bits are the per-channel sequence; the remaining 191 bits select the channel.
  - Every channel starts at sequence 0 and advances independently; replayed or gapped sequences are rejected.
  - NeoVM's signed Integer representation means the upper half of a mathematical uint256 is not a valid operation value.

**Mapping:**
- Neo bounded channel + sequence ≈ ERC-4337 sequential nonce lanes
- Neo keeps one canonical nonce path and does not expose a separate UUID/salt mode

The current custom source also bounds `getNonce` channel reads to `0 <= channel < 2^191`.
An older deployed foundation artifact may accept an upper-half channel for a read until it is
republished; those read-only values remain non-executable under the signed operation boundary.

---

## 5. Signature Verification Comparison

### Ethereum ECDSA Signatures

```solidity
// Standard secp256k1 verification
function validateUserOpSignature(UserOperation calldata op, bytes32 hash) external;
```

### Neo N3 Signature Options

| Signature Type | Curve | Use Case | Ethereum Equivalent |
| --- | --- | --- | --- |
| **Native N3** | secp256r1 (Neo native) | Cold wallet backup | N/A |
| **Web3Auth / EIP-712** | secp256k1 | EVM wallet compatibility | EIP-712 Typed Data |
| **WebAuthn / Passkey** | secp256r1 | Hardware biometrics | WebAuthn spec |
| **TEE** | secp256r1 | Trusted execution | BLS/TLS-notary |
| **SessionKey** | secp256r1 | Temporary delegation | Session Keys (EIP-5732) |
| **MultiSig** | Heterogeneous | Threshold approval | Multi-sig wallets |

**Key Advantage:** Neo supports heterogeneous signature schemes (mix EVM + Passkey + TEE) in a single account.

---

## 6. Hook/Policy Comparison

### Ethereum ERC-7579 Modular Smart Account

```solidity
interface IModule {
    function onInstall(bytes32 id) external;
    function onUninstall(bytes32 id) external;
}

interface IValidator {
    function validateUserOp(UserOperation calldata userOp, bytes32 userOpHash)
        external returns (uint256 validationData);
}

interface IExecutor {
    function execute(UserOperation calldata userOp) external;
}

interface IFallback {
    function handleFunctionCall(...) external;
}
```

### Neo N3 Plugins

```csharp
// Verifier (Validator equivalent)
interface IVerifier {
    bool validateSignature(UInt160 accountId, UserOperation op);
    ByteString getPayload(...);
}

// Hook (Policy module equivalent)
interface IHook {
    void preExecute(UInt160 accountId, object[] opParams);
    void postExecute(UInt160 accountId, object[] opParams, object result);
}
```

**Mapping:**
- `IVerifier.validateSignature` ≈ `IValidator.validateUserOp`
- `IHook.preExecute` ≈ Pre-execution validation hook
- `IHook.postExecute` ≈ Post-execution cleanup
- `MultiHook` ≈ ERC-7579 Aggregator

---

## 7. Paymaster/Sponsorship Comparison

### Ethereum ERC-4337 Paymaster

```solidity
interface IPaymaster {
    function validatePaymasterUserOp(UserOperation calldata userOp, bytes32 userOpHash,
        uint256 maxCost) external returns (bytes memory context, uint256 validationData);
}
```

- Validates gas sponsorship
- Returns context for EntryPoint
- Can decline sponsorship

### Neo N3 Paymaster (On-Chain)

```csharp
// AAPaymaster contract
public class SponsorshipPolicy {
    public UInt160 TargetContract;  // Zero = any contract
    public string Method;            // empty = any method
    public BigInteger MaxPerOp;      // Max GAS per operation
    public BigInteger DailyBudget;   // Max GAS per day (0 = unlimited)
    public BigInteger TotalBudget;   // Max total GAS (0 = unlimited)
    public BigInteger ValidUntil;    // Expiry timestamp (0 = no expiry)
}

// Core integration
object result = executeSponsoredUserOp(accountId, op, paymaster, sponsor, reimbursementAmount);
// 1. Optional relay preflight via Paymaster.validatePaymasterOp()
// 2. executeUserOp() — full verification + execution
// 3. Paymaster.settleReimbursement() — atomic policy enforcement + GAS to relay
```

- Sponsors deposit GAS into the Paymaster via NEP-17 transfer
- Per-account or global (`accountId = Zero`) sponsorship policies
- Atomic settlement: policy validation + deposit deduction + relay reimbursement
- Daily/total budget tracking with automatic 24-hour window reset
- `validatePaymasterOp` available as `[Safe]` read-only for relay preflight

### Neo N3 Paymaster (Off-Chain — Morpheus)

- **Off-chain service** (Morpheus Paymaster)
- **Authorization endpoint:** `/api/paymaster/authorize`
- **Response:** `{ approved: boolean, reason?: string }`

**Key Differences vs Ethereum:**
- Neo supports both on-chain (SAPaymaster) and off-chain (Morpheus) paymaster models
- On-chain model is closer to ERC-4337: deposit + policy + settlement, but without per-op gas metering (Neo transactions have fixed fees)
- Off-chain model is simpler to integrate but less verifiable on-chain
- Both models: paymaster never authorizes execution — only the verifier or backup owner can

---

## 8. Recovery/Emergency Access Comparison

### Ethereum Recovery Patterns

1. **Social Recovery:** Multi-sig with guardians
2. **Time-lock:** Delayed admin changes
3. **Oracle Recovery:** On-chain oracle approves lost key
4. **EIP-4337 EntryPoint:** No native recovery (wallet-specific)

### Neo N3 L1 Escape Hatch

```mermaid
stateDiagram-v2
    [*] --> Configured: BackupOwner set
    Configured --> EscapeInitiated: initiateEscape(accountId) called
    EscapeInitiated --> [*]: Normal op cancels escape
    EscapeInitiated --> EscapeFinalized: Timelock expires + finalizeEscape(accountId, newVerifier)
    EscapeFinalized --> [*]: Verifier reset to BackupOwner
```

The two deployed entrypoints take the account id, and `finalizeEscape` also takes the verifier the
account falls back to (`contracts/build/SmartAccount.manifest.json`; implemented in
`contracts/custom/SmartAccount.Escape.cs`, where the C# methods are spelled with a leading capital —
that form names no exported method, which is why it is not code-formatted here).

**Features:**
- **Timelock:** Configurable 7-90 days
- **Cancel-on-use:** Any normal operation cancels in-progress escape
- **No oracle dependency:** Pure on-chain state machine
- **No per-account deployment:** Works with virtual accounts

**Comparison:** More robust than typical Ethereum AA recovery (which often depends on wallet-specific off-chain mechanisms or complex social recovery smart contracts).

---

## 9. Security Properties Comparison

| Security Property | Ethereum AA | Neo N3 SA | Notes |
| --- | --- | --- | --- |
| **Replay Protection** | ✓ Nonce | ✓ Nonce + Deadline | Both use 2D nonce + expiry |
| **Reentrancy Protection** | ✓ NonReentrant modifier | ✓ ExecutionLock | Both use locks |
| **Cross-chain Replay** | ✓ ChainID in typed data | ✓ `Runtime.GetNetwork()` in payload | Both include network ID |
| **Signature Theft** | ✓ Validator isolation | ✓ Verifier isolation | Both isolate validation |
| **DoS via Gas** | ✓ Gas limits on validation | ✗ **NO GAS LIMITS** | **Neo vulnerability** |
| **Rogue Paymaster** | ✓ Validation returns failure | ✓ Off-chain auth fails | Both can reject |
| **Account Discovery** | ✗ Not specified | ✓ Reverse indices | Neo advantage |
| **Batch Operations** | ✓ UserOp[] | ✓ UserOperation[] | Both support batches |
| **Verification Context** | ✓ Sender, paymaster | ✓ accountId, contract | Similar surface |

---

## 10. Migration Guide for Ethereum AA Developers

### From Ethereum EntryPoint to Neo SmartAccount

| Concept | How to Adapt |
| --- | --- |
| **Deploying new account** | Use `registerAccount()` instead of deploying a proxy. Account address is deterministic. |
| **Sending UserOperation** | Call `executeUserOp(accountId, op)` instead of `handleUserOps()`. |
| **Paymaster integration** | Use `SAPaymaster` contract (on-chain deposit/policy/settlement) or off-chain Morpheus endpoint. Call `executeSponsoredUserOp()` for on-chain, or implement off-chain auth for Morpheus. |
| **Aggregator pattern** | Use `MultiHook` to combine policy modules. |
| **Bundler integration** | Implement relay server that calls `simulateMetaInvocation()` then `relayMetaInvocation()`. |
| **Signature schemes** | Use `Web3AuthVerifier` for EVM sigs, `WebAuthnVerifier` for passkeys. |
| **Recovery** | Use `initiateEscape()` / `finalizeEscape()` for L1 backup. |

### Code Pattern: Ethereum AA → Neo SA

**Ethereum:**
```solidity
UserOp[] calldata ops;
entryPoint.handleOps(ops, beneficiary);
```

**Neo:**
```csharp
UserOperation[] ops;
object[] results = executeUserOps(accountId, ops);
// Or via SDK/relay:
relayMetaInvocation({ scriptHash: aaContract, operation: "executeUserOps", args: [accountId, ops] });
```

---

## 11. Known Limitations vs Ethereum AA

1. **Verifier Gas Budget:** Public activation of the matching platform
   bounded-call extension remains pending. The current private artifact uses
   `CallWithGasLimit`; see `docs/reports/sa-platform-gas-cap-20260921.json`.
2. **Simpler Fee Model:** No per-op gas estimation hooks (Neo has fixed transaction fees).
3. **No Staking Mechanism:** On-chain Paymaster uses direct GAS deposits, not staking.
4. **Limited Aggregation:** `MultiHook` doesn't aggregate signatures like Ethereum aggregators.

---

## 11a. Standards Alignment Surface (2026-11-16)

The custom source candidate narrows the practical interop gap with the
Ethereum AA tooling surface. All of it stays behind the unchanged
upgrade-required boundary until the governed upgrade lands:

- **ERC-4337 `simulateValidation` = `simulateValidation(accountId, op)`:**
  the candidate carries the EntryPoint name itself. A non-faulting preflight
  of the core's execution-time checks. Unknown
  accounts report an all-false result instead of faulting; the escrow latch
  and the native backup-owner witness are reported explicitly. Signature
  verification and hook execution stay excluded, exactly like
  `previewUserOpValidation`.
- **ERC-7579 capability discovery ≈ `describeAccount(accountId)`:** one safe
  read returning the full descriptor — verifier, hook, backup owner, escape
  state, market-escrow latch and both pending-update maturity windows — so
  wallets and indexers stop fanning out across per-field getters.
- **ERC-7715 session permissions ≈ `buildSessionKeyPermission`:** the SDK
  emits a 7715-shaped grant (signer + contract-call permission + unix-second
  expiry) next to the canonical on-chain artifacts; the registration-time
  version-0x01 blob installs the first session key immediately
  (`SessionKeyVerifier.setPublicKey`), closing the day-one usability gap
  without weakening the 24h rotation cooldown for later changes.
- **4337 tooling shape ≈ `toErc4337UserOperation`:** sender = account id,
  `callData` = the Neo VM invocation script, gas fields zeroed (Neo prices
  execution in the VM), deadline carried as an extension field.

Deliberately not adopted: EIP-7702 EOA delegation (Neo has no EOAs in the
Ethereum sense — the virtual-account proxy already covers the goal), mempool
rules / ERC-7562 (Neo has no alt-mempool to police), initCode (accounts are
zero-deployment), and BLS aggregate signatures (no native pairing precompile
on the custom surface).

---

## 12. Neo N3 Advantages vs Ethereum AA

1. **Zero-Deployment Virtual Accounts:** No gas cost for account creation.
2. **Heterogeneous Signature Support:** Mix EVM, Passkey, TEE in one account.
3. **L1 Native Escape:** Robust recovery without complex social recovery.
4. **Account Discovery:** Reverse indices for O(1) account lookup.
5. **Unified Execution Context:** Single contract for all accounts simplifies indexing.
6. **TEE-First Design:** Built for trusted execution environments.
7. **Dual Paymaster Model:** Both on-chain trustless (`SAPaymaster`) and off-chain flexible (Morpheus) sponsorship.
