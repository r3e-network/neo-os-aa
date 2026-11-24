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
[5, operationEnabled, messageEnabled]                     set built-in routes
[7, policyId, threshold, memberInstanceIds[], active]       set threshold policy
[8, recoveryAuthority, recoveryTimelockMs, ownerOnly]      set recovery policy
[9, scriptIdentities[], threshold]                         set message subjects
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

For an intent containing multiple adjacent core actions (1, 2, 5, 7, 8 or 9), confirmation
calls the core's `applyConfigurationActions` once. The original action order and install
digest are preserved; failure leaves the original intent pending. The final account must
retain an operation route. Module-defined actions may precede or follow one such group;
interleaving two core groups with a module action is rejected at proposal. Confirmation
also refuses to commit a net configuration nonce increase greater than one.

## Storage

```
0x01 ‖ accountId ‖ intentId(8 BE)   → serialized intent record
0x02 ‖ accountId                    → last allocated intent id
0x03 ‖ accountId                    → last recorded routed-operation completion
```

## Intent lifecycle rules

* **R-11-03** — a confirmed intent must be at least `configurationMaturity()`
  old and at most `configurationExpiryWindow()` (7 days) past maturity; an
  expired intent fails confirmation and can be cleaned by cancellation or the next proposal.
* **R-11-04** — at most 16 pending intents per account; a full table refuses
  new proposals. Confirmed and cancelled intents are deleted (spec §11.4), so
  the slot is free again.
* **R-11-05** — a proposal whose action digest equals a pending intent's is a
  duplicate and is refused.
* **R-11-09/11** — the public receipt pins the original epoch, configuration nonce, actions
  and time window. Separate proposals consisting only of built-in, threshold, recovery and message policies can
  follow one another across a configuration increment: both must be current beforehand and
  their resources must be disjoint. External changes, callbacks with unknown effects and legacy records
  are never accepted as evidence of an independent policy transition. An epoch change
  invalidates prior approvals.
* Actions 6 (code rebind) and 10 (migration import) have no native landing method in this
  profile. A proposal containing either faults before it receives an intent ID.
* **H-2** — the `unfreeze` intent is the one path open to a `Frozen` account:
  both `unfreezeAccount` (propose) and its confirmation accept `Active` or
  `Frozen`; `MigrationRequired` never passes. All `configure` paths keep the
  `Active` gate.

## Notes for integrators

* Maturity (24h) and the confirmation window (7d) are fixed in this implementation.
* Confirmed and cancelled intents are deleted; an intent that expired without
  confirmation occupies a slot until explicitly cleaned or the next proposal runs cleanup.
* `onUninstall` deletes all three prefixes.
* The digest is over raw serialized actions, not over a re-encoding, so a
  confirmation cannot be tricked by a semantically equal but differently ordered
  array.
