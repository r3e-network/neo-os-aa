# Native MultiSig VM budget and policy probe

Run from the repository root against an explicitly built native core runtime and
its matching packaged module artifacts:

```sh
dotnet run --project tests/NativeMultiSigProbe/NativeMultiSigProbe.csproj \
  -p:NativeRuntimeDirectory=/absolute/path/to/source-built/runtime \
  -p:UseArtifactsOutput=true -p:ArtifactsPath=/absolute/path/to/isolated/artifacts \
  -- /absolute/path/to/native-module-artifacts
```

The host has no Neo NuGet dependency. Its committed restore lock is intentionally
empty; the supplied runtime DLLs determine execution. Never substitute a public
Neo package or use a different profile digest. The JSON receipt binds both NEF
and manifest bytes, loaded Neo assembly hashes, probe sources and the lock.
The surrounding source-runtime build receipt supplies core commit provenance.

This is an in-memory ApplicationEngine probe using real compiled module NEFs,
real P-256 operation signatures and synthetic transaction signers. It checks the
actual proxy Verification script under the global 1.5 GAS ceiling, and Application
under unchanged 1 GAS callback limits. It does not relay transactions, validate
external payer signatures, use a public network or prove private-chain persistence.
The separate SDK/NeoExpress runner covers those boundaries.

The matrix includes Session/Native and two-Session pairs; all three 2-of-3 slot
positions; surplus proofs with only the first quorum charged; an invalid first
signature followed by two approvals; malformed unused slots; quorum failure;
maximum 128-byte description, positive 255-bit amount, 191-bit nonce channel,
4096 serialized argument bytes and depth-eight argument data. Storage, nonce,
metadata projection, public signing preimage and phase-denial assertions accompany
the gas checks. Public-key vectors include both standard encodings, duplicate
Session/native identities, invalid-point rollback and revocation cleanup.

Pricing is recorded explicitly. These measurements concern the tested official
modules at that pricing, not arbitrary third-party bytecode or all future
consensus/governance fee schedules. Clients must still simulate their exact
transaction and enforce independent fee limits.

The optional `--diagnose` argument records failed positive cases for cost triage;
a diagnostic receipt reports `FAIL` and must never be used as an acceptance gate.

## Repeatable local execution measurements

See [the recorded performance comparison](../../docs/NATIVE_ACCOUNT_PERFORMANCE.md)
for measured results, build provenance and remaining limits.

Use a Release build and add `--benchmark` to emit a separate
`smartaccount-native-multisig-benchmark/v1` receipt. The default without this
option remains the existing acceptance receipt. `--diagnose` cannot be combined
with benchmark mode because every acceptance assertion must pass.

```sh
dotnet run --project tests/NativeMultiSigProbe/NativeMultiSigProbe.csproj \
  --configuration Release \
  -p:NativeRuntimeDirectory=/absolute/path/to/source-built/runtime \
  -p:UseArtifactsOutput=true -p:ArtifactsPath=/absolute/path/to/isolated/probe \
  -p:UseSharedCompilation=false \
  -- /absolute/path/to/native-module-artifacts \
  --benchmark --warmup 5 --samples 30 > /absolute/path/to/benchmark.json
python3 scripts/native_budget_benchmark.py validate /absolute/path/to/benchmark.json
```

Each of the 18 operation scenarios is configured once. Its warmups and samples
reuse the same transaction script, signatures, signers, block time and initial
nonce. Every invocation runs against a new clone of that starting snapshot;
successful and failed clones are both discarded. The probe checks that the
original committed snapshot stays unchanged after every warmup and sample.
Baseline and candidate runs generate signatures separately. The fixed-byte claim
applies within each scenario run; receipts compare scenario parameters and key
semantics, and do not prove identical signature or transaction-script bytes across
different runs.
The original acceptance execution then runs once with diagnostics to check
callback budgets, committed nonce, selected Session allowances, metadata and
rollback. Duplicate-domain and invalid-point controls also run as before.

Only `ApplicationEngine.Execute()` is inside the monotonic `Stopwatch` interval.
Module compilation and deployment, configuration, argument construction,
signing, transaction/engine creation, script loading, snapshot enumeration,
assertions and engine disposal are outside it. Timed execution has no diagnostic
listener. The independent acceptance execution supplies `phaseGas` and
`executionResult`; its per-instruction tracing is never used for latency samples.
Warmups default to 5 and measured samples to 30; counts are explicit in the
receipt and may be changed with `--warmup` (0..10000) and `--samples` (1..10000).
A zero-warmup run includes possible cold JIT work and should be labeled accordingly.

Each sample records raw elapsed ticks, actual fee consumed, the engine's minimum
required fee, VM state and logical storage metrics. Convert ticks to seconds
using `environment.stopwatchFrequency`. `p50Ticks` and `p95Ticks` use the
nearest-rank order statistic: sorted sample at index `ceil(percentile * n) - 1`.
Small samples have coarse percentiles; raw samples remain available for analysis.

Storage metrics count all logical keys and serialized key/value bytes visible
through the snapshot. Key bytes include the serialized contract ID. The starting
snapshot, resulting effective storage and signed deltas are recorded. For a
FAULT, effective storage is the unchanged starting snapshot after discarding
the failed clone, so its deltas are zero. These are logical state sizes, not
physical database allocation, compaction, cache memory or disk writes.

Compare two receipts produced by the same probe source and runtime on the same
host, with identical pricing, scenarios, warmup/sample counts and timing settings:

```sh
python3 scripts/native_budget_benchmark.py compare \
  /absolute/path/to/baseline.json /absolute/path/to/candidate.json \
  --allow-artifact-change MultiSigVerifier.nef \
  --allow-artifact-change MultiSigVerifier.manifest.json \
  --require-improvement --output /absolute/path/to/comparison.json
```

Artifact changes are rejected unless explicitly allowed; this comparison permits
only the named MultiSig artifacts to differ. It preserves raw samples and checks
fee-independent verification results, VM states, logical storage deltas,
post-execution nonce/Session values and the original semantic controls. Absolute
storage bytes are reported but may change with the allowed deployed NEF and
manifest sizes. `--require-improvement` requires strictly lower post-callback GAS
for the maximum `SSN` / `110` boundary case; comparing a receipt with itself must
fail that gate. Timing changes alone do not satisfy the deterministic GAS gate.

These measurements describe one in-memory execution environment. They exclude
mempool admission, external payer witness verification, relay, block production,
network fees, disk persistence and end-to-end confirmation latency. Host load,
thermal conditions, JIT and garbage collection can affect timing even when the
runtime and machine identity match. Keep these conditions controlled, retain the
runtime/module build provenance and raw receipts, and repeat complete runs when
assessing timing variation. Do not extrapolate the results to network throughput.
