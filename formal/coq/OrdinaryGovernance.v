(*
  NeoOS formal verification -- ordinary platform owner governance.

  This is a scoped state-machine model of the source-candidate platform owner
  rotation path. Registrar identity, owner witness, account binding, time,
  escape and escrow status are abstract inputs; C# to NEF/NeoVM refinement,
  storage serialization and public deployment are outside this model.
*)
From Coq Require Import Bool PeanoNat Lia.

Record GovernanceState : Type := mkGovernanceState {
  registrar : nat;
  platform_owner : nat;
  pending_owner : option nat;
  pending_at : nat;
  escape_active : bool;
  escrow_active : bool
}.

Definition min_upgrade_delay : nat := 7.

Definition valid_owner (owner : nat) : bool := negb (Nat.eqb owner 0).
Definition registrar_is_current (state : GovernanceState) (caller : nat) : bool :=
  (0 <? registrar state) && Nat.eqb caller (registrar state).
Definition owner_is_current (state : GovernanceState) (caller : nat) (witness : bool) : bool :=
  witness && (0 <? platform_owner state) && Nat.eqb caller (platform_owner state).
Definition pending_is_empty (state : GovernanceState) : bool :=
  match pending_owner state with None => true | Some _ => false end.

Definition propose_owner_rotation
    (state : GovernanceState) (caller new_owner now : nat) : option GovernanceState :=
  if registrar_is_current state caller && valid_owner new_owner &&
     pending_is_empty state && negb (Nat.eqb new_owner (platform_owner state)) &&
     negb (escape_active state) && negb (escrow_active state)
  then Some (mkGovernanceState
    (registrar state) (platform_owner state) (Some new_owner) now
    (escape_active state) (escrow_active state))
  else None.

Definition confirm_guard
    (state : GovernanceState) (caller now pending : nat) (new_owner_witness : bool) : bool :=
  registrar_is_current state caller &&
  Nat.leb (pending_at state + min_upgrade_delay) now && new_owner_witness &&
  valid_owner pending && negb (Nat.eqb pending (platform_owner state)) &&
  negb (escape_active state) && negb (escrow_active state).

Definition confirm_owner_rotation
    (state : GovernanceState) (caller now : nat) (new_owner_witness : bool)
    : option GovernanceState :=
  match pending_owner state with
  | None => None
  | Some new_owner =>
      if confirm_guard state caller now new_owner new_owner_witness
      then Some (mkGovernanceState
        (registrar state) new_owner None 0
        (escape_active state) (escrow_active state))
      else None
  end.

Definition cancel_owner_rotation
    (state : GovernanceState) (caller : nat) (owner_witness : bool)
    : option GovernanceState :=
  if pending_is_empty state then None
  else if registrar_is_current state caller || owner_is_current state caller owner_witness
  then Some (mkGovernanceState
    (registrar state) (platform_owner state) None 0
    (escape_active state) (escrow_active state))
  else None.

Definition clear_pending_on_boundary (state : GovernanceState) : GovernanceState :=
  mkGovernanceState
    (registrar state) (platform_owner state) None 0
    (escape_active state) (escrow_active state).

Definition apply_proposal
    (state : GovernanceState) (caller new_owner now : nat) : GovernanceState :=
  match propose_owner_rotation state caller new_owner now with
  | Some next => next
  | None => state
  end.

Definition apply_confirmation
    (state : GovernanceState) (caller now : nat) (new_owner_witness : bool)
    : GovernanceState :=
  match confirm_owner_rotation state caller now new_owner_witness with
  | Some next => next
  | None => state
  end.

Definition apply_cancellation
    (state : GovernanceState) (caller : nat) (owner_witness : bool)
    : GovernanceState :=
  match cancel_owner_rotation state caller owner_witness with
  | Some next => next
  | None => state
  end.

Theorem OG_001_proposal_requires_current_registrar_and_valid_owner :
  forall state caller new_owner now next,
    propose_owner_rotation state caller new_owner now = Some next ->
    registrar_is_current state caller = true /\
    valid_owner new_owner = true.
Proof.
  intros state caller new_owner now next H.
  unfold propose_owner_rotation in H.
  destruct (registrar_is_current state caller && valid_owner new_owner &&
    pending_is_empty state && negb (Nat.eqb new_owner (platform_owner state)) &&
    negb (escape_active state) && negb (escrow_active state)) eqn:E;
    [| discriminate].
  repeat rewrite andb_true_iff in E.
  destruct E as [[[[[Hr Hv] _] _] _] _].
  injection H as Hnext.
  repeat split; assumption.
Qed.

Theorem OG_002_duplicate_pending_proposal_is_rejected :
  forall state caller new_owner now,
    pending_owner state <> None ->
    propose_owner_rotation state caller new_owner now = None.
Proof.
  intros state caller new_owner now Hpending.
  unfold propose_owner_rotation, pending_is_empty.
  destruct (pending_owner state) as [pending|]; [| contradiction].
  repeat rewrite andb_false_r.
  reflexivity.
Qed.

Theorem OG_003_confirm_requires_delay_and_new_owner_witness :
  forall state caller now witness next,
    confirm_owner_rotation state caller now witness = Some next ->
    pending_owner state <> None /\
    Nat.leb (pending_at state + min_upgrade_delay) now = true /\
    witness = true.
Proof.
  intros state caller now witness next.
  destruct (pending_owner state) as [pending|] eqn:Hp.
  - destruct (confirm_guard state caller now pending witness) eqn:E.
    + intro H.
      unfold confirm_guard in E.
      repeat rewrite andb_true_iff in E.
      destruct E as [E Hescrow].
      destruct E as [E Hescape].
      destruct E as [E Hneq].
      destruct E as [E Hvalid].
      destruct E as [E Hw].
      destruct E as [Hr Hdelay].
      assert (Hpn : Some pending <> None) by congruence.
      repeat split; [exact Hpn | exact Hdelay | exact Hw].
    + intro H.
      unfold confirm_owner_rotation in H.
      rewrite Hp in H.
      rewrite E in H.
      discriminate.
  - intro H.
    unfold confirm_owner_rotation in H.
    rewrite Hp in H.
    discriminate.
Qed.

Theorem OG_004_confirm_before_delay_preserves_state :
  forall state caller now witness,
    pending_owner state <> None ->
    Nat.leb (pending_at state + min_upgrade_delay) now = false ->
    confirm_owner_rotation state caller now witness = None.
Proof.
  intros state caller now witness Hp Hdelay.
  destruct (pending_owner state) as [pending|] eqn:HpState.
  - unfold confirm_owner_rotation, confirm_guard.
    rewrite HpState.
    rewrite Hdelay.
    repeat rewrite andb_false_r.
    simpl.
    reflexivity.
  - simpl in Hp. contradiction.
Qed.

Theorem OG_005_cancel_requires_registrar_or_current_owner :
  forall state caller witness next,
    cancel_owner_rotation state caller witness = Some next ->
    pending_owner state <> None /\
    (registrar_is_current state caller = true \/
     owner_is_current state caller witness = true).
Proof.
  intros state caller witness next.
  destruct (pending_owner state) as [pending|] eqn:Hp.
  - destruct (registrar_is_current state caller || owner_is_current state caller witness) eqn:Ha.
    + intro H.
      apply orb_true_iff in Ha.
      split; [assert (Hpn : Some pending <> None) by congruence; exact Hpn | exact Ha].
    + intro H.
      unfold cancel_owner_rotation, pending_is_empty in H.
      rewrite Hp in H.
      rewrite Ha in H.
      discriminate.
  - intro H.
    unfold cancel_owner_rotation, pending_is_empty in H.
    rewrite Hp in H.
    discriminate.
Qed.

Theorem OG_006_unauthorized_cancel_preserves_state :
  forall state caller witness,
    pending_owner state <> None ->
    registrar_is_current state caller = false ->
    owner_is_current state caller witness = false ->
    cancel_owner_rotation state caller witness = None.
Proof.
  intros state caller witness Hp Hr Ho.
  destruct (pending_owner state) as [pending|] eqn:HpState.
  - unfold cancel_owner_rotation, pending_is_empty.
    rewrite HpState.
    rewrite Hr, Ho.
    reflexivity.
  - simpl in Hp. contradiction.
Qed.

Theorem OG_007_boundary_clears_pending_rotation :
  forall state,
    pending_owner (clear_pending_on_boundary state) = None.
Proof. intros state. reflexivity. Qed.

Theorem OG_008_failed_proposal_preserves_state :
  forall state caller new_owner now,
    propose_owner_rotation state caller new_owner now = None ->
    apply_proposal state caller new_owner now = state.
Proof. intros state caller new_owner now H. unfold apply_proposal. rewrite H. reflexivity. Qed.

Theorem OG_009_failed_confirmation_preserves_state :
  forall state caller now witness,
    confirm_owner_rotation state caller now witness = None ->
    apply_confirmation state caller now witness = state.
Proof. intros state caller now witness H. unfold apply_confirmation. rewrite H. reflexivity. Qed.

Theorem OG_010_failed_cancellation_preserves_state :
  forall state caller witness,
    cancel_owner_rotation state caller witness = None ->
    apply_cancellation state caller witness = state.
Proof. intros state caller witness H. unfold apply_cancellation. rewrite H. reflexivity. Qed.

Theorem OG_011_successful_confirmation_clears_pending_and_sets_owner :
  forall state caller now witness next pending,
    pending_owner state = Some pending ->
    confirm_owner_rotation state caller now witness = Some next ->
    pending_owner next = None /\ platform_owner next = pending.
Proof.
  intros state caller now witness next pending Hp H.
  unfold confirm_owner_rotation in H.
  rewrite Hp in H.
  destruct (confirm_guard state caller now pending witness) eqn:E.
  - injection H as Hnext.
    subst next.
    simpl.
    split; reflexivity.
  - discriminate.
Qed.

Theorem OG_012_successful_proposal_records_pending_owner_and_time :
  forall state caller new_owner now next,
    propose_owner_rotation state caller new_owner now = Some next ->
    pending_owner next = Some new_owner /\ pending_at next = now.
Proof.
  intros state caller new_owner now next H.
  unfold propose_owner_rotation in H.
  destruct (registrar_is_current state caller && valid_owner new_owner &&
    pending_is_empty state && negb (Nat.eqb new_owner (platform_owner state)) &&
    negb (escape_active state) && negb (escrow_active state)) eqn:E;
    [| discriminate].
  injection H as Hnext.
  subst next.
  simpl.
  split; reflexivity.
Qed.

Theorem OG_013_successful_confirmation_requires_current_registrar :
  forall state caller now witness next pending,
    pending_owner state = Some pending ->
    confirm_owner_rotation state caller now witness = Some next ->
    registrar_is_current state caller = true.
Proof.
  intros state caller now witness next pending Hp H.
  unfold confirm_owner_rotation in H.
  rewrite Hp in H.
  destruct (confirm_guard state caller now pending witness) eqn:E.
  - unfold confirm_guard in E.
    repeat rewrite andb_true_iff in E.
    destruct E as [E _].
    destruct E as [E _].
    destruct E as [E _].
    destruct E as [E _].
    destruct E as [E _].
    destruct E as [Hr _].
    exact Hr.
  - discriminate.
Qed.

Theorem OG_014_successful_proposal_requires_no_escape_or_escrow :
  forall state caller new_owner now next,
    propose_owner_rotation state caller new_owner now = Some next ->
    negb (escape_active state) = true /\ negb (escrow_active state) = true.
Proof.
  intros state caller new_owner now next H.
  unfold propose_owner_rotation in H.
  destruct (registrar_is_current state caller && valid_owner new_owner &&
    pending_is_empty state && negb (Nat.eqb new_owner (platform_owner state)) &&
    negb (escape_active state) && negb (escrow_active state)) eqn:E;
    [| discriminate].
  repeat rewrite andb_true_iff in E.
  destruct E as [E Hescrow].
  destruct E as [E Hescape].
  split; assumption.
Qed.

Print Assumptions OG_001_proposal_requires_current_registrar_and_valid_owner.
Print Assumptions OG_002_duplicate_pending_proposal_is_rejected.
Print Assumptions OG_003_confirm_requires_delay_and_new_owner_witness.
Print Assumptions OG_004_confirm_before_delay_preserves_state.
Print Assumptions OG_005_cancel_requires_registrar_or_current_owner.
Print Assumptions OG_006_unauthorized_cancel_preserves_state.
Print Assumptions OG_007_boundary_clears_pending_rotation.
Print Assumptions OG_008_failed_proposal_preserves_state.
Print Assumptions OG_009_failed_confirmation_preserves_state.
Print Assumptions OG_010_failed_cancellation_preserves_state.
Print Assumptions OG_011_successful_confirmation_clears_pending_and_sets_owner.
Print Assumptions OG_012_successful_proposal_records_pending_owner_and_time.
Print Assumptions OG_013_successful_confirmation_requires_current_registrar.
Print Assumptions OG_014_successful_proposal_requires_no_escape_or_escrow.
