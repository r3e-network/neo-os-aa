# Recovery plugins

> **Status of `SocialRecoveryService` (7 `SocialRecoveryService*.cs` partials): pre-v4, NOT deployable on the v4 native core.**
> It was written for the retired custom kernel and is kept only as history. On the current
> native stack (`contracts/native/SmartAccount`, protocol v4) it cannot run:
>
> * it calls `beginRecovery`, `executeRecovery`, `cancelRecovery` and `getRecoveryStatus` **on the core**,
>   but in v4 recovery is the `RecoveryModule`'s job and the core exposes none of these entries
>   (protocol §9: "the core exposes none of them"). The first submitted recovery ticket faults at
>   `Contract.Call(core, "beginRecovery", ...)` (`SocialRecoveryService.Lifecycle.cs`);
> * it expects the old status layout `[pending, ..., generation, newCustody]`
>   (`status[3]` generation, `status[4]` new custodian). The standard seat's
>   `RecoveryModule.getRecoveryStatus` answers `[nonce, custodian, startedAt, executableAt, status,
>   newCustody, authorityEpochAtInit]`, and it is a different contract, not the core;
> * the core's `resetAccount` admits only the account's installed, code-bound recovery seat
>   (module type 5), never this service;
> * `SocialRecoveryService.csproj` does not compile on its own (the project lists only the seven
>   partials; `ActionSessionValidator` artifacts are emitted from `ActionSessionValidator.csproj`).
>
> Do not use it as evidence for current behaviour, install it, or build a profile on it. The named-profile
> catalogue lists it as external and not covered
> (`docs/proposals/nep-smartaccount-module-profiles.mediawiki`). Delayed recovery on v4 is the standard
> `contracts/modules/RecoveryModule`.

| Contract | Role | State |
| --- | --- | --- |
| `ActionSessionValidator` | validator, standalone route only | current, named profile `ActionSessionValidator` |
| `SocialRecoveryService` | external recovery oracle service (pre-v4) | not deployable on v4, not wired |

## ActionSessionValidator — permission boundary

`validateUserOp` approves on either of two transaction witnesses, and only on a standalone route
(`operation[validatorId] == moduleId`; on a threshold route it returns `false`):

1. **the account's recovery authority** as recorded by the core (`getAccount(accountId)[3]`). This
   branch has no target, method, value or time scope: an installed instance makes the recovery
   authority an immediate spending key that does not wait for the recovery delay.
2. **the executor** reported by the configured service (`GetAuthorizedSessionExecutor(accountId)`).
   The validator reads an address, never an expiry or a scope, so the service's own session lifetime
   is the only time limit.

The instance is not a recovery seat, not a threshold member and not proof of an elapsed reset delay.
A wallet must present it with that boundary; see the `ActionSessionValidator` clause of the
named-profile catalogue.
