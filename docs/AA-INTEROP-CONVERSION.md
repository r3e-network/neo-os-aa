# Interop argument conversion (kernel-checked, nineteenth gate scope)

**Status: registered as the nineteenth closure scope**
(`interop-argument-conversion`). `InteropConvert.v` is a kernel-checked model,
`InteropConvertArtifact.v` is a certificate bound to the projected record, and 18
semantic controls re-check one pinned decision each. None of this closes an
entrypoint: the lane ends at the converted argument vector, before the handler
body runs. `implementationVerified` and `fullImplementationVerified` stay
`false`.

## Why this layer

The `syscall-dispatch` lane (`docs/AA-SYSCALL-ADMISSION.md`) covers admission and
stops at the `CallContractInternal` parameter tuple; the `contract-handoff` lane
(`docs/AA-CONTRACT-HANDOFF.md`) starts inside the callee. Between them sits the
step that both lanes exclude: `OnSysCall` turning the caller's stack window into
the invoked handler's arguments, one `Convert(Pop(), ...)` per declared argument.

## Pinned inputs (neo `d10e9cee`, neo-vm `004cd607`)

| Key | Declaration |
| --- | --- |
| `core/engine` | `OnSysCall`, `Convert(object?)`, `Convert(StackItem, InteropParameterDescriptor)` |
| `core/contract` | the `CallContract` declaration, read for its four arguments |
| `core/interop-parameter` | `InteropParameterDescriptor` (the `IsArray` member, the converter table, the constructor) |
| `vm/limits` | `ExecutionEngineLimits.MaxStackSize` |

`ApplicationEngine.cs` from the pinned tarball is byte-identical to the copy the
entry-dispatch lane pinned, which is how the other three files were
authenticated before being pinned here.

## What the projection derives rather than asserts

- `counted_branch_max_length` is **evaluated** from the initializer expression
  (`2 * 1024 = 2048`), so a widened limit cannot pass silently.
- `array_branch_excludes_byte_element` is read off the `IsArray` declaration
  itself (`Type.IsArray && Type.GetElementType() != typeof(byte)`), not restated.
- `argument_count` is the arity of the pinned `CallContract` declaration, and the
  four argument types and names travel with it in `parameters`.
- The three converter-keying facts (`array_element_converter_from_element_type`,
  `enum_converter_from_underlying_type`, `identity_converter_for_plain_array`)
  are read from the constructor branch and the converter table, not assumed.

## Two classes of guard

**Reason-only, never mutated.** Removing them still faults on the same input, so
a mutant would keep the same outcome and prove nothing:

| Guard | Why removal still faults |
| --- | --- |
| `ValidateCallFlags(descriptor.RequiredCallFlags)` | the same call was already admitted by the dispatcher with these flags, so the call cannot reach here with a word the guard would reject |
| `descriptor.Validate(item)` | every reachable descriptor in this window was built with validators that the converter immediately re-checks on the same item |

## What the kernel proves

Nineteen field facts (one theorem per projected field) plus thirty structural
theorems. The ones that carry weight:

| Theorem | Claim |
| --- | --- |
| `the_vector_has_one_slot_per_declared_argument` | the argument vector has exactly one slot per declared argument, whatever the branches do |
| `conversion_never_grows_the_window` | converting one argument never adds an item to the window |
| `the_window_shrinks_by_the_arity` | with one pop per argument the window shrinks by at least the arity |
| `byte_element_leaves_the_array_branch` | a byte element leaves the array branch, and only because the field says so |
| `byte_array_arguments_differ_across_the_branch` | the same byte-array argument converts to a byte span on one side and to an array on the other, so the exclusion is observable |
| `counted_length_above_the_limit_faults` | a counted length **strictly** above the limit faults |
| `counted_length_at_the_limit_is_accepted` | the limit itself is accepted — the comparison is `>`, not `>=` |
| `counted_length_one_above_the_limit_faults` | the successor of the limit faults, which fixes the boundary from the other side |
| `counted_branch_takes_exactly_the_count` | the counted branch converts exactly the prefix it was told to |
| `counted_items_stay_when_the_pop_is_dropped` | dropping the pop leaves the counted items on the caller's window |
| `a_null_argument_faults_when_the_check_is_on` / `a_nullable_argument_accepts_null` / `a_stack_item_argument_accepts_null` | the null guard is the conjunction of three conditions, and each one alone can defeat it |
| `a_null_payload_element_faults` / `a_null_counted_element_faults` | both array branches reject a null element, and the counted branch reads it off the caller's window |
| `an_unknown_type_goes_to_the_interface` / `dropping_the_interface_flag_leaves_no_converter` | an unnamed type is reached through the interface converter, and dropping the flag leaves no converter at all |
| `a_void_return_pushes_nothing` / `a_value_return_pushes_one_item` | the return push is conditional on the handler's return type |
| `returned_nulls_are_dropped` | `OfType<object>()` drops the null elements of a returned array |

Every declaration is `Closed under the global context`; `coqchk -silent` passes;
no `Admitted`, `Axiom`, `Abort` or `Parameter` appears in the model.

## The eighteen controls

One textual mutation of the pinned source each, and each must change **exactly
one** projected field. Eighteen of the nineteen fields are covered this way; the
arity is the exception on purpose (see below).

| Control | Field it moves |
| --- | --- |
| `read-arg-count-from-the-stack` | `argument_count_from_descriptor` |
| `pop-twice-per-parameter` | `pops_one_item_per_parameter` |
| `fill-parameters-backwards` | `pop_order_is_reversed` |
| `push-void-return` | `return_pushes_only_for_nonvoid_handler` |
| `keep-null-return-elements` | `return_payload_drops_nulls` |
| `include-byte-arrays` | `array_branch_excludes_byte_element` |
| `convert-elements-with-the-array-converter` | `array_element_converter_from_element_type` |
| `convert-enums-as-integers` | `enum_converter_from_underlying_type` |
| `unknown-types-are-not-interfaces` | `unknown_type_is_interface` |
| `copy-plain-array-elements` | `identity_converter_for_plain_array` |
| `payload-length-is-not-the-item-count` | `payload_branch_length_is_item_count` |
| `fill-payload-elements-backwards` | `payload_branch_fills_in_index_order` |
| `fill-counted-elements-backwards` | `counted_branch_fills_in_index_order` |
| `keep-the-counted-items-on-the-stack` | `counted_branch_pops_the_count` |
| `weaken-the-stack-size-limit` | `counted_branch_max_length` |
| `allow-a-null-argument` | `null_argument_rejected` |
| `allow-a-null-payload-element` | `null_element_rejected_in_payload_branch` |
| `allow-a-null-counted-element` | `null_element_rejected_in_counted_branch` |

For each control the lane writes three files: `Definitions.v` (the mutant record,
which must compile), `OriginalBehavior.v` (the reviewed observation asserted
against the mutant, which must **fail** to compile) and `Counterexample.v` (the
negation, which must compile and pass `coqchk`).

## Three facts the kernel or the tests forced

- **`left` is reserved.** `left` and `right` are the `sumbool` constructors, so a
  record projection bound as `Some (values, left)` is parsed as the constructor
  applied to nothing. Every such binder is `remaining` instead.
- **An `andb` chain only reduces on its first argument.** The null guard is
  therefore spelled with the item test outermost. That is the same conjunction as
  the pinned source; the order is chosen so a non-null item leaves the guard
  `false` without consulting the descriptor, which is what makes the "a null
  argument faults" theorems close by computation.
- **`1 == True` in Python.** A program record whose boolean slot held an integer
  would render as a numeric literal into a `bool` slot. `program_expression`
  therefore rejects a non-`bool` in a boolean field and a non-`int` in a numeric
  one, and the gate compares the record with `literal_equal`, which compares types
  as well as values.

## Still open

- The per-type converter functions, their `BigInteger` narrowing and every
  `FormatException` they may raise; only their results are inputs here.
- The handler body, its return value and its continuation.
- Gas metering and descriptor pricing; only the *absence* of an add-fee step
  inside this window is recorded. The charge itself is covered by the
  [descriptor charge lane](AA-INTEROP-FEE-ORDER.md), which owns the ordering,
  the factor identity and the fee limit.
- Reference counting, the disposables `Convert(object?)` adds, and payload
  aliasing between caller and handler.
- Trusted C# extraction and compiler/CLR correspondence; all 109 public
  entrypoints.

## Running it

```
AA_INTEROP_CONVERSION_SOURCE_MIRROR=<4 pinned .cs files> \
python3 formal/refinement/interop_convert_proofs.py \
  --output-dir /tmp/interop/out --json-report /tmp/interop/result.json
```

Without the mirror the lane downloads from `codeload.github.com` and still has to
hash to the same pinned bytes. The gate's own run of this lane inherits the same
variable.
