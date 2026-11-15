# Reimbursement helper and transaction ledger composition

This proof composes the artifact-specific `CapMethodArtifact.vm_method_classified`
theorem for the complete 281-byte helper with a finite caller execution relation.
Every reservation transition runs that actual bytecode in the reference VM; it
does not substitute a second arithmetic oracle. The runner recompiles the exact
helper certificate and its semantic dependencies before checking the composition.

An invocation reserves a strictly positive amount before entering its callback.
Successful nested invocations receive the already updated ledger, and their
results become the input to the following invocation. Accounts, sponsors and
paymasters do not partition this ledger. The execution relation represents finite
serial calls and arbitrary finite nesting using one transaction hash and fee sum.
Missing storage is a legal initial input. A different stored transaction hash
resets the effective reserved amount to zero through the actual helper theorem.

The intended paid invariant is conservation: initial effective reserved plus the
sum of every accepted reservation equals the final effective reserved, which is
at most the positive transaction fee, assuming the initial effective reserved
amount is already at most that fee. Missing storage and a different transaction
hash start at zero; successful calls preserve this bound. An existing
over-reserved ledger makes the helper reject a further paid invocation rather
than establishing a bound on the already stored amount. Exhaustion rejects the invocation. For
zero-fee estimation, each caller must establish that the updated sum is below
`2^255`; estimation has no transaction-fee bound. The caller conditions include
positive, Integer-typed requests, nonnegative signed-64-bit fee fields, a valid
32-byte transaction hash, and a well-formed Array/Struct ledger. Establishing
these conditions for every real public entrypoint remains a separate obligation.

The outer transaction has an initial snapshot and a working ledger. A successful
outer transaction may commit its working ledger. An uncaught application fault
discards all of its reservations and restores the initial snapshot. Callback
entry does not itself create a rollback rule. The model covers successful nested
returns whose writes become visible to their parent, and faults that abort the
outer transaction. Caught faults and actual child-context cache/checkpoint
semantics are outside this model; they must not be described as independent
callback rollback or as an already proved ApplicationEngine property.

The proof continues to rely on the helper reference theorem's explicit static
slot, getter and native codec contracts. It does not prove the actual binary
codec, Neo ApplicationEngine, gas/resource behavior, production cache commit or
discard implementation, arbitrary callback writes, compiler correctness, or all
public methods. The snapshot theorem is about the declared outer commit/discard
operation, not a replacement for those missing runtime correspondence proofs.

Negative controls will change valid definitions to lose cumulative reservations,
feed a reentrant callback the old ledger, or commit after an outer fault. Each
control must compile as a definition and then fail a kernel-checked semantic
claim. Source and certificate hashes are recorded before compilation and checked
again after verification.

## Validation

The composition contains 21 proved lemmas/theorems and eight checked model
definitions, with explicit `Print Assumptions` coverage. Its proof audit also
checks the 110 declarations of the imported artifact-specific helper and models,
139 declarations closed under the global context in total. The five-test suite
passed after real `coqc` and `coqchk` execution; all three semantic controls
compiled valid definitions and received proof rejection.

The helper's headroom guard is a second `if` over symbolic operands, so the
composition discharges it from `legal_inputs` instead of letting `inversion`
explore the unreduced classified term. That is an explicit hypothesis, not a
computed branch: the caller still has to establish the zero-fee sum bound.

The default command records positive and negative results together:

```sh
python3 formal/refinement/composition_proofs.py \
  --helper-proof-report <fresh-helper-proof.json> \
  --output-dir <composition-proofs> \
  --json-report <composition-proof.json> --controls
```

The runner checks the exact helper certificate, literal method bytes, current
Coq semantic models and generating tool identities. The supplied helper receipt
inherits its current production source/NEF binding from the aggregate gate; this
runner does not independently rerun Roslyn or establish public caller reachability.
It reads each checked source into one raw snapshot, hashes and compiles that same
content, then checks the source files again at the end. A deterministic read-race
regression ensures a second read cannot silently change the compiled certificate.
