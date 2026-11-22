# Validator, Policy & Hook Modules

Protocol v4 installs **modules** into an account instead of binding a single `verifier` contract.
The module whose job is to decide authorization is a **validator** (the ERC-7579 term the protocol
now uses); the modules that narrow what the account may do are **hooks**. The old `verifier` binding
surface is removed without an alias, and the identity-only witness entry `verify` survives because
the proxy script embeds it.

Module kinds are one-byte codes:

| Type | Name | v4 |
| --- | --- | --- |
| 1 | validator | supported |
| 2 | executor | rejected by `supportsModuleType` |
| 3 | fallback handler | rejected by `supportsModuleType` |
| 4 | hook | supported |

## Choose In Layers

Treat an SA policy stack as three layers, installed in this order:

1. **Validator layer** — decides **who may authorize** an operation.
   The built-in route (the custody witness) always exists and is gated by the default policy, so an
   account with no validator module is not an owner-less account.
   Shipped validators:
   - `Web3AuthValidator`
   - `SessionKeyValidator`
   - `MultiSigValidator`
   - `SubscriptionValidator`
   - `NeoWitnessValidator`
   - `P256Validator`
   - `TeeKeyValidator`
   - `DelegatedIdentityValidator`

2. **Hook layer** — decides **what the account may do** once a validator (or the built-in route)
   accepts the operation. Hooks are ordered by the account's `hookOrder` list: every `preCheck` runs
   in ascending order and every `postCheck` runs over the same snapshot in reverse order.
   Shipped hooks:
   - `WhitelistHook`
   - `DailyLimitHook`
   - `TokenRestrictedHook`
   - `NeoDIDCredentialHook`

3. **Recovery path** — the core owns recovery: the custody witness can self-rescue, and an optional
   recovery authority takes over only after the account's 7–90 day timelock. Recovery is not a
   module; it removes modules and policies callback-free once it matures.

`MultiHook` is retired: installing it is rejected, and the migrated hook order lives in the core
`hookOrder` list instead. `ZKEmailVerifier` is a disabled template — every callback fails closed, so
it is not an installable production validator.

### Validator notes

- `MultiSigValidator` is a threshold *policy* now: one key per instance (`setMemberKey`), the member
  set and threshold live in core state, and orchestration plus approval receipts are core-owned.
  A threshold is 1–10 members over one layer — the members may share a key or a controller, so a
  threshold counts modules, not independent humans.
- `SessionKeyValidator` instances are isolated: each instance owns one credential set, granted with
  `setSessionKey` and withdrawn with `clearSessionKey`. The cap is enforced on the `transfer` method
  only, so a wildcard method with a zero cap is a value-uncapped delegation.
- `DelegatedIdentityValidator` verifies a configured P-256 signer plus an identity binding. It does
  not verify a general zero-knowledge proof, and it does not claim a remote attestation; the same
  boundary applies to `TeeKeyValidator`.

## Recommended Combinations

### Consumer Wallet

- Validator: `Web3AuthValidator`
- Hook: `DailyLimitHook`
- Recovery: custody address plus a 7–30 day timelock

### Trading / Automation Wallet

- Validator: `SessionKeyValidator` (one instance per bot)
- Hook: `WhitelistHook`
- Recovery: custody address plus an optional recovery authority

### High-Value Treasury

- Validator: `MultiSigValidator` (threshold 2–10)
- Hook: `TokenRestrictedHook`
- Recovery: separate recovery authority with a 90 day timelock

### Membership / Recurring Billing

- Validator: `SubscriptionValidator`
- Hook: `DailyLimitHook`
- Recovery: custody address

## How To Configure

Do not start from raw calldata. An install is either an atomic registration action or a call to the
core:

1. `installModule(accountId, moduleType, moduleContractHash, initData)` installs one instance in the
   current transaction; `removeModule(accountId, moduleId, deInitData)` uninstalls it. Both accept the
   custody witness or the witness of an already installed validator instance.
2. A registration action is the positional vector `[1, moduleType, moduleHash, profileDigest,
   initData]` — the install code, the module type, the module hash, the profile digest the core
   compares and the install data. Its uninstall companion is `[2, moduleId, deInitData]`.
3. The core executes no other action code. A delay, a maturity window and a multi-action batch belong
   to a governance module, which collects them and then calls the two methods above; the core itself
   applies each call atomically or not at all.

A module instance is identified by `(accountId, moduleId)`, never by contract address. `moduleId` is
allocated once per account from 1 (0 is the built-in route) and is never reused, so an uninstalled
instance's signatures and pending intents can never re-attach to a new one. The same contract may be
installed several times only when its capability profile declares instance isolation.

Limits: 32 validator instances, 8 hook instances, 10 threshold members per policy, 16 actions per
intent and 16 unresolved intents per account. Enumeration reads page at most 32 modules.

## Module Commands

Install data, configure data and uninstall data are `[command, ...args]` arrays. Each module owns its
vocabulary; the core only enforces the array bound and the lifecycle gas budget.

| Module | Commands |
| --- | --- |
| `P256Validator`, `Web3AuthValidator`, `TeeKeyValidator` | `setPublicKey` — 33-byte compressed or 65-byte uncompressed, stored compressed |
| `NeoWitnessValidator` | `setSigners` — signer set plus threshold |
| `MultiSigValidator` | `setMemberKey` — one key per instance |
| `SessionKeyValidator` | `setSessionKey` — key, target, method, expiry, cap, subId; `clearSessionKey` |
| `SubscriptionValidator` | `createSubscription` — key, payee, token, amount, period; `cancelSubscription` |
| `DelegatedIdentityValidator` | `setConfig` — public key, provider, master nullifier |
| `ActionSessionValidator` | `setRecoveryService`; `clearRecoveryService` |
| `DailyLimitHook` | `setDailyLimit` — token, max amount, rolling-window flag; `clearDailyLimit` |
| `TokenRestrictedHook` | `restrictToken`; `unrestrictToken` |
| `WhitelistHook` | `allowTarget`; `denyTarget` |
| `NeoDIDCredentialHook` | `requireCredential` — target, provider, claim type, commitment; `clearRequirement` |
| `MultiHook` | none — retired, installation rejected |

`DailyLimitHook` meters the account id, not the derived virtual address, and usage accrues only
after a successful execution. `NeoDIDCredentialHook` stores no local credential flags: the credential
must exist on the configured `NeoDIDRegistry`, and the commitment must be the 32-byte commitment
registered for that provider and claim type.

## Paymaster + Hook Combinations

The on-chain `SAPaymaster` contract funds relay fees for an account but never authorizes execution.
Validators and hooks still run independently, so sponsorship composes with any policy stack.

### Sponsored Consumer Wallet

- Validator: `Web3AuthValidator`
- Hook: `DailyLimitHook`
- Paymaster: a global policy (account id of zero) targeting the dApp contract

### Sponsored Automation

- Validator: `SessionKeyValidator`
- Hook: `WhitelistHook`
- Paymaster: a per-account policy with per-operation and daily budgets

### Key Principle

The paymaster pays only after validation succeeds:

- a sponsor cannot bypass a hook by paying for gas
- a hook cannot raise a paymaster budget
- reimbursement is settled inside the same sponsored execution, so there is no window where the
  target runs but reimbursement fails

## Market Readiness

When listing an SA address in the market, publish at minimum:

- the installed validator instances and their module ids
- the hook set and its order
- the recovery authority, timelock and whether the account is frozen
- whether the buyer must install fresh modules after purchase

Settlement is the buyer's clean slate: `settleMarketEscrow` sweeps modules and policies callback-free,
sets custody to the buyer, clears the recovery authority, advances the authority epoch and
configuration nonce, resets the default authorizations and re-initializes the message subjects.
The buyer configures fresh modules in the app workspace after purchase.
