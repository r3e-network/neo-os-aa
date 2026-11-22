# ThresholdPolicyModule (§15)

A threshold policy as an installable validator: member set, threshold, and the
`validateUserOp` that counts signatures against it.

The minimal core routes an operation to exactly one validator instance and asks
that instance to answer true or false. It does not count members. So the
threshold lives here: the account installs this module as its validator,
publishes a policy, and an operation is approved only when enough listed members
signed it.

## Surface

| ABI | Returns | Authority |
| --- | --- | --- |
| `setThresholdPolicy(accountId, threshold, members[])` | `Void` | account administration |
| `getThresholdPolicy(accountId)` | `Array` policy record | read-only |
| `validateUserOp(accountId, operationDigest, operation)` | `Boolean` | core only, read-only |
| `onUserOpComplete(accountId, operation, result)` | `Void` | core only |
| `getModuleProfile()` | `String` profile JSON | read-only |

The profile declares `thresholdMemberEligible: false` — that flag marks
modules that may **join** a policy as members (§15.4), and this module *is*
the policy, not a member — with `instanceIsolation: false`: the policy roster
is keyed by account, so one instance per account.

The member-facing read is `GetMemberDigest`: it binds an operation digest to the account's policy
record and returns the 32-byte digest a listed member signs.

## Policy record

```
[0] members[]     Array of 33-byte compressed secp256r1 keys
[1] threshold     Integer   0 … members.length
[2] policyNonce   Integer   bumps on every write
[3] updatedAt     Integer   ms
```

A never-configured account answers with an empty policy rather than a fault, so a
reader can tell "no policy" from "no account". `threshold = 0` with an empty
roster is a legitimate policy: it approves nothing.

## What a member signs

```
memberDigest = sha256(accountId ‖ moduleId(8 BE) ‖ operationDigest)
```

Binding the account and the instance into the digest means a signature collected
for one account, or for one instance of it, never verifies for another — even
when the core operation digest is identical.

The signatures travel in the operation's validator DTO (field 11) as the members'
64-byte `r‖s` values concatenated in policy order:

```
signature = r₁‖s₁ ‖ r₂‖s₂ ‖ …          (64 bytes per member, policy order)
```

## Validation

`validateUserOp` is the core's callback, so it asserts that the caller is the
pinned core and asks the core which instance it routed to
(`getAuthorizedModuleId`). It then:

1. refuses when the operation's `validatorId` is not this instance;
2. refuses when there is no policy, or the threshold is unreachable;
3. counts valid members up to the supplied signature capacity;
4. answers `true` only when the count reaches the threshold.

Every refusal is `false`, never a fault, so a malformed or truncated signature
block cannot widen the answer by omission.

## Storage

```
0x01 ‖ accountId   → serialized [serialized members[], threshold, policyNonce, updatedAt]
```

## Notes for integrators

* `onInstall` accepts `[]` or `[threshold, members[]]` so the first policy can be
  published with the installation.
* Member ceiling is 10 (`MaxThresholdPolicyMembers`), checked before any storage
  write, so an unbounded roster can never be stored.
* This skeleton re-reads the policy on every validation. A production deployment
  that routes many operations per block caches the decoded roster per operation
  in its own storage generation counter instead.
