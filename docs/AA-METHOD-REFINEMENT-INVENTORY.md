# Whole-helper refinement inventory

This is a structural inventory and implementation plan. It proves no VM, ApplicationEngine, compiler, storage, or whole-method semantics. The current arithmetic certificate remains a region certificate; it cannot establish a whole-method certificate.

## Current artifact summary (2026-10-30)

The current SmartAccount V3 NEF is
`6c347dac40bd562edda3216e40c7007fad3a2bb24020013e730c58bd4ceed1c3`
with script SHA256
`b7fa49f95cf7ba5fbc9676de60bc7917331687b6dd6d2dfc52a2fbcee1b95913`.
Its `CapReimbursementToActualCost` helper is the complete interval
`[17762,18043)`: 281 bytes, 116 instructions, and 52 distinct opcode names.
The initializer is `[29415,30097)`: 682 bytes and 182 instructions. The helper
reads static slot 38; the initializer stores the reimbursement key with
`PUSHDATA1 21` at 29909, `CONVERT Buffer` at 29912, and `STSFLD 38` at 29914.
The current compiler artifact has 105 ABI entries, not the historical 100.

## Historical candidate and scope

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

Only `INITSLOT` at 13557 has no exact declared source point; the other 115 instructions have explicit debug source points. The optional existing arithmetic certificate claims 22 instructions, leaving 94 method instructions unaccounted for by that certificate. These are counts of declared coverage, not proof acceptance.

The two `LDSFLD` instructions at 13568 and 13822 use static index 34, named `Prefix_TransactionReimbursement`. Outside this helper, initialization is `25432: 0c0121` (PUSHDATA1 containing `21`), `25435: db30` (CONVERT to Buffer), `25437: 6722` (STSFLD 34). (These three offsets are 10 lower than in the pre-rename build `083ed325…`, which kept the same `LDSFLD` sites at 13568/13749 but was 10 script bytes longer after `getAccountImplementationId`.) Thus a helper entry-state specification must bind slot 34 to `Buffer([0x21])` and establish that initialization ran. Those three initializer instructions are not part of the 116-instruction helper.

## Interpreter and correspondence split

1. **VM control and data operations.** Extend the existing arithmetic semantics with `INITSLOT`, static fields, Null/ByteString/Array/Struct values, PACK, stack rearrangements, field mutation, equality, conditional/unconditional branches, ABORTMSG, and RET. Preserve actual pc, slot counts, stack order, type/index faults, object aliasing, and frame conditions; do not replace the method with its source formula.
2. **Explicit environment outcomes.** Give the seven SYSCALL sites and two native CALLT sites success/fault relations. Bind repeated script-container reads to the same transaction and bind the static field at index 34 to the initialized reimbursement key. State deployed-contract/context and ReadStates/WriteStates/AllowCall assumptions. Model absent storage separately from deserialization and the matching/different transaction-hash paths.
3. **All helper paths.** Certify all 116 instructions against an explicit two-field stored-budget invariant, or extend the value model to other deserialized shapes and their type/index faults. Include settled<=0 ABORTMSG and reservation overflow before serialization; the arithmetic proof alone does not establish these paths. Observe returned settlement and the serialized budget stored under the correct contract/key, with other state unchanged on the success path.
4. **ApplicationEngine composition.** Connect the environment relations to pinned handler implementations, native dispatch, conversion, fee charging, contract permissions, hardfork selection, snapshot ownership and rollback. A helper-under-environment theorem is distinct from this correspondence and from complete transaction/caller refinement. Do not label either partial layer as full implementation verification.

## Pinned ordinary ApplicationEngine boundary

Target Neo core: [`d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d`](https://github.com/neo-project/neo/tree/d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d); Neo VM: [`004cd6070a940405818d9357638277dd44407e2e`](https://github.com/neo-project/neo-vm/tree/004cd6070a940405818d9357638277dd44407e2e). These are the public ordinary track, separate from the native AA fork. The source hashes below attest the files inspected for this plan, not a proof of their runtime behavior.

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

## Complete instruction and source-point list

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
