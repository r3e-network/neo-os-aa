# SA — Source front end and compiler correspondence

```json
{"scope": "source-frontend-and-compiler-correspondence",
 "crossCheckPerformed": true,
 "agreesOnCorpus": true,
 "corpusFiles": 22,
 "corpusTokens": 19486,
 "corpusMethods": 109,
 "anchorFragments": 1291,
 "anchorDivergentAcceptance": 0,
 "needleLiterals": 648,
 "needleBelowAnchorFloor": 133,
 "needleDivergent": 0,
 "abiDispatchMethods": 109,
 "abiDispatchOnDeclaredOffset": 107,
 "abiDispatchReservedRefused": 2,
 "abiDispatchMismatches": 0,
 "abiReturnShapesChecked": 42,
 "abiReturnShapeMismatches": 0,
 "abiReturnNulls": 0,
 "abiDispatchReturnTypesUnexercised": ["Any", "Array"],
 "abiSemanticsMeasured": false,
 "abiBoundaryProbes": 408,
 "abiBoundaryProbeSetMatches": true,
 "abiBoundaryControls": 109,
 "abiBoundaryControlsEntered": 107,
 "abiBoundaryControlsRefused": 2,
 "abiBoundaryArityProbes": 202,
 "abiBoundaryArityRefused": 202,
 "abiBoundaryOverloadProbes": 2,
 "abiBoundaryOverloadLandedOnSibling": 2,
 "abiBoundaryTypeProbes": 94,
 "abiBoundaryTypeEntered": 94,
 "abiBoundaryTypeCompleted": 7,
 "abiBoundaryShapeEnforced": false,
 "abiBoundaryAbsentNameRefused": true,
 "abiBoundaryBehaviourProven": false,
 "footprintMethodsCompared": 107,
 "footprintEnteredByteMethods": 362,
 "footprintOutsideStaticClosure": 0,
 "footprintUnownedOffsets": 0,
 "footprintReachableNotEntered": 634,
 "scenarioFiles": 4,
 "scenarioSteps": 228,
 "scenarioStepsOnDeclaredArguments": 228,
 "scenarioStepsAtDeclaredBlockTime": 228,
 "scenarioEntrypointsNamedByAStep": 88,
 "scenarioEntrypointsCalledThroughACaller": 6,
 "scenarioEntrypointsReachedThroughPluginCallbacks": 1,
 "scenarioEntrypointsUnreached": 14,
 "scenarioFaultsAsExpected": 42,
 "scenarioReturnNulls": 2,
 "scenarioReadLinksHeld": 38,
 "scenarioDistinctBlockTimes": 24,
 "scenarioTimeSensitivePairs": 14,
 "scenarioModulesDeclared": 10,
 "scenarioModulesDeployed": 10,
 "scenarioStepsOnModules": 28,
 "scenarioReturnTypesExercised": ["Any", "Array", "Boolean", "ByteArray", "Hash160", "Integer", "String", "Void"],
 "returnTypesUnexercised": [],
 "declaredArgumentCallsMeasured": 228,
 "declaredArgumentBehaviourProven": false,
 "executionSemanticsMeasured": false,
 "strictReaderConfirmedFiles": 22,
 "frontEndConfirmedFiles": 22,
 "knownFrontEndGaps": 0,
 "remainingGapSlicedByAnyLane": false,
 "anchorOccurrencesMoved": 0,
 "uniqueAnchorsMoved": 0,
 "grammarProven": false,
 "compilerCorrespondenceProven": false,
 "deploymentPathVerified": false,
 "implementationVerified": false,
 "fullImplementationVerified": false}
```

Every projection lane reads its pinned C# with one shared tokenizer and slices
method bodies by counting braces over that token stream. Those two functions sit
under every anchor and every field the refinement lanes read: if the front end
reads a file differently than the pinned source means, each downstream receipt is
still internally consistent and still wrong. That is why
`SOURCE_FRONTEND_AND_COMPILER_CORRESPONDENCE` is the largest single item in the
trusted base.

This page describes what the project now has for that item, and — at least as
importantly — what it does not have.

## What was built

A second reader, `formal/refinement/frontend_correspondence.py`, written as a
character state machine that shares no code with the scanner the lanes use: it
walks the file one character at a time, keeps literals opaque by scanning to the
closing quote, and counts braces on the resulting pieces. The front end is not
copied into it. What is read out of the seven lane modules that are supposed to
share one reader is the *declaration* that names it, and the seven are required
to name the same one before anything is compared:

| Reader | Modules | Status |
| --- | --- | --- |
| `csharp_tokens.TOKENIZER` | `abi_admission_source`, `contract_handoff_source`, `entry_dispatch_source`, `exception_identity_source`, `interop_convert_source`, `interop_fee_source`, `syscall_dispatch_source` | one declaration, verified at run time, then loaded and executed |
| private tables | `gas_proofs`, `runtime_collection_source`, `runtime_source` | named in the receipt, not merged |

The last three are named rather than quietly treated as the same reader. Their
lanes read a narrower character set, so they are outside these faces; that is a
scope limit of the harness, not a property of the tables, and the receipt says
which modules it covers and which it does not.

Reading a declaration is weaker than reading a table, and the substitution is
deliberate: the algorithm is no longer a string that a harness can reinterpret,
so the algorithm is what the compiler faces measure, while the declaration
census measures only that the seven lanes still agree about which reader they
use. Both facts are needed and neither replaces the other.

## The faces, in increasing strength

The first thing this work produced was a negative result about the obvious
comparison. Joining tokens is concatenation, so

```
normalize("a == b")  ==  normalize("a = =b")  ==  "a==b"
```

Equality of normalized text therefore proves exactly one thing: that both
readers dropped the same characters, which is whitespace and comments and
nothing else. It cannot see a boundary drawn in the wrong place. So the harness
compares five faces and says which is which:

| Face | What it can see | Measured (gate 29) |
| --- | --- | --- |
| `normalize` | the set of dropped characters | 22 files, 0 mismatch |
| `tokens` | a boundary drawn in the wrong place | 19,486 tokens, 0 mismatch |
| `bodies` | the brace that ends a method | 109 methods, 0 mismatch |
| `anchors` | whether the fragments the lanes name are accepted and joined the same way | 1,291 fragments, 0 divergent |
| `needles` | the same, for the short literals the projection code reads a field with | 648 fragments, 0 divergent |

The body face is the one the lanes actually depend on, and the header for each
method is taken verbatim out of the file by the independent span index, so both
readers receive the same bytes rather than the same intention.

The fourth face is aimed at what the lanes actually do with the text. Each lane
declares anchors — statement fragments quoted out of the pinned source — and
requires each to occur exactly once before it reads a field. If the two readers
joined a fragment differently, the anchor would land somewhere else and every
field after it would be read out of the wrong place. So the harness parses the
nine lane modules (parses, never imports: importing one can start a download)
and takes every string constant of at least ten characters: 1,291 fragments.
Both readers accept 1,189 of them, both refuse 102, and neither accepts one the
other refuses — a divergence of zero. 397 of the accepted fragments occur in the
corpus and 378 of those occur exactly once, which is the same uniqueness the
lanes require before they trust an anchor.

The 102 refused fragments are the interesting half of that number. They are
refused by *both* readers, because they contain a character neither reader has —
a backslash, most of them, from the one lane module that stores a regex. A
refusal on both sides is not agreement about meaning, it is agreement about
scope, and the harness counts it separately rather than folding it into the
successes.

Two independent measurements, same reader, different corpora:

| Corpus | Files | Tokens | Methods | Mismatch |
| --- | --- | --- | --- | --- |
| the six lane mirrors kept locally | 26 | 20,151 | 117 | 0 |
| the seven `source` directories gate 28 left behind | 22 | 19,486 | 109 | 0 |

### The floor the anchor face had

Ten characters is a hole. A lane does not read a field by quoting a sentence; it
reads it with whatever literal sits in the projection code — `if(verify)`,
`returnnull;`, `_=x.ToDictionary(...)` — and then asks `needle in text` or
`text.count(needle) == 1`. A needle of seven characters still decides which
region of which file the lane believes it is looking at, and the anchor face
could not see it at all.

So a ninth module read the same way, with no length floor: every non-empty string
constant inside the lane modules' *function bodies*, minus the eight functions
that are plumbing rather than projection — `body`, `canonical`, `download_pinned`,
`mirror_source`, `normalize`, `require`, `sha`, `source_url`, which pin a URL,
hash bytes, look up a name or slice a body. The excluded names are printed in the
receipt, and a unit test refuses the set if a name stops existing, because a
rename must not quietly widen the filter.

That is **648 fragments, 133 of them shorter than the anchor floor**. Each is
asked the same three questions the anchors get, plus a third that only a short
needle needs: do the two readers find it the same number of times in each corpus
file? 584 are readable and 64 are refused by both readers — numbers that depend
on the fragment, not on the corpus, so both corpora report them identically. 200
needles occur in the corpus (`168` of them exactly once in the 26-file local
mirror, `165` in the 22 files gate 29 left behind). Neither reader accepts a
fragment the other refuses, no fragment is joined differently, and no fragment is
counted differently: **divergence of zero on all three questions, in both runs.**

A zero means nothing without the control. The control is a front end that is
right on every long fragment and wrong on short ones: it drops `(` from anything
shorter than ten characters. The anchor face reports zero problems — it never
looks that small — and the needle face reports one join divergence on the first
needle. That is `test_a_defect_in_a_short_needle_is_invisible_to_the_anchor_face`,
and it is the reason this face exists.

One honest bound on what it adds. If the token face agrees on a file, every
substring lookup on that file agrees too, so the needle face says nothing new
about whole files — the count question is implied by work already done. What it
adds is the fragment side: 133 short strings, near the top of every lane's
projection, that nothing else in the run looked at before. And the gate refuses a
needle face that finds no needle, because agreement on an empty question is not
agreement.

## What the corpus does not carry

A census records which token classes the corpus actually spells, because an
operator no file contains is not evidence of anything. Every operator in the
table is spelled at least once; the rarest are `--` (1), `%` (3), `^` (3), `~`
(3), `&` (4), `<=` (4), `++` (7). That much is genuinely exercised.

The hazard the body face exists for is not. A reader that counted braces without
honouring literals would still agree on this corpus, because the only braces
inside literals are interpolated-string holes, which are balanced and therefore
cancel. Two literals in the corpus have unbalanced braces, and both come from
the same real construct:

```csharp
return $"[{string.Join(", ", _innerList.Select(p => $"{p.Type}({p})"))}]";
```

That line is upstream `neo-vm` at `004cd6070a940405818d9357638277dd44407e2e`,
`src/Neo.VM/EvaluationStack.cs` — the mirrored bytes hash to the same
`7190a363…` as the file fetched straight from the repository, so the mirror is
not the source of the oddity. C# lexes the quotes inside an interpolation hole
as a nested string literal; both readers of that era split the literal at the
inner quote, and they split it in exactly the same place.

An earlier draft of this page said the projection was unaffected "because a
split literal keeps every character". That was wrong, and the C# lexer showed
it. The table read `string.Join(", ", …)` as: `$"[{string.Join("` ends the
first literal, the separator's own `,` is emitted as an operator, its content
space is dropped as whitespace, and the separator's closing quote opens the
next literal. The joined text was one byte shorter than the source, and the two
readers agreed on the shorter text. Agreement between two readers cannot see
this; only an authority outside both can.

## The C# lexer itself

So there is a third reader, and it is not one of ours: `SyntaxFactory.ParseTokens`
from Microsoft's Roslyn, run over the same corpus with all trivia dropped and
the token texts joined the way the lanes join them. Two facts came out, and the
second is what makes the item measurable rather than self-referential:

On the gate's own corpus the same comparison read, at the time (gate 24):

| Comparison | Result |
| --- | --- |
| whole-file joins, regex front end vs the C# lexer | 22 files compared, 20 identical, 2 differ |
| lane anchors found by the front end, and also found by the C# lexer | 397 of 397, 0 divergences |

The dump is not a new tool. `formal/refinement/export` already carries Roslyn,
is rebuilt by every gate run, and its compiler package is audited by hash, so a
second mode was added to it:

```sh
dotnet export/bin/Debug/net10.0/RefinementExport.dll --token-dump /path/lexer-tokens.json
```

and the gate calls it after the lanes finish, beside the correspondence
receipt. No new project, no new package, no new network dependency.

The two differing files were identified, and neither was a mystery:

- `vm-stack.cs` — the interpolated-string hole above, one content character
  lost. The regex table could not model interpolation because a hole needs
  nesting, and the shared table was a single regular expression.
- `vm-engine.cs` — 214 characters that the front end read and the compiler did
  not, because `strip_directives` removed the `#if VMPERF` line but kept the
  disabled body, while the lexer drops the whole region.

Both were real defects in the front end, and both were outside every fragment a
lane names: all 397 anchors a lane located were located by the C# lexer at the
same count, on both corpora measured. That is the line this page draws — the
front end must agree with the compiler on everything a lane reads, and it does;
text no lane reads is not allowed to hide a defect either, which is why both were
fixed rather than only measured.

Neither defect was excused while it lasted: the harness carried a reader the
compiler confirms, so the size of each was a measurement rather than an estimate,
and the difference between "we lost a character somewhere" and "we lost a
character in text no lane reads" was a number in the receipt.

## A reader the compiler confirms

`strip_directives` drops the `#` lines and keeps the bodies, which is the reading
a reader *without* conditional semantics is forced into. The compiler is not
forced into it. So the harness carried a second reader — `strict_spans` and
`active_text` — that reads an interpolated literal as one token with its holes
inside it, and evaluates the directive conditions instead of dropping them. It
was not the reader the lanes used; it was the reader they were judged against,
and it was only allowed to judge once it had reproduced the lexer everywhere:

| Comparison | Result (gate 27) | Result (gate 28) | Result (gate 29) |
| --- | --- | --- | --- |
| strict reader vs the C# lexer, joined text | 22 of 22 identical | 22 of 22 identical | 22 of 22 identical |
| front end vs the C# lexer, joined text | 21 of 22 identical, 1 differ | **22 of 22 identical** | **22 of 22 identical** |
| lane anchors, read by the strict reader | 397 checked, 0 divergent | 397 checked, 0 divergent | 397 checked, 0 divergent |

Gate 29 is the same corpus with the seventh face added, and it moved no other
number: 22 files, 19,486 tokens, 109 methods, 1,291 anchors, 0 divergences on
every face, `knownGaps` empty, and the receipt's own hash recomputes from its
contents.

The first row is what licensed the second. Rows one and two together were the
shape of the finding: a reader existed that joined exactly what the compiler
joins, and the front end was not it, on two named files — then on one. Now the
two rows agree, which is why the front-end column of `knownGaps` is empty.

The reason for each difference was computed, not guessed — each remedy was
applied on its own and compared with the lexer, so a file that needed both said
`both` and a file that needed neither said `unclassified` rather than being
forced into a category. Now that the string rules are no longer in dispute there
is one remedy left to switch: whether a directive is evaluated or merely
dropped, and the classifier only blames it when the two readings actually differ:

| File (gate 27) | Bytes | Cause |
| --- | --- | --- |
| `vm-stack.cs` | front end 4,000 / lexer 4,001, first difference at 3,950 | `interpolation-hole` |
| `vm-engine.cs` | front end 4,004 / lexer 3,790, first difference at 1,615 | `disabled-region` |

Both defects are also kept in executable form, so the receipt carries a
reproducer rather than a story, and the gate requires both to agree:

| Reproducer | Front end joins | Compiler joins |
| --- | --- | --- |
| `$"[{string.Join(", ", items)}]"` | `$"[{string.Join(", ", items)}]"` | same |
| `#if VMPERF` / `Hidden();` / `#endif` / `Visible();` | `Visible();` | same |

### The one number that used to be non-zero

One named fragment did move: `CurrentContext` occurred 13 times in the front
end's reading of `vm-engine.cs` and 10 times in the compiler's, because the
disabled `#if VMPERF` block mentions it three times. It was reported under
`knownGaps` with both counts, and it was reported as *ambiguous* rather than as a
moved location — the distinction is the point, because a fragment that occurs
more than once locates nothing. `anchorsAffected` was 1 and
`anchorsAffectedUnique` was 0, and the rule the gate enforces is that a fragment
unique on either side is a location that moved.

No lane names `CurrentContext` by itself; it appears inside longer anchors such
as `ExecutionContextStatestate=CurrentContext!.GetState<ExecutionContextState>();`,
and those were never affected. With the region read correctly the counts agree
and both numbers are 0.

### The first of the two, fixed

The `#if` half was fixable, and it is fixed. `strip_directives` — the name two
lanes carried, and the harness mirrored — now lives once, in
`csharp_directives.py`, and evaluates the condition instead of dropping the line
and keeping the body. The lanes do not import the harness: the measuring
instrument must not be the thing being measured, so there are two copies of the
rule and a test that they agree on a battery and on the whole corpus.

The proof that this was safe came before the edit, and it came from the lane's
own projection rather than from text statistics:

| Lane | `program` (the claims) | `methods` (the recorded bodies) |
| --- | --- | --- |
| `exception_identity` | identical | `executeNext` 749 → 577, `onFaultVm` 64 → 22 |
| `abi_admission` | identical | identical (no conditional region in its files) |

Both changed bodies are the `VMPERF` tracing regions, which print and assign no
state — which is exactly why no field moved, and exactly why the text had to be
read correctly rather than conveniently. `sourceHashes` still hash the raw
bytes, so the pins are untouched.

After the change the front end joins 25 of 26 files identically, `knownGaps` has
one file in it instead of two, and `anchorsAffected` is 0. The list of gaps is a
frozen constant in the gate, so retiring one is a deliberate edit with a
comment; the interpolation hole in `vm-stack.cs` stays, because it needs a lexer
that tracks nesting, not a reader that evaluates conditions.

### The second one, also fixed

`vm-stack.cs` was the harder half, and the reason was structural: the shared
tokenizer was a single regular expression, and a hole is an expression that can
contain quotes. Fixing it meant replacing that expression in all seven canonical
modules, which is the thing every lane slices bodies with — so it was measured
before it was done, not after.

`csharp_tokens.py` is that scanner, and the measurement is threefold. First, the
token streams: on the pinned corpus, `25 of 26 files are token-identical`, four
files with directives are refused by both (the lanes read directives first), and
exactly one differs — `vm-stack.cs`, where 14 tokens become 1.

Second, the projections, which is what actually matters. Each lane was run twice
over the same mirror — once with its own table, once with `TOKEN` rebound to the
scanner — and the two reports compared as canonical JSON:

| Lane | `project_production` | `project_captured` | controls applied | identical |
| --- | --- | --- | --- | --- |
| `abi_admission` | identical | identical | 54 | yes |
| `contract_handoff` | identical | identical | 42 | yes |
| `entry_dispatch` | identical | identical | 24 | yes |
| `exception_identity` | identical | identical | 32 | yes |
| `interop_convert` | identical | identical | 36 | yes |
| `interop_fee` | identical | identical | 32 | yes |
| `syscall_dispatch` | identical | identical | 26 | yes |

246 controls in total, all with the same verdict, and the 12 controls a lane
refuses it refuses identically both ways. Third, the blast radius in files: of
the three lanes that pin `EvaluationStack.cs`, none takes a method body out of
it, and `sliced_files()` is what recomputes that:

| Question | Answer |
| --- | --- |
| lanes that pin `EvaluationStack.cs` | three: `contract_handoff`, `entry_dispatch`, `syscall_dispatch` |
| lanes that take a whole method body out of it | none |
| lanes that read it at all, and how | `entry_dispatch`, by `text.count(needle) == 1` on raw bytes |

The last row is why the token stream of that file was never load-bearing for a
field: a needle count reads the file's bytes, not its tokens. The gate recomputes
the claim from the modules rather than trusting this paragraph:

```python
require(not frontend_receipt['knownGaps']['slicedGaps'], ...)
```

`slicedGaps` is computed by parsing the lane modules for `SOURCES`, `SIGNATURES`
and a `body()` slicer, so it moves if a lane ever starts slicing that file. A
module with no slicer is named in `lanesWithoutBodySlicer` rather than counted as
checked, so an empty result cannot be a silent skip.

### What the gate now requires

- the strict reader reproduces the C# lexer on **every** file, not only the
  convenient ones;
- the front end reproduces it on every file too — the row that used to be
  `25 of 26` and is now `26 of 26`;
- `anchorsAffectedUnique` is zero;
- the needle face is not empty: it has to report fragments, readable fragments and
  fragments below the anchor floor, or a run that compared nothing would pass;
- no gap lands in a file any lane slices bodies from;
- the file set in `knownGaps` equals `KNOWN_FRONT_END_GAPS`, which is now **empty**.

The last one is frozen in both directions, deliberately, and it has been emptied
twice by hand. A run that gains a gap has a new defect and has to say so; a run
that closes one has improved the front end, and editing that list is how the
improvement gets recorded. A pinned list that can silently shrink is not pinned —
which is exactly why it was not allowed to shrink on its own when the scanner
landed.

The rest of the hazard is carried by a self-test: thirteen checks, of which
seven confirm the independent reader on constructed snippets and six confirm
that a literal-blind reader gets a *different* answer on the snippets where a
blind reader can. Without that second half, a run of zero disagreements could
not be distinguished from a harness that compares nothing.

## Three facts this work forced

**Token classes versus boundaries.** The lanes consume the joined string, not
the token list. That makes `normalize`-equality the exact property they need,
and makes the token face strictly stronger than necessary — which is the right
direction to be wrong in, but it has to be stated, because a reader could agree
on all three faces and still not be a C# parser.

**One reader, seven declarations.** The front end used to exist as seven literal
copies of a regular expression; it is now one scanner that seven modules name on
one line each. `canonical_reader()` reads all seven declarations and refuses to
compare anything if they disagree, then loads and runs the reader they name. A
lane that quietly stops sharing it fails the correspondence check rather than
silently projecting differently.

**A gate failure, not a warning.** The receipt is recomputed on every gate run
from the pinned C# the lanes just downloaded, and a mismatch fails the run. The
check is `correspondence.agrees(frontend_receipt)`; there is no path that logs a
disagreement and continues.

**The measurement had to survive the fix.** Removing the defect did not remove
the faces: `normalize`, `tokens`, `bodies`, `anchors` and `needles` still compare
the front end against a reader written separately from it, and `lexer`, `strict`
still compare it against Microsoft's. What disappeared is the column of excuses. A
harness that only knew how to say "this is expected" would have nothing left to
say once nothing was expected — which is why the gap list is a frozen constant
and not a filter.

## The other half was already there

The item's name joins two things, and it is worth separating them because they
are established by different mechanisms at different strengths:

| Leg | What establishes it | Strength |
| --- | --- | --- |
| C# project -> NEF bytes | `formal/refinement/export` recompiles `SmartAccount.cs` (retired custom kernel)proj` with the pinned NCCS 3.9.1 and requires `File.ReadAllBytes(compiled).SequenceEqual(pinnedNefBytes)`, plus `JsonNode.DeepEquals` on the manifest | byte identity, every gate run |
| C# text -> what the lanes read | this harness | agreement between two independent readers on a measured corpus |
| ABI -> what a real engine dispatches | `export --abi-dispatch` plus `abi_dispatch.py` | 107 of 109 entries dispatched onto the declared offset, the two engine entry points refused by name |
| C# semantics -> VM semantics | still nothing beyond the dispatch path, and nothing here claims it | open |

The first leg is stronger than the second and predates it. `verify.py` builds
`export/RefinementExport.csproj` and runs it inside the gate's `base` step, so
every invocation recompiles the contract from source and refuses a single byte
of difference; the compiler's own assembly bytes are compared against the
audited `.nupkg` entries, and the package hash is a constant in the exporter.
The projection lanes therefore never had to trust that the text and the artifact
were related — the exporter checks it.

What was missing was the middle leg. The lanes read the text with a tokenizer and
a brace counter, and nothing checked that reading against anything. That is what
this harness adds, and it is the only leg where the check is agreement rather
than identity.

## The artifact, run by a real engine

Everything above is about text. None of it says that the compiled bytes mean what
the lanes read out of C#, which is why the middle leg of this trust item used to be
"agreement about text" and the third leg "nothing".
`ACTUAL_VM_APPLICATION_ENGINE_ABI_DISPATCH` is that third leg, and one part of it
is now measured rather than assumed.

A new exporter mode — `--abi-dispatch FILE --nef … --manifest …` — deploys the
pinned NEF into a real `ApplicationEngine` (Neo 3.9.1, the assemblies the compiler
ships: `Neo.dll`, `Neo.VM.dll`, `Neo.SmartContract.Testing.dll`), then calls every
ABI method by name with the arity the manifest declares, single-steps the call,
and records for each method:

- the offset the engine entered (`firstIps[2]`, the first instruction of the callee);
- whether the instruction at the declared offset was executed at all;
- the final state and the fault message;
- the syscalls the contract reached, in order, resolved from the interop table.

`abi_dispatch.py` then asks six questions of that measurement, and only six:
the dump covers exactly the manifest's methods (same count, same name/arity set);
the entered offset equals the declared one, for every method that is not an engine
entry point; the declared offset's instruction actually ran; `_deploy` and
`_initialize` — which the engine invokes itself and refuses to dispatch by name —
were refused, which is recorded as a fact about the engine rather than as an
excuse; the value the call left on the stack has the shape the manifest declares;
and — the sixth, added after the first five were closed — the calls the manifest
does *not* describe are refused at the boundary, or land where the manifest says
they should. That sixth question is the section below this one.

| Question | Result on the pinned artifact (gate 32) |
| --- | --- |
| methods measured | 100 of 100, name/arity match the manifest |
| dispatched onto the declared offset | 98 |
| engine entry points refused by name | 2 (`_deploy`, `_initialize`) |
| declared offset executed | 98 of 98 dispatched |
| ended `HALT` / `FAULT` | 39 / 61 — the faults are zero-argument faults, not dispatch failures |
| returned shape matches the declared type | 39 of 39 completed calls, 0 mismatches |
| syscalls observed | 355, every one resolved by the interop table |
| lazy initializer invocations | 98 (the compiler's static-init guard runs `_initialize` from inside each method) |

The current artifact was remeasured on 2026-11-17: 109 of 109 methods matched the
manifest, 107 entered their declared offset, `_deploy` and `_initialize` were the
two refused names, 42 completed calls matched their declared return shape, and 67
faulted on zero arguments. The receipt recorded 399 resolved syscalls and
`receiptSha256: f75e1226fd445b31112003f84f609486cbfbb9d92c8eacc902a72642650a046c`;
its seventeen self-checks all rejected their mutations. The corresponding
footprint is 30,678 bytes / 10,594 instructions, 238 ranges, 362 entered byte
methods all inside the 996-method static closure, 634 reachable methods not
entered, zero unknown, unowned or outside-closure executed offsets — the 887
foreign-script offsets are counted separately, not as owned contract
instructions — and
`receiptSha256: 20833d6456d0cd4ebba05bd0b5356e2e834960063a4f9e0fa2487671baf2d847`.

The fault count is the honest part of that table. A call with `0`/`null` arguments
is not a call the contract was written for, so 61 methods abort in the historical
gate-32 artifact and 67 in the current one; what the receipt establishes is *where
the engine went*, not that the method succeeded. A face that required `HALT` would
have been a face that required a fixture nobody has.

The return-shape rule is measured, not decreed, and the first draft had it wrong.
`System.Contract.Call` pushes the callee's result whatever it is, so a named call
to a `Void` method leaves **one Null item**, not zero: the two void methods that
complete (`cancelUpdate`, `cancelAdminTransfer`) said so, and the rule now maps
`Void -> Any`. The rest of the mapping is the manifest's own vocabulary against the
stack's: `Hash160` has to be a 20-byte `ByteString`, `Hash256` 32, `PublicKey` 33,
`Signature` 64, `Boolean` a `Boolean`, `Integer` an `Integer`, `ByteArray`/`String`
a `ByteString`. A fault must leave nothing behind — a result next to a fault would
mean the measurement describes a different run than the one it reports — and that
holds for all 61.

Two declared types are *not* covered **by this face**, and the receipt says so
instead of counting them as tested: `Any` and `Array` are declared only by methods
that fault on zero arguments (`executeUserOp`, `registerAccounts`, the batch
entries), so their mappings were never applied.
`declaredTypesUnexercised: ["Any", "Array"]` is the line a reader should look at
before believing the return face covers everything. The section after next is the
one that closes it, and the gate refuses to pass until the *union* of the two faces
covers every declared type.

A null return is the one case the manifest cannot express. Neo has no nullability
in its ABI, so the v3 `object[]? GetPendingVerifierUpdate(...)` (removed in v4) still declares `Array`, and
a call with no pending update answers null. Requiring a value there would fail a
correct contract; counting null as a match would let an untested mapping look
tested. The rule is therefore three-valued: a value of the declared type is a
match, null where a reference type is declared is allowed and counted in
`nullReturns` without marking the type exercised, and null where a *value* type is
declared is a mismatch. This was measured, not decreed — the v3 getter
`getPendingVerifierUpdate` (removed in v4) on a registered account is where the shape rule first met a null.

Ten mutations are run against the dump on every invocation — a moved declared
offset, a dispatch landing elsewhere, an entry that never ran, a missing method, a
reserved entry point that claims to be callable, a syscall the engine does not
know, a dump bound to another manifest, a returned value of a type the manifest
does not declare, a completed call that returns nothing where a value is
declared, and a null standing where a value type was promised. Seven more mutate
the boundary probes, below. Each one has to be caught, so a run of zero problems
cannot be confused with a face that compares nothing.

What this still does not establish: that a call with real arguments behaves as
intended, that the C# in `contracts/` means what the opcodes do, or anything
about rollback, gas or exception identity. It says the engine's dispatch and the
returned shapes agree with the manifest on this artifact, which is one layer below
"the source agrees with the compiler" and two below "the implementation is
correct". A matching shape is not a matching value: `getContractAdmin` returning
20 bytes says nothing about which 20.

### The other half of the dispatch rule

Every measurement above describes a call that **matches** the manifest. A dispatch
rule has two halves, and the second — what the engine does with a call the manifest
does not describe — was unmeasured, which is how a face ends up agreeing about the
easy direction only. The same exporter mode now also runs 408 probes that no
manifest would accept, and records what happened without deciding what should
have:

| Probe | Count | What the engine did |
| --- | --- | --- |
| the call the dispatch face makes, re-run | 109 | 107 entered the declared offset; the 2 engine entry points were refused |
| a parameter count no overload of that name declares | 202 | 202 refused before a callee frame existed, 0 entered |
| a parameter count a *sibling* overload declares | 2 | 2 entered — `finalizeEscape/2` at 11096, `finalizeEscape/3` at 11108 |
| a name no method declares | 1 | refused |
| an argument of a shape the manifest says cannot arrive | 94 | 94 entered; 87 faulted inside, 7 answered |

The refusals are not folklore: each carries the engine's own message, and the face
pins it. A parameter count that no overload has comes back as
`Method "computeRegistrationAccountId" with 4 parameter(s) doesn't exist in the
contract 0x…`, thrown by `ContractManagement` before any instruction of this
contract ran — the probe records `entered: false` and a step count in the low tens
against the control's two hundred-odd. A name beginning with an underscore is
refused a step earlier, by name,
`Method name '_deploy' cannot start with underscore`, which is why the arity probes
for the two reserved entries carry that text and not the other. Two different
messages, two different checks, both before the callee — and a refusal that carries
neither is a problem the face reports rather than a measurement it files away.

The two overload probes are the positive half. `finalizeEscape` is declared twice,
at arity 2 and 3, and a call to each count enters a different offset; name alone
would not select, and arity alone would not either. That is the one place in this
artifact where the (name, arity) pair the manifest declares can be shown to be the
pair the engine dispatches on.

The 94 wrong-shaped arguments are the finding, and they are not what the first
draft of this face expected. **Not one is refused at the boundary.** An empty array
passed where a `Hash160`, a `ByteString` or an `Integer` is declared reaches the
callee anyway: 87 of those calls then fail *inside* the contract — 38 with
`Specified cast is not valid` at `StackItem.GetInteger`, the rest on the entry's
own abort (`Account id required`, `Account not found`, `Platform registrar not
set`, …) — and 7 answer normally: the two `supports*` predicates, `computeArgsHash`
(which hashed the empty array it was handed rather than rejecting it), and the four
`can*` guards the scenario layer already measures returning `false`.
So the manifest's parameter types are documentation for tooling, not an admission
rule in this engine. The receipt records `shapeEnforcedAtBoundary: false` and, in
the boundary block's own claims, `boundaryRefusalsAreStructural: true`; inventing
the rule the ABI looks like it should have would have been the wrong kind of
agreement, and the face would have failed a correct artifact for it. Where an
engine *does* refuse a shape, the same counter turns true and the run still passes
— the flag reports which engine was measured, not whether the contract is good.

Seven mutations keep that from being self-congratulation: a probe that went
missing, an arity refusal that claims to have entered, an arity probe relabelled as
an overload, an overload sent to the wrong sibling, a refusal whose reason is the
callee's (`ABORTMSG`) rather than the boundary's, a wrong-shaped argument that
landed elsewhere, and one refused for a reason nobody named. The probe set itself
is recomputed from the manifest — every method's count minus one and plus one,
minus the counts a sibling declares, plus one type probe per non-`Any` first
parameter, plus one undeclared name — so an exporter that quietly stopped emitting
a probe is a disagreement rather than a smaller measurement. Gate 37 is the run
that carries it, and the receipt hash says what moved: the dispatch face went from
`24aac44d…` to `f9429279…`, while the footprint, the lexer face and all four
scenario receipts stayed byte for byte.

### The layer under the dispatch

A dispatcher that lands on the right offset has said nothing about the body it
landed on. A contract can dispatch perfectly and then run instructions no model of
it accounts for, and every question above would still answer "agreement".

`dispatch_footprint.py` closes that gap from the other side. The exporter now also
writes, per method, the **set of instruction offsets the engine executed inside the
contract**, the script bytes it measured against, and the script hash of every frame
depth it entered. A second reader decodes those bytes with this repository's own
independent decoder (`nef_decode.py`, Neo.VM 3.10.1 tables) and confronts the result
with `entrypoint_inventory`'s static model: for each entry point, the set of byte
methods its dependency graph reaches, plus the initializer's closure.

| Question | What it means | Result on the pinned artifact (gate 31, reconfirmed by gate 32) |
| --- | --- | --- |
| bytes | the dump's script decodes to the sha256 both documents claim | 25,620 bytes, 8,833 instructions |
| boundaries | every executed offset is an instruction start of that script | 0 unknown of 1,661 distinct offsets |
| ranges | the inventory's 200 byte ranges partition the script and every executed offset has exactly one owner | no hole, no overlap, 0 unowned |
| reach | the byte methods the engine entered are among those the static graph reaches from that entry | 315 inside the closure, 0 outside |

Across the 98 dispatched calls the engine entered 315 byte methods — a helper
entered by several calls counts once per call — and every one of them is in that
entry's closure. The static closures list 996 members in all, so 634 were reachable
and not entered on this run. That number is reported and is deliberately **not** a
failure: `reachable` is a may-set, it lists every method some path could reach, and
a zero-argument call takes one path. A face that required equality would be
demanding a fixture nobody has, and — worse — would be reporting a disagreement that
does not exist. The direction that must hold is the other one, and it does.

Two details are worth naming because the first draft had both wrong:

- Frame membership is decided by the **running script's hash**, not by stack depth.
  A native contract call pushes its own context, and its instruction pointers are
  numbered from zero in a different script, so a depth rule can credit this contract
  with an offset it never ran. Filtering by hash also keeps the 887 offsets executed
  in other scripts out of the comparison instead of quietly mixing them in.
- "The declared entry ran" is tested against the **offset**, not against the owning
  byte range. An owner set says "this method ran"; the question here is "the offset
  the manifest points at ran". A footprint that starts three instructions into the
  body is indistinguishable to an owner-set test and is a different claim.

Eight mutations run on every invocation, and both sides are mutated on purpose: a
face that only distrusts the dump would pass a closure that forgot a method the
engine demonstrably entered. A mutant that cannot be built on the pair at hand is
recorded as **skipped** and fails the run, because a self test that silently shrinks
to what still fits would certify the input it did not examine. The receipt also
records the largest group of methods with byte-identical footprints; it is 1 on the
pinned artifact, so this is 107 traces and not one trace relabelled 107 times.

What the footprint adds, and what it does not: it says *which instructions were
entered* by a call whose arguments are all zero. It says nothing about the values
those instructions computed, so it cannot turn a `FAULT` into a pass or a pass into
a proof. `fullImplementationVerified` stays `false`.

### The layer under the footprint

Both layers above call every entry once, with arity-matched zeros. That is what
makes them comparable across all 109 entries, and it is also their limit. On the
historical gate-32 artifact cited below, 61 of the 98 dispatched calls stop at
their first argument guard; the current gate must remeasure that count rather
than inherit it. A body that refuses zero and a body that works are
indistinguishable to a face that only ever sends zero.

`abi_scenario.py` sends values instead. A scenario file — reviewed input, whose
sha256 travels in the receipt — declares an ordered list of calls: method, literal
arguments, a named signer, the block time it runs at, the contract the call lands
on, the ending it expects, and which earlier argument a result should equal. The
exporter deploys the pinned NEF into the same engine, signs as the declared
account, and runs the calls in order over one storage snapshot. Both the writes and
the reads that follow them are recorded, which is what lets a consumer confront
"what the engine answered" with "what was written" instead of comparing the engine
to itself.

Eight questions, and each one has a way to fail:

- **encoding.** The frame is rebuilt here from the scenario alone — argument
  pushes in reverse (PACK fills index 0 from the top of the stack), `PUSHDATA1`
  for every byte string because Neo N3 has no `PUSHBYTES` opcodes, `PUSHINT32`
  padded to four bytes for `604800`, and the syscall operand derived from the name
  rather than transcribed — and compared byte for byte with the script the engine
  ran. This is not decoration: the first draft pushed arguments in declared order,
  every call arrived with its parameters rotated, and the register step reported
  the rotation as a missing backup owner. The address in the frame is the one the
  step names, so a step aimed at a plugin is rebuilt against the plugin's address
  and its manifest rather than the account's; a target the scenario does not
  deploy is refused instead of falling back to the account, because a silent
  fallback would report the wrong contract as a return-type mismatch.
- **shape.** Same steps, same order, same ids and methods. A dump that lost a step
  cannot pass by having nothing left to disagree with.
- **time.** Each call ran at the block time the scenario declares for it, and the
  dump says which one. `Runtime.Time` is the persisting block's timestamp, so a
  step that declares a later time is given a block at that time and sees the same
  storage a later transaction would. This is the question that makes the timelocks
  measurable at all: a harness frozen at one instant can show that a call before a
  window refuses, and can never show that the same call at the window succeeds.
- **ending.** Each call ends where the scenario says, and a call expected to fault
  faults with the declared reason. Forty-two of the two hundred and twenty-eight
  steps are expected faults — a timelock that has not elapsed, a proposal that does
  not exist, a recovery that is permanent — so the failing path is measured as
  deliberately as the succeeding one. A fault may also pin a `detail`: the reason
  is what the target script aborted with, the detail is what the host recorded
  underneath it, and pinning both is pinning two different layers. A scenario that
  declared only the generic host message would not be saying which refusal it
  measured.
- **returns.** The declared return type is read from the manifest and judged with
  the same three-valued rule the dispatch face uses, loaded from `abi_dispatch`
  rather than restated, so "the manifest describes what came back" is not decided
  twice in two places. The manifest is the one belonging to the contract the step
  called.
- **values.** The integers, booleans and array lengths the scenario declares are
  the ones the engine produced, and every declared read link holds: thirty-eight
  links tie a result to an argument byte for byte. Among them are the account ids
  derived by a pure function to the identity a later call registers, the backup
  owner, verifier data and metadata URI read back after they were written, the
  escape timestamp stamped from the declared block time, an admin proposed and then
  read back as the admin that took office, and both batch-registered accounts
  reading back the one backup owner the batch was signed by.
- **modules.** A step that lands on a plugin is compared against that plugin: the
  address the engine deployed is the one the scenario names, and the bytes it
  deployed hash to the file the scenario points at, read from disk here rather
  than taken from the dump. The signer is compared too, because a deployed
  contract's address is a function of the NEF, the manifest name *and* the deploy
  signer, and two of those three matching says nothing without the third. A
  plugin the dump reports and the scenario does not declare is a failure, and so
  is one whose address, bytes or signer moved. This question exists because
  `AssertV3Verifier` and `AssertV3Hook` read a deployed manifest rather than a
  source file: the admission check is a claim about an artifact, and an artifact
  claim needs an artifact question.
- **frozen.** A step expected to fault is not what any later step reads, because
  this harness shares one storage snapshot and does not roll a faulting call back.
  Building on a fault would not be a scenario that recovers; it would be one that
  measured a state no chain would have reached. The face refuses it.

Sixteen mutations run on every invocation, on all four files: a call whose bytes
are not the scenario's, a call that ended elsewhere, a call that ran at another
time, a call signed by another account, a fault with another reason, a value the
scenario does not declare, a value that is not what was written, a missing step, a
reordered dump, a value the manifest does not describe, a deployment other than
the one the scenario names, a dump produced from another scenario, a step that
builds on a fault, a plugin deployed at another address, a plugin deployed from
other bytes, and a call aimed at a contract the step does not name. A mutation
that cannot be built counts as a failure rather than as an absence — a self test
that shrank to what still fitted would certify the input it did not examine. One
of them had been passing for the wrong reason and was found that way: it rewrote a
signer with `0x7777…`, which happened to be the signer the first step already had,
so it changed nothing and the face correctly reported no difference. It now picks a
value the row does not carry.

What it measured on the pinned artifact: 228 calls over four files, 186 halted, 42
faults with the expected reasons, 228 of 228 frames byte-identical to the
independent encoder, 228 of 228 at their declared block time and under their
declared signer, 184 returned shapes matching their declaration and 2 nulls where a
reference type was declared, 38 of 38 read links holding, and every declared
integer, boolean and array length matching. Those are the numbers of the gate runs
as well. The first file's receipt is `1b757ffe…` from gate 33, `4593d9c5…` from
gate 34 and `7b58876f…` from gate 35 — the input did not move (its sha256 is
`ecd68d8e…` in all three) and the face grew questions, which is exactly why the
receipt hash is allowed to move and the scenario sha is not. The second file's
receipt is `1411ecce…` from gate 34 and `33093cac…` from gate 35; the third's is
`bced9fbd…`; the fourth's is `c2ad13ef…` from gate 36. Gate 36 snapshotted 128 tool
files, ran 27 jobs with none non-zero, and returned the same `NO-GO` with
`fullUnprovedCount 100`, `verifiedEntrypoints []` and all four obligations open —
while the three older scenario receipts, the dispatch face (`24aac44d…`) and the
footprint (`48556e2a…`) did not move at all. Gate 35 snapshotted 121 tool files, ran
26 jobs with none non-zero, and also returned `NO-GO` with
`fullImplementationVerified false` and `fullUnprovedCount 105`. The two nulls are
named rather than counted:
`read-pending-verifier-update`, `read-pending-hook-update`. The two types the
dispatch face could not exercise are exercised here: `Array` by a batch execution
and by a read-only preview that returned five items, `Any` by a user operation
whose result was the string the self-call returned. `returnTypesUnexercised` is
empty — as a *union* of the five faces, which is why the gate asks for the union
and not for any one face's list. No single scenario covers all eight types: the
roundtrip answers without a fault for `Array`, the windows scenario answers without
one for `Any` and `ByteArray`, the plugin scenario supplies `Array` and `Any`
again from a different direction and leaves `String` to the others, the registrar
scenario leaves `Array` and `String` to the others again, and the dispatch face
alone leaves `Any` and `Array` unexercised. Each face keeps its own non-empty gap:
`['Any','Array']`, `['ByteArray']`, `['Any','Array']`, `['String']`,
`['Array','String']`.

#### Plugins beside the account

The first two files could only measure this contract talking to itself and to the
VM. A third limit is structural rather than temporal: a verifier body cannot run
without a verifier, and the admission check reads a deployed contract's manifest
rather than a source file. Nothing in the first two files could reach
`AssertV3Verifier`, `callVerifier`, `callHook`, `isModuleInstalled` or any of the
pending-module getters, because reaching them requires a plugin contract to exist
in the same engine.

`scenarios/aa-account-plugins.json` deploys four plugins beside the account and
calls into them. Two are the same `MultiSigVerifier` bytes under two deploy
signers, which is what gives a rotation somewhere to rotate to. The two hooks are
different contracts, and having both is the point: `NeoDIDCredentialHook`'s
`ClearAccount` clears its own storage, while `MultiHook`'s calls back into the
core's `clearHookDependencies` unconditionally. This build of the account exposes
that callback, so both two-phase cleanup paths complete:
`call-hook-a-confirmed` and `call-hook-b-confirmed` each halt after the first call
records the pending request and the second executes it after the timelock. Keeping
the pair makes the callback binding visible rather than hiding it behind a single
plugin.

The plugin bodies that execute are real. `call-verifier-confirmed` runs
MultiSigVerifier's `clearAccount` inside the VM, and `call-hook-a-confirmed` runs
NeoDIDCredentialHook's, both after the account has cleared three gates: the
plugin's authorized core is this contract, `Runtime.CallingScriptHash` is this
contract, and the account says the caller is currently its verifier or hook.

The artifacts are pinned by hash and their provenance is recorded, not re-derived.
`plugins/provenance.json` names the compiler (`nccs 3.9.1`, because the NEF header
names it and its code generation decides the bytes), the project file, every source
file that feeds it, and the sha256 of all twelve artifacts.
`plugins/build-plugins.sh` is the recorded build step: it refuses to run against a
different compiler and exits non-zero if any artifact it produces hashes
differently from what the provenance file records. This is exactly the standing
`contracts/bin/public` has for the main contract — a pinned input with a recorded
derivation, not something any run re-derives — and it is not a proof that the
plugins are correct.

#### Callers beside the account

A fourth kind of unreachability is about *who is calling*. The platform-registrar
channel and the market escrow both assert that their caller is a contract the
account recorded: `registerPlatformAccount` and the platform owner rotations check
`Runtime.CallingScriptHash == registrar`, and `enterMarketEscrow`,
`cancelMarketEscrow` and `settleMarketEscrow` check it against the market. No step
aimed at the account can satisfy that, because a step's caller is the transaction's
entry script.

`scenarios/aa-account-registrar.json` deploys the other party instead of a plugin.
Three of the six artifacts it installs are neither plugins nor under test: the
AAPlatformRegistrar service contract, driven as its own admin so its calls reach
the account through the registrar gate, a forwarder with a blanket permission
that lets the market's own calls come from a contract, and a paymaster. All six are pinned by hash the
same way the plugins are, and the receipt compares address, bytes and deploy signer
for each — a claim about who called the account is a claim about an artifact, so it
gets the artifact question.

What that reaches: the registrar is proposed and confirmed the way the contract
requires (seven days, admin witness), the platform accounts are registered by the
mock and then read back through `getAccountIdByProxy` against their proxy script
hash, the owner rotation is proposed, refused before its window, cancelled, refused
again for having nothing pending, proposed again and confirmed by the new owner's
witness; the escrow is opened over three listings by the market and then driven
through both exits — the owner's timelocked force-cancel and the market's cancel
and settle. Those six entries execute inside the account and are evidenced by
the state they change rather than by a step landing on them, which is why the
status block counts them separately from the 88 a step names directly. One
further entry, `clearHookDependencies/1`, is reached by a plugin callback:
`MultiHook`'s `clearAccount` calls back into the core unconditionally, so the
two-phase cleanup path runs even though no step names the entry.

Fourteen entries are still unreached and are declared as such rather than counted:

- `_deploy/2` and `_initialize/0` are in the manifest ABI and cannot be called at
  all. `System.Contract.Call` rejects any method name beginning with an underscore
  before the callee runs a single instruction — the run recorded the host's own
  message, `Method name '_deploy' cannot start with underscore`. They are the
  platform's deployment hooks. A scenario that "covered" them would be measuring
  the engine's argument check and calling it coverage.
- Twelve further entries no current scenario drives: the account freeze lifecycle
  (`freezeAccount/1`, `unfreezeAccount/1`, `isAccountFrozen/1`), the dependency
  configuration writers (`setHookDependencies/2`, `setVerifierDependencies/2`,
  `clearVerifierDependencies/1`), the child-hook forwarder `callHookChild/4`,
  the simulation read `simulateValidation/2`, and the reads `describeAccount/1`,
  `getPlatformAccountBinding/1`, `isMarketService/1` and
  `isUserOpExecutionActive/0`. Each is an ordinary authorised entry the scenario
  files simply do not call — a coverage statement, not a defect — and the gate
  counts them as unreached rather than papering over the gap.

`cancelPlatformRegistrar` is a successful control in the current artifact. At the
configured timelock it deletes the pending proposal and timelock and emits the
32-byte `PlatformRegistrarCancelled` event. The former 34-byte event name was
corrected, and the scenario now requires `HALT` rather than recording a host
fault.

#### The other side of every window

The second file exists because of a structural limit in the first. Everything the
contract protects with a delay — a contract upgrade, an admin transfer, an escape
cooldown, an escape timelock, a batch owner registration — is a comparison against
`Runtime.Time`. One declared block time can only ever reach the refusing side of
those comparisons, so the first file contains four faults of the shape "not yet"
and no success at the end of any of them. That is half a rule measured twice.

`scenarios/aa-account-windows.json` declares a time per step: nine of them, each
placed one millisecond before a boundary and then exactly at it. Four pairs are
the same call with the same arguments at two different times ending differently —
admin-transfer confirmation, escape initiation against the cooldown, escape
finalization against the timelock, and the same finalization on a batch-registered
account driven all the way to permanent recovery. Nothing else in the receipt can
produce that pair, so the gate treats "more than one block time declared and no
call whose ending depends on one" as a failure rather than as a pass: a dimension
that was declared and not measured is a dimension the receipt would otherwise
count as covered.

Two things about the contract are only visible from the succeeding side, and both
were discovered by getting them wrong first. `finalizeEscape(id, 0x0)` and
`finalizeEscapeToOwner(id)` are not the same operation: the first clears the
verifier and the hook and returns the account to backup-owner mode, the second also
marks it permanently owner-only. The first draft of this file expected the account to report
"owner-only recovery" after the verifier-returning call; the engine said false, and a later
`finalizeEscapeToOwner` reported `Escape not initiated` rather than `Already recovered`.
Both expectations were corrected against the engine and
the file now drives one account each way. The other is that `registerAccounts`
takes verifier parameters per account, which is what makes two ids distinct under
one backup owner — the batch registers two accounts with `01` and `02` and reads
the same backup owner back from both.

What it does not do: the four files together say nothing about 14 of the 109
entries — `_deploy/2` and `_initialize/0`, which the engine refuses to invoke
through `System.Contract.Call` at all, and the twelve operational entries listed
above that no scenario step drives — and nothing about argument values outside
these files, and nothing about a second call sequence over the same state. It also
cannot prove the *choice* of what to call is meaningful — a scenario of trivial
getters would satisfy every question above while measuring nothing worth knowing.
The non-vacuity floors in the gate (halted, faulted, distinct methods, read links, a
shape check for every halted call, a time-sensitive pair whenever more than one
block time is declared, and — for a scenario that declares modules — a deployed
address, an artifact hash, a signer and at least one step that landed on one) bound
that, but they bound it, they do not remove it.
`fullImplementationVerified` stays `false`.

## Still open

- The grammar is not proven. What exists is agreement between three readers —
  two of ours and Microsoft's lexer — on a measured corpus, plus a self-test
  that the harness can see a difference. Agreement between two of our readers is
  not a theorem about C#; agreement with the C# lexer is a measurement, and it is
  scoped to the fragments the lanes name.
- Compiler semantics are untouched by all of the above. Byte identity says the
  compiler is deterministic and that the artifact is the artifact; it says
  nothing about whether the C# in `contracts/` means what the opcodes emitted
  for it do. The VM side is addressed by the separate VM lanes, not by this one.
- The corpus is the pinned sources the lanes load, not the whole of `neo`. Files
  no lane reads are not covered, and the receipt names the mirrors it used so
  that cannot be mistaken.
- The scanner reads the character set the corpus spells, and three shapes are
  outside it: a C# 11 raw string literal (the scanner reads `"""` as an empty
  string followed by another literal), a `U+`-escaped identifier, and any
  character outside the operator and single-character sets, which is *refused*
  rather than skipped. None appear in the pinned corpus — if one appeared, the
  front end would differ from the lexer on a whole file and the gate would say
  so, because a gap is a new file name in `KNOWN_FRONT_END_GAPS` and that list
  is empty.
- Three modules still keep their own narrower tables — `gas_proofs`,
  `runtime_collection_source`, `runtime_source` — and the faces on this page do
  not measure their readers. They are named in
  `sharedReader.privateTableModules`, so the scope limit is in the receipt rather
  than in someone's memory, and narrowing that gap is separate work.
- The preprocessor is evaluated with an empty symbol set, which matches a lexer
  with nothing defined. If the real build defines `VMPERF`, the compiler saw the
  other branch of that region. The receipt prints `symbols: []` so the
  assumption is visible instead of implied, and a build that defines something
  would need the set passed in on both sides.
- The needle face asks whether both readers see the same string in the same place
  the same number of times. It does not ask whether the lane looked in the right
  file: a needle that occurs exactly once in the wrong file satisfies it, and only
  the lane's own pinning stands against that. It also reads only the projection
  functions of the nine modules it parses, so a needle kept somewhere else is out
  of scope, and the eight plumbing functions it skips are printed in the receipt
  rather than left to memory.
- The footprint says which instructions the engine entered, not what they
  computed. Arguments are all zero, so 67 of the 107 dispatched calls end in
  `FAULT`; the face compares instruction identity and is silent about values.
- The boundary face says which calls the engine refuses and where the accepted
  ones land. It does not say whether a contract *should* have rejected a
  wrong-shaped argument itself: 7 of the 94 entered and answered normally, and
  whether that is defensible is a property of those seven entries, not of the
  engine. The receipt counts them (`boundaryTypeCompleted`) and leaves the
  judgement to whoever reads the entry. It also measures one engine version, so
  `shapeEnforcedAtBoundary: false` is a fact about Neo 3.9.1 as built here.
- The scenario layer answers for the ABI entries it names — with 6 more
  reached through a deployed caller and evidenced by the state they change — and only
  for the sequences in the four files. Every remaining question about behaviour — an
  argument outside these literals, a second read of the same value, a call after a
  fault a real chain would have rolled back, an entry nobody wrote a step for — is
  outside it. The 2 that remain are not a coverage problem to be fixed by writing
  more steps: `_deploy/2` and `_initialize/0` cannot be invoked through
  `System.Contract.Call` at all. `cancelPlatformRegistrar` is now a
  successful control: it completes at its timelock and emits
  `PlatformRegistrarCancelled`, whose name is within Neo's 32-byte limit. So
  `ACTUAL_VM_APPLICATION_ENGINE_ABI_DISPATCH` stays open on the obligation, not on
  the noise: what is missing is semantics — a return shape is not a behaviour — and a
  face cannot manufacture it.
- The plugin artifacts are a pinned input with a recorded derivation, not a
  proof. `provenance.json` says which compiler turned which sources into which
  bytes, and `build-plugins.sh` re-derives them; neither says the plugins are
  correct, safe to deploy, or what a live chain would run. The scenario measures
  that the account admitted the pinned plugins and called into them, including
  both `NeoDIDCredentialHook` and `MultiHook` confirmed two-phase cleanup paths.
  Those are artifact-level controls, not a proof that arbitrary plugin bodies are
  correct or live.
- Time is declared, not observed. A boundary pair shows the harness moved between
  the two calls, and it does not show that the chain would have: there is no chain,
  no consensus timestamp, and no drift. What the pair measures is the comparison
  the contract performs, at the two values the scenario names.
- The scenario harness shares one storage snapshot across steps and does not roll a
  faulting call back. The face refuses to build on a declared fault, which is the
  case that matters, but a fault the scenario did *not* predict is only noticed
  after the fact, by the ending check. A stateful harness that modelled rollback
  would be a different and larger piece of equipment.
- The static model the footprint is confronted with is the same structural graph
  the entrypoint inventory publishes. Containment therefore tests that graph's
  soundness on one path per entry point, not its completeness: 634 reachable
  members were never entered, and nothing here says the graph listed everything a
  different set of arguments could reach.
- `implementationVerified` and `fullImplementationVerified` remain `false`.

## Running it

```sh
cd formal/refinement
python3 -m unittest test_frontend_correspondence      # 93 tests
python3 -m unittest test_abi_dispatch                # 22 tests
python3 -m unittest test_dispatch_footprint          # 20 tests
python3 -m unittest test_abi_scenario                # 42 tests

python3 - <<'PY'
import sys; sys.path.insert(0, '.')
import frontend_correspondence as fc
roots = ['/tmp/loadadm/src', '/tmp/excid/src', '/tmp/syscall1/source']
print(fc.correspond('.', roots)['corpus'])
PY
```

Inside the gate the corpus is discovered rather than supplied:

```python
corpus_roots = sorted(str(path) for path in output.glob('*/source') if path.is_dir())
frontend_receipt = correspondence.correspond(stage, corpus_roots)
require(correspondence.agrees(frontend_receipt), 'source frontend correspondence mismatch: ...')
```

An empty corpus is refused, so a run that found no `source` directory cannot be
reported as agreement.
