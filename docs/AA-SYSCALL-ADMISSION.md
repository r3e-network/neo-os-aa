# Syscall admission: `System.Contract.Call` and `CALLT`

`formal/refinement/coq/EntryDispatch.v` states its own entry boundary as
"after interop admission and argument conversion". This lane covers exactly
that excluded prefix. It is the first unit of the source-trust route: prove the
pinned C# frontend's decisions, and end where an existing kernel-checked
refinement already begins.

Nothing here moves `fullyClosed` off zero, and the reason is the same one
recorded in `AA-ENTRYPOINT-CLOSURE.md`: a closed entrypoint needs the
ApplicationEngine dispatch, the gas/exception/transaction composition and the
compiler correspondence as well, and none of those are in this lane.

## Pinned inputs

neo `d10e9cee`, neo-vm `004cd607`:

| file | why |
| --- | --- |
| `ApplicationEngine.Contract.cs` | the `System.Contract.Call` registration and `CallContract` |
| `ApplicationEngine.cs` | `OnSysCall`, `ValidateCallFlags`, `OnCallT`, the five-argument `CallContractInternal`, `Register` |
| `CallFlags.cs` | the four bit values and the three composites |
| `InteropDescriptor.cs` | `RequiredCallFlags` and `Parameters => Handler.GetParameters()` |
| `MethodToken.cs` | the token fields and the `Deserialize` guards |
| `EvaluationStack.cs` | `Pop` |

## What the projection derives rather than asserts

The record the kernel consumes is not written down by hand; every field is read
off the source text:

- `interop_pop_count = 4` and `interop_flag_slot = 2` come from the parameter
  list of the declaration named by `nameof(CallContract)`, because
  `InteropDescriptor.Parameters` is `Handler.GetParameters()`.
- `interop_required_flags = 5` is `Register`'s fourth argument evaluated against
  the enum's own composite definitions; `OnSysCall` passes exactly that to
  `ValidateCallFlags`.
- `token_required_flags = 5` is `OnCallT`'s own `ValidateCallFlags` argument.
- `call_all_flags = 15` is the right operand of `(callFlags & ~X) != 0`.
- The boolean fields are which statements are present.

Changing any of those source expressions changes the projection: `narrow-call-flags`
swaps `~CallFlags.All` for `~CallFlags.ReadOnly` and the derived value becomes
5 without any table being consulted.

## Two classes of guard

Only guards whose removal changes an outcome or a handed-off value are model
fields. Four pinned guards are reason refinements instead: the called contract
being absent, the ABI method being absent, the CALLT token index being out of
range (an unguarded array read throws) and the CALLT parameter count exceeding
the stack (an unguarded `Pop` throws). The unguarded code faults on the same
input, so a mutant of one keeps the same admission outcome and would prove
nothing. They are modelled as unconditional faults, and they are deliberately
absent from the 13 semantic controls.

What actually differs between the two paths:

| | `System.Contract.Call` | `CALLT` |
| --- | --- | --- |
| caller flag gate | `ReadStates \| AllowCall`, in `OnSysCall` | `ReadStates \| AllowCall`, in `OnCallT` |
| underscore check | `CallContract`, after the pops | not repeated — `MethodToken.Deserialize` already rejects it |
| `~CallFlags.All` range check | `CallContract` | not repeated — `Deserialize` already rejects it |
| `callFlags` source | the third popped stack value | `token.CallFlags` |
| callee arguments | the converted `Array` payload, opaque | the popped window |
| `IsDynamicCall` | set to `true` after the call | left untouched |

The last two rows are the substantive ones. `OnCallT` transfers the caller's
top-`n` window unchanged — `pop_window` in ascending order followed by the
descending push in `CallContractInternal` is the identity — so composing this
file with `EntryDispatch.v` gives a callee stack that is a contiguous, ordered
prefix of the caller's. `System.Contract.Call` has no such property: its callee
argument vector is a stack-item payload, which is why the model carries it as an
opaque input rather than pretending it is a window.

Ordering is proved, not assumed: `OnSysCall` validates the caller's flags and
pops every handler parameter before it invokes `CallContract`, so an exhausted
stack faults before the underscore rejection is even reachable, and a caller
without `ReadStates | AllowCall` never reaches it either.

## What the run produces

`formal/refinement/syscall_dispatch_proofs.py`:

- 35 model declarations, 11 certificate declarations, 46 closed assumptions,
  `coqchk -silent` clean, no `Axioms:` line.
- 13 semantic controls, one per discriminating field: each mutant's original
  behaviour fails to compile, and the `<>` counterexample both compiles and
  passes `coqchk`.
- `implementationVerified`, `fullImplementationVerified`,
  `sourceFrontendVerified` and `vmCorrespondenceProven` all stay `false`.

## Still open in this layer

- `AddFee`, gas metering and every resource exception. No cost is modelled. The
  charge itself is now covered separately by the
  [descriptor charge lane](AA-INTEROP-FEE-ORDER.md): its ordering against the flag
  check and the first pop, the one-time factor, the whitelist bypass and the strict
  limit comparison. The `BigInteger` arithmetic and the exception identity remain
  open there too.
- `Convert` and the `Array` payload; the interop callee argument vector is an
  input, not a derived value.
- Exception identity. Every `Rejected` constructor is a fault, but whether it
  surfaces as `InvalidOperationException`, `ArgumentException`,
  `ArgumentOutOfRangeException`, `FormatException` or `IndexOutOfRangeException`
  is not modelled — which is precisely why the four reason-only guards above
  cannot be discriminated.
- Contract resolution, manifest/ABI reads, `MethodToken` deserialization at NEF
  load, policy whitelists and invocation counting.
- Trusted C# extraction and compiler/CLR correspondence.

## Registered as the seventeenth gate scope

> Forward: the conversion that turns the window into the handler's arguments is
> covered by the nineteenth scope, `interop-argument-conversion` — see
> `docs/AA-INTEROP-CONVERSION.md`. The fixed price this layer charges before that
> conversion is covered by the twentieth scope, `interop-descriptor-charge-order`
> — see `docs/AA-INTEROP-FEE-ORDER.md`. The frame this lane hands off *into* is
> covered by the eighteenth scope,
> `contract-internal-handoff-and-frame-construction` — see
> `docs/AA-CONTRACT-HANDOFF.md`.

The lane is registered in `formal/refinement/closure.py` as `syscall-dispatch`.
Because the gate now carries its own reviewed copy of this layer's taxonomy,
weakening a constant here no longer weakens the gate: the lane report, its
regeneration check and `join_scopes` would all still agree with each other.

What the gate does beyond the generic join:

- `join_scopes` compares the receipt's `program`, `handlerParameters`,
  `tokenFields`, control name list (ordered) and precondition/unproved/TCB text
  against `closure.py`'s own `SYSCALL_DISPATCH_*` constants, and requires
  `implementationVerified` and the four scope flags to be present and `false`.
- `validate_provenance` re-hashes `source-projection.json`, re-reads its
  `scope`/`entryBoundary`/`program`/`handlerParameters`/`tokenFields` and domain,
  checks the certificate's declaration inventory against `kernelDeclarations`,
  and re-reads `model.log`/`certificate.log` to confirm that each prints
  `Closed under the global context` exactly once per declaration with no
  `Axioms:` line.
- `main` regenerates the certificate bytes and the whole control inventory from
  the freshly captured pinned sources and compares them to the receipt.

The lane is deliberately **not** in `ARTIFACT_LANES`: it makes no claim about
the deployed contract, so requiring `nefSha256` to match would be wrong.

`test_syscall_dispatch_source.test_gate_pins_agree_with_this_lane` fails
immediately if the gate's copy and this lane's constants diverge, so such a
divergence is caught in a second rather than after a full gate run.
