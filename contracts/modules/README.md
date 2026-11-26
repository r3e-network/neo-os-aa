# Standard modules (spec §3, §9, §10)

These contracts own the policy state the v4.1 native core deliberately does not
store. The authoritative implementation sources are the machine-readable
[v4.1 IDL](../../docs/proposals/smartaccount-v4.1.idl.json) and
[SA-SPEC.zh-CN.md](../../docs/SA-SPEC.zh-CN.md); this file describes the module
side of that closed 27-method native ABI. GovernanceModule holds the pending
governance intents, the 24-hour delay and the 7-day window. RecoveryModule holds
the guardians, the recovery delay and the mature request that lands on
`resetAccount`. SigningModule owns the message domain, the subject roster and the
ERC-1271 replies, and is the only public message-signature entry.
HookOrchestratorModule owns hook order and the planner snapshot.
ThresholdPolicyModule owns the rosters and quorums.

The native core keeps only identity, the custody proxy, nonce channels, the
operation digest, the configuration nonce, execution, the set limits, the
immediate `freezeAccount` / `revokeModuleCredentials` entries and the narrow write
sinks `installModule`, `removeModule`, `configureModule`,
`setBuiltinAuthorization`, `applyConfigurationActions` and `resetAccount`. It
stores no intent, policy, roster, hook order or recovery timelock. See the
[protocol](../../docs/SA-MODULE-PROTOCOL.md): limits and ordering in §3, the
public interface in §9, lifecycle and governance intents in §10.

| Module | Named NEP clause | Installation role | Entry surface (manifest method names) |
| --- | --- | --- | --- |
| [GovernanceModule](GovernanceModule/README.md) | [Governance](../../docs/proposals/nep-smartaccount-module-profiles.mediawiki#GovernanceModule) | validator | declares the `governance` seat; writes: `proposeConfiguration`, `confirmConfiguration`, `cancelConfiguration`, `unfreezeAccount`; reads: `getPendingConfiguration`, `getPendingConfigurationIntentIds`, `getLastCompletion`, `configurationMaturity`, `configurationExpiryWindow`; core only: `onInstall`, `onUninstall`, `validateUserOp`, `onUserOpComplete` |
| [RecoveryModule](RecoveryModule/README.md) | [Recovery](../../docs/proposals/nep-smartaccount-module-profiles.mediawiki#RecoveryModule) | recovery | writes: `beginRecovery`, `cancelRecovery`, `executeRecovery`; reads: `getRecoveryStatus`, `getRecoveryPolicySnapshot`, `getExecutedRecoveryNonce`; the guardians, threshold and timelock arrive through the governed `configure` callback |
| [SigningModule](SigningModule/README.md) | [Signing](../../docs/proposals/nep-smartaccount-module-profiles.mediawiki#SigningModule) | validator | declares `messageCapability` and instance isolation; `isValidSignature` is the sole public message entry (with the safe `validateMessageSignature` preview) and `getMessagePolicy(accountId, moduleId)` the roster read; the roster arrives through the governed `configure` callback — the native core has no `isValidSignature` and publishes no message domain |
| [HookOrchestratorModule](HookOrchestratorModule/README.md) | [Hook order](../../docs/proposals/nep-smartaccount-module-profiles.mediawiki#HookOrchestratorModule) | validator | declares the `hookPlanner` seat and the safe `planHooks` callback; writes: `setHookOrder` (only through the native configuration frame, with the expected revision), `revokeCredentials`; reads: `getHookOrder`, `getHookSnapshot`, `getCredentialGeneration` |
| [ThresholdPolicyModule](ThresholdPolicyModule/README.md) | [Threshold policy](../../docs/proposals/nep-smartaccount-module-profiles.mediawiki#ThresholdPolicyModule) | validator | declares the single composite layer and instance isolation; reads: `getThresholdPolicy(accountId, moduleId)`, `getPolicySnapshot(accountId)`; enrollment and quorum travel through governed `configure` data — the core never reads a roster, weight or quorum |

Every module also publishes `getModuleProfile`, `authorizedCore` and `setAuthorizedCore` (the one-time core pin). The complete compiled manifest of each module, with safe flags, is the [ABI appendix](../../docs/proposals/smartaccount-module-abis.md); it is regenerated from the manifests, not written by hand.

The canonical profile carries four required capability fields (`instanceIsolation`, `messageCapability`, `thresholdMemberEligible`, `compositeLayer`) plus the two optional seats. `governance` is declared by the instance that may land a delayed configuration action, `hookPlanner` by the single instance the core calls for `planHooks`; both are omitted when false and only validators may declare them. `SmartAccountModulePolicy.BindProfileAsync` parses them, rejects a present `false`, and records the descriptor bits the core routes on, so the profile is the only declaration of those seats. The module tests derive their core-double flags from the deployed getter for the same reason: a profile that drops a seat must make its routed callback unauthenticated.

The four validator-type modules here (Governance, Signing, Hook, Threshold) never approve spending: `validateUserOp` returns `false` after authenticating the core. Recovery is a type-5 seat, not a validator route. Each module
publishes its own canonical `getModuleProfile` response. The [common interface
draft](../../docs/proposals/nep-smartaccount-module-interface.mediawiki) defines that
format; the [named interface catalogue](../../docs/proposals/smartaccount-named-module-interfaces.json)
lists the extra methods required for each profile, including plugins outside this directory.

## Shared plumbing

[`Shared/ModuleSupport.cs`](Shared/ModuleSupport.cs) is compiled into every module
project. It holds the two things a module must never re-derive:

* **Protocol constants** — module type codes, phase codes, action codes, the
  validator instance ceiling, the account status codes and the `SA_*` error
  symbols (spec §17).
* **Core access and authority** — `getAccount`/`getModules`/`getModule`/
  `getAuthorizedModuleId` reads, the module-administration rule (see below),
  the custody gates, and the write sinks a module role may reach:
  `unfreezeAccount`, `revokeModuleCredentials` and `resetAccount`. The
  configuration sink `applyConfigurationActions` is called by GovernanceModule
  alone, when it confirms a matured intent. No wrapper exists for
  `installModule`, `removeModule`, `configureModule` or
  `setBuiltinAuthorization`: inside a module those exist only as action codes
  in a reviewed intent batch.

`RequireCustody` gates the module-side proposal surface; the core's own rule for
those write sinks is narrower. Custody may propose; only the account's
code-bound GovernanceModule may commit, and every commit must carry a matured
intent (24-hour delay, 7-day window), fail-closed with `SA_UNAUTHORIZED`:

1. the **caller** is the account's installed GovernanceModule instance, resolved
   through `getModules`/`getModule` and never from a caller-declared value, with a
   recorded code binding (`contractId`, `updateCounter`) that still equals the
   deployed contract;
2. the intent has matured inside the module and has not expired or been consumed;
   and
3. the account is Active — freeze blocks governed writes while custody keeps its
   immediate `freezeAccount` and `revokeModuleCredentials` entries.

A transaction that merely lists a module contract as a signer is not an
administration route. The shared layer keeps no copy of the native
administration rule: `RequireCustody` reads the custody from `getAccount` and
checks that single witness, so a module neither re-derives the mandatory-route
term nor accepts an installed validator as an administration caller (v4.1 has
no such bypass either side, and no native threshold read for modules to
consult, because no threshold policy exists in the native core).

A module pins its core once, through `setAuthorizedCore`, and can never silently
re-point afterwards; the pin is what makes every recorded policy trustworthy.

## Lifecycle

The core dispatches these callbacks (spec §9.1):

```
onInstall(accountId, moduleId, moduleType, initData)
onUninstall(accountId, moduleId, moduleType, deInitData)
configure(accountId, moduleId, moduleType, configData)     (configurable modules only)
validateUserOp(accountId, operationDigest, operation)      → Boolean
onUserOpComplete(accountId, operation, result)
```

The third argument is the module type code (1 validator, 4 hook, 5 recovery); it
is constant for an instance and is never a credential generation. `onInstall` and
`onUninstall` are required of every module — the core calls them
inside `installModule`/`removeModule`, so a module that omits them cannot be
installed. All five modules here take an empty `initData`. Both lifecycle
callbacks assert that the caller is the pinned core.

## Build

```
nccs contracts/modules/GovernanceModule/GovernanceModule.csproj -o <out>
nccs contracts/modules/RecoveryModule/RecoveryModule.csproj -o <out>
nccs contracts/modules/SigningModule/SigningModule.csproj -o <out>
nccs contracts/modules/HookOrchestratorModule/HookOrchestratorModule.csproj -o <out>
nccs contracts/modules/ThresholdPolicyModule/ThresholdPolicyModule.csproj -o <out>
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

The native core holds no per-module digest constant for these modules. It binds
each installed instance when the instance is installed:
`SmartAccountModulePolicy.CaptureCodeBinding` records the deployed contract's hash,
deployment id, update counter and `NefSha256`, and `BindProfileAsync` records the
`ProfileSha256` of the canonical profile. Before an instance is used, the core
re-checks that record against the deployed contract (`AssertCodeBinding`) and
requires the current instance record to carry the same `NefSha256` and
`ProfileSha256` (`AssertInstalledModuleBinding` in
`contracts/native/SmartAccount/SmartAccount.Modules.cs`). A module that is updated
or destroyed and redeployed therefore stops serving the instances recorded against
its earlier bytes; there is nothing to re-pin in the core.
