# Custom Modules (Plugins Behind The Module Gate)

An account is not limited to the modules that ship with the protocol: any contract that implements
the module profile can be installed. The protocol calls these **modules**; the layer that decides
authorization is a **validator** (kind 1), the layer that narrows an accepted operation is a **hook**
(kind 4). Executor (2) and fallback handler (3) are declared unsupported, and an install of either is
rejected rather than silently ignored.

A module never bypasses the core. Installing one changes *who* may authorize or *what* may run — it
does not remove the 24 hour configuration timelock, the hook order, the account freeze, recovery, or
the market settlement sweep.

## The Callback Surface

The core talks to a module through a fixed set of callbacks. A validator implements the validation
pair, a hook implements the pre/post pair, and every module implements lifecycle plus the profile
read:

| Direction | Callback | Contract |
| --- | --- | --- |
| module → core | `getModuleProfile` | Returns the canonical capability profile as a string, at most 2048 bytes, no arguments, no writes. |
| core → module | `onInstall` | Receives account id, module id, credential generation and the install command array. |
| core → module | `configure` | Same argument shape; runs at the configuration phase. |
| core → module | `onUninstall` | Must clear every storage key scoped to that account and module id. |
| core → module | `validateUserOp` | Receives the account id, the core operation digest and the canonical 13-field operation; returns exactly `true` to approve. |
| core → module | `onUserOpComplete` | Receives the sanitized target result; completion phase only. |
| core → module | `preCheck` | Returns this instance's hook data, at most 512 bytes. |
| core → module | `postCheck` | Receives the exact bytes the same instance returned, never another instance's. |
| core → module | `isValidSignature` | Only for a module that declares the message capability; verifies an ERC-1271 style digest. |

`getModuleProfile`, `validateUserOp` and `isValidSignature` must be declared safe, so a caller that
passes write flags still cannot write from them. Hook pre/post are write-capable by design — they
meter balances — but they run with their own instance keys only.

Replies are typed, not coerced. A validation reply that is not exactly `true` is a denial, and a
validation reply of the wrong type is an ABI violation in both the preview and the execution path. A
message-signature reply that is not a boolean counts as `false`, because ERC-1271 has to fail closed.

## Instance Isolation And Code Binding

An instance is identified by `(accountId, moduleId)`, never by the contract address. The same contract
can therefore be installed more than once on one account — one session key per bot, for example —
but only when the profile declares instance isolation. Without that declaration the core allows at
most one instance per account and module kind.

Every module resolves its own instance instead of trusting the caller: it checks that the caller is
the authorized core, and the core answers with the module id it is currently addressing for the phase
(validation, hook pre, target dispatch, hook post, completion, configuration). During the read-only
preview the module uses the validator id carried inside the operation itself.

Binding at install is a code check, not a promise:

1. the profile digest is recorded,
2. the profile is parsed for version, module type, contract name and capabilities,
3. the complete callback surface is verified before the instance row is written.

A missing callback fails the install. A profile that claims a kind the core does not support fails the
install. Neither case leaves a half-written instance behind.

## How To Install A Custom Module

Custom modules are installed by intent, exactly like the shipped ones — there is no separate trusted
path:

```javascript
const script = buildConfigurationScript({
  accountId,
  actions: [
    installModule({ type: 1, hash: customValidatorHash, data: ['setPublicKey', publicKey] }),
  ],
});
```

The account id, the read set and the action digest are bound when the intent is proposed; maturity is
24 hours and expiry is seven days after maturity. Confirmation re-requires the custody witness, and a
multi-action intent commits atomically — batching actions into one intent never shortens the timelock.

The install data, configure data and uninstall data are `[command, ...args]` arrays. The core only
enforces the array bound and the lifecycle gas budget: each module owns the meaning of its own
commands, which is why a custom module can add a command without a core upgrade.

## Removing A Custom Module

Uninstall with an `uninstallModule` action and expect `onUninstall` to clear the instance's keys. An
uninstalled module id is never reused, so calls, signatures and pending intents addressed to the old
instance cannot re-attach to a replacement.

Uninstalling the last validator does not leave an owner-less account: the built-in route always
exists, gated by the default policy, and the same intent must enable it. Hooks keep running. Only a
matured recovery removes every module and policy, and it does so callback-free.

## What A Custom Module Cannot Do

- It cannot grant itself a bigger gas budget than the lifecycle budget.
- It cannot touch another instance's storage keys.
- It cannot replace the core as the caller, and a non-core caller is refused.
- It cannot skip the hook order: a hook's `preCheck` runs forward and `postCheck` runs in reverse over
  the same snapshot, so a re-entrant configuration change cannot alter the in-flight sequence.
- It cannot authorize execution through sponsorship: the paymaster funds the relay and never
  authorizes.

## Renamed From The Verifier Era

If you are porting a plugin written for the previous protocol generation, the interface name changed
and the semantics narrowed:

| Earlier plugin | Current module |
| --- | --- |
| `MultiSigVerifier` | `MultiSigValidator` — a threshold policy; orchestration and receipts are core-owned |
| `SessionKeyVerifier` | `SessionKeyValidator` — one credential set per instance |
| `SubscriptionVerifier` | `SubscriptionValidator` |
| `Web3AuthVerifier` | `Web3AuthValidator` |
| `Web3AuthnVerifier` | `P256Validator` — raw P-256, no WebAuthn ceremony claim |
| `TEEVerifier` | `TeeKeyValidator` — configured enclave-key verification only |
| `ZkLoginVerifier` | `DelegatedIdentityValidator` — configured signer plus identity binding, no general zero-knowledge claim |
| `NeoNativeVerifier` | `NeoWitnessValidator` |
| `MultiHook` | retired; the migrated order lives in the core hook order list |
| `ZKEmailVerifier` | disabled template; every callback fails closed |
