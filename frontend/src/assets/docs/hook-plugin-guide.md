# Hook & Plugin Guide

This guide replaces the old "type a raw method name and paste JSON args" workflow as the primary mental model.

## Choose In Layers

Treat an AA policy stack as three layers:

1. **Verifier plugin**
   Use this to decide **who is allowed to authorize**.
   Examples:
   - `Web3AuthVerifier`
   - `SessionKeyVerifier`
   - `MultiSigVerifier`
   - `SubscriptionVerifier`
   - `TEEVerifier`
   - `ZkLoginVerifier`

`ZkLoginVerifier` is a compatibility name for the current delegated-signer
scheme. It verifies a `secp256r1` signature plus provider and nullifier
bindings; it does not verify a zero-knowledge proof. The master nullifier is
public contract state, and action-nullifier replay protection comes from the
core account nonce rather than an on-chain nullifier set.

2. **Hook plugin**
   Use this to decide **what the account is allowed to do** after a verifier accepts the signature.
   Examples:
   - `WhitelistHook`
   - `DailyLimitHook`
   - `TokenRestrictedHook`
   - `NeoDIDCredentialHook`

3. **Backup / escape path**
   Use this to recover ownership or rotate the verifier when the primary path is compromised.

## Recommended Combinations

### Consumer Wallet

- Verifier: `Web3AuthVerifier`
- Hook: `DailyLimitHook`
- Backup: one cold owner address

Use this when you want a mainstream login flow with a hard spending ceiling.

### Trading / Automation Wallet

- Verifier: `SessionKeyVerifier`
- Hook: `WhitelistHook`
- Backup: `MultiSigVerifier` recovery path

Use this when a bot or operator should hit only approved contracts and methods.

### High-Value Treasury

- Verifier: `MultiSigVerifier`
- Hook: `TokenRestrictedHook` or `MultiHook`
- Backup: separate recovery owner

Use this when the account should protect a small approved asset set and require collective approvals.

### Membership / Recurring Billing

- Verifier: `SubscriptionVerifier`
- Hook: `DailyLimitHook`
- Backup: cold owner

Use this when the account is expected to authorize repeated recurring actions with bounded exposure.

## How To Configure

Do not start from raw calldata.

Start from:

1. pick the verifier intent
2. pick the policy hook intent
3. fill only the small number of fields that are specific to your account
4. let the app generate the low-level method + typed args

## Hook Presets

### WhitelistHook

Purpose:
only allow explicit target contracts.

Typical operations:

- `setWhitelist(accountId, target, true)`
- `setWhitelist(accountId, target, false)`

### DailyLimitHook

Purpose:
cap daily outflow for a token or target.

Operational notes:

- the canonical protected transfer source is the V3 `accountId`
- this hook does not treat the derived virtual address as a separate spend authority
- usage only accrues after successful execution

Typical operations:

- `setDailyLimit(accountId, token, dailyLimit)`

### TokenRestrictedHook

Purpose:
only allow a narrow asset universe.

Typical operations:

- `allowToken(accountId, token, true)`
- `allowToken(accountId, token, false)`

### NeoDIDCredentialHook

Purpose:
require an active NeoDID registry binding before a call is allowed.

Typical operations:

- `setRegistry(registryHash)`
- `requireCredentialCommitmentForContract(accountId, target, provider, claimType, claimCommitment)`

Operational notes:

- this hook no longer stores local `issueCredential` / `revokeCredential` flags
- the credential must exist on the configured `NeoDIDRegistry`
- `claimCommitment` must be the 32-byte commitment registered for the provider + claim type

### MultiHook

Purpose:
compose multiple hooks behind one bound hook slot.

Typical operations:

- `setHooks(accountId, [hook1, hook2, ...])`

## Verifier Presets

### Web3AuthVerifier

Purpose:
consumer-facing social login.

Input shape:

- verifier contract hash
- verifier pubkey / provider config bytes

### SessionKeyVerifier

Purpose:
temporary delegated signing.

Input shape:

- session key pubkey
- target contract
- allowed method
- expiry

### MultiSigVerifier

Purpose:
N-of-M governance approvals.

Input shape:

- signer set
- threshold

### SubscriptionVerifier

Purpose:
recurring scheduled approvals.

Input shape:

- receiver / target
- cadence
- expiry / max usage

### ZkLoginVerifier

Purpose:
bind an AA account to a privacy-preserving Morpheus NeoDID identity root and authorize each `executeUserOp` with an operation-bound zklogin ticket.

Input shape:

- Morpheus / NeoDID verifier public key
- provider id, typically `web3auth`
- `master_nullifier` derived inside the TEE from the verified Web2 identity root

Operational notes:

- Google / Twitter / GitHub style Web2 login can flow through Web3Auth while the TEE keeps the raw provider identity private.
- Each signature is a compact proof blob containing the provider id, `master_nullifier`, `action_nullifier`, and Morpheus signer signature.
- The account still relies on AA nonce + deadline replay protection; the verifier only binds the private identity root to each operation payload.

## Paymaster + Hook Combinations

The on-chain `AAPaymaster` contract (`contracts/paymaster/Paymaster.cs`) lets sponsors cover relay fees for accounts, but it never authorizes execution. Verifier and hook plugins still run independently. This separation makes it safe to combine Paymaster sponsorship with any policy stack.

### Sponsored Consumer Wallet

- Verifier: `Web3AuthVerifier`
- Hook: `DailyLimitHook`
- Paymaster: sponsor sets a global policy (`accountId = UInt160.Zero`) targeting the dApp contract

Use this when a dApp operator wants gasless onboarding. The `DailyLimitHook` caps daily outflow even though the sponsor pays the gas, so a compromised session cannot drain the account.

### Sponsored Automation

- Verifier: `SessionKeyVerifier`
- Hook: `WhitelistHook`
- Paymaster: sponsor sets a per-account policy with `maxPerOp` and `dailyBudget` limits

Use this when a backend bot executes on behalf of users and the service provider funds the gas. The `WhitelistHook` restricts which contracts the bot can touch, while the Paymaster policy caps how much GAS the sponsor is willing to burn per operation and per day.

### Sponsored Subscription

- Verifier: `SubscriptionVerifier`
- Hook: `DailyLimitHook`
- Paymaster: sponsor sets a policy scoped to the subscription target contract and method

Use this when a merchant sponsors recurring billing gas. The `SubscriptionVerifier` ensures cadence and expiry, the `DailyLimitHook` bounds exposure, and the Paymaster policy limits total GAS the merchant commits.

### Key Principle

The Paymaster only funds the relay after verifier and hook checks pass. This means:

- a sponsor cannot bypass a hook by paying for gas
- a hook cannot override a Paymaster budget limit
- the relay receives GAS atomically inside `executeSponsoredUserOp`, so there is no window where execution succeeds but reimbursement fails

## Market Readiness

When listing an AA address in the market, publish at minimum:

- active verifier profile
- active hook profile
- backup owner / escape expectations
- whether transfer requires a verifier rotation after purchase

That lets buyers understand whether they are purchasing a clean shell or a heavily opinionated policy stack.

For trustless escrow sales, the market should transfer only the AA shell. Existing verifier and hook bindings are cleared during settlement, and the buyer should configure fresh plugins in the app workspace after purchase.
