# Abstract Account Workflow Lifecycle

This page describes the active V3 workflow built around `UnifiedSmartWalletV3` and `executeUserOp(accountId, op)`.

Direct proxy-signed external calls are intentionally rejected after hardening. The supported V3 execution path is the core wallet's `executeUserOp`.

## App Workspace

The app workspace is the primary V3 operator surface.

- Load an account from a deterministic seed or 20-byte `accountId` hash.
- Derive the virtual Neo address locally.
- Stage a `UserOperation`.
- Persist an immutable draft.
- Collect Neo and EVM approvals.
- Choose client-side broadcast or relay broadcast.

The public share link is read-only, the collaborator link can append signatures, and the operator link can run relay checks, broadcasts, and link rotation. Shared drafts keep only the latest 100 activity entries and 12 submission receipts.

If Supabase is not configured, the same flow falls back to local-only `localStorage` persistence in the current browser.

## 1. First Transaction Walkthrough

1. **Load the account** from a deterministic seed or `accountId` hash.
2. **Choose the operation** with Generic Invoke, NEP-17 Transfer, or Multisig Draft.
3. **Stage the operation** as a V3 `executeUserOp` payload.
4. **Persist the draft** before collecting external approvals.
5. **Collect signatures** from Neo, EVM, or both.
6. **Review relay readiness** and choose the payload mode.
7. **Broadcast** with a Neo wallet or submit via relay.

```mermaid
flowchart LR
  Load[Load V3 Account] --> Compose[Compose UserOperation]
  Compose --> Persist[Persist Immutable Draft]
  Persist --> Sign[Collect Signatures]
  Sign --> Review[Review Readiness]
  Review --> Submit[Submit via Wallet or Relay]
  Submit --> Receipt[Track Receipt + Timeline]
```

## 2. Choose the Submission Path

| Path | Best for | Requirements | Tradeoff |
| --- | --- | --- | --- |
| Client-side broadcast | Native Neo wallet users | Browser wallet connected | Simplest and most transparent |
| Relay preflight | Operators who want simulation before submit | Relay endpoint configured | Adds server dependency, but gives VM/gas feedback |
| Relay raw submission | Existing signed raw transaction | Raw forwarding explicitly enabled | Compatibility-only passthrough |
| Relay invocation submission | EVM/UserOperation flows | Relay signer plus relay invocation mode | Most flexible form of relay broadcast for mixed-signature workflows |

When both raw and relay-ready invocation payloads exist, the UI exposes **Best Available**, **Signed Raw Tx**, and **Relay Invocation**.

## 3. Collaboration Lifecycle

```mermaid
sequenceDiagram
    actor Creator
    actor Signer
    actor Operator
    participant Store as Draft Store

    Creator->>Store: Create draft and publish scoped links
    Signer->>Store: Append signature via collaborator scope
    Operator->>Store: Run relay preflight / broadcast / rotate links
```

## 4. Native Neo Execution

```mermaid
sequenceDiagram
    actor User as Backup Owner / Plugin-Authorized User
    participant Wallet as Neo Wallet
    participant Core as UnifiedSmartWalletV3
    participant Target as Target Contract

    User->>Wallet: Approve executeUserOp(accountId, op)
    Wallet->>Core: Submit executeUserOp
    Core->>Core: Check deadline + consume nonce
    Core->>Core: Validate verifier or backup owner witness
    Core->>Core: Run preExecute hook if configured
    Core->>Target: Contract.Call(target, method, args)
    Target-->>Core: Result
    Core->>Core: Run postExecute hook if configured
```

## 5. EVM / Web3Auth Execution

```mermaid
sequenceDiagram
    actor EVM as EVM Wallet / Web3Auth
    participant Browser as Frontend
    participant Relay as Relay
    participant Core as UnifiedSmartWalletV3
    participant Verifier as Web3AuthVerifier

    Browser->>Core: Read verifier + nonce + argsHash
    Browser->>EVM: Request EIP-712 UserOperation signature
    EVM-->>Browser: Return typed-data signature
    Browser->>Relay: Submit relay-ready invocation
    Relay->>Core: executeUserOp(accountId, op)
    Core->>Verifier: validateSignature(accountId, op)
    Verifier-->>Core: true / false
```

## 6. Before You Broadcast

- Verify the `accountId` is the intended one.
- Confirm the target contract, method, and args.
- Check signer progress against the required approvals.
- Confirm whether you are sending raw tx bytes or a relay-ready invocation.
- Run relay preflight before relay submission when possible.
- Rotate scoped links if an older collaborator/operator URL leaked.

## 7. Historical Compatibility Note

Legacy `executeUnifiedByAddress` payloads can still appear in old drafts, but the wrapper was removed in the V3 rewrite: no deployed manifest and no contract source defines it, so a transaction naming it fails in its verify phase. New integrations should target `executeUserOp`.
