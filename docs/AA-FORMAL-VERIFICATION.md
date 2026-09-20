# AA Formal Verification

## Status

The current AA formal artifacts live in the sibling local
`neo-os-formal-verification` workspace.

The fail-closed run on 2026-09-18 completed with **79 passed, 0 failed**.
This result is a verification of the stated abstract models and arithmetic
obligations; it is not a claim that the deployed NEF is fully formally
verified.

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

The local gate invalidates any previous result before checking, refuses source
hash drift, requires real Coq/Z3/TLC execution, checks final TLC state counts
and action coverage, rejects syntax-only mutations, and records tool/artifact
hashes under ignored `formal/.runs/`.

The gate needs Rocq/Coq 9 (the models use the `Stdlib` namespace), Z3, a real
JDK and `tla2tools.jar`. On macOS `/usr/bin/java` is a stub that cannot run
TLC; point `JAVA_BIN` at a real runtime (for example
`JAVA_BIN=/opt/homebrew/opt/openjdk/bin/java`). `TLA_JAR` overrides the default
`~/tools/tla/tla2tools.jar`.

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
| `formal/tla/UnifiedSmartWalletAA.tla` (sibling: `verified/tla/`) | Finite state-machine exploration of Begin/success/failure/Tick transitions |
| `formal/tla/UnifiedSmartWalletAA.cfg` | TLC bounds and safety invariants |
| `formal/smt/aa_core.smt2` (sibling: `verified/smt/`) | Nonce arithmetic, cursor advancement, rollback equalities, reimbursement cap and budget arithmetic |
| sibling `reports/aa-formal-20260918/README.md` | Human-readable result and boundary report |
| `formal/verify.py` | AA-local fail-closed runner with source pins and semantic mutations |
| `formal/test_verify.py` | Runner/parser fail-closed regression tests |
| `formal/source-lock.json` | Reviewed source snapshot hashes; not a proof attestation |

## Security boundaries

### Verifier resource-boundary status

The current AA artifact still calls verifiers through the published
`System.Contract.Call` surface, so VULN-001 is open for that artifact. A
platform-level remedy is specified in
`docs/proposals/AA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.md`: the proposed
`System.Contract.CallWithGasLimit` enforces a child budget in NeoVM and passes
ordinary and nested descendant charges through the ancestor budget chain. The
isolated Neo core prototype has 7/7 targeted vectors and the full core unit
suite has 1,433/1,433 passes, but the AA contract has not yet been compiled
against that future DevPack surface or deployed to a node with the hardfork
active. These platform results therefore do not close the current AA finding.

The models do not prove cryptography, witness-rule or script parsing
correctness, full Neo VM semantics, or full callback refinement, session lifecycle,
paymaster policy resolution, or C#-to-NEF/deployed-bytecode equivalence.
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

The current gated contract run is **291 passed, 0 failed, 0 skipped** after
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
2026-09-20 against the latest source pins: 2 Coq modules (34 closed
declarations, 11 rejected semantic mutations), TLC over 61,460 distinct states
with 4 rejected mutations, and 6 SMT obligations with 6 satisfiable controls. A fresh private
NeoExpress deployment of the current post-remediation core, MultiSigVerifier,
and MultiHook matched each local NEF script and manifest over RPC; see
`docs/reports/aa-neoexpress-readback-20260920-current.json`. This is local-chain
readback only. The read-only public comparison found the known
canonical TestNet/MainNet artifacts differ from the current local artifact; deployment of the
current artifact remains a separate approval-gated operation.

The standalone checkout without the sibling `NeoDIDRegistry` artifact passes
**289/291** and records exactly the two cross-repository DID cases as explicit
skips; it does not count those cases as passes.

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
