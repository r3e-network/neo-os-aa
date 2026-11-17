# Contract-internal handoff (kernel-checked, eighteenth gate scope)

**Status: registered as the eighteenth closure scope**
(`contract-internal-handoff-and-frame-construction`). `ContractHandoff.v` is a
kernel-checked model, `ContractHandoffArtifact.v` is a certificate bound to the
projected record, and 21 semantic controls re-check one pinned decision each.
None of this closes an entrypoint: the lane ends at the context `LoadContract`
returns, before the callee executes. `implementationVerified` and
`fullImplementationVerified` stay `false`.

> Backward: the step that turns the caller's stack window into this call's
> arguments is the nineteenth scope, `interop-argument-conversion` — see
> `docs/AA-INTEROP-CONVERSION.md`.

## Why this layer

`formal/coq/EntryDispatch.v` declares that its entry is *after* interop
admission and argument conversion. The `syscall-dispatch` lane
(`docs/AA-SYSCALL-ADMISSION.md`) covers admission and stops at the
`CallContractInternal` parameter tuple. This lane starts there: the second
`CallContractInternal` overload and the frame that `LoadContract` builds. It
stops at the constructed context, before any instruction of the callee runs.

## Pinned inputs (neo `d10e9cee`, neo-vm `004cd607`)

| Key | Declaration |
| --- | --- |
| `core/engine` | `CallContractInternal` (both overloads), `LoadContract`, `LoadScript` |
| `core/abi` | `ContractAbi.GetMethod(name, pcount)` |
| `core/basic` | `ContractBasicMethod.Initialize`, `InitializePCount` |
| `core/flags` | `CallFlags` members |
| `core/method` | `ContractMethodDescriptor.ReturnType/Offset/Safe` |
| `core/contract-state` | `ContractState.CanCall` |
| `core/policy` | `PolicyContract.IsBlocked` |
| `vm/context` | `ExecutionContext.Clone(int)` |
| `vm/stack` | `EvaluationStack` |

`ApplicationEngine.cs` from the pinned tarball is byte-identical to the copy the
entry-dispatch lane pinned, which is how the other four neo files were
authenticated before being pinned here.

## What the projection derives rather than asserts

- `safe_mask_drops` is read off the mask expression and evaluated against the
  `CallFlags` declaration itself: `WriteStates | AllowNotify = 10`. A widened or
  narrowed mask cannot pass.
- `increment_step` is read off the `TryGetValue` branch and the `else` branch is
  required to agree (`= 1` from an empty counter), so "increment by one either
  way" is checked rather than assumed.
- `initializer_name_is_canonical` and `initializer_pcount` come from
  `ContractBasicMethod`, not from the call site.
- `lookup_is_arity_keyed` comes from the dictionary construction
  `(p.Name, p.Parameters.Length)` in `GetMethod`.

## Two classes of guard

**Reason-only, never mutated.** Removing them still faults on the same input, so
a mutant would keep the same outcome and prove nothing:

| Guard | Why removal still faults |
| --- | --- |
| `contract is null` | the next statement dereferences `contract` |
| `md is null` | the next statement dereferences `md` |
| `args.Count != method.Parameters.Length` | every reachable caller reached this overload through `GetMethod(name, args.Length)`, which is keyed on `(Name, Parameters.Length)`, so the equality already holds |
| `hasReturnValue ^ (ReturnType != Void)` | every reachable caller derived `hasReturnValue` from the same ABI descriptor |

The last two are the interesting ones: they are *unreachable as failing* on all
three call sites (`CallContract`, `OnCallT`, `CallFromNativeContractAsync`), so
they are modelled as unconditional faults instead of mutable predicates.

**Discriminating, mutated.** 21 controls, each changing exactly one projected
field, with all 18 derived fields covered:

`drop-blocked-gate`, `mask-nothing`, `mask-read-states`, `mask-everything`,
`drop-authorization-gate`, `authorize-the-callee`, `increment-twice`,
`skip-increment`, `hand-off-raw-flags`, `drop-calling-context`,
`drop-whitelisted-fee`, `whitelist-keeps-flag-false`, `push-in-order`,
`swap-rvcount`, `zero-offset`, `share-the-contract`, `drop-initializer-frame`,
`drop-snapshot-clone`, `lookup-by-name-only`, `initializer-pcount-one`,
`initializer-renamed`.

## What the kernel proves

`formal/refinement/coq/ContractHandoff.v` — 42 closed declarations, all
`Closed under the global context`, `coqchk -silent` clean:

| Group | Declarations |
| --- | --- |
| Rejection order | `blocked_rejects`, `unauthorized_rejects`, `arity_mismatch_never_accepts`, `arity_precedes_return`, `return_mismatch_rejects`, `authorization_precedes_arity`, `blocked_precedes_authorization` |
| Counter placement | `blocked_counter_is_untouched`, `unauthorized_counter_is_untouched`, `arity_rejection_after_the_increment`, `return_rejection_after_the_increment`, `accepted_counter_is_incremented` |
| Acceptance | `accepted_frame_records_the_call`, `safe_method_skips_authorization` |
| Flag algebra | `handed_flags_are_the_intersection`, `handed_flags_do_not_exceed_the_caller`, `raw_handoff_can_exceed_the_caller`, `mask_removes_the_projected_bits` |
| Frame contents | `rvcount_is_zero_for_void`, `rvcount_is_one_for_non_void`, `swapped_projection_inverts_the_void_case`, `offset_is_the_method_offset`, `contract_fields_are_copied`, `snapshot_cache_is_cloned`, `calling_context_points_at_the_caller`, `stack_is_the_reverse_of_the_argument_vector`, `reverse_preserves_the_argument_count`, `whitelisted_fee_is_charged`, `no_whitelist_no_fee` |
| Initializer frame | `initializer_adds_one_frame`, `no_frame_without_the_lookup`, four component theorems |

`ContractHandoffArtifact.v` — 19 declarations: the projected record equals
`canonical_handoff`, the derived constants (`safe_mask_drops = 10%N`,
`increment_step = 1`, `initializer_pcount = 0`, the name/arity/flag/frame
inputs), and the same rejection, acceptance and frame theorems instantiated at
the record the source produced rather than at the reviewed literal.

Two facts about the encoding are worth stating, because both were found by the
kernel rather than by reading:

- `Bool.eqb` matches on its first argument only, so `Bool.eqb b b` does not
  reduce for an unknown `b`; `eqb_diag` is needed before the return-type guard
  can be discharged.
- The `andb` chain in `initializer_lookup_succeeds` is left-stuck on a variable,
  so `andb X false` does not reduce. `no_frame_without_the_lookup` does the
  single case split the four component theorems would otherwise each repeat.

A third was found by a test: `1 == True` in Python, so the projected record is
compared by type as well as value (`literal_equal` in `closure.py`, and
`NUMERIC_FIELDS` in the renderer). A boolean slot holding `1` is a different
record, not the reviewed one.

## Facts this layer records

- The counter is incremented **before** the arity and return-type checks, so a
  call that is rejected for either reason has already consumed a counter slot.
  A blocked call and an unauthorized call have not.
- `flags & callingFlags` is applied at the `LoadContract` call, so the callee's
  `CallFlags` are bounded by both the requested word and the caller's own word.
  `CallContract` hands over `md.ReturnType != Void` derived from the same
  descriptor, while `OnCallT` hands over the token's `HasReturnValue`.
- `LoadContract` copies the contract fields into a fresh `ContractState` and
  clones the snapshot cache; `ExecutionContext.Clone` shares the *shared states*
  object, so the `_initialize` frame sees the same `ExecutionContextState`.
- `rvcount` is `0` exactly for `Void` and `1` otherwise; the initial position is
  `method.Offset`, and the argument vector is pushed in reverse.

## Still open

- `AddFee`, gas, resource limits and every exception type; a `Rejected`
  constructor is a fault, not a .NET exception identity.
- Storage reads behind `IsBlocked`, `IsWhitelistFeeContract`, `GetContract` and
  manifest/ABI loading; only their answers are inputs.
- Stack/static-field sharing, reference counters and `Dispose` ordering inside
  `LoadScript`/`CreateContext`.
- Trusted C# extraction and compiler/CLR correspondence; execution inside the
  constructed context; all 109 public entrypoints.

## Running it

```sh
# Projection only.
AA_CONTRACT_HANDOFF_SOURCE_MIRROR=/path/to/pinned/cs \
python3 -c "import contract_handoff_source as s; print(s.project_production('/tmp/handoff')['program'])"

# Model, certificate and all 21 controls.
AA_CONTRACT_HANDOFF_SOURCE_MIRROR=/path/to/pinned/cs \
python3 contract_handoff_proofs.py --output-dir /tmp/handoff/out \
    --json-report /tmp/handoff/report.json
```

The mirror is transport only: its bytes must hash to the same pins a download
would have to reach.
