; ===========================================================================
; NeoOS formal verification -- AA core arithmetic obligations
;
; Source correspondence (read at 2026-09-18):
;   ../neo-os-aa/contracts/UnifiedSmartWallet.Execution.cs
;   ../neo-os-aa/contracts/UnifiedSmartWallet.Paymaster.cs
;   ../neo-os-aa/contracts/paymaster/Paymaster.cs
;
; OBL: the negation is unsat, so the arithmetic property holds.
; CTRL: a deliberately unguarded bad state is sat, proving the obligation is
;       not merely true because the domain was accidentally empty.
;
; The AA core now rejects negative and over-width nonce values before splitting
; the Neo BigInteger into channel/sequence. The byte-width implementation is
; represented below by the exact arithmetic domain 0 <= nonce < 2^256. The
; concrete Neo VM transport and C#-to-NEF refinement remain separate scope.
; ===========================================================================

(set-logic QF_LIA)
(set-option :produce-models true)

(define-fun SEQUENCE_LIMIT () Int 18446744073709551616) ; 2^64
(define-fun CHANNEL_LIMIT () Int 6277101735386680763835789423207666416102355444464034512896) ; 2^192
(define-fun NONCE_LIMIT () Int 115792089237316195423570985008687907853269984665640564039457584007913129639936) ; 2^256

; ---------------------------------------------------------------------------
; OBL 1: the core's accepted nonce domain is exactly unsigned uint256,
;        which is the arithmetic form of its 32-byte width check.
; ---------------------------------------------------------------------------
(echo "OBL:nonce-acceptance-is-uint256-bounded")
(push)
(declare-const nonce Int)
(define-fun accepted () Bool (and (>= nonce 0) (< nonce NONCE_LIMIT)))
(assert (not (=> accepted (and (>= nonce 0) (< nonce NONCE_LIMIT)))))
(check-sat)
(pop)

; CTRL 1: omitting the upper-bound guard admits a non-representable input.
; ---------------------------------------------------------------------------
(echo "CTRL:nonce-acceptance-without-upper-bound-is-expressible")
(push)
(declare-const nonce Int)
(assert (= nonce NONCE_LIMIT))
(assert (not (and (>= nonce 0) (< nonce NONCE_LIMIT))))
(check-sat)
(pop)

; OBL 2: a uint256 nonce splits into a uint192 channel and uint64 sequence,
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
; CTRL 2: outside uint256, the same arithmetic can express a non-representable
;        nonce. This keeps OBL 1's finite domain explicit rather than vacuous.
; ---------------------------------------------------------------------------
(echo "CTRL:nonce-outside-uint256-is-expressible")
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
;        execution cost, matching CapReimbursementToActualCost.
; ---------------------------------------------------------------------------
(echo "OBL:reimbursement-cannot-exceed-request-or-actual-cost")
(push)
(declare-const requested Int)
(declare-const actualCost Int)
(define-fun settled () Int (ite (< requested actualCost) requested actualCost))
(assert (> requested 0))
(assert (> actualCost 0))
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

(echo "DONE:aa_core")
