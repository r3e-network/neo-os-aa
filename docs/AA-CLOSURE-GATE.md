# Integrated refinement closure gate

This is a fresh orchestration and identity join of scoped proofs. It does not
authenticate full protocol closure merely because several kernels accepted
their models. All public entries retain open runtime/frontend/composition
obligations; body and private-helper certificates stay separate.

The default command builds a fresh inventory with the existing four-lane
verifier, then runs the additional scoped provers and their negative controls.
The current gate selects sixteen separate scopes. Missing receipts, wrong
scopes, mixed NEF/helper identities, source/model drift
and incomplete controls fail closed. Independent proof lanes run at most two
at a time. Each invocation retains its command, log and receipt.

```sh
python3 formal/refinement/closure.py \
  --output-dir /tmp/aa-integrated-closure-fresh \
  --timeout-seconds 1800 \
  --helper-gas-runtime-receipts /path/to/reviewed-five-shape-receipts
```

Exit `2` means the selected scoped checks passed but full implementation
refinement is still `NO-GO`. Exit `1` means a selected check failed, evidence was
missing or identities drifted. `--allow-partial` changes exit `2` to `0` while
preserving `status:NO-GO`, `implementationVerified:false`, an empty
`verifiedEntrypoints` and the complete public-entrypoint unproved count. It never
relaxes a selected proof, identity join or negative control.

The tool first snapshots the called lanes' Python imports/literal resources,
exporter source project membership (excluding generated `bin/obj` files),
referenced Coq models, fixtures and
the imported `OrdinarySponsorship.v`. For each captured input, one read supplies
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
| Private hook tuple | `private-hook-params-reference-refinement` | Complete private method range/bytes, typed record projection and reference certificate; no public entry is closed |
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
`vmCorrespondenceProven:false`; all 100 ABI entries still lack complete
implementation proofs. ABI admission does not establish bytecode relocation,
initializer execution/return, caller continuation, gas/resources, faults,
transaction rollback or full source-to-runtime correspondence.

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
  --helper-gas-runtime-receipts /path/to/reviewed-five-shape-receipts \
  --native-vectors /private/tmp/aa-public-native-codec-vectors.json
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
rename invalidated the 2026-10-13 capture, and the lane stayed red until the
producer test was re-run against NEF `be43cd05…`. The reviewed five-shape capture
is archived in-repo as
`formal/refinement/fixtures/helper-gas-runtime-live-receipts.json.gz`
(SHA256 `d464f706…`); the superseded pre-rename capture is kept beside it and its
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
certificate can never be read as a closed public entrypoint. It pins the shared
private callees (`getAccountState`, `getMarketEscrowOwnerCancelInitiated`,
`getPendingModuleCallRecord`) by name, region and projection kind, joins every
getter's ABI descriptor, region bytes and trace-coverage classes to the fresh
inventory, requires at least the two independent read-order controls that back
the legacy-compatibility read order, and requires each bytecode control to carry
an accepted unmutated twin plus a positive kernel rejection. Every written
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
[AA-ENTRYPOINT-CLOSURE.md](AA-ENTRYPOINT-CLOSURE.md).

The join function is an internal check of freshly executed results; it is not an
API for authenticating arbitrary user-supplied receipt JSON. The CLI does not
accept old proof receipts as substitutes for new invocations.
