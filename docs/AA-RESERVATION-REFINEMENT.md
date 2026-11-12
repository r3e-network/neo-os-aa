# Reservation arithmetic refinement

## Current arithmetic result

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

## Intended statement

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

## Conditional whole-helper plan

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

## Verification and controls

Dedicated Coq and Python proof files will leave the old charge gate untouched.
Tests begin with a captured failing run. Coq compilation, closed-assumption
audits and `coqchk` must be real and fail when tools are absent. Definition-valid
semantic controls will alter the positivity guard, reservation addition,
overflow rejection, transaction-ledger scope and iteration. Proof inputs,
dependencies and generated certificates are hashed from the exact bytes
compiled and checked again after verification.
