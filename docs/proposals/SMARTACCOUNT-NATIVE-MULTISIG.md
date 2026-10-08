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

The root exposes exact `Array` operations for `validateSignature(accountId, op)`
and `postExecute(accountId, op, result)`. Its sole configuration capability is
`setConfig(accountId, children, threshold)`. The ordered child list is nonempty,
unique, nonzero, excludes the root and contains at most ten leaf verifiers.
The threshold is between one and the list length. Child lifecycle ABIs and
public signer-domain commitments must be valid before publishing dependencies.
Public domain uniqueness does not establish private-key/operator independence.

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

## Phase-specific revalidation

The existing `validateSignature` entry remains restricted to a `validation`
grant. Calling it under a `postExecute` grant must continue to reject.
An admitted native leaf additionally exposes the read-only Boolean method
`validateSignatureForPostExecute(Hash160, Array)`. This method requires the
account/role/module/frame-specific `postExecute` grant and applies the same
signature and policy predicate, without debiting state. The root uses it only
during its own post-execution callback, with ReadOnly call flags.

The root rechecks every supplied child, requires threshold approval, and calls
`postExecute` only on approving children, in configuration order. A catchable
child exception is a rejection; fatal faults and shared callback-budget
exhaustion are not converted into votes. If post-execution approval falls below
threshold, or any selected post callback fails, the whole operation must roll
back. The verifier's existing native gas budget includes all descendants; it
is never reset or increased per child. Successful small rosters do not prove
cost sufficiency at maximum roster size.

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

The formal gate must distinguish the validation entry from post revalidation,
reject mismatched phases and missing account/frame grants, preserve the same
policy predicate across both authorized entries, and exclude non-Boolean replies
from threshold support. A post callback plan must contain exactly the approving
children in configuration order. These are abstract obligations; the actual
native engine grant, compiled dispatch and child policy predicates still need
runtime correspondence and are not established by source hashes.

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
