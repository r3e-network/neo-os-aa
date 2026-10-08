# Neo N3 Abstract Account Security Model

## Runtime and authority versions (2026-10-08 convergence)

Ordinary deployed `UnifiedSmartWallet` remains the public `v3` implementation
from the tested main branch; its separate `PLATFORM` build retains 10 GAS bounded
verifier callbacks. Neither is the native AccountManagement service. Native ABI 2
uses a 1 GAS verifier budget (within the 1.5 GAS verification envelope), 2.5 GAS
hook/maintenance budgets, and explicit epoch-aware module packaging.

Native recovery now requires a checked authority-epoch and configuration-nonce
advance, detaches old roots/dependencies without calling old modules, and leaves
identity, asset address, execution nonce and frozen state unchanged. All module
storage uses `0xA2 || policyPrefix || accountIdLE20 || authorityEpochLE64 || suffix`. The native four-argument execution envelope commits both counters in the unsigned
transaction script, covering custody fallback and native transaction witnesses;
operation-signature preimages also bind them. Prior-generation
keys or signatures cannot be restored by reinstalling a module. This is distinct
from ordinary `finalizeEscape`, whose old-module cleanup can still fail closed.
The normative rules are in `docs/proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md`.
Historical receipts below describe their pinned ABI 1 or ordinary-contract
snapshots. They do not certify the changed ABI 2 source, SDK or runtime.


## Executive Summary

The Neo N3 Abstract Account system implements a policy-gated, plugin-based account abstraction architecture. This document defines the threat model, trust assumptions, security properties, and defense-in-depth mechanisms across all layers of the system.

The deployed-contract profile is not automatically compatible with native
AccountManagement. The native NeoNativeVerifier, WhitelistHook, SessionKeyVerifier,
DailyLimitHook and TokenRestrictedHook historical ABI 1 profiles
have private-chain evidence for actual witnesses, exact invocation grants,
delayed configuration, rollback and cleanup. The remaining modules still require
their own native-profile adaptation and validation. The consolidated evidence is
`docs/reports/aa-native-restricted-validation-20261008.json`; the detailed
scope is `docs/proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.md`. None of these
receipts establishes complete cryptographic or compiler refinement.

The native SessionKey profile uses the canonical operation preimage, actual
P-256 signatures and the registered asset proxy. Its Verification clock must
use persisted ledger time: Runtime.Time is unavailable when no persisting block
exists. The private matrix distinguishes witness admission rejection from
persisted Application FAULT and checks real GAS transfer rollback when a capped
transfer returns false. Ordinary session configuration/revocation remains delayed;
immediate freeze requires a configured recovery authority. This is not a promise
of immediate session revocation or proof of an arbitrary token's semantics.
Rotation preserves spent allowance. Reducing a positive cap below the amount
already spent blocks even zero-amount transfers; at the exact cap, zero transfers
remain admissible. Explicit delayed revocation clears the key and allowance but
retains the rotation timestamp, whereas account cleanup removes all four session
prefixes. The private lifecycle matrix checks these distinct effects.
The additional scope matrix is
`docs/reports/aa-native-session-scope-validation-20261007.json`. Zero means no
session spending cap, not zero allowance. A wildcard method remains bound to one
target but can authorize its entire value-moving surface; a whole-balance GAS
transfer is exercised. Uncapped Boolean-false HALT consumes nonce and updates
last-use metadata, whereas target FAULT rolls back. Capped false transfers still
fault. The event exposes the exact scope and uncapped flag.

The historical ABI 1 replay restored identical signature bytes after regrant
when nonce/deadline still permitted them. ABI 2 closes that behavior: every
configuration transition changes configurationNonce in the signing domain;
recovery additionally advances authorityEpoch. Regranting the same public key
cannot revive a pre-transition signature. The ABI 2 matrix must retain the old
bytes and reject them after regrant, then accept a freshly signed operation.
Old ABI 1 receipts remain historical evidence and must not be relabelled.

DailyLimitHook native-profile evidence is recorded separately in
`docs/reports/aa-native-daily-balance-validation-20261007.json`. Its net-outflow meter
uses every configured token's proxy balance rather than inferring success from
the target return value. False results leave no persistent snapshot. Fixed
window anchors do not slide on subsequent transfers; rolling history has an
explicit live-record bound. Arbitrary tokens must still provide honest balances,
and callback-budget sufficiency for arbitrary configurations remains unproven.
The single-token fifty-record capacity was initially unreachable: repeated
history scans exhausted a callback budget on record 21. Single-pass sum/count
and post-execution pruning fix that measured case without changing the budget.
The diagnostic token's real balance writes verify false-result accounting and
over-limit rollback; it deliberately violates NEP-17 success semantics and is
not a production token. Nested GAS calls do not inherit the proxy witness from
the active target; this restriction is tested, not relaxed.
Negative and non-Integer balance replies, query faults and query gas exhaustion
are rejected in both hook phases on two private chains. Post-hook rejection
rolls back the diagnostic token's actual raw balance/mode storage together with
nonce and policy state. Removing the faulty token limit through delayed
configuration restores a successful GAS operation without querying that token.
This is bounded recovery evidence, not immediate availability or a proof that
arbitrary tokens report honest balances. No callback budget was raised.

The native TokenRestrictedHook rejects direct interaction with a restricted
token and rejects any observed restricted-token net outflow through another
target, independently of the target's return value. Its private diagnostic
router has an explicit token-side delegation; it does not inherit native proxy
witness authority. Inflows and zero-net movement remain allowed. Strict balance
types, query faults, inherited gas exhaustion, raw-storage rollback, delayed
removal and both-prefix cleanup are exercised. Missing-snapshot rejection has a
source guard and an abstract proof; a separate unchanged-NEF host probe now
deletes an actual snapshot between authenticated callbacks and verifies
rejection and parent-store rollback. That diagnostic injection is not a
persisted on-chain attack. The host also covers every VM stack-item type with
representative balance replies in both phases and verifies stale-snapshot cleanup
isolation. Post-phase type rejection rolls back the diagnostic mode write,
account nonce and transient snapshot. Direct calls without phase authority and
host-injected malformed callback Arrays reject. These diagnostic injections do
not establish that malformed callbacks are reachable through the native parser.
Full-NEF measured instruction/conditional-edge coverage is 83.64%/68.13%, below
the completion threshold; it is not C# source coverage. See
`docs/reports/aa-native-nef-phases-validation-20261008.json`. Arbitrary token
honesty, gross intermediate movement, large configured sets and complete C#/NEF
branch coverage remain outside the demonstrated scope.

---

## 1. Threat Model

### 1.1 Attackers

| Attacker Type | Capabilities | Primary Attack Vectors |
| --- | --- | --- |
| **External Attacker** | No private keys, can submit transactions | Replay, gas DoS, front-running, signature forgery |
| **Compromised Verifier** | Control of verifier signing key | Unauthorize withdrawals, bypass hooks |
| **Compromised Relay** | Can submit to bundler/relay | Censorship, front-running, selective relay |
| **Compromised TEE Node** | TEE private key access | Unlimited automated transactions |
| **Compromised Paymaster Sponsor** | Sponsor wallet private key | Policy manipulation, deposit withdrawal |
| **Stolen Cold Wallet** | Backup owner private key | Escape hatch takeover |
| **Smart Contract Developer** | Plugin code deployment | Logic bugs, backdoors, malicious hooks/verifiers |

### 1.2 Assets at Risk

| Asset | Protection Mechanism | Threat Level |
| --- | --- | --- |
| **Native Neo Tokens** (NEO, GAS) | Verifier signature + Hook policies + Nonce | High |
| **NEP-17 Tokens** | Verifier signature + Hook policies + Nonce | High |
| **NFTs / SBTs** | Verifier signature + Hook policies + Nonce | Medium |
| **Account Control** (Verifier, Hooks, BackupOwner) | Timelocks, authority checks | Critical |
| **Reputation / Identity** | NeoDID binding + Credential hooks | Medium |

---

## 2. Trust Assumptions

### 2.1 Layer 1: Neo N3 Blockchain

| Assumption | Rationale | Risk if Violated |
| --- | --- | --- |
| **NeoVM is sound** | Code execution is deterministic | Global consensus failure |
| **Cryptography is secure** | secp256k1/r1 are battle-tested | Private key recovery via weaknesses |
| **Consensus fault bound holds** | Byzantine validators remain within the deployed consensus protocol's tolerated fault bound | Safety or liveness can fail beyond that bound |

### 2.2 Layer 2: Core Contract

| Assumption | Rationale | Risk if Violated |
| --- | --- | --- |
| **Verifier plugins are honest** | Signature = authorization | Malicious verifier drains funds |
| **Hook plugins don't censor** | Policies only reject, not modify | Hook prevents valid operations |
| **Backup owner is secure** | L1 escape mechanism | Account takeover without recovery |

### 2.3 Layer 3: Plugin Ecosystem

| Assumption | Rationale | Risk if Violated |
| --- | --- | --- |
| **Plugin deployment is authorized** | Only backup owner can install | Unauthorized plugin installation |
| **TEE enclaves are secure** | Hardware-level isolation | TEE key compromise |
| **Relays are semi-honest** | Multiple competing relays | Censorship or front-running |
| **Paymaster is solvent** | On-chain deposit balance or off-chain gas sponsorship | Failed transactions if deposit exhausted |
| **Paymaster policy is honest** | Sponsor controls policy creation | Sponsor can revoke/expire policies at will |

### 2.4 Layer 4: Frontend & SDK

| Assumption | Rationale | Risk if Violated |
| --- | --- | --- |
| **User's device is secure** | Private key storage | Key theft via malware |
| **RPC endpoints are honest** | Transaction submission | Transaction censorship |
| **Supabase is secure** | Draft/collaboration storage | Draft manipulation |

---

## 3. Security Properties by Layer

### 3.1 Core Contract Layer

| Property | Implementation | Threat Mitigated |
| --- | --- | --- |
| **Integrity** | State in `UnifiedSmartWallet` | Contract can't be modified without deployer |
| **Confidentiality** | No confidentiality guarantee from account abstraction | Transaction and stored contract data are public; secrets must not be placed on-chain |
| **Availability** | No per-account deployment | Single point of failure |
| **Non-repudiation** | Nonce + Deadline | Sender can't deny transaction |
| **Replay Protection** | Nonce + Network ID + Deadline | Can't replay on same/different chain |
| **Operation Shape** | Target/method/argument/serialization/signature/batch bounds | Rejects malformed and resource-amplifying input before execution |

### 3.2 Verification Layer

| Property | Implementation | Threat Mitigated |
| --- | --- | --- |
| **Authentication** | Verifier signature checks | Unauthorized ops rejected |
| **Authorization** | Backup owner / Verifier separation | Privilege escalation prevented |
| **Freshness** | Nonce increment / Salt consumption | Replay rejected |
| **Cross-chain isolation** | `Runtime.GetNetwork()` in payload | Can't replay across networks |

### 3.3 Policy/Hook Layer

| Property | Implementation | Threat Mitigated |
| --- | --- | --- |
| **Transfer limits** | `DailyLimitHook` | Large thefts mitigated |
| **Target allowlisting** | `WhitelistHook` | Fraudulent contract interaction blocked |
| **Token restrictions** | `TokenRestrictedHook` | Unauthorized token transfers blocked |
| **Credential gating** | `NeoDIDCredentialHook` | Unverified users blocked |
| **Composability** | `MultiHook` | Combined policies enforce AND logic |

### 3.4 Recovery Layer

| Property | Implementation | Threat Mitigated |
| --- | --- | --- |
| **L1 fallback** | Backup owner native witness | Verifier failure recovery |
| **Delayed takeover** | Escape timelock (7-90 days) | Immediate takeover prevented |
| **Activity cancellation** | Normal ops cancel escape | Stolen wallet can't quietly takeover |
| **Auditability** | Escape events logged | Recovery attempts visible |

---

## 4. Defense-in-Depth Architecture

```mermaid
flowchart TD
    subgraph Layer1["Layer 1: Blockchain"]
        NeoVM["Neo VM Consensus"]
        Crypto["Cryptographic Primitives"]
    end

    subgraph Layer2["Layer 2: Core Contract"]
        NonceCheck["Nonce + Deadline Check"]
        ExecLock["Reentrancy Lock"]
        AuthCheck["Verifier/BackupOwner Auth"]
    end

    subgraph Layer3["Layer 3: Plugin System"]
        Verifiers["Verifier Plugins"]
        Hooks["Hook Plugins"]
    end

    subgraph Layer4["Layer 4: Off-Chain"]
        TEE["TEE Nodes"]
        Relay["Relay Server"]
        Paymaster["Paymaster Service"]
        Frontend["Frontend + SDK"]
    end

    Attack["External Attacker"] --> Layer1
    Layer1 --> Layer2
    Layer2 --> Layer3
    Layer3 --> Layer4
```

### Layer 1: Blockchain Primitives
- **NeoVM:** Deterministic execution, bounded gas
- **Cryptography:** secp256k1 (EVM), secp256r1 (Passkey/TEE), SHA256, Keccak256

### Layer 2: Core Contract
- **Nonce + Deadline:** Replay protection
- **Execution Lock:** Reentrancy prevention (`IsAnyExecutionActive()`)
- **Verify Context:** Limits `CheckWitness(accountId)` to execution context
- **Authority Separation:** Verifier (who) vs Hook (what) vs Core (how)

### Layer 3: Plugin System
- **Verifier Isolation:** Stateless, no direct state access
- **Hook Gating:** Pre/post execution policies
- **Authority Validation:** `CanConfigureVerifier` / `CanExecuteHook` checks
- **Module Lifecycle:** Timelocked updates with events

The core passes hook callbacks a single canonical operation tuple in both phases:
`[TargetContract, Method, Args, Nonce, Deadline, Signature]`; the account id remains a separate
callback argument. This prevents a hook from validating one operation representation and metering
another. A real NeoVM regression vector confirms that `WhitelistHook` accepts the signed target,
rejects an unlisted target before dispatch, and rolls back the nonce on rejection.

### Layer 4: Off-Chain Infrastructure
- **TEE Attestation:** Hardware root of trust (future)
- **Relay Diversity:** Multiple competing relays prevent censorship
- **Paymaster Policy:** Off-chain sponsorship rules
- **Frontend Sanitization:** Input validation, error message stripping

---

## 5. Critical Security Invariants

### 5.1 Must-Hold Invariants

1. **Nonce Monotonicity:** Nonces never decrease within a channel
2. **Deterministic Address:** Same `accountId` always resolves to same address
3. **Replay Prevention:** Same operation cannot execute twice
4. **Context Isolation:** `CheckWitness(accountId)` only valid during `executeUserOp`
5. **Escape Atomicity:** Either completes fully or not at all
6. **Market Escrow Exclusivity:** Escape/initiative changes blocked during escrow

### 5.2 Should-Hold Invariants

1. **Gas Limits on Verifiers:** *(PROFILE DEPENDENT)* The private `PLATFORM` core uses a 10 GAS child budget for each verifier callback on the matching runtime. Public `v3` uses standard `System.Contract.Call` and has no child budget; lifecycle admission, simulation and transaction fee ceilings do not establish one. Historical private runtime evidence requires revalidation after source/runtime changes.
2. **Plugin State Cleanup:** *(PARTIAL)* Current settlement clears known plugin markers and rejects modules whose manifest omits the V3 lifecycle ABI; semantic cleanup/refinement coverage for arbitrary future plugins is pending.
   Every verifier and hook must implement `clearAccount`: the core calls it without a fallback from
   `confirmVerifierUpdate`, `confirmHookUpdate`, `finalizeEscape` and `settleMarketEscrow`, and a
   nested call to a missing method faults the enclosing transaction uncatchably. The
   `SocialRecoveryVerifier` source now implements it (core-gated, oracle credit refunded to the
   recovery owner, consumed action nullifiers retained as replay protection). The recovery verifier
   artifacts recorded as deployed on TestNet and MainNet predate this method, so an account bound to
   a deployed instance cannot rotate away from it, finalize an escape or be sold until that instance
   is upgraded through its timelocked `proposeUpdate`/`update` path.
3. **Session Key Revocation:** *(DEFINED)* Revocation is effective at canonical transaction execution order; a later validation sees no active key, and `SessionKeyRevoked` is emitted. No protocol component promises mempool cancellation or retroactive invalidation of an operation already executed earlier in the chain.
4. **Transfer-Source Metering:** A virtual account's assets live at the core-derived proxy script
   hash (`getProxyScriptHash(accountId)`), never at the `accountId`. A verifier or hook that pins or
   meters a transfer source must compare against that proxy address; `SubscriptionVerifier` and
   `DailyLimitHook` do so, and a source equal to the `accountId` is rejected outright.
5. **Plugin-Level Witness Checks Need a Reaching Scope:** A verifier or hook runs as a nested call
   from the core, so a `Runtime.CheckWitness` inside it (the merchant check in
   `SubscriptionVerifier`, for example) only sees signers whose scope reaches the plugin.
   `CalledByEntry` stops at the core and is rejected; the private-chain validation records that
   fault and the successful pull with a reaching scope. A merchant scopes its signer to the
   verifier with `CustomContracts` rather than signing `Global`.

---

## 6. Attack Surface Analysis

### 6.1 Known Vulnerabilities

| ID | Severity | Component | Description | Status |
| --- | --- | --- | --- |
| **VULN-001** | Critical | **Verifier Gas DoS** | Public `v3` permits lifecycle-compatible verifier callbacks through standard `Contract.Call` without a child budget | Open for public arbitrary-verifier sponsorship; historical private `PLATFORM` evidence only |
| **VULN-002** | High | **Escape Hatch Bypass** | Market settlement intentionally clears escape; owner cancellation is timelocked | Mitigated in source; refinement/deployment unverified |
| **VULN-003** | Medium | **Session Key Ordering** | A signed operation can execute before a later revocation transaction is ordered | Defined execution-order semantics; residual pre-inclusion operational risk |
| **VULN-004** | Medium | **MultiSig Composition Boundary** | Empty, oversized, invalid-threshold, duplicate, self-referential, incomplete-child, and signer-domain-reuse configurations | Bounded Coq policy + 368 VM tests + private NeoExpress child manifest/domain preflight and revalidation; shipped-profile cryptographic vectors are covered, while private-key independence is not inferable from public keys and arbitrary future plugins remain a declared trust boundary |
| **VULN-005** | Medium | **Plugin State Orphaning** | Settlement cleanup is finite and not proven for every plugin | Core-owned leaf dependency registries, manifest lifecycle preflight, and fail-closed cleanup for MultiSig/MultiHook; arbitrary-plugin storage/refinement coverage remains open |
| **VULN-006** | Low | **Nonce Collision** | Executable nonces use 191-bit channel + 64-bit sequence within the non-negative signed NeoVM Integer range | Replay/sequence properties verified within the representable domain; the foundation query API still admits wider non-executable channels and is not native-profile conformance; public deployment is excluded |

**VULN-001 closure gate:** a transaction-wide gas limit or voluntary
`Runtime.GasLeft`/`BurnGas` accounting is insufficient. The current private
artifact instead uses the platform-level `System.Contract.CallWithGasLimit`
capability. Its 1,000,000,000-datoshi (10 GAS) budget is charged against the
child and every ancestor before counters mutate; ordinary nested calls inherit
the budget and fee whitelisting cannot bypass it. The matching core passes 9/9
targeted vectors and 1,435/1,435 full unit tests. The matching AA artifact
passes 292/292 contract tests, and the private NeoExpress receipt drives a
burning verifier to `Contract call gas limit exceeded` with nonce rollback and
25-artifact RPC readback parity. See
`docs/reports/aa-platform-gas-cap-20260921.json` and
`docs/reports/aa-neoexpress-gas-cap-20260921.json`. VULN-001 is mitigated for
this private integrated artifact; public activation and deployment remain
pending. These dated receipts describe the private artifact tested then, not the
current public `contracts/bin/v3` build. The source lock scopes
`VerifierGasBudget.v` to bounded `PLATFORM` and native callbacks; native ABI 2
uses a separate 1 GAS verifier budget and 2.5 GAS hook/maintenance budget. A
passing formal run does not close public VULN-001.

**Public admission policy:** the on-chain lifecycle ABI preflight is a compatibility
check and does not certify a module's trustworthiness, resource use, upgrade policy or
nested dependencies. Permissionless account configuration does not oblige a relay to
sponsor that configuration. A public sponsor must bound its transaction exposure and
admit only reviewed verifier/hook configurations, including mutable child modules and
upgrade authority; it must re-check the configuration and simulation before signing.
An absent reviewed admission policy means arbitrary-module sponsorship is not ready for
production. These operational controls reduce sponsor exposure without claiming the
non-bypassable callback budget that only the private runtime supplies.

**Witness/callback evidence boundary:** the runtime suite now covers bounded proxy-script shape
vectors (wrong account, arbitrary/non-data instructions, decoy/global signer, and fee-payer
cases) and the shipped hook callback tuple, and the transaction-script shape parser itself has a
closed Coq model (`formal/coq/ProxyWitnessScript.v`) proving that an accepted script is data
pushes followed by exactly the expected core call, with the account id and core hash bound.
The bounded callback model (`formal/coq/CallbackPluginTopology.v`) additionally proves the
six-field callback binding, the complete success order through hook and verifier post-callbacks,
CalledByEntry/Custom target binding, and
fail-closed cleanup/rotation invariant. These are implementation evidence plus abstract proofs,
not a formal proof of NeoVM witness-condition evaluation, signer scopes, cryptographic
primitives, arbitrary plugins, or C#-to-NEF callback refinement.
The isolated NeoExpress receipt now also drives the concrete boundary with independently
bounded verifier and hook callbacks plus a hand-built,
P-256-signed transaction: a real proxy verification script is carried by a `WitnessRules`
signer scoped to both the AA core and `NeoDIDRegistry`, consumes an action ticket, and rejects
same-nullifier replay and action-id retargeting. The receipt deploys 25 artifacts, runs 14
scenarios, and reads every deployed artifact back with byte-identical NEF scripts, matching
checksums, and semantically equal manifests over RPC. This is private-chain
evidence only; it does not prove arbitrary witness rules, cryptography, full NeoVM semantics,
or public deployment parity. The same receipt includes bare P-256 WebAuthn/TEE payload
vectors, delegated ZkLogin provider/nullifier binding, and the disabled ZKEmail fail-closed
path. The formal `NeoVmCallSubset.v` model closes only the proxy-relevant bounded instruction
shape; complete NeoVM/ApplicationEngine semantics remain outside this model.
The core also rejects oversized verifier signatures and argument arrays before nonce
consumption or external dispatch. This is input-amplification mitigation only; it cannot cap a
verifier that is already executing inside the shared NeoVM gas budget.
A read-only RPC comparison of the known canonical TestNet/MainNet AA core hashes also
found different NEF scripts than the current local artifact. This is a detected deployment
drift, not a current-artifact deployment proof; no public write was performed.

### 6.2 Mitigated Attack Vectors

| Attack | Mitigation | Status |
| --- | --- | --- |
| **Signature Replay** | Nonce + Network ID + Deadline | ✓ Mitigated |
| **Reentrancy** | Execution lock + Context isolation | ✓ Mitigated |
| **Cross-Chain Replay** | `Runtime.GetNetwork()` in all payloads | ✓ Mitigated |
| **Front-Running** | Nonce prevents same-op reuse | ✓ Mitigated |
| **Hook Censorship** | Hooks only reject, don't modify | ✓ Mitigated |
| **Verifier Bypass** | Authority checks on all calls | ✓ Mitigated |
| **Market Escrow Censorship** | Backup owner's timelocked `initiateMarketEscrowCancel` / `forceCancelMarketEscrow`; the market `abandonListing` callback is pre-flighted through the market's manifest so a destroyed, upgraded-away, method-less or throwing market cannot block the escape | ✓ Mitigated (see boundary below) |
| **Paymaster Front-Running** | On-chain atomic settlement; off-chain decision pre-submission | ✓ Mitigated (on-chain) / Partially mitigated (off-chain) |
| **Paymaster Deposit Drain** | Per-op limits + daily budgets + total budgets | ✓ Mitigated |
| **RPC Censorship** | Multiple relays + client-side broadcast | ✓ Mitigated |

**Market escrow trust boundary:** entering an escrow delegates settle authority to the market
contract. `settleMarketEscrow` and `cancelMarketEscrow` are authorized purely by
`CallingScriptHash == marketContract`, so a hostile market that the backup owner listed on can
settle the account to any address it chooses; no owner action is required. The owner escape
therefore protects against a market that is destroyed, upgraded without `abandonListing`, never
settles, or throws. It does not protect against a market that aborts inside its own
`abandonListing`, and it cannot: NeoVM `ASSERT`/`ABORT` faults are uncatchable and no
call-site guard exists. Only list accounts on audited markets; the shipped `AAAddressMarket`
allowlists the core it trusts, and the same allowlisting discipline applies in the other direction.

---

## 7. Cryptographic Security

### 7.1 Signature Schemes

| Scheme | Curve | Key Size | Security Level | Use Cases |
| --- | --- | --- | --- |
| **Neo Native** | secp256r1 | 256-bit | Backup owner |
| **EVM/EIP-712** | secp256k1 | 256-bit | Web3Auth |
| **WebAuthn/Passkey** | secp256r1 | 256-bit | Biometrics |
| **TEE** | secp256r1 | 256-bit | Automated agents |
| **Session Key** | secp256r1 | 256-bit | Temporary delegation |

### 7.2 Hash Functions

- **SHA256:** Used for payload hashing in most verifiers
- **Keccak256:** Used for `Web3AuthVerifier` EIP-712 compatibility
- **Nonce Storage:** Executable nonces have a 191-bit channel and 64-bit sequence. Native-profile keys reserve 24 bytes for the channel with the high bit clear; cursor `2^64` is an explicit exhaustion sentinel. The ordinary foundation uses its existing variable-width key encoding and still admits wider, non-executable channel queries.

### 7.3 Replay Protection Mechanisms

1. **Nonce:**
   - Canonical two-dimensional form: `channel = nonce >> 64`, `sequence = nonce & (2^64 - 1)`
   - Core rejects negative and over-width values; each channel advances exactly one step

2. **Deadline:**
   - Absolute timestamp (`Runtime.Time`)
   - Must be in future for execution

3. **Network ID:**
   - `Runtime.GetNetwork()` included in payload hash
   - Prevents cross-chain replay

---

## 8. Operational Security

### 8.1 Relay Server Security

| Mechanism | Purpose |
| --- | --- |
| **Rate Limiting** | Prevent DoS via request flooding (10 req/min) |
| **Request Durability** | Prevent double-submission via deduplication |
| **Input Validation** | Script hash allowlist, raw transaction bounds |
| **Error Sanitization** | Strip sensitive information from error responses |
| **Simulation First** | Validate before broadcasting to save gas |

### 8.2 Paymaster Security

#### On-Chain Paymaster (`AAPaymaster`)

| Mechanism | Purpose |
| --- | --- |
| **Deposit-Backed** | Sponsorship is only possible with pre-deposited GAS |
| **Policy Enforcement** | Per-account or global policies with target/method restrictions |
| **Per-Op Limits** | Each operation capped to `MaxPerOp` GAS |
| **Daily Budget** | Rolling 24-hour spend cap per (sponsor, account) pair |
| **Total Budget** | Lifetime spend cap with overflow protection |
| **Expiry Timestamps** | Policies auto-expire at `ValidUntil` |
| **Core-Only Settlement** | Only the authorized AA core contract can call `settleReimbursement` |
| **Checks-Effects-Interactions** | Deposit deducted before GAS transferred to relay |
| **Atomic Execution** | Settlement reverts if policy check or GAS transfer fails |

#### Off-Chain Paymaster (Morpheus)

| Mechanism | Purpose |
| --- | --- |
| **API Token Auth** | Prevent unauthorized sponsorship |
| **Off-chain Validation** | Apply business rules before chain submission |
| **Network Isolation** | Testnet/Mainnet separation |
| **Reason Disclosure** | Explain rejections to users |

**Reimbursement cap and fee estimation:** `executeSponsoredUserOp` caps the settled
reimbursement at the enclosing transaction's system fee plus network fee. A container whose
fees are both zero can only be an `invokescript`/`invokefunction` estimation (a persisted
transaction must pay for its consumed gas and for witness verification), so that container
caps at the requested amount, the largest amount the chain could settle; every transaction
that reaches a block is capped by its real fees. The cap is computed without a branch so the
estimation and the persisted transaction execute the same instruction sequence, and the
private-chain validation asserts that the estimate equals the persisted gas to the datoshi.
Both were found on a private NeoExpress chain: the original cap faulted the estimation with
"Reimbursement exceeds actual gas cost", and an early-return fix under-estimated the system fee
by the instructions it skipped, so the persisted transaction faulted with "Insufficient GAS".
The settled amount itself still differs between the two containers, which can change the byte
length of a stored balance at a power-of-256 boundary and move the storage fee by one unit, so
a relay should keep the customary system-fee margin on sponsored submissions.

### 8.3 TEE Security

| Mechanism | Purpose |
| --- | --- |
| **Hardware Attestation** | *(Future)* Verify genuine TEE execution |
| **Policy Enforced in TEE** | Complex logic off-chain, signature on-chain |
| **Session Key Issuance** | TEE-bound temporary delegation |

---

## 9. Recovery & Emergency Access

### 9.1 Escape Hatch Flow

```mermaid
stateDiagram-v2
    [*] --> Normal: Account configured
    Normal --> EscapeInitiated: BackupOwner calls InitiateEscape()
    EscapeInitiated --> ActiveEscape: Timelock starts (7-90 days)
    ActiveEscape --> Cancelled: Normal operation executed
    ActiveEscape --> Escaped: Timelock expires + FinalizeEscape()
    Cancelled --> Normal: Escape cleared, account normal
    Escaped --> Reset: Verifier = BackupOwner
    Reset --> Normal: New config via BackupOwner
```

### 9.2 Security Properties

| Property | Guarantee |
| --- | --- |
| **Delayed Takeover** | 7-90 day minimum timelock |
| **Cancel-on-Use** | Any valid op cancels escape |
| **Audit Trail** | All escape events emitted |
| **No Bypass** | *(PARTIAL)* Market escrow can clear escape |

Finalization validates a nonzero replacement verifier against the same V3 lifecycle ABI
as normal verifier rotation before cleanup or state writes. It still calls the old
verifier and hook's `clearAccount` and fails atomically if either module faults or aborts.
The timelock therefore authorizes recovery but does not guarantee recovery liveness
against an unavailable or malicious old plugin. Emergency detach would need an explicit
authority-revocation and plugin-state design; it is not implemented by these changes.

---

## 10. Compliance & Privacy

### 10.1 Privacy Properties

| Data | On-Chain | Public |
| --- | --- | --- |
| **Verifier Public Key** | ✓ | ✓ Signature verification required |
| **Hook Policies** | ✓ | ✓ Allowlist/rules visible |
| **Transaction History** | ✓ | ✓ Ledger transparency |
| **User Identity** | ✗ | Off-chain only (DID) |
| **Session Keys** | ✓ (public) | ✓ Temporary delegation visible |

### 10.2 Regulatory Considerations

| Requirement | Support |
| --- | --- |
| **KYC/AML Integration** | Via `NeoDIDCredentialHook` |
| **Sanctions Screening** | Via `WhitelistHook` |
| **Transaction Monitoring** | Via relay server logs |
| **Recovery Standard** | L1 timelock escape hatch |
| **User Sovereignty** | Backup owner authorizes delayed recovery; successful plugin cleanup remains required |

---

## 11. Future Security Enhancements

### 11.1 Critical Priority

1. **Verifier Gas Limits:** Publish/activate the matching Neo core and DevPack,
   then verify target-node NEF/manifest/runtime parity; do not rely on an ABI
   gas parameter or voluntary verifier accounting.
2. **Private Artifact Refinement:** The current private artifact has a source-to-artifact
   certificate, strict NEF/manifest structure tests, and NeoExpress RPC readback; public
   deployment parity is intentionally excluded.
3. **Session Key Cancellation UX:** Relayers and wallets must re-check canonical key state before submission; cancellation is not a chain-level rollback primitive

### 11.2 Medium Priority

4. **TEE Attestation:** Integrate remote attestation verification
5. ~~**Paymaster Staking:**~~ Resolved — `AAPaymaster` contract provides on-chain deposit-backed sponsorship
6. **Plugin Audit System:** Verified plugin marketplace

### 11.3 Low Priority

7. **Protocol Conformance:** Use signed-Integer-compatible nonce vectors (`0 <= nonce < 2^255`), UTF-8 method bounds and nested-argument limits; do not claim an unsigned-256 ABI
8. **Account-Based Rate Limiting:** Per-account limits in relay
9. **Formal Verification:** Independent review of the complete NeoVM/compiler refinement
   boundary and third-party plugin behavior remains an optional external-audit item; the
   bounded private-profile gates are current and passing.

---

## 12. References

- **ERC-4337:** https://eips.ethereum.org/EIPS/eip-4337
- **ERC-7579:** https://eips.ethereum.org/EIPS/eip-7579
- **Neo Documentation:** https://docs.neo.org/
- **Security Audit:** `docs/SECURITY_AUDIT.md`
- **Plugin Matrix:** `docs/PLUGIN_MATRIX.md`
