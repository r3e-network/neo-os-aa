# Operations Manual

This book is for node operators, release engineers and validators: the runbooks for
live testnet validation and read-only mainnet validation, the post-deployment smoke
checklist for a new frontend build, and the recorded local performance baseline.

## Contents

1. [Validation runbooks (testnet + mainnet)](#1-validation-runbooks-testnet--mainnet)
2. [Post-deploy smoke test](#2-post-deploy-smoke-test)
3. [Performance baseline](#3-performance-baseline)

## 1. Validation runbooks (testnet + mainnet)

This chapter covers both live testnet validation and the read-only mainnet
validation of the published SA anchors.

### Quickstart

Before any live validator run, check the plan and environment readiness first:

```bash
cd sdk/js
cp .env.example .env
# fill in TEST_WIF or NEO_TESTNET_WIF (funded testnet account)
npm run testnet:validate:dry-run
```

The dry run prints the planned validation stages, marks a required stage
`blocked` when its environment is missing, and names the optional stages it
would skip — without broadcasting anything.

When the dry run looks right, execute the live suite:

```bash
npm run testnet:validate
```

RPC endpoint pinning (`TESTNET_RPC_URL` / `TESTNET_RPC_URLS`), the stage list, and
per-stage commands are covered by the testnet runbook below and the "Live Testnet
Validation" section of the root `README.md`.

### Testnet validation runbook

This runbook executes the v4 SDK testnet validation scripts in the safest recommended order, stopping on the first failure.

#### Required environment

- `TEST_WIF` or `NEO_TESTNET_WIF` set to a dedicated funded Neo testnet account

The paymaster policy probe is the one stage that needs no wallet: it checks an off-chain allowlist pinned to a deployed core, so it needs `SA_CORE_HASH_TESTNET` (the deployed v4 core) and `PAYMASTER_ACCOUNT_ID` (the account that core derived). Without them the suite skips the stage instead of failing.

#### Optional environment

- `SA_VALIDATION_RUN_ID` to name one suite run; every stage then shares the derived `sa-v4-<run id>` deployment tag
- `SA_VALIDATION_DEPLOY_TAG` to override that tag directly
- `SA_MATRIX_SCENARIOS` as a comma-separated list to narrow the plugin matrix to named scenarios (see the file header of `tests/testnet_plugin_matrix.js` for the names)
- `SA_MAX_SYSTEM_FEE` / `SA_MAX_NETWORK_FEE` / `SA_MAX_TOTAL_FEE` to tighten the fee caps the SDK enforces before signing (defaults `50000000` / `5000000` / `55000000`)
- `TESTNET_RPC_URL` to force one Neo N3 testnet RPC
- `TESTNET_RPC_URLS` as a comma- or whitespace-separated Neo N3 testnet RPC candidate list; when unset, the validators auto-probe the official public seeds `seed1` through `seed5.neo.org:20332` and then fall back to `https://testnet1.neo.coz.io:443`
- `MORPHEUS_RUNTIME_TOKEN` preferred, or `PHALA_API_TOKEN` / `PHALA_SHARED_SECRET`, to enable the live Morpheus paymaster relay validator
- `MORPHEUS_TESTNET_RUNTIME_URL` or `MORPHEUS_RUNTIME_URL` to override the default Morpheus testnet runtime URL; otherwise the validators use `https://oracle.meshmini.app/testnet/paymaster/authorize`
- `MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH` to run the Morpheus paymaster worker handler directly from a local checkout, for example `/home/neo/git/neo-morpheus-oracle/workers/phala-worker/src/worker.js`
- `MORPHEUS_PAYMASTER_APP_ID` if the paymaster validator should target a non-default CVM app
- `PAYMASTER_ACCOUNT_ID` if you want to replay against a fixed existing allowlisted account instead of deriving the bootstrap account from `TEST_WIF`
- `SKIP_PAYMASTER_ALLOWLIST_UPDATE=1` if you already manually allowlisted the account on the Morpheus worker
- `PHALA_SSH_RETRIES` to tune CVM bridge retries for the paymaster validator
- `PHALA_CLI` to override the Phala CLI launch command. When unset, the validators prefer a global `phala` binary and otherwise fall back to `npx --yes phala`.

If the public `paymaster/authorize` endpoint returns `401` or `403`, or a direct request fails before an HTTP response is available, the off-chain validators automatically retry through the remote worker path via `phala` / `npx phala` when the CLI is available. For deterministic local validation, set `MORPHEUS_LOCAL_PAYMASTER_HANDLER_PATH`; the validators then exercise the worker handler locally while still submitting the relay transaction to Neo N3 testnet.

#### Dry run

From `sdk/js`, print the planned commands without broadcasting anything:

```bash
./run_testnet_validation_suite.sh --dry-run
```

The dry run marks a stage `blocked` when a required variable is missing and `skip` when an optional stage cannot run, so the plan it prints is the plan the live run can execute.

#### Live execution

From `sdk/js`, run the full ordered suite:

```bash
./run_testnet_validation_suite.sh
```

The suite writes `docs/reports/sa-testnet-validation-suite.latest.json` and `docs/TESTNET_VALIDATION_SUMMARY.md`, both stamped with the run id, the deployment tag and the core under test.

#### v4 deployment model

The kernel and the modules it installs are deployed under their canonical manifest names. Two protocol checks make that mandatory: the SDK client only adopts a core whose manifest is named `SmartAccount`, and the kernel binds a module by comparing the profile's `contractName` with the deployed manifest name (§7.3 of `docs/SA-MODULE-PROTOCOL.md`), refusing a mismatch with `SA_MODULE_CODE_BINDING_MISMATCH`. A run tag would rename the manifest and break both checks, so only non-module contracts (paymaster, address market, test probe) carry the per-run suffix. Because the canonical hash of a given kernel is fixed, a rerun reuses the contracts already on chain instead of spending fees on duplicate deployments.

#### Ordered scripts

1. `tests/testnet_smoke.js`
2. `tests/testnet_plugin_matrix.js`
3. `tests/testnet_market_escrow.js`
4. `tests/testnet_paymaster_onchain.mjs`
5. `tests/testnet_paymaster_policy.mjs` when a paymaster runtime token, `SA_CORE_HASH_TESTNET` and `PAYMASTER_ACCOUNT_ID` are present
6. `tests/testnet_paymaster_relay.mjs` when `MORPHEUS_RUNTIME_TOKEN` or `PHALA_API_TOKEN` is present

#### Individual commands

```bash
npm run testnet:validate:smoke
npm run testnet:validate:plugin-matrix
npm run testnet:validate:market
npm run testnet:validate:paymaster-onchain
npm run testnet:validate:paymaster-policy
npm run testnet:validate:paymaster
npm run testnet:validate:report
```

#### Safety notes

- The runner stops on the first failure.
- Several scripts deploy contracts or broadcast real testnet transactions and mutate live state.
- Testnet validators intentionally ignore generic `NEO_RPC_URL`; use only `TESTNET_RPC_URL` / `TESTNET_RPC_URLS`. Every live script verifies Neo N3 testnet network magic before it can broadcast.
- The plugin matrix deploys the v4 kernel plus the validator and hook modules it exercises, all under canonical names, and records a JSON report under `docs/reports/`.
- The paymaster policy validator exercises explicit deny paths such as wrong `dapp_id`, wrong `account_id`, wrong `target_contract`, wrong `method`, missing `operation_hash`, and over-limit gas.
- The paymaster validator can reuse a fixed allowlisted account or register a fresh account and update the worker allowlist live.
- The public paymaster endpoint is allowed to enforce hosted anti-abuse controls. Local handler validation proves policy logic and relay wiring without weakening that production boundary.
- Prefer a disposable test key and a fresh or resettable testnet environment before running the full suite.
- Re-running the suite against the same live state can change outcomes because nonces, verifier keys, allowlists, and balances move forward.

### Mainnet read-only validation

This runbook validates the published Neo N3 mainnet SA anchors without broadcasting transactions.

Run from `sdk/js`:

```bash
npm run mainnet:validate:readonly
```

The validator checks:

- the generated Morpheus mainnet registry has the expected network magic
- the public mainnet runtime catalog and status endpoints are reachable and operational
- the mainnet SA core, Web3Auth verifier, session-key verifier, and social-recovery verifier contracts are deployed
- each deployed manifest exposes the required read/write entrypoints for the published architecture

The latest report is written to `docs/reports/sa-mainnet-readonly.latest.json`.

## 2. Post-deploy smoke test

Use this checklist immediately after deploying a new frontend build.

### Goal

Confirm that the latest deployed frontend is actually live, not stale, and that the critical wallet, native workspace, docs, and operations flows still work.

### 1. Version and cache checks

- Confirm the deployed revision is the intended commit.
- Confirm the CDN / hosting cache has been refreshed.
- Hard refresh the browser once after deployment.
- If a stale bundle still appears, clear site data and reload.

### 2. Browser console checks

Open the site with DevTools enabled and verify:

- no `t is not a function` errors
- no `No supported Neo wallet provider detected in browser.` error when NEOLine is installed
- no unexpected Vue render errors on first page load

### 3. Wallet Detection

With NEOLine installed, verify the frontend can detect module-style providers such as:

- `window.NEOLineN3.N3`
- `window.NEOLine.NEO`

Then:

- click the Neo wallet connect action
- confirm a wallet prompt or account response appears
- confirm the UI reflects the connected wallet state

### 4. Native workspace checks

Open the native account workspace and confirm each of its tabs renders without exceptions:

- Account & recovery
- Create account
- Modules
- Native operation

Expected result:

- tab labels and panels render normally
- with an account loaded, the Modules tab lists its installed validator and hook modules
- no `t is not a function` console error appears

### 5. Operations checks

Verify the primary frontend flows still render:

- Home operations workspace loads
- Load Account panel renders
- Compose / signature / broadcast sections render
- Docs page opens
- Transaction info page renders if a draft or tx route is available

### 6. Relay and submission checks

If relay is enabled in the environment:

- verify relay preflight UI still renders
- verify operator actions do not fail immediately on load
- verify no new 5xx or malformed error messages appear in the UI

### 7. Pass criteria

The deployment passes this smoke test if:

- the intended build is live
- no runtime exceptions appear in console for core pages
- wallet detection works for supported providers
- the native workspace tabs render correctly
- operations pages remain usable

### 8. If the smoke test fails

Capture and report:

- deployed commit SHA
- loaded asset filenames from DevTools network panel
- exact console error text
- browser + extension version
- hosting platform or CDN details

## 3. Performance baseline

Performance claims apply to a pinned runtime, compiled module bytes, fee schedule
and workload. The local VM benchmark measures execution cost and latency; it does
not measure public-network throughput, consensus, transaction propagation, wallet
signing, network fees or confirmation latency.

### Target and preserved behavior

The existing [module budget receipt](reports/sa-native-multisig-budget-20261009.json)
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

### Reproduction contract

Build baseline and candidate modules separately with
`scripts/build_native_modules.py`, using the same compiler, package cache,
repository restore policy and immutable runtime. Each build compiles all supported
modules twice and checks byte-for-byte reproduction. Retain both build receipts;
never overwrite a historical receipt or substitute a newer source pin into it.

Run `tests/NativeMultiSigProbe` in Release configuration against each artifact
directory. The custom acceptance mode checks real module NEFs, actual proxy
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

### Recorded local comparison — 2026-10-09

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
cases. The [custom acceptance receipt](reports/native-domain-copy-20261009/candidate-acceptance.json)
also passes the existing identity and finite-scenario validator. The strict
improvement check rejects the baseline compared with itself and accepts the
candidate. The comparator's 15 unit tests cover malformed or mismatched receipts,
state effects, quantiles and the improvement gate.

### Native Boolean result comparison — 2026-10-09

This bounded native-only candidate concerns the composite post callback's
result snapshot. An exact VM Boolean is immutable, so each approved child can
receive the original Boolean value, including `false`. Every other result type
continues through the existing serialization and independent deserialization
path: null, Integer, ByteString, Buffer, Array, Struct and Map receive no shortcut.
Unsupported or cyclic result graphs must still fail before any child post call.
Each child's operation arguments remain an independent deep copy.

This candidate is inside `SMARTACCOUNT_NATIVE`; the custom contract path is
unchanged. It preserves both fresh policy commitments, current domain and
authority reads, phase and code checks, and atomic rollback. No budget, fee
schedule, module version or storage format change is part of it.

The new comparison repeats all 18 scenarios with five warmups and 30 measured
samples per version under the same pinned runtime. For maximum-argument
`SSN/110`:

| Measurement | Range-copy baseline | Boolean result candidate |
| --- | ---: | ---: |
| Post-execution callback, GAS | 0.95454583 | 0.91399672 |
| Callback headroom | 4.545417% | 8.600328% |
| Validation callback, GAS | 0.67744195 | 0.67744195 |
| Application consumption, GAS | 1.89580941 | 1.85526030 |
| Minimum admission fee, GAS | 1.89702613 | 1.89702613 |
| Local execution p50, ms | 8.723583 | 8.767458 |
| Local execution p95, ms | 10.680916 | 10.651084 |
| Logical operation growth | 3 keys / 200 bytes | 3 keys / 200 bytes |

The post callback saves 4,054,911 datoshi, or 4.248%. The minimum admission fee
remains unchanged because it includes the bounded callback reservation; lower
consumption does not imply an equal reduction in the fee budget required for
admission. The candidate NEF is 19 bytes larger, which increases the fixture's
starting logical storage by 19 bytes. The timing measurements show no consistent
latency improvement and retain the sequential-run and signature-byte limits
described above.

The native build reproduces twice. The default 20 controls remain present, and
an instruction diagnostic reconciles every callback's charges with its recorded
budget. Its Boolean result path changes from one result serialization and two
result deserializations to zero; argument copying remains intact. Separate
module tests cover Boolean true/false propagation, every listed non-Boolean type,
mutable results isolated between children and from the original, and unsupported
or cyclic results rejected before any child post call with storage rolled back.
Those ownership tests use a permissive test service in a public VM; they do not
establish native contract authorization.

The new raw samples, build and semantic receipts are retained as separate review
artifacts. Earlier committed receipts remain historical evidence. Candidate NEFs
remain outside the public build directory pending separate native delivery;
the custom contract's source with `SMARTACCOUNT_NATIVE` disabled is identical
before and after this change.

### Further measurement boundaries

The separate SDK runtime runner can measure loopback transaction submission and
confirmation with real signing. Its one-second private-chain block interval and
500-millisecond receipt polling interval are part of that environment. Such a
measurement must separate preparation, signing, submission and confirmation and
record both system and network fees. It cannot establish public-network capacity.

Long-running storage growth, contention, sustained node load, and multiple host
architectures require separate experiments. Passing the local budget and timing
comparison establishes only the measured optimization under the recorded inputs.
