(* Native ABI 2 composite receipt NECESSARY CONDITIONS, not a refinement proof.
   Validation selects the first threshold exact-Boolean-true children in roster
   order. Only a fresh Application operation may retain the receipt. Post uses
   that selection without repeating cryptographic signature verification, and
   checks all active pins plus the policy commitment before and after callbacks.
   Native caps are 3 children / 2 threshold / 2 approved / 3 aggregate domains;
   these bounds are profile conditions, NOT a gas-feasibility theorem.

   IDs abstract Hash160s. Operation IDs abstract fresh ExecuteOne contexts, not
   attacker-supplied receipt fields. Natural-number policy tokens abstract exact
   commitment equality. Collision resistance and binding of
   SHA256(NeoBinarySerialize([threshold,orderedChildren,orderedChildSignerDomains])),
   correct raw receipt parsing, owned serialization/deep copies, crypto, VM
   rollback, storage absence, and compiler/source correspondence remain external
   implementation obligations. Clearing the abstract local slot proves only the
   model lifetime: it does not prove a concrete engine has no aliases/storage. *)
From Coq Require Import List Bool PeanoNat Lia.
Import ListNotations.

Inductive Phase := ValidationPhase | PostPhase | OtherPhase.
Inductive Trigger := Verification | Application.
Inductive Reply := TrueReply | FalseReply | NonBooleanReply | RejectedReply.
Inductive Shape := Array3 | OtherShape.
Inductive CommitmentShape := ByteString32 | WrongCommitmentType | WrongCommitmentLength.

Definition validation_phase (phase : Phase) : bool :=
  match phase with ValidationPhase => true | _ => false end.
Definition post_phase (phase : Phase) : bool :=
  match phase with PostPhase => true | _ => false end.
Definition application (trigger : Trigger) : bool :=
  match trigger with Application => true | Verification => false end.
Definition reply_approved (reply : Reply) : bool :=
  match reply with TrueReply => true | _ => false end.
Definition exact_shape (shape : Shape) : bool :=
  match shape with Array3 => true | OtherShape => false end.
Definition exact_commitment (shape : CommitmentShape) : bool :=
  match shape with ByteString32 => true | _ => false end.
Fixpoint unique (ids : list nat) : bool :=
  match ids with
  | [] => true
  | id :: rest => negb (existsb (Nat.eqb id) rest) && unique rest
  end.
Fixpoint ordered_subset (selected active : list nat) : bool :=
  match selected, active with
  | [], _ => true
  | _, [] => false
  | s :: ss, a :: aa =>
      if Nat.eqb s a then ordered_subset ss aa else ordered_subset selected aa
  end.
Definition config_valid (ids : list nat) (threshold domains : nat) : bool :=
  (0 <? length ids) && (length ids <=? 3) &&
  (0 <? threshold) && (threshold <=? 2) && (threshold <=? length ids) &&
  (domains <=? 3) && unique ids && forallb (fun id => negb (Nat.eqb id 0)) ids.
Definition selection (ids : list nat) (threshold : nat) (reply : nat -> Reply) : list nat :=
  firstn threshold (filter (fun id => reply_approved (reply id)) ids).
Definition validates (ids : list nat) (threshold domains count : nat)
    (reply : nat -> Reply) (phase : Phase) (grant : bool) : bool :=
  grant && validation_phase phase && config_valid ids threshold domains &&
  Nat.eqb count (length ids) && Nat.eqb (length (selection ids threshold reply)) threshold.

Record Receipt := ReceiptValue {
  receipt_shape : Shape; receipt_reply : Reply; commitment_shape : CommitmentShape;
  approved : list nat; owner_operation : nat; origin : Trigger; policy : nat
}.
Definition retained (trigger : Trigger) (receipt : Receipt) : option Receipt :=
  match trigger with Application => Some receipt | Verification => None end.
Definition prepare_local (active : list nat) (threshold domains count : nat) (reply : nat -> Reply)
    (phase : Phase) (grant : bool) (op : nat) (trigger : Trigger) (current_policy : nat) : option Receipt :=
  if validates active threshold domains count reply phase grant
  then retained trigger (ReceiptValue Array3 TrueReply ByteString32
    (selection active threshold reply) op trigger current_policy)
  else None.
Definition completed (_receipt : option Receipt) : option Receipt := None.
Definition post_ready (r : Receipt) (active : list nat) (threshold domains op current_policy : nat)
    (phase : Phase) (grant all_active_pins : bool) : bool :=
  grant && post_phase phase && application (origin r) &&
  Nat.eqb (owner_operation r) op && exact_shape (receipt_shape r) &&
  reply_approved (receipt_reply r) && exact_commitment (commitment_shape r) &&
  config_valid active threshold domains &&
  Nat.eqb (length (approved r)) threshold && (length (approved r) <=? 2) &&
  unique (approved r) && ordered_subset (approved r) active &&
  all_active_pins && Nat.eqb (policy r) current_policy.
Definition active_pin_check (active : list nat) (pin : nat -> bool) : bool :=
  forallb pin active.
Definition post_plan (r : Receipt) (active : list nat) (threshold domains op current_policy : nat)
    (phase : Phase) (grant : bool) (pin : nat -> bool) : list nat :=
  if post_ready r active threshold domains op current_policy phase grant (active_pin_check active pin)
  then approved r else [].
Definition post_complete (ready : bool) (r : Receipt) (after_policy : nat) (after_pins : bool) : bool :=
  ready && Nat.eqb (policy r) after_policy && after_pins.
Definition good_receipt (ids : list nat) (op : nat) (trigger : Trigger) : Receipt :=
  ReceiptValue Array3 TrueReply ByteString32 ids op trigger 7.
Definition ready (r : Receipt) : bool := post_ready r [1; 2; 3] 2 3 10 7 PostPhase true true.

Lemma firstn_membership : forall (ids : list nat) n id,
  In id (firstn n ids) -> In id ids.
Proof.
  induction ids as [|a ids IH]; intros [|n] id H; simpl in *; try contradiction.
  destruct H; [left; assumption|right; eapply IH; eassumption].
Qed.
Lemma firstn_unique : forall (ids : list nat) n,
  NoDup ids -> NoDup (firstn n ids).
Proof.
  induction ids as [|a ids IH]; intros [|n] H; simpl; try solve [constructor].
  inversion H; subst. constructor.
  - intro Hin. apply H2. eapply firstn_membership; eassumption.
  - apply IH; assumption.
Qed.
Theorem selection_preserves_membership : forall ids threshold reply id,
  In id (selection ids threshold reply) -> In id ids /\ reply id = TrueReply.
Proof.
  intros ids threshold reply id H. apply firstn_membership in H.
  apply filter_In in H. destruct H as [Hin Hreply]. split; [assumption|].
  destruct (reply id); simpl in Hreply; try discriminate; reflexivity.
Qed.
Theorem selection_preserves_uniqueness : forall ids threshold reply,
  NoDup ids -> NoDup (selection ids threshold reply).
Proof. intros. apply firstn_unique, NoDup_filter; assumption. Qed.
Theorem selection_has_exact_threshold : forall ids threshold reply,
  threshold <= length (filter (fun id => reply_approved (reply id)) ids) ->
  length (selection ids threshold reply) = threshold.
Proof. intros. unfold selection. rewrite firstn_length. apply Nat.min_l; assumption. Qed.
Theorem validation_requires_grant_and_phase : forall ids threshold domains count reply phase grant,
  validates ids threshold domains count reply phase grant = true ->
  grant = true /\ phase = ValidationPhase.
Proof.
  intros. unfold validates in H. repeat rewrite andb_true_iff in H.
  assert (grant = true /\ validation_phase phase = true) as [G P] by tauto.
  split; [assumption|]. destruct phase; simpl in P; congruence.
Qed.
Theorem validation_requires_signature_count : forall ids threshold domains count reply phase grant,
  validates ids threshold domains count reply phase grant = true -> count = length ids.
Proof.
  intros. unfold validates in H. repeat rewrite andb_true_iff in H.
  apply Nat.eqb_eq. tauto.
Qed.
Theorem native_config_caps : forall ids threshold domains,
  config_valid ids threshold domains = true ->
  0 < length ids /\ length ids <= 3 /\ 0 < threshold /\ threshold <= 2 /\
  threshold <= length ids /\ domains <= 3.
Proof.
  intros. unfold config_valid in H. repeat rewrite andb_true_iff in H.
  repeat split; [apply Nat.ltb_lt|apply Nat.leb_le|apply Nat.ltb_lt|apply Nat.leb_le|apply Nat.leb_le|apply Nat.leb_le]; tauto.
Qed.
Theorem local_receipt_requires_fresh_application_validation :
  forall active threshold domains count reply phase grant op trigger current r,
  prepare_local active threshold domains count reply phase grant op trigger current = Some r ->
  trigger = Application /\ validates active threshold domains count reply phase grant = true /\
  approved r = selection active threshold reply /\ owner_operation r = op /\ policy r = current.
Proof.
  intros. unfold prepare_local in H.
  destruct (validates active threshold domains count reply phase grant) eqn:V; [|discriminate].
  destruct trigger; simpl in H; [discriminate|]. inversion H; subst; simpl. auto.
Qed.
Theorem verification_preparation_cannot_retain_receipt :
  forall active threshold domains count reply phase grant op current,
  prepare_local active threshold domains count reply phase grant op Verification current = None.
Proof. intros. unfold prepare_local. destruct (validates active threshold domains count reply phase grant); reflexivity. Qed.
Example successful_application_prepares_selection :
  prepare_local [1; 2; 3] 2 3 3 (fun _ => TrueReply) ValidationPhase true 10 Application 7 =
  Some (good_receipt [1; 2] 10 Application).
Proof. reflexivity. Qed.
Theorem post_requires_application_operation : forall r active threshold domains op current phase grant pins,
  post_ready r active threshold domains op current phase grant pins = true ->
  origin r = Application /\ owner_operation r = op.
Proof.
  intros. unfold post_ready in H. repeat rewrite andb_true_iff in H.
  assert (application (origin r) = true) as A by tauto.
  split; [destruct (origin r); simpl in A; congruence|apply Nat.eqb_eq; tauto].
Qed.
Theorem post_requires_current_policy : forall r active threshold domains op current phase grant pins,
  post_ready r active threshold domains op current phase grant pins = true -> policy r = current.
Proof. intros. unfold post_ready in H. repeat rewrite andb_true_iff in H. apply Nat.eqb_eq; tauto. Qed.
Theorem post_requires_all_active_pins : forall r active threshold domains op current phase grant pins,
  post_ready r active threshold domains op current phase grant pins = true -> pins = true.
Proof. intros. unfold post_ready in H. repeat rewrite andb_true_iff in H. tauto. Qed.
Theorem post_approved_count_is_threshold : forall r active threshold domains op current phase grant pins,
  post_ready r active threshold domains op current phase grant pins = true ->
  length (approved r) = threshold /\ length (approved r) <= 2.
Proof.
  intros. unfold post_ready in H. repeat rewrite andb_true_iff in H.
  split; [apply Nat.eqb_eq|apply Nat.leb_le]; tauto.
Qed.
Theorem post_plan_grants_only_approved : forall r active threshold domains op current phase grant pins id,
  In id (post_plan r active threshold domains op current phase grant pins) -> In id (approved r).
Proof. intros. unfold post_plan in H. destruct (post_ready r active threshold domains op current phase grant (active_pin_check active pins)); simpl in *; tauto. Qed.
Theorem post_plan_checks_even_unapproved_pins : forall r active threshold domains op current phase grant pins called child,
  In called (post_plan r active threshold domains op current phase grant pins) ->
  In child active -> pins child = true.
Proof.
  intros r active threshold domains op current phase grant pins called child Hin Hactive.
  unfold post_plan in Hin.
  destruct (post_ready r active threshold domains op current phase grant (active_pin_check active pins)) eqn:E;
    [|simpl in Hin; contradiction].
  apply post_requires_all_active_pins in E. unfold active_pin_check in E.
  rewrite forallb_forall in E. apply E; assumption.
Qed.
Example unapproved_child_pin_still_required :
  post_plan (good_receipt [1; 2] 10 Application) [1; 2; 3] 2 3 10 7 PostPhase true
    (fun id => negb (Nat.eqb id 3)) = [].
Proof. reflexivity. Qed.
Example valid_post_plan_grants_selected_subset :
  post_plan (good_receipt [1; 2] 10 Application) [1; 2; 3] 2 3 10 7 PostPhase true
    (fun _ => true) = [1; 2].
Proof. reflexivity. Qed.
Theorem completion_rechecks_policy : forall ok r after pins,
  post_complete ok r after pins = true -> ok = true /\ policy r = after /\ pins = true.
Proof.
  intros. unfold post_complete in H. repeat rewrite andb_true_iff in H.
  destruct H as [[Hok Heq] Hpin]. apply Nat.eqb_eq in Heq. tauto.
Qed.
Theorem verification_receipt_is_discarded : forall r, retained Verification r = None.
Proof. reflexivity. Qed.
Theorem operation_completion_discards_receipt : forall r, completed r = None.
Proof. reflexivity. Qed.
Theorem application_retains_fresh_receipt : forall r, retained Application r = Some r.
Proof. reflexivity. Qed.
Example first_threshold_in_roster_order : selection [3; 1; 2] 2 (fun _ => TrueReply) = [3; 1].
Proof. reflexivity. Qed.
Example non_boolean_child_does_not_vote : selection [1; 2] 1 (fun id => if Nat.eqb id 1 then NonBooleanReply else TrueReply) = [2].
Proof. reflexivity. Qed.
Example insufficient_support_rejects : validates [1; 2] 2 2 2 (fun _ => FalseReply) ValidationPhase true = false.
Proof. reflexivity. Qed.
Example valid_receipt_completes : post_complete (ready (good_receipt [1; 2] 10 Application)) (good_receipt [1; 2] 10 Application) 7 true = true.
Proof. reflexivity. Qed.
Example post_wrong_phase_rejects : post_ready (good_receipt [1; 2] 10 Application) [1; 2; 3] 2 3 10 7 ValidationPhase true true = false.
Proof. reflexivity. Qed.
Example post_missing_grant_rejects : post_ready (good_receipt [1; 2] 10 Application) [1; 2; 3] 2 3 10 7 PostPhase false true = false.
Proof. reflexivity. Qed.
Example verification_reuse_rejects : ready (good_receipt [1; 2] 10 Verification) = false.
Proof. reflexivity. Qed.
Example other_operation_rejects : ready (good_receipt [1; 2] 11 Application) = false.
Proof. reflexivity. Qed.
Example wrong_receipt_arity_rejects : ready (ReceiptValue OtherShape TrueReply ByteString32 [1; 2] 10 Application 7) = false.
Proof. reflexivity. Qed.
Example non_boolean_receipt_rejects : ready (ReceiptValue Array3 NonBooleanReply ByteString32 [1; 2] 10 Application 7) = false.
Proof. reflexivity. Qed.
Example wrong_commitment_type_rejects : ready (ReceiptValue Array3 TrueReply WrongCommitmentType [1; 2] 10 Application 7) = false.
Proof. reflexivity. Qed.
Example wrong_commitment_length_rejects : ready (ReceiptValue Array3 TrueReply WrongCommitmentLength [1; 2] 10 Application 7) = false.
Proof. reflexivity. Qed.
Example duplicate_approved_rejects : ready (good_receipt [1; 1] 10 Application) = false.
Proof. reflexivity. Qed.
Example unordered_approved_rejects : ready (good_receipt [2; 1] 10 Application) = false.
Proof. reflexivity. Qed.
Example inactive_approved_rejects : ready (good_receipt [1; 4] 10 Application) = false.
Proof. reflexivity. Qed.
Example incomplete_approved_rejects : ready (good_receipt [1] 10 Application) = false.
Proof. reflexivity. Qed.
Example empty_roster_rejects : config_valid [] 1 0 = false.
Proof. reflexivity. Qed.
Example duplicate_roster_rejects : config_valid [1; 1] 1 2 = false.
Proof. reflexivity. Qed.
Example zero_roster_rejects : config_valid [0; 1] 1 2 = false.
Proof. reflexivity. Qed.
Example fourth_child_rejects : config_valid [1; 2; 3; 4] 2 3 = false.
Proof. reflexivity. Qed.
Example third_threshold_rejects : config_valid [1; 2; 3] 3 3 = false.
Proof. reflexivity. Qed.
Example fourth_domain_rejects : config_valid [1; 2] 2 4 = false.
Proof. reflexivity. Qed.

Print Assumptions firstn_membership.
Print Assumptions firstn_unique.
Print Assumptions selection_preserves_membership.
Print Assumptions selection_preserves_uniqueness.
Print Assumptions selection_has_exact_threshold.
Print Assumptions validation_requires_grant_and_phase.
Print Assumptions validation_requires_signature_count.
Print Assumptions native_config_caps.
Print Assumptions post_requires_application_operation.
Print Assumptions post_requires_current_policy.
Print Assumptions post_requires_all_active_pins.
Print Assumptions post_approved_count_is_threshold.
Print Assumptions post_plan_grants_only_approved.
Print Assumptions completion_rechecks_policy.
Print Assumptions verification_receipt_is_discarded.
Print Assumptions operation_completion_discards_receipt.
Print Assumptions application_retains_fresh_receipt.
Print Assumptions first_threshold_in_roster_order.
Print Assumptions non_boolean_child_does_not_vote.
Print Assumptions insufficient_support_rejects.
Print Assumptions valid_receipt_completes.
Print Assumptions post_wrong_phase_rejects.
Print Assumptions post_missing_grant_rejects.
Print Assumptions verification_reuse_rejects.
Print Assumptions other_operation_rejects.
Print Assumptions wrong_receipt_arity_rejects.
Print Assumptions non_boolean_receipt_rejects.
Print Assumptions wrong_commitment_type_rejects.
Print Assumptions wrong_commitment_length_rejects.
Print Assumptions duplicate_approved_rejects.
Print Assumptions unordered_approved_rejects.
Print Assumptions inactive_approved_rejects.
Print Assumptions incomplete_approved_rejects.
Print Assumptions empty_roster_rejects.
Print Assumptions duplicate_roster_rejects.
Print Assumptions zero_roster_rejects.
Print Assumptions fourth_child_rejects.
Print Assumptions third_threshold_rejects.
Print Assumptions fourth_domain_rejects.

Print Assumptions post_plan_checks_even_unapproved_pins.
Print Assumptions unapproved_child_pin_still_required.
Print Assumptions valid_post_plan_grants_selected_subset.

Print Assumptions local_receipt_requires_fresh_application_validation.
Print Assumptions verification_preparation_cannot_retain_receipt.
Print Assumptions successful_application_prepares_selection.
