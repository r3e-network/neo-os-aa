# Native composite verifier profile

## Purpose and compatibility

Adapt the heterogeneous MultiSigVerifier policy to the native AccountManagement
service without weakening callback phase isolation. This is a module profile,
not a change to native consensus activation, callback budgets or operation bytes.
Legacy artifacts remain separate. Native compatibility requires a fresh module
deployment and binding; it is not an in-place legacy upgrade. The current native
profile requires ABI 2 and the tagged authority-generation storage namespace
specified in `SMARTACCOUNT-NATIVE-MODULE-PROFILES.md`. Restoring the same module
or child keys after recovery does not restore old policy state or signatures.

## Interfaces and state

The native manifest explicitly declares `compositeVerifier: true` and the exact
profile parameter digest. Admission requires the non-safe callbacks
`validateCompositeSignature(Hash160, Array) -> Array` and
`postExecuteComposite(Hash160, Array, Any, Array) -> Void`. Ordinary leaf
verifiers retain Boolean validation and three-argument post execution.

The sole root configuration capability is `setConfig(accountId, children,
threshold)`. The candidate bounded profile admits one to three ordered, unique,
nonzero leaf verifiers, excluding the root; threshold is one or two and cannot
exceed the roster length. The aggregate contains at most three distinct
32-byte signer domains. Root and child reconfiguration must recheck these
bounds atomically. Actual VM worst-case measurements remain a release gate;
a declaration or a small successful operation does not establish support.

Domain commitment is `SHA256(StdLib.Serialize([threshold, orderedChildren,
perChildDomainArrays]))`. Each child boundary and child order are retained.
Replies must be exact Arrays containing immutable 32-byte ByteStrings. A Struct,
Buffer, duplicate domain, empty set or over-limit set is rejected. The root owns
copies of returned domain bytes before invoking the next child.

Native P-256 Session identity is the domain of its canonical Neo standard-account
script hash, shared with NeoNativeVerifier. Reusing one P-256 key across two
Sessions or a Session and its standard-account witness cannot supply two votes.
All future native P-256 profiles must use this canonical identity. Arbitrary
script or multisig ownership cannot be inferred from an opaque script hash;
public domains do not prove private-key/operator independence. Legacy public
profiles are a separate policy and migration boundary.

The signature field is the canonical Neo binary serialization of an exact Array
with one element per configured child. Each element is Null (skip that child)
or a ByteString in that child's signature format. A native-witness child uses
an empty ByteString to participate; it still requires its real transaction
witnesses. Children receive the original six operation fields with only the
signature element replaced. They retain the native account authorization domain.

For example, a two-child bundle `[ByteString(signature), ByteString(empty)]`
requests both a signature verifier and a native-witness verifier; `[Null,
ByteString(empty)]` requests only the second. A two-of-two policy rejects the
latter even when its one supplied witness is valid.

## Ephemeral approval receipt and post policy

Validation checks every signature slot's type before considering a quorum. It
visits children in configured order, skipping Null slots, and stops after the
first `threshold` exact Boolean approvals. It returns the exact Array
`[true, orderedApprovedChildren, policyCommitment32]`. The native service strictly
checks the shape and ordered subset, deep copies it, and retains it only for
this one operation. It is never persisted, accepted from the transaction, or
shared across Verification and Application. Batch operations each create a
fresh receipt. No transaction-supplied receipt can create a module grant.

The post callback receives the original operation/result and a fresh copy of
that private receipt. It first reloads configuration and all child domains and
compares their commitment. Only the approved children receive post grants and
callbacks, in configured order. Later supplied valid signatures are not part of
the selected quorum and do not consume Session allowances. The root reloads the
configuration and domains again after all child callbacks; a changed commitment
faults the operation. The native service additionally checks current code pins.

Post execution skips only duplicate cryptographic operation-signature work.
Each Session freshly checks that its key is active, unexpired and permits the
exact target/method, then applies result/source/amount and cumulative cap rules.
Each NeoNative child freshly rechecks its transaction-witness quorum, since its
signer domains alone do not commit its internal threshold. Account, frame,
phase and current authority-generation checks remain mandatory.

A cryptographically invalid, well-shaped signature which returns Boolean false
can be skipped in favor of later children. A catchable child exception is also
a rejection. A fatal VM ASSERT/ABORT or inherited budget exhaustion is not a
recoverable vote; callers must use Null to omit an expired or inapplicable child.
Malformed unused slots still reject. Every rejection discards nonce, target and
policy writes. Each root callback and all descendants share the unchanged 1 GAS
budget; transaction fee allowance does not increase it. Witness verification
also remains subject to the global 1.5 GAS limit.

## Dependency ownership and cleanup

Custody configures leaves through delayed `callVerifierChild` operations before
the root activates the roster with delayed `callVerifier`. The native service
owns enrolled/active dependency records, code identities and cleanup ordering.
Root `clearAccount` requires a cleanup grant, checks the native dependency-clear
operation and removes root configuration. It must not impersonate a leaf's
cleanup or configuration grant. Removing/replacing a root must clean enrolled
leaves, including configured but inactive leaves, and preserve other accounts.
This ordinary configuration cleanup is distinct from custody recovery. ABI 2
recovery advances authorityEpoch and configurationNonce, clears root/dependency
bindings and pending intents without external callbacks, and retains frozen
state and target nonces. Old module state becomes unreachable; recovery does
not require a deleted, changed or faulting child to cooperate.

## Required evidence

Build original compiler output twice, package capabilities without rewriting
NEF, then read all deployed bytes back on disposable NeoExpress chains. Test
actual distinct native witnesses and P-256 signatures, both phases, missing or
wrong witnesses, canonical bundle parsing, duplicate domains, delayed child/root
configuration, post-policy failure, nonce/asset/storage rollback and cleanup.
Run existing five-profile regressions on the new artifact set. Host-only
synthetic or unsigned invocations must be identified separately from persisted
transactions. No TestNet/MainNet operation is part of this validation.

These checks do not prove primitive cryptography, arbitrary future-plugin
behavior, complete NeoVM semantics or compiler refinement. The native profile
is not considered validated merely because source checks or compilation pass.

## Abstract phase obligations

The formal gate must distinguish validation and post grants, reject wrong
account/module/frame/phase combinations, model a fresh operation-local receipt,
and reject malformed or unordered approved subsets. Only exact Boolean child
approvals contribute to the first quorum. Pre/post commitments preserve the
ordered per-child policy boundary. These are abstract obligations; actual
native grants, compiled dispatch, cryptography and child policies require
independent runtime correspondence.

## Operation argument isolation

Every child invocation must receive an independent deep materialization of the
same original operation arguments. `ReadOnly` call flags constrain persistent
effects; they do not establish ownership of VM Arrays or their nested values.
A child must not change the arguments seen by a later validation, revalidation
or post-execution callback. A snapshot must be captured before the first child
call, not recreated from a possibly mutated object between children. Only each
child's signature may differ. Deserialization failure is fail-closed.

Regression tests must use a diagnostic mutating child followed by an honest
signature verifier, including nested argument values and positive controls.
The same argument/result isolation invariant applies to the ordinary composite
profile. ABI 2 separately changes the native signing domain and storage namespace;
copy isolation must not introduce further operation or budget changes.
Serialization and per-child reconstruction consume the existing callback budget;
their cost must be measured on private-chain executions before validation is
claimed. Every child post callback must also receive an independent deep snapshot
of the original target result, including nested collections; snapshots must be
captured before any callback can mutate them. Unsupported result types fail
closed. This separate result-isolation obligation requires an actual mutating
child regression and is not established by an argument-copy test.
