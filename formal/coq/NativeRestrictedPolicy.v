(* Account-local restriction policy. Reply decoding, honest balances, native
   phase grants, storage enumeration and VM rollback require correspondence. *)
From Coq Require Import Bool PeanoNat List Lia.
Import ListNotations.

Definition observation_allowed (snapshot reply : option nat) : bool :=
  match snapshot with
  | None => false
  | Some before => match reply with
    | None => false
    | Some after => before <=? after
    end
  end.
Definition pre_check (context direct_restricted queries_valid : bool) : bool :=
  context && negb direct_restricted && queries_valid.
Fixpoint all_restrictions (checks : list bool) : bool :=
  match checks with [] => true | check :: rest => check && all_restrictions rest end.
Definition post_check (context : bool) (checks : list bool) (target_result : bool) : bool :=
  context && all_restrictions checks.
Record RestrictionState := State { configured : list nat; snapshots : list nat }.
Definition without_token (token : nat) (entries : list nat) : list nat :=
  filter (fun entry => negb (entry =? token)) entries.
Definition remove_token (token : nat) (s : RestrictionState) : RestrictionState :=
  State (without_token token (configured s)) (without_token token (snapshots s)).
Definition clear_account (s : RestrictionState) : RestrictionState := State [] [].

Theorem missing_snapshot_rejects : forall reply, observation_allowed None reply = false.
Proof. reflexivity. Qed.
Theorem invalid_query_rejects : forall snapshot, observation_allowed snapshot None = false.
Proof. intros []; reflexivity. Qed.
Theorem outflow_rejects : forall before after,
  after < before -> observation_allowed (Some before) (Some after) = false.
Proof. intros. simpl. apply Nat.leb_gt. assumption. Qed.
Theorem inflow_allowed : forall before after,
  before <= after -> observation_allowed (Some before) (Some after) = true.
Proof. intros. simpl. apply Nat.leb_le. assumption. Qed.
Theorem zero_net_allowed : forall balance, observation_allowed (Some balance) (Some balance) = true.
Proof. intros. simpl. apply Nat.leb_refl. Qed.
Theorem direct_target_rejects : forall context queries, pre_check context true queries = false.
Proof. intros []; reflexivity. Qed.
Theorem pre_requires_context : forall direct queries, pre_check false direct queries = false.
Proof. reflexivity. Qed.
Theorem post_requires_context : forall checks result, post_check false checks result = false.
Proof. reflexivity. Qed.
Theorem empty_restrictions_reachable : forall result, post_check true [] result = true.
Proof. reflexivity. Qed.
Theorem every_restriction_must_hold : forall checks,
  all_restrictions checks = true <-> Forall (fun check => check = true) checks.
Proof.
  induction checks as [|check rest IH]; simpl.
  - split; intros; [constructor|reflexivity].
  - rewrite andb_true_iff, IH. split.
    + intros [H R]. constructor; assumption.
    + intros H. inversion H; subst. split; [reflexivity|assumption].
Qed.
Theorem false_result_does_not_bypass : forall checks,
  post_check true checks false = all_restrictions checks.
Proof. reflexivity. Qed.
Theorem false_outflow_rejects : forall before after rest,
  after < before -> post_check true (observation_allowed (Some before) (Some after) :: rest) false = false.
Proof. intros. rewrite outflow_rejects by assumption. reflexivity. Qed.
Theorem removal_clears_token : forall token s,
  ~ In token (configured (remove_token token s)) /\ ~ In token (snapshots (remove_token token s)).
Proof.
  intros. unfold remove_token, without_token; simpl. split; intros H; apply filter_In in H;
  destruct H as [_ H]; rewrite Nat.eqb_refl in H; discriminate.
Qed.
Theorem removal_preserves_other_tokens : forall token other entries,
  token <> other -> (In other (without_token token entries) <-> In other entries).
Proof.
  intros. unfold without_token. rewrite filter_In.
  assert (E : (other =? token) = false) by (apply Nat.eqb_neq; lia).
  rewrite E. simpl. tauto.
Qed.
Theorem cleanup_clears_both_prefixes : forall s,
  configured (clear_account s) = [] /\ snapshots (clear_account s) = [].
Proof. intros. split; reflexivity. Qed.

Print Assumptions missing_snapshot_rejects.
Print Assumptions invalid_query_rejects.
Print Assumptions outflow_rejects.
Print Assumptions inflow_allowed.
Print Assumptions zero_net_allowed.
Print Assumptions direct_target_rejects.
Print Assumptions pre_requires_context.
Print Assumptions post_requires_context.
Print Assumptions empty_restrictions_reachable.
Print Assumptions every_restriction_must_hold.
Print Assumptions false_result_does_not_bypass.
Print Assumptions false_outflow_rejects.
Print Assumptions removal_clears_token.
Print Assumptions removal_preserves_other_tokens.
Print Assumptions cleanup_clears_both_prefixes.
