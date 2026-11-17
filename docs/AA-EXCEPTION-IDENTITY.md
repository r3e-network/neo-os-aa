# Exception identity and catchability

This is the twenty-first selected scope. Four lanes say "it throws" without
recording *which* exception reaches whom: the gas lane rejects a charge, the
syscall lane rejects an admission, the contract-handoff lane rejects a call, and
the conversion lane rejects an argument. Each records the rejection as a boolean
outcome and leaves the exception's identity open. This lane reads the surfacing
mechanism out of the pinned C# and stops at the fault-state effect.

**Status.** `implementationVerified` and `fullImplementationVerified` remain
`false`. This scope does not close an entrypoint, does not model instruction
semantics, and does not model the TRY-stack protocol or any transaction
composition.

## Pinned inputs

| Key | Repository | File | Pin |
| --- | --- | --- | --- |
| `vm/engine` | `neo-vm` | `src/Neo.VM/ExecutionEngine.cs` | `ea906436…` at `004cd60` |
| `vm/control` | `neo-vm` | `src/Neo.VM/JumpTable/JumpTable.Control.cs` | `a0ac51ff…` at `004cd60` |
| `vm/limits` | `neo-vm` | `src/Neo.VM/ExecutionEngineLimits.cs` | `b8353f47…` at `004cd60` |
| `vm/catchable` | `neo-vm` | `src/Neo.VM/CatchableException.cs` | `c6fbc18f…` at `004cd60` |
| `vm/unhandled` | `neo-vm` | `src/Neo.VM/VMUnhandledException.cs` | `71cd4912…` at `004cd60` |
| `core/engine` | `neo` | `src/Neo/SmartContract/ApplicationEngine.cs` | `97b08bfe…` at `d10e9ce` |

`vm/control` and `vm/limits` are already reviewed by the `runtime` and
`interop-conversion` lanes and `core/engine` by six others, so those three hashes
are not new evidence; the two exception classes and the VM engine file are new.
The projection re-checks all six on every run.

## What the source says

The instruction turn wraps only the opcode handler in a typed, guarded catch:

```csharp
try
{
    JumpTable[instruction.OpCode](this, instruction);
}
catch (CatchableException ex) when (Limits.CatchEngineExceptions)
{
    JumpTable.ExecuteThrow(this, ex.Message);
}
PostExecuteInstruction(instruction);
if (!isJumping && currentInstruction != null)
    context.InstructionPointer += instruction.Size;
isJumping = false;
```

and the outer handler is untyped, so everything the guard did not admit lands
there:

```csharp
catch (Exception e)
{
    OnFault(e);
}
```

`CatchableException` derives from `Exception` directly, which is what makes the
guarded clause narrow: an `InvalidOperationException` is not a
`CatchableException`, so it can never enter the typed handler. What the typed
handler hands over is the *message*:

```csharp
public virtual void ExecuteThrow(ExecutionEngine engine, StackItem? ex)
{
    engine.UncaughtException = ex;
    ...
            engine.Push(engine.UncaughtException!);
            executionContext.InstructionPointer = tryContext.CatchPointer;
            engine.UncaughtException = null;
    ...
    throw new VMUnhandledException(engine.UncaughtException!);
}
```

`VMUnhandledException` wraps the thrown `StackItem` in `ExceptionObject`, and the
engine records the exception object host-side while clearing the notification
set:

```csharp
protected override void OnFault(Exception ex)
{
    FaultException = ex;
    notifications = null;
    base.OnFault(ex);
}
```

## The projected record

Sixteen fields, each derived from the pinned text, each independently mutable.
`step_order` is a field, not a restatement: `guarded-catch` is anchored on the
`ExecuteThrow` call and `fault-handler` on the `OnFault` call, so moving either
block rewrites the order.

| Field | Source fact |
| --- | --- |
| `step_order` | `read-instruction` → `guarded-catch` → `post-hook` → `advance-pointer` → `fault-handler` |
| `catch_names_the_catchable_type` | the guarded clause names `CatchableException` |
| `catch_is_guarded_by_the_limit` | the clause carries `when (Limits.CatchEngineExceptions)` |
| `the_generic_handler_is_untyped` | the outer clause is `catch (Exception e)` |
| `the_caught_value_is_the_message` | the guarded handler is called with `ex.Message` |
| `the_fault_sets_the_state` | `OnFault` assigns `State = VMState.FAULT` |
| `the_thrown_value_is_recorded_at_entry` | `ExecuteThrow` opens by storing its argument |
| `a_handler_clears_the_recorded_value` | a taken handler clears `UncaughtException` |
| `the_handler_receives_the_thrown_value` | the taken handler pushes that stored value |
| `the_walk_skips_the_finally_and_consumed_catch` | the walk skips `Finally` and a spent `Catch` |
| `an_absent_handler_wraps_the_value` | the walk ends by throwing `VMUnhandledException` |
| `a_dedicated_catchable_type_exists` | `CatchableException` is declared and derives from `Exception` |
| `the_wrapper_keeps_the_thrown_object` | the wrapper keeps `ExceptionObject` |
| `the_engine_records_the_fault` | `ApplicationEngine.OnFault` stores `FaultException` |
| `the_engine_clears_the_notifications` | the same override clears `notifications` |
| `the_limit_defaults_to_catching` | `CatchEngineExceptions` declares `= true` |

## What the kernel proves

`coq/ExceptionIdentity.v` closes 29 declarations; the generated certificate adds
30 more, for `closedAssumptionCount = 59`. No `Axiom`, no `Admitted`, no
`Parameter` — `coqchk -silent` on the certificate exits 0 and both logs carry one
`Closed under the global context` per declaration with no `Axioms:` line.

| Theorem | What it settles |
| --- | --- |
| `the_reviewed_order_puts_the_catch_before_the_fault_handler` | the recorded order admits a catch at all |
| `a_fault_first_record_admits_nothing` | a reordered table cannot catch, whatever the types say |
| `an_uncatchable_exception_is_never_admitted` | admission is `false` for every record and limit |
| `an_uncatchable_exception_never_reaches_a_handler` | no handler runs for it, ever |
| `an_unguarded_record_catches_with_the_limit_off` | the limit matters only because the guard exists |
| `a_misnamed_catch_record_admits_nothing` | the clause's own type is load bearing |
| `a_caught_turn_receives_the_message` | what the contract gets is the message |
| `handing_over_the_object_would_break_the_message_guarantee` | pushing `ex` instead of `ex.Message` is observable |
| `failures_the_engine_does_not_catch_are_indistinguishable` | identity is erased on the fault path |
| `a_caught_turn_is_not_a_fault` | a taken handler leaves the turn running |
| `a_faulted_turn_skips_the_pointer_advance` | a fault ends the turn |
| `the_fault_path_always_clears_the_notifications` | the notification set is lost on every fault |
| `a_caught_throw_leaves_the_notifications_alone` | and kept on every caught throw |
| `the_wrapper_and_the_original_are_never_both_recorded` | the host sees exactly one of the two |
| `a_caught_turn_records_no_wrapper` / `…_no_exception_at_all` | a caught throw records neither |
| `a_wrapper_that_drops_the_object_leaves_the_host_with_a_shell` | the wrapper's payload is load bearing |
| `an_unrecorded_engine_leaves_the_host_with_no_exception` | `FaultException` is the only host record |
| `an_engine_that_skips_the_fault_assignment_loses_the_fault_state` | the state assignment is load bearing |
| `an_engine_that_keeps_the_notifications_leaks_them_on_a_fault` | so is the clearing |
| `swapping_the_hook_and_the_pointer_advance_keeps_the_catch_first` | the swap is order-visible but not admission-visible |

## The four paths, side by side

| Thrown class | Limit | Handler | Contract sees | Host records | Notifications |
| --- | --- | --- | --- | --- | --- |
| `CatchableException` | `true` | present | `ByteString(message)` | nothing | kept |
| `CatchableException` | `true` | absent | nothing | `VMUnhandledException` | cleared |
| `CatchableException` | `false` | either | nothing | the exception itself | cleared |
| anything else | either | either | nothing | the exception itself | cleared |

The first row is the only one where the contract observes anything, and what it
observes is a string. Rows three and four are deliberately identical: the type of
an exception the engine does not catch is not observable at all, which is why the
model has no field for it.

## Sixteen controls

Each control recompiles the model against one changed source fact, must fail to
prove the reviewed behaviour, and must prove the counterexample. Every mutation
moves exactly one projected field, and the sixteen cover all sixteen fields.

| Control | Field it moves |
| --- | --- |
| `drop-the-limit-guard` | `catch_is_guarded_by_the_limit` |
| `name-the-base-type-in-the-guarded-clause` | `catch_names_the_catchable_type` |
| `throw-the-exception-object-instead-of-its-message` | `the_caught_value_is_the_message` |
| `make-the-outer-handler-typed` | `the_generic_handler_is_untyped` |
| `fault-without-setting-the-state` | `the_fault_sets_the_state` |
| `skip-recording-the-thrown-value` | `the_thrown_value_is_recorded_at_entry` |
| `never-clear-the-recorded-value` | `a_handler_clears_the_recorded_value` |
| `push-a-null-instead-of-the-thrown-value` | `the_handler_receives_the_thrown_value` |
| `treat-the-finally-frame-as-a-catch` | `the_walk_skips_the_finally_and_consumed_catch` |
| `let-the-unhandled-value-escape-unwrapped` | `an_absent_handler_wraps_the_value` |
| `give-the-catchable-exception-no-dedicated-type` | `a_dedicated_catchable_type_exists` |
| `drop-the-wrapped-object` | `the_wrapper_keeps_the_thrown_object` |
| `fault-without-recording-the-exception` | `the_engine_records_the_fault` |
| `keep-the-notifications-on-fault` | `the_engine_clears_the_notifications` |
| `default-the-limit-to-off` | `the_limit_defaults_to_catching` |
| `swap-the-hook-and-the-pointer-advance` | `step_order` |

## Three facts this lane forced

**The tokenizer has no `#` token, so the pinned engine cannot be read as-is.**
`ExecutionEngine.cs` carries two `VMPERF` regions that print to the console.
They assign no state, and they sit inside both of the bodies this lane reads.
The lane therefore drops preprocessor *lines* before projecting and hashes the
raw bytes: the pin is still over the whole file, only the projection skips
directive syntax the shared tokenizer cannot express. This is recorded in the
lane's `tcb`, not hidden in a helper.

**A guard and a conjunct are not the same thing.** The first version of `admits`
multiplied `guard` into `limit`. That reads naturally but is wrong: with the
guard *absent*, admission then required `limit` to still hold, so dropping the
guard made everything uncatchable. The correct reading is an implication —
present guard implies the limit must admit; absent guard implies the limit is
irrelevant. `an_unguarded_record_catches_with_the_limit_off` is the test that
pins this down, and the mutation that drops the guard is the control that would
have silently passed under the wrong reading.

**One projected field was redundant and had to go.** `guarded_handler_precedes_
the_generic_one` looked like a real fact, but every mutation that could move it
also moved `step_order`, so it could never be isolated by a single-field control.
`step_order` already contains `guarded-catch` before `fault-handler`, so the field
was deleted rather than left uncovered. The lane now has exactly one control per
field and one field per control.

## Still open

- Which concrete exception type each individual engine operation throws. This
  lane records the catch clause's identity and the surfacing rule, not the throw
  sites of every opcode.
- Whether any host ever constructs an engine with `CatchEngineExceptions` off.
  Only the declared default and the guard position are recorded.
- The fault-message text and any client-visible diagnostic derived from it.
- Rollback of ledger and storage effects after a fault, and the transaction
  composition that decides whether a faulted execution is committed or discarded
  — the remaining part of `GAS_RESOURCE_EXCEPTION_AND_TRANSACTION_COMPOSITION`.
- Trusted C# extraction and compiler/CLR correspondence; all 109 public
  entrypoints.

## Running it

```sh
cd formal/refinement
python3 -m unittest test_exception_identity_source       # 25 tests
python3 exception_identity_proofs.py \
    --output-dir /tmp/exid --json-report /tmp/exid/exception-identity-proof.json
```

A full run takes about two and a half minutes: two `coqc` passes plus `coqchk`
for the model and the certificate, then four kernel commands per control.
