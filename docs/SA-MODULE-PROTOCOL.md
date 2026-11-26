# SmartAccount module protocol

This unpublished protocol defines one native core and its modules. The [current parameters](proposals/smartaccount-native-profile-parameters.json) bind the implementation, packaging and wallets. The [implementation profile](../contracts/native/profile.json) lists open conformance gates.

The authoritative implementation sources are the [v4.1 IDL](proposals/smartaccount-v4.1.idl.json) and [SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md). This document describes module behavior under the closed 26-method native ABI frozen there. The native core exposes `installModule`, `removeModule`, `configureModule`, `setBuiltinAuthorization`, `applyConfigurationActions`, `revokeModuleCredentials`, `resetAccount` and the read-only module queries. Custody may execute ordinary UserOps, freeze and revoke credentials immediately. Module installation, removal, configuration, built-in authorization changes and ordinary unfreeze take effect only through a mature GovernanceModule confirmation (24 h delay, 7-day window); the core stores no governance intent. Message signatures are verified by SigningModule, the only public message entry; the native core has no `isValidSignature`. Use the [standard module directory](../contracts/modules/README.md) to find the corresponding contract. The protocol is not publicly activated.

Companion documents:

- [Core protocol NEP](proposals/nep-smartaccount-entry-verifier.mediawiki): account identity, the operation and authority.
- [Module interface NEP](proposals/nep-smartaccount-module-interface.mediawiki) and [named module NEP](proposals/nep-smartaccount-module-profiles.mediawiki): discovery format, callbacks and requirements for each implementation.
- [Chinese counterpart](SA-MODULE-PROTOCOL.zh-CN.md).
- `tests/fixtures/sa-module-protocol/README.md` — golden-vector / rejection
  fixture formats and the kernel verification matrix.
- `contracts/native/SmartAccount/SmartAccountModuleProtocol.cs` — the constant
  file carrying every numeric value in this spec (§15).

## 1. Scope and terminology

### 1.1 Terminology

A validator decides authorization. A hook checks policy before and after execution.

Module kinds (one-byte type code, ERC-7579 numbering):

| Type | Name | Supported in |
| --- | --- | --- |
| 1 | validator | yes |
| 2 | executor | unsupported; installation is rejected |
| 3 | fallback handler | no — same |
| 4 | hook | yes |
| 5 | recovery seat (native extension) | yes; one per account |

Types 2 and 3 are not aliases of validator/hook. Declaring support without an
implementation is forbidden; the profile says "not supported", not "maybe".

### 1.2 Standard modules

See the [module directory](../contracts/modules/README.md) for installable modules and their responsibilities.

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

Profile limits (protocol-level; the native core enforces them unless the row names
the standard module that owns the rule; values pinned in §15 constant files):

| Limit | Value |
| --- | --- |
| validator instances per account (incl. threshold members) | 32 |
| hook instances per account | 8 |
| threshold policy members per policy | 10 |
| threshold value | 1–10 |
| composite graph depth | 1 layer (no nesting, no cycles) |
| actions per governance configuration proposal, or per `applyConfigurationActions` group | 16 |
| unresolved governance configuration proposals per account (kept in the module's own storage) | 16 |
| enumeration page size (`getModules` limit) | 1–32 |

These are protocol caps, **not** performance guarantees: legal worst-case
combinations (10 threshold members, 8 hooks, maximum proofs) must be measured
against the declared system fee (§11) before any release claim; passing "over-limit is
rejected" alone is not acceptance.

**Hook ordering.** Hook order is HookOrchestratorModule state, not a native record. It changes only through a governance-delayed `configureModule` callback to that module; the core stores no order and exposes no setter. During execution the core calls the account's single `hookPlanner` instance (`planHooks`), validates the reply as a permutation of the installed hook ids, freezes it in engine-local invocation state and consumes it exactly once for that operation: `preCheck` runs in the planned order (forward), `postCheck` runs over the same frozen set in reverse. A re-entrant configuration change during execution does not alter the in-flight sequence. Signatures bind the hook-proof digest (§5), so a signer cannot be shown a different hook set than the one that will run.

**Recovery is module state.** The recovery policy setter, governance action 8, the recovery authority, the recovery delay and the recovery begin/cancel/execute/status entries belong to RecoveryModule. The native core stores no recovery policy, guardian roster or timelock and exposes no recovery setter. The only native recovery landing is `resetAccount`, which accepts only the account's currently installed, code-bound recovery module after that module has matured its own record; the core checks binding and landing only. `ownerOnlyRecovery` is a reserved field in 0x51 and carries no authorization meaning; clients must not present it as an authority feature.

## 4. Operation — canonical encoding

### 4.1 Wire shape

A UserOperation is a **strict 13-field NeoVM `Array`** (a `Struct` anywhere in
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

Operation-level cap: one operation encodes to ≤16384 bytes, the sum of args 4096 +
signature 8192 + hookProofs 4096. It is only a backstop and costs the user nothing;
every transaction carries exactly one operation. Extra fields, duplicate
hook proofs, unsorted proofs, or non-canonical integers (negative or
out-of-domain values where the field declares a domain) are rejected.

### 4.2 Canonical serialization

The canonical byte form of the unsigned operation is the NeoVM binary
stack-item serialization of the same 13-field Array with `[11] signature`
replaced by an **empty ByteString**. The native core produces it with
`Neo.VM.BinarySerializer.Serialize`; golden vectors
(§15 fixture set) pin those bytes.

### 4.3 Operation digest and signing domain

```
domain := UTF8("NeoSmartAccount/UserOperation")        // 29 bytes
         || U1 (version = 4)
         || U32LE (network magic)
|| coreHash, 20 raw bytes, the *actual* executing native core hash;
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
| TeeKeyValidator | 96 bytes: 32-byte key id (`SHA256(compressedPublicKey)`, must equal the configured key's id) ‖ 64-byte P-256 `r‖s` over the member/operation digest; no attestation quote is verified on chain |
| Web3AuthValidator | EIP-712-style typed payload per `docs/SDK.md` (domain name `"Neo Smart Account"`), signature 64-byte compact |
| P256Validator | raw P-256 `r‖s` (64 bytes) against the instance's configured key |
| DelegatedIdentityValidator | configured P-256 signer signature + identity commitment |
| built-in (validatorId = 0) | one canonical P-256 custody script and its signature over the operation digest |

Threshold routing: a threshold policy is a validator instance whose module owns
the member roster and quorum. During validation the core calls that instance
once; the instance enumerates its own members and calls the narrow
`validateMember(accountId, memberId, operationDigest, operation)` landing for
each leaf. The landing rejects duplicates, nested composition, non-leaf members
and more than 10 members, and records approvals in core-local invocation state;
`postCheck` runs completion only for the members approved in the validation
phase. The core never reads a roster or quorum. Member changes are module
configuration and take effect only through the mature GovernanceModule path;
enrollment advances the authority epoch, invalidating earlier recovery requests.

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
- Plugins do not keep private sequence counters that must be kept in exact sync
  with the core cursor; the core nonce is the single sequence source
  (SubscriptionValidator consumes the core nonce only).

`configurationNonce` is **not** an operation nonce: it advances monotonically
on every committed security configuration, credential revocation,
freeze/unfreeze, recovery and custody change; operation consumption and quota
counters never advance it; cleanup and uninstall never reset it.

### 6.1 Which generation a route binds

`credentialGeneration` is not a global counter: it identifies the routing
subject's current credential set, and the core resolves it from the route (it is
never a caller-supplied default, and no ABI method publishes it for the built-in
route).

| Route | Bound generation | Record |
| --- | --- | --- |
| built-in (`validatorId` = 0) | 1 for operations | custody in account control |
| installed validator instance | that instance's `CredentialGeneration` | 0x52 |

Consequences that hold in the native core:

- A basic account receives assets at its proxy address and spends with one custody signature.
  Its operation generation is 1. A custody change invalidates prior signatures through
  the authority epoch. The message entry is owned by SigningModule; the native
  core grants it no message authority.
- An installed instance starts at generation 1 and advances on
  `revokeModuleCredentials` only — an administration-authorized, callback-free
  revocation that retires every signature bound to the old generation at once.
  Rebinding a module's code advances `moduleRevision`, not the credential generation.
- A mandatory validator is an installed instance and binds its own instance
  generation. Reset removes every instance and advances the authority epoch.
  The ID allocator never reuses an ID.
- Because the generation is inside the §4.3 domain, a stale value is not a
  retryable nonce mismatch. An operation with a mismatched route generation
  faults with `SA_CREDENTIAL_STALE`. Revocation also advances the configuration
  nonce, so an operation signed before it normally faults earlier with
  `SA_CONFIGURATION_NONCE_STALE`; the credential fault is reached only by an
  operation that carries the current nonce. The message path is owned by
  SigningModule: its generation check happens inside that module's
  `isValidSignature` callback, not in a native entry, and its failure channel is
  module-defined.
- `getNonce` resolves the generation internally and returns the channel the core
  would use. A caller may cross-check it against its own derivation, but the
  core's answer is authoritative.

## 7. Storage layout plan

### 7.1 Shared 0x50–0x5F region (the native core, identical key bytes)

Key construction: 1-byte prefix ‖ raw 20-byte accountId ‖ fixed-width
**big-endian** integer suffixes where noted. 0x50 is the only bare key. All
integer key suffixes are fixed-width big-endian.

| Prefix | Key suffix | Use |
| --- | --- | --- |
| 0x50 | bare | protocol info |
| 0x51 | +acctId | account control metadata (§7.2) |
| 0x52 | +acctId+moduleId[8 BE] | module instance record (14 fields: type[1], contractHash, contractId, updateCounter, nefSha256, profileSha256, moduleRevision, credentialGeneration, instanceIsolation, messageCapability, thresholdMemberEligible, compositeLayer, governance, hookPlanner) |
| 0x53 | +acctId+type[1]+moduleId[8 BE] | installed-instance enumeration index (marker rows; per-type ascending-moduleId scan; type is validator 1, hook 4 or recovery 5) |
| 0x56 | +acctId+channel[24 BE] | nonce cursor |
| 0x5C | +acctId+channel[24 BE] | nonce namespace full digest (collision detection) |

Every other prefix of the range — 0x54, 0x55, 0x57–0x5B and 0x5D–0x5F — is
reserved and unallocated. Hook order, message roster and threshold policy are module state and keep their own storage. Configuration proposals are not core state either: the
standard governance module keeps them under its own storage prefixes.

Outside the range, `0x11 ‖ proxyAddress → accountId` indexes every registered
account. Registration refuses a custody address that is an account proxy
address or the core itself, and a proxy address that is already a custody
address.

The 0x50–0x5F byte range must be re-scanned on both networks before any
upgrade; unknown occupied keys abort the upgrade — they are never overwritten.

### 7.2 0x51 account control metadata

A 9-field array in this fixed order: status (Active/Frozen), custody,
authorityEpoch, configurationNonce; nextModuleId (the moduleId allocator); the
default operation authorization switch and the default message authorization
switch; `requiredValidatorId` (the mandatory route; 0 while every validator
instance may be routed); controlRevision. Registration writes
`Active, custody, 1, 0, 1, true, true, 0, 1`. Recovery, threshold, message
roster and hook order are not control fields: they belong to modules.

### 7.3 0x52 code binding (identical definition in the native core)

contractHash, ContractId, UpdateCounter, SHA256(NEF bytes), SHA256(canonical
module profile JSON). ContractId blocks destroy-and-redeploy; UpdateCounter
catches manifest-only updates; NEF hash pins code; profile hash pins interface
capability. Binding is checked before and after every module callback and before
commit; an address re-deploy does not inherit authorization. The per-callback
check compares `(ContractId, UpdateCounter)` only — the pair names exactly one
(deployment slot, revision), so it proves the same thing the record's install-time
NEF hash pins, without re-hashing the NEF on every callback.

## 8. Message signatures (SigningModule, ERC-1271 profile)

The native core defines no message entry. SigningModule is the only public
message-signature entry and owns the message domain, the subject roster, the
quorum and the ERC-1271 answer.

API (module): `SigningModule.isValidSignature(accountId, originalSender, validatorId, credentialGeneration, hash, pairs)`.
- `hash` is the caller-supplied 32-byte message digest.
- The module returns the strict 4-byte magic value `0x1626ba7e` (ERC-1271 `MAGICVALUE`)
  on success and a different fixed 4-byte value (`0xffffffff`) on failure; it must
  not throw as its success channel.
- Message validation is read-only: it does not consume operation nonces and
  cannot be satisfied by a transaction witness (a contract custody passing
  `CheckWitness` does not thereby produce an offline message signature).

The module binds its own message digest domain, for example:

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

The exact bytes belong to the deployed SigningModule profile; the native IDL
deliberately publishes no message domain and no message method. The module's
subject roster, threshold and credential generation are its own state. A custody
rotation through `resetAccount` changes the account epoch and invalidates prior
message signatures; it does not rewrite a module roster. None of these message
settings grants permission to transfer assets.

### 8.1 Message subjects

SigningModule owns the subject set: the built-in custody key may be one subject,
but the native core stores no subject roster. An account with the module
installed reads its subjects from the module, never from a native query.
SessionKey and Subscription validators do not declare arbitrary-message
capability by default. An account without a message-capable module has no public
message entry.

## 9. Public interface (identical naming in the native core)

Queries: `getProtocolInfo()`, `getAccountImplementationId()`, `getAccount(accountId)`
(`[exists, status, custody, authorityEpoch, configurationNonce,
defaultOperationAuthorization, defaultMessageAuthorization, requiredValidatorId,
controlRevision]`; an unknown account answers `false` and zeroes), `getAccountAddress(accountId)`,
`getModules(accountId, moduleType, cursor, limit)` (limit 1–32; returns
`[items, nextCursor, configurationNonce]`; cursor is moduleId-based), `getModule(accountId, moduleId)`
(the 14 record fields of §7.1 preceded by `moduleId`; an empty array when the
instance is missing), `isModuleInstalled(accountId, moduleType, moduleHash, additionalContext)`,
`getAuthorizedModuleId(accountId, phase)`, `getNonce(accountId, validatorId, nonceSubkey)` (packed),
`getNonceSequence(accountId, channel)`, `getOperationDigest(accountId, operation)`. There is no native message or threshold query: SigningModule and ThresholdPolicyModule own those reads.

Registration: `createAccount(accountId, custody, salt, actions)` and the batch
`createAccounts(accountIds, custody, salts)`. The batch requires 1–64 id/salt
pairs of equal length, shares one custody witness and registers every account
without registration actions. `actions` holds at most 16 initial action arrays
and only install actions (code 1) are accepted: they run
atomically after the control record is written and the group advances the
configuration nonce once, installing the §1.2 default composition in the
registering call. Configure, remove, setBuiltinAuthorization and
setRequiredValidator are governance paths and are rejected in the initial group.
The core holds no recovery timelock or policy: RecoveryModule sets its own delay.

Configuration: `installModule(accountId, moduleType, moduleContractHash, initData)`,
`removeModule(accountId, moduleId, deInitData)`, `configureModule(accountId, moduleId, data)`,
the grouped `applyConfigurationActions(accountId, actions)` and the restricted
landing entries `setBuiltinAuthorization(accountId, defaultOperationAuthorization, defaultMessageAuthorization)`
and `revokeModuleCredentials(accountId, moduleId)`. Install, remove, configure,
setBuiltinAuthorization and the grouped entry accept only the governance caller;
`revokeModuleCredentials` accepts the custody witness or the governance caller. Each
requires an Active, idle account and advances the configuration nonce exactly
once (the grouped entry once for the whole group). The core keeps no intent
record, maturity window or cancellation path. The governance module owns those
records and submits the matured actions in the signed order (§10).

The administration caller of the governed transitions (install, remove,
configure, setBuiltinAuthorization, `applyConfigurationActions` and ordinary
unfreeze) is resolved by the core as follows: the direct caller must be an
installed validator instance of the account that declares `governance` and
whose code binding still matches; any other caller, custody included, fails with
`SA_UNAUTHORIZED`. The standard GovernanceModule is such an instance and
submits the actions after its own 24-hour delay (§10); the core holds no delay.
Custody keeps the immediate emergency entries `freezeAccount` (custody-only) and
`revokeModuleCredentials`. `resetAccount` is restricted to the bound recovery
seat (§9).

Action codes are install (1, `[1, moduleType, moduleHash, profileDigest, initData]`), remove (2, `[2, moduleId, deInitData]`),
configure (3, `[3, moduleId, data]`), built-in authorization (5, `[5, operation, message]`) and
required validator (7, `[7, validatorId, required]`); any other code fails with `SA_OPERATION_MALFORMED`. The initial group on `createAccount` accepts only install actions.

Execution: `validateUserOp(accountId, operation)` (read-only, real
verification, structured result), `executeUserOp(accountId, operation)`,
`freezeAccount(accountId)`, `unfreezeAccount(accountId)` (governance caller only).
A transaction carries exactly one operation. Recovery is
a module: `beginRecovery`, `cancelRecovery`, `executeRecovery` and status reads
are RecoveryModule methods, so the core exposes none of them beyond the
restricted `resetAccount` landing entry.

`resetAccount(accountId, newCustody)` is that landing entry. It accepts only
the account's installed recovery seat (type 5, one per account) as the calling
contract; custody and every other caller fail with `SA_UNAUTHORIZED`. It
removes every instance and nonce row, writes `newCustody`, restores the
registration switches with status Active and `requiredValidatorId` 0, and
advances the authority epoch, the configuration nonce and the control revision.
The id allocator is kept.

Composite validation: `validateMember(accountId, memberId, operationDigest, operation)`
is callable only by the composite validator that is being validated, and only
for the exact operation bytes and digest of that validation. It runs the leaf
member's `validateUserOp` under the member-validation phase: at most 10 members,
no duplicates, no nested composition.

The witness entry `verify(accountId)` is embedded in the fixed proxy
verification script and answers the witness check with admissibility only
(§11.1): it authorizes nothing and grants no frame of its own.

Lifecycle module callbacks (core→module): `onInstall(accountId, moduleId,
moduleType, initData)`, `onUninstall(accountId, moduleId, moduleType,
deInitData)`, `configure(accountId, moduleId, moduleType, configData)`,
`preCheck` / `postCheck` (hooks), `validateUserOp` /
`onUserOpComplete` (validators), each running inside the transaction's declared
system fee (§11.1). Each module decodes its own `configData` through the core configuration gate; the core keeps no per-method allowlist.

### 9.1 Callback ABI as compiled

Manifest names are the C# method names with the first character lower-cased
(`OnInstall` → `onInstall`, `ValidateUserOp` → `validateUserOp`). `preCheck`
parameter is named `operation`; `postCheck` last parameter is named `hookData`.
Type names below are manifest parameter types.

| Direction | Operation | Manifest ABI | Notes |
| --- | --- | --- | --- |
| core→module | `getModuleProfile()` | `→ String`, **safe** | Canonical profile bytes, ≤ 2048 bytes, no arguments, no writes. |
| core→module | `onInstall(accountId, moduleId, moduleType, initData)` | `Hash160, Integer, Integer, Array → Void` | `initData` is a command array (see §9.3) or empty. |
| core→module | `configure(accountId, moduleId, moduleType, configData)` | `Hash160, Integer, Integer, Array → Void` | Same command shape; runs at the configuration phase. |
| core→module | `onUninstall(accountId, moduleId, moduleType, deInitData)` | `Hash160, Integer, Integer, Array → Void` | Must clear every instance-scoped key of `(accountId, moduleId)`. |
| core→module (validator) | `validateUserOp(accountId, operationDigest, operation)` | `Hash160, ByteArray, Array → Boolean`, **safe** | `operationDigest` is the §4.3 core digest; `operation` is the canonical 13-field view. |
| core→module (validator) | `onUserOpComplete(accountId, operation, result)` | `Hash160, Array, Any → Void` | Completion phase only; `result` is the sanitized target result. |
| core→module (hook) | `preCheck(accountId, operation)` | `Hash160, Array → ByteArray` | Returns instance `hookData`; `null` is normalised to the empty byte string; at most 512 bytes or `SA_HOOK_DATA_TOO_LARGE`. |
| core→module (hook) | `postCheck(accountId, operation, result, hookData)` | `Hash160, Array, Any, ByteArray → Void` | Receives exactly the bytes the same instance returned from `preCheck`; never another instance's. |
| core→module (validator, `messageCapability`) | `isValidSignature(accountId, originalSender, validatorId, generation, hash, signatures)` | `Hash160, Hash160, Integer, Integer, ByteArray, Array → Boolean`, **safe** | `hash` is the message digest; SigningModule owns the domain, subject roster and quorum and verifies it directly. Callers are limited to `ReadOnly`. |
| core→module (validator, `hookPlanner`) | `planHooks(accountId, operationDigest, operation)` | `Hash160, ByteArray, Array → Array`, **safe** | Returns the hook order for this operation: exactly one id per installed hook, each installed, no duplicates — otherwise `SA_PROOF_INVALID`. One planner per account (`SA_MODULE_LIMIT_PLANNER`). |

Binding order at install: profile digest → profile parse (version, module type,
contract name, capabilities) → the complete callback surface above. Missing
methods fail before the instance is written; `getModuleProfile` and the
validation/message callbacks must be declared `safe`, so a caller passing write
flags still cannot write from them. Hook pre/post are write-capable by design
(they meter balances) but run with the hook's own instance keys only.

Replies are typed, not coerced. `validateUserOp` approves only when it
returns exactly `Boolean true`; any other reply type is an ABI violation and
faults with `SA_CALLBACK_RETURN_TYPE`, in the execution path and in the
read-only preview alike. `isValidSignature` must never fault — ERC-1271 has to
fail closed — so a reply that is not a `Boolean` counts exactly like
`Boolean false`. `preCheck` replies must be `ByteArray` (the same violation
otherwise), `getModuleProfile` replies must be `String` or installation fails
with `SA_MODULE_CODE_BINDING_MISMATCH`, and every `Void` callback must leave the
evaluation stack empty.

### 9.2 Instance authentication (module side)

A module never trusts a caller-declared instance. It resolves one in this order:

1. `authorizedCore()` (module storage) must equal `Runtime.CallingScriptHash`;
   a zero or invalid core fails with the plain message `SA core not configured`
   (not a protocol code), any other caller with `Unauthorized caller`. The
   standard modules under `contracts/modules` raise `SA_PHASE_VIOLATION` and
   `SA_UNAUTHORIZED` for the same two cases.
2. The core answers `getAuthorizedModuleId(accountId, phase)` with the instance
   it is currently addressing. Phases are `Validation 1`, `HookPre 2`,
   `TargetDispatch 3`, `HookPost 4`, `Completion 5`, `Configuration 6`;
   member validation is `8` and hook planning `9` (`Cleanup 7` is reserved and
   never granted); `0`
   means the phase does not address this module. Lifecycle callbacks are
   authorised only when phase 6 returns exactly the `moduleId` they received.
3. `validateUserOp` runs during the read-only preview with no writer phase; the
   module then uses `operation[validatorId]` (index 7) as its instance id.
4. `getModule(accountId, moduleId)` returns the descriptor
   `[moduleId, moduleType, contractHash, contractId, updateCounter, nefSha256,
   profileSha256, moduleRevision, credentialGeneration, instanceIsolation,
   messageCapability, thresholdMemberEligible, compositeLayer, governance,
   hookPlanner]`. Index 8 (`credentialGeneration`) binds a member's signature
   to its own instance.
5. The asset-holding script hash is `getAccountAddress(accountId)`.

The instance key is `prefix (1 byte) ‖ accountId (20 bytes) ‖ moduleId
(8 bytes, big-endian)`; modules never key on a caller-supplied context blob.

### 9.3 Configuration command arrays

All three lifecycle data arguments are VM Arrays. Build `initData` from the
named profile's [installation forms](proposals/nep-smartaccount-module-profiles.mediawiki#Installation_data).
For a configurable module, `configData` is one `[command, ...args]` array.
For ordinary removal of any enabled named module, send `deInitData = []`;
there is no uninstall command. Third-party profiles define their own data semantics.
The core bounds each array (§3).
Shipped modules use these configuration commands:

| Module | Commands |
| --- | --- |
| `P256Validator`, `Web3AuthValidator`, `TeeKeyValidator` | `setPublicKey(publicKey)` — 33-byte compressed or 65-byte uncompressed, stored compressed. |
| `NeoWitnessValidator` | `setSigners(signers[], threshold)` |
| `MultiSigValidator` | `setMemberKey(publicKey)` — one key per instance. |
| `SessionKeyValidator` | `setSessionKey(publicKey, target, method, validUntil, spendingLimit, description)` / `clearSessionKey()`; expiry is a Unix timestamp in milliseconds |
| `SubscriptionValidator` | `createSubscription(subId, merchant, token, amount, periodSeconds)` / `cancelSubscription(subId)`; [billing and ID rules](proposals/nep-smartaccount-module-profiles.mediawiki#SubscriptionValidator) |
| `DelegatedIdentityValidator` | `setConfig(publicKey, provider, masterNullifier)` |
| `ZKEmailVerifier` | none — the proof verifier is not deployed, so every callback fails closed. |
| `ActionSessionValidator` | `setRecoveryService(service)` / `clearRecoveryService()` |
| `DailyLimitHook` | `setDailyLimit(token, maxAmount, useRollingWindow)` / `clearDailyLimit(token)` |
| `TokenRestrictedHook` | `restrictToken(token)` / `unrestrictToken(token)` |
| `WhitelistHook` | `allowTarget(target)` / `denyTarget(target)` |
| `NeoDIDCredentialHook` | `requireCredential(target, provider, claimType, commitment)` / `clearRequirement(target)` |
| `MultiHook` | none — the core does not admit this module type. |
| `HookOrchestratorModule` | none. `initData` is `[]`, or `[hookIds[]]` to confirm the installed hook order in the same call that installs the module; the list must equal the account's installed hook set in ascending order. |
| `GovernanceModule` | none — `initData` must be `[]`; configuration travels through its own proposal entries (§10). |
| `RecoveryModule` | none — `initData` must be `[]`; recovery requests travel through its own entries (§12). |
| `SigningModule`, `ThresholdPolicyModule` | none — `initData` must be `[]`; read adapters without configuration. |

### 9.4 Division of responsibility between core and modules

This document is the normative source for module behavior; the PDF reading edition is generated from it. The division of responsibility it fixes:

1. Recovery policy and the recovery delay are RecoveryModule state; the core has no recovery policy setter.
2. Message subjects, member rosters and threshold policies are module state.
3. Module configuration lands through the generic `configureModule` and `applyConfigurationActions` pair; the closed v4.1 ABI has 26 public methods.
4. Registration carries caller-supplied `actions` instead of a fixed default composition, so the core holds no module hash.
5. Hook planning and the hook bracket are core-executed. The core calls the account's single `hookPlanner` instance (`planHooks`), freezes the returned order, then dispatches `preCheck` / `postCheck`, the member callbacks and completion itself. Ordering, snapshot freeze, `hookData` pairing and code-binding re-checks stay host-enforced facts instead of module promises.
6. Every administration entry except freeze and credential revocation accepts only the account's code-bound `governance` caller.
7. There is no per-call or aggregate gas budget: callbacks run inside the transaction's declared system fee (§11.1).
## 10. Lifecycle, governance intents and time locks

For the governance proposal path, normal configuration (empty-slot install, uninstall, hook order change,
signer change, default-authorization toggles, code rebinding) — **24 h delay
uniformly** (86 400 000 ms).

Exceptions:
- new account registration installs the full initial configuration atomically
  (no assets or prior policy exist);
- emergency freeze is immediate;
- callback-free credential revocation of a validator is immediate — a
  core-defined one-way revocation (generation bump); a module cannot interpret
  "revoke" as a grant;
- recovery runs the RecoveryModule's own timelock; the core landing is `resetAccount`.

Pending intents are governance-module state, not core state. The standard
governance module allocates the per-account `intentId` from its own counter and
stores each record under its own prefix (§7.1); the core's `nextIntentId` is a
reserved layout field. At most 16 intents may be unresolved per account;
`proposedAt + 24 h = matureAt`; `expiresAt = matureAt + 7 days`
(604 800 000 ms). An intent binds the authorityEpoch, the configurationNonce
and the exact serialized action bytes; confirmation must resubmit those bytes
unchanged, is refused before maturity (`SA_INTENT_IMMATURE`) and after expiry
(`SA_INTENT_EXPIRED`), and deletes the record before the actions run. A proposal
whose action digest or resource set (action-derived keys plus the declared read
set) intersects a pending intent is refused at submission
(`SA_INTENT_CONFLICT`), never queued or merged. After a commit only the stale or
conflicting intents are invalidated, not every pending one. Expired records are
cleaned by the explicit cancel entry or by the next proposal. Proposing,
confirming and cancelling an unexpired intent each require the custody
witness; an installed validator that calls these entries is not an
administration witness, and anyone may clean an expired one. While the
account is Frozen only the unfreeze intent may be proposed, confirmed or
cancelled.

SigningModule owns the message subject set and quorum; ThresholdPolicyModule owns
the member roster and threshold. Neither is a native action and neither is a
native query. A governance proposal that changes them is a module proposal
submitted to the corresponding module; the native core receives only the generic
configuration callbacks described in §9.

Separate proposals containing only the governed module actions may confirm in
either order when their resources are disjoint. The checkpoint covers one
observed commit, including a batch, and preserves the original receipt and
deadline. Threshold resources include the policy, members being released or
acquired, and the shared allocation dependency for new or unknown IDs. Changes
outside governance and callbacks with unknown effects cannot renew a stale
approval. Unknown actions are rejected
before an intent id is allocated.

**Atomic configuration.** The core method
`applyConfigurationActions(accountId, actions)` accepts 1–16 ordered actions:
install (1), remove (2), configure (3), set built-in authorization (5) and
required validator (7), with the same field types as the proposal. A successful
group advances the account configuration nonce and control revision exactly
once. A fault in any action or the final route check commits no writes. Removing
the last validator with built-in operation authorization closed fails; the same
group may reopen the route. Every governed
action reaches this sink through the account's governance caller: the standard
GovernanceModule submits it after a mature confirmation. The core stores no
delay or intent. `createAccount` accepts only
initial install actions (code 1).

In the governance module, core actions must form one consecutive group. Module actions may
precede or follow it; the exact proposed order is preserved. A proposal that separates
core writes with a module action is refused before an ID is issued. The module also checks
the final nonce: an unexpected second increment during callbacks faults the entire confirmation.
The core exposes 26 native methods and binds its governance artifacts in the profile parameter digest. Clients check both the method descriptors and the declared parameter digest during discovery.

Custody can call `SmartAccount.freezeAccount` immediately; freeze is the
emergency path and is never governance-delayed. `GovernanceModule.unfreezeAccount`
creates a proposal whose confirmation must wait 24 h; only the mature
confirmation reaches the native `unfreezeAccount` landing. The core accepts
the governance caller only; a direct custody thaw fails with `SA_UNAUTHORIZED`.
Freeze
and thaw advance the authority epoch.
Removing the last validator requires built-in operation authorization to be enabled by the
end of the same configuration group; existing hooks remain. No fallback is enabled implicitly.

The standard recovery seat accepts a request from custody or the configured recovery
authority. Only the installed, code-bound seat can call the core reset. The
per-account timelock is 7–90 days; recovery requests are never overwritten or
restarted by another request; matured execution is permissionless and applies
the exact approved result;
it advances authorityEpoch/configurationNonce, removes every module instance and nonce row,
invalidates pending governance intents and restores built-in authorization.
The reset and the landing of the approved composition are one transaction: the transaction
has to end with a governance-capable, code-bound validator, otherwise it faults as a whole
(`SA_UNAUTHORIZED`) and the reset is rolled back with everything else in it.

## 11. Gas and measured cost

### 11.1 Witness and fee model

Transaction shape: the account's verification script is fixed and calls only
`verify(accountId)`. The operation is carried in the transaction script as the
argument of exactly one `executeUserOp(accountId, operation)` call.

`verify` performs admissibility only: the caller is the account's proxy and the
proxy is not the payer of the transaction; the account exists and is Active; the
transaction script is that one `executeUserOp` call (recognized in
`ValidateEntryScript` by a fixed-tail byte comparison followed by literal
decoding, the literal being bounded to twice the operation size before it is
decoded; the core never executes or builds a script); the deadline, authority
epoch and configuration nonce are current; the nonce is available. `verify`
checks no signature and calls no module, because Neo caps the fee of one witness
at 1.5 GAS. Under the Application trigger only the proxy frame inside its own
target dispatch answers true. Nested frames of the target call do not count as
the target, so the proxy cannot move NEO or GAS through a target contract that
itself calls `NEO.transfer`; only a direct native target can.

Authorization happens once, in `executeUserOp`: for `validatorId = 0` the built-in
signature (one SHA-256 over the domain-separated canonical operation, verified
with P-256), otherwise `validateUserOp` of the installed validator instance. An
invalid signature therefore passes the witness check and is rejected at
execution: the transaction faults, nothing changes, and the fee is still
burned. Relayers should simulate first.

The core sets no gas limit of its own. There is no per-call budget, no aggregate
limit, no `System.Contract.CallWithGasLimit` and no `MinimumRequiredFee`. The declared `SystemFee` is the only limit, and Neo burns it in
full. The wallet declares what the simulation consumed.

The engine keeps only the state the kernel needs: the account re-entrancy lock,
the current callback identity (module id, contract, phase), the target anchor
frame for witness authorization, the composite validation state and the
restricted initialization after a reset. The proxy and the native contract hash
can never become the witness of an unintended frame.

Bounds that shape the worst case are pinned in the protocol constant file
(`contracts/native/SmartAccount/SmartAccountModuleProtocol.cs`): `HookDataBytesMax
= 512`, `ModuleProfileBytesMax = 2048`, `ArgsCountMax = 64`,
`HookProofsEntriesMax = 8`, `HookProofBytesMax = 4096` (aggregate),
`OperationEncodedSizeMax = 16384`. `getModuleProfile` runs with
`CallFlags.ReadStates`: a profile cannot read balances, call other contracts
or write.

### 11.2 Measured cost

Datoshi = 1e-8 GAS; ExecFeeFactor 30, `HF_Huyao` enabled, default Policy. The
first column is the execution engine; the second is the engine that runs the
proxy verification script. The wallet total is the declared system fee plus the
network fee, as quoted on the wallet path (datoshi, GAS in brackets).

| Scenario | Execution engine | Proxy witness engine | Network fee | Total a wallet pays |
| --- | --- | --- | --- | --- |
| Ordinary NEO transfer | 9,915,830 | not applicable | 1,227,520 | 11,143,350 (about 0.111 GAS) |
| Custodial single key, transfer | 12,866,237 | 1,966,546 | 3,548,066 | 16,414,303 (about 0.164 GAS) |
| Module-routed 1-of-1 | 18,274,253 | 1,966,546 | 3,425,066 | 21,699,319 (about 0.217 GAS) |
| Threshold 2-of-3 | 26,631,930 | 1,966,546 | 3,425,066 | 30,056,996 (about 0.301 GAS) |
| Threshold 10-of-10 | 55,883,801 | 1,966,546 | 3,425,066 | 59,308,867 (about 0.593 GAS) |

Network fee = custody signature cost 983,520 + proxy witness engine + byte fee
(1,000 per byte; 244 bytes for an ordinary transfer, 598 for the custodial
transfer and 475 for the module scenarios). With `HF_Huyao` disabled every
figure is slightly higher (custodial transfer: 13,051,820 execution engine,
2,028,330 witness engine, 3,609,850 network fee, 16,661,670 total, about
0.167 GAS).

Earlier revisions of this document quoted 3.0 to 15.4 GAS for the same
scenarios; those figures are obsolete.

## 12. Module capability declaration profile

Every installable module ships a canonical profile JSON (the profile hashed
into the 0x52 binding). Schema (skeleton in
`tests/fixtures/sa-module-protocol/module-profile.template.json`):

```json
{
  "profileVersion": 1,
  "moduleType": "validator",
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

The example is a validator. Hooks and recovery seats have their own callback lists;
see the [module interface](proposals/nep-smartaccount-module-interface.mediawiki)
and the [named profiles](proposals/nep-smartaccount-module-profiles.mediawiki).

- `instanceIsolation: true` is required for multiple instances of the same
  contract address on one account.
- `messageCapability` gates §8 module message signing. **SessionKeyValidator
  and SubscriptionValidator declare `messageCapability: false` by default** —
  restricted execution credentials must not become arbitrary offline
  authorizations.
- `thresholdMemberEligible` marks scalar validators that may join a threshold
  policy. It is a necessary condition only (see the note under the §12 matrix).
- `compositeLayer` ≤ 1 (one layer; no nesting/cycles).
- `governance` and `hookPlanner` are optional seat flags, absent when false and
  never `false` when present. Only validators may declare them. The core records
  the two bits of the 0x52 descriptor from these fields: a delayed configuration
  landing is only accepted from an instance declaring `governance`, and
  `planHooks` is only called on the single instance declaring `hookPlanner`
  (which must also expose the safe `planHooks` callback).

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
`scripts/sync-module-profiles.mjs --check` fails on STALE/ERROR; run it before building.

Binding order and failure modes:

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

`thresholdMemberEligible` is only a necessary condition for threshold enrollment.
Enrollment in the core also requires each member's code to be the pinned standard
member validator (`MultiSigValidator`, checked by NEF and manifest digest) and
calls its member-key entry (the module method whose manifest name is
getMemberKey(accountId, moduleId)) for a distinct 33-byte
compressed key. Only `MultiSigValidator` satisfies both, so the other
`true` rows cannot be enrolled as policy members.

`Web3AuthValidator` is the only shipped validator that implements
`isValidSignature`; a profile claiming `messageCapability` without that method
still fails binding at §9.1.

## 13. ERC alignment boundary

Interface naming aligns with ERC-7579/4337/1271 (module types,
`isValidSignature`, `validateUserOp`-style validation, `executeUserOp`,
install/uninstall lifecycle events). **The protocol does NOT claim Ethereum
protocol compatibility:**
- Neo SA is not `PackedUserOperation`/`EntryPoint.handleOps`; one transaction
  carries one operation, not a bundle.
- NeoVM nonce domain is a **191-bit derived channel + 64-bit sequence**; ERC-4337
  is 192+64 with a chosen key.
- ERC-7562 is an Ethereum mempool validation ruleset, not a Neo consensus rule;
  the declared Neo system fee is not an Ethereum verification-gas conversion.
- ERC-1271 semantics (magic value, read-only, arbitrary schemes) are respected
  as a **Neo profile**.

Wording rule for all docs/UI: "responsibility- and security-model-aligned Neo
profile", never "fully ERC-4337/ERC-7579 compatible".

## 14. Account creation and state

Accounts start at registration. Active and Frozen are the only defined states; reject every other status code.

## 15. Shared constant files and fixtures

| Artifact | Path |
| --- | --- |

| native constants | `contracts/native/SmartAccount/SmartAccountModuleProtocol.cs` (internal static `SmartAccountModuleProtocol`, synced to neo-native-core via `scripts/sync_native_smartaccount.py`) |
| fixture skeletons | `tests/fixtures/sa-module-protocol/` (README + schemas + templates) |

The constant file carries, for: wire tag 4;
module type codes 1/4/5; all §3 limits; 13-field operation field indices; nonce
sizes (32-byte subkey, 24-byte channel); serialized-size caps (4096/8192/4096/
16384); the storage prefixes the core declares (0x50, 0x51,
0x52, 0x53, 0x56, 0x5C); the §17 error-code strings; the §18 event display
names; and the fixed-width big-endian key-suffix encoding (`UInt64ToBigEndian`,
per-prefix composite key builders). The recovery delay bounds and the
governance delay are module constants, not core constants.

## 16. Kernel implementation mapping

> The table is a design mapping, not an inventory of native ABI methods.

### 16.1 Native kernel

| Spec section | Native files to create/modify |
| --- | --- |
| constants | consume `SmartAccountModuleProtocol.cs` (then run `scripts/sync_native_smartaccount.py` to materialize the neo-native-core copy) |
| §4/§5 operation/digest | `SmartAccountProtocol.cs` (signing domain, 13-field operation, entry-script recognition) |
| §6 nonce | `SmartAccountProtocol.cs` + nonce storage partial (0x56/0x5C) |
| §7 state | `SmartAccountRecords.cs` (0x51 record and its codec) |
| §2/§3 collections | `SmartAccount.Modules.cs` (instance records, enumeration, module caps), `SmartAccountModulePolicy.cs` (profile validation, composite layer) |
| §9/§10 lifecycle & governance actions | `SmartAccount.Modules.cs`, `SmartAccount.Execution.cs` (configuration actions); pending intents live in `contracts/modules/GovernanceModule`, not in the core |
| §8 message | `contracts/modules/SigningModule` (message domain, subjects and quorum); the native core has no message entry |
| §11.1 witness and fee | `SmartAccount.Execution.cs` (`verify`), `SmartAccountInvocationContext.cs` (target anchor frame); the core sets no gas budget |
| Invocation phase gates | `SmartAccountInvocationContext.cs` (exact-frame callback and target grants; validation/message must never reach post/configuration/cleanup writes) |
### 16.2 Native invariants to verify (fixture matrix)

The full matrix is `tests/fixtures/sa-module-protocol/README.md`: multi-instance same-address installs; validator swap cannot skip
hooks; threshold members not independently routable; duplicate identities,
cycles, nesting rejected; post only over the approved snapshot set; forward/reverse
hook order with false/FAULT handling; proof/args/hookData tampering rejected;
timelock on empty-slot/uninstall/last-validator/default-policy; pending governance
intent concurrency, conflicts, maturity, expiry, stale revisions; frozen-state ABI
sweep; validation/message→post/configuration/cleanup escalation attacks;
contractId/updateCounter/NEF/profile drift before and after; revoke-regrant; subId re-creation with fresh generations; unconsumed
recovery-ticket replay across clear/setup; recovery without any plugin
callback; no-plugin operation + SigningModule message signatures; contract custody
cannot fake message signatures; the witness check (Verification trigger) and
the proxy frame (Application trigger) separately; nonce and credential monotonicity.

## 17. Error codes

Error codes are stable string constants (`SA_*`); kernel exceptions carry them
(possibly with a detail suffix after a space). The native core's spellings are
pinned in `contracts/native/SmartAccount/SmartAccountModuleProtocol.cs`; every
code in the first table is declared there and reachable. The standard modules
keep their own copies of the shared codes plus the module-only codes in the
second table, in `contracts/modules/Shared/ModuleSupport.cs`. The validators and
hooks under `contracts/plugins` assert with plain messages, not `SA_*` codes.

| Code | Meaning |
| --- | --- |
| `SA_PROTOCOL_VERSION` | operation version ≠ 4 |
| `SA_OPERATION_MALFORMED` | non-canonical shape, sizes, depths, ordering, integer domains (the nonce and deadline fields are the two explicit exceptions, see their rows); malformed action arrays |
| `SA_OPERATION_FIELD_COUNT` | field count ≠ 13 |
| `SA_MODULE_TYPE_UNSUPPORTED` | module type not 1, 4 or 5; a profile whose `moduleType` or capabilities contradict the requested type |
| `SA_MODULE_LIMIT_VALIDATOR` / `SA_MODULE_LIMIT_HOOK` / `SA_MODULE_LIMIT_RECOVERY` / `SA_MODULE_LIMIT_PLANNER` / `SA_MODULE_LIMIT_ACTIONS` / `SA_MODULE_LIMIT_BATCH` | §3 limits exceeded (instances per type, hook planners, actions per group, accounts per `createAccounts` batch); `SA_MODULE_LIMIT_THRESHOLD` and `SA_MODULE_LIMIT_MEMBERS` are module-only codes |
| `SA_MODULE_NOT_INSTALLED` | moduleId not installed on the account |
| `SA_MODULE_ID_INVALID` | enumeration cursor outside the UInt64 domain; a remove action whose module id is 0 |
| `SA_MODULE_INSTANCE_ISOLATION_REQUIRED` | same-address re-install without `instanceIsolation` |
| `SA_MODULE_CODE_BINDING_MISMATCH` | contractId/updateCounter/NEF/profile drift; non-canonical profile; member, recovery or governance code that does not match its pinned digest |
| `SA_MODULE_NOT_ROUTABLE` | a route other than the required validator while one is registered; the built-in route while it is closed; a non-validator instance routed directly |
| `SA_VALIDATION_REJECTED` | validator rejected the operation; built-in custody signature invalid |
| `SA_VALIDATOR_NOT_FOUND` | the routed instance is not installed or is not a validator instance |
| `SA_CALLBACK_RETURN_TYPE` | `validateUserOp` returned a value that is not a `Boolean`, or `preCheck` returned neither `ByteArray` nor `null` (§9.1) |
| `SA_HOOK_DATA_TOO_LARGE` | hookData > 512 bytes |
| `SA_PROOF_INVALID` | duplicate/unsorted/oversized signatures or hook proofs; a hook proof for a hook that is not installed; a `planHooks` reply that is not a permutation of the installed hook ids |
| `SA_NONCE_INVALID` / `SA_NONCE_EXHAUSTED` / `SA_NONCE_CHANNEL_COLLISION` | nonce channel or sequence mismatch, and a nonce outside its declared integer domain (the first exception to the `SA_OPERATION_MALFORMED` integer-domain rule) / channel dead / 191-bit truncation collision |
| `SA_DEADLINE_EXPIRED` | past deadline, and a deadline outside its declared integer domain (the second exception) |
| `SA_EPOCH_STALE` / `SA_CONFIGURATION_NONCE_STALE` / `SA_CREDENTIAL_STALE` | signature bound to superseded epoch/nonce/generation |
| `SA_INTENT_CONFLICT` | `GovernanceModule` only: a submitted proposal whose action digest or read set intersects a pending one (§10). The core defines no intent error; a threshold policy module rejects a bad member set with `SA_OPERATION_MALFORMED`, `SA_MODULE_LIMIT_MEMBERS` or `SA_MODULE_LIMIT_THRESHOLD`. |
| `SA_ACCOUNT_NOT_FOUND` / `SA_ACCOUNT_FROZEN` / `SA_ACCOUNT_STATUS` | account state gates |
| `SA_REENTRANCY_FORBIDDEN` | same-account or cross-account nested execution; a configuration write while the account has an open execution |
| `SA_BUILTIN_ROUTE_REQUIRED` | the configuration group would leave the account with neither the built-in operation route nor a validator instance (§10) |
| `SA_UNAUTHORIZED` | caller/subject witness failure; a governed administration entry called by anyone but the account's code-bound `governance` validator instance; a core reset or governance landing requested by a contract that is not the pinned installed module; an execution that reset an account and ends without a governance-capable, code-bound validator |
| `SA_PHASE_VIOLATION` | Core: the invocation-context phase gates (a grant (callback or target) requested for an account that is not the entered one, the core named as a dispatch target) and a second reset of the same account in one execution (`SmartAccountInvocationContext.cs`, `SmartAccount.Modules.cs`). `GovernanceModule` and the shared module support raise the same code for core actions split into several groups, the undeployed rebinding action, a configuration nonce that advanced more than once, a core that is already pinned or not configured |

A hook refuses an operation by faulting inside `preCheck` or `postCheck`; the core
adds no hook-rejection code of its own.

Module-only codes. The standard modules under `contracts/modules` raise these
in addition to the core codes above; the core does not raise them.

| Code | Raised by |
| --- | --- |
| `SA_INTENT_IMMATURE` / `SA_INTENT_EXPIRED` | `GovernanceModule`: confirming a proposal before `matureAt` / after `expiresAt` (§10) |
| `SA_INTENT_NOT_FOUND` / `SA_INTENT_LIMIT` / `SA_INTENT_CONFLICT` | `GovernanceModule`: unknown proposal id; a new proposal while 16 are already pending; a proposal whose action digest or resource set intersects a pending one (§10) |
| `SA_RECOVERY_PENDING` / `SA_RECOVERY_LOCKED` | `RecoveryModule`: cancelling or executing without a pending request, or starting a second one / executing before the timelock elapsed (§12) |

## 18. Event table

These are the events emitted by the native SmartAccount contract. Parameter order and manifest types are part of the interface. For module notifications, identify the emitting contract separately.

| Event | Parameters |
| --- | --- |
| `AccountRegistered` | `accountId: Hash160`, `custody: Hash160` |
| `ModuleInstalled` | `accountId: Hash160`, `moduleType: String`, `moduleHash: Hash160` |
| `ModuleRemoved` | `accountId: Hash160`, `moduleType: String`, `moduleHash: Hash160` |
| `UserOpExecuted` | `accountId: Hash160`, `targetContract: Hash160`, `method: String`, `nonce: Integer` |
| `ModuleInstanceInstalled` | `accountId: Hash160`, `moduleId: Integer`, `moduleType: Integer`, `contractHash: Hash160`, `credentialGeneration: Integer` |
| `ModuleInstanceRemoved` | `accountId: Hash160`, `moduleId: Integer` |
| `NonceChannelOpened` | `accountId: Hash160`, `channelDigest: ByteArray` |
| `NonceChannelExhausted` | `accountId: Hash160`, `channelDigest: ByteArray` |
| `AccountFrozen` | `accountId: Hash160`, `authorityEpoch: Integer` |
| `AccountUnfrozen` | `accountId: Hash160`, `authorityEpoch: Integer` |
| `ModuleCredentialsRevoked` | `accountId: Hash160`, `moduleId: Integer`, `credentialGeneration: Integer` |
| `AccountReset` | `accountId: Hash160`, `custody: Hash160`, `authorityEpoch: Integer` |
| `BuiltinAuthorizationSet` | `accountId: Hash160`, `defaultOperationAuthorization: Boolean`, `defaultMessageAuthorization: Boolean` |
| `ModuleInstanceConfigured` | `accountId: Hash160`, `moduleId: Integer`, `credentialGeneration: Integer` |
| `RequiredValidatorSet` | `accountId: Hash160`, `validatorId: Integer`, `required: Boolean` |

---

## Appendix: Module developer guide

> This appendix is English only; the Chinese counterpart carries a pointer to it.

### Executive Summary

This guide is for developers building the protocol validator or hook modules for the Neo N3 Smart
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
module-owned — ThresholdPolicyModule holds the member roster and quorum, and
HookOrchestratorModule holds hook order — so a module never calls another module.

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
`DeleteInstancePrefix(prefix, accountId, moduleId)`. The core reaches these callbacks through its
configuration entries and governance actions; the core keeps no configuration intent of its own.

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

    void OnInstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] initData);
    void Configure(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] configData);
    void OnUninstall(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] deInitData);
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
implementation and concrete runtime/refinement evidence. Composition is module-owned:
ThresholdPolicyModule holds the member roster and quorum, and HookOrchestratorModule
holds hook order and the planner snapshot, so `MultiSigValidator` validates one configured
child signer and `MultiHook` rejects new installs. These checks are ABI/profile/lifecycle
guards, not proofs of cryptographic independence or arbitrary future-module storage
semantics.

#### 2.2 Security Checklist for Validators

| Check | Why | Implementation |
| --- | --- | --- |
| **Network ID in domain** | Prevent cross-chain replay | Sign `ValidatorPayload.SigningDigest`, which binds the core operation digest and its network domain |
| **Account ID in domain** | Prevent account confusion | The same helper binds `accountId`, `moduleId` and the credential generation |
| **Deadline in operation** | Prevent old signature use | `operation[6]` is covered by the core digest; check it against `Runtime.Time` when your policy has a window |
| **No side effects** | Validation must be read-only | Use `CallFlags.ReadOnly` where applicable |
| **Bounded cost** | Prevent DoS | The native core sets no per-callback gas budget; a callback runs inside the transaction's declared system fee (§11.1). Keep validation work bounded by construction — the core already caps the operation at 16384 bytes, 64 args and depth 8. |
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
// The core sets no callback budget; the transaction's declared system fee is the only limit.
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

`onUninstall(accountId, moduleId, moduleType, deInitData)` is a mandatory lifecycle method for both
validator and hook modules. It must delete every instance-scoped key owned by the module
(`HookAuthority.DeleteInstancePrefix` or `ValidatorAuthority.DeleteInstancePrefix` per prefix) and
must fault on an internal cleanup failure. It must also be idempotent for an instance the module
never configured, because the core calls it on every uninstall regardless. A module that omits the
method never installs: the core's install-time gate checks the complete lifecycle ABI. Modules that
custody user funds per instance (for example the recovery service's credit) must return them to the
account owner in `onUninstall` rather than orphan them.

**Transfer source is the proxy address, never the account id.** A virtual SA
account holds its assets at the core-derived proxy script hash
(`getAccountAddress(accountId)`), and that address is the only `from` a token's
`CheckWitness` accepts during `executeUserOp`. Any validator or hook that pins,
meters or allowlists a transfer source must compare against that address
(`Contract.Call(core, "getAccountAddress", CallFlags.ReadOnly, accountId)`) and
must declare `ContractPermission("*", "getAccountAddress")`. Comparing against
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
public static void Configure(UInt160 accountId, BigInteger moduleId, BigInteger moduleType, object[] configData)
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
| **Mutable verification** | Bypass timelock | Never make verification upgradable without the core's configuration intent (the governance proposal path of §10) |
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
# Sign for one network, submit to another - should fail

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
- [ ] `ContractPermission("*", "getModule")` and `getAccountAddress` where the module resolves its instance or the proxy address
- [ ] `Safe` attributes on view functions
- [ ] Events for state changes
- [ ] Clear documentation of security assumptions
- [ ] Private-chain validation completed
- [ ] Source code published
- [ ] Address registered in ecosystem

---

### 8. Resources

- **Security Model:** `docs/SECURITY.md`
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
  - `contracts/plugins/hooks/MultiHook.cs` (installation is rejected)

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

SmartAccount installs **modules** into an account.
The module whose job is to decide authorization is a **validator**; the modules that narrow what the account may do are **hooks**. The identity-only witness entry `verify` exists because the proxy script embeds it.

Module kinds are one-byte codes:

| Type | Name | |
| --- | --- | --- |
| 1 | validator | supported |
| 2 | executor | installation rejected |
| 3 | fallback handler | installation rejected |
| 4 | hook | supported |
| 5 | recovery seat | one per account |

### Choose In Layers

A basic account needs no modules to receive or transfer assets. Add the following roles as needed:

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
   accepts the operation. Hooks are ordered by the account's hook planner (`planHooks`, §9.1): every `preCheck` runs
   in ascending order and every `postCheck` runs over the same snapshot in reverse order.
   Shipped hooks:
   - `WhitelistHook`
   - `DailyLimitHook`
   - `TokenRestrictedHook`
   - `NeoDIDCredentialHook`

3. **Recovery seat** — install `RecoveryModule` and set the delay in advance. Custody or the
   configured recovery authority may start a request; a proposed new custodian must also consent.
   Once the delay elapses, anyone can submit the approved reset through the seat. The core then
removes modules and nonce records without calling their uninstall callbacks.

`MultiHook` is not admitted: the core admits module types 1, 4 and 5 only, and the hook order comes
from the account's hook planner, not from a core list. `ZKEmailVerifier` is a disabled template — every
callback fails closed, so it is not an installable production validator.

#### Validator notes

- Each `MultiSigValidator` instance supplies one member key. To require a quorum even for custody,
  enroll distinct member keys in the mandatory threshold policy through governance. The threshold
  counts keys; a wallet cannot infer how many independent people control them.
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

- Spending: install the recovery seat and distinct member instances, then enroll the mandatory threshold policy
- Hook: `TokenRestrictedHook`
- Recovery: separate recovery authority with a 90 day timelock

#### Membership / Recurring Billing

- Validator: `SubscriptionValidator`
- Hook: `DailyLimitHook`
- Recovery: custody address

### How To Configure

Do not start from raw calldata. An install is either an atomic registration action or a call to the
core:

1. `installModule(accountId, moduleType, moduleContractHash, initData)` installs one instance;
   `removeModule(accountId, moduleId, deInitData)` uninstalls it. On the v4.1 target both are
   reached only by the account's code-bound GovernanceModule after its 24-hour delay; custody keeps
   the immediate `freezeAccount` and `revokeModuleCredentials` entries.
2. A registration install action is the positional vector `[1, moduleType, moduleHash, profileDigest,
   initData]`. `createAccount` accepts only initial install actions; remove, configure, built-in
   authorization and required validator are governance paths.
3. For an existing active account, GovernanceModule submits the mature confirmation to
   `applyConfigurationActions`, which combines install, remove, configure, built-in authorization and
   required validator in one atomic update (§10).

A module instance is identified by `(accountId, moduleId)`, never by contract address. `moduleId` is
allocated once per account from 1 (0 is the built-in route) and is never reused, so an uninstalled
instance's signatures and pending governance intents can never re-attach to a new one. The same contract may be
installed several times only when its capability profile declares instance isolation.

Limits: 32 validator instances, 8 hook instances, one recovery seat and one hook planner per account,
10 composite members per validation, 16 actions per group or governance proposal.

### Module Commands

For the configurable validators and hooks below, a non-empty install payload uses the same
`[command, ...args]` encoding as configuration. Empty install data skips initial configuration.
Uninstall data is a separate lifecycle argument; it does not dispatch a configuration command.

| Module | Commands |
| --- | --- |
| `P256Validator`, `Web3AuthValidator`, `TeeKeyValidator` | `setPublicKey` — 33-byte compressed or 65-byte uncompressed, stored compressed |
| `NeoWitnessValidator` | `setSigners` — signer set plus threshold |
| `MultiSigValidator` | `setMemberKey` — one key per instance |
| `SessionKeyValidator` | `setSessionKey` — key, target, method, expiry in milliseconds, spending cap, description; `clearSessionKey` |
| `SubscriptionValidator` | `createSubscription` takes the raw subscription ID, merchant, token, amount cap and period in seconds; `cancelSubscription` takes the same ID |
| `DelegatedIdentityValidator` | `setConfig` — public key, provider, master nullifier |
| `ActionSessionValidator` | `setRecoveryService`; `clearRecoveryService` |
| `DailyLimitHook` | `setDailyLimit` — token, max amount, rolling-window flag; `clearDailyLimit` |
| `TokenRestrictedHook` | `restrictToken`; `unrestrictToken` |
| `WhitelistHook` | `allowTarget`; `denyTarget` |
| `NeoDIDCredentialHook` | `requireCredential` — target, provider, claim type, commitment; `clearRequirement` |
| `MultiHook` | none — not admitted by the core |

`DailyLimitHook` meters the asset balance of the account's derived proxy address, and usage accrues only
after a successful execution. `NeoDIDCredentialHook` stores no local credential flags: the credential
must exist on the configured `NeoDIDRegistry`, and the commitment must be the 32-byte commitment
registered for that provider and claim type.
