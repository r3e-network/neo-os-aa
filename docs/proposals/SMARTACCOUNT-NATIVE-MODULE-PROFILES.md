# Native SmartAccount module profiles

## Compatibility boundary

The deployed-contract profile and the native AccountManagement profile are
distinct build targets. Existing verifier artifacts advertise an `Any` callback
argument and use `canConfigureVerifier` / `canExecuteVerifier`; native admission
requires exact `Array` arguments and authenticated `hasModuleContext` phases.
Existing hook authority queries also target the deployed-contract profile.
Passing legacy deployment tests does not establish native compatibility.

Native builds MUST NOT relax the service ABI, emulate a custody witness, use a
hash-only caller shortcut, or fall back to legacy authorization. The native
service identity is fixed by the native profile. Configuration, cleanup,
validation, preExecute and postExecute each require their own exact account,
module role and invocation-phase grant. Independent module administration never
substitutes for this account-scoped grant.

## Initial profiles

The native build reuses the existing NeoNativeVerifier signer/threshold policy
and WhitelistHook storage/allowlist policy. `SMARTACCOUNT_NATIVE` selects only
native authority and exact callback signatures; the ordinary build keeps its
existing ABI and authority behavior. Both profiles retain their full lifecycle,
signer-domain discovery where applicable, timelocked module administration and
account cleanup. They are not test-only accepting verifiers.

- NeoNativeVerifier: exactly typed Array operations, actual transaction witness
  threshold, distinct nonzero signer identities, and native validation/postExecute
  grants. Configuration capability: `setConfig`.
- WhitelistHook: native preExecute/postExecute grants, default-deny target lookup,
  and account-scoped cleanup. Configuration capability: `setWhitelist`.

The configured transaction witnesses authorize the native verifier. They are not
a custom operation-signature format. The SessionKey profile below adds a distinct
operation-signature adapter; arbitrary proof/attestation plugins remain separate
work.

The current descriptor also includes SessionKeyVerifier, DailyLimitHook,
TokenRestrictedHook and MultiSigVerifier. The first three profile requirements
are defined below; the composite profile and its separate post-revalidation
entry are defined in `docs/proposals/SMARTACCOUNT-NATIVE-MULTISIG.md`.

## Artifact construction and security

Compiler output is not hand-edited to hide an ABI mismatch. Native projects use
source-level Array callback declarations. The current compiler only supports
string-valued manifest extras, so the native packaging stage adds the structured
`extra.smartAccount.configurationMethods` value from a checked-in profile
descriptor. It must reject missing, duplicate, safe, reserved or incorrectly
account-scoped ABI methods. Both original compiler bytes and packaged manifest
bytes, the descriptor, linked source files, compiler identity and packaging
recipe must be hashed. The deployed code identity uses the packaged manifest.
No opaque NEF rewriting is permitted. A fresh replay must reproduce every native
artifact byte; ordinary-profile artifacts remain separately checked.

The descriptor must be a nonempty object with simple artifact and project names,
an explicit role and a nonempty array of unique configuration names. Inputs must
remain inside the contract tree; symbolic links and aliasing an existing output
are rejected. A failed build or package operation must leave a failure receipt,
never a success inherited from an earlier invocation. Empty descriptors and
malformed capability types must fail before compilation.

The installed compiler does not propagate the project `DefineConstants` value
to its contract parser. The native recipe therefore copies only explicitly
linked sources into a disposable project and prefixes each with the standard C#
`#define SMARTACCOUNT_NATIVE` directive. Original sources are never rewritten.
Both original and prepared source hashes are recorded. The native marker and
exact Array ABI are checked after compilation, so silently compiling the legacy
branch is an error, not an accepted native artifact.

## Required validation

First reproduce rejection of the existing verifier ABI on the native service.
Then deploy the actual native artifacts on a disposable NeoExpress chain and
read their NEF and packaged manifests back. Test registration, delayed account
configuration, actual threshold signatures, missing/wrong witnesses, allowlist
rejection, direct configuration and phase-confusion rejection, cross-account
isolation, cleanup on replacement, nonce preservation on FAULT and event/state
readback. Include positive controls after rejection. Do not reuse wallet keys,
chains or remote endpoints; receipts contain no private keys or host paths.

New native artifacts are not upgrades of deployed legacy contracts. Migration
requires explicit redeployment and native account binding, not an assumed ABI
or storage upgrade. No public deployment is part of this work. Native module
gas is bounded by the protocol; successful examples are not a complete cost
profile, arbitrary-plugin proof or compiler refinement.

## Formal correspondence boundary

`NativeInvocation.v` models the exact service-identity check and the required
authenticated invocation grant as a conjunction. Wrong configured service or
missing grant rejects; the matching service with a grant remains reachable.
The existing frame, phase, role and account theorems apply to the abstract grant
predicate. The shared authority sources and all six selected module sources are pinned by
the formal gate after review. Pins detect source drift; they do not prove C#
preprocessing, compiler correctness, native callback refinement or cryptography.

## Session-key native profile

SessionKeyVerifier uses the same six-field Array ABI and exact native validation,
postExecute, configuration and cleanup grants. The legacy direct custody-witness
configuration shortcut is not a native authorization path. The declared native
configuration capabilities are `setSessionKey` and `clearSessionKey`.

The P-256 signing input is the native authorization-domain byte sequence followed
by `StdLib.Serialize` of the canonical operation with an empty signature field.
`getPayload` returns this preimage, not its digest. Its single SHA-256 hash must
equal `AccountManagement.getOperationDigest`; CryptoLib's secp256r1SHA256 verifier
hashes the preimage exactly once. Feeding the already-hashed digest to an API that
hashes internally is not this profile. Signatures are fixed-width 64-byte `r || s`;
JSON encoding, legacy verifier-specific payloads and DER signatures are rejected.

Session expiry uses the persisting block timestamp in Application and the latest
persisted ledger block timestamp in Verification, matching the native service.
`System.Runtime.GetTime` is not available in an actual witness Verification
engine without a persisting block. A direct use there rejects otherwise valid
proxy witnesses. The time source is selected by the trigger, never by the caller.

Native capped sessions are restricted to the exact NEP-17 transfer shape: four
arguments, the account's asset address as source, a nonzero Hash160 recipient,
and a nonnegative exact Integer amount. Validation checks the cumulative cap;
postExecute requires an exact Boolean true result before debiting it. A false
business result faults the operation and preserves nonce, spending state and
asset balances. The target must itself implement the declared token semantics;
an arbitrary dishonest contract's external effects cannot be inferred from its
method name. Uncapped or wildcard sessions remain explicitly uncapped.

Cleanup removes key, metadata, spending and rotation state under the cleanup
grant. Ordinary revocation retains the rotation cooldown; replacing an active
key does not reset accumulated spending. Core configuration delay still applies.
If a replacement lowers the positive cap below accumulated spending, every
capped operation must reject, including a zero-amount transfer. A zero amount is
admissible at the exact cap, but never bypasses an already-exceeded cap. Ordinary
revocation clears accumulated spending as an explicit custody-authorized policy
reset; a subsequent delayed grant begins a new allowance. Rotation without
revocation is not such a reset. Operations do not bind a configuration epoch, so
restoring an earlier key can restore an unconsumed, unexpired signature's
validity; this profile does not promise permanent invalidation on key reuse.
Immediate containment requires a configured recovery authority and native freeze;
there is no hidden direct-custody revocation bypass. Frozen accounts cannot use
generic configuration. The delay and recovery dependency are operational limits,
not a claim of immediate session revocation.

The validation matrix must use actual generated P-256 keys, a separate transaction
payer and real native GAS transfers through the account proxy. It must compare
the independently serialized signing input and digest with both native queries,
reject wrong account/network/core, tampered arguments, wrong signatures, expired
keys and excess spending, and read back persisted rollback and cleanup. The
cryptographic primitive and complete compiler refinement remain separate proofs.
Witness admission is a separate gate from persisted Application execution:
wrong-signature and expired-session proxy witnesses must be rejected by
`sendrawtransaction`, with both accounts' observed storage, nonce and balances
unchanged. An admission rejection must never be counted as a persisted FAULT.
The same canonical proxy script must also admit a valid signed transfer.
The lifecycle matrix additionally replaces a used key, verifies preserved spend
and rejection of the previous key, spends exactly the remaining allowance,
lowers the cap below spent, restores it to the exact boundary, revokes the key,
and grants a fresh allowance after the protocol delay. It compares all four raw
storage prefixes, including retention of the ordinary revocation cooldown and
its removal by account cleanup.

`NativeSessionPolicy.v` models the capped-session conjunction of context,
signature acceptance, target/method scope, expiry and exact transfer shape. It
proves debit bounds, rejection of each missing condition, exact successful debit
and unchanged spending on a failed target or rejected operation. The Booleans
are abstract facts supplied by the runtime, not proofs of P-256 or parsing. Its
positive control and condition-removal mutations must pass the formal gate.
The clock abstraction separately proves that witness validation selects the
persisted timestamp (or fails closed if it is unavailable), while Application
selects the persisting timestamp. This selection proof does not establish that
the ledger syscall or trigger implementation refines the model.
The lifecycle abstraction additionally distinguishes key replacement (preserved
spending, refreshed rotation timestamp), ordinary revocation (cleared key and
spending, retained timestamp), and account cleanup (no retained timestamp).
Cooldown rejection and the zero-amount cap boundary require separate proofs
and mutation controls. The native service's delayed configuration remains an
additional gate, not a replacement for the module's cooldown rule.

### Uncapped scope and key reuse

A zero spending limit disables the session's transfer-specific shape, Boolean
success and cumulative-debit checks. It does not disable target identity,
method scope, signature, expiry, account status or nonce checks. A wildcard
method permits different methods on the one configured target; it is not a
wildcard target. A positive limit is invalid unless the configured method is
exactly `transfer`. The grant event must expose the exact scope and its uncapped
flag so operators do not mistake zero for a zero allowance.

For an admitted uncapped operation, a target that HALTs with Boolean false is
still a completed operation: nonce and last-use metadata advance, while session
spending does not. A target FAULT rolls back the operation. Read methods and
value-moving methods must both be exercised under an explicit wildcard grant,
with separate wrong-target and exact-method negative controls. The private
matrix must include an actual whole-balance GAS transfer to demonstrate the
exposure, not infer it from the event alone.

Key reuse is an authorization boundary, not an independence guarantee. The
current canonical payload contains no configuration epoch. A still-live,
unconsumed signature must reject while its key is replaced or revoked, but may
become valid again when that exact key is explicitly granted again. The private
matrix must retain and submit the identical signature bytes across both kinds
of transition, without re-signing the positive control. A consumed operation
must remain rejected by nonce even after regrant. Operators requiring permanent
invalidation must not reuse a retired key; this profile does not implement an
epoch-bearing signature domain. Adding one would require an explicit protocol
and compatibility revision, not a silent verifier-only change.

`NativeSessionScope.v` must distinguish the zero-cap path from capped policy,
prove that wildcard methods retain target binding, and expose the key-reuse
counterexample. Its key identifiers, signature validity, VM completion and
nonce/expiry predicates are abstract inputs. These declarations are not a
cryptographic independence or C#-to-NEF refinement proof. The private runner
compares exact raw key, metadata, spending and rotation storage and all grant
event fields, and retains full source/artifact provenance. No production
contract or public-network deployment is required for these tests.

## Daily-limit native hook profile

DailyLimitHook admits `setDailyLimit` as its sole account configuration
capability. Pre-execution, post-execution and cleanup require distinct native
hook grants. Balances belong to `getAccountAddress(accountId)`, not the account
identifier. Native transfer prechecks require the exact four-argument shape,
the registered asset address as source, and a positive exact Integer amount.

The authoritative meter is the observed net outflow of every configured token,
even when the target returns Boolean false. A false return does not prove that
the target made no writes. Each balance must be an exact nonnegative Integer;
missing snapshots and failed queries reject. Completed operations remove all
snapshots; FAULT rolls back nonce, token writes, accounting and snapshots.
This is net-outflow accounting, not a claim to measure gross intermediate
movement or the honesty of an arbitrary token's balanceOf implementation.

Fixed windows begin at the first recorded outflow and last 86,400,000 ms.
Subsequent outflows do not move that anchor. At the boundary the next outflow
starts a new window. Rolling windows retain records whose timestamp is greater
than or equal to now minus that duration; the lower endpoint is inclusive.
The existing fifty-live-record ceiling fails closed rather than dropping live
spending. Removing a token limit clears its configuration, fixed counters,
history and balance snapshot. Account cleanup clears all six policy prefixes.
Changing a limit remains subject to the native configuration delay.

Private validation must use real native GAS balances and signed proxy witnesses,
including false returns, precheck failure, same-window transfers, fixed-window
reset, rolling accumulation/expiry, direct phase rejection, cross-account
isolation and full storage-prefix enumeration after cleanup. Successful examples
do not prove an arbitrary configured token set fits the callback gas budget.

### Adversarial outflow and saturation validation

The diagnostic token used for private validation is deliberately not a conforming
NEP-17 implementation: `moveThenFalse` changes its own balances after an exact
source witness check and then returns Boolean false. A configured daily policy
must charge that observed outflow, reject an excess in postExecute, and roll back
both balances, the nonce and policy storage on rejection. This fixture is never
a production module or a substitute for real GAS transfer tests. Its two clean
builds and deployed NEF/manifest must be compared byte-for-byte.

Native authorization belongs to the exact active target frame, not arbitrary
descendants. A diagnostic target forwarding a GAS transfer therefore must not
inherit the proxy witness, even if transaction WitnessRules allow that caller.
The private test must assert this rejection without widening native authority
to make the example work. A target's own metered balances and nested native GAS
authorization are separate claims.

Rolling-window capacity must be exercised with fifty live records for one
configured GAS token under the unchanged 2.5 GAS per-hook callback budget. The
fifty-first positive outflow must fail with the policy's history-capacity error,
not an earlier gas exhaustion. After expiry a new outflow must succeed and prune
all expired records. Record identifiers remain monotonically increasing; no
live record may be discarded or overwritten to pass the budget test. Receipts
must distinguish consumed gas from the transaction's fee allowance.

A single-pass rolling-history scan must compute exactly the sum and count of
records retained by the inclusive time predicate. Removing expired records
must preserve both results and every live record. Abstract scan equivalence
and append-capacity proofs are separate from measured NeoVM callback costs;
neither proves arbitrary token-query cost or compiler correspondence.

### Invalid balance observations

The native meter accepts only an exact nonnegative VM Integer from each token
query. Negative integers, ByteString, Boolean, Null and Array results are not
coerced to balances. Query faults and exhaustion of the inherited callback
budget abort the operation. A target that changes balances and then changes
its query behavior must not commit those writes if the post-execution query
fails. The tests must compare raw token storage, not trust the same hostile
balanceOf result as their oracle.

The private diagnostic fixture may select these behaviors for a single asset
address, under its deployment payer's witness. This is test administration,
not SmartAccount configuration authority. Tests exercise each behavior in both
pre-execution and post-execution, require unchanged account/recipient storage,
nonce and policy state after FAULT, and include successful controls. Delayed
removal of a gas-burning token's limit must remain possible without querying
that token, followed by a successful GAS operation. This does not guarantee
token honesty or immediate recovery from an arbitrarily configured policy.

## Restricted-token native hook profile

TokenRestrictedHook admits only `setRestrictedToken` as an account configuration
capability. Configuration, pre-execution, post-execution and cleanup require
their distinct native grants and the fixed native service identity. Its asset
address is the registered proxy, not the account identifier. Nonzero valid
Hash160 token identities are required; removal does not call the token.

Every configured token is observed before and after execution. Direct calls to
a restricted token are forbidden, including read methods. An indirect target
is allowed only if no restricted token's observed balance decreases, regardless
of whether that target returns true, false or another value. Inflows and zero
net movement are not outflows. This policy does not measure gross intermediate
movement or establish the honesty of an arbitrary token's `balanceOf`.

Balance replies must be exact nonnegative VM Integers. Missing snapshots,
invalid replies, query faults and query-budget exhaustion abort the operation.
A successful post-execution check deletes every snapshot; FAULT rolls back the
target's writes, nonce and snapshots. Removing a restriction deletes that token's
configuration and snapshot. Account cleanup deletes both account-scoped prefixes.
The existing per-hook callback budgets are not raised. Arbitrary token-set costs
are not assumed to fit them; removing a faulting token remains a delayed custody
operation that does not query the token.

Private validation must exercise direct denial, indirect outflow with both true
and false results, zero-net and inflow controls, invalid queries in both phases,
real GAS transfers, delayed removal and full cleanup. A test-only token may
permit an explicitly configured router to move its own balances without a proxy
witness, modeling a pre-existing token-side delegation. This is not inherited
native witness authority or a production NEP-17 implementation. The runtime
oracle must compare raw token storage instead of trusting its hostile query.
Both diagnostic contracts and the hook require independent builds and complete
deployed NEF/manifest readback. The legacy hook profile remains a separate build;
native-only guards must not silently change its artifacts.
