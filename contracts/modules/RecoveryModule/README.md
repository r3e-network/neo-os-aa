# RecoveryModule (spec §3, §10)

Timelocked account recovery, driven by the account's own recovery policy.

A recovery is a three-step conversation the account cannot hold by itself:

```
beginRecovery    custody, the recorded recovery authority or the guardian quorum starts it,
                 optionally naming the custody the matured reset rotates to
cancelRecovery   the same authority withdraws it
executeRecovery  anyone may execute once the window has passed; the reset lands
                 through the core's resetAccount
```

The module never invents a delay. The guardians, the guardian threshold, the
timelock and the optional recovery authority are module policy, written only
through the governed `configure` callback. The start time is the clock the
policy's `timelockMs` runs against. Completion requires the live policy to
match the snapshot taken at begin: replacing the authority or the guardians
revokes the request, changing the delay retires it. The authority epoch and
the configuration nonce are checked independently.

## Surface

| ABI | Returns | Authority |
| --- | --- | --- |
| `beginRecovery(accountId, newCustody)` | `Integer` nonce | custody, recovery authority or guardian quorum; a non-zero `newCustody` must also witness |
| `cancelRecovery(accountId)` | `Void` | custody, recovery authority or guardian quorum |
| `executeRecovery(accountId)` | `Void` | permissionless after maturity |
| `getRecoveryStatus(accountId)` | `Array` recovery record, or empty | read-only |
| `getRecoveryPolicySnapshot(accountId)` | `Array [guardians[], threshold, timelockMs, authority, revision, digest]`, or empty | read-only |
| `getExecutedRecoveryNonce(accountId)` | `Integer` | read-only |
| `configure(accountId, moduleId, moduleType, configData)` | `Void` | core only, configuration frame only |
| `getModuleProfile()` | `String` profile JSON | read-only |
| `authorizedCore()` | `Hash160` | read-only |
| `setAuthorizedCore(coreContract)` | `Void` | deployer, once |
| `onInstall(accountId, moduleId, moduleType, initData)` | `Void` | core only; `initData` must be `[]` |
| `onUninstall(accountId, moduleId, moduleType, deInitData)` | `Void` | core only |

The module is installed as the **recovery seat** (module type code 5, one per
account, spec §1.1 and §12): recovery is not a routing decision, so the
admission gate asks only for the `getModuleProfile` reader and the
`onInstall`/`onUninstall` lifecycle pair. The profile declares
`instanceIsolation: false` (state is keyed by account) and no routing callbacks.

## Policy

`configData` is `[guardians[], threshold, timelockMs]` or
`[guardians[], threshold, timelockMs, authority]`:

* 1–10 distinct non-zero guardians (`SA_MODULE_LIMIT_MEMBERS`,
  `SA_OPERATION_MALFORMED`);
* `1 ≤ threshold ≤ guardians` (`SA_MODULE_LIMIT_THRESHOLD`);
* `timelockMs` inside the 7–90 day domain (`SA_OPERATION_MALFORMED`);
* `authority` optional, zero or a valid 20-byte script hash.

Every write bumps the policy revision and emits `RecoveryPolicyUpdated`. The native core has no recovery-policy setter: the module is the only owner of these values.

## Authority and the begin gate

`RequireRecoveryAuthority` accepts, in order: the account's custody witness, the
recorded recovery authority, or at least `threshold` guardian witnesses
(`SA_UNAUTHORIZED` otherwise). It never accepts "any installed validator".

`beginRecovery` needs the installed seat and a configured policy, refuses a
second pending request (`SA_RECOVERY_PENDING`), and records the start time, the
executable time, the authority epoch, the configuration nonce, the policy
revision and the policy digest. A non-zero rotation target must witness its own
installation into the record.

`executeRecovery` is permissionless on purpose: the whole point of a recovery
window is that the outcome does not depend on the party who started it still
being reachable. It refuses before maturity (`SA_RECOVERY_LOCKED`), on a
changed authority epoch (`SA_EPOCH_STALE`), on a changed configuration nonce
(`SA_CONFIGURATION_NONCE_STALE`) and on a changed policy revision or digest
(`SA_EPOCH_STALE`). The record's account and module ids are re-checked against
the live values so a record can never be replayed under another account.

Its effect goes through the core's restricted `resetAccount(accountId,
newCustody)`: this module's installed, code-bound recovery seat is the one
caller the core's reset accepts, so the permissionless trigger can finish a
reset that no other contract can start. The core removes every module instance
(this seat included, without `onUninstall`), clears every nonce channel,
rotates custody to the recorded target, restores the registration defaults and
advances epoch, nonce and revision — atomically.

The begin, cancel and execute gates accept `Active` or `Frozen` accounts; any
other status is `SA_ACCOUNT_STATUS`.

## Recovery record

`getRecoveryStatus` answers an empty array while no recovery was ever started or
after a cancellation, otherwise the twelve-field record:

```
[0] nonce                    Integer   monotonically increasing per account
[1] initiator                Hash160   caller that started the request
[2] startedAt                Integer   ms
[3] executableAt             Integer   ms  (startedAt + timelockMs)
[4] status                   Integer   1 pending · 2 executed
[5] newCustody               Hash160   custody the matured reset rotates to (zero keeps it)
[6] authorityEpochAtInit     Integer   epoch snapshotted at begin
[7] configurationNonceAtInit Integer   configuration nonce snapshotted at begin
[8] policyDigest             ByteString 32 — SHA-256 of the serialized policy
[9] policyRevision           Integer   policy revision at begin
[10] accountId               Hash160   account the record belongs to
[11] moduleId                Integer   recovery seat that wrote it
```

Starting while a request is pending, or cancelling/executing without one, is
`SA_RECOVERY_PENDING`. `getExecutedRecoveryNonce` answers the nonce of the last
executed recovery (`0` when none), so a client can prove an execution happened
without re-reading the record.

## Storage

All keys are scoped to the instance through `ModuleSupport.Key`:

```
0x01 ‖ accountId ‖ moduleId   → serialized recovery record (12 fields)
0x02 ‖ accountId ‖ moduleId   → last executed recovery nonce
0x03 ‖ accountId ‖ moduleId   → serialized policy [guardians[], threshold, timelockMs, authority, revision]
```

## Notes for integrators

* The executed nonce is monotone so a cancelled-then-restarted recovery cannot
  reuse an earlier nonce, and a replay of a completed `executeRecovery` faults
  rather than performing a second transition.
* The record written at execution survives only as inert history; the policy
  prefix is deleted once the reset has landed.
* `onUninstall` clears all three prefixes: an unfinished recovery must not
  survive the module it was recorded under.
* The native core pins this module's NEF and manifest digests: a reset can be
  triggered only through the re-pinned artifact.
