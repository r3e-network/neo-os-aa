# AA load admission

Status: **scoped, kernel-checked, not a full-implementation claim.**

```json
{"scope": "load-time-manifest-and-token-admission",
 "entryBoundary": "manifest-parse-and-nef-deserialize-admission-to-exact-arity-resolution",
 "semanticControls": 27,
 "closedAssumptions": 73,
 "sourceFrontendVerified": false,
 "applicationEngineVerified": false,
 "vmCorrespondenceProven": false,
 "deploymentPathVerified": false,
 "fullImplementationVerified": false}
```

Three dispatch lanes — `syscall-dispatch`, `contract-handoff`, `exception-identity`
— start from a `ContractMethodDescriptor` that has already been resolved and a
`ContractState` that has already been loaded. None of them records what a manifest
or a nef token is allowed to *declare*, so a caller reading those lanes cannot tell
a declaration the loader refuses from one it accepts and the dispatcher later
cannot resolve.

This lane reads both admission surfaces out of five pinned declarations and stops
at the value the loader returns.

## Pinned sources

Core commit `d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d`.

| Key | Path | SHA-256 (first 16) |
| --- | --- | --- |
| `core/nef` | `src/Neo/SmartContract/NefFile.cs` | `89184d41d9860835` |
| `core/token` | `src/Neo/SmartContract/MethodToken.cs` | `310d91742a751ed2` |
| `core/manifest` | `src/Neo/SmartContract/Manifest/ContractManifest.cs` | `1268364da65127dd` |
| `core/abi` | `src/Neo/SmartContract/Manifest/ContractAbi.cs` | `9313d6709261c83c` |
| `core/method` | `src/Neo/SmartContract/Manifest/ContractMethodDescriptor.cs` | `8b0c93a42e2cde4d` |

The projection re-reads each file and refuses bytes that do not hash to the pin.
An offline mirror (`AA_LOAD_ADMISSION_SOURCE_MIRROR`) may substitute for the
transport, never for the hash.

## What the source says

The read order of one nef deserialization is fixed, and the checksum is both last
and optional:

```csharp
long startPosition = reader.Position;
if (reader.ReadUInt32() != Magic) throw new FormatException("Wrong magic");
Compiler = reader.ReadFixedString(64);
Source = reader.ReadVarString(256);
if (reader.ReadByte() != 0) throw new FormatException("Reserved bytes must be 0");
Tokens = reader.ReadSerializableArray<MethodToken>(128);
if (reader.ReadUInt16() != 0) throw new FormatException("Reserved bytes must be 0");
Script = reader.ReadVarMemory((int)ExecutionEngineLimits.Default.MaxItemSize);
if (Script.Length == 0) throw new ArgumentException("Script cannot be empty.");
CheckSum = reader.ReadUInt32();
if (verify)
{
    if (CheckSum != ComputeChecksum(this)) throw new FormatException("CRC verification fail");
    ...
}
```

A token bounds its own name and masks its flag byte against the declared set:

```csharp
Method = reader.ReadVarString(32);
if (Method.StartsWith('_')) throw new FormatException($"Method('{Method}') cannot start with '_'");
ParametersCount = reader.ReadUInt16();
HasReturnValue = reader.ReadBoolean();
CallFlags = (CallFlags)reader.ReadByte();
if ((CallFlags & ~CallFlags.All) != 0) throw new FormatException($"CallFlags({CallFlags}) is not valid");
```

And an exact call is resolved through a table keyed by *name and arity*, while the
wildcard lookup ignores the arity:

```csharp
if (pcount >= 0)
{
    methodDictionary ??= Methods.ToDictionary(p => (p.Name, p.Parameters.Length));
    if (methodDictionary.TryGetValue((name, pcount), out var method))
        return method;
    return null;
}
else
{
    return Methods.FirstOrDefault(p => p.Name == name);
}
```

## The projected record

Twenty-four slots, each derived from the pinned text: one ordered step list,
twenty booleans and three declared bounds.

| Group | Slots |
| --- | --- |
| nef | magic constant, both reserves zero, token-array cap `128`, non-empty script, checksum compared for inequality, checksum guarded by `verify` |
| token | no `_` prefix, method-name limit `32`, flag byte masked against `CallFlags.All` |
| manifest | non-empty name, empty `features`, no repeated standards/subjects/trusts, length cap `65535`, cap enforced before parsing |
| ABI | at least one method, exact lookup keyed by `(name, arity)`, arity range-checked, wildcard lookup ignores arity, a miss returns null |
| method descriptor | non-empty name, no repeated parameter names, defined return type, non-negative offset |

The step list is read by sorting anchors in the normalized body, so moving a
`reader.Read*` call changes the record instead of passing unnoticed. Anchors keep
the shape of their statement but not the value they compare against, so a weakened
comparison moves a *field* without moving the *order* — the two are distinguishable.

## What the kernel proves

`formal/refinement/coq/LoadAdmission.v` — 30 declarations, all closed,
`coqc` and `coqchk -silent` both exit 0, no axioms.

| Claim | Statement |
| --- | --- |
| admission is all-or-nothing | `admitted p = true` iff every guard in `guards` holds |
| one false guard refuses | `In g guards → guard p g = false → admitted p = false` |
| the guard list is complete | every `GuardName` constructor appears in `guards`, in order |
| the magic is read before the tokens | `earlier ReadMagic ReadTokens canonical_steps = true` |
| the tokens precede the script | `earlier ReadTokens ReadScript …` |
| the script precedes the checksum | `earlier ReadScript VerifyChecksum …` |
| the checksum is terminal | every recorded step is the checksum or precedes it |
| a reordered reader is observable | `swapped_read_steps ≠ canonical_steps`, yet it still verifies last |
| the bounds are inclusive | `within cap cap = true` |
| one past the bound is refused | `within cap (S cap) = false` |
| a raised bound admits exactly one more | `within cap n = false → within (S cap) n = true → n = S cap` |
| loading needs both surfaces | `loads` requires admission *and* all three bounds |
| a bound refuses on its own | a failed token/name/manifest bound makes `loads` false |
| the guards alone do not admit a long name | `admitted p = true → within limit n = false → loads p 0 n 0 = false` |
| the reviewed record loads its maxima | `loads reviewed_program 128 32 65535 = true`, and `129`/`33`/`65536` do not |

## Semantic controls

Twenty-seven source mutants, each a single textual change to a pinned file, each
moving **exactly one** of the twenty-four slots and covering all of them. Every
control compiles the mutant record, shows the pinned observable (`true`, `128`,
`32`, `65535`) is *rejected* for the mutant, and re-checks the counterexample with
`coqchk`.

Examples: `accept-a-foreign-magic` (`!= Magic` → `!= 0`), `compare-the-checksum-for-equality`
(`!=` → `==`), `allow-a-underscore-method` (`'_'` → `'#'`),
`key-the-exact-lookup-by-the-name-only` (`(p.Name, p.Parameters.Length)` → `(p.Name, 0)`),
`make-the-wildcard-respect-the-arity`, `read-the-reserve-before-the-source`
(the only mutant that moves the step order), `raise-the-manifest-length-cap`
(`65535` → `131070`).

## Three facts this lane forced

1. **Structural admission precedes integrity.** The checksum is read last and only
   under `verify`, so every declaration rejected for its shape is rejected before
   the checksum is even computed. A reader that verified first would admit the same
   set of declarations but report a different first failure, which is why the order
   is a field and not a comment.

2. **The ABI has two lookups over one table.** Exact resolution is keyed by
   `(name, arity)`; the wildcard path takes the first method with that name and
   ignores the arity entirely. `ContractManifest.FromJson` de-duplicates groups,
   standards, permission subjects and trusts — but not method signatures. So a
   manifest declaring two methods with the same name and arity is *admitted*, and
   the exact-arity `ToDictionary` is where it stops being resolvable. The lane
   records the key and lists that consequence as open rather than modelling a throw.

3. **Admission and loading are different questions.** `admitted` consults only the
   guard list; the three caps are consumed by `loads`. A declaration can therefore
   pass every guard and still be refused for being too long — and the kernel proves
   that separation instead of collapsing it into one verdict.

## Still open

- Whether the deployment path ever stores a manifest whose ABI declares two methods
  with the same name and arity.
- Every rejection message and any client-visible diagnostic derived from it.
- The wildcard container reader that turns the JSON string `*` into a wildcard.
- Gas, storage growth and every resource limit on the admission path.
- The permission table's runtime decision (modelled by `contract-handoff`).
- Trusted C# extraction and compiler/CLR correspondence; all 100 public entrypoints.

## Running it

```sh
AA_LOAD_ADMISSION_SOURCE_MIRROR=/path/to/pinned/bytes \
python3 formal/refinement/abi_admission_proofs.py \
  --output-dir /tmp/load-admission --json-report /tmp/load-admission.json
```

The lane also runs as the `load-admission` scope of `formal/refinement/closure.py`.
Tests: `python3 -m unittest test_abi_admission_source` (47 cases).
