# SA Module Protocol — Shared Specification (Protocol Version 4)

This document is the **single shared specification** for the Neo Smart Account (SA)
module model that the two kernel batches implement:

- custom (user-contract) kernel — task #39 (`contracts/`)
- native kernel — task #40 (`contracts/native/SmartAccount/`)

The DTOs, profiles, storage layout, limits, error codes, events and gas budget
defined here are **common to both versions**. Neither kernel may deviate from or
independently re-design anything in this document. Where a difference between the
two runtimes is unavoidable (e.g. caller/phase enforcement mechanics), it is
explicitly listed as a disclosed capability difference, never as a divergent DTO.

Status: **specification + shared constants + fixtures + both kernels delivered.**
`contracts/custom` and `contracts/native/SmartAccount` implement the surface
described here; `tests/SmartAccount.Contracts.Tests` and
`tests/SmartAccount.Native.Tests` cover them, and both assert the shared vectors in
`tests/SmartAccount.Native.Tests/TestFile/smartaccount-v4-vectors.json`.
`tests/SmartAccount.Contracts.Tests/CrossCoreVectorTests.cs` is that assertion on
the custom side. Nothing here claims on-chain deployment of this source, and the
formal models are reported separately in `docs/SA-FORMAL-VERIFICATION.md`.

Companion documents:

- `docs/SA-MODULE-PROTOCOL.zh-CN.md` — Chinese counterpart (authoritative together
  with this file; on any divergence the newer revision of both wins).
- `docs/SA-MIGRATION-MANIFEST.md` — legacy→v4 migration manifest design (§14).
- `tests/fixtures/sa-module-protocol/README.md` — golden-vector / rejection
  fixture formats and the kernel verification matrix.
- `contracts/custom/SmartAccount.ModuleProtocol.cs` and
  `contracts/native/SmartAccount/SmartAccountModuleProtocol.cs` — the
  paired constant files carrying every numeric value in this spec (§15). Both
  files MUST carry identical values at all times.

## 1. Scope and terminology migration

### 1.1 Terminology

The legacy model used `verifier` for the authorization-deciding module. Protocol
v4 adopts the ERC-7579 term **validator**; `hook` keeps its name. The contract
API, storage, events and error codes use `validator`/`Validator` exclusively; the
old `verifier`/`Verifier` names are removed without aliases (the identity-only
witness entry `verify(accountId)` survives because the proxy script embeds it —
see `docs/SA-EIP-712-SPEC.md` and §13).

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

**Hook ordering.** The core owns one `hookOrder` list per account: the ordered
list of installed hook moduleIds, length ≤ 8. During execution:

- `preCheck` runs in **ascending list order** (forward);
- `postCheck` runs over the **same snapshot in reverse list order**.

The order is snapshot-based: a re-entrant configuration change during execution
does not alter the in-flight sequence. Signatures bind the hook-proof digest
(§5), so a signer cannot be shown a different hook set than the one that will
run.

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
| Web3AuthValidator | EIP-712-style typed payload per `docs/SA-EIP-712-SPEC.md` (domain name `"Neo Smart Account"`), signature 64-byte compact |
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
- Channel bytes in storage keys are 24 bytes, right-aligned big-endian, top 7
  bits zero.
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
| 0x54 | +acctId | core-owned hookOrder list + hookOrderRevision |
| 0x55 | +acctId+intentId[8 BE] | configuration intent record |
| 0x56 | +acctId+channel[24 BE] | nonce cursor (new encoding) |
| 0x57 | +acctId | built-in message signer subjects (≤16 P-256 keys, threshold) + subjectRevision |
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

## 9. Public interface (identical naming in both kernels)

Queries: `getProtocolInfo`, `getAccount(accountId)`, `supportsModuleType(type)`,
`supportsExecutionMode(mode)`, `getModules(accountId, type, cursor, limit)`
(limit 1–32; returns next cursor and current configurationNonce; cursor is
moduleId-based), `getModule(accountId, moduleId)`,
`isModuleInstalled(accountId, type, moduleHash, additionalContext)`,
`getHookOrder(accountId)`, `getPendingConfiguration(accountId, intentId)`,
`getNonce(accountId, validatorId, nonceSubkey)` (packed),
`getNonceSequence(accountId, channel)`,
`getOperationDigest(accountId, operation)`,
`isValidSignature(accountId, hash, signatureEnvelope)`.

Configuration: `proposeConfiguration(accountId, actions, readSet)`,
`confirmConfiguration(accountId, intentId, actions)`,
`cancelConfiguration(accountId, intentId)`.

Actions: `installModule`, `uninstallModule`, `configureModule`,
`setHookOrder`, `setDefaultPolicy`, `rebindModuleCode`, `setThresholdPolicy`,
`setRecoveryPolicy`. A multi-action intent is one atomic proposal — never a
timelock bypass.

Execution: `validateUserOp(accountId, operation)` (read-only, real
verification, structured result), `executeUserOp(accountId, operation)`,
`executeUserOps(accountId, operations)`, `freezeAccount(accountId)`,
`unfreezeAccount(accountId)`, `beginRecovery(...)`, `cancelRecovery(accountId)`,
`executeRecovery(accountId)`.

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
read queries, recovery/escape, and unfreeze; freeze advances the epoch (old
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

Both kernels pin the per-call caps as private constants in their protocol
constant files (`contracts/custom/SmartAccount.ModuleProtocol.cs` and
`contracts/native/SmartAccount/SmartAccountModuleProtocol.cs`):
`ValidationPerCallGasLimit = 100_000_000`, `CompletionPerCallGasLimit =
100_000_000`, `HookCallbackGasLimit = 250_000_000`, `LifecycleCallbackGasLimit
= 250_000_000`. The two validator aggregates are computed from those caps and
`MaxThresholdPolicyMembers` (`ValidationAggregateGasLimit()` /
`CompletionAggregateGasLimit()` in the custom kernel's module section; the hook
aggregate is `HookAggregateGasBudget()`).

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
`contracts/compile.sh` runs `--check` before compiling, so a drifted literal can
never reach an artifact.

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

## 14. Migration manifest (summary — full design in docs/SA-MIGRATION-MANIFEST.md)

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
| custom constants | `contracts/custom/SmartAccount.ModuleProtocol.cs` (partial `SmartAccount`) |
| native constants | `contracts/native/SmartAccount/SmartAccountModuleProtocol.cs` (internal static `SmartAccountModuleProtocol`, synced to neo-native-core via `scripts/sync_native_smartaccount.py`) |
| fixture skeletons | `tests/fixtures/sa-module-protocol/` (README + schemas + templates) |

Both constant files carry identical numeric values for: protocol version 4;
module type codes 1/4; all §3 limits; 13-field envelope field indices; nonce
sizes (32-byte subkey, 24-byte channel); serialized-size caps (4096/8192/4096/
16384/65536); delays (86 400 000 / 604 800 000 / 7 776 000 000 ms); gas budgets
(100 000 000 / 250 000 000 datoshi); ERC-1271 magic (0x1626ba7e / 0xffffffff);
domain strings ("NeoSmartAccount/UserOperation", "NeoSmartAccount/Message");
storage prefixes 0x50–0x5E; the §10 error-code strings; §10bis event display
names; and the fixed-width big-endian key-suffix encoding (both files provide
the same key builders: `UInt64ToBigEndian`, per-prefix composite key builders).

## 16. Kernel implementation mapping (tasks #39 / #40)

### 16.1 Custom kernel (#39, shares its batch with #25)

| Spec section | Custom files to create/modify |
| --- | --- |
| §2/§3/§7 constants | consume `contracts/custom/SmartAccount.ModuleProtocol.cs` (already added; add to `SmartAccount.csproj` — done in this batch) |
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
| profile sources | `<Name>.profile.json` next to every module, literal embedded as `ModuleProfileJson`, kept in sync by `scripts/sync-module-profiles.mjs` and gated by `contracts/compile.sh` (§12.1) |
| build layout | `contracts/compile.sh` emits `contracts/bin/public` for the core, services and mocks, `bin/public/validators`, `bin/public/hooks`; nccs compiles every project in the directory it is given |

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
