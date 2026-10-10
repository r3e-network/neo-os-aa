# Native SmartAccount Profile

**Foundation:** Draft PR [#243](https://github.com/neo-project/proposals/pull/243)

**Discussion:** Issue [#242](https://github.com/neo-project/proposals/issues/242)

**Status:** Draft protocol profile; not activated and not an adopted standard
**Version:** 2 (identity version 1; authorization and account-record version 2)

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
| Profile version | `2` |
| Identity derivation version | `1` (unchanged) |
| Authorization version | `2` |
| Account record version | `2` |
| Authority epoch and configuration nonce | Separate unsigned 64-bit counters |
| Native ABI version | `2` |
| Maximum native verifier children | `3` |
| Maximum native verifier threshold / approved children | `2` / `2` |
| Maximum aggregate native signer domains | `3` |
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
| Native sponsorship | Not included in version 2 |

The resource budgets are fixed profile parameters. They are not operation
fields, account-controlled values, or fee-whitelist exemptions. A later profile
version MUST use a new ABI version and activation boundary when changing them.

The activation record MUST include this parameter digest:

```text
profileParameterDigest = SHA256(
    ASCII("NeoSmartAccount/Profile") ||
    UInt8(2) ||
    CanonicalProfileParameterJsonUtf8
)
```

For version 2, `CanonicalProfileParameterJsonUtf8` is exactly the following
byte sequence:

```text
{"abiVersion":2,"accountRecordVersion":2,"argumentCountMax":64,"argumentDepthMax":8,"argumentSizeMax":4096,"authorityEpochWidthBits":64,"authorizationDomainSuffix":["authorityEpochLE64","configurationNonceLE64"],"authorizationVersion":2,"batchMax":32,"childConfiguration":true,"compositeReceipt":{"fields":["BooleanTrue","OrderedApprovedHash160Array","PolicyCommitmentByteString32"],"lifetime":"oneApplicationOperation","policyCommitment":"SHA256(NeoBinarySerialize([threshold,orderedChildren,orderedChildSignerDomains]))","postSignatureRevalidation":false,"selection":"firstThresholdValidChildren","verificationReceiptReused":false,"version":1},"compositeVerifierCallbacks":{"postExecute":{"name":"postExecuteComposite","parameters":["Hash160","Array","Any","Array"],"returnType":"Void","safe":false},"validation":{"name":"validateCompositeSignature","parameters":["Hash160","Array"],"returnType":"Array","safe":false}},"compositeVerifierMaxApprovedChildren":2,"compositeVerifierMaxChildren":3,"compositeVerifierMaxSignerDomains":3,"compositeVerifierMaxThreshold":2,"configurationNonceWidthBits":64,"custodyRecoveryDelayMs":604800000,"executionArgumentOrder":["accountId","operationOrBatch","expectedAuthorityEpoch","expectedConfigurationNonce"],"executionCounterCommitments":["authorityEpoch","configurationNonce"],"hookBudgetDatoshi":250000000,"identityVersion":1,"maintenanceBudgetDatoshi":250000000,"methodBytesMax":128,"moduleChangeDelayMs":86400000,"moduleCompositeVerifierMarkerRequired":true,"moduleProfileDigestRequired":true,"nativeP256Canonicalization":{"accountRegistrationRequired":false,"algorithm":"compressedDecodeThenExactUncompressedRoundTrip","argumentStackType":"ByteString","cpuFeeUnits":32768,"name":"canonicalP256PublicKey","ownedResult":true,"parameters":["ByteArray"],"requiredCallFlags":"None","returnType":"ByteArray","safe":true},"nativeP256SignerDomain":{"canonicalSigner":"CreateStandardAccount(compressedSecp256r1PublicKey)","domainsPerKey":1,"scheme":"NativeScript"},"nativeSessionMetadataStorage":{"atomicWithSessionConfiguration":true,"deletedWithSession":true,"legacyFallback":false,"metadataRecordFields":3,"namespace":"authorityEpoch","policyPrefix":"06","readFresh":true,"sessionConfigurationInitialValue":0,"storedMetadataLastUsedAt":0,"valueType":"CanonicalUInt64NeoInteger"},"nativeSessionPublicKey":{"acceptedEncodingBytes":[33,65],"invalidPoint":"rejectAtomically","normalization":"secp256r1DecodeThenCompress","normalizationServiceMethod":"canonicalP256PublicKey","storedEncodingBytes":33},"nativeSessionSignerDomainStorage":{"atomicWithSessionConfiguration":true,"deletedWithSession":true,"legacyFallback":false,"namespace":"authorityEpoch","policyPrefix":"05","readFresh":true,"sessionRecordFields":5,"valueBytes":32},"nativeSponsorship":false,"nativeWitnessSignerDomainStorage":{"atomicWithConfiguration":true,"configurationRecordFields":2,"deletedWithAccountCleanup":true,"encoding":"orderedPackedByteString32","legacyFallback":false,"maxDomains":10,"namespace":"authorityEpoch","policyPrefix":"03","readFresh":true},"profileVersion":2,"recoveryRevokesModules":true,"serviceName":"AccountManagement","signatureBytesMax":1024,"verifierBudgetDatoshi":100000000}
```

The resulting version-2 digest is:

```text
4201b02f571b7415121467d67343a8189b8070ad795a82424c0403782d22b1b4
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
    "abiVersion": 2,
    "profileParameterDigest": "4201b02f571b7415121467d67343a8189b8070ad795a82424c0403782d22b1b4"
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
4. make the version-2 ABI available from that block onward.

Before activation, `AccountManagement` has no callable version-2 ABI. Existing
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

For version 2, the transaction script MUST be the canonical application
envelope for this account. The envelope is exactly one application call with
the following semantic values and no additional instructions:

```text
System.Contract.Call(
    AccountManagement.Hash,
    "executeUserOp" or "executeUserOps",
    All,
    accountId,
    op or ops,
    expectedAuthorityEpoch,
    expectedConfigurationNonce
)
```

The script parser MUST require the native service hash, method, call flags,
argument count of four, account identifier, both current authority counters, and canonical operation bytes to match.
Both expected counters MUST be exact UInt64 Integers and MUST equal the current
stored authorityEpoch and configurationNonce in both Verification and Application.
The former two-argument entrypoints MUST NOT remain callable. The two expected
counters are encoded in the unsigned transaction script, so transaction-witness
modes (custody fallback and NeoNativeVerifier) commit to them as well as operation
signatures. Native callbacks still receive the unchanged six-field UserOperation.
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
    [accountId, op or ops, expectedAuthorityEpoch, expectedConfigurationNonce]
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
5. call read-only `validateCompositeSignature` for an admitted composite
   verifier, or `validateSignature` for a scalar verifier; use the native-witness
   fallback when no verifier is installed;
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
    authorityEpoch:       UInt64
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
Array with exactly these 14 positions (positions 0 through 12 retain their meaning):

```text
[version, accountId, accountAddress, custodyAddress, recoveryAddress,
 verifier, hook, status, configurationNonce, pendingVerifier, pendingHook,
 pendingRecoveryAddr, pendingRecovery, authorityEpoch]
```

`version` is exactly `2`; `status` is a canonical non-negative Integer.
`authorityEpoch` at index 13 and `configurationNonce` at index 8 are distinct
unsigned 64-bit Integers, initially zero. Counter overflow MUST fault before mutation. Version 2 uses
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

A decoded account record MUST satisfy `authorityEpoch <= configurationNonce`.
Both counters start at zero; configuration advances only configurationNonce and
recovery advances both. A record violating this reachable-state invariant MUST
be rejected, even when both values individually fit UInt64. Pure authorization
domain encoders may encode any UInt64 pair for conformance vectors; such vectors
do not imply that the pair is a valid stored account state.

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
- initialize the account as `Active` with configuration nonce zero and authority epoch zero;
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
that require another configuration counter value. Pending records MUST bind the current configuration nonce and
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
- preserves the account identifier, account address, nonce state, and recovery address;
- removes the verifier and hook roots and all dependency records, selecting native-witness fallback;
- revokes every old module generation without invoking any external callback;
- clears all pending intents, including the executed recovery;
- increments both the configuration nonce and the authority epoch, with checked overflow;
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

### 7.5 Authority generations and recovery isolation

Every native module MUST namespace all account-owned persistent state by the
account identifier and the current `authorityEpoch`, obtained from the native
service. The native module key encoding MUST be
`0xA2 || policyPrefix || accountIdLE20 || authorityEpochLE64 || suffix`, with a
one-byte policy prefix, a 20-byte account identifier and an unsigned 64-bit
little-endian epoch. The distinct `0xA2` version tag prevents confusion with
unversioned legacy keys. Modules MUST reject an invalid or unavailable epoch;
there is no legacy namespace fallback or ability to select a future generation.
Configuration counters are not storage namespaces. The same module
reinstalled after recovery MUST observe an empty current-generation namespace;
old grants, keys, spending state and transient snapshots MUST NOT become active
again. Historical storage may remain unreachable; recovery never depends on
old module availability, code identity or successful cleanup. A module must
bind each callback to the current authenticated native account/module/phase.

Only successful custody recovery increments `authorityEpoch`. Configuration,
freeze and unfreeze retain the authority epoch and advance the separate
configuration nonce as specified above. Both counters bind authorization, so a
configuration transition invalidates previously signed but unconsumed operations.
Recovery clears all pending intents and roots before returning; target nonces,
identity and frozen state remain unchanged. Subsequent unfreeze still requires
the current custody and configured recovery witnesses. No committee bypass is
introduced.

Native ABI 1 modules MUST NOT be relabelled as ABI 2. Packaged ABI 2 modules
must declare the native-v2 profile, an explicit ABI version, and permission to
read `getAuthorityEpoch`. All six supported native module profiles must pass
recovery/reinstall isolation vectors. Migration of an existing ABI 1 account
record requires a separately activated, deterministic migration routine; there
is no implicit interpretation of a 13-field record as ABI 2.

Every module manifest MUST additionally declare `extra.smartAccount.profileDigest`
as exactly 64 lowercase hexadecimal characters equal to the service's
`profileParameterDigest`, and `extra.smartAccount.compositeVerifier` as an exact
JSON Boolean. The latter is `true` only for a verifier using the composite receipt
callbacks; verifier `supportsComposition()` MUST return the same value. Hooks
MUST declare `false`; their independent hook-composition discovery is unchanged.
Missing, mismatched or incorrectly typed declarations MUST fail admission. The
packager computes the fingerprint from the canonical parameter JSON; it MUST NOT
infer compatibility from a compiler label or silently supply an old fingerprint.

## 8. Module binding and code identity

Every ABI 2 verifier, including a composite root, MUST retain these scalar
compatibility descriptors with the exact types below. Ordinary leaf verifiers
use these callbacks for execution; admitted composite roots use the additional
composite callbacks specified next. This native profile is stricter about
baseline descriptors than the foundation's general permission to define a
separate composite ABI; it does not make either execution-after callback optional.

```text
validateSignature(accountId: Hash160, op: Array) -> Boolean
postExecute(accountId: Hash160, op: Array, result: Any) -> Void
```

A composite verifier MUST additionally expose both non-safe callback descriptors:

```text
validateCompositeSignature(accountId: Hash160, op: Array) -> Array
postExecuteComposite(accountId: Hash160, op: Array, result: Any, receipt: Array) -> Void
```

The first callback is invoked with `ReadOnly` despite its non-safe descriptor.
It MUST return an exact three-element Array:
`[Boolean true, orderedApprovedChildren, policyCommitment32]`. The approved
children MUST form a nonempty, ordered, unique subset of the current active
verifier children, represented by exact 20-byte ByteStrings. The policy
commitment MUST be an exact 32-byte ByteString. The fixed profile bounds apply
to child count, approved count, threshold and aggregate signer domains.

`AccountManagement` MUST strictly parse and copy the result before any target
call. The receipt is owned by one Application operation; it MUST NOT be stored
in contract storage, accepted from transaction arguments, shared with another
operation, or carried from Verification into Application. Verification parses
and discards its receipt. Application performs fresh validation and retains its
own receipt only until that operation's post callback completes or faults.
Batch operations each produce a new receipt. The composite post callback uses
the validated selection without repeating child signature verification. Its
authenticated child grant is restricted to the approved subset, while the core
still checks the code bindings of every currently active child.

This is an amendment to the unreleased ABI 2 draft. Profile discovery MUST bind
the composite callback and receipt semantics, together with the measured fixed
composition limits, into the authoritative parameter digest. Matching only the
ABI number or a `native-v2` label is insufficient to admit a prior draft module.

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

`schemeTag` and `canonicalSignerMaterial` are profile-defined. Signer-domain encoding version 1
assigns `0x01` to secp256k1, `0x02` to secp256r1, `0x03` to native script
identities, and `0x04` to DKIM registry authority. It uses compressed
public-key encoding for secp256k1 and secp256r1 identities, the canonical
20-byte script hash for native witness identities, and the configured authority
commitment for non-key profiles. A verifier MUST return
the complete set of signer domains that can authorize the account, not only
the signer used by the current operation. A dynamic policy whose signer set
cannot be represented statically MUST return an empty array and is not an
eligible child of `MultiSigVerifier` in version 2.

Native ABI 2 normalizes every P-256 public-key authorizer to exactly one native
standard-account domain: `NativeScript(CreateStandardAccount(compressedPublicKey))`.
Its scheme tag is `0x03`, and its signer material is the standard account's
20-byte script hash in wire order. Session-key and native-witness verifiers
using the same private key therefore expose the same domain and cannot count
as two independent approvals. The legacy non-native `0x02` key domain remains
separate. This rule does not establish independent ownership of arbitrary scripts.

The native SessionKey profile retains the five-field `getSessionKey` record.
Its canonical signer domain is stored separately under policy prefix `0x05`
in the same authority-epoch namespace, as exactly 32 raw bytes. Configuring a
session MUST derive this value from the configured public key and write both
entries atomically; clearing the session MUST delete both entries. Signer-domain
discovery MUST freshly read this entry and reject a missing or malformed value,
without falling back to the older storage layout. This is deterministic
configuration data, not an approval receipt or cache; recovery isolates it by
advancing the authority epoch. Domain discovery and policy commitments are still
checked during validation and before and after composite post-execution.

Native session configuration accepts valid compressed 33-byte and uncompressed
65-byte secp256r1 public keys, decodes the curve point before use, and stores the
canonical compressed 33-byte representation. Invalid curve encodings MUST reject
the whole configuration transaction. Both encodings of the same point MUST
produce the same standard account and signer domain.

`canonicalP256PublicKey(publicKey: ByteArray) -> ByteArray` is a safe, pure native
method with required call flags `None` and a base CPU fee of `32768` units (before
the execution-fee factor). Its VM argument MUST be an exact ByteString; Buffer,
Integer, Boolean, Array and null are rejected. It requires no registered account.
The method MUST decode a valid 33-byte compressed point. For a 65-byte input,
it MUST decompress the supplied X coordinate and Y parity, then compare the full
uncompressed point encoding with the original bytes before returning an owned
33-byte compressed encoding. Checking length or parity alone is insufficient.
The native SessionKey module MUST invoke this helper before configuration writes
and explicitly declare its service-method permission in the manifest. The helper
has no storage writes, notifications, module grants or external callbacks.

Native session last-use time is stored separately under policy prefix `0x06`
in the same authority-epoch namespace, as an unsigned 64-bit value in canonical
NeoVM Integer byte encoding, initialized to zero atomically with session
configuration. Negative, overflowing or redundantly encoded values MUST reject.
Prefix `0x02` retains the three-field metadata record `[CreatedAt, 0, Description]`; the public metadata getter MUST
freshly read `0x06` and project the original `[CreatedAt, LastUsedAt, Description]`
shape. Post-execution updates `0x06` without rewriting the description. Missing or
malformed `0x06` values MUST fail closed without a legacy fallback. Session
revocation removes prefixes `0x01`, `0x02`, `0x03`, `0x05`, and `0x06` while
retaining the `0x04` rotation timestamp; account cleanup removes all six prefixes.

The native NeoNativeVerifier profile retains its two-field `getConfig` record.
It stores the configured signer domains, in signer order, as concatenated 32-byte
values under policy prefix `0x03` in the same authority-epoch namespace. `setConfig`
MUST derive and atomically replace this entry with the signer configuration;
account cleanup MUST delete it. Discovery MUST freshly read this entry and reject
missing, empty, misaligned or over-limit values without a legacy fallback. The
storage supports the existing maximum of ten configured witness signers; the
native composite still independently enforces at most three aggregate signer
domains. This stores deterministic identities, not witness or signature approvals.

For the native MultiSig profile, the policy commitment is exactly
`SHA256(NeoBinarySerialize([Integer threshold, Array orderedChildren, Array orderedChildSignerDomains]))`.
Each child identity is a 20-byte ByteString; each child-domain entry is an Array
of exact 32-byte ByteStrings in discovery order. Validation selects the first
`threshold` valid children in configured order, and passes only that selection
to post-execution. The root checks a fresh policy commitment before and after
the child post callbacks. It never replaces cryptographic validation with a
persistent approval cache.

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
MUST NOT be installed as a child of another composite. Version 2 composites
are the protocol-defined `MultiSigVerifier` and `MultiHook` profiles; arbitrary
recursive composition is not part of this profile.

When a composite is bound, `AccountManagement` MUST validate every child as a
deployed module with the exact lifecycle ABI above, require a `false`
`supportsComposition()` result, reject zero, duplicate, and self identities,
and enforce the fixed verifier composition limits and a maximum of 8 hook children.
Signer-domain discovery applies to verifier children only: each MUST return a
non-empty `getSignerDomains` result, with no duplicate commitments within or
across children. Hook children do not implement signer-domain discovery.
`MultiSigVerifier` MUST bind its configured policy and approved child selection
to the transient receipt. Its post callback MUST reject a policy commitment
that does not match the current configured policy. The
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
account configuration nonce changes. Every configuration-nonce transition in section 7 clears
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
verifiers or hooks in version 2.

The native service MUST call `validateSignature` or `validateCompositeSignature`
with `ReadOnly`, and MUST call the verifier's `postExecute` or
`postExecuteComposite`, every hook callback, and the target method with
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
registered leaf called directly by that root invocation. A composite verifier's
postExecute grant MUST additionally be limited to the receipt's approved children.
A grandchild,
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

Version 2 exposes the following Application methods:

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
`validateSignature`, `validateCompositeSignature`, `postExecuteComposite`,
`validateSignatureForPostExecute`, `preExecute`, `postExecute`, `clearAccount`,
`supportsComposition` and `getSignerDomains` MUST NOT appear in this list.
Metadata is part of the pinned code identity. It is a capability declaration,
not a proof that an arbitrary plugin confines its own writes to that account.

At confirmation the core rechecks maturity, all bound bytes, code identity,
blocking policy, ABI and authority before granting only the selected module's
`configuration` context. It passes `All` and the fixed maintenance budget.
Every failure rolls back the pending-call consumption, configuration nonce, registry,
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
`1` for hook; version, role, configurationNonce and timestamps MUST be exact Integers, not
Boolean or ByteString coercions. Timestamps and configurationNonce use UInt64 bounds and the
fixed module-change delay. `methodBytes` MUST be a strict UTF-8 ByteString;
`invokedArguments` MUST include the prepended accountId and satisfy the canonical
argument rules. Queries and confirmation MUST reject a malformed, stale-root or
stale-configuration-nonce record. Custody cancellation MAY delete a malformed intent without
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

Both rosters are bounded by the fixed verifier child limit or 8 hook leaves. Each identity is
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
Freeze preserves the installed roots and registry. Recovery revokes both roots
and deletes the registry without an external cleanup callback, as specified in
section 7; old module state remains unreachable through its prior authority epoch.

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

The native MultiSig module profile uses the core-owned transient receipt for
post-execution approval selection. The historical leaf
`validateSignatureForPostExecute` method, if retained for compatibility, is not
used by this composite path and MUST NOT be exposed as a configuration capability.
Ordinary `validateSignature` remains restricted to the validation grant. Receipt
handling creates no new authority phase. Descendant calls still share the root
callback's fixed budget. Module policy commitment rules are defined in
`SMARTACCOUNT-NATIVE-MULTISIG.md`.

Discovery and cleanup performed by a registry continuation inside a composite
maintenance callback inherit that callback's remaining budget and fixed flags;
they MUST NOT allocate another equal maintenance budget beneath it. Direct
maintenance roots still receive the full fixed callback cap, subject to the
transaction and ancestor admission checks in section 10.

Pending call records and dependency records do not alter the fourteen-field
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
9. call hook `postExecute`, then verifier `postExecuteComposite` for an admitted composite
   or verifier `postExecute` for a scalar;
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
validateSignature, validateCompositeSignature, or native-witness fallback
consume-nonce
hook.preExecute
target call
hook.postExecute
verifier.postExecute or verifier.postExecuteComposite(owned receipt)
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
UInt8(2) ||
UInt32LE(networkMagic) ||
coreHash.ToArray() ||
accountId.ToArray() ||
UInt64LE(authorityEpoch) ||
UInt64LE(configurationNonce) ||
canonicalOperationWithoutSignature
```

`canonicalOperationWithoutSignature` is the canonical six-field operation with
field five replaced by an empty `ByteString`. The digest is
`SHA256` of the complete byte sequence. The native core MUST expose this
domain and operation digest through read-only methods so that independent
verifier profiles do not reconstruct network or core identity from display
strings.

`getAuthorizationDomain(accountId)` reads the registered account and returns the
bytes through `configurationNonce` in that formula. It is a safe `ReadStates`
method. `getOperationDigest(accountId, op)` returns the single SHA-256 digest of
that domain followed by the canonical operation bytes. Unknown accounts fault.
A signature produced for either older counter value MUST NOT authorize the
current state. Identity derivation remains version 1; changing the authorization
domain MUST NOT change accountId, verification-script bytes or asset address.

### 9.3 Chain time and deadline boundaries

Time values are integer milliseconds from a deterministic chain context, never
from a wallet, relayer or node's wall clock. When an execution has a persisting
block, the account service uses that block's timestamp. Otherwise it uses the
timestamp of the header identified by `Ledger.CurrentHash` in the execution's
snapshot. A missing persisted header MUST fault; zero or local time is not a
fallback.

The standard Neo witness-verification path supplies no persisting block, so
Verification uses the snapshot's persisted header time. A verifier needing time
in that trigger MUST read the same persisted block/header; it MUST NOT assume
that the Application-only `Runtime.Time` service is available. Application
execution in a block uses that block's timestamp, including the explicitly
hypothetical block used by transaction preflight. An earlier Verification result
MUST NOT replace Application's deadline or module-policy checks.

An operation expires exactly when `now > deadline`; equality is accepted.
A module may impose a stricter, separately documented policy. Configuration
and recovery maturity use the same Application time: execution is allowed at
`now >= matureAt`, while custody cancellation of recovery requires
`now < executeAt`. The fixed delays are milliseconds, not block counts.

For example, an operation with deadline `1000` can pass Verification against a
persisted timestamp of `1000` and fail Application in a block timestamped `1001`.
The failed Application does not consume its nonce or commit target/module state;
ordinary transaction fees still apply if the transaction is included. A client
MUST NOT interpret successful Verification, or a hypothetical next-block replay,
as a reservation of nonce, timestamp or inclusion. It must inspect the actual
persisted Application result.

### 9.4 Target results in the current implementation

The `Any` return type of `executeUserOp` and the `result: Any` callback
parameter do not mean that every runtime object can be returned through this
profile. The current native implementation serializes the target result before
post-execution callbacks and deserializes an independent copy for each root
callback and for the caller. This also happens with no verifier or hook
installed. A target with a `Void` ABI produces Null; Boolean `false` remains an
ordinary result.

The existing result serializer accepts Null, Boolean, Integer, ByteString,
Buffer, Array, Struct and Map, preserving their VM types. It rejects
InteropInterface values, including iterators and storage contexts, and Pointer
values. It also rejects a repeated reference to the same Array, Struct or Map,
even when the graph has no cycle. Separate containers with equal contents are
permitted. Buffer is supported here although it is not a supported
UserOperation argument type.

Result snapshots use the executing engine's `MaxItemSize` as the maximum total
serialized byte length, including type tags and length prefixes, and
`MaxStackSize` as the maximum number of serialized values. A container counts
as one value; each Map key and value is counted separately. In the current
reference runtime, Neo.VM `3.10.2-CI00384`, these defaults are **131,070 bytes**
and **2,048 values**. These are existing VM limits used by the implementation,
not additional fixed profile parameters or a promise that a value at either
limit fits the surrounding execution and callback budgets. The argument
limits of 4096 bytes and depth 8 are not substituted for the result limits.

An unsupported result, repeated container reference or serialization-limit
failure faults the operation before its post-execution callbacks. The normal
application rollback applies to target writes, nonce changes and notifications;
transaction fees remain chargeable. The existing result-isolation tests cover
independent nested Array/Buffer copies and rejection of a cyclic Array or
InteropInterface result. These implementation details explain the current
return-value boundary; this clarification changes no ABI, parameter digest,
consensus rule or ordinary-contract implementation.

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
MUST fault and MUST leave the enclosing module configuration or cleanup
transition unchanged. Custody recovery does not invoke these callbacks. A maintenance budget is independent of the verifier and
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
fee charging but MUST NOT change the safety budget. ABI 2 has no native
paymaster or automatic reimbursement path. An external transaction fee payer
may pay ordinary Neo fees, but the registered account proxy MUST NOT be the
transaction sender. The payer signs the complete transaction and its fees;
UserOperation authorization does not authorize spending proxy GAS on arbitrary
transaction fees. This does not relax the exact operation envelope or target-frame
witness authority.

Application fee estimation MUST distinguish consumed gas from the minimum
transaction budget required to admit each fixed bounded callback. The latter
includes the peak of already consumed gas plus the next callback's fixed budget,
with the runtime's exact fee units and ceiling conversion. The RPC simulation
result MUST expose this value as `minimumrequiredfee`; clients MUST use at least
`max(gasconsumed, minimumrequiredfee)` and apply explicit system/network/total
fee caps before signing. A missing required field is not evidence that
consumed-only estimation is safe. Generic proxy witness estimation must account
for the exact verification-script bytes, witness layout, consumed verification
cost and bounded-callback admission requirement within MaxVerificationGas.
This value is a lower bound for the observed simulation trace, not all possible
traces of a module. Fee fields, GasLeft and chain-state changes may alter behavior;
clients must replay the final signed transaction with its exact final fee fields.
Simulation does not guarantee admission after state changes or final signed
witness verification, and an admitted transaction that faults still charges its
external payer under ordinary Neo rules.

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

ABI 2 defines no legacy import entrypoint, import registry, migration event,
or native address alias. Registering an account does not record a legacy
identity or authorize movement of legacy assets. The native address differs
from the legacy address; assets remain at the legacy address until an explicitly
authorized transfer occurs.

An optional migration adapter is a separately specified extension outside this
profile. It may compose the existing registration call with explicitly authorized
transfers, but MUST NOT claim native import status. If such an extension publishes
an import mapping, its own specification MUST define the registry and event,
require both the legacy account and new custody witnesses, bind the legacy core,
account identifier and asset address, reject duplicate imports, and preserve the
one-way immutable mapping to the newly derived native account identifier. Those
requirements do not add an ABI 2 service method or establish implemented adapter
behavior. The existing legacy witness rules may constrain which composition is
possible; an adapter requires separate implementation and conformance evidence.

ABI 1 to ABI 2 is a breaking revision of an unactivated draft, not an automatic
upgrade of deployed state. Initial activation under this document starts with
ABI 2. Identity derivation version 1 preserves the formula; it does not make old
account records, module ABIs or execution envelopes compatible. The native core
MUST reject an ABI 1 thirteen-field record, an ABI 1 module and a former
two-argument execution call. It MUST NOT silently append an epoch, infer an
initial counter, or import an older state namespace.

This profile supplies no legacy native-state conversion routine. A network
already containing a prior experimental native state cannot use this draft as
its migration program: it needs the separately specified activation, deterministic
state conversion and cross-client vectors required by section 11. No reverse
mapping, transparent script replacement or implicit transfer of assets is
provided by ABI 2.

## 13. Required ABI surface

The version-2 ABI MUST contain the following methods and events. The exact Neo
ABI parameter types are normative.

### Read-only methods

```text
getPendingModuleCall(accountId: Hash160, moduleType: String) -> Any
getModuleDependencies(accountId: Hash160, moduleType: String) -> Array
getVersion() -> Integer
getAccount(accountId: Hash160) -> Any
getAccountAddress(accountId: Hash160) -> Hash160
getNonce(accountId: Hash160, channel: Integer) -> Integer
getAuthorityEpoch(accountId: Hash160) -> Integer
canonicalP256PublicKey(publicKey: ByteArray) -> ByteArray
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
executeUserOp(accountId: Hash160, op: Array, expectedAuthorityEpoch: Integer, expectedConfigurationNonce: Integer) -> Any
executeUserOps(accountId: Hash160, ops: Array, expectedAuthorityEpoch: Integer, expectedConfigurationNonce: Integer) -> Array
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
                 configurationNonce, authorityEpoch)
AccountFrozen(accountId)
AccountUnfrozen(accountId)
UserOpExecuted(accountId, targetContract, method, nonce)
```

The event field order and types MUST be published in the native manifest and
must remain stable for ABI version 2.

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
| `RecoveryExecuted` | `Hash160, Hash160, Hash160, Integer, Integer` |
| `AccountFrozen` | `Hash160` |
| `AccountUnfrozen` | `Hash160` |
| `UserOpExecuted` | `Hash160, Hash160, String, Integer` |

Unknown-account queries for `getAccountAddress`, `getNonce`, and
`getOperationDigest`, `getAuthorizationDomain`, and `getAuthorityEpoch` MUST fault.
`getVersion` and `canonicalP256PublicKey` require no account record after activation. Every malformed
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
- rejection of ABI 1 records, modules and execution envelopes; no implicit legacy import or asset custody.

A separately specified migration adapter MUST additionally publish and pass its
own witness, duplicate-import, mapping/event and asset-transfer vectors. Those
extension-specific cases are not claims about the current native ABI.

## 15. Review and activation gates

A protocol-review candidate MUST include the complete normative state model,
canonical identity/authorization/nonce/witness vectors, resource and failure
semantics, authority/governance/recovery rules, and explicit compatibility with
#218 and the foundation in #243. The implementation and tests offered for review
MUST identify their exact source and artifact inputs and disclose every pending
conformance or rollout requirement. Draft PRs and private-chain evidence may be
reviewed before network activation is approved; they do not imply that approval.

Public activation additionally requires all of the following:

1. the activation identifier and explicit network configuration are accepted
   through the network's protocol-governance process;
2. the bounded-call engine capability is implemented and independently tested;
3. the native ABI and storage encoding match this document byte-for-byte;
4. the vectors are checked by at least two independent clients;
5. NeoExpress verifies activation, execution, rollback and readback parity,
   plus every migration path applicable to that network's actual prior state;
6. the source, native manifest/artifact identity and deployed readback hashes
   match;
7. a security audit has no unmitigated critical or high findings.

A fresh activation with no legacy native state MUST prove rejection of obsolete
records and entrypoints and absence of implicit import. It MUST NOT substitute
that proof for migration testing on a network that does have prior state. Any
optional adapter needs its own reviewed specification and evidence before use.

Until these public-activation gates pass, this document remains a design profile
and MUST NOT be presented as an activated Neo native SmartAccount service.
