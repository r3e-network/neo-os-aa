; ===========================================================================
; NeoOS formal verification -- SA core arithmetic obligations
;
; Source correspondence (read at 2026-09-18):
;   ../neo-os-sa/contracts/custom/SmartAccount.Execution.cs
;   ../neo-os-sa/contracts/custom/SmartAccount.Paymaster.cs
;   ../neo-os-sa/contracts/custom/paymaster/Paymaster.cs
;
; OBL: the negation is unsat, so the arithmetic property holds.
; CTRL: an explicit accepted-domain witness or a deliberately unguarded bad
;       state is sat. Only controls sharing the accepted predicate establish
;       that its domain is nonempty; unrelated bad states do not establish this.
;
; The SA core now rejects negative and over-width nonce values before splitting
; the Neo BigInteger into channel/sequence. NeoVM Integer is a signed 256-bit
; value, so the non-negative executable domain is exactly 0 <= nonce < 2^255.
; The concrete Neo VM transport and C#-to-NEF refinement remain separate scope.
; ===========================================================================

(set-logic QF_LIA)
(set-option :produce-models true)

(define-fun SEQUENCE_LIMIT () Int 18446744073709551616) ; 2^64
(define-fun CHANNEL_LIMIT () Int 3138550867693340381917894711603833208051177722232017256448) ; 2^191
(define-fun NONCE_LIMIT () Int 57896044618658097711785492504343953926634992332820282019728792003956564819968) ; 2^255
(define-fun accepted ((nonce Int)) Bool (and (>= nonce 0) (< nonce NONCE_LIMIT)))

; ---------------------------------------------------------------------------
; OBL 1: the core's accepted nonce domain is exactly the non-negative half of
;        NeoVM's signed 256-bit Integer domain.
; ---------------------------------------------------------------------------
(echo "OBL:nonce-acceptance-is-signed-vm-bounded")
(push)
(declare-const nonce Int)
(assert (not (= (accepted nonce) (and (>= nonce 0) (< nonce NONCE_LIMIT)))))
(check-sat)
(pop)

; CTRL 1: the same predicate accepts both executable boundary values. This
;         fails for a reject-all domain or the loss of either endpoint.
; ---------------------------------------------------------------------------
(echo "CTRL:nonce-acceptance-includes-both-executable-boundaries")
(push)
(assert (accepted 0))
(assert (accepted (- NONCE_LIMIT 1)))
(check-sat)
(pop)

; OBL 2: a signed-VM-domain nonce splits into a uint191 channel and uint64 sequence,
;        and the split is lossless for every representable nonce.
; ---------------------------------------------------------------------------
(echo "OBL:nonce-encoding-is-bounded-and-lossless")
(push)
(declare-const nonce Int)
(define-fun channel () Int (div nonce SEQUENCE_LIMIT))
(define-fun sequence () Int (mod nonce SEQUENCE_LIMIT))
(assert (>= nonce 0))
(assert (< nonce NONCE_LIMIT))
(assert (not (and (>= channel 0)
                  (< channel CHANNEL_LIMIT)
                  (>= sequence 0)
                  (< sequence SEQUENCE_LIMIT)
                  (= nonce (+ (* channel SEQUENCE_LIMIT) sequence)))))
(check-sat)
(pop)

; ---------------------------------------------------------------------------
; CTRL 2: outside the signed-VM non-negative domain, the same arithmetic can express a non-representable
;        nonce. CTRL 1 separately establishes that the accepted domain is nonempty.
; ---------------------------------------------------------------------------
(echo "CTRL:nonce-outside-signed-vm-domain-is-expressible")
(push)
(declare-const nonce Int)
(define-fun channel () Int (div nonce SEQUENCE_LIMIT))
(define-fun sequence () Int (mod nonce SEQUENCE_LIMIT))
(assert (= nonce NONCE_LIMIT))
(assert (not (and (< channel CHANNEL_LIMIT) (< sequence SEQUENCE_LIMIT))))
(check-sat)
(get-value (nonce channel sequence))
(pop)

; ---------------------------------------------------------------------------
; OBL 3: a successful operation consumes exactly the current sequence plus
;        one. This is the arithmetic core of the per-channel cursor rule.
; ---------------------------------------------------------------------------
(echo "OBL:successful-operation-advances-current-sequence-once")
(push)
(declare-const current Int)
(declare-const requested Int)
(declare-const next Int)
(assert (>= current 0))
(assert (= requested current))
(assert (= next (+ current 1)))
(assert (not (= next (+ requested 1))))
(check-sat)
(pop)

; CTRL 3: without the exact-current guard, an out-of-order sequence can be
;        accepted by an unguarded arithmetic transition.
(echo "CTRL:out-of-order-sequence-is-expressible-without-guard")
(push)
(declare-const current Int)
(declare-const requested Int)
(declare-const next Int)
(assert (= current 4))
(assert (= requested 5))
(assert (= next (+ requested 1)))
(assert (not (= requested current)))
(check-sat)
(pop)

; ---------------------------------------------------------------------------
; OBL 4: reimbursement is capped by both the request and the actual measured
;        execution cost, matching CapReimbursementToActualCost for every
;        persisted transaction (actualCost > 0). A container with zero total fee
;        is an invokescript estimation, not a chain transaction, and is settled
;        at the request in the source; that branch is outside this obligation.
;        Persisted calls share one transaction-wide already-reserved total.
; ---------------------------------------------------------------------------
(echo "OBL:reimbursement-cannot-exceed-request-or-actual-cost")
(push)
(declare-const requested Int)
(declare-const actualCost Int)
(declare-const alreadyReserved Int)
(define-fun remaining () Int (- actualCost alreadyReserved))
(define-fun settled () Int (ite (< requested remaining) requested remaining))
(assert (> requested 0))
(assert (> actualCost 0))
(assert (>= alreadyReserved 0))
(assert (<= alreadyReserved actualCost))
(assert (not (and (<= settled requested) (<= settled actualCost))))
(check-sat)
(pop)

; CTRL 4: removing the cap admits an over-reimbursement state.
(echo "CTRL:uncapped-reimbursement-is-expressible")
(push)
(declare-const requested Int)
(declare-const actualCost Int)
(declare-const settled Int)
(assert (= requested 1))
(assert (= actualCost 2))
(assert (= settled actualCost))
(assert (> settled requested))
(check-sat)
(pop)

; ---------------------------------------------------------------------------
; OBL 5: a paymaster budget check preserves the budget upper bound and never
;        decreases already-accounted spend.
; ---------------------------------------------------------------------------
(echo "OBL:paymaster-budget-check-preserves-upper-bound")
(push)
(declare-const spent Int)
(declare-const amount Int)
(declare-const budget Int)
(declare-const nextSpent Int)
(assert (>= spent 0))
(assert (> amount 0))
(assert (> budget 0))
(assert (<= (+ spent amount) budget))
(assert (= nextSpent (+ spent amount)))
(assert (not (and (>= nextSpent spent) (<= nextSpent budget))))
(check-sat)
(pop)

; CTRL 5: without the budget guard, a positive reimbursement can exceed the
;        configured budget.
(echo "CTRL:paymaster-budget-overrun-is-expressible-without-guard")
(push)
(declare-const spent Int)
(declare-const amount Int)
(declare-const budget Int)
(assert (= spent budget))
(assert (= budget 10))
(assert (= amount 1))
(assert (> (+ spent amount) budget))
(check-sat)
(pop)

; OBL 6: at the final uint64 sequence the cursor advances to 2^64;
; every subsequent low-64-bit sequence is smaller, so the lane is exhausted.
(echo "OBL:exhausted-lane-cannot-wrap")
(push)
(declare-const nextCursor Int)
(declare-const nextSequence Int)
(assert (= nextCursor SEQUENCE_LIMIT))
(assert (>= nextSequence 0))
(assert (< nextSequence SEQUENCE_LIMIT))
(assert (= nextSequence nextCursor))
(check-sat)
(pop)
(echo "CTRL:modulo-cursor-would-allow-replay")
(push)
(declare-const nextCursor Int)
(assert (= nextCursor (mod (+ (- SEQUENCE_LIMIT 1) 1) SEQUENCE_LIMIT)))
(assert (= nextCursor 0))
(check-sat)
(pop)

; OBL 7: successive calls add their reservation before any external callback.
; Caller/account/paymaster identities do not partition the enclosing fee cap.
(echo "OBL:transaction-cumulative-reservations-stay-within-fee")
(push)
(declare-const actualCost Int)
(declare-const spent Int)
(declare-const requested Int)
(define-fun remaining () Int (- actualCost spent))
(define-fun charge () Int (ite (< requested remaining) requested remaining))
(assert (> actualCost 0))
(assert (and (>= spent 0) (<= spent actualCost) (> requested 0)))
(assert (not (and (>= (+ spent charge) spent) (<= (+ spent charge) actualCost))))
(check-sat)
(pop)
(echo "CTRL:per-call-fee-cap-does-not-bound-total")
(push)
(declare-const actualCost Int)
(declare-const first Int)
(declare-const second Int)
(assert (= actualCost 5))
(assert (= first 3))
(assert (= second 3))
(assert (and (<= first actualCost) (<= second actualCost) (> (+ first second) actualCost)))
(check-sat)
(pop)

(echo "DONE:sa_core")
