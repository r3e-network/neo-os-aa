# AA Verifier Gas-Budget Extension

**Status:** Draft platform-extension proposal  
**Date:** 2026-09-20  
**Scope:** NeoVM / DevPack capability required by the Neo N3 AA profile

## Abstract

The current NeoVM `System.Contract.Call` operation executes a child contract
inside the caller's transaction gas budget, but it does not expose a
non-bypassable budget for one untrusted child call. An AA account that invokes
an arbitrary verifier therefore cannot put an independent upper bound around
`validateSignature`.

This proposal adds `System.Contract.CallWithGasLimit`. It is a platform
capability, not an AA contract-local accounting convention. The capability
assigns a child budget that is enforced by the execution engine and inherited
by all descendants. It is intended to let the AA core call a verifier without
allowing that verifier to consume the whole transaction budget.

The implementation has been prototyped in isolated Neo core and DevPack
worktrees. The current `neo-os-aa` artifact still uses the published
`Neo.SmartContract.Framework` 3.9.1 surface and does **not** claim to use this
syscall until the platform dependency is versioned, activated, compiled into
the AA contract, and read back from a node.

## Motivation and threat model

`Runtime.GasLeft`, a verifier-supplied `BurnGas` convention, a transaction gas
limit, or a pre-call estimate does not cap an already executing child call.
Those mechanisms either remain voluntary or bound the complete transaction.
The threat is a malicious or defective verifier that performs expensive VM
work and makes the account or relay path unusable.

The required property is:

> For a bounded call with limit `L`, every billable resource charge produced by
> the target and its descendants is charged to `L`; once `L` is exhausted, the
> invocation faults and its state changes are rolled back by normal Neo
> application-engine atomicity.

This proposal does not make an arbitrary verifier correct, honest, or
cryptographically secure. It bounds resource consumption only.

## Normative syscall ABI

```text
System.Contract.CallWithGasLimit(
    scriptHash: Hash160,
    method: String,
    flags: CallFlags,
    gasLimit: Integer,
    args: Array
) -> Any
```

The DevPack declaration is:

```csharp
[Syscall("System.Contract.CallWithGasLimit")]
public static extern object CallWithGasLimit(
    UInt160 scriptHash,
    string method,
    CallFlags flags,
    long gasLimit,
    params object?[]? args);
```

The `gasLimit` parameter is in datoshi, the same public unit used by
`Runtime.GasLeft`. The engine converts it to its internal femtoGAS accounting
unit using the active fee and opcode multipliers. A caller MUST NOT pass a
negative or zero limit. A limit greater than the remaining transaction budget
MUST be rejected before the child context is created.

The syscall preserves the ordinary `Contract.Call` checks:

- the target contract must exist;
- the method must be a public ABI method and MUST NOT start with `_`;
- the argument count must match the ABI;
- the call flags must be valid and permitted by the caller;
- hardfork activation MUST be checked by the execution engine.

## Budget semantics

1. The engine creates a private budget `B = (limit, parent)` for the child.
2. Every billable charge in the child is charged to `B` and every ancestor
   budget in the parent chain before the charge is committed.
3. An ordinary nested `System.Contract.Call` inherits the current budget.
4. A nested `CallWithGasLimit` creates a new child budget, but charges still
   pass through all enclosing budgets. A descendant cannot escape an ancestor
   limit by selecting a new limit.
5. Fee-whitelisted execution still consumes the budget. Whitelisting can
   suppress transaction charging, but MUST NOT disable the safety budget.
6. Budget exhaustion faults the invocation. The fault is not converted to a
   Boolean failure or a successful empty result.
7. The existing Neo transaction/application rollback rules apply to state,
   notifications, and nonce changes when the bounded call faults.
8. A completed bounded call does not consume a sibling's independent budget;
   only the enclosing transaction budget and any still-active ancestor budget
   remain applicable.

The budget is an execution-engine object, not contract storage. Contracts MUST
NOT be able to read, mutate, or reset another call's budget.

## AA integration profile

After the platform capability is activated, the AA core SHOULD replace the
verifier dispatch with the following exact operation:

```csharp
Contract.CallWithGasLimit(
    state.Verifier,
    "validateSignature",
    CallFlags.ReadOnly,
    verifierGasLimit,
    accountId,
    op);
```

The verifier limit MUST be a protocol constant or an account/profile value
with a documented upper bound. It MUST NOT be supplied by an untrusted
operation without an independent maximum. The result MUST still be checked as
the Boolean authorization result, and all existing nonce, hook, execution-lock
and rollback rules remain in force.

The AA profile MUST publish:

- the default and maximum verifier limit;
- whether the limit covers verifier initialization and callback work;
- the gas unit and fee-factor interpretation;
- the fault and rollback behavior;
- the minimum Neo hardfork activation;
- the exact NEF and manifest hashes after compilation.

## Activation and compatibility

The prototype registers the syscall behind `Hardfork.HF_Iara`. Nodes that have
not activated the hardfork MUST reject the syscall rather than silently
executing an unbounded call. A contract compiled with the new syscall therefore
requires an activation-aware deployment plan and MUST NOT be advertised as
backwards-compatible with nodes that lack the syscall.

Required dependency sequence:

1. Merge and version the Neo core execution-engine implementation.
2. Publish the matching DevPack syscall declaration and compiler support.
3. Activate the hardfork on the target network and verify node configuration.
4. Compile the AA core against the matching DevPack.
5. Run the AA runtime, formal-boundary, and NeoExpress readback gates.
6. Compare C# source, NEF bytes, manifest bytes, and deployed RPC readback.

## Verification vectors

The platform implementation MUST pass at least these vectors:

- child exceeds its limit and faults;
- ordinary nested `Contract.Call` remains bounded by the ancestor;
- nested bounded calls cannot escape the ancestor;
- a child within its limit succeeds;
- zero, negative, and transaction-budget-exceeding limits are rejected;
- fee-whitelisted child execution still consumes the budget;
- target state and notifications roll back on budget exhaustion;
- the syscall is unavailable before hardfork activation.

The current isolated prototype passes all seven engine vectors listed in the
platform receipt, including child-state rollback and pre-hardfork syscall
rejection, plus the compiler emission smoke test. The whitelist, rollback in
the integrated AA core, hardfork activation, AA-core integration, and
deployed-node readback vectors remain required before this proposal can be
marked implemented.

## Security and coverage boundary

This extension closes only the independent resource-budget design gap. It does
not prove verifier cryptography, witness parsing, complete NeoVM semantics,
callback correctness, plugin storage cleanup, or MultiSig key independence.
Those remain separate AA and platform assurance obligations.

## Current implementation status

| Gate | Result |
| --- | --- |
| Neo core prototype | Implemented in isolated worktree |
| Neo core targeted vectors | 7/7 passed |
| Neo core full unit suite | 1,433/1,433 passed |
| DevPack framework build | Passed |
| DevPack compiler syscall smoke | Passed |
| DevPack compiler unit suite on published core | 1,359/1,359 passed |
| Published DevPack framework suite | Blocked by the expected core-package version mismatch until the matching Neo package is published |
| Current AA source uses syscall | No |
| Current AA artifact uses syscall | No |
| Private NeoExpress with syscall-enabled AA | Not yet run; current local readback is for the pre-extension artifact |
| Public network activation/readback | Not performed |

Until the remaining integration gates pass, VULN-001 remains open for the
currently deployed AA artifact. This document is intentionally not a claim of
production security.
