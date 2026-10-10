# Native account transaction guards

The native SDK binds a module-policy cancellation to the complete pending call
reviewed by the signer. The signed Application script checks that record again
at execution, then calls the existing native cancellation method. This closes
the interval between client revalidation and transaction inclusion for changes
to the reviewed content, without changing the native ABI or account counters.

## Complete cancellation script

The script executes these instructions in this order, with no additional calls
between the comparison and cancellation:

```text
PUSH moduleType
PUSH accountIdBytes
PUSH 2; PACK
PUSH ReadOnly
PUSH "getPendingModuleCall"
PUSH AccountManagementHashBytes
SYSCALL System.Contract.Call

PUSH 1; PACK
PUSH None
PUSH "serialize"
PUSH StdLibHashBytes
SYSCALL System.Contract.Call
PUSH reviewedPendingCallBytes
EQUAL
ASSERT

PUSH moduleType
PUSH accountIdBytes
PUSH 2; PACK
PUSH All
PUSH "cancelModuleCall"
PUSH AccountManagementHashBytes
SYSCALL System.Contract.Call
```

`ReadOnly`, `None`, and `All` are call flags `5`, `0`, and `15`.
`moduleType` is the UTF-8 string `verifier` or `hook`, as required by both
native entrypoints; the stored record's role field is the corresponding
integer `0` or `1`.
Both contract hashes and `accountIdBytes` use VM wire byte order. The first
call is a native read, serialization is pure computation, and cancellation
checks the current custody witness before deleting the selected role's slot.
There is no external module callback in this sequence, and other transactions
cannot execute between these instructions.

## Canonical bytes

`reviewedPendingCallBytes` is the exact Neo binary serialization of the same
pending record returned to the caller for review:

```text
[1, accountId, role, rootBinding, selectedBinding, methodBytes,
 invokedArguments, proposedAt, matureAt, configurationNonce]
```

The outer value and bindings are Arrays. Array and Struct arguments remain
distinct; ByteStrings retain their bytes; Integers retain exact values; Null
and Boolean retain their VM types. The SDK uses the canonical VM serializer,
never JSON, display-order hashes, or reconstructed method-specific parameters.
The outer Array contains exactly ten entries and the entire record is bounded
to 8192 bytes, matching native storage decoding. Argument depth and size retain
their existing profile limits. This guard compares bytes directly and defines
no new digest or hash domain.

A missing pending call serializes as Null and fails the comparison. Any changed
field fails `ASSERT` before cancellation. A malformed native record also faults
before deletion. A match still requires the current custody witness; it grants
no additional authority. Faulting transactions do not commit application
writes. The check does not require maturity, an Active account, or absence of
recovery, preserving the native cancellation policy.

## Submission and compatibility

Cancellation plans retain `role` and `pending`, and add `pendingCallBytes` and
`requiresExactScript: true`. Preparation, simulation, signing, export and import
must preserve the entire `plan.script`. A wallet method-and-arguments request
cannot express the comparison. Such plans must use the exact-script SDK route;
the interface must not fall back to an unguarded `wallet.invoke` request.

The native two-argument cancellation method remains available to applications
that deliberately authorize cancellation of the current role slot. The guard
is a guarantee of the guarded SDK transaction, not a new invariant enforced on
every native caller. Existing native methods, profile digest, record format,
identity, authorization domain and configuration-counter semantics remain
unchanged. Older clients do not gain this guard automatically.

The extra native read, serialization, comparison and embedded bytes increase
script size and fees. Existing simulation and transaction fee ceilings apply
to the complete script; clients must not reuse an estimate for the old single
call.

## Content identity and regression coverage

This is exact-content binding, not a unique proposal-instance identifier. If a
pending call is cancelled and recreated with every byte identical, including
the proposal timestamp and configuration nonce, the old guard still matches.
In particular, identical re-proposal within one block can have that property.
Rejecting that case would require a persistent proposal-generation counter or
another unique on-chain identifier and a separate protocol change.

Regression coverage must execute actual SDK script bytes against the native
engine: matching cancellation succeeds; replaced or missing content faults;
using the other role does not cancel either reviewed slot; missing custody
faults. A script with the guard removed demonstrates why the native two-argument
call alone cannot provide content binding. Tests also cover canonical VM type
distinctions, unchanged account records during replacement, the identical-byte
boundary, and preservation of the complete script through transaction signing.
