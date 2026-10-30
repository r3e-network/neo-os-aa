# Public entrypoint closure inventory

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
  --inventory /tmp/aa-refinement-integrated-final-20261013/inventory.json \
  --json-report /tmp/aa-entrypoint-closure-20261013.json
```

The current artifact identity is NEF SHA256
`4e5c8ae0c4b9722ae19e099303b6a61786de97cc4844abbc1ad458c3a76ce198`
(script `cd1ef3375d65844e896fab0b69191640e10328ae188993da3c65fa0cfe53366d`,
manifest `f7203fd84f6d132119df839a13249d73e4fe67644ca7a2e1c4ad6b9a1f6b21ed`),
accounted against inventory SHA256
`a19a3fac91914deea3b1454f01b751e6c1c929b5241c91ba14436337d1171a8b`.
This targets ordinary Neo 3.10.1 source commit
`d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d` and Neo.VM source commit
`004cd6070a940405818d9357638277dd44407e2e`.

The inventory SHA256 is deliberately *not* used as an artifact identity: it is
unstable across rebuilds of a byte-identical artifact because
`sourceMap.debug.document-root` records the per-build export directory
(`…/T/aa-refinement-export-<random-hex>/contracts`). `nef.sha256`,
`nef.scriptSha256`, `manifest.sha256`, `tokens`, `instructions` and
`debug.methods` stay byte-identical; only the recorded build path (and one
`compiler.loadedAssemblies` entry) moves. Compare those fields, not the inventory
digest, when deciding whether two builds are the same artifact.

This artifact is 10 script bytes shorter than the pre-rename build described in
earlier revisions of this file, because `getAccountImplementationId` returns a
shorter implementation-id literal (33 bytes / 3 instructions now, 43 before). The
body still starts at 17906, but it now ends at 17939, so its own end boundary and
every interval after it shift down by 10, while every interval strictly before it
is unchanged. The reimbursement helper `CapReimbursementToActualCost` then grew by
73 bytes when it gained its explicit VM-integer-range margin guard, so it is now
`[13557,13838)` instead of `[13557,13765)`, and every interval at or after 13734
moves down another 73 (net +63 against the pre-rename build). The initializer's
key setup is therefore at `25432/25435/25437` (was `25359/25362/25364` in the
rename build and `25369/25372/25374` before the rename).

The result accounts for 100 manifest entries, 164 byte methods, 815 typed source
methods, 331 exported source initializers and all 8,833 instructions / 25,620
script bytes. All 164 debug identities uniquely match typed method display names;
all 99 source-backed ABI descriptors exactly match their manifest descriptors.
The remaining manifest entry, `_initialize/0`, has no typed/debug method mapping.
Its exact interval is `[24966,25620)`, 654 bytes, and remains source-unbound.

There are 278 direct-call sites, 581 external-effect sites (69 token calls and 512
syscalls), 14 local control-flow cycle components, no call recursion components,
no `CALLA`, and no `PUSHA`. The 962 bytes outside source/debug method intervals
are kept in distinct generated/unmapped ranges. The initializer accounts for 654
structurally reachable bytes; the remaining 308 bytes in 36 ranges have no path
from the conservative root set through explicit decoded edges. They are marked
`structurallyUnreachable`, with `semanticDead:false`. Future indirect calls disable
this conclusion. This result makes no claim about execution introduced by an
external host bypassing the normal manifest dispatch rules.

The source graph is separate from the byte graph: it records bound method,
constructor, operator and conversion references, property/field references,
source loops and unexported metadata. Compiler inlining or intrinsic lowering
does not justify equating those graphs. Missing external source bodies and
unexported metadata stay open. Each ABI closure contains its body/callee byte
ranges, transitively referenced source members and the common initializer
dependency. The full count remains `fullUnprovedCount:100`.
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

The aggregate gate in [AA-CLOSURE-GATE.md](AA-CLOSURE-GATE.md) reports which
entry bodies its selected lanes refine, in the non-overlapping
`entrypointCoverage` buckets `fullyClosed`, `bodyLevelRefined` and
`dispatchLevelOnly`. Those buckets describe the gate's own selected scopes only.
This inventory still requires every manifest entry to retain all of its
obligations, and its `fullUnprovedCount` stays `100`.

The automatic first public candidates are:

| ABI entry | Exact body interval | Bytes / instructions | Remaining body work |
| --- | --- | --- | --- |
| `getAccountImplementationId/0` | `[17906,17939)` | 33 / 3 | Source string/ABI observation and VM body theorem |
| `supportsExecutionMode/1` | `[17939,17990)` | 51 / 18 | Boolean `PUSHT`, string comparison bounds/faults and source projection |
| `supportsModuleType/1` | `[17990,18039)` | 49 / 18 | Same requirements |

All have no static fields, external effects, internal calls or graph loops. Their
body proofs are developed separately in [AA-PUBLIC-PURE-REFINEMENT.md](AA-PUBLIC-PURE-REFINEMENT.md).
Their full entrypoint dependencies remain open here.

Automatic selection also finds six private source helpers with no explicit
external effect or graph loop. The current `CapMethodVm.v` decoder text recognizes
all byte opcodes of `BuildHookOperationParams`, `[11602,11626)`, 24 bytes / 21
instructions, source `SmartAccount.Execution.cs:267–278`. This is the next
smallest useful pure helper candidate: it builds a packed argument array from a
`UserOperation` and caller arguments using existing argument/heap/frame opcodes.
Textual decoder recognition alone does not prove its values, aliasing, faults,
source projection or universal frame behavior.

| Additional helper | Interval | Bytes / instructions | Opcodes missing from current CapMethodVm decoder text |
| --- | --- | --- | --- |
| `UInt32ToLittleEndianBytes` | `[293,404)` | 111 / 71 | AND, JMPGE, JMPLE, NEWBUFFER, PUSHINT16, PUSHINT8, SHR |
| `ValidateAccountId` | `[7164,7243)` | 79 / 27 | ISTYPE, NUMEQUAL, PUSHF, PUSHINT8, SIZE |
| `IsUnsignedIntegerWithinBytes` | `[10960,11177)` | 217 / 101 | AND, CONVERT, DEC, JMPGE, JMPLE, JMP_L, LE, LT, PUSHF, PUSHINT16/32/64, PUSHT, SIZE |
| `ValidatePlatformAccountBinding` | `[14815,14907)` | 92 / 24 | LE, PUSHF, PUSHINT16, SIZE |
| `DataPushInstructionSize` | `[22494,23894)` | 1400 / 568 | AND, GE, JMPGE, JMPIFNOT_L, JMPLE, JMP_L, LE, PUSHF, PUSHINT8/16/32/64, PUSHT |

The machine profile is derived from the current reference decoder text, attests
that model's hash and explicitly reports its limited scope. It is not a supported
instruction semantics proof. The separate public-pure model extends `PUSHT`; this
inventory does not silently treat that extension as part of `CapMethodVm`.

The only additional public candidate without static-field effects or cycles is
`computeArgsHash/1`, `[18559,18612)`, 53 bytes / 13 instructions, source
`SmartAccount.State.cs:166–175`. It requires `StdLib.serialize` and
`System.Contract.Call` handler correspondence, so it is classified as requiring
an external environment specification. A method name or apparent source purity
cannot remove those actual byte dependencies.

## What the engine says about this graph

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
describe. 185 probes carry a parameter count no overload of that name declares, and
all 185 are refused by `ContractManagement` before a single instruction of this
contract runs — `Method "computeRegistrationAccountId" with 4 parameter(s) doesn't
exist in the contract`, with `entered: false` and a dozen steps instead of the
control's two hundred. The one name nobody declares is refused the same way. The
two counts that *are* declared for `finalizeEscape` each enter a different offset,
8514 and 8526, which is the only place on this artifact where name-plus-arity
selection can be shown rather than read. And 86 arguments of a shape the manifest
says cannot arrive are all accepted at the boundary: 79 fail inside the contract,
7 answer, so the declared parameter types turn out to be documentation for tooling
and not an admission rule — recorded as `shapeEnforcedAtBoundary: false` rather
than as a defect in the artifact. Gate 37 is the run that carries this: the
dispatch receipt moved from `24aac44d…` to `f9429279…`, while the footprint
(`48556e2a…`) and all four scenario receipts did not move at all.

### The same graph, with arguments

`formal/refinement/abi_scenario.py` sends values instead of zeros. A reviewed
scenario file declares an ordered list of calls — method, literal arguments, signer,
the block time it runs at, the contract the call lands on, the ending each call
expects, and which earlier argument a result must equal — and the same engine runs
them in order over one deployment, so a write and the read that follows it are both
on the record. Four files are driven. The first, thirty calls at one block time,
builds an account, registers it, writes through it and reads it back. The second,
fifty-three calls at nine declared block times, drives the timelocks: four pairs are
the same call with the same arguments one millisecond before a boundary and exactly
at it, faulting and then halting. The third, sixty-two calls, deploys four real
plugin contracts beside the account and calls into them — a limit here is structural
rather than temporal, since a verifier body cannot run without a verifier and the
admission check reads a deployed manifest rather than a source file. Ten of its steps
land on a plugin, and their declared return types are read from that plugin's own
manifest. The fourth, eighty-two calls, deploys the *other party* rather than a
plugin: the platform-registrar channel and the market escrow both assert that their
caller is a contract, so a registrar mock, a forwarder and a paymaster are installed
and the account's own registrar-gated and market-gated entries run behind them.
Together on the pinned artifact: 227 calls, 183 halted and 44 faults with the
reasons the files predict, 227 of 227 frames byte-identical to an encoder written
against the opcode table, 227 of 227 at their declared time and signer,
thirty-seven read links holding byte for byte, and every declared integer, boolean
and array length matching.

Two of the 100 entries' declared return types — `Any` and `Array` — are declared
only by methods that fault on zero arguments, so no zero-argument face could ever
apply their mapping. After this layer none is left: the union of the five faces
covers all eight declared return types, and the gate refuses to pass until it does.
That is eight return types, not eight behaviours. Of the 100 entries, 89 are named
by a step in one of the four files, 8 more execute behind a caller and are evidenced
by the state they change (the platform registrations, the owner rotations and the
three escrow transitions), and 3 are declared unreached: `_deploy/2` and
`_initialize/0`, which `System.Contract.Call` refuses to invoke at all because their
names begin with an underscore, and `rotatePlatformAccountOwner/3`, a one-line alias
whose target the mock calls instead. A shape that matches still says nothing about
which value it carried. The boundary pairs are the same kind of statement about time
— the receipt shows the harness was at two instants and the endings differ, and it
says nothing about what a chain would have stamped. And the fourth file's one
unexplained fault is a finding rather than a gap in the harness: `cancelPlatformRegistrar`
emits an event whose name is 34 bytes, and Neo caps event names at 32, so the call
reverts in the host before it can delete anything. That one is a contract defect,
declared in the scenario with the host's own message, and left unfixed because
renaming the event changes the manifest and therefore every hash this project pins.

Gate 35 is the run that carries the third file. It snapshotted 121 tool files, ran
26 jobs with none non-zero, and returned `NO-GO` with `fullUnprovedCount 100` and
all four obligations open. The plugin face reads 62 of 62 frames byte-identical,
62 of 62 at their declared block time and signer, 51 halts and 11 faults with the
declared reasons, 16 of 16 read links holding, four plugins deployed at the declared
addresses from the declared bytes by the declared signers, ten steps landing on a
plugin, and sixteen of sixteen mutations caught (`bced9fbd…`). The two faces that
existed before it both moved their receipt hashes — `7b58876f…` and `33093cac…` —
while the first scenario's own sha256 stayed at `ecd68d8e…`, and the dispatch face's
(`24aac44d…`) and the footprint's (`48556e2a…`) did not move at all.

Gate 36 is the run that carries the fourth file. It snapshots 128 tool files (the
fourth scenario and six artifacts more than gate 35), runs 27 jobs with none
non-zero, and the registrar face reads 82 of 82 frames byte-identical, 82 of 82 at
their declared time and signer, 64 halts and 18 faults with the declared reasons,
10 of 10 read links holding, six modules deployed at the declared addresses from the
declared bytes by the declared signers, sixteen steps landing on one, and sixteen of
sixteen mutations caught (`c2ad13ef…`). Nothing else moved: the first scenario's
receipt is still `7b58876f…`, the windows face `33093cac…`, the plugin face
`bced9fbd…`, the dispatch face `24aac44d…` and the footprint `48556e2a…` — which is
what a new file beside three old ones should look like, and what a change to the
account's bytes would not. It still returns `NO-GO`: `fullUnprovedCount 100`,
`verifiedEntrypoints []`, all four obligations open.


## Why more body proofs cannot move `fullyClosed`

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
  prove refinement from the NEF bytes and the reviewed debug mapping for all 100
  entrypoints. The existing lanes already work this way — they decode the pinned
  script and never trust the source for semantics — so this route is reachable by
  repetition rather than by a new theory. It yields a *weaker* statement about the
  source (bytecode matches a spec; the mapping from C# to those bytes is assumed)
  and a stronger one about the artifact.

Neither route is something the current evidence can shortcut, and switching to
Route B is a change to what the certificate asserts, so the boundary text in
`AA-FORMAL-VERIFICATION.md` and the gate's `boundary` string would have to move
with it. Until that decision is recorded, the honest status stays
`NO-GO` with `fullyClosed: 0` regardless of additional body work.

### The eleven read-only entries are not a cheap win

Rendering each remaining read-only region through the storage-getter lane's own
pinned model (`storage_getter_proofs.render_vm_program`) fails closed for all
eleven, and the reasons matter more than the verdict:

- Ten of them call at least one helper, and the targets are not uniform:
  `ValidateAccountId` `7164` (five entries), `GetAccountState` `2986` (three),
  `GetMarketEscrowContract` `3226` + `GetMarketEscrowListingId` `3291`,
  `BuildProxyVerificationScript` `15530`, `GetPendingPlatformAccountOwnerRotation`
  `17060`, `IsUnsignedIntegerWithinBytes` `10960`, and `isOwnerOnlyRecovery`
  alone makes four calls (`7164`, `2986`, `3117`, `isExecutionActive` `7396`).
  The lane binds exactly one shared callee per getter, so these need
  multi-callee composition before any proof can be written — a structural
  extension, not another table row.
- `getAccountIdByProxy` is the only call-free one. It fails on
  `Expected exactly one cast width witness`: its nullable `UInt160` read carries
  the `DUP / ISNULL / SIZE / JMPEQ / THROW` guard as well as the cast, so the
  `direct` family's single-witness assumption does not cover it. It also needs an
  inline key concatenation and a tolerated leading `ExecutionEngine.Assert`.

So the read-only entries are one multi-callee extension plus several cast-witness
shapes, not eleven independent one-liners. Anyone scheduling this should price it
as lane work first and entry work second.
