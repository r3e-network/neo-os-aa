(* Custom source-candidate callback-free recovery projection.
   Identity and nonce are ghost projections of retained storage; the model does
   not prove storage layout, compiler/VM refinement or witness validity. Mature
   timer, owner witness, whole-account lock and escrow predicates are abstract.
   The irreversible owner-only latch is not native authority-epoch recovery. *)
From Coq Require Import Bool PeanoNat.
Record RecoveryState := mkRecoveryState {
  account_identity : nat;
  retained_nonce : nat;
  owner_only : bool;
  verifier_root : bool;
  hook_root : bool;
  pending_intents : bool;
  live_contexts : bool
}.
Definition detached (before : RecoveryState) : RecoveryState :=
  mkRecoveryState (account_identity before) (retained_nonce before)
    true false false false false.
Definition recover (before : RecoveryState)
    (mature owner_witness locked escrow old_plugin_ok : bool) : option RecoveryState :=
  if mature && owner_witness && negb locked && negb escrow && negb (owner_only before)
  then Some (detached before) else None.
Definition apply_recovery (before : RecoveryState)
    (mature owner_witness locked escrow old_plugin_ok : bool) : RecoveryState :=
  match recover before mature owner_witness locked escrow old_plugin_ok with
  | Some next => next | None => before end.
Definition configure_roots (before : RecoveryState) (verifier hook : bool)
    : option RecoveryState :=
  if owner_only before && (verifier || hook) then None
  else Some (mkRecoveryState (account_identity before) (retained_nonce before)
    (owner_only before) verifier hook (pending_intents before) (live_contexts before)).

Theorem OR_001_recovery_does_not_depend_on_old_plugin : forall before m w l e first second,
  recover before m w l e first = recover before m w l e second.
Proof. reflexivity. Qed.
Theorem OR_002_recovery_requires_authority_and_safe_boundary : forall before m w l e old next,
  recover before m w l e old = Some next ->
  m = true /\ w = true /\ l = false /\ e = false.
Proof. intros before m w l e old next H. unfold recover in H.
  destruct (m && w && negb l && negb e && negb (owner_only before)) eqn:E; [|discriminate].
  repeat rewrite andb_true_iff in E. destruct E as [[[[Hm Hw] Hl] He] Hoo].
  apply negb_true_iff in Hl, He. auto. Qed.
Theorem OR_003_success_detaches_all_authority : forall before m w l e old next,
  recover before m w l e old = Some next ->
  owner_only next = true /\ verifier_root next = false /\ hook_root next = false /\
  pending_intents next = false /\ live_contexts next = false.
Proof. intros before m w l e old next H. unfold recover in H.
  destruct (m && w && negb l && negb e && negb (owner_only before)); [|discriminate].
  injection H as Hnext. subst next. repeat split; reflexivity. Qed.
Theorem OR_004_success_preserves_identity_and_nonce : forall before m w l e old next,
  recover before m w l e old = Some next ->
  account_identity next = account_identity before /\ retained_nonce next = retained_nonce before.
Proof. intros before m w l e old next H. unfold recover in H.
  destruct (m && w && negb l && negb e && negb (owner_only before)); [|discriminate].
  injection H as Hnext. subst next. split; reflexivity. Qed.
Theorem OR_005_failed_recovery_preserves_entire_projection : forall before m w l e old,
  recover before m w l e old = None -> apply_recovery before m w l e old = before.
Proof. intros before m w l e old H. unfold apply_recovery. rewrite H. reflexivity. Qed.
Theorem OR_006_latched_account_rejects_nonzero_roots : forall before verifier hook,
  owner_only before = true -> verifier || hook = true -> configure_roots before verifier hook = None.
Proof. intros before verifier hook Hl Hr. unfold configure_roots. rewrite Hl, Hr. reflexivity. Qed.
Theorem OR_007_configuration_never_clears_latch : forall before verifier hook next,
  configure_roots before verifier hook = Some next -> owner_only next = owner_only before.
Proof. intros before verifier hook next H. unfold configure_roots in H.
  destruct (owner_only before && (verifier || hook)); [discriminate|].
  injection H as Hnext. subst next. reflexivity. Qed.
Theorem OR_008_successful_latched_configuration_has_no_roots : forall before verifier hook next,
  owner_only before = true -> configure_roots before verifier hook = Some next ->
  verifier_root next = false /\ hook_root next = false.
Proof. intros before verifier hook next Hl H. unfold configure_roots in H.
  rewrite Hl in H. simpl in H. destruct verifier, hook; try discriminate.
  injection H as Hnext. subst next. split; reflexivity. Qed.
Example OR_009_broken_old_plugin_does_not_block_recovery :
  recover (mkRecoveryState 8 9 false true true true true) true true false false false =
    Some (mkRecoveryState 8 9 true false false false false).
Proof. reflexivity. Qed.
Example OR_010_owner_only_configuration_is_reachable :
  configure_roots (mkRecoveryState 8 9 true false false false false) false false =
    Some (mkRecoveryState 8 9 true false false false false).
Proof. reflexivity. Qed.
Print Assumptions OR_001_recovery_does_not_depend_on_old_plugin.
Print Assumptions OR_002_recovery_requires_authority_and_safe_boundary.
Print Assumptions OR_003_success_detaches_all_authority.
Print Assumptions OR_004_success_preserves_identity_and_nonce.
Print Assumptions OR_005_failed_recovery_preserves_entire_projection.
Print Assumptions OR_006_latched_account_rejects_nonzero_roots.
Print Assumptions OR_007_configuration_never_clears_latch.
Print Assumptions OR_008_successful_latched_configuration_has_no_roots.
Print Assumptions OR_009_broken_old_plugin_does_not_block_recovery.
Print Assumptions OR_010_owner_only_configuration_is_reachable.

Theorem OR_011_latched_recovery_cannot_repeat : forall before m w l e old,
  owner_only before = true -> recover before m w l e old = None.
Proof. intros before m w l e old H. unfold recover. rewrite H.
  rewrite andb_false_r. reflexivity. Qed.
Print Assumptions OR_011_latched_recovery_cannot_repeat.
