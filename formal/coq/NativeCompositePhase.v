(* Phase-specific composite revalidation. The grant, reply and configured
   roster are abstract; this does not establish runtime/compiler refinement. *)
From Coq Require Import List Bool.
Import ListNotations.

Inductive Entry := ValidationEntry | PostEntry.
Inductive Phase := ValidationPhase | PostPhase | OtherPhase.
Inductive Reply := TrueReply | FalseReply | NonBooleanReply | RejectedReply.

Definition phase_allowed (entry : Entry) (phase : Phase) : bool :=
  match entry, phase with
  | ValidationEntry, ValidationPhase => true
  | PostEntry, PostPhase => true
  | _, _ => false
  end.
Definition reply_approved (reply : Reply) : bool :=
  match reply with TrueReply => true | _ => false end.
Definition native_approve (entry : Entry) (phase : Phase) (grant : bool) (reply : Reply) : bool :=
  grant && phase_allowed entry phase && reply_approved reply.
Definition post_plan (ids : list nat) (grant : bool) (reply : nat -> Reply) : list nat :=
  filter (fun id => native_approve PostEntry PostPhase grant (reply id)) ids.

Theorem old_entry_rejects_post : forall grant reply,
  native_approve ValidationEntry PostPhase grant reply = false.
Proof. intros [] []; reflexivity. Qed.
Theorem post_entry_rejects_validation : forall grant reply,
  native_approve PostEntry ValidationPhase grant reply = false.
Proof. intros [] []; reflexivity. Qed.
Theorem other_phase_rejects : forall entry grant reply,
  native_approve entry OtherPhase grant reply = false.
Proof. intros [] [] []; reflexivity. Qed.
Theorem missing_grant_rejects : forall entry phase reply,
  native_approve entry phase false reply = false.
Proof. intros [] [] []; reflexivity. Qed.
Theorem both_entries_use_same_policy : forall reply,
  native_approve ValidationEntry ValidationPhase true reply = reply_approved reply /\
  native_approve PostEntry PostPhase true reply = reply_approved reply.
Proof. intros []; split; reflexivity. Qed.
Theorem nonboolean_not_support : forall entry phase grant,
  native_approve entry phase grant NonBooleanReply = false.
Proof. intros [] [] []; reflexivity. Qed.
Theorem false_not_support : forall entry phase grant,
  native_approve entry phase grant FalseReply = false.
Proof. intros [] [] []; reflexivity. Qed.
Theorem post_plan_exact_support : forall ids reply id,
  In id (post_plan ids true reply) <-> In id ids /\ reply id = TrueReply.
Proof.
  intros. unfold post_plan. rewrite filter_In. simpl.
  destruct (reply id); simpl; split; intros H; try tauto;
  destruct H as [H E]; discriminate.
Qed.
Theorem post_plan_preserves_membership : forall ids grant reply id,
  In id (post_plan ids grant reply) -> In id ids.
Proof. intros. apply filter_In in H. tauto. Qed.
Theorem post_plan_preserves_uniqueness : forall ids grant reply,
  NoDup ids -> NoDup (post_plan ids grant reply).
Proof. intros. apply NoDup_filter. assumption. Qed.
Theorem post_plan_needs_grant : forall ids reply,
  post_plan ids false reply = [].
Proof. induction ids; intros; simpl; [reflexivity|apply IHids]. Qed.

Print Assumptions old_entry_rejects_post.
Print Assumptions post_entry_rejects_validation.
Print Assumptions other_phase_rejects.
Print Assumptions missing_grant_rejects.
Print Assumptions both_entries_use_same_policy.
Print Assumptions nonboolean_not_support.
Print Assumptions false_not_support.
Print Assumptions post_plan_exact_support.
Print Assumptions post_plan_preserves_membership.
Print Assumptions post_plan_preserves_uniqueness.
Print Assumptions post_plan_needs_grant.
