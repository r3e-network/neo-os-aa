# SmartAccount Proposal Relationship and Protocol Scope

**Review date:** 2026-09-21
**Purpose:** Record the relationship between the existing Neo SmartAccount proposals and the protocol boundary of the revised foundation.
**Status:** Editorial and architectural guidance; not a NEP assignment, implementation claim, or community decision.

## 1. Existing proposal history

| Identifier | Title | Status | Protocol relationship |
|---|---|---|---|
| [#165](https://github.com/neo-project/proposals/pull/165) | New Proposal: add meta transaction proposal | Closed, not merged | Historical motivation; does not define the current operation or witness model. |
| [#218](https://github.com/neo-project/proposals/pull/218) | Draft: Contract-based Verification Script Standard | Open | Generic witness-script layer; remains independent of the SmartAccount execution state machine. |
| [#219](https://github.com/neo-project/proposals/pull/219) | Draft: Transferable Abstract Account Standard | Closed, not merged | Optional control-transfer extension. |
| [#220](https://github.com/neo-project/proposals/pull/220) | Draft: Abstract Account Metadata Standard | Closed, not merged | Optional presentation and discovery extension. |
| [#221](https://github.com/neo-project/proposals/pull/221) | Draft: Abstract Account Entry Contract and Custom Verifier Standard | Closed, not merged | Direct predecessor of the revised protocol foundation. |
| [#242](https://github.com/neo-project/proposals/issues/242) | Proposal: Neo Native SmartAccount Standard | Open issue | Native SmartAccount profile that may build on the foundation. |
| [#243](https://github.com/neo-project/proposals/pull/243) | Draft: SmartAccount Protocol Foundation for Native SmartAccount | Draft PR | Current deployment-independent protocol foundation. |

Closed proposals are historical references. Closed status must not be interpreted as either adoption or formal rejection by the Neo protocol.

## 2. Protocol layering

The proposals have three distinct layers:

1. **Generic witness layer - #218.** Defines reusable contract-based verification-script behavior. It must remain generic with respect to method names, argument counts, and invocation data.
2. **SmartAccount protocol foundation - #243.** Defines UserOperation encoding, account identity, replay protection, verifier and hook lifecycle, callback authority, execution ordering, failure semantics, witness bridging, and module resource boundaries.
3. **Native SmartAccount profile - #242.** Defines the node-native identity, activation, fee and resource schedule, governance, state model, and migration rules required by a native contract.

Transferable ownership, metadata, marketplaces, paymasters, and application-specific authorization schemes are extensions. They must not silently become prerequisites of the foundation.

## 3. Corrections carried into the foundation

The revised foundation resolves the following protocol ambiguities from the earlier draft:

- `executeUserOp` and `executeUserOps` replace the earlier implementation-specific entrypoint names as the foundation's canonical operation interfaces.
- `accountId`, `coreHash`, and the verification-script-derived asset address are distinct identifiers. A profile must publish byte-order and address-derivation vectors.
- Authorization commits to the protocol domain, network, core, account, target, method, exact arguments, nonce, and deadline. A caller-supplied signer list is not proof of authorization.
- `validateSignature` is read-only and returns a Boolean. An installed verifier must also implement `postExecute`; a no-op is permitted, an absent method is not.
- Execution order is normative: validation, authorization, nonce consumption, pre-hook, target call, post-hook, verifier post-callback, event emission, and cleanup.
- Failed authorization, callback, or target execution must not commit target state or nonce consumption. A target Boolean `false` is not automatically a VM fault.
- Every verifier callback must run under a platform-enforced child resource budget independent of the enclosing transaction budget. Nested calls inherit ancestor budgets, fee whitelists do not bypass them, and exhaustion is fail-closed and atomic. Hook callbacks must also have finite documented resource bounds.
- Module type identifiers in lifecycle events are strings (`"verifier"` and `"hook"`), not canonical integer values.
- Verification-trigger witness validation and application-trigger UserOperation authorization are separate mechanisms and must not depend on temporary application state.
- Changing verification-script bytes or call flags changes the derived address and therefore requires an explicit migration rule.

## 4. Native SmartAccount obligations

A native proposal must not copy ordinary deployed-contract assumptions into a node-native specification. It must define, independently:

- native contract identity and address;
- consensus activation and ABI-version policy;
- account creation, binding, recovery, custody, and revocation transitions;
- canonical serialization, signing profiles, and conformance vectors;
- GAS charging and non-bypassable resource accounting for all external callbacks;
- governance, upgrades, emergency controls, and authority separation;
- deterministic storage and state migration;
- compatibility for existing accounts, verification-script addresses, and assets.

A deployed contract, its bytecode, its administrator, or its private-chain test results do not establish that a node-native SmartAccount contract has been activated or specified.

## 5. Scope and evidence boundary

The foundation is a protocol document. It does not prescribe a source language, contract layout, bytecode format, syscall name, hardfork name, or deployment topology. A conforming implementation must publish its profile parameters and pass reproducible vectors for encoding, authorization, replay, callback authority, resource exhaustion, rollback, witness scopes, and migration where applicable.

Implementation tests, private-chain execution, formal models, and artifact readback are evidence for an implementation or profile. They are not substitutes for the protocol's normative definitions, cross-client vectors, consensus activation, or independent review.

## 6. Editorial action

The revised English protocol text is maintained in [`nep-aa-entry-verifier.mediawiki`](./nep-aa-entry-verifier.mediawiki) and is synchronized with the file proposed in PR #243. The native-profile issue should reference the foundation and state its additional obligations instead of repeating implementation-specific account, administrator, proxy-script, or deployment claims.

This document does not reopen #221 and does not modify the scope of #218, #219, or #220.
