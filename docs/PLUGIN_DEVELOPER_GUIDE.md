# Module Developer Security Guide

## Executive Summary

This guide is for developers building protocol v4 validator or hook modules for the Neo N3 Smart
Account ecosystem. It covers security best practices, common vulnerabilities, and the interfaces the
core enforces at install and call time.

**Target Audience:** Smart contract developers
**Prerequisites:** Familiarity with Neo N3, C#, and cryptographic primitives
**Security Status:** Following these guidelines is required for plugin inclusion in the verified ecosystem.

---

## 0. Quick Start: From Template to Bound Plugin

The fastest correct path is to copy a template, not to start from a blank file:

```text
contracts/plugins/templates/validator/  minimal validator (single-key secp256r1 authorization)
contracts/plugins/templates/hook/       minimal hook (fail-closed per-instance target gate)
```

Each template compiles against the same shared layer the shipped modules use
(`ValidatorAuthority` / `ValidatorPayload` / `ValidatorModels` / `SignerDomain` for
validators, `HookAuthority` for hooks), exposes exactly the ABI the core's
bind-time gate demands, and wires the timelocked governance rails (self-upgrade,
admin rotation, core re-pointing). Copy the directory, rename the class,
`DisplayName` and `ModuleProfileJson`, replace the marked policy method, and compile. The step-by-step
walkthrough and the six rules that bite are in
[`contracts/plugins/templates/README.md`](../contracts/plugins/templates/README.md).

`node scripts/check_plugin_templates.mjs` recompiles both templates and asserts
their manifests still satisfy the binding ABI; the repository verification gate
runs it on every contract build, so a shared-layer change that would break a
fresh plugin fails here first.

---

## 1. Plugin Architecture Overview

### 1.1 Two Plugin Types

| Type | Responsibility | Security Focus | Examples |
| --- | --- | --- | --- |
| **Validator** | "Who is authorized?" | NeoWitness, MultiSig, SessionKey, P256, Web3Auth, TeeKey, DelegatedIdentity |
| **Hook** | "What is allowed?" | Whitelist, DailyLimit, TokenRestricted, NeoDIDCredential |

Both roles are installed as instances: the core assigns a `moduleId` per install and one
module contract may serve several instances on the same account. Composition is
core-owned — a threshold policy over validator instances and `hookOrder` over hook
instances — so a module never calls another module.

### 1.2 Module Storage Is Instance-Scoped

```csharp
// GOOD: Stateless module
public static ByteString GetPublicKey(UInt160 accountId, BigInteger moduleId)
{
    byte[] key = ValidatorAuthority.InstanceKey(Prefix_PubKey, accountId, moduleId);
    return Storage.Get(Storage.CurrentContext, key) ?? (ByteString)"";
}

// BAD: Stateful module with admin keys
private static readonly byte[] Prefix_Admin = new byte[] { 0xFF };
public static void SetAdmin(UInt160 newAdmin)
{
    // Never allow admin keys in plugins!
}
```

**Rule:** A module may keep instance-scoped policy state, but it must not have
independent admin keys or privileged upgradability. Every key starts from
`InstanceKey(prefix, accountId, moduleId)` because the same module may be installed
several times on one account, and `OnUninstall` deletes each prefix with
`DeleteInstancePrefix(prefix, accountId, moduleId)`. All configuration flows through
the SA core's configuration intents.

---

## 2. Validator Module Security

### 2.1 Required Interface

```csharp
// Exported by every installable module, validator or hook.
public interface IModuleLifecycle
{
    // Canonical, whitespace-free profile JSON; its SHA-256 is the profile
    // digest the core recomputes and binds at install (spec §12).
    string GetModuleProfile();

    void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] initData);
    void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData);
    void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] deInitData);
}

public interface IValidatorModule : IModuleLifecycle
{
    // Read-only authorization over the core's canonical 13-field view.
    bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation);

    // Optional post-execution work for this instance; a no-op when unused.
    void OnUserOpComplete(UInt160 accountId, object[] operation, object result);

    // Declared only when the profile claims messageCapability.
    object[] GetSignerDomains(UInt160 accountId, BigInteger moduleId);
}

public interface IHookModule : IModuleLifecycle
{
    // Runs before execution; returns at most 512 bytes of hook data.
    ByteString PreCheck(UInt160 accountId, object[] operation);

    // Receives the same instance's hook data after execution.
    void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData);
}
```

Binding is fail-closed at three layers. `getModuleProfile/0` must be a safe String method
whose canonical bytes hash to the profile digest the core stores, the deployed manifest
must expose the lifecycle callbacks `onInstall(Hash160, Integer, Integer, Array)`,
`configure(Hash160, Integer, Integer, Array)` and `onUninstall(Hash160, Integer, Integer, Array)`,
and it must expose the callback pair of its declared role —
`validateUserOp(Hash160, ByteString, Array) -> Boolean` with `onUserOpComplete(Hash160, Array, Any)`
for validators, or `preCheck(Hash160, Array) -> ByteString` with
`postCheck(Hash160, Array, Any, ByteString)` for hooks. A module that declares a callback
outside its role, or a profile the core cannot re-hash, is rejected before it is
installed. Manifest presence proves only the callable surface; it does not prove the
method's cryptographic or storage semantics, so new modules still require an audited
implementation and concrete runtime/refinement evidence. Composition is core-owned:
protocol v4 replaced composite verifiers with the core threshold policy and composite hooks
with `hookOrder`, so `MultiSigValidator` validates one configured child signer and
`MultiHook` rejects new installs. These checks are ABI/profile/lifecycle guards, not proofs
of cryptographic independence or arbitrary future-module storage semantics.

### 2.2 Security Checklist for Validators

| Check | Why | Implementation |
| --- | --- | --- |
| **Network ID in domain** | Prevent cross-chain replay | Sign `ValidatorPayload.SigningDigest`, which binds the core operation digest and its network domain |
| **Account ID in domain** | Prevent account confusion | The same helper binds `accountId`, `moduleId` and the credential generation |
| **Deadline in operation** | Prevent old signature use | `operation[6]` is covered by the core digest; check it against `Runtime.Time` when your policy has a window |
| **No side effects** | Validation must be read-only | Use `CallFlags.ReadOnly` where applicable |
| **Bounded gas** | *(CRITICAL)* Prevent DoS | The matching private SA artifact uses `System.Contract.CallWithGasLimit` for validator and hook callbacks; public-profile descendants inherit the callback's ancestor budget. Native activation and public deployment remain separate gates. |
| **Signature length check** | Prevent malformed input | Assert `((ByteString)operation[11]).Length` against the expected value |
| **Return boolean only** | Validation pattern | Don't throw on normal rejections |
| **No state mutation** | Pure validation | Never write storage in `validateUserOp` |

### 2.3 Common Vulnerabilities

The `PG-*` identifiers below are this guide's plugin-development checklist. The project's
vulnerability ledger is a different namespace with its own `VULN-001` to `VULN-006`, kept in
`docs/SECURITY_MODEL.md` section 6.1; do not read a `PG-*` item as a ledger entry.

#### PG-01: Missing Network ID

**Severity:** Critical

```csharp
// VULNERABLE: a self-built digest that omits the network and the instance
byte[] payload = Helper.Concat(accountId, targetContract, method, args, nonce, deadline);

// SECURE: sign the shared binding, which carries the network domain, the core
// operation digest, the canonical 13-field view and the module instance.
ByteString digest = ValidatorPayload.SigningDigest(accountId, operationDigest, operation, moduleId);
```

#### PG-02: Mutable State in Validation

**Severity:** High

```csharp
// VULNERABLE: State change during validation
public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
{
    Storage.Put(Storage.CurrentContext, "lastValidated", Runtime.Time); // BAD!
    return CryptoLib.Verify(...);
}

// SECURE: Pure validation
public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
{
    return CryptoLib.Verify(...);
}
```

#### PG-03: Unbounded Gas Consumption

**Severity:** Critical

```csharp
// VULNERABLE: DoS vector
public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
{
    // Loop can consume arbitrary gas
    for (int i = 0; i < operation.Length; i++)
    {
        HeavyCryptoOperation(operation[i]);
    }
    return true;
}

// REDUCED INPUT RISK ONLY: Bound iterations and reject oversized inputs.
// This does not replace a platform-enforced child budget.
public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
{
    ExecutionEngine.Assert(operation.Length == 13, "Non-canonical operation");
    object[] args = (object[])operation[3];
    ExecutionEngine.Assert(args.Length <= 64, "Too many args");
    for (int i = 0; i < args.Length; i++)
    {
        HeavyCryptoOperation(args[i]);
    }
    return true;
}
```

#### PG-04: Signature Forgery via Length Extension

**Severity:** Critical

```csharp
// VULNERABLE: Accepts any signature length
public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
{
    ByteString sig = (ByteString)operation[11];
    // Missing length check!
    return CryptoLib.Verify(payload, pubKey, sig);
}

// SECURE: Enforce exact length
public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
{
    ByteString sig = (ByteString)operation[11];
    ExecutionEngine.Assert(sig.Length == 64, "Invalid signature length");
    return CryptoLib.Verify(payload, pubKey, sig);
}
```

---

## 3. Hook Plugin Security

### 3.1 Required Interface

```csharp
public interface IHookModule : IModuleLifecycle
{
    // Runs before target execution and may reject; returns at most 512 bytes.
    ByteString PreCheck(UInt160 accountId, object[] operation);

    // Runs after target execution for the same instance; receives its own hookData.
    void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData);
}
```

The sketch above is written in the deployed spelling deliberately, because these are the names the SA
core calls: the manifest your plugin deploys has to export them, and a method declared the way the
sketch declares it exports exactly that name. The contracts build compiles with `nccs`, which
lower-cases the first letter of every exported member, so a hook contract that declares the same
callbacks as PreCheck, PostCheck, OnInstall, Configure and OnUninstall deploys the same names — the
rule leaves a declaration that is already lower-case unchanged. The rule is stated for contract
authors in `neo-os-contracts` `contracts/README.md` ("The deployed spelling of an exported member");
writing the C# spelling in documentation is a claim about a name the deployment does not carry.

Both callbacks receive the core's canonical 13-field operation view (§4.1 of
[`docs/SA-MODULE-PROTOCOL.md`](SA-MODULE-PROTOCOL.md)), never a caller-supplied tuple:
`operation[1]` is the target, `[2]` the method, `[3]` the argument array and `[12]` the hook
proofs. `preCheck` returns the bytes its own `postCheck` needs (or an empty `ByteString`), and the
core passes them back to the **same instance** in the same execution; a hook never reconstructs
state from a caller-controlled value, and a hook that returns more than 512 bytes is rejected. The
core's runtime suite verifies both the positive target path and rejection of an unlisted target
through the real NeoVM callback path.

`onUninstall(accountId, moduleId, generation, deInitData)` is a mandatory lifecycle method for both
validator and hook modules. It must delete every instance-scoped key owned by the module
(`HookAuthority.DeleteInstancePrefix` or `ValidatorAuthority.DeleteInstancePrefix` per prefix) and
must fault on an internal cleanup failure. It must also be idempotent for an instance the module
never configured, because the core calls it on every uninstall regardless. A module that omits the
method never installs: the core's install-time gate checks the complete lifecycle ABI. Modules that
custody user funds per instance (for example the recovery service's credit) must return them to the
account owner in `onUninstall` rather than orphan them.

**Transfer source is the proxy address, never the account id.** A virtual SA
account holds its assets at the core-derived proxy script hash
(`getProxyScriptHash(accountId)`), and that address is the only `from` a token's
`CheckWitness` accepts during `executeUserOp`. Any validator or hook that pins,
meters or allowlists a transfer source must compare against that address
(`Contract.Call(core, "getProxyScriptHash", CallFlags.ReadOnly, accountId)`) and
must declare `ContractPermission("*", "getProxyScriptHash")`. Comparing against
the `accountId` authorizes a transfer that can never move funds and meters a
balance that is always zero. The SA core treats a cleanup fault
as a failed enclosing transition; it must not swallow the fault and hand a
buyer or replacement module a potentially dirty account shell. This is
fail-closed for known plugins, not a proof that an arbitrary future contract
has no unrelated storage.

**A witness you check inside a module needs a signer scope that reaches the module.**
Validators and hooks execute as nested calls from the core, so `Runtime.CheckWitness`
in a module only sees signers whose scope covers the module contract. A signer with
`CalledByEntry` is visible to the core but not to the module: `SubscriptionValidator`
rejects such a merchant pull with "merchant authorization required" and accepts it once
the merchant signs with a scope that reaches the validator. Document the required scope
for every witness your module checks, and prefer `CustomContracts` naming the module
over `Global`.

### 3.2 Security Checklist for Hooks

| Check | Why | Implementation |
| --- | --- | --- |
| **Authority validation** | Prevent unauthorized configuration | Each callback starts with `HookAuthority.RequireLifecycle(accountId, moduleId)`; the core records the writer phase and `getAuthorizedModuleId(accountId, phase)` resolves the instance |
| **Context validation** | Ensure SA core is caller | `RequirePreCheck` / `RequirePostCheck` likewise refuse any caller that is not the configured core in the matching phase |
| **Revert on reject** | Atomic rejection pattern | Throw `ExecutionEngine.Assert` |
| **No external calls in pre** | Prevent reentrancy | Only inspect the operation view |
| **Careful post logic** | No validation in post | Only cleanup and logging |
| **State consistency** | Idempotent operations | Handle re-entrancy/timeout |
| **onUninstall** | Cleanup on removal | `DeleteInstancePrefix` for every instance prefix |

### 3.3 Common Vulnerabilities

#### PG-05: Reentrancy in preCheck

**Severity:** High

```csharp
// VULNERABLE: Can call back into the SA
public static ByteString PreCheck(UInt160 accountId, object[] operation)
{
    HookAuthority.RequirePreCheck(accountId, operation);

    // Check limit in storage
    BigInteger spent = GetSpent(accountId);
    if (spent + amount > limit) return (ByteString)new byte[0];

    // Call external contract (DANGEROUS!)
    Contract.Call((UInt160)operation[1], "doSomething", CallFlags.All, ...);

    // Attacker re-enters with same operation!
}

// SECURE: No external calls in preCheck
public static ByteString PreCheck(UInt160 accountId, object[] operation)
{
    HookAuthority.RequirePreCheck(accountId, operation);

    BigInteger spent = GetSpent(accountId);
    if (spent + amount > limit)
    {
        ExecutionEngine.Assert(false, "Limit exceeded");
    }
    Storage.Put(..., spent + amount);
    return (ByteString)new byte[0];
}

public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
{
    HookAuthority.RequirePostCheck(accountId, operation);
    if (!DidExecutionSucceed(result)) return;

    BigInteger pending = GetPending(accountId);
    Storage.Put(..., 0); // Consume
}
```

#### PG-06: Double-Spend in postCheck

**Severity:** High

```csharp
// VULNERABLE: Not checking if already consumed
public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
{
    // Attacker calls postCheck twice!
    BigInteger current = GetSpent(accountId);
    Storage.Put(..., current + amount);
}

// SECURE: Use idempotent operations keyed by the instance
public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
{
    HookAuthority.RequirePostCheck(accountId, operation);
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

#### PG-07: Incorrect Result Handling

**Severity:** Medium

```csharp
// VULNERABLE: Falsy results treated as success
public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
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

public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
{
    if (!DidExecutionSucceed(result)) return;
    Storage.Put(..., GetSpent(accountId) + amount);
}
```

---

## 4. Configuration Security

### 4.1 Using ValidatorAuthority

```csharp
// REQUIRED at the head of every exported callback
public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger generation, object[] configData)
{
    ValidatorAuthority.RequireLifecycle(accountId, moduleId);
    // ... actual storage, keyed by InstanceKey(prefix, accountId, moduleId) ...
}

public static bool ValidateUserOp(UInt160 accountId, ByteString operationDigest, object[] operation)
{
    BigInteger moduleId = ValidatorAuthority.RequireValidation(accountId, operation);
    // ... authorize against the stored credential ...
}
```

`RequireLifecycle` and `RequireValidation` read the module id from the core's recorded
writer phase; never accept a module id the caller passes in.

### 4.2 Using HookAuthority

```csharp
// REQUIRED for both hook callbacks
public static ByteString PreCheck(UInt160 accountId, object[] operation)
{
    HookAuthority.RequirePreCheck(accountId, operation);
    // ... actual logic ...
    return (ByteString)new byte[0];
}

public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
{
    HookAuthority.RequirePostCheck(accountId, operation);
    // ... actual cleanup ...
}
```

### 4.3 Common Misconfigurations

| Misconfiguration | Risk | Fix |
| --- | --- | --- |
| **Skip authority check** | Unauthorized config | Start each callback with `RequireLifecycle` / `RequirePreCheck` / `RequirePostCheck` |
| **Direct storage access** | Bypass core contract | Only access `Prefix_*` prefixed keys |
| **Mutable verification** | Bypass timelock | Never make verification upgradable without the core's configuration intent |
| **Shared state across instances** | Cross-instance leakage | Always derive keys from `InstanceKey(prefix, accountId, moduleId)` |

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
| **Payload binding** | Both | Match the validator's signature algorithm |

### 5.3 Public Key Validation

```csharp
// GOOD: Explicit validation
public static void SetPublicKey(UInt160 accountId, BigInteger moduleId, ByteString pubKey)
{
    ValidatorAuthority.RequireLifecycle(accountId, moduleId);

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

- [ ] All authority checks present (`RequireLifecycle`, `RequireValidation`, `RequirePreCheck`, `RequirePostCheck`)
- [ ] No mutable global state (no admin keys)
- [ ] Canonical `getModuleProfile()` matches the published `<Name>.profile.json`
- [ ] Operation digest signed through `ValidatorPayload.SigningDigest` (network, account, instance, generation)
- [ ] Deadline and nonce window checked against `Runtime.Time` where the policy needs one
- [ ] Signature length enforced
- [ ] Gas bounds on loops/recursion
- [ ] No external calls in `preCheck`
- [ ] Idempotent `postCheck` operations
- [ ] `onUninstall` deletes every instance prefix and is idempotent

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
# Hook that calls the SA - should be rejected
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
- [ ] `ContractPermission("*", "getAuthorizedModuleId")` (validators and hooks)
- [ ] `ContractPermission("*", "getModule")` and `getProxyScriptHash` where the module resolves its instance or the proxy address
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
- **Protocol Coverage:** `docs/PROTOCOL_COMPLETENESS_AUDIT.md`
- **Module Protocol:** [`docs/SA-MODULE-PROTOCOL.md`](SA-MODULE-PROTOCOL.md)
- **Templates:** [`contracts/plugins/templates/README.md`](../contracts/plugins/templates/README.md)
- **Core Contract:** `contracts/custom/SmartAccount.cs`
- **Validator Examples:**
  - `contracts/plugins/validators/NeoWitnessValidator.cs`
  - `contracts/plugins/validators/MultiSigValidator.cs`
  - `contracts/plugins/validators/SessionKeyValidator.cs`
- **Hook Examples:**
  - `contracts/plugins/hooks/WhitelistHook.cs`
  - `contracts/plugins/hooks/DailyLimitHook.cs`
  - `contracts/plugins/hooks/MultiHook.cs` (rejects new installs; kept as migration evidence)

---

## 9. Reporting Security Issues

Found a vulnerability in an existing plugin? Report to:

1. **Critical/High:** Email `security@smart-account.org`
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
| **Defense in Depth** | Core → validator → hook layers |
| **Fail Closed** | Reject unauthorized, don't allow |
| **Economy of Mechanism** | Minimal gas, no unnecessary checks |
| **Open Verification** | Signature logic is auditable |
| **No Secrets** | All state is on-chain |

Follow these principles, and your plugin will be a secure, auditable component of the Neo Smart Account ecosystem.
