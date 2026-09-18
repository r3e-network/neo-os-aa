---------------------------- MODULE UnifiedSmartWalletAA ----------------------------
(*******************************************************************************)
(* Bounded AA execution-state model.                                          *)
(*                                                                             *)
(* Corresponding implementation:                                              *)
(*   ../neo-os-aa/contracts/UnifiedSmartWallet.Execution.cs                   *)
(*   ../neo-os-aa/contracts/UnifiedSmartWallet.Models.cs                      *)
(*   ../neo-os-aa/contracts/UnifiedSmartWallet.Escape.cs                      *)
(*                                                                             *)
(* The model separates Begin from the terminal transaction outcome.  A valid   *)
(* success requires the same operation-shape, authorization, deadline, hook,   *)
(* target and exact                                                            *)
(* per-channel nonce predicates as the contract boundary.  A failure is a     *)
(* rollback: durable cursor and effect state remain equal to the snapshot      *)
(* taken at Begin.  Cryptographic witness evaluation, script parsing, Neo VM   *)
(* semantics and C#-to-NEF refinement are outside this finite model.           *)
(* pendingTarget means normal return, including a returned Boolean FALSE;   *)
(* pendingPost covers both hook and verifier postExecute normal completion. *)
(* effects counts completed operations, NOT asset movements/business success.*)
(* Rollback is assumed only for a FAULT of the enclosing transaction, never  *)
(* an exception caught by its caller. No liveness/refinement is claimed.    *)
(* MaxSeq is a finite TLC exploration bound; the unbounded Coq model carries  *)
(* the cursor as nat. The core's BigInteger-to-uint256 input boundary is an    *)
(* explicit separate obligation in verified/smt/aa_core.smt2.                 *)
(*******************************************************************************)
EXTENDS Integers

CONSTANTS
    Channels,
    MaxSeq,
    MaxTime

ASSUME ChannelsNonEmpty == Channels # {}
ASSUME MaxSeqFinite == MaxSeq \in Nat
ASSUME MaxTimeFinite == MaxTime \in Nat

VARIABLES
    now,
    cursor,
    effects,
    pending,
    executing,
    pendingChannel,
    pendingSeq,
    pendingShape,
    pendingAuthorized,
    pendingDeadline,
    pendingPre,
    pendingTarget,
    pendingPost,
    beforeCursor,
    beforeEffects,
    lastOutcome,
    lastChannel,
    lastRequestedSeq,
    lastShape,
    lastAuthorized,
    lastDeadline,
    lastPre,
    lastTarget,
    lastPost

vars == << now, cursor, effects, pending, executing, pendingChannel,
           pendingSeq, pendingShape, pendingAuthorized, pendingDeadline, pendingPre,
           pendingTarget, pendingPost, beforeCursor, beforeEffects,
           lastOutcome, lastChannel, lastRequestedSeq, lastShape, lastAuthorized,
           lastDeadline, lastPre, lastTarget, lastPost >>

Time == 0..MaxTime
SeqRange == 0..MaxSeq
CursorRange == 0..(MaxSeq + 1)

TypeOK ==
    /\ now \in Time
    /\ cursor \in [Channels -> CursorRange]
    /\ effects \in Nat
    /\ pending \in BOOLEAN
    /\ executing \in BOOLEAN
    /\ pendingChannel \in Channels
    /\ pendingSeq \in SeqRange
    /\ pendingShape \in BOOLEAN
    /\ pendingAuthorized \in BOOLEAN
    /\ pendingDeadline \in BOOLEAN
    /\ pendingPre \in BOOLEAN
    /\ pendingTarget \in BOOLEAN
    /\ pendingPost \in BOOLEAN
    /\ beforeCursor \in [Channels -> CursorRange]
    /\ beforeEffects \in Nat
    /\ lastOutcome \in {"none", "success", "failure"}
    /\ lastChannel \in Channels
    /\ lastRequestedSeq \in SeqRange
    /\ lastShape \in BOOLEAN
    /\ lastAuthorized \in BOOLEAN
    /\ lastDeadline \in BOOLEAN
    /\ lastPre \in BOOLEAN
    /\ lastTarget \in BOOLEAN
    /\ lastPost \in BOOLEAN

Init ==
    /\ now = 0
    /\ cursor = [c \in Channels |-> 0]
    /\ effects = 0
    /\ pending = FALSE
    /\ executing = FALSE
    /\ pendingChannel \in Channels
    /\ pendingSeq = 0
    /\ pendingShape = FALSE
    /\ pendingAuthorized = FALSE
    /\ pendingDeadline = FALSE
    /\ pendingPre = FALSE
    /\ pendingTarget = FALSE
    /\ pendingPost = FALSE
    /\ beforeCursor = [c \in Channels |-> 0]
    /\ beforeEffects = 0
    /\ lastOutcome = "none"
    /\ lastChannel \in Channels
    /\ lastRequestedSeq = 0
    /\ lastShape = FALSE
    /\ lastAuthorized = FALSE
    /\ lastDeadline = FALSE
    /\ lastPre = FALSE
    /\ lastTarget = FALSE
    /\ lastPost = FALSE

Tick ==
    /\ ~pending
    /\ now < MaxTime
    /\ now' = now + 1
    /\ UNCHANGED << cursor, effects, pending, executing, pendingChannel,
                    pendingSeq, pendingShape, pendingAuthorized, pendingDeadline, pendingPre,
                    pendingTarget, pendingPost, beforeCursor, beforeEffects,
                    lastOutcome, lastChannel, lastRequestedSeq, lastShape,
                    lastAuthorized, lastDeadline, lastPre, lastTarget,
                    lastPost >>

Begin ==
    \E c \in Channels, q \in SeqRange,
       shape \in BOOLEAN, a \in BOOLEAN, d \in BOOLEAN, hpre \in BOOLEAN,
       target \in BOOLEAN, hpost \in BOOLEAN :
        /\ ~pending
        /\ ~executing
        /\ pending' = TRUE
        /\ executing' = TRUE
        /\ pendingChannel' = c
        /\ pendingSeq' = q
        /\ pendingShape' = shape
        /\ pendingAuthorized' = a
        /\ pendingDeadline' = d
        /\ pendingPre' = hpre
        /\ pendingTarget' = target
        /\ pendingPost' = hpost
        /\ beforeCursor' = cursor
        /\ beforeEffects' = effects
        /\ lastOutcome' = "none"
        /\ lastChannel' = c
        /\ lastRequestedSeq' = q
        /\ lastShape' = shape
        /\ lastAuthorized' = a
        /\ lastDeadline' = d
        /\ lastPre' = hpre
        /\ lastTarget' = target
        /\ lastPost' = hpost
        /\ UNCHANGED << now, cursor, effects >>

SuccessShapeGuard == pendingShape
SuccessAuthorizationGuard == pendingAuthorized

CompleteSuccess ==
    /\ pending
    /\ executing
    /\ SuccessShapeGuard
    /\ SuccessAuthorizationGuard
    /\ pendingDeadline
    /\ pendingPre
    /\ pendingTarget
    /\ pendingPost
    /\ pendingSeq = cursor[pendingChannel]
    /\ cursor' = [cursor EXCEPT ![pendingChannel] = @ + 1]
    /\ effects' = effects + 1
    /\ pending' = FALSE
    /\ executing' = FALSE
    /\ lastOutcome' = "success"
    /\ lastChannel' = pendingChannel
    /\ lastRequestedSeq' = pendingSeq
    /\ lastShape' = pendingShape
    /\ lastAuthorized' = pendingAuthorized
    /\ lastDeadline' = pendingDeadline
    /\ lastPre' = pendingPre
    /\ lastTarget' = pendingTarget
    /\ lastPost' = pendingPost
    /\ UNCHANGED << now, pendingChannel, pendingSeq, pendingShape, pendingAuthorized,
                    pendingDeadline, pendingPre, pendingTarget, pendingPost,
                    beforeCursor, beforeEffects >>

CompleteFailure ==
    /\ pending
    /\ executing
    /\ ~(pendingShape /\ pendingAuthorized /\ pendingDeadline /\ pendingPre /\ pendingTarget
         /\ pendingPost /\ pendingSeq = cursor[pendingChannel])
    /\ cursor' = cursor
    /\ effects' = effects
    /\ pending' = FALSE
    /\ executing' = FALSE
    /\ lastOutcome' = "failure"
    /\ lastChannel' = pendingChannel
    /\ lastRequestedSeq' = pendingSeq
    /\ lastShape' = pendingShape
    /\ lastAuthorized' = pendingAuthorized
    /\ lastDeadline' = pendingDeadline
    /\ lastPre' = pendingPre
    /\ lastTarget' = pendingTarget
    /\ lastPost' = pendingPost
    /\ UNCHANGED << now, pendingChannel, pendingSeq, pendingShape, pendingAuthorized,
                    pendingDeadline, pendingPre, pendingTarget, pendingPost,
                    beforeCursor, beforeEffects >>

Next == Tick \/ Begin \/ CompleteSuccess \/ CompleteFailure

Spec == Init /\ [][Next]_vars

(*******************************************************************************)
(* Safety properties.                                                         *)
(*******************************************************************************)

ExecutionLockWellFormed == executing = pending

SuccessWasAuthorized ==
    lastOutcome = "success" =>
        lastAuthorized /\ lastDeadline /\ lastPre /\ lastTarget /\ lastPost

SuccessWasWellShaped ==
    lastOutcome = "success" => lastShape

SuccessUsedCurrentNonce ==
    lastOutcome = "success" => lastRequestedSeq = beforeCursor[lastChannel]

FailureAtomic ==
    lastOutcome = "failure" =>
        /\ cursor = beforeCursor
        /\ effects = beforeEffects

EffectsOnlyOnSuccess ==
    /\ lastOutcome = "success" => effects = beforeEffects + 1
    /\ lastOutcome = "failure" => effects = beforeEffects

NoInFlightCommit ==
    pending => /\ cursor = beforeCursor
               /\ effects = beforeEffects

SuccessNonceTransition ==
    lastOutcome = "success" =>
        /\ cursor[lastChannel] = beforeCursor[lastChannel] + 1
        /\ \A c \in Channels \ {lastChannel} : cursor[c] = beforeCursor[c]

=============================================================================
