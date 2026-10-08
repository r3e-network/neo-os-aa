(*
  Native SmartAccount lifecycle authority and epoch invalidation.
  Witness results are assumptions supplied by an abstract caller, not proofs
  of Neo witness evaluation. This model does not claim C# refinement, callback
  cleanup, ledger rollback, or complete native-service semantics.
*)
From Coq Require Import ZArith Bool Lia.
Open Scope Z_scope.

Record State := mkState {
  active : bool;
  has_recovery : bool;
  epoch : Z;
  pending_verifier : bool;
  pending_hook : bool;
  pending_address : bool;
  pending_recovery : bool
}.
Definition epoch_limit : Z := 2 ^ 64.
Definition configuration_allowed (s : State) : bool :=
  active s && negb (pending_recovery s).
Definition unfreeze_allowed (s : State) (custody recovery : bool) : bool :=
  negb (active s) && custody && (negb (has_recovery s) || recovery).
Definition cancel_recovery_allowed (s : State) (now maturity : Z)
    (custody recovery : bool) : bool :=
  pending_recovery s &&
    ((has_recovery s && recovery) || (custody && (now <? maturity))).
Definition advance (s : State) : option State :=
  if (0 <=? epoch s) && (epoch s <? epoch_limit - 1) then
    Some (mkState (active s) (has_recovery s) (epoch s + 1)
                  false false false false)
  else None.

(* Post-callback binding observations are abstract code/admission identities.
   Store is the entire staged snapshot, including epoch, roster, module writes
   and notifications; this models transaction selection, not NeoVM rollback. *)
Definition configuration_bindings_match (root_pin child_pin : Z)
    (root_now child_now : option Z) : bool :=
  match root_now, child_now with
  | Some r, Some c => Z.eqb r root_pin && Z.eqb c child_pin
  | _, _ => false
  end.

Definition finalize_configuration {Store : Type} (before staged : Store)
    (root_pin child_pin : Z) (root_now child_now : option Z) : bool * Store :=
  if configuration_bindings_match root_pin child_pin root_now child_now
  then (true, staged) else (false, before).

Theorem pending_recovery_blocks_configuration : forall s,
  pending_recovery s = true -> configuration_allowed s = false.
Proof. intros s H. unfold configuration_allowed. rewrite H. apply andb_false_r. Qed.

Theorem frozen_blocks_configuration : forall s,
  active s = false -> configuration_allowed s = false.
Proof. intros s H. unfold configuration_allowed. rewrite H. reflexivity. Qed.

Theorem configuration_requires_active_and_no_recovery : forall s,
  configuration_allowed s = true -> active s = true /\ pending_recovery s = false.
Proof.
  intros s H. unfold configuration_allowed in H.
  apply andb_true_iff in H. destruct H as [Hactive Hrecovery].
  apply negb_true_iff in Hrecovery. auto.
Qed.

Theorem joint_unfreeze_requires_recovery : forall s custody,
  has_recovery s = true -> unfreeze_allowed s custody false = false.
Proof.
  intros s custody H. unfold unfreeze_allowed. rewrite H.
  simpl. apply andb_false_r.
Qed.

Theorem unfreeze_requires_custody : forall s recovery,
  unfreeze_allowed s false recovery = false.
Proof. intros. unfold unfreeze_allowed. rewrite andb_false_r. reflexivity. Qed.

Theorem custody_cannot_cancel_at_maturity : forall s now maturity,
  maturity <= now -> cancel_recovery_allowed s now maturity true false = false.
Proof.
  intros s now maturity H. unfold cancel_recovery_allowed.
  assert ((now <? maturity) = false) as Htime by (apply Z.ltb_ge; lia).
  rewrite Htime, andb_false_r. simpl. apply andb_false_r.
Qed.

Theorem recovery_can_cancel_after_maturity : forall s now maturity,
  pending_recovery s = true -> has_recovery s = true ->
  cancel_recovery_allowed s now maturity false true = true.
Proof. intros s now maturity Hp Hr. unfold cancel_recovery_allowed. rewrite Hp, Hr. reflexivity. Qed.

Theorem advance_clears_all_intents : forall s next,
  advance s = Some next ->
  pending_verifier next = false /\ pending_hook next = false /\
  pending_address next = false /\ pending_recovery next = false.
Proof.
  intros s next H. unfold advance in H.
  destruct ((0 <=? epoch s) && (epoch s <? epoch_limit - 1));
    inversion H; subst; simpl; auto.
Qed.

Theorem advance_increments_exactly_once : forall s next,
  advance s = Some next -> epoch next = epoch s + 1.
Proof.
  intros s next H. unfold advance in H.
  destruct ((0 <=? epoch s) && (epoch s <? epoch_limit - 1));
    inversion H; subst; reflexivity.
Qed.

Theorem advance_preserves_status_and_recovery : forall s next,
  advance s = Some next -> active next = active s /\ has_recovery next = has_recovery s.
Proof.
  intros s next H. unfold advance in H.
  destruct ((0 <=? epoch s) && (epoch s <? epoch_limit - 1));
    inversion H; subst; auto.
Qed.

Theorem exhausted_epoch_is_rejected : forall s,
  epoch s = epoch_limit - 1 -> advance s = None.
Proof. intros s H. unfold advance. rewrite H, Z.ltb_irrefl, andb_false_r. reflexivity. Qed.

Theorem advance_stays_in_uint64 : forall s next,
  advance s = Some next -> 0 <= epoch next < epoch_limit.
Proof.
  intros s next H. unfold advance in H.
  destruct ((0 <=? epoch s) && (epoch s <? epoch_limit - 1)) eqn:E; try discriminate.
  apply andb_true_iff in E. destruct E as [El Eu].
  apply Z.leb_le in El. apply Z.ltb_lt in Eu.
  inversion H; subst; simpl. lia.
Qed.

Example custody_can_cancel_strictly_before_maturity :
  cancel_recovery_allowed (mkState true true 0 false false false true) 99 100 true false = true.
Proof. reflexivity. Qed.

Example recovery_free_frozen_account_can_unfreeze :
  unfreeze_allowed (mkState false false 0 false false false false) true false = true.
Proof. reflexivity. Qed.

Print Assumptions pending_recovery_blocks_configuration.
Print Assumptions frozen_blocks_configuration.
Print Assumptions configuration_requires_active_and_no_recovery.
Print Assumptions joint_unfreeze_requires_recovery.
Print Assumptions unfreeze_requires_custody.
Print Assumptions custody_cannot_cancel_at_maturity.
Print Assumptions recovery_can_cancel_after_maturity.
Print Assumptions advance_clears_all_intents.
Print Assumptions advance_increments_exactly_once.
Print Assumptions advance_preserves_status_and_recovery.
Print Assumptions exhausted_epoch_is_rejected.
Print Assumptions advance_stays_in_uint64.
Print Assumptions custody_can_cancel_strictly_before_maturity.
Print Assumptions recovery_free_frozen_account_can_unfreeze.

Theorem configuration_missing_root_rolls_back : forall (Store : Type)
    (before staged : Store) rp cp child,
  finalize_configuration before staged rp cp None child = (false, before).
Proof. intros. unfold finalize_configuration, configuration_bindings_match. reflexivity. Qed.

Theorem configuration_missing_child_rolls_back : forall (Store : Type)
    (before staged : Store) rp cp root,
  finalize_configuration before staged rp cp root None = (false, before).
Proof. intros. destruct root; reflexivity. Qed.

Theorem configuration_changed_root_rolls_back : forall (Store : Type)
    (before staged : Store) rp cp root child,
  root <> rp -> finalize_configuration before staged rp cp (Some root) child = (false, before).
Proof.
  intros. unfold finalize_configuration, configuration_bindings_match. destruct child; [|reflexivity].
  assert (Z.eqb root rp = false) as E by (apply Z.eqb_neq; assumption).
  rewrite E. reflexivity.
Qed.

Theorem configuration_changed_child_rolls_back : forall (Store : Type)
    (before staged : Store) rp cp root child,
  child <> cp -> finalize_configuration before staged rp cp root (Some child) = (false, before).
Proof.
  intros. unfold finalize_configuration, configuration_bindings_match. destruct root; [|reflexivity].
  assert (Z.eqb child cp = false) as E by (apply Z.eqb_neq; assumption).
  rewrite E, andb_false_r. reflexivity.
Qed.

Theorem configuration_success_preserves_pins : forall (Store : Type)
    (before staged : Store) rp cp root child,
  fst (finalize_configuration before staged rp cp root child) = true ->
  root = Some rp /\ child = Some cp.
Proof.
  intros Store before staged rp cp root child H.
  unfold finalize_configuration in H.
  destruct (configuration_bindings_match rp cp root child) eqn:E; [|discriminate].
  unfold configuration_bindings_match in E.
  destruct root, child; try discriminate.
  apply andb_true_iff in E. destruct E as [R C].
  apply Z.eqb_eq in R. apply Z.eqb_eq in C. subst. auto.
Qed.

Theorem configuration_failure_keeps_entire_snapshot : forall (Store : Type)
    (before staged : Store) rp cp root child,
  fst (finalize_configuration before staged rp cp root child) = false ->
  snd (finalize_configuration before staged rp cp root child) = before.
Proof.
  intros Store before staged rp cp root child H.
  unfold finalize_configuration in *.
  destruct (configuration_bindings_match rp cp root child); [discriminate|reflexivity].
Qed.

Theorem configuration_matching_pins_commits : forall (Store : Type)
    (before staged : Store) rp cp,
  finalize_configuration before staged rp cp (Some rp) (Some cp) = (true, staged).
Proof.
  intros. unfold finalize_configuration, configuration_bindings_match.
  repeat rewrite Z.eqb_refl. reflexivity.
Qed.

Example selected_only_check_is_insufficient :
  Z.eqb 7 7 = true /\ finalize_configuration 0 1 5 7 None (Some 7) = (false, 0).
Proof. split; reflexivity. Qed.

Print Assumptions configuration_missing_root_rolls_back.
Print Assumptions configuration_missing_child_rolls_back.
Print Assumptions configuration_changed_root_rolls_back.
Print Assumptions configuration_changed_child_rolls_back.
Print Assumptions configuration_success_preserves_pins.
Print Assumptions configuration_failure_keeps_entire_snapshot.
Print Assumptions configuration_matching_pins_commits.
Print Assumptions selected_only_check_is_insufficient.
