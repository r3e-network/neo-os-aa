# AA Formal Verification

## Status

### Bounded configuration postcondition

The native confirmation boundary must re-admit both the selected child and its
bound root after callback execution. A concrete regression reproduced a child
configuration destroying its root and still returning HALT. The repaired path
rechecks the root before committing. `NativeLifecycle.v` models the corresponding
two-binding postcondition and all-or-nothing snapshot selection: missing or
changed bindings select the original snapshot, not the staged callback writes.
Observed binding identities and whole-snapshot rollback remain abstract inputs;
this is not a proof of hashing, ContractManagement or C# callback refinement.
The private receipt `docs/reports/aa-neoexpress-native-configuration-20261006.json`
records ten signed configuration transactions and two registrations, including
two persisted root-destruction FAULTs and benign controls under the same roots.

The repository-local formal artifacts under `formal/` are the inputs to the
fail-closed gate below; the sibling local `neo-os-formal-verification`
workspace carries the parallel verification set.

The current fail-closed AA-local host gate passed on 2026-10-08: **25 Coq
modules, 360 assumption-audited closed declarations, and 198 rejected semantic
mutations** (194 Coq and four TLA mutations). TLC explored 61,460 distinct
states, all six SMT obligations and six controls passed, and the runner suite
passed **52/52**. The current receipt is
`docs/reports/aa-formal-gate-native-multisig-20261008.json`.
The gate now pins 23 source files, including the exact native module authority
guard, selected module profiles and session clock/payload adapters. The entry lemmas require
both the fixed service identity and an authenticated phase grant; a matching
positive control excludes an always-reject implementation. Source pins remain
manual correspondence checks, not a compiler or callback refinement proof.

`NativeCompositePhase.v` adds eleven declarations and six mutations for the
separate validation and post-revalidation entries. The original validation entry
still rejects post-phase grants; the additional read-only entry requires an
exact postExecute grant. Both authorized entries apply the same leaf policy.
Non-Boolean replies are not votes, and the abstract post plan preserves the
configured roster's membership and uniqueness. Grant authenticity, returned
values and runtime dispatch remain abstract inputs, not a refinement theorem.
The module profile is defined in `docs/proposals/SMARTACCOUNT-NATIVE-MULTISIG.md`.

`NativeSessionPolicy.v` has twenty-three declarations and nineteen mutations for
capped authorization, exact debit, failed-target rollback and trigger-dependent
clock selection. The clock selects a persisted ledger timestamp in Verification
and the persisting timestamp in Application; missing ledger time fails closed.
Signature validity, scope, timestamps and transfer shape remain abstract inputs.
These proofs do not mechanize CryptoLib, NeoVM or the C# adapter.
The lifecycle extension proves spending preservation on rotation, cooldown
rejection, distinct revocation/cleanup effects and both zero-amount cap
boundaries. A concrete private-chain regression found that the native source
skipped the cumulative cap check for zero amounts after a cap reduction. The
native validation and postExecute paths now apply the check to zero amounts as
well. A specific mutation restores that bypass and is rejected by the proof
gate. The old-profile branch is unchanged. These are model and runtime evidence,
not a machine-checked proof connecting the two.

`NativeSessionScope.v` adds twenty-two declarations and eighteen mutations for
zero-cap authorization, wildcard target binding, configuration admission,
uncapped result semantics, capped debit and key-reuse boundaries. It does not
replace the capped lifecycle model. Signature validity, completion, key identity,
nonce currency and expiry are abstract predicates, not cryptographic or engine
proofs. In particular, a counterexample shows that restoring the same key can
restore an unconsumed signature's validity; permanent invalidation is not proved
and is not implemented by this profile.

`docs/reports/aa-native-session-scope-validation-20261007.json` records two new
private chains, each with 44 persisted matrix transactions (27 HALT, 17 expected
FAULT), five witness-admission rejections and two registrations. Exact raw
storage and all grant-event fields are compared. A zero-cap false GAS transfer
completes and consumes nonce without spending; a target FAULT rolls back. A
wildcard grant permits read methods and a whole-balance GAS transfer but still
rejects another target. The same retained signature bytes reject while the key
is replaced or revoked, then succeed after explicit regrant; an already consumed
nonce still rejects. These are measured current-protocol semantics, not a fix
for permanent revocation. No production contract or native artifact changed.

`NativeDailyPolicy.v` has twenty-four declarations and fifteen mutations for fixed
window anchoring/expiry, capped positive net-outflow accounting, Boolean-false
return independence, rolling-window inclusion/expiry and the fifty-record bound.
The scan proofs equate the one-pass sum/count with a filtered history, preserve
every live record under pruning, and bound the count after an admitted append.
The balance decoder rejects negative Integers, other types and query faults;
an invalid observation aborts the delta rather than substituting zero. Four
mutations restore coercion or fallback behavior and must be rejected. Mapping
concrete VM values and faults to the abstract reply constructors remains an
external correspondence obligation.
Balances, timestamps and transaction-wide rollback are model inputs, not proven
token or VM behavior. Native DailyLimitHook uses the asset proxy, distinct phase
grants and unconditional net-outflow metering. A private fail-first run reproduced
a snapshot left behind after a false GAS return; the corrected profile clears
the snapshot while preserving the zero-outflow counter. A moving fixed-window
anchor is separately rejected by the model and the private time-shift matrix.
Neither test proves arbitrary-token balance honesty or sufficient callback gas
for every possible configured token set.

The later capacity run reproduced callback gas exhaustion on the twenty-first
live GAS record, before the declared fifty-record ceiling. The native branch
now computes rolling sum/count in one traversal per callback and prunes expired
records during the post-execution traversal. It neither raises the native
2.5 GAS callback budget nor discards live history. The adversarial matrix also
uses a deliberately nonconforming diagnostic token that changes balances and
returns false, plus a rejected nested GAS transfer to verify exact-target
witness isolation. See `docs/reports/aa-native-daily-capacity-validation-20261007.json`
for that repair's measured scope; token honesty and full compiler refinement are
still assumptions, not consequences of the scan proofs.

The current balance-observation extension is recorded in
`docs/reports/aa-native-daily-balance-validation-20261007.json`. Two independent
private chains each pass 116 matrix transactions (87 HALT, 29 expected FAULT)
plus two registrations. Negative Integer, ByteString, Boolean, Null and Array
replies are observed directly from the compiled fixture before policy testing.
Those five cases, query faults and callback-budget exhaustion reject both before
the target and after target writes. The oracle compares raw token storage,
nonce, policy state and account isolation, not a hostile balanceOf result.
Delayed removal of the gas-burning token limit succeeds and a real GAS transfer
then succeeds. Capacity, expiry and six-prefix cleanup are also replayed.
No production contract or native artifact changed in this extension. A prior
fixture run failed on a return-value count mismatch instead of producing the
intended negative value; that failed receipt is retained and is not counted as
policy evidence. Exact getter checks now prevent that false-positive scenario.
These measured paths do not prove arbitrary query behavior or VM refinement.

The native TokenRestrictedHook profile adds distinct phase grants, proxy-asset
queries, exact nonnegative Integer observations, missing-snapshot rejection and
cleanup of both account-scoped prefixes. `NativeRestrictedPolicy.v` adds fifteen
declarations and eight mutations for direct-target rejection, every-token
admission, result-independent net-outflow denial, removal and cleanup. Decoding,
token honesty, storage enumeration and atomic VM rollback remain correspondence
inputs. An abstract cleanup theorem does not establish arbitrary-plugin cleanup.

Two independent private chains each pass 64 matrix transactions (35 HALT and
29 expected FAULT) plus two registrations. A deliberately delegated diagnostic
router moves actual test-token balances without inheriting a proxy witness;
postExecute rejects the outflow even when the router returns false. Zero net
movement and inflows succeed. Seven malformed/failing query cases reject in
both phases; raw token storage, nonce and hook state roll back. Delayed removal
of a gas-burning token permits a subsequent real GAS transfer. Two configured
tokens are exercised before complete account cleanup. The new native build
retains the previous four profiles' eight NEF/manifest files byte-for-byte;
legacy-profile artifacts remain unchanged. Current evidence and explicit
unclosed obligations are recorded in
`docs/reports/aa-native-restricted-validation-20261008.json`.
The same five-profile build is also used for fresh DailyLimitHook, capped
SessionKey, uncapped SessionKey and native-witness/allowlist regressions.
Across six disposable chains, 361 persisted matrix transactions produce 214
HALT and 147 expected FAULT results; 12 registrations and 14 witness-admission
rejections are counted separately. Missing-snapshot rejection is guarded in
source and modeled formally, but is not directly fault-injected on these chains.

The earlier unchanged-bytecode probe is recorded in
`docs/reports/aa-native-nef-probe-validation-20261008.json`. Two independently
built host probes each execute 156 cases (122 HALT, 34 expected FAULT). A missing
snapshot is removed at the authenticated postExecute boundary and rejected;
the entire parent store remains unchanged. Deliberately stale snapshots are
removed by configuration and cleanup without deleting another account's state.
Twelve balance vectors include every defined VM stack-item type, with separate
zero, positive and negative Integer cases. These are representative values,
not exhaustive value, size or serialization proofs. Timelocked administration,
wrong witnesses, mismatched upgrade hashes and a same-artifact update are also
executed. Host transactions are unsigned; they do not replace the real-witness
NeoExpress tests. One additional private replay passes 64 persisted cases.

The phase extension is recorded in
`docs/reports/aa-native-nef-phases-validation-20261008.json`. Two clean builds
each run 230 invocations (177 HALT and 53 expected FAULT). All twelve balance
representatives are now exercised in both phases. A diagnostic token first
returns a valid positive Integer; a host-only storage-mode change at the native
postExecute boundary then selects each reply type. Invalid types, a negative
Integer and zero-after-positive outflow reject with distinct expected reasons.
Each rejected transaction discards the injected mode write, nonce change and
transient hook snapshot. A subsequent valid execution succeeds. Four direct
callback/configuration calls without a phase grant reject, as do four
host-injected malformed callback Arrays. These injections test defensive paths;
they do not assert that the native service emits malformed operations.

Current coverage of the entire 1,076-instruction production NEF is **900 attempted
instructions (83.64%)** and **124 of 182 completed conditional edges (68.13%)**,
up from 890/1076 and 119/182 in the earlier pre-phase probe.
Unvisited administration and defensive code is retained in the denominator.
The collector checks both branch directions, fault-before-completion and every
conditional opcode; it observes fall-through at the next instruction, not too
early in the post hook. The probe executable itself reproduces byte-for-byte.
This is neither C# source-line coverage nor a completed coverage gate, and does
not mechanize compiler or full VM correspondence. Native artifacts are unchanged.

The host TLC binary changed because the previous local jar was unavailable.
The replacement's SHA-256 matches GitHub's published asset digest; provenance is
recorded in `docs/reports/aa-formal-tool-provenance-20261007.json`. The upstream
`v1.8.0` asset is mutable. This is a new host toolchain run, not a replay of the
older container toolchain, and the Docker pin was not silently updated.

The scope includes the bounded MultiSig, authorization, attestation/proof
binding, fault-aware WitnessRule evaluator refinement, ABI projection,
NeoVM call/continuation subsets, signer-domain separation, signer-independence
and cleanup countermodels, signed Integer/nonce arithmetic, shadow cursors,
abstract native lifecycle authority, native-dispatch activation/fee guards, and account/phase/frame invocation isolation.
These are stated abstract obligations, not complete NeoVM or C#-to-NEF
refinement. Remaining non-public proof boundaries are recorded in
`docs/reports/aa-open-formal-boundaries-20261007.json`.

The current native integration worktree now registers actual AccountManagement,
including lifecycle, delayed module configuration, dependency cleanup, bounded
callbacks, exact proxy Verification and target-frame witness enforcement. The
recorded source-built node suite passes 1,702/1,702 tests. The native-host C#
coverage threshold is met for the files enumerated below, not for every native
plugin's C#/NEF paths. The restricted-token pass rechecked all 313 core source pins
and the 104 runtime files but did not rerun that separate node suite. The full
persisted plugin scenario matrix and semantic refinement remain open.
The new service-hash witness restriction has a reproduced failing test and an
activation-gated fix. The private native-service receipt is
`docs/reports/aa-neoexpress-native-service-after-configuration-20261006.json`; it is bounded persisted
lifecycle evidence, not complete native conformance. Source/artifact hashes and
current node-suite results are recorded by the native integration worktree's
`docs/reports/smartaccount-native-source-runtime-validation-20261006.json`. Older
component-only receipts remain historical evidence, not current service status.
The signed proxy receipt `docs/reports/aa-neoexpress-native-proxy-20261006.json`
adds six persisted transactions (two expected FAULTs) and three admission
rejections with exact witness/script and asset-balance readback. Native raw-call
bridge coverage is 100% line/branch; service entry/execution coverage is also
100% line/branch and module management is 100% line, 98.46% branch. All ten new
native/component files and instrumented added engine lines meet the 90% gate.
This does not prove all adversarial paths or full protocol conformance.
`docs/reports/aa-neoexpress-native-recovery-20261006.json` records 25 persisted
recovery/authorization transactions (15 HALT, 10 expected FAULT) and an additional
registration, with actual single/joint P-256 witnesses and complete account/cursor
readback. These are runtime checks, not new cryptographic or WitnessRule proofs.

The native integration runtime is now source-built rather than an assembly
overlay. The initial two-directory offline build and a receipt-pinned two-directory
replay compile eleven projects from 611 source files and 50 external package
archives; all 104 runtime files match byte-for-byte. See
`docs/reports/aa-neoexpress-source-build-final-20261006.json` and
`docs/reports/aa-neoexpress-source-build-replay-20261006.json`. The exact rebuilt
core/VM assemblies also pass all 1,702 node tests. The service, signed proxy,
configuration, recovery and four current activation cases pass again against
the same runtime, with complete runtime-file verification before/after each
matrix: `docs/reports/aa-neoexpress-source-runtime-final-20261006/summary.json`.
Original raw receipts are retained separately from provenance-annotated copies.
No production C# or formal model changed in this build-validation step. Its 72
script tests include failure, interruption, recipe/dependency and runtime-drift
controls. Reproducibility is not a compiler-refinement proof, a complete plugin
matrix, or a current external-dependency security audit.

The last successful pinned-container run covered an older snapshot: 17 Coq
modules, 95 rejected semantic mutations and 40 runner tests. Its receipt is
`docs/reports/aa-formal-gate-20261006-native-integer.json`. The newer shadow
cursor, lifecycle, dispatch, invocation, session and daily-limit changes have
**host evidence only**: neither the Desktop
nor Colima context returned a successful bounded daemon probe. The current status is
`HOST_PASS_CONTAINER_UNAVAILABLE`; an earlier container PASS is not reused for
changed model bytes.

Run from the formal-verification workspace:

```sh
./verify.sh
./verify.sh --report
python3 audit-coverage.py --check-ledger
```

For an AA-repository-local gate with source-hash pinning and semantic
mutation tests:

```sh
python3 formal/verify.py
python3 -m unittest discover -s formal -p 'test_*.py'
```

or, through the repository entrypoint:

```sh
NEOOS_REQUIRE_FORMAL=1 ./scripts/verify_repo.sh --contracts-only
```

The private-chain validation is a separate opt-in step of the same entrypoint
(`--neoexpress` or `NEOOS_REQUIRE_NEOEXPRESS=1`); it needs the `neoxp` tool and
`openssl`, deploys every artifact to a fresh NeoExpress chain, drives the
protocol with real transactions and reads every contract back over JSON-RPC.

The local gate invalidates any previous result before checking, refuses source
hash drift, requires real Coq/Z3/TLC execution, checks final TLC state counts
and action coverage, rejects syntax-only mutations, and records tool/artifact
hashes under ignored `formal/.runs/`.

The gate needs Coq 8.16 or later (Rocq 9 included; the models use the
portable `From Coq` import path, which Rocq 9 accepts with a deprecation
warning), Z3, a JDK and `tla2tools.jar`. On macOS `/usr/bin/java` is a stub
that cannot run TLC; the runner skips it and probes the usual JDK locations,
or set `JAVA_BIN` explicitly. `TLA_JAR` overrides the default
`~/tools/tla/tla2tools.jar`. Without a host toolchain, run the pinned
environment instead:

```sh
formal/verify-in-docker.sh
```

It builds `formal/Dockerfile` (Ubuntu 24.04, Coq 8.18, Z3, OpenJDK, the TLA+
tools jar verified against a pinned SHA-256) and runs both the gate and the
runner's regression tests inside it. The previous 2026-10-06 run passed in the
pinned `linux/arm64` image: 17 modules, 95 semantic mutations, 61,460 TLC
states, 6/6 SMT obligations and **40/40 OK** runner tests. Its raw result is
retained under `formal/.runs/docker-20261006-native-integer-v1`; the old 2026-09-21
result remains historical only. If Docker injects a localhost proxy, the
wrapper accepts `AA_FORMAL_HTTP_PROXY` and `AA_FORMAL_HTTPS_PROXY` to pass a
host-reachable build proxy explicitly. The compatibility claim (the models use
only `List`, `Bool`, `PeanoNat`, `ZArith` and `Lia` lemmas present since Coq 8.16)
was exercised on Rocq 9.2 and Coq 8.18 for those earlier model bytes. The latest
shadow-cursor, lifecycle, dispatch, invocation, session and daily-limit additions
currently have host evidence only. The current host TLC jar has separate
provenance in `docs/reports/aa-formal-tool-provenance-20261007.json`; the mutable
upstream asset no longer matches the retained Docker pin. A host PASS does not
establish a successful build or run of the current container recipe.

**CI status:** `.github/workflows/ci.yml` runs `scripts/verify_repo.sh`, which
does not run the formal gate unless `--formal` or `NEOOS_REQUIRE_FORMAL=1` is
supplied, and the CI image provides neither Rocq 9 nor the TLA tools. The gate
is therefore a local/release obligation, and `verify_repo.sh` prints an
explicit `formal gate: NOT RUN` line whenever it is skipped so the gap is
visible in every CI log rather than implied by a green run.

## ABI projection acceptance obligations

A structural ABI certificate must compare full descriptors (method name,
ordered parameter types, return type, and safe flag), not just counts or
membership in one direction. The expected core surface is the declared public
C# surface plus exactly one compiler-generated `_initialize` descriptor with
zero parameters, `Void` return, and `safe = false`. Method order is irrelevant;
dispatch keys `(name, arity)` must be unique on both sides. Every expected
method must occur and every manifest method must be expected. Equal cardinality
alone cannot establish this: a duplicate method can replace a missing method.

`AbiManifestProjection.v` models this order-independent finite check. Runtime
regressions must reject missing, extra, duplicate, retyped, and reflagged
methods while accepting reordered descriptors. Offsets are independently
checked against the strict NEF decoder. The check has quadratic list-matching
cost for the finite ABI roster; it changes neither on-chain behavior nor the
artifact format and needs no deployment or migration. Its proofs concern ABI
correspondence only, not the behavior of compiled instructions.

The registered `NeoVmContinuationSemantics.v` model now rejects oversized
callback limits instead of truncating them, treats `_initialize` as a per-load
context, preserves the caller budget and continuation through `LoadScript`,
models CALLT/RET return addresses, applies the hardfork gate fail-closed, and
rolls back storage without refunding consumed gas. These are bounded semantic
obligations; they do not constitute a complete NeoVM/ApplicationEngine or
compiler-refinement proof.

The runtime suite additionally differentially checks a fixed 1,032-case corpus of
finite witness-condition trees against the fault-aware reference relation across
read-state permissions and call depths 0 through 2. This strengthens concrete
implementation correspondence, but remains bounded test evidence rather than a
mechanized `ApplicationEngine` refinement.

## AA artifacts

### Evidence validation requirements

The rebuild certificate must label scratch-build hashes as `fresh_artifact_sha256`
and local candidate hashes as `release_artifact_sha256`, including on a failed
comparison. Both complete maps, including manifests and duplicated plugin output
paths, must agree with each other and with the current release directory before
the provenance join accepts a PASS receipt. A Boolean PASS field alone is not
evidence of byte equality. Missing files, extra files, contradictory verdicts,
and changed bytes must fail closed. These are linear-time integrity checks over
local files, not a replacement for a compiler proof or a signed attestation.

The core ABI correspondence test compares public static C# method signatures and
safe flags to the NEF manifest, excluding CLR event accessors and explicitly
including the generated `_initialize` method. This is a structural test only;
it does not establish instruction-level equivalence. Verifier-domain replay
tests must include a positive control using the same key: rejecting every
signature is not sufficient evidence of domain separation.

### Witness evaluator correspondence

The parser-to-evaluator proof obligation is to derive sufficient evaluation
fuel from an accepted condition, rather than require an externally supplied
`Enough` certificate. For the modeled depth limit of three and fan-out limit
of sixteen, `F(0) = 1` and `F(d + 1) = 17 + F(d)` give a conservative bound
of 52 for a condition and `52 + length(rules)` for rule traversal. This fuel
is a termination measure of the model, not NeoVM instructions or GAS. The
gate must reject changes to the parser bounds or fuel recurrence; proving
these bounds does not certify the concrete binary/JSON parser or compiler.

The private-artifact provenance checker must parse NEF framing before using
its script as readback evidence: all fields must fit before the checksum,
reserved bytes must be zero, variable lengths and token fields must be valid,
the script must be non-empty, and exactly four checksum bytes must remain.
A matching hash alone is not proof of a valid NEF. These structural checks
remain separate from instruction decoding, ABI checks, and compiler refinement.

The Boolean WitnessRule model describes evaluation only when group-state
reads are permitted. A fault-aware extension must distinguish a condition
that returns `false` from an evaluation that faults: `Group` and
`CalledByGroup` require `ReadStates`, including when no calling contract
exists. `Not` must preserve faults; `And`, `Or`, and the first-match rule
loop must preserve Neo's left-to-right short-circuit behavior. A later allow
rule must not mask an earlier condition fault.

The correspondence obligation is explicit. `WitnessRuleRefinement.v` now
constructively derives the fuel certificate for every tree accepted by its
parser predicate. The condition and rule-list refinement theorems require only
parser admissibility and `ReadStates`, not an external `Enough` assumption.
The two model parser predicates are compared by a runner regression test to
reject shape drift. Five additional semantic mutations cover fan-out,
non-emptiness, depth, rule-condition depth, and insufficient fuel.
Concrete engine tests cover both permission settings, all condition kinds,
the no-caller case, entry/direct/deep calling contexts, and scope expansion
before explicit rules. Binary/JSON parser regressions exercise empty,
one-child, sixteen-child, and seventeen-child compounds, plus a full-width
three-level tree and a forbidden fourth level in its last descendant.
This closes the stated structural evaluator refinement; it remains distinct
from a mechanical decoder or complete `ApplicationEngine` refinement,
transaction signature verification, validated manifest-group signatures,
or the entire NeoVM.

The AA-repository-local copies under `formal/` are the artifacts `formal/verify.py`
compiles, model-checks and mutation-tests; the sibling workspace carries the same
models under `verified/` for its own `verify.sh`.

| Artifact | Scope |
|---|---|
| `formal/coq/UnifiedSmartWalletAA.v` (sibling: `verified/coq/`) | Closed Coq proofs for authorization, exact channel nonce use, rollback, reentrancy, escape-owner gating and success-only state transitions |
| `formal/coq/MultiSigPolicy.v` | Closed bounded threshold-policy proofs for configuration validity, exact signature cardinality and threshold support; child identity is abstract |
| `formal/coq/ProxyWitnessScript.v` | Byte-level model of the proxy-witness transaction-script parser (`ScriptIsSingleExecuteCall`, `ScriptPrefixIsDataPushes`, `DataPushInstructionSize`): an accepted script is a data-push walk landing exactly on the expected `executeUserOp`/`executeUserOps` call, every instruction start in that walk is a data-push opcode (so no SYSCALL/CALL/JMP/TRY precedes the core call), acceptance binds account id and core hash, and the canonical shapes are reachable while a leading non-push opcode, a foreign account id, an out-of-range CallFlags push and a trailing instruction are rejected |
| `formal/coq/CallbackPluginTopology.v` | Closed abstract correspondence model for the six-field hook callback tuple, the complete success order including hook and verifier post-callbacks, CalledByEntry/Custom target binding, fail-closed plugin cleanup/rotation, atomic leaf-child cleanup, and core-owned dependency-registry replacement for shipped composites; it is not a proof of NeoVM dispatch or arbitrary plugin storage |
| `formal/coq/VerifierGasBudget.v` | Closed abstract model of bounded callback charging: every charge checks the callback and all ancestor budgets before mutation, exhaustion is atomic, and nested callbacks cannot escape an ancestor cap |
| `formal/coq/AuthorizationEvidence.v` | Closed protocol-level binding and replay model for cryptographic, native-witness, attestation and proof evidence; primitive validity is an explicit oracle, so this is not a proof of ECDSA, witness-rule evaluation, attestation or ZK soundness |
| `formal/coq/AttestationProofBinding.v` | Closed protocol-envelope model for attestation and zero-knowledge evidence: account, target, nonce, issuer, measurement commitment, non-zero nullifier and single-use binding; primitive cryptographic and proof validity remain explicit oracle inputs |
| `formal/coq/WitnessRuleSemantics.v` | Closed bounded model of Neo's first-match rule decision, default deny, allow/deny precedence, entry/direct-child scope, condition composition, and parser depth/child limits; it is not a refinement proof of `ApplicationEngine` or group-key cryptography |
| `formal/coq/WitnessRuleFaultSemantics.v` | Closed fuel-bounded model of `ReadStates` faults, left-to-right And/Or short-circuiting, fault propagation through `Not`, and first-match fault behavior; concrete engine tests cover the corresponding permission and scope paths |
| `formal/coq/WitnessRuleRefinement.v` | Closed refinement from parser-admissible fault-aware condition/rule evaluation to the Boolean model under readable permission; the uniform fuel certificate is derived rather than supplied, and does not refine the binary/JSON decoder or complete `ApplicationEngine` |
| `formal/coq/NeoVmCallSubset.v` | Closed bounded transition-shape model for the proxy-relevant push/PACK/contract-call/RET subset; it rejects unsafe prefixes, truncated tails and trailing instructions, but is not the complete NeoVM or `ApplicationEngine` semantics |
| `formal/coq/NeoVmContinuationSemantics.v` | Closed bounded model of callback-limit admission, CALLT/RET continuations, `LoadScript` budget inheritance, per-load initialization, hardfork gating, ancestor charging, and storage-only rollback; it is not a complete VM or compiler-refinement proof |
| `formal/coq/AbiManifestProjection.v` | Closed finite, order-independent ABI projection model requiring exact source/manifest coverage, unique `(name, arity)` dispatch keys, parameter/return/safe equality, and the generated initializer |
| `formal/coq/SignerDomainSeparation.v` | Closed binding model requiring exact authorization domain and payload equality; it rejects cross-domain replay but does not prove private-key independence or primitive cryptographic soundness |
| `formal/coq/SignerIndependence.v` | Closed finite countermodel showing that distinct public signer domains do not imply private-key independence; this is an explicit trust-boundary proof, not a key-generation proof |
| `formal/coq/PluginLifecycle.v` | Closed finite countermodel showing that a lifecycle ABI does not imply complete cleanup of arbitrary future-plugin storage, plus a conditional theorem for a certified cleanup function |
| `formal/tla/UnifiedSmartWalletAA.tla` (sibling: `verified/tla/`) | Finite state-machine exploration of Begin/success/failure/Tick transitions |
| `formal/tla/UnifiedSmartWalletAA.cfg` | TLC bounds and safety invariants |
| `formal/smt/aa_core.smt2` (sibling: `verified/smt/`) | Nonce arithmetic, cursor advancement, rollback equalities, reimbursement cap and budget arithmetic |
| sibling `reports/aa-formal-20260918/README.md` | Human-readable result and boundary report |
| `formal/verify.py` | AA-local fail-closed runner with source pins and semantic mutations |
| `formal/Dockerfile`, `formal/verify-in-docker.sh` | Pinned Ubuntu 24.04 environment (Coq 8.18, Z3, OpenJDK, TLA+ tools jar pinned by SHA-256) so an independent reviewer runs the identical gate without a host toolchain |
| `formal/test_verify.py` | Runner/parser fail-closed regression tests |
| `formal/source-lock.json` | Reviewed source snapshot hashes; not a proof attestation |

### Witness-condition depth correspondence

The parser depth budget counts every condition node, including leaves. At
budget three, `Not(Not(Boolean))` is valid and `Not(Not(Not(Boolean)))` is
invalid. Both binary and JSON parsing reject any node at budget zero. The
model must apply that check before dispatching on the condition kind, not
only when descending through `Not`, `And` or `Or`. Runtime regression vectors
cover both parsers at and beyond this boundary, and the formal mutation gate
must reject removal of the zero-depth guard. This is bounded parser-shape
correspondence, not a proof of complete transaction decoding or cryptography.

The current Neo bounded-call core branch based on `master-n3` also passed the
complete 1,453-test `Neo.UnitTests` suite, including 26 `WitnessCondition`
tests and 150 `ApplicationEngine`/interop tests covering caller-context,
call-permission, bounded callbacks, Huyao pricing and RET-accounting paths.
The read-only result is recorded in
`docs/reports/aa-neo-core-semantic-validation-20261006.json`; these tests
strengthen implementation evidence but do not replace the missing mechanized
full-semantics or compiler-refinement proof.

## Security boundaries

### Verifier resource-boundary status

The current deployed UnifiedSmartWalletV3 prototype routes both application-trigger
verifier and hook callbacks through `System.Contract.CallWithGasLimit`. Verifier
callbacks use a 1,000,000,000-datoshi (10 GAS) budget and hook callbacks use a
separate 250,000,000-datoshi budget. The matching Neo core/DevPack runtime
activates the syscall at `HF_SmartAccountV1`; ordinary nested calls and bounded
descendants consume the ancestor chain, and whitelist charging cannot bypass it.
The native SmartAccount profile uses a separate 100,000,000-datoshi verifier
budget, which is below Neo's 150,000,000-datoshi `MaxVerificationGas` envelope.
The isolated core passes targeted bounded verifier and hook callback vectors and
the repository unit suite. A fresh private NeoExpress chain activates the
hardfork at block 0, drives adversarial burning verifier and hook callbacks to
`The bounded contract call gas limit has been exhausted.`, confirms
nonce rollback, and reads all 25 deployed artifacts back with byte-identical
NEF scripts and matching manifests. This closes the bounded-callback property
for the matching private artifact only; it does not prove the native
AccountManagement contract, cryptography, full NeoVM refinement, or any public
activation/deployment. The current receipt is
`docs/reports/aa-neoexpress-validation-20261006.json`.

The models do not prove cryptography, the concrete witness-rule parser or
`ApplicationEngine` implementation, full Neo VM semantics, or C#-to-NEF callback refinement, session lifecycle,
paymaster policy resolution, or C#-to-NEF/deployed-bytecode equivalence.
The `NeoVmCallSubset.v` and `NeoVmContinuationSemantics.v` models close only
bounded transition and callback-budget obligations relevant to the proxy and
SmartAccount callback boundaries; they are deliberately not presented as the
complete VM semantics. The source-to-artifact certificate separately closes
rebuild provenance and byte drift for the private artifact, but not compiler
correctness.
The MultiSig model separately proves the finite policy layer: non-empty,
at-most-ten, nonzero/distinct child identifiers, threshold bounds, exact
signature-array cardinality, threshold support, and preservation of a
distinct signer-domain projection for the approved subset. The concrete
profile now obtains canonical 32-byte signer-domain commitments from every
protocol-defined leaf, rejects duplicate commitments at configuration time,
and re-checks them before validation and child post-execution. This closes
accidental configured-key reuse for those profiles. It does not prove private
key independence, cryptographic correctness, witness-rule evaluation, honest
behavior by arbitrary third-party plugins, or full child-call refinement. The
runtime suite adds negative domain-reuse and post-configuration revalidation
vectors alongside the 2-of-2/1-of-2/native-witness vectors; these remain
bounded VM evidence rather than a complete NeoVM or cryptographic proof. The
policy model also proves that its abstract post-callback roster is unique,
configured, and threshold-supported; this remains separate from concrete
callback refinement.
The local runtime suite does check the concrete session-key ordering rule:
after `clearSessionKey` executes, a later `validateSignature` faults with no
active key, and the clear emits `SessionKeyRevoked`. This does not cancel a
transaction already ordered earlier and does not provide mempool invalidation.

The protocol boundary is now explicit in the implementation and proposal:
nonzero valid target, method length 1--128 UTF-8 bytes, argument count at most
64, canonical argument serialization at most 4096 bytes, signature at most
1024 bytes, non-empty batch of at most 32 operations, and nonce/deadline in
the non-negative signed-256-bit domain (`0 <= value < 2^255`). Therefore an
executable nonce has 191 channel bits, not 192. The deployed foundation's
`GetNonce` currently admits a wider, unsigned-192-bit query range; that does
not make those upper-half channels executable and is not native-profile
conformance. The new native codec rejects channels at or above `2^191`.

The AA core rejects negative and over-width values, while the VM itself limits
an Integer to a signed 32-byte representation. Earlier documentation incorrectly
promoted a mathematical unsigned-256 model to exact VM-domain correspondence.
`NativeIntegerDomain.v` now proves the representable range, 191/64-bit
decomposition and composition, fixed-width key high-bit invariant, and the
`2^64` exhaustion sentinel without wraparound. The same model now also proves
shadow-cursor channel isolation and immediate replay rejection, with positive
sequential/interleaved-channel examples and negative gap/exhaustion examples.
All 24 declarations are closed and seven semantic mutations are rejected.
This arithmetic model does not prove
the VM constructor, serializer, or C#-to-NEF compiler correct.

The local runtime correspondence suite is also bounded evidence: fourteen tests
passed for false-return consumption, replay/gap rejection, target-fault
rollback, batch rollback, reentrancy rollback, operation shape bounds and
high-channel nonce routing, malformed-field rejection, nonce-query bounds and
the maximum batch. It executes local compiled NEFs only; it does not establish
deployed-bytecode parity by itself. New node tests independently confirm that
`2^255 - 1` is representable, `2^255` is rejected by both Integer construction
and script generation, and the original identity/signing vectors are unchanged.
Five fresh private NeoExpress `StdLib.deserialize` simulations confirm the
signed representation boundary and the representable exhaustion sentinel;
their receipt is `docs/reports/aa-neoexpress-native-integer-domain-20261006.json`.
They are RPC simulations, not persisted SmartAccount operations or evidence
that native `AccountManagement` exists.

The native envelope component parses only bounded inert initializers, validates
every operation, and requires byte-for-byte canonical re-encoding with the
fixed native/account/method/flags/syscall suffix. It preserves Boolean and Struct
types and snapshots operations before returning them. The 104 focused node
tests include 96 generated VM comparisons and 512 deterministic byte mutations,
as well as truncation, substitution, depth, size, and shadow-cursor cases.
Three independently encoded fixtures match both node builder/parser and private
NeoExpress serialization. Three semantically equivalent but noncanonical
initializers execute successfully in NeoExpress and are separately rejected by
the node parser tests. The private receipt is
`docs/reports/aa-neoexpress-native-envelope-20261006.json`. These are bounded
runtime checks, not a mechanized parser/VM refinement or native service test.

The concrete runtime boundary now has additional bounded evidence: the proxy witness suite
rejects wrong-account calls and non-data instructions around the single-core-call shape, and a
real `WhitelistHook` VM execution confirms the canonical callback tuple
`[TargetContract, Method, Args, Nonce, Deadline, Signature]` reaches the hook path. An
unlisted target faults before target dispatch and the nonce remains unchanged. These vectors
exercise the checked NeoVM implementation; they are not a formal proof of all witness-condition,
script-parser, VM, or arbitrary-plugin behaviors.
The same suite rejects an oversized verifier signature and an oversized argument array before nonce
consumption or external dispatch. These bounds reduce input-amplification risk but do not replace a
non-bypassable per-verifier gas budget.

The proxy-witness transaction-script shape is now covered by a closed Coq
model rather than by runtime vectors alone. `formal/coq/ProxyWitnessScript.v`
transcribes the parser byte for byte (opcode table, PUSHDATA length decoding,
overrun checks, tail layout, CallFlags push range) and proves that any accepted
script is a walk of data-push instructions landing exactly on the expected core
call for the given account id and core hash, that no instruction start in that
walk is a SYSCALL or any other non-push opcode, and that acceptance binds the
account id and core hash uniquely; six semantic mutations (dropping the prefix
walk, the account or core binding, the flags range, the syscall tail, or
treating unknown opcodes as pushes) are each rejected. It does not prove NeoVM's
own instruction decoding, witness-rule evaluation, signer-scope semantics, or
C#-to-NEF refinement, and the byte range 0..255 is assumed from the C# type.

Three further runtime boundaries are now pinned by real NeoVM vectors rather than
by prose. First, the backup owner's `forceCancelMarketEscrow` and the
market-driven `cancelMarketEscrow` pre-flight the market through
`ContractManagement.GetContract` and only call `abandonListing` when the manifest
declares it; a market without the method (modelled by a contract that can arm an
escrow but exposes no `abandonListing`) no longer faults the escape, and a market
that throws is tolerated. A market that aborts inside its own `abandonListing`
remains outside this guarantee, because NeoVM offers no catchable form of
`ASSERT`/`ABORT`; such a market already holds unconditional settle authority over
the escrowed account. Second, `SocialRecoveryVerifier` implements the mandatory
`clearAccount` lifecycle method: `confirmVerifierUpdate` and `finalizeEscape`
away from it now succeed, the account-scoped recovery records are wiped, and any
earmarked oracle GAS is refunded to the recovery owner; the recovery verifier
artifacts recorded as deployed on public networks predate this method. Third,
`SubscriptionVerifier` requires the transfer source to be the core-derived proxy
asset address; a pull sourced from the `accountId`, which can never hold a
balance, is rejected. The core's own models are unaffected: the market escrow
and plugin lifecycle are outside the abstract execution boundary and the
pinned source hashes did not change.

The pre-MultiSig-extension local AA runtime suite passed **257/257**. The separate
session-key regression proves clear-then-validate failure and the
`SessionKeyRevoked(accountId)` notification. Two independent `nccs` 3.9.1
compilations of the core and session-key profile are byte-identical; the
source/artifact hashes and explicit public-deployed-parity status are recorded in
`docs/reports/aa-protocol-security-build-20260918.json`. A read-only check of the known
canonical TestNet/MainNet hashes found different NEF scripts; the current artifact has not
been publicly deployed.

The current gated contract run is **368 passed, 0 failed, 0 skipped** when the
sibling NeoDIDRegistry artifact is supplied, and **366 passed, 0 failed, 2
skipped** in a standalone checkout, after
adding the MultiSig configuration,
fail-closed cleanup, witness-shape, hook-callback ABI, input-shape boundary,
market-escape pre-flight, recovery-verifier cleanup, subscription transfer-source
Studio source-mirror, module-lifecycle-ABI, MultiSig child-preflight, and MultiHook child-preflight vectors.
Module binding now preflights the deployed manifest for the complete V3 lifecycle
surface, including exact parameter/return types and safe Boolean `supportsV3`
and `supportsComposition` markers; a marker-only or wrong-typed verifier or
hook is rejected before its address is stored. MultiSig and MultiHook are
explicit composites and cannot be nested as children. The core-owned dependency
registry records leaf children, clears removed children before replacement, and
clears all registered leaves before final removal; a child fault rolls back the
enclosing change. These are ABI/deployment and lifecycle-boundary guarantees,
not proofs that declared child methods are cryptographically independent or
that arbitrary future plugins have correct storage semantics. The two standalone
skips are the cross-repository DID cases when the sibling artifact is not
supplied; the required NeoExpress run with that artifact is recorded below. The
depth-one topology theorem proves that an accepted shipped composite has only
leaf children, so recursive composition and cycles are excluded for that
profile; it does not prove the behavior of arbitrary future plugins.
The formal gate itself was re-run on 2026-10-06
against the latest source pins: 17 Coq modules, including fault-aware WitnessRule
semantics and its constructive structural refinement, exact ABI projection,
bounded callback continuation semantics, exact signer-domain/payload binding,
explicit signer-independence and future-plugin-cleanup countermodels, the bounded
MultiSig, authorization, attestation/proof-envelope, WitnessRule and NeoVM
call/return-subset models, signed Integer/nonce arithmetic, the source snapshot
gate, and 98 semantic mutations rejected; its runner regression suite was
41/41. The current host receipt, which explicitly retains the unavailable
container rerun, is `docs/reports/aa-formal-gate-20261006-native-envelope.json`.
The runner resolves a working Java runtime itself (an explicit `JAVA_BIN` is
honoured verbatim; otherwise `JAVA_HOME`, the macOS locator, the Homebrew
OpenJDK kegs and `PATH` are probed with `-version`, and the macOS launcher
stub is skipped), so the earlier `UNAVAILABLE` revalidation verdict caused by
that stub no longer reproduces on a machine with a JDK installed. An earlier
targeted private NeoExpress deployment of the post-remediation core,
MultiSigVerifier, and MultiHook matched each local NEF script and manifest over
RPC; see the historical
`docs/reports/aa-neoexpress-readback-20260920-current.json`. This is local-chain
readback only. The read-only public comparison found the known
canonical TestNet/MainNet artifacts differ from the current local artifact; deployment of the
current artifact remains a separate approval-gated operation.

A full private-chain validation on 2026-10-06 (`scripts/neoexpress_validate.py`, opt-in
through `scripts/verify_repo.sh --neoexpress`) deployed all 24 `contracts/bin/v3` artifacts
plus the sibling `NeoDIDRegistry` artifact (25 deployments total) to a fresh single-node NeoExpress chain, drove
14 scenarios with 106 HALT and 2 FAULT persisted transactions (38 expected negative cases, including 36
preflight refusals), checked 84 on-chain
assertions, advanced 5,619,600 s of simulated block time, and read all 25 deployed
artifacts back over JSON-RPC with byte-identical NEF scripts, matching checksums and semantically equal
manifests. The DID artifact was separately compared byte-for-byte to its sibling build and
used in the proxy-witness scenario. The receipt is
`docs/reports/aa-neoexpress-validation-20261006.json`. The scenarios cover native
backup-owner execution with nonce lanes, replay, witness, deadline and size bounds; the
escape hatch with cooldown and timelock; the whitelist hook callback tuple; the lifecycle-ABI
pre-check for every plugin; bounded adversarial hook and verifier callbacks; relay-only session-key
submission with a real P-256 signature; bare P-256 WebAuthn and TEE payload vectors,
delegated ZkLogin provider/nullifier binding, and fail-closed disabled ZKEmail proof handling;
sponsored settlement whose private pre-submission estimate equals the persisted gas to the datoshi;
recovery-verifier rotation with cleanup and oracle-credit refund; MultiSig and MultiHook
child pre-checks, leaf-only composition and detach cleanup; a market sale, an owner escape and a
silent market; subscription pulls from
the proxy asset address; and a hand-built, P-256-signed transaction carrying the real proxy
verification script and `WitnessRules` signer, which consumed a NeoDID action ticket and
proved replay and retarget refusal. The earlier private-chain iterations found three defects
the unit suite had not: the reimbursement cap initially faulted the pre-submission estimation container, the
first fix under-estimated the system fee by the instructions its early return skipped, and a
merchant pull needs a signer scope that reaches the verifier (see `SECURITY_MODEL.md`). The
latest receipt records the corrected implementation, including independently bounded verifier
and hook callbacks,
and remains local-chain evidence; it does not establish public deployment parity.

The automatic gate was retried on 2026-10-05 with the installed NeoExpress
3.10.1.18 runner. That incompatible attempt is retained as
`docs/reports/aa-neoexpress-validation-20261005-unmatched-runner.json`, but is
not release evidence: it lacks the bounded-call syscall and faults with
`KeyNotFoundException` for the `System.Contract.CallWithGasLimit` interop hash.
The full run was then repeated with the matching private NeoExpress
3.10.1.20+59ee6e2d43 build. It passed all 14 scenarios, and the current
release-eligible receipt is
`docs/reports/aa-neoexpress-validation-20261006.json`; the equivalent callback
fault wording from that runner is normalized by the validator without widening
any other expected-fault match.

As an independent runtime check, the same 14 scenarios were re-run on 2026-10-06
with a locally built NeoExpress runner from commit
`da143f8643ebca7841cc7f56e4e3e00293819fbc`, linked to the matching private Neo,
RPC-server and DBFT packages. The runner executed all 25 deployments, persisted
108 transactions, completed 84 assertions, and read all 25 contracts back over
JSON-RPC with `releaseEvidenceEligible: true`. The runner needed temporary
compatibility adapters for the current Neo persistence `Find(..., skip)` and
NeoVM `PostExecuteInstruction(..., RunStats)` signatures; those adapters are not
presented as an upstream NeoExpress change. Provenance and the complete receipt
are recorded in `docs/reports/aa-neoexpress-runner-provenance-20261006.json` and
`docs/reports/aa-neoexpress-validation-20261006-custom-did.json`.

A further parser-audit run used the same verified runner binary on a fresh
private chain: 25 deployments, 14 scenarios, 108 persisted transactions,
84 assertions, and 25 successful artifact readbacks. The hardened provenance
checker joined that run to the unchanged 76-file rebuild certificate and
validated all 38 local NEF frames. See
`docs/reports/aa-neoexpress-validation-20261006-parser-audit.json` and
`docs/reports/aa-private-artifact-provenance-20261006-parser-audit.json`.
The checker previously accepted nonzero reserved fields, extra bytes before
the checksum, and high-bit-masked magic bytes when a raw checksum matched.
Negative-first regressions now reject those cases; five matching cases also
fail in the actual Neo `NefFile` parser. This repairs an evidence-tool gap,
not an established deployed-contract exploit. The provenance suite passes
34/34 tests and the combined script suite passes 79/79. The full Neo core
suite was also rerun with 1,453 passes. Detailed scope and source hashes are
in `docs/reports/aa-parser-audit-20261006.json`.

The current AA solution test run passed **368/368** with the sibling artifact
supplied. In a standalone checkout it passes **366/368** and explicitly skips
the two DID cases; the two modes remain intentionally distinct.

The current source-to-artifact replay independently compiled the scratch tree
with the matching private compiler and compared **76/76** NEF/manifest files
byte-for-byte with `contracts/bin/v3`; no artifact was missing or drifted. The
historical `contracts/build` tree remains an explicitly reported provenance
anchor rather than an expected match. See
`docs/reports/aa-artifact-reproducibility-20261006.json`.

That receipt now includes a source-to-artifact certificate over all **74** C# and
project inputs under `contracts/`, repository-relative source hashes, the `nccs`
version, the exact compile recipe, and fresh/release hashes for every artifact.
This is a practical provenance and rebuild-drift closure for the private artifact;
it is not a mechanized compiler-correctness theorem or a full NeoVM refinement proof.
The read-only join of that certificate to the private NeoExpress deployment and
JSON-RPC readback is recorded in
`docs/reports/aa-private-artifact-provenance-20261006.json`; the same join is now
run automatically after `verify_repo.sh --neoexpress`, which first regenerates
the dated rebuild certificate for that run. The join recomputes the current
`contracts/` source snapshot before accepting the certificate, so a stale
rebuild receipt fails closed rather than being silently attached to a new source
tree.

The artifact-structure regression gate in
`tests/AbstractAccount.Contracts.Tests/AAArtifactStructureRuntimeTests.cs`
loads all **38** NEF/manifest pairs
with Neo's strict `Script` decoder. ABI entry points must be unique by method
name and parameter count, matching Neo's dispatch key (not by parameter or
return types), and must resolve to real instruction boundaries. Negative
fixtures exercise same-arity collisions, operand offsets, truncated instructions
and checksum corruption. These are executable structural checks, not a
compiler certificate, a proof of full NeoVM execution semantics, or a
source-to-bytecode refinement theorem.

The two AA-to-DID cross-contract cases require the sibling `NeoDIDRegistry`
build artifact. They passed in the current gated run with
`NEOOS_REQUIRE_SERVICES_ARTIFACTS=1` and a matching
`NEOOS_SERVICES_CONTRACT_BUILD` directory. A standalone checkout without that
artifact correctly reports those two cases as skipped rather than passing
them; the current receipts record both modes.

The public parity state is stronger than an unverified label: read-only RPC
readback of the known canonical TestNet and MainNet hashes returned different
NEF scripts from the current local artifact. The current artifact was not
publicly deployed and no signing or broadcast was attempted. This is recorded
in `docs/reports/aa-public-readback-20260920.json`.

The prior **272/272** NeoExpress receipt remains at
`docs/reports/aa-neoexpress-readback-20260919.json` as historical evidence only.

### Native lifecycle authority model

`NativeLifecycle.v` checks the authority guards and epoch invalidation used by
native account-record transitions: Active-only configuration, exclusion of
configuration during pending custody recovery, strict custody-cancellation
maturity, joint unfreeze authorization, and clearing every pending intent on
a checked epoch increment. It models addresses, witnesses and storage as
abstract facts. It does not prove `CheckWitness`, serialization, callback
cleanup, ledger rollback, or correspondence between the C# component and the
model. Native service integration and private-chain activation remain required.

The earlier lifecycle host snapshot is recorded in
`docs/reports/aa-formal-gate-20261006-native-lifecycle.json`: 18 modules,
223 closed declarations, 105 rejected semantic mutations, 61,460 distinct TLC
states, six SMT obligations and six controls; the runner has 42 passing tests.
The pinned container image is unavailable on the accessible daemon, so this
snapshot has no current container PASS. Earlier successful container receipts
remain historical and do not cover the new module.

`docs/reports/aa-neoexpress-native-state-20261006.json` records eight private
state-initializer/serialization round trips. They used a node with no native
AccountManagement contract and persisted no application transactions; this
is state-codec compatibility evidence, not lifecycle execution evidence.

### Native callback dispatch boundaries

`NativeDispatch.v` models SmartAccount activation using the configured height
and the persisting-or-ledger index, native caller and permission guards, and
the distinction between a resumed native dispatch fee and the returning child
instruction's whitelist policy. It addresses a concrete runtime regression:
a future activation key is not equivalent to activation when no persisting
block exists. The fee model assumes an already computed nonnegative fee; the
existing bounded-budget models cover ancestor accounting. It does not prove
application-engine C# refinement, full scheduling, or complete native service
behavior.

The current native-dispatch host receipt is
`docs/reports/aa-formal-gate-20261006-native-dispatch.json`: 19 modules,
236 closed declarations, 112 rejected semantic mutations, 61,460 distinct TLC
states and 43 passing runner tests. The pinned-container rerun remains
unavailable; no older container PASS is promoted to this model snapshot.

`docs/reports/aa-neoexpress-native-activation-20261006.json` records a private
Verification-trigger regression: the historical runtime accepted a bounded
syscall despite a future activation height, while the corrected runtime rejects
it. Missing activation rejects it and explicit activation permits it. A small
ordinary diagnostic contract was deployed and its script/manifest read back;
this is not activation of native AccountManagement or a chain invocation of the
new internal native-dispatch helper.

#### Reproducing the private activation regression

`scripts/neoexpress_activation_validate.py` accepts a local NeoExpress runtime
directory containing `neoxp.dll` and its dependencies. It invokes that exact
assembly with the selected local `dotnet` executable, hashes the runtime before
and after execution, and creates disposable single-node chains. It accepts no
remote RPC endpoint or existing chain file. An optional historical runtime
reproduces the original future-height Verification-trigger bug.

```sh
python3 scripts/neoexpress_activation_validate.py \
  --runtime "$CURRENT_PRIVATE_RUNTIME" \
  --historical-runtime "$HISTORICAL_PRIVATE_RUNTIME" \
  --output activation-receipt.json
python3 -m unittest discover -s scripts -p 'test_neoexpress_activation_validate.py'
```

The validator deploys an ordinary diagnostic contract, checks its NEF script,
checksum and manifest readback, and runs actual RPC Verification and Application
simulations for omitted, future and active configuration. It also observes a
live nonzero activation boundary using ledger reads on both sides of each
Verification request. Samples spanning a block change are discarded; both
`height - 1` and `height` must be observed. A timeout is a failure, not evidence
of rejection. The default timeout accommodates fifteen-second blocks because
the running protocol's block policy may override the runner's one-second hint.

A previous PASS is invalidated before starting any chain, so interruption cannot
leave stale success evidence. Receipts distinguish persisted diagnostic deployments from simulations and
record runtime hashes without wallet material or absolute local paths. Failures
leave a non-PASS receipt and owned nodes are stopped in `finally` blocks. Neither
this validator nor its probe registers AccountManagement, validates its full
lifecycle, or establishes a compiler-refinement theorem.

### Native invocation authority boundaries

`NativeInvocation.v` proves account/phase separation, frame-sensitive root
admission, direct-child delegation, target/module separation, revocation and
the requirement to retain the original witness checks. It treats frame tokens,
deployment and caller facts as abstract inputs. Its eighteen declarations and
thirteen semantic mutations also cover activated service-hash witness rejection,
legacy behavior before activation, and proxy witness conjunction. They do not
prove how ApplicationEngine supplies the abstract facts. The separate native
integration now enforces these boundaries in the runtime; this is not a
mechanized model-to-code refinement.

The native invocation component has fifteen focused tests, including real VM
nested-call and LoadScript observations in both charging regimes. An initially
failing test established that an engine FAULT must revoke locks and grants even
when a pending native continuation cannot run its finally block; OnFault now
performs that revocation. The native worktree's
`docs/reports/smartaccount-invocation-validation-20261006.json` records full
suite, coverage, compiled-mutation and companion receipt hashes.

The profile now explicitly requires registered-proxy application witness
acceptance to be constrained to the exact authorized target invocation, in
addition to normal signer/WitnessRule checks. A Global scope or a repeated call
to the same contract hash is not a substitute for that grant. Two safe context
queries are now implemented in the native integration alongside the
CheckWitnessInternal guard. The earlier component-only private activation receipt
`docs/reports/aa-neoexpress-activation-after-context-20261006.json` only reruns
the bounded-call activation regression with the updated runtime assemblies; it
must not be interpreted as a native invocation-context lifecycle test.
