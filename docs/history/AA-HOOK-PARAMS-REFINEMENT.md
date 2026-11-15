# Hook operation-parameter helper reference refinement

This independent lane targets the complete private `BuildHookOperationParams`
body at `[11602,11626)`: 24 exact NEF bytes and 21 instructions. It projects the
actual typed source and record field layout independently of target bytes. It
cannot certify a public entrypoint or reduce the 100 full-unproved ABI entries.

The result is a fresh outer Array holding
`[TargetContract, Method, providedArgs, Nonce, Deadline, Signature]`. The provided
argument array keeps its heap identity; it is not cloned by this helper. The
pinned NeoVM PACK and PICKITEM implementations retain their contained values.
Struct cloning in VALUES, SETITEM and APPEND is a separate behavior and must not
be silently attributed to PACK. The caller's `CloneOperationArguments` uses
native Serialize/Deserialize and needs its own codec/host correspondence.
These operation choices were checked against the [pinned NeoVM implementation](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/JumpTable/JumpTable.Compound.cs),
not inferred from CLR array behavior.

The success theorem requires an Array/Struct record view containing the six
UserOperation fields. Typed-source correspondence additionally needs the caller
to establish the declared field types and argument-array representation. The
source is a declared Neo contract dialect, not arbitrary CLR boxing/object
identity. Existing heap objects and aliases survive unchanged; only the new
outer tuple is appended. The success theorem quantifies over all field values,
heap prefixes, suffix fields, provided values, storage and static environments
in that structural domain. Its exact `Halt` state and separate termination theorem
exclude timeout and fallthrough; they retain storage, statics and existing heap
objects, clear the evaluation stack and locals, and preserve the input arguments.
The array-identity corollaries require the provided argument reference to exist
in the old heap. Admitting dangling references as ordinary live StackItems would
be an invalid concrete runtime correspondence.

Separate fault statements cover a null operation, dangling operation reference,
an Array/Struct record with fewer than six fields, and an empty incoming argument
stack. They establish terminal fault and unchanged heap/storage/effects, rather
than treating timeout as fault. Resource faults and concrete StackItem
correspondence remain open. Neo PICKITEM also has Map and byte-indexing cases
outside this record domain; no blanket wrong-tag fault claim is made.

Typed source is projected without consulting target instructions. The complete
container, manifest, decoded instruction table, debug boundary and current input
hashes are checked against one captured input snapshot. Models compiled by Coq
come from the same bytes that are hashed, with a final drift check. A failed CLI
run replaces any stale success receipt before it starts, and output directories
must be new or empty. Native codec calls, caller admission, gas/resource limits,
compiler/source-frontend and concrete VM correspondence remain independent gates.

The October 13 local validation passed six tests, coqc, coqchk and the assumption
audit: 41 closed declarations (15 helper/model-artifact declarations plus 26
shared imported declarations). Six semantic controls compile valid definitions
and fail the concrete result equality: four exact-byte field/argument/size
mutations and two typed-source field-order/argument-origin mutations. The latest
local receipt is `/tmp/aa-hook-params-final-20261013.json`; this path is evidence
for this machine, not a portable release certificate. Regenerate a fresh receipt
for every accepted inventory. These reference results do not establish a
production, protocol-activation or whole-entrypoint GO.

```sh
python3 -m unittest formal/refinement/test_hook_params_source.py \
  formal/refinement/test_hook_params_proofs.py
python3 formal/refinement/hook_params_proofs.py \
  --inventory /path/to/fresh/inventory.json \
  --output-dir /tmp/aa-hook-params-proof \
  --json-report /tmp/aa-hook-params-proof.json
```

See [implementation acceptance](../AA-IMPLEMENTATION-REFINEMENT.md) and
[public entrypoint closure](../AA-ENTRYPOINT-CLOSURE.md). `fullImplementationVerified`
remains false even after this private-body reference theorem succeeds.
