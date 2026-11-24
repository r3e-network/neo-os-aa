From Coq Require Import Bool.Bool Lists.List Arith.PeanoNat.
Import ListNotations.

(* Policy model only. Call/witness authenticity, storage and VM rollback are
   separate implementation obligations. *)
(* InvalidStatus is a rejected decoder input, not an account lifecycle state. *)
Inductive status := Active | Frozen | InvalidStatus.
Definition accept_authority (admin changed consent valid_address : bool) : bool :=
  admin && valid_address && (negb changed || consent).
Definition recover (s : status) (seat configured mature current_epoch : bool) : bool :=
  match s with
  | Active | Frozen => seat && configured && mature && current_epoch
  | InvalidStatus => false
  end.
Definition hook_trace (hooks : list nat) := hooks ++ rev hooks.

(* Pending governance approval after one observed core write. The two policy
   flags model resource-tracked core policy groups, excluding arbitrary callbacks.
   An epoch or resource conflict deletes the record; an untracked transition
   leaves the old checkpoint in place and therefore cannot renew it. *)
Definition governance_checkpoint (same_epoch disjoint pending_policy committed_policy : bool)
    (checkpoint before after : nat) : option nat :=
  if same_epoch && disjoint then
    if pending_policy && committed_policy && Nat.eqb checkpoint before && Nat.eqb after (S before)
    then Some after else Some checkpoint
  else None.

(* Observations expected from the reviewed caller and intent. This is an
   admission model, not a proof that a particular NEF implements the caller. *)
Definition governed_admission (installed exact_code exact_manifest original_deployment exact_payload
    current_epoch unused : bool) (now maturity expiry : nat) : bool :=
  installed && exact_code && exact_manifest && original_deployment && exact_payload &&
  current_epoch && unused && (maturity <=? now) && (now <=? expiry).

(* A core batch has ordered, staged updates and one commit point. State and
   actions are abstract: this does not establish VM storage or callback semantics. *)
Fixpoint stage_actions (step : nat -> nat -> option nat) (state : nat) (actions : list nat) : option nat :=
  match actions with
  | [] => Some state
  | action :: rest =>
      match step state action with
      | Some next => stage_actions step next rest
      | None => None
      end
  end.

Definition commit_actions (step : nat -> nat -> option nat) (route : nat -> bool)
    (nonce state : nat) (actions : list nat) : nat * nat :=
  if (1 <=? length actions) && (length actions <=? 16) then
    match stage_actions step state actions with
    | Some final => if route final then (S nonce, final) else (nonce, state)
    | None => (nonce, state)
    end
  else (nonce, state).

(* Custody operations bind a fixed credential generation and an authority
   epoch. A message delegation has a separate revision and signing key. *)
Definition custody_operation (enabled custody_signature message_signature : bool)
    (expected_epoch signed_epoch generation : nat) : bool :=
  enabled && custody_signature && Nat.eqb expected_epoch signed_epoch && Nat.eqb generation 1.

(* route_ok represents the independently checked normal route before enrollment.
   After enrollment only the enrolled route and its quorum may spend. *)
Definition spending_route (required route : nat) (route_ok quorum : bool) : bool :=
  match required with
  | 0 => route_ok
  | S n => Nat.eqb route (S n) && quorum
  end.

Definition recovery_policy (required : nat) (s : status) (seat configured mature current : bool) : nat :=
  if recover s seat configured mature current then 0 else required.

(* Digests and provider IDs are observations, not an assumption that hashing
   is injective. The store is indexed by both the hosting contract and account. *)
Definition message_roster (store : nat -> nat -> option (nat * nat))
    (account provider revision commitment : nat) : bool :=
  match store provider account with
  | Some (observed_revision, observed_digest) =>
      Nat.eqb observed_revision revision && Nat.eqb observed_digest commitment
  | None => false
  end.

Theorem new_authority_requires_consent : forall a c v,
  accept_authority a true c v = true -> c = true.
Proof. intros [] [] []; cbv; intuition discriminate. Qed.
Theorem unchanged_authority_needs_only_admin_and_valid_address : forall a c v,
  accept_authority a false c v = andb a v.
Proof. intros [] [] []; reflexivity. Qed.
Theorem frozen_recovery_matches_active : forall seat configured mature current_epoch,
  recover Frozen seat configured mature current_epoch =
  recover Active seat configured mature current_epoch.
Proof. reflexivity. Qed.
Theorem frozen_recovery_needs_all_conditions : forall a b c d,
  recover Frozen a b c d = true <-> a = true /\ b = true /\ c = true /\ d = true.
Proof. intros [] [] [] []; cbv; intuition discriminate. Qed.
Theorem invalid_status_never_recovers : forall a b c d,
  recover InvalidStatus a b c d = false.
Proof. reflexivity. Qed.
Theorem nested_hooks_bracket_target : forall h hs,
  hook_trace (h :: hs) = h :: hook_trace hs ++ [h].
Proof. intros. unfold hook_trace. simpl. now rewrite app_assoc. Qed.

Print Assumptions new_authority_requires_consent.
Print Assumptions unchanged_authority_needs_only_admin_and_valid_address.
Print Assumptions frozen_recovery_matches_active.
Print Assumptions frozen_recovery_needs_all_conditions.
Print Assumptions invalid_status_never_recovers.
Print Assumptions nested_hooks_bracket_target.

Theorem independent_policy_step_preserves_confirmability : forall n,
  governance_checkpoint true true true true n n (S n) = Some (S n).
Proof. intros n. unfold governance_checkpoint. now rewrite !Nat.eqb_refl. Qed.

Theorem changed_checkpoint_requires_reviewed_step : forall e d p c k b a,
  a <> k -> governance_checkpoint e d p c k b a = Some a ->
  e = true /\ d = true /\ p = true /\ c = true /\ k = b /\ a = S b.
Proof.
  intros e d p c k b a Hneq H.
  unfold governance_checkpoint in H.
  destruct (e && d) eqn:E; [|discriminate].
  destruct (p && c && Nat.eqb k b && Nat.eqb a (S b)) eqn:G; [|congruence].
  apply Bool.andb_true_iff in E as [He Hd].
  apply Bool.andb_true_iff in G as [G Ga].
  apply Bool.andb_true_iff in G as [G Gk].
  apply Bool.andb_true_iff in G as [Hp Hc].
  apply Nat.eqb_eq in Ga. apply Nat.eqb_eq in Gk. tauto.
Qed.

Theorem conflicting_or_changed_epoch_invalidates : forall e d p c k b a,
  e = false \/ d = false -> governance_checkpoint e d p c k b a = None.
Proof. intros [] [] p c k b a; simpl; intuition discriminate. Qed.

Print Assumptions independent_policy_step_preserves_confirmability.
Print Assumptions changed_checkpoint_requires_reviewed_step.
Print Assumptions conflicting_or_changed_epoch_invalidates.

Theorem successful_core_batch_advances_once : forall step route n s actions final,
  (1 <=? length actions) && (length actions <=? 16) = true ->
  stage_actions step s actions = Some final -> route final = true ->
  commit_actions step route n s actions = (S n, final).
Proof. intros. unfold commit_actions. now rewrite H, H0, H1. Qed.

Theorem failed_core_batch_preserves_input : forall step route n s actions,
  stage_actions step s actions = None -> commit_actions step route n s actions = (n, s).
Proof. intros. unfold commit_actions. destruct (_ && _); [now rewrite H|reflexivity]. Qed.

Theorem missing_final_route_preserves_input : forall step route n s actions final,
  stage_actions step s actions = Some final -> route final = false ->
  commit_actions step route n s actions = (n,s).
Proof. intros. unfold commit_actions. destruct (_ && _); [now rewrite H, H0|reflexivity]. Qed.

Theorem staged_second_action_refusal : forall step s a b next rest,
  step s a = Some next -> step next b = None ->
  stage_actions step s (a :: b :: rest) = None.
Proof. intros. simpl. now rewrite H, H0. Qed.

Theorem outside_batch_limit_preserves_input : forall step route n s actions,
  (1 <=? length actions) && (length actions <=? 16) = false ->
  commit_actions step route n s actions = (n,s).
Proof. intros. unfold commit_actions. now rewrite H. Qed.

Print Assumptions successful_core_batch_advances_once.
Print Assumptions failed_core_batch_preserves_input.
Print Assumptions missing_final_route_preserves_input.
Print Assumptions staged_second_action_refusal.
Print Assumptions outside_batch_limit_preserves_input.

Lemma staged_prefix_then_suffix : forall step prefix state intermediate suffix,
  stage_actions step state prefix = Some intermediate ->
  stage_actions step state (prefix ++ suffix) = stage_actions step intermediate suffix.
Proof.
  intros step prefix. induction prefix as [|a rest IH]; intros state intermediate suffix H.
  - simpl in H. inversion H. reflexivity.
  - simpl in H |- *. destruct (step state a) as [next|]; try discriminate.
    now apply IH.
Qed.

Theorem refused_callback_after_any_prefix_rolls_back : forall step route nonce initial prefix staged callback suffix,
  stage_actions step initial prefix = Some staged -> step staged callback = None ->
  commit_actions step route nonce initial (prefix ++ callback :: suffix) = (nonce, initial).
Proof.
  intros. apply failed_core_batch_preserves_input.
  rewrite (staged_prefix_then_suffix step prefix initial staged (callback :: suffix) H).
  simpl. now rewrite H0.
Qed.

Print Assumptions staged_prefix_then_suffix.
Print Assumptions refused_callback_after_any_prefix_rolls_back.

Theorem governed_admission_requires_bound_review : forall i c m o p e u n a b,
  governed_admission i c m o p e u n a b = true ->
  i = true /\ c = true /\ m = true /\ o = true /\ p = true /\ e = true /\ u = true /\ a <= n /\ n <= b.
Proof.
  intros. unfold governed_admission in H. repeat rewrite andb_true_iff in H.
  repeat rewrite Nat.leb_le in H. tauto.
Qed.
Theorem governed_admission_includes_window_endpoints : forall a b, a <= b ->
  governed_admission true true true true true true true a a b = true /\
  governed_admission true true true true true true true b a b = true.
Proof. intros. unfold governed_admission. rewrite !Nat.leb_refl, (proj2 (Nat.leb_le a b) H). reflexivity || auto. Qed.
Print Assumptions governed_admission_requires_bound_review.
Print Assumptions governed_admission_includes_window_endpoints.

Theorem custody_operation_requires_current_authority : forall e c m epoch signed g,
  custody_operation e c m epoch signed g = true <->
    e = true /\ c = true /\ epoch = signed /\ g = 1.
Proof.
  intros. unfold custody_operation. repeat rewrite andb_true_iff.
  repeat rewrite Nat.eqb_eq. tauto.
Qed.

Theorem custody_operation_independent_of_message_key : forall e c epoch signed g,
  custody_operation e c true epoch signed g = custody_operation e c false epoch signed g.
Proof. reflexivity. Qed.

Print Assumptions custody_operation_requires_current_authority.
Print Assumptions custody_operation_independent_of_message_key.

Theorem enrolled_spending_requires_policy_and_quorum : forall n route direct quorum,
  spending_route (S n) route direct quorum = true <-> route = S n /\ quorum = true.
Proof. intros. unfold spending_route. rewrite andb_true_iff, Nat.eqb_eq. tauto. Qed.

Theorem basic_custody_cannot_spend_after_enrollment : forall n direct quorum,
  spending_route (S n) 0 direct quorum = false.
Proof. reflexivity. Qed.

Theorem enrolled_recovery_requires_current_mature_seat : forall n s a b c d,
  recovery_policy (S n) s a b c d = 0 <->
  (s = Active \/ s = Frozen) /\ a = true /\ b = true /\ c = true /\ d = true.
Proof. intros n [] [] [] [] []; simpl; intuition discriminate. Qed.

Print Assumptions enrolled_spending_requires_policy_and_quorum.
Print Assumptions basic_custody_cannot_spend_after_enrollment.
Print Assumptions enrolled_recovery_requires_current_mature_seat.

Theorem message_roster_requires_exact_provider_row : forall store a p r h,
  message_roster store a p r h = true <-> store p a = Some (r,h).
Proof.
  intros. unfold message_roster. destruct (store p a) as [[x y]|].
  - rewrite andb_true_iff, !Nat.eqb_eq. split;
      [intros [-> ->]; reflexivity|intro H; inversion H; auto].
  - split; discriminate.
Qed.
Print Assumptions message_roster_requires_exact_provider_row.
