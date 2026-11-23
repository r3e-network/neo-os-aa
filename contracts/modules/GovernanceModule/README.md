# GovernanceModule (§11)

Configuration-intent governance for one SmartAccount account.

The minimal core executes; it does not stage. `installModule` and `removeModule`
take effect in the transaction that calls them, `unfreezeAccount` leaves `Frozen`
the moment it is confirmed. An account that wants a reviewed change-control
budget — propose, wait, confirm with the same actions — needs a module, and this
is that module.

## Surface

| ABI | C# | Returns | Authority |
| --- | --- | --- | --- |
| `proposeConfiguration(accountId, actions[], readSet[])` | `ProposeConfiguration` | `Integer` intentId | account administration |
| `confirmConfiguration(accountId, intentId, actions[])` | `ConfirmConfiguration` | `Void` | account administration |
| `cancelConfiguration(accountId, intentId)` | `CancelConfiguration` | `Void` | account administration |
| `getPendingConfiguration(accountId, intentId)` | `GetPendingConfiguration` | `Array` intent record | read-only |
| `unfreezeAccount(accountId)` | `UnfreezeAccount` | `Integer` intentId | account administration |
| `configurationMaturity()` | `ConfigurationMaturity` | `Integer` ms | read-only |
| `configurationExpiryWindow()` | `ConfigurationExpiryWindow` | `Integer` ms | read-only |
| `getModuleProfile()` | `GetModuleProfile` | `String` profile JSON | read-only |
| `validateUserOp(accountId, operationDigest, operation)` | `ValidateUserOp` | `Boolean` | core only, read-only |
| `onUserOpComplete(accountId, operation, result)` | `OnUserOpComplete` | `Void` | core only |
| `getLastCompletion(accountId)` | `GetLastCompletion` | `Array` `[completedAt, moduleId]` | read-only |

The module is installed as a **validator-type** instance (spec §11.1), so the
core's admission gate requires the `getModuleProfile` reader plus the
`validateUserOp`/`onUserOpComplete` routing pair; all three are exposed. The
routing callback always declines ordinary UserOps; use a credential validator for spending. The
profile declares no message domain, no threshold membership and no composition
(`capabilities` all zero/false, `instanceIsolation: false` — policy state is
keyed by account).

`unfreezeAccount` exists here rather than as a core call because leaving `Frozen`
is exactly the change an account wants a maturity window in front of: the module
creates an `unfreeze` intent and, once it matures, drives the core's
`unfreezeAccount`.

## Intent record

`getPendingConfiguration` answers with nine fields:

```
[0] intentId           Integer
[1] kind               "configure" | "unfreeze"
[2] proposedAt         Integer ms
[3] matureAt           Integer ms   (proposedAt + configurationMaturity)
[4] expiresAt          Integer ms   (matureAt + configurationExpiryWindow)
[5] authorityEpoch     Integer      epoch at proposal time
[6] configurationNonce Integer      nonce at proposal time
[7] digest             ByteString 32 — sha256 of the serialized actions
[8] actionCount        Integer
```

## Actions

`confirmConfiguration` re-submits the actions and the module compares them
against the pinned digest. Only the exact set that was proposed executes:

```
[1, moduleType, contractHash, profileDigest, initData[]]   install
[2, moduleId, deInitData[]]                                uninstall
[8, recoveryAuthority, recoveryTimelockMs, ownerOnly]      set recovery policy
```

Install and uninstall are driven through `ModuleSupport.InstallModule` /
`ModuleSupport.RemoveModule`, so the core allocates the module id — the module
never guesses one, and a proposal can be authored before the id exists. The
install action's `profileDigest` (action[3]) is handed through (audit M-2): the
module hashes the installed contract's live `getModuleProfile` reply and refuses
the install when it differs from the digest the proposal reviewed, so the
profile that was reviewed is the profile that is installed.

Action 8 (H-4(a), spec §11.5/§12.5) is the restricted recovery-policy write:
a confirmed intent hands its four values — non-zero `recoveryAuthority`, a
timelock inside the 7–90 day domain, and the `ownerOnly` flag — to the core's
`setRecoveryPolicy` landing entry, which re-validates the domain and authority
before writing the account's control record and emitting `RecoveryPolicySet`.

## Storage

```
0x01 ‖ accountId ‖ intentId(8 BE)   → serialized intent record
0x02 ‖ accountId                    → last allocated intent id
0x03 ‖ accountId                    → last recorded routed-operation completion
```

## Intent lifecycle rules

* **R-11-03** — a confirmed intent must be at least `configurationMaturity()`
  old and at most `configurationExpiryWindow()` (7 days) past maturity; an
  expired intent fails confirmation and leaves the table only by cancel.
* **R-11-04** — at most 16 pending intents per account; a full table refuses
  new proposals. Confirmed and cancelled intents are deleted (spec §11.4), so
  the slot is free again.
* **R-11-05** — a proposal whose action digest equals a pending intent's is a
  duplicate and is refused.
* **R-11-09** — the record pins the authority epoch and configuration nonce at
  proposal time; a confirmation against a changed (epoch, nonce) fails.
* **H-2** — the `unfreeze` intent is the one path open to a `Frozen` account:
  both `unfreezeAccount` (propose) and its confirmation accept `Active` or
  `Frozen`; `MigrationRequired` never passes. All `configure` paths keep the
  `Active` gate.

## Notes for integrators

* Maturity (24h) and the confirmation window (7d) are constants in this
  skeleton. A production deployment makes them per-account state and puts a
  floor under them.
* Confirmed and cancelled intents are deleted; an intent that expired without
  confirmation stays until it is cancelled (it still occupies a pending slot).
* `onUninstall` deletes all three prefixes.
* The digest is over raw serialized actions, not over a re-encoding, so a
  confirmation cannot be tricked by a semantically equal but differently ordered
  array.
