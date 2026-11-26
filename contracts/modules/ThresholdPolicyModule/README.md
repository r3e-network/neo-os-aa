# ThresholdPolicyModule (spec §3, §5, §10)

Weighted-threshold policy for one SmartAccount account: members, weights,
quorum, generation and the active flag.

A basic account receives and sends funds without this module. To require
several approvals, install one standard member validator instance per signing
key, then install this module as the account's **composite layer** and enrol
the policy through its governed `configure` callback.

## Surface

| ABI | Returns | Authority |
| --- | --- | --- |
| `getThresholdPolicy(accountId, moduleId)` | `Array [thresholdWeight, memberIds[], weights[], generation, active, revision]`, or empty | read-only |
| `getPolicySnapshot(accountId)` | `Array [moduleId, …policy]`, or empty when this contract holds no seat | read-only |
| `configure(accountId, moduleId, moduleType, configData)` | `Void` | core only, configuration frame only |
| `getModuleProfile()` | `String` profile JSON | read-only |
| `authorizedCore()` | `Hash160` | read-only |
| `setAuthorizedCore(coreContract)` | `Void` | deployer, once |
| `onInstall(accountId, moduleId, moduleType, initData)` | `Void` | core only; `initData` must be `[]` |
| `onUninstall(accountId, moduleId, moduleType, deInitData)` | `Void` | core only |
| `validateUserOp(accountId, operationDigest, operation)` | `Boolean` | core only, read-only |
| `onUserOpComplete(accountId, operation, result)` | `Void` | core only |

The module is installed as a validator-type instance (module type 1) whose
profile declares `compositeLayer: 1` and `instanceIsolation: true`. The core
treats it as the account's composite layer; the core never reads a roster,
weight or quorum itself.

## Policy

`configData` is one of:

* `[thresholdWeight, memberIds[], weights[]]` — enrol the roster (active
  defaults to `true`);
* `[thresholdWeight, memberIds[], weights[], active]` — enrol and set the flag;
* `[active]` — flip only the flag of the existing policy;
* `[]` — a byte-for-byte no-op, so a generic configure call never faults.

Every enrolment is validated leaf by leaf against the **native descriptor**,
never against caller-supplied data: 1–10 distinct member ids
(`SA_MODULE_LIMIT_MEMBERS`), each a validator-type instance that is
threshold-member eligible and not itself a composite layer, not this module,
with a live code binding, weight `1..MaxWeight` and total weight bounded
(`SA_OPERATION_MALFORMED`), and `1 ≤ thresholdWeight ≤ totalWeight`
(`SA_MODULE_LIMIT_THRESHOLD`). The pinned credential generation of the
composite instance is recorded with the policy.

## Validation

`validateUserOp` approves exactly when the weights of the leaf approvals reach
the quorum. Every configured member is dispatched through the native
`validateMember` sink and **the loop never stops early** when the quorum is
reached, so the core records — and later completes — every member that
approved. The core itself rejects nested composites, ineligible leaves,
duplicates, cross-account members and dead code bindings; this module owns only
the roster, weights and quorum. A policy whose pinned credential generation no
longer matches the installed instance fails closed until it is reconfigured, as
does an inactive policy or a corrupt record.

`onUserOpComplete` only authenticates the core caller: the core already
dispatches completion to the approved members only, and this module has no
member callbacks to forward and no post-execution state.

## Storage

```
0x01 ‖ accountId ‖ moduleId   → serialized [thresholdWeight, memberIds[], weights[], generation, active, revision]
```

The prefix is deleted and the binding released by `onUninstall`.

## Notes for integrators

* While a policy is active, spending must satisfy its quorum. The roster, weights
  and quorum can change only through the governed `configure` callback; no
  other entry of this module writes them. To return to the basic account,
  start a recovery and wait its preset delay.
* Only approving members receive completion callbacks; the core decides that
  from the approvals the native `validateMember` sink recorded.
* The core pins no digest of this artifact: the policy is bound by the instance
  binding and the credential generation checked on every validation.
