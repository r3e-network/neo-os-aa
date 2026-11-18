# Contract Data Flow & Storage

The Smart Account model centralizes all on-chain authority inside the **Master Entry Contract**, while using the browser, Supabase, and optional relay services to improve usability and collaboration.

## 1. System Boundaries

The easiest way to understand the system is to separate it into trust boundaries.

```mermaid
flowchart LR
  Browser[Browser / UI]
  Local[localStorage fallback]
  Supabase[Supabase draft store]
  Relay[Relay + signed operator APIs]
  Chain[Neo N3 chain]

  Browser --> Local
  Browser --> Supabase
  Browser --> Relay
  Browser --> Chain
  Relay --> Chain
```

Those boundaries do different jobs:

- **Browser** prepares invocations, displays readiness, and holds temporary UI state
- **localStorage** preserves local-only drafts when Supabase is absent
- **Supabase** stores collaborative draft data and scoped links
- **Relay APIs** simulate or submit relay-ready payloads and accept signed operator mutations
- **Neo N3 chain** stores the real account rules and executes the final call

## 2. Data Ownership Matrix

| Boundary | What lives there | Who can mutate it | Why it exists |
| --- | --- | --- | --- |
| On-chain master contract | Admins, managers, thresholds, whitelist / blacklist, verifier, dome, limits, nonces | Authorized SA governance flows | Source of truth for authorization and execution |
| Browser memory | Current workspace state, selected payload mode, active wallet session | Current browser session | Fast UX and staging |
| `localStorage` fallback | Local-only drafts and preferences | Same browser only | Offline / no-Supabase development path |
| Supabase | Draft body, append-only signatures, bounded activity, bounded receipts, scoped slugs | Scope-limited collaboration flows | Shared review and multi-party coordination |
| Relay server | Simulation results in flight, relay signer use, signed operator mutation validation | Server config + signed operator requests | UX helper for relay and operator-only actions |

## 3. Mutation Authority by Boundary

Not every boundary is allowed to mutate the same data.

```mermaid
flowchart TD
  Public[Public share link] --> ReadOnly[Read-only access]
  Collaborator[Collaborator link] --> SigOnly[Signature-only append path]
  Operator[Operator link] --> SignedServer[Signed operator mutation route]
  SignedServer --> Receipts[Receipts / relay preflight / rotation / status]
  Chain[On-chain execution] --> Policy[Final policy enforcement]
```

Practical meaning:

- public viewers can inspect a draft but cannot mutate it
- collaborators can add signatures but cannot append operator-class relay activity
- operators can request higher-sensitivity mutations, but the server still validates signed intent
- the chain remains the final authority for whether the transaction is valid

## 4. Storage Schema On-Chain

The contract utilizes a unified internal storage mapping where keys are derived by concatenating a static prefix with a hashed representation of the user's `accountId`.

```mermaid
flowchart TD
    A[Master Contract Storage] --> B(Admins Map)
    A --> C(Managers Map)
    A --> E(Limits & Restrictions)

    B --> B1[Prefix: 0x01 + sha256(accountId)]
    C --> C1[Prefix: 0x03 + sha256(accountId)]
    D --> D1[Prefix: 0x0E + sha256(accountId)]
    E --> E1[Prefix: 0x09 / 0x0B / 0x0C composite keys]
```

## 5. Internal Data Flow During Execution

When an execution command enters the Master Contract, it flows through a rigid pipeline of isolation, verification, and restriction checks before any external smart contract is called.

```mermaid
flowchart TD
    Start[Transaction Payload Received] --> HasID{Account ID Valid?}
    HasID -- Yes --> ActiveLock{Execution Lock Active?}
    HasID -- No --> Reject[Revert: Invalid ID]

    ActiveLock -- Yes --> RejectLock[Revert: Re-entrancy Blocked]
    ActiveLock -- No --> Lock[Apply Execution Lock]

    Lock --> CustomVer{Custom Verifier Set?}

    CustomVer -- Yes --> CallCustom[Contract.Call verifier.verify]
    CallCustom --> AuthResult

    CustomVer -- No --> CheckNative[Evaluate M-of-N Thresholds]
    CheckNative --> AuthResult{Authorized?}

    AuthResult -- Yes --> CheckBlacklist{Target Blacklisted?}
    AuthResult -- No --> RejectAuth[Revert: Unauthorized]

    CheckBlacklist -- Yes --> RejectBL[Revert: Target Blacklisted]
    CheckBlacklist -- No --> CheckWhitelist{Whitelist Enabled?}

    CheckWhitelist -- Yes --> InWhitelist{Target in Whitelist?}
    InWhitelist -- No --> RejectWL[Revert: Not Whitelisted]
    InWhitelist -- Yes --> TokenCheck
    CheckWhitelist -- No --> TokenCheck

    TokenCheck{Is Token Transfer?}
    TokenCheck -- Yes --> OverLimit{Amount > Max Transfer?}
    OverLimit -- Yes --> RejectLimit[Revert: Exceeds Limit]
    OverLimit -- No --> Execute
    TokenCheck -- No --> Execute

    Execute[Dynamic Call to Target Contract] --> Unlock[Remove Execution Lock]
    Unlock --> End[Transaction Success]
```

## 6. Relay and Signed Operator Mutation Flow

The relay and operator helper paths exist to improve usability, not to replace the contract.

```mermaid
sequenceDiagram
  participant Browser
  participant Supabase
  participant OperatorAPI as draft-operator API
  participant RelayAPI as relay-transaction API
  participant Chain

  Browser->>Supabase: Read or append draft collaboration data
  Browser->>OperatorAPI: Send signed operator mutation request
  OperatorAPI->>Supabase: Persist operator-class change
  Browser->>RelayAPI: Request simulation or relay submission
  RelayAPI->>Chain: Simulate or submit supported payload
```

## 7. Retention and Practical Limits

The collaborative metadata layer is intentionally bounded:

- latest **100 activity entries** retained
- latest **12 submission receipts** retained
- immutable draft body preserved separately from append-only signature history

This keeps long-lived drafts explainable and reviewable without letting metadata grow without limit.

## 8. Storage Key Prefixes Table

| Prefix Identifier | Hex Value | Purpose |
| :--- | :---: | :--- |
| `AdminsPrefix` | `0x01` | Serialized array of admin addresses. |
| `AdminThresholdPrefix` | `0x02` | Integer threshold for admins. |
| `ManagersPrefix` | `0x03` | Serialized array of manager addresses. |
| `ManagerThresholdPrefix` | `0x04` | Integer threshold for managers. |
| `BlacklistPrefix` | `0x09` | Composite key for blocked external contracts. |
| `WhitelistPrefix` | `0x0B` | Composite key for allowed external contracts. |
| `MaxTransferPrefix` | `0x0C` | Composite key for token transfer caps. |
| `VerifierContractPrefix` | `0x12` | Script hash of custom verifier logic. |

## Matrix Domain Resolution Boundary

The `.matrix` contract is an external naming boundary. It does not replace SA authorization state. Instead, the frontend resolves a `.matrix` domain to a controller wallet address and then queries SA admin/manager address indexes to find the corresponding bound SA addresses.
