# Core Architecture

This page describes the active architecture of protocol version 4: one SmartAccount core, two
kernels (the C# custom kernel and the native kernel), and modules that plug into a fixed lifecycle.

## 1. Component Map

```mermaid
flowchart LR
  User[User or Operator]
  Browser[Frontend Workspace]
  Drafts[Local Store or Supabase Drafts]
  Relay[Optional Relay]
  Wallets[Neo Wallet, EVM Wallet, Web3Auth]
  Core[SmartAccount Core]
  ValidatorModule[Validator Modules]
  HookModule[Hook Modules]
  Paymaster[SAPaymaster]
  Marketplace[SA Address Market]
  Target[Target Contract]

  User --> Browser
  Browser --> Wallets
  Browser --> Drafts
  Browser --> Relay
  Browser --> Core
  Relay --> Core
  Core --> ValidatorModule
  Core --> HookModule
  Core --> Marketplace
  Core --> Paymaster
  Paymaster -->|reimburse GAS| Relay
  Core --> Target
```

The system is a **policy-gated** smart contract wallet architecture. The core keeps one execution
engine; account-specific authorization and policy live in module instances rather than in role tables
inside the wallet.

## 2. Account Model

An account is keyed by a deterministic 20-byte account id:

```
accountId = hash160(0xAA524704 || custody || salt)
```

The custody script hash and the salt are the only identity inputs, so changing either changes the
account. The asset-holding address is the proxy script that embeds the account id and the core hash;
the id itself never holds assets.

`getAccount` returns one control record:

```
[exists, status, custody, recoveryAuthority, authorityEpoch, configurationNonce,
 recoveryTimelockMs, defaultOperationAuthorization, defaultMessageAuthorization,
 ownerOnlyRecovery, hookOrderRevision, controlRevision, recoveryPending,
 recoveryMatureAt, marketEscrowActive, legacyRow]
```

- `status` is 0 active, 1 frozen, 2 migration required.
- `authorityEpoch` increments on freeze, recovery and settlement: every signature and intent signed
  against the previous epoch dies with it.
- `configurationNonce` increments whenever the configuration changes, so a pending intent probes the
  configuration it was proposed against.
- `hookOrderRevision` and `controlRevision` let a reader reject a stale snapshot of the hook set or of
  the control subject.
- `defaultOperationAuthorization` and `defaultMessageAuthorization` gate the built-in route; a custody
  signature is routed by them, and a validator module is not needed for the account to have an owner.

The core is accountId-first. Reverse discovery from role indexes is not part of the model.

## 3. Verification Pipeline

```mermaid
flowchart TD
  Start[Tx reaches Neo node] --> Witness[Node triggers the account witness entry]
  Witness --> Context{Transient context is an executeUserOp call for this account}
  Context -- No --> Reject1[Reject unexpected witness use]
  Context -- Yes --> Execute[executeUserOp account and operation]
  Execute --> Status{Account active}
  Status -- No --> Reject2[Reject frozen or migrating account]
  Status -- Yes --> Digest[Compute the core operation digest]
  Digest --> Route{Route: built-in, validator, or threshold}
  Route -- Built-in --> Default{Default operation authorization allows custody}
  Default -- No --> Reject3[Reject unauthorized operation]
  Default -- Yes --> Nonce[Consume nonce channel and check deadline]
  Route -- Validator --> Validate{Validator module approves}
  Validate -- No --> Reject3
  Validate -- Yes --> Nonce
  Nonce --> PreHook[Run hook preCheck in ascending order]
  PreHook --> Call[Call the target contract]
  Call --> PostHook[Run hook postCheck in reverse order]
  PostHook --> Complete[Run validator completion callback]
  Complete --> Return[Return the sanitized result]
```

The witness entry that the proxy script embeds is a real gate, not a legacy alias: it only succeeds
while the same transaction is executing an operation for that account.

## 4. Application Execution Pipeline

```mermaid
flowchart TD
  Entry[executeUserOp or executeUserOps] --> Load[Load the account control record]
  Load --> Sane{Active, epoch and nonce current}
  Sane -- No --> Reject[Abort without state change]
  Sane -- Yes --> Hooks[Snapshot the hook order]
  Hooks --> Pre[preCheck forward over the snapshot]
  Pre --> Dispatch[Dispatch the target action]
  Dispatch --> Post[postCheck reverse over the same snapshot]
  Post --> Reimburse[Settle an optional paymaster reimbursement]
  Reimburse --> Return[Return the target result]
```

A batch is one envelope with at most 32 operations, and it either commits wholly or aborts. The hook
order snapshot is bound into the signature, so a signer cannot be shown a different hook set than the
one that runs.

## 5. Sponsored Execution Pipeline

When a sponsor funds gas, the core runs `executeSponsoredUserOp` (or its batch variant) instead of the
plain entrypoint.

```mermaid
flowchart TD
  Entry[executeSponsoredUserOp] --> Load[Load the account control record]
  Load --> Auth[Run the same authorization route]
  Auth --> Hooks[Run hook preCheck]
  Hooks --> Call[Call the target contract]
  Call --> Post[Run hook postCheck]
  Post --> Policy[Paymaster validates the sponsor policy]
  Policy -- Fail --> RejectPay[Abort: policy or deposit insufficient]
  Policy -- Pass --> Settle[Deduct the deposit and pay the relay]
  Settle --> Return[Return the target result]
```

Sponsors deposit GAS into the paymaster and create policies with `setPolicy`. A policy scoped to a zero
account id is global. Settlement is atomic — policy check, deposit deduction and relay reimbursement
happen inside one call — so there is no window where the target runs but reimbursement fails. For a
fee-bearing transaction the reimbursement is the smaller of the requested amount and the sum of system
and network fee; the per-operation cap bounds that settlement, not the total fee, and the relay bears
any unreimbursed remainder.

## 6. Authorization Modes

Every route converges on the same entrypoint, and the route is chosen by the account's own state:

- **Built-in route** — a custody witness, gated by the default operation and message authorizations.
  It always exists, so an account is never owner-less.
- **Validator modules** — `Web3AuthValidator`, `NeoWitnessValidator`, `P256Validator`,
  `TeeKeyValidator`, `SessionKeyValidator`, `SubscriptionValidator`, `DelegatedIdentityValidator`, and
  `MultiSigValidator` as a threshold policy over other validator instances.
- **Hook modules** — `WhitelistHook`, `DailyLimitHook`, `TokenRestrictedHook` and
  `NeoDIDCredentialHook` narrow what an accepted operation may do.

This is the critical boundary: a validator decides **who may authorize**, a hook decides **what else
must hold around execution**, and neither can remove the other. `ZKEmailVerifier` is a disabled
template: it faults on every use until a real proof verifier is deployed.

## 7. Recovery And Freeze

Recovery belongs to the core, not to a module:

1. `beginRecovery` starts the account's recovery window; during the window the account is frozen for
   normal operations, which is what makes the recovery safe to observe.
2. `cancelRecovery` lets custody abandon the window before maturity.
3. `executeRecovery` applies the approved result once the timelock matures, and it is permissionless —
   anyone may submit it, because the result is already fixed and approved.

The recovery timelock is per account, chosen at creation between 7 and 90 days. Matured recovery
advances the authority epoch, removes every module and policy callback-free, voids pending intents and
enables the built-in route. It calls no module, no market and no oracle.

A custody witness can freeze an account immediately with `freezeAccount`; a frozen account exposes only
reads, recovery and `unfreezeAccount`. Freezing advances the epoch, so every outstanding signature and
intent dies with it.

## 8. Frontend and Relay Model

The workspace is v4-first:

- users load an account from its account id, or create one from custody plus salt
- the UI stages one canonical 13-field operation, or a batch of them
- EVM signatures are attached as relay-ready invocations
- operators choose between client broadcast and relay submission
- shared drafts keep only the latest 100 activity entries and 12 submission receipts

The V1/V2 wrappers are gone: no manifest and no source defines them, so only `executeUserOp` (or
`executeUserOps` for a batch) reaches the current runtime. The relay trust boundary is explicit — the
relay can simulate and submit, it cannot authorize for the account, and paymaster sponsorship does not
authorize execution.

## 9. Module Lifecycle

Modules are installed, replaced and removed through configuration intents, and each step is an event:

- **install** — `ModuleInstalled`, then `ModuleInstanceInstalled` for the instance row
- **configure** — `ModuleInstanceConfigured` after the module's own command array runs
- **replace code** — `ModuleCodeRebound` when an instance is pointed at new code
- **remove** — `ModuleRemoved`, `ModuleInstanceRemoved`, or a callback-free sweep during settlement or
  recovery
- **cancel** — `ModuleUpdateCancelled` and `ConfigurationIntentCancelled` for an abandoned intent
- **order and threshold** — `HookOrderSet` and `ThresholdPolicySet` record the policy changes

The intent itself emits `ConfigurationIntentProposed`, `ConfigurationIntentConfirmed`,
`ConfigurationIntentCancelled` and `ConfigurationIntentExpired`. Tooling should read the instance
events: they carry the module id, so two instances of the same contract are distinguishable.

New configuration matures after 24 hours; the three exceptions are registration (which installs the
initial configuration atomically), emergency freeze (immediate) and callback-free credential
revocation (immediate, one-way).

## 10. Validation Preview

Relay preflight has two layers:

- a **validation preview** from the core runtime via the read-only `validateUserOp`: it runs the real
  verification path — epoch, deadline, nonce channel, validator route and hook bindings — and returns a
  structured result without writing state
- full relay simulation that runs the relay-ready invocation against Neo RPC and returns VM state and
  gas estimates

The preview never authorizes or executes anything by itself, and it never becomes a second
implementation of the rules: it calls the same code the execution path calls.

## 11. Contract File Map

| File | Responsibility |
| --- | --- |
| `contracts/custom/SmartAccount.cs` | Core account: constructor, dispatch, shared helpers |
| `contracts/custom/SmartAccount.State.cs` | Control record layout and the `getAccount` view |
| `contracts/custom/SmartAccount.Execution.cs` | Envelope decode, digest, nonce, hook sequence, dispatch |
| `contracts/custom/SmartAccount.Modules.cs` | Module instances, code binding, hook order, threshold policy |
| `contracts/custom/SmartAccount.Intents.cs` | Pending configuration intents, maturity and cancellation |
| `contracts/custom/SmartAccount.ModuleProtocol.cs` | Callback ABI and profile parsing |
| `contracts/custom/SmartAccount.Escape.cs` | Recovery, freeze and unfreeze |
| `contracts/custom/SmartAccount.Message.cs` | Built-in message-signature envelope (ERC-1271 profile) |
| `contracts/custom/SmartAccount.MarketEscrow.cs` | Settlement sweep and market escrow lock |
| `contracts/custom/SmartAccount.Paymaster.cs` | Sponsored execution and reimbursement |
| `contracts/plugins/validators/*.cs` | Validator modules |
| `contracts/plugins/hooks/*.cs` | Hook modules |
| `contracts/custom/paymaster/Paymaster.cs` | `SAPaymaster`: deposit pool and sponsor policy engine |
| `contracts/custom/market/SAAddressMarket.cs` | Listing, escrow and settlement entry |
| `contracts/native/SmartAccount/*.cs` | Native kernel implementing the same protocol |

## 12. Security Invariants

1. The witness entry succeeds only inside a matching execution context for the same account.
2. Nonces are consumed by the core, never by a module.
3. A validator approval does not bypass hooks: they run before and after the target call.
4. Freeze, recovery and settlement advance the authority epoch, so old signatures and intents die.
5. Recovery execution is permissionless but applies an already-approved result, and it removes modules
   callback-free.
6. Configuration takes effect only after a 24 hour intent matures and is confirmed by custody.
7. The relay and the paymaster are operator conveniences: neither authorizes an operation.
