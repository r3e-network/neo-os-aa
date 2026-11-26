# GovernanceModule (spec §10)

Configuration-intent governance for one SmartAccount account.

The minimal core executes; it does not stage. `installModule`, `removeModule`,
`configureModule`, `setBuiltinAuthorization` and `setRequiredValidator` take
effect in the transaction that calls them. An account that wants a reviewed
change-control budget — propose, wait, confirm the exact same actions — needs a
module, and this is that module. It declares the `governance` seat in its
profile, which is what lets the core accept a landing from this instance.

## Surface

| ABI | C# | Returns | Authority |
| --- | --- | --- | --- |
| `proposeConfiguration(accountId, actions[], readSet[])` | `ProposeConfiguration` | `Integer` intentId | custody witness |
| `confirmConfiguration(accountId, intentId, actions[])` | `ConfirmConfiguration` | `Void` | custody witness |
| `cancelConfiguration(accountId, intentId)` | `CancelConfiguration` | `Void` | custody witness; anyone for an expired record |
| `unfreezeAccount(accountId)` | `UnfreezeAccount` | `Integer` intentId | custody witness |
| `getPendingConfiguration(accountId, intentId)` | `GetPendingConfiguration` | `Array` intent view | read-only |
| `getPendingConfigurationIntentIds(accountId)` | `GetPendingConfigurationIntentIds` | `Array` intentIds | read-only |
| `getLastCompletion(accountId)` | `GetLastCompletion` | `Array` `[completedAt]` or empty | read-only |
| `configurationMaturity()` | `ConfigurationMaturity` | `Integer` ms | read-only |
| `configurationExpiryWindow()` | `ConfigurationExpiryWindow` | `Integer` ms | read-only |
| `getModuleProfile()` | `GetModuleProfile` | `String` profile JSON | read-only |
| `authorizedCore()` | `AuthorizedCore` | `Hash160` | read-only |
| `setAuthorizedCore(coreContract)` | `SetAuthorizedCore` | `Void` | deployer, once |
| `onInstall(accountId, moduleId, moduleType, initData)` | `OnInstall` | `Void` | core only; `initData` must be `[]` |
| `onUninstall(accountId, moduleId, moduleType, deInitData)` | `OnUninstall` | `Void` | core only |
| `validateUserOp(accountId, operationDigest, operation)` | `ValidateUserOp` | `Boolean` | core only, read-only |
| `onUserOpComplete(accountId, operation, result)` | `OnUserOpComplete` | `Void` | core only |

The module is installed as a **validator-type** instance (module type 1, spec §9
and §12). Its profile declares `governance: true` and the
`validateUserOp`/`onUserOpComplete` routing pair, and it has **no `configure`
callback**: its policy is fixed and its only mutable state is the intent set.
The routing callback always declines ordinary UserOps; use a credential
validator for spending. The profile declares no message domain, no threshold
membership and no composition (`instanceIsolation: false`, `compositeLayer: 0`
— policy state is keyed by account).

`unfreezeAccount` exists here rather than as a core call because leaving `Frozen`
is exactly the change an account wants a maturity window in front of: the module
creates an `unfreeze` intent and, once it matures, drives the core's
`unfreezeAccount`.

## Administration rule

`proposeConfiguration`, `confirmConfiguration` and `unfreezeAccount` require the
custody witness before they write anything (fail-closed, `SA_UNAUTHORIZED`, see
[Shared plumbing](../README.md#shared-plumbing)): the module reads the custody
from the core's `getAccount` and checks that one witness. The module keeps no
copy of the native landing rule — it does not consult a mandatory route, and an
installed validator that calls these entries is not an administration witness
(the core's v4.1 rule says the same for `revokeModuleCredentials`). Cancelling an
unexpired intent needs the custody witness only; an expired record can be cleaned
by anyone.

## Intent view

`getPendingConfiguration` answers with nine fields:

```
[0] intentId           Integer
[1] kind               "configure" | "unfreeze"
[2] proposedAt         Integer ms
[3] matureAt           Integer ms   (proposedAt + configurationMaturity)
[4] expiresAt          Integer ms   (matureAt + configurationExpiryWindow)
[5] authorityEpoch     Integer      epoch at proposal time
[6] configurationNonce Integer      nonce at proposal time
[7] digest             ByteString 32 — commitment over the serialized actions
[8] actionCount        Integer
```

An unknown id answers an empty array (`SA_INTENT_NOT_FOUND` is raised only by
the write entries).

## Actions

`confirmConfiguration` re-submits the actions and the module compares the
re-serialized bytes with the pinned bytes (`SA_OPERATION_MALFORMED` on any
difference). Only the exact set that was proposed executes:

```
[1, moduleType, contractHash, profileDigest, initData[]]   install
[2, moduleId, deInitData[]]                                uninstall
[3, moduleId, configData[]]                                configure an instance
[5, operationEnabled, messageEnabled]                      set built-in routes
[7, moduleId, required]                                    set required validator
[11]                                                       unfreeze (alone)
```

Every action is validated at **proposal** time: unknown codes, wrong arity, wrong
types and limit violations are `SA_OPERATION_MALFORMED`, except more than 16
actions (`SA_MODULE_LIMIT_ACTIONS`) and more than 16 `readSet` entries
(`SA_OPERATION_MALFORMED`). No intent id is allocated for a proposal that could
never land. Any other action code is refused (`SA_OPERATION_MALFORMED`); policies travel through the governed `configure` callback of the owning module.

Install and uninstall land inside the reviewed batch: the core allocates the
module id when it applies the action, so the module never guesses one and a
proposal can be authored before the id exists. The install action's
`profileDigest` (action[3]) is compared by the core against the profile digest
it binds for the installed contract, and a differing digest refuses the install
(`SA_MODULE_CODE_BINDING_MISMATCH`). This contract carries no `installModule`,
`removeModule`, `configureModule` or `setBuiltinAuthorization` call path —
`Shared/ModuleSupport` exposes none — so no code here can land a topology
change outside the delay.

**Core group.** Actions 1, 2, 3, 5 and 7 are core actions and must form one
consecutive group in the proposal; at confirmation the group is handed to the
core's `applyConfigurationActions` once (one nonce advance, all-or-nothing).
Action 11 must travel alone and lands on the core's `unfreezeAccount`.

## Commitment and conflicts

The intent digest is `SHA-256("NeoSmartAccount/Governance" ‖ 0x04 ‖ coreHash ‖
accountId ‖ U64BE(moduleId) ‖ U64BE(epoch) ‖ U64BE(nonce) ‖ serializedActions)`,
computed with `CryptoLib.Sha256`. A proposal whose digest equals a pending
intent's, or whose resource set (action-derived keys plus the declared
`readSet`) intersects a pending intent's, is refused (`SA_INTENT_CONFLICT`),
never queued.

## Storage

All keys are scoped to the instance through `ModuleSupport.Key`:

```
0x01 ‖ accountId ‖ moduleId ‖ intentId(8 BE)   → serialized intent record (10 fields)
0x02 ‖ accountId ‖ moduleId                    → last allocated intent id
0x03 ‖ accountId ‖ moduleId                    → last routed-operation completion time
```

The module owns no policy body: thresholds, recovery settings and message
subjects live in their own modules' storage, written only through the governed
`configure` callback.

## Intent lifecycle rules

* A confirmed intent must be at least `configurationMaturity()` old and at most
  `configurationExpiryWindow()` (7 days) past maturity; an immature intent fails
  with `SA_INTENT_IMMATURE`, an expired one with `SA_INTENT_EXPIRED`.
* At most 16 pending intents per account (`SA_INTENT_LIMIT`); a full table
  refuses new proposals. Confirmed and cancelled intents are deleted, so the
  slot is free again.
* The record pins the authority epoch, configuration nonce, exact action bytes
  and time window. An epoch or nonce change between proposal and confirmation
  is `SA_EPOCH_STALE` / `SA_CONFIGURATION_NONCE_STALE`.
* Confirmation consumes the record **before** the landing write, so a replayed
  confirmation finds no intent instead of landing twice.
* After a landing the module asserts the expected core transition —
  `configurationNonce + 1` always, plus `authorityEpoch + 1` for an unfreeze and
  an unchanged epoch otherwise — and then invalidates every remaining intent
  that is stale (`ConfigurationInvalidated`, reason 1) or resource-conflicting
  (reason 2).
* The unfreeze intent is the one path open to a `Frozen` account: both
  `unfreezeAccount` (propose) and its confirmation accept `Active` or `Frozen`;
  All `configure` paths keep the `Active` gate, and a `Frozen` account may cancel only an unfreeze intent.

## Notes for integrators

* Maturity (24h) and the confirmation window (7d) are fixed in this implementation.
* Confirmed and cancelled intents are deleted; an intent that expired without
  confirmation occupies a slot until explicitly cleaned or the next proposal runs cleanup.
* `onUninstall` deletes the intent set, the intent counter and the completion
  record of the instance.
* The digest is over the raw serialized actions, not over a re-encoding, so a
  confirmation cannot be tricked by a semantically equal but differently ordered
  array.
* The native core pins this module's NEF and manifest digests for the governed
  configuration actions; a rebuilt artifact must be re-pinned there.
