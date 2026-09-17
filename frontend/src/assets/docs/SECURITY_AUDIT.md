# Neo Abstract Account Security Audit

## Historical Audit (March 11, 2026)

_Date:_ March 11, 2026

## Summary

This document records a focused static security audit of an earlier Neo Abstract Account contract generation together with the fixes applied during remediation. The current production runtime is `UnifiedSmartWalletV3`; this audit is retained as historical security context rather than as the sole description of the current system.

The audit concentrated on the following areas:

- Core account abstraction contract authorization and execution paths
- Meta-transaction verification, replay protection, and signer handling
- Deterministic account-address binding and identity mapping
- Admin mutation flows and privileged self-call boundaries
- Dome/oracle-based inactivity recovery logic
- Custom verifier integration contract interfaces
- Recovery verifier contract initialization and verification semantics

This was a source-level audit and regression-hardening exercise. It was not a formal proof, bytecode-level model check, or external third-party audit.

## Scope

### Core Contract

- predecessor account-abstraction runtime modules that predate `UnifiedSmartWalletV3`

### Recovery Verifiers

- `contracts/recovery/ArgentRecoveryVerifier.Fixed.cs`
- `contracts/recovery/SafeRecoveryVerifier.Fixed.cs`
- `contracts/recovery/LoopringRecoveryVerifier.Fixed.cs`

### Regression Coverage Added

- `sdk/js/tests/securityAudit.unit.test.js`

## Methodology

The review used the following process:

1. Manual inspection of authentication, authorization, replay, upgrade, oracle, and recovery logic.
2. Consistency checks between contract call sites and verifier manifests.
3. Source-level regression tests for each identified issue.
4. Contract rebuilds and artifact regeneration after remediation.
5. Re-running targeted regression tests to confirm fixes.

## Findings and Remediation

### 1. Recovery verifier initialization lacked owner authorization

**Severity:** High

**Affected files:**
- `contracts/recovery/ArgentRecoveryVerifier.Fixed.cs`
- `contracts/recovery/SafeRecoveryVerifier.Fixed.cs`
- `contracts/recovery/LoopringRecoveryVerifier.Fixed.cs`

**Issue:**
The `SetupRecovery(...)` entrypoints allowed verifier state to be initialized without requiring the claimed owner to authenticate the setup operation.

**Risk:**
If a verifier contract were installed for an account, arbitrary parties could initialize or overwrite recovery state and alter ownership or guardian policy assumptions.

**Fix applied:**
- `SetupRecovery(...)` now requires `Runtime.CheckWitness(owner)`.
- `SetupRecovery(...)` now rejects blind reinitialization if recovery state already exists.

**Representative locations:**
- `contracts/recovery/ArgentRecoveryVerifier.Fixed.cs`
- `contracts/recovery/SafeRecoveryVerifier.Fixed.cs`
- `contracts/recovery/LoopringRecoveryVerifier.Fixed.cs`

### 2. Recovery verifier interface did not match wallet expectations

**Severity:** High

**Affected files:**
- `contracts/recovery/ArgentRecoveryVerifier.Fixed.cs`
- `contracts/recovery/SafeRecoveryVerifier.Fixed.cs`
- `contracts/recovery/LoopringRecoveryVerifier.Fixed.cs`
- `contracts/recovery/compiled/*.manifest.json`

**Issue:**
The wallet calls custom verifiers using:
- `verify(accountId)`
- `verifyMetaTx(accountId, signerHashes)`

The recovery verifiers previously exposed only `Verify(UInt160 accountId)` and did not expose `VerifyMetaTx(...)`. This was incompatible with the wallet's `ByteString accountId` model and broke custom-verifier interoperability for meta-transactions.

**Risk:**
Custom verifier installation could fail at runtime or make meta-transaction authorization unusable.

**Fix applied:**
- Verifier boundary methods now accept `ByteString accountId`.
- Added `VerifyMetaTx(ByteString accountId, UInt160[] signerHashes)` to all three recovery verifiers.
- Regenerated recovery manifests and compiled artifacts.

### 3. Meta-transaction custom-verifier handoff allowed duplicate signers

**Severity:** Low

**Affected file:**
- predecessor meta-transaction module from the pre-V3 runtime

**Issue:**
Recovered EVM signers were handed to custom verifiers without deduplication.

**Risk:**
The built-in mixed-signature quorum check was safe, but a naive custom verifier could incorrectly count repeated signers as distinct approvals.

**Fix applied:**
- Added deduplication before the signer array is passed into policy evaluation and meta-tx context storage.

### 4. Dome recovery implicitly unlocked when no oracle URL was configured

**Severity:** Medium

**Affected file:**
- predecessor oracle/recovery module from the pre-V3 runtime

**Issue:**
The dome unlock helper treated a missing oracle URL as implicitly unlocked.

**Risk:**
Operators could believe dome recovery was oracle-gated while actually enabling timeout-only recovery if the oracle URL was absent.

**Fix applied:**
- `IsDomeOracleUnlocked(...)` now returns `false` when no oracle URL is configured.

### 5. Account creator was silently appended to explicit admin sets

**Severity:** Medium

**Affected file:**
- predecessor storage/context module from the pre-V3 runtime

**Issue:**
Account creation silently appended `tx.Sender` to the admin set even when administrators were explicitly provided.

**Risk:**
In sponsored or delegated creation flows, the creator could gain persistent administrative authority unintentionally.

**Fix applied:**
- The sender is only auto-added when no admin set is supplied.
- Explicit admin lists are now respected as authoritative input.

### 6. Proxy verification scope was broader than necessary

**Severity:** Informational / Defense-in-depth

**Affected file:**
- predecessor storage/context module from the pre-V3 runtime

**Issue:**
Proxy-witness verification previously accepted any hardened single-self-call script shape, not only the intended AA execution wrappers.

**Risk:**
While most sensitive methods still performed their own authorization checks, the broader acceptance rule increased future confused-deputy risk if new methods were added without equivalent guarding.

**Fix applied:**
- Added an explicit proxy verification allowlist via `AllowedProxyVerificationMethods`.
- Verification now requires both the hardened script shape and an allowed wrapper-method suffix.

## Files Changed During Remediation

### Core Wallet

- predecessor account-abstraction runtime modules later superseded by `UnifiedSmartWalletV3`

### Recovery Verifiers

- `contracts/recovery/ArgentRecoveryVerifier.Fixed.cs`
- `contracts/recovery/SafeRecoveryVerifier.Fixed.cs`
- `contracts/recovery/LoopringRecoveryVerifier.Fixed.cs`
- `contracts/recovery/compiled/ArgentRecoveryVerifier.*`
- `contracts/recovery/compiled/SafeRecoveryVerifier.*`
- `contracts/recovery/compiled/LoopringRecoveryVerifier.*`

### Tests and Planning Record

- `sdk/js/tests/securityAudit.unit.test.js`
- the current V3 contract/runtime hardening path documented in the main repo docs

## Verification Evidence

The following commands were used to verify the remediated state:

```bash
dotnet build neo-abstract-account.sln -c Release --nologo
cd contracts/recovery && dotnet build ArgentRecoveryVerifier.csproj -nologo
cd contracts/recovery && dotnet build SafeRecoveryVerifier.csproj -nologo
cd contracts/recovery && dotnet build LoopringRecoveryVerifier.csproj -nologo
cd contracts/recovery && bash ./compile_recovery_contracts.sh
cd sdk/js && node --test tests/securityAudit.unit.test.js tests/contractArtifacts.unit.test.js tests/recoveryReadiness.unit.test.js
```

### Verified Results

- Core contract build succeeded.
- Recovery verifier project builds succeeded.
- Recovery verifier artifacts were regenerated successfully.
- Targeted regression suite passed:
  - `25` tests passed
  - `0` tests failed

## Residual Notes

- The core contract build completed without warnings after final remediation.
- Recovery verifier builds still emit nullable/static-analysis warnings in some helper/event declarations. These did not block compilation and were not part of the identified exploitability findings addressed in this remediation pass.
- This audit does not replace an external independent review, integration testing on live networks, or runtime economic stress testing.

## Current Security Posture (Historical)

After the fixes described here, all identified issues from this audit pass were remediated for that contract generation. For the current V3 runtime, this document should be read alongside the active architecture, plugin-matrix, and relay-validation docs. The remaining recommended next steps are:

- external third-party review,
- broader property-based / adversarial test coverage,
- end-to-end testnet execution for the updated recovery-verifier interface,
- and optional cleanup of remaining nullable warnings in recovery contracts.

---

## Current V3 Runtime Audit (March 28, 2026)

**Date:** March 28, 2026

### Scope

This audit covers the current production V3 runtime (`UnifiedSmartWallet`) and all plugin contracts (verifiers and hooks), plus relay server API endpoints.

**Components Audited:**
- Core contract: `UnifiedSmartWallet` (Execution, Accounts, State, Escape, MarketEscrow, Internal, VerifyContext)
- Verifier plugins: Web3AuthVerifier, TEEVerifier, WebAuthnVerifier, SessionKeyVerifier, MultiSigVerifier, SubscriptionVerifier, ZkLoginVerifier
- Hook plugins: WhitelistHook, DailyLimitHook, TokenRestrictedHook, MultiHook, NeoDIDCredentialHook
- Market contract: AAAddressMarket
- API endpoints: relay-transaction.js, rateLimiter.js

### Methodology

The review used the following process:

1. Manual inspection of all contract and API code for security vulnerabilities
2. Comparison against ERC-4337/ERC-7579 best practices
3. Threat modeling for each layer (blockchain, core, plugins, off-chain)
4. Analysis of cryptographic implementations and replay protection mechanisms
5. Review of authorization, reentrancy, and gas DoS vectors

---

## Critical Findings

### 1. CRITICAL: No Verifier Gas Limit - DoS Vector

**Severity:** Critical

**Affected File:** `contracts/UnifiedSmartWallet.Execution.cs:42`

**Issue:**
The core contract calls `validateSignature` on verifiers without any gas limit:

```csharp
bool isValid = (bool)Contract.Call(state.Verifier, "validateSignature", CallFlags.ReadOnly, new object[] { accountId, op });
```

A malicious or buggy verifier plugin could consume excessive gas, causing legitimate user operations to fail due to gas exhaustion. This is a well-known DoS vector in ERC-4337 implementations.

**Risk:**
An attacker could deploy a malicious verifier that consumes gas during validation (e.g., infinite loops, expensive hash operations). When installed on an account, the account becomes unusable. While the backup owner escape hatch is available, it requires a 7-90 day timelock.

**Mitigation Required:**
1. Add a dynamic gas limit for verifier calls based on a reasonable maximum (e.g., 50,000 gas)
2. Use `CallFlags.States` or implement a gas metering wrapper
3. Consider a verifier blacklist/registry for known malicious verifiers

**Ethereum Comparison:**
ERC-4337 validators have explicit gas limits enforced by the EntryPoint contract to prevent DoS. The V3 implementation lacks this critical protection.

---

## High Findings

### 2. HIGH: Session Key Revocation Race Condition

**Severity:** High

**Affected File:** `contracts/verifiers/SessionKeyVerifier.cs:71-76, 104-123`

**Issue:**
When `ClearSessionKey()` is called, the key is immediately deleted from storage:

```csharp
public static void ClearSessionKey(UInt160 accountId)
{
    VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
    byte[] key = Helper.Concat(Prefix_SessionKeys, (byte[])accountId);
    Storage.Delete(Storage.CurrentContext, key);  // Immediate deletion
}
```

A race condition exists where a session key could be validated between clearing and finalization, especially in high-throughput scenarios or when multiple transactions are in the mempool.

**Risk:**
A malicious session holder could continue using the key briefly after revocation initiation. If a transaction validating that session key is already in the mempool when `ClearSessionKey()` is called, it will execute successfully after key deletion.

**Mitigation Required:**
1. Add a `RevokedAt` timestamp to `SessionKeyData` struct
2. Reject signatures with `RevokedAt > 0` in `ValidateSignature`
3. Clear storage only after a timelock expiry period

**Ethereum Comparison:**
ERC-4337 implementations often use nonce-based invalidation or delay windows for key revocation to prevent this race condition.

---

### 3. HIGH: Escape Hatch Can Be Bypassed via Market Escrow

**Severity:** High

**Affected Files:** `contracts/UnifiedSmartWallet.Escape.cs:21`, `contracts/UnifiedSmartWallet.MarketEscrow.cs:47-77`

**Issue:**
The escape hatch checks for market escrow:

```csharp
public static void InitiateEscape(UInt160 accountId)
{
    AssertNoMarketEscrow(accountId);  // Line 21
    // ...
}
```

However, `SettleMarketEscrow()` clears `EscapeTriggeredAt` atomically:

```csharp
public static void SettleMarketEscrow(UInt160 accountId, BigInteger listingId, UInt160 newBackupOwner)
{
    // ...
    state.EscapeTriggeredAt = 0;  // Line 58 - Clears escape without timelock!
    // ...
}
```

An attacker who initiates escape, then immediately enters market escrow and settles, can transfer the account without waiting the escape timelock. The new buyer receives a clean account with no trace of the escape attempt.

**Risk:**
Complete bypass of 7-90 day escape timelock security guarantee. A stolen backup owner could transfer the account immediately after initiating escape by using the market escrow path.

**Mitigation Required:**
1. Add `EscapeTriggeredAt > 0` check in `EnterMarketEscrow` - reject if escape is active
2. Or block `SettleMarketEscrow` if `EscapeTriggeredAt > 0`

**Ethereum Comparison:**
Not directly applicable as Ethereum doesn't have a similar native escrow, but ERC-4337 prevents config changes during validation windows.

---

## Medium Findings

### 4. MEDIUM: MultiSig Threshold Edge Case - Empty Child List

**Severity:** Medium

**Affected File:** `contracts/verifiers/MultiSigVerifier.cs:44-61`

**Issue:**
While the code validates `threshold > 0 && threshold <= verifiers.Length`, it doesn't explicitly reject an empty verifier array:

```csharp
ExecutionEngine.Assert(threshold > 0 && threshold <= verifiers.Length, "Invalid threshold");
```

If `verifiers.Length == 0` and `threshold == 1`, this would fail. But there's no explicit check preventing empty arrays entirely.

**Risk:**
Configuration errors could lead to permanently locked accounts if an empty verifier array is set with a positive threshold.

**Mitigation Required:**
Add explicit assertion: `ExecutionEngine.Assert(verifiers.Length > 0, "At least one verifier required")`

---

### 5. MEDIUM: Market Escrow State Cleanup Partiality

**Severity:** Medium

**Affected File:** `contracts/UnifiedSmartWallet.MarketEscrow.cs:47-77`

**Issue:**
The settlement clears core state but doesn't verify all plugin state is wiped:

```csharp
state.Verifier = UInt160.Zero;
state.HookId = UInt160.Zero;
state.EscapeTriggeredAt = 0;
```

It deletes pending updates, but doesn't verify the verifier/hook's own storage (`ClearAccount` is called for removed modules). If a verifier has a bug in `ClearAccount`, orphaned storage could remain.

**Risk:**
Storage bloat and potential data leakage to buyer of a market-listed account. The new account owner might inherit stale state from a previous verifier/hook configuration.

**Mitigation Required:**
1. Wrap verifier/hook deletion in try-finally blocks
2. Add storage migration/cleanup verification
3. Consider emitting events for forensic tracking

**Ethereum Comparison:**
ERC-4337 doesn't have an equivalent market escrow mechanism, but module upgrades typically require explicit cleanup verification.

---

### 6. MEDIUM: VerifierPayload Encoding Ambiguity

**Severity:** Medium

**Affected File:** `contracts/verifiers/VerifierPayload.cs:11-31`

**Issue:**
The payload construction uses simple concatenation:

```csharp
return Helper.Concat(
    // ... nested Concat calls ...
    argsSerialized  // No length prefix!
);
```

The args are serialized without length prefix. If two different argument arrays serialize to the same byte string (theoretically possible with certain data types), collisions could occur.

**Risk:**
Theoretical signature replay across different operations with colliding serializations. While unlikely in practice, it violates cryptographic best practices for unambiguous encoding.

**Mitigation Required:**
1. Use length-prefixed serialization for variable-length fields
2. Add type tags for each field
3. Consider using a proper structured hash (RLP-like)

**Ethereum Comparison:**
ERC-4337 uses EIP-712 typed data encoding which prevents collision issues by including type information in the hash.

---

## Low Findings

### 7. LOW: Nonce Salt Collision Probability

**Severity:** Low

**Affected File:** `contracts/UnifiedSmartWallet.Execution.cs:175-184`

**Issue:**
Salt-mode nonces use a threshold of `1_000_000_000_000_000`:

```csharp
BigInteger MAX_2D_NONCE = 1_000_000_000_000_000;
```

This creates ~1 quadrillion possible values. The probability of collision is negligible in practice (birthday problem with 1M operations = ~1 in 2 trillion), but not mathematically impossible.

**Risk:**
Extremely unlikely replay collision due to nonce reuse. The practical impact is negligible.

**Mitigation Recommended:**
Consider increasing to `2^64` (~18 quintillion) for cryptographic safety margin.

**Ethereum Comparison:**
ERC-4337 typically uses full 256-bit nonce space for random/salt modes.

---

### 8. LOW: Rate Limiter Bypass via IP Rotation

**Severity:** Low

**Affected File:** `frontend/api/rateLimiter.js:4-90`

**Issue:**
The current rate limiter resolves client identity from the socket address by default. Proxy headers are only used when proxy trust is enabled and a single trusted header name is configured.

Sophisticated attackers can still rotate IPs to bypass limits. Redis backend helps but IP-based limiting is inherently bypassable.

**Risk:**
Attackers with access to botnet or IP rotation services can exceed rate limits. This is a limitation of IP-based rate limiting, not a vulnerability per se.

**Mitigation Recommended:**
1. Add rate limiting per account ID in addition to IP
2. Implement proof-of-work for high-frequency requests
3. Consider requiring authentication for relay operations

**Ethereum Comparison:**
Ethereum bundlers typically use per-account or per-sender rate limiting rather than IP-based limits.

---

### 9. LOW: Error Information Leakage

**Severity:** Low

**Affected Files:** `frontend/api/relay-transaction.js:492-507`, `frontend/api/rateLimiter.js:92-112`

**Issue:**
The `sanitizeError()` function provides some protection, but raw errors can leak when `AA_RELAY_INCLUDE_RAW_ERRORS` is enabled:

```javascript
if (shouldIncludeRawRelayErrors()) {
    payload.rawMessage = rawMessage;
    payload.stack = typeof error?.stack === 'string' ? error.stack : undefined;
}
```

Stack traces could reveal internal structure and potential attack surface to attackers.

**Risk:**
Information leakage about internal implementation details when feature is enabled. Default configuration uses sanitized errors, so risk is low.

**Mitigation Recommended:**
1. Default to `false` for raw errors
2. Rate-limit raw error output
3. Never include raw errors in production

**Ethereum Comparison:**
ERC-4337 bundlers typically provide minimal error information to prevent information leakage.

---

## Positive Security Findings

### 1. STRONG: Cross-Chain Replay Protection

All verifiers properly include `Runtime.GetNetwork()` in their payload hashing:
- `VerifierPayload.BuildPayload()` line 20: `ToUint256Word((BigInteger)Runtime.GetNetwork())`
- `Web3AuthVerifier.BuildDomainSeparator()` line 158: `ToUint256Word((BigInteger)network)`
- `ZkLoginVerifier.BuildPayload()` line 324: `ToUint256Word((BigInteger)Runtime.GetNetwork())`

This ensures signatures cannot be replayed across different Neo networks.

### 2. STRONG: Reentrancy Protection

The execution lock mechanism prevents reentrancy:
- `UnifiedSmartWallet.Execution.cs:25-108`: Uses `IsAnyExecutionActive()` and `SetExecutionLock()`
- Proper try-finally cleanup ensures lock release

### 3. STRONG: Hook Authority Validation

Hooks properly validate caller chain through `HookAuthority.ValidateExecutionCaller()` and `CanExecuteHook()`.

### 4. STRONG: Market Escrow Isolation

Market escrow properly blocks normal execution via `AssertNoMarketEscrow()`.

### 5. STRONG: Duplicate Verifier Prevention

`MultiSigVerifier` explicitly checks for and rejects duplicate verifiers to prevent threshold bypass.

---

## Summary of Findings

| Severity | Count | Status |
| --- | --- | --- |
| Critical | 1 | **Open** |
| High | 2 | **Open** |
| Medium | 3 | **Open** |
| Low | 3 | **Open** |
| Positive | 5 | ✓ Verified |

**Open Issues Requiring Fix:**
1. VULN-001 (Critical): Verifier gas limit - DoS vector
2. VULN-002 (High): Session key revocation race condition
3. VULN-003 (High): Escape hatch bypass via market escrow
4. VULN-004 (Medium): MultiSig empty child list edge case
5. VULN-005 (Medium): Market escrow state cleanup partiality
6. VULN-006 (Medium): VerifierPayload encoding ambiguity
7. VULN-007 (Low): Nonce salt collision probability
8. VULN-008 (Low): Rate limiter bypass via IP rotation
9. VULN-009 (Low): Error information leakage

---

## Recommended Next Steps

1. **Address Critical Findings:** Implement verifier gas limits and escape escrow protection before mainnet deployment
2. **Plugin Developer Education:** Ensure all new plugin developers review `PLUGIN_DEVELOPER_GUIDE.md`
3. **Security Testing:** Conduct adversarial testing on all attack vectors
4. **Third-Party Audit:** Engage an independent security firm for formal verification
5. **Continuous Monitoring:** Set up monitoring for gas anomalies, failed operations, and unusual patterns

---

## References

- Full Security Model: `docs/SECURITY_MODEL.md`
- Plugin Developer Guide: `docs/PLUGIN_DEVELOPER_GUIDE.md`
- Ethereum Comparison: `docs/ETHEREUM_AA_COMPARISON.md`
- Plugin Matrix: `docs/PLUGIN_MATRIX.md`
