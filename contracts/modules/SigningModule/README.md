# SigningModule (§13)

EIP-1271 message signatures for one SmartAccount account.

The core authorizes operations. It says nothing about whether a *message* was
signed by the account — a dapp login, an off-chain order, a 1271 verifier. This
module answers exactly that question in the shape every verifier already
understands: four bytes of magic for a valid signature, four bytes of refusal
otherwise.

## Surface

| ABI | Returns | Authority |
| --- | --- | --- |
| `isValidSignature(accountId, hash, signature)` | `ByteString` 4 | read-only, no witness |
| `updateMessageSubject(accountId, subjects[], threshold)` | `Void` | account administration |
| `getMessageSubjects(accountId)` | `Array` `[subjects[], threshold]` | read-only |
| `getModuleProfile()` | `String` profile JSON | read-only |
| `validateUserOp(accountId, operationDigest, operation)` | `Boolean` | core only, read-only |
| `onUserOpComplete(accountId, operation, result)` | `Void` | core only |

The module is installed as a **validator-type** instance (spec §13.1), so the
admission gate requires the full routing pair; the profile declares
`messageCapability: true` — this module owns the account's message domain, and
nothing else — with `instanceIsolation: false` (roster keyed by account).

The routing callbacks never approve an operation (R-13-15): the message domain
signs messages, not operations, so `validateUserOp` answers `false` for
everything and `onUserOpComplete` is a no-op.

```
0x1626ba7e   valid
0xffffffff   not valid
```

`isValidSignature` must be answerable by any node for any account, so it takes
no witness and touches no state. Everything that could make it fault — a missing
hash, a short signature, an unconfigured account — answers `0xffffffff` instead.

## Subjects and signatures

Subjects are 33-byte compressed secp256r1 public keys; the threshold is how many
of them must sign. A signature is the subjects' 64-byte `r‖s` values
concatenated in subject order:

```
signature = r₁‖s₁ ‖ r₂‖s₂ ‖ …          (64 bytes per subject, policy order)
```

The module never guesses which subject signed what: entry *i* is checked against
subject *i*, and a missing or malformed entry counts as a non-signature. If the
number of valid entries reaches the threshold the answer is `0x1626ba7e`.

An empty roster with `threshold = 0` is a legitimate policy: it means "this
account signs no messages".

## Storage

```
0x01 ‖ accountId   → serialized [serialized subjects[], threshold]
```

The roster is stored serialized so a read never re-encodes policy, and so a
duplicate or malformed key cannot be introduced by a later encoding change.

## Notes for integrators

* `onInstall` accepts `[]` or `[subjects[], threshold]`, so an account can
  publish its roster in the same call that installs the module.
* Verification uses `CryptoLib.VerifyWithECDsa` with
  `NamedCurveHash.secp256r1SHA256`, matching the repository's validator
  convention (`ValidatorPayload.VerifyP256`).
* This skeleton verifies one signature per subject, in order. A production
  deployment that needs out-of-order signatures carries an index alongside each
  signature rather than changing the digest.
