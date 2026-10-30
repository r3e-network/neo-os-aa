# Initialization and helper context refinement

The complete candidate `_initialize` and `CapReimbursementToActualCost` reference
executions are proved, including arbitrary existing heap objects and an arbitrary
caller evaluation-stack suffix. The receipt sets `helperContextVerified` only
after checking their composition and the bridge to the isolated helper. It keeps
`fullImplementationVerified` false: this is not an ApplicationEngine
correspondence proof or full implementation acceptance.

The initializer certificate executes the entire raw NEF range `[24966,25620)`:
654 bytes and 170 instructions. It decodes `INITSSLOT`, all constant pushes,
`CONVERT Buffer`, both `PACK` instructions, all static stores and `RET`; the
expected reimbursement key is a theorem conclusion, never a decoder shortcut.
`INITSSLOT` requires uninitialized statics and rejects a second initialization.

For every preexisting heap and evaluation-stack suffix, six artifact theorems
establish termination, 53 static slots, slot 34 equal to `Buffer([0x21])`, exact
preservation of the stack suffix, and two appended arrays. Static slots 10 and
12 point to those fresh array indices. Every preexisting heap object is
unchanged, and the new array indices are distinct and outside the old heap.
Disjointness from caller references presupposes valid references into that old
heap; dangling caller references are not a legal aliasing invariant.

The Coq model represents Buffer contents as values. It does not prove mutable
Buffer object identity, resource limits, gas charging, or handler dispatch.
The initializer has no calls or environment effects. Its manifest entry and
complete terminal range are bound to independently decoded raw NEF bytes; all
exported inputs, the proof tools and all imported models are rechecked after
kernel verification and semantic controls. The digest of the bytes actually
decoded must also equal the pinned NEF digest, preventing a file change between
the shared input check and decoding from certifying another artifact.
Source-initializer equivalence is a
separate certificate, rather than a consequence of byte execution alone.

The helper certificate executes all 116 instructions in the raw NEF range
`[13557,13838)` (281 bytes). Its contextual interpreter reuses the frozen ordinary
instruction semantics, allocates a fresh transaction Array for each of the three
`Runtime.GetScriptContainer` calls, and preserves the shared evaluation stack at the
returning helper's `RET`. This is an explicit reference extension; it does not
establish the correspondence of actual C# call-frame operations by definition.

Three symbolic path proofs cover a present ledger for the current transaction,
a present ledger for another transaction, and an absent ledger, including a zero
transaction hash. Their composition proves the independent reimbursement
observation, excludes timeout and unknown faults on the legal domain, and proves
the following frame properties:

- Existing Array/Struct heap objects and static fields remain unchanged.
- Three transaction Arrays and one budget Array/Struct occupy four distinct
  appended heap indices. They cannot alias valid references into the old heap.
- Success returns exactly one value above the original caller stack; rejection
  preserves that stack and the original stored ledger.
- Observations agree with the earlier isolated raw-byte helper execution, which
  has its own separate source-refinement certificate.
- Executing the actual initializer first supplies the helper's slot-34
  precondition and preserves the original heap while appending six model objects
  across initialization and the helper.

The frame and observation theorems are stated under the helper's own VM-integer
headroom assertion, the check that the new reservation stays inside the signed
range before the addition runs. That assertion is not an added caller
obligation: `legal_update_fits` derives it from the legal domain, and
`complete_context_frame` discharges it there. The refusal branch is a separate
abort whose caller frame and heap the certificate does not claim. The 73-byte
assertion is why the helper is 281 bytes and 116 instructions instead of the
earlier 208 bytes and 96 instructions; every later script offset moved by the
same amount while the 654-byte initializer kept its length.

The legal domain is explicit: 32-byte hashes, nonnegative signed-64-bit fee
components, a positive representable requested reimbursement, and an absent or
two-field Array/Struct ledger with a nonnegative representable reservation.
Zero-cost estimation additionally requires the reservation plus request to fit.
Paid transactions with an exhausted or overreserved ledger are included and
reject. Arbitrary malformed storage, Map records, dangling caller references,
and the reachability of the persisted-ledger invariant are not established here.
The projected effect trace contains storage read, deserialization, serialization
and storage write; pure getter calls and gas are not in that trace.

```sh
python3 formal/refinement/context_proofs.py \
  --inventory /path/to/fresh/inventory.json \
  --output-dir /path/to/new-empty-proof-directory \
  --json-report /path/to/context-proof.json --controls
```

The default command checks both full byte ranges. `--initializer-only` retains
the initializer-only certificate used by the independent source-initializer
lane. Both modes require a new or empty output directory.

The runner requires `coqc`, `coqchk` and a complete inventory of closed
assumptions. It writes a failure receipt before starting; an error cannot leave
an earlier successful receipt in place. Wrong static slot, wrong key and dropped
heap allocation controls compile their altered definitions first, then must be
rejected by the semantic certificate. Three further controls drop a helper heap
write, discard the caller stack, or reuse an old transaction reference. Each
compiles its altered definitions, proves and kernel-checks a concrete differing
observation, and rejects the positive certificate. Syntax, missing-tool and
timeout failures are not successful controls. Portable tests reconstruct the exact pinned NEF
from the archived inventory and verify its original hash; they need no SDK,
NuGet cache, old checkout paths or production build directory.

The model heap is a list of Array/Struct objects; its exact allocation count is
not an assertion about the runtime's complete heap or garbage collector. The
suspended caller's locals, arguments and exception frames, actual CALL/RET
dispatch, mutable Buffer identity, real native codec and storage handlers,
resource limits and gas still need their respective runtime correspondences.
All 100 public ABI entrypoints remain outside this helper-context certificate.
