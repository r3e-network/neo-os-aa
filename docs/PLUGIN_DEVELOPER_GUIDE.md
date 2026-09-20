# Plugin Developer Security Guide

## Executive Summary

This guide is for developers building Verifier or Hook plugins for the Neo N3 Abstract Account ecosystem. It covers security best practices, common vulnerabilities, and required interfaces for plugin development.

**Target Audience:** Smart contract developers
**Prerequisites:** Familiarity with Neo N3, C#, and cryptographic primitives
**Security Status:** Following these guidelines is required for plugin inclusion in the verified ecosystem.

---

## 1. Plugin Architecture Overview

### 1.1 Two Plugin Types

| Type | Responsibility | Security Focus | Examples |
| --- | --- | --- | --- |
| **Verifier** | "Who is authorized?" | Web3Auth, TEE, WebAuthn, SessionKey |
| **Hook** | "What is allowed?" | Whitelist, DailyLimit, TokenRestricted |

### 1.2 Plugin Storage Is Account-Scoped

```csharp
// GOOD: Stateless plugin
public static ByteString GetPublicKey(UInt160 accountId)
{
    byte[] key = Helper.Concat(Prefix_PubKey, (byte[])accountId);
    return Storage.Get(Storage.CurrentContext, key) ?? (ByteString)"";
}

// BAD: Stateful plugin with admin keys
private static readonly byte[] Prefix_Admin = new byte[] { 0xFF };
public static void SetAdmin(UInt160 newAdmin)
{
    // Never allow admin keys in plugins!
}
```

**Rule:** Plugins may keep account-scoped policy state, but they must not have
independent admin keys or privileged upgradability. All configuration flows
through the AA core contract, and every storage key must be namespaced by the
account identifier.

---

## 2. Verifier Plugin Security

### 2.1 Required Interface

```csharp
public interface IVerifier
{
    // Capability marker; the AA core also checks the deployed manifest.
    bool SupportsV3();

    // Called by AA core during validation
    bool ValidateSignature(UInt160 accountId, UserOperation op);

    // Called after target execution; implement as a no-op when unused.
    void PostExecute(UInt160 accountId, UserOperation op, object result);

    // Mandatory lifecycle cleanup before a verifier is detached or an AA shell
    // is transferred. A fault must abort the enclosing transition.
    void ClearAccount(UInt160 accountId);

    // Optional: Get exact payload bytes for signing
    ByteString GetPayload(UInt160 accountId, UInt160 targetContract,
        string method, object[] args, BigInteger nonce, BigInteger deadline);
}
```

Binding is fail-closed at two layers. `supportsV3/0` must be a safe Boolean
method and return `true`, and the deployed manifest must expose the exact
verifier signatures `validateSignature(Hash160, Any) -> Boolean`,
`postExecute(Hash160, Any, Any) -> Void`, and
`clearAccount(Hash160) -> Void`. A marker-only, stale, or wrong-typed verifier
is rejected before its address is stored. Hooks are subject to the analogous
exact signatures `preExecute(Hash160, Array) -> Void`,
`postExecute(Hash160, Array, Any) -> Void`, and
`clearAccount(Hash160) -> Void`. Manifest presence proves only the callable surface; it does
not prove the method's cryptographic or storage semantics, so new modules still
require an audited implementation and concrete runtime/refinement evidence. `MultiSigVerifier`
and `MultiHook` apply the same manifest/deployment preflight to their configured child
modules; self-reference is rejected by `MultiSigVerifier`, while `MultiHook` also
maintains a bounded execution-depth guard. These checks are ABI/topology guards, not
proofs of arbitrary child-call graphs or cryptographic independence.

### 2.2 Security Checklist for Verifiers

| Check | Why | Implementation |
| --- | --- | --- |
| **Network ID in payload** | Prevent cross-chain replay | Include `Runtime.GetNetwork()` in hash |
| **Account ID in payload** | Prevent account confusion | Include `accountId` in hash |
| **Deadline in payload** | Prevent old signature use | Include `deadline` in hash |
| **No side effects** | Validation must be read-only | Use `CallFlags.ReadOnly` where applicable |
| **Bounded gas** | *(CRITICAL)* Prevent DoS | The current AA artifact has no non-bypassable per-call cap; do not claim voluntary metering closes it. Use the platform extension in `docs/proposals/AA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.md` once activated. |
| **Signature length check** | Prevent malformed input | Assert `signature.Length == expected` |
| **Return boolean only** | Validation pattern | Don't throw on normal rejections |
| **No state mutation** | Pure validation | Never write storage in `ValidateSignature` |

### 2.3 Common Vulnerabilities

#### VULN-001: Missing Network ID

**Severity:** Critical

```csharp
// VULNERABLE: Cross-chain replay possible
byte[] payload = Helper.Concat(accountId, targetContract, method, args, nonce, deadline);

// SECURE: Network ID prevents replay
byte[] payload = Helper.Concat(
    ToUint256Word((BigInteger)Runtime.GetNetwork()),  // <-- Required
    accountId, targetContract, method, args, nonce, deadline
);
```

#### VULN-002: Mutable State in Validation

**Severity:** High

```csharp
// VULNERABLE: State change during validation
public static bool ValidateSignature(UInt160 accountId, UserOperation op)
{
    Storage.Put(Storage.CurrentContext, "lastValidated", Runtime.Time); // BAD!
    return CryptoLib.Verify(...);
}

// SECURE: Pure validation
public static bool ValidateSignature(UInt160 accountId, UserOperation op)
{
    return CryptoLib.Verify(...);
}
```

#### VULN-003: Unbounded Gas Consumption

**Severity:** Critical

```csharp
// VULNERABLE: DoS vector
public static bool ValidateSignature(UInt160 accountId, UserOperation op)
{
    // Loop can consume arbitrary gas
    for (int i = 0; i < op.Args.Length; i++)
    {
        HeavyCryptoOperation(op.Args[i]);
    }
    return true;
}

// REDUCED INPUT RISK ONLY: Bound iterations and reject oversized inputs.
// This does not replace a platform-enforced child budget.
public static bool ValidateSignature(UInt160 accountId, UserOperation op)
{
    ExecutionEngine.Assert(op.Args.Length <= 100, "Too many args");
    for (int i = 0; i < op.Args.Length; i++)
    {
        HeavyCryptoOperation(op.Args[i]);
    }
    return true;
}
```

#### VULN-004: Signature Forgery via Length Extension

**Severity:** Critical

```csharp
// VULNERABLE: Accepts any signature length
public static bool ValidateSignature(UInt160 accountId, UserOperation op)
{
    ByteString sig = op.Signature;
    // Missing length check!
    return CryptoLib.Verify(payload, pubKey, sig);
}

// SECURE: Enforce exact length
public static bool ValidateSignature(UInt160 accountId, UserOperation op)
{
    ByteString sig = op.Signature;
    ExecutionEngine.Assert(sig.Length == 64, "Invalid signature length");
    return CryptoLib.Verify(payload, pubKey, sig);
}
```

---

## 3. Hook Plugin Security

### 3.1 Required Interface

```csharp
public interface IHook
{
    // Capability marker; the AA core also checks the deployed manifest.
    bool SupportsV3();

    // Called before execution (can reject)
    void PreExecute(UInt160 accountId, object[] opParams);

    // Called after execution (cleanup/logging)
    void PostExecute(UInt160 accountId, object[] opParams, object result);

    // Mandatory lifecycle cleanup before removal or shell transfer.
    void ClearAccount(UInt160 accountId);
}
```

The `opParams` ABI is canonical and identical in `PreExecute` and `PostExecute`:

```text
opParams = [TargetContract, Method, Args, Nonce, Deadline, Signature]
```

The account id is passed separately as the first callback argument. The core must not pass the
opaque `UserOperation` object in the `opParams` position: shipped hooks inspect
`opParams[0]`/`[1]`/`[2]` as the target, method, and argument array. Hook implementations must treat
the tuple as the signed operation and must not mutate or reconstruct authorization from any
independent caller-controlled value. The core's runtime suite verifies both the positive target
path and rejection of an unlisted target through the real NeoVM callback path.

`ClearAccount(accountId)` is a mandatory lifecycle method for both verifier and
hook plugins. It must delete every account-scoped key owned by the plugin and
must fault on an internal cleanup failure. It must also be idempotent for an
account the plugin never configured, because the core calls it on every
rotation regardless. A plugin that omits the method is not merely unclean: the
core's call into the missing method faults uncatchably, so every account bound
to that plugin is locked to it (no verifier rotation, no escape finalization, no
market sale). Plugins that custody user funds per account (for example the
recovery verifier's oracle credit) must return them to the account owner in
`ClearAccount` rather than orphan them.

**Transfer source is the proxy address, never the account id.** A virtual AA
account holds its assets at the core-derived proxy script hash
(`getProxyScriptHash(accountId)`), and that address is the only `from` a token's
`CheckWitness` accepts during `executeUserOp`. Any verifier or hook that pins,
meters or allowlists a transfer source must compare against that address
(`Contract.Call(core, "getProxyScriptHash", CallFlags.ReadOnly, accountId)`) and
must declare `ContractPermission("*", "getProxyScriptHash")`. Comparing against
the `accountId` authorizes a transfer that can never move funds and meters a
balance that is always zero. The AA core treats a cleanup fault
as a failed enclosing transition; it must not swallow the fault and hand a
buyer or replacement module a potentially dirty account shell. This is
fail-closed for known plugins, not a proof that an arbitrary future contract
has no unrelated storage.

### 3.2 Security Checklist for Hooks

| Check | Why | Implementation |
| --- | --- | --- |
| **Authority validation** | Prevent unauthorized configuration | Call `CanConfigureHook` before writes |
| **Context validation** | Ensure AA core is caller | Call `CanExecuteHook` before execution |
| **Revert on reject** | Atomic rejection pattern | Throw `ExecutionEngine.Assert` |
| **No external calls in Pre** | Prevent reentrancy | Only inspect parameters |
| **Careful Post logic** | No validation in post | Only cleanup/logging |
| **State consistency** | Idempotent operations | Handle re-entrancy/timeout |
| **ClearAccount** | Cleanup on removal | Delete all storage for account |

### 3.3 Common Vulnerabilities

#### VULN-005: Reentrancy in PreExecute

**Severity:** High

```csharp
// VULNERABLE: Can call back into AA
public static void PreExecute(UInt160 accountId, object[] opParams)
{
    // Check limit in storage
    BigInteger spent = GetSpent(accountId);
    if (spent + amount > limit) return;

    // Call external contract (DANGEROUS!)
    Contract.Call(opParams[0], "doSomething", CallFlags.All, ...);

    // Attacker re-enters with same operation!
}

// SECURE: No external calls in PreExecute
public static void PreExecute(UInt160 accountId, object[] opParams)
{
    BigInteger spent = GetSpent(accountId);
    if (spent + amount > limit)
    {
        ExecutionEngine.Assert(false, "Limit exceeded");
    }
    // Store for PostExecute to consume
    Storage.Put(..., spent + amount);
}

public static void PostExecute(UInt160 accountId, object[] opParams, object result)
{
    if (!DidExecutionSucceed(result)) return;

    BigInteger pending = GetPending(accountId);
    Storage.Put(..., 0); // Consume
}
```

#### VULN-006: Double-Spend in PostExecute

**Severity:** High

```csharp
// VULNERABLE: Not checking if already consumed
public static void PostExecute(UInt160 accountId, object[] opParams, object result)
{
    // Attacker calls PostExecute twice!
    BigInteger current = GetSpent(accountId);
    Storage.Put(..., current + amount);
}

// SECURE: Use idempotent operations
public static void PostExecute(UInt160 accountId, object[] opParams, object result)
{
    if (!DidExecutionSucceed(result)) return;

    byte[] pendingKey = GetPendingKey(accountId);
    ByteString? pending = Storage.Get(Storage.CurrentContext, pendingKey);

    ExecutionEngine.Assert(pending != null, "Already consumed");

    BigInteger amount = (BigInteger)pending;
    Storage.Delete(Storage.CurrentContext, pendingKey);

    BigInteger current = GetSpent(accountId);
    Storage.Put(..., current + amount);
}
```

#### VULN-007: Incorrect Result Handling

**Severity:** Medium

```csharp
// VULNERABLE: Falsy results treated as success
public static void PostExecute(UInt160 accountId, object[] opParams, object result)
{
    // result = 0 means failure, but we still spend!
    Storage.Put(..., GetSpent(accountId) + amount);
}

// SECURE: Check for actual success
private static bool DidExecutionSucceed(object result)
{
    if (result is bool asBool) return asBool;
    if (result is BigInteger asInt) return asInt != 0;
    if (result is ByteString asStr) return asStr.Length > 0;
    return true;
}

public static void PostExecute(UInt160 accountId, object[] opParams, object result)
{
    if (!DidExecutionSucceed(result)) return;
    Storage.Put(..., GetSpent(accountId) + amount);
}
```

---

## 4. Configuration Security

### 4.1 Using VerifierAuthority

```csharp
// REQUIRED for all verifiers
public static void SetPublicKey(UInt160 accountId, ByteString pubKey)
{
    VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);
    // ... actual storage ...
}
```

### 4.2 Using HookAuthority

```csharp
// REQUIRED for all hooks
public static void PreExecute(UInt160 accountId, object[] opParams)
{
    HookAuthority.ValidateExecutionCaller(accountId,
        Runtime.CallingScriptHash, Runtime.ExecutingScriptHash);
    // ... actual logic ...
}
```

### 4.3 Common Misconfigurations

| Misconfiguration | Risk | Fix |
| --- | --- | --- |
| **Skip authority check** | Unauthorized config | Always call `ValidateConfigCaller` |
| **Direct storage access** | Bypass core contract | Only access `Prefix_*` prefixed keys |
| **Mutable verification** | Bypass timelock | Never make verification upgradable without core |
| **Shared state across accounts** | Cross-account leakage | Always prefix with `accountId` |

---

## 5. Cryptographic Best Practices

### 5.1 Canonical Payload Encoding

```csharp
// GOOD: Unambiguous encoding
private static byte[] BuildPayload(...)
{
    return Helper.Concat(
        ToUint256Word(network),
        Helper.Concat(
            accountId,  // Fixed 20 bytes
            ToLengthPrefixed(method)  // Length + bytes
        )
    );
}

// BAD: Ambiguous concatenation
private static byte[] BuildPayload(...)
{
    return Helper.Concat(accountId, method, args); // Collision possible!
}
```

### 5.2 Hash Function Selection

| Use Case | Hash Function | Notes |
| --- | --- | --- |
| **Neo-native sigs** | SHA256 | Via `CryptoLib` |
| **EVM compatibility** | Keccak256 | Via `NativeCryptoLib.Keccak256` |
| **Payload binding** | Both | Match verifier's signature algorithm |

### 5.3 Public Key Validation

```csharp
// GOOD: Explicit validation
public static void SetPublicKey(UInt160 accountId, ByteString pubKey)
{
    VerifierAuthority.ValidateConfigCaller(accountId, Runtime.ExecutingScriptHash);

    // Check length (secp256k1 uncompressed = 65, compressed = 33)
    ExecutionEngine.Assert(
        pubKey.Length == 65 || pubKey.Length == 33,
        "Invalid public key length"
    );

    // Check valid point
    ECPoint? point = TryParseECPoint(pubKey);
    ExecutionEngine.Assert(point != null && point.IsValid, "Invalid public key");

    Storage.Put(..., pubKey);
}
```

---

## 6. Testing & Audit Checklist

### 6.1 Before Submission

- [ ] All authority checks present (`ValidateConfigCaller`, `ValidateExecutionCaller`)
- [ ] No mutable global state (no admin keys)
- [ ] Network ID included in all payload hashes
- [ ] Account ID included in all payload hashes
- [ ] Deadline included in all payload hashes
- [ ] Signature length enforced
- [ ] Gas bounds on loops/recursion
- [ ] No external calls in `PreExecute`
- [ ] Idempotent `PostExecute` operations
- [ ] `ClearAccount` deletes all storage prefixes

### 6.2 Security Testing

```bash
# Test 1: Replay protection
# Submit same operation twice - should fail on second attempt

# Test 2: Cross-chain replay
# Sign on mainnet, submit to testnet - should fail

# Test 3: Signature forgery
# Modify signature bytes - should fail

# Test 4: Gas DoS
# Pass large arrays - should reject or be bounded

# Test 5: Reentrancy
# Hook that calls AA - should be rejected
```

### 6.3 Audit Requirements

For official plugin listing, provide:

1. **Source code review** - Full codebase access
2. **Test coverage** - Unit + integration tests
3. **Formal verification** - (Optional) Mathematical proof
4. **Gas analysis** - Worst-case gas consumption
5. **Third-party audit** - (Recommended) Independent review

---

## 7. Deployment Checklist

- [ ] Contract manifest includes required permissions
- [ ] `ContractPermission("*", "canConfigureVerifier")` (verifiers)
- [ ] `ContractPermission("*", "canExecuteHook")` (hooks)
- [ ] `Safe` attributes on view functions
- [ ] Events for state changes
- [ ] Clear documentation of security assumptions
- [ ] Testnet validation completed
- [ ] Source code published
- [ ] Address registered in ecosystem

---

## 8. Resources

- **Security Model:** `docs/SECURITY_MODEL.md`
- **Ethereum Comparison:** `docs/ETHEREUM_AA_COMPARISON.md`
- **Plugin Matrix:** `docs/PLUGIN_MATRIX.md`
- **Core Contract:** `contracts/UnifiedSmartWallet.cs`
- **Verifier Examples:**
  - `contracts/verifiers/Web3AuthVerifier.cs`
  - `contracts/verifiers/WebAuthnVerifier.cs`
  - `contracts/verifiers/SessionKeyVerifier.cs`
- **Hook Examples:**
  - `contracts/hooks/WhitelistHook.cs`
  - `contracts/hooks/DailyLimitHook.cs`
  - `contracts/hooks/MultiHook.cs`

---

## 9. Reporting Security Issues

Found a vulnerability in an existing plugin? Report to:

1. **Critical/High:** Email `security@neo-abstract-account.org`
2. **Medium/Low:** Open GitHub issue with `[security]` label

Include:
- Affected plugin version
- Vulnerability description
- Exploit scenario
- Recommended fix
- Proof of concept (optional but helpful)

---

## 10. Summary: Security by Design

| Principle | Implementation |
| --- | --- |
| **Least Privilege** | Plugins only access account-specific state |
| **Defense in Depth** | Core → Verifier → Hook layers |
| **Fail Closed** | Reject unauthorized, don't allow |
| **Economy of Mechanism** | Minimal gas, no unnecessary checks |
| **Open Verification** | Signature logic is auditable |
| **No Secrets** | All state is on-chain |

Follow these principles, and your plugin will be a secure, auditable component of the Neo Abstract Account ecosystem.
