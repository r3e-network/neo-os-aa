# Method-level refinement

This document holds every method-level refinement lane for the ordinary SmartAccount
candidate. It replaces the thirteen lane documents that used to sit side by side in
`docs/`, and each lane's text below is unchanged: only the heading level moved down
one step, so that thirteen separate arguments read as one ordered document.

**The lanes are not additive.** Each lane states its own scope, its own pinned
inputs and the obligations it leaves open; a receipt in one lane never discharges
another, and shared imported declarations must not be added together as if each
receipt contained disjoint proofs. Nothing here certifies the whole contract,
ApplicationEngine composition, public protocol activation or deployment. The
[implementation gate](SA-IMPLEMENTATION-REFINEMENT.md) and the
[entrypoint closure gate](SA-ENTRYPOINT-CLOSURE.md) own those decisions.

## Lanes

| # | Lane | What it establishes |
| ---: | --- | --- |
| 1 | [Whole-helper refinement inventory](#whole-helper-refinement-inventory) | Artifact identity, the complete 116-instruction table and the pinned ApplicationEngine boundary. Structural accounting only. |
| 2 | [Full helper source projection](#full-helper-source-projection) | The complete typed Roslyn tree translated into the statement/expression language the certificate consumes. |
| 3 | [Complete reimbursement-helper reference refinement](#complete-reimbursement-helper-reference-refinement) | The complete typed-source body compared with a byte-decoding reference VM for one helper. |
| 4 | [Complete reimbursement helper runtime checks](#complete-reimbursement-helper-runtime-checks) | The original private helper executed in the pinned engine: storage, codec, faults and rollback. |
| 5 | [Reservation arithmetic refinement](#reservation-arithmetic-refinement) | Positivity, representable reservation updates and protocol fee bounds; records the zero-fee overflow disagreement. |
| 6 | [Numeric coercion refinement](#numeric-coercion-refinement) | GetInteger decoding and its value relation, including Boolean and ByteString inputs. |
| 7 | [ApplicationEngine fee semantics](#applicationengine-fee-semantics) | The complete AddFee(BigInteger, bool) body from the pinned Neo commit. |
| 8 | [Public pure-method reference refinement](#public-pure-method-reference-refinement) | Three public pure bodies certified under declared reference semantics. |
| 9 | [Public sponsored-entry runtime refinement](#public-sponsored-entry-runtime-refinement) | The two public sponsored entrypoints executed end to end in the base ApplicationEngine. |
| 10 | [Syscall admission: `System.Contract.Call` and `CALLT`](#syscall-admission-systemcontractcall-and-callt) | System.Contract.Call and CALLT admission, up to the CallContractInternal parameter tuple. |
| 11 | [Interop argument conversion (kernel-checked, nineteenth gate scope)](#interop-argument-conversion-kernel-checked-nineteenth-gate-scope) | The caller's stack window turned into the callee's argument frame, kernel-checked. |
| 12 | [Interop descriptor charge and window effect](#interop-descriptor-charge-and-window-effect) | The descriptor charge and its window effect, which the conversion lane excludes backward. |
| 13 | [Exception identity and catchability](#exception-identity-and-catchability) | Which exception reaches whom, rather than the bare claim that a path throws. |

## Whole-helper refinement inventory

This is a structural inventory and implementation plan. It proves no VM, ApplicationEngine, compiler, storage, or whole-method semantics. The current arithmetic certificate remains a region certificate; it cannot establish a whole-method certificate.

### Current artifact summary (2026-11-17)

The current SmartAccount V3 NEF is
`9f714866c5ba1b6cf31d63036d9805d73058055f325fd412e303356534ba2f76`
with script SHA256
`909ba759b66a4d84a4bd2aa2a2a78ef611c8b27e834b460a90f8ff83d387e1cd`.
Its `CapReimbursementToActualCost` helper is the complete interval
`[18900,19181)`: 281 bytes, 116 instructions, and 52 distinct opcode names.
The initializer is `[29996,30678)`: 682 bytes and 182 instructions. The helper
reads static slot 38; the initializer stores the reimbursement key with
`PUSHDATA1 21` at 30497, `CONVERT Buffer` at 30500, and `STSFLD 38` at 30502.
The current compiler artifact has 109 ABI entries, not the historical 100.

Only `INITSLOT` at 18900 has no exact declared source point; the other 115 instructions have explicit debug source points. The optional existing arithmetic certificate claims 22 instructions, leaving 94 method instructions unaccounted for by that certificate. These are counts of declared coverage, not proof acceptance.

The two `LDSFLD` instructions at 18911 and 19165 use static index 38, named `Prefix_TransactionReimbursement`. Outside this helper, initialization is `30497: 0c0121` (PUSHDATA1 containing `21`), `30500: db30` (CONVERT to Buffer), `30502: 6726` (STSFLD 38). (The pre-sweep build `6c347dac…` had the same shape with `INITSLOT` at 13557, `LDSFLD` sites at 13568/13822, initializer instructions at 25432/25435/25437 and static index 34; the 2026-11-16 design-phase legacy sweep moved the offsets and the slot.) Thus a helper entry-state specification must bind slot 38 to `Buffer([0x21])` and establish that initialization ran. Those three initializer instructions are not part of the 116-instruction helper.

### Historical candidate and scope

The detailed table below records the earlier 2026-10-13 candidate and its
`[13557,13838)` layout. It is retained as provenance for the historical
inventory lane; its offsets and slot 34 must not be applied to the current
artifact.

The public ordinary candidate NEF has SHA256 `4e5c8ae0c4b9722ae19e099303b6a61786de97cc4844abbc1ad458c3a76ce198`. Its reviewed debug mapping identifies `CapReimbursementToActualCost(BigInteger)` at inclusive offsets **13557–13837**: **281 bytes, 116 instructions, 52 distinct opcodes**. All 116 instructions are listed below, including the prefix, assertion fault path, reservation update, serialization, storage write, and return. Debug/source identity and source locations are bound exporter evidence, not a compiler-refinement theorem.

The current arithmetic proof covers `[13667,13689)`. Its complete uncovered prefix is `[13557,13667)` and suffix is `[13689,13838)`. Structural accounting of claimed regions must expose both. `method_inventory.py` independently decodes raw script bytes and rejects incomplete debug boundaries, forged instruction metadata, invalid source points, overlaps, and an arithmetic certificate presented as whole-method evidence. Its output always retains `implementationVerified=false` and `wholeMethodVerified=false`.

The CLI first binds the inventory to the actual NEF, manifest, input hashes and current source membership, and checks them again before writing the report. It also records and checks the inventory tool, independent decoder and binding-parser hashes. Its optional certificate accounting checks exact method/artifact identity and instruction boundaries but does not authenticate or prove the certificate. Even a claimed interval covering every byte remains structural accounting. A future whole-helper checker must supply its own reviewed semantic acceptance path.

```sh
python3 formal/refinement/method_inventory.py \
  --inventory /path/to/fresh/inventory.json \
  --certificate /path/to/arithmetic/proof.json \
  --json-report /path/to/method-inventory.json
```

### Interpreter and correspondence split

1. **VM control and data operations.** Extend the existing arithmetic semantics with `INITSLOT`, static fields, Null/ByteString/Array/Struct values, PACK, stack rearrangements, field mutation, equality, conditional/unconditional branches, ABORTMSG, and RET. Preserve actual pc, slot counts, stack order, type/index faults, object aliasing, and frame conditions; do not replace the method with its source formula.
2. **Explicit environment outcomes.** Give the seven SYSCALL sites and two native CALLT sites success/fault relations. Bind repeated script-container reads to the same transaction and bind the static field at index 38 to the initialized reimbursement key. State deployed-contract/context and ReadStates/WriteStates/AllowCall assumptions. Model absent storage separately from deserialization and the matching/different transaction-hash paths.
3. **All helper paths.** Certify all 116 instructions against an explicit two-field stored-budget invariant, or extend the value model to other deserialized shapes and their type/index faults. Include settled<=0 ABORTMSG and reservation overflow before serialization; the arithmetic proof alone does not establish these paths. Observe returned settlement and the serialized budget stored under the correct contract/key, with other state unchanged on the success path.
4. **ApplicationEngine composition.** Connect the environment relations to pinned handler implementations, native dispatch, conversion, fee charging, contract permissions, hardfork selection, snapshot ownership and rollback. A helper-under-environment theorem is distinct from this correspondence and from complete transaction/caller refinement. Do not label either partial layer as full implementation verification.

### Pinned ordinary ApplicationEngine boundary

Target Neo core: [`d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d`](https://github.com/neo-project/neo/tree/d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d); Neo VM: [`004cd6070a940405818d9357638277dd44407e2e`](https://github.com/neo-project/neo-vm/tree/004cd6070a940405818d9357638277dd44407e2e). These are the public ordinary track, separate from the native SA fork. The source hashes below attest the files inspected for this plan, not a proof of their runtime behavior.

| Boundary | Pinned implementation and obligation |
| --- | --- |
| Runtime container | `ApplicationEngine.Runtime.cs:207` requires an IInteroperable container. `Transaction.cs:427` requires a signer and returns `[Hash,Version,Nonce,Sender,SystemFee,NetworkFee,ValidUntilBlock,Script]`; helper indices 0, 4, 5 must match those fields. |
| Storage context/read | `ApplicationEngine.Storage.cs:102` requires a deployed current contract; context carries its contract ID. `Get:153` reads `(context.Id,key)` and returns null for absence. |
| Storage write | `Put:228` checks key<=64 bytes, value<=65535 bytes and writable context; charges size-dependent storage fees and changes the current snapshot. Model fee failure before the final value write. |
| CALLT | `ApplicationEngine.cs:490` validates ReadStates\|AllowCall, token and argument count; `CallContractInternal:579` resolves hash/method/ABI, policy, permissions, flags intersection and return shape. Both actual tokens request All flags; effective flags remain context-dependent. |
| StdLib | `Native/StdLib.cs:35,41` delegates to BinarySerializer with engine limits. Native dispatch additionally checks activation/flags, converts parameters and charges native fees (`NativeContract.cs:445`). Both native handlers remain external correspondence obligations. |
| Codec fidelity | `BinarySerializer.cs:56,80,198` handles Array, Struct and Map in addition to primitive values. Deserialization does not require the reader to reach the end of its input; a strict canonical/no-trailing-byte model would be stronger than this handler. Serialization rejects unsupported values, repeated compound references and size/item-limit excesses. |
| Fees and failure | `ApplicationEngine.cs:991,1005` validates syscall flags, charges syscall/opcode fees and converts values. `ContextUnloaded:661` commits cross-contract snapshots only without an uncaught exception. Application transaction rollback and caller-visible failure still need outer composition, even though this helper has no TRY/CALLA. |

| Fixed core file | SHA256 |
| --- | --- |
| `src/Neo/SmartContract/ApplicationEngine.cs` | `97b08bfe754bc51ed8418316b45d3805dccff76ef51fbd43ac9b663eacb4d5eb` |
| `src/Neo/SmartContract/ApplicationEngine.Runtime.cs` | `b0f4fa6316d796e0b0aa1406a696395669311d5382600f3f83bad966c6d429e9` |
| `src/Neo/SmartContract/ApplicationEngine.Storage.cs` | `adeb3ce69a7d04a3015de35884c0f0c6203ef2dfbfbe8056395f074d69e04083` |
| `src/Neo/SmartContract/ApplicationEngine.Contract.cs` | `8958efff155cb407fef140dea11a516b9f08ab10feecf1b3c39d986d79801a96` |
| `src/Neo/SmartContract/ApplicationEngine.Helper.cs` | `70b3b6bf41cad318e8346c71a3f7b70d1054e44cb029f499ff9feab86d2dded9` |
| `src/Neo/SmartContract/Native/StdLib.cs` | `510dbd32f7896e99b0953096b6bc1df64fabfbee952ff4dc9f186789f084be05` |
| `src/Neo/SmartContract/BinarySerializer.cs` | `d74462dce89437070ca67deca40ba40de1e3a335f8a63726e5420ffb846ff150` |
| `src/Neo/Network/P2P/Payloads/Transaction.cs` | `4b527ca5e6a47b3852cbbd44aec256025011aad14b3e0154b01aa4e5b1acc41d` |
| `src/Neo/SmartContract/ExecutionContextState.cs` | `d08d47dc43f00070b5a2248556efa8afc7ff5f24db2d96d9a8712101eaa925d8` |
| `src/Neo/SmartContract/StorageContext.cs` | `29dea6ee1be9e95b61420d351929643aa9e63ae112af9acfcb12bbd59ff4d164` |
| `src/Neo/SmartContract/Native/NativeContract.cs` | `3ceb1bd9c78e0683b81b2833e0c544a7a3b77778fb44676ec4cc9f76d863fcbf` |

### Complete instruction and source-point list

Offsets are absolute script positions; the method end is exclusive 13838. `d17` is `SmartAccount.Paymaster.cs`; d5/d6/d7/d15 are pinned framework `Services/Runtime.cs`, `Services/Storage.cs`, `Native/StdLib.cs`, and `UInt256.cs`. Only exact declared source points are shown; `—` means unmapped, with no fabricated nearest-line association. Relative targets are independently checked by the raw decoder. No internal CALL/CALL_L, indirect CALLA, or explicit TRY handler occurs in this method. CALLT/SYSCALL fallthrough is a declared continuation, not a guarantee that a handler returns successfully.

| pc | Full instruction bytes | Opcode | Non-fallthrough edge / environment effect | Exact source point(s) |
| ---: | --- | --- | --- | --- |
| 13557 | `570801` | INITSLOT | — | — |
| 13560 | `412d510830` | SYSCALL | System.Runtime.GetScriptContainer | d5:51:14–51:58 |
| 13565 | `10` | PUSH0 | — | d17:55:39–55:63 |
| 13566 | `ce` | PICKITEM | — | d17:55:39–55:63 |
| 13567 | `70` | STLOC0 | — | d17:55:21–55:63 |
| 13568 | `5f22` | LDSFLD | — | d17:56:68–56:99 |
| 13570 | `419bf667ce` | SYSCALL | System.Storage.GetContext | d6:27:14–27:50 |
| 13575 | `41925de831` | SYSCALL | System.Storage.Get | d6:51:10–51:39 |
| 13580 | `71` | STLOC1 | — | d17:56:25–56:100 |
| 13581 | `69` | LDLOC1 | — | d17:57:47–57:51 |
| 13582 | `0b` | PUSHNULL | — | d17:57:55–57:59 |
| 13583 | `97` | EQUAL | — | d17:57:47–57:59 |
| 13584 | `2629` | JMPIFNOT | branch→13625 | d17:57:47–59:69 |
| 13586 | `10` | PUSH0 | — | d17:28:42–28:43 |
| 13587 | `0c200000000000000000000000000000000000000000000000000000000000000000` | PUSHDATA1 | — | d15:20:46–20:140 |
| 13621 | `12` | PUSH2 | — | d17:58:19–58:49 |
| 13622 | `c0` | PACK | — | d17:58:19–58:49 |
| 13623 | `2206` | JMP | branch→13629 | d17:57:47–59:69 |
| 13625 | `69` | LDLOC1 | — | d17:59:64–59:68 |
| 13626 | `370400` | CALLT | CALLT 4 StdLib.deserialize | d7:19:6–19:60 |
| 13629 | `72` | STLOC2 | — | d17:57:38–59:69 |
| 13630 | `6a` | LDLOC2 | — | d17:60:17–60:23 |
| 13631 | `10` | PUSH0 | — | d17:60:17–60:39 |
| 13632 | `ce` | PICKITEM | — | d17:60:17–60:39 |
| 13633 | `68` | LDLOC0 | — | d17:60:43–60:58 |
| 13634 | `98` | NOTEQUAL | — | d17:60:17–60:58 |
| 13635 | `2610` | JMPIFNOT | branch→13651 | d17:60:13–64:14 |
| 13637 | `68` | LDLOC0 | — | d17:62:42–62:57 |
| 13638 | `4a` | DUP | — | d17:62:17–62:57 |
| 13639 | `6a` | LDLOC2 | — | d17:62:17–62:23 |
| 13640 | `10` | PUSH0 | — | d17:62:17–62:57 |
| 13641 | `51` | ROT | — | d17:62:17–62:57 |
| 13642 | `d0` | SETITEM | — | d17:62:17–62:57 |
| 13643 | `45` | DROP | — | d17:62:17–62:57 |
| 13644 | `10` | PUSH0 | — | d17:63:35–63:36 |
| 13645 | `4a` | DUP | — | d17:63:17–63:36 |
| 13646 | `6a` | LDLOC2 | — | d17:63:17–63:23 |
| 13647 | `11` | PUSH1 | — | d17:63:17–63:36 |
| 13648 | `51` | ROT | — | d17:63:17–63:36 |
| 13649 | `d0` | SETITEM | — | d17:63:17–63:36 |
| 13650 | `45` | DROP | — | d17:63:17–63:36 |
| 13651 | `412d510830` | SYSCALL | System.Runtime.GetScriptContainer | d5:51:14–51:58 |
| 13656 | `14` | PUSH4 | — | d17:65:49–65:78 |
| 13657 | `ce` | PICKITEM | — | d17:65:49–65:78 |
| 13658 | `412d510830` | SYSCALL | System.Runtime.GetScriptContainer | d5:51:14–51:58 |
| 13663 | `15` | PUSH5 | — | d17:65:93–65:123 |
| 13664 | `ce` | PICKITEM | — | d17:65:93–65:123 |
| 13665 | `9e` | ADD | — | d17:65:37–65:123 |
| 13666 | `73` | STLOC3 | — | d17:65:24–65:123 |
| 13667 | `11` | PUSH1 | — | d17:66:41–66:42 |
| 13668 | `11` | PUSH1 | — | d17:66:72–66:73 |
| 13669 | `6b` | LDLOC3 | — | d17:66:60–66:70 |
| 13670 | `b9` | MIN | — | d17:66:45–66:74 |
| 13671 | `9f` | SUB | — | d17:66:41–66:74 |
| 13672 | `74` | STLOC4 | — | d17:66:24–66:74 |
| 13673 | `10` | PUSH0 | — | d17:67:75–67:76 |
| 13674 | `6b` | LDLOC3 | — | d17:67:45–67:55 |
| 13675 | `6a` | LDLOC2 | — | d17:67:58–67:64 |
| 13676 | `11` | PUSH1 | — | d17:67:58–67:73 |
| 13677 | `ce` | PICKITEM | — | d17:67:58–67:73 |
| 13678 | `9f` | SUB | — | d17:67:45–67:73 |
| 13679 | `ba` | MAX | — | d17:67:30–67:77 |
| 13680 | `6c` | LDLOC4 | — | d17:67:80–67:94 |
| 13681 | `78` | LDARG0 | — | d17:67:97–67:106 |
| 13682 | `a0` | MUL | — | d17:67:80–67:106 |
| 13683 | `9e` | ADD | — | d17:67:30–67:106 |
| 13684 | `75` | STLOC5 | — | d17:67:24–67:106 |
| 13685 | `6d` | LDLOC5 | — | d17:68:60–68:63 |
| 13686 | `78` | LDARG0 | — | d17:68:49–68:58 |
| 13687 | `b9` | MIN | — | d17:68:34–68:64 |
| 13688 | `76` | STLOC6 | — | d17:68:24–68:64 |
| 13689 | `6e` | LDLOC6 | — | d17:69:36–69:43 |
| 13690 | `10` | PUSH0 | — | d17:69:46–69:47 |
| 13691 | `b7` | GT | — | d17:69:36–69:47 |
| 13692 | `242a` | JMPIF | branch→13734 | d17:69:13–69:89 |
| 13694 | `0c255265696d62757273656d656e7420657863656564732061637475616c2067617320636f7374` | PUSHDATA1 | — | d17:69:49–69:88 |
| 13733 | `e0` | ABORTMSG | — | d17:69:13–69:89 |
| 13734 | `11` | PUSH1 | — | d17:81:34–81:48 |
| 13735 | `01fe00` | PUSHINT16 | — | d17:81:52–81:55 |
| 13738 | `a8` | SHL | — | d17:81:34–81:55 |
| 13739 | `11` | PUSH1 | — | d17:81:59–81:60 |
| 13740 | `9f` | SUB | — | d17:81:33–81:60 |
| 13741 | `11` | PUSH1 | — | d17:81:65–81:79 |
| 13742 | `01fe00` | PUSHINT16 | — | d17:81:83–81:86 |
| 13745 | `a8` | SHL | — | d17:81:65–81:86 |
| 13746 | `9e` | ADD | — | d17:81:32–81:87 |
| 13747 | `7707` | STLOC | — | d17:81:24–81:87 |
| 13749 | `6a` | LDLOC2 | — | d17:82:36–82:42 |
| 13750 | `11` | PUSH1 | — | d17:82:36–82:51 |
| 13751 | `ce` | PICKITEM | — | d17:82:36–82:51 |
| 13752 | `6f07` | LDLOC | — | d17:82:55–82:60 |
| 13754 | `6e` | LDLOC6 | — | d17:82:63–82:70 |
| 13755 | `9f` | SUB | — | d17:82:55–82:70 |
| 13756 | `b6` | LE | — | d17:82:36–82:70 |
| 13757 | `2432` | JMPIF | branch→13807 | d17:82:13–83:65 |
| 13759 | `0c2d5265696d62757273656d656e7420627564676574206578636565647320564d20696e7465676572206c696d6974` | PUSHDATA1 | — | d17:83:17–83:64 |
| 13806 | `e0` | ABORTMSG | — | d17:82:13–83:65 |
| 13807 | `6a` | LDLOC2 | — | d17:84:13–84:19 |
| 13808 | `4a` | DUP | — | d17:84:13–84:39 |
| 13809 | `11` | PUSH1 | — | d17:84:13–84:39 |
| 13810 | `ce` | PICKITEM | — | d17:84:13–84:39 |
| 13811 | `6e` | LDLOC6 | — | d17:84:32–84:39 |
| 13812 | `9e` | ADD | — | d17:84:13–84:39 |
| 13813 | `4e` | TUCK | — | d17:84:13–84:39 |
| 13814 | `11` | PUSH1 | — | d17:84:13–84:39 |
| 13815 | `50` | SWAP | — | d17:84:13–84:39 |
| 13816 | `d0` | SETITEM | — | d17:84:13–84:39 |
| 13817 | `45` | DROP | — | d17:84:13–84:39 |
| 13818 | `6a` | LDLOC2 | — | d17:85:99–85:105 |
| 13819 | `370300` | CALLT | CALLT 3 StdLib.serialize | d7:19:6–19:60 |
| 13822 | `5f22` | LDSFLD | — | d17:85:49–85:80 |
| 13824 | `419bf667ce` | SYSCALL | System.Storage.GetContext | d6:27:14–27:50 |
| 13829 | `41e63f1884` | SYSCALL | System.Storage.Put | d6:91:10–91:39 |
| 13834 | `6e` | LDLOC6 | — | d17:86:20–86:27 |
| 13835 | `2202` | JMP | branch→13837 | d17:86:13–86:28 |
| 13837 | `40` | RET | — | d17:87:9–87:10 |

## Full helper source projection

The reimbursement helper certificate needs the entire source body, constructor
initializers and storage-key initializer. Selecting three arithmetic expressions
does not account for a changed guard, reset, assignment, serialization or return.
`formal/refinement/method_source.py` translates the complete typed Roslyn tree
into the independent statement/expression language in `CapMethodVm.v`.

The projection supports only the concrete, explicitly checked Neo framework
intrinsics needed here. It preserves statement and argument evaluation order,
all field writes, conditionals, assertions and return values. It lowers the
conditional budget initializer to an if with one local assignment per branch.
Compound field addition reads that field and emits an addition followed by a
field write. BigInteger expressions retain unbounded source arithmetic; target
integer bounds are proved separately for the certificate's admitted domain.

The source language is the declared Neo-framework contract interpretation, not
arbitrary CLR object execution. ByteString/UInt256 values denote immutable byte
values; record fields have their exported layout; framework storage, transaction
and codec calls have explicit effect contracts. Reference casts require the
declared well-formed record relation. These frontend/framework correspondences
remain named obligations, rather than results of the Coq source interpreter.
Invalid codec objects, actual initializer execution, resources and the real
ApplicationEngine are not supplied by the source projection.

Each node's type, resolved member/operator, conversion flags, semantic metadata
and ordered children are checked. Exported collection metadata binds field
initializers to symbols and makes ignored dimensions/arguments, local lists and
argument positions inspectable. Unknown constructs and unexplained metadata are
errors. Adding a supported statement changes the projected program; it is never
silently omitted. The new projector does not replace the previous arithmetic
certificate or its historical evidence.

The public Python API is `project_method(inventory)`, returning a JSON-serializable
source program, local/type bindings, record layout and the literal storage key.
`render_program(projection)` renders the corresponding Coq `list Stmt`. Input
inventory hashes are checked by the outer fresh gate; the projector does not
turn a caller-supplied JSON tree into independent proof of a C# parser.

Projection is linear in the helper tree and initializer inventory. Unsupported
inputs raise `SourceProjectionError` before a certificate is generated. The
regression suite mutates types, callees, source constants, write order, guards,
constructor/key bindings and hidden collection metadata. No production contract,
storage schema or deployment changes are required.

The framework transaction type is supplied through the pinned framework
reference, not exported as a repository record declaration. Its `Hash`,
`SystemFee` and `NetworkFee` fields are named dialect intrinsics at positions
0, 4 and 5. Each use must carry the exact resolved field ID and declared type.
The projection records that external contract together with immutable-byte
comparison, the 32-byte zero hash, the Array/Struct record relation, native codec
effects and the Buffer-valued storage key. Those contracts contribute to the
projection digest. The user-defined reimbursement record is handled separately:
its exact field order/types, synthesized constructor and both symbol-bound field
initializers are checked from exported source.

The key's initializer is traversed as a typed array allocation with an explicit
one-dimensional size and ordered byte elements. Dimension and element
collections must be complete; a manually supplemented fixture is not accepted
as an actual export. The `InitializedFields` collection identifies each
initializer's field, independently of its line number or neighboring text.

`fixtures/cap-method-source.json` contains an unmodified subset of one actual
export. Its recorded inventory digest identifies where the source tree came
from; fixture tests do not themselves authenticate live C# inputs. The outer
fresh gate authenticates those inputs. Semantic controls alter supported source
arithmetic, guards, return variables, constructor constants and statement order,
and require the resulting Coq program to change. Structural controls reject
missing/extra children, unresolved metadata, misleading collections, wrong types,
callees, conversion flags, field layouts and constructor bindings. The projector
never compares its source program against the NEF before choosing semantics.

The checked fixture is drawn from the inventory with SHA-256
`65a73399659594d72b8ae063f14fc64ed18120719111165b69f03785f81d7195`.
Its 14 top-level statements and eight typed locals produce source projection
`11f8b6974dd5278de323078483fd2d0312a4c6d028465831e83e0cfd96c2af31`.
The focused source-projection suite has 15 passing tests, including the original
missing-module red run and subsequent rejected incomplete array metadata and
malformed semantic-container controls. This result establishes checked frontend
projection and mutation sensitivity; the Coq certificate must still consume the
rendered source program and prove its relation to independently decoded bytes.

## Complete reimbursement-helper reference refinement

The certificate covers all **281 bytes / 116 instructions / 52 opcode names** at
`[18900,19181)` of `CapReimbursementToActualCost`. It compares the complete
14-statement source program, independently projected from the typed source
inventory, with an executable reference VM that decodes the actual NEF bytes.
No expected settlement is passed to a native-call oracle or substituted for a
bytecode instruction.

The universal result includes the storage-load branch, new-record construction,
both transaction-hash branches, fee arithmetic, the headroom guard against an
accumulation that would leave the signed range, rejection, aliased reservation
mutation, serialization, storage write and return. Separate classification
lemmas establish the expected return or rejection, storage snapshot and effect
trace. The final theorem excludes both accidental faults and fuel exhaustion on
its legal input domain; equality of two failing executions cannot establish it.

### Quantified domain and result

Inputs comprise a valid 32-byte transaction hash, two nonnegative signed-64-bit
fees, a positive signed-256-bit request, and either no stored ledger or a
well-formed two-field Array/Struct ledger. Its fields are a valid 32-byte hash
and a nonnegative signed-256-bit reservation. The method-entry frame supplies
one argument and an explicit static environment with slot 38 equal to
`Buffer[0x21]`. LDSFLD performs a lookup in that environment.

Let `r` be the stored reservation when the hashes match and zero otherwise,
`c` the sum of the two fees, and `q` the request. The independent observation
contract settles `q` for a zero-fee estimation, otherwise
`min(q, max(c-r, 0))`. Positive settlement stores the current hash and
`r + settled`; nonpositive settlement aborts without serialization or a write.
Paid ledgers with `r >= c` are included and universally reject. The domain does
not impose `r <= c`.

Zero-fee estimation additionally requires `r + q < 2^255`. The helper asserts
that headroom against the domain maximum before it accumulates, so a separately
kernel-checked actual-byte example shows the artifact rejecting with the margin
message instead of faulting on the overflowing addition, and the projected
source rejecting on the same assertion. Source BigInteger arithmetic remains
unbounded: the guard is a precondition the helper checks, not a change to source
arithmetic semantics.

### Source and environment contracts

The source language is the **Neo framework contract dialect**, not arbitrary
CLR execution. ByteString/UInt256 equality means immutable byte-value equality;
the source's object conversions do not establish CLR reference-identity
equivalence. The record cast, framework transaction projection, zero UInt256,
storage prefix and codec are explicit dialect/intrinsic contracts. The source
projector checks every statement and exported semantic collection and does not
consult the target NEF when building the source program. Roslyn/exporter and
source-projection correctness remain in the trusted computing base.

Arrays and structs have heap identities. DUP, loads and field writes retain
aliases. Serialize reads the current heap object; Deserialize allocates from
its input snapshot. The two record fields are scalar values, so the model makes
no nested-Struct clone theorem. Structured wire values stand for a codec
relation; they are not a proof of Neo's binary serializer, deserializer or
marshalling. The persisted typed-ledger invariant must be established by callers
and storage producers. Other shapes, including Maps, are outside this theorem;
the theorem does not assert that all such real-engine inputs fault.

The observed effect sequence includes Storage.Get, optional Deserialize,
Serialize of the resulting snapshot and Storage.Put of that snapshot. The three
GetScriptContainer calls and two GetContext calls are modeled as pure, stable,
nonfaulting getters. Their diagnostic call counts are tested in Python, but are
projected out of the proved trace. This permits the compiler's reordering of a
pure context read around serialization. Gas, call permissions, storage limits,
resource failures, callbacks and transaction rollback are external obligations.
The helper theorem does not prove `_initialize` establishes static slot 38.

### Verification and negative controls

Run the portable fixture and execution tests with:

```sh
python3 -m unittest discover -s formal/refinement -p test_method_proofs.py -v
```

The fixture test restores the exact original NEF from the archived script/token
data and the 68-byte header acquired from that candidate, then requires its
original full SHA-256. It uses no previous checkout, SDK/package cache or build
output. The independent source-only fixture supplies newer semantic collections.
This assembly is only for tests; it does not compile a replacement contract.
The production certificate requires a complete fresh exporter inventory and
rechecks every current input file:

```sh
python3 formal/refinement/method_proofs.py \
  --inventory /path/to/fresh-inventory.json \
  --output-dir /tmp/aa-cap-method-proof \
  --json-report /tmp/aa-cap-method-proof.json \
  --controls
```

Acceptance compiles with `coqc`, checks with `coqchk`, and prints assumptions for
every named model/certificate declaration, requiring the exact closed count.
The receipt binds the NEF, full script, complete method, source tree/projection,
proof certificate, models and Python tools. Inputs and tools are checked again
after the controls. The standalone CLI overwrites any old success receipt with
a failure receipt before work and retains failure on any error.

Six semantic controls first compile valid mutated definitions, then require the
kernel certificate to reject MIN changed to MAX, the reversed assertion branch,
a duplicated value left after the reservation write, a source return changed to
zero, an initial source reservation changed to one, and a deleted source
assertion. Syntax errors, missing tools and timeouts do not count as semantic
rejection. Execution tests also cover every one of the 116 actual instruction
offsets across their cases.

The receipt uses `scope: complete-helper-reference-refinement` and
`fullImplementationVerified: false`. This is a complete private-helper reference
proof under the stated contracts. It does not prove actual ApplicationEngine,
native binary codecs, gas accounting, compiler correctness, caller composition
or any of the **109 public ABI entrypoints**, all of which remain outside this
certificate.

## Complete reimbursement helper runtime checks

These tests execute the original private `CapReimbursementToActualCost` method in
the reviewed ordinary NEF, from PC 18900 through RET at PC 19180. They extend the
22-instruction arithmetic checks with transaction fields, initial storage, default
record construction, transaction-hash reset, actual native deserialize/serialize,
assertion, heap update and Storage.Put. They are concrete runtime correspondence
evidence, not a universal translation certificate or public deployment approval.

### Entry and artifact identity

The test deploys the unchanged candidate NEF/manifest and uses the public pinned
`ApplicationEngine.LoadContract` API with a test-only method descriptor pointing
at the original private method PC. That API executes the original `_initialize`,
which must establish static slot 38 as storage key byte `0x21`. The descriptor is
not added to the manifest. Original bytecode, tokens and native calls execute;
there is no source surrogate, copied arithmetic script or replacement native
codec. This private-method seam does not prove the two public entrypoint guards
or their complete caller paths.

NEF SHA256: `9f714866c5ba1b6cf31d63036d9805d73058055f325fd412e303356534ba2f76`.
Manifest SHA256: `a6533d47d4a72c3c8159923ce54cb136ab02acb0e9a8c5f24cf75bd4ea838e31`.
Script SHA256: `909ba759b66a4d84a4bd2aa2a2a78ef611c8b27e834b460a90f8ff83d387e1cd`.
Every offset in this file is inside `[18900,19181)`, the helper's current
281-byte, 116-instruction interval. The current build includes the VM-integer margin guard and the expanded helper
frame; the earlier 208-byte/96-instruction candidate is historical and is not
the artifact pinned by this document. Older revisions pinned NEF
`083ed325f9bdaa6b223662042f32d29f398ba055f507bbdde46daf8113c47f2a` /
manifest `e79fa04969ef3f0bdd6b9df6afe41acdd19767968575ea38c1cd011ee97e5156`
(pre-rename), and NEF
`6c347dac40bd562edda3216e40c7007fad3a2bb24020013e730c58bd4ceed1c3` /
manifest `8b6bd9623ab4ed293ad9b6fda27402aaf3100d0b2a9d5c44658edb7e83fb0c29`
(the 2026-10-30 build the 2026-11-16 legacy-compatibility sweep superseded);
neither is the artifact pinned by this document.
The runtime packages remain Neo/Neo.VM/Neo.SmartContract.Testing 3.10.1, locked by
the existing project. Relevant source commits are Neo
`d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d`, VM
`004cd6070a940405818d9357638277dd44407e2e`, and testing
`37c03d3e7db8d125efb968a1f1da455f3d205b26`.

### Cases and independent oracle

For well-formed ledger states the oracle is the protocol rule: keep reservation
only for the same transaction; otherwise reset to zero; for positive cost settle
`min(requested, max(cost-reserved,0))`; for zero-fee estimation settle requested;
a nonpositive settlement aborts. The runtime must serialize the updated hash and
reservation and return the settled amount. The oracle is not a translation of
the method's branchless opcode sequence.

Cases cover absent storage, same/new transaction, positive fees, exhausted fees,
zero-fee estimation, signed limits and reservation overflow. A genuine parsed
transaction permits nonnegative fees whose sum is at most `long.MaxValue`; helper
runtime checks do not prove sender funding, witnesses, consensus acceptance, GAS
burning or actual block persistence. The test host allocates execution GAS
independently so zero-fee RPC-style containers can execute the method.

Requested Integer, Boolean, ByteString, Buffer and Null inputs are tested against
the actual engine. ABI Integer metadata does not enforce the tag. ByteString and
Boolean numeric coercions are accepted where positive; Buffer/Null GetInteger
faults must not be silently classified as equivalent bytes/zero.

Injected Array/Struct/Map records, extra/missing fields, invalid bytes, wrong tags
and negative reservations probe the real deserialization and heap behavior. Such
states are explicitly outside the expected reachable ledger invariant unless
identified as a normal record. Accepted repairs or counterexamples do not by
themselves establish a reachable production defect.

### Persistence and failure boundary

The wrapper creates the genuine pinned ApplicationEngine with its own cloned
transaction snapshot and commits it only on HALT, matching the pinned native
block application persistence policy. It does not use TestingApplicationEngine
for the method call: TestEngine.Fee aliases Transaction.NetworkFee and would
otherwise change the fee/hash inputs while allocating host GAS. A successful helper can first commit its child snapshot into the pending
parent cache. A later parent ABORTMSG still prevents that cache from reaching the
original committed snapshot. Tests distinguish pending writes, child-call effects
and outer snapshot persistence; they do not call all of them the same rollback.
The native block path likewise commits successful application snapshots only,
but transaction fees burned by OnPersist are outside application rollback.

Malformed data, nonpositive settlement, arithmetic overflow, read-only call flags
and insufficient execution GAS must fault without committing the new budget.
The estimation case additionally needs a representable aggregate reservation; the
headroom branch compares `reserved <= (2^255-1) - settled` and rejects a violation
with its own ABORTMSG at 19149, so `reserved+settled >= 2^255` is a contract
rejection rather than a CLR integer-size exception escaping the ADD at 19155.
The 73-byte guard exists precisely because the accumulator ADD would otherwise
overflow outside the certified arithmetic region. No universal
zero-estimation completion guarantee is claimed.

### Acceptance and maintenance

Write the cases before the test execution helper and retain a failing first run.
Then run the new method suite against exact artifacts and preserve logs outside
the repository. No production source/artifact update, existing seven-test edit,
mainnet/testnet call or deployment is part of this work. The formal certificate
must separately establish source-domain guards, codec/heap assumptions, static
initialization, host effects, gas and storage refinement before whole-method
verification can be claimed.

### Observed local evidence

The new focused suite passes 38/38 with no skipped cases. The initial method
runner run was 31/31 failures; two later primitive CONVERT cases were also
recorded failing before their runner existed. The original seven arithmetic
runtime tests were not edited or rerun by this lane.

The twelve requested-tag cases include padded positive `[7,0]`, padded negative
`[ff,ff]`, signed 32-byte minimum/maximum, and 33-byte zero/negative encodings.
Positive ByteString and Boolean values execute; false/negative/Null/Buffer or
oversized numeric inputs fault as specified by the actual instructions. Separate
primitive checks distinguish explicit CONVERT(Integer): Buffer can convert to
Integer, while Null remains Null; neither makes the original helper implicitly
perform that conversion.

Successful calls assert the real initialized static slot 38 is a Buffer containing
`21`. The storage probes preserve Array/Struct/Map tags, normalize coerced scalar
reservation fields to Integer after ADD, preserve extra fields, and demonstrate
that a mismatched-hash Map missing reservation key can be repaired by SETITEM.
Injected negative reservation can produce a payment quote above paid fees: this
shows the importance of the reachable-ledger invariant, not a proven reachable
production exploit. The canonical produced record remains a two-field Array with
32-byte hash and nonnegative Integer reservation.

After a successful helper return, a later parent ABORTMSG leaves the new budget
visible in the pending parent cache but the original committed test store retains
its old bytes. Zero-fee successful cases commit only to this isolated test store
for readback; real RPC estimation normally discards its execution snapshot. The
host Block carries fixture index/time/nonce without validating a chain header,
and neither signatures, sender fee balances nor OnPersist are executed.

Logs and TRX receipts are outside the repository in the host temporary
directory and record the exact focused command. These finite observations do
not replace any open kernel proof, environment assumption or complete
public-entrypoint certificate.

## Reservation arithmetic refinement

### Current arithmetic result

`formal/refinement/coq/ReservationArithmetic.v` contains 24 closed declarations.
The dedicated host runner compiles it together with 29 imported declarations
from `IntegerSemantics`, `CapArithmetic`, and the actual existing
`OrdinarySponsorship`, audits every `Print Assumptions`, and rechecks all four
compiled modules with `coqchk`. Two runner tests and six definition-valid,
proof-rejected semantic controls pass. These are arithmetic/protocol results;
`suffixBytecodeVerified`, `fullHelperVerified`, and
`fullImplementationVerified` remain false.

The public composition interfaces are `checked_update_success_iff`,
`checked_update_nonpositive_fault`, `checked_update_overflow_fault`,
`paid_reservation_success_iff_remaining`, `paid_reservation_result_bound`,
`estimation_success_iff_representable`, `estimation_overflow_fault`,
`bounded_reserve_refines_protocol_when_sum_fits`, and
`same_transaction_iteration_preserves_fee_bound`. The
`estimation_overflow_protocol_disagrees` theorem explicitly prevents extending
the representable-success result into an unproved source/target fault claim.

### Intended statement

Extend the existing charge-region proof with the reservation's positive-charge
guard, its VM-integer headroom guard and signed 256-bit addition. The reviewed
current ordinary NEF contains the charge region at `[17860,17882)` and the
following guard/update suffix at `[17882,18011)`. The suffix compares local6
with zero, branches from 17885 to 17927 on success, otherwise executes `ABORTMSG`
at 17926. The success path materialises `vmMax = 2^254 - 1 + 2^254` into local7
beginning at 17927, then compares budget field1 with `vmMax - local6` at the
headroom branch around 17950 and aborts at 17999 when that remaining headroom
would be exceeded. Past the guard it reads budget field1, adds local6 at 18005,
and updates that shared record with `SETITEM` at 18009 followed by `DROP` at
18010. The endpoint loads the record onto the evaluation stack at 18011;
serialization from 18012 and storage follow and are not part of this suffix.

The headroom guard is a source-level assertion about the *remaining* budget, not a
checked-add. It aborts with `Reimbursement budget exceeds VM integer limit` when
`budget[1] > vmMax - local6`, so for admitted inputs the `ADD` at 18005 cannot
leave the VM signed range; the arithmetic layer below still models the case where
the guard is absent, which is why the estimation-overflow tolerance was narrowed
rather than deleted.

The first theorem layer will execute the guard and checked addition over
Integer-typed values. Its results distinguish a successful new reserved amount
from a zero-charge rejection and from a signed-integer overflow. It will import
the existing `OrdinarySponsorship.charge`, `reserve`, and `reserve_many` rather
than redefine their protocol meaning.

For a positive paid transaction, assume `0 < cost < 2^255`,
`0 < requested < 2^255`, and `0 <= reserved <= cost`. Success occurs exactly when
`reserved < cost`; the updated reservation is at most the transaction fee and
remains representable. Exhaustion rejects without an admitted successful state.
Iterating successful same-transaction reservations preserves this bound.

For zero-fee RPC estimation, assume representable nonnegative reserved and a
representable positive request. The quote equals the request. The reservation
succeeds exactly when `reserved + requested < 2^255`; otherwise the unchecked
addition would fault. In particular, `reserved = 2^255-1` and `requested = 1`
succeeds in the old charge region and is now rejected by the headroom guard at
17999, before the `ADD` at 18005 executes. The arithmetic layer keeps the
unguarded checked-add result as the case that this guard rules out; it does not
claim the target faults there.

This is target Integer behavior. CLR `BigInteger` addition and the imported
abstract `reserve` are unbounded; they admit that mathematical sum. A separate
counterexample theorem records this disagreement. No theorem here turns CLR
addition into checked arithmetic or claims matching source/target fault traces
through later serialization. The success-domain composition requires a
representable sum and a separate source/native-effect semantics for a complete
C# result.

### Conditional whole-helper plan

A whole-helper theorem requires separate certificates for actual bytes and
state effects. The suffix needs byte-addressed control flow, the actual branch
operand, stack shuffles, mutable Array/Struct identity and aliasing, `PICKITEM`
and `SETITEM`. Value-copy record semantics would be insufficient: the record
held in local2 must observe the write performed through its stack reference.

The method's earlier instructions must establish the typed ledger record,
transaction hash comparison/reset, nonnegative enclosing fee and region entry
invariants. Its later instructions must refine serialization, storage context,
single prefix0x21 write, return value and observable transaction faults. A
successful enclosing transaction must make the reserved amount visible before
external callbacks; transaction rollback and GAS require the matching host
semantics. None of these obligations follows from a source hash or a sample
execution.

The planned composition is therefore: actual charge certificate, actual
guard/update certificate, ledger/source projection, then whole-helper effects
and caller establishment. A layer may be reported closed only after its exact
kernel-checked certificate exists. Universal arithmetic lemmas alone do not
certify the suffix's bytes, storage effects, the complete helper, or all public
entrypoints.

### Verification and controls

Dedicated Coq and Python proof files will leave the old charge gate untouched.
Tests begin with a captured failing run. Coq compilation, closed-assumption
audits and `coqchk` must be real and fail when tools are absent. Definition-valid
semantic controls will alter the positivity guard, reservation addition,
overflow rejection, transaction-ledger scope and iteration. Proof inputs,
dependencies and generated certificates are hashed from the exact bytes
compiled and checked again after verification.

## Numeric coercion refinement

This work extends the reference model beyond Integer-tag-only arithmetic inputs.
It targets NeoVM 3.10.1, source commit
`004cd6070a940405818d9357638277dd44407e2e`. It does not modify production contracts,
the compiler, or the existing arithmetic certificate. Kernel checking the new
model does not establish that the runtime implements it; that correspondence
remains an explicit obligation until independently established.

Arithmetic opcodes call `StackItem.GetInteger()`. The pinned implementations
accept Integer values, Boolean values as zero or one, and ByteString payloads
of at most 32 bytes interpreted as signed little-endian two's complement.
Empty payloads represent zero. Redundant positive or negative sign bytes are
accepted within the size bound; canonical encoding is not an admission rule.
See [ByteString.GetInteger](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/ByteString.cs)
and [Integer construction](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/Integer.cs).

Buffer has no GetInteger override and arithmetic therefore rejects it, despite
its separate `ConvertTo(Integer)` implementation accepting a payload of at most
32 bytes. Null also rejects GetInteger, but `ConvertTo(Integer)` returns the
original Null, not numeric zero. Other unsupported tags reject GetInteger.
These separate paths must remain separate in the model. See
[Buffer](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/Buffer.cs),
[Null](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/Null.cs)
and [the base coercion](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/StackItem.cs).

`NumericCoercions.v` defines an executable decoder over byte lists and a separate
numeric value type. Its relationship to a typed source BigInteger is equality
to the decoded integer, not equality of VM tags. Physical bytes are constrained
to 0..255. Successful numeric values remain in `[-2^255, 2^255)`; oversized
payloads, unsupported tags and unrepresentable Integer constructors reject.
The proofs cover the decoding algorithm, range, sign extension and value
relation. They do not prove ABI argument admission, gas, heap identity,
serialization, transaction fees, or .NET BigInteger's implementation.

Run the independent gate with:

```sh
python3 -m unittest formal/refinement/test_numeric_proofs.py
python3 formal/refinement/numeric_proofs.py --output-dir /tmp/aa-numeric-proof \
  --json-report /tmp/aa-numeric-proof.json
```

The gate invokes `coqc` and `coqchk` and requires every reported declaration to
have no assumptions. Semantic negative controls change definitions while
preserving valid Coq syntax; each must fail a theorem after its definition-only
version has compiled. All existing refinement gates retain their original
scope until this model is explicitly composed into them.

`numeric_proofs.py` verifies 13 pinned runtime type-source files. By default it
uses `/tmp/aa-pinned-neovm-numeric-004cd607` and downloads only missing files
from the fixed official commit. Supply `--source-cache` to use another prepared
cache; changed cached bytes fail rather than being silently refreshed. Receipts
have scope `numeric-coercions`, `vmCorrespondenceProven: false` and
`fullImplementationVerified: false`. The host vector oracle is only a test
comparison; the kernel proofs use the independently defined decoding algorithm.

## ApplicationEngine fee semantics

This lane checks the complete `AddFee(BigInteger, bool)` body from Neo commit
`d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d`. A small rejecting source frontend
projects its statements, branch order, assignments and exception messages into
an independently interpreted Coq program. The generated certificate must prove
that program agrees with a fee specification for every input, including negative
charges, whitelist contexts, exact-budget success and over-budget failure.

The specification preserves the updated fee counter on insufficient GAS. It
does not erase earlier storage writes. Transaction and context snapshots are a
separate obligation. Negative input is rejected before the whitelist exemption.
Internal counters are mathematical integers in picoGAS; factor application uses
the actual declared `FeeFactor`, rather than a silently assumed datoshi unit.

The trace model checks charges before effects. Its erasure theorem states that
a trace with nonnegative charges and sufficient total budget performs the same
effects as the unmetered trace. An exhausted trace stops before the failing
event's effect. This is not yet a theorem that the complete contract emits that
trace or that the trace prices cover every opcode, syscall and native fee.

The source lexer/parser, Coq printing, C# BigInteger implementation and context
getter interpretation remain trusted. Kernel checking proves the projected
program, not arbitrary C# parsing or the .NET implementation. Source hashes bind
the input but do not discharge this semantic trust boundary. Actual engine
instruction scheduling, policy configuration, price tables, native dynamic fees,
resource limits and full ApplicationEngine correspondence remain separate work.

Validation requires positive `coqc` and `coqchk`, assumption checks for every
declaration, and valid-program mutations that change arithmetic, branch order or
the strict budget comparison. Syntax errors and timeouts do not count as proof
rejection.

## Public pure-method reference refinement

This lane certifies the complete bodies of three public ABI methods in the
ordinary candidate under declared reference semantics. It independently
projects their typed source, decodes their exact NEF bytes, and kernel-checks
source results, terminal behavior and frame preservation. It does not certify
ApplicationEngine, ABI dispatch, gas or public deployment. All 109 ABI entries
remain unproved for full implementation acceptance.

| Public method | Exact byte range, end exclusive | Bytes / instructions |
| --- | --- | --- |
| `getAccountImplementationId/0` | `[22447,22480)` | 33 / 3 |
| `supportsExecutionMode/1` | `[22480,22531)` | 51 / 18 |
| `supportsModuleType/1` | `[22531,22580)` | 49 / 18 |

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
  --output-dir /tmp/sa-public-pure-proof \
  --json-report /tmp/sa-public-pure-proof.json
```

The output directory must be new or empty. The CLI always runs the semantic
controls, writes a failing receipt before work, and replaces it with success
only after coqc, coqchk, every Print Assumptions audit and final input/model/tool
checks pass. Failure overwrites an old success receipt; its reason and kernel
logs remain available. The receipt binds source inputs, source tree/projection,
full NEF and script, each complete method, models, proof recipe and certificate.

Read `referenceVerifiedEntrypoints` as three reference-certified bodies, not
three fully accepted implementations. See the
[implementation boundary](SA-IMPLEMENTATION-REFINEMENT.md),
[entrypoint closure gate](SA-ENTRYPOINT-CLOSURE.md), and separate
[public runtime checks](#public-sponsored-entry-runtime-refinement).

## Public sponsored-entry runtime refinement

This suite executes the unchanged candidate NEF through its original public
`executeSponsoredUserOp` and `executeSponsoredUserOps` ABI using the base Neo
ApplicationEngine 3.10.1. It retains registration, native owner witness checks,
operation validation, nonce/locking, real SAPaymaster policy and GAS settlement.
The purpose is independent finite runtime evidence for the formal bridge, not a
universal compiler/VM refinement proof.

The tests observe the real core's single serialized reimbursement record at key
`0x21` before paymaster discovery and target callbacks. Two public calls share a
transaction fee budget; different-account nesting must see an outer reservation;
same-account nesting must fail the actual account lock. Later validation,
settlement, parent-script, read-only and gas failures must preserve original
committed account, sponsor and relay state.

Setup uses the existing RuntimeFixture deployment/account/policy facilities.
The measured public invocation uses a genuine base ApplicationEngine with a
separate hosting GAS allowance; TestEngine.Fee cannot supply that allowance
because it changes Transaction.NetworkFee. Transaction signer scopes are supplied
by the harness, and witnesses are not cryptographically verified. A test-only
adversarial target may call the original public ABI; it never substitutes core
validation, private helper execution, or the real paymaster.

Each invocation uses a cloned application snapshot. Successful cross-contract
frames commit to their parent according to the pinned engine. The harness commits
the outer transaction cache only on HALT and discards it on FAULT. Pending parent
writes can therefore exist after an outer abort without reaching the original
store. This is an explicit hosting policy consistent with native application
execution; it does not execute block persistence, sender funding checks, witness
verification, or native fee burning. Zero-fee vectors represent RPC estimation.

Native StdLib serialize/deserialize vectors pin Array/Struct tags and signed
integer wire length/padding. Expected bytes are fixed independently of a host
serializer, then compared with real native execution. Wire padding roundtrips
are canonicalized where observed. Receipts include artifact and runtime identity.

Run `dotnet test tests/SmartAccount.Contracts.Tests --filter
FullyQualifiedName~ImplementationRefinementPublicRuntimeTests`. No deployment,
ABI migration or production source change is required by this test-only addition.
Measured result on 2026-10-13: **12/12 PASS, zero skip**. Initial test-first
RED was 12/12. The codec case checks **33 exact native vectors**: 20 Array/Struct
records at signed integer boundaries, four integer normalization vectors, and
nine framing/tag probes. Integer zero is `2100`; `210100` canonicalizes to `2100`.
`21020700` canonicalizes to `210107` and `2102ffff` to `2101ff`. Buffer hash fields
preserve tag `30`; ByteString hash fields preserve tag `28`. Native deserialization
accepts tested nonminimal uint16/32/64 container counts, uint16 byte/integer lengths,
positive sign padding and trailing bytes. Reserialization emits minimal framing
and drops the trailing suffix. Negative ledger vectors describe codec behavior;
they do not establish the reimbursement invariant or reachable production state.

A successful single call exposes reservation 3 GAS at real paymaster discovery,
target execution and settlement. Single-plus-batch exposes 3 then 5 GAS and advances
three nonces. Different-account nesting reserves 3 then 5 GAS and emits settlements
2 then 3 GAS; same-account nesting reaches reservation 5 GAS but the actual account
lock aborts the whole invocation. Subsequent cap, nonce and real policy failures,
and an explicit outer ABORTMSG, leave the original sponsor deposit, relay GAS,
nonce, spending counter and ledger unchanged. Their parent application cache
retains the first successful child's 3-GAS ledger, demonstrating why HALT-only
outer persistence is necessary. A first-call reentry fault retains no parent ledger.
ReadOnly fails at the real forbidden syscall before callbacks; hosting GAS=1 fails
at the first charge (`FeeConsumed=30` datoshi), so that case is an early out-of-gas
probe, not proof of a failure after Storage.Put.

Receipts are generated under `Path.GetTempPath()` (macOS uses a `/var/folders/…`
directory). This run copied and read back durable evidence at:

- `<tmp>/sa-public-runtime-results/public-final.trx`
- `<tmp>/sa-public-final.log`
- `<tmp>/sa-public-red.log`
- `<tmp>/sa-public-native-codec-vectors.json`, SHA256
  `38cef261e60b5bf08ca11209991e657d919988e40ac5095043dea2e55c116bdd`
- `<tmp>/sa-public-runtime-evidence/`, 11 per-invocation JSON receipts with
  fee fields, independent hosting allowance, actual FeeConsumed, callbacks and
  committed/pending ledgers.

All public execution uses unchanged original NEF and ABI descriptors. The pinned
artifact identities are:

| Artifact | NEF SHA256 | Manifest SHA256 |
| --- | --- | --- |
| SmartAccountV3 | `4e5c8ae0c4b9722ae19e099303b6a61786de97cc4844abbc1ad458c3a76ce198` | `f7203fd84f6d132119df839a13249d73e4fe67644ca7a2e1c4ad6b9a1f6b21ed` |
| SAPaymaster | `c29738ab55d59c28608a6a646e5f36c4746d4158fccbde54079f11c2865d285a` | `49a51b95c284db4f7971b0f049f8e3e208f6a1f0b3cdce8631bcb6fd73ce0a54` |
| MockTransferTarget | `97d853d1f076abda4a1d6e44aa88ebdca01d390594a77ae03df2e164a7e181c0` | `3760aefced22c045b98414368e4c3eac5a6d9dc866a1b6f017c49c01518d401c` |

The SmartAccountV3 row named the current artifact when the table was written.
It moved three times after the dated paths above were captured: the rename to
`SmartAccountV3` shortened the script by 10 bytes
(`083ed325…` / `e79fa049…` → `be43cd05…` / `35fbb188…`), the helper's
VM-integer headroom assertion then grew it by 73 bytes, and the 2026-11-16
design-phase legacy-compatibility sweep changed it again (current NEF
`9f714866…`, manifest `a6533d47…`, as pinned by the regenerated five-shape
helper-gas runtime capture). Those files have not been recopied since any of
these changes, so they are evidence about an earlier build only and must be
regenerated before being cited for the current NEF. SAPaymaster and
MockTransferTarget were not affected by any of the three changes and their
rows are current.

MockTransferTarget is explicitly a compiled test target, not a production token.
The in-memory nesting adversary is also test-only. Actual GAS reimbursement uses
the native token. The loaded Neo and Neo.VM assemblies are both 3.10.1.0, with
InformationalVersion source commits `d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d`
and `004cd6070a940405818d9357638277dd44407e2e`. Tests fail closed on both loaded
file hashes: Neo `cb1b4db8076847dc23fda920ded773adaeeda07895effd350d2d8a99595a7f3a`,
Neo.VM `cea00a147add3c672bb23ffb5d98a4b1f31da135272efc258fee8fb7805bbfe9`.
These are bounded runtime cross-checks; no compiler-wide equivalence, arbitrary
callbacks, production wallet signer-scope integration or public-chain acceptance
is claimed.

## Syscall admission: `System.Contract.Call` and `CALLT`

`formal/refinement/coq/EntryDispatch.v` states its own entry boundary as
"after interop admission and argument conversion". This lane covers exactly
that excluded prefix. It is the first unit of the source-trust route: prove the
pinned C# frontend's decisions, and end where an existing kernel-checked
refinement already begins.

Nothing here moves `fullyClosed` off zero, and the reason is the same one
recorded in `SA-ENTRYPOINT-CLOSURE.md`: a closed entrypoint needs the
ApplicationEngine dispatch, the gas/exception/transaction composition and the
compiler correspondence as well, and none of those are in this lane.

### Pinned inputs

neo `d10e9cee`, neo-vm `004cd607`:

| file | why |
| --- | --- |
| `ApplicationEngine.Contract.cs` | the `System.Contract.Call` registration and `CallContract` |
| `ApplicationEngine.cs` | `OnSysCall`, `ValidateCallFlags`, `OnCallT`, the five-argument `CallContractInternal`, `Register` |
| `CallFlags.cs` | the four bit values and the three composites |
| `InteropDescriptor.cs` | `RequiredCallFlags` and `Parameters => Handler.GetParameters()` |
| `MethodToken.cs` | the token fields and the `Deserialize` guards |
| `EvaluationStack.cs` | `Pop` |

### What the projection derives rather than asserts

The record the kernel consumes is not written down by hand; every field is read
off the source text:

- `interop_pop_count = 4` and `interop_flag_slot = 2` come from the parameter
  list of the declaration named by `nameof(CallContract)`, because
  `InteropDescriptor.Parameters` is `Handler.GetParameters()`.
- `interop_required_flags = 5` is `Register`'s fourth argument evaluated against
  the enum's own composite definitions; `OnSysCall` passes exactly that to
  `ValidateCallFlags`.
- `token_required_flags = 5` is `OnCallT`'s own `ValidateCallFlags` argument.
- `call_all_flags = 15` is the right operand of `(callFlags & ~X) != 0`.
- The boolean fields are which statements are present.

Changing any of those source expressions changes the projection: `narrow-call-flags`
swaps `~CallFlags.All` for `~CallFlags.ReadOnly` and the derived value becomes
5 without any table being consulted.

### Two classes of guard

Only guards whose removal changes an outcome or a handed-off value are model
fields. Four pinned guards are reason refinements instead: the called contract
being absent, the ABI method being absent, the CALLT token index being out of
range (an unguarded array read throws) and the CALLT parameter count exceeding
the stack (an unguarded `Pop` throws). The unguarded code faults on the same
input, so a mutant of one keeps the same admission outcome and would prove
nothing. They are modelled as unconditional faults, and they are deliberately
absent from the 13 semantic controls.

What actually differs between the two paths:

| | `System.Contract.Call` | `CALLT` |
| --- | --- | --- |
| caller flag gate | `ReadStates \| AllowCall`, in `OnSysCall` | `ReadStates \| AllowCall`, in `OnCallT` |
| underscore check | `CallContract`, after the pops | not repeated — `MethodToken.Deserialize` already rejects it |
| `~CallFlags.All` range check | `CallContract` | not repeated — `Deserialize` already rejects it |
| `callFlags` source | the third popped stack value | `token.CallFlags` |
| callee arguments | the converted `Array` payload, opaque | the popped window |
| `IsDynamicCall` | set to `true` after the call | left untouched |

The last two rows are the substantive ones. `OnCallT` transfers the caller's
top-`n` window unchanged — `pop_window` in ascending order followed by the
descending push in `CallContractInternal` is the identity — so composing this
file with `EntryDispatch.v` gives a callee stack that is a contiguous, ordered
prefix of the caller's. `System.Contract.Call` has no such property: its callee
argument vector is a stack-item payload, which is why the model carries it as an
opaque input rather than pretending it is a window.

Ordering is proved, not assumed: `OnSysCall` validates the caller's flags and
pops every handler parameter before it invokes `CallContract`, so an exhausted
stack faults before the underscore rejection is even reachable, and a caller
without `ReadStates | AllowCall` never reaches it either.

### What the run produces

`formal/refinement/syscall_dispatch_proofs.py`:

- 35 model declarations, 11 certificate declarations, 46 closed assumptions,
  `coqchk -silent` clean, no `Axioms:` line.
- 13 semantic controls, one per discriminating field: each mutant's original
  behaviour fails to compile, and the `<>` counterexample both compiles and
  passes `coqchk`.
- `implementationVerified`, `fullImplementationVerified`,
  `sourceFrontendVerified` and `vmCorrespondenceProven` all stay `false`.

### Still open in this layer

- `AddFee`, gas metering and every resource exception. No cost is modelled. The
  charge itself is now covered separately by the
  [descriptor charge lane](#interop-descriptor-charge-and-window-effect): its ordering against the flag
  check and the first pop, the one-time factor, the whitelist bypass and the strict
  limit comparison. The `BigInteger` arithmetic and the exception identity remain
  open there too.
- `Convert` and the `Array` payload; the interop callee argument vector is an
  input, not a derived value.
- Exception identity. Every `Rejected` constructor is a fault, but whether it
  surfaces as `InvalidOperationException`, `ArgumentException`,
  `ArgumentOutOfRangeException`, `FormatException` or `IndexOutOfRangeException`
  is not modelled — which is precisely why the four reason-only guards above
  cannot be discriminated.
- Contract resolution, manifest/ABI reads, `MethodToken` deserialization at NEF
  load, policy whitelists and invocation counting.
- Trusted C# extraction and compiler/CLR correspondence.

### Registered as the seventeenth gate scope

> Forward: the conversion that turns the window into the handler's arguments is
> covered by the nineteenth scope, `interop-argument-conversion` — see
> [interop argument conversion](#interop-argument-conversion-kernel-checked-nineteenth-gate-scope). The fixed price this layer charges before that
> conversion is covered by the twentieth scope, `interop-descriptor-charge-order`
> — see [interop descriptor charge and window effect](#interop-descriptor-charge-and-window-effect). The frame this lane hands off *into* is
> covered by the eighteenth scope,
> `contract-internal-handoff-and-frame-construction` — see
> `docs/SA-CONTRACT-HANDOFF.md`.

The lane is registered in `formal/refinement/closure.py` as `syscall-dispatch`.
Because the gate now carries its own reviewed copy of this layer's taxonomy,
weakening a constant here no longer weakens the gate: the lane report, its
regeneration check and `join_scopes` would all still agree with each other.

What the gate does beyond the generic join:

- `join_scopes` compares the receipt's `program`, `handlerParameters`,
  `tokenFields`, control name list (ordered) and precondition/unproved/TCB text
  against `closure.py`'s own `SYSCALL_DISPATCH_*` constants, and requires
  `implementationVerified` and the four scope flags to be present and `false`.
- `validate_provenance` re-hashes `source-projection.json`, re-reads its
  `scope`/`entryBoundary`/`program`/`handlerParameters`/`tokenFields` and domain,
  checks the certificate's declaration inventory against `kernelDeclarations`,
  and re-reads `model.log`/`certificate.log` to confirm that each prints
  `Closed under the global context` exactly once per declaration with no
  `Axioms:` line.
- `main` regenerates the certificate bytes and the whole control inventory from
  the freshly captured pinned sources and compares them to the receipt.

The lane is deliberately **not** in `ARTIFACT_LANES`: it makes no claim about
the deployed contract, so requiring `nefSha256` to match would be wrong.

`test_syscall_dispatch_source.test_gate_pins_agree_with_this_lane` fails
immediately if the gate's copy and this lane's constants diverge, so such a
divergence is caught in a second rather than after a full gate run.

## Interop argument conversion (kernel-checked, nineteenth gate scope)

**Status: registered as the nineteenth closure scope**
(`interop-argument-conversion`). `InteropConvert.v` is a kernel-checked model,
`InteropConvertArtifact.v` is a certificate bound to the projected record, and 18
semantic controls re-check one pinned decision each. None of this closes an
entrypoint: the lane ends at the converted argument vector, before the handler
body runs. `implementationVerified` and `fullImplementationVerified` stay
`false`.

### Why this layer

The `syscall-dispatch` lane ([syscall admission](#syscall-admission-systemcontractcall-and-callt)) covers admission and
stops at the `CallContractInternal` parameter tuple; the `contract-handoff` lane
(`docs/SA-CONTRACT-HANDOFF.md`) starts inside the callee. Between them sits the
step that both lanes exclude: `OnSysCall` turning the caller's stack window into
the invoked handler's arguments, one `Convert(Pop(), ...)` per declared argument.

### Pinned inputs (neo `d10e9cee`, neo-vm `004cd607`)

| Key | Declaration |
| --- | --- |
| `core/engine` | `OnSysCall`, `Convert(object?)`, `Convert(StackItem, InteropParameterDescriptor)` |
| `core/contract` | the `CallContract` declaration, read for its four arguments |
| `core/interop-parameter` | `InteropParameterDescriptor` (the `IsArray` member, the converter table, the constructor) |
| `vm/limits` | `ExecutionEngineLimits.MaxStackSize` |

`ApplicationEngine.cs` from the pinned tarball is byte-identical to the copy the
entry-dispatch lane pinned, which is how the other three files were
authenticated before being pinned here.

### What the projection derives rather than asserts

- `counted_branch_max_length` is **evaluated** from the initializer expression
  (`2 * 1024 = 2048`), so a widened limit cannot pass silently.
- `array_branch_excludes_byte_element` is read off the `IsArray` declaration
  itself (`Type.IsArray && Type.GetElementType() != typeof(byte)`), not restated.
- `argument_count` is the arity of the pinned `CallContract` declaration, and the
  four argument types and names travel with it in `parameters`.
- The three converter-keying facts (`array_element_converter_from_element_type`,
  `enum_converter_from_underlying_type`, `identity_converter_for_plain_array`)
  are read from the constructor branch and the converter table, not assumed.

### Two classes of guard

**Reason-only, never mutated.** Removing them still faults on the same input, so
a mutant would keep the same outcome and prove nothing:

| Guard | Why removal still faults |
| --- | --- |
| `ValidateCallFlags(descriptor.RequiredCallFlags)` | the same call was already admitted by the dispatcher with these flags, so the call cannot reach here with a word the guard would reject |
| `descriptor.Validate(item)` | every reachable descriptor in this window was built with validators that the converter immediately re-checks on the same item |

### What the kernel proves

Nineteen field facts (one theorem per projected field) plus thirty structural
theorems. The ones that carry weight:

| Theorem | Claim |
| --- | --- |
| `the_vector_has_one_slot_per_declared_argument` | the argument vector has exactly one slot per declared argument, whatever the branches do |
| `conversion_never_grows_the_window` | converting one argument never adds an item to the window |
| `the_window_shrinks_by_the_arity` | with one pop per argument the window shrinks by at least the arity |
| `byte_element_leaves_the_array_branch` | a byte element leaves the array branch, and only because the field says so |
| `byte_array_arguments_differ_across_the_branch` | the same byte-array argument converts to a byte span on one side and to an array on the other, so the exclusion is observable |
| `counted_length_above_the_limit_faults` | a counted length **strictly** above the limit faults |
| `counted_length_at_the_limit_is_accepted` | the limit itself is accepted — the comparison is `>`, not `>=` |
| `counted_length_one_above_the_limit_faults` | the successor of the limit faults, which fixes the boundary from the other side |
| `counted_branch_takes_exactly_the_count` | the counted branch converts exactly the prefix it was told to |
| `counted_items_stay_when_the_pop_is_dropped` | dropping the pop leaves the counted items on the caller's window |
| `a_null_argument_faults_when_the_check_is_on` / `a_nullable_argument_accepts_null` / `a_stack_item_argument_accepts_null` | the null guard is the conjunction of three conditions, and each one alone can defeat it |
| `a_null_payload_element_faults` / `a_null_counted_element_faults` | both array branches reject a null element, and the counted branch reads it off the caller's window |
| `an_unknown_type_goes_to_the_interface` / `dropping_the_interface_flag_leaves_no_converter` | an unnamed type is reached through the interface converter, and dropping the flag leaves no converter at all |
| `a_void_return_pushes_nothing` / `a_value_return_pushes_one_item` | the return push is conditional on the handler's return type |
| `returned_nulls_are_dropped` | `OfType<object>()` drops the null elements of a returned array |

Every declaration is `Closed under the global context`; `coqchk -silent` passes;
no `Admitted`, `Axiom`, `Abort` or `Parameter` appears in the model.

### The eighteen controls

One textual mutation of the pinned source each, and each must change **exactly
one** projected field. Eighteen of the nineteen fields are covered this way; the
arity is the exception on purpose (see below).

| Control | Field it moves |
| --- | --- |
| `read-arg-count-from-the-stack` | `argument_count_from_descriptor` |
| `pop-twice-per-parameter` | `pops_one_item_per_parameter` |
| `fill-parameters-backwards` | `pop_order_is_reversed` |
| `push-void-return` | `return_pushes_only_for_nonvoid_handler` |
| `keep-null-return-elements` | `return_payload_drops_nulls` |
| `include-byte-arrays` | `array_branch_excludes_byte_element` |
| `convert-elements-with-the-array-converter` | `array_element_converter_from_element_type` |
| `convert-enums-as-integers` | `enum_converter_from_underlying_type` |
| `unknown-types-are-not-interfaces` | `unknown_type_is_interface` |
| `copy-plain-array-elements` | `identity_converter_for_plain_array` |
| `payload-length-is-not-the-item-count` | `payload_branch_length_is_item_count` |
| `fill-payload-elements-backwards` | `payload_branch_fills_in_index_order` |
| `fill-counted-elements-backwards` | `counted_branch_fills_in_index_order` |
| `keep-the-counted-items-on-the-stack` | `counted_branch_pops_the_count` |
| `weaken-the-stack-size-limit` | `counted_branch_max_length` |
| `allow-a-null-argument` | `null_argument_rejected` |
| `allow-a-null-payload-element` | `null_element_rejected_in_payload_branch` |
| `allow-a-null-counted-element` | `null_element_rejected_in_counted_branch` |

For each control the lane writes three files: `Definitions.v` (the mutant record,
which must compile), `OriginalBehavior.v` (the reviewed observation asserted
against the mutant, which must **fail** to compile) and `Counterexample.v` (the
negation, which must compile and pass `coqchk`).

### Three facts the kernel or the tests forced

- **`left` is reserved.** `left` and `right` are the `sumbool` constructors, so a
  record projection bound as `Some (values, left)` is parsed as the constructor
  applied to nothing. Every such binder is `remaining` instead.
- **An `andb` chain only reduces on its first argument.** The null guard is
  therefore spelled with the item test outermost. That is the same conjunction as
  the pinned source; the order is chosen so a non-null item leaves the guard
  `false` without consulting the descriptor, which is what makes the "a null
  argument faults" theorems close by computation.
- **`1 == True` in Python.** A program record whose boolean slot held an integer
  would render as a numeric literal into a `bool` slot. `program_expression`
  therefore rejects a non-`bool` in a boolean field and a non-`int` in a numeric
  one, and the gate compares the record with `literal_equal`, which compares types
  as well as values.

### Still open

- The per-type converter functions, their `BigInteger` narrowing and every
  `FormatException` they may raise; only their results are inputs here.
- The handler body, its return value and its continuation.
- Gas metering and descriptor pricing; only the *absence* of an add-fee step
  inside this window is recorded. The charge itself is covered by the
  [descriptor charge lane](#interop-descriptor-charge-and-window-effect), which owns the ordering,
  the factor identity and the fee limit.
- Reference counting, the disposables `Convert(object?)` adds, and payload
  aliasing between caller and handler.
- Trusted C# extraction and compiler/CLR correspondence; all 109 public
  entrypoints.

### Running it

```
AA_INTEROP_CONVERSION_SOURCE_MIRROR=<4 pinned .cs files> \
python3 formal/refinement/interop_convert_proofs.py \
  --output-dir /tmp/interop/out --json-report /tmp/interop/result.json
```

Without the mirror the lane downloads from `codeload.github.com` and still has to
hash to the same pinned bytes. The gate's own run of this lane inherits the same
variable.

## Interop descriptor charge and window effect

This is the twentieth selected scope. It covers what the
[interop conversion](#interop-argument-conversion-kernel-checked-nineteenth-gate-scope) lane excludes backward: that
lane's preconditions say the descriptor price "has already been charged" and its
open list admits that only the *absence* of an add-fee step inside the window is
recorded. This lane reads the charge itself out of the pinned C# and stops at the
argument-window effect.

**Status.** `implementationVerified` and `fullImplementationVerified` remain
`false`. This scope does not close an entrypoint and does not model the
conversion, the handler body, or how the fee factor is obtained.

### Pinned inputs

| Key | File | Pin |
| --- | --- | --- |
| `core/engine` | `src/Neo/SmartContract/ApplicationEngine.cs` | `97b08bfe…` at `d10e9ce` |
| `core/descriptor` | `src/Neo/SmartContract/InteropDescriptor.cs` | `84c7d8cc…` at `d10e9ce` |

Both pins are already reviewed by the `syscall-dispatch` lane, so the hashes are
not new evidence; the projection re-checks them on every run.

### What the source says

```csharp
protected virtual void OnSysCall(InteropDescriptor descriptor)
{
    ValidateCallFlags(descriptor.RequiredCallFlags);
    AddFee(descriptor.FixedPrice * _execFeeFactor, false);
    object?[] parameters = new object?[descriptor.Parameters.Count];
    for (int i = 0; i < parameters.Length; i++)
        parameters[i] = Convert(Pop(), descriptor.Parameters[i]);
    object? returnValue = descriptor.Handler.Invoke(this, parameters);
    ...
}
```

and `AddFee` itself:

```csharp
if (gas < 0) throw new InvalidOperationException("AddFee can't be negative.");
if (CurrentContext?.GetState<ExecutionContextState>()?.WhiteListed == true) return;
if (applyFactor) { gas *= FeeFactor; }
_feeConsumed = _feeConsumed + gas;
if (_feeConsumed > _feeAmount) throw new InvalidOperationException("Insufficient GAS.");
```

### The projected record

Fifteen fields, all derived from the text above rather than restated. The order
is the headline field: it is read by locating six anchors in the normalized
`OnSysCall` body and sorting them, so moving any statement changes it.

| Field | Reads |
| --- | --- |
| `step_order` | the six anchors, sorted by position |
| `charge_reads_the_declared_price` | `descriptor.FixedPrice` in the charge call |
| `charge_uses_the_exec_factor` | `_execFeeFactor` in the charge call |
| `charge_skips_the_inner_factor` | the charge call's second argument is `false` |
| `vector_length_from_descriptor` | `new object?[descriptor.Parameters.Count]` |
| `pops_one_item_per_parameter` | `Convert(Pop(), descriptor.Parameters[i])` |
| `arity_from_the_handler_signature` | `Parameters => … Handler.GetParameters() …` |
| `declared_price_type_is_long` | `public long FixedPrice { get; init; }` |
| `declared_price_may_be_zero` | the member's own doc comment |
| `negative_fee_is_rejected` | `if (gas < 0)` plus its throw |
| `whitelist_bypasses_the_charge` | the whitelist `return` sits before the counter |
| `factor_applied_only_when_requested` | `if (applyFactor) { gas *= FeeFactor; }` |
| `consumed_incremented_before_the_limit_check` | counter index < limit-check index |
| `limit_check_is_strict` | `if (_feeConsumed > _feeAmount)` |
| `no_fee_inside_the_conversion_window` | `AddFee` absent from both `Convert` bodies |

`reasonOnlyGuards` lists the two facts read but not mutated: the price member's
identity and where the fee factor comes from.

### What the kernel proves

| Theorem | Claim |
| --- | --- |
| `the_charge_sits_between_the_flag_check_and_the_conversion` | the reviewed order, all three relations at once |
| `a_rejected_call_charges_nothing_when_the_flag_check_comes_first` | a flags rejection pays 0 |
| `a_rejected_call_pays_when_the_charge_comes_first` | the same call pays the full price if the order is moved |
| `the_charge_is_paid_before_the_first_pop` | any conversion fault still leaves the charge applied |
| `a_conversion_fault_does_not_refund_the_charge` | faulting and succeeding charge the same amount |
| `a_conversion_fault_pops_only_the_converted_prefix` | pops = `min (S k) arity` |
| `a_fee_shortfall_pops_nothing` | a refused charge pops nothing |
| `the_charge_does_not_depend_on_the_arity` | two arities, one charge |
| `a_whitelisted_context_pays_nothing` / `…_still_pops` | the bypass skips the fee, not the work |
| `the_factor_is_applied_once_on_the_reviewed_record` | `3 × 5 = 15` |
| `asking_for_the_factor_twice_would_charge_seventy_five` | `15 × 5 = 75` |
| `dropping_the_inner_branch_also_doubles_the_charge` | the same 75 from the other direction |
| `a_zero_price_charges_nothing` | a zero `FixedPrice` is free at this point |
| `the_long_declaration_holds_a_price_above_the_int_range` | `3e9` survives `long`, not `int` |
| `a_zero_price_is_legitimate_on_the_reviewed_record` | zero is declared, not an error |
| `a_negative_fee_is_rejected` | the `-1` edge |
| `the_limit_accepts_a_call_landing_exactly_on_it` | strict `>`, so equality fits |
| `a_call_that_overruns_the_limit_is_refused` | `3 + 3 > 5` |
| `checking_the_limit_before_counting_would_accept_the_overrun` | the counter order matters |
| `the_conversion_window_adds_no_fee` | the window fee is 0 |

35 model declarations, all `Closed under the global context`, no axioms.

### Semantic controls

Sixteen, one per mutant, each moving exactly one projected field (`argument_count`
has no analogue here; every field is mutable). Two of them move the order:

| Control | Field moved |
| --- | --- |
| `charge-before-the-flag-check` | `step_order` |
| `charge-after-the-conversion-loop` | `step_order` |
| `charge-reads-another-price-member` | `charge_reads_the_declared_price` |
| `charge-multiplies-by-the-base-factor` | `charge_uses_the_exec_factor` |
| `ask-add-fee-to-apply-the-factor-again` | `charge_skips_the_inner_factor` |
| `size-the-vector-from-a-constant` | `vector_length_from_descriptor` |
| `convert-every-parameter-from-the-first-descriptor` | `pops_one_item_per_parameter` |
| `take-the-arity-from-an-empty-signature` | `arity_from_the_handler_signature` |
| `narrow-the-declared-price-to-int` | `declared_price_type_is_long` |
| `declare-the-price-always-nonzero` | `declared_price_may_be_zero` |
| `accept-a-negative-fee` | `negative_fee_is_rejected` |
| `charge-a-whitelisted-context` | `whitelist_bypasses_the_charge` |
| `always-apply-the-factor-branch` | `factor_applied_only_when_requested` |
| `check-the-limit-before-counting-the-charge` | `consumed_incremented_before_the_limit_check` |
| `reject-a-call-at-exactly-the-limit` | `limit_check_is_strict` |
| `charge-a-fee-inside-the-conversion-window` | `no_fee_inside_the_conversion_window` |

Each control compiles its `Definitions.v`, then asserts the reviewed observation
in `OriginalBehavior.v` — which must fail — and the negation in
`Counterexample.v`, which must pass `coqchk`. A control that still proved the
reviewed value would mean the field is decorative.

### Three facts this lane forced

1. **`_execFeeFactor` already carries the fee decimals.** The field is built as
   `policyFactor * FeeFactor` (`// Add fee decimals`), which is why the charge
   passes `applyFactor: false`. Passing `true` would square the factor; the
   `charge_skips_the_inner_factor` field and its control exist for that.
2. **The charge is outside the window on purpose.** A conversion fault aborts the
   frame, but the fee was already counted, so it is not refunded. Moving the
   `AddFee` call after the loop is the exact bug the order field forbids, and the
   `charge-after-the-conversion-loop` control shows the charge dropping to 0 on a
   fault when it is moved.
3. **`Fields` polarity, not field names, is what the join must agree on.** The
   first draft named the Coq field `fp_apply_factor` (true = double charge) while
   the projection named the same fact `charge_apply_factor` (true = the source
   passes `false`). The certificate failed with `Unable to unify "canonical_fee"
   with "actual_program"`. The field is now `fp_skips_the_inner_factor` on both
   sides, so `true` means the same thing everywhere.

### Still open

- The arithmetic of `_feeConsumed + gas` at `BigInteger` width, and whether a
  rejected charge surfaces as `OutOfGas` or as the generic invalid operation.
  Which exception that is, and what reaches the contract and the host when one is
  raised, is now its own scope: [exception identity](#exception-identity-and-catchability).
- How `_execFeeFactor` is obtained on each hardfork path (`policy` read, pico
  factor, hardcoded default); only the member identity is recorded.
- Which descriptors declare a zero `FixedPrice`; the lane only proves that the
  declaration permits zero.
- The conversion, the handler body and its return value — those stay in
  [interop argument conversion](#interop-argument-conversion-kernel-checked-nineteenth-gate-scope).
- Trusted C# extraction and compiler/CLR correspondence; all 109 public
  entrypoints.

### Running it

```sh
python3 formal/refinement/interop_fee_proofs.py \
  --output-dir /tmp/sa-interop-fee \
  --json-report /tmp/sa-interop-fee/report.json
```

Set `AA_INTEROP_CHARGE_SOURCE_MIRROR` to a directory holding
`core-engine.cs` and `core-descriptor.cs` to work offline; the mirror bytes must
hash to the same pins, so it cannot launder a different artifact.

## Exception identity and catchability

This is the twenty-first selected scope. Four lanes say "it throws" without
recording *which* exception reaches whom: the gas lane rejects a charge, the
syscall lane rejects an admission, the contract-handoff lane rejects a call, and
the conversion lane rejects an argument. Each records the rejection as a boolean
outcome and leaves the exception's identity open. This lane reads the surfacing
mechanism out of the pinned C# and stops at the fault-state effect.

**Status.** `implementationVerified` and `fullImplementationVerified` remain
`false`. This scope does not close an entrypoint, does not model instruction
semantics, and does not model the TRY-stack protocol or any transaction
composition.

### Pinned inputs

| Key | Repository | File | Pin |
| --- | --- | --- | --- |
| `vm/engine` | `neo-vm` | `src/Neo.VM/ExecutionEngine.cs` | `ea906436…` at `004cd60` |
| `vm/control` | `neo-vm` | `src/Neo.VM/JumpTable/JumpTable.Control.cs` | `a0ac51ff…` at `004cd60` |
| `vm/limits` | `neo-vm` | `src/Neo.VM/ExecutionEngineLimits.cs` | `b8353f47…` at `004cd60` |
| `vm/catchable` | `neo-vm` | `src/Neo.VM/CatchableException.cs` | `c6fbc18f…` at `004cd60` |
| `vm/unhandled` | `neo-vm` | `src/Neo.VM/VMUnhandledException.cs` | `71cd4912…` at `004cd60` |
| `core/engine` | `neo` | `src/Neo/SmartContract/ApplicationEngine.cs` | `97b08bfe…` at `d10e9ce` |

`vm/control` and `vm/limits` are already reviewed by the `runtime` and
`interop-conversion` lanes and `core/engine` by six others, so those three hashes
are not new evidence; the two exception classes and the VM engine file are new.
The projection re-checks all six on every run.

### What the source says

The instruction turn wraps only the opcode handler in a typed, guarded catch:

```csharp
try
{
    JumpTable[instruction.OpCode](this, instruction);
}
catch (CatchableException ex) when (Limits.CatchEngineExceptions)
{
    JumpTable.ExecuteThrow(this, ex.Message);
}
PostExecuteInstruction(instruction);
if (!isJumping && currentInstruction != null)
    context.InstructionPointer += instruction.Size;
isJumping = false;
```

and the outer handler is untyped, so everything the guard did not admit lands
there:

```csharp
catch (Exception e)
{
    OnFault(e);
}
```

`CatchableException` derives from `Exception` directly, which is what makes the
guarded clause narrow: an `InvalidOperationException` is not a
`CatchableException`, so it can never enter the typed handler. What the typed
handler hands over is the *message*:

```csharp
public virtual void ExecuteThrow(ExecutionEngine engine, StackItem? ex)
{
    engine.UncaughtException = ex;
    ...
            engine.Push(engine.UncaughtException!);
            executionContext.InstructionPointer = tryContext.CatchPointer;
            engine.UncaughtException = null;
    ...
    throw new VMUnhandledException(engine.UncaughtException!);
}
```

`VMUnhandledException` wraps the thrown `StackItem` in `ExceptionObject`, and the
engine records the exception object host-side while clearing the notification
set:

```csharp
protected override void OnFault(Exception ex)
{
    FaultException = ex;
    notifications = null;
    base.OnFault(ex);
}
```

### The projected record

Sixteen fields, each derived from the pinned text, each independently mutable.
`step_order` is a field, not a restatement: `guarded-catch` is anchored on the
`ExecuteThrow` call and `fault-handler` on the `OnFault` call, so moving either
block rewrites the order.

| Field | Source fact |
| --- | --- |
| `step_order` | `read-instruction` → `guarded-catch` → `post-hook` → `advance-pointer` → `fault-handler` |
| `catch_names_the_catchable_type` | the guarded clause names `CatchableException` |
| `catch_is_guarded_by_the_limit` | the clause carries `when (Limits.CatchEngineExceptions)` |
| `the_generic_handler_is_untyped` | the outer clause is `catch (Exception e)` |
| `the_caught_value_is_the_message` | the guarded handler is called with `ex.Message` |
| `the_fault_sets_the_state` | `OnFault` assigns `State = VMState.FAULT` |
| `the_thrown_value_is_recorded_at_entry` | `ExecuteThrow` opens by storing its argument |
| `a_handler_clears_the_recorded_value` | a taken handler clears `UncaughtException` |
| `the_handler_receives_the_thrown_value` | the taken handler pushes that stored value |
| `the_walk_skips_the_finally_and_consumed_catch` | the walk skips `Finally` and a spent `Catch` |
| `an_absent_handler_wraps_the_value` | the walk ends by throwing `VMUnhandledException` |
| `a_dedicated_catchable_type_exists` | `CatchableException` is declared and derives from `Exception` |
| `the_wrapper_keeps_the_thrown_object` | the wrapper keeps `ExceptionObject` |
| `the_engine_records_the_fault` | `ApplicationEngine.OnFault` stores `FaultException` |
| `the_engine_clears_the_notifications` | the same override clears `notifications` |
| `the_limit_defaults_to_catching` | `CatchEngineExceptions` declares `= true` |

### What the kernel proves

`coq/ExceptionIdentity.v` closes 29 declarations; the generated certificate adds
30 more, for `closedAssumptionCount = 59`. No `Axiom`, no `Admitted`, no
`Parameter` — `coqchk -silent` on the certificate exits 0 and both logs carry one
`Closed under the global context` per declaration with no `Axioms:` line.

| Theorem | What it settles |
| --- | --- |
| `the_reviewed_order_puts_the_catch_before_the_fault_handler` | the recorded order admits a catch at all |
| `a_fault_first_record_admits_nothing` | a reordered table cannot catch, whatever the types say |
| `an_uncatchable_exception_is_never_admitted` | admission is `false` for every record and limit |
| `an_uncatchable_exception_never_reaches_a_handler` | no handler runs for it, ever |
| `an_unguarded_record_catches_with_the_limit_off` | the limit matters only because the guard exists |
| `a_misnamed_catch_record_admits_nothing` | the clause's own type is load bearing |
| `a_caught_turn_receives_the_message` | what the contract gets is the message |
| `handing_over_the_object_would_break_the_message_guarantee` | pushing `ex` instead of `ex.Message` is observable |
| `failures_the_engine_does_not_catch_are_indistinguishable` | identity is erased on the fault path |
| `a_caught_turn_is_not_a_fault` | a taken handler leaves the turn running |
| `a_faulted_turn_skips_the_pointer_advance` | a fault ends the turn |
| `the_fault_path_always_clears_the_notifications` | the notification set is lost on every fault |
| `a_caught_throw_leaves_the_notifications_alone` | and kept on every caught throw |
| `the_wrapper_and_the_original_are_never_both_recorded` | the host sees exactly one of the two |
| `a_caught_turn_records_no_wrapper` / `…_no_exception_at_all` | a caught throw records neither |
| `a_wrapper_that_drops_the_object_leaves_the_host_with_a_shell` | the wrapper's payload is load bearing |
| `an_unrecorded_engine_leaves_the_host_with_no_exception` | `FaultException` is the only host record |
| `an_engine_that_skips_the_fault_assignment_loses_the_fault_state` | the state assignment is load bearing |
| `an_engine_that_keeps_the_notifications_leaks_them_on_a_fault` | so is the clearing |
| `swapping_the_hook_and_the_pointer_advance_keeps_the_catch_first` | the swap is order-visible but not admission-visible |

### The four paths, side by side

| Thrown class | Limit | Handler | Contract sees | Host records | Notifications |
| --- | --- | --- | --- | --- | --- |
| `CatchableException` | `true` | present | `ByteString(message)` | nothing | kept |
| `CatchableException` | `true` | absent | nothing | `VMUnhandledException` | cleared |
| `CatchableException` | `false` | either | nothing | the exception itself | cleared |
| anything else | either | either | nothing | the exception itself | cleared |

The first row is the only one where the contract observes anything, and what it
observes is a string. Rows three and four are deliberately identical: the type of
an exception the engine does not catch is not observable at all, which is why the
model has no field for it.

### Sixteen controls

Each control recompiles the model against one changed source fact, must fail to
prove the reviewed behaviour, and must prove the counterexample. Every mutation
moves exactly one projected field, and the sixteen cover all sixteen fields.

| Control | Field it moves |
| --- | --- |
| `drop-the-limit-guard` | `catch_is_guarded_by_the_limit` |
| `name-the-base-type-in-the-guarded-clause` | `catch_names_the_catchable_type` |
| `throw-the-exception-object-instead-of-its-message` | `the_caught_value_is_the_message` |
| `make-the-outer-handler-typed` | `the_generic_handler_is_untyped` |
| `fault-without-setting-the-state` | `the_fault_sets_the_state` |
| `skip-recording-the-thrown-value` | `the_thrown_value_is_recorded_at_entry` |
| `never-clear-the-recorded-value` | `a_handler_clears_the_recorded_value` |
| `push-a-null-instead-of-the-thrown-value` | `the_handler_receives_the_thrown_value` |
| `treat-the-finally-frame-as-a-catch` | `the_walk_skips_the_finally_and_consumed_catch` |
| `let-the-unhandled-value-escape-unwrapped` | `an_absent_handler_wraps_the_value` |
| `give-the-catchable-exception-no-dedicated-type` | `a_dedicated_catchable_type_exists` |
| `drop-the-wrapped-object` | `the_wrapper_keeps_the_thrown_object` |
| `fault-without-recording-the-exception` | `the_engine_records_the_fault` |
| `keep-the-notifications-on-fault` | `the_engine_clears_the_notifications` |
| `default-the-limit-to-off` | `the_limit_defaults_to_catching` |
| `swap-the-hook-and-the-pointer-advance` | `step_order` |

### Three facts this lane forced

**The tokenizer has no `#` token, so the pinned engine cannot be read as-is.**
`ExecutionEngine.cs` carries two `VMPERF` regions that print to the console.
They assign no state, and they sit inside both of the bodies this lane reads.
The lane therefore drops preprocessor *lines* before projecting and hashes the
raw bytes: the pin is still over the whole file, only the projection skips
directive syntax the shared tokenizer cannot express. This is recorded in the
lane's `tcb`, not hidden in a helper.

**A guard and a conjunct are not the same thing.** The first version of `admits`
multiplied `guard` into `limit`. That reads naturally but is wrong: with the
guard *absent*, admission then required `limit` to still hold, so dropping the
guard made everything uncatchable. The correct reading is an implication —
present guard implies the limit must admit; absent guard implies the limit is
irrelevant. `an_unguarded_record_catches_with_the_limit_off` is the test that
pins this down, and the mutation that drops the guard is the control that would
have silently passed under the wrong reading.

**One projected field was redundant and had to go.** `guarded_handler_precedes_
the_generic_one` looked like a real fact, but every mutation that could move it
also moved `step_order`, so it could never be isolated by a single-field control.
`step_order` already contains `guarded-catch` before `fault-handler`, so the field
was deleted rather than left uncovered. The lane now has exactly one control per
field and one field per control.

### Still open

- Which concrete exception type each individual engine operation throws. This
  lane records the catch clause's identity and the surfacing rule, not the throw
  sites of every opcode.
- Whether any host ever constructs an engine with `CatchEngineExceptions` off.
  Only the declared default and the guard position are recorded.
- The fault-message text and any client-visible diagnostic derived from it.
- Rollback of ledger and storage effects after a fault, and the transaction
  composition that decides whether a faulted execution is committed or discarded
  — the remaining part of `GAS_RESOURCE_EXCEPTION_AND_TRANSACTION_COMPOSITION`.
- Trusted C# extraction and compiler/CLR correspondence; all 109 public
  entrypoints.

### Running it

```sh
cd formal/refinement
python3 -m unittest test_exception_identity_source       # 25 tests
python3 exception_identity_proofs.py \
    --output-dir /tmp/exid --json-report /tmp/exid/exception-identity-proof.json
```

A full run takes about two and a half minutes: two `coqc` passes plus `coqchk`
for the model and the certificate, then four kernel commands per control.
