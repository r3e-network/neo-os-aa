(* Capped native session policy. Signature, scope, expiry, transfer shape and
   invocation context are abstract inputs, not crypto/VM/compiler proofs. *)
From Coq Require Import Bool PeanoNat Lia.

Definition session_admissible (context signature scope live shape : bool)
    (spent amount cap : nat) : bool :=
  context && signature && scope && live && shape && (spent + amount <=? cap).

Definition session_step (context signature scope live shape target_success : bool)
    (spent amount cap : nat) : bool * nat :=
  if session_admissible context signature scope live shape spent amount cap && target_success
  then (true, spent + amount) else (false, spent).

Definition session_clock (verification : bool) (persisting : nat)
    (ledger : option nat) : option nat :=
  if verification then ledger else Some persisting.

Record SessionPolicy := Policy {
  has_session : bool;
  consumed : nat;
  rotated_at : option nat
}.

Definition rotation_ready (last : option nat) (now cooldown : nat) : bool :=
  match last with None => true | Some timestamp => timestamp + cooldown <=? now end.

Definition rotate_policy (s : SessionPolicy) (now cooldown : nat) : option SessionPolicy :=
  if rotation_ready (rotated_at s) now cooldown
  then Some (Policy true (consumed s) (Some now)) else None.

Definition revoke_policy (s : SessionPolicy) : SessionPolicy :=
  Policy false 0 (rotated_at s).

Definition cleanup_policy (_ : SessionPolicy) : SessionPolicy :=
  Policy false 0 None.

Theorem rotation_preserves_spent : forall s now cooldown next,
  rotate_policy s now cooldown = Some next -> consumed next = consumed s.
Proof.
  intros. unfold rotate_policy in H.
  destruct (rotation_ready (rotated_at s) now cooldown); inversion H. reflexivity.
Qed.

Theorem rotation_sets_timestamp : forall s now cooldown next,
  rotate_policy s now cooldown = Some next -> rotated_at next = Some now.
Proof.
  intros. unfold rotate_policy in H.
  destruct (rotation_ready (rotated_at s) now cooldown); inversion H. reflexivity.
Qed.

Theorem rotation_before_cooldown_rejects : forall active spent timestamp now cooldown,
  now < timestamp + cooldown ->
  rotate_policy (Policy active spent (Some timestamp)) now cooldown = None.
Proof.
  intros. unfold rotate_policy, rotation_ready. simpl.
  assert (E : (timestamp + cooldown <=? now) = false) by (apply Nat.leb_gt; lia).
  rewrite E. reflexivity.
Qed.

Theorem first_grant_is_reachable : forall active spent now cooldown,
  rotate_policy (Policy active spent None) now cooldown = Some (Policy true spent (Some now)).
Proof. reflexivity. Qed.

Theorem revoke_clears_key_and_spent : forall s,
  has_session (revoke_policy s) = false /\ consumed (revoke_policy s) = 0.
Proof. intros. split; reflexivity. Qed.

Theorem revoke_retains_rotation : forall s,
  rotated_at (revoke_policy s) = rotated_at s.
Proof. reflexivity. Qed.

Theorem cleanup_removes_rotation : forall s,
  cleanup_policy s = Policy false 0 None.
Proof. reflexivity. Qed.

Theorem lowered_cap_rejects_zero : forall spent cap,
  cap < spent -> session_admissible true true true true true spent 0 cap = false.
Proof. intros. unfold session_admissible. simpl. rewrite Nat.add_0_r. apply Nat.leb_gt. lia. Qed.

Theorem zero_at_cap_is_reachable : forall cap,
  session_step true true true true true true cap 0 cap = (true, cap).
Proof.
  intros. unfold session_step, session_admissible. simpl.
  rewrite Nat.add_0_r, Nat.leb_refl. reflexivity.
Qed.

Theorem verification_clock_uses_ledger : forall persisting ledger,
  session_clock true persisting (Some ledger) = Some ledger.
Proof. reflexivity. Qed.

Theorem missing_ledger_rejects_verification : forall persisting,
  session_clock true persisting None = None.
Proof. reflexivity. Qed.

Theorem application_clock_uses_persisting_block : forall persisting ledger,
  session_clock false persisting ledger = Some persisting.
Proof. reflexivity. Qed.

Theorem session_requires_context : forall v s l h spent amount cap,
  session_admissible false v s l h spent amount cap = false.
Proof. reflexivity. Qed.

Theorem session_requires_signature : forall c s l h spent amount cap,
  session_admissible c false s l h spent amount cap = false.
Proof. intros []; reflexivity. Qed.

Theorem session_requires_scope : forall c v l h spent amount cap,
  session_admissible c v false l h spent amount cap = false.
Proof. intros [] []; reflexivity. Qed.

Theorem session_requires_liveness : forall c v s h spent amount cap,
  session_admissible c v s false h spent amount cap = false.
Proof. intros [] [] []; reflexivity. Qed.

Theorem session_requires_transfer_shape : forall c v s l spent amount cap,
  session_admissible c v s l false spent amount cap = false.
Proof. intros [] [] [] []; reflexivity. Qed.

Theorem session_within_cap : forall c v s l h spent amount cap,
  session_admissible c v s l h spent amount cap = true -> spent + amount <= cap.
Proof.
  intros. unfold session_admissible in H. apply andb_true_iff in H.
  destruct H as [_ H]. apply Nat.leb_le. exact H.
Qed.

Theorem false_target_preserves_spent : forall c v s l h spent amount cap,
  session_step c v s l h false spent amount cap = (false, spent).
Proof. intros. unfold session_step. rewrite andb_false_r. reflexivity. Qed.

Theorem session_fault_preserves_spent : forall c v s l h t spent amount cap next,
  session_step c v s l h t spent amount cap = (false, next) -> next = spent.
Proof.
  intros. unfold session_step in H.
  destruct (session_admissible c v s l h spent amount cap && t); inversion H. reflexivity.
Qed.

Theorem session_success_debits_exactly : forall c v s l h t spent amount cap next,
  session_step c v s l h t spent amount cap = (true, next) -> next = spent + amount.
Proof.
  intros. unfold session_step in H.
  destruct (session_admissible c v s l h spent amount cap && t); inversion H. reflexivity.
Qed.

Theorem session_success_stays_within_cap : forall c v s l h t spent amount cap next,
  session_step c v s l h t spent amount cap = (true, next) -> next <= cap.
Proof.
  intros. unfold session_step in H.
  destruct (session_admissible c v s l h spent amount cap && t) eqn:E; inversion H; subst.
  apply andb_true_iff in E. destruct E as [E _].
  eapply session_within_cap. exact E.
Qed.

Theorem valid_session_is_reachable :
  session_step true true true true true true 3 2 5 = (true, 5).
Proof. reflexivity. Qed.

Print Assumptions session_requires_context.
Print Assumptions session_requires_signature.
Print Assumptions session_requires_scope.
Print Assumptions session_requires_liveness.
Print Assumptions session_requires_transfer_shape.
Print Assumptions session_within_cap.
Print Assumptions false_target_preserves_spent.
Print Assumptions session_fault_preserves_spent.
Print Assumptions session_success_debits_exactly.
Print Assumptions session_success_stays_within_cap.
Print Assumptions valid_session_is_reachable.
Print Assumptions verification_clock_uses_ledger.
Print Assumptions missing_ledger_rejects_verification.
Print Assumptions application_clock_uses_persisting_block.
Print Assumptions rotation_preserves_spent.
Print Assumptions rotation_sets_timestamp.
Print Assumptions rotation_before_cooldown_rejects.
Print Assumptions first_grant_is_reachable.
Print Assumptions revoke_clears_key_and_spent.
Print Assumptions revoke_retains_rotation.
Print Assumptions cleanup_removes_rotation.
Print Assumptions lowered_cap_rejects_zero.
Print Assumptions zero_at_cap_is_reachable.
