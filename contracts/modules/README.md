# Standard modules (spec §11–§15)

The five contracts in this directory are the **standard user-space modules** of
the SmartAccount protocol. They are ordinary `SmartContract`s: they are installed
into an account through the native core's `installModule`, they are dispatched by
the core as validator or hook instances, and they keep their own policy state in
their own storage.

They are *not* part of the native core. The minimal core (§7) publishes
registration, freeze/unfreeze, execution and module administration — 21 ABI
methods — and deliberately publishes no governance, recovery, message-signing,
hook-order or threshold policy. Those five concerns live here.

| Module | Spec | Kind | Entry surface |
| --- | --- | --- | --- |
| [GovernanceModule](GovernanceModule/README.md) | §11 | configuration module | `proposeConfiguration`, `confirmConfiguration`, `cancelConfiguration`, `getPendingConfiguration`, `unfreezeAccount` |
| [RecoveryModule](RecoveryModule/README.md) | §12 | policy module | `beginRecovery`, `cancelRecovery`, `executeRecovery`, `getRecoveryStatus` |
| [SigningModule](SigningModule/README.md) | §13 | validator module | `isValidSignature`, `updateMessageSubject`, `getMessageSubjects` |
| [HookOrchestratorModule](HookOrchestratorModule/README.md) | §14 | hook module | `setHookOrder`, `getHookOrder`, `revokeCredentials` |
| [ThresholdPolicyModule](ThresholdPolicyModule/README.md) | §15 | validator module | `setThresholdPolicy`, `getThresholdPolicy`, `validateUserOp` |

## Status: skeletons

Every module compiles and carries the published ABI shape, the storage layout
and the authority rules. What a skeleton deliberately leaves to the integrator:

* gas/limit tuning (a real deployment sets its own bounds on caller arrays);
* migration and upgrade entry points (`update`, timelocked NEF replacement);
* the profile JSON a plugin publishes through `getModuleProfile`;
* event indexes and the off-chain indexer that consumes them.

## Shared plumbing

[`Shared/ModuleSupport.cs`](Shared/ModuleSupport.cs) is compiled into every module
project. It holds the two things a module must never re-derive:

* **Protocol constants** — module type codes, phase codes, action codes, the
  validator instance ceiling and the account status codes.
* **Core access and authority** — `getAccount`/`getAccountAddress`/`getModules`/
  `getModule`/`getAuthorizedModuleId` reads, the module-administration witness
  rule (custody, or an installed validator contract), the custody and
  custody-or-recovery gates, and the `installModule`/`removeModule`/
  `unfreezeAccount` transitions.

A module pins its core once, through `setAuthorizedCore`, and can never silently
re-point afterwards; the pin is what makes every recorded policy trustworthy.

## Lifecycle

The core dispatches four callbacks (spec §9, Table 10):

```
onInstall(accountId, moduleId, moduleType, initData)
onUninstall(accountId, moduleId, moduleType, deInitData)
validateUserOp(accountId, operationDigest, operation)      → Boolean
onUserOpComplete(accountId, operation, result)
```

`onInstall`/`onUninstall` are required of every module — the core calls them
inside `installModule`/`removeModule`, so a module that omits them cannot be
installed. Both assert that the caller is the pinned core.

## Build

```
dotnet build contracts/modules/GovernanceModule        -c Release
dotnet build contracts/modules/RecoveryModule          -c Release
dotnet build contracts/modules/SigningModule           -c Release
dotnet build contracts/modules/HookOrchestratorModule  -c Release
dotnet build contracts/modules/ThresholdPolicyModule   -c Release
```

All five are wired into `SmartAccount.sln`, so `dotnet build SmartAccount.sln`
builds them too. Each project sets `RunNccsAfterBuild=false`: a skeleton is a
library until its owner decides to emit a NEF. Flip the property (or pass
`-p:RunNccsAfterBuild=true`) to compile the contract with `nccs`:

```
dotnet build contracts/modules/HookOrchestratorModule -c Release -p:RunNccsAfterBuild=true
```

Every module in this directory has been compiled with the pinned `nccs` through
that property, so the ABI tables in the per-module READMEs are the manifest's
method list, not a reading of the C# sources. (`nccs` lowercases the first
character of a method name: `SetHookOrder` is `setHookOrder` on the wire.)
