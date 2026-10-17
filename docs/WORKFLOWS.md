# Abstract Account Workflow Lifecycle

The Neo N3 Abstract Account workflow turns user intent into verified on-chain execution through the master contract. After the March 6, 2026 hardening update, deterministic proxy witnesses are only valid for a single top-level self-call back into the Abstract Account contract. That means direct proxy-signed external token transfers are rejected, while V3 executes through `executeUserOp(accountId, op)`, or `executeUserOps(accountId, ops)` for a batch. The V1/V2 wrappers `executeUnified` and `executeUnifiedByAddress` were removed in the V3 rewrite and exist in no deployed manifest and no contract source.

## Home Operations Workspace

The home operations workspace is now the fastest path for day-to-day usage. It lets a user load an Abstract Account, stage the AA invocation, persist an immutable share draft, collect mixed Neo + EVM approvals, and then choose the final submission path. For client-side Neo execution, the workspace now stages a concrete `executeUserOp` invocation against the AA contract instead of pointing the wallet directly at the downstream target contract.

For v1, both broadcast modes are supported:

- **Client-side broadcast:** safest default path; a connected Neo browser wallet signs and submits the invocation directly.
- **Relay broadcast:** optional path for either already-signed raw transactions or relay-ready `executeUserOp` invocations assembled from collected EVM signatures. When a relayer signer is configured, the server can submit those meta invocations without requiring users to reconstruct the call body manually.

Anonymous collaboration drafts can be backed by Supabase. The public share link carries only the opaque read slug, a collaborator link carries signature-collection authority, and a separate operator link carries relay, broadcast, and draft-management authority. Signer links also cannot forge relay or broadcast timeline entries; those activity classes are reserved for operator scope. That keeps ordinary shared links read-only while still preserving the cheap anonymous collaboration flow. If either write-capable URL leaks, the workspace can rotate the collaborator or operator link in place without rebuilding the draft.

To keep shared drafts lightweight over time, the frontend now retains only the latest 100 activity entries and the latest 12 submission receipts in draft metadata. That bounded-retention policy is applied consistently in both the local browser fallback and the Supabase-backed shared draft path.

If Supabase is not configured, the workspace falls back to a local-only draft store backed by `localStorage`. That keeps the compose → persist → sign → review flow working in the same browser, but those share links are intentionally local-only and are not a substitute for the real anonymous Supabase collaboration path.

The composer ships with concrete presets for **Generic Invoke**, **NEP-17 Transfer**, and **Multisig Draft** flows so users can stage common AA operations without hand-writing every JSON argument from scratch.

If you want the UI to treat collected EVM meta signatures as directly relayable, expose `VITE_AA_RELAY_META_ENABLED=1` alongside the server-side `AA_RELAY_WIF` configuration. That lets the workspace show an accurate relay-readiness state before submission. When both a signed raw transaction and a relay-ready meta invocation exist, the UI now offers explicit **Best Available**, **Signed Raw Tx**, and **Meta Invocation** choices so operators can control which relay path is used. The **Check Relay** action runs a server-backed preflight simulation for relay-ready meta invocations before submission and clearly reports when signed raw transaction simulation is not supported. The dedicated **Relay Preflight** panel then shows the selected payload mode, simulated VM state, gas estimate, operation, any exception details, and an expandable **Stack Preview** for inspecting return values. Stack items are also decoded for common VM types such as `Integer`, `Boolean`, `ByteString`, and nested `Array` values. Operators can also use **Copy Payload**, **Copy Stack**, and **Export JSON** actions directly from that panel for handoff and debugging.

## 1. First Transaction Walkthrough

For a first successful transaction, the recommended sequence is:

1. **Load the account** — enter the AA address or derive it from the expected identity path.
2. **Choose the operation** — start with a preset like Generic Invoke or NEP-17 Transfer.
3. **Persist the draft** — lock in the body before collecting external signatures.
4. **Collect signatures** — native Neo, EVM typed-data, or both depending on threshold requirements.
5. **Review readiness** — confirm signer progress, relay mode, and explorer settings.
6. **Choose submission path** — client-side wallet broadcast or relay-backed submission.
7. **Monitor the receipt** — txid, result, timeline entry, and follow-up actions.

```mermaid
flowchart LR
  Load[Load Account] --> Compose[Compose Operation]
  Compose --> Persist[Persist Immutable Draft]
  Persist --> Sign[Collect Signatures]
  Sign --> Review[Review Readiness]
  Review --> Submit[Submit via Wallet or Relay]
  Submit --> Receipt[Track Receipt + Timeline]
```

## 2. Choose the Submission Path

Use this rule of thumb:

| Path | Best for | Requirements | Tradeoff |
| --- | --- | --- | --- |
| Client-side broadcast | Native Neo wallet users | Browser wallet connected | Simplest and most transparent |
| Relay preflight only | Operators who want simulation before submit | Relay endpoint configured | Adds server dependency, but gives VM/gas feedback |
| Relay raw submission | Existing signed raw transaction | Raw forwarding explicitly enabled | Only use when you intentionally want passthrough |
| Relay meta submission | EVM signature collection flow | Relay signer + relay meta mode configured | Most flexible for mixed-signature workflows |
| Sponsored (Paymaster) | Gasless execution for users | AAPaymaster deployed + sponsor has deposit/policy | User pays no GAS; relay reimbursed atomically |

## 3. Collaboration Lifecycle

The collaboration lifecycle exists so different people can contribute without sharing the same power level.

```mermaid
sequenceDiagram
    actor Creator
    actor Signer
    actor Operator
    participant Store as Draft Store

    Creator->>Store: Create draft and publish share URLs
    Signer->>Store: Append signature via collaborator scope
    Operator->>Store: Append relay status / receipt via operator scope
    Operator->>Store: Rotate collaborator/operator link if needed
```

## 4. Standard Native Invocation

Native Neo execution now flows through Abstract Account wrapper methods instead of relying on a raw proxy witness to call an external contract directly.

```mermaid
sequenceDiagram
    actor Signer as Admin / Manager
    participant Node as Neo N3 Node
    participant Proxy as Deterministic Account Address
    participant Master as Master Entry Contract
    participant Target as Target Contract

    Signer->>Node: Submit tx targeting executeUserOp(...)
    activate Node

    Note over Node,Proxy: Verification Phase
    Node->>Proxy: Trigger verify(accountId)
    Proxy->>Master: Forward verification context
    activate Master
    Master->>Master: Require single top-level self-call into AA contract
    Master->>Master: Validate witness / threshold / custom verifier
    Master-->>Node: Return true or false
    deactivate Master

    Note over Node,Target: Application Phase
    Node->>Master: Run executeUserOp
    activate Master
    Master->>Master: Enforce whitelist, blacklist, and max-transfer limits
    Master->>Target: Contract.Call(target, method, args)
    Target-->>Master: Result
    Master-->>Node: Return result
    deactivate Master
    deactivate Node
```

> Raw external contract calls signed only by the deterministic proxy are intentionally rejected after hardening.

## 5. Meta-Transaction Workflow

Ethereum users can still sign EIP-712 payloads off-chain while a Neo relayer pays network fees and submits the wrapped AA execution.

```mermaid
sequenceDiagram
    actor EVM as EVM Wallet (MetaMask)
    participant Relayer as Neo Relayer
    participant Master as Master Entry Contract
    participant Target as Target Smart Contract

    EVM->>Relayer: Sign EIP-712 payload for AA wrapper call
    Relayer->>Master: executeUserOp / executeUserOps
    activate Master
    Master->>Master: Rebuild typed-data payload
    Master->>Master: Recover EVM signer and verify nonce/deadline/argsHash
    Master->>Master: Enforce whitelist, blacklist, and transfer policies
    Master->>Target: Contract.Call(target, method, args)
    Target-->>Master: Result
    Master-->>Relayer: Success or fault
    deactivate Master
```

## 6. Before You Broadcast

Before a production submission, operators should verify:

- the draft body matches the intended target and method
- signer progress satisfies the configured threshold
- the chosen payload mode is the one you actually want to send
- relay readiness is green if using relay submission
- explorer base URL is set if you want receipt links
- collaborator/operator links are rotated if an older scoped URL leaked

## 7. If Something Fails

Use the failure mode to decide where to look next:

- **Wallet connect issue** — browser wallet integration or missing provider
- **Signature count incomplete** — draft collaboration or threshold mismatch
- **Relay readiness warning** — runtime config mismatch or unsupported payload mode
- **Simulation fault** — contract policy or target-call failure
- **Broadcast failure** — network fee, RPC, or signer-side submission problem


## Domain-Assisted Account Workflow

A compatible Neo wallet can batch two invocations into one transaction during account creation:

1. `registerAccount(accountId, verifier, verifierParams, hookId, backupOwner, escapeTimelock)` on the AA master contract
2. `register(domain, ownerHash160)` on the `.matrix` contract

In this repository, the `.matrix` domain is registered to the signer wallet address. V3 has no admin or manager reverse index: that V1/V2 role model was removed, and per-account state is read with `getAccountState(accountIdHash)`. The V2 account-discovery helper that named the removed `getAccountAddressesByAdmin` / `getAccountAddressesByManager` reads has been deleted, so no frontend path targets those reads any more.
