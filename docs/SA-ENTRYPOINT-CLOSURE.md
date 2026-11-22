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

The aggregate gate in [SA-CLOSURE-GATE.md](SA-CLOSURE-GATE.md) reports which
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

### The same graph, with arguments

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
  prove refinement from the NEF bytes and the reviewed debug mapping for all 81
  entrypoints. The existing lanes already work this way — they decode the pinned
  script and never trust the source for semantics — so this route is reachable by
  repetition rather than by a new theory. It yields a *weaker* statement about the
  source (bytecode matches a spec; the mapping from C# to those bytes is assumed)
  and a stronger one about the artifact.

Neither route is something the current evidence can shortcut, and switching to
Route B is a change to what the certificate asserts, so the boundary text in
`SA-FORMAL-VERIFICATION.md` and the gate's `boundary` string would have to move
with it. Until that decision is recorded, the honest status stays
`NO-GO` with `fullyClosed: 0` regardless of additional body work.

### The fourteen read-only entries are not a cheap win

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
