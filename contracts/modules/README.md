# Standard modules (spec §11–§15)

These contracts supply governance, recovery, hook ordering and read adapters. Governance stores confirmed custom message rosters and spending policies as well as pending proposals. Recovery keeps its own pending requests. The native core verifies the policy body against its stored reference, verifies messages and enforces the required spending route. See the [storage layout](../../docs/SA-MODULE-PROTOCOL.md).

| Module | Named NEP clause | Installation role | Entry surface |
| --- | --- | --- | --- |
| [GovernanceModule](GovernanceModule/README.md) | [Governance](../../docs/proposals/nep-smartaccount-module-profiles.mediawiki#GovernanceModule) | validator | `proposeConfiguration`, `confirmConfiguration`, `cancelConfiguration`, `getPendingConfiguration`, `unfreezeAccount` |
| [RecoveryModule](RecoveryModule/README.md) | [Recovery](../../docs/proposals/nep-smartaccount-module-profiles.mediawiki#RecoveryModule) | recovery | `beginRecovery`, `cancelReviewedRecovery`, `executeReviewedRecovery`, `getRecoveryPolicySnapshot`, `getRecoveryStatus` |
| [SigningModule](SigningModule/README.md) | [Signing](../../docs/proposals/nep-smartaccount-module-profiles.mediawiki#SigningModule) | validator | `getMessageSubjects`; propose action 9 via governance, verify on core |
| [HookOrchestratorModule](HookOrchestratorModule/README.md) | [Hook ordering](../../docs/proposals/nep-smartaccount-module-profiles.mediawiki#HookOrchestratorModule) | validator | `setHookOrder`, `getHookOrder`, `revokeCredentials` |
| [ThresholdPolicyModule](ThresholdPolicyModule/README.md) | [Threshold policy](../../docs/proposals/nep-smartaccount-module-profiles.mediawiki#ThresholdPolicyModule) | validator | `getThresholdPolicy`; propose action 7 via governance |

The four modules installed as validators here do not approve spending. Each module
publishes its own canonical `getModuleProfile` response. The [common interface
draft](../../docs/proposals/nep-smartaccount-module-interface.mediawiki) defines that
format; the [named interface catalogue](../../docs/proposals/smartaccount-named-module-interfaces.json)
lists the extra methods required for each profile, including plugins outside this directory.

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
