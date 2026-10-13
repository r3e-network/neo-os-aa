(* Zero-cap policy and key-reuse boundary. Identity comparison, signature
   validity, target HALT, nonce and expiry are abstract correspondence inputs.
   The key-reuse counterexample holds the domain-validity predicate fixed. It
   describes a leaf-policy boundary and the historical ABI 1 risk, not ABI 2
   end-to-end replay acceptance. NativeAuthorityEpoch.v separately models why
   ABI 2 counter transitions invalidate signatures, even when a key is reused.
   Composition with concrete domain bytes, cryptography and VM state is external. *)
From Coq Require Import Bool PeanoNat Lia.

Definition method_scope (target_match wildcard method_match : bool) : bool :=
  target_match && (wildcard || method_match).
Definition configuration_allowed (transfer_method : bool) (cap : nat) : bool :=
  (cap =? 0) || transfer_method.
Definition scope_admissible (ctx sig live target_match wildcard method_match shape : bool)
    (spent amount cap : nat) : bool :=
  ctx && sig && live && method_scope target_match wildcard method_match &&
  (if cap =? 0 then true else shape && (spent + amount <=? cap)).
Definition scope_step (authorized halted true_result : bool) (spent amount cap : nat) : bool * nat :=
  if authorized && halted && ((cap =? 0) || true_result)
  then (true, if cap =? 0 then spent else spent + amount)
  else (false, spent).
Definition key_authorized (current : option nat) (signing_key : nat)
    (valid_signature nonce_current unexpired : bool) : bool :=
  match current with
  | None => false
  | Some key => (key =? signing_key) && valid_signature && nonce_current && unexpired
  end.

Theorem wildcard_retains_target : forall wildcard method_match,
  method_scope false wildcard method_match = false.
Proof. reflexivity. Qed.
Theorem wildcard_permits_other_methods : forall method_match,
  method_scope true true method_match = true.
Proof. reflexivity. Qed.
Theorem exact_method_rejects_mismatch : method_scope true false false = false.
Proof. reflexivity. Qed.
Theorem zero_cap_configuration_admitted : forall method,
  configuration_allowed method 0 = true.
Proof. reflexivity. Qed.
Theorem positive_cap_requires_transfer : forall cap,
  0 < cap -> configuration_allowed false cap = false.
Proof. intros. unfold configuration_allowed. rewrite orb_false_r. apply Nat.eqb_neq. lia. Qed.
Theorem uncapped_shape_independent : forall ctx sig live target wildcard method shape spent amount,
  scope_admissible ctx sig live target wildcard method shape spent amount 0 =
  ctx && sig && live && method_scope target wildcard method.
Proof. intros. unfold scope_admissible. simpl. apply andb_true_r. Qed.
Theorem scope_requires_context : forall sig live target wildcard method shape spent amount cap,
  scope_admissible false sig live target wildcard method shape spent amount cap = false.
Proof. reflexivity. Qed.
Theorem scope_requires_signature : forall ctx live target wildcard method shape spent amount cap,
  scope_admissible ctx false live target wildcard method shape spent amount cap = false.
Proof. intros []; reflexivity. Qed.
Theorem scope_requires_liveness : forall ctx sig target wildcard method shape spent amount cap,
  scope_admissible ctx sig false target wildcard method shape spent amount cap = false.
Proof. intros [] []; reflexivity. Qed.
Theorem scope_requires_target : forall ctx sig live wildcard method shape spent amount cap,
  scope_admissible ctx sig live false wildcard method shape spent amount cap = false.
Proof. intros [] [] []; reflexivity. Qed.
Theorem capped_requires_shape : forall ctx sig live target wildcard method spent amount cap,
  0 < cap -> scope_admissible ctx sig live target wildcard method false spent amount cap = false.
Proof.
  intros. unfold scope_admissible.
  assert (E : (cap =? 0) = false) by (apply Nat.eqb_neq; lia).
  rewrite E. simpl. apply andb_false_r.
Qed.
Theorem capped_admission_within_limit : forall ctx sig live target wildcard method shape spent amount cap,
  0 < cap -> scope_admissible ctx sig live target wildcard method shape spent amount cap = true -> spent + amount <= cap.
Proof.
  intros. unfold scope_admissible in H0.
  assert (E : (cap =? 0) = false) by (apply Nat.eqb_neq; lia).
  rewrite E in H0. apply andb_true_iff in H0. destruct H0 as [_ H0].
  apply andb_true_iff in H0. destruct H0 as [_ H0]. apply Nat.leb_le. exact H0.
Qed.
Theorem uncapped_false_completes : forall spent amount,
  scope_step true true false spent amount 0 = (true, spent).
Proof. reflexivity. Qed.
Theorem uncapped_spending_unchanged : forall authorized halted result spent amount,
  snd (scope_step authorized halted result spent amount 0) = spent.
Proof. intros [] [] []; reflexivity. Qed.
Theorem target_fault_rolls_back : forall authorized result spent amount cap,
  scope_step authorized false result spent amount cap = (false, spent).
Proof. intros []. all: reflexivity. Qed.
Theorem capped_false_rolls_back : forall authorized halted spent amount cap,
  0 < cap -> scope_step authorized halted false spent amount cap = (false, spent).
Proof.
  intros. unfold scope_step.
  assert (E : (cap =? 0) = false) by (apply Nat.eqb_neq; lia).
  rewrite E. simpl. rewrite andb_false_r. reflexivity.
Qed.
Theorem capped_success_exact_debit : forall spent amount cap,
  0 < cap -> scope_step true true true spent amount cap = (true, spent + amount).
Proof.
  intros. unfold scope_step.
  assert (E : (cap =? 0) = false) by (apply Nat.eqb_neq; lia).
  rewrite E. reflexivity.
Qed.
Theorem revoked_key_rejects : forall key sig nonce live,
  key_authorized None key sig nonce live = false.
Proof. reflexivity. Qed.
Theorem replaced_key_rejects : forall current key sig nonce live,
  current <> key -> key_authorized (Some current) key sig nonce live = false.
Proof.
  intros. unfold key_authorized.
  assert (E : (current =? key) = false) by (apply Nat.eqb_neq; assumption).
  rewrite E. reflexivity.
Qed.
(* Counterexample to permanent invalidation, not a desired revocation guarantee.
   Regrant explicitly restores the same key; the signature and nonce did not change. *)
Theorem restored_key_can_revive_signature : forall key,
  key_authorized None key true true true = false /\
  key_authorized (Some key) key true true true = true.
Proof. intros. split; simpl; [reflexivity|rewrite Nat.eqb_refl; reflexivity]. Qed.
Theorem consumed_nonce_still_rejects : forall current key sig live,
  key_authorized current key sig false live = false.
Proof. intros [current|] key sig live; simpl; [rewrite !andb_false_r; reflexivity|reflexivity]. Qed.
Theorem expired_signature_still_rejects : forall current key sig nonce,
  key_authorized current key sig nonce false = false.
Proof. intros [current|] key sig nonce; simpl; [apply andb_false_r|reflexivity]. Qed.

Print Assumptions wildcard_retains_target.
Print Assumptions wildcard_permits_other_methods.
Print Assumptions exact_method_rejects_mismatch.
Print Assumptions zero_cap_configuration_admitted.
Print Assumptions positive_cap_requires_transfer.
Print Assumptions uncapped_shape_independent.
Print Assumptions scope_requires_context.
Print Assumptions scope_requires_signature.
Print Assumptions scope_requires_liveness.
Print Assumptions scope_requires_target.
Print Assumptions capped_requires_shape.
Print Assumptions capped_admission_within_limit.
Print Assumptions uncapped_false_completes.
Print Assumptions uncapped_spending_unchanged.
Print Assumptions target_fault_rolls_back.
Print Assumptions capped_false_rolls_back.
Print Assumptions capped_success_exact_debit.
Print Assumptions revoked_key_rejects.
Print Assumptions replaced_key_rejects.
Print Assumptions restored_key_can_revive_signature.
Print Assumptions consumed_nonce_still_rejects.
Print Assumptions expired_signature_still_rejects.
