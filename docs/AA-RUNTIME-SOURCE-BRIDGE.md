# Runtime handler source bridge

This bridge consumes the actual NeoVM 3.10.1 handler sources at commit
`004cd6070a940405818d9357638277dd44407e2e`. It retains complete accepted C# bodies
as an expression/action tree, including statement order, operands, branches and
stack guards. Unknown syntax, calls and property access reject. Source hashes
provide identity; they do not provide semantic preservation.

An independent Coq evaluator executes the extracted source action language.
Generated certificates compare this evaluator with the existing `CapMethodVm`
instruction semantics on explicitly stated domains. The evaluator does not
dispatch directly to `CapMethodVm.vm_step`. Negative controls alter the actual
C# handler behavior while retaining legal syntax; their altered extracted trees
must fail the corresponding kernel-checked certificate.

The initial arithmetic and comparison correspondence is restricted to admissible
Integer-tag operands, and conditional branches to Boolean-tag conditions. The
standalone numeric-coercion model does not automatically broaden that domain.
Stack operations preserve value identities. Slot and branch proofs require the
active-frame, valid-index and valid-target obligations stated in their receipts.

Fault classification is distinct from exact fault-state equality: the real
handler may already have popped operands before throwing, while the existing
reference model preserves the pre-instruction stack on Fault. This bridge must
not assert those stacks are identical. Resource/gas accounting, exception
unwinding, opcode dispatch overrides and .NET/host primitive implementations
remain separate obligations. Equal/NotEqual also depend on the runtime's
comparison budget and are unsupported unless those obligations are discharged.

The source parser and C# API binding projection remain trusted extraction code.
The kernel checks the emitted action program's relationship to the model; it
does not prove that this parser implements all of C#, that the compiled VM DLL
matches the source, or that all helper instructions and external effects are
covered. Reports retain those open boundaries and never assert full
implementation acceptance.

Run the fresh source extraction, kernel certificates and all semantic controls:

```sh
python3 formal/refinement/runtime_bridge_proofs.py \
  --output-dir /tmp/aa-runtime-bridge \
  --json-report /tmp/aa-runtime-bridge.json
python3 -m unittest discover -s formal/refinement -p 'test_runtime*.py'
```

An optional `--source-cache` selects a directory containing the pinned paths;
missing files are fetched only from the fixed first-party commit and existing
hash mismatches reject. The source projection contains full accepted handler and
helper bodies. Every model is compiled from the same captured bytes used for its
hash; inputs are checked again after proofs and controls.

The certificate covers ADD, SUB, MUL, MIN, MAX, GT; DROP, DUP, TUCK, SWAP, ROT;
LDLOC0–6, STLOC0–6, LDARG0–6, LDSFLD; JMP, JMPIF and JMPIFNOT. Successful
stack operations preserve identities; slot certificates quantify arbitrary
prefix values and suffixes around the selected valid index. Static loads require
a present value and an in-range static index. Branches require a representable
signed32 target inside the script; the final PC projection assumes the default
engine scheduling rule. These are conditional single-instruction correspondence
certificates, not a composed proof of the whole helper or engine.

The eight legal C# mutations cover subtraction, minimum, strict comparison,
TUCK depth, ROT order, local index, relative jump direction and JMPIFNOT
condition. Each emitted mutant definition compiles, its concrete semantic
counterexample is kernel checked, and the unchanged correspondence statement
rejects. This separates behavior-sensitive rejection from a hash-only refusal.
Production source pins are bypassed only inside these controls.

`productionSourceBound: true` records identity of the selected pinned handler
source used by extraction. It does not certify the source parser, engine API
primitive implementations, reference counting, limits, .NET arithmetic, compiled
DLL identity, dispatch registration or runtime scheduling. Those remain trusted
or unproved boundaries in the receipt. Unknown syntax and omitted opcodes reject;
there is no fallback that labels an unrecognized handler verified.
