# Interop descriptor charge and window effect

This is the twentieth selected scope. It covers what the
[interop conversion](AA-INTEROP-CONVERSION.md) lane excludes backward: that
lane's preconditions say the descriptor price "has already been charged" and its
open list admits that only the *absence* of an add-fee step inside the window is
recorded. This lane reads the charge itself out of the pinned C# and stops at the
argument-window effect.

**Status.** `implementationVerified` and `fullImplementationVerified` remain
`false`. This scope does not close an entrypoint and does not model the
conversion, the handler body, or how the fee factor is obtained.

## Pinned inputs

| Key | File | Pin |
| --- | --- | --- |
| `core/engine` | `src/Neo/SmartContract/ApplicationEngine.cs` | `97b08bfe…` at `d10e9ce` |
| `core/descriptor` | `src/Neo/SmartContract/InteropDescriptor.cs` | `84c7d8cc…` at `d10e9ce` |

Both pins are already reviewed by the `syscall-dispatch` lane, so the hashes are
not new evidence; the projection re-checks them on every run.

## What the source says

```csharp
protected virtual void OnSysCall(InteropDescriptor descriptor)
{
    ValidateCallFlags(descriptor.RequiredCallFlags);
    AddFee(descriptor.FixedPrice * _execFeeFactor, false);
    object?[] parameters = new object?[descriptor.Parameters.Count];
    for (int i = 0; i < parameters.Length; i++)
        parameters[i] = Convert(Pop(), descriptor.Parameters[i]);
    object? returnValue = descriptor.Handler.Invoke(this, parameters);
    ...
}
```

and `AddFee` itself:

```csharp
if (gas < 0) throw new InvalidOperationException("AddFee can't be negative.");
if (CurrentContext?.GetState<ExecutionContextState>()?.WhiteListed == true) return;
if (applyFactor) { gas *= FeeFactor; }
_feeConsumed = _feeConsumed + gas;
if (_feeConsumed > _feeAmount) throw new InvalidOperationException("Insufficient GAS.");
```

## The projected record

Fifteen fields, all derived from the text above rather than restated. The order
is the headline field: it is read by locating six anchors in the normalized
`OnSysCall` body and sorting them, so moving any statement changes it.

| Field | Reads |
| --- | --- |
| `step_order` | the six anchors, sorted by position |
| `charge_reads_the_declared_price` | `descriptor.FixedPrice` in the charge call |
| `charge_uses_the_exec_factor` | `_execFeeFactor` in the charge call |
| `charge_skips_the_inner_factor` | the charge call's second argument is `false` |
| `vector_length_from_descriptor` | `new object?[descriptor.Parameters.Count]` |
| `pops_one_item_per_parameter` | `Convert(Pop(), descriptor.Parameters[i])` |
| `arity_from_the_handler_signature` | `Parameters => … Handler.GetParameters() …` |
| `declared_price_type_is_long` | `public long FixedPrice { get; init; }` |
| `declared_price_may_be_zero` | the member's own doc comment |
| `negative_fee_is_rejected` | `if (gas < 0)` plus its throw |
| `whitelist_bypasses_the_charge` | the whitelist `return` sits before the counter |
| `factor_applied_only_when_requested` | `if (applyFactor) { gas *= FeeFactor; }` |
| `consumed_incremented_before_the_limit_check` | counter index < limit-check index |
| `limit_check_is_strict` | `if (_feeConsumed > _feeAmount)` |
| `no_fee_inside_the_conversion_window` | `AddFee` absent from both `Convert` bodies |

`reasonOnlyGuards` lists the two facts read but not mutated: the price member's
identity and where the fee factor comes from.

## What the kernel proves

| Theorem | Claim |
| --- | --- |
| `the_charge_sits_between_the_flag_check_and_the_conversion` | the reviewed order, all three relations at once |
| `a_rejected_call_charges_nothing_when_the_flag_check_comes_first` | a flags rejection pays 0 |
| `a_rejected_call_pays_when_the_charge_comes_first` | the same call pays the full price if the order is moved |
| `the_charge_is_paid_before_the_first_pop` | any conversion fault still leaves the charge applied |
| `a_conversion_fault_does_not_refund_the_charge` | faulting and succeeding charge the same amount |
| `a_conversion_fault_pops_only_the_converted_prefix` | pops = `min (S k) arity` |
| `a_fee_shortfall_pops_nothing` | a refused charge pops nothing |
| `the_charge_does_not_depend_on_the_arity` | two arities, one charge |
| `a_whitelisted_context_pays_nothing` / `…_still_pops` | the bypass skips the fee, not the work |
| `the_factor_is_applied_once_on_the_reviewed_record` | `3 × 5 = 15` |
| `asking_for_the_factor_twice_would_charge_seventy_five` | `15 × 5 = 75` |
| `dropping_the_inner_branch_also_doubles_the_charge` | the same 75 from the other direction |
| `a_zero_price_charges_nothing` | a zero `FixedPrice` is free at this point |
| `the_long_declaration_holds_a_price_above_the_int_range` | `3e9` survives `long`, not `int` |
| `a_zero_price_is_legitimate_on_the_reviewed_record` | zero is declared, not an error |
| `a_negative_fee_is_rejected` | the `-1` edge |
| `the_limit_accepts_a_call_landing_exactly_on_it` | strict `>`, so equality fits |
| `a_call_that_overruns_the_limit_is_refused` | `3 + 3 > 5` |
| `checking_the_limit_before_counting_would_accept_the_overrun` | the counter order matters |
| `the_conversion_window_adds_no_fee` | the window fee is 0 |

35 model declarations, all `Closed under the global context`, no axioms.

## Semantic controls

Sixteen, one per mutant, each moving exactly one projected field (`argument_count`
has no analogue here; every field is mutable). Two of them move the order:

| Control | Field moved |
| --- | --- |
| `charge-before-the-flag-check` | `step_order` |
| `charge-after-the-conversion-loop` | `step_order` |
| `charge-reads-another-price-member` | `charge_reads_the_declared_price` |
| `charge-multiplies-by-the-base-factor` | `charge_uses_the_exec_factor` |
| `ask-add-fee-to-apply-the-factor-again` | `charge_skips_the_inner_factor` |
| `size-the-vector-from-a-constant` | `vector_length_from_descriptor` |
| `convert-every-parameter-from-the-first-descriptor` | `pops_one_item_per_parameter` |
| `take-the-arity-from-an-empty-signature` | `arity_from_the_handler_signature` |
| `narrow-the-declared-price-to-int` | `declared_price_type_is_long` |
| `declare-the-price-always-nonzero` | `declared_price_may_be_zero` |
| `accept-a-negative-fee` | `negative_fee_is_rejected` |
| `charge-a-whitelisted-context` | `whitelist_bypasses_the_charge` |
| `always-apply-the-factor-branch` | `factor_applied_only_when_requested` |
| `check-the-limit-before-counting-the-charge` | `consumed_incremented_before_the_limit_check` |
| `reject-a-call-at-exactly-the-limit` | `limit_check_is_strict` |
| `charge-a-fee-inside-the-conversion-window` | `no_fee_inside_the_conversion_window` |

Each control compiles its `Definitions.v`, then asserts the reviewed observation
in `OriginalBehavior.v` — which must fail — and the negation in
`Counterexample.v`, which must pass `coqchk`. A control that still proved the
reviewed value would mean the field is decorative.

## Three facts this lane forced

1. **`_execFeeFactor` already carries the fee decimals.** The field is built as
   `policyFactor * FeeFactor` (`// Add fee decimals`), which is why the charge
   passes `applyFactor: false`. Passing `true` would square the factor; the
   `charge_skips_the_inner_factor` field and its control exist for that.
2. **The charge is outside the window on purpose.** A conversion fault aborts the
   frame, but the fee was already counted, so it is not refunded. Moving the
   `AddFee` call after the loop is the exact bug the order field forbids, and the
   `charge-after-the-conversion-loop` control shows the charge dropping to 0 on a
   fault when it is moved.
3. **`Fields` polarity, not field names, is what the join must agree on.** The
   first draft named the Coq field `fp_apply_factor` (true = double charge) while
   the projection named the same fact `charge_apply_factor` (true = the source
   passes `false`). The certificate failed with `Unable to unify "canonical_fee"
   with "actual_program"`. The field is now `fp_skips_the_inner_factor` on both
   sides, so `true` means the same thing everywhere.

## Still open

- The arithmetic of `_feeConsumed + gas` at `BigInteger` width, and whether a
  rejected charge surfaces as `OutOfGas` or as the generic invalid operation.
  Which exception that is, and what reaches the contract and the host when one is
  raised, is now its own scope: `AA-EXCEPTION-IDENTITY.md`.
- How `_execFeeFactor` is obtained on each hardfork path (`policy` read, pico
  factor, hardcoded default); only the member identity is recorded.
- Which descriptors declare a zero `FixedPrice`; the lane only proves that the
  declaration permits zero.
- The conversion, the handler body and its return value — those stay in
  `AA-INTEROP-CONVERSION.md`.
- Trusted C# extraction and compiler/CLR correspondence; all 100 public
  entrypoints.

## Running it

```sh
python3 formal/refinement/interop_fee_proofs.py \
  --output-dir /tmp/aa-interop-fee \
  --json-report /tmp/aa-interop-fee/report.json
```

Set `AA_INTEROP_CHARGE_SOURCE_MIRROR` to a directory holding
`core-engine.cs` and `core-descriptor.cs` to work offline; the mirror bytes must
hash to the same pins, so it cannot launder a different artifact.
