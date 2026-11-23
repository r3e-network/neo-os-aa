# HookOrchestratorModule (§14)

Hook order and credential revocation for one SmartAccount account.

The core snapshots the installed hook ids on every operation. It calls pre-hooks
in ascending id order, then post-hooks in reverse order. This management module
can confirm the current order or revoke a validator credential. Installing it
is not required for hooks to run.

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

This module is installed as a validator-type management instance; it does not
sign UserOps. `getHookOrder` reads the current core index. `setHookOrder`
checks the supplied list against that entire index; it cannot omit a hook or
change the protocol order. Installing or removing a hook changes the ordering
immediately for subsequent operations.

Credential revocation calls the core's restricted `revokeModuleCredentials`
entry. The core's module descriptor is authoritative for the generation.
