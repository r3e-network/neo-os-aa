# Public pure-method reference refinement

This lane certifies the complete bodies of three public ABI methods in the
ordinary candidate under declared reference semantics. It independently
projects their typed source, decodes their exact NEF bytes, and kernel-checks
source results, terminal behavior and frame preservation. It does not certify
ApplicationEngine, ABI dispatch, gas or public deployment. All 105 ABI entries
remain unproved for full implementation acceptance.

| Public method | Exact byte range, end exclusive | Bytes / instructions |
| --- | --- | --- |
| `getAccountImplementationId/0` | `[17906,17949)` | 43 / 3 |
| `supportsExecutionMode/1` | `[17949,18000)` | 51 / 18 |
| `supportsModuleType/1` | `[18000,18049)` | 49 / 18 |

The source-only frontend reads `inventory.source`; it never consults bytecode,
offsets or expected target results. It checks the complete MethodBody, Block and
Return, parameter types, equality and short-circuit OR metadata, and each
constant. The implementation ID's typed constant field and field-reference
constant must agree. The NEF compiles this constant inline: none of these bodies
loads static state. Their frame theorems quantify over arbitrary existing heap,
storage and static values, but do not prove the enclosing `_initialize` or the
caller's admission of arguments.

The source dialect interprets strings as byte values, with source constants
encoded in UTF-8, and preserves null. This is a Neo contract dialect theorem,
not preservation of arbitrary CLR object identity or a complete .NET string
implementation. Equality compares byte content; conditional OR short-circuits.
The capability methods report supported strings, not permission to change an
individual account's configuration.

The successful source domain admits null and physical ByteString bytes in
0..255 with length at most 65,536. This explicitly reflects the pinned VM's
[maximum comparable size](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/ExecutionEngineLimits.cs)
and [ByteString comparison guard](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/ByteString.cs).
It does not assume that an ABI String declaration validates runtime tags or
UTF-8. In the reference semantics, null and nonmatching byte strings return
false; other modeled value tags also return false for these string comparisons.
An oversized ByteString faults, and a missing argument faults at INITSLOT.
Concrete StackItem-to-reference-value correspondence, dispatch and resource
admission remain runtime obligations.

The generated certificate separates these statements:

- Universal execution classification distinguishes HALT and FAULT and excludes
  timeout, continuation and abort. It preserves heap, storage, effects and statics.
- The admitted-source-domain theorem connects budgeted equality with independent
  source evaluation; the composed theorem returns the source value at HALT.
- Successful returns leave the evaluation stack and locals empty and retain the
  original inputs as the method's argument frame. Oversized faults preserve the
  environment separately; they are not collapsed into a false result.
- The public decoder adds PUSHT to the frozen helper decoder. A checked subset
  theorem preserves existing decoding, and a second subset theorem preserves
  existing VM steps when comparison guards hold.

The fresh host receipt checks 66 closed declarations: 40 local/generated and
26 imported from IntegerSemantics, CapArithmetic and CapMethodVm. Eight actual
typed-source, byte-literal and valid branch mutations have accepted definition
modules and rejected semantic counterexample proofs. These shared declarations
must not be added to historical lane totals as disjoint proofs. This result is
reference body refinement; `fullImplementationVerified` and
`vmCorrespondenceProven` remain false.

Run from the repository root with the audited .NET/NCCS and Coq/Rocq tools:

```sh
python3 -m unittest formal/refinement/test_public_source.py \
  formal/refinement/test_public_pure_proofs.py
python3 formal/refinement/public_pure_proofs.py \
  --inventory /path/to/fresh/inventory.json \
  --output-dir /tmp/aa-public-pure-proof \
  --json-report /tmp/aa-public-pure-proof.json
```

The output directory must be new or empty. The CLI always runs the semantic
controls, writes a failing receipt before work, and replaces it with success
only after coqc, coqchk, every Print Assumptions audit and final input/model/tool
checks pass. Failure overwrites an old success receipt; its reason and kernel
logs remain available. The receipt binds source inputs, source tree/projection,
full NEF and script, each complete method, models, proof recipe and certificate.

Read `referenceVerifiedEntrypoints` as three reference-certified bodies, not
three fully accepted implementations. See the
[implementation boundary](AA-IMPLEMENTATION-REFINEMENT.md),
[entrypoint closure gate](AA-ENTRYPOINT-CLOSURE.md), and separate
[public runtime checks](AA-PUBLIC-RUNTIME-REFINEMENT.md).
