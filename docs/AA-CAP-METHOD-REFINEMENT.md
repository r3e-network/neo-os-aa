# Complete reimbursement-helper reference refinement

The certificate covers all **281 bytes / 116 instructions / 52 opcode names** at
`[13557,13838)` of `CapReimbursementToActualCost`. It compares the complete
14-statement source program, independently projected from the typed source
inventory, with an executable reference VM that decodes the actual NEF bytes.
No expected settlement is passed to a native-call oracle or substituted for a
bytecode instruction.

The universal result includes the storage-load branch, new-record construction,
both transaction-hash branches, fee arithmetic, the headroom guard against an
accumulation that would leave the signed range, rejection, aliased reservation
mutation, serialization, storage write and return. Separate classification
lemmas establish the expected return or rejection, storage snapshot and effect
trace. The final theorem excludes both accidental faults and fuel exhaustion on
its legal input domain; equality of two failing executions cannot establish it.

## Quantified domain and result

Inputs comprise a valid 32-byte transaction hash, two nonnegative signed-64-bit
fees, a positive signed-256-bit request, and either no stored ledger or a
well-formed two-field Array/Struct ledger. Its fields are a valid 32-byte hash
and a nonnegative signed-256-bit reservation. The method-entry frame supplies
one argument and an explicit static environment with slot 34 equal to
`Buffer[0x21]`. LDSFLD performs a lookup in that environment.

Let `r` be the stored reservation when the hashes match and zero otherwise,
`c` the sum of the two fees, and `q` the request. The independent observation
contract settles `q` for a zero-fee estimation, otherwise
`min(q, max(c-r, 0))`. Positive settlement stores the current hash and
`r + settled`; nonpositive settlement aborts without serialization or a write.
Paid ledgers with `r >= c` are included and universally reject. The domain does
not impose `r <= c`.

Zero-fee estimation additionally requires `r + q < 2^255`. The helper asserts
that headroom against the domain maximum before it accumulates, so a separately
kernel-checked actual-byte example shows the artifact rejecting with the margin
message instead of faulting on the overflowing addition, and the projected
source rejecting on the same assertion. Source BigInteger arithmetic remains
unbounded: the guard is a precondition the helper checks, not a change to source
arithmetic semantics.

## Source and environment contracts

The source language is the **Neo framework contract dialect**, not arbitrary
CLR execution. ByteString/UInt256 equality means immutable byte-value equality;
the source's object conversions do not establish CLR reference-identity
equivalence. The record cast, framework transaction projection, zero UInt256,
storage prefix and codec are explicit dialect/intrinsic contracts. The source
projector checks every statement and exported semantic collection and does not
consult the target NEF when building the source program. Roslyn/exporter and
source-projection correctness remain in the trusted computing base.

Arrays and structs have heap identities. DUP, loads and field writes retain
aliases. Serialize reads the current heap object; Deserialize allocates from
its input snapshot. The two record fields are scalar values, so the model makes
no nested-Struct clone theorem. Structured wire values stand for a codec
relation; they are not a proof of Neo's binary serializer, deserializer or
marshalling. The persisted typed-ledger invariant must be established by callers
and storage producers. Other shapes, including Maps, are outside this theorem;
the theorem does not assert that all such real-engine inputs fault.

The observed effect sequence includes Storage.Get, optional Deserialize,
Serialize of the resulting snapshot and Storage.Put of that snapshot. The three
GetScriptContainer calls and two GetContext calls are modeled as pure, stable,
nonfaulting getters. Their diagnostic call counts are tested in Python, but are
projected out of the proved trace. This permits the compiler's reordering of a
pure context read around serialization. Gas, call permissions, storage limits,
resource failures, callbacks and transaction rollback are external obligations.
The helper theorem does not prove `_initialize` establishes static slot 34.

## Verification and negative controls

Run the portable fixture and execution tests with:

```sh
python3 -m unittest discover -s formal/refinement -p test_method_proofs.py -v
```

The fixture test restores the exact original NEF from the archived script/token
data and the 68-byte header acquired from that candidate, then requires its
original full SHA-256. It uses no previous checkout, SDK/package cache or build
output. The independent source-only fixture supplies newer semantic collections.
This assembly is only for tests; it does not compile a replacement contract.
The production certificate requires a complete fresh exporter inventory and
rechecks every current input file:

```sh
python3 formal/refinement/method_proofs.py \
  --inventory /path/to/fresh-inventory.json \
  --output-dir /tmp/aa-cap-method-proof \
  --json-report /tmp/aa-cap-method-proof.json \
  --controls
```

Acceptance compiles with `coqc`, checks with `coqchk`, and prints assumptions for
every named model/certificate declaration, requiring the exact closed count.
The receipt binds the NEF, full script, complete method, source tree/projection,
proof certificate, models and Python tools. Inputs and tools are checked again
after the controls. The standalone CLI overwrites any old success receipt with
a failure receipt before work and retains failure on any error.

Six semantic controls first compile valid mutated definitions, then require the
kernel certificate to reject MIN changed to MAX, the reversed assertion branch,
a duplicated value left after the reservation write, a source return changed to
zero, an initial source reservation changed to one, and a deleted source
assertion. Syntax errors, missing tools and timeouts do not count as semantic
rejection. Execution tests also cover every one of the 116 actual instruction
offsets across their cases.

The receipt uses `scope: complete-helper-reference-refinement` and
`fullImplementationVerified: false`. This is a complete private-helper reference
proof under the stated contracts. It does not prove actual ApplicationEngine,
native binary codecs, gas accounting, compiler correctness, caller composition
or any of the **100 public ABI entrypoints**, all of which remain outside this
certificate.
