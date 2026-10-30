# Runtime collection source bridge

This second lane preserves the frozen instruction bridge and consumes fixed
Neo.VM 3.10.1 source at commit `004cd6070a940405818d9357638277dd44407e2e`.
The actual reimbursement helper has 281 bytes, 116 instructions and 52 distinct
opcodes. The first lane covers 30 of those opcode kinds. The remaining 22 are
ABORTMSG, CALLT, EQUAL, INITSLOT, LDLOC, LE, NOTEQUAL, PACK, PICKITEM, PUSH0,
PUSH1, PUSH2, PUSH4, PUSH5, PUSHDATA1, PUSHINT16, PUSHNULL, RET, SETITEM, SHL,
STLOC and SYSCALL. The generic slot forms LDLOC/STLOC and SHL, LE, PUSHINT16
entered this set when the helper gained its VM-integer headroom assertion and a
seventh local; the compact LDLOC0..6/STLOC0..6 kinds stay in the first lane.
NEWSTRUCT0, ISTYPE, CONVERT and SIZE are adjacent context/codec requirements,
not instructions present in this helper.

The initial collection certificates target the actual Array/Struct branch of
PICKITEM, scalar SETITEM with mutable receiver identity, PACK's counted pop loop,
entry INITSLOT, constant/data pushes, and fresh empty Array/Struct allocation.
Source extraction uses a deliberately delimited typed grammar: accepted operands,
guards, indexing and loop operations are emitted as data for an independent Coq
evaluator. Other switch branches are explicitly unsupported, not treated as
faulting source semantics. Unknown or additional source operations reject.

Heap references are stable identifiers. Writes update the object addressed by
the identifier; an alias must see that same update. The source evaluator uses
recursive indexed updates and counted-pop construction, while the frozen
reference model uses list slicing. Universal correspondence lemmas connect them.
Read-only receivers, Struct-valued writes/cloning, maps, primitive/buffer indexed
access, reference-counter effects and resource failures remain outside the
initial correspondence domain. The parser and runtime API/heap projection are
trusted extraction boundaries; source identity alone is not a semantic proof.

INITSLOT proofs distinguish absent slots from initialized empty slots and require
nonzero operands, successful int32 sizes and enough argument items. A reference
model's acceptance of a zero/zero operand is not attributed to the actual VM.
RET requires a separate shared-stack/context contract: preserving a returned
stack is not proof of the caller's saved continuation, unload callbacks or
ApplicationEngine behavior. Receipts must keep complete runtime acceptance false.

The emitted catalogue currently has 17 handlers. Thirteen certificates concern
reference VM steps or fresh allocation: PICKITEM, SETITEM, PACK, INITSLOT,
NEWARRAY0, NEWSTRUCT0, PUSHDATA1, PUSHNULL and PUSH0/1/2/4/5. Four supporting
projections are deliberately listed separately: RET preserves a shared stack
and jump flag; SIZE projects Array/Struct cardinality; ISTYPE projects those two
kinds on valid non-Any enum values; CONVERT projects ByteString/Buffer to Buffer
contents. These projections do not certify full opcode semantics or caller PC,
Buffer allocation identity, primitive encoded sizes or other converted types.

The Array Count/indexer/Add source is structurally validated alongside the
handler grammar. The Buffer content projection also validates the actual
PrimitiveType converter/GetSpan and Buffer→base same-type chain. Underlying
.NET list/span/copy primitives and CLR/runtime value binding remain TCB.

Run the standalone gate in a new or empty output directory:

```sh
python3 formal/refinement/runtime_collection_proofs.py \
  --output-dir /tmp/aa-runtime-collections \
  --json-report /tmp/aa-runtime-collections.json
python3 -m unittest discover -s formal/refinement -p 'test_runtime_collection*.py'
```

`--source-cache` optionally selects the fixed-source cache. Existing mismatches
reject; missing sources are fetched only from the exact first-party commit.
Each model is hashed, copied and compiled from one captured raw byte sequence,
then rechecked. Failed source, output or kernel checks overwrite a prior receipt
with `kernelChecked: false`. Output reuse rejects while preserving its files.

Nine legal source-semantic changes have compiled definitions and checked
counterexamples: array read offset, assigned key/value, PACK loop start,
allocation kind, local slot operand, literal value, RET jump flag, type comparison
and PrimitiveType Buffer span slice. Each rejects the original universal
correspondence statement. None is accepted merely because its source hash differs.
