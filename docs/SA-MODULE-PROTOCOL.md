# SA Module Protocol — Shared Specification (Protocol Version 4)

This document is the **single shared specification** for the Neo Smart Account (SA)
module model implemented by the native kernel batch:

- native kernel — task #40 (`contracts/native/SmartAccount/`)
- retired custom (user-contract) kernel — task #39, archived delivery record

The DTOs, profiles, storage layout, limits, error codes, events and gas budget
defined here are the contract between the core and every module. No
implementation may deviate from or independently re-design anything in this
document. Where a runtime difference is unavoidable (e.g. caller/phase
enforcement mechanics), it is explicitly listed as a disclosed capability
difference, never as a divergent DTO.

Status: **specification + shared constants + fixtures + native kernel delivered.**
`contracts/native/SmartAccount` implements the surface described here;
`tests/SmartAccount.Native.Tests` covers it and asserts the shared vectors in
`tests/SmartAccount.Native.Tests/TestFile/smartaccount-v4-vectors.json`. The second
kernel that once implemented the same surface has been retired, so this document
and its vectors are the single shared contract. Nothing here claims on-chain
deployment of this source, and the formal models are reported separately in
`docs/engineering/VERIFICATION-AND-GATES.md` (the SA formal verification chapter).

Companion documents:

- `docs/SA-MODULE-PROTOCOL.zh-CN.md` — Chinese counterpart (authoritative together
  with this file; on any divergence the newer revision of both wins).
- `docs/engineering/VERIFICATION-AND-GATES.md` — the SA migration manifest chapter (legacy→v4 design; §14 summarizes).
- `tests/fixtures/sa-module-protocol/README.md` — golden-vector / rejection
  fixture formats and the kernel verification matrix.
- `contracts/native/SmartAccount/SmartAccountModuleProtocol.cs` — the constant
  file carrying every numeric value in this spec (§15).

## 1. Scope and terminology migration

### 1.1 Terminology

The legacy model used `verifier` for the authorization-deciding module. Protocol
v4 adopts the ERC-7579 term **validator**; `hook` keeps its name. The contract
API, storage, events and error codes use `validator`/`Validator` exclusively; the
old `verifier`/`Verifier` names are removed without aliases (the identity-only
witness entry `verify(accountId)` survives because the proxy script embeds it —
see `docs/SDK.md` and §13).

Module kinds (one-byte type code, ERC-7579 numbering):

| Type | Name | Supported in v4 |
| --- | --- | --- |
| 1 | validator | yes |
| 2 | executor | no — `supportsModuleType` returns false, install rejected |
| 3 | fallback handler | no — same |
| 4 | hook | yes |

Types 2 and 3 are not aliases of validator/hook. Declaring support without an
implementation is forbidden; the profile says "not supported", not "maybe".

### 1.2 Plugin renaming / disposition (from the approved design report §3.12)

| Legacy plugin | v4 disposition |
| --- | --- |
| MultiHook | stops new installs; migrated hook order unfolds in core `hookOrder` |
| MultiSigVerifier | becomes **MultiSigValidator** — threshold *policy*; orchestration and approval receipts live in the core |
| NeoNativeVerifier | NeoWitnessValidator (multi-party transaction witness; default single witness is built-in) |
| SessionKeyVerifier | SessionKeyValidator — instance-isolated, one credential set per instance |
| SubscriptionVerifier | SubscriptionValidator — core nonce is the only sequence; same subId re-created ⇒ new credential generation |
| Web3AuthVerifier | Web3AuthValidator — same signature scheme, full new signing domain |
| Web3AuthnVerifier | **P256Validator** (raw P-256; no WebAuthn ceremony claim) |
| TEEVerifier | **TeeKeyValidator** (configured enclave-key verification only; no remote-attestation claim) |
| ZkLoginVerifier | **DelegatedIdentityValidator** (configured P-256 signer + identity binding; no general ZK-proof claim) |
| ZKEmailVerifier | stays disabled; a disabled template only, no installable production validator |
| DailyLimitHook / TokenRestrictedHook / WhitelistHook / NeoDIDCredentialHook | kept, instantiated (external registry reads count against callback gas budget) |
| SocialRecoveryVerifier | split into an optional social-recovery *service* and an optional action-session validator; base recovery is core-native |
| HookAuthority / VerifierAuthority, SignerDomain, VerifierPayload, templates | shared protocol library updates, not installable plugins |

## 2. moduleId — instance namespace

- `moduleId` is a **per-account, persistent, monotonically increasing UInt64**.
  Allocation starts at 1; **0 is reserved for the built-in authorization**.
- A module instance is uniquely identified by `(accountId, moduleId)` — not by
  contract address.
- The same monotonic allocator also issues **threshold policy ids** (§4.2), so
  every routable id in an account comes from one collision-free space.
- **moduleId is never reused.** After uninstall, signatures, pending intents and
  plugin data of the old instance can never silently re-attach to a new instance.
- A module record additionally stores: module type, contract hash, code binding
  (§7.3), module revision, and a per-instance `credentialGeneration`.
- The **same contract address may be installed multiple times** on one account,
  but only if the module's capability profile declares `instanceIsolation`
  (§12). Without that declaration, at most **one instance per (account, type)**
  of that contract may be installed.

Rationale (pinned by the design report §3.1): address-based identity cannot
express multiple sessions of one SessionKeyValidator, and an address must not
simultaneously carry code identity, instance identity and authorization
generation.

## 3. Set limits and ordering semantics

Profile limits (protocol-level, enforced by both kernels, values pinned in
§15 constant files):

| Limit | Value |
| --- | --- |
| validator instances per account (incl. threshold members) | 32 |
| hook instances per account | 8 |
| threshold policy members per policy | 10 |
| threshold value | 1–10 |
| composite graph depth | 1 layer (no nesting, no cycles) |
| actions per configuration intent | 16 |
| concurrent (unresolved) configuration intents per account | 16 |
| operations per same-account batch envelope | 32 |
| enumeration page size (`getModules` limit) | 1–32 |

These are protocol caps, **not** performance guarantees: legal worst-case
combinations (10 threshold members, 8 hooks, maximum proofs) must be measured
against the gas budget (§11) before any release claim; passing "over-limit is
rejected" alone is not acceptance.

**Hook ordering.** The core derives `hookOrder` from the account’s installed hook index (0x53),
in ascending moduleId order, length ≤ 8. Every authorization route uses it. During execution:

- `preCheck` runs in **ascending list order** (forward);
- `postCheck` runs over the **same snapshot in reverse list order**.

The order is snapshot-based: a re-entrant configuration change during execution
does not alter the in-flight sequence. Signatures bind the hook-proof digest
(§5), so a signer cannot be shown a different hook set than the one that will
run.

The recovery policy write requires the existing administrator and, when the recipient changes, a witness from the new nonzero recovery authority. Retaining the same authority needs no second consent. The core admits only the installed, code-bound recovery contract as the direct reset caller. The standard seat obtains the incoming custody witness at proposal, and a mature record can be completed in Active or Frozen, never in MigrationRequired. Its reviewed cancellation and completion methods bind the record nonce and current core configuration nonce. A third-party seat must separately establish its admission and delay guarantees.

## 4. Operation envelope — canonical encoding

### 4.1 Wire shape

A v4 UserOperation is a **strict 13-field NeoVM `Array`** (a `Struct` anywhere in
the operation is rejected):

```
[0]  version              Integer   = 4 (ModuleProtocolVersion)
[1]  target               ByteString, 20 bytes, nonzero
[2]  method               ByteString, 1–128 strict-UTF-8 bytes
[3]  args                  Array, ≤64 entries, depth ≤8, serialized ≤4096 bytes;
                          entries: Null/Boolean/Integer/ByteString/Array only
[4]  nonce                Integer ≥0 — 191-bit channel ‖ 64-bit sequence
[5]  nonceSubkey          ByteString, exactly 32 bytes
[6]  deadline              Integer ≥0 <2^255 (Runtime.Time ms)
[7]  validatorId           Integer ≥0 — 0 = built-in; else moduleId or
                          threshold policyId of the account
[8]  credentialGeneration Integer ≥1 — per-instance generation of [7]
[9]  authorityEpoch        Integer ≥0 (UInt64 domain)
[10] configurationNonce    Integer ≥0 (UInt64 domain)
[11] signature            ByteString, 1–8192 bytes, validator-defined DTO (§6)
[12] hookProofs            Array of `[hookId:Integer, proof:ByteString]` pairs,
                          0–8 entries, hookIds unique and strictly ascending,
                          aggregate proof bytes ≤4096
```

Envelope-level caps: one operation encodes to ≤16 KiB; one transaction envelope
(single or batch of ≤32 operations) encodes to ≤64 KiB. Extra fields, duplicate
hook proofs, unsorted proofs, or non-canonical integers (negative or
out-of-domain values where the field declares a domain) are rejected.

### 4.2 Canonical serialization

The canonical byte form of the unsigned operation is the NeoVM binary
stack-item serialization of the same 13-field Array with `[11] signature`
replaced by an **empty ByteString**. The custom kernel produces it via
`StdLib.Serialize`, the native kernel via `Neo.VM.BinarySerializer.Serialize`;
the two serializers emit identical bytes for these shapes, and golden vectors
(§15 fixture set) pin that equality.

### 4.3 Operation digest and signing domain

```
domain := UTF8("NeoSmartAccount/UserOperation")        // 29 bytes
         || U1 (version = 4)
         || U32LE (network magic)
         || coreHash, 20 raw bytes, the *actual* executing core hash;
                       the custom kernel must NOT substitute the native
                       ServiceHash constant, and vice versa)
         || accountId (20 raw UInt160 bytes)
         || U64BE (validatorId)
         || U64BE (credentialGeneration)
         || U64BE (authorityEpoch)
         || U64BE (configurationNonce)

digest := SHA256( domain || canonicalUnsignedOperation )
```

All unsigned operation fields (including the hookProofs array) are inside the
canonical serialization, so the digest covers them. Integer domain encoding:
`U1` one byte, `U32LE` 4 bytes little-endian (matching the existing native
domain-separator convention), `U64BE` 8 bytes big-endian. Address bytes are the
raw UInt160 bytes exactly as `UInt160.ToArray()` yields — never the
display-order reversal.

The `version`, `validatorId` and `credentialGeneration` fields appear both in
the array and the domain; the domain copy is authoritative for signature
binding, the array copy for execution routing.

`credentialGeneration` has **no default**. §6.1 states which generation a route
binds; a client that substitutes 1, or 2, derives a domain and a channel the
core never validates, and the failure mode is a signature bound to a namespace
the account does not use rather than a recoverable nonce mismatch.

## 5. Signature DTO structure

The `signature` field is a validator-defined DTO (opaque bytes to the core),
bounded by 1–8192 bytes. Every validator signature format **must** bind —
inside its own DTO or by hashing the core digest above — at least:

- protocol version, network, actual core hash, accountId;
- `validatorId` and `credentialGeneration` (per-instance);
- `authorityEpoch` and `configurationNonce`;
- all unsigned operation fields and the hookProofs digest.

Covered formats and their DTO heads (validator-internal layout is their own, but
the binding requirements are auditable against this list):

| Validator | DTO essentials |
| --- | --- |
| SessionKeyValidator | session credential id, delegated grant digest, expiry; generation-bound (revoke ⇒ generation bump ⇒ old signatures dead) |
| MultiSigValidator (as policy) | member identifier + per-member signature list; bound to policyId and member generations; policy members are never independently routable |
| TeeKeyValidator | enclave key id + attested signature blob |
| Web3AuthValidator | EIP-712-style typed payload per `docs/SDK.md` (domain name `"Neo Smart Account"`), signature 64-byte compact |
| P256Validator (was WebAuthn) | raw P-256 `r‖s` (64 bytes) against the instance's configured key |
| DelegatedIdentityValidator (was ZkLogin) | configured P-256 signer signature + identity commitment |
| built-in (validatorId = 0) | §8 message profile reused in operation mode: canonical P-256 script + signature, threshold per 0x57 |

Threshold routing: when `validatorId` names a threshold policy, the core calls
each member validator directly under a **shared parent validation budget**,
keeps approval receipts in core-local invocation state, and — in `postCheck` —
runs completion only for the members approved in the validation phase.
Members are scalar validators only; one member may not join two active
policies; a member referenced by a policy cannot be uninstalled while
referenced. The member side carries the back-pointer to its active policy in its
own 0x52 record (`activePolicyId`, §7.1), which the policy executor rewrites on
every activation, reshape and deactivation. Routing and uninstall checks
therefore read one instance record instead of scanning every policy of the
account; a deactivated policy clears the pointer, releasing its members without
a second pass.

## 6. Nonce channels and namespace derivation

- Channel := **low 191 bits** of `SHA256( U1(4) || coreHash || accountId ||
  U64BE(authorityEpoch) || U64BE(validatorId) || U64BE(credentialGeneration) ||
  nonceSubkey )`.
- The channel is **derived, not chosen**. The 64 low bits of `nonce` are the
  sequence; they must equal the stored cursor (or the exhaustion sentinel).
- Channel bytes in storage keys are 24 bytes, big-endian, `channel[0] =
  digest[8] & 0x7F` (only the top bit cleared: a 191-bit channel).
- The **full 256-bit derivation digest** is persisted per channel (0x5C); if a
  second, different derivation maps to an already-used 191-bit channel, the
  operation is rejected (truncation-collision fail-closed), never silently
  shared.
- Sequence exhaustion (cursor == 2^64 sentinel): the channel is dead; no
  wrap-around.
- Legacy cursor merge rule (migration, §14): the new cursor never decreases, and
  reading the new cursor takes `max(legacy 0x03 value for the same channel,
  new 0x56 value)` before writing.
- Plugins do not keep private sequence counters that must be kept in exact sync
  with the core cursor; the core nonce is the single sequence source
  (SubscriptionValidator consumes the core nonce only).

`configurationNonce` is **not** an operation nonce: it advances monotonically
on every committed security configuration, credential revocation,
freeze/unfreeze, recovery and custody change; operation consumption and quota
counters never advance it; cleanup, uninstall and market sale never reset it.

### 6.1 Which generation a route binds

`credentialGeneration` is not a global counter: it identifies the routing
subject's current credential set, and the core resolves it from the route (it is
never a caller-supplied default, and no ABI method publishes it for the built-in
route).

| Route | Bound generation | Record |
| --- | --- | --- |
| built-in (`validatorId` = 0) | the account's `SubjectRevision` | 0x57 |
| installed validator instance | that instance's `CredentialGeneration` | 0x52 |
| active threshold policy | the policy's `CredentialGeneration` | 0x5B |

Consequences that hold in both kernels:

- The built-in generation is **not** a fixed 1. Every subject change advances
  `SubjectRevision` (§8.3), and a client that hard-codes 1 derives a channel the
  core can never reproduce once the revision has moved. An account with no 0x57
  subject record is still at generation 1.
- An installed instance starts at generation 1 and advances on
  `revokeCredentials` only — a custody-authorized, callback-free revocation that
  retires every signature bound to the old generation at once. Rebinding a
  module's code advances `moduleRevision`, not the credential generation.
- A threshold policy's generation is monotonic across rewrites (a new policy is
  written at generation 1, every reshape carries the previous value forward and
  bumps it), so a reshaped policy kills the channels of its previous generation
  and never resets to 1.
- Because the generation is inside the §4.3 domain, a stale value is not a
  retryable nonce mismatch. An installed-validator or threshold-policy route
  faults with `SA_CREDENTIAL_STALE`; the built-in route rejects the message with
  its invalid-signature result instead, because the generation is compared
  against `SubjectRevision` before any subject is examined.
- `getNonce` resolves the generation internally and returns the channel the core
  would use. A caller may cross-check it against its own derivation, but the
  core's answer is authoritative.

## 7. Storage layout plan

### 7.1 Shared 0x50–0x5F region (both kernels, identical key bytes)

Key construction: 1-byte prefix ‖ raw 20-byte accountId ‖ fixed-width
**big-endian** integer suffixes where noted. All integer key suffixes are
fixed-width big-endian. 0x5F is reserved and unallocated.

| Prefix | Key suffix | Use |
| --- | --- | --- |
| 0x50 | bare | protocol version, layout version, activation state, profile summary |
| 0x51 | +acctId | account control metadata (§7.2) |
| 0x52 | +acctId+moduleId[8 BE] | module instance record (type[1], contractHash, contractId, updateCounter, nefSha256, profileSha256, moduleRevision, credentialGeneration, capability flags, activePolicyId) |
| 0x53 | +acctId+type[1]+moduleId[8 BE] | installed-instance enumeration index (marker rows; per-type ascending-moduleId scan) |
| 0x54 | +acctId | reserved; effective hook order is the 0x53 hook index, revision is in 0x51 |
| 0x55 | +acctId+intentId[8 BE] | configuration intent record |
| 0x56 | +acctId+channel[24 BE] | nonce cursor (new encoding) |
| 0x57 | +acctId | built-in message signer subjects (≤16 20- or 32-byte subjects, threshold) + subjectRevision (§8.1) |
| 0x58 | +acctId | application callback/execution context (phase + re-entrancy state) |
| 0x59 | +acctId | core recovery & emergency invalidation records (Market escape path, §7.5) |
| 0x5A | +acctId | migration state & legacy state digest (§14) |
| 0x5B | +acctId+policyId[8 BE] | threshold member list & policy commitment |
| 0x5C | +acctId+channel[24 BE] | nonce namespace full digest (collision detection) |
| 0x5D | +acctId | Market lock ↔ custody/control-epoch ↔ listing binding (§7.5) |
| 0x5E | +acctId | bounded configuration-intent index |

The 0x50–0x5F byte range must be re-scanned on both networks before any
upgrade; unknown occupied keys abort the upgrade — they are never overwritten.

### 7.2 0x51 account control metadata

status (Active/Frozen/MigrationRequired), custody, recovery authority;
authorityEpoch, configurationNonce; nextModuleId (shared allocator for moduleIds
and policyIds), nextIntentId; default operation authorization switch and default
message authorization switch; recoveryTimelockMs (7–90 days; migrated accounts
keep their existing value); hookOrderRevision, defaultPolicyRevision,
controlRevision; the legacy permanent owner-only flag, which continues to
constrain that account after migration.

### 7.3 0x52 code binding (identical definition in both kernels)

contractHash, ContractId, UpdateCounter, SHA256(NEF bytes), SHA256(canonical
module profile JSON). ContractId blocks destroy-and-redeploy; UpdateCounter
catches manifest-only updates; NEF hash pins code; profile hash pins interface
capability. Binding is checked before and after every module callback and before
commit; an address re-deploy does not inherit authorization. The per-callback
check compares `(ContractId, UpdateCounter)` only — the pair names exactly one
(deployment slot, revision), so it proves the same thing the record's install-time
NEF hash pins, without re-hashing the NEF on every callback.

### 7.4 Legacy regions

**Custom kernel:**
- 0x01 legacy five-field AccountState rows are **kept as migration input /
  historical evidence**; new state is written only under 0x51. New code never
  routes through the old Verifier/HookId fields; a legacy decoder exists solely
  for migration.
- 0x12 and 0x1C are **retired**: new authorization never derives from them. The
  migration intent records an explicit invalidation declaration for any 0x12 /
  0x1C rows of the account (stored under 0x5A); the bytes are never
  re-allocated.
- 0x12 is permanently reserved, never re-allocated; 0x1C likewise.

**Native kernel:** the legacy 14-slot account Array under the 0x10 account key
remains the migration input; the new 0x51 record supersedes it after
migration. 0x10/0x11/0x20/0x30/0x40 legacy prefixes are not re-interpreted by
the new module model.

### 7.5 Market minimal lock (0x5D / 0x59)

- 0x06 / 0x07 / 0x1D stay **Market-only physical marker writes** (Market
  entrances write or delete them; nothing else does — the current
  owner-side `initiateMarketEscrowCancel` direct 0x1D write and the
  ForceCancel/FinalizeEscapeToOwner marker deletions are kernel-batch bugs to
  fix, see §16).
- 0x5D binds, per account: the escrow lock, its custody/control epoch, and the
  listing id.
- Owner-initiated and completed escapes write **0x59 core recovery records**
  only — never the legacy Market prefixes.
- A matured callback-free escape invalidates that old-epoch lock: Market
  settle/cancel must validate listing + control epoch before acting; an
  escaped account cannot be sold under its old binding. Later Market claims
  clean the physical markers.
- Owner escape never calls the Market; a listing may be invalidated
  asynchronously by an independent keeper.

## 8. Built-in message-signature envelope (ERC-1271 profile)

Both kernels implement core P-256 single/threshold message verification with no
plugin dependency.

API: `isValidSignature(accountId, hash, signatureEnvelope)`.
- `hash`: 32-byte ByteString (the caller-supplied message digest).
- Returns the strict 4-byte magic value; success = `0x1626ba7e`
  (ERC-1271 `MAGICVALUE`); any failure returns a different fixed 4-byte value
  (`0xffffffff`) — never throws as its success channel.
- Message validation is **read-only**: it does not consume operation nonces, does
  not run stateful quota hooks, and cannot be satisfied by a transaction
  witness (a contract custody passing `CheckWitness` does not thereby produce an
  offline message signature; it must explicitly authorize a message subject).

Built-in envelope (Array):

```
[0] version               = 4
[1] validatorId            = 0 (built-in) or moduleId of an installed validator
                             that declared messageCapability (§12)
[2] credentialGeneration   built-in: messageSubjectRevision from 0x57;
                            module: instance credentialGeneration
[3] signatures             Array of pairs [verificationScript:ByteString,
                            signature:ByteString 64-byte r‖s]
```

Message digest domain:

```
domain := UTF8("NeoSmartAccount/Message")
         || U1 (4)
         || U32LE (network)
         || coreHash, 20 raw bytes
         || accountId, 20 raw bytes
         || originalSender, 20 raw bytes
         || U64BE (validatorId)
         || U64BE (credentialGeneration)
         || U64BE (authorityEpoch)
messageDigest := SHA256( domain || hash )
```

Built-in rules: each `verificationScript` must be the canonical N3 P-256
verification script for a compressed point (standard wallet script builder
shape); `SHA256(script)` (script hash) must be one of the ≤16 authorized
subjects in 0x57; scripts in the envelope must be pairwise distinct; valid
P-256 signatures over `messageDigest`; count ≥ configured threshold. Duplicate
keys, off-curve points and non-canonical scripts are rejected. The subject set
and threshold live in 0x57 with a `subjectRevision` that advances on every
subject change (custody-gated, 24 h configuration). New account registration
must set a message subject (default = custody address).

Module message signing: `validatorId` = instance moduleId; only modules whose
profile declares `messageCapability`. The core forwards a sanitized signature
payload and `originalSender`; execution quota hooks never apply to opaque
message hashes. SessionKey and Subscription validators **do not** declare
arbitrary-message capability by default.

### 8.1 The two 0x57 keys

The subject store occupies two keys per account, and they are different widths on
purpose:

| Key | Bytes | Meaning |
| --- | --- | --- |
| `0x57 ‖ accountId` | 21 | the canonical subject row: `MessageSubjectRecord` (≤16 subjects, threshold, `SubjectRevision`) |
| `0x57 ‖ accountId ‖ 0x01` | 22 | an internal provenance marker, never a second row |

The canonical row stays **21 bytes**: widening it to 22 would move every existing
account's record and turn a reviewed key into a different one. The marker reuses
the canonical prefix plus a one-byte suffix instead of allocating another
protocol prefix, and it is written and deleted only by the core.

### 8.2 Subject matching

A subject entry binds the signer's **script**, and two widths are accepted:

- a 32-byte subject is the raw `SHA256` of the signer's verification script and
  must equal it exactly;
- a 20-byte subject is the signer's account address (`RIPEMD160(SHA256(script))`,
  the N3 script hash) and must equal it exactly.

Any other width matches nothing. Both forms verify the same ECDSA check over
`messageDigest`, so an account may mix them; the 20-byte form is what registration
writes, because the canonical P-256 custody script hashes back to exactly the
custody address and that key can therefore sign built-in messages immediately
without waiting out the 24-hour subject intent.

### 8.3 Custody-derived subjects and provenance

Registration writes `Subjects = [custody]`, threshold 1, `SubjectRevision` 1, and
sets the 22-byte provenance marker. On a custody rotation the core rewrites the
subject set to the new custody and advances `SubjectRevision` **only when that
marker is present**:

- a missing marker means the provenance is unknown: the subject set may have been
  configured deliberately (through the subject intent), or the account may predate
  the marker and still carry its historical default subject state. The runtime
  makes no inference in either direction — it simply does not rewrite — and a
  subject that happens to equal the old custody address is never read as
  evidence of explicit delegation: address equality is never used to infer
  provenance;
- a marker that is present but carries an unexpected value is an integrity fault,
  not a signal to rotate;
- the rotation emits the subject-update event with the new revision, so the built-in
  credential generation advances together with the subject set. Escape (§7.5) and
  account teardown delete both keys.

## 9. Public interface (identical naming in both kernels)

Queries: `getProtocolInfo`, `getAccount(accountId)`,
`getAccountAddress(accountId)`, `supportsModuleType(type)`,
`supportsExecutionMode(mode)`, `getModules(accountId, type, cursor, limit)`
(limit 1–32; returns next cursor and current configurationNonce; cursor is
moduleId-based), `getModule(accountId, moduleId)`,
`isModuleInstalled(accountId, type, moduleHash, additionalContext)`,
`getAuthorizedModuleId(accountId, phase)`, `getAccountAddress(accountId)`,
`getNonce(accountId, validatorId, nonceSubkey)` (packed),
`getNonceSequence(accountId, channel)`,
`getOperationDigest(accountId, operation)`.

Configuration: `installModule(accountId, moduleType, moduleContractHash, initData)` and
`removeModule(accountId, moduleId, deInitData)`, each authorised by the custody witness or by the
witness of an already installed validator instance, and each advancing the configuration nonce. The
core keeps no intent record, no maturity window and no cancellation path: those belong to a
governance module, which submits the matured call through these two methods.

Actions: the core executes exactly two action codes, `installModule` and `uninstallModule`, and
registration runs them through the same executor the two module methods use. Every other code a v3
kernel carried is removed — a script that still assembles one is rejected with
SA_OPERATION_MALFORMED rather than silently ignored.

Execution: `validateUserOp(accountId, operation)` (read-only, real
verification, structured result), `executeUserOp(accountId, operation)`,
`executeUserOps(accountId, operations)`, `freezeAccount(accountId)`,
`unfreezeAccount(accountId)`. Recovery is a module: `beginRecovery`,
`cancelRecovery` and `executeRecovery` are that module's methods, so the core
exposes none of them.

The immutable-identity witness entry `verify(accountId)` (embedded in the proxy
script) remains a real witness gate, not a legacy API alias. The old
`getVerifier`/`getHook`/`CallVerifier`/`CallHook`/`*Child` surfaces are removed without aliases in both kernels.

Lifecycle module callbacks (core→module): `onInstall(accountId, moduleId,
generation, initData)`, `onUninstall(accountId, moduleId, generation,
deInitData)`, `configure(accountId, moduleId, generation, configData)`,
`preCheck` / `postCheck` (hooks), `validateUserOp` /
`onUserOpComplete` (validators), each bounded by §11 budgets. The core no
longer hard-codes per-method allowlists such as `setPublicKey` — modules decode
their own `configData` through the core configuration gate.

### 9.1 Callback ABI as compiled

Manifest names are the C# method names with the first character lower-cased
(`OnInstall` → `onInstall`, `ValidateUserOp` → `validateUserOp`). `preCheck`
parameter is named `operation`; `postCheck` last parameter is named `hookData`.
Type names below are manifest parameter types.

| Direction | Operation | Manifest ABI | Notes |
| --- | --- | --- | --- |
| module→core | `getModuleProfile()` | `→ String`, **safe** | Canonical profile bytes, ≤ 2048 bytes, no arguments, no writes. |
| core→module | `onInstall(accountId, moduleId, generation, initData)` | `Hash160, Integer, Integer, Array → Void` | `initData` is a command array (see §9.3) or empty. |
| core→module | `configure(accountId, moduleId, generation, configData)` | `Hash160, Integer, Integer, Array → Void` | Same command shape; runs at the configuration phase. |
| core→module | `onUninstall(accountId, moduleId, generation, deInitData)` | `Hash160, Integer, Integer, Array → Void` | Must clear every instance-scoped key of `(accountId, moduleId)`. |
| core→module (validator) | `validateUserOp(accountId, operationDigest, operation)` | `Hash160, ByteArray, Array → Boolean`, **safe** | `operationDigest` is the §4.3 core digest; `operation` is the canonical 13-field view. |
| core→module (validator) | `onUserOpComplete(accountId, operation, result)` | `Hash160, Array, Any → Void` | Completion phase only; `result` is the sanitized target result. |
| core→module (hook) | `preCheck(accountId, operation)` | `Hash160, Array → ByteArray` | Returns instance `hookData`; `null` is normalised to the empty byte string; at most 512 bytes or `SA_HOOK_DATA_TOO_LARGE`. |
| core→module (hook) | `postCheck(accountId, operation, result, hookData)` | `Hash160, Array, Any, ByteArray → Void` | Receives exactly the bytes the same instance returned from `preCheck`; never another instance's. |
| core→module (validator, `messageCapability`) | `isValidSignature(accountId, originalSender, validatorId, generation, hash, signatures)` | `Hash160, Hash160, Integer, Integer, ByteArray, Array → Boolean`, **safe** | `hash` is the core domain-bound module message digest, verified directly. Callers are limited to `ReadOnly`. |

Binding order at install: profile digest → profile parse (version, module type,
contract name, capabilities) → the complete callback surface above. Missing
methods fail before the instance is written; `getModuleProfile` and the
validation/message callbacks must be declared `safe`, so a caller passing write
flags still cannot write from them. Hook pre/post are write-capable by design
(they meter balances) but run with the hook's own instance keys only.

Replies are typed, not coerced (§11). `validateUserOp` approves only when it
returns exactly `Boolean true`; any other reply type is an ABI violation and
faults with `SA_MODULE_TYPE_UNSUPPORTED`, in the execution path and in the
read-only preview alike. `isValidSignature` must never fault — ERC-1271 has to
fail closed — so a reply that is not a `Boolean` counts exactly like
`Boolean false`. `preCheck` replies must be `ByteArray` (the same violation
otherwise), `getModuleProfile` replies must be `String` or installation fails
with `SA_MODULE_CODE_BINDING_MISMATCH`, and every `Void` callback must leave the
evaluation stack empty.

### 9.2 Instance authentication (module side)

A module never trusts a caller-declared instance. It resolves one in this order:

1. `authorizedCore()` (module storage) must equal `Runtime.CallingScriptHash`;
   a zero or invalid core fails with `SA_CORE_NOT_CONFIGURED`, any other caller
   with `Unauthorized caller`.
2. The core answers `getAuthorizedModuleId(accountId, phase)` with the instance
   it is currently addressing. Phases are `Validation 1`, `HookPre 2`,
   `TargetDispatch 3`, `HookPost 4`, `Completion 5`, `Configuration 6`; `0`
   means the phase does not address this module. Lifecycle callbacks are
   authorised only when phase 6 returns exactly the `moduleId` they received.
3. `validateUserOp` runs during the read-only preview with no writer phase; the
   module then uses `operation[validatorId]` (index 7) as its instance id.
4. `getModule(accountId, moduleId)` returns the descriptor
   `[moduleId, moduleType, contractHash, contractId, updateCounter, nefSha256,
   profileSha256, moduleRevision, credentialGeneration, instanceIsolation,
   messageCapability, thresholdMemberEligible]`. Index 8
   (`credentialGeneration`) binds a threshold member's signature to its own
   instance.
5. The asset-holding script hash is `getProxyScriptHash(accountId)` on the
   custom kernel and `getAccountAddress(accountId)` on the native kernel.

The instance key is `prefix (1 byte) ‖ accountId (20 bytes) ‖ moduleId
(8 bytes, big-endian)`; modules never key on a caller-supplied context blob.

### 9.3 Configuration command arrays

`initData`, `configData` and `deInitData` are `[command, ...args]` arrays. Each
module owns its command vocabulary; the core only enforces the array bound
(≤ §3 argument count) and the 2.5 GAS lifecycle budget. Shipped modules use:

| Module | Commands |
| --- | --- |
| `P256Validator`, `Web3AuthValidator`, `TeeKeyValidator` | `setPublicKey(publicKey)` — 33-byte compressed or 65-byte uncompressed, stored compressed. |
| `NeoWitnessValidator` | `setSigners(signers[], threshold)` |
| `MultiSigValidator` | `setMemberKey(publicKey)` — one key per instance. |
| `SessionKeyValidator` | `setSessionKey(publicKey, target, method, expiry, cap, subId)` / `clearSessionKey()` |
| `SubscriptionValidator` | `createSubscription(publicKey, payee, token, amount, period)` / `cancelSubscription(subId)` |
| `DelegatedIdentityValidator` | `setConfig(publicKey, provider, masterNullifier)` |
| `ZKEmailVerifier` | none — the proof verifier is not deployed, so every callback fails closed. |
| `ActionSessionValidator` | `setRecoveryService(service)` / `clearRecoveryService()` |
| `DailyLimitHook` | `setDailyLimit(token, maxAmount, useRollingWindow)` / `clearDailyLimit(token)` |
| `TokenRestrictedHook` | `restrictToken(token)` / `unrestrictToken(token)` |
| `WhitelistHook` | `allowTarget(target)` / `denyTarget(target)` |
| `NeoDIDCredentialHook` | `requireCredential(target, provider, claimType, commitment)` / `clearRequirement(target)` |
| `MultiHook` | none — retired, installation is rejected (§1.2). |


## 10. Lifecycle, pending intents and time locks

Normal configuration (empty-slot install, uninstall, hook order change,
signer change, default-authorization toggles, code rebinding) — **24 h delay
uniformly** (86 400 000 ms).

Exceptions:
- new account registration installs the full initial configuration atomically
  (no assets or prior policy exist);
- emergency freeze is immediate;
- callback-free credential revocation of a validator is immediate — a
  core-defined one-way revocation (generation bump); a module cannot interpret
  "revoke" as a grant;
- callback-free recovery runs the account recoveryTimelock, no plugin calls.

Pending intents: per-account `intentId` (own allocator in 0x51); ≤16
unresolved; `proposedAt + 24 h = matureAt`; `expiresAt = matureAt + 7 days`
(604 800 000 ms). Intents bind authorityEpoch, the exact action digest, and a
bounded read/write set. Same-resource conflicts (same module revision, hook
order, default policy, control subject) cannot run in parallel; independent
instances' configurations can. Committing an intent invalidates only the
conflicting stale intents, not every pending intent. Expired intents are
explicitly cleaned; maturing cannot be covertly replaced. Confirmation
re-requires a custody witness; a new control subject additionally needs that
subject's witness.

Freeze semantics: custody witness can freeze; frozen accounts expose only
read queries, recovery/escape, and unfreeze; `freezeAccount` is immediate, while
`unfreezeAccount` only proposes the unfreeze intent that `confirmConfiguration`
executes after the uniform 24 h delay — an account under `MigrationRequired` can
never thaw; freeze advances the epoch (old
signatures and intents die). Last-validator rule: the built-in route always
exists but is gated by the default policy — uninstalling the last validator
must enable the built-in route within the same 24 h intent, and existing hooks
keep running; there is no automatic owner fallback; only emergency recovery
removes all policies callback-free.

Recovery: core-built-in; custody self-rescue plus optional recovery authority;
timelock per-account 7–90 days; recovery intents are never overwritten or
restarted by another request; matured execution is permissionless and applies
the exact approved result; it calls no old verifier/hook/Market/Oracle; it
advances authorityEpoch/configurationNonce, removes all modules and policies,
voids pending intents, enables built-in authorization; legacy permanent
owner-only flags survive migration.

## 11. Gas hard budget profile (approved Plan B)

Unit: **datoshi**, 1 GAS = 100 000 000 datoshi (same unit as the existing
`System.Contract.CallWithGasLimit` usage). Values identical in both kernels:

| Callback | Hard budget |
| --- | --- |
| each `validateUserOp` call (routed validator or one threshold member) | 100 000 000 (1 GAS) |
| validation aggregate (per account, per transaction; shared by the routed validator and every threshold member) | 100 000 000 × (1 + 10) = 1 100 000 000 (11 GAS) |
| each `onUserOpComplete` call (routed validator or one approved member) | 100 000 000 (1 GAS) |
| completion aggregate (routed validator + approved threshold members) | 100 000 000 × (1 + 10) = 1 100 000 000 (11 GAS) |
| each hook `preCheck` / `postCheck` | 250 000 000 (2.5 GAS) |
| hook aggregate (per account, per transaction) | 250 000 000 × 8 = 2 000 000 000 (20 GAS) |
| each lifecycle / configuration callback (`onInstall`, `onUninstall`, `configure`) | 250 000 000 (2.5 GAS) |

Semantics: budgets include **all descendant calls** (no whitelist bypass);
enforced via `System.Contract.CallWithGasLimit`; threshold validation shares the
parent budget (member budgets are never summed into a larger envelope); core
scheduling and serialization GAS is accounted separately from the callback
budgets. The budgets are caps, not guarantees — worst-case legal combinations
must be measured (fixture matrix, §15) before release.

**Why the aggregates are cap × multiplicity.** An aggregate must always admit
one *maximal* legal round, otherwise the multiplicity the core advertises is
unreachable. A flat 1 GAS validation aggregate made every policy with two
P-256 members unusable: measured one member callback already spends more than
half of it, and a two-member round faulted with `SA_GAS_BUDGET_EXCEEDED` while
the core allows `MaxThresholdPolicyMembers = 10` co-signers. Both validator
aggregates are therefore sized `per-call cap × (1 + MaxThresholdPolicyMembers)`,
the same rule the hook pool already used (`HookCallbackGasLimit ×
MaxHookModuleInstances`). Because a single callback can never be charged more
than its per-call cap, a maximal round charges at most `(1 + 10) × 1 GAS` — the
pool can never be exhausted by a legal configuration, and the per-call cap,
not the pool, remains the bound on an individual module. Measured end-to-end
cost of a full `executeUserOp` (core dispatch included) on the reference build:
1 member 3.0 GAS, 2 members 4.4 GAS, 3 members 5.8 GAS, 10 members 15.4 GAS.

Any budget overrun fails the whole transaction fail-closed; there is no
try-and-continue.

### 11.1 Where the numbers live and what they cover

The kernel pins the per-call caps as private constants in its protocol constant
file (`contracts/native/SmartAccount/SmartAccountModuleProtocol.cs`):
`ValidationPerCallGasLimit = 100_000_000`, `CompletionPerCallGasLimit =
100_000_000`, `HookCallbackGasLimit = 250_000_000`, `LifecycleCallbackGasLimit
= 250_000_000`. The two validator aggregates are computed from those caps and
`MaxThresholdPolicyMembers` (`ValidationAggregateGasLimit()` /
`CompletionAggregateGasLimit()` in the kernel's module section; the hook aggregate
is `HookAggregateGasBudget()`).

Bounds that shape the worst case are pinned in the same files: `HookDataBytesMax
= 512`, `ModuleProfileBytesMax = 2048`, `ArgsCountMax = 64`,
`HookProofsEntriesMax = 8`, `HookProofBytesMax = 4096` (aggregate),
`OperationEncodedSizeMax = 16384`, `EnvelopeEncodedSizeMax = 65536`.

- `getModuleProfile` is charged as a lifecycle callback (2.5 GAS) and runs with
  `CallFlags.ReadStates`: a profile cannot read balances, call other contracts
  or write.
- Each hook callback has its own 2.5 GAS cap; a hook never carries unused budget
  into the next hook. `preCheck` runs in ascending `hookOrder`, `postCheck` in
  reverse over the same approved set.
- The validation aggregate covers every validator call in one transaction,
  including threshold members; completion has its own 1 GAS aggregate.
- A callback that returns a value of the wrong ABI type fails at the manifest
  check, not at gas: the core does not coerce.

## 12. Module capability declaration profile

Every installable module ships a canonical profile JSON (the profile hashed
into the 0x52 binding). Schema (skeleton in
`tests/fixtures/sa-module-protocol/module-profile.template.json`):

```json
{
  "profileVersion": 1,
  "moduleType": "validator | hook",
  "contractName": "…",
  "capabilities": {
    "instanceIsolation": false,
    "messageCapability": false,
    "thresholdMemberEligible": false,
    "compositeLayer": 0
  },
  "lifecycle": ["onInstall", "onUninstall", "configure"],
  "callbacks": ["validateUserOp", "onUserOpComplete"]
}
```

- `instanceIsolation: true` is required for multiple instances of the same
  contract address on one account.
- `messageCapability` gates §8 module message signing. **SessionKeyValidator
  and SubscriptionValidator declare `messageCapability: false` by default** —
  restricted execution credentials must not become arbitrary offline
  authorizations.
- `thresholdMemberEligible` marks scalar validators that may join a threshold
  policy.
- `compositeLayer` ≤ 1 (one layer; no nesting/cycles).

### 12.1 Canonical bytes and the source of truth

The profile is a UTF-8 JSON document with object keys sorted, no whitespace and
**no trailing newline**; the canonical form is what the module returns and what
the installer hashes. `timestamp`-like or environment-dependent fields are not
allowed: the same source must produce the same bytes on every machine.

Each module keeps its canonical bytes twice, and both copies are checked:

| Copy | Purpose |
| --- | --- |
| `contracts/plugins/<validators\|hooks\|recovery>/<Name>.profile.json` | Editable source of truth, reviewable in isolation. |
| `private const string ModuleProfileJson = "…"` in the module source | What `getModuleProfile()` returns on chain. |

`scripts/sync-module-profiles.mjs` rewrites non-canonical files, patches the
literal from the `.profile.json`, verifies the module declares the callbacks its
profile claims, and supports `--check` (exit 1 on STALE/ERROR).
`scripts/sync-module-profiles.mjs --check` fails on STALE/ERROR; run it before building, because
the retired `contracts/compile.sh` no longer chains it into a compile.

Binding order and failure modes (custom and native kernels alike):

1. `getModuleProfile` must exist and be `safe` → otherwise
   `SA_MODULE_CODE_BINDING_MISMATCH`.
2. `SHA-256(returned bytes)` must equal the `profileDigest32` in the install
   action → otherwise `SA_MODULE_CODE_BINDING_MISMATCH`.
3. `profileVersion` must equal 1, `moduleType` must match the requested type,
   `contractName` must equal the manifest name, the four capability keys must be
   present → otherwise `SA_MODULE_CODE_BINDING_MISMATCH` or
   `SA_MODULE_TYPE_UNSUPPORTED`.
4. Hook profiles claiming `messageCapability` or `thresholdMemberEligible` fail
   with `SA_MODULE_TYPE_UNSUPPORTED`; `compositeLayer` outside 0–1 likewise.
5. Only then is the callback ABI of §9.1 checked and the instance written; the
   recorded capability flags are read from the profile, never declared by the
   installer.

The capability matrix shipped with this repository:

| Module | instanceIsolation | messageCapability | thresholdMemberEligible | compositeLayer |
| --- | --- | --- | --- | --- |
| `P256Validator` | false | false | true | 0 |
| `Web3AuthValidator` | false | true | true | 0 |
| `TeeKeyValidator` | false | false | true | 0 |
| `NeoWitnessValidator` | false | false | true | 0 |
| `DelegatedIdentityValidator` | false | false | true | 0 |
| `MultiSigValidator` | true | false | true | 0 |
| `SessionKeyValidator` | true | false | false | 0 |
| `SubscriptionValidator` | false | false | false | 0 |
| `ZKEmailVerifier` | false | false | false | 0 |
| `ActionSessionValidator` | false | false | false | 0 |
| `DailyLimitHook`, `TokenRestrictedHook`, `WhitelistHook`, `NeoDIDCredentialHook` | false | false | false | 0 |
| `MultiHook` | false | false | false | 1 |

`Web3AuthValidator` is the only shipped validator that implements
`isValidSignature`; a profile claiming `messageCapability` without that method
still fails binding at §9.1.

## 13. ERC alignment boundary

Interface naming aligns with ERC-7579/4337/1271 (module types,
`isValidSignature`, `validateUserOp`-style validation, `executeUserOp(s)`,
install/uninstall lifecycle events). **The protocol does NOT claim Ethereum
protocol compatibility:**
- Neo SA is not `PackedUserOperation`/`EntryPoint.handleOps`; same-account
  batches are not cross-account bundler bundles.
- NeoVM nonce domain is a **191-bit derived channel + 64-bit sequence**; ERC-4337
  is 192+64 with a chosen key.
- ERC-7562 is an Ethereum mempool validation ruleset, not a Neo consensus rule;
  Neo GAS budgets are not Ethereum verification-gas conversions.
- ERC-1271 semantics (magic value, read-only, arbitrary schemes) are respected
  as a **Neo profile**.

Wording rule for all docs/UI: "responsibility- and security-model-aligned Neo
profile", never "fully ERC-4337/ERC-7579 compatible".

## 14. Migration manifest (summary — full design in the SA migration manifest chapter of docs/engineering/VERIFICATION-AND-GATES.md)

Per-account classification: `no-plugin`, `scalar-plugin`, `multihook`,
`multisig`, `unknown-plugin`, `owner-only`, `market-locked`, `recovery-pending`.
Unknown plugins are never guess-migrated — the account enters
`MigrationRequired` (execution and message authorization rejected; queries,
freeze and callback-free recovery remain). Migration intents are idempotent
against the manifest digest; the 0x01 legacy five fields and the native
14-slot Array are inputs only; old pending, old signatures, 0x12 and 0x1C are
never authorization sources.

## 15. Shared constant files and fixtures

| Artifact | Path |
| --- | --- |

| native constants | `contracts/native/SmartAccount/SmartAccountModuleProtocol.cs` (internal static `SmartAccountModuleProtocol`, synced to neo-native-core via `scripts/sync_native_smartaccount.py`) |
| fixture skeletons | `tests/fixtures/sa-module-protocol/` (README + schemas + templates) |

The constant file carries, for: protocol version 4;
module type codes 1/4; all §3 limits; 13-field envelope field indices; nonce
sizes (32-byte subkey, 24-byte channel); serialized-size caps (4096/8192/4096/
16384/65536); delays (86 400 000 / 604 800 000 / 7 776 000 000 ms); gas budgets
(100 000 000 / 250 000 000 datoshi); ERC-1271 magic (0x1626ba7e / 0xffffffff);
domain strings ("NeoSmartAccount/UserOperation", "NeoSmartAccount/Message");
storage prefixes 0x50–0x5E; the §10 error-code strings; §10bis event display
names; and the fixed-width big-endian key-suffix encoding (`UInt64ToBigEndian`,
per-prefix composite key builders).

## 16. Kernel implementation mapping

> The #39 table below is the archived delivery record of the retired custom kernel;
> the #40 mapping is the one that still describes this repository.

### 16.1 Retired custom kernel (#39, archived delivery record)

| Spec section | Custom files to create/modify |
| --- | --- |
| §2/§3/§7 constants | consume the constant file that shipped with the retired custom kernel (`SmartAccount.ModuleProtocol.cs`) |
| §7.1/§7.4 prefixes | extend the STORAGE PREFIX MAP comment in `SmartAccount.cs` with the 0x50–0x5E rows; add `SmartAccount.ModuleProtocol.cs` to `WalletPartials` in `tests/SmartAccount.Contracts.Tests/StoragePrefixMapTests.cs` **together with first key usages** (DeriveShape requires usage) |
| §4/§5 envelope + digest | `SmartAccount.Execution.cs` (13-field decode, digest, batch), new `SmartAccount.Intents.cs` if split |
| §6 nonce | `SmartAccount.Internal.cs`/new nonce partial (0x56/0x5C, merge with legacy 0x03) |
| §8 message | `SmartAccount.State.cs` (built-in P-256 subjects, 0x57) |
| §9 interface + lifecycle | `SmartAccount.Accounts.cs` (registration identity custody+salt, atomic initial install), `SmartAccount.Modules.cs` (0x51–0x53, 0x5B; `AssertModuleCallbackAbi`, `BindModuleProfile`, hook pre/post dispatch), `SmartAccount.State.cs` (`getModule`/`getModules` descriptors), `SmartAccount.Message.cs` (module `isValidSignature` route), no `HookChildren`/`VerifierChildren` adapter partials remain |
| §10 intents | new intents partial (0x55/0x5E) |
| §7.5 Market | `SmartAccount.MarketEscrow.cs` (0x5D binding, no owner-side 0x1D writes, epoch validation), `SmartAccount.Escape.cs` (0x59 records, callback-free escape) |
| F-1 (verify scope) | `SmartAccount.VerifyContext.cs` — delete `verifyScopeTarget` authorization, phase gates |
| F-7 (phase gates) | `SmartAccount.VerifyContext.cs` + `SmartAccount.Execution.cs` (0x58 context, direct-caller + ReadOnly + strict domain checks for read-only callbacks) |
| events | `SmartAccount.Events.cs` (§10bis table; keep existing AA-free events) |
| plugins | `contracts/plugins/validators/` — 9 validators (`P256Validator`, `Web3AuthValidator`, `TeeKeyValidator`, `NeoWitnessValidator`, `DelegatedIdentityValidator`, `MultiSigValidator`, `SessionKeyValidator`, `SubscriptionValidator`, `ZKEmailVerifier`) plus the shared layer `ModuleOperation.cs`, `ValidatorAuthority.cs`, `ValidatorPayload.cs`, `ValidatorClock.cs`, `ValidatorModels.cs`, `SignerDomain.cs` |
| hooks | `contracts/plugins/hooks/` — `DailyLimitHook`, `TokenRestrictedHook`, `WhitelistHook`, `NeoDIDCredentialHook`, retired `MultiHook` (installation rejected), shared `HookAuthority.cs` |
| recovery split | `contracts/plugins/recovery/ActionSessionValidator.cs` (validator module) and `contracts/plugins/recovery/SocialRecoveryService.*.cs` (service contract); each ships a canonical profile |
| profile sources | `<Name>.profile.json` next to every module, literal embedded as `ModuleProfileJson`, kept in sync by `scripts/sync-module-profiles.mjs` (run `--check` before building) |
| build layout | the retired custom build emitted `contracts/bin/public` for the core, services and mocks, `bin/public/validators`, `bin/public/hooks`; the native kernel builds through MSBuild into each project's `bin/Release/net10.0/`, and `scripts/build_native_modules.py` writes the six native-profile modules to its `--output` |

### 16.2 Native kernel (#40, shares its batch with #29)

| Spec section | Native files to create/modify |
| --- | --- |
| constants | consume `SmartAccountModuleProtocol.cs` (this batch; then run `scripts/sync_native_smartaccount.py` to materialize the neo-native-core copy) |
| §4/§5 envelope/digest | `SmartAccountProtocol.cs` (v4 domain, 13-field serialize), `SmartAccountEnvelope.cs` (13-field operations) |
| §6 nonce | `SmartAccountProtocol.cs` + nonce storage partial (0x56/0x5C; legacy 0x20 merge) |
| §7 state | `SmartAccountRecords.cs` (new 0x51 record and its codec; legacy 14-slot decoder kept for migration only) |
| §2/§3 collections | `SmartAccount.Modules.cs` (instance records, enumeration, hookOrder, threshold policies), `SmartAccountModulePolicy.cs` (new limits) |
| §9/§10 lifecycle & intents | `SmartAccount.Modules.cs`, new intents partial (0x55/0x5E) |
| §8 message | `SmartAccount.Keys.cs` (P-256 subjects), `SmartAccount.cs` (`isValidSignature` ABI) |
| §11 gas | `SmartAccount.Execution.cs` (CallWithGasLimit budgets — ABI hooks exist in the core) |
| F-7 phase gates | `SmartAccountInvocationContext.cs` (exact-frame writer-phase grants; validation/message must never reach post/configuration/cleanup writes) |
| §7.5 Market | core 0x5D/0x59 records; Market contract updates in the services batch |

### 16.3 Cross-kernel invariants to verify (fixture matrix)

The full matrix is `tests/fixtures/sa-module-protocol/README.md` (from design
report §5.4): multi-instance same-address installs; validator swap cannot skip
hooks; threshold members not independently routable; duplicate identities,
cycles, nesting rejected; post only over the approved snapshot set; forward/reverse
hook order with false/FAULT handling; proof/args/hookData tampering rejected;
timelock on empty-slot/uninstall/last-validator/default-policy; pending intent
concurrency, conflicts, maturity, expiry, stale revisions; frozen-state ABI
sweep; validation/message→post/configuration/cleanup escalation attacks;
contractId/updateCounter/NEF/profile drift before and after; revoke-regrant and
market-sale replay; subId re-creation with fresh generations; unconsumed
recovery-ticket replay across clear/setup (F-11); recovery without any plugin
callback; no-plugin operation + built-in message signatures; contract custody
cannot fake message signatures; gas overrun/non-return/whitelist paths in
Verification and Application separately; migration fixtures for 53/407 real
accounts, all legacy prefixes, MultiHook order, MultiSig threshold, nonce and
epoch monotonicity, 0x12/0x1C invalidation, interrupted and repeated migration.

## 17. Error codes

Error codes are stable string constants (`SA_*`), shared verbatim by both
kernels; kernel exceptions carry them (possibly with a detail suffix after a
space). The constants files pin the spellings.

| Code | Meaning |
| --- | --- |
| `SA_PROTOCOL_VERSION` | operation/envelope version ≠ 4 |
| `SA_OPERATION_MALFORMED` | non-canonical shape, sizes, depths, ordering, integer domains |
| `SA_OPERATION_FIELD_COUNT` | field count ≠ 13 |
| `SA_MODULE_TYPE_UNSUPPORTED` | module type not 1 or 4 |
| `SA_MODULE_LIMIT_VALIDATOR` / `SA_MODULE_LIMIT_HOOK` / `SA_MODULE_LIMIT_THRESHOLD` / `SA_MODULE_LIMIT_MEMBERS` / `SA_MODULE_LIMIT_ACTIONS` / `SA_MODULE_LIMIT_INTENTS` / `SA_MODULE_LIMIT_BATCH` | profile limits exceeded |
| `SA_MODULE_NOT_INSTALLED` | moduleId not installed on the account |
| `SA_MODULE_ID_INVALID` | id 0 for a module route or an unallocated id |
| `SA_MODULE_INSTANCE_ISOLATION_REQUIRED` | same-address re-install without `instanceIsolation` |
| `SA_MODULE_CODE_BINDING_MISMATCH` | contractId/updateCounter/NEF/profile drift |
| `SA_MODULE_NOT_ROUTABLE` | threshold policy member routed directly |
| `SA_MODULE_MESSAGE_CAPABILITY_ABSENT` | module lacks `messageCapability` |
| `SA_VALIDATION_REJECTED` | validator rejected the operation |
| `SA_VALIDATOR_NOT_FOUND` | routed validator/policy missing |
| `SA_HOOK_REJECTED` | hook pre/post failure |
| `SA_HOOK_DATA_TOO_LARGE` | hookData > 512 bytes |
| `SA_PROOF_INVALID` | duplicate/unsorted/oversized hook proof |
| `SA_NONCE_INVALID` / `SA_NONCE_EXHAUSTED` / `SA_NONCE_CHANNEL_COLLISION` | nonce mismatch / channel dead / 191-bit truncation collision |
| `SA_DEADLINE_EXPIRED` | past deadline |
| `SA_EPOCH_STALE` / `SA_CONFIGURATION_NONCE_STALE` / `SA_CREDENTIAL_STALE` | signature bound to superseded epoch/nonce/generation |
| `SA_INTENT_IMMATURE` / `SA_INTENT_EXPIRED` / `SA_INTENT_CONFLICT` / `SA_INTENT_NOT_FOUND` / `SA_INTENT_LIMIT` | intent lifecycle violations |
| `SA_ACCOUNT_NOT_FOUND` / `SA_ACCOUNT_FROZEN` / `SA_ACCOUNT_STATUS` | account state gates |
| `SA_RECOVERY_PENDING` / `SA_RECOVERY_LOCKED` | recovery in progress / timelock |
| `SA_REENTRANCY_FORBIDDEN` | same-account or cross-account nested execution |
| `SA_PHASE_VIOLATION` | callback invoked outside its writer phase |
| `SA_GAS_BUDGET_EXCEEDED` | callback exceeded its §11 budget (fail-closed) |
| `SA_MESSAGE_INVALID` | message envelope failed (returns magic-invalid, may also throw on malformed input) |
| `SA_MIGRATION_REQUIRED` | account not yet migrated; execution/message rejected |
| `SA_MARKET_LOCKED` | 0x5D epoch binding mismatch for Market action |
| `SA_UNAUTHORIZED` | caller/subject witness failure |

## 18. Event table

Reused existing (AA-free) events: `AccountRegistered`, `ModuleInstalled`,
`ModuleUpdateInitiated`, `ModuleUpdateConfirmed`, `ModuleUpdateCancelled`,
`ModuleRemoved`, `MetadataUriUpdated`, `UserOpExecuted`,
`EscapeInitiated`, `EscapeCancelled`, `EscapeFinalized`,
`MarketEscrowEntered`, `MarketEscrowCancelled`, `MarketEscrowSettled`,
`SponsoredUserOpExecuted`.

`VerifyScopeTargetSet` is **retired** with the F-1 fix.

New module-model events (display names pinned in the constants files; payload
order fixed):

| Event | Payload |
| --- | --- |
| `ModuleInstanceInstalled` | accountId, moduleId, moduleType, contractHash, credentialGeneration |
| `ModuleInstanceConfigured` | accountId, moduleId, credentialGeneration |
| `ModuleInstanceRemoved` | accountId, moduleId |
| `ModuleCodeRebound` | accountId, moduleId, bindingDigest |
| `HookOrderSet` | accountId, hookOrderRevision, hookIds |
| `ThresholdPolicySet` | accountId, policyId, threshold, memberIds |
| `ConfigurationIntentProposed` | accountId, intentId, actionCount, actionDigest |
| `ConfigurationIntentConfirmed` | accountId, intentId, configurationNonce |
| `ConfigurationIntentCancelled` | accountId, intentId |
| `ConfigurationIntentExpired` | accountId, intentId |
| `CredentialRevoked` | accountId, moduleId, credentialGeneration |
| `NonceChannelOpened` | accountId, channelDigest |
| `NonceChannelExhausted` | accountId, channelDigest |
| `MessageSubjectUpdated` | accountId, subjectCount, threshold, subjectRevision |
| `AccountFrozen` | accountId, authorityEpoch |
| `AccountUnfrozen` | accountId, authorityEpoch |
| `RecoveryInitiated` | accountId, newCustody, matureAt |
| `RecoveryCancelled` | accountId |
| `RecoveryExecuted` | accountId, authorityEpoch, configurationNonce |
| `MarketControlEpochBound` | accountId, listingId, controlEpoch |
| `MarketLockInvalidated` | accountId, controlEpoch |
| `CoreRecoveryRecorded` | accountId, matureAt |
| `MigrationRequired` | accountId, legacyModuleCount |
| `MigrationImported` | accountId, manifestDigest, classification |

Every lifecycle transition emits exactly one event; install/uninstall failure
throws (no partial-commit event pair).

---

## Appendix: Module developer guide

> This appendix absorbs the former standalone module developer guide; it is English only (the Chinese counterpart carries a pointer instead of a translation), and its internal structure and numbering are preserved.

### Executive Summary

This guide is for developers building protocol v4 validator or hook modules for the Neo N3 Smart
Account ecosystem. It covers security best practices, common vulnerabilities, and the interfaces the
core enforces at install and call time.

**Target Audience:** Smart contract developers
**Prerequisites:** Familiarity with Neo N3, C#, and cryptographic primitives
**Security Status:** Following these guidelines is required for plugin inclusion in the verified ecosystem.

---

### 0. Quick Start: From Template to Bound Plugin

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

### 1. Plugin Architecture Overview

#### 1.1 Two Plugin Types

| Type | Responsibility | Security Focus | Examples |
| --- | --- | --- | --- |
| **Validator** | "Who is authorized?" | NeoWitness, MultiSig, SessionKey, P256, Web3Auth, TeeKey, DelegatedIdentity |
| **Hook** | "What is allowed?" | Whitelist, DailyLimit, TokenRestricted, NeoDIDCredential |

Both roles are installed as instances: the core assigns a `moduleId` per install and one
module contract may serve several instances on the same account. Composition is
core-owned — a threshold policy over validator instances and `hookOrder` over hook
instances — so a module never calls another module.

#### 1.2 Module Storage Is Instance-Scoped

```csharp
// GOOD: Stateless module
public static ByteString getPublicKey(UInt160 accountId, BigInteger moduleId)
{
    byte[] key = ValidatorAuthority.InstanceKey(Prefix_PubKey, accountId, moduleId);
    return Storage.Get(Storage.CurrentContext, key) ?? (ByteString)"";
}

// BAD: Stateful module with admin keys
private static readonly byte[] Prefix_Admin = new byte[] { 0xFF };
public static void SetAdmin(UInt160 newAdmin) // an admin setter is not part of any compliant module
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

### 2. Validator Module Security

#### 2.1 Required Interface

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

#### 2.2 Security Checklist for Validators

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

#### 2.3 Common Vulnerabilities

The `PG-*` identifiers below are this guide's plugin-development checklist. The project's
vulnerability ledger is a different namespace with its own `VULN-001` to `VULN-006`, kept in
`docs/SECURITY.md` section 6.1; do not read a `PG-*` item as a ledger entry.

##### PG-01: Missing Network ID

**Severity:** Critical

```csharp
// VULNERABLE: a self-built digest that omits the network and the instance
byte[] payload = Helper.Concat(accountId, targetContract, method, args, nonce, deadline);

// SECURE: sign the shared binding, which carries the network domain, the core
// operation digest, the canonical 13-field view and the module instance.
ByteString digest = ValidatorPayload.SigningDigest(accountId, operationDigest, operation, moduleId);
```

##### PG-02: Mutable State in Validation

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

##### PG-03: Unbounded Gas Consumption

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

##### PG-04: Signature Forgery via Length Extension

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

### 3. Hook Plugin Security

#### 3.1 Required Interface

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

#### 3.2 Security Checklist for Hooks

| Check | Why | Implementation |
| --- | --- | --- |
| **Authority validation** | Prevent unauthorized configuration | Each callback starts with `HookAuthority.RequireLifecycle(accountId, moduleId)`; the core records the writer phase and `getAuthorizedModuleId(accountId, phase)` resolves the instance |
| **Context validation** | Ensure SA core is caller | `RequirePreCheck` / `RequirePostCheck` likewise refuse any caller that is not the configured core in the matching phase |
| **Revert on reject** | Atomic rejection pattern | Throw `ExecutionEngine.Assert` |
| **No external calls in pre** | Prevent reentrancy | Only inspect the operation view |
| **Careful post logic** | No validation in post | Only cleanup and logging |
| **State consistency** | Idempotent operations | Handle re-entrancy/timeout |
| **onUninstall** | Cleanup on removal | `DeleteInstancePrefix` for every instance prefix |

#### 3.3 Common Vulnerabilities

##### PG-05: Reentrancy in preCheck

**Severity:** High

```csharp
// VULNERABLE: Can call back into the SA
public static ByteString PreCheck(UInt160 accountId, object[] operation)
{
    HookAuthority.RequirePreCheck(accountId, operation);

    // Check limit in storage
    BigInteger spent = getSpentAmount(accountId);
    if (spent + amount > limit) return (ByteString)new byte[0];

    // Call external contract (DANGEROUS!)
    Contract.Call((UInt160)operation[1], "transfer", CallFlags.All, ...);

    // Attacker re-enters with same operation!
}

// SECURE: No external calls in preCheck
public static ByteString PreCheck(UInt160 accountId, object[] operation)
{
    HookAuthority.RequirePreCheck(accountId, operation);

    BigInteger spent = getSpentAmount(accountId);
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

    BigInteger pending = (BigInteger)Storage.Get(...);
    Storage.Put(..., 0); // Consume
}
```

##### PG-06: Double-Spend in postCheck

**Severity:** High

```csharp
// VULNERABLE: Not checking if already consumed
public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
{
    // Attacker calls postCheck twice!
    BigInteger current = getSpentAmount(accountId);
    Storage.Put(..., current + amount);
}

// SECURE: Use idempotent operations keyed by the instance
public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
{
    HookAuthority.RequirePostCheck(accountId, operation);
    if (!DidExecutionSucceed(result)) return;

    byte[] pendingKey = InstanceKey(Prefix_Pending, accountId, moduleId);
    ByteString? pending = Storage.Get(Storage.CurrentContext, pendingKey);

    ExecutionEngine.Assert(pending != null, "Already consumed");

    BigInteger amount = (BigInteger)pending;
    Storage.Delete(Storage.CurrentContext, pendingKey);

    BigInteger current = getSpentAmount(accountId);
    Storage.Put(..., current + amount);
}
```

##### PG-07: Incorrect Result Handling

**Severity:** Medium

```csharp
// VULNERABLE: Falsy results treated as success
public static void PostCheck(UInt160 accountId, object[] operation, object result, ByteString hookData)
{
    // result = 0 means failure, but we still spend!
    Storage.Put(..., getSpentAmount(accountId) + amount);
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
    Storage.Put(..., getSpentAmount(accountId) + amount);
}
```

---

### 4. Configuration Security

#### 4.1 Using ValidatorAuthority

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

#### 4.2 Using HookAuthority

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

#### 4.3 Common Misconfigurations

| Misconfiguration | Risk | Fix |
| --- | --- | --- |
| **Skip authority check** | Unauthorized config | Start each callback with `RequireLifecycle` / `RequirePreCheck` / `RequirePostCheck` |
| **Direct storage access** | Bypass core contract | Only access `Prefix_*` prefixed keys |
| **Mutable verification** | Bypass timelock | Never make verification upgradable without the core's configuration intent |
| **Shared state across instances** | Cross-instance leakage | Always derive keys from `InstanceKey(prefix, accountId, moduleId)` |

---

### 5. Cryptographic Best Practices

#### 5.1 Canonical Payload Encoding

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

#### 5.2 Hash Function Selection

| Use Case | Hash Function | Notes |
| --- | --- | --- |
| **Neo-native sigs** | SHA256 | Via `CryptoLib` |
| **EVM compatibility** | Keccak256 | Via `NativeCryptoLib.Keccak256` |
| **Payload binding** | Both | Match the validator's signature algorithm |

#### 5.3 Public Key Validation

```csharp
// GOOD: Explicit validation
public static void setPublicKey(UInt160 accountId, BigInteger moduleId, ByteString pubKey)
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

### 6. Testing & Audit Checklist

#### 6.1 Before Submission

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

#### 6.2 Security Testing

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

#### 6.3 Audit Requirements

For official plugin listing, provide:

1. **Source code review** - Full codebase access
2. **Test coverage** - Unit + integration tests
3. **Formal verification** - (Optional) Mathematical proof
4. **Gas analysis** - Worst-case gas consumption
5. **Third-party audit** - (Recommended) Independent review

---

### 7. Deployment Checklist

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

### 8. Resources

- **Security Model:** `docs/SECURITY.md`
- **Ethereum Comparison:** the Ethereum AA comparison chapter of `docs/ARCHITECTURE.md`
- **Protocol Coverage:** `docs/SECURITY.md` (Appendix A)
- **Module Protocol:** [`docs/SA-MODULE-PROTOCOL.md`](SA-MODULE-PROTOCOL.md)
- **Templates:** [`contracts/plugins/templates/README.md`](../contracts/plugins/templates/README.md)
- **Core Contract:** `contracts/native/SmartAccount/SmartAccount.cs`
- **Validator Examples:**
  - `contracts/plugins/validators/NeoWitnessValidator.cs`
  - `contracts/plugins/validators/MultiSigValidator.cs`
  - `contracts/plugins/validators/SessionKeyValidator.cs`
- **Hook Examples:**
  - `contracts/plugins/hooks/WhitelistHook.cs`
  - `contracts/plugins/hooks/DailyLimitHook.cs`
  - `contracts/plugins/hooks/MultiHook.cs` (rejects new installs; kept as migration evidence)

---

### 9. Reporting Security Issues

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

### 10. Summary: Security by Design

| Principle | Implementation |
| --- | --- |
| **Least Privilege** | Plugins only access account-specific state |
| **Defense in Depth** | Core → validator → hook layers |
| **Fail Closed** | Reject unauthorized, don't allow |
| **Economy of Mechanism** | Minimal gas, no unnecessary checks |
| **Open Verification** | Signature logic is auditable |
| **No Secrets** | All state is on-chain |

Follow these principles, and your plugin will be a secure, auditable component of the Neo Smart Account ecosystem.

## Frontend module chooser guide

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

### Choose In Layers

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

#### Validator notes

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

### Recommended Combinations

#### Consumer Wallet

- Validator: `Web3AuthValidator`
- Hook: `DailyLimitHook`
- Recovery: custody address plus a 7–30 day timelock

#### Trading / Automation Wallet

- Validator: `SessionKeyValidator` (one instance per bot)
- Hook: `WhitelistHook`
- Recovery: custody address plus an optional recovery authority

#### High-Value Treasury

- Validator: `MultiSigValidator` (threshold 2–10)
- Hook: `TokenRestrictedHook`
- Recovery: separate recovery authority with a 90 day timelock

#### Membership / Recurring Billing

- Validator: `SubscriptionValidator`
- Hook: `DailyLimitHook`
- Recovery: custody address

### How To Configure

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

### Module Commands

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

### Paymaster + Hook Combinations

The on-chain `SAPaymaster` contract funds relay fees for an account but never authorizes execution.
Validators and hooks still run independently, so sponsorship composes with any policy stack.

#### Sponsored Consumer Wallet

- Validator: `Web3AuthValidator`
- Hook: `DailyLimitHook`
- Paymaster: a global policy (account id of zero) targeting the dApp contract

#### Sponsored Automation

- Validator: `SessionKeyValidator`
- Hook: `WhitelistHook`
- Paymaster: a per-account policy with per-operation and daily budgets

#### Key Principle

The paymaster pays only after validation succeeds:

- a sponsor cannot bypass a hook by paying for gas
- a hook cannot raise a paymaster budget
- reimbursement is settled inside the same sponsored execution, so there is no window where the
  target runs but reimbursement fails

### Market Readiness

When listing an SA address in the market, publish at minimum:

- the installed validator instances and their module ids
- the hook set and its order
- the recovery authority, timelock and whether the account is frozen
- whether the buyer must install fresh modules after purchase

Settlement is the buyer's clean slate: `settleMarketEscrow` sweeps modules and policies callback-free,
sets custody to the buyer, clears the recovery authority, advances the authority epoch and
configuration nonce, resets the default authorizations and re-initializes the message subjects.
The buyer configures fresh modules in the app workspace after purchase.

