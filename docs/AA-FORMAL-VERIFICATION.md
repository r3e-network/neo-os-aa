# AA Formal Verification

## Status

The repository-local formal artifacts under `formal/` are the inputs to the
fail-closed gate below; the sibling local `neo-os-formal-verification`
workspace carries the parallel verification set.

The historical fail-closed AA-local gate passed on 2026-09-21: **5 Coq modules,
72 closed declarations, 30 semantic mutations rejected, 61,460 TLC distinct
states, and 6 SMT obligations with 6 controls**. The host run and the same
source snapshot in the cached-base Docker BuildKit stage both passed; the
runner regression suite is **20/20 OK**. This verifies the stated abstract
models and arithmetic obligations, not a claim that a deployed NEF is fully
formally verified.

The 2026-10-08 host gate passed **5 Coq modules, 77 closed declarations, 32 semantic
mutations rejected, 61,460 TLC distinct states, 6 SMT obligations and 6 controls**,
with **23/23** runner tests. Exact source/model/tool hashes and versions are recorded in
[`aa-formal-gate-20261008.json`](reports/aa-formal-gate-20261008.json). The Docker gate was
not rerun; its pin is unchanged.

The 2026-10-08 source separates public `v3` and private `PLATFORM` execution. The
source lock and every new gate result include `runtimeProfiles` and `modelProfiles`;
the runner rejects missing or changed scope metadata. `VerifierGasBudget.v` applies
only to `PLATFORM`. Public `v3` uses standard `System.Contract.Call` and has **no
per-verifier child gas budget**. Other models cover stated abstractions for both
profiles, without establishing source/VM refinement or deployment parity. Historical
private receipts below do not validate a changed public artifact or current source;
re-run the gate and bytecode/runtime tests for the exact candidate being reviewed.

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
runner's regression tests inside it. On 2026-09-21 the current source snapshot
executed successfully in a cached-base Docker BuildKit `RUN` stage: the formal
gate passed and the runner tests were **20/20 OK**. The exported result is
retained under `formal/.runs/docker-build-20260921-cached2` and is recorded in
`docs/reports/aa-formal-gate-20260921.json`. The ordinary
`docker run` wrapper still hit a Docker Desktop start/API hang in this local
environment, so that wrapper path itself is not claimed as executed evidence;
the BuildKit stage is the completed in-container execution.
Its compatibility claim (the models use only `List`, `Bool`, `PeanoNat` and
`Lia` lemmas present since Coq 8.16) has now been exercised on both Rocq 9.2
on the host and Coq 8.18 in the pinned image.

**CI status:** `.github/workflows/ci.yml` runs `scripts/verify_repo.sh`, which
does not run the formal gate unless `--formal` or `NEOOS_REQUIRE_FORMAL=1` is
supplied, and the CI image provides neither Rocq 9 nor the TLA tools. The gate
is therefore a local/release obligation, and `verify_repo.sh` prints an
explicit `formal gate: NOT RUN` line whenever it is skipped so the gap is
visible in every CI log rather than implied by a green run.

## AA artifacts

The AA-repository-local copies under `formal/` are the artifacts `formal/verify.py`
compiles, model-checks and mutation-tests; the sibling workspace carries the same
models under `verified/` for its own `verify.sh`.

| Artifact | Scope |
|---|---|
| `formal/coq/UnifiedSmartWalletAA.v` (sibling: `verified/coq/`) | Closed Coq proofs for authorization, exact channel nonce use, rollback, reentrancy, escape-owner gating and success-only state transitions |
| `formal/coq/MultiSigPolicy.v` | Closed bounded threshold-policy proofs for configuration validity, exact signature cardinality and threshold support; child identity is abstract |
| `formal/coq/ProxyWitnessScript.v` | Byte-level model of the proxy-witness transaction-script parser (`ScriptIsSingleExecuteCall`, `ScriptPrefixIsDataPushes`, `DataPushInstructionSize`): an accepted script is a data-push walk landing exactly on the expected direct `executeUserOp`/`executeUserOps` call with its two-argument pack, every instruction start in that walk is a data-push opcode (so no SYSCALL/CALL/JMP/TRY precedes the core call), acceptance binds account id and core hash, and the canonical shapes are reachable while a leading non-push opcode, a foreign account id, an out-of-range CallFlags push and a trailing instruction are rejected |
| `formal/coq/CallbackPluginTopology.v` | Closed abstract correspondence model for the six-field hook callback tuple, success/callback ordering, CalledByEntry/Custom target binding, and fail-closed plugin cleanup/rotation; it is not a proof of NeoVM dispatch or arbitrary plugin storage |
| `formal/coq/VerifierGasBudget.v` | **PLATFORM only:** closed abstract model of bounded callback charging: every charge checks the callback and all ancestor budgets before mutation, exhaustion is atomic, and nested callbacks cannot escape an ancestor cap; inapplicable to public `v3` |
| `formal/tla/UnifiedSmartWalletAA.tla` (sibling: `verified/tla/`) | Finite state-machine exploration of Begin/success/failure/Tick transitions |
| `formal/tla/UnifiedSmartWalletAA.cfg` | TLC bounds and safety invariants |
| `formal/smt/aa_core.smt2` (sibling: `verified/smt/`) | Nonce arithmetic, cursor advancement, rollback equalities, reimbursement cap and budget arithmetic |
| sibling `reports/aa-formal-20260918/README.md` | Human-readable result and boundary report |
| `formal/verify.py` | AA-local fail-closed runner with source pins and semantic mutations |
| `formal/Dockerfile`, `formal/verify-in-docker.sh` | Pinned Ubuntu 24.04 environment (Coq 8.18, Z3, OpenJDK, TLA+ tools jar pinned by SHA-256) so an independent reviewer runs the identical gate without a host toolchain |
| `formal/test_verify.py` | Runner/parser fail-closed regression tests |
| `formal/source-lock.json` | Reviewed source snapshot hashes; not a proof attestation |

## Security boundaries

### Verifier resource-boundary status

The private `PLATFORM` source branch and `contracts/bin/platform` core call verifiers
through `System.Contract.CallWithGasLimit`, with a 1,000,000,000-datoshi (10 GAS)
callback budget. Public `contracts/bin/v3` uses standard `System.Contract.Call`:
validation is read-only, post-execution accounting retains write access, and neither
callback has an isolated child budget. Input bounds, total transaction gas ceilings
and module admission do not supply the missing public runtime capability.

The historical matching Neo core/DevPack runtime activates the private syscall
at `HF_Iara`; ordinary nested calls and bounded descendants consume the
ancestor chain, and whitelist charging cannot bypass it. The isolated core
passes 9/9 targeted vectors and 1,435/1,435 full unit tests. A fresh private
NeoExpress chain activates the hardfork at block 0, drives an adversarial
burning verifier to `Contract call gas limit exceeded`, confirms nonce
rollback, and reads all 25 deployed artifacts back with byte-identical NEF
scripts and matching manifests. This closes VULN-001 for the matching private
artifact only; no public activation or deployment was performed. The current
receipts are `docs/reports/aa-platform-gas-cap-20260921.json` and
`docs/reports/aa-neoexpress-gas-cap-20260921.json`.

The models do not prove cryptography, witness-rule or script parsing
correctness, full Neo VM semantics, or C#-to-NEF callback refinement, session lifecycle,
paymaster policy resolution, or C#-to-NEF/deployed-bytecode equivalence.
The cleanup model proves fail-closed state transitions, not recovery availability:
`finalizeEscape` still depends on successful cleanup by the old verifier and hook.
The 2026-10-08 source validates the replacement verifier before these callbacks, but
does not introduce emergency detach or guarantee progress past a malicious old module.
`CallVerifierChild` and its explicit `getChildVerifierConfig` capability are recorded in
the source snapshot and tested in NeoVM, but are outside the current abstract models.
Those models do not prove the child configuration ABI, core/topology binding,
pending-call serialization or timelock enforcement for this new route. The project file
and profile build recipe are also pinned so changing source selection invalidates the
snapshot. Hash pinning is not a proof of these implementation properties.
The MultiSig model separately proves only the finite policy layer: non-empty,
at-most-ten, nonzero/distinct child identifiers, threshold bounds, exact
signature-array cardinality, and threshold support. It does not prove that
child identifiers represent independent keys, that child verifiers agree
between validation and post-execution, or that serialization and child calls
are safe under gas exhaustion. The runtime suite adds negative configuration
vectors and 2-of-2/1-of-2/native-witness vectors; these remain bounded VM
evidence rather than a complete NeoVM or cryptographic proof. The policy model
also proves that its abstract post-callback roster is unique, configured, and
threshold-supported; this remains separate from concrete callback refinement.
Its lists and callback fields are abstract values. The concrete protection against a
child mutating another child's arguments or result depends on the implementation's
deep snapshots and the NeoVM regression vectors; the model does not prove serialization
or reference-isolation behavior.
The local runtime suite does check the concrete session-key ordering rule:
after `clearSessionKey` executes, a later `validateSignature` faults with no
active key, and the clear emits `SessionKeyRevoked`. This does not cancel a
transaction already ordered earlier and does not provide mempool invalidation.

The protocol boundary is now explicit in the implementation and proposal:
nonzero valid target, method length 1--128 UTF-8 bytes, argument count at most
64, canonical argument serialization at most 4096 bytes, signature at most
1024 bytes, non-empty batch of at most 32 operations, and nonce/deadline in
the unsigned uint256 domain. `GetNonce` also rejects channels outside uint192.
These are input-domain and resource-shape checks, not a gas or semantic type
policy for every nested argument.

The AA core now rejects negative and over-width nonce values before splitting
the Neo `BigInteger`; deadlines are subject to the same unsigned 256-bit width
bound. The arithmetic proof models that domain exactly. The concrete Neo VM
transport/refinement and the byte-for-byte C#-to-NEF correspondence remain
separate security obligations.

The local runtime correspondence suite is also bounded evidence: twelve tests
passed for false-return consumption, replay/gap rejection, target-fault
rollback, batch rollback, reentrancy rollback, operation shape bounds and
high-channel nonce routing, malformed-field rejection, nonce-query bounds and
the maximum batch. It executes local compiled NEFs only; it does not establish
deployed-bytecode parity by itself. The exact `2^256 - 1` upper bound is
covered by the arithmetic model; Neo VM runtime vectors use its highest
directly representable positive integer.

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
models the parser's opcode table, PUSHDATA length decoding,
overrun checks, tail layout and CallFlags push range, and proves that any accepted
script is a walk of data-push instructions landing exactly on the expected core
call for the given account id and core hash, that no instruction start in that
walk is a SYSCALL or any other non-push opcode, and that acceptance binds the
account id and core hash uniquely. The model allows only the two direct entrypoints:
`executeUserOp`/`executeUserOps` require `PUSH2 PACK`. Both sponsored method names
are explicitly rejected, including a correctly packed five-argument envelope and a
two-argument disguise. These negative examples are compiled and assumption-audited;
they preserve the boundary that sponsored settlement callbacks have not been authorized
to reuse the proxy witness.
Eight semantic mutations (dropping the prefix
walk, the account or core binding, the flags range, the method/arity binding, widening
the entrypoint allowlist, removing the syscall tail, or
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

The historical 2026-09-21 gated contract run was **292 passed, 0 failed, 0 skipped** after
adding the MultiSig configuration,
fail-closed cleanup, witness-shape, hook-callback ABI, input-shape boundary,
market-escape pre-flight, recovery-verifier cleanup, subscription transfer-source
Studio source-mirror, module-lifecycle-ABI, MultiSig child-preflight, and MultiHook child-preflight vectors.
Module binding now preflights the deployed manifest for the complete V3 lifecycle
surface, including exact parameter/return types and a safe Boolean `supportsV3`
marker; a marker-only or wrong-typed verifier or hook is rejected before its
address is stored.
MultiSig also rejects self-reference and undeployed/incomplete child verifiers
before configuration storage; MultiHook rejects incomplete child hooks before storage. These are ABI/deployment guards, not proofs that
declared child methods are semantically safe, cryptographically independent, or
free of multi-contract cycles. The
formal gate itself was re-run on
2026-09-21 against the latest source pins: 5 Coq modules (72 closed
declarations, 26 rejected Coq semantic mutations), TLC over 61,460 distinct states
with 4 rejected mutations, and 6 SMT obligations with 6 satisfiable controls.
The runner resolves a working Java runtime itself (an explicit `JAVA_BIN` is
honoured verbatim; otherwise `JAVA_HOME`, the macOS locator, the Homebrew
OpenJDK kegs and `PATH` are probed with `-version`, and the macOS launcher
stub is skipped), so the earlier `UNAVAILABLE` revalidation verdict caused by
that stub no longer reproduces on a machine with a JDK installed. A fresh private
NeoExpress deployment of the current post-remediation core, MultiSigVerifier,
and MultiHook matched each local NEF script and manifest over RPC; see
`docs/reports/aa-neoexpress-readback-20260920-current.json`. This is local-chain
readback only. The read-only public comparison found the known
canonical TestNet/MainNet artifacts differ from the current local artifact; deployment of the
current artifact remains a separate approval-gated operation.

A full private-chain validation on 2026-09-21 (`scripts/neoexpress_validate.py`, opt-in
through `scripts/verify_repo.sh --neoexpress`) deployed all 24 `contracts/bin/v3` artifacts
plus the sibling `NeoDIDRegistry` artifact to a fresh single-node NeoExpress chain, drove
12 scenarios with 73 halted transactions and 26 expected faults, checked 61 on-chain
assertions, advanced 4,669,200 s of simulated block time, and read every deployed contract
back over JSON-RPC with a byte-identical NEF script, matching checksum and semantically equal
manifest: `docs/reports/aa-neoexpress-gas-cap-20260921.json`. The scenarios cover native
backup-owner execution with nonce lanes, replay, witness, deadline and size bounds; the
escape hatch with cooldown and timelock; the whitelist hook callback tuple; the lifecycle-ABI
pre-check for every plugin; relay-only session-key submission with a real P-256 signature;
sponsored settlement whose private pre-submission estimate equals the persisted gas to the datoshi;
recovery-verifier rotation with cleanup and oracle-credit refund; MultiSig and MultiHook
child pre-checks; the bounded adversarial verifier callback; a market sale, an owner escape and a silent market; subscription pulls from
the proxy asset address; and a hand-built, P-256-signed transaction carrying the real proxy
verification script and `WitnessRules` signer, which consumed a NeoDID action ticket and
proved replay and retarget refusal. The earlier private-chain iterations found three defects
the unit suite had not: the reimbursement cap initially faulted the pre-submission estimation container, the
first fix under-estimated the system fee by the instructions its early return skipped, and a
merchant pull needs a signer scope that reaches the verifier (see `SECURITY_MODEL.md`). The
latest receipt records the corrected implementation, including the bounded verifier callback,
and remains local-chain evidence; it does not establish public deployment parity.

The historical 2026-09-21 standalone checkout without the sibling `NeoDIDRegistry` artifact passed
**290/292** and records exactly the two cross-repository DID cases as explicit
skips; it does not count those cases as passes. The earlier 289/291 result is
historical, from before the zero-fee estimation regression test was added.

The historical 2026-09-21 source-to-artifact replay independently compiled the scratch tree
with the matching private compiler and compared **76/76** NEF/manifest files
byte-for-byte with `contracts/bin/v3`; no artifact was missing or drifted. The
historical `contracts/build` tree remains an explicitly reported provenance
anchor rather than an expected match. See
`docs/reports/aa-artifact-reproducibility-20260921.json`.

The two AA-to-DID cross-contract cases require the sibling `NeoDIDRegistry`
build artifact. They passed in the gated run with
`NEOOS_REQUIRE_SERVICES_ARTIFACTS=1` and a matching
`NEOOS_SERVICES_CONTRACT_BUILD` directory. A standalone checkout without that
artifact correctly reports those two cases as skipped rather than passing
them; the receipt records both modes.

The public parity state is stronger than an unverified label: read-only RPC
readback of the known canonical TestNet and MainNet hashes returned different
NEF scripts from the current local artifact. The current artifact was not
publicly deployed and no signing or broadcast was attempted. This is recorded
in `docs/reports/aa-public-readback-20260920.json`.

The prior **272/272** NeoExpress receipt remains at
`docs/reports/aa-neoexpress-readback-20260919.json` as historical evidence only.
