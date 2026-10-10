# Native account performance measurements

Performance claims apply to a pinned runtime, compiled module bytes, fee schedule
and workload. The local VM benchmark measures execution cost and latency; it does
not measure public-network throughput, consensus, transaction propagation, wallet
signing, network fees or confirmation latency.

## Target and preserved behavior

The existing [module budget receipt](reports/aa-native-multisig-budget-20261009.json)
records a maximum-argument `SSN` roster with slots `110`: its post-execution
callback consumes 95,694,229 datoshi of the unchanged 100,000,000-datoshi limit.
That leaves 4,305,771 datoshi, or 4.305771%, of headroom at the recorded pricing.
This historical receipt remains immutable.

The optimization replaces the 32-iteration owned-byte copy in
`MultiSigVerifier.ReadSignerDomainSets` with a fresh range copy. With three child
domains, the two post-execution policy commitments perform six such copies.
Domain lengths, duplicate checks, child ordering, quorum selection, callback
authority, and policy commitments before and after child execution stay intact.
No callback limit, module version, authorization rule or fee schedule changes.
New compiled bytes have a new artifact identity; already deployed modules do not
acquire the change automatically.

The pinned framework maps `Helper.Range` to the VM `SUBSTR` instruction. The
existing `NeoNativeVerifier.GetSignerDomains` uses the same operation to extract
owned 32-byte domains. The range starts at zero and its length remains exactly
32 after the existing input check.

## Reproduction contract

Build baseline and candidate modules separately with
`scripts/build_native_modules.py`, using the same compiler, package cache,
repository restore policy and immutable runtime. Each build compiles all supported
modules twice and checks byte-for-byte reproduction. Retain both build receipts;
never overwrite a historical receipt or substitute a newer source pin into it.

Run `tests/NativeMultiSigProbe` in Release configuration against each artifact
directory. The ordinary acceptance mode checks real module NEFs, actual proxy
Verification, both callback budgets, basic and maximum arguments, malformed
proofs, insufficient quorum, duplicate identities, phase denial and atomic
rollback. Its transaction signers are synthetic and it uses an in-memory store.

For each source snapshot, build to a new output directory:

```sh
python3 scripts/build_native_modules.py \
  --contracts "$SOURCE_ROOT/contracts" \
  --compiler "$NATIVE_COMPILER" --cache "$NATIVE_PACKAGE_CACHE" \
  --output "$MODULE_OUTPUT" --receipt "$MODULE_BUILD_RECEIPT"
```

Then run the same benchmark source and runtime against each module output:

```sh
dotnet run --project tests/NativeMultiSigProbe/NativeMultiSigProbe.csproj \
  --configuration Release \
  -p:NativeRuntimeDirectory="$NATIVE_RUNTIME" \
  -p:UseArtifactsOutput=true -p:ArtifactsPath="$PROBE_BUILD_OUTPUT" \
  -p:UseSharedCompilation=false -- "$MODULE_OUTPUT" \
  --benchmark --warmup 5 --samples 30
```

Use the SDK version recorded by the runtime build receipt. Separate build logs
from the emitted JSON receipt; a build failure is not a benchmark result.

The optional repeatable benchmark uses warmup iterations followed by measured
samples from identical cloned starting state. Account nonce, chain time, operation
bytes and policy remain fixed. Setup, compilation, signing, diagnostics and
storage enumeration are outside the measured execution interval. The receipt
retains raw samples, sample counts, runtime and module hashes, host information,
actual consumption and minimum admission fee. Nearest-rank p50 and p95 describe
this host and workload; a low sample count does not establish a stable tail.

State measurements count logical keys and serialized key/value bytes before and
after execution. They are not physical database size or long-term node growth.
Rejected cases must leave committed state unchanged. Successful samples expose
their tentative write deltas while discarding the cloned snapshot so the next
sample begins from the same state. Diagnostic callback-cost collection is separate
from timing so instruction tracing does not inflate the reported latency.

The comparison must reject different runtime hashes, pricing, scenario parameters
or benchmark source. Only the intended module artifact may differ. A baseline
compared with itself must fail the strict-improvement gate; the candidate must
retain all functional controls and reduce the target post-execution callback cost.

```sh
python3 scripts/native_budget_benchmark.py compare \
  "$BASELINE_BENCHMARK" "$CANDIDATE_BENCHMARK" \
  --allow-artifact-change MultiSigVerifier.nef \
  --allow-artifact-change MultiSigVerifier.manifest.json \
  --require-improvement --output "$BENCHMARK_COMPARISON"
```

## Recorded local comparison — 2026-10-09

The [comparison receipt](reports/native-domain-copy-20261009/comparison.json)
retains both sets of raw samples and all 18 scenario comparisons. Each version
uses five warmups and 30 measured samples per scenario, for 540 measured samples.
The host was macOS 15.7.7 on Arm64, .NET 10.0.11, built with SDK 10.0.400 in
Release configuration. The [validation receipt](reports/native-domain-copy-20261009/validation.json)
binds the source change, build receipts, runtime identity, comparator and tests.

For the maximum-argument `SSN/110` case:

| Measurement | Baseline | Range copy |
| --- | ---: | ---: |
| Post-execution callback, GAS | 0.95694229 | 0.95454583 |
| Callback headroom | 4.305771% | 4.545417% |
| Validation callback, GAS | 0.67864018 | 0.67744195 |
| Application consumption, GAS | 1.89940410 | 1.89580941 |
| Minimum admission fee, GAS | 1.89940410 | 1.89702613 |
| Local execution p50, ms | 9.413208 | 7.895625 |
| Local execution p95, ms | 11.443416 | 10.976542 |
| Logical operation growth | 3 keys / 200 bytes | 3 keys / 200 bytes |

The deterministic post-execution saving is 239,646 datoshi, or 0.2504% of that
callback's previous consumption. The budget remains close to its limit; this
small change does not establish broad efficiency or sufficient margin for future
module changes. The 75-byte reduction in the NEF also reduces this fixture's
starting logical storage by 75 bytes. It does not change the operation's storage
growth.

The timing percentiles describe these runs. Baseline and candidate ran sequentially
on the same host; scheduling, concurrent work and runtime warmup can affect the
difference. No latency improvement threshold or public-network claim follows
from them.

Operation and signature bytes stay fixed across repetitions within each scenario
run. Baseline and candidate configure the same scenario and signing keys but
generate signatures separately; the receipts do not prove identical signature or
transaction-script bytes across those two runs. Their recorded shapes, semantics
and deterministic fee results are compared. This is another reason to treat the
timing difference as observational.

Both module builds were reproduced twice. Baseline module artifacts exactly match
the historical final module receipt. This run uses a separately pinned source-built
runtime whose assembly hashes differ from the historical budget probe; it measures
both versions again under that same runtime and reproduces the historical target
cost. The [runtime build receipt](reports/native-domain-copy-20261009/runner-build.json)
and each benchmark's loaded assembly hashes preserve that distinction.

All 20 functional controls remain present, including two cross-scheme signer-domain
cases. The [ordinary acceptance receipt](reports/native-domain-copy-20261009/candidate-acceptance.json)
also passes the existing identity and finite-scenario validator. The strict
improvement check rejects the baseline compared with itself and accepts the
candidate. The comparator's 15 unit tests cover malformed or mismatched receipts,
state effects, quantiles and the improvement gate.

## Further measurement boundaries

The separate SDK runtime runner can measure loopback transaction submission and
confirmation with real signing. Its one-second private-chain block interval and
500-millisecond receipt polling interval are part of that environment. Such a
measurement must separate preparation, signing, submission and confirmation and
record both system and network fees. It cannot establish public-network capacity.

Long-running storage growth, contention, sustained node load, and multiple host
architectures require separate experiments. Passing the local budget and timing
comparison establishes only the measured optimization under the recorded inputs.
