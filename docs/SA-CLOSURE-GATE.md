# Integrated refinement closure gate

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
See `SA-FRONTEND-CORRESPONDENCE.md`.

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
[`sa-closure-gate-20261117.json`](reports/sa-closure-gate-20261117.json). It
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
fresh artifact (currently NEF `9f714866…`). The reviewed five-shape capture
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
[SA-ENTRYPOINT-CLOSURE.md](SA-ENTRYPOINT-CLOSURE.md).

The join function is an internal check of freshly executed results; it is not an
API for authenticating arbitrary user-supplied receipt JSON. The CLI does not
accept old proof receipts as substitutes for new invocations.
