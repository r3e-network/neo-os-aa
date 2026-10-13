# How It Works & Usage Guide

This guide explains the Neo Abstract Account system end to end: what the contract does, how the website is organized, how a user creates and uses an account, how collaboration drafts work, and how transactions finally reach the chain.

## 1. Who This Is For

Use this page if you are trying to answer any of these questions:

- **New user:** What is an Abstract Account and what do I click first?
- **Signer:** What can I review and sign without taking operator actions?
- **Operator:** How do I collect approvals, run relay checks, and submit safely?
- **Integrator:** Which parts are on-chain, off-chain, and server-side?

If you only want one mental model, use this:

> One global AA contract stores account configuration, while each logical account gets a deterministic verify address that routes authorization back through the shared policy-gated engine.

## 2. Mental Model

An Abstract Account in this project is **not** a new smart contract deployed per user.

Instead, the system uses one global master contract plus a deterministic verification account address for each logical account.

```mermaid
flowchart LR
  User[User / Operator] --> UI[Frontend Workspace]
  UI --> Drafts[Draft Store]
  UI --> Relay[Optional Relay API]
  UI --> Master[UnifiedSmartWallet Master Contract]
  Master --> Policies[Roles + Policies + Limits]
  Master --> Target[Target Contract]
  Master --> Proxy[Deterministic Verify Account Address]
```

The result is:

- one shared on-chain execution engine
- zero per-account deployment cost
- isolated account configuration per `accountId`
- support for both native Neo signatures and EVM EIP-712 signatures
- one consistent permission surface for native calls, relay-assisted calls, and meta-transactions
- optional on-chain Paymaster for trustless sponsored/gasless execution

### Account Discovery and Batch Operations

V3 has no admin, manager or threshold state and no reverse indices: that V1/V2 role model was
removed in the V3 rewrite, and the SDK keeps `getAccountsByAdmin`/`getAccountsByManager` only as
stubs that throw `LEGACY_V3_REMOVED`. Per-account state is read with `getAccountState(accountIdHash)`,
one account at a time.

- **Batch creation:** `registerAccounts(UInt160[], UInt160, ByteString[], UInt160, UInt160, Integer)`
  on the deployed core registers several accounts in one transaction; the SDK has no batch payload
  builder, so build one `createAccountPayload` per account and submit them through that entrypoint.
- **Registration authority:** `registerAccount` requires the witness of the `backupOwner` argument
  (`contracts/UnifiedSmartWallet.Accounts.cs:75`), not of the transaction sender.

## 3. Choose the Right Path

Use the path that matches your role and risk profile:

| Situation | Recommended path | Why |
| --- | --- | --- |
| One user, one browser, ready to submit | Client-side broadcast | Simplest and safest default path. |
| Shared review and signature collection | Draft + collaborator link | Lets signers review and approve without operator powers. |
| Gasless / sponsored transaction | On-chain Paymaster + relay | Sponsor deposits GAS, relay submits and gets reimbursed atomically. |
| Relay simulation before submit | Operator link + relay preflight | Shows VM state, gas, and payload details before final submission. |
| EVM wallet approval flow | Meta signature + relay-ready invocation | Keeps EIP-712 signing while preserving Neo policy enforcement. |
| No Supabase configured | Local-only draft flow | Compose, save, and sign in the same browser without cross-device sharing. |

## 4. What the System Contains

Think of the full product as four connected surfaces:

1. **On-chain engine** — the master contract plus deterministic verify path
2. **Frontend workspace** — compose, review, sign, and broadcast UI
3. **Collaboration storage** — immutable draft body plus append-only signatures/activity
4. **Optional server helpers** — relay submission and signed operator mutations

Those surfaces are connected, but they do not all have the same authority. Supabase does not replace the contract permission model, and a shared URL does not by itself bypass operator-only actions.

## 5. What Happens During One Transaction?

Most users interact through the home workspace:

```mermaid
sequenceDiagram
  participant User
  participant Frontend
  participant DraftStore
  participant Wallet
  participant Relay
  participant Chain

  User->>Frontend: Load abstract account
  User->>Frontend: Compose operation
  Frontend->>DraftStore: Persist draft
  User->>Wallet: Sign natively or via EVM typed data
  Wallet-->>Frontend: Signature / approval
  Frontend->>DraftStore: Append signature
  User->>Frontend: Choose client or relay path
  Frontend->>Chain: Client broadcast
  Frontend->>Relay: Relay preflight / relay submission
  Relay->>Chain: Submit wrapped invocation
```

The key design choice is that the downstream target contract is **not** called directly by a raw proxy-signed transaction. Instead, execution routes through `executeUserOp(accountId, op)` (or `executeUserOps(accountId, ops)` for a batch), where the policy engine can enforce verifier, hook and target checks. The V1/V2 wrapper entrypoints were removed and exist in no deployed manifest and no contract source.

## 6. Draft Collaboration Model

The website uses a three-scope draft model:

- **Share link** — read-only review
- **Collaborator link** — signature collection only
- **Operator link** — relay checks, broadcast, receipt updates, and link rotation

That means:

- people reviewing a draft cannot mutate it
- signers cannot impersonate operators
- operators can rotate write-capable links if one leaks
- operator actions still pass through the signed server-side mutation path when configured

## 7. Human-Readable Domain Access

The frontend can use `.matrix` domains as a discovery layer. During account creation, a compatible Neo wallet can submit a single batched transaction that both creates the AA and registers the `.matrix` domain to the signer wallet. Later, the frontend resolves the domain back to the controller wallet address and discovers associated AA addresses through on-chain admin/manager indexes.

## 8. How a User Uses the Website

### For a new user

1. Open **Home**
2. Load or derive the abstract account
3. Choose an operation preset or create a custom invocation
4. Persist the draft
5. Share links depending on the collaborator role
6. Collect approvals
7. Run relay checks if needed
8. Broadcast through a wallet or relay

### For a signer

1. Open the collaborator link
2. Review the draft and operation snapshot
3. Add a manual signature or an EVM typed-data approval
4. Leave relay/broadcast tasks to the operator

### For an operator

1. Open the operator link
2. Monitor signatures and relay readiness
3. Run preflight checks
4. Broadcast client-side or via relay
5. Rotate collaborator or operator links when needed

### For a developer or auditor

1. Read the **Core Architecture** page for contract structure
2. Read the **Workflow Lifecycle** page for execution sequences
3. Read the **Data Flow & Storage** page for boundary ownership
4. Read **SDK Integration** for runtime and relay configuration

## 9. What Gets Stored Where?

The draft body and collaboration state live off-chain, while authority and execution rules live on-chain.

- **On-chain:** admins, managers, thresholds, verifier configuration, whitelist / blacklist rules, dome settings, and transfer limits
- **Browser / Supabase:** immutable draft body, collected signatures, activity timeline, relay preflight snapshots, and bounded submission receipt history
- **Relay server:** simulation, raw transaction forwarding if explicitly enabled, and meta invocation submission when a relay signer is configured

Shared draft metadata is intentionally bounded: the frontend retains only the latest **100 activity entries** and the latest **12 submission receipts** so collaboration records stay lightweight over time.

## 10. Sponsored / Gasless Transactions

The on-chain `AAPaymaster` contract enables users to execute operations without holding GAS:

1. A **sponsor** (dApp, organization, or service) deposits GAS into the Paymaster contract and creates a sponsorship policy specifying which accounts, contracts, methods, and budgets to fund.
2. The **relay** calls `executeSponsoredUserOp` on the AA core with the sponsor and paymaster details.
3. Relays can optionally preflight `validatePaymasterOp`, while the AA core executes the UserOp normally (verifier + hooks) and then atomically settles the reimbursement — deducting from the sponsor's deposit and sending GAS to the relay.

Sponsors can create **per-account policies** (specific accountId) or **global policies** (accountId = Zero) to sponsor any account. Policies support:
- Per-operation GAS limits
- Daily spend budgets (24-hour rolling window)
- Total lifetime budgets
- Target contract and method restrictions
- Expiry timestamps

The Paymaster never replaces the verifier or backup-owner — it only funds the relay after the operation has been fully authorized.

## 11. Key Security Boundaries

Every execution path still flows through the same protection layer:

- account existence checks
- role / threshold verification
- optional custom verifier hook
- dome timeout + oracle unlock path
- method allowlist
- blacklist / whitelist
- max transfer restrictions

The practical security result is:

- deterministic proxy witnesses are limited to hardened AA wrapper flows
- public links are read-only
- collaborator links are signature-only
- operator actions use signed server-side mutations
- direct proxy-signed external spends remain invalid

## 12. Recommended Reading Order

If you are learning the system for the first time, read these pages in order:

1. **How It Works & Usage Guide**
2. **Core Architecture**
3. **Workflow Lifecycle**
4. **Data Flow & Storage**
5. **SDK Integration**

## 13. Glossary

- **Abstract Account** — a logical account identified by an `accountId`, enforced by the shared AA contract
- **Deterministic account address** — the Neo address derived from the `verify(accountId)` script
- **Master contract** — the shared on-chain execution and permission engine
- **Draft** — the off-chain collaboration record containing operation data, signatures, and metadata
- **Collaborator link** — a scoped link for signature collection only
- **Operator link** — a scoped link for relay, broadcast, receipts, and link rotation
- **Relay preflight** — a server-backed simulation of a relay-ready invocation before submission
- **Meta invocation** — the AA payload created from EVM typed-data signatures; it targets `executeUserOp`
- **Account discovery** — reading one account's state with `getAccountState(accountIdHash)`; the V1/V2 reverse indices were removed, so there is no admin/manager role query
- **Batch registration** — registering several accounts in one transaction with `registerAccounts` (no shared governance: every account carries its own verifier, hook and backup owner)
- **Paymaster** — on-chain contract (`AAPaymaster`) that holds sponsor GAS deposits and reimburses relays after successful execution
- **Sponsor** — an address that deposits GAS into the Paymaster and creates policies to fund operations for other accounts
- **Sponsorship policy** — configuration defining which accounts, contracts, methods, and budgets a sponsor will fund
- **Settlement** — atomic post-execution step where the Paymaster deducts from the sponsor deposit and sends GAS to the relay
