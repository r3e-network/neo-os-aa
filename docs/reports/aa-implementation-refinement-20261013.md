# Ordinary C# / NEF / VM refinement — 2026-10-13

**Full implementation refinement is NO-GO.** This revision adds an executable,
artifact-bound proof lane and closes one arithmetic region. It does not prove a
complete public method: all 100 ABI entries remain explicitly unproved. The
default fresh command returns `2`, with `implementationVerified: false`.

The production contract and candidate NEF are unchanged. Ordinary and native
implementations remain on local `main`, under their existing separate entry
folders. This work does not certify public deployment or native activation.

## What is proved

The exporter loads the audited NCCS 3.9.1 package, exports typed Roslyn operations,
and rebuilds an isolated source copy. Its NEF must match the original bytes and
its complete manifest must match the original semantics. An independent decoder
pinned to Neo.VM 3.10.1 checks every instruction and structural edge from the raw
NEF bytes. The inventory covers 254 bound inputs, 100 ABI entries, 25,557 script
bytes, 8,813 instructions, 120 used opcodes and 9,430 structural edges. The 815
source methods include framework and non-target compilation types; this is not
a reachable-method count or a semantic coverage percentage.

For `CapReimbursementToActualCost`, typed source declarations at lines 66–68 are
projected to a formal expression independently of the target instructions. The
certificate contains the actual 22 bytes at PC `[13667,13689)`:

```text
11116bb99f74106b6a11ce9fba6c78a09e756d78b976
```

Coq universally proves their result under the declared, gas-erased reference
semantics. Preconditions include `0 <= cost,reserved < 2^255`,
`0 < requested < 2^255`, Integer-tagged values in the specified argument/local
slots, an Array or Struct budget record, seven existing locals and an empty
evaluation stack. The result equals the typed source expression and the existing
`OrdinarySponsorship.charge`; execution reaches the exact end with an empty
stack, unchanged arguments and locals 0–3, and seven locals. Intermediate
arithmetic stays representable. This is a proof about the concrete region bytes
under reference semantics, not a proof of the Neo.VM C# interpreter itself.

Host Rocq 9.2 and the pinned Coq 8.18 container both accept the certificate and
recheck compiled objects with `coqchk`. Each checks 38 closed declarations:
**23 new/local declarations and 15 imported protocol declarations**. The latter
already belong to the historical 490-model-declaration count and must not be
counted twice. All declarations are closed without admitted goals or axioms.
The generated certificate bytes are identical across both environments.

## Verification evidence

| Check | Result |
| --- | --- |
| Inventory/parser/identity gate regressions | 31/31 |
| Independent raw NEF decoder regressions | 15/15 |
| Typed source exporter regressions | 6/6 |
| Coq runner regressions | 5/5 on host and 5/5 in pinned container |
| Definition-valid semantic controls | 9/9 rejected on host and container |
| Actual Neo.VM runtime tests | 7/7, zero skipped |
| Full default CLI | Exit 2; 100 unproved ABI entries, full verification false |
| Explicit partial CLI | Exit 0; same proof/input identities, full verification still false |

The nine kernel controls change three target arithmetic operations, three source
IR operations/constants, one frame write and two reference-semantic rules
(overflow and operand order). Their definitions compile before their proofs are
rejected. Malformed AST, ignored sibling statements, invalid types/callees/flags
and locating executable code inside PUSHDATA payloads are separate input-binding
regressions, not additional semantic-proof controls.

The seven runtime tests load the entire original NEF into pinned Neo.VM 3.10.1,
use its original seven-local/one-argument frame and execute the original PC range.
They check 806 input cases against an independently written conditional oracle,
11 valid-opcode mutations and three signed-overflow controls. They also exercise
the real exhaustion ABORTMSG at PC 13733 and reservation ADD at PC 13739 outside
the certificate. These finite executions support the model/runtime connection;
they do not prove it universally.

Independent review found and closed omitted control-flow inventory, payload-as-code
locators, ignored source siblings, input/hash races, added-compilation-file drift
and unbound proof-template/model dependencies. Inputs and their membership are
checked before and after the relevant stages. Missing tools, malformed artifacts,
unsupported source constructs and stale inputs fail rather than supplying proof.

## Artifact identity

| Artifact | SHA-256 |
| --- | --- |
| Candidate NEF | `083ed325f9bdaa6b223662042f32d29f398ba055f507bbdde46daf8113c47f2a` |
| Candidate complete manifest | `e79fa04969ef3f0bdd6b9df6afe41acdd19767968575ea38c1cd011ee97e5156` |
| Fresh inventory, uncompressed | `1504bf3c5c3a72821b40394aa00c4a929081b403a3954ece710c92eea453ae17` |
| Generated CapArtifact.v | `c1191e625a9a36f1b9ab6f76764bc2f205bd2a5b236a883529d12688c88f7ac3` |
| Host proof receipt | `38e8ab4c66b6a27bd8aed9ac723fb1cce5dda5416523c1fdb31d1dfa740bc2df` |
| Container proof receipt | `a94dce7e314d3a74d4c89b98576def1661d428130c2d50b9c2cc0766a64f0cb1` |
| Executed Neo.VM.dll | `cea00a147add3c672bb23ffb5d98a4b1f31da135272efc258fee8fb7805bbfe9` |

The container ran image
`sha256:49175ab91d07c3446004b93c667b581d34c1702b61cc1d937c8218f439b00941`
with networking disabled and individually hashed, read-only copied inputs. The
Dockerfile and tool pins were unchanged. Colima was restored to stopped and the
Docker context to `default`; both were independently read back after completion.

The [evidence index](aa-implementation-refinement-20261013/evidence.json) hashes
the retained [host result](aa-implementation-refinement-20261013/host-result.json),
[host proof](aa-implementation-refinement-20261013/host-proof.json),
[container validation](aa-implementation-refinement-20261013/container-validation.json),
[generated certificate](aa-implementation-refinement-20261013/CapArtifact.v),
[runtime receipt](aa-implementation-refinement-20261013/runtime.json), compressed
typed inventory, semantic-control proof sources, kernel logs and test logs.
The two proof receipts differ only in the kernel-version string. Fresh inventories
can differ in the debug export's temporary `document-root`; source, compiler,
NEF, manifest and bound-input maps were equal in the compared exports.

## Remaining full-method obligations

| Boundary | Concrete evidence location | Required proof |
| --- | --- | --- |
| Caller guards and value tags | Single call PC 13926; batch call PC 14572 | Positive guards dominate the calls; values enter the Integer reference relation, or coercion semantics are added |
| Budget read/default/reset | PC 13560–13650 | Static slot 34 means storage key `0x21`; codec preserves `[hash,reserved]`; reservation is nonnegative; changed transaction hash resets it |
| Transaction fee source | PC 13651–13666 | Script container is the transaction; fields 4/5 are its stable system/network fees |
| Assertion and reservation addition | PC 13689–13744 | Successful paid charge preserves `reserved + settled <= cost`, and the addition is representable |
| Serialization, write and return | PC 13746–13764 | Encoding preserves the record; storage effects and failures follow the specified state relation |
| External settlement | Paymaster source lines 100–116 and 155–169 | Reservation is visible before nested calls; failures restore application state, with transaction fee burning treated separately |

Pinned Neo transaction decoding rejects negative fees and signed-long addition
overflow, so valid deserialized transactions satisfy `cost <= long.MaxValue`.
Reaching the method with positive cost still requires an execution argument.
The inspected arbitrary frame `cost=0,reserved=2^255-1,requested=1` succeeds in
the proved region but faults at the later reservation ADD. This is a boundary
counterexample, not an established reachable chain defect. Zero-fee estimation
needs a reservation bound or explicit overflow-fault semantics; the existing
unbounded-Z ledger model cannot automatically establish that correspondence.

ABI dispatch checks arity rather than enforcing every Integer tag. Pinned VM
[ByteString](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/ByteString.cs#L80-L83)
and [Boolean](https://github.com/neo-project/neo-vm/blob/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/Types/Boolean.cs#L57-L59)
values support integer conversion. A positive guard therefore does not by itself
prove the Integer-tagged frame precondition.

Beyond this helper, all entrypoints, initializers, reachable helpers and loops
need certificates. Heap/reference identity, exceptions and full transaction
rollback, external calls/reentrancy, gas/resource accounting, Roslyn/debug
frontend correctness and correspondence to the actual ApplicationEngine remain
open. The existing protocol proofs and local runtime tests do not discharge them.

## Reproduction

```sh
python3 formal/refinement/verify.py --output-dir /tmp/aa-refinement-fresh
python3 -m unittest discover -s formal/refinement -p 'test_*.py'
python3 -m unittest formal/refinement/export/test_export.py
dotnet test tests/AbstractAccount.Contracts.Tests/AbstractAccount.Contracts.Tests.csproj --no-restore --filter 'FullyQualifiedName~ImplementationRefinementRuntimeTests'
```

Use a new output directory. The first command currently returns `2` by design;
the other commands run the scoped verification tests. `--allow-partial` is an
explicit region-development option, never the complete-refinement release gate.
The exporter [README](../../formal/refinement/export/README.md) describes the
audited compiler location override. Container commands and their exit results
are retained in `container-commands.json` in the evidence directory. No remote
push, public-chain write, deployment or signing occurred.
