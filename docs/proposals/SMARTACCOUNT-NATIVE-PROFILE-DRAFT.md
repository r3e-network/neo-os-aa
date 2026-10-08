# Native SmartAccount Profile

**Foundation:** Draft PR [#243](https://github.com/neo-project/proposals/pull/243)

**Discussion:** Issue [#242](https://github.com/neo-project/proposals/issues/242)

**Status:** Draft protocol profile; not activated and not an adopted standard
**Version:** 1

## 1. Scope

This document defines a native Neo N3 profile for the SmartAccount protocol
foundation. It specifies the native service identity, activation boundary,
account identity, verification-script address, account state, module lifecycle,
UserOperation authorization, resource accounting, governance, and migration.

It does not assign a NEP number. It does not merge or replace the generic
verification-script proposal in [#218](https://github.com/neo-project/proposals/pull/218),
and it does not adopt the optional proposals in #219 or #220.

An implementation MUST NOT expose this profile as active until the activation
hardfork, the matching node implementation, the matching DevPack surface, and
the published conformance vectors are accepted together.

## 2. Normative language

The terms **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and
**MAY** are normative.

All byte strings in this document are shown in wire order. A Neo `UInt160` is
serialized with its standard `ToArray()` representation. Hexadecimal display
does not reverse the byte order a second time.

## 3. Fixed profile parameters

| Parameter | Value |
|---|---|
| Native service name | `AccountManagement` |
| Native service hash | `GetContractHash(UInt160.Zero, 0, "AccountManagement")` |
| Profile version | `1` |
| Native ABI version | `1` |
| Maximum batch size | `32` operations |
| Maximum method length | `128` UTF-8 bytes |
| Maximum argument count | `64` values |
| Maximum serialized argument size | `4096` bytes |
| Maximum signature size | `1024` bytes |
| Maximum argument nesting depth | `8` |
| Verifier callback budget | `100,000,000` datoshi per callback |
| Hook callback budget | `250,000,000` datoshi per callback |
| Module maintenance callback budget | `250,000,000` datoshi per callback |
| Verifier validation flags | `ReadOnly` (`0x05`) |
| Verifier post flags | `All` (`0x0F`) |
| Hook callback flags | `All` (`0x0F`) |
| Target call flags | `All` (`0x0F`) |
| Module-change delay | `86,400,000` milliseconds |
| Custody-recovery delay | `604,800,000` milliseconds |
| Native sponsorship | Not included in version 1 |

The resource budgets are fixed profile parameters. They are not operation
fields, account-controlled values, or fee-whitelist exemptions. A later profile
version MUST use a new ABI version and activation boundary when changing them.

The activation record MUST include this parameter digest:

```text
profileParameterDigest = SHA256(
    ASCII("NeoSmartAccount/Profile") ||
    UInt8(1) ||
    CanonicalProfileParameterJsonUtf8
)
```

For version 1, `CanonicalProfileParameterJsonUtf8` is exactly the following
byte sequence:

```text
{"abiVersion":1,"argumentCountMax":64,"argumentDepthMax":8,"argumentSizeMax":4096,"batchMax":32,"childConfiguration":true,"custodyRecoveryDelayMs":604800000,"hookBudgetDatoshi":250000000,"maintenanceBudgetDatoshi":250000000,"methodBytesMax":128,"moduleChangeDelayMs":86400000,"nativeSponsorship":false,"profileVersion":1,"serviceName":"AccountManagement","signatureBytesMax":1024,"verifierBudgetDatoshi":100000000}
```

The resulting version-1 digest is:

```text
2601e456d8d5a3f746c8cdcd6f90f19a62bf00bdfb856ef6f14be74a2b44f81a
```

## 4. Native identity and activation

### 4.1 Service identity

The service name is exactly `AccountManagement`. Its native hash is the hash
produced by Neo's standard native-contract identity function:

```text
GetContractHash(UInt160.Zero, 0, "AccountManagement")
```

The service MUST publish the following native manifest metadata:

```json
{
  "smartAccount": {
    "abiVersion": 1,
    "profileParameterDigest": "2601e456d8d5a3f746c8cdcd6f90f19a62bf00bdfb856ef6f14be74a2b44f81a"
  }
}
```

The ABI version is part of the protocol identity and MUST NOT be inferred from
a method list.

The service hash identifies a permissionless protocol dispatcher, not an account
owner or asset-holding principal. From activation, `CheckWitness(AccountManagement.Hash)`
MUST return false, including in a directly dispatched target and regardless of
transaction signer scopes. The legacy immediate-caller witness shortcut MUST NOT
authorize this service hash. This restriction MUST NOT apply before activation.

### 4.2 Activation

The profile is activated by the dedicated network hardfork key
`HF_SmartAccountV1` in the protocol configuration. The activation MUST be a
distinct hardfork entry; an existing hardfork MUST NOT be repurposed.

Each network MUST configure an explicit activation height. A missing activation
entry means **disabled**, not genesis activation. Nodes MUST reject a native
SmartAccount call before activation and MUST NOT create the service state at
genesis as a side effect of loading an unconfigured protocol setting.

At the activation block the node MUST:

1. create the native `AccountManagement` contract state;
2. initialize the profile version and fixed parameter digest;
3. emit the normal native-contract deployment notification;
4. make the version-1 ABI available from that block onward.

Before activation, `AccountManagement` has no callable version-1 ABI. Existing
ordinary contracts and existing verification scripts MUST retain their current
behavior.

The native service has no ordinary-contract deployment sender, NEF update
method, administrator, or runtime code-upgrade path. Code and ABI changes
require a later protocol activation with an explicit migration routine.

## 5. Account identity and address

### 5.1 Account identifier

An account is registered from a custody address and a 32-byte salt. The native
core computes the identifier as:

```text
accountId = Hash160(
    ASCII("NeoSmartAccount") ||
    UInt8(1) ||
    UInt32LE(networkMagic) ||
    coreHash.ToArray() ||
    custodyAddress.ToArray() ||
    salt
)
```

`Hash160` is RIPEMD-160(SHA-256(input)). The domain string, version byte,
network encoding, field order, and byte representation are fixed. The account
identifier MUST be non-zero. The native core MUST reject an already registered
identifier rather than overwrite it.

The identifier is an account-state key. It is not an asset address and MUST
NOT be used as one.

### 5.2 Verification-script address

The asset-holding address is derived from the following exact verification
script:

```text
PUSH accountId
PUSH 1
PACK
PUSH ReadOnly
PUSH "verify"
PUSH AccountManagement.Hash
SYSCALL System.Contract.Call
```

The script MUST use Neo's canonical push encoding and MUST leave exactly one
Boolean value on the stack. It MUST conform to the statically parseable
contract-call shape in #218. The static call has:

```text
verifierContract = AccountManagement.Hash
method           = "verify"
callFlags        = ReadOnly (0x05)
argumentCount    = 1
arguments        = [accountId]
```

The address is the script hash of these bytes. Changing any byte, including the
account identifier, call flags, method, or native service hash, creates a new
address. Such a change MUST be treated as an address and asset migration, not
as an in-place account upgrade.

### 5.3 Verification-trigger bridge

`verify(accountId)` is available only during the Verification trigger. The
verification script is an asset-address compatibility bridge, not a second
authorization entrypoint. It MUST NOT authorize an arbitrary transaction that
merely includes the account address as a signer.

For version 1, the transaction script MUST be the canonical application
envelope for this account. The envelope is exactly one application call with
the following semantic values and no additional instructions:

```text
System.Contract.Call(
    AccountManagement.Hash,
    "executeUserOp" or "executeUserOps",
    All,
    accountId,
    op or ops
)
```

The script parser MUST require the native service hash, method, call flags,
argument count, account identifier, and canonical operation bytes to match.
The batch form MUST also satisfy the batch bounds and same-account rule. A
transaction that directly calls a token, NFT, application contract, or an
unrelated native method MUST fail account-address verification.

The canonical envelope is the byte-for-byte output of Neo's dynamic contract
call builder for the following values, with no prefix or suffix:

```text
EmitDynamicCall(
    AccountManagement.Hash,
    "executeUserOp" or "executeUserOps",
    CallFlags.All,
    [accountId, op] or [accountId, ops]
)
```

The builder MUST use canonical VM push encodings, `NEWARRAY0` for an empty
array, and `PACK` for a non-empty array. The operation arrays themselves MUST
use the canonical serialization defined by the foundation and this profile.
Parsers MUST reject semantically equivalent scripts that contain extra
instructions, alternate call flags, dynamic method values, or non-canonical
push encodings.

The typed initializer for `op` or `ops` MUST preserve VM value types exactly:

| Value | Canonical initializer |
|---|---|
| Null | `PUSHNULL` |
| Boolean | `PUSHT` or `PUSHF` |
| Integer | Shortest signed encoding emitted by Neo's `ScriptBuilder.EmitPush` |
| ByteString | Shortest length-prefixed data push emitted by that builder |
| Empty Array | `NEWARRAY0` |
| Empty Struct | `NEWSTRUCT0` |
| Non-empty Array | Initialize elements in reverse order, push the count canonically, then `PACK` |
| Non-empty Struct | Initialize elements in reverse order, push the count canonically, then `PACKSTRUCT` |

These rules apply recursively. An SDK overload that emits `PUSH0 PACK` for an
empty Array does not satisfy this profile. `CONVERT`, duplicated stack values,
branches, calls, or additional syscalls are not permitted in the initializer,
even when they would produce an equal value. Struct remains an argument type,
not an alternate type for the operation, batch, or top-level argument Array.
The complete transaction must also satisfy the normal Neo transaction-size
and execution-resource limits; per-operation validity does not imply that a
maximum-size batch fits those limits.

After envelope validation, `verify(accountId)` MUST:

1. require the caller script hash to equal the deterministic account address;
2. load the account state and require it to be active;
3. recompute the address from `accountId` and require an exact match;
4. validate the operation shape, deadline, current nonce, module code identity,
   and authorization without mutating state;
5. call the configured verifier's read-only `validateSignature`, or use the
   native-witness fallback when no verifier is installed;
6. return the authorization result without consuming a nonce, executing a
   hook, invoking the target, or emitting a notification.

For a batch, the Verification trigger MUST process nonces in operation order
using a private shadow cursor for each channel. The first occurrence loads
the stored cursor; later occurrences use the cursor advanced by earlier
operations in that same batch. These shadow updates MUST NOT write storage.
Checking every operation against an unchanged stored cursor is incorrect:
sequences 0 then 1 in one channel are valid when its stored cursor is 0.
Duplicate, skipped, or exhausted sequences MUST still be rejected. A failed
verification MUST NOT consume any nonce. This rule covers nonce simulation
only; it does not authorize operations or predict hook/target state changes.

The Application-trigger execution repeats the pure checks and then performs
the stateful nonce, hook, target, and post-callback steps. This deliberate
double evaluation is required because Verification-trigger execution cannot
commit application state. The verifier MUST therefore be deterministic and
read-only for this callback.

The native-witness fallback requires the custody address to witness the same
transaction and requires an empty operation signature. A configured verifier
uses the operation signature/proof in the canonical envelope; custody is not
implicitly required for that profile. The account-address proxy MUST never be
accepted as its own custody witness, and caller-supplied signer lists MUST NOT
be treated as proof.

### 5.4 Application witness authority

A successful Verification-trigger bridge is not an unrestricted application
witness. For a registered SmartAccount asset address, application witness
acceptance MUST additionally require an active target grant for that account
and the exact target invocation established by AccountManagement after operation
authorization. The normal Neo signer and WitnessRule checks still apply; the
grant cannot manufacture a missing witness or expand its declared scope.

A Global signer, a matching contract hash in a custom scope, or reentry into the
same target contract MUST NOT bypass this extra restriction. The target's
initialization and internal VM calls belong to its invocation; fresh
cross-contract invocations and arbitrary descendants do not. Verifier, hook,
configuration and cleanup phases carry no asset-witness grant. The native
service and application witness evaluator MUST enforce this jointly; a public
Boolean query that callers can choose to ignore is not an equivalent control.

## 6. Canonical account state

The native service stores one canonical record for each `accountId`:

```text
AccountState {
    version:              UInt8
    accountId:            UInt160
    accountAddress:       UInt160
    custodyAddress:       UInt160
    recoveryAddress:      UInt160 | zero
    verifier:             ModuleBinding | native-witness
    hook:                 ModuleBinding | none
    status:               Active | Frozen
    configurationNonce:   UInt64
    pendingVerifier:      PendingModuleChange | none
    pendingHook:          PendingModuleChange | none
    pendingRecoveryAddr:  PendingRecoveryAddressChange | none
    pendingRecovery:      PendingRecovery | none
}

ModuleBinding {
    contract:             UInt160
    codeHash:              UInt256
}

PendingModuleChange {
    contract:             UInt160 | zero
    codeHash:              UInt256 | zero
    proposedAt:            UInt64
    activateAt:            UInt64
    expectedConfiguration: UInt64
}

PendingRecovery {
    newCustodyAddress:     UInt160
    proposedAt:            UInt64
    executeAt:             UInt64
    expectedConfiguration: UInt64
}

PendingRecoveryAddressChange {
    recoveryAddress:       UInt160 | zero
    proposedAt:            UInt64
    activateAt:            UInt64
    expectedConfiguration: UInt64
}
```

The native storage encoding MUST use deterministic field order and fixed
integer semantics. The canonical stack representation of `AccountState` is an
Array with exactly these 13 positions:

```text
[version, accountId, accountAddress, custodyAddress, recoveryAddress,
 verifier, hook, status, configurationNonce, pendingVerifier, pendingHook,
 pendingRecoveryAddr, pendingRecovery]
```

`version` and `status` are canonical non-negative Integers. Version 1 uses
`Active = 0` and `Frozen = 1`; all other status values MUST be rejected. `accountId`,
`accountAddress`, and `custodyAddress` are 20-byte ByteStrings. A zero optional
address is a 20-byte all-zero ByteString. A missing optional record is `Null`.
Each `ModuleBinding` is `[contract, codeHash]`; each pending record uses the
field order declared above and has no omitted fields. Neo's canonical binary
serializer is applied to this Array without a map or textual JSON layer.
Missing fields, additional fields, wrong types, and non-canonical encodings
MUST fault closed.

The service stores the next sequence independently for each nonce channel. A
nonce key is `(accountId, channel)` where `channel = nonce >> 64`; the stored
value is the next `sequence` or the exhaustion sentinel `2^64`. The canonical
storage key is the one-byte field prefix `0x20`, followed by the 20-byte
`accountId` wire representation and the 24-byte unsigned-big-endian channel.
The channel satisfies `0 <= channel < 2^191`; the 24-byte field's
highest bit MUST be zero. Keeping this fixed-width field does not extend the
signed NeoVM Integer domain used by the operation ABI.
The account record key uses field prefix `0x10` followed by `accountId`; no
other state may use either prefix.

## 7. Account lifecycle and authority separation

### 7.1 Creation

`registerAccount(custodyAddress, salt, verifier, hook, recoveryAddress)` MUST:

- be an Application-trigger call;
- require a non-zero custody address;
- require a 32-byte salt;
- require a zero recovery address or a recovery address different from custody;
- require that custody and recovery addresses MUST NOT equal the account-address proxy;
- require the custody address to witness the transaction;
- compute the account identifier and proxy address internally;
- validate the verifier and hook ABI before storing them;
- reject duplicate identifiers;
- initialize all nonce channels at sequence zero;
- initialize the account as `Active` with configuration nonce zero;
- emit `AccountCreated`.

The caller MUST NOT supply `accountId` or `accountAddress` as authoritative
values.

### 7.2 Configuration authority

The current custody address is the configuration authority. It may propose:

- verifier replacement or removal;
- hook replacement or removal;
- recovery-address replacement or removal.

Every change is delayed by the fixed module-change delay. Each proposal records
the current `configurationNonce`. Replacing an intent restarts its full delay.
Activation is permissionless at or after its recorded maturity and MUST reject
a stale proposal. Cancellation is immediate, requires an existing proposal and
the current custody witness, and does not advance the configuration nonce.

All configuration proposals and activations require an Active account;
configuration changes MUST be rejected while custody recovery is pending.
This includes verifier, hook, recovery-address, root-module, and child-module
configuration routes. Otherwise custody could invalidate a mature recovery by
advancing the configuration nonce after its direct cancellation right expires.
Cancelling a configuration intent remains allowed because it neither changes
an active binding nor advances that nonce. Recovery-address configuration is
also forbidden while Frozen, preventing removal of the recovery authority as
a bypass of the joint-witness unfreeze rule.

Every successful configuration activation, recovery execution, freeze, or
unfreeze increments the configuration nonce and clears all pending intents,
including custody recovery and recovery-address rotation. No stale pending
record is retained. Configuration counters and timestamp arithmetic MUST NOT
wrap; an exhausted configuration counter rejects proposals and transitions
that require another epoch. Pending records MUST have the current epoch and
the exact fixed delay for their kind. Callers MUST NOT supply maturity times.

Verifier removal selects the native-witness fallback. Hook removal selects no
hook. Neither operation changes the account address or nonce state.

### 7.3 Recovery authority

The recovery address is optional. When configured, it is a separate authority
from custody. The recovery address may propose a new custody address. The
proposal becomes executable only after the fixed custody-recovery delay and
only if its configuration nonce is still current.

A proposed new custody address MUST be non-zero and MUST differ from both the
current custody address, the configured recovery address, and the account-address
proxy. A proposed recovery address MUST be zero or different from both the
current custody address and the account-address proxy.
Custody and non-zero recovery addresses MUST NOT be native contract hashes.
These checks apply at registration, during delayed rotation, and when validating
stored current or pending authorities. Zero denotes the absence of recovery only;
it is never a custody authority.

The current custody may cancel a pending custody recovery only strictly before
its execution time (`now < executeAt`). At equality this right has expired. After the delay, anyone may submit `executeRecovery`; the native service
does not require the old custody to cooperate. The recovery address may cancel
its own pending proposal. A stale or already cancelled proposal MUST fault.

Executing recovery:

- replaces the custody address without re-deriving the account identity;
- preserves the account identifier, account address, nonce state, verifier,
  hook, and recovery address;
- clears all pending intents, including the executed recovery;
- increments the configuration nonce;
- leaves a frozen account frozen;
- emits `RecoveryExecuted`.

If no recovery address is configured, no recovery transition exists. There is
no committee, administrator, plugin, or relayer recovery bypass.

### 7.4 Freeze and unfreeze

The configured recovery address may freeze an account immediately. A frozen
account cannot execute UserOperations or propose or activate configuration
changes, including recovery-address rotation. Recovery operations
remain available so that custody can be repaired.

Unfreezing requires both the current custody witness and the configured
recovery witness when a recovery address exists. If no recovery address exists,
only the custody witness is required. A frozen account with no recovery address
can therefore be unfrozen only by its custody authority.

`freeze` MUST require the recovery witness and MUST be unavailable when the
account has no recovery address. `unfreeze` MUST require the authorities stated
above. Freeze requires Active status and unfreeze requires Frozen status;
repeated same-status calls MUST fault. Both increment the configuration nonce
and clear all pending intents so that proposals cannot cross a status transition.

## 8. Module binding and code identity

An installed verifier MUST expose exactly:

```text
validateSignature(accountId: Hash160, op: Array) -> Boolean
postExecute(accountId: Hash160, op: Array, result: Any) -> Void
```

A leaf verifier MUST additionally expose the safe discovery method:

```text
getSignerDomains(accountId: Hash160) -> Array
```

Each returned element MUST be a 32-byte signer-domain commitment. The
commitment is computed as:

```text
SHA256(ASCII("NeoSmartAccount/SignerDomain") || UInt8(1) ||
       schemeTag || canonicalSignerMaterial)
```

`schemeTag` and `canonicalSignerMaterial` are profile-defined. Version 1
assigns `0x01` to secp256k1, `0x02` to secp256r1, `0x03` to native script
identities, and `0x04` to DKIM registry authority. It uses compressed
public-key encoding for secp256k1 and secp256r1 identities, the canonical
20-byte script hash for native witness identities, and the configured authority
commitment for non-key profiles. A verifier MUST return
the complete set of signer domains that can authorize the account, not only
the signer used by the current operation. A dynamic policy whose signer set
cannot be represented statically MUST return an empty array and is not an
eligible child of `MultiSigVerifier` in version 1.

An installed hook MUST expose exactly:

```text
preExecute(accountId: Hash160, op: Array) -> Void
postExecute(accountId: Hash160, op: Array, result: Any) -> Void
```

Every installed verifier and hook MUST also expose the safe discovery method:

```text
supportsComposition() -> Boolean
```

Every installed verifier and hook MUST expose the non-safe maintenance method:

```text
clearAccount(accountId: Hash160) -> Void
```

This exact lifecycle ABI is required for roots and children. Cleanup runs only
under the authenticated `cleanup` context and the fixed maintenance budget;
ABI admission alone does not establish complete removal of arbitrary plugin storage.

A leaf module MUST return `false`. A composite module MUST return `true` and
MUST NOT be installed as a child of another composite. Version 1 composites
are the protocol-defined `MultiSigVerifier` and `MultiHook` profiles; arbitrary
recursive composition is not part of this profile.

When a composite is bound, `AccountManagement` MUST validate every child as a
deployed module with the exact lifecycle ABI above, require a `false`
`supportsComposition()` result, reject zero, duplicate, and self identities,
and enforce a maximum of 10 verifier children and 8 hook children.
Signer-domain discovery applies to verifier children only: each MUST return a
non-empty `getSignerDomains` result, with no duplicate commitments within or
across children. Hook children do not implement signer-domain discovery.
`MultiSigVerifier` MUST repeat the domain
separation check before validation and before verifier post-execution so a
child configuration change cannot invalidate the binding invariant. The
native core MUST record the validated child list in a core-owned,
account-scoped dependency registry; the composite MUST NOT own the
authoritative cleanup roster.

Signer-domain separation is a configuration invariant, not a proof of
cryptographic independence. It prevents reuse of the same canonical key or
authority commitment by the protocol-defined verifier profiles. It does not
prove private-key non-cooperation, witness-rule semantics, remote-attestation
correctness, or the behavior of an arbitrary third-party verifier that lies
about its configured domain. Such a verifier requires an independent audit
and MUST NOT be treated as equivalent to a protocol-defined key profile.

Before a composite publishes its child roster, the native core MUST provide a
child-configuration route equivalent to:

```text
callVerifierChild(accountId: Hash160, childVerifier: Hash160,
                  method: String, args: Array) -> Any
```

The route MUST be available only to the account's custody authority, MUST
require the active root verifier to advertise composition, MUST accept only a
validated leaf child, MUST apply the module-maintenance callback budget, and
MUST use the same delayed-call semantics as root verifier configuration. The
child call MUST execute with the child's configuration context, not the root's
context. A pending child call MUST be invalidated when its root binding or the
account configuration nonce changes. Every epoch transition in section 7 clears
these pending calls along with the other pending intents. This native profile
does not define escape, market settlement, or account removal entrypoints;
ordinary-contract lifecycle routes MUST NOT be inferred as native ABI methods.

Before a composite binding is removed or replaced, the native core MUST invoke
`clearAccount(accountId)` on every removed or previously registered leaf child
under that child's authenticated `cleanup` context. A retained child remains
configured during a partial replacement. Any child fault MUST abort the whole
operation and roll back the root binding, dependency registry, and all child
state changes. A final removal MUST clear the root registry after all child
cleanup succeeds.

Verifier validation MUST be read-only. Hook and verifier post-execution calls
may write only through their normal application permissions.

The native service MUST reject a module that is missing, blocked, has the wrong
ABI types, or is not a deployed contract. The native service MUST reject a
module if its current code identity differs from the stored binding.
Native contracts, including `AccountManagement` itself, MUST NOT be installed as
verifiers or hooks in version 1.

The native service MUST call `validateSignature` with `ReadOnly`, and MUST call
the verifier's `postExecute`, every hook callback, and the target method with
`All`. The fixed flags are not operation fields and cannot be weakened or
expanded by a caller.

The module code identity is:

```text
codeHash = SHA256(
    nefBytes ||
    UInt8(0) ||
    CanonicalManifestJsonUtf8
)
```

`CanonicalManifestJsonUtf8` MUST be the RFC 8785 JSON Canonicalization Scheme
(JCS) encoding of the complete deployed manifest, including `extra`. Object
names MUST be sorted recursively by unsigned UTF-16 code units; array order
MUST be preserved. Strings MUST use strict UTF-8 and JCS escaping without
Unicode normalization. Finite binary64 numbers MUST use the ECMAScript number
serialization specified by RFC 8785, including negative zero encoded as `0`.
A serializer that merely sorts keys or uses a platform's default JSON escaping
is not sufficient. Invalid Unicode, duplicate member names, non-finite numbers,
and nesting beyond the existing Neo JSON limit of 64 MUST be rejected. The
canonical output MUST also satisfy Neo's manifest byte-size limit. No parser
may repair or silently discard invalid data before binding.

`nefBytes` MUST contain the complete deployed NEF serialization, including its
header, method tokens and checksum. The zero separator is exactly one byte.
All byte arrays and manifest arrays retain their defined order. The hash is
recomputed from current deployed state before use; missing, blocked, or changed
modules MUST fault rather than retain cached admission. These rules pin module
bytes under the hash's collision-resistance assumption; they do not prove the
module's behavior, signer honesty, or cryptographic correctness.

Reference: [RFC 8785, JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html).

### 8.1 Authenticated invocation contexts

The native service MUST expose the safe query:

```text
hasModuleContext(accountId: Hash160, moduleType: String, module: Hash160,
                 phase: String) -> Boolean
isAccountAuthorized(accountId: Hash160) -> Boolean
```

`moduleType` is exactly `"verifier"` or `"hook"`. `phase` is exactly
`"validation"`, `"preExecute"`, `"postExecute"`, `"configuration"` or
`"cleanup"`. A verifier has no preExecute phase; a hook has no validation
phase. Mutable callback phases are Application-only. Validation context is
available during the verifier callback in either Verification or Application.
Unknown phase/type strings or absence of a matching context return false.

`hasModuleContext` MUST authenticate the actual querying module, account, role,
phase and current invocation; supplying an allowed module hash is insufficient.
The service grants a direct context only to the specific callback it schedules.
Initialization and internal VM calls share that grant, but a new cross-contract
call to the same script hash does not. For validation, preExecute and
postExecute only, a composite may delegate the current phase to a validated,
registered leaf called directly by that root invocation. A grandchild,
unregistered child, intermediary, or LoadScript context MUST NOT inherit it.
Configuration and cleanup always give each affected module an individual
direct context; they do not authorize all children at once.

`isAccountAuthorized` is true only when the actual caller is the currently
authorized target invocation for the account. It is false during module
callbacks and for arbitrary target descendants. It is not a witness substitute;
section 5.4 defines the additional enforcement in application witness evaluation.

Every mutating account entrypoint and operation batch MUST hold a same-account
lock before any external callback. A reentrant mutation or execution MUST
fault. Read-only context queries do not acquire that lock. Cross-account calls
may nest subject to their own authorization; an inner invocation MUST NOT
consume or replace a suspended outer invocation's grant. Contexts are transient,
phase-separated and removed on normal return and VM FAULT, including faults
after a native continuation has executed but before its child's RET is charged.

### 8.2 Delayed account-scoped module configuration

Version 1 exposes the following Application methods:

```text
callVerifier(accountId: Hash160, method: String, args: Array) -> Any
callHook(accountId: Hash160, method: String, args: Array) -> Any
callVerifierChild(accountId: Hash160, childVerifier: Hash160,
                  method: String, args: Array) -> Any
callHookChild(accountId: Hash160, childHook: Hash160,
              method: String, args: Array) -> Any
cancelModuleCall(accountId: Hash160, moduleType: String) -> Void
```

All four call routes require the current custody witness, an Active account,
no pending custody recovery, a usable configuration nonce, and the same-account
lock. `moduleType` is exactly `"verifier"` or `"hook"`. A child route additionally
requires the active root of that role to be a supported composite and its target
to be an admitted leaf distinct from that root.

A call route is a two-step operation, not an immediate forwarding API. With no
pending call for its role, it records the complete immutable call intent and
returns Boolean `false` without invoking a mutable module method. Repeating the
exact call at or after its module-change maturity executes it. An immature or
non-identical repetition MUST fault, not replace the intent or restart its delay.
Cancellation requires custody and an existing intent; it remains available while
Frozen or during recovery and does not advance the configuration nonce. A new
intent after cancellation starts the full delay again.

There is one pending call per account and role. The intent binds the account,
role, active root identity and code hash, selected module identity and code hash,
method bytes, full canonical argument bytes, proposal time, maturity and current
configuration nonce. A successful mutable callback advances the configuration
nonce and clears all account intents. Its ordinary result, including Boolean
`false` or Null, is returned unchanged. `getPendingModuleCall` distinguishes a
recorded proposal from a completed callback that returned false:

```text
getPendingModuleCall(accountId: Hash160, moduleType: String) -> Any
```

This safe query returns the pending record or Null; an unknown account faults.
The caller supplies only the method-specific arguments. The core MUST prepend
the authoritative `accountId` as argument zero. It MUST NOT accept an account
identifier supplied inside `args` as a substitute. Arguments have the same exact
VM types, depth and serialization bounds as UserOperation arguments, with at
most 63 supplied values so the invoked method has at most 64 arguments. Method
names have the same UTF-8 bound and MUST NOT begin with `_`.

A configurable module MUST declare an array of unique method names at
`extra.smartAccount.configurationMethods`. An absent list grants no generic
configuration capability. The selected deployed ABI method MUST be listed,
non-safe, have exactly one more parameter than the supplied argument count,
and have `Hash160` as its first parameter. The lifecycle methods
`validateSignature`, `preExecute`, `postExecute`, `clearAccount`,
`supportsComposition` and `getSignerDomains` MUST NOT appear in this list.
Metadata is part of the pinned code identity. It is a capability declaration,
not a proof that an arbitrary plugin confines its own writes to that account.

At confirmation the core rechecks maturity, all bound bytes, code identity,
blocking policy, ABI and authority before granting only the selected module's
`configuration` context. It passes `All` and the fixed maintenance budget.
Every failure rolls back the pending-call consumption, epoch, registry,
notifications and all module writes. A child configuration is registered in the
core's cleanup roster even before the composite publishes that child as active.
After the callback and before committing configuration, the core MUST revalidate
both the selected module and the bound root against their original identities,
code hashes, ABI and blocking policy. A callback that destroys, changes or blocks
either binding MUST fault and roll back all its effects; checking only the
selected child is insufficient.
If it is already active, the core MUST revalidate the complete active verifier
signer-domain separation after its configuration; a conflicting change faults.

Pending call storage MUST use the exact Array:
`[1, accountId, role, rootBinding, selectedBinding, methodBytes, invokedArguments,
proposedAt, matureAt, configurationNonce]`. `role` is Integer `0` for verifier or
`1` for hook; version, role, epoch and timestamps MUST be exact Integers, not
Boolean or ByteString coercions. Timestamps and epoch use UInt64 bounds and the
fixed module-change delay. `methodBytes` MUST be a strict UTF-8 ByteString;
`invokedArguments` MUST include the prepended accountId and satisfy the canonical
argument rules. Queries and confirmation MUST reject a malformed, stale-root or
stale-epoch record. Custody cancellation MAY delete a malformed intent without
executing it.

### 8.3 Authoritative composition registry

The native service exposes these Application methods:

```text
setVerifierDependencies(accountId: Hash160, children: Array) -> Void
setHookDependencies(accountId: Hash160, children: Array) -> Void
clearVerifierDependencies(accountId: Hash160) -> Void
clearHookDependencies(accountId: Hash160) -> Void
```

The setter authenticates the actual active root's current `configuration`
invocation. It MUST NOT accept custody signatures, hash equality alone, another
account's context, a child, a new invocation of the same root, or a target grant
as substitutes. These are internal callback continuations of an already locked
transition, not independently authorized account mutations. Cleanup context may
only acknowledge an already emptied registry through the corresponding clear
method; it MUST NOT publish a new roster.

The core keeps, separately for each account and role:

1. the pinned root binding;
2. the ordered cleanup roster of all enrolled leaf bindings, including configured
   leaves not yet published as active;
3. the ordered active child hash list.

Both rosters are bounded by 10 verifier leaves or 8 hook leaves. Each identity is
non-zero, distinct from the root and all other entries, non-native, deployed,
unblocked, and pinned to its current code. The active list is a subset of the
cleanup roster. Leaf admission and, for verifier children, non-empty disjoint
signer domains are checked before publishing. Array order is protocol-visible;
it is not replaced with hash or dictionary order.

A partial replacement cleans each removed active leaf under an individual
`cleanup` grant before removing that leaf from the cleanup roster. Retained
active leaves and enrolled-but-inactive leaves retain their state. Publishing an
empty active list cleans previously active leaves; final root removal additionally
cleans every enrolled-but-inactive leaf. The core then empties the registry before
calling the old root's cleanup. Root or leaf faults roll back the entire update.
Recovery and freeze preserve the registry because they preserve installed roots.

The registry query is safe and faults for an unknown account:

```text
getModuleDependencies(accountId: Hash160, moduleType: String) -> Array
```

It returns `[rootBindingOrNull, cleanupBindings, activeChildHashes]`. Each binding
is `[Hash160 bytes, codeHash bytes]`. Empty roles return `[Null, [], []]`.
The registry belongs to the native core, never to plugin-provided storage.
A composite's claimed profile name does not establish honest behavior; only
conforming, independently reviewed MultiSigVerifier and MultiHook profiles may
be treated as those profiles. Arbitrary module behavior remains a trust boundary.

The native MultiSig module profile uses a separate read-only leaf method,
`validateSignatureForPostExecute(accountId: Hash160, op: Array) -> Boolean`,
for post-execution approval checks. It requires the exact `postExecute` grant;
it MUST NOT broaden the ordinary `validateSignature` entry to accept that phase.
The same leaf policy is evaluated without state debit, after which only approving
children receive their post callbacks. The module-specific requirements are in
`SMARTACCOUNT-NATIVE-MULTISIG.md`; this additional leaf method is not a new native
service method or a new authority phase. Descendant calls still share the root
callback's fixed budget.

Discovery and cleanup performed by a registry continuation inside a composite
maintenance callback inherit that callback's remaining budget and fixed flags;
they MUST NOT allocate another equal maintenance budget beneath it. Direct
maintenance roots still receive the full fixed callback cap, subject to the
transaction and ancestor admission checks in section 10.

Pending call records and dependency records do not alter the thirteen-field
account record. Implementations MUST preserve these logical records across
serialization and rollback; no client may infer authorization from storage keys.

## 9. UserOperation authorization and execution

The native service implements the foundation's exact six-field UserOperation:

```text
[targetContract, method, args, nonce, deadline, signature]
```

It MUST validate the shape, bounds, canonical argument types, and numeric
ranges before calling any external module. Supported argument values are
`Null`, `Boolean`, `Integer`, `ByteString`, `Array`, and `Struct`. `Map` and
`InteropInterface` values are rejected by this profile. Nested arrays and
structs have a maximum depth of eight.

The operation and its top-level `args` MUST have the exact Array type, not
Struct. The target, method, and signature MUST have the exact ByteString type;
Buffer is not an alternate encoding. The target is a non-zero 20-byte value,
the method is strict UTF-8 of 1 through 128 bytes, and the signature contains
at most 1024 bytes. The top-level argument Array does not count as a nesting level;
each nested Array or Struct counts one level. The complete argument Array,
including its type and length headers, MUST serialize to at most 4096 bytes
and MUST contain at most 64 top-level values. Repeated references to compound
values, including cycles, MUST be rejected, matching Neo's canonical binary
serializer. Independent, equal-valued compound arguments remain permitted.

Both numeric fields MUST have the exact Integer type and satisfy:

```text
0 <= nonce < 2^255
0 <= deadline < 2^255
```

NeoVM uses signed 256-bit Integers. Values from `2^255` through `2^256 - 1`
require a 33-byte signed representation and cannot use this ABI. A node or
client MUST NOT coerce a ByteString or Boolean into these fields, truncate an
out-of-range value, or reinterpret a negative Integer as unsigned. This
corrects the earlier draft's unrepresentable unsigned-256 range without
changing any representable operation or the published signing vectors.

Nonce processing is exact:

```text
channel  = nonce >> 64
sequence = nonce & (2^64 - 1)
```

Only the stored next sequence is accepted. Sequence `2^64 - 1` is consumable,
after which the stored channel cursor is the explicit exhaustion sentinel
`2^64`. A channel with cursor `2^64` is permanently exhausted and MUST NOT
wrap or accept another operation.

The execution order is:

1. require Application trigger and establish the same-account execution lock;
2. validate the operation and account state, rejecting a frozen account;
3. reject an expired deadline or incorrect next sequence;
4. validate the installed module code identity and ABI;
5. validate authorization;
6. consume the nonce;
7. call hook `preExecute`;
8. call the target with exactly the supplied method and arguments;
9. call hook `postExecute`, then verifier `postExecute`;
10. emit `UserOpExecuted` and clear temporary state.

`executeUserOps` MUST validate that `ops` is non-empty, contains no more than
32 operations, and contains only operations for the supplied `accountId`. The
same-account execution lock remains held for the entire batch. All operations
execute in array order inside one application-state boundary. A failure in any
operation MUST roll back every nonce increment, target write, callback write,
freeze transition, and notification produced by the batch.

The effective normative order, without shorthand, is:

```text
lock
validate
deadline-and-nonce-check
validateSignature or native-witness fallback
consume-nonce
hook.preExecute
target call
hook.postExecute
verifier.postExecute
UserOpExecuted
unlock
```

The account MUST NOT accept caller-supplied verifier or hook identities. A
same-account reentrant execution MUST fault before any external module runs.
The target's Boolean `false` is a normal result; it is not converted into a
VM fault by the core.

Any validation failure, module failure, target VM fault, resource exhaustion,
or post-callback failure MUST roll back nonce, target state, module state,
freeze state, and notifications. Transaction fees are not refunded.

### 9.1 Native-witness fallback

When `verifier` is zero, authorization uses the stored custody witness. The
operation's signature field MUST be an empty byte string. The native service
MUST call `CheckWitnessInternal(custodyAddress)` and MUST NOT accept a supplied
signer list as proof.

This fallback authorizes the transaction that invokes the UserOperation. It
does not create a relayer signature format and does not replace verifier-based
authorization.

### 9.2 Authorization domain

Verifier profiles MUST bind their authorization digest to:

```text
ASCII("NeoSmartAccount/UserOperation") ||
UInt8(1) ||
UInt32LE(networkMagic) ||
coreHash.ToArray() ||
accountId.ToArray() ||
canonicalOperationWithoutSignature
```

`canonicalOperationWithoutSignature` is the canonical six-field operation with
field five replaced by an empty `ByteString`. The digest is
`SHA256` of the complete byte sequence. The native core MUST expose this
domain and operation digest through read-only methods so that independent
verifier profiles do not reconstruct network or core identity from display
strings.

`getAuthorizationDomain()` returns the bytes from the domain prefix through
`accountId` in the formula above. `getOperationDigest()` returns the single
SHA-256 digest of that domain followed by the canonical operation bytes.

## 10. Resource and fee accounting

The native service MUST use the platform bounded-call capability for every
external verifier and hook callback:

```text
System.Contract.CallWithGasLimit(
    target,
    method,
    flags,
    fixedProfileBudget,
    args
)
```

The platform capability is identified by the exact syscall name
`System.Contract.CallWithGasLimit` and the exact parameter order shown above.
It is available only after the separately configured `HF_SmartAccountV1`
activation boundary. A node MUST reject the syscall before that boundary and
MUST NOT treat an omitted `HF_SmartAccountV1` entry as activation at genesis.
The `gasLimit` value is an integer number of datoshi; it MUST be positive and
MUST fit within both the enclosing transaction budget and every active ancestor
bounded-call budget before the callee context is created.

The capability MUST satisfy all of the following:

1. every billable charge in the callback and its descendants consumes the
   active child budget;
2. ordinary nested calls inherit all ancestor budgets;
3. nested bounded calls cannot escape an ancestor budget;
4. fee whitelists do not bypass the budget;
5. zero, negative, and transaction-budget-exceeding limits are rejected;
6. exhaustion faults closed and rolls back application state and notifications;
7. the budget covers callback initialization, execution, nested calls, and
   return-value handling.

The same capability MUST be used for every external module maintenance callback,
including lifecycle cleanup (`clearAccount`), profile-specific configuration, and
composition-marker discovery. These calls use the fixed module maintenance
budget of `250,000,000` datoshi. A maintenance callback that exhausts its budget
MUST fault and MUST leave the enclosing configuration, recovery, or migration
transition unchanged. A maintenance budget is independent of the verifier and
hook execution budgets and MUST NOT be supplied by an account or module.

When a maintenance callback is a composite root, its ordinary descendant calls
for child discovery and child cleanup inherit the active root maintenance
budget. The root and its descendants therefore form one bounded maintenance
call tree; the protocol MUST NOT require each descendant to allocate another
equal fixed budget beneath the root, because that would make valid
configurations depend on implementation-specific dispatch overhead. A
descendant still consumes the remaining root budget and cannot escape it by
using an ordinary call.

For this profile, “descendants” includes ordinary contract calls, static method
tokens, the contract's `_initialize` method, `System.Runtime.LoadScript`, and
native asynchronous callback continuations reached before the callback returns.
Each descendant retains the active budget chain. Dynamic execution does not
acquire additional call permissions or a deployed contract identity, and this
budget inheritance does not change legacy transaction fee-whitelist semantics.
Returning from a descendant does not refund consumed budget.

The verifier budget is `100,000,000` datoshi per callback. This callback is
reachable from the Verification trigger, so the profile value MUST remain less
than or equal to Neo's `MaxVerificationGas` envelope of `150,000,000` datoshi.
The hook budget is `250,000,000` datoshi per callback and applies only to the
Application-trigger hook path. The target call uses the enclosing transaction
budget and is not silently assigned a verifier budget.

Normal Neo fee charging still applies. A fee whitelist may change transaction
fee charging but MUST NOT change the safety budget. Version 1 has no native
paymaster or automatic sponsorship path.

## 11. Governance and upgrades

The native service has no runtime administrator. Its code, ABI, native hash,
and hardfork activation are consensus-governed. Existing committee policy
mechanisms may block a contract according to the general Neo protocol, but
there is no SmartAccount-specific committee bypass for account custody,
recovery, or module binding.

An ABI or state-layout change requires:

1. a new profile version;
2. a new activation boundary;
3. a deterministic migration routine;
4. cross-client vectors for pre- and post-activation behavior;
5. explicit compatibility rules for existing addresses and assets.

There is no emergency method that changes custody, verifier, hook, or account
address without the authority and delay rules above.

## 12. Migration and compatibility

Existing ordinary SmartAccounts remain ordinary deployed contracts. No native
account is implicitly created for them and no existing address changes meaning.

An optional migration adapter may create a native account only when:

- the legacy account address witnesses the migration transaction;
- the new custody address witnesses the same transaction;
- the legacy core identity, legacy account identifier, and legacy address are
  recorded in the migration event;
- the new account identifier is computed by the version-1 formula;
- the legacy identity has not already been imported.

The native address is different from the legacy address. Assets remain at the
legacy address until an explicitly authorized transfer occurs. The native core
MUST NOT claim custody of legacy assets merely because an import record exists.

The migration mapping is one-way and immutable:

```text
(legacyCoreHash, legacyAccountId, legacyAddress) -> nativeAccountId
```

No reverse mapping, address alias, or transparent script replacement is
provided by version 1.

## 13. Required ABI surface

The version-1 ABI MUST contain the following methods and events. The exact Neo
ABI parameter types are normative.

### Read-only methods

```text
getPendingModuleCall(accountId: Hash160, moduleType: String) -> Any
getModuleDependencies(accountId: Hash160, moduleType: String) -> Array
getVersion() -> Integer
getAccount(accountId: Hash160) -> Any
getAccountAddress(accountId: Hash160) -> Hash160
getNonce(accountId: Hash160, channel: Integer) -> Integer
getAuthorizationDomain(accountId: Hash160) -> ByteArray
getOperationDigest(accountId: Hash160, op: Array) -> ByteArray
verify(accountId: Hash160) -> Boolean
hasModuleContext(accountId: Hash160, moduleType: String, module: Hash160,
                 phase: String) -> Boolean
isAccountAuthorized(accountId: Hash160) -> Boolean
```

### Application methods

```text
callVerifier(accountId: Hash160, method: String, args: Array) -> Any
callHook(accountId: Hash160, method: String, args: Array) -> Any
callHookChild(accountId: Hash160, childHook: Hash160,
              method: String, args: Array) -> Any
cancelModuleCall(accountId: Hash160, moduleType: String) -> Void
setVerifierDependencies(accountId: Hash160, children: Array) -> Void
setHookDependencies(accountId: Hash160, children: Array) -> Void
clearVerifierDependencies(accountId: Hash160) -> Void
clearHookDependencies(accountId: Hash160) -> Void
registerAccount(custodyAddress: Hash160, salt: ByteArray,
                verifier: Hash160, hook: Hash160,
                recoveryAddress: Hash160) -> Hash160
executeUserOp(accountId: Hash160, op: Array) -> Any
executeUserOps(accountId: Hash160, ops: Array) -> Array
callVerifierChild(accountId: Hash160, childVerifier: Hash160,
                  method: String, args: Array) -> Any
proposeVerifier(accountId: Hash160, verifier: Hash160) -> Void
activateVerifier(accountId: Hash160) -> Void
cancelVerifier(accountId: Hash160) -> Void
proposeHook(accountId: Hash160, hook: Hash160) -> Void
activateHook(accountId: Hash160) -> Void
cancelHook(accountId: Hash160) -> Void
proposeRecoveryAddress(accountId: Hash160, recovery: Hash160) -> Void
activateRecoveryAddress(accountId: Hash160) -> Void
cancelRecoveryAddress(accountId: Hash160) -> Void
proposeRecovery(accountId: Hash160, newCustody: Hash160) -> Void
executeRecovery(accountId: Hash160) -> Void
cancelRecovery(accountId: Hash160) -> Void
freeze(accountId: Hash160) -> Void
unfreeze(accountId: Hash160) -> Void
```

### Events

```text
AccountCreated(accountId, accountAddress, custodyAddress, verifier, hook,
               recoveryAddress)
VerifierChangeProposed(accountId, verifier, activateAt, configurationNonce)
VerifierChanged(accountId, verifier, configurationNonce)
VerifierChangeCancelled(accountId, configurationNonce)
HookChangeProposed(accountId, hook, activateAt, configurationNonce)
HookChanged(accountId, hook, configurationNonce)
HookChangeCancelled(accountId, configurationNonce)
RecoveryAddressChangeProposed(accountId, recoveryAddress, activateAt,
                               configurationNonce)
RecoveryAddressChanged(accountId, recoveryAddress, configurationNonce)
RecoveryAddressChangeCancelled(accountId, configurationNonce)
RecoveryProposed(accountId, newCustodyAddress, executeAt, configurationNonce)
RecoveryCancelled(accountId, configurationNonce)
RecoveryExecuted(accountId, oldCustodyAddress, newCustodyAddress,
                 configurationNonce)
AccountFrozen(accountId)
AccountUnfrozen(accountId)
UserOpExecuted(accountId, targetContract, method, nonce)
```

The event field order and types MUST be published in the native manifest and
must remain stable for ABI version 1.

The normative event parameter types and order are:

| Event | Parameters |
|---|---|
| `AccountCreated` | `Hash160, Hash160, Hash160, Hash160, Hash160, Hash160` |
| `VerifierChangeProposed` | `Hash160, Hash160, Integer, Integer` |
| `VerifierChanged` | `Hash160, Hash160, Integer` |
| `VerifierChangeCancelled` | `Hash160, Integer` |
| `HookChangeProposed` | `Hash160, Hash160, Integer, Integer` |
| `HookChanged` | `Hash160, Hash160, Integer` |
| `HookChangeCancelled` | `Hash160, Integer` |
| `RecoveryAddressChangeProposed` | `Hash160, Hash160, Integer, Integer` |
| `RecoveryAddressChanged` | `Hash160, Hash160, Integer` |
| `RecoveryAddressChangeCancelled` | `Hash160, Integer` |
| `RecoveryProposed` | `Hash160, Hash160, Integer, Integer` |
| `RecoveryCancelled` | `Hash160, Integer` |
| `RecoveryExecuted` | `Hash160, Hash160, Hash160, Integer` |
| `AccountFrozen` | `Hash160` |
| `AccountUnfrozen` | `Hash160` |
| `UserOpExecuted` | `Hash160, Hash160, String, Integer` |

Unknown-account queries for `getAccountAddress`, `getNonce`, and
`getOperationDigest` MUST fault. `getVersion` and `getAuthorizationDomain`
remain callable after activation without an account record. Every malformed
ABI value, invalid authority, stale delayed transition, missing module, blocked
module, callback budget exhaustion, target fault, and wrong callback result
type MUST fault and MUST preserve the outer application-state rollback rule.

## 14. Conformance vectors

An implementation MUST publish machine-readable vectors for every boundary in
this section. The following identity vector is normative:

```text
networkMagic = 0x12345678
coreHash     = d9421d07adf206e9dc4be746a02e8e087fa61741
custody      = 202122232425262728292a2b2c2d2e2f30313233
salt         = 404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f

accountId    = 0x3e25330008563c55fe2853e07868b36ca00020ac
accountAddress = 0x7829f40af6380c00110932c9551ece0916fdcad1
```

The corresponding test suite MUST additionally cover:

- zero and duplicate identifiers;
- invalid salt length and custody values;
- exact verification-script bytes and script hash;
- signer-domain commitments for every version-1 scheme tag and canonical material;
- strict UTF-8 method boundaries;
- argument depth, type, count, and serialized-size boundaries;
- nonce sequence zero, maximum, exhaustion, and channel independence;
- deadline equal-to-now and one-millisecond expiry boundaries;
- verifier and hook ABI mismatch;
- module code replacement under the same contract hash;
- callback budget exhaustion, nested inheritance, and fee whitelists;
- same-account reentrancy and target Boolean `false`;
- exact callback-frame, account, role and phase isolation;
- Global-scope proxy witnesses rejected outside the active target invocation;
- depth-one child delegation and rejection of same-hash reentry and dynamic scripts;
- rollback of nonce, target state, callback state, and notifications;
- recovery delay, stale configuration nonce, cancellation, and frozen state;
- pre-activation rejection and activation-block initialization;
- legacy import witness requirements and asset non-custody.

## 15. Implementation gate

The native core implementation is ready for a protocol PR only when all of the
following are true:

1. the activation identifier and network configuration are accepted;
2. the bounded-call engine capability is implemented and independently tested;
3. the native ABI and storage encoding match this document byte-for-byte;
4. the vectors are checked by at least two independent clients;
5. NeoExpress verifies activation, execution, rollback, migration, and
   readback parity;
6. the source, NEF-equivalent native manifest, and deployed readback hashes
   match;
7. a security audit has no unmitigated critical or high findings.

Until these gates pass, this document remains a design profile and MUST NOT be
presented as an activated Neo native SmartAccount service.
