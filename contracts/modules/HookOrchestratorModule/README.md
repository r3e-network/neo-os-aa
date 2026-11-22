# HookOrchestratorModule (§14)

Hook order and credential revocation for one SmartAccount account.

A v4 operation carries a per-hook proof array (operation field 12) plus the
module id of every hook it names. The minimal core shape-checks that array —
ordered, unique, within capacity — and never interprets it. Deciding which hooks
run, in which order, and whether a credential was revoked is orchestration, and
orchestration is this module.

## Surface

| ABI | C# | Returns | Authority |
| --- | --- | --- | --- |
| `setHookOrder(accountId, hookIds[])` | `SetHookOrder` | `Void` | account administration |
| `getHookOrder(accountId)` | `GetHookOrder` | `Array` hookIds | read-only |
| `revokeCredentials(accountId, moduleId)` | `RevokeCredentials` | `Void` | account administration |
| `getCredentialGeneration(accountId, moduleId)` | `GetCredentialGeneration` | `Integer` | read-only |
| `getModuleProfile()` | `GetModuleProfile` | `String` profile JSON | read-only |
| `validateUserOp(accountId, operationDigest, operation)` | `ValidateUserOp` | `Boolean` | core only, read-only |
| `onUserOpComplete(accountId, operation, result)` | `OnUserOpComplete` | `Void` | core only |

The module is installed as a **validator-type** instance (spec §14.1) with
`compositeLayer: 1` — it composes the hook chain behind an operation — and
`instanceIsolation: false`. The routing callbacks are fail-closed in this
skeleton: inner-credential verification and pre/post-hook dispatch are not
implemented yet, so `validateUserOp` answers `false` for everything and
`onUserOpComplete` is a no-op.

## The two policies

**Hook order.** The published list is what a hook set must satisfy, in order:

* strictly ascending, no duplicates — the same ordering rule the core applies to
  the operation's proof array, so a published order can be compared position by
  position against an operation;
* at most 8 entries, the protocol's per-operation proof capacity;
* an empty list is a legitimate value: it says "run no hooks".

**Credential generation.** Revoking a credential raises the instance's
operating generation — the one the core's restricted landing entry
`revokeModuleCredentials` advances in the 0x52 record, together with the
account's configuration nonce, in the same call frame (audit H-3): that core
generation is what invalidates every proof bound to the older one.
`revokeCredentials` calls that entry (the orchestrator's own validator witness
is one of the two authorities the core accepts) and keeps a local mirror under
`0x02` for `getCredentialGeneration` readers; the mirror is history, never the
effective counter. Revocation is monotone — there is no call that lowers a
generation again — so a revoked credential cannot be revived by replaying the
call that revoked it. A generation of 1 means "never revoked"; 0 means "no such
instance was ever issued to this account".

## Storage

```
0x01 ‖ accountId                     → serialized hookId list
0x02 ‖ accountId ‖ moduleId(8 BE)    → current credential generation
```

Per spec §14.3 the hook-order record is **account-level** — one record per
account, shared by every instance on it — while credential generations are
**instance-scoped** (`accountId ‖ moduleId`). `onUninstall` therefore deletes
the order for the whole account but only its own instance's generation keys
(audit L-2: a second instance's credential records survive another instance's
uninstall).


## Notes for integrators

* `onInstall` accepts `[]` or `[hookIds[]]` so the first order can be published
  with the installation.
* `onUninstall` deletes the account's order and its own generation keys (see
  Storage): a revocation record must not outlive the instance that interpreted
  it, and another instance's records are not its to delete.
* Both writes take the core's module-administration authority — custody, or an
  installed validator contract. There is no separate "hook admin" key to
  compromise.
* This skeleton stores the order but does not enforce proofs itself. Enforcement
  is the job of the hooks it names: each hook validates its own entry of field
  12 through `validateUserOp`/its own dispatch, and the core asserts the array's
  shape.
