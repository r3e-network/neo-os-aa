# Verification and gates

This book is the SmartAccount process-layer verification record. English only by
policy: these chapters change with every gate run, and a stale translation would
misstate the evidence. It carries the verification and gate chapters: bounded formal models and the
reproducible build. The Chinese reading guide for this layer stays at
[SA-SPEC.zh-CN.md](../SA-SPEC.zh-CN.md).

## Contents

1. [SA Formal Verification](#sa-formal-verification) — bounded Coq models, runtime correspondence, open boundaries
2. [SA contracts: reproducible build from published packages](#sa-contracts-reproducible-build-from-published-packages) — pinned toolchain, byte-for-byte rebuild, pin bumps

## SA Formal Verification

### Status

The formal gate is a bounded-model check, not an implementation proof. The Coq
models under `formal/coq/` state abstract obligations for authorization, nonce
channels, authority epochs, lifecycle, dispatch, invocation, session scope, daily
limits, witness-rule evaluation and ABI projection. They do not prove
`ApplicationEngine` refinement, cryptography, hashing, byte encoding, compiler
correctness or GAS feasibility. A passing run reports `modelChecksPassed: true`
and `implementationVerified: false`.

No complete gate run exists for the native v4.1 source: the models that changed
for v4.1 have not been re-run. No receipt under `docs/reports/` is evidence for
the current tree; a receipt is evidence only for the commit, artifacts and
runtime it names.

**Native v4.1 status:** the native core has no bounded-call syscall, no
per-callback budget and no `VerifierGasBudget` model. The native `verify` witness
performs admissibility only; the signature or validator check runs once in
`executeUserOp`, inside the transaction's declared `SystemFee`.
`NeoVmContinuationSemantics.v` tracks return continuations only. The current
model is [SA-MODULE-PROTOCOL.md](../SA-MODULE-PROTOCOL.md) §11.1.

The native source correspondence includes a separately supplied core checkout.
`--native-core-root` (or `NEOOS_NATIVE_CORE_SOURCE`) is mandatory for a complete
gate. Its reviewed source roster and hashes are checked before and after proofs;
missing files, extra files, changed bytes or absent provenance reject.
The mirrored copy under `contracts/native/` is never a substitute for the
reviewed core checkout.
`NativeAuthorityEpoch.v` checks separate bounded counters, callback-free recovery,
revoked roots/dependencies/pending intents, unchanged identity/nonces/frozen state,
abstract generation isolation and stale-domain rejection. Both counters travel in the operation itself, the single argument of
`executeUserOp`; the model rejects an explicit counter argument and stale
counters even when the witness-evidence predicate is true. Namespace emptiness
requires no writes into future generations; byte encoding and exclusive use by
every module require independent source and runtime validation. Namespace emptiness
requires no writes into future generations; byte encoding and exclusive use by
every module require independent source and runtime validation.

Run from the formal-verification workspace:

```sh
./verify.sh
./verify.sh --report
python3 audit-coverage.py --check-ledger
```

For an SA-repository-local gate with source-hash pinning and semantic
mutation tests:

```sh
python3 formal/verify.py --native-core-root /path/to/reviewed/neo
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
hash drift, requires real Coq execution with semantic mutations, and records
tool/artifact hashes under ignored `formal/.runs/`.

The default gate (the current profile, no `--reference-models`) needs only
Coq 8.16 or later (Rocq 9 included; the models use the portable `From Coq`
import path, which Rocq 9 accepts with a deprecation warning). Z3, a JDK and
`tla2tools.jar` are needed only with `--reference-models`, which also runs the
research models with their original scopes in a separate receipt, checks final
TLC state counts and action coverage and rejects the TLC mutations. On macOS
`/usr/bin/java` is a stub that cannot run TLC; the runner skips it and probes
the usual JDK locations, or set `JAVA_BIN` explicitly. `TLA_JAR` overrides the
default `~/tools/tla/tla2tools.jar`. Without a host toolchain, run the pinned
environment instead:

```sh
formal/verify-in-docker.sh
```

It builds `formal/Dockerfile` (Ubuntu 24.04, Coq 8.18, Z3, OpenJDK, the TLA+
tools jar verified against a pinned SHA-256) and runs both the gate and the
runner's regression tests inside it. If Docker injects a localhost proxy, the
wrapper accepts `SA_FORMAL_HTTP_PROXY` and `SA_FORMAL_HTTPS_PROXY` to pass a
host-reachable build proxy explicitly. A host PASS does not establish a
successful build or run of the container recipe; the gate has no container
result for the native v4.1 models.

Coq 8.18 can also run on Windows through WSL, in the `Ubuntu-24.04`
distribution (the `-d Ubuntu-24.04` selector is required and the repository is
reached under `/mnt/d/...`):

```sh
wsl.exe -d Ubuntu-24.04 -- bash -lc 'cd /mnt/d/Git/neo-os/neo-os-aa && python3 formal/verify.py --native-core-root /mnt/d/Git/neo-os/neo-native-core --output formal/.runs/<new-run-directory>; echo exit=$?'
```

**CI status:** `.github/workflows/ci.yml` runs `scripts/verify_repo.sh`, which
does not run the formal gate unless `--formal` or `NEOOS_REQUIRE_FORMAL=1` is
supplied, and the CI image provides neither Rocq 9 nor the TLA tools. The gate
is therefore a local/release obligation, and `verify_repo.sh` prints an
explicit `formal gate: NOT RUN` line whenever it is skipped so the gap is
visible in every CI log rather than implied by a green run. The source-only
architecture gates are the exception: both workflows run the ABI IDL, native
purity and core-tree pin gates before any build (see the gate list under
"Select the validation profile").

### ABI projection acceptance obligations

A structural ABI certificate must compare full descriptors (method name,
ordered parameter types, return type, and safe flag), not just counts or
membership in one direction. The expected core surface is the declared public
C# surface plus exactly one compiler-generated `_initialize` descriptor with
zero parameters, `Void` return, and `safe = false`. Method order is irrelevant;
dispatch keys `(name, arity)` must be unique on both sides. Every expected
method must occur and every manifest method must be expected. Equal cardinality
alone cannot establish this: a duplicate method can replace a missing method.

`AbiManifestProjection.v` models this method-order-independent finite check.
Its descriptors contain ordered parameter-type lists, and explicit arities must
equal those lists' lengths. Kernel-checked negative controls reject retyping,
parameter reordering, inconsistent arities and nonempty initializer parameters.
Type identifiers are abstract; their correspondence to concrete C# and manifest
types remains an external obligation. Runtime
regressions must reject missing, extra, duplicate, retyped, and reflagged
methods while accepting reordered descriptors. Offsets are independently
checked against the strict NEF decoder. The check has quadratic list-matching
cost for the finite ABI roster; it changes neither on-chain behavior nor the
artifact format and needs no deployment or migration. Its proofs concern ABI
correspondence only, not the behavior of compiled instructions.

The registered `NeoVmContinuationSemantics.v` model tracks return continuations
only: CALL, CALLT and `LoadScript` push the same shared continuation, RET returns
to exactly that frame, `_initialize` is a per-load context, and a faulted
transaction restores storage. The model carries no per-callback budget: the transaction's declared system fee is the only bound a callback has. Instruction prices,
transaction fees and runtime scheduling are outside the model. These are bounded semantic
obligations; they do not constitute a complete NeoVM/ApplicationEngine or
compiler-refinement proof.

The SMT nonce model checks equality with the entire executable nonce domain,
and its positive control uses that same acceptance predicate at zero and
`2^255 - 1`. Executable regression mutations cover reject-all, missing boundary
values and out-of-domain admission; independent SAT examples that never call
the acceptance predicate are insufficient evidence of nonempty acceptance.
The runtime suite additionally differentially checks a fixed 1,032-case corpus of
finite witness-condition trees against the fault-aware reference relation across
read-state permissions and call depths 0 through 2. This strengthens concrete
implementation correspondence, but remains bounded test evidence rather than a
mechanized `ApplicationEngine` refinement.

### SA artifacts

#### Evidence validation requirements

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

#### Witness evaluator correspondence

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

The SA-repository-local copies under `formal/` are the artifacts `formal/verify.py`
compiles, model-checks and mutation-tests; the sibling workspace carries the same
models under `verified/` for its own `verify.sh`.

| Artifact | Scope |
|---|---|
| `formal/coq/NativeCompositePhase.v` | **Native only:** first-threshold selection, one-operation receipt ownership and discard, approved-child grants, all-active pins, and pre/post policy equality under bounds 3/2/2/3; no byte-copy, hash, crypto or gas-feasibility refinement |
| `formal/coq/ProxyWitnessScript.v` | Byte-level model of the proxy-witness transaction-script parser (`ScriptIsSingleExecuteCall`, `ScriptPrefixIsDataPushes`, `DataPushInstructionSize`): an accepted script is a data-push walk landing exactly on the expected direct `executeUserOp`/`executeUserOps` call with its two-argument pack, every instruction start in that walk is a data-push opcode (so no SYSCALL/CALL/JMP/TRY precedes the core call), acceptance binds account id and core hash, and the canonical shapes are reachable while a leading non-push opcode, a foreign account id, an out-of-range CallFlags push and a trailing instruction are rejected |
| `formal/coq/CallbackPluginTopology.v` | Closed abstract correspondence model for the six-field hook callback tuple, configured-vs-absent callback phases, success/callback ordering, CalledByEntry/Custom target binding, and fail-closed plugin cleanup/rotation; it is not a proof of NeoVM dispatch or arbitrary plugin storage. The tuple it fixes is the one `BuildHookOperationParams(UserOperation, object[])` produced, and that constructor does not exist in v4: a v4 hook is a module callback reached through `CallHookPreCheck` / `CallHookPostCheck`, which no Coq artefact models |
| `formal/coq/AuthorizationEvidence.v` | Closed protocol-level binding and replay model for cryptographic, native-witness, attestation and proof evidence; primitive validity is an explicit oracle, so this is not a proof of ECDSA, witness-rule evaluation, attestation or ZK soundness |
| `formal/coq/AttestationProofBinding.v` | Closed protocol-envelope model for attestation and zero-knowledge evidence: account, target, nonce, issuer, measurement commitment, non-zero nullifier and single-use binding; primitive cryptographic and proof validity remain explicit oracle inputs |
| `formal/coq/WitnessRuleSemantics.v` | Closed bounded model of Neo's first-match rule decision, default deny, allow/deny precedence, entry/direct-child scope, condition composition, and parser depth/child limits; it is not a refinement proof of `ApplicationEngine` or group-key cryptography |
| `formal/coq/WitnessRuleFaultSemantics.v` | Closed fuel-bounded model of `ReadStates` faults, left-to-right And/Or short-circuiting, fault propagation through `Not`, and first-match fault behavior; concrete engine tests cover the corresponding permission and scope paths |
| `formal/coq/WitnessRuleRefinement.v` | Closed refinement from parser-admissible fault-aware condition/rule evaluation to the Boolean model under readable permission; the uniform fuel certificate is derived rather than supplied, and does not refine the binary/JSON decoder or complete `ApplicationEngine` |
| `formal/coq/NeoVmCallSubset.v` | Closed bounded transition-shape model for the proxy-relevant push/PACK/contract-call/RET subset; it rejects unsafe prefixes, truncated tails and trailing instructions, but is not the complete NeoVM or `ApplicationEngine` semantics |
| `formal/coq/NativeAuthorityEpoch.v` | Native abstraction of checked independent counters, callback-free recovery, revoked roots/dependencies/pending intents, generation isolation and stale signature domains; excludes VM/byte-key refinement and assumes no future-generation writes |
| `formal/coq/NeoVmContinuationSemantics.v` | Closed bounded model of return continuations: CALL, CALLT and `LoadScript` push one shared continuation, RET returns to it, `_initialize` is a per-load context, and a faulted transaction restores storage; it tracks no callback budget, opcode price or hardfork gate, and is not a complete VM or compiler-refinement proof |
| `formal/coq/AbiManifestProjection.v` | Closed finite, order-independent ABI projection model requiring exact source/manifest coverage, unique `(name, arity)` dispatch keys, parameter/return/safe equality, and the generated initializer |
| `formal/coq/SignerDomainSeparation.v` | Closed binding model requiring exact authorization domain and payload equality; it rejects cross-domain replay but does not prove private-key independence or primitive cryptographic soundness |
| `formal/coq/SignerIndependence.v` | Closed finite countermodel showing that distinct public signer domains do not imply private-key independence; this is an explicit trust-boundary proof, not a key-generation proof |
| `formal/coq/PluginLifecycle.v` | **Native profile only:** closed finite countermodel showing that a lifecycle ABI does not imply complete cleanup of arbitrary future-plugin storage, plus a conditional theorem for a certified cleanup function; custom V3 lifecycle claims remain runtime/artifact evidence |
| `formal/tla/SmartAccountAA.tla` (sibling: `verified/tla/`) | Finite state-machine exploration of Begin/success/failure/Tick transitions |
| `formal/tla/SmartAccountAA.cfg` | TLC bounds and safety invariants |
| `formal/smt/aa_core.smt2` (sibling: `verified/smt/`) | Nonce arithmetic, cursor advancement, rollback equalities, reimbursement cap and budget arithmetic |
| sibling `reports/sa-formal-20260918/README.md` | Human-readable result and boundary report |
| `formal/verify.py` | SA-local fail-closed runner with source pins and semantic mutations |
| `formal/Dockerfile`, `formal/verify-in-docker.sh` | Pinned Ubuntu 24.04 environment (Coq 8.18, Z3, OpenJDK, TLA+ tools jar pinned by SHA-256) so an independent reviewer runs the identical gate without a host toolchain |
| `formal/test_verify.py` | Runner/parser fail-closed regression tests |
| `formal/source-lock.json` | Reviewed source snapshot hashes; not a proof attestation |

#### Witness-condition depth correspondence

The parser depth budget counts every condition node, including leaves. At
budget three, `Not(Not(Boolean))` is valid and `Not(Not(Not(Boolean)))` is
invalid. Both binary and JSON parsing reject any node at budget zero. The
model must apply that check before dispatching on the condition kind, not
only when descending through `Not`, `And` or `Or`. Runtime regression vectors
cover both parsers at and beyond this boundary, and the formal mutation gate
must reject removal of the zero-depth guard. This is bounded parser-shape
correspondence, not a proof of complete transaction decoding or cryptography.

### Security boundaries

#### Verifier resource-boundary status

Native v4.1 sets no per-callback budget. A validator or hook callback runs inside
the transaction's declared `SystemFee`, which is the only bound a callback has.
There is no bounded-call syscall, no per-callback gas accounting and no callback
gas model to verify.

The models do not prove cryptography, the concrete witness-rule parser or
`ApplicationEngine` implementation, full Neo VM semantics, or callback refinement, session
lifecycle or C#-to-NEF bytecode equivalence.
The `NeoVmCallSubset.v` and `NeoVmContinuationSemantics.v` models close only
bounded transition-shape and return-continuation obligations relevant to the proxy and
SmartAccount callback boundaries; they are deliberately not presented as the
complete VM semantics. The source-to-artifact certificate separately closes
rebuild provenance and byte drift for the built artifact, but not compiler
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
Threshold policy is user-space module state: `contracts/modules/ThresholdPolicyModule`
owns it, and the native core declares, stores and executes no threshold, member
set or approval count. `MultiSigPolicy.v` is a compile-and-mutation model of the
finite policy layer only; it has no live native source link.

#### Native lifecycle authority model

`NativeLifecycle.v` additionally projects authority admission over the four
current/pending custody and recovery slots. Every nonzero next-state authority
must be outside the registered-proxy set; addresses absent from the prior
accepted set require a witness. Pending promotion preserves prior consent,
whereas removal followed by reintroduction requires consent again. Future-proxy
rejection is conditional on that address failing actual witness verification;
witness soundness, hash separation, storage provenance and the shared native
read/save implementation remain external correspondence obligations. Stateless
`SmartAccountState` transformations alone do not enforce this runtime guard.

`NativeLifecycle.v` checks the authority guards and configuration-nonce invalidation used by
native account-record transitions: Active-only configuration, exclusion of
configuration during pending custody recovery, strict custody-cancellation
maturity, joint unfreeze authorization, and clearing every pending intent on
a checked epoch increment. It models addresses, witnesses and storage as
abstract facts. It does not prove `CheckWitness`, serialization, callback
cleanup, ledger rollback, or correspondence between the C# component and the
model. SmartAccount native-contract integration and private-chain activation remain required.

#### Native callback dispatch boundaries

`NativeDispatch.v` models SmartAccount activation using the configured height
and the persisting-or-ledger index, native caller and permission guards, and
the distinction between a resumed native dispatch fee and the returning child
instruction's whitelist policy. It addresses a concrete runtime regression:
a future activation key is not equivalent to activation when no persisting
block exists. The fee model assumes an already computed nonnegative fee; the
existing bounded-budget models cover ancestor accounting. It does not prove
application-engine C# refinement, full scheduling, or complete native contract
behavior.

`NativeInvocation.v` proves account/phase separation, frame-sensitive root
admission, direct-child delegation, target/module separation, revocation and
the requirement to retain the original witness checks. It treats frame tokens,
deployment and caller facts as abstract inputs. Its eighteen declarations and
thirteen semantic mutations also cover activated native-contract-hash witness rejection,
behavior before activation, and proxy witness conjunction. They do not
prove how ApplicationEngine supplies the abstract facts. The separate native
integration now enforces these boundaries in the runtime; this is not a
mechanized model-to-code refinement.

## SA contracts: reproducible build from published packages

Every package the SA contracts and their tests restore is published on nuget.org, and the toolchain
is pinned so that a second builder gets the same NEF and manifest bytes.

### What is pinned

| What | Pin | Where |
| --- | --- | --- |
| `Neo.SmartContract.Framework`, `Neo.SmartContract.Testing` | 3.10.1 | `Directory.Build.props` (`NeoSmartContractFrameworkVersion`) |
| the Neo packages they pull in | `Neo`, `Neo.Extensions`, `Neo.IO`, `Neo.Json`, `Neo.VM`, `Neo.Disassembler.CSharp` 3.10.1; `Neo.Cryptography.BLS12_381` 3.9.0 | `contracts/neo-platform-packages.json` (SHA-512 of each package) |
| every other package (MSTest, Akka, ...) | resolved version and content hash | committed locks for every in-scope project; the scope is the native inventory (six native modules, two test-only epoch-probe projects and two runtime probe hosts with empty NuGet dependency locks) |
| package source | nuget.org only, every package id mapped to it | `nuget.config` |
| compiler | `Neo.Compiler.CSharp` 3.9.1 (`nccs`) | `.github/workflows/ci.yml`; the installed package is checked against `contracts/neo-platform-packages.json` |
| SDK | .NET 10 (`net10.0`) | `actions/setup-dotnet` in `ci.yml` |

Restore runs in locked mode, for `dotnet` and for the restore that `nccs` runs per project: a resolution
that would change a lock file fails with `NU1004`, and a package whose bytes differ from the lock fails
with `NU1403`.

### Restore, build, test

```bash
dotnet tool install -g neo.compiler.csharp --version 3.9.1
node scripts/check_neo_platform_packages.mjs                  # pins, lock files, locked restore, package hashes
node scripts/check_neo_platform_packages.mjs --compiler-only  # the installed nccs is the pinned package
dotnet build SmartAccount.sln -c Release                      # native-only solution: pinned core, six modules, probes
dotnet test tests/SmartAccount.Native.Tests/SmartAccount.Tests.csproj -c Release
```

Always name the test project and pass `-c Release`, as above. `tests/SmartAccount.Native.Tests/bin/Debug`
and `<core>/tests/Neo.UnitTests/bin/Debug` keep the binaries of earlier Debug runs (2026-11-25 at
the time of writing); a `dotnet test --no-build` started in such a directory without a project path
resolves the default `Debug` configuration and runs those stale binaries instead of the current
sources. `verify_repo.sh` runs the same project with `-p:StandardModuleNefDir` pointing at freshly
compiled standard modules, which adds the 59 integration tests that deploy them (1802 instead of 1743).

`SmartAccount.sln` is the native build entry: it carries the native core overlay
(`contracts/native/Neo.csproj`), the six native-profile modules, the native unit tests
and the probe hosts. Building it needs a reviewed core checkout;
set `NEOOS_NATIVE_CORE_SOURCE` to it (default sibling `../neo-native-core`).

`./scripts/verify_repo.sh --contracts-only` runs the native build and unit-test lane; MSBuild
writes the kernel into each project's `bin/Release/net10.0/`. To prove a clean restore, point
`NUGET_PACKAGES` at an empty directory first.

#### Select the validation profile

`./scripts/verify_repo.sh --profile native` is the default and the only
profile. It runs the native
package locks, protocol and runner guards, the native-only solution build and unit
tests, the native module epoch VM regression and native browser coverage, and reads
nothing outside the native tree. `--contracts-only`, `--frontend-only` and
`--sdk-only` still select the component to validate. Shared deterministic
frontend/SDK unit tests run either way; they do not require a native node.

Every selected command is mandatory and its failure stops the gate. The native
epoch fixture is module-level VM evidence; the independent
`native-profile.yml` workflow additionally builds the pinned native core and
executes the native VM matrix. Neither command establishes public activation or
full-chain admission.

The main CI workflow also runs the native browser fixture in a separate required
step after installing the frontend dependencies and Playwright. It reuses those
installations and does not repeat the frontend build or full unit suites. This
workflow has no path filter, so native UI, shared code, SDK and frontend test
changes all select the browser gate without needing a native node.

`--formal` explicitly adds the aggregate formal checks and their source-lock
requirements. `--skip-e2e` drops the disposable-chain lane while keeping every
off-chain gate. `NEOOS_NEOXP` (else `NEOXP`, PATH, or the user tool directory)
selects the published NeoExpress runner; no private hardfork is enabled by this
path.

The native lane's own provenance join lives in `scripts/native_epoch_probe.py`
and the `scripts/neoexpress_native_*_validate.py` suites: together they bind the
rebuilt artifact to the current source snapshot, the module NEF hashes,
checksums, full manifests and RPC script readback. This is a measured subset,
not proof of the entire module catalog or public deployment. Native full-chain
validation follows its separate documented runner. Optional selected checks keep
their explicit NOT RUN messages when they are not selected.

#### Gate list

The contract block of `scripts/verify_repo.sh` runs these gates in this order.
Each one is required, a failure stops the run, and a gate that cannot run prints
an explicit NOT RUN line instead of passing. `<core>` is the reviewed core
checkout (`NEOOS_NATIVE_CORE_SOURCE`).

| Gate | Command | What it checks | A failure means | Where it runs |
| --- | --- | --- | --- | --- |
| ABI IDL | `python3 scripts/check_smartaccount_v41_idl.py` | `docs/proposals/smartaccount-v4.1.idl.json` matches the native source attributes and the manifest fixture: 26 methods, 15 events, no rename, alias or retired entry | the frozen v4.1 ABI the SDK and clients compile against drifted | `verify_repo.sh` before the build; the fail-fast step of `ci.yml` and `native-profile.yml` |
| Native purity | `python3 scripts/native_purity.py` | `contracts/native/SmartAccount/*.cs` carries no embedded or script-running engine, no opcode interpretation, no Envelope codec or bounded call, no self-built gas budget and no runtime script construction. The only accepted places are six pinned exceptions in `SmartAccountProtocol.cs`, each bound to its file, line range, a verbatim code anchor and a reason | SDK-style logic returned to the native contract, or the line range or anchor of an exception drifted and the exception must be reviewed again | same as the ABI IDL gate |
| Mirror sync | `python3 scripts/sync_native_smartaccount.py --check --core <core>` | the core checkout carries exactly the generated copies of `contracts/native/SmartAccount` and the runtime witness prelude | the core the solution is built against is not the reviewed source | `verify_repo.sh` before the build; the fail-fast step of `native-profile.yml`; `formal/verify.py` |
| Core-tree pin | `python3 scripts/native_core_pin.py --core <core>` | every tracked and untracked difference of the core checkout from upstream Neo commit `99618f48` is inside the reviewed allowlist and every allowlist entry still matches a difference; `src/Neo/SmartContract/ApplicationEngine.Contract.cs` and `src/Neo/SmartContract/ExecutionContextState.cs` exist and are byte-identical to upstream (only CRLF versus LF is ignored). `src/Neo/SmartContract/InteropService.cs` does not exist at that upstream commit and is not checked | unrelated core code was changed, a pristine VM file drifted, or the allowlist went stale | `verify_repo.sh` before the build; the fail-fast steps of `ci.yml` and `native-profile.yml`; it needs the full core history (`fetch-depth: 0`) |
| Profile validation | `python3 docs/proposals/validate-native-smartaccount-profile.py` | the native core and its clients admit the same current protocol | profile parameters, fingerprints or client pins disagree with the source | `verify_repo.sh`; `native-profile.yml` |
| Source budget | `python3 scripts/native_source_budget.py` | SmartAccount-specific lines stay within the budget and the core names no module policy | the native surface grew past the budget or took over module ownership | `verify_repo.sh` |
| Script unit tests | `python3 -m unittest discover -s scripts -p 'test_native_*.py'` | the gates' own regression suites, including the core-pin and purity suites | a gate stopped refusing what it was written to refuse | `verify_repo.sh` |
| Module NEPs | `python3 scripts/check_module_neps.py --compiler <nccs> --vm-getters --vm-commands` | the module proposals match the source profiles and the compiled ABIs | a module's documented ABI differs from its bytecode | `verify_repo.sh` |
| Plugin templates | `node scripts/check_plugin_templates.mjs` | both templates under `contracts/plugins/templates/` compile with the pinned compiler, their manifests satisfy the module NEP the core requires at bind time and their capability profile is self-consistent | a documented plugin starting point no longer compiles or drifted from the core's bind-time gate | `verify_repo.sh` after module compilation, next to the Module NEPs gate |
| Module VM regression | `python3 scripts/native_epoch_probe.py --compiler <nccs> --output <receipt>` | the production module bytecode runs its lifecycle in the public NeoVM with a test-only ABI fixture: module-level evidence, not native-chain admission | a module no longer behaves as its fixture expects | `verify_repo.sh` |
| Formal gate | `python3 formal/verify.py --native-core-root <core>` | the fail-closed SA model checks of the current profile (Coq); with `--reference-models` also Z3, TLC and the SMT obligations | a model, a mutation or a source pin failed, or a required tool is missing | `verify_repo.sh --formal` only: never in CI, a local and release obligation |

#### CI core checkout

**Gate A and mirror sync on CI need the fork commit to be reachable** (state of
2026-11-26). Both workflows check the core out with `repository: neo-project/neo`
at `NATIVE_CORE_COMMIT: e7fcc132…`, the head of the upstream `native-account-core`
branch. That commit predates the regenerated native SmartAccount source. On a
clean checkout of it the mirror sync gate fails with 19 problems and the core-tree
pin gate fails with 35 differences outside the allowlist, 17 stale allowlist
entries and drift of both pristine VM files.

The core tree that passes both gates is the local `neo-native-core` checkout:
branch `native-account-core` at `a8ad4a2c…`, which no remote carries
(`neo-project/neo`, `r3e-network/neo` and `Jim8y/neo` all reject the SHA) and
which still holds 49 uncommitted paths on top of that commit (35 modified, 6
deleted, 8 untracked), among them the eight generated SmartAccount copies and the
two pristine VM files restored to upstream. Until those core changes are
committed and pushed, both workflows fail at their first core gate with the
current pin, and a pin to `a8ad4a2c` fails earlier still because
`actions/checkout` cannot resolve it. Update `NATIVE_CORE_COMMIT` in both
workflows and `CORE` in `formal/refinement/native_overlay_build.py` together,
then only to the pushed commit that passes the mirror sync and core-tree pin gates
on a clean checkout.

`formal/refinement/native_overlay_build.py` keeps the same pin. It refuses the
local core tree with `base core must match the reviewed commit` (its `HEAD` is
`a8ad4a2c`), and against a clean `e7fcc132` checkout the overlay does not compile:
that core still calls `SmartAccountInvocationContext.Reset()` from `ApplicationEngine.cs`
and its `CallFromNativeContractRawAsync` still takes the `requireInheritedBudget`
argument, while the current native source defines neither. Both are gone only in the
uncommitted core working tree (the committed `a8ad4a2c` still calls `Reset`).
The clean-directory `Neo.dll` reproducibility proof therefore has no result for
the current source.

### Reproduce

#### Native build outputs

The native kernel is the only build target. `dotnet build SmartAccount.sln` compiles the overlay core
(`contracts/native/SmartAccount/`) against the pinned core checkout, and
`scripts/build_native_modules.py` reproduces the six `SMARTACCOUNT_NATIVE` modules in two independent
scratch trees under the locked restore policy and writes them to the `--output` directory its caller
names. `scripts/native_epoch_probe.py` runs those artifacts in the public VM and writes a receipt to its
own `--output`. Neither script has a default directory, and `contracts/bin/native` is not a target.

### What the bytes are, and are not

- A rebuild certificate shows that a second builder obtains the same NEF and
  manifest bytes from the pinned sources, packages and compiler. It does not
  prove compiler correctness or on-chain behavior.
- 3.10.1 is the pinned published framework. 3.9.1 and older bind
  `ContractManagement.Update` to the two-argument native overload instead of the three-argument one (a
  different method token and one byte less code), so every later method offset shifts and the build differs.
- No SmartAccount artifact has been deployed to a public network, so there is no
  on-chain byte identity to compare a build against.

### How to bump

1. Change `NeoSmartContractFrameworkVersion` in `Directory.Build.props`, or another package version in
   `tests/SmartAccount.Contracts.Tests/SmartAccount.Contracts.Tests.csproj`.
2. Update every lock file: `for p in $(find contracts tests -name '*.csproj'); do dotnet restore "$p" --force-evaluate; done`.
   Locked mode refuses this without `--force-evaluate`, and CI never passes it.
3. Run `node scripts/check_neo_platform_packages.mjs`. It lists each Neo package whose content hash differs
   from the audited one and any Neo package the manifest does not know. Put the id, version and content
   hash (the one in `packages.lock.json`) into `contracts/neo-platform-packages.json`, with the SHA-256 of the
   `.nupkg` from the global packages folder, and set `frameworkVersion`.
4. Compile with the pinned compiler and compare the digests with the pinned ones. If the bytes change,
   say so in the change and replace the receipt in `docs/reports/`.
5. To change the compiler, edit the `nccs` version in `ci.yml` and the `compiler` entry in the manifest:
   `sha256` of the installed `.nupkg`, `sha512` from the `contentHash` in its `.nupkg.metadata`.

A Dependabot NuGet pull request that changes a version without regenerating the lock files (and, for a Neo
package, the manifest) fails the gate; apply steps 2 and 3 to its branch.
