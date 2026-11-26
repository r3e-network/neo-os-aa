# HookOrchestratorModule (spec §3)

Hook-order ownership, planner snapshot and credential revocation for one
SmartAccount account.

The core stores the installed hook set but no order. It asks the account's
planner seat for the order of every operation, runs pre-hooks forward and
post-hooks in reverse, pairs each `hookData` value with the instance that
produced it, honours vetoes and sets no per-callback gas budget. This module owns
the order and the immutable snapshot the core reads it from.

## Surface

| ABI | C# | Returns | Authority |
| --- | --- | --- | --- |
| `planHooks(accountId, operationDigest, operation)` | `PlanHooks` | `Array` hookIds | core only, read-only (`[Safe]`) |
| `setHookOrder(accountId, moduleId, hookIds[], expectedRevision)` | `SetHookOrder` | `Void` | core only, configuration frame only |
| `configure(accountId, moduleId, moduleType, configData)` | `Configure` | `Void` | core only, configuration frame only |
| `getHookOrder(accountId)` | `GetHookOrder` | `Array` hookIds | read-only |
| `getHookSnapshot(accountId)` | `GetHookSnapshot` | `Array` snapshot view | read-only |
| `revokeCredentials(accountId, moduleId)` | `RevokeCredentials` | `Void` | custody witness |
| `getCredentialGeneration(accountId, moduleId)` | `GetCredentialGeneration` | `Integer` | read-only |
| `getModuleProfile()` | `GetModuleProfile` | `String` profile JSON | read-only |
| `authorizedCore()` | `AuthorizedCore` | `Hash160` | read-only |
| `setAuthorizedCore(coreContract)` | `SetAuthorizedCore` | `Void` | deployer, once |
| `onInstall(accountId, moduleId, moduleType, initData)` | `OnInstall` | `Void` | core only |
| `onUninstall(accountId, moduleId, moduleType, deInitData)` | `OnUninstall` | `Void` | core only |
| `validateUserOp(accountId, operationDigest, operation)` | `ValidateUserOp` | `Boolean` | core only, read-only |
| `onUserOpComplete(accountId, operation, result)` | `OnUserOpComplete` | `Void` | core only |

The module is installed as a validator-type instance (module type 1) whose
profile declares `hookPlanner: true`, `instanceIsolation: true` and the safe
`planHooks` callback. The core resolves the single planner seat from that
profile; the routing callback never signs UserOps.

## Order writes

**The order can only change inside the native configuration frame.** Both
`setHookOrder` and `configure` call `RequireConfigurationInstance`, which first
authenticates the pinned core as the caller and then requires the core to be
running the configuration phase for this exact instance. An ordinary direct
call is `SA_UNAUTHORIZED`; there is no administration route that reorders hooks
outside a governed `configureModule` action (or the install frame itself).

`configData` is empty (reseed from the installed set, revision + 1),
`[hookIds[]]` or `[hookIds[], expectedRevision]`. `setHookOrder` always takes
the expected revision. A revision that does not match the stored one is
`SA_PROOF_INVALID` ("stale hook snapshot"); a list that is not a permutation of
the installed hook set is `SA_PROOF_INVALID`; more than 8 ids is
`SA_OPERATION_MALFORMED`.

## Planner snapshot

`planHooks` authenticates the core, resolves its own descriptor, asserts that it
is the live `hookPlanner` instance with an unchanged code binding, and answers
the stored order. A stored snapshot whose set no longer equals the installed
hook set is refused instead of being silently re-ordered; with no snapshot the
installed order is returned. The reply is a copy — the caller cannot mutate
module state through it.

`getHookSnapshot` is the opaque read: `[moduleId, revision, digest, order[],
hookSet[]]`, or empty when this contract holds no planner seat. The digest is
`SHA-256` over the bound snapshot fields and the revision is the value an order
write must echo.

**Credential revocation** is immediate and never governance-delayed: it calls
the core's restricted `revokeModuleCredentials`, which bumps the validator
instance's credential generation and the account's configuration nonce in the
same frame. The core's module descriptor (`getModule`) is authoritative for the
generation; `getCredentialGeneration` answers from it (1 for an instance that
was never revoked, 0 for an id never issued to the account).

## Storage

```
0x01 ‖ accountId ‖ moduleId   → serialized snapshot [order[], set[], revision, digest]
```

`onUninstall` deletes the instance prefix and releases the binding. The module
never writes a native prefix and never reads a core roster or order: the
installed hook set comes from `getModules`/`getModule`.

## Notes for integrators

* The module does not run hooks and does not validate hook results; the core
  owns the forward/reverse bracket, veto handling and the transaction's gas limit.
* An account may install hooks without this module; the core then derives the
  order from the installed hook index.
* The native core pins no digest of this artifact: the order is authenticated by
  the configuration frame, not by an artifact pin.
