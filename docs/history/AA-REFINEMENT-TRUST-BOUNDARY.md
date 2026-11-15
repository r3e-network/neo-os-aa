# Trust boundaries for complete implementation refinement

The acceptance target is the complete ordinary source artifact executed by the
pinned Neo runtime. A certificate for the private reimbursement helper is a
useful intermediate result. It does not establish that its entry conditions are
reachable, that the runtime implements its reference machine, or that public
methods compose its result correctly. The full gate must keep these distinctions.

## What each layer must establish

| Layer | Evidence required before discharging its obligation |
| --- | --- |
| Source acquisition and binding | The complete compilation membership, references, conditional symbols and typed bodies must be bound to unchanged source bytes. A debug mapping locates code; it does not prove translation. |
| Source projection | Every admitted operation and conversion needs declared semantics and a sound lowering to the source interpreter. Unknown metadata, sibling statements, initializers and calls must fail closed or remain obligations. A matching template authenticates a supported shape; matching alone is not the semantic-preservation theorem. |
| Artifact validation | The certificate must consume the independently decoded actual instruction bytes and tokens, not instruction names or expected output supplied by the compiler inventory. Every reachable dependency needs coverage. |
| Context composition | Call frames, lower caller stack, heap extensions, aliases, statics, exceptions and continuation PCs must be related. A theorem from one isolated initial state does not imply arbitrary caller-frame preservation. |
| Runtime correspondence | The runtime-source projection and its interpretation must be related to the reference transition rules. Pinned files or matching method bodies authenticate an input; they do not prove that the runtime executes those rules. Source extraction and the .NET execution boundary remain `SOURCE_BRIDGE_TCB` unless discharged independently. |
| Application effects | Actual storage bytes, native codec failures, permissions, witness checks, gas, notifications, nested calls and rollback scopes must be accounted for. Their effects cannot be replaced by an unconditional-success environment. |
| Public acceptance | Every ABI descriptor and its transitive dependencies must compose these results. Proved pure leaves, runtime probes and supporting models must not promote unproved entrypoints. |

The source interpretation is the explicit Neo contract dialect documented in
[the source-projection contract](../AA-METHOD-SOURCE-REFINEMENT.md). It is not general
CLR semantics. In particular, byte-value equality and record intrinsics require
a correspondence argument; exporting a resolved symbol does not provide it.
Source `BigInteger` addition remains unbounded. The target's integer bounds must
be proved for reachable inputs or represented as differing fault behavior.

A manifest parameter descriptor does not establish the runtime StackItem tag.
For each public method, the theorem must either classify all runtime-admitted
arguments or state a typed input relation and prove that its callers establish
that relation. A reference theorem over Integer values cannot silently inherit
the separately proved Boolean/ByteString coercion model. Similarly, a bounded
comparison evaluator needs an explicit bridge to the source evaluator on its
admitted domain, with oversized comparison faults classified separately.

## Concrete frame rules that a composition must preserve

At NeoVM commit `004cd6070a940405818d9357638277dd44407e2e`, same-script CALL
creates a context clone. It shares the evaluation stack and statics but creates
fresh method slots. RET validates return count only when transferring to a
different evaluation stack; returning to the shared caller stack must preserve
its lower values. A singleton-stack Return rule is therefore an isolated-helper
rule, not the general CALL/RET rule. See the pinned
[control implementation](https://raw.githubusercontent.com/neo-project/neo-vm/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/JumpTable/JumpTable.Control.cs)
and [context implementation](https://raw.githubusercontent.com/neo-project/neo-vm/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/ExecutionContext.cs).

INITSLOT consumes arguments from the shared stack without removing lower caller
values. INITSSLOT rejects a second initialization and a zero-sized static slot.
Initialization must model the distinction between an absent slot and an existing
slot, rather than infer it solely from an empty list. See the pinned
[slot implementation](https://raw.githubusercontent.com/neo-project/neo-vm/004cd6070a940405818d9357638277dd44407e2e/src/Neo.VM/JumpTable/JumpTable.Slot.cs).

`Runtime.GetScriptContainer` delegates to `Transaction.ToStackItem`, which constructs a
fresh Array and requires a transaction signer. Repeated reads can have equal
field values without equal object identity. A heap relation must admit these
fresh allocations while preserving caller objects; any erased allocation,
reference-count or resource effect needs an explicit boundary. See the pinned
[runtime getter](https://github.com/neo-project/neo/blob/d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d/src/Neo/SmartContract/ApplicationEngine.Runtime.cs#L207)
and [transaction projection](https://github.com/neo-project/neo/blob/d10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d/src/Neo/Network/P2P/Payloads/Transaction.cs#L427).

The caller relation must ensure that initially reachable references denote
existing objects. An arbitrary natural-number reference equal to the next fresh
heap index would otherwise become an alias after allocation. Preserving an old
heap prefix proves unchanged fields; a well-formed reference relation is also
needed for separation and contextual reachability claims.

## Required adversarial checks

Kernel closure excludes admitted axioms. It does not exclude restrictive
preconditions that assume the property being proved. An admitted domain must
have concrete reachable witnesses, and caller guards must establish it. Proving
that both sides return the same timeout or fault is insufficient for a successful
execution refinement claim.

The composition checks should reject a callee that drops the lower caller stack,
loses a heap write through an alias, resets an already initialized static slot,
or receives an arbitrary transaction object in place of the runtime projection.
Source controls should remove an assertion, change a storage key or alter a
literal while producing a well-formed source program. Rejection must arise from
semantic disagreement, rather than missing syntax, tools or stale hashes.

Gas checks need nonnegative cost and limit inputs, charging order, exact-limit
behavior, exhaustion after a write, and callback consumption. Rollback checks
need failed nested calls, caught exceptions and enclosing failure; a host test
that commits only on HALT supplies a persistence policy, not a proof that the
actual runtime implements that policy. Public callback proofs must quantify over
adversarial return values, mutation, reentry and resource consumption subject to
the runtime's real restrictions.

## Acceptance discipline

The [fresh gate](AA-REFINEMENT-GATE.md) must report the strongest statement actually
proved. A reference-body certificate may close its declared local obligation
while runtime, caller, codec and public dependencies remain open. Receipt hashes
bind evidence; differential tests supply finite execution evidence. Neither
changes the quantifiers or hypotheses of a theorem.

`implementationVerified` must remain false while any required public dependency
or runtime correspondence is missing. A development option that returns success
for partial proofs must retain that false flag, the unproved dispatch signatures
and the remaining obligations. New proof lanes must be reviewed and composed
before their receipt is permitted to remove an obligation.

Every runner must hash and compile or interpret the same captured source/model
bytes, then recheck the live inputs. Hashing once, reading a model again, and
checking the first hash at the end admits an A-to-B-to-A race: the receipt can
identify A while the kernel checked B. Fresh subprocess exit checks also remain
mandatory. A failed standalone invocation must overwrite a prior success
receipt, even when the outer gate already rejects its nonzero exit status.
