# Native account transaction guards

The native SDK binds a configuration-intent cancellation to the complete pending intent record
reviewed by the signer. The signed Application script reads that record again at execution,
compares its canonical bytes with the reviewed ones, and only then calls the native cancellation
method. This closes the interval between client revalidation and transaction inclusion, without
changing the native ABI or the account counters.

## Complete cancellation script

The script executes these instructions in this order, with no additional calls between the
comparison and the cancellation:

```text
PUSH intentId
PUSH accountIdBytes
PUSH 2; PACK
PUSH ReadOnly
PUSH "getPendingConfiguration"
PUSH SmartAccountHashBytes
SYSCALL System.Contract.Call

PUSH 1; PACK
PUSH None
PUSH "serialize"
PUSH StdLibHashBytes
SYSCALL System.Contract.Call
PUSH reviewedIntentBytes
EQUAL
ASSERT

PUSH intentId
PUSH accountIdBytes
PUSH 2; PACK
PUSH All
PUSH "cancelConfiguration"
PUSH SmartAccountHashBytes
SYSCALL System.Contract.Call
```

`ReadOnly`, `None`, and `All` are call flags `5`, `0`, and `15`. `intentId` is the id
`proposeConfiguration` returned in its `ConfigurationIntentProposed` notification; the account
derives ids from a monotonic counter, so an id is never reused. Both contract hashes and
`accountIdBytes` use VM wire byte order. The first call is a read, serialization is pure
computation, and cancellation re-checks the intent's own authorization. There is no external
module callback in this sequence, and no other transaction can execute between these instructions.

## Canonical bytes

`reviewedIntentBytes` is the exact Neo binary serialization of the record the caller reviewed:

```text
[true, intentId, proposedAt, matureAt, expiresAt, authorityEpoch, actionDigest, actions]
```

The outer value and `actions` are Arrays and each action is itself an Array of the form
`[code, operand…]`. Array and Struct arguments stay distinct; ByteStrings keep their bytes;
Integers keep exact values; Null and Boolean keep their VM types. The SDK uses the canonical VM
serializer, never JSON, display-order hashes or reconstructed action operands. This guard compares
bytes directly and defines no new digest or hash domain.

A missing intent serializes as an empty Array and fails the comparison. Any changed field — the
action digest, the operands, the maturity, the authority epoch — fails `ASSERT` before the
cancellation. A malformed native record faults before deletion. A match still has to satisfy the
native cancellation authorization: a live intent needs the custody witness on an active account,
and an intent past `expiresAt` is dropped by anyone without a witness. The guard grants no
additional authority. Faulting transactions do not commit application writes.

## Submission and compatibility

Cancellation plans keep `intentId` and the reviewed record, and add `reviewedIntentBytes` and
`requiresExactScript: true`. Preparation, simulation, signing, export and import must preserve the
entire `plan.script`. A wallet method-and-arguments request cannot express the comparison, so such
plans must use the exact-script SDK route; the interface must not fall back to an unguarded
`wallet.invoke` request.

`cancelConfiguration(accountId, intentId)` remains available to applications that deliberately
authorize cancellation of whatever the intent currently carries. The guard is a guarantee of the
guarded SDK transaction, not a new invariant on every native caller. Native methods, the profile
digest, the record format, identity, the authorization domain and the configuration-counter
semantics are unchanged, and an older client does not gain this guard automatically.

The extra read, serialization, comparison and embedded bytes increase script size and fees.
Existing simulation and transaction fee ceilings apply to the complete script; a client must not
reuse an estimate for the old single-call form.

## Content identity and regression coverage

This is exact-content binding over a record that already carries a unique id. A cancelled intent
that is proposed again with identical actions gets a new `intentId` from the monotonic counter, so
the old guard no longer matches; identical re-proposal inside one block cannot replay it.

Regression coverage must execute actual SDK script bytes against the native engine: a matching
cancellation succeeds; a replaced or missing intent faults; a changed operand or action digest
faults; an expired intent is cleaned without the witness; a live intent without custody faults. A
script with the comparison removed demonstrates why the two-argument native call alone cannot bind
content. Tests also cover canonical VM type distinctions, unchanged account records during
replacement, the identical-id boundary, and preservation of the complete script through
transaction signing.
