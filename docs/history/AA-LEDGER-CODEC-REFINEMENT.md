# Ledger byte codec refinement

The two-field reimbursement record must have an executable byte representation;
a structured `VWire` is not itself a native serialization proof. This lane models
the Neo 3.10.1 binary codec for an Array or Struct containing one 32-byte hash and
one nonnegative signed-256 Integer, and explicitly preserves ByteString versus
Buffer tags. It does not change production code or broaden accepted ledger types.

The pinned implementation has two important permissive behaviors: its varint
reader accepts non-minimal widths, and `Deserialize(ReadOnlyMemory<byte>, limits)`
returns the first complete item without requiring end-of-input. Integer decoding
accepts empty and sign-extended payloads up to 32 bytes. Therefore the theorem is
unique deterministic prefix parsing, not uniqueness of every accepted byte
encoding. The serializer emits canonical varints and an empty Integer payload for
zero; positive values use signed little-endian with a protective zero sign byte
when necessary. A canonical two-field ledger occupies 38 through 70 bytes.

The independent Python and Coq encoders/parsers implement this byte framing.
Kernel proofs establish integer reconstruction, framing roundtrip, deterministic
parsing and length bounds, and a relation to the existing helper's structured wire. Explicit
source validation checks the pinned serializer, reader/writer helpers, native
entry wrappers and VM tags/Integer definitions; fixed hashes additionally bind
provenance. Real native vectors must agree on exact bytes and decoding outcomes.
These checks do not magically constitute a general C#/.NET execution theorem.
Malformed inputs outside the two-field domain, native dispatch, engine resources,
global rollback and arbitrary nested codec objects remain separate obligations.

## Verified boundary

`LedgerCodec.v` contains 27 assumption-closed declarations, including universal
theorems for every physical 32-byte hash and every reservation in `[0, 2^255)`.
`ledger_encode_decode_roundtrip` preserves an arbitrary suffix;
`ledger_encoding_injective` concerns the canonical encoder, and
`ledger_prefix_parse_unique` concerns deterministic parsing. ByteString and Buffer
hash tags, and Array and Struct container tags, remain distinct. The physical
byte-range theorem excludes non-byte naturals from canonical output.

`structured_wire_binary_roundtrip` connects actual framing to `VWire`.
`byte_string_wire_is_helper_budget` and
`helper_serialize_deserialize_roundtrip` connect the ByteString-hash subset to
the existing helper model. Buffer hashes have codec correspondence, but the
helper theorem still has its original ByteString-hash precondition.

The source validator compares complete reviewed executable method token streams
for serializer, deserializer, native wrappers, varint reader/writer, little-endian
readers and VM value constructors/accessors. It also checks tag constants,
Integer bounds/zero representation, and Struct inheritance. Ten pinned source
file hashes bind these checks to Neo `d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d`
and NeoVM `004cd6070a940405818d9357638277dd44407e2e`.
The tokenizer, source-to-model interpretation, .NET BigInteger primitives and
runtime receipt producer remain trusted components; token identity is not a
kernel-checked simulation of C# execution.

## Reproduction and evidence

Run from the repository root, with `coqc`, `coqchk` and .NET 10 on `PATH`, the
pinned NCCS 3.9.1 Roslyn assemblies installed, and Neo 3.10.1 packages restored:

```sh
PYTHONPATH=formal/refinement python3 -m unittest discover \
  -s formal/refinement -p 'test_*codec*.py' -v
PYTHONPATH=formal/refinement python3 formal/refinement/codec_proofs.py \
  --output-dir /tmp/aa-ledger-codec-proof-fresh \
  --json-report /tmp/aa-ledger-codec-proof-fresh.json \
  --native-vectors path/to/reviewed-native-codec-vectors.json
```

The output directory must be empty or absent, and the report must be absent.
`--source-cache` can supply the directory holding the ten pinned source files;
otherwise the runner fetches exact-commit source URLs into its temporary cache.
Omitting `--native-vectors` runs the universal codec proofs and semantic controls
without claiming a native-runtime join. The receipt records the input hashes,
tool identity, theorem assumptions, semantic controls, scope and remaining gaps.

The 2026-10-13 host run checks 19 Python tests, all 27 codec declarations,
six source execution declarations and all 33 generated native-vector declarations
under Rocq 9.2 and `coqchk`.
Eight definition-level semantic mutations first compiled and then failed both
their original-behavior examples and the theorem suite: nonempty zero, missing
positive sign byte, changed Array tag, collapsed Buffer tag, 33-byte integer
admission, rejected nonminimal varints, discarded suffix, and unsigned integer
decoding. A separate corrupted native expected-byte certificate also failed.

The native receipt SHA-256 is
`38cef261e60b5bf08ca11209991e657d919988e40ac5095043dea2e55c116bdd`.
Its 33 vectors cover 12 canonical nonnegative ledgers, 3 nonnegative integer
normalizations, 9 ledger normalizations and 9 negative values outside this
codec's domain. Negative values are supported by the real generic native codec;
their rejection here expresses the reimbursement ledger's narrower domain.
Every vector is independently joined in Python and incorporated, using the
receipt's actual bytes, into a kernel-checked Coq certificate. The join records
the loaded Neo and Neo.VM assembly identities and hashes from the native receipt.
Finite native agreement does not establish a universal native-execution theorem.

The fresh host receipt is
`/tmp/aa-ledger-codec-source-roundtrip-v2-20261013.json`; its corresponding directory
contains source copies, compiled modules, assumption checks, mutation failure
logs and the native-vector certificate. Its explicit status is
`kernelChecked: true`, `runtimeSourceSimulationProven: false`, and
`fullImplementationVerified: false`.

## Actual typed source execution

The subsequent source lane exports the two complete native core methods using
the pinned Roslyn 4.14 assemblies from NCCS 3.9.1. The independent
`native_export/NativeCodecExport.csproj` does not alter the existing contract
exporter. It requires zero compilation errors, resolves every operation and
symbol, preserves ordered children, and exports every semantic interface
property or fails. The export contains 541 operation nodes and 55 distinct
resolved external member bindings. It includes actual constructor defaults,
including BigInteger's signed, little-endian arguments.

`native_codec_source.py` translates these bound operations to an executable
source AST; it does not infer that AST from the reference codec or NEF. The
translator checks complete metadata schemas, external overloads and assemblies,
argument order, conversions, dispatch flags, collection completeness and source
spans. The interpreter executes loops, pattern switches, mutable stacks, reference
sets, container construction, stream writes and resource guards. It preserves
the prefix parser's remaining bytes. VM and .NET primitive behavior remains an
explicit contract, and this source dialect does not claim arbitrary CLR behavior
or general nested input support.

The default proof runner performs a fresh typed export and joins its interpreter
to all 33 native vectors alongside the independent byte model. An existing
inventory may be passed with `--native-source-inventory FILE`; its full input
identity is included and rechecked. Five mutations of the actual C# source each
compile without errors and project successfully, then fail the original behavior:
reversed Array field scheduling, incorrect Array field count, construction of an Array instead of a Struct,
incorrect pending-item accounting, and an off-by-one item limit. These controls
test source execution rather than merely rejecting changed source hashes.

`NativeCodecSource.v` independently interprets the projected AST with an explicit
mutable heap, local environment, control flow, stack/set operations, stream
operations and placeholder reconstruction. Both complete method bodies are
rendered into the certificate; unsupported branches fail rather than being erased.
The universal theorems show that execution in this source machine reaches the
supported branches for the stated domain. All theorem assumptions are closed.

`source_serializer_all_payloads` covers every 32-byte hash, every payload length
from zero through 32, and both container and hash tags. The numeric reconstruction
theorem then connects the actual serializer AST to canonical `encode_ledger`.
`source_deserializer_all_payloads` covers the same hash/payload domain with an
arbitrary unread suffix, preserving the signed little-endian payload value.
`actual_deserializer_ledger_refinement` reconstructs every legal ledger from its
canonical encoding. `actual_source_codec_roundtrip` composes the two actual core
AST executions; it is not a composition of two reference codec calls.

These source theorems use fixed core arguments `maxItems = 2048` and
`maxSize = 131070`. Canonical varint framing is proved universally; padding within
the integer payload is covered, but nonminimal varint framing currently has only
the separate finite native/source join. The native wrapper's argument adjustment,
arbitrary resource limits, malformed or nested objects, and general CLR execution
are outside this certificate. VM value accessors, collection behavior, small
varint writes, reader primitives and .NET BigInteger construction remain explicit
semantic contracts. Checked token correspondence and fully resolved external
symbols bind these contracts to the pinned code; they do not constitute a
universal proof of every external runtime primitive.

Four actual C# mutants also compile as Coq source definitions and then fail the
universal source theorem: field order, field count, Array-for-Struct construction,
and pending-item count. The off-by-one resource mutation is separately rejected
by source execution at the three-item boundary, without claiming that the fixed
2048-item universal theorem detects it.
The mutation proof strategy checks the empty suffix first to expose an incorrect
read past the ledger without expanding a symbolic suffix. The unmodified source
passes the same strategy in a separately compiled and kernel-checked baseline.
Mutation failure must contain a kernel proof error; a timeout is not accepted.

All Coq model inputs and the native receipt are now read once into immutable byte
snapshots. Hashing, compilation staging, host joins and native Coq certificates
consume those same bytes. End-of-run reads only detect persistent drift; they
are not the source of evidence identity. Deterministic regressions cover a native
receipt changing A→B→A between consumers and a Coq file returning different bytes
on consecutive reads. Both retain the first snapshot exactly, including line
endings, and snapshot consumers cannot reopen the original path.

The source subreceipt records the exact scope, source projection hash, source
machine hash, generated certificate hash and the six closed declarations. Its
`kernelChecked: true` applies to the stated two-field core domain;
`fullSourceSimulationProven: false` and top-level
`runtimeSourceSimulationProven: false` remain explicit. The source machine,
Roslyn exporter/translator, external primitive contracts and native receipt
producer remain part of the trusted computing base. The final proof runner also
retains the byte codec's eight semantic controls, corrupted native-byte rejection,
five compiled C# source controls and all native/source finite correspondence.

Sources: [Neo BinarySerializer](https://github.com/neo-project/neo/blob/d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d/src/Neo/SmartContract/BinarySerializer.cs),
[NeoVM Integer](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/Integer.cs).
