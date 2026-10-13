# Ordinary implementation refinement

## Acceptance objective

The target is the ordinary `UnifiedSmartWalletV3` source and its exact compiled
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
`inventory.json`, `proof.json`, tool logs and `result.json` are retained there.

Exit `0` means the requested scope passed; exit `1` means an input/tool/proof
failure; exit `2` means a checked local region exists but complete implementation
refinement is still open. `--allow-partial` explicitly requests only the current
region and returns `0` on its success, while the report still records
`implementationVerified: false` and all unproved public entrypoints. It must not
be used as the complete-refinement release command.
