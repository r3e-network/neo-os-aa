# Ordinary implementation refinement

## Acceptance objective

The target is the ordinary `SmartAccountV3` source and its exact compiled
NEF/manifest, including all public entrypoints and their reachable helpers. The
required result is semantic preservation from typed C# operations to decoded
NeoVM execution, followed by preservation of the protocol properties already
proved in the ordinary models. A passing handwritten model, matching hash,
compiler build, trace sample or differential test cannot supply that theorem.

The existing ordinary candidate acceptance remains valid for its documented
scope. Full implementation refinement remains unverified until the requirements
below have independently checked certificates. No production contract behavior,
compiler pin, public deployment or original user changes are modified to make a
proof gate pass.

## Proof architecture

1. **Concrete inputs.** Decode the actual NEF container and manifest; retain the
   original bytes, checksum, tokens, every instruction boundary and ABI offset.
   Parse the selected C# compilation with its exact types, references, constants
   and conditional symbols. Source locations and compiler debug data are hints
   for locating obligations, not proof that a translation is correct.
2. **Source semantics.** Give each supported typed operation executable formal
   semantics. Specify evaluation order, checked and unchecked integer behavior,
   `BigInteger`, nulls, references, aliasing, arrays, exceptions and calls.
   Reject unrecognized operations rather than translating them to an unconstrained
   value or a no-op. Native/framework calls need explicit effect contracts.
   The source dialect must be fixed before checking the target. In particular,
   CLR `BigInteger` arithmetic is unbounded while NeoVM integers have a signed
   32-byte limit. A preservation theorem over a restricted input domain must
   state that domain and separately prove that real entry guards establish it.
   String encoding/length and CLR versus VM exception behavior also require
   explicit semantics; target behavior cannot redefine the source after the fact.
3. **Target semantics.** Interpret concrete decoded instruction operands,
   stack values, locals, statics, control flow and call frames. State the limits
   imposed by the selected NeoVM, including integer width, stack depth and gas.
   Faults, notifications, storage and external calls are observable behavior.
4. **Translation certificates.** Prove a simulation relation between the source
   and target states. Straight-line expression certificates are useful only for
   their exact region. Whole methods require every branch and reachable helper;
   loops require inductive invariants and termination or divergence treatment,
   not a finite unrolling reported as a universal proof.
5. **ApplicationEngine boundary.** Relate syscall/native-call specifications to
   the pinned runtime implementation. Witnesses, storage serialization, nested
   calls, reentrancy, gas exhaustion and transaction rollback cannot be replaced
   by unconditional-success assumptions. Cryptographic assumptions and host
   services must be stated explicitly in the trusted computing base.
6. **Composition and coverage.** A public method is verified only when its
   certificate, dependencies and environment obligations are all discharged.
   All manifest entries, initialization paths and reachable instructions must be
   accounted for before `implementationVerified` can become true.

Artifact-specific translation validation avoids requiring a theorem for every
program accepted by NCCS. It still requires checked semantics and certificates
for the complete selected artifact. This follows the semantic-preservation
distinction in the [CompCert manual](https://compcert.org/man/manual001.html)
and its [research objectives](https://compcert.org/research.html). The concrete
target is the pinned [NeoVM implementation](https://github.com/neo-project/neo-vm),
not an unrelated stack-machine model with similar opcode names.

## Layered proof lanes

The reimbursement work separates the following evidence. A certificate in one
row does not discharge the obligations in another; shared imported declarations
must not be added together as if each receipt contained disjoint proofs.

| Lane | Checked statement and boundary |
| --- | --- |
| Protocol models | `formal/verify.py` checks the declared ordinary/native abstractions. Its model receipts do not establish source-to-NEF refinement. |
| Arithmetic region | `prove.py` binds the original charge instructions to signed-256 reference arithmetic and `OrdinarySponsorship.charge`. Its scope remains the local region. |
| [Numeric coercions](AA-NUMERIC-REFINEMENT.md) | Models GetInteger decoding and its value relation, including Boolean and ByteString. This does not prove ABI admission or actual runtime correspondence. |
| [Reservation arithmetic](AA-RESERVATION-REFINEMENT.md) | Adds positivity, representable reservation updates and protocol fee bounds. It records the zero-fee overflow disagreement with unbounded arithmetic. |
| [Complete helper reference refinement](AA-CAP-METHOD-REFINEMENT.md) | Compares the complete typed-source projection with a byte-decoding reference VM for `CapReimbursementToActualCost`, under declared input and environment contracts. It does not certify ApplicationEngine or public entrypoints. |

The [source projection](AA-METHOD-SOURCE-REFINEMENT.md) records which typed
operations and semantic metadata are interpreted. The
[method inventory](AA-METHOD-REFINEMENT-INVENTORY.md) accounts for all helper
instructions and separate static initialization; structural coverage alone is
not semantic proof. The [runtime checks](AA-METHOD-RUNTIME-REFINEMENT.md) execute
the original helper in the pinned engine and distinguish valid inputs,
malformed records, pending storage and enclosing transaction rollback. Those
checks provide finite runtime evidence, independently of universal reference
theorems.

## Neo contract dialect and object identity

The complete-helper source interpretation is a declared **Neo framework
contract dialect**, not an interpreter for arbitrary CLR object execution.
ByteString and UInt256 represent immutable byte values; hash equality in this
interpretation compares their contents. Arrays/Structs that hold the mutable
reservation record retain heap identity and aliases, so a write through a stack
reference updates the object still held by a local. Serialization observes that
object, while deserialization constructs a fresh object from stored contents.
These are distinct identity rules, not one blanket value-copy rule.

A CLR reference comparison between separately allocated objects does not
automatically satisfy the byte-value equality contract. Exporting an operation's
type or symbol also does not prove the compiler lowers it according to this
dialect. Framework/compiler correspondence, repeated GetScriptContainer reads
of the same transaction, static initialization and native codec behavior remain
named obligations. A receipt must retain them rather than present its dialect
theorem as preservation of general .NET behavior.

The [reimbursement policy](SECURITY_MODEL.md) requires one reservation ceiling
per transaction within each ordinary core. The helper reference theorem assumes
a stable 32-byte transaction hash, nonnegative signed-64-bit fees and either no
ledger or a well-formed two-field ledger with a 32-byte hash and nonnegative,
representable reservation. A chain-level composition must establish that
reachable persisted records satisfy this invariant and that equal hash bytes
identify the same transaction across calls. The policy does not itself prove
these codec and identity contracts. Malformed externally supplied storage must
not be treated as an admitted reachable state or silently repaired by a proof
oracle. The [native profile draft](proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md)
sets `nativeSponsorship: false`; this ordinary reimbursement proof is not a
native sponsorship standard or activation claim.

## Evidence and error behavior

The refinement gate must distinguish input inventory, structural validation,
bounded execution, universal semantic proof and full implementation acceptance.
It records exact source, NEF, manifest, semantic model, certificate and tool
identities. Proof outputs must come from actual proof-kernel invocations and have
no admitted declarations or unexplained axioms.

Malformed containers, noncanonical lengths, invalid ABI offsets, truncated
operands, unknown opcodes, invalid branch targets, missing source mappings,
unsupported typed operations, uncovered methods and stale certificates are
explicit errors or open proof obligations. None are silently skipped. A caller
requesting complete refinement receives a failing exit status while any required
obligation remains open; an inventory-only run cannot claim implementation GO.

Negative controls must change source or bytecode semantics while retaining
well-formed input: arithmetic operators and operands, comparison direction,
branch targets, witness guards, write ordering, return values and rollback.
Other controls cover deleted ABI entries, missing dependencies and mismatched
source/NEF pairs. Rejecting only invalid syntax or a changed hash is not evidence
that semantic certificates detect miscompilation.

## Resource and maintenance requirements

Inventory decoding should be linear in the size of the artifact. Proof search
has explicit timeouts and preserves diagnostics on failure. Missing tools fail
closed. Generated proofs run in isolated temporary directories and never update
their own trusted expected result. New instructions or C# operations create new
obligations rather than automatically increasing proven coverage.

The existing `formal/verify.py` model gate and historical receipts remain a
separate evidence layer. New refinement work lives under `formal/refinement/`;
its report must state precisely which semantic links have been established.
There is no deployment migration for this verification tooling. A future
contract or compiler change requires new certificates against its new bytes.

## Running the implementation gate

From the repository root, with the audited NCCS installation, .NET SDK and Rocq
available:

```sh
python3 formal/refinement/verify.py --output-dir /tmp/aa-refinement-evidence
```

The output directory must be new or empty. The runner rebuilds the exporter,
recompiles an isolated source copy with extended debug information, requires
byte-identical NEF output, exports the typed source and complete instruction/ABI
inventory, runs the proof kernel, and rechecks inputs after verification. The
compilation input set is checked before export, after export and after proof;
newly added source or build files fail the gate just as changed files do.
Proof templates are included in the verification-tool input hashes.
By default, the runner requests all four refinement proof lanes: arithmetic,
numeric coercions, reservation arithmetic and complete-helper reference
refinement. It retains `inventory.json`, `proof.json`, `numeric-proof.json`,
`reservation-proof.json`, `method-proof.json`, `method-inventory.json`, tool logs
and `result.json`. Each receipt has its own scope and exact input identities.
The [dated integrated report](reports/aa-method-refinement-20261013.md) retains
the fresh final receipt and its per-lane input identities. It records which
lanes passed together; historical counts from separate runs cannot substitute
for that evidence.

Exit `0` means the requested scope passed; exit `1` means an input/tool/proof
failure; exit `2` means the requested partial proofs passed but complete
implementation refinement is still open. `--allow-partial` accepts that declared
partial scope with exit `0`, while the report still records
`implementationVerified: false` and all unproved public entrypoints. It must not
be used as the complete-refinement release command.

To reproduce only the earlier arithmetic-region scope, use a separate empty
directory and opt in explicitly:

```sh
python3 formal/refinement/verify.py --arithmetic-only --allow-partial \
  --output-dir /tmp/aa-refinement-arithmetic-evidence
```

This compatibility command omits the three newer proof lanes. It cannot stand
in for the default gate. Missing tools, unsupported source operations or failed
proofs fail closed in either mode; `--allow-partial` does not bypass them.
