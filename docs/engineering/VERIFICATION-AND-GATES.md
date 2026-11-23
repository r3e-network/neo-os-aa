# Verification and gates

This book is the SmartAccount process-layer verification record. English only by
policy: these chapters change with every gate run, and a stale translation would
misstate the evidence. Phase 2 of the docs role-based reorganization merged the
seven former process documents into two books; this one carries the verification
and gate chapters, verbatim — SA-FORMAL-VERIFICATION.md, SA-REPRODUCIBLE-BUILD.md,
SA-CLOSURE-GATE.md, SA-ENTRYPOINT-CLOSURE.md and SA-MIGRATION-MANIFEST.md — with
each former document demoted to a chapter: the original titles are kept, heading
levels moved down one step, and cross-file links were re-pointed at their new
locations. The contract/SDK/frontend handoff records moved to the companion book
[HANDOFF-RECORDS.md](HANDOFF-RECORDS.md). The Chinese reading guide for this layer
stays at [SA-SPEC.zh-CN.md](../SA-SPEC.zh-CN.md).

## Contents

1. [SA Formal Verification](#sa-formal-verification) — bounded Coq models, runtime correspondence, open boundaries
2. [SA contracts: reproducible build from published packages](#sa-contracts-reproducible-build-from-published-packages) — pinned toolchain, byte-for-byte rebuild, pin bumps
3. [Integrated refinement closure gate](#integrated-refinement-closure-gate) — the gate that decides whether any entrypoint counts as verified
4. [Public entrypoint closure inventory](#public-entrypoint-closure-inventory) — per-entrypoint closure rules
5. [SA Migration Manifest — Legacy → Protocol v4 (Design)](#sa-migration-manifest--legacy--protocol-v4-design) — legacy-to-v4 migration manifest and idempotency rules

## SA Formal Verification

### Status

#### Fixture refresh (2026-11-21)

The 2026-11-21 v4 protocol-conformance rebuild changed the custom core again
(credential generation is 1-based, one core-wide reentrancy exclusion, code
binding continuity after every writable callback and at commit, and `NefSha256`
as `SHA256(NEF)`), so the artifact identity moved to NEF `397f96ab…` / manifest
`4939cf01…` with a 44,833-byte script. Every lane constant, fixture and receipt
in `formal/refinement/` was re-derived from those bytes: the helper is still the
byte-identical 281-byte / 116-instruction / 52-opcode program and moved by +272
to `[36586,36867)`; the initializer is `[44047,44833)` at 786 bytes / 245
instructions; the charge region is `[36696,36718)`; the reimbursement
`Storage.Put` is `36858`; the initializer static controls are the `PUSHDATA1`
data byte `44605` and the `STSFLD` slot operand `44609`. The five-shape
helper-gas runtime capture was re-captured with its producer test rather than
edited. One lane control needed re-anchoring instead of shifting:
`gas_trace_proofs`' hash-equal-branch mutant named PC 36126, which after the
move named no instruction inside the bound helper at all — a latent bug that
raised instead of rejecting — and now names the reviewed branch at `36664` with
edges `36666` / `36680`. The refreshed receipt
(`formal/refinement/fixtures/current-method-proof/method-proof.json`, SHA-256
`a4bd1854…`) records `kernelChecked: true`, `referenceRefinementVerified: true`
and `fullImplementationVerified: false` over `[36586,36867)`, with method
`9aec81b7…`, certificate `f339b6ec…` and `CapMethodVm` model `5ac5fa2c…`; all
111 closed assumptions are enumerated and 6/6 semantic controls are rejected on
Rocq 9.0.1. Suite results for the re-anchored lane: `test_gas_trace` 22/22,
`test_method_proofs` + `test_initializer_proofs` 32/32, and
`test_composition_proofs` + `test_context_proofs` + `test_public_pure_proofs` +
`test_gas_proofs` 28/28. That scope stays a bounded helper/reference refinement,
not a proof of the whole implementation; the initializer `CapContext` gap for
the `UInt64Mask` statics remains open under Task 26.

#### Fixture refresh (2026-11-16)

The 2026-11-16 design-phase legacy-compatibility sweep changed the custom
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
The 2026-11-19 v4 rebuild moved the artifact again, to NEF `2887bad3…` /
manifest `f44cddeb…`; every lane constant, fixture and receipt listed in this
document was re-pinned or re-distilled against that artifact, except the archived
helper-gas runtime capture, which still pins `9f714866…` and therefore fails
closed until a new capture is produced.
The 2026-11-20 rebuild moved it once more, to NEF `27e28aa0…` / manifest
`f0c6467b…`. That pin was re-anchored from the live bytes, and the five-shape
helper-gas runtime capture was re-captured with its producer test rather than
edited, so the lane constants in the archived method-refinement record (removed from the tree) and the receipts under
`formal/refinement/fixtures/` name this artifact. Two model bindings did not
survive the move: the reimbursement key is static slot 58 (slot 38 is now
`UInt64Mask`) and the codec tokens are `deserialize` 2 / `serialize` 3 (not 3 /
4). Both were corrected in `formal/refinement/` and re-checked on a Coq 8.18 host
against this artifact. The refreshed receipt
(`formal/refinement/fixtures/current-method-proof/method-proof.json`, SHA-256
`98711714…`) records `kernelChecked: true`, `referenceRefinementVerified: true`
and `fullImplementationVerified: false` over the helper `[36314,36595)` at 281
bytes / 116 instructions, with method `9aec81b7…`, certificate `f339b6ec…` and
`CapMethodVm` model `5ac5fa2c…`; `coqc` and `coqchk -silent` are clean, all 111
closed assumptions are enumerated, and the 5/5 composition tests pass. That
scope stays a bounded helper/reference refinement, not a proof of the whole
implementation. The initializer `CapContext` still does not cover the
`PUSHINT8`/`SHL`/`SUB` writes that establish the v4 `UInt64Mask` statics and
remains open under Task 26. The archived pre-rename capture continues to fail
closed by design.
The retired pre-sweep getter shapes are gone: `storage_getter_source.py` no
longer carries the `legacy_symbol` / `inline-fallback` forms, the lane's
source-level semantic controls are now the prefix/default binding mutants, and
the legacy read-order controls were removed from the lane, the closure gate
and the regression suite.

#### Current private validation refresh (2026-10-31)

The current SmartAccount/native-core source snapshot passes the pinned Docker
formal gate. The receipt at
`docs/reports/sa-formal-gate-20261031.json` records 29 Coq modules,
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

Separately, the custom SA protocol suite was rerun end to end with the same
source-built NeoExpress runtime. The current receipt at
`docs/reports/sa-neoexpress-validation-20261031.json` reports `PASS` and is
release-evidence eligible for the private chain: 25 deployed artifacts
(24 local artifacts plus the sibling `NeoDIDRegistry`), 15 scenarios, 135
persisted transactions (132 HALT and 3 FAULT), 48 expected negative cases
(45 refused before persistence), 132 on-chain assertions, and 25 byte-identical
RPC NEF readbacks with matching checksums and semantically equal manifests.
The source-to-artifact-to-chain join at
`docs/reports/sa-private-artifact-provenance-20261031.json` compares all 80
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

The remaining boundary is explicit: custom public profile still calls verifiers
through `System.Contract.Call` without an independent child gas cap. Public
deployment and public artifact parity are outside this private-only run. The
formal and runtime evidence also retain the cryptography, complete WitnessRule
and NeoVM, compiler/refinement, key independence, and arbitrary-plugin cleanup
boundaries described below. No public network was used by this refresh.

#### Layered implementation refinement (2026-10-13)

The [implementation gate](#appendix-custom-implementation-refinement) now requests four
proof lanes by default: the original arithmetic region,
`numeric coercions`,
`reservation arithmetic`, and
`complete reimbursement-helper reference refinement`.
The last lane uses a `typed source projection`
and the `complete instruction inventory`.
`Pinned-engine runtime checks` provide separate,
finite evidence, including storage and fault behavior. None of these lanes alone
verifies the whole contract or public protocol activation.

Run the default gate from the repository root with a new or empty output
directory:

```sh
python3 formal/refinement/verify.py --timeout-seconds 1800 --output-dir /tmp/sa-refinement-evidence
```

The fresh integrated report `reports/sa-method-refinement-20261013.md` (not
included in this checkout) and its
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
See the [dialect and identity boundary](#neo-contract-dialect-and-object-identity)
before interpreting a reference theorem as implementation acceptance.

**Full implementation refinement remains NO-GO.** No complete public entrypoint
has been certified by these helper lanes. A successful partial default run still
returns exit `2`, unless explicitly requested with `--allow-partial`, and retains
the false implementation status.

#### Historical arithmetic-region certificate (2026-10-13)

The separate [implementation refinement gate](#appendix-custom-implementation-refinement)
now binds typed Roslyn operations, a byte-identical NCCS rebuild, the complete
100-entry manifest and independently decoded candidate NEF to an actual Coq
certificate. The proved region is the reimbursement arithmetic at PC
`[13667,13689)`: 22 original instructions, with signed-256 bounds, typed entry
conditions, result equality, argument/local-frame preservation and equality to
the existing `CustomSponsorship.charge` definition.

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
dated refinement report `reports/aa-implementation-refinement-20261013.md` (not
included in this checkout) contains the exact artifacts, commands, controls and
remaining method obligations.

#### Historical source-candidate host closure (2026-10-13)

The frozen custom source-candidate snapshot passed the host model gate:
**29 Coq modules, 490 closed declarations, 287 rejected semantic mutations**
(283 Coq and four TLA), **61,460 TLC distinct states**, and **seven SMT obligations
with seven controls**. The gate checks 59 SA source inputs and 310 native-core
source inputs before and after verification. The runner regression suite passes
68 tests. The tracked receipt is
`reports/sa-formal-ordinary-closure-20261013.json`
(not included in this checkout; SHA-256 `7ad982a403b7c2b953c946f49ce42fe544be1b87fa3fbdd668078623070bc5b9`);
it is byte-identical to
`formal/.runs/ordinary-closure-final-r3-20261013/result.json`.
The host used Rocq 9.2, Z3 5.1.0, OpenJDK 26.0.2.1, and the reviewed TLA jar
with SHA-256 `7beec0f04818732a62fa193731711a99aa4f11279499b2360a7d156c519ea78d`.

This closes **GO for the declared custom protocol abstractions and reviewed
source-snapshot checks**: governance authorization and delay, cumulative
transaction sponsorship reservations, and permanent owner-only recovery are
included. `implementationVerified` remains **false**. Source-fragment checks
and model proofs do not establish C# to NEF to NeoVM refinement, all-entrypoint
storage semantics, cryptography, complete fee accounting, arbitrary plugin
liveness, or public activation.

The independent pinned-container gate also passes this same source/model
snapshot with Coq 8.18.0, Z3 4.8.12 and OpenJDK 21.0.12.1, including all 68 runner
regression tests. The container receipt is
`reports/sa-formal-ordinary-closure-docker-20261013.json` (not included in this
checkout; SHA-256 `283e7517b9c113fb829f4735206da2c882e84be8065ffbeae09ed8259bc9289e`).
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
`reports/sa-formal-container-build-20261013.json`
(not included in this checkout; SHA-256 `d17b6b6d61568bdad038adf19baa3615d7fce00f1fad9fa9de82cda1e9891a8c`).
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

#### Previous host snapshot (2026-10-13)

The previous custom-governance source and model snapshot passed the host formal gate:
**27 Coq modules, 460 closed declarations, 258 rejected semantic mutations,
61,460 TLC distinct states, six SMT obligations and six controls**, with the
native core roster checked at 310 exact source files. The tracked custom-governance
receipt is `reports/sa-formal-ordinary-go-20261013.json` (not included in this
checkout)
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

The custom public profile also retains two protocol-level NO-GO boundaries:
`public` callbacks use standard `System.Contract.Call` without an isolated
child budget, and the pinned public ABI still exposes immediate platform-account
backup-owner rotation. The source candidate now contains a two-stage
proposal/confirmation/cancellation path with a new-owner witness, but closing
the public boundary requires an ABI migration from the pinned 90-entry artifact
to the reviewed source-candidate ABI, an upgraded artifact, and public
readback; this repository does not relabel it as closed based on static tests.

The custom source candidate now has an explicit Coq governance model
(`CustomGovernance.v`) covering registrar and owner authorization, duplicate
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

`CustomSponsorship.v` models one ledger per core and transaction shared across
accounts, sponsors, paymasters, single calls, batches and nested execution.
Reservations precede external callbacks; repeated successful reservations sum
to at most the positive enclosing transaction fee. A theorem relates the
abstract charge to the branch-free source expression. Zero-fee RPC estimation
retains requested quotes and has no persisted-fee-bound claim. Transaction hash
identity, fees, stored ledger integrity, enclosing-transaction rollback and actual
token settlement remain implementation correspondence obligations.

`CustomRecovery.v` models the source candidate's callback-free recovery to an
irreversible owner-only latch. It proves independence from old plugin outcomes,
maturity/witness/lock/escrow guards, root/context/intent detachment, retained
identity and nonce projections, rejection of repeated recovery, and rejection
of nonzero root installation after recovery. It has no transition that reopens
plugin authority and does not claim native authority-epoch semantics. Concrete
storage cleanup, all-entrypoint enforcement and witness validity require the
matching source review and VM tests. Irreversibility is scoped to this version's
modeled transitions; administrative code upgrades and future protocol versions
are outside that claim.

#### ABI 2 convergence boundary

The active native target is SmartAccount ABI 2, with identity derivation
version 1, authorization/account-record version 2, and separate authority epoch
and configuration nonce. Native recovery revokes old module generations without
external cleanup. The six native modules use epoch-scoped state. Custom
`public` and private `PLATFORM` sources are retained as separate profiles; native
claims must bind the external Neo core sources, not the old deployed-core prototype.

The unreleased ABI 2 profile now requires the exact profile fingerprint and a
strict verifier-composition marker on every module. Its native composite model
uses a transient three-field receipt, first-threshold selection, at most three
children/two approvals/two threshold/three signer domains, fresh per-operation
ownership, all-active binding checks and pre/post policy equality. The public
`MultiSigPolicy.v` ten-child/repeated-validation model applies only to `public` and
`PLATFORM`; `NativeCompositePhase.v` covers the separate native receipt design.
Session's epoch-scoped prefix `0x05` stores deterministic signer-domain
configuration, and prefix `0x06` holds the independently updated last-use time;
neither stores a persistent approval. Neither model proves byte copying,
hashing, cryptography, implementation refinement or gas feasibility.

The frozen composite profile passed its complete host gate on 2026-10-09:
**26 Coq modules, 443 closed declarations, 247 rejected semantic mutations**
(243 Coq and four TLA), **61,460 TLC distinct states**, and six SMT obligations
with six controls. The gate checked 55 SA inputs and 310 external core inputs
before and after the proofs. `NativeCompositePhase.v` contributes 45 closed
declarations and 31 definition-valid, proof-rejected mutations. The exact result
is [`sa-native-composite-final-formal-20261009.json`](../reports/sa-native-composite-final-formal-20261009.json).
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
[`sa-native-composite-final-build-proof-20261009.json`](../reports/sa-native-composite-final-build-proof-20261009.json).
Final native private-chain and SDK integration receipts remain separate gates;
older runtime receipts do not certify this profile.

The preceding ABI 2 snapshot's host gate passed on 2026-10-08: **26 Coq modules, 409 closed declarations,
222 rejected semantic mutations** (218 Coq and four TLA), 61,460 TLC distinct states,
and six SMT obligations with six controls. All mutations first passed definition
compilation and then failed the relevant proof or invariant. The gate pins 55 SA
inputs and 309 external native core source files, checked again after verification.
The gate regression suite passed 57 tests; the profile/vector suite passed 12.
Exact model/source/tool hashes and profile applicability are in
[`sa-native-abi2-formal-20261008.json`](../reports/sa-native-abi2-formal-20261008.json).

`NativeAuthorityEpoch.v` contributes 44 closed declarations and 22 mutations for
checked counters, callback-free recovery, namespace separation and the four-argument
execution commitment. Domain hashing, exact byte keys and VM transaction-witness
behavior remain source/runtime correspondence obligations. The custom TLC and
SMT checks retain their public/private contract scope. Formal models remain
hand-written abstractions, not C#/VM/NEF refinement or deployment attestations;
the result therefore retains `implementationVerified: false`. Counts below identify the dated snapshot that produced them; an ABI 2 label
alone does not establish compatibility with this amended, unreleased profile. Module/build and native-chain
receipts are separate evidence; a passing proof does not substitute for replay.


#### Bounded configuration postcondition

The native confirmation boundary must re-admit both the selected child and its
bound root after callback execution. A concrete regression reproduced a child
configuration destroying its root and still returning HALT. The repaired path
rechecks the root before committing. `NativeLifecycle.v` models the corresponding
two-binding postcondition and all-or-nothing snapshot selection: missing or
changed bindings select the original snapshot, not the staged callback writes.
Observed binding identities and whole-snapshot rollback remain abstract inputs;
this is not a proof of hashing, ContractManagement or C# callback refinement.
The private receipt `docs/reports/sa-neoexpress-native-configuration-20261006.json`
records ten signed configuration transactions and two registrations, including
two persisted root-destruction FAULTs and benign controls under the same roots.

The repository-local formal artifacts under `formal/` are the inputs to the
fail-closed gate below; the sibling local `neo-os-formal-verification`
workspace carries the parallel verification set.

#### Historical native ABI 1 evidence

Receipts named in the historical sections below are dated records of the runs
they describe. Most 2026-10-05..08 receipts were never part of this checkout, so
a citation names the record, not a file you can open here; the current pinned
set is listed in [INDEX.md](../INDEX.md#evidence-receipts). None of them is evidence
for the current tree.

The historical fail-closed SA-local host gate passed on 2026-10-08: **25 Coq
modules, 360 assumption-audited closed declarations, and 198 rejected semantic
mutations** (194 Coq and four TLA mutations). TLC explored 61,460 distinct
states, all six SMT obligations and six controls passed, and the runner suite
passed **52/52**. The historical receipt is
`docs/reports/sa-formal-gate-native-multisig-20261008.json`.
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
`docs/reports/sa-native-session-scope-validation-20261007.json`: two private
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
witness isolation. See `docs/reports/sa-native-daily-capacity-validation-20261007.json`
for that repair's measured scope; token honesty and full compiler refinement are
still assumptions, not consequences of the scan proofs.

The current balance-observation extension is recorded in
`docs/reports/sa-native-daily-balance-validation-20261007.json`. Two independent
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
`docs/reports/sa-native-restricted-validation-20261008.json`.
The same five-profile build is also used for fresh DailyLimitHook, capped
SessionKey, uncapped SessionKey and native-witness/allowlist regressions.
Across six disposable chains, 361 persisted matrix transactions produce 214
HALT and 147 expected FAULT results; 12 registrations and 14 witness-admission
rejections are counted separately. Missing-snapshot rejection is guarded in
source and modeled formally, but is not directly fault-injected on these chains.

The earlier unchanged-bytecode probe is recorded in
`docs/reports/sa-native-nef-probe-validation-20261008.json`. Two independently
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
`docs/reports/sa-native-nef-phases-validation-20261008.json`. Two clean builds
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
recorded in `docs/reports/sa-formal-tool-provenance-20261007.json`. The upstream
`v1.8.0` asset is mutable. This is a new host toolchain run, not a replay of the
older container toolchain, and the Docker pin was not silently updated.

The scope includes the bounded MultiSig, authorization, attestation/proof
binding, fault-aware WitnessRule evaluator refinement, ABI projection,
NeoVM call/continuation subsets, signer-domain separation, signer-independence
and cleanup countermodels, signed Integer/nonce arithmetic, shadow cursors,
abstract native lifecycle authority, native-dispatch activation/fee guards, and account/phase/frame invocation isolation.
These are stated abstract obligations, not complete NeoVM or C#-to-NEF
refinement. Remaining non-public proof boundaries are recorded in
`docs/reports/sa-open-formal-boundaries-20261007.json`.

An earlier native integration worktree reported a registered SmartAccount
implementation, including lifecycle, delayed module configuration, dependency
cleanup, bounded callbacks, exact proxy Verification and target-frame witness
enforcement. Those results belong to that historical source/artifact snapshot
and are not current native-contract readback. The native-contract receipt from
that snapshot is
`docs/reports/sa-neoexpress-native-contract-after-configuration-20261006.json`; it is bounded persisted
lifecycle evidence, not complete native conformance. Source/artifact hashes and
current node-suite results are recorded by the native integration worktree's
`docs/reports/smartaccount-native-source-runtime-validation-20261006.json`. Older
component-only receipts remain historical evidence, not current native-contract status.
The signed proxy receipt `docs/reports/sa-neoexpress-native-proxy-20261006.json`
adds six persisted transactions (two expected FAULTs) and three admission
rejections with exact witness/script and asset-balance readback. Native raw-call
bridge coverage is 100% line/branch; native-contract entry/execution coverage is also
100% line/branch and module management is 100% line, 98.46% branch. All ten new
native/component files and instrumented added engine lines meet the 90% gate.
This does not prove all adversarial paths or full protocol conformance.
`docs/reports/sa-neoexpress-native-recovery-20261006.json` records 25 persisted
recovery/authorization transactions (15 HALT, 10 expected FAULT) and an additional
registration, with actual single/joint P-256 witnesses and complete account/cursor
readback. These are runtime checks, not new cryptographic or WitnessRule proofs.

The native integration runtime is now source-built rather than an assembly
overlay. The initial two-directory offline build and a receipt-pinned two-directory
replay compile eleven projects from 611 source files and 50 external package
archives; all 104 runtime files match byte-for-byte. See
`docs/reports/sa-neoexpress-source-build-final-20261006.json` and
`docs/reports/sa-neoexpress-source-build-replay-20261006.json`. The exact rebuilt
core/VM assemblies also pass all 1,702 node tests. The native contract, signed proxy,
configuration, recovery and four current activation cases pass again against
the same runtime, with complete runtime-file verification before/after each
matrix: `docs/reports/sa-neoexpress-source-runtime-final-20261006/summary.json`.
Original raw receipts are retained separately from provenance-annotated copies.
No production C# or formal model changed in this build-validation step. Its 72
script tests include failure, interruption, recipe/dependency and runtime-drift
controls. Reproducibility is not a compiler-refinement proof, a complete plugin
matrix, or a current external-dependency security audit.

The last successful pinned-container run covered an older snapshot: 17 Coq
modules, 95 rejected semantic mutations and 40 runner tests. Its receipt is
`docs/reports/sa-formal-gate-20261006-native-integer.json`. The newer shadow
cursor, lifecycle, dispatch, invocation, session and daily-limit changes have
**host evidence only**: neither the Desktop
nor Colima context returned a successful bounded daemon probe. The current status is
`HOST_PASS_CONTAINER_UNAVAILABLE`; an earlier container PASS is not reused for
changed model bytes.

#### Historical custom-contract evidence

The historical fail-closed SA-local gate passed on 2026-09-21: **5 Coq modules,
72 closed declarations, 30 semantic mutations rejected, 61,460 TLC distinct
states, and 6 SMT obligations with 6 controls**. The host run and the same
source snapshot in the cached-base Docker BuildKit stage both passed; the
runner regression suite is **20/20 OK**. This verifies the stated abstract
models and arithmetic obligations, not a claim that a deployed NEF is fully
formally verified.

The 2026-10-08 host gate passed **5 Coq modules, 77 closed declarations, 32 semantic
mutations rejected, 61,460 TLC distinct states, 6 SMT obligations and 6 controls**,
with **23/23** runner tests. Exact source/model/tool hashes and versions are recorded in
[`sa-formal-gate-20261008.json`](../reports/sa-formal-gate-20261008.json). The Docker gate was
not rerun; its pin is unchanged.

The 2026-10-08 source separates `public` and private `PLATFORM` execution. The
source lock and every new gate result include `runtimeProfiles` and `modelProfiles`;
the runner rejects missing or changed scope metadata. `VerifierGasBudget.v` applies
only to bounded `PLATFORM` and native callbacks. `public` uses standard `System.Contract.Call` and has **no
per-verifier child gas budget**. `ProxyWitnessScript.v` models only the custom public/private direct-call parser.
Native-specific lifecycle, registry, witness and module models are labelled
`native`; only the shared bounded MultiSig policy abstraction spans all profiles.
The custom execution/escape model, TLC state machine and uint256/paymaster
SMT file remain public/private-contract scope. Native integer, lifecycle and
dispatch obligations use the dedicated native models instead. No scope label establishes source/VM refinement or deployment parity.

The native source correspondence includes a separately supplied core checkout.
`--native-core-root` (or `NEOOS_NATIVE_CORE_SOURCE`) is mandatory for a complete
gate. Its reviewed source roster and hashes are checked before and after proofs;
missing files, extra files, changed bytes or absent provenance reject. The custom
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
provenance in `docs/reports/sa-formal-tool-provenance-20261007.json`; the mutable
upstream asset no longer matches the retained Docker pin. A host PASS does not
establish a successful build or run of the current container recipe.

**CI status:** `.github/workflows/ci.yml` runs `scripts/verify_repo.sh`, which
does not run the formal gate unless `--formal` or `NEOOS_REQUIRE_FORMAL=1` is
supplied, and the CI image provides neither Rocq 9 nor the TLA tools. The gate
is therefore a local/release obligation, and `verify_repo.sh` prints an
explicit `formal gate: NOT RUN` line whenever it is skipped so the gap is
visible in every CI log rather than implied by a green run.

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
| `formal/coq/SmartAccountAA.v` (sibling: `verified/coq/`) | Closed Coq proofs for authorization, exact channel nonce use, rollback, reentrancy, escape-owner gating, success-only state transitions, and the rule that an absent hook/verifier cannot fail a callback phase |
| `formal/coq/MultiSigPolicy.v` | **Public V3/PLATFORM only:** bounded ten-child configuration, exact signature cardinality and threshold support; child identity is abstract |
| `formal/coq/CustomGovernance.v` | **Public V3/PLATFORM source candidate:** owner-witness cancellation independent of caller, exact millisecond delay, pending rotation and rollback; binding/identity validity is a precondition |
| `formal/coq/CustomSponsorship.v` | **Public V3/PLATFORM source candidate:** transaction-wide cumulative reservation cap, request bound, zero-fee estimation control and failure rollback; no storage/fee/VM refinement |
| `formal/coq/CustomRecovery.v` | **Public V3/PLATFORM source candidate:** callback-free recovery and irreversible owner-only latch with projected identity/nonce retention; no storage or all-entrypoint refinement |
| `formal/coq/NativeCompositePhase.v` | **Native ABI 2 only:** first-threshold selection, one-operation receipt ownership and discard, approved-child grants, all-active pins, and pre/post policy equality under bounds 3/2/2/3; no byte-copy, hash, crypto or gas-feasibility refinement |
| `formal/coq/ProxyWitnessScript.v` | Byte-level model of the proxy-witness transaction-script parser (`ScriptIsSingleExecuteCall`, `ScriptPrefixIsDataPushes`, `DataPushInstructionSize`): an accepted script is a data-push walk landing exactly on the expected direct `executeUserOp`/`executeUserOps` call with its two-argument pack, every instruction start in that walk is a data-push opcode (so no SYSCALL/CALL/JMP/TRY precedes the core call), acceptance binds account id and core hash, and the canonical shapes are reachable while a leading non-push opcode, a foreign account id, an out-of-range CallFlags push and a trailing instruction are rejected |
| `formal/coq/CallbackPluginTopology.v` | Closed abstract correspondence model for the six-field hook callback tuple, configured-vs-absent callback phases, success/callback ordering, CalledByEntry/Custom target binding, and fail-closed plugin cleanup/rotation; it is not a proof of NeoVM dispatch or arbitrary plugin storage. The tuple it fixes is the one `BuildHookOperationParams(UserOperation, object[])` produced, and that constructor does not exist in v4: a v4 hook is a module callback reached through `CallHookPreCheck` / `CallHookPostCheck`, which no Coq artefact models |
| `formal/coq/VerifierGasBudget.v` | **Bounded PLATFORM/native profiles only:** closed abstract model of bounded callback charging: every charge checks the callback and all ancestor budgets before mutation, exhaustion is atomic, and nested callbacks cannot escape an ancestor cap; inapplicable to `public` |
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
| `formal/coq/PluginLifecycle.v` | **Native profile only:** closed finite countermodel showing that a lifecycle ABI does not imply complete cleanup of arbitrary future-plugin storage, plus a conditional theorem for a certified cleanup function; custom V3 lifecycle claims remain runtime/artifact evidence |
| `formal/tla/SmartAccountAA.tla` (sibling: `verified/tla/`) | Finite state-machine exploration of Begin/success/failure/Tick transitions |
| `formal/tla/SmartAccountAA.cfg` | TLC bounds and safety invariants |
| `formal/smt/aa_core.smt2` (sibling: `verified/smt/`) | Nonce arithmetic, cursor advancement, rollback equalities, reimbursement cap and budget arithmetic |
| sibling `reports/sa-formal-20260918/README.md` | Human-readable result and boundary report |
| `formal/verify.py` | SA-local fail-closed runner with source pins and semantic mutations |
| `formal/Dockerfile`, `formal/verify-in-docker.sh` | Pinned Ubuntu 24.04 environment (Coq 8.18, Z3, OpenJDK, TLA+ tools jar pinned by SHA-256) so an independent reviewer runs the identical gate without a host toolchain |
| `formal/test_verify.py` | Runner/parser fail-closed regression tests |
| `formal/source-lock.json` | Reviewed source snapshot hashes; not a proof attestation |

#### Source-pin refresh after the rename and the headroom assertion

`formal/source-lock.json` currently pins 56 source files. The historical
rename refresh below pinned 59 source files. Thirty-five of those pins were
stale against the working tree and `formal/verify.py` failed closed at
`Source drift: Directory.Build.props` before running any Coq or TLC lane. The
pins were refreshed only after classifying every one of the 35:

- **31 files are rename-only.** Replacing `SmartAccount` /
  `UnifiedSmartWallet` / `abstract-account` with `SmartAccount` /
  `smart-account` in the previously pinned content reproduces the current file
  byte for byte, so the correspondence statements are unchanged.
- **`SmartAccount.Paymaster.cs` (retired custom kernel)** gains the 73-byte VM-integer
  headroom assertion (`vmMax` plus `budget.Reserved <= vmMax - settled`). That
  assertion is inside the helper the complete-context certificate models; the
  refinement lanes prove the guard succeeds on the legal domain
  (`legal_update_fits`, `vm_leb_margin_of_fits`), so the pinned correspondence
  still holds for the new text.
- **`SmartAccount.State.cs` (retired custom kernel)** changes only the
  `AccountImplementationId` string constant, no executable logic.
- **`formal/verify.py` and `scripts/verify_repo.sh`** carry the same rename plus
  mutation-table entries for the renamed models; the diff adds and removes no
  `require(...)` call, so no gate assertion was relaxed.

This refresh re-attests the manual correspondence snapshot against the reviewed
bytes. It discharges no open obligation and changes no proof: the public,
runtime, gas and ABI-refinement boundaries listed above remain open, and
`implementationVerified` stays false.

#### Witness-condition depth correspondence

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
`docs/reports/sa-neo-core-semantic-validation-20261006.json`; these tests
strengthen implementation evidence but do not replace the missing mechanized
full-semantics or compiler-refinement proof.

### Security boundaries

#### Verifier resource-boundary status

The private `PLATFORM` source branch and `contracts/bin/platform` core call verifiers
through `System.Contract.CallWithGasLimit`, with a 1,000,000,000-datoshi (10 GAS)
callback budget. Public `contracts/bin/public` uses standard `System.Contract.Call`:
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
receipts are `docs/reports/sa-platform-gas-cap-20260921.json` and
`docs/reports/sa-neoexpress-gas-cap-20260921.json`.

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
The native-side threshold-policy source guards and their bounded config/acceptance
model retired from the local gate on 2026-11-22: threshold policy ownership moved
out of the native kernel into the user-space `contracts/modules/ThresholdPolicyModule`,
so the native core no longer declares, stores or executes a threshold, a member set
or an approval count. The abstract `MultiSigPolicy.v` Coq model stays as
public/platform compile-and-mutation evidence only; the gate no longer asserts a
live native threshold-policy source link.

For the custom deployed public/PLATFORM profiles:

The cleanup model proves fail-closed state transitions, not recovery availability:
`finalizeEscape` still depends on successful cleanup by the old verifier and hook.
The 2026-10-08 source validates the replacement verifier before these callbacks, but
does not introduce emergency detach or guarantee progress past a malicious old module.
`CallVerifierChild` and its explicit `getChildVerifierConfig` capability are absent from the
deployed core manifest (`contracts/build/SmartAccount.manifest.json`) although they are
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
executable nonce has 191 channel bits, not 192. The current custom source
applies the same signed-VM bound to `getNonce` reads. A historical deployed
foundation artifact may still admit a wider, unsigned-192-bit query range until
it is republished; that does not make those upper-half channels executable and
is not native-profile conformance. The native codec rejects channels at or above
`2^191`.

The custom execution model scopes callback predicates to the configured
modules: an absent hook or verifier has no callback phase that can reject the
operation, while an installed module must return normally. This closes the
previously implicit `hookInstalled` state in the abstract model. Callback
noninterference, callback storage isolation and the correspondence from these
predicates to concrete NeoVM faults remain separate runtime obligations.

The SA core rejects negative and over-width values, while the VM itself limits
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
their receipt is `docs/reports/sa-neoexpress-native-integer-domain-20261006.json`.
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
`docs/reports/sa-neoexpress-native-envelope-20261006.json`. These are bounded
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

The pre-MultiSig-extension local SA runtime suite passed **257/257**. The separate
session-key regression proves clear-then-validate failure and the
`SessionKeyRevoked(accountId)` notification. Two independent `nccs` 3.9.1
compilations of the core and session-key profile are byte-identical; the
source/artifact hashes and explicit public-deployed-parity status are recorded in
`docs/reports/sa-protocol-security-build-20260918.json`. A read-only check of the known
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
container rerun, is `docs/reports/sa-formal-gate-20261006-native-envelope.json`.
The runner resolves a working Java runtime itself (an explicit `JAVA_BIN` is
honoured verbatim; otherwise `JAVA_HOME`, the macOS locator, the Homebrew
OpenJDK kegs and `PATH` are probed with `-version`, and the macOS launcher
stub is skipped), so the earlier `UNAVAILABLE` revalidation verdict caused by
that stub no longer reproduces on a machine with a JDK installed. An earlier
targeted private NeoExpress deployment of the post-remediation core,
MultiSigVerifier, and MultiHook matched each local NEF script and manifest over
RPC; see the historical
`docs/reports/sa-neoexpress-readback-20260920-current.json`. This is local-chain
readback only. The read-only public comparison found the known
canonical TestNet/MainNet artifacts differ from the current local artifact; deployment of the
current artifact remains a separate approval-gated operation.

A full private-chain validation on 2026-10-06 (`scripts/neoexpress_validate.py`, opt-in
through `scripts/verify_repo.sh --neoexpress`) deployed all 24 `contracts/bin/public` artifacts
plus the sibling `NeoDIDRegistry` artifact (25 deployments total) to a fresh single-node NeoExpress chain, drove
14 scenarios with 106 HALT and 2 FAULT persisted transactions (38 expected negative cases, including 36
preflight refusals), checked 84 on-chain
assertions, advanced 5,619,600 s of simulated block time, and read all 25 deployed
artifacts back over JSON-RPC with byte-identical NEF scripts, matching checksums and semantically equal
manifests. The DID artifact was separately compared byte-for-byte to its sibling build and
used in the proxy-witness scenario. The receipt is
`docs/reports/sa-neoexpress-validation-20261006.json`. The scenarios cover native
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
merchant pull needs a signer scope that reaches the verifier (see `docs/SECURITY.md`). The
latest receipt records the corrected implementation, including independently bounded verifier
and hook callbacks,
and remains local-chain evidence; it does not establish public deployment parity.

The automatic gate was retried on 2026-10-05 with the installed NeoExpress
3.10.1.18 runner. That incompatible attempt is retained as
`docs/reports/sa-neoexpress-validation-20261005-unmatched-runner.json`, but is
not release evidence: it lacks the bounded-call syscall and faults with
`KeyNotFoundException` for the `System.Contract.CallWithGasLimit` interop hash.
The full run was then repeated with the matching private NeoExpress
3.10.1.20+59ee6e2d43 build. It passed all 14 scenarios, and the
release-eligible receipt for that dated run was
`docs/reports/sa-neoexpress-validation-20261006.json`; the equivalent callback
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
are recorded in `docs/reports/sa-neoexpress-runner-provenance-20261006.json` and
`docs/reports/sa-neoexpress-validation-20261006-custom-did.json`.

A further parser-audit run used the same verified runner binary on a fresh
private chain: 25 deployments, 14 scenarios, 108 persisted transactions,
84 assertions, and 25 successful artifact readbacks. The hardened provenance
checker joined that run to the unchanged 76-file rebuild certificate and
validated all 38 local NEF frames. See
`docs/reports/sa-neoexpress-validation-20261006-parser-audit.json` and
`docs/reports/sa-private-artifact-provenance-20261006-parser-audit.json`.
The checker previously accepted nonzero reserved fields, extra bytes before
the checksum, and high-bit-masked magic bytes when a raw checksum matched.
Negative-first regressions now reject those cases; five matching cases also
fail in the actual Neo `NefFile` parser. This repairs an evidence-tool gap,
not an established deployed-contract exploit. The provenance suite passes
34/34 tests and the combined script suite passes 79/79. The full Neo core
suite was also rerun with 1,453 passes. Detailed scope and source hashes are
in `docs/reports/sa-parser-audit-20261006.json`.

The current SA solution test run passed **571/571** with the sibling artifact
supplied. In a standalone checkout it passes **569/571** and explicitly skips
the two DID cases; the two modes remain intentionally distinct.

The historical 2026-09-21 standalone checkout without the sibling `NeoDIDRegistry` artifact passed
**290/292** and records exactly the two cross-repository DID cases as explicit
skips; it does not count those cases as passes. The earlier 289/291 result is
historical, from before the zero-fee estimation regression test was added.

The historical 2026-09-21 source-to-artifact replay independently compiled the scratch tree
with the matching private compiler and compared **76/76** NEF/manifest files
byte-for-byte with `contracts/bin/public`; no artifact was missing or drifted. The
historical `contracts/build` tree remains an explicitly reported provenance
anchor rather than an expected match. See
`docs/reports/sa-artifact-reproducibility-20261006.json`.

That receipt now includes a source-to-artifact certificate over all **74** C# and
project inputs under `contracts/`, repository-relative source hashes, the `nccs`
version, the exact compile recipe, and fresh/release hashes for every artifact.
This is a practical provenance and rebuild-drift closure for the private artifact;
it is not a mechanized compiler-correctness theorem or a full NeoVM refinement proof.
The read-only join of that certificate to the private NeoExpress deployment and
JSON-RPC readback is recorded in
`docs/reports/sa-private-artifact-provenance-20261006.json`; the same join is now
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

The two SA-to-DID cross-contract cases require the sibling `NeoDIDRegistry`
build artifact. They passed in the current gated run with
`NEOOS_REQUIRE_SERVICES_ARTIFACTS=1` and a matching
`NEOOS_SERVICES_CONTRACT_BUILD` directory. A standalone checkout without that
artifact correctly reports those two cases as skipped rather than passing
them; the current receipts record both modes.

The public parity state is stronger than an unverified label: read-only RPC
readback of the known canonical TestNet and MainNet hashes returned different
NEF scripts from the current local artifact. The current artifact was not
publicly deployed and no signing or broadcast was attempted. This is recorded
in `docs/reports/sa-public-readback-20260920.json`.

The prior **272/272** NeoExpress receipt remains at
`docs/reports/sa-neoexpress-readback-20260919.json` as historical evidence only.

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

The earlier lifecycle host snapshot is recorded in
`docs/reports/sa-formal-gate-20261006-native-lifecycle.json`: 18 modules,
223 closed declarations, 105 rejected semantic mutations, 61,460 distinct TLC
states, six SMT obligations and six controls; the runner has 42 passing tests.
At that checkpoint the pinned container image was unavailable on the accessible
daemon, so the dated snapshot had no container PASS. The current container
receipt in Status includes this model; earlier receipts remain historical.

`docs/reports/sa-neoexpress-native-state-20261006.json` records eight private
state-initializer/serialization round trips. They used a node with no native
SmartAccount contract and persisted no application transactions; this
is state-codec compatibility evidence, not lifecycle execution evidence.

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

The dated native-dispatch host receipt is
`docs/reports/sa-formal-gate-20261006-native-dispatch.json`: 19 modules,
236 closed declarations, 112 rejected semantic mutations, 61,460 distinct TLC
states and 43 passing runner tests. Its pinned-container rerun was unavailable
at that checkpoint; the current container receipt in Status includes this
model without promoting older evidence.

`docs/reports/sa-neoexpress-native-activation-20261006.json` records a private
Verification-trigger regression: the historical runtime accepted a bounded
syscall despite a future activation height, while the corrected runtime rejects
it. Missing activation rejects it and explicit activation permits it. A small
ordinary diagnostic contract was deployed and its script/manifest read back;
this is not activation of native SmartAccount or a chain invocation of the
new internal native-dispatch helper.

##### Reproducing the private activation regression

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

#### Native invocation authority boundaries

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
`docs/reports/sa-neoexpress-activation-after-context-20261006.json` only reruns
the bounded-call activation regression with the updated runtime assemblies; it
must not be interpreted as a native invocation-context lifecycle test.

### Appendix: Custom implementation refinement

The former standalone refinement document is merged here verbatim as this
appendix; its acceptance conditions govern the implementation gate referenced
above.

#### Acceptance objective

The target is the custom `SmartAccount` source and its exact compiled
NEF/manifest, including all public entrypoints and their reachable helpers. The
required result is semantic preservation from typed C# operations to decoded
NeoVM execution, followed by preservation of the protocol properties already
proved in the custom models. A passing handwritten model, matching hash,
compiler build, trace sample or differential test cannot supply that theorem.

The existing custom candidate acceptance remains valid for its documented
scope. Full implementation refinement remains unverified until the requirements
below have independently checked certificates. No production contract behavior,
compiler pin, public deployment or original user changes are modified to make a
proof gate pass.

#### Proof architecture

1. **Concrete inputs.** Decode the actual NEF container and manifest; retain the
   original bytes, checksum, tokens, every instruction boundary and ABI offset.
   Parse the selected C# compilation with its exact types, references, constants
   and conditional symbols. Source locations and compiler debug data are hints
   for locating obligations, not proof that a translation is correct.
2. **Source semantics.** Give each supported typed operation executable formal
   semantics. Specify evaluation order, checked and unchecked integer behavior,
   `BigInteger`, nulls, references, aliasing, arrays, exceptions and calls.
   Reject unrecognized operations rather than translating them to an unconstrained
   value or a no-op. Native/framework calls need explicit effect contracts.
   The source dialect must be fixed before checking the target. In particular,
   CLR `BigInteger` arithmetic is unbounded while NeoVM integers have a signed
   32-byte limit. A preservation theorem over a restricted input domain must
   state that domain and separately prove that real entry guards establish it.
   String encoding/length and CLR versus VM exception behavior also require
   explicit semantics; target behavior cannot redefine the source after the fact.
3. **Target semantics.** Interpret concrete decoded instruction operands,
   stack values, locals, statics, control flow and call frames. State the limits
   imposed by the selected NeoVM, including integer width, stack depth and gas.
   Faults, notifications, storage and external calls are observable behavior.
4. **Translation certificates.** Prove a simulation relation between the source
   and target states. Straight-line expression certificates are useful only for
   their exact region. Whole methods require every branch and reachable helper;
   loops require inductive invariants and termination or divergence treatment,
   not a finite unrolling reported as a universal proof.
5. **ApplicationEngine boundary.** Relate syscall/native-call specifications to
   the pinned runtime implementation. Witnesses, storage serialization, nested
   calls, reentrancy, gas exhaustion and transaction rollback cannot be replaced
   by unconditional-success assumptions. Cryptographic assumptions and host
   services must be stated explicitly in the trusted computing base.
6. **Composition and coverage.** A public method is verified only when its
   certificate, dependencies and environment obligations are all discharged.
   All manifest entries, initialization paths and reachable instructions must be
   accounted for before `implementationVerified` can become true.

Artifact-specific translation validation avoids requiring a theorem for every
program accepted by NCCS. It still requires checked semantics and certificates
for the complete selected artifact. This follows the semantic-preservation
distinction in the [CompCert manual](https://compcert.org/man/manual001.html)
and its [research objectives](https://compcert.org/research.html). The concrete
target is the pinned [NeoVM implementation](https://github.com/neo-project/neo-vm),
not an unrelated stack-machine model with similar opcode names.

#### Layered proof lanes

The reimbursement work separates the following evidence. A certificate in one
row does not discharge the obligations in another; shared imported declarations
must not be added together as if each receipt contained disjoint proofs.

| Lane | Checked statement and boundary |
| --- | --- |
| Protocol models | `formal/verify.py` checks the declared custom/native abstractions. Its model receipts do not establish source-to-NEF refinement. |
| Arithmetic region | `prove.py` binds the original charge instructions to signed-256 reference arithmetic and `CustomSponsorship.charge`. Its scope remains the local region. |
| `Numeric coercions` | Models GetInteger decoding and its value relation, including Boolean and ByteString. This does not prove ABI admission or actual runtime correspondence. |
| `Reservation arithmetic` | Adds positivity, representable reservation updates and protocol fee bounds. It records the zero-fee overflow disagreement with unbounded arithmetic. |
| `Complete helper reference refinement` | Compares the complete typed-source projection with a byte-decoding reference VM for `CapReimbursementToActualCost`, under declared input and environment contracts. It does not certify ApplicationEngine or public entrypoints. |

The `source projection` records which typed
operations and semantic metadata are interpreted. The
`method inventory` accounts for all helper
instructions and separate static initialization; structural coverage alone is
not semantic proof. The `runtime checks` execute
the original helper in the pinned engine and distinguish valid inputs,
malformed records, pending storage and enclosing transaction rollback. Those
checks provide finite runtime evidence, independently of universal reference
theorems.

#### Neo contract dialect and object identity

The complete-helper source interpretation is a declared **Neo framework
contract dialect**, not an interpreter for arbitrary CLR object execution.
ByteString and UInt256 represent immutable byte values; hash equality in this
interpretation compares their contents. Arrays/Structs that hold the mutable
reservation record retain heap identity and aliases, so a write through a stack
reference updates the object still held by a local. Serialization observes that
object, while deserialization constructs a fresh object from stored contents.
These are distinct identity rules, not one blanket value-copy rule.

A CLR reference comparison between separately allocated objects does not
automatically satisfy the byte-value equality contract. Exporting an operation's
type or symbol also does not prove the compiler lowers it according to this
dialect. Framework/compiler correspondence, repeated GetScriptContainer reads
of the same transaction, static initialization and native codec behavior remain
named obligations. A receipt must retain them rather than present its dialect
theorem as preservation of general .NET behavior.

The [reimbursement policy](../SECURITY.md) requires one reservation ceiling
per transaction within each custom core. The helper reference theorem assumes
a stable 32-byte transaction hash, nonnegative signed-64-bit fees and either no
ledger or a well-formed two-field ledger with a 32-byte hash and nonnegative,
representable reservation. A chain-level composition must establish that
reachable persisted records satisfy this invariant and that equal hash bytes
identify the same transaction across calls. The policy does not itself prove
these codec and identity contracts. Malformed externally supplied storage must
not be treated as an admitted reachable state or silently repaired by a proof
oracle. The [native profile draft](../proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md)
sets `nativeSponsorship: false`; this custom reimbursement proof is not a
native sponsorship standard or activation claim.

#### Evidence and error behavior

The refinement gate must distinguish input inventory, structural validation,
bounded execution, universal semantic proof and full implementation acceptance.
It records exact source, NEF, manifest, semantic model, certificate and tool
identities. Proof outputs must come from actual proof-kernel invocations and have
no admitted declarations or unexplained axioms.

Malformed containers, noncanonical lengths, invalid ABI offsets, truncated
operands, unknown opcodes, invalid branch targets, missing source mappings,
unsupported typed operations, uncovered methods and stale certificates are
explicit errors or open proof obligations. None are silently skipped. A caller
requesting complete refinement receives a failing exit status while any required
obligation remains open; an inventory-only run cannot claim implementation GO.

Negative controls must change source or bytecode semantics while retaining
well-formed input: arithmetic operators and operands, comparison direction,
branch targets, witness guards, write ordering, return values and rollback.
Other controls cover deleted ABI entries, missing dependencies and mismatched
source/NEF pairs. Rejecting only invalid syntax or a changed hash is not evidence
that semantic certificates detect miscompilation.

#### Resource and maintenance requirements

Inventory decoding should be linear in the size of the artifact. Proof search
has explicit timeouts and preserves diagnostics on failure. Missing tools fail
closed. Generated proofs run in isolated temporary directories and never update
their own trusted expected result. New instructions or C# operations create new
obligations rather than automatically increasing proven coverage.

The existing `formal/verify.py` model gate and historical receipts remain a
separate evidence layer. New refinement work lives under `formal/refinement/`;
its report must state precisely which semantic links have been established.
There is no deployment migration for this verification tooling. A future
contract or compiler change requires new certificates against its new bytes.

#### Running the implementation gate

From the repository root, with the audited NCCS installation, .NET SDK and Rocq
available:

```sh
python3 formal/refinement/verify.py --output-dir /tmp/sa-refinement-evidence
```

The output directory must be new or empty. The runner rebuilds the exporter,
recompiles an isolated source copy with extended debug information, requires
byte-identical NEF output, exports the typed source and complete instruction/ABI
inventory, runs the proof kernel, and rechecks inputs after verification. The
compilation input set is checked before export, after export and after proof;
newly added source or build files fail the gate just as changed files do.
Proof templates are included in the verification-tool input hashes.
By default, the runner requests all four refinement proof lanes: arithmetic,
numeric coercions, reservation arithmetic and complete-helper reference
refinement. It retains `inventory.json`, `proof.json`, `numeric-proof.json`,
`reservation-proof.json`, `method-proof.json`, `method-inventory.json`, tool logs
and `result.json`. Each receipt has its own scope and exact input identities.
The dated integrated report `reports/sa-method-refinement-20261013.md` (not
included in this checkout) retains
the fresh final receipt and its per-lane input identities. It records which
lanes passed together; historical counts from separate runs cannot substitute
for that evidence.

Exit `0` means the requested scope passed; exit `1` means an input/tool/proof
failure; exit `2` means the requested partial proofs passed but complete
implementation refinement is still open. `--allow-partial` accepts that declared
partial scope with exit `0`, while the report still records
`implementationVerified: false` and all unproved public entrypoints. It must not
be used as the complete-refinement release command.

To reproduce only the earlier arithmetic-region scope, use a separate empty
directory and opt in explicitly:

```sh
python3 formal/refinement/verify.py --arithmetic-only --allow-partial \
  --output-dir /tmp/sa-refinement-arithmetic-evidence
```

This compatibility command omits the three newer proof lanes. It cannot stand
in for the default gate. Missing tools, unsupported source operations or failed
proofs fail closed in either mode; `--allow-partial` does not bypass them.

## SA contracts: reproducible build from published packages

Package baseline established on 2026-10-04 (audit finding R-11 / N-DEP-1, program item P1-C-AAV4-BUILD). Every package the SA
contracts and their tests restore is published on nuget.org, and the toolchain is pinned so that a second
builder gets the same NEF and manifest bytes.

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

`SmartAccount.sln` is the native build entry: it carries the native core overlay
(`contracts/native/Neo.csproj`), the six native-profile modules, the native unit tests
and the probe hosts, and no custom project. Building it needs a reviewed core checkout;
set `NEOOS_NATIVE_CORE_SOURCE` to it (default sibling `../neo-native-core`).

`./scripts/verify_repo.sh --contracts-only` runs the native build and unit-test lane; MSBuild
writes the kernel into each project's `bin/Release/net10.0/`. To prove a clean restore, point
`NUGET_PACKAGES` at an empty directory first.

#### Select the validation profile

`./scripts/verify_repo.sh --profile native` is the default and the only
profile. It runs the native
package locks, protocol and runner guards, the native-only solution build and unit
tests, the native module epoch VM regression and native browser coverage, and reads
nothing from the retired custom tree. `--contracts-only`, `--frontend-only` and
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

### Reproduce

#### Native build outputs

The native kernel is the only build target. `dotnet build SmartAccount.sln` compiles the overlay core
(`contracts/native/SmartAccount/`) against the pinned core checkout, and
`scripts/build_native_modules.py` reproduces the six `SMARTACCOUNT_NATIVE` modules in two independent
scratch trees under the locked restore policy and writes them to the `--output` directory its caller
names. `scripts/native_epoch_probe.py` runs those artifacts in the public VM and writes a receipt to its
own `--output`. Neither script has a default directory, and `contracts/bin/native` is not a target.

The retired custom track's `public` and `platform` profiles (`contracts/bin/public`,
`contracts/bin/platform`) are archived artifacts and were never tracked: `bin/` is gitignored, so a
clean checkout has neither. Their `compile.sh` recipe and the user-contract
projects it built were removed when the repository went native-only; the digests recorded for them
below stay as historical receipts, nothing in the tree rebuilds them, and
`scripts/check-artifact-reproducibility.mjs` refuses to replay the deleted recipe. Do not deploy those
artifacts and do not treat their recorded bytes as current native evidence.

For the record, the retired public profile used published `System.Contract.Call` with read-only
validation and write-capable `postCheck` accounting, and it did not bound verifier gas; the retired
private `PLATFORM` profile used `System.Contract.CallWithGasLimit`. Lifecycle ABI admission was never
a verifier trust or resource policy: public relays must still apply their own reviewed module policy,
simulation and finite transaction-fee limits before sponsorship, and unrestricted sponsored admission
remains unsafe. `contracts/build` remains the historical deployed-artifact fixture.

#### Public validator release selection

`scripts/deploy_latest_sa_validators.js` selects SessionKeyValidator from
`contracts/bin/public/validators/` and SocialRecoveryService from `contracts/bin/public/`
through the same constrained artifact-path helper as the other public deployment
scripts. It must fail if that reviewed public NEF/manifest pair is absent; it
must never fall back to historical `contracts/build` fixtures or a private/native
profile. The selected manifest must match the expected module name, version and
account-ID ABI. Deployment readback must match the selected NEF script and complete
manifest before the existing authorized-core binding check can succeed.

Rebuild and review the public artifact pair before release. Offline loader tests
exercise path selection and reject missing or mismatched pairs; they neither
broadcast a transaction nor establish public deployment parity.

#### Two-build comparison

The two-build replay that produced the certificates below used `contracts/compile.sh`, which was
deleted with the custom track. `scripts/check-artifact-reproducibility.mjs` therefore fails closed
instead of replaying a recipe the repository no longer contains; the recorded digests stay as
historical receipts. The native replacement is `scripts/build_native_modules.py`, which builds the six
`SMARTACCOUNT_NATIVE` modules in two independent scratch trees at different temporary paths and fails
unless every NEF and manifest digest matches:

```bash
python3 scripts/build_native_modules.py --contracts contracts \
  --compiler "$NCCS_BIN" --cache "$NUGET_PACKAGES" \
  --output <new-directory> --receipt <receipt.json>
```

It does not infer runtime compatibility from reproducibility alone. The paragraphs that follow record
the retired custom profile replays and their archived certificates.

The 2026-10-08 replay matched **80/80** files: **78** under `bin/public` and **2** under
`bin/platform`, with no drift or missing artifacts. Exact digests and the profile verdicts
for the native integration source are in
[`sa-native-abi2-public-platform-reproducibility-20261008.json`](../reports/sa-native-abi2-public-platform-reproducibility-20261008.json).
The current-source replay on 2026-10-31 again matched **80/80** files with the
same **78 + 2** profile split, no drift and no missing artifacts. Its certificate
is
[`sa-artifact-reproducibility-20261031.json`](../reports/sa-artifact-reproducibility-20261031.json);
the private-chain join is
[`sa-private-artifact-provenance-20261031.json`](../reports/sa-private-artifact-provenance-20261031.json).
The 2026-11-13 replay of the post-extraction tree (registrar move, market-escrow
and paymaster settlement splits, backup-owner-gated freeze surface) matched again with no
drift and no missing artifacts; its certificate — whose text-input digests are
LF-normalized so a Windows `core.autocrlf` checkout measures the same bytes as
Linux CI — is
[`sa-artifact-reproducibility-20261113.json`](../reports/sa-artifact-reproducibility-20261113.json),
and the candidate/public ABI delta it certifies is
[`sa-ordinary-candidate-compatibility-20261113.json`](../reports/sa-ordinary-candidate-compatibility-20261113.json).
The 2026-11-16 replay of the design-phase legacy-compat sweep (storage fallbacks,
the one-time rotation migration and the v3 recovery ticket removed; the candidate
ABI is now 109 methods) matched again with no drift and no missing artifacts; its
certificate is
[`sa-artifact-reproducibility-20261116.json`](../reports/sa-artifact-reproducibility-20261116.json),
regenerated the same day after the orphaned `tests/mocks/packages.PlatformRegistrarMock.lock.json`
left the tree (132 source inputs; the sweep commit's receipt had been generated one
`SmartAccount.MarketEscrow.cs` revision early, which the regeneration also corrects),
and the candidate/public ABI delta it certifies is
[`sa-ordinary-candidate-compatibility-20261116.json`](../reports/sa-ordinary-candidate-compatibility-20261116.json).
The 2026-11-20 replay of the v4 generation and subject-provenance revision (the
22-byte provenance marker beside the 21-byte subject row, custody-derived subject
rotation, and routing-generation resolution inside the core) matched again with no
drift and no missing artifacts: **66** artifacts compared, **64** under
`bin/public` and **2** under `bin/platform`, over **174** source inputs. The six
new mock contract/project/lock triplets under `tests/mocks` (GasBurningHook,
GasBurningValidator, MockDivisibleNep11Token, MockNep11Token, MockNep17Token,
MockNepPaymentReceiver) are inside the inventory by construction, because
`SOURCE_ROOTS` copies `tests/mocks` whole rather than by an explicit file list.
The certificate is
[`sa-artifact-reproducibility-20261120.json`](../reports/sa-artifact-reproducibility-20261120.json),
and the two core pairs it certifies are:

| Profile | `SmartAccount.nef` SHA-256 | `SmartAccount.manifest.json` SHA-256 |
| --- | --- | --- |
| `bin/public` | `27e28aa06068d0d9898a6dcf3d703d7561e05e2e12d4a8bd8202ae7abdc654e1` | `f0c6467b05004fdbedc0a9b8f6368ab29a30e84a6b38ece56219a6913282bd23` |
| `bin/platform` | `60f17dfd0a19b40076b0a72577ed29ea6d480e8bbe73b2a37dc207c08a1b4048` | `61900e8a80a8fc8cd3b3fb4698050f53e7dd18ee64da13bc4ab2f1cfc20cd55c` |

The same run's private-chain receipts are
[`sa-custom-source-chain-20261120.json`](../reports/sa-custom-source-chain-20261120.json)
(28/28 acceptance checks, nine artifacts deployed from the freshly compiled public
profile) and
[`sa-custom-runtime-provenance-20261120.json`](../reports/sa-custom-runtime-provenance-20261120.json)
(that receipt joined to the certificate above, source snapshot `164c58a3…`). They
are evidence for the sources and artifacts they name and not for a public-network
deployment: no chain writes are performed, and `tracked_tree_drift` still lists
`contracts/build` because that tree is deliberately pinned to the deployed mainnet
bytecode. An artifact identity refresh is not an acceptance event — it says what
the current sources build to.
The 2026-11-21 protocol-conformance replay (1-based credential generation, the
core-wide reentrancy exclusion, code-binding continuity after every writable
callback and at commit, and `NefSha256` as `SHA256(NEF)`) matched again with no
drift and no missing artifacts: **66** artifacts compared, **64** under
`bin/public` and **2** under `bin/platform`, over **174** source inputs, both
profiles reporting `matches_fresh_build: true`, and
`chain_writes_performed: false`. Its certificate is
[`sa-artifact-reproducibility-20261121.json`](../reports/sa-artifact-reproducibility-20261121.json),
and the two core pairs it certifies are:

| Profile | `SmartAccount.nef` SHA-256 | `SmartAccount.manifest.json` SHA-256 |
| --- | --- | --- |
| `bin/public` | `397f96ab1997dcd8aad6455a797a569dfff2789c4ffff4dbfcab4ff590d553bf` | `4939cf01fb812fff5fb83fc4edd71205041d9a91201390ff9f21716692c23470` |
| `bin/platform` | `7d5fad653060bbe6dca63bc14dc7be8097e138c46956c23c787cba2fe604fdd8` | `296a3ad498dd4a553e1aa91449817b6eab3b4814cf3c15fe3830fe004f6b7550` |

Both profiles moved in that replay: the `PLATFORM` profile compiles the same
custom sources, so it carries the same protocol changes. `contracts/build`
remains the deliberate deployed-mainnet anchor and is reported as such.
The joined NeoExpress receipt is bound to a reviewed source-runtime build
(`sourceRuntime`): its 104-file map, source-build receipt, `neoxp.dll` and
wrapper hashes are checked before and after the private run, with host paths
excluded from the receipt.
The NEF carries no
source path or URL, and the compiler string in its header is `Neo.Compiler.CSharp 3.9.1+5fa9566e...`, so the
bytes depend only on the sources, the pinned packages and the pinned compiler.

#### Native ABI 2 modules

The six `SMARTACCOUNT_NATIVE` modules are built and packaged separately by
`scripts/build_native_modules.py`. Their committed locks use the same published
Framework 3.10.1, and each packaged manifest requires the native ABI 2 authority
service. Two clean builds matched all six NEFs, six packaged manifests and the
packaging certificate; the current input/output maps are in
[`sa-native-abi2-module-build-20261008.json`](../reports/sa-native-abi2-module-build-20261008.json).
The receipt identifies both original sources and the explicit native preprocessing
recipe. These modules require SmartAccount and are not `public` artifacts.

The native node/NeoExpress runtime has a separate source build and private-chain
gate, documented in [native validation](../proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.md).
Module reproducibility and the test-only public-VM module-lifecycle probe do not establish
native-chain behavior or public activation.

Historical reference digests before the 2026-10-08 consolidation (SHA-256; these are not pins for the
current source, and a fresh reproduction report is required after every contract or pin change):

| Profile / artifact | SHA-256 |
| --- | --- |
| `v3/SmartAccountV3.nef` | `63d33c11d9fe89d7386ec3d96d8a8e79680be432d7ccd01ee17e704e8cced245` |
| `v3/SmartAccountV3.manifest.json` | `b72317b021775187f55ed7851cdc268a63b3598153235cf02df3307007fd1546` |
| `platform/SmartAccountV3.nef` | `088f9157bb1c5f1217d29e49f6177f9da5a370fa671941da2c6bb216959bbc94` |
| `platform/SmartAccountV3.manifest.json` | `9db29a5f9c3d2b38e16daa61a1ea9bbee3227d5cbf81026e23ce88d81420c44d` |

`docs/reports/sa-published-build-reproducibility-20261004.json` lists the 76 files written by the 2026-10-04 build
(24 contracts; the verifiers and hooks are written twice). Two clean exports at paths of 118 and 165
characters, each with an empty NuGet cache, produced identical bytes and no warnings.

### What the bytes are, and are not

- The historical 2026-10-04 artifacts were byte-identical to what the private framework build (`3.10.2-CI00384`) produced from the source as it
  was before the syscall declaration moved into the contract, for all 24 contracts, so contract behaviour and
  ABI did not change when the pin moved.
- They are **not** the bytes deployed on MainNet or TestNet. Those cores were compiled from older source,
  before the verifier gas cap and later changes, so the current NEF differs from the deployed one.
  Deployed-versus-source evidence for the SA core is a separate task.
- The historical 2026-10-04 core emitted `SYSCALL System.Contract.CallWithGasLimit`. Only the private
  PLATFORM profile now emits it; the public profile's four callback tests run without a skip guard.
- 3.10.1 is the pinned published framework. The historical comparison found that 3.10.0 gives the same bytes. 3.9.1 and older bind
  `ContractManagement.Update` to the two-argument native overload instead of the three-argument one (a
  different method token and one byte less code), so every later method offset shifts and the build differs.

### Neo platform packages and the verifier gas syscall (R-11 / N-DEP-1)

Status on 2026-10-08: the public contract profile and its tests use pinned packages
published on nuget.org. Public verifier execution and private callback gas isolation are
separate profiles, with separate artifact directories and evidence
(the preceding sections of this document).

#### Historical private-runtime revalidation (2026-10-06)

The installed public `neoxp` runner remains incompatible with the SmartAccount
artifact: a fresh run faults when the VM resolves the
`System.Contract.CallWithGasLimit` interop hash. This is a runner/runtime
mismatch, not evidence that the callback cap is optional, and the failed receipt
is retained separately from release evidence at
`docs/reports/sa-neoexpress-validation-20261006-v2.json`.

An independent local NeoExpress build linked to the matching private Neo runtime
packages was then run against that snapshot of the artifacts. It deployed 25 contracts,
completed all 14 scenarios with no skipped scenario, persisted 108 transactions,
and read back all 25 NEF/manifest pairs. The receipt for that historical snapshot is
`docs/reports/sa-neoexpress-validation-20261006-custom-did.json`; runner source,
package hashes, and the temporary API-adapter boundary are recorded in
`docs/reports/sa-neoexpress-runner-provenance-20261006.json`.

This closes the private NeoExpress execution/readback evidence for the matching
runtime. It does not alter the separate owner action for making the private
packages reproducibly available to clean CI, and it does not establish public
network activation or deployment parity.

Historical status on 2026-09-28: **known red, owner action required.** A clean CI runner cannot restore
the packages that `contracts/Directory.Build.props` pins, so the contract build, the contract
tests and the deploy-tool tests do not run in CI. The `Check pinned Neo platform packages`
step in `.github/workflows/ci.yml` (and the first contract gate in `scripts/verify_repo.sh`)
runs `scripts/check_neo_platform_packages.mjs`, which stops within seconds with the owner
action below instead of a bare `NU1102` from deep inside the build.

#### Runtime profiles

| Profile | Artifact directory | Verifier callback | Runtime requirement |
| --- | --- | --- | --- |
| `public` | `contracts/bin/public` | Standard `System.Contract.Call`; validation is read-only and post-execution accounting retains write access | Published Neo runtime; no isolated verifier child gas budget |
| Native ABI 2 | Explicit native-module build output | SmartAccount bounded native callbacks: verifier 1 GAS, hook/maintenance 2.5 GAS | Source-built native contract, `HF_SmartAccountV1`, ABI 2 metadata and epoch-aware modules |
| Private `PLATFORM` | `contracts/bin/platform` | `System.Contract.CallWithGasLimit`, 10 GAS per verifier callback | Matching private runtime and activation; cannot run on an ordinary public node |

`scripts/build_native_modules.py` reproduces the native modules from the pinned published compiler and
framework under the repository locked restore policy and writes them to the `--output` directory its
caller names; the native kernel itself is compiled by `dotnet build SmartAccount.sln` against the
pinned core checkout, and MSBuild writes it to each project's `bin/Release/net10.0/`. No script targets
`contracts/bin/native`. The two retired custom rows above remain in the table because their recorded
bytes are historical receipts: their `compile.sh` recipe is gone, the directories they name are
gitignored build output, so a clean checkout has neither, and byte identity alone never established
runtime support or deployment parity.

For private NeoExpress validation, `scripts/neoexpress_validate.py` deploys the core from
`bin/platform` and the modules from `bin/public`, and records the profile of every deployment.
The provenance join independently selects the same profile; a public-core receipt cannot be
joined to bounded-callback evidence. Set `NEOOS_NEOXP` to a source-built runner that registers
`System.Contract.CallWithGasLimit` under `HF_SmartAccountV1`; an ordinary published `neoxp`
does not satisfy this runtime requirement.

For release-grade runner provenance, pass
`--runtime-build-receipt <PASS-runner-build.json> --runtime-dir <complete-runtime-dir>`.
The validator invokes `dotnet <runtime-dir>/neoxp.dll`, verifies the receipt's complete
runtime file map before and after the chain run, and records only the build-receipt,
`neoxp.dll`, runtime-file-count and wrapper hashes in the NeoExpress receipt. No host
path is written to the evidence.

Native modules are built separately by `scripts/build_native_modules.py`. Its
six projects obey the same root `Directory.Build.props`, `nuget.config` and
reviewed per-project locks; a missing or changed lock is a build failure. The
packager requires the `native-v4` marker, the v4 lifecycle ABI
(`getModuleProfile` plus `onInstall`/`configure`/`onUninstall`), the exact native
service permission allowlist and the NEF checksum. A module's capabilities come
from its own `getModuleProfile()` answer, which the core re-hashes at install
time, so packaging never grafts an `extra.smartAccount` declaration onto the
compiler manifest. Protocol v4 replaced composite verifiers with the core
threshold policy, so the descriptor keeps `compositeVerifier`/`compositeProfile`
only to reject a non-empty value instead of silently reinterpreting an old one.
It records original/prepared sources and both
raw/packaged artifact bytes, then compares two independent scratch builds.
Run `node scripts/check_neo_platform_packages.mjs` before building: its default native
scope covers the six modules, the epoch probe and its ABI fixture, and the two source-runtime
probe hosts (`--include-custom` adds the retired custom tree). The runtime hosts use no NuGet packages: their
committed locks must contain an empty net10.0 dependency graph, and their Neo
assemblies must come from an explicitly validated source-built runtime. Native
runner provenance must independently pin the
reviewed core and node/RPC sources; public compile success does not establish
native activation or fee-estimation compatibility.

The four verifier-path tests
(`ExecuteUserOp_VerifierPath_AcceptsValidSessionSignatureWithoutOwnerWitness`,
`ExecuteUserOp_VerifierPath_RejectsTamperedSessionSignature`,
`ExecuteUserOp_RecoveryVerifier_EnforcesOwnerAndCoreContext`, and
`ExecuteUserOp_ActiveEscape_OnlyBackupOwnerWitnessMayExecute`) run on the published
TestEngine without a private-syscall skip. `CompiledCoreSyscallTests` checks the actual
NEFs: the public core excludes the private syscall, and the separate `PLATFORM` core
retains both bounded verifier callbacks. `tests/localchain/test_public_profile.py`
exercises a public verifier-signed operation on disposable published NeoExpress.

The private profile declares the syscall with `[Syscall]` because the pinned published
framework does not expose it. This makes it compile, not execute on a runtime lacking the
interop. The historical private Neo 3.10.1.1 build below registers it behind `HF_Iara`.
Historical gas-cap receipts apply only to their exact private runtime/source/artifact
snapshot. The abstract `VerifierGasBudget.v` obligations apply only to bounded `PLATFORM` and native callbacks; the public profile has
no such child budget and public arbitrary-module sponsorship remains a separate resource
and admission-policy concern. Public activation is a platform decision.

#### Historical public deployment observation

The deployed SA cores do not depend on any of this. Public JSON-RPC reads on 2026-09-28:

| Network | SA core | NEF checksum | Compiler | `CallWithGasLimit` syscall |
| --- | --- | --- | --- | --- |
| MainNet | `0x0268a387913b250166ddec032b03332690a1ef78` | 2035992441 | Neo.Compiler.CSharp 3.9.1 | absent |
| TestNet | `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2` | 2785794149 | Neo.Compiler.CSharp 3.9.1 | absent |

The MainNet core is reproducible from public packages: compiling commit `4149496` (the source before
the gas cap) with the public framework 3.9.1 and `nccs` 3.9.1 from a clean cache gives
`SmartAccountV3.nef` with checksum 2035992441, byte-identical to the chain and to
`contracts/build/SmartAccount.nef`. The current source has additional contract changes and separate runtime profiles;
current public deployment parity requires a fresh source/artifact/RPC comparison.

#### Historical private packages

The following archives were used for the 2026-09-21 private gas-cap validation. They are
not required for the public verifier tests or for compiling either current profile. A
private runtime is required to execute `PLATFORM` callbacks; these archive hashes describe
the historical test environment, not a new runtime release. Nothing in the default
`nuget.config` or CI selects these archives. Their audited bytes:

| Package | Version | SHA-256 of the `.nupkg` | Public? |
| --- | --- | --- | --- |
| Neo.SmartContract.Framework | 3.10.2-CI00384 | `172597b180f6ae9d93c1901bec11d8f2ce76b46c465a2dd3552ae876e5421d65` | no |
| Neo.SmartContract.Testing | 3.10.2-CI00384 | `92a06b27548c10da98c54043ff4dfd5eaf6c1b74df4fc707b6e7cc67c7b9ce6a` | no |
| Neo.Disassembler.CSharp | 3.10.2-CI00384 | `9ee27bb5b372bba07ef0872ca22ab4700be0c3dc87deb5cbc1ada9a895901f21` | no |
| Neo | 3.10.1.1 | `4218a38a767d8c9c0d8bfbd6cc91c9bd13f9d298c816dd72366a3f3735960d49` | no |
| Neo.Extensions | 3.10.1.1 | `93e296fe0773db0ddaeb4f0a9d9174555f65ae17560497e72e8f4a692ffe500d` | no |
| Neo.IO | 3.10.1.1 | `b1bba7f6aad5275f05ac13f4356c56caaac5866318ef87b30cd14d8ed3a2dcf7` | no |
| Neo.Json | 3.10.1.1 | `0275990e41fe6fb6163183ceb5b151a62a16219294852569d1b85a8ef7f4fa63` | no |
| Neo.VM | 3.10.2-CI00384 | `84bd08d291362cfaf85697f0fb14666719d3443f2f71c39c8de1b9184c20820e` | upstream nightly on the Neo MyGet feed |

The framework and testing hashes equal the ones in `docs/reports/sa-platform-gas-cap-20260921.json`.
Compared with the published 3.10.1 framework, the private one adds `Contract.CallWithGasLimit`, lacks
`AccessControl` and `Ownable2Step`, and otherwise differs only in comments and in the error path of
`Nep11Token.Burn` (compared on 2026-10-04).

The 2026-10-04 provenance review found that the nuspecs named
`neo-project/neo-devpack-dotnet@34255c4` and `neo-project/neo@8461a72`, while neither
commit contained `CallWithGasLimit`; the tested changes had been applied on top of those
commits. Those historical archive labels therefore do not attest the complete source.
Preserve their exact bytes when retaining the historical receipts. Any new private
runtime release must identify its complete committed source, reproducible package hashes,
activation configuration and runtime tests; do not reuse these hashes for rebuilt archives.

### How to bump

1. Change `NeoSmartContractFrameworkVersion` in `Directory.Build.props`, or another package version in
   `tests/SmartAccount.Contracts.Tests/SmartAccount.Contracts.Tests.csproj`.
2. Update every lock file: `for p in $(find contracts tests -name '*.csproj'); do dotnet restore "$p" --force-evaluate; done`.
   Locked mode refuses this without `--force-evaluate`, and CI never passes it.
3. Run `node scripts/check_neo_platform_packages.mjs`. It lists each Neo package whose content hash differs
   from the audited one and any Neo package the manifest does not know. Put the id, version and content
   hash (the one in `packages.lock.json`) into `contracts/neo-platform-packages.json`, with the SHA-256 of the
   `.nupkg` from the global packages folder, and set `frameworkVersion`.
4. Compile with the pinned compiler and compare the digests with the previous ones. If the bytes change,
   say so in the change and replace the receipt in `docs/reports/`.
5. To change the compiler, edit the `nccs` version in `ci.yml` and the `compiler` entry in the manifest:
   `sha256` of the installed `.nupkg`, `sha512` from the `contentHash` in its `.nupkg.metadata`.

A Dependabot NuGet pull request that changes a version without regenerating the lock files (and, for a Neo
package, the manifest) fails the gate; apply steps 2 and 3 to its branch.

Native private-chain consumers verify the packaged profile certificate against
current profile parameter bytes and their canonical digest, the descriptor and
the packaging recipe. They also validate each packaged module's exact capability
metadata and lifecycle ABI against that descriptor. Matching artifact hashes
alone do not admit an older native ABI 2 profile.


### Frozen native composite profile (2026-10-09)

The final build/proof checkpoint binds profile
`4201b02f571b7415121467d67343a8189b8070ad795a82424c0403782d22b1b4`
to the core/node/Express commits and complete source maps in
[`sa-native-composite-final-build-proof-20261009.json`](../reports/sa-native-composite-final-build-proof-20261009.json).
Two independently copied source trees produced identical 104-file runtimes,
50 dependency archives and lock maps. The six native modules independently
reproduced their 12 NEF/manifest files and packaging certificate. The consumer
revalidated current parameter bytes, profile digest, descriptor, recipes,
capability metadata and lifecycle ABI against all 13 packaged files.

The custom `public` and `PLATFORM` outputs remain byte-identical across all 80
artifacts. The final public runtime regression passed 396 tests with no skips;
the required external NeoDID artifact was supplied. The earlier
`sa-native-abi2-runner-build-20261009.json` and
`sa-native-abi2-rpc-runtime-20261009.json` describe intermediate source snapshots
and are not the final composite build. Private-chain/SDK receipts establish
integration behavior separately; these build results do not establish activation
on a public network or compiler correctness.

## Integrated refinement closure gate

This is a fresh orchestration and identity join of scoped proofs. It does not
authenticate full protocol closure merely because several kernels accepted
their models. All public entries retain open runtime/frontend/composition
obligations; body and private-helper certificates stay separate.

The default command builds a fresh inventory with the existing four-lane
verifier, then runs the additional scoped provers and their negative controls.
The current gate selects twenty-two separate scopes. Missing receipts, wrong
scopes, mixed NEF/helper identities, source/model drift
and incomplete controls fail closed. Independent proof lanes run at most two
at a time. Each invocation retains its command, log and receipt.

```sh
python3 formal/refinement/closure.py \
  --output-dir /tmp/aa-integrated-closure-fresh \
  --timeout-seconds 5400 \
  --helper-gas-runtime-receipts /path/to/reviewed-five-shape-receipts
```

Exit `2` means the selected scoped checks passed but full implementation
refinement is still `NO-GO`. Exit `1` means a selected check failed, evidence was
missing or identities drifted. `--allow-partial` changes exit `2` to `0` while
preserving `status:NO-GO`, `implementationVerified:false`, an empty
`verifiedEntrypoints` and the complete public-entrypoint unproved count. It never
relaxes a selected proof, identity join or negative control.

The budgets above are sized for a shared host, not for a fast one. The kernel
limits inside `context_proofs.py` and `composition_proofs.py` are one module
constant each (`KERNEL_TIMEOUT = 3600`); the old values were 1800 and 600, and on
2026-10-20 a run at load average 136 lost `context` at 1800.08s and `composition`
at 649.7s before a single scoped check disagreed. In the passing run those two
jobs took 2292s and 1198s. A timeout here is an environment fault that fails
closed — it is never evidence about the contract, and raising the bound does not
weaken the check, because the kernel still has to accept the proof.

Every successful run also publishes a `frontendCorrespondence` block in
`result.json`. It is recomputed from the pinned C# the lanes just downloaded,
under `*/source`, and it compares the shared tokenizer and body slicer against a
second reader that shares no code with them: normalized text, token sequences
and per-method bodies. Agreement does not claim the grammar is proven and does
not move `implementationVerified` — it measures a corpus and names it. A
disagreement fails the run, and an empty corpus is refused rather than reported
as agreement. A fifth face compares the same corpus against Microsoft's C#
lexer, which the exporter already carries: the whole-file joins may differ (they
are recorded, with offsets), but every fragment a lane locates must survive the
lexer's view, and a receipt with no lexer face counts as no agreement at all. A
sixth face judges the judge: a strict reader — interpolation holes read as one
token, `#if` conditions evaluated rather than dropped — has to reproduce the
lexer's join on every file before whole-file divergences may be recorded at all,
no uniquely located anchor may move under it, and the set of files where the
front end differs is a frozen constant (`KNOWN_FRONT_END_GAPS`) so that a new
defect cannot arrive silently and a fixed one has to be retired on purpose. That
list is now **empty**: the lanes share one scanner instead of a regular
expression per module, so the interpolation hole is read the way the compiler
reads it, and the front end reproduces the lexer on every file in the corpus. A
divergence that lands in a file some lane slices a method body out of fails the
run outright: the body is what the fields are read from, and `slicedGaps` is
recomputed from the lane modules rather than remembered. A seventh face drops the
ten-character floor the anchor face needs: a field is read with
`needle in text` or `text.count(needle) == 1`, and the needle is often shorter
than that, so every non-empty literal in the lane modules' projection functions is
put to both readers — accepted the same way, joined the same way, and found the
same number of times in each corpus file. An empty needle face is refused rather
than reported as agreement.
See [HANDOFF-RECORDS.md](HANDOFF-RECORDS.md).

The same run also publishes an `abiDispatch` block, which is about bytes rather
than text. A second mode of the exporter deploys the pinned NEF into a real
`ApplicationEngine` — Neo 3.9.1, the assemblies the compiler ships — calls every
ABI method by name with the arity the manifest declares, and single-steps the
call. The receipt keeps, per method, the offset the engine entered, whether the
declared entry point was executed, the final state and fault, the syscall
sequence, and the shape of the value the call left on the stack. The gate requires
all 109 entries to be measured against the same manifest the inventory trusts, 107
of them to dispatch onto their declared offset, `_deploy` and `_initialize` to be
refused when called by name, and every completed call to have been judged against
the declared return type — one result of the mapped stack type, with the exact
width for `Hash160`/`Hash256`/`PublicKey`/`Signature`, and nothing left behind by
a fault. A null return satisfies a declared reference type and is counted apart,
because the manifest has no nullability and a null applies no rule; a null where a
value type is declared is a failure. Ten mutations of the dump have to be caught on
every run, so a receipt of zero problems cannot come from a face that compares
nothing; an engine error, a step-limit trip, an unresolvable syscall, a
wrong-shaped result or a dump bound to another manifest fails the run.

That block also carries the other half of the dispatch rule: 408 probes of calls
the manifest does not describe, and the gate requires the probe *set* to be the one
the manifest implies — every method's parameter count minus one and plus one,
minus the counts a sibling overload declares, plus one shape probe per non-`Any`
first parameter, plus one undeclared name. A probe that is missing, duplicated or
relabelled fails. Each arity probe has to be refused with the engine's own message
(`Method "…" with N parameter(s) doesn't exist in the contract`) and to have
entered no callee frame at all; the two counts `finalizeEscape` declares have to
land on the two different offsets, which is what makes "name and arity select" a
measurement; a refusal whose text is the callee's rather than the boundary's fails.
A wrong-shaped argument is the one thing the gate does *not* require to be refused,
because it is not: 94 of them enter the callee on this engine, 87 fail there and 7
answer, so the receipt carries `shapeEnforcedAtBoundary: false` and the gate reads
it as a measurement instead of failing a correct artifact for a rule the engine
never had. Seven mutations of the probes have to be caught on every run.

It also publishes a `dispatchFootprint` block, which is the layer under the
dispatch. Landing on the right offset says nothing about the body that runs there,
so the same dump now carries, per method, the set of instruction offsets the engine
executed inside the contract, the script bytes, and the script hash of each frame
depth. A second reader decodes those bytes with the repository's own independent
decoder and confronts the result with `entrypoint_inventory`'s static model:
executed offsets have to be instruction starts of that script, every one of them has
to fall in exactly one byte range of an inventory that partitions the script, and
the byte methods entered have to be among the ones that entry's dependency graph
reaches. The last one is the direction that must hold. Reachability is a may-set, so
the members it lists and a zero-argument call never enters are counted and printed —
634 of 996 on this artifact — and are never read as disagreement. Eight mutations,
on both the measurement and the model, have to be caught on every run; one that
cannot be built is recorded as skipped and fails the run rather than shrinking the
self test. The face compares no values, so it says nothing about the 67 methods that
fault on zero arguments.

An `abiScenario` block is the layer under that one, and the only one so far that
sends values. `formal/refinement/scenarios/aa-account-roundtrip.json` declares 29
calls — literal arguments, named signers, the ending each call expects, and which
earlier argument a result must equal — and the exporter runs them in order over one
deployment. The gate requires: the scenario's sha256 and the deployment's address to
be the ones in the receipt, all 29 frames to be byte-identical to an encoder written
here against the opcode table, all 29 calls to end where the scenario says, all four
expected faults to carry the declared reason, a shape judgement for every halted
call, every declared integer, boolean and array length to match, all five read links
to hold byte for byte, and no step to read a call that faulted. Eleven mutations, on
both the scenario and the dump, have to be caught. Non-vacuity floors — a halt, a
fault, more than one method, at least one read link, one shape check per halt — keep
an empty or single-call scenario from passing the same checks as a real one.

A second block, `abiScenarioWindows`, runs
`formal/refinement/scenarios/aa-account-windows.json` through the same checks. It
exists because every delay in this contract is a comparison against `Runtime.Time`,
and one declared block time can only reach the refusing side of each comparison.
Each step of that file declares the block time it runs at — nine distinct instants,
placed one millisecond before a boundary and exactly at it — and the file contains
four pairs of the same call with the same arguments at two times ending differently.
So the gate adds one more rule for it: when a scenario declares more than one block
time, it must contain at least one call whose ending depends on which time it ran
at. A dimension that was declared and not measured is otherwise a dimension the
receipt would count as covered. The two scenarios are separate requirements — one
file's agreement does not stand in for the other's — and each carries its own
non-vacuity floors and its own 13 mutations, two of which are new here: a call that
ran at another time, and a call signed by another account.

A third block, `abiScenarioPlugins`, runs
`formal/refinement/scenarios/aa-account-plugins.json` through the same checks plus one
more. It exists because a limit here is structural rather than temporal: a verifier
body cannot run without a verifier, and `AssertV3Verifier` reads a *deployed
contract's manifest* rather than a source file. Nothing in the first two files could
reach `AssertV3Verifier`, `callVerifier`, `callHook`, `isModuleInstalled`, or any
pending-module getter, because reaching them needs a plugin contract to exist in the
same engine. That file declares four plugins — two copies of one verifier's bytes
under two deploy signers, and two different hooks — and the gate adds a module
question: for each declared plugin, the address the engine deployed must equal the
declared one, the bytes it deployed must hash to the file the scenario points at
(read from the snapshot, not taken from the dump), and the deploy signer must match,
because a deployed contract's address is a function of the NEF, the manifest name
*and* the signer, and two of those three agreeing says nothing without the third. A
plugin the dump reports and the scenario does not declare fails, as does one whose
address, bytes or signer moved. A step aimed at a plugin is measured against *that
plugin's* manifest — the declared return type of `authorizedCore` belongs to the
verifier's ABI, and reading it out of the account's manifest would be a claim about
the wrong artifact. The non-vacuity floor for this file requires at least one step to
have landed on a plugin and more than one distinct target, so a file that declared
artifacts and measured nothing there cannot pass.

Those artifacts are pinned inputs with a recorded derivation, not a proof.
`formal/refinement/plugins/provenance.json` names the compiler (`nccs 3.9.1`, because
the NEF header names it and its code generation decides the bytes), each project
file, every source file feeding it, and the sha256 of all twelve artifacts;
`formal/refinement/plugins/build-plugins.sh` is the recorded build step and exits
non-zero if a rebuild disagrees with those hashes. This is exactly the standing
`contracts/bin/public` has for the main contract, and it is not a claim that the plugins
are correct.

A fourth block, `abiScenarioRegistrar`, runs
`formal/refinement/scenarios/aa-account-registrar.json` through the same checks. Its
reason is neither time nor admission but *who is calling*: the platform-registrar
channel checks `Runtime.CallingScriptHash` against the registrar the account
recorded, and the market escrow checks it against the market, so no step aimed at
the account can run either. That file installs the other party — the
SAPlatformRegistrar service contract itself, pointed back at the account through
its own `setAuthorizedCore` and driven as its own admin, a forwarder with a
blanket permission that lets the market's own cancel and settle arrive from a
contract, and a paymaster — and the module question is applied to all six
artifacts it deploys, the three callers included, because a claim about who
called the account is a claim about an artifact. The same non-vacuity floor applies,
so a file that declared callers and never called through one cannot pass.

Six of the entries that file drives execute inside the account without a step
landing on them: the two platform registrations, the platform owner-rotation apply
and the three escrow transitions are reached through the caller and are
evidenced by the state they change — an account id that resolves through its proxy
index, a backup owner that moved to the rotation's new owner, a listing id that is
present and then cleared. The receipt counts those apart from the entries a step
names, and the numbers below say which is which. Fourteen entries are declared
unreached and are not counted as covered: `_deploy/2` and `_initialize/0`, which
`System.Contract.Call` refuses to invoke because their names begin with an
underscore (the run records the host's own message), and twelve operational
entries no scenario step drives — the freeze lifecycle (`freezeAccount/1`,
`unfreezeAccount/1`, `isAccountFrozen/1`), the dependency writers
(`setHookDependencies/2`, `setVerifierDependencies/2`,
`clearVerifierDependencies/1`), the child-hook forwarder `callHookChild/4`, the
simulation read `simulateValidation/2` and the reads `describeAccount/1`,
`getPlatformAccountBinding/1`, `isMarketService/1` and
`isUserOpExecutionActive/0`.

`cancelPlatformRegistrar` is a successful control in the current artifact. The
call waits for its timelock, deletes the pending registrar state, and emits the
32-byte `PlatformRegistrarCancelled` event. The former 34-byte event name was
corrected; the scenario now requires `HALT` rather than pinning a host fault.


The three return faces are then joined rather than read separately: the union of the
types the dispatch face exercised and the types each scenario face exercised has to
cover every declared return type. On the pinned artifact the dispatch face alone
leaves `Any` and `Array` uncovered, because every method declaring them faults on
zeros; the first scenario reaches both, the second reaches `ByteArray` with real
arguments rather than a zero-length one, and `returnTypesUnexercised` is empty only
as that union. No face's own list is empty, which is the point: one face's gap is
not papered over by another's success.

The current artifact was remeasured on 2026-11-17 without a public network.
Its dispatch face reads 109/109 methods, 107 entered offsets, two reserved names
refused, 42 completed return shapes matched, 67 zero-argument faults, 408 boundary
probes (202/202 arity refusals, two overload probes on their declared siblings,
94 type probes with 87 in-callee faults and seven answers), and all seventeen
self-checks rejected. Its footprint reads 30,678 bytes, 10,594 instructions, 238
ranges, 362 entered byte methods inside a 996-method closure, 634 reachable and
not entered, with zero unknown, unowned, outside-closure or missing-entry
offsets. Foreign-script offsets are counted separately from this contract's
footprint; the receipt records 887 of them and does not treat them as owned
contract instructions. The four scenario files together read 228 calls, 186
halts, 42 expected faults, 38 read links, ten deployed module artifacts, 28
module steps, 24 block times and 14 time-sensitive pairs. Those measurements
keep `fullUnprovedCount` at 109 and `implementationVerified` false. The four
corresponding scenario receipt hashes are
`081104cc…` (roundtrip), `76814f19…` (windows), `20660340…` (plugins), and
`be1ec7b9…` (registrar). The dispatch and footprint receipt hashes are
`f75e1226…` and `20833d64…`.

The final integrated run for this revision is recorded in
[`sa-closure-gate-20261117.json`](../reports/sa-closure-gate-20261117.json). It
selected twenty-two scopes, snapshotted 130 tool files, 263 input hashes, 129
project-input hashes and 24 raw-receipt hashes, and executed 27 command records
with no non-zero exit and no timeout. The result remains `NO-GO` with
`selectedScopeStatus: PASS`, `fullUnprovedCount: 109`,
`verifiedEntrypoints: []` and `fullImplementationVerified: false`; the current
entrypoint split is 0 fully closed, 34 body-level refined and 75
dispatch-level only. The result, commands and snapshot hashes are
`d68e2ce1…`, `310d48f7…` and `a60cdca7…`. This is the current closure status;
the `fullUnprovedCount: 100` values in gates 33-37 are historical snapshots and
must not be read as the count for this revision.

The run that carries these numbers is gate 33. It snapshotted 112 tool files, ran
24 command jobs with none non-zero or timed out, and returned `NO-GO` —
`selectedScopeStatus PASS`, `fullUnprovedCount 100`, `verifiedEntrypoints []`,
`fullImplementationVerified false`, the same four obligations open. In that receipt
the dispatch face reads `returnsChecked 39`, `returnsMatch 39`, `nullReturns 0`,
`resultTypeMismatch 0`, `declaredTypesUnexercised ['Any','Array']`, ten of ten
mutations caught (`24aac44d…`); the scenario face reads 30 of 30 frames, 26 halts,
4 expected faults, `declaredReturnChecked 26`, `Matched 23`, `Null 3`, `Mismatch 0`,
`linksChecked 5 == linksMatched 5`, `linksToFaultedStep 0`, `distinctMethods 27`,
`declaredTypesUnexercised ['ByteArray']`, eleven of eleven mutations caught
(`1b757ffe…`); and the footprint face's receipt hash is unchanged at `48556e2a…`
across the two neighbouring runs, which is the evidence that the refactor those two
faces share did not reach it.

Gate 34 adds the second scenario. It snapshotted 113 tool files, ran 25 command jobs
with none non-zero or timed out, and returned the same `NO-GO` with the same four
obligations open. `abiScenarioWindows` reads 53 of 53 frames byte-identical, 53 of
53 at their declared block time and signer, 42 halts and 11 faults with the declared
reasons, `declaredReturnChecked 42 == Matched 42` with `Null 0` and `Mismatch 0`,
`linksChecked 6 == linksMatched 6`, `linksToFaultedStep 0`, `distinctMethods 33`,
`distinctTimestamps 9`, `timeSensitivePairs 4` over the steps named
`confirm-admin-transfer`, `initiate-escape`, `finalize-escape` and
`finalize-to-owner-batch`, thirteen of thirteen mutations caught
(`1411ecce…`). Three facts in the same receipt are worth more than the count: the
first scenario's **scenario sha is unchanged** at `ecd68d8e…` while its receipt hash
moved to `4593d9c5…` (the face grew two questions, the input did not move), the
dispatch face's receipt hash did not move at all (`24aac44d…`), and the footprint's
still did not (`48556e2a…`). Each scenario's own `declaredTypesUnexercised` is still
non-empty — `['ByteArray']` for the first, `['Any','Array']` for the second — and the
union over the three faces is what covers all eight declared return types.

A note on the first attempt at gate 34, because it is part of the record: it exited
1, not 2. The `context` lane was killed at the per-subprocess limit — 1800 seconds,
which is the default and which that Coq lane exceeds on this host under load, having
taken 37 minutes in gate 33. That is a resource bound set too low, not a failed
proof, and the gate stopped before it reached the ABI faces at all, so the new layer
was still unmeasured in-gate. Rerunning with `--timeout-seconds 5400` produced the
receipt above. No proof was relaxed to get it.

A note on the first attempt at gate 35, for the same reason. It also exited 1, not 2,
and again the cause was in the orchestration rather than in a proof: all 21 command
jobs finished with exit code 0 and none timed out, and the plugin scenario's dump was
already on disk with 62 steps, four modules, and the right addresses and artifact
hashes. The failure came from the new check that the plugin bytes in the snapshot
are the bytes the receipt names. The receipt records each artifact by the path the
scenario declared — `../plugins/X.nef` — and that path is relative to the *scenario
file's own directory*, which is how the exporter and the face both read it. The check
resolved it against the package root instead, looked for
`snapshot/formal/refinement/../plugins/X.nef`, and raised `FileNotFoundError`. It was
fixed to resolve against the scenario's directory, and the fix was verified against
gate 35's own snapshot rather than against the source tree: all eight artifacts
present, all eight hashes matching, the face still agreeing with sixteen of sixteen
mutations caught. The check was also widened rather than relaxed — it now verifies
each plugin's manifest as well as its NEF, and it asserts the file exists before
hashing it. No proof was relaxed to get it.

A second attempt at gate 35 was abandoned by hand rather than left to fail. Two
minutes into it, a regression test was added for the path rule above — which means
the gate's end-of-run drift check, which re-hashes every original input against the
snapshot it took at start, would have reported `original input drift` an hour later
and thrown away the whole run. The run was stopped, the tests were run to green
(188), the source was frozen, and only then was the gate started again. The rule
this leaves behind: add the test first, start the gate second.

A third attempt passed, and then a fourth was run to make the receipt attest to the
tree as it is actually delivered. Between the two, one word in a docstring had been
corrected: `abi_scenario.py` said its self test had fifteen mutations when it has
sixteen. That edit is provably inert — recomputing all three scenario faces with the
edited source against the third attempt's own dumps reproduced `7b58876f…`,
`33093cac…` and `bced9fbd…` byte for byte, with sixteen of sixteen mutations still
caught — but the tree had stopped matching the snapshot the third attempt took, and a
receipt that attests to a tree nobody is shipping is worth less than one that does.
So the tree was frozen at `5488c3b8…` and the gate run once more. All five receipt
hashes came back identical, the 26 jobs again all exited zero, and the source tree
now matches the gate's snapshot file for file. The number this section reports is
from that final run.

Gate 35 adds the third scenario. It snapshotted 121 tool files, ran 26 command jobs
with none non-zero or timed out, and returned the same `NO-GO` with the same four
obligations open and `fullUnprovedCount 100`. (Both counts are read off
`snapshot.json` and `result.json` respectively: the snapshot total includes the
contract NEF and manifest, `CustomSponsorship.v` and the five helper-gas runtime
receipts, of which 113 are under `formal/refinement`; the job count is the
`commands` block, which is five larger than `commands.json` because that file
records only the captured lanes. Getting either wrong would misreport what the run
covered.) `abiScenarioPlugins` reads 62 of 62
frames byte-identical, 62 of 62 at their declared block time and signer, 52 halts and
10 faults with the declared reasons, `declaredReturnChecked 52 == Matched 52` with
`Null 0` and `Mismatch 0`, `linksChecked 16 == linksMatched 16`,
`linksToFaultedStep 0`, `distinctMethods 27`, `distinctTargets 5`,
`distinctTimestamps 9`, `timeSensitivePairs 5`, and the module question holding:
four plugins declared, four deployed, four addresses matched, eight artifact hashes
matched (each plugin's NEF and its manifest), four signers matched, ten steps landed
on a plugin, sixteen of sixteen mutations caught (`bced9fbd…`). The two scenario
receipts that existed before it both moved — `abiScenario` to `7b58876f…` and
`abiScenarioWindows` to `33093cac…` — because the face grew a question and a
mutation, and the first scenario's **scenario sha is still unchanged** at
`ecd68d8e…`, which is the evidence that the input did not move. The dispatch face's
receipt hash did not move at all (`24aac44d…`) and neither did the footprint's
(`48556e2a…`). The union over the four faces that existed then covered all eight
declared return types, while each face kept its own non-empty gap: `['Any','Array']`
for the dispatch face, `['ByteArray']` for the first scenario, `['Any','Array']` for
the second and `['String']` for the third. Five faces now, and the fourth scenario
adds `['Array','String']` to that list — the union still covers all eight types and
each face still has a gap of its own, which is the point of asking for the union
rather than for any one face's list.

Gate 36 adds the fourth scenario. It snapshotted 128 tool files — the 121 Gate 35
saw, plus the new scenario file and the six artifacts of the three caller-side
plugins — and ran 27 command jobs with none non-zero and none timed out. The verdict
is unchanged: `NO-GO`, `selectedScopeStatus PASS`, twenty-two scopes, `abiEntryCount
100`, `fullUnprovedCount 100`, `verifiedEntrypoints []`,
`fullImplementationVerified false`. So is every receipt that already existed:
`abiScenario 7b58876f…`, `abiScenarioWindows 33093cac…`, `abiScenarioPlugins
bced9fbd…`, `abiDispatch 24aac44d…` and `dispatchFootprint 48556e2a…` are byte for
byte what Gate 35 returned, which is how we know the added scenario touched nothing
it did not select. Only the new face moves: `abiScenarioRegistrar` reads `c2ad13ef…`,
from 82 of 82 frames byte-identical, 82 of 82 at their declared block time and
signer, 65 halts and 17 faults all carrying the declared reason, 65 declared returns
matched with no null and no mismatch, `linksChecked 10 == linksMatched 10`,
`linksToFaultedStep 0`, `distinctMethods 44`, `distinctTargets 6`, six modules
declared, six deployed, six addresses matched, twelve artifact hashes matched, six
signers matched, 16 steps landed on a module, `distinctTimestamps 5`,
`timeSensitivePairs 5`, sixteen of sixteen mutations caught, `problems []`. Across
the four files that is 227 declared calls (30 + 53 + 62 + 82), 42 declared faults, 38
read links held, ten module deployments and 19 distinct block times — the union, not
the sum: two files reuse a boundary instant.

That run took three attempts, and the first two were not code failures. The first
returned `GATE36_EXIT=1` with `one or more fresh proof/control subprocesses failed`;
seven of the eight source-fetch lanes had died on `Tunnel connection failed: 502 Bad
Gateway` and one on `read operation timed out`. Nothing in the tree was wrong — the
upstream hosts were simply unreachable from here. The fix was to point each lane's
`AA_*_SOURCE_MIRROR` at the bytes Gate 35 had already captured under
`/tmp/gate35d/<lane>/source`. A mirror is not a waiver: every mirrored file still
has to hash to the same pin the lane declares, and the run still recomputes each
hash before it accepts the file. With the mirrors supplied the second attempt
returned `GATE36B_EXIT=2`, `NO-GO` with `PASS`, and 27 zero jobs.

Gate 37 is the run that carries the sixth question. Nothing new was selected — the
probe code lives in `AbiDispatch.cs` and `abi_dispatch.py`, both already in the
snapshot — so the snapshot is 128 files again, the job count 27 again, and the
verdict the same `NO-GO` with `PASS`, `fullUnprovedCount 100`, `verifiedEntrypoints
[]` and all four obligations open. Exactly one receipt moved: `abiDispatch` from
`24aac44d…` to `f9429279…`, because the dump grew a `boundary` block (schema v3) and
the face grew a sixth question and seven mutations. Everything beside it held:
`dispatchFootprint 48556e2a…`, the lexer face `93ad5822…` and all four scenario
receipts (`7b58876f…`, `33093cac…`, `bced9fbd…`, `c2ad13ef…`) are byte for byte what
Gate 36 returned. That is what a change to one selected measurement should look
like, and what a change to the artifact would not. The new face reads 374 probes
against the 374 the manifest implies, 98 of 100 controls entering their declared
offset and the 2 reserved names refused, 185 of 185 arity probes refused by
`ContractManagement` with `entered: false`, the two `finalizeEscape` arities landing
on 8514 and 8526, the undeclared name refused, and 86 of 86 wrong-shaped arguments
admitted — 79 failing inside the contract, 7 answering — which is recorded as
`shapeEnforcedAtBoundary: false` rather than as a failure of the artifact. `problems
[]`, seventeen of seventeen mutations caught. The tree was re-hashed against this
run's own records afterwards: 128 tool files, 254 inputs and 120 project inputs, all
identical, none missing.

2026-11-16 amendment, measured with the pinned exporter on this machine rather
than a full gate run: the four scenario files are re-based onto the rebuilt core
artifact, whose deployed address is `0x4560a7a7346fad0826fb5d5ef9fdaff55a0fa294`
— a pure function of the rebuilt NEF, the manifest name and the unchanged deploy
signer — and every script frame and embedded literal moves with it. The
roundtrip file loses the `getPendingPlatformAccountOwnerRotation` read removed
when the rotation bookkeeping moved to the registrar service, and now drives
29 calls. The registrar file deploys the SAPlatformRegistrar service contract
itself in place of the deleted mock — pointed back at the account through its
own `setAuthorizedCore`, driven as its own admin, and gaining the core's
`SetMarketService` registration the hardened escrow requires — and now runs
84 calls. The four caller/plugin artifacts whose sources the 2026-11-13
security remediation changed are rebuilt from those sources with the pinned
compiler, `provenance.json` is re-pinned to the new bytes, and
`build-plugins.sh` reproduces all twelve artifacts byte for byte; module
addresses move accordingly, and with them the account ids derived from a
module's address. Re-measured faces, all agreeing: `abiScenario` scenario
`d5ab5b55…` (29 of 29 frames), `abiScenarioWindows` `867d3d07…` (53 of 53),
`abiScenarioPlugins` `9d16c9b2…` (62 of 62, four modules matched), and
`abiScenarioRegistrar` `960b72eb…` (84 of 84, six modules matched, eleven read
links, eighteen steps on modules). The gate-run numbers above this paragraph —
the entry counts and the earlier receipt pins — describe earlier artifacts and
remain as the historical record; the next full closure run re-derives them.

Two things were recorded after that run and neither changed a measured byte. The
prose in this file and in the two companion documents was rewritten from the
receipts above, and before any of it was trusted the tree was re-hashed against the
gate's own records: all 128 tool-snapshot files, all 254 input files and all 120
project-input files came back identical to the values in `result.json`, with nothing
missing and nothing mismatched. So the run attests the tree as delivered rather than
an earlier one, and a rerun would only have shown that it reproduces — the re-hash
shows the stronger thing, that the receipt is about these bytes. The prose files are
deliberately outside all three sets — nothing in the lanes reads a `.md` — which is
why the rewrite could not have moved a receipt, and why the check was still done
rather than assumed. The lesson worth recording next to the one about adding the
test first: a gate that reaches the network can fail for reasons that say nothing
about the code, and the honest response is to make the network irrelevant rather
than to relax the check.

The tool first snapshots the called lanes' Python imports/literal resources,
exporter source project membership (excluding generated `bin/obj` files),
referenced Coq models, fixtures and
the imported `CustomSponsorship.v`. For each captured input, one read supplies
both the hash and copied executable bytes. The copied verifier and copied provers run from this
snapshot. The source root and production NEF/manifest stay the current repository
inputs; the fresh exporter records and the strict verifier checks their exact
hashes. The tool repeats source membership, inventory/receipt bytes and both
original/copied tool/model checks before writing a successful scoped result.
Unrelated unselected proof-lane files do not change this dependency set.
Selected dynamic loaders must expose literal dependency names or add an explicit
declaration in the gate; implicit undeclared dynamic code is not supported.
Evidence output must be a new or empty directory outside `formal/refinement`.

The base verifier provides arithmetic, numeric, reservation and whole-helper
positive proofs. Numeric and whole-helper controls run in the base command;
arithmetic controls run through the existing captured Python API, and reservation
controls run separately because their CLI returns a controls-only receipt.
Neither controls-only receipt is represented as an additional kernel theorem.
The subsequent lanes are:

| Lane | Accepted scope | Required dependency |
| --- | --- | --- |
| Context | `complete-helper-context-and-initializer-reference-refinement` | Same fresh NEF/script, initializer and complete helper/caller-context certificates |
| Initializer source | `source-to-complete-initializer-reference-refinement` | Same initializer, source projection, field count and captured models |
| Composition | `caller-ledger-composition` | Exact fresh helper certificate and method hash |
| Public pure | `public-pure-reference-refinement` | Exact fresh ABI descriptors, complete method bytes and typed projections |
| Public safe entry frame | `ordinary-safe-public-abi-entry-frame-source-bridge` | Exact same three public-pure descriptors and initializer; pinned ordinary Core/VM source, strict source projection and fresh certificate |
| Syscall admission bridge | `system-contract-call-and-callt-admission-bridge` | Pinned neo `System.Contract.Call` registration and `CallContract`/`OnCallT`/`OnSysCall` source, derived admission record and fresh certificate; hands off to `CallContractInternal` only |
| Contract handoff | `contract-internal-handoff-and-frame-construction` | Pinned neo `CallContractInternal`/`LoadContract`/`LoadScript`/`GetMethod`/`CanCall`/`IsBlocked` and neo-vm `ExecutionContext.Clone` source, derived handoff record and fresh certificate; stops at the constructed frame, before the callee executes |
| Interop conversion | `interop-argument-conversion` | Pinned neo `OnSysCall`/both `Convert` overloads/`InteropParameterDescriptor`/`CallContract` declaration and neo-vm `ExecutionEngineLimits.MaxStackSize`, derived conversion record and fresh certificate; stops at the converted argument vector, before the handler body runs |
| Interop descriptor charge | `interop-descriptor-charge-order` | Pinned neo `OnSysCall`/`AddFee` bodies and the `InteropDescriptor` declaration, derived charge record and fresh certificate; stops at the argument-window effect, before any parameter is popped |
| Exception identity | `exception-identity-and-catchability` | Six pinned neo/neo-vm declarations (instruction loop, throw walk, both fault hooks, the catchable class and the limit record), derived surfacing record and fresh certificate; stops at the fault-state effect, before instruction semantics or the transaction layer |
| Load admission | `load-time-manifest-and-token-admission` | Five pinned core declarations (nef, method token, manifest, ABI, method descriptor), derived 24-slot declaration record and fresh certificate; stops at the value the loader returns, before deployment, gas or the permission decision |
| Private hook view | none (retired) | The v3 `private-hook-params-reference-refinement` lane certified the retired `BuildHookOperationParams` constructor, which protocol v4 deleted. `hook_params_source` now projects the v4 `BuildCanonicalOperationView` at source level only (13 protocol fields in order, deep copies at arguments and hook proofs); no Coq artefact models `CallHookPreCheck`/`CallHookPostCheck`, and no public entry is closed |
| Runtime source bridge | `runtime-instruction-source-bridge` | Pinned VM source commit and source-derived certificate |
| Runtime collection bridge | `runtime-collection-source-bridge` | Pinned VM handlers and certificate; RET/SIZE/ISTYPE/CONVERT remain explicit partial projections |
| Codec | `ledger-codec` | Captured model and pinned native source identities |
| Gas | `source-derived-add-fee-and-metered-traces` | Pinned Neo production AddFee source and generated projection |
| Helper gas | `exact-CFG-parameterized-helper-price-bound` | Same fresh NEF/helper, pinned price tables and five actual runtime trace receipts |
| Storage getters | `storage-getter-source-refinement` | Exact same NEF/script, exact ABI descriptors and body regions, pinned read-only getter inventory, three shared private callees and its own source/bytecode controls |

Each lane requires a positive kernel result and real semantic controls. Definition
or source compilation must succeed before the correspondence theorem is rejected;
timeouts, process signals and missing control detail are insufficient. The gate
uses the composition lane's `semanticControls` as its single control receipt:
the summary records compiled definitions, each rejected mutant and its positive
kernel rejection exit code. A list of mutant names alone is not evidence.
The real composition CLI receipt is tested through the same control validator
used by the join, including malformed and incomplete negative controls. The gate
checks model/input hashes, generated certificate files and source projection
bytes. It independently regenerates the helper, context, initializer-source and
public-pure, private-hook and safe-entry-frame certificate data from the same fresh inventory and rejects a mismatch.
Runtime opcode lists and exclusions must agree with the actual hashed source
projection; declarations must agree with the generated certificate. The four
collection partial projections have an independent fixed taxonomy, so removing
a partial label cannot promote it to a complete opcode proof. Shared official
source URLs must carry identical pinned hashes across lanes.

The safe-entry-frame lane begins at `CallContract` after interop admission and
argument conversion. Its source-bound reference certificate covers exact
name/arity selection and safe-call frame construction for the same three
descriptors already selected by the public-pure lane. It does not execute the
initializer or public method bodies, or prove the preceding SYSCALL flag, fee,
conversion or stack-pop operations. The gate joins the raw inventory hash,
NEF/script/manifest identities, exact ABI descriptors, method ranges and hashes,
initializer descriptor and range, pinned Core and VM source files, generated
projection and certificate bytes. It independently regenerates that certificate
from the same inventory and saved source bytes; copied flags in a receipt do not
replace this check. Controls require compiled definitions and a positive kernel
rejection exit code, with unique mutant names and no timeout or process signal.
The generic initializer projection must equal the ABI lookup of `_initialize/0`;
the generated artifact certificate proves that lookup for the actual manifest.
This lane compiles mutant Coq source projections; it does not compile or execute
mutated C# with the CLR. The gate requires all twelve controls, their independent
kernel-checked counterexamples, exact generated proof files and command logs,
and regenerates every mutant projection and certificate from the pinned sources.
The required control inventory also includes a generic two-argument reverse-push
counterexample for the source loop. The three actual selected descriptors have
zero or one argument; that generic control does not expand their artifact scope.

This lane discharges a scoped admission/frame-construction sub-obligation. Its
trusted bounded source frontend, explicit preconditions and remaining
obligations are retained in the integrated result. The domain requires pinned
dispatch targets without overriding behavior, disabled diagnostics and
noninterfering external operations; successful external calls alone do not
establish these conditions. It keeps
`sourceFrontendVerified:false`, `applicationEngineVerified:false` and
`vmCorrespondenceProven:false`; all 109 ABI entries still lack complete
implementation proofs. ABI admission does not establish bytecode relocation,
initializer execution/return, caller continuation, gas/resources, faults,
transaction rollback or full source-to-runtime correspondence.

The syscall admission bridge covers exactly the layer the previous paragraph
excludes. It pins the neo `System.Contract.Call` registration and the
`OnSysCall`, `CallContract`, `OnCallT` and `MethodToken` source, derives the
admission record from those declarations instead of restating it, and stops at
the `CallContractInternal` parameter tuple. The gate holds its own reviewed copy
of that record, the handler parameter list, the method-token fields, the
thirteen semantic controls and the precondition/unproved/TCB text, so a lane
whose constants were weakened together with its own receipt and regeneration
check still fails. The stack window and the `Array` payload are kept distinct:
`CALLT` hands over an ordered stack prefix, while `System.Contract.Call` hands
over a converted array. `AddFee`/gas, `Convert`, exception identity,
the deployment path that stores an admitted manifest and C#-to-compiler
correspondence remain open, and the lane keeps
`sourceFrontendVerified:false`, `applicationEngineVerified:false` and
`vmCorrespondenceProven:false`.

The contract handoff covers the layer the syscall lane hands off *to*: the second
`CallContractInternal` overload and the frame `LoadContract` builds, including the
initializer frame. It pins nine declarations, derives all eighteen handoff fields from
them, and stops before the callee's first instruction, so it closes no entrypoint. The
gate holds its own reviewed copy of the record, the twenty-one semantic controls, the
four reason-only guards and the precondition/unproved/TCB text. Two orderings are
proved rather than described: the invocation counter is incremented *after* the
blocked/unauthorized gates and *before* the arity and return-type checks, and the
caller-flag intersection bounds the callee word by both the requested and the caller's
own flags. `AddFee`/gas, resource limits, exception identity, storage and manifest reads,
`EvaluationStack`/static sharing and `Dispose` ordering inside `LoadScript`, and
C#-to-compiler correspondence remain open, and the lane keeps
`sourceFrontendVerified:false`, `applicationEngineVerified:false` and
`vmCorrespondenceProven:false`.

The interop conversion covers the step between those two lanes: `OnSysCall` turning
the caller's stack window into the invoked handler's arguments. It pins four
declarations, derives all nineteen conversion fields from them, and stops at the
converted argument vector, so it closes no entrypoint either. The gate holds its own
reviewed copy of the record, the eighteen semantic controls, the two reason-only
guards, the declared `CallContract` argument list and the precondition/unproved/TCB
text. Two facts about the counted branch are proved rather than described: its length
check is strictly `>` against `MaxStackSize` (the limit itself converts, its successor
faults), and the counted elements come off the same window the caller's arguments come
off, so dropping the pop leaves them on the stack. `MaxStackSize` itself is evaluated
from the initializer expression, not restated. The per-type converters, the handler
body, gas, reference counting and C#-to-compiler correspondence remain open, and the
lane keeps `sourceFrontendVerified:false`, `applicationEngineVerified:false` and
`vmCorrespondenceProven:false`.

The interop descriptor charge covers what that lane excludes backward: its
preconditions assume the price "has already been charged" and its open list admits
that only the *absence* of an add-fee step inside the window is recorded. The lane
pins the `OnSysCall` and `AddFee` bodies plus the `InteropDescriptor` declaration,
derives fifteen fields from them, and stops at the window effect. The order of the
six statements is itself a field, read by sorting anchors in the normalized body,
so moving a statement changes the record rather than passing unnoticed. What is
proved: a call rejected by `ValidateCallFlags` pays nothing *because* the flag
check sits in front of the charge; the charge is fixed before the first pop, so a
conversion fault does not refund it; a refused charge pops nothing; a whitelisted
context skips the fee but not the work; and the factor is applied exactly once,
since `_execFeeFactor` already carries the fee decimals and the charge passes
`applyFactor:false`. Sixteen semantic controls, one per mutant, each moving exactly
one field. The fee arithmetic at `BigInteger` width, which descriptors declare a
zero price, the conversion itself and C#-to-compiler correspondence remain open;
exception identity moved to its own scope, below.

The exception identity scope covers the identity those lanes leave boolean: every
lane above records a rejection as an outcome flag, so none of them says which
exception reaches the contract, which reaches the host, and what the difference
is. The lane pins six declarations — the VM instruction loop, the throw walk, both
`OnFault` hooks, the dedicated catchable class and the limit record that guards
its clause — and derives sixteen fields from them. Two facts make the record
load bearing rather than descriptive: what the guarded handler is called with is
`ex.Message`, a string, so the contract never sees a type; and the guarded clause
names `CatchableException` while the outer clause is `catch (Exception e)`, so a
non-catchable failure cannot be caught at all. The kernel proves the four paths
are distinct on the two observable channels, that turning the limit off removes
catchability, that a dropped guard makes the limit irrelevant, that an untyped
outer clause swallows everything, that every fault clears the notification set
while no caught throw does, and that two failures the engine does not catch are
indistinguishable — which is exactly why the record has no field for the thrown
type. Sixteen semantic controls, one per field. Instruction semantics, the
TRY-stack protocol, the fault message text, effect rollback and the transaction
composition that consumes a fault remain open.

The load admission scope covers what every dispatch lane above starts *after*: the
manifest and nef-token declarations that must already have been accepted for a call
to be resolvable at all. It pins five core declarations — the nef reader, the method
token, the manifest, the ABI and the method descriptor — and derives twenty-four
slots from them: one ordered read list, twenty booleans and three declared bounds.
Two surfaces are kept apart rather than merged: `admitted` consults only the guard
list, while the three inclusive caps (token array, token name, manifest length) are
consumed by `loads`, so a declaration can pass every guard and still be refused for
being too long. The read order is a field, read by sorting anchors that survive
every mutant, so moving a `reader.Read*` call changes the record; the checksum is
both last and optional, which is why structural rejection always precedes integrity.
The lane also records the asymmetry the ABI itself carries: exact resolution is keyed
by `(name, arity)` while the wildcard lookup ignores the arity, and the manifest
de-duplicates groups, standards, permission subjects and trusts but not method
signatures — so a repeated signature is admitted and the exact-arity table is where
it stops being resolvable, which stays on the open list rather than being modelled as
a throw. Twenty-seven semantic controls, each moving exactly one slot and covering all
of them. The deployment path, every rejection message, gas, the wildcard reader and
C#-to-compiler correspondence remain open, and the lane keeps
`sourceFrontendVerified:false`, `applicationEngineVerified:false`,
`vmCorrespondenceProven:false` and `deploymentPathVerified:false`.

The codec's typed native C# sub-layer carries six kernel-checked declarations for
its resolved serializer/deserializer AST and two-field roundtrip. Their legal
input domain, canonical framing, fixed limits and explicit VM/.NET primitive
contracts are recorded as a separate scope. The gate joins the three subset
certificates, source model and positive control baseline, and requires valid
source mutants to fail the original universal assertions. This scoped kernel
result retains `fullSourceSimulationProven:false` and
`runtimeSourceSimulationProven:false`. The host codec runner uses .NET for its
typed export; a Coq-only image must recheck generated models/certificates
separately from that whole Python runner.

An optional native-vector join can be selected with:

```sh
python3 formal/refinement/closure.py \
  --output-dir /tmp/aa-integrated-closure-with-vectors \
  --timeout-seconds 5400 \
  --helper-gas-runtime-receipts /path/to/reviewed-five-shape-receipts \
  --native-vectors path/to/reviewed-native-codec-vectors.json
```

The supplied vector bytes are themselves snapshotted. This rechecks a finite
concrete native correspondence certificate and its corrupted-byte control; it
does not rerun the native runtime or prove a general serializer/VM simulation.
Without the option, this evidence is explicitly `NOT_SELECTED`.

The helper gas receipt proves a parameterized bound over the exact independently
enumerated helper CFG and joins the five reviewed runtime traces. These concrete
checks do not close universal actual ApplicationEngine pricing, scheduling,
resource safety or caller reachability. The local default trace directory is `/tmp/aa-gas-runtime-evidence`; use the
explicit CLI option on another host. Missing selected trace receipts fail
instead of silently skipping this scope.

The selected receipts must pin the artifact the other lanes are proving, not just
any plausible trace: `crosscheck_runtime` rejects a receipt whose `nefSha256` or
`manifestSha256` differs from the pinned artifact with `Runtime artifact
mismatch`. That check is what kept this lane failing closed after the contract
rename invalidated the 2026-10-13 capture, and again after the 2026-11-16
design-phase legacy-compatibility sweep changed the custom core artifact;
each time the lane stayed red until the producer test was re-run against the    
fresh artifact (the archived capture still pins NEF `9f714866…`; the current     
artifact is `2887bad3…`, so the lane is red until a new capture exists). The      
reviewed five-shape capture
is archived in-repo as
`formal/refinement/fixtures/helper-gas-runtime-live-receipts.json.gz`
(SHA256 `6d141d14…`); the superseded pre-rename capture is kept beside it and its
refusal is asserted by `ArchivedReceiptStalenessTests`. Re-pointing this lane at
a new artifact therefore requires a new capture, never an edited hash.

The entrypoint-dispatch lane downloads its pinned Neo core sources from
`raw.githubusercontent.com` and admits each file only when its SHA256 equals the
hash recorded for the pinned Core commit. Nothing is cached between runs, because
the lane's output directory must be empty and the source cache lives inside it.
A transport timeout therefore aborted the lane before any proof work happened, so
the download now retries on transport errors only, with the bounded timeout
schedule `(30, 45, 60, 90)` seconds. An HTTP status is reported without retrying,
an exhausted schedule re-raises the last transport error, and downloaded bytes
are still rejected unless they match the pinned hash exactly — the retry changes
resilience, never evidence strength.

For hosts where that download cannot succeed at all, `AA_ENTRY_DISPATCH_SOURCE_MIRROR`
names a directory of previously fetched `<key>.cs` files (`key` being the pinned
source key with `/` replaced by `-`). A mirrored file is admitted under exactly the
same rule as a download: it must hash to the pinned SHA256, otherwise the lane
fails with `Offline mirror source mismatch`. The pin, not the transport, is the
evidence, so a mirror cannot launder a different artifact; the variable only
substitutes for a stalled network, which is an environment fault rather than a
fact about the source. Without the variable the lane always downloads.

The storage-getter lane certificate binds the pinned *read-only* ABI entries to
their exact manifest descriptor and byte region, proves each body's source
semantics in the kernel, and additionally carries a trace-level bytecode
certificate per region: every reachable behavior class of the decoded region
agrees with the source-level outcome, with programs, slot targets, call and
return frames, callee parameter bindings, syscall pop order and cast widths
rendered from the decoded region bytes. `StdLib.Deserialize` stays a pinned NEF
token index whose behavior is a universally quantified oracle, so the lane's own
`vmCorrespondenceProven` is scoped to that trace model. The gate requires the
lane's `referenceVerifiedEntrypoints` to stay empty and its
`fullUnprovedEntrypointCount` to equal the whole manifest count, so this body
certificate can never be read as a closed public entrypoint. It pins the three
shared private callees listed in `closure.STORAGE_GETTER_SHARED_CALLEES` (the
account-state, market-escrow owner-cancel and pending-module-call readers) by name,
region and projection kind, joins every
getter's ABI descriptor, region bytes and trace-coverage classes to the fresh
inventory, and requires kernel-rejected semantic controls at both levels: the
source-level controls mutate each escrow getter's storage prefix or default
binding, and the bytecode-level controls form a non-empty, uniquely named
roster in which every control is bound to a verified getter and carries an
accepted unmutated twin plus a positive kernel rejection. Every written
module is joined by hashing its bytes and re-parsing its declaration inventory,
and the composed certificate bytes are independently regenerated from the fresh
inventory; a receipt alone never replaces that regeneration.

`result.json` also carries a non-overlapping `entrypointCoverage` breakdown. Only
`fullyClosed` clears an entrypoint from `unprovedEntrypoints`; `bodyLevelRefined`
counts entries whose own body has a kernel-checked refinement (the public-pure
lane's reference entries plus the storage-getter lane's traced regions), and
`dispatchLevelOnly` counts the rest. These buckets partition the manifest
exactly, and a refinement claim on an unknown entry or one shared by two lanes
fails closed. The breakdown is descriptive accounting over the selected scopes;
it does not change `status:NO-GO`, `verifiedEntrypoints` or the whole-contract
unproved count.

`result.json` preserves each lane's scope, controls, source/model identities,
established facts, exclusions and declaration inventory. Imported declarations
are not summed across lanes. `commands.json`, per-lane logs, raw receipts,
generated artifacts, `snapshot.json` and `entrypoint-inventory.json` remain
available for independent review. The entrypoint inventory is described in
[Public entrypoint closure inventory](#public-entrypoint-closure-inventory).

The join function is an internal check of freshly executed results; it is not an
API for authenticating arbitrary user-supplied receipt JSON. The CLI does not
accept old proof receipts as substitutes for new invocations.

## Public entrypoint closure inventory

This inventory is an independent structural check, not a semantics theorem or a
release certificate. Every manifest entry must retain its complete entrypoint
obligations, even when its body has an independently checked certificate.

The tool binds the typed source export, manifest descriptors and exact NEF
instructions, then account for all byte ranges, static and indirect calls,
external handlers and graph cycles. Structural reachability includes manifest
roots, initializer entry, branch/fallthrough/handler edges, direct calls and every
address taken by `PUSHA`. An unresolved `CALLA` prevents an unreachable conclusion.
Unreachable means only no path in this explicit graph; it does not mean semantic
dead code. Implicit exception flow, VM gas and ApplicationEngine effects remain
separate obligations.

Run the adversarial tests with:

```sh
python3 -m unittest discover -s formal/refinement -p test_entrypoint_inventory.py -v
```

Omitted edges, substituted valid entry offsets, missing source input membership,
instruction width/opcode forgery and an invented indirect target must fail closed.

The actual command also checks all input hashes and current compilation input
membership before and after accounting. It reopens the NEF and manifest with the
strict existing verifier, and checks independent decoding of every instruction
field, including operand bytes, instruction size and edges. The in-memory builder
alone is for already bound data and fixtures; use the CLI for artifact evidence:

```sh
python3 formal/refinement/entrypoint_inventory.py \
  --inventory "$AA_CURRENT_INVENTORY" \
  --json-report /tmp/aa-entrypoint-closure-current.json
```

The current pinned artifact identity is NEF SHA256
`2887bad34ab763cc8fb1de789997e3c3b331fc7de6ef42f44b095131529cfefb`
(script `6eef7f70838b1bb3b8bed9a6a515152a6b0d86a102a11ba489d74c422cbf715f`,
manifest `f44cddebab7ecc5e35a66b5cb28fb0dbe1f2c224bc139e95ce41d6606431476f`),
accounted against inventory SHA256
`1cfeed33a34cc80d87fe95c68df8f3c94c00a6e4c1ffa106993ccef271b29df6`.
This targets ordinary Neo 3.10.1 source commit
`d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d` and Neo.VM source commit
`004cd6070a940405818d9357638277dd44407e2e`.

The inventory SHA256 is deliberately *not* used as an artifact identity: it is
unstable across rebuilds of a byte-identical artifact because
`sourceMap.debug.document-root` records the per-build export directory
(`…/T/sa-refinement-export-<random-hex>/contracts`). `nef.sha256`,
`nef.scriptSha256`, `manifest.sha256`, `tokens`, `instructions` and
`debug.methods` stay byte-identical; only the recorded build path (and one
`compiler.loadedAssemblies` entry) moves. Compare those fields, not the inventory
digest, when deciding whether two builds are the same artifact.

The current result accounts for 81 manifest entries, 276 byte methods, 400
typed source methods, 378 exported source initializers and all 18,045
instructions / 44,187 script bytes. All 276 debug identities uniquely match
typed method display names, and 80 source-backed ABI descriptors match their
manifest descriptors. The remaining manifest entry, `_initialize/0`, has no
typed/debug method mapping. Its exact interval is `[43470,44187)`: 717 bytes and
236 instructions, and remains source-unbound.

There are 640 direct-call sites, 579 external-effect sites (91 token calls and
488 syscalls), 69 local control-flow cycle components, one call-recursion
component, no `CALLA`, and no `PUSHA`. The 1,230 bytes outside source/debug method
intervals are kept in 43 generated/unmapped ranges. The initializer accounts for
717 structurally reachable bytes; the other 513 bytes in 42 ranges have no path
from the conservative root set through explicit decoded edges. They are marked
`structurallyUnreachable`, with `semanticDead:false`. Future indirect calls disable
this conclusion. This result makes no claim about execution introduced by an
external host bypassing the normal manifest dispatch rules.

The former artifacts with NEF
`4e5c8ae0c4b9722ae19e099303b6a61786de97cc4844abbc1ad458c3a76ce198`
(`[13557,13838)` helper, slot 34, 100 entries),
`6c347dac40bd562edda3216e40c7007fad3a2bb24020013e730c58bd4ceed1c3`
(`[17762,18043)` helper, slot 38, 105 entries) and
`9f714866c5ba1b6cf31d63036d9805d73058055f325fd412e303356534ba2f76`
(`[18900,19181)` helper, slot 38, 109 entries) are historical. Their layouts,
slots and counts must not be applied to the current artifact. The v3 private helper
`BuildHookOperationParams` (`[15136,15160)`, 24 bytes / 21 instructions) has no
counterpart in this artifact at all: no method of that name exists in the v4 source
or in the decoded method table, so the interval it used to occupy no longer exists
and the lane that pinned it is retired rather than renumbered.

The source graph is separate from the byte graph: it records bound method,
constructor, operator and conversion references, property/field references,
source loops and unexported metadata. Compiler inlining or intrinsic lowering
does not justify equating those graphs. Missing external source bodies and
unexported metadata stay open. Each ABI closure contains its body/callee byte
ranges, transitively referenced source members and the common initializer
dependency. The full count remains `fullUnprovedCount:81`.
External/static/indirect effects are explicitly reported for the full body plus
initializer scope; separate `body*` and `initialization*` fields preserve their
origin without letting pure body selection hide common initialization effects.

The registry includes complete byte semantics and faults, source correspondence,
source metadata gaps, property/field interpretation, loop/recursion invariants,
external handler specifications, indirect target resolution, call/return frames,
typed ABI conversion, initialization, compiler correspondence, VM/ApplicationEngine
correspondence, gas/resources and transaction state/rollback. It does not consume
proof receipts or mark any of these obligations closed. `bodyScopedEvidence` is a
separate field, initially empty. Editing flags or attaching a helper/region
receipt cannot turn this tool into a full certificate verifier.

The aggregate gate in [Integrated refinement closure gate](#integrated-refinement-closure-gate) reports which
entry bodies its selected lanes refine, in the non-overlapping
`entrypointCoverage` buckets `fullyClosed`, `bodyLevelRefined` and
`dispatchLevelOnly`. Those buckets describe the gate's own selected scopes only.
This inventory still requires every manifest entry to retain all of its
obligations, and its current `fullUnprovedCount` is `81`.

The automatic first public candidates are:

| ABI entry | Exact body interval | Bytes / instructions | Remaining body work |
| --- | --- | --- | --- |
| `getAccountImplementationId/0` | ``39563,39596)` | 33 / 3 | Source string/ABI observation and VM body theorem |
| `supportsModuleType/1` | `[39947,39979)` | 32 / 12 | Boolean `PUSHT`, string comparison bounds/faults and source projection |
| `supportsExecutionMode/1` | `[39979,40030)` | 51 / 18 | Same requirements |

All have no static fields, external effects, internal calls or graph loops. Their
body proofs were developed separately, and the archived reflection
artifacts live under `formal/refinement/fixtures/current-method-proof/`.
Their full entrypoint dependencies remain open here.

Automatic selection also finds 29 private source helpers with no explicit
external effect or graph loop, and seven of them need no extension to
`CapMethodVm.v`'s decoder text. The smallest useful candidate is
`IsMemberOfActivePolicy`, `[10685,10694)`, 9 bytes / 7 instructions, source
`SmartAccount.Modules.cs:333–334`, which asks whether one module instance is a
member of the active policy — a boolean read over already-materialised state; the
next is `ExpectBool`, `[4114,4121)`, 7 bytes / 4 instructions,
`SmartAccount.Modules.cs:1472–1475`. Textual decoder recognition alone does not
prove their values, aliasing, faults, source projection or universal frame
behavior.

| Additional helper | Interval | Bytes / instructions | Opcodes missing from current CapMethodVm decoder text |
| --- | --- | --- | --- |
| `UInt32ToLittleEndianBytes` | `[491,602)` | 111 / 71 | AND, JMPGE, JMPLE, NEWBUFFER, PUSHINT8, SHR |
| `ValidateAccountId` | `[1467,1546)` | 79 / 27 | ISTYPE, NUMEQUAL, PUSHF, PUSHINT8, SIZE |
| `AssertTargetIsNotProtocolOwned` | `[5772,6106)` | 334 / 32 | none |
| `IsUnsignedIntegerWithinBytes` | `[20806,21023)` | 217 / 101 | AND, CONVERT, DEC, JMPGE, JMPLE, JMP_L, LT, PUSHF, PUSHINT32/64, PUSHT, SIZE |
| `ValidatePlatformAccountBinding` | `[37302,37394)` | 92 / 24 | PUSHF, SIZE |
| `DataPushInstructionSize` | `[41978,43378)` | 1400 / 568 | AND, GE, JMPGE, JMPIFNOT_L, JMPLE, JMP_L, PUSHF, PUSHINT8/32/64, PUSHT |

The machine profile is derived from the current reference decoder text, attests
that model's hash and explicitly reports its limited scope. It is not a supported
instruction semantics proof. The separate public-pure model extends `PUSHT`; this
inventory does not silently treat that extension as part of `CapMethodVm`.

The only additional public candidate without static-field effects or cycles is
`computeArgsHash/1`, `[40407,40460)`, 53 bytes / 13 instructions, source
`SmartAccount.State.cs:301–310`. It requires `StdLib.serialize` and
`System.Contract.Call` handler correspondence, so it is classified as requiring
an external environment specification. A method name or apparent source purity
cannot remove those actual byte dependencies.

### What the engine says about this graph

Everything above is computed from the decoded script. Reachability is a claim about
paths in a graph this tool builds, and until recently nothing outside the tool had
ever exercised one of those paths.

`formal/refinement/dispatch_footprint.py` does. The exporter deploys the pinned NEF
into a real `ApplicationEngine`, calls each ABI method by name with the arity the
manifest declares, and records every instruction offset the engine executed inside
the contract — attributed by running script hash, not by stack depth, so a native
contract's offsets are not credited to this one. This module then decodes the same
script bytes a second time with `nef_decode`. Neo.VM 3.10.1 tables and asks four
questions of the pair:

| Question | Result (gate 31) |
| --- | --- |
| the dump's script decodes to the sha256 both documents claim | 25,620 bytes, 8,833 instructions |
| every executed offset is an instruction start | 0 unknown of 1,661 distinct |
| the 200 accounted byte ranges partition the script and own every executed offset | no hole, no overlap, 0 unowned |
| the byte methods entered are among those `byteDependencyStarts ∪ initializationDependencyStarts` reaches | 315 inside, 0 outside |

The fourth line is the only direction that has to hold, and it is the one this
inventory's `byteDependencyStarts` was making a claim about. The closures list 657
members across the 98 dispatched calls; 342 of them were reachable and never
entered. That is expected rather than a defect — a zero-argument call takes one path
out of a may-set — and the receipt prints the number instead of quietly requiring
equality it would then have to explain away.

What this does **not** do: it does not validate the closures as complete, because it
observes one path per entry point; it does not test any argument-dependent branch;
and it says nothing about what the executed instructions computed. `fullyClosed`
stays `0` and `fullImplementationVerified` stays `false`.

The same dump also answers the negative half of the dispatch question, which none
of the numbers above can: what the engine does with a call the manifest does not
describe. In the current remeasurement, 195 probes carry a parameter count no
overload of that name declares, and all 195 are refused by `ContractManagement`
before a single instruction of this
contract runs — `Method "computeRegistrationAccountId" with 4 parameter(s) doesn't
exist in the contract`, with `entered: false` and a dozen steps instead of the
control's two hundred. The one name nobody declares is refused the same way. The
two counts that *are* declared for `finalizeEscape` each enter a different offset,
10988 and 11000, which is the only place on this artifact where name-plus-arity
selection can be shown rather than read. And 91 arguments of a shape the manifest
says cannot arrive are all accepted at the boundary: 84 fail inside the contract,
7 answer, so the declared parameter types turn out to be documentation for tooling
and not an admission rule — recorded as `shapeEnforcedAtBoundary: false` rather
than as a defect in the artifact.

#### The same graph, with arguments

`formal/refinement/abi_scenario.py` sends values instead of zeros. A reviewed
scenario file declares an ordered list of calls — method, literal arguments, signer,
the block time it runs at, the contract the call lands on, the ending each call
expects, and which earlier argument a result must equal — and the same engine runs
them in order over one deployment, so a write and the read that follows it are both
on the record. Four files are driven. The first, twenty-nine calls at one block time,
builds an account, registers it, writes through it and reads it back. The second,
fifty-three calls at nine declared block times, drives the timelocks: four pairs are
the same call with the same arguments one millisecond before a boundary and exactly
at it, faulting and then halting. The third, sixty-two calls, deploys four real
plugin contracts beside the account and calls into them — a limit here is structural
rather than temporal, since a verifier body cannot run without a verifier and the
admission check reads a deployed manifest rather than a source file. Ten of its steps
land on a plugin, and their declared return types are read from that plugin's own
manifest. The fourth, eighty-four calls, deploys the *other party* rather than a
plugin: the platform-registrar channel and the market escrow both assert that their
caller is a contract, so the registrar service contract itself, a forwarder and a
paymaster are installed, and the account's own registrar-gated and market-gated
entries run behind them.
Together on the 109-entry artifact these four files were last driven against: 228
calls, 186 halted and 42 faults with the reasons the files predict, 228 of 228
frames byte-identical to an encoder written against the opcode table, 228 of 228
at their declared time and signer, thirty-eight read links holding byte for byte,
and every declared integer, boolean and array length matching.

On the 105-entry artifact this gate last measured, two entries' declared return
types — `Any` and `Array` — were declared only by methods that fault on zero
arguments, so no zero-argument face could ever apply their mapping; the union of
the five faces then covered all eight declared return types, and the gate refuses
to pass until it does. That is eight return types, not eight behaviours. The same
measurement decomposed the 105 entries as: 89 named by a step in one of the four
files, 8 more executing behind a caller and evidenced by the state they change
(the platform registrations, the owner rotations and the three escrow
transitions), 5 more reached through the plugin-facing callback paths, and 3
declared unreached: `_deploy/2` and `_initialize/0`, which
`System.Contract.Call` refuses to invoke at all because their names begin with an
underscore, and `rotatePlatformAccountOwner/3`, a one-line alias whose target the
mock calls instead. The 109-entry artifact re-measured this decomposition instead
of inheriting the 105-entry split: 88 entries are named by a step in one of the
four files (both `finalizeEscape` arities among them), 6 more execute behind a
caller and are evidenced by the state they change — the two platform
registrations and the owner-rotation application behind the registrar, the three
escrow transitions behind the market — 1 more is reached through a plugin
callback (`clearHookDependencies/1`, which `MultiHook`'s `clearAccount` calls
unconditionally), and 14 are declared unreached: the two engine entry points plus
twelve operational entries no scenario drives (the freeze lifecycle, the
dependency writers, the child-hook forwarder, the simulation read and four safe
reads; the correspondence document names them). The 81-entry artifact in this
inventory has not been driven through the four files: the scenario lane needs a
fresh exporter dump of it, and its own receipts are the only place that split can
come from, so no decomposition is claimed for it here. A shape that matches still says
nothing about
which value it carried. The boundary pairs are the same kind of statement about time
— the receipt shows the harness was at two instants and the endings differ, and it
says nothing about what a chain would have stamped. The current scenario also
drives the corrected registrar cancellation path: `cancelPlatformRegistrar`
completes at the configured timelock and emits the 32-byte
`PlatformRegistrarCancelled` event. The former 34-byte event name was a contract
defect; it is no longer present in the current artifact or scenario.

Gate 35 is the run that carries the third file. It snapshotted 121 tool files, ran
26 jobs with none non-zero, and returned `NO-GO` with `fullUnprovedCount 100` and
all four obligations open. The plugin face reads 62 of 62 frames byte-identical,
62 of 62 at their declared block time and signer, 52 halts and 10 faults with the
declared reasons, 16 of 16 read links holding, four plugins deployed at the declared
addresses from the declared bytes by the declared signers, ten steps landing on a
plugin, and sixteen of sixteen mutations caught (`bced9fbd…`). The two faces that
existed before it both moved their receipt hashes — `7b58876f…` and `33093cac…` —
while the first scenario's own sha256 stayed at `ecd68d8e…`, and the dispatch face's
(`24aac44d…`) and the footprint's (`48556e2a…`) did not move at all.

Gate 36 is the run that carries the fourth file. It snapshots 128 tool files (the
fourth scenario and six artifacts more than gate 35), runs 27 jobs with none
non-zero, and the registrar face reads 82 of 82 frames byte-identical, 82 of 82 at
their declared time and signer, 65 halts and 17 faults with the declared reasons,
10 of 10 read links holding, six modules deployed at the declared addresses from the
declared bytes by the declared signers, sixteen steps landing on one, and sixteen of
sixteen mutations caught (`c2ad13ef…`). Nothing else moved: the first scenario's
receipt is still `7b58876f…`, the windows face `33093cac…`, the plugin face
`bced9fbd…`, the dispatch face `24aac44d…` and the footprint `48556e2a…` — which is
what a new file beside three old ones should look like, and what a change to the
account's bytes would not. It still returns `NO-GO`: `fullUnprovedCount 100`,
`verifiedEntrypoints []`, all four obligations open.

2026-11-16 amendment: the four scenario files are re-based onto the rebuilt core
artifact (deployed account `0x4560a7a7346fad0826fb5d5ef9fdaff55a0fa294`), the
registrar file now deploys the AAPlatformRegistrar service contract itself instead
of the deleted mock, and the four caller/plugin artifacts whose sources the
2026-11-13 security remediation changed are rebuilt and re-pinned. The
re-measured faces — 29, 53, 62 and 84 frames, all agreeing — are recorded in the
closure-gate document's same-day amendment; the gate-run paragraphs above stay as
the historical record of the runs they describe.


### Why more body proofs cannot move `fullyClosed`

`entrypoint_coverage` reports `fullyClosed: 0` for the current build and says so
in its own note: a body-level refinement is a strict sub-scope, and every refined
entry still carries the ApplicationEngine, compiler-correspondence, gas,
exception and transaction-composition obligations. So adding bodies — the
tempting next step, and the one this document's tables are about — raises
`bodyLevelRefined` while leaving `fullyClosed` at zero. The number that would
have to move is gated by the four open obligations in the closure result, not by
how many entry bodies are refined.

That leaves two coherent programmes, and they claim different things:

- **Route A (source-trust).** Add a verified C#→NEF front end so
  `SOURCE_FRONTEND_AND_COMPILER_CORRESPONDENCE` can close, then refine the
  ApplicationEngine dispatch and the gas/exception/transaction layer. This is
  what `implementationVerified` means today, and it is research-scale: a
  semantics for the subset of C# the compiler accepts, plus its code generation.
- **Route B (bytecode-trust).** Drop the compiler obligation from the claim and
  prove refinement from the NEF bytes and the reviewed debug mapping for all 81
  entrypoints. The existing lanes already work this way — they decode the pinned
  script and never trust the source for semantics — so this route is reachable by
  repetition rather than by a new theory. It yields a *weaker* statement about the
  source (bytecode matches a spec; the mapping from C# to those bytes is assumed)
  and a stronger one about the artifact.

Neither route is something the current evidence can shortcut, and switching to
Route B is a change to what the certificate asserts, so the boundary text in
`VERIFICATION-AND-GATES.md` and the gate's `boundary` string would have to move
with it. Until that decision is recorded, the honest status stays
`NO-GO` with `fullyClosed: 0` regardless of additional body work.

#### The fourteen read-only entries are not a cheap win

Fourteen read-only ABI entries remain on this artifact — thirteen method names,
because `getNonce` has two arities. The v3 pending-update getters
`getPendingVerifierUpdate` and `getPendingHookUpdate` no longer exist (the
control record answers `getPendingConfiguration` instead), and
`isValidSignature/3` is now a 28-byte wrapper over a separate
`IsValidSignatureCore` body at `[33325,34216)` — 891 bytes, 409 instructions,
fourteen direct callees, the `sha256` and `verifyWithECDsa` tokens and the
`System.Runtime.GasLeft` / `System.Runtime.GetCallingScriptHash` syscalls.

| Read-only entry | Exact body interval | Bytes / instructions | Direct callees |
| --- | --- | --- | --- |
| `isOwnerOnlyRecovery/1` | `[17700,17718)` | 18 / 7 | `ValidateAccountId` `1467`, `HasOwnerOnlyRecovery` `17204` |
| `isAccountFrozen/1` | `[17663,17700)` | 37 / 20 | `ValidateAccountId` `1467`, `GetAccountControl` `1566`, `HasLegacyFrozenLatch` `17156` |
| `isMarketEscrowActive/1` | `[14388,14430)` | 42 / 14 | two market-escrow reader helpers; the custom source that defined them was removed with the retired custom tree (Task #43), so only the artifact interval is cited |
| `getNonce/3` | `[35916,36022)` | 106 / 47 | `ValidateAccountId` `1467`, `RequireAccountControl` `30206`, `ResolveCredentialGeneration` `35797`, `ReadNonceCursor` `24023` and three more |
| `getNonce/2` | `[40313,40407)` | 94 / 47 | `ValidateAccountId` `1467`, `IsUnsignedIntegerWithinBytes` `20806` |
| `isModuleInstalled/4` | `[40220,40286)` | 66 / 26 | `ValidateAccountId` `1467`, `FindModuleIdByContract` `8613`, `ModuleTypeCodeFromName` `40030` |
| `getPendingConfiguration/2` | `[31368,31422)` | 54 / 40 | `ValidateAccountId` `1467`, `GetConfigurationIntent` `27334` |
| `isMarketService/1` | `[33147,33196)` | 49 / 17 | `IsRegisteredMarketService` `32012` |
| `isValidSignature/3` | `[33297,33325)` | 28 / 14 | `IsValidSignatureCore` `33325`, `InvalidSignatureMagic` `34216` |
| `isUserOpExecutionActive/0` | `[31440,31500)` | 60 / 35 | none |
| `getAccountIdByProxy/1` | `[38688,38832)` | 144 / 51 | none |
| `getPlatformAccountBinding/1` | `[38832,38858)` | 26 / 10 | `ValidateAccountId` `1467` |
| `getProxyScriptHash/1` | `[37830,37914)` | 84 / 29 | `BuildProxyVerificationScript` `37914` |
| `getAccountImplementationId/0` | `[39563,39596)` | 33 / 3 | none |

Rendering each region through the storage-getter lane's own pinned model
(`storage_getter_proofs.render_vm_program`, with the pinned `StdLib.deserialize`
token admitted) fails closed for all fourteen, and the reasons matter more than
the verdict:

- Eight call more than one helper and stop at `CALL/CALL_L target N is not the
  pinned shared callee`: `isAccountFrozen/1` and `isModuleInstalled/4` call
  three each, `getNonce/3` calls seven, and `isOwnerOnlyRecovery/1`,
  `isMarketEscrowActive/1`, `getNonce/2`, `getPendingConfiguration/2` and
  `isValidSignature/3` call two each. The lane binds exactly one shared callee
  per getter, so these need multi-callee composition before any proof can be
  written — a structural extension, not another table row.
- `isModuleInstalled/4`, `getNonce/3`, `getPendingConfiguration/2` and
  `isValidSignature/3` also read `LDARG1`/`LDARG2`, outside the pinned
  single-operand callee parameter binding, so that binding has to widen
  together with the composition work.
- `getPlatformAccountBinding/1` fails on an `INITSLOT` shape outside the pinned
  frame layout — a frame-shape extension, not new semantics.
- `isUserOpExecutionActive/0` issues `System.Runtime.GetScriptContainer` and
  reads a `deserialize`d in-flight record, outside the pinned
  GetContext/StorageGet pair; `getProxyScriptHash/1` calls both the CryptoLib
  `sha256` and `ripemd160` tokens, and the lane pins only the
  `StdLib.deserialize` token identity. Each is one more pinned external
  identity, not a new model.
- `isMarketService/1` and `isModuleInstalled/4` fail on `PUSHT`, which the
  pinned model does not render.
- `getAccountImplementationId/0` is a two-instruction jump thunk with no
  `INITSLOT` of its own; its body belongs to the public-pure lane instead.
- `getAccountIdByProxy/1` fails on `Expected exactly one cast width witness`:
  its nullable `UInt160` read carries the `DUP / ISNULL / SIZE / JMPEQ / THROW`
  guard as well as the cast, so the `direct` family's single-witness assumption
  does not cover it. It also needs an inline key concatenation and a tolerated
  leading `ExecutionEngine.Assert`.

So the read-only entries are one multi-callee extension, a callee-parameter
widening, three more pinned external identities and several frame/cast-witness
shapes, not fourteen independent one-liners. Anyone scheduling this should
price it as lane work first and entry work second.

## SA Migration Manifest — Legacy → Protocol v4 (Design)

This document specifies the **migration manifest**: the canonical, exportable,
per-account classification record that drives migration of existing Neo Smart
Account (SA) accounts from the legacy single-slot model (custom five-field
`0x01` AccountState / native 14-slot Array) to the shared module protocol
version 4 (`docs/SA-MODULE-PROTOCOL.md`).

Status: **design + manifest schema + idempotency rules; migration executor is a
later batch.** The re-deployment decision is confirmed: the new core, Market and
Paymaster deploy under new names (`SmartAccount`, `SAAddressMarket`,
`SAPaymaster`) at fresh addresses; legacy cores (mainnet `0x0268a387…`,
testnet `0xdbf38e7b…`) are migrated, never upgraded in place. Consequently the
"preserve manifest.name / coreHash" identity constraints of an in-place
upgrade do not apply to the *new* deployment; the legacy contracts are frozen
read-only sources for export.

### 1. Export pipeline (per design report §4.3)

1. Re-scan both networks before anything moves: every account, every legacy
   prefix row, the deployment artifacts. The scan produces the manifest.
2. Export per account: legacy state, root modules, children, threshold
   configuration, hook order, freeze/escape state, nonce cursors, Market
   markers, plugin code identity.
3. Classify (§2). Unknown/unresolvable plugins ⇒ `MigrationRequired`, never a
   guess.
4. New-core deployment happens first; no single transaction walks 53 mainnet /
   407 testnet accounts.
5. Every legacy account that had plugins enters `MigrationRequired` state on
   the new core: execution and message authorization are rejected, while
   queries, freeze and callback-free recovery remain reachable. No silent
   owner fallback.
6. Owner proposes a migration intent (24 h, the normal configuration timelock)
   with the exact new modules, instances, thresholds and hook order; custody
   confirms.
7. Import runs through the new `onInstall` lifecycle with the exact approved
   configuration; MultiHook unfolds in legacy forward order; MultiSig keeps
   its threshold as a core-owned policy.
8. On verified success the account atomically switches to `Active`; the
   manifest digest and legacy digest are recorded in `0x5A`.
9. Re-scan after migration: addresses, permissions, nonce, locks and results.

### 2. Classification

Every account gets exactly one primary class:

| Class | Meaning | Default path |
| --- | --- | --- |
| `no-plugin` | zero verifier, zero hook, no policy rows of any kind (a nonzero legacy hook is *not* "no policy") | bounded materialize to Active |
| `scalar-plugin` | one verifier and/or one hook, no children | direct install of renamed module(s) |
| `multihook` | MultiHook root with 0–8 child hooks | unfold children into core `hookOrder` in legacy forward order; MultiHook itself is not reinstalled |
| `multisig` | MultiSigVerifier root (≤10 children, threshold) | core-owned threshold policy; members installed as `thresholdMemberEligible` validators; member order preserved |
| `unknown-plugin` | any root/child whose contract hash is not in the approved v4 module set | `MigrationRequired`; no speculative mapping |
| `owner-only` | legacy permanent owner-only accounts (0x22 semantics) | migrate but the owner-only flag persists in 0x51 and keeps constraining the account |
| `market-locked` | live escrow/listing marker (0x06/0x07/0x1D) at export time | migrate account; 0x5D records the binding; Market settle/cancel revalidates epoch; owner escape writes 0x59 only |
| `recovery-pending` | pending escape/recovery at export time | finish or cancel on the legacy core first, then re-export; the new core never continues a legacy pending |

A legacy pending configuration/call is **not** an authorization source: it is
exported only as evidence and is dropped.

### 3. Manifest format

One JSON document per network (canonical JSON: sorted keys, no insignificant
whitespace; its SHA-256 is the `manifestDigest`). Schema skeleton:
`tests/fixtures/sa-module-protocol/migration-manifest.template.json`.

```json
{
  "manifestVersion": 1,
  "protocolVersion": 4,
  "network": 860833102,
  "legacyCoreHash": "…",
  "newCoreHash": "…",
  "exportedAt": 1765000000000,
  "scan": {
    "accounts": 407,
    "legacyPrefixRows": { "0x01": 407, "0x12": 84, "0x1C": 3 },
    "artifactDigest": "…"
  },
  "accounts": [
    {
      "accountId": "…",
      "accountAddress": "…",
      "classification": "multisig",
      "legacyState": {
        "verifier": "…", "hook": "…", "backupOwner": "…",
        "escapeTimelock": 86400, "escapeTriggeredAt": 0,
        "frozen": false, "ownerOnly": false,
        "pendingConfig": null, "pendingCalls": []
      },
      "legacyModules": [
        { "role": "verifier-root", "contractHash": "…",
          "contractId": 42, "updateCounter": 1, "nefSha256": "…",
          "children": [ { "contractHash": "…", "type": "verifier" } ] }
      ],
      "legacyThreshold": { "members": 10, "value": 3 },
      "legacyHookOrder": ["childHashA", "childHashB"],
      "legacyNonces": [ { "channel": "…", "cursor": 7 } ],
      "marketLock": { "listingId": 5, "escrowContract": "…" },
      "targetState": {
        "modules": [
          { "moduleId": 1, "type": 1, "contractHash": "…",
            "credentialGeneration": 1,
            "source": "legacy-verifier-root" }
        ],
        "hookOrder": [1],
        "thresholdPolicies": [
          { "policyId": 2, "threshold": 3, "memberIds": [1,2,3] }
        ],
        "recoveryTimelockMs": 604800000,
        "defaultPolicy": { "operation": "builtin", "message": "builtin" }
      },
      "idempotencyKey": "network:accountId:manifestDigest"
    }
  ]
}
```

Field rules:

- `legacyModules[].children` lists sub-module registrations (0x23/0x24 roots)
  — evidence only; children are never migrated as independent installs.
- `targetState` is the *proposed* v4 state computed by the classifier; the
  owner may amend it in the 24 h intent window; confirmation binds the exact
  final action digest.
- `moduleIds` in `targetState` are allocated fresh on the new core starting
  from 1, in a deterministic order (verifier roots first, then children in
  legacy order, then hooks in hookOrder order, then policy members).
- `credentialGeneration` starts at 1 for every imported instance; the legacy
  generation/nonce history is *not* carried into the new instance's
  credential space.
- `legacyNonces` feeds only the monotonic merge rule of protocol §6: new
  cursor = `max(legacy channel cursor, new 0x56 value)`, never a decrease.
- Accounts with `classification: unknown-plugin` carry `targetState: null`
  plus a `required` block listing what the owner must decide.

### 4. Idempotency requirements

- Re-submitting an identical `(accountId, manifestDigest)` migration intent
  is a no-op (not an error, not a second install).
- The manifest digest is stored under `0x5A` at import; any later intent for
  the same account must quote it. An import interrupted mid-way (transaction
  FAULT) leaves zero partial state (transaction atomicity) and the account
  remains `MigrationRequired`; retry re-runs the whole intent.
- Once `Active`, a repeat import is rejected unless it quotes the recorded
  digest *and* proposes an empty action set (proving no-op) — otherwise
  `SA_MIGRATION_REQUIRED`-style guards treat it as a normal configuration.
- Legacy data is never deleted by migration: 0x01 rows (custom) and the
  native 14-slot records stay as historical evidence on their contracts; the
  new core only records the invalidation declarations (0x12/0x1C) and
  digests in 0x5A.
- Old signatures, old pending intents, 0x12 rows and 0x1C rows are never
  authorization inputs on the new core (protocol §7.4).
- Stateful quotas / rate-limit history (DailyLimitHook etc.) are imported with
  their counters; an import failure keeps the account in `MigrationRequired`
  — history is never silently zeroed; the owner may explicitly choose a
  delayed re-set as a separate action.
- Contract custody message subjects require an explicit owner authorization
  during migration setup — never inferred from the custody address.

### 5. Acceptance evidence (per account)

1. Legacy export row matches an on-chain readback at migration time.
2. New account state matches `targetState` exactly (module count, ids, order,
   threshold, generations).
3. `authorityEpoch`/`configurationNonce` on the new core are ≥ legacy
   exported values where defined; nonce cursors never decreased.
4. A legacy-crafted signature/pending replay attempt against the new core
   fails (regression fixture, protocol §16.3).
5. Post-migration re-scan equality on both networks.

These become golden fixture entries in
`tests/fixtures/sa-module-protocol/golden-vectors/migration.json`, which pins
the §14 state machine the core can prove without a chain export (the kernel
decodes the seeded 0x01 row, marks it, imports through the 24h migration
intent, and rejects the replay). Steps 1 and 5 additionally need the real
53/407 account exports that `migration-manifest.template.json` describes.
