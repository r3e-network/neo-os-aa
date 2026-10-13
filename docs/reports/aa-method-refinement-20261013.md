# Ordinary reimbursement method refinement — 2026-10-13

This revision extends the previous 22-instruction arithmetic certificate to
the complete private reimbursement method: 208 bytes and 96 instructions at
`[13557,13765)`. The production source, NEF and manifest are unchanged. The work
remains on local `main`, with the ordinary and native implementation entry
folders preserved.

Full implementation verification remains false: this private helper does not
certify any of the 100 public ABI entries. The certificate is a complete
observable reference-body theorem under the explicit contracts below.

## Complete helper theorem

The generated certificate contains ten universal results and two concrete
examples. It separately classifies source and VM execution for missing storage,
matching hashes and changed hashes, then composes both with the independent
settlement observation. The complete result excludes accidental VM faults and
fuel exhaustion on its legal input domain; two failing executions cannot pass
as successful refinement. Paid exhausted or over-reserved records universally
abort without serialization or a storage write.

The kernel assumptions audit covers **103 declarations**, including definitions
and imported results: 14 from IntegerSemantics, 11 from CapArithmetic, 63 from
CapMethodVm and 15 from the generated certificate. They contain 38 proved
lemmas/theorems/examples in total; 103 is not a theorem count. Every declaration
is closed, and compiled objects are rechecked with `coqchk`.

Six definition-valid semantic mutations are rejected: target MIN to MAX,
reversed rejection branch, missing reservation write, source return zero,
initial source reservation one, and missing source assertion. An additional
independent alias control drops a heap update: valid definitions compile, the
expected successful observation is rejected, and the actual disagreement is
itself kernel checked. Syntax errors and unavailable tools are not successes.

## Source and target meaning

The source-only projector checks the complete typed Roslyn body, all 12
statements and seven locals, record field layout, constructor initializers and
the storage-key initializer. It never reads NEF opcodes to invent a matching
source program. Unknown or omitted metadata is rejected, and supported changes
to a guard, write, return or constant change the projected program. The exporter
now preserves ordered operation collections and the actual symbols targeted by
field initializers, including array dimensions and elements.

The source interpreter has unbounded BigInteger arithmetic and preserves
left-to-right expression evaluation. Its declared Neo framework dialect gives
ByteString/UInt256 immutable byte-value equality and mutable records heap
identity. This is not a theorem about arbitrary CLR reference equality. The
source/compiler/framework relationship remains a named correspondence
obligation, even though the exact source tree and its projection are hashed.

The target reference interpreter decodes actual helper bytes, uses stack/locals
and shared heap references, and reads static fields through an explicit
environment. Serialize observes the updated object; it is not passed an expected
answer. The codec contract represents a stored record snapshot rather than the
native binary encoding. Getter calls are stable, pure and successful under the
environment contract. The compared effect trace contains storage reads,
deserialization, serialization and writes; it does not claim equality of every
syscall trace or resource failure across compiler evaluation-order changes.
The observation compares the terminal result, stored snapshot and this effect
trace. It does not establish a frame rule for arbitrary caller heaps, arguments
or static fields.

The independent protocol result uses remaining paid fees, or the requested
quote for zero-fee estimation, with a transaction-hash reset. Positive settlement
updates the ledger; an exhausted paid budget aborts without a storage write.
The no-overflow domain requires a representable accumulated reservation for
zero-fee estimation. Outside that domain, the VM can fault where the unbounded
protocol model permits a mathematical result. No matching source-fault claim
is substituted for this disagreement.

## Supporting results

The numeric model proves signed little-endian decoding, signed-256 bounds,
redundant sign-extension acceptance and the GetInteger/ConvertTo distinction.
Boolean and ByteString coercions are modeled; Buffer rejects GetInteger but
supports its separate conversion, while Null's conversion preserves Null.
Its 29 new declarations import seven existing integer declarations. All 36 are
kernel checked; eight definition-valid semantic changes are rejected. This
standalone model does not expand the complete helper's Integer input relation
without an explicit composition theorem.

Reservation arithmetic adds 24 closed declarations and imports 29 existing
declarations. It proves positive paid reservation bounds, estimation
representability, iteration and composition with the original unbounded
protocol on their shared domain. Six definition-valid semantic mutations are
rejected. Counts from different receipts overlap and must not be added together.

The real ApplicationEngine suite passes 38 tests with zero skipped. It uses the
original NEF, manifest, tokens, initializer and native codecs, entering the
private method through a test-only descriptor. The initializer's slot 34 is
asserted to be Buffer `[0x21]`. Tests cover normal and exceptional ledger states,
fee and request limits, numeric tags, read-only permissions, early GAS failure,
and a later outer abort after the helper has written to the pending cache.
The last case distinguishes pending reservation 5 from committed reservation 2.

These are finite runtime checks. The host explicitly applies HALT-only outer
snapshot persistence; it does not run consensus validation, sender funding or
native block fee burning. Injected Map, malformed or negative-reservation
records probe behavior outside the declared reachable-ledger invariant and do
not establish reachable production defects.

## Gate and review

The default fresh gate requests arithmetic, numeric, reservation and complete
helper reference proofs. It rebuilds the source inventory and checks complete
source/tool membership and hashes before and after verification. The helper
receipt is joined to independently decoded method bytes, boundaries and counts,
and to an independently regenerated source projection digest. A well-formed
but different source digest is rejected. No external JSON success certificate
can replace fresh kernel execution.

Independent review also required explicit static-slot state, unbounded source
arithmetic, heap alias preservation, a non-vacuous HALT/ABORT classification,
and distinct dialect, codec, getter, storage and rollback obligations. The
actual source projector rejected unsupported metadata and retained deliberately
changed guards, writes and returns in its output.

The complete gate returns exit 2 while public implementation obligations remain
open. `--allow-partial` changes the development exit code, never the false full
verification result. `--arithmetic-only` explicitly reproduces the historical
region lane and cannot replace the default gate.

The final [host receipt](aa-method-refinement-20261013/host/result.json) records
four accepted proof lanes and zero certified public entrypoints. The
[evidence archive](aa-method-refinement-20261013/README.md) retains the generated
certificate, closed-assumptions audit, negative-control sources/logs, runtime
results and the [local independent review](aa-method-refinement-20261013/review/scoped-review.json).
This is local peer review, not an external audit certification.

| Proof lane | Assumption-audited declarations | Semantic controls |
| --- | ---: | ---: |
| Original arithmetic region | 38 | 9 |
| Numeric coercions | 36 | 8 |
| Reservation arithmetic | 53 | 6 |
| Complete helper reference body | 103 | 6 |

Each lane passes host Rocq 9.2 and the fixed Coq 8.18 container kernel. Counts
include shared imports and definitions and must not be summed. The independent
alias control is additional to the six complete-helper controls.

The container uses image ID
`sha256:49175ab91d07c3446004b93c667b581d34c1702b61cc1d937c8218f439b00941`,
network disabled and read-only inputs. It rechecks the frozen kernel inputs;
it does not claim a Linux Roslyn/NCCS rebuild or Linux ApplicationEngine run.
The [inventory comparison](aa-method-refinement-20261013/inventory-parity.json)
permits only the temporary debug document-root to differ between the two fresh
exports. All remaining JSON, including the 254 inputs, is exactly equal.

| Verification | Result |
| --- | --- |
| Final fresh four-lane gate | All proofs accepted; expected exit 2; full implementation false |
| Host regression suite before fixture isolation | 107/107, no skips |
| Final isolated helper tests on host | 23/23, no skips |
| Final full suite in minimal container | 107/107, no skips |
| Typed exporter tests | 11/11 |
| Original NEF in actual ApplicationEngine | 38/38, no skips |

The final portable tests reconstruct the original NEF container from archived
script/token data and its acquired header, then require the original full
SHA-256. They use no prior checkout, SDK, NuGet cache or contract build output.
The test-only repair changes neither the proof models nor the production
runner's requirement to validate every fresh compilation input.

The [container summary](aa-method-refinement-20261013/container/summary.json),
[final test log](aa-method-refinement-20261013/container/portable-tests-final.log)
and [mount readback](aa-method-refinement-20261013/container/portable-mount-readback.json)
retain the actual results and isolation evidence. A superseded old-fixture
container test run was cancelled and is explicitly excluded from passing counts.
Colima was stopped and Docker context restored to `default`; a separate
[root readback](aa-method-refinement-20261013/environment-readback.json) confirms
the original environment state. The [file index](aa-method-refinement-20261013/index.json)
binds the retained evidence bytes.

| Identity | SHA-256 |
| --- | --- |
| Original NEF | `083ed325f9bdaa6b223662042f32d29f398ba055f507bbdde46daf8113c47f2a` |
| Original manifest | `e79fa04969ef3f0bdd6b9df6afe41acdd19767968575ea38c1cd011ee97e5156` |
| Final fresh inventory | `0c3e1ffcc917d448408d0aafd6908b8ab1985c4afe923117a153586e1bd5962a` |
| Source projection | `28a24f8e2ba8211b12b4dd0b1242b65d2c314510668a432af5e4ba696130f97e` |
| Complete helper certificate | `544a704cc938e44a9131c62b47fd905eb85af5f5fb7824a182ad7b6c92b391b0` |
| Final aggregate receipt | `e5345ac958f14286819367e1b27bce1c2cc3d6866096a52382cf9baafa4a804c` |

Reproduce the source-bound gate from the repository root with a new output
directory (exit 2 is the expected partial-proof result):

```sh
python3 formal/refinement/verify.py --timeout-seconds 1800 \
  --output-dir /tmp/aa-method-refinement-fresh
```

## Remaining implementation obligations

All 100 ABI entries still require their own certificates and composition with
reachable helpers. The caller must establish the request value relation, stable
transaction fields, static initialization and persisted ledger invariants.
Actual binary serialization, native storage and permission effects, transaction
rollback, callbacks/reentrancy, gas/resource faults, compiler/frontend semantics
and the real ApplicationEngine need correspondence proofs. The native standard
track is separate; ordinary reimbursement is not native sponsorship activation.

No remote push, public-network write, deployment or signing is part of this work.
