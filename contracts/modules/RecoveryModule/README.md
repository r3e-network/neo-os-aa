# RecoveryModule (§12)

Timelocked account recovery, driven by the account's own recovery timelock.

A recovery is a three-step conversation the account cannot hold by itself:

```
beginRecovery    the custodian or the recorded recovery authority starts it
                 (R-12-02), optionally naming the custody the matured reset
                 rotates to; the start time is the clock the account's own
                 recoveryTimelockMs runs against
cancelRecovery   the custodian or the recorded recovery authority withdraws it
executeRecovery  anyone may execute once the window has passed; the reset lands
                 through the core's §12.5 resetAccount
```

The module never invents a delay. It reads `recoveryTimelockMs` from the core's
`getAccount` at the moment the recovery starts, so a later policy change cannot
shorten a recovery that is already running.

## Surface

| ABI | Returns | Authority |
| --- | --- | --- |
| `beginRecovery(accountId, newCustody)` | `Integer` nonce | custody or recovery authority witness; a non-zero `newCustody` must also witness (R-12-02) |
| `cancelRecovery(accountId)` | `Void` | custody or recovery authority |
| `executeRecovery(accountId)` | `Void` | permissionless after maturity |
| `getRecoveryStatus(accountId)` | `Array` recovery record | read-only |
| `getModuleProfile()` | `String` profile JSON | read-only |

The module is installed as a **recovery seat** (module type code 5, spec
§12/§12.5, one per account): recovery is not a routing decision, so the
admission gate asks only for the `getModuleProfile` reader and the
`onInstall`/`onUninstall` lifecycle pair. The profile declares
`instanceIsolation: false` (state is keyed by account) and no routing
callbacks.

The module also answers `GetExecutedRecoveryNonce`, the nonce of the last executed recovery (`0` when
none), so a client can prove an execution happened without re-reading the record.

`beginRecovery` needs the custody or the recovery authority the account
recorded in the core (`getAccount` field 3 — the value the core's
`setRecoveryPolicy` landing entry writes), never "any installed validator";
the optional rotation target must witness its own installation into the record.
`executeRecovery` is permissionless on purpose: the whole point of a recovery
window is that the outcome does not depend on the party who started it still
being reachable. Its effect goes through the core's restricted
`resetAccount(accountId, newCustody)` entry: this module's installed recovery
seat is the one caller the core's reset accepts (R-12-12), so the
permissionless trigger can finish a reset the control subjects proposed but
no other contract can start one.

## Recovery record

```
[0] nonce         Integer   monotonically increasing per account
[1] custodian     Hash160  custody at begin time
[2] startedAt     Integer  ms
[3] executableAt  Integer  ms  (startedAt + recoveryTimelockMs)
[4] status        Integer  0 none · 1 pending · 2 executed
[5] newCustody    Hash160  custody the matured reset rotates to (zero keeps it)
```

## Storage

```
0x01 ‖ accountId   → serialized recovery record
0x02 ‖ accountId   → last executed recovery nonce
```

## Notes for integrators

* The matured execution is wired to the core: `executeRecovery` calls the
  core's `resetAccount(accountId, newCustody)` restricted landing entry
  (§12.5), which removes every module instance (this seat included, without
  `onUninstall`), clears the nonce channels and migration state, rotates
  custody to the recorded target, restores the registration defaults and
  advances epoch/nonce/revision — atomically. The module-side record written
  at execution survives only as inert history (R-12-13).
* The executed nonce is monotone so a cancelled-then-restarted recovery cannot
  reuse an earlier nonce, and a replay of a completed `executeRecovery` is a
  no-op fault rather than a second transition.
* `onUninstall` clears both prefixes: an unfinished recovery must not survive the
  module it was recorded under.

The reviewed entrypoints are absent from the published user-contract ABI. In the [native candidate module](RecoveryModule.cs), wallets reviewing a pending record can use `cancelReviewedRecovery` and `executeReviewedRecovery`. Each takes the account ID, pending record nonce and core configuration nonce, in that order. Both fail if the record or the core configuration has changed since review. The existing authorization and timelock checks still apply.
The SDK offers this flow only for the compiled standard module: the installed NEF digest, current deployment id and update counter, and the configured core must match.
