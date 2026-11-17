# AA Formal Verification

## Status

### Fixture refresh (2026-11-16)

The 2026-11-16 design-phase legacy-compatibility sweep changed the ordinary
core source (legacy storage-prefix fallbacks, the rotation-migration surface
and the dependency backfill were removed; the recovery verifier's v3 action
ticket was dropped and `submitActionTicketV4` renamed to `submitActionTicket`).
The refinement fixtures under `formal/refinement/fixtures/` were re-distilled
against the post-sweep candidate: the RefinementExport inventory was rerun,
`cap-method-source.json`, `initializer-source.json` and
`current-initializer-source.json` were re-distilled, the current-method-proof
receipt was regenerated against the fresh kernel, the method/context lane
constants were re-pinned, and the five-shape helper-gas runtime capture was
regenerated against the new artifact (NEF `9f714866…`, manifest `a6533d47…`).
The retired pre-sweep getter shapes are gone: `storage_getter_source.py` no
longer carries the `legacy_symbol` / `inline-fallback` forms, the lane's
source-level semantic controls are now the prefix/default binding mutants, and
the legacy read-order controls were removed from the lane, the closure gate
and the regression suite.

### Current private validation refresh (2026-10-31)

The current SmartAccount/native-core source snapshot passes the pinned Docker
formal gate. The receipt at
`docs/reports/aa-formal-gate-20261031.json` records 29 Coq modules,
554 closed declarations, 311 rejected Coq mutations, four rejected TLC
mutations, 315 semantic mutations in total, 61,460 TLC distinct states, and
7/7 SMT obligations. The formal runner regression suite independently passes
72/72 tests on the current worktree. The .NET contract suite independently
passes 571/571 tests, with no failures or skips.

The gate reports `modelChecksPassed: true` and
`implementationVerified: false`. Its scope is the reviewed abstract protocol
and native-state models; it does not claim a complete C# to NEF to NeoVM
refinement, full NeoVM/ApplicationEngine semantics, cryptographic soundness,
complete WitnessRule decoding/evaluation, or arbitrary-plugin liveness.
The committed receipt is byte-identical to the Docker run output at
`formal/.runs/docker/result.json`.

The current source-built NeoExpress authority validation is recorded under
`docs/reports/smartaccount-native-source-runtime-20261031-final/`. Its
aggregate receipt and all five matrix receipts report `PASS`: native service
lifecycle, signed proxy and atomic rollback, configuration-root mutation,
authority recovery, and activation-boundary validation. The runtime file map
matched before and after the matrices, all owned nodes stopped, and
`publicNetworksTouched` is `false`. The aggregate deliberately reports
`fullProtocolConformanceVerified: false`; these are bounded private-chain
checks, not a claim that every possible plugin, proof system, or production
deployment is covered.

The same final source-built runtime has been exercised against the extended
native matrix recorded in
`docs/reports/smartaccount-native-extended-matrix-20261031-final/index.json`.
The receipt reports `PASS` for MultiSig composition, DailyLimit accounting,
SessionKey execution, session scope admission, and TokenRestrictedHook policy;
the six packaged native profiles also pass the current profile packaging check
after two reproducible builds with pinned `nccs` 3.9.1. These receipts are bound
to the current source-built runner and module-build receipt, report
`publicNetworksTouched: false`, and retain the same bounded scope: shipped
scenarios and persisted private-chain readback only. They do not prove
cryptographic soundness, MultiSig private-key independence, arbitrary-plugin
liveness, full NeoVM/compiler refinement, or public deployment parity.

The current native authority-admission profile remains ABI 2. The final
source-built runner receipt is
`docs/reports/smartaccount-native-runner-build-20261031.json`. It binds core
`0b81b25601ba7e2ec0b0d9b9cb0ab79ed809af03`, two byte-identical clean builds,
104 runtime files, and 50 dependency packages. The earlier 2026-10-30 module
and runner receipts remain historical evidence for their recorded source set
and must not be used as current provenance.

Separately, the ordinary AA protocol suite was rerun end to end with the same
source-built NeoExpress runtime. The current receipt at
`docs/reports/aa-neoexpress-validation-20261031.json` reports `PASS` and is
release-evidence eligible for the private chain: 25 deployed artifacts
(24 local artifacts plus the sibling `NeoDIDRegistry`), 15 scenarios, 135
persisted transactions (132 HALT and 3 FAULT), 48 expected negative cases
(45 refused before persistence), 132 on-chain assertions, and 25 byte-identical
RPC NEF readbacks with matching checksums and semantically equal manifests.
The source-to-artifact-to-chain join at
`docs/reports/aa-private-artifact-provenance-20261031.json` compares all 80
current release artifacts with a fresh build and joins the 24 local artifacts
to their deployed bytes. The run reports `publicNetworksTouched: false` and
does not establish public deployment or public artifact parity.

The platform-account owner-rotation scenario uses the final source-built
runtime to verify delayed registrar activation, rejection of cancellation by a
stranger, current-owner cancellation, rejection of early confirmation,
rejection of confirmation without the proposed new owner's witness, proposal
and cancellation events, persistence of the rotated owner, clearing of the
pending record, and preservation of the proxy address. This is private-chain
evidence for the shipped source; public ABI migration and public deployment
readback remain pending.

That receipt now includes a real ephemeral secp256k1 path for
`Web3AuthVerifier`: account registration with a 65-byte uncompressed public
key, a successful EIP-712-style UserOperation, retarget and foreign-key
rejection with unchanged nonce, and direct 32-byte ERC-1271 digest validation
in both 65-byte recoverable and 64-byte EIP-2098 compact forms, with a
different-digest negative case. This exercises the shipped
NeoVM/CryptoLib path, not a hosted Web3Auth OAuth ceremony. The Web3Auth
ERC-1271 direct-digest path requires `HF_Huyao` or later. The pre-Huyao compatibility
implementation does not enforce canonical `r`/`s` bounds and is outside the
reviewed deployment profile.

The NeoExpress receipt is also source-runtime-bound: it records the PASS
source-build receipt hash, the three source commits, the 104-file runtime map
matched before and after execution, the `neoxp.dll` hash and the wrapper hash,
while explicitly setting `pathsIncluded: false`. This binds the chain run to
the reviewed runner build without publishing host paths.

A host-side discovery run of
`python3 -m unittest discover -s formal/refinement -p 'test_*.py'` completed
790 tests with 50 environment-gated skips and no failures on 2026-10-31. The
skips are not counted as proof, and this discovery run does not replace the
fail-closed closure gate or move `implementationVerified`.

The remaining boundary is explicit: ordinary public v3 still calls verifiers
through `System.Contract.Call` without an independent child gas cap. Public
deployment and public artifact parity are outside this private-only run. The
formal and runtime evidence also retain the cryptography, complete WitnessRule
and NeoVM, compiler/refinement, key independence, and arbitrary-plugin cleanup
boundaries described below. No public network was used by this refresh.

### Layered implementation refinement (2026-10-13)

The [implementation gate](AA-IMPLEMENTATION-REFINEMENT.md) now requests four
proof lanes by default: the original arithmetic region,
[numeric coercions](AA-NUMERIC-REFINEMENT.md),
[reservation arithmetic](AA-RESERVATION-REFINEMENT.md), and
[complete reimbursement-helper reference refinement](AA-CAP-METHOD-REFINEMENT.md).
The last lane uses a [typed source projection](AA-METHOD-SOURCE-REFINEMENT.md)
and the [complete instruction inventory](AA-METHOD-REFINEMENT-INVENTORY.md).
[Pinned-engine runtime checks](AA-METHOD-RUNTIME-REFINEMENT.md) provide separate,
finite evidence, including storage and fault behavior. None of these lanes alone
verifies the whole contract or public protocol activation.

Run the default gate from the repository root with a new or empty output
directory:

```sh
python3 formal/refinement/verify.py --timeout-seconds 1800 --output-dir /tmp/aa-refinement-evidence
```

The [fresh integrated report](reports/aa-method-refinement-20261013.md) and its
per-lane receipts record the complete helper's ten universal results and two
concrete examples, with 103 assumption-audited declarations including imported
definitions and proofs. The historical arithmetic and protocol-model receipts
below retain their original scopes and must not be summed to infer a larger
implementation theorem. `--arithmetic-only` explicitly
selects the historical local lane. `--allow-partial` only accepts a checked
partial scope and leaves `implementationVerified: false`; neither option bypasses
tool or proof failures.

The complete helper's source theorem uses a declared Neo framework contract
dialect: transaction hashes are immutable byte values compared by content,
while mutable reservation records preserve heap aliases. This is not a theorem
about arbitrary CLR reference identity. Compiler/framework correspondence,
well-formed reachable storage, caller guards, actual native serialization,
ApplicationEngine effects and resource faults remain separate obligations.
See the [dialect and identity boundary](AA-IMPLEMENTATION-REFINEMENT.md#neo-contract-dialect-and-object-identity)
before interpreting a reference theorem as implementation acceptance.

**Full implementation refinement remains NO-GO.** No complete public entrypoint
has been certified by these helper lanes. A successful partial default run still
returns exit `2`, unless explicitly requested with `--allow-partial`, and retains
the false implementation status.

### Historical arithmetic-region certificate (2026-10-13)

The separate [implementation refinement gate](AA-IMPLEMENTATION-REFINEMENT.md)
now binds typed Roslyn operations, a byte-identical NCCS rebuild, the complete
100-entry manifest and independently decoded candidate NEF to an actual Coq
certificate. The proved region is the reimbursement arithmetic at PC
`[13667,13689)`: 22 original instructions, with signed-256 bounds, typed entry
conditions, result equality, argument/local-frame preservation and equality to
the existing `OrdinarySponsorship.charge` definition.

Host Rocq 9.2 and pinned-container Coq 8.18 independently accept the same generated
certificate and recheck it with `coqchk`. Each checks **38 closed declarations**:
23 new/local declarations and 15 imported protocol declarations. Do not add 38
to the historical 490 count, which already includes those 15. This is a
gas-erased Integer-typed reference-semantics theorem; actual NeoVM execution is
separately checked by seven runtime tests, not proved equivalent for all states.

**Full implementation refinement remains NO-GO.** No complete public entrypoint
is proved. Source/debug extraction, entry-state establishment and numeric tag
coercions, storage/serialization, exceptions and transaction rollback, external
calls/reentrancy, gas/resource faults and the ApplicationEngine correspondence
remain open for this historical certificate. Its arithmetic-only gate returns
exit `2` and `implementationVerified: false`; `--allow-partial` preserves that
false status while accepting only the explicitly scoped arithmetic region. The
[dated refinement report](reports/aa-implementation-refinement-20261013.md)
contains the exact artifacts, commands, controls and remaining method obligations.

### Historical source-candidate host closure (2026-10-13)

The frozen ordinary source-candidate snapshot passed the host model gate:
**29 Coq modules, 490 closed declarations, 287 rejected semantic mutations**
(283 Coq and four TLA), **61,460 TLC distinct states**, and **seven SMT obligations
with seven controls**. The gate checks 59 AA source inputs and 310 native-core
source inputs before and after verification. The runner regression suite passes
68 tests. The tracked receipt is
[`aa-formal-ordinary-closure-20261013.json`](reports/aa-formal-ordinary-closure-20261013.json)
(SHA-256 `7ad982a403b7c2b953c946f49ce42fe544be1b87fa3fbdd668078623070bc5b9`);
it is byte-identical to
`formal/.runs/ordinary-closure-final-r3-20261013/result.json`.
The host used Rocq 9.2, Z3 5.1.0, OpenJDK 26.0.2.1, and the reviewed TLA jar
with SHA-256 `7beec0f04818732a62fa193731711a99aa4f11279499b2360a7d156c519ea78d`.

This closes **GO for the declared ordinary protocol abstractions and reviewed
source-snapshot checks**: governance authorization and delay, cumulative
transaction sponsorship reservations, and permanent owner-only recovery are
included. `implementationVerified` remains **false**. Source-fragment checks
and model proofs do not establish C# to NEF to NeoVM refinement, all-entrypoint
storage semantics, cryptography, complete fee accounting, arbitrary plugin
liveness, or public activation.

The independent pinned-container gate also passes this same source/model
snapshot with Coq 8.18.0, Z3 4.8.12 and OpenJDK 21.0.12.1, including all 68 runner
regression tests. The container receipt is
[`aa-formal-ordinary-closure-docker-20261013.json`](reports/aa-formal-ordinary-closure-docker-20261013.json)
(SHA-256 `283e7517b9c113fb829f4735206da2c882e84be8065ffbeae09ed8259bc9289e`).
Its source, native-core, model artifact, profile and proof-result maps equal the
host receipt. It ran immutable image
`sha256:49175ab91d07c3446004b93c667b581d34c1702b61cc1d937c8218f439b00941`
with the same exact TLA jar pin. The image build used the reviewed cached
`/tmp/tla2tools.jar` through the existing `TLA_JAR_URL` argument and a temporary
localhost server, which was stopped after the build. The default GitHub release
URL at that time served different bytes and failed the unchanged SHA-256 guard;
this run does not claim a successful rebuild from that mutable URL. Neither the
Dockerfile nor wrapper was modified to bypass the pin. The 2026-10-30 refresh
reviews the official `fc6878c6...` asset digest, updates the declared pin, and
rebuilds the image; this does not retroactively alter the historical receipt.
The build-input and
native-contract cleanup evidence is
[`aa-formal-container-build-20261013.json`](reports/aa-formal-container-build-20261013.json)
(SHA-256 `d17b6b6d61568bdad038adf19baa3615d7fce00f1fad9fa9de82cda1e9891a8c`).
The first container attempt exposed a scratch
path collision between identically named mutations in different models; the
runner now namespaces evidence by module, and the complete rerun passes.
Both environments report `modelChecksPassed: true` and
`implementationVerified: false`.

Each receipt is bound to its recorded source, model, profile and tool versions.
The host and container receipts above have identical fields except for
`toolVersions`; their different Java, Coq/Rocq and Z3 versions identify separate
verification runs, not interchangeable receipt bytes. Matching declaration,
mutation or state counts alone do not establish snapshot equality. Use the
recorded input hashes and proof results when comparing runs, and retain each
receipt's original tool versions.

### Previous host snapshot (2026-10-13)

The previous ordinary-governance source and model snapshot passed the host formal gate:
**27 Coq modules, 460 closed declarations, 258 rejected semantic mutations,
61,460 TLC distinct states, six SMT obligations and six controls**, with the
native core roster checked at 310 exact source files. The tracked ordinary-governance
receipt is [`aa-formal-ordinary-go-20261013.json`](reports/aa-formal-ordinary-go-20261013.json)
(SHA-256 `a5becc179de6d55bf688dcede42b402ad4018a69ea061d16179e7ac89cdfae21`).
The verification run also wrote `formal/.runs/ordinary-go-20261013/result.json`;
the tracked copy retains the source/model identities validated at that checkpoint.
It does not certify subsequent sponsorship or owner-only recovery changes.
It ran with OpenJDK 26.0.2.1.
The earlier receipt `formal/.runs/final-20261013-platform/result.json` (SHA-256
`f1b0f876b9219bf4cab19f3da6beeaaed8ef50756564eb9e52b75389b7dcf887`) covers
the preceding model/source snapshot and ran with OpenJDK 17.0.20.1; retain it
only as evidence for that historical snapshot and toolchain. It does not
certify the later source/model snapshots or their Java runtimes. The
formal model gate is **GO** for its declared abstractions. It deliberately
retains `implementationVerified: false`: these models do not prove C# to NEF to
NeoVM refinement, complete VM fee accounting, arbitrary plugin liveness, or
public deployment equivalence. At this earlier checkpoint the Docker gate had
not run because the local Colima daemon was unavailable. The later independent
container run is recorded under Current source-candidate host closure above;
it certifies that later pinned snapshot without retroactively changing this
historical receipt.

The ordinary public profile also retains two protocol-level NO-GO boundaries:
public `v3` callbacks use standard `System.Contract.Call` without an isolated
child budget, and the pinned public ABI still exposes immediate platform-account
backup-owner rotation. The source candidate now contains a two-stage
proposal/confirmation/cancellation path with a new-owner witness, but closing
the public boundary requires an ABI migration from the pinned 90-entry artifact
to the reviewed source-candidate ABI, an upgraded artifact, and public
readback; this repository does not relabel it as closed based on static tests.

The ordinary source candidate now has an explicit Coq governance model
(`OrdinaryGovernance.v`) covering registrar and owner authorization, duplicate
pending proposals, seven-day confirmation delay, new-owner witness, escape and
escrow exclusion, cancellation, boundary cleanup, and failed-transition
atomicity. This is a bounded state-machine correspondence model; it does not
prove storage serialization, C# to NEF/NeoVM refinement, or public deployment.

The current governance model uses millisecond `Z` values and the exact
604,800,000 ms delay. The runner recomputes the pinned C# delay expression and
compares that value, and pins the escape and market settlement cleanup sources.
Owner cancellation requires the current owner's witness independently of the
calling script. Natural-number owner IDs abstract nonzero identities; valid
UInt160 values and matching account bindings are preconditions of the projection.
Governance failure proofs preserve the governance record, which does not model
nonce storage. They do not prove current-owner consent to a registrar proposal.

`OrdinarySponsorship.v` models one ledger per core and transaction shared across
accounts, sponsors, paymasters, single calls, batches and nested execution.
Reservations precede external callbacks; repeated successful reservations sum
to at most the positive enclosing transaction fee. A theorem relates the
abstract charge to the branch-free source expression. Zero-fee RPC estimation
retains requested quotes and has no persisted-fee-bound claim. Transaction hash
identity, fees, stored ledger integrity, enclosing-transaction rollback and actual
token settlement remain implementation correspondence obligations.

`OrdinaryRecovery.v` models the source candidate's callback-free recovery to an
irreversible owner-only latch. It proves independence from old plugin outcomes,
maturity/witness/lock/escrow guards, root/context/intent detachment, retained
identity and nonce projections, rejection of repeated recovery, and rejection
of nonzero root installation after recovery. It has no transition that reopens
plugin authority and does not claim native authority-epoch semantics. Concrete
storage cleanup, all-entrypoint enforcement and witness validity require the
matching source review and VM tests. Irreversibility is scoped to this version's
modeled transitions; administrative code upgrades and future protocol versions
are outside that claim.

### ABI 2 convergence boundary

The active native target is SmartAccount ABI 2, with identity derivation
version 1, authorization/account-record version 2, and separate authority epoch
and configuration nonce. Native recovery revokes old module generations without
external cleanup. The six native modules use epoch-scoped state. Ordinary public
`v3` and private `PLATFORM` sources are retained as separate profiles; native
claims must bind the external Neo core sources, not the old deployed-core prototype.

The unreleased ABI 2 profile now requires the exact profile fingerprint and a
strict verifier-composition marker on every module. Its native composite model
uses a transient three-field receipt, first-threshold selection, at most three
children/two approvals/two threshold/three signer domains, fresh per-operation
ownership, all-active binding checks and pre/post policy equality. The public
`MultiSigPolicy.v` ten-child/repeated-validation model applies only to `v3` and
`PLATFORM`; `NativeCompositePhase.v` covers the separate native receipt design.
Session's epoch-scoped prefix `0x05` stores deterministic signer-domain
configuration, and prefix `0x06` holds the independently updated last-use time;
neither stores a persistent approval. Neither model proves byte copying,
hashing, cryptography, implementation refinement or gas feasibility.

The frozen composite profile passed its complete host gate on 2026-10-09:
**26 Coq modules, 443 closed declarations, 247 rejected semantic mutations**
(243 Coq and four TLA), **61,460 TLC distinct states**, and six SMT obligations
with six controls. The gate checked 55 AA inputs and 310 external core inputs
before and after the proofs. `NativeCompositePhase.v` contributes 45 closed
declarations and 31 definition-valid, proof-rejected mutations. The exact result
is [`aa-native-composite-final-formal-20261009.json`](reports/aa-native-composite-final-formal-20261009.json).
Its profile fingerprint is
`4201b02f571b7415121467d67343a8189b8070ad795a82424c0403782d22b1b4`.
The runner regression suite passes 60 tests; profile/vector tests pass 16.

Two complete source runtime builds produced identical 104-file outputs, 50
dependency archives and project-lock maps from core `ff422d940a4722c361c32398c6f28c00fb7f0693`,
node `fa35e69af130661e2ac60bffd43eb6c6c78aa7d5` and Express
`da143f8643ebca7841cc7f56e4e3e00293819fbc`. Six native modules reproduce as 13
packaged files; 80 public/PLATFORM artifacts match fresh builds, and the public
contract suite passes 396/396 with zero skips and required NeoDID artifacts.
These build/proof results are consolidated in
[`aa-native-composite-final-build-proof-20261009.json`](reports/aa-native-composite-final-build-proof-20261009.json).
Final native private-chain and SDK integration receipts remain separate gates;
older runtime receipts do not certify this profile.

The preceding ABI 2 snapshot's host gate passed on 2026-10-08: **26 Coq modules, 409 closed declarations,
222 rejected semantic mutations** (218 Coq and four TLA), 61,460 TLC distinct states,
and six SMT obligations with six controls. All mutations first passed definition
compilation and then failed the relevant proof or invariant. The gate pins 55 AA
inputs and 309 external native core source files, checked again after verification.
The gate regression suite passed 57 tests; the profile/vector suite passed 12.
Exact model/source/tool hashes and profile applicability are in
[`aa-native-abi2-formal-20261008.json`](reports/aa-native-abi2-formal-20261008.json).

`NativeAuthorityEpoch.v` contributes 44 closed declarations and 22 mutations for
checked counters, callback-free recovery, namespace separation and the four-argument
execution commitment. Domain hashing, exact byte keys and VM transaction-witness
behavior remain source/runtime correspondence obligations. The ordinary TLC and
SMT checks retain their public/private contract scope. Formal models remain
hand-written abstractions, not C#/VM/NEF refinement or deployment attestations;
the result therefore retains `implementationVerified: false`. Counts below identify the dated snapshot that produced them; an ABI 2 label
alone does not establish compatibility with this amended, unreleased profile. Module/build and native-chain
receipts are separate evidence; a passing proof does not substitute for replay.


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

### Historical native ABI 1 evidence

The historical fail-closed AA-local host gate passed on 2026-10-08: **25 Coq
modules, 360 assumption-audited closed declarations, and 198 rejected semantic
mutations** (194 Coq and four TLA mutations). TLC explored 61,460 distinct
states, all six SMT obligations and six controls passed, and the runner suite
passed **52/52**. The historical receipt is
`docs/reports/aa-formal-gate-native-multisig-20261008.json`.
That gate pinned 23 source files, including the exact native module authority
guard, selected module profiles and session clock/payload adapters. The entry lemmas require
both the fixed native contract identity and an authenticated phase grant; a matching
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
proofs. Its leaf-policy counterexample holds signature/domain predicates fixed and records
the historical ABI 1 key-reuse risk. ABI 2 changes the authorization domain on
configuration and recovery; `NativeAuthorityEpoch.v` models rejection of those
stale signatures. Neither abstraction alone proves their VM composition.

The historical ABI 1 evidence was recorded as
`docs/reports/aa-native-session-scope-validation-20261007.json`: two private
chains, each with 44 persisted matrix transactions (27 HALT, 17 expected
FAULT), five witness-admission rejections and two registrations. Exact raw
storage and all grant-event fields are compared. A zero-cap false GAS transfer
completes and consumes nonce without spending; a target FAULT rolls back. A
wildcard grant permits read methods and a whole-balance GAS transfer but still
rejects another target. The same retained signature bytes reject while the key
is replaced or revoked, then succeed after explicit regrant; an already consumed
nonce still rejects. These observations apply only to that historical ABI 1
source/artifact/receipt set, not the current ABI 2 protocol. The referenced raw
receipt is absent from the current checkout; its exact source and artifact
identity must be recovered before replaying or reusing those observations.
For ABI 2, `NativeAuthorityEpoch.v` separately models stale-signature rejection
after configuration or recovery changes the authorization domain. That model
does not replace current runtime signature evidence or rebind the historical
receipt to current artifacts. No production contract or native artifact changed
in the historical validation.

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
they do not assert that the native contract emits malformed operations.

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

An earlier native integration worktree reported a registered SmartAccount
implementation, including lifecycle, delayed module configuration, dependency
cleanup, bounded callbacks, exact proxy Verification and target-frame witness
enforcement. Those results belong to that historical source/artifact snapshot
and are not current native-contract readback. The native-contract receipt from
that snapshot is
`docs/reports/aa-neoexpress-native-contract-after-configuration-20261006.json`; it is bounded persisted
lifecycle evidence, not complete native conformance. Source/artifact hashes and
current node-suite results are recorded by the native integration worktree's
`docs/reports/smartaccount-native-source-runtime-validation-20261006.json`. Older
component-only receipts remain historical evidence, not current native-contract status.
The signed proxy receipt `docs/reports/aa-neoexpress-native-proxy-20261006.json`
adds six persisted transactions (two expected FAULTs) and three admission
rejections with exact witness/script and asset-balance readback. Native raw-call
bridge coverage is 100% line/branch; native-contract entry/execution coverage is also
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
core/VM assemblies also pass all 1,702 node tests. The native contract, signed proxy,
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

### Historical ordinary-contract evidence

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
only to bounded `PLATFORM` and native callbacks. Public `v3` uses standard `System.Contract.Call` and has **no
per-verifier child gas budget**. `ProxyWitnessScript.v` models only the ordinary public/private direct-call parser.
Native-specific lifecycle, registry, witness and module models are labelled
`native`; only the shared bounded MultiSig policy abstraction spans all profiles.
The ordinary execution/escape model, TLC state machine and uint256/paymaster
SMT file remain public/private-contract scope. Native integer, lifecycle and
dispatch obligations use the dedicated native models instead. No scope label establishes source/VM refinement or deployment parity.

The native source correspondence includes a separately supplied core checkout.
`--native-core-root` (or `NEOOS_NATIVE_CORE_SOURCE`) is mandatory for a complete
gate. Its reviewed source roster and hashes are checked before and after proofs;
missing files, extra files, changed bytes or absent provenance reject. The ordinary
SmartAccount contract source is never used as a substitute for the native
SmartAccount core source.
`NativeAuthorityEpoch.v` checks separate bounded counters, callback-free recovery,
revoked roots/dependencies/pending intents, unchanged identity/nonces/frozen state,
abstract generation isolation and stale-domain rejection. The four-argument
native execution envelope commits both counters in the unsigned transaction;
its guard applies to custody fallback and native transaction witnesses as well
as operation-signature verifiers. The model rejects the old two-argument arity
and stale explicit counters even when the witness-evidence predicate is true. Namespace emptiness
requires no writes into future generations; byte encoding and exclusive use by
every module require independent source and runtime validation. Historical
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

The registered `NeoVmContinuationSemantics.v` model rejects zero and oversized
callback limits and charges the current budget and every ancestor atomically.
Bounded returns restore the already-debited parent; ordinary CALL, CALLT and
`LoadScript` frames share the same budget chain. The parent-100/child-10/charge-3
regression returns with 97 and admits a subsequent sibling budget of 20.
The model treats `_initialize` as a per-load context, models saved return
addresses, applies the hardfork gate fail-closed, and rolls back storage without
refunding consumed gas. Explicit charges abstract away opcode prices,
transaction fees and runtime scheduling. These are bounded semantic
obligations; they do not constitute a complete NeoVM/ApplicationEngine or
compiler-refinement proof.

The SMT nonce model checks equality with the entire executable nonce domain,
and its positive control uses that same acceptance predicate at zero and
`2^255 - 1`. Executable regression mutations cover reject-all, missing boundary
values and out-of-domain admission; independent SAT examples that never call
the acceptance predicate are insufficient evidence of nonempty acceptance.
These corrected models supersede the corresponding model bytes in the
historical 2026-10-13 receipt; that receipt is not evidence for these revisions.

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
| `formal/coq/SmartAccountAA.v` (sibling: `verified/coq/`) | Closed Coq proofs for authorization, exact channel nonce use, rollback, reentrancy, escape-owner gating, success-only state transitions, and the rule that an absent hook/verifier cannot fail a callback phase |
| `formal/coq/MultiSigPolicy.v` | **Public V3/PLATFORM only:** bounded ten-child configuration, exact signature cardinality and threshold support; child identity is abstract |
| `formal/coq/OrdinaryGovernance.v` | **Public V3/PLATFORM source candidate:** owner-witness cancellation independent of caller, exact millisecond delay, pending rotation and rollback; binding/identity validity is a precondition |
| `formal/coq/OrdinarySponsorship.v` | **Public V3/PLATFORM source candidate:** transaction-wide cumulative reservation cap, request bound, zero-fee estimation control and failure rollback; no storage/fee/VM refinement |
| `formal/coq/OrdinaryRecovery.v` | **Public V3/PLATFORM source candidate:** callback-free recovery and irreversible owner-only latch with projected identity/nonce retention; no storage or all-entrypoint refinement |
| `formal/coq/NativeCompositePhase.v` | **Native ABI 2 only:** first-threshold selection, one-operation receipt ownership and discard, approved-child grants, all-active pins, and pre/post policy equality under bounds 3/2/2/3; no byte-copy, hash, crypto or gas-feasibility refinement |
| `formal/coq/ProxyWitnessScript.v` | Byte-level model of the proxy-witness transaction-script parser (`ScriptIsSingleExecuteCall`, `ScriptPrefixIsDataPushes`, `DataPushInstructionSize`): an accepted script is a data-push walk landing exactly on the expected direct `executeUserOp`/`executeUserOps` call with its two-argument pack, every instruction start in that walk is a data-push opcode (so no SYSCALL/CALL/JMP/TRY precedes the core call), acceptance binds account id and core hash, and the canonical shapes are reachable while a leading non-push opcode, a foreign account id, an out-of-range CallFlags push and a trailing instruction are rejected |
| `formal/coq/CallbackPluginTopology.v` | Closed abstract correspondence model for the six-field hook callback tuple, configured-vs-absent callback phases, success/callback ordering, CalledByEntry/Custom target binding, and fail-closed plugin cleanup/rotation; it is not a proof of NeoVM dispatch or arbitrary plugin storage |
| `formal/coq/VerifierGasBudget.v` | **Bounded PLATFORM/native profiles only:** closed abstract model of bounded callback charging: every charge checks the callback and all ancestor budgets before mutation, exhaustion is atomic, and nested callbacks cannot escape an ancestor cap; inapplicable to public `v3` |
| `formal/coq/AuthorizationEvidence.v` | Closed protocol-level binding and replay model for cryptographic, native-witness, attestation and proof evidence; primitive validity is an explicit oracle, so this is not a proof of ECDSA, witness-rule evaluation, attestation or ZK soundness |
| `formal/coq/AttestationProofBinding.v` | Closed protocol-envelope model for attestation and zero-knowledge evidence: account, target, nonce, issuer, measurement commitment, non-zero nullifier and single-use binding; primitive cryptographic and proof validity remain explicit oracle inputs |
| `formal/coq/WitnessRuleSemantics.v` | Closed bounded model of Neo's first-match rule decision, default deny, allow/deny precedence, entry/direct-child scope, condition composition, and parser depth/child limits; it is not a refinement proof of `ApplicationEngine` or group-key cryptography |
| `formal/coq/WitnessRuleFaultSemantics.v` | Closed fuel-bounded model of `ReadStates` faults, left-to-right And/Or short-circuiting, fault propagation through `Not`, and first-match fault behavior; concrete engine tests cover the corresponding permission and scope paths |
| `formal/coq/WitnessRuleRefinement.v` | Closed refinement from parser-admissible fault-aware condition/rule evaluation to the Boolean model under readable permission; the uniform fuel certificate is derived rather than supplied, and does not refine the binary/JSON decoder or complete `ApplicationEngine` |
| `formal/coq/NeoVmCallSubset.v` | Closed bounded transition-shape model for the proxy-relevant push/PACK/contract-call/RET subset; it rejects unsafe prefixes, truncated tails and trailing instructions, but is not the complete NeoVM or `ApplicationEngine` semantics |
| `formal/coq/NativeAuthorityEpoch.v` | Native ABI 2 abstraction of checked independent counters, callback-free recovery, revoked roots/dependencies/pending intents, generation isolation and stale signature domains; excludes VM/byte-key refinement and assumes no future-generation writes |
| `formal/coq/NeoVmContinuationSemantics.v` | Closed bounded model of callback-limit admission, CALLT/RET continuations, `LoadScript` budget inheritance, per-load initialization, hardfork gating, ancestor charging, and storage-only rollback; it is not a complete VM or compiler-refinement proof |
| `formal/coq/AbiManifestProjection.v` | Closed finite, order-independent ABI projection model requiring exact source/manifest coverage, unique `(name, arity)` dispatch keys, parameter/return/safe equality, and the generated initializer |
| `formal/coq/SignerDomainSeparation.v` | Closed binding model requiring exact authorization domain and payload equality; it rejects cross-domain replay but does not prove private-key independence or primitive cryptographic soundness |
| `formal/coq/SignerIndependence.v` | Closed finite countermodel showing that distinct public signer domains do not imply private-key independence; this is an explicit trust-boundary proof, not a key-generation proof |
| `formal/coq/PluginLifecycle.v` | **Native profile only:** closed finite countermodel showing that a lifecycle ABI does not imply complete cleanup of arbitrary future-plugin storage, plus a conditional theorem for a certified cleanup function; ordinary V3 lifecycle claims remain runtime/artifact evidence |
| `formal/tla/SmartAccountAA.tla` (sibling: `verified/tla/`) | Finite state-machine exploration of Begin/success/failure/Tick transitions |
| `formal/tla/SmartAccountAA.cfg` | TLC bounds and safety invariants |
| `formal/smt/aa_core.smt2` (sibling: `verified/smt/`) | Nonce arithmetic, cursor advancement, rollback equalities, reimbursement cap and budget arithmetic |
| sibling `reports/aa-formal-20260918/README.md` | Human-readable result and boundary report |
| `formal/verify.py` | AA-local fail-closed runner with source pins and semantic mutations |
| `formal/Dockerfile`, `formal/verify-in-docker.sh` | Pinned Ubuntu 24.04 environment (Coq 8.18, Z3, OpenJDK, TLA+ tools jar pinned by SHA-256) so an independent reviewer runs the identical gate without a host toolchain |
| `formal/test_verify.py` | Runner/parser fail-closed regression tests |
| `formal/source-lock.json` | Reviewed source snapshot hashes; not a proof attestation |

### Source-pin refresh after the rename and the headroom assertion

`formal/source-lock.json` currently pins 61 source files. The historical
rename refresh below pinned 59 source files. Thirty-five of those pins were
stale against the working tree and `formal/verify.py` failed closed at
`Source drift: Directory.Build.props` before running any Coq or TLC lane. The
pins were refreshed only after classifying every one of the 35:

- **31 files are rename-only.** Replacing `AbstractAccount` /
  `UnifiedSmartWallet` / `abstract-account` with `SmartAccount` /
  `smart-account` in the previously pinned content reproduces the current file
  byte for byte, so the correspondence statements are unchanged.
- **`contracts/SmartAccount.Paymaster.cs`** gains the 73-byte VM-integer
  headroom assertion (`vmMax` plus `budget.Reserved <= vmMax - settled`). That
  assertion is inside the helper the complete-context certificate models; the
  refinement lanes prove the guard succeeds on the legal domain
  (`legal_update_fits`, `vm_leb_margin_of_fits`), so the pinned correspondence
  still holds for the new text.
- **`contracts/SmartAccount.State.cs`** changes only the
  `AccountImplementationId` string constant, no executable logic.
- **`formal/verify.py` and `scripts/verify_repo.sh`** carry the same rename plus
  mutation-table entries for the renamed models; the diff adds and removes no
  `require(...)` call, so no gate assertion was relaxed.

This refresh re-attests the manual correspondence snapshot against the reviewed
bytes. It discharges no open obligation and changes no proof: the public,
runtime, gas and ABI-refinement boundaries listed above remain open, and
`implementationVerified` stays false.

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

Native ABI 2 separately fixes verifier callbacks at 100,000,000 datoshi and hook/maintenance callbacks at 250,000,000 datoshi on the source-built SmartAccount runtime. The bounded gas model uses abstract budget parameters; it does not establish complete VM fee accounting.

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

For the ordinary deployed public/PLATFORM profiles:

The cleanup model proves fail-closed state transitions, not recovery availability:
`finalizeEscape` still depends on successful cleanup by the old verifier and hook.
The 2026-10-08 source validates the replacement verifier before these callbacks, but
does not introduce emergency detach or guarantee progress past a malicious old module.
`CallVerifierChild` and its explicit `getChildVerifierConfig` capability are absent from the
deployed core manifest (`contracts/build/SmartAccountV3.manifest.json`) although they are
recorded in the source snapshot and tested in NeoVM; both are outside the current abstract models.
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
or reference-isolation behavior. `MultiHook` applies the same result-snapshot boundary
to each leaf post-hook, and a dedicated NeoVM vector verifies that one hook cannot change
the business result observed by the next; this remains runtime evidence, not a formal
serialization or callback-refinement proof.
The local runtime suite does check the concrete session-key ordering rule:
after `clearSessionKey` executes, a later `validateSignature` faults with no
active key, and the clear emits `SessionKeyRevoked`. This does not cancel a
transaction already ordered earlier and does not provide mempool invalidation.

The protocol boundary is now explicit in the implementation and proposal:
nonzero valid target, method length 1--128 UTF-8 bytes, argument count at most
64, canonical argument serialization at most 4096 bytes, signature at most
1024 bytes, non-empty batch of at most 32 operations, and nonce/deadline in
the non-negative signed-256-bit domain (`0 <= value < 2^255`). Therefore an
executable nonce has 191 channel bits, not 192. The current ordinary source
applies the same signed-VM bound to `getNonce` reads. A historical deployed
foundation artifact may still admit a wider, unsigned-192-bit query range until
it is republished; that does not make those upper-half channels executable and
is not native-profile conformance. The native codec rejects channels at or above
`2^191`.

The ordinary execution model scopes callback predicates to the configured
modules: an absent hook or verifier has no callback phase that can reject the
operation, while an installed module must return normally. This closes the
previously implicit `hookInstalled` state in the abstract model. Callback
noninterference, callback storage isolation and the correspondence from these
predicates to concrete NeoVM faults remain separate runtime obligations.

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
that native `SmartAccount` exists.

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
runtime checks, not a mechanized parser/VM refinement or native contract test.

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

The historical native-prototype contract run was **368 passed, 0 failed, 0 skipped** when the
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
3.10.1.20+59ee6e2d43 build. It passed all 14 scenarios, and the
release-eligible receipt for that dated run was
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

The current AA solution test run passed **571/571** with the sibling artifact
supplied. In a standalone checkout it passes **569/571** and explicitly skips
the two DID cases; the two modes remain intentionally distinct.

The historical 2026-09-21 standalone checkout without the sibling `NeoDIDRegistry` artifact passed
**290/292** and records exactly the two cross-repository DID cases as explicit
skips; it does not count those cases as passes. The earlier 289/291 result is
historical, from before the zero-fee estimation regression test was added.

The historical 2026-09-21 source-to-artifact replay independently compiled the scratch tree
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
`tests/SmartAccount.Contracts.Tests/AAArtifactStructureRuntimeTests.cs`
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

The earlier lifecycle host snapshot is recorded in
`docs/reports/aa-formal-gate-20261006-native-lifecycle.json`: 18 modules,
223 closed declarations, 105 rejected semantic mutations, 61,460 distinct TLC
states, six SMT obligations and six controls; the runner has 42 passing tests.
At that checkpoint the pinned container image was unavailable on the accessible
daemon, so the dated snapshot had no container PASS. The current container
receipt in Status includes this model; earlier receipts remain historical.

`docs/reports/aa-neoexpress-native-state-20261006.json` records eight private
state-initializer/serialization round trips. They used a node with no native
SmartAccount contract and persisted no application transactions; this
is state-codec compatibility evidence, not lifecycle execution evidence.

### Native callback dispatch boundaries

`NativeDispatch.v` models SmartAccount activation using the configured height
and the persisting-or-ledger index, native caller and permission guards, and
the distinction between a resumed native dispatch fee and the returning child
instruction's whitelist policy. It addresses a concrete runtime regression:
a future activation key is not equivalent to activation when no persisting
block exists. The fee model assumes an already computed nonnegative fee; the
existing bounded-budget models cover ancestor accounting. It does not prove
application-engine C# refinement, full scheduling, or complete native contract
behavior.

The dated native-dispatch host receipt is
`docs/reports/aa-formal-gate-20261006-native-dispatch.json`: 19 modules,
236 closed declarations, 112 rejected semantic mutations, 61,460 distinct TLC
states and 43 passing runner tests. Its pinned-container rerun was unavailable
at that checkpoint; the current container receipt in Status includes this
model without promoting older evidence.

`docs/reports/aa-neoexpress-native-activation-20261006.json` records a private
Verification-trigger regression: the historical runtime accepted a bounded
syscall despite a future activation height, while the corrected runtime rejects
it. Missing activation rejects it and explicit activation permits it. A small
ordinary diagnostic contract was deployed and its script/manifest read back;
this is not activation of native SmartAccount or a chain invocation of the
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
Application request. The boundary probe compares the Application execution
height, which is the next block after the latest persisted ledger index,
because the
`invokecontractverify` RPC has no persisting-block argument and cannot select
the block context required to prove a nonzero hardfork height. Samples spanning
a block change are discarded; both execution heights
`height - 1` and `height` must be observed. A timeout is a failure, not evidence
of rejection. The default timeout accommodates fifteen-second blocks because
the running protocol's block policy may override the runner's one-second hint.
The resulting receipt is tagged `evidenceKind: "syscall-smoke"` with
`nativeActivationClaim: false`; it is evidence for the bounded-call syscall
gate only, not for native `SmartAccount` activation or lifecycle
conformance.

A previous PASS is invalidated before starting any chain, so interruption cannot
leave stale success evidence. Receipts distinguish persisted diagnostic deployments from simulations and
record runtime hashes without wallet material or absolute local paths. Failures
leave a non-PASS receipt and owned nodes are stopped in `finally` blocks. Neither
this validator nor its probe registers SmartAccount, validates its full
lifecycle, or establishes a compiler-refinement theorem.

### Native invocation authority boundaries

`NativeInvocation.v` proves account/phase separation, frame-sensitive root
admission, direct-child delegation, target/module separation, revocation and
the requirement to retain the original witness checks. It treats frame tokens,
deployment and caller facts as abstract inputs. Its eighteen declarations and
thirteen semantic mutations also cover activated native-contract-hash witness rejection,
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
