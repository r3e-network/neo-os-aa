# Complete reimbursement helper gas bound

This lane derives a parameterized raw-picoGAS price trace from the 281-byte,
116-instruction `CapReimbursementToActualCost` region, rather than using
the nine concrete execution receipts as a universal proof. It enumerates the
actual acyclic CFG, including storage-present/missing, hash-equal/reset and
settlement-success/abort edges. A missing record with an all-zero transaction
hash is retained as a structural possibility; no cryptographic nonzero-hash
assumption removes that cheaper path.

Opcode prices, syscall fixed prices and native serialize/deserialize CPU prices
come from hash-pinned Neo 3.10.1 source. The rejecting extractor admits only the
observed declaration forms and native wrapper construction. CALLT cost includes
the native PUSH0/SYSCALL/RET wrapper and its CPU charge. Storage.Put includes its
fixed syscall charge plus the source's data-size charge. The exact formula is:
missing = keyLength + newLength; existing empty new value = 0; shrinking/equal =
ceil(newLength/4); growing from empty = newLength; other growth =
ceil(oldLength/4) + newLength - oldLength. The fee is charged before assigning the
new value; creating an absent item occurs before that charge. Fee sufficiency
does not establish storage rollback.

The successful semantic domain separately requires correct call flags/context,
native activation, valid frame/static fields, admitted integer inputs, successful
settlement, no arithmetic overflow, available stack/resource budget and a codec
invariant. A newly serialized two-field Array/Struct ledger with a 32-byte hash
and nonnegative signed-256-bit reservation has length 38..70. Existing admitted
wire can have nonminimal varints/sign padding/trailing bytes, but must decode to
that ledger and fit storage/VM limits; its raw length is at least 38. It need not
be canonical. Gas sufficiency does not repair malformed storage or prove these
semantic prerequisites. Native codec CPU fees are fixed, not payload-dependent
AddFee calls; memory/serialization limits remain independent prerequisites.

Coq proves nonnegative event charges, Storage.Put size bounds, a helper-wide
price bound and metering erasure for sufficient remaining budget by composing
`GasSemantics.sufficient_budget_erases_metering`. The generated certificate
contains the actual CFG paths and extracted coefficients. Optional original
`_initialize` opcode cost is added separately; public wrapper dispatch, account
validation, callbacks, paymaster policy/GAS transfers and block fee burning are
outside this helper bound.

The byte decoder, CFG enumeration, source extraction/Coq printing, C# scheduling,
native wrapper correspondence, .NET arithmetic and metadata-to-runtime link are
explicit trusted boundaries. Kernel checking does not verify those Python/C#
frontends. Actual raw pre/post fee receipts cross-check them independently for
finite cases and reject observed metadata/trace drift; they do not discharge the
universal ApplicationEngine correspondence obligation. No production source or
artifact is changed.

The projection pins nine source files, including native attribute defaults and
metadata assignment. It rejects unknown price expressions, changed source hashes,
unknown native/syscall effects and cyclic or incomplete helper CFGs. The native
codec attributes do not set StorageFee; the pinned long auto-property's CLR zero
default and the pinned metadata assignment are explicit frontend assumptions.
This yields zero native storage charge in addition to the CPU fees.

The model charges one aggregate event per original core instruction; CALLT folds
its real native wrapper's charges into that event. The charge-refinement theorem
also covers any finer nonnegative charge sequence with the same total. Universal
actual-AE scheduling and equality of that fine sequence remain a separate bridge
obligation. The success erasure theorem must not be repurposed as an actual
out-of-gas rollback theorem: an absent Storage.Put creates an empty item before
its dynamic AddFee, and aggregate events do not encode that intermediate write.
The independent runtime lane measures a gas failure after Put; it does not prove
all possible fault schedules.

Measured validation on 2026-10-17 after the helper grew to 281 bytes: **22/22
Python tests PASS**, **real coqc/coqchk PASS**, **69 declarations closed under the
global context** (29 imported GasSemantics, 21 HelperGasBound, 19 generated
artifact), 12 enumerated CFG paths and **six valid-definition semantic controls
rejected**. The controls lower the execution
bound, omit native CPU or wrapper cost, omit the storage-price marker, omit a
hash branch, or lower the storage bound. Definition-only compilation succeeds
before each certificate rejection. Five pinned actual-runtime receipts separately
match the independent CFG, bytes, initializer, native wrappers, metadata and
raw fee total. Missing receipts fail the proof runner closed.

The proof runner consumes supplied traces; it does not start ApplicationEngine.
Its receipt therefore records `runtimeObservationSource=supplied-runtime-receipts`,
`runtimeReexecuted=false`, `checkerExecutesApplicationEngine=false` and
`runtimeReceiptAuthenticityVerified=false`. These fields describe the checker,
not when a separate runtime test produced its inputs. Fresh execution requires
separate evidence binding the test process, loaded assembly and artifact hashes,
test results and output files. Deterministic fresh traces can have the same bytes
as earlier traces; a matching hash alone does not establish freshness or origin.

For nonnegative parameters `E` (execution pico factor), `S` (storage price in
datoshi), `F` (pico per datoshi), the conservative universal price bound is:

```
helper only:          177005 * E + 71 * S * F
including initialize: 558542 * E + 71 * S * F
```

The actual default fixture has `E=300000`, `S=100000`, `F=10000`; including
initialization the bound is `238562600000` picoGAS, or `23856260` datoshi.
The independent maxima for execution and storage make this deliberately
conservative. Actual canonical 39-byte paths measure 19343410 datoshi (missing),
17264110 (same transaction) and 17756260 (reset). Those measurements are checks,
not the proof oracle. The model also proves admitted size times uint32 storage
price fits signed Int64 before conversion to BigInteger.

```sh
python3 -m unittest formal.refinement.test_gas_trace
python3 formal/refinement/gas_trace_proofs.py \
  --output-dir /tmp/fresh-helper-gas-proof \
  --runtime-receipts path/to/aa-gas-runtime-evidence \
  --json-report /tmp/helper-gas-proof.json
```

Actual execution receipts come from the frozen `ImplementationRefinementGasRuntimeTests`
suite; their persistent locations are documented in the dated audit evidence.

### Recapture after the artifact rename

The 2026-10-13 receipts pinned the pre-rename artifact (NEF `083ed325…`). After
the rename the observed instruction offsets no longer belonged to the reviewed
NEF, so `gas_trace.crosscheck_runtime` refused them with `Runtime artifact
mismatch` and the aggregate gate's helper lane failed closed instead of silently
passing on stale bytes. No expectation was edited to make that refusal go away.

The lane was re-established on 2026-10-17 by re-running the producer test, which
executes the real `ApplicationEngine` against the reviewed NEF it asserts on
disk:

```sh
dotnet test tests/SmartAccount.Contracts.Tests/SmartAccount.Contracts.Tests.csproj \
  -c Release --filter "FullyQualifiedName~ImplementationRefinementGasRuntimeTests"
```

That re-run pinned NEF `be43cd05…` / manifest `35fbb188…`. The helper then grew
from 208 bytes to 281 bytes when it gained the explicit VM-integer-range margin
assertion, which moved every observed offset again, so the producer was re-run a
second time against the current build. All 9 cases passed and wrote the receipts
archived as the hermetic fixture
`formal/refinement/fixtures/helper-gas-runtime-live-receipts.json.gz`
(SHA256 `2e4aa70b716fe3afcb774963404664be5a87d57b95560e4ae3f6c74f4226b6c7`,
deterministic gzip), pinning NEF `4e5c8ae0…` / manifest `f7203fd8…` with Neo
`3.10.1+d10e9cee…` and Neo.VM `3.10.1+004cd607…`. Independent CFG cross-check raw
totals: absent `193434100000`, same `172641100000`, reset `177562600000`,
exhausted `139224600000`, zero `172641100000` picoGAS.

The pre-rename receipts stay archived at
`formal/refinement/fixtures/helper-gas-runtime-receipts.json.gz`, and
`ArchivedReceiptStalenessTests` keeps asserting they are refused at the artifact
check. The eleven mutation controls in `RuntimeReceiptTests` now run against the
live fixture instead of being skipped, so they verify real rejections rather than
observing the artifact-mismatch error the mutation never caused. Re-running the
producer is the only way to re-establish the lane; a stale receipt cannot be
rewritten into evidence about a different build.

The proof output directory must be empty. This run's durable proof receipt is
`<tmp>/gaslane/gas.json`; logs, kernel objects and six controls are in
`<tmp>/gaslane/proofs/`. The receipt includes source/artifact/input hashes
and each actual-runtime receipt hash. Its flags keep `applicationEngineVerified`,
`sourceFrontendVerified` and `fullImplementationVerified` false. The selected
helper's gas-price model has been proved; complete implementation/protocol
verification remains open.
