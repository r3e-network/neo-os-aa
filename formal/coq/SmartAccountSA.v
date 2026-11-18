(*
  NeoOS formal verification -- SmartAccount SA execution core.

  Source correspondence (read 2026-09-18):
    ../neo-os-sa/contracts/custom/SmartAccount.Execution.cs
    ../neo-os-sa/contracts/custom/SmartAccount.Models.cs
    ../neo-os-sa/contracts/custom/SmartAccount.Escape.cs

  This is a hand-written abstract model of the stable application-phase
  operation boundary. It models execution locking, verifier/native-owner
  authorization, escape-owner authorization, exact per-channel nonce
  consumption, deadline/policy/target rejection, and transactional rollback.
  Cryptographic correctness, Neo VM semantics, witness-rule parsing and C# to
  NEF refinement remain separate obligations and are not claimed here.

  The model returns None for a VM-faulting operation. The transactional wrapper
  execute_state keeps the pre-state on that failure, matching Neo transaction
  rollback only when the enclosing transaction faults. A caught call exception
  is NOT claimed to roll back the enclosing transaction. targetValid means
  the target returns normally, even if its returned value is false. postHookValid
  combines hook.postExecute and verifier.postExecute normal completion. The
  effects field is a ghost completed-operation count, NOT token balances or
  evidence that a business action succeeded. deadlineValid is a predicate,
  not a proof about time sources. Account existence and no market escrow are
  preconditions of this projection. A missing hook or verifier has no callback
  to reject the operation; installed callbacks must return normally. Callbacks
  must preserve the modelled core configuration/nonces; callback noninterference
  is an unproved obligation.
*)
From Coq Require Import PeanoNat Bool Lia.

Record SAState : Type := mkSAState {
  cursor : nat -> nat;
  executing : bool;
  verifierConfigured : bool;
  escapeActive : bool;
  hookInstalled : bool;
  effects : nat
}.

Record UserOp : Type := mkUserOp {
  opChannel : nat;
  opSequence : nat;
  operationShapeValid : bool;
  signatureValid : bool;
  ownerWitness : bool;
  deadlineValid : bool;
  preHookValid : bool;
  targetValid : bool;
  postHookValid : bool
}.

Definition authorized (s : SAState) (op : UserOp) : bool :=
  let base := if verifierConfigured s then signatureValid op else ownerWitness op in
  if escapeActive s then base && ownerWitness op else base.

Definition pre_callback_valid (s : SAState) (op : UserOp) : bool :=
  if hookInstalled s then preHookValid op else true.

Definition post_callback_valid (s : SAState) (op : UserOp) : bool :=
  if hookInstalled s || verifierConfigured s then postHookValid op else true.

Definition admissible (s : SAState) (op : UserOp) : bool :=
  negb (executing s) &&
  authorized s op &&
  Nat.eqb (opSequence op) (cursor s (opChannel op)) &&
  operationShapeValid op &&
  deadlineValid op && pre_callback_valid s op && targetValid op &&
  post_callback_valid s op.

Definition set_cursor (m : nat -> nat) (c n : nat) : nat -> nat :=
  fun k => if Nat.eqb k c then n else m k.

Definition committed (s : SAState) (op : UserOp) : SAState :=
  mkSAState
    (set_cursor (cursor s) (opChannel op) (S (cursor s (opChannel op))))
    false
    (verifierConfigured s)
    (if escapeActive s then false else escapeActive s)
    (hookInstalled s)
    (S (effects s)).

Definition execute (s : SAState) (op : UserOp) : option SAState :=
  if admissible s op then Some (committed s op) else None.

Definition execute_state (s : SAState) (op : UserOp) : SAState :=
  match execute s op with
  | Some next => next
  | None => s
  end.

Lemma and_chain_components :
  forall a b c d e f g h : bool,
    a && b && c && d && e && f && g && h = true ->
    a = true /\ b = true /\ c = true /\ d = true /\
    e = true /\ f = true /\ g = true /\ h = true.
Proof.
  intros a b c d e f g h H.
  repeat rewrite andb_true_iff in H.
  destruct H as [[[[[[[Hab Hc] Hd] He] Hf] Hg] Hh]].
  repeat split; assumption.
Qed.

Lemma set_cursor_self :
  forall m c n,
    set_cursor m c n c = n.
Proof.
  intros m c n.
  unfold set_cursor.
  rewrite Nat.eqb_refl.
  reflexivity.
Qed.

Lemma set_cursor_other :
  forall m c n k,
    k <> c ->
    set_cursor m c n k = m k.
Proof.
  intros m c n k Hneq.
  unfold set_cursor.
  apply Nat.eqb_neq in Hneq.
  rewrite Hneq.
  reflexivity.
Qed.

Lemma admissible_components :
  forall s op,
    admissible s op = true ->
    negb (executing s) = true /\
    authorized s op = true /\
    Nat.eqb (opSequence op) (cursor s (opChannel op)) = true /\
    operationShapeValid op = true /\
    deadlineValid op = true /\
    pre_callback_valid s op = true /\
    targetValid op = true /\
    post_callback_valid s op = true.
Proof.
  intros s op H.
  unfold admissible in H.
  apply and_chain_components in H.
  exact H.
Qed.

Theorem SA_001_success_requires_authorization :
  forall s op next,
    execute s op = Some next -> authorized s op = true.
Proof.
  intros s op next H.
  unfold execute in H.
  destruct (admissible s op) eqn:Ha; [| discriminate].
  apply admissible_components in Ha.
  exact (proj1 (proj2 Ha)).
Qed.

Theorem SA_002_success_requires_current_nonce :
  forall s op next,
    execute s op = Some next ->
    opSequence op = cursor s (opChannel op).
Proof.
  intros s op next H.
  unfold execute in H.
  destruct (admissible s op) eqn:Ha; [| discriminate].
  apply admissible_components in Ha.
  apply Nat.eqb_eq.
  exact (proj1 (proj2 (proj2 Ha))).
Qed.

Theorem SA_003_success_consumes_exactly_one_nonce :
  forall s op next,
    execute s op = Some next ->
    cursor next (opChannel op) = S (cursor s (opChannel op)).
Proof.
  intros s op next H.
  unfold execute in H.
  destruct (admissible s op) eqn:Ha; [| discriminate].
  injection H as Hnext.
  assert (Hcursor :
    cursor (committed s op) (opChannel op) = S (cursor s (opChannel op))).
  { unfold committed.
    simpl.
    apply set_cursor_self.
  }
  rewrite <- Hnext.
  exact Hcursor.
Qed.

Theorem SA_004_parallel_channels_are_independent :
  forall s op next other,
    execute s op = Some next ->
    other <> opChannel op ->
    cursor next other = cursor s other.
Proof.
  intros s op next other H Hneq.
  unfold execute in H.
  destruct (admissible s op) eqn:Ha; [| discriminate].
  injection H as Hnext.
  assert (Hcursor :
    cursor (committed s op) other = cursor s other).
  { unfold committed.
    simpl.
    apply set_cursor_other.
    exact Hneq.
  }
  rewrite <- Hnext.
  exact Hcursor.
Qed.

Theorem SA_005_replay_or_out_of_order_is_rejected :
  forall s op,
    opSequence op <> cursor s (opChannel op) ->
    execute s op = None.
Proof.
  intros s op Hneq.
  unfold execute, admissible.
  destruct (negb (executing s) && authorized s op &&
            Nat.eqb (opSequence op) (cursor s (opChannel op)) &&
            operationShapeValid op && deadlineValid op &&
            pre_callback_valid s op && targetValid op &&
            post_callback_valid s op) eqn:Ha.
  - apply and_chain_components in Ha.
    assert (Hcursor : Nat.eqb (opSequence op) (cursor s (opChannel op)) = true).
    { exact (proj1 (proj2 (proj2 Ha))). }
    apply Nat.eqb_eq in Hcursor.
    contradiction.
  - reflexivity.
Qed.

Theorem SA_006_failed_execution_is_atomic :
  forall s op,
    execute s op = None -> execute_state s op = s.
Proof.
  intros s op H.
  unfold execute_state.
  rewrite H.
  reflexivity.
Qed.

Theorem SA_007_reentrancy_is_rejected :
  forall s op,
    executing s = true -> execute s op = None.
Proof.
  intros s op Hexec.
  unfold execute, admissible.
  rewrite Hexec.
  reflexivity.
Qed.

Theorem SA_008_active_escape_requires_backup_owner :
  forall s op next,
    escapeActive s = true ->
    execute s op = Some next ->
    ownerWitness op = true.
Proof.
  intros s op next Hescape Hsuccess.
  apply SA_001_success_requires_authorization in Hsuccess.
  unfold authorized in Hsuccess.
  rewrite Hescape in Hsuccess.
  apply andb_true_iff in Hsuccess.
  exact (proj2 Hsuccess).
Qed.

Theorem SA_009_success_advances_effects_once :
  forall s op next,
    execute s op = Some next -> effects next = S (effects s).
Proof.
  intros s op next H.
  unfold execute in H.
  destruct (admissible s op) eqn:Ha; [| discriminate].
  injection H as Hnext.
  unfold committed in Hnext.
  rewrite <- Hnext.
  reflexivity.
Qed.

Theorem SA_010_failed_execution_does_not_advance_effects :
  forall s op,
    execute s op = None -> effects (execute_state s op) = effects s.
Proof.
  intros s op H.
  unfold execute_state.
  rewrite H.
  reflexivity.
Qed.

Theorem SA_011_success_clears_active_escape :
  forall s op next,
    escapeActive s = true ->
    execute s op = Some next ->
    escapeActive next = false.
Proof.
  intros s op next Hescape Hsuccess.
  unfold execute in Hsuccess.
  destruct (admissible s op) eqn:Ha; [| discriminate].
  injection Hsuccess as Hnext.
  assert (Hactive : escapeActive (committed s op) = false).
  { unfold committed.
    rewrite Hescape.
    reflexivity.
  }
  rewrite <- Hnext.
  exact Hactive.
Qed.

Theorem SA_012_failed_execution_preserves_nonce :
  forall s op,
    execute s op = None ->
    cursor (execute_state s op) (opChannel op) = cursor s (opChannel op).
Proof.
  intros s op H.
  unfold execute_state.
  rewrite H.
  reflexivity.
Qed.

Theorem SA_013_admissible_operation_is_accepted :
  forall s op,
    admissible s op = true -> execute s op = Some (committed s op).
Proof.
  intros s op H. unfold execute. rewrite H. reflexivity.
Qed.

Theorem SA_014_success_prevents_immediate_replay :
  forall s op next,
    execute s op = Some next -> execute next op = None.
Proof.
  intros s op next H.
  pose proof (SA_002_success_requires_current_nonce s op next H) as Hseq.
  pose proof (SA_003_success_consumes_exactly_one_nonce s op next H) as Hnext.
  apply SA_005_replay_or_out_of_order_is_rejected.
  rewrite Hseq, Hnext. lia.
Qed.

Theorem SA_015_success_releases_lock :
  forall s op next,
    execute s op = Some next -> executing next = false.
Proof.
  intros s op next H. unfold execute in H.
  destruct (admissible s op); [| discriminate].
  inversion H; subst. reflexivity.
Qed.

Theorem SA_019_success_requires_operation_shape :
  forall s op next,
    execute s op = Some next -> operationShapeValid op = true.
Proof.
  intros s op next H.
  unfold execute in H.
  destruct (admissible s op) eqn:Ha; [| discriminate].
  apply admissible_components in Ha.
  exact (proj1 (proj2 (proj2 (proj2 Ha)))).
Qed.

Theorem SA_020_disabled_callbacks_do_not_gate_execution :
  forall s op,
    hookInstalled s = false ->
    verifierConfigured s = false ->
    pre_callback_valid s op = true /\ post_callback_valid s op = true.
Proof.
  intros s op Hhook Hverifier.
  unfold pre_callback_valid, post_callback_valid.
  rewrite Hhook, Hverifier.
  simpl.
  repeat split; reflexivity.
Qed.

Theorem SA_016_native_valid_operation_is_reachable :
  let s := mkSAState (fun _ => 0) false false false false 0 in
  let op := mkUserOp 0 0 true false true true true true true in
  execute s op = Some (committed s op).
Proof. reflexivity. Qed.

Theorem SA_017_verifier_valid_operation_is_reachable :
  let s := mkSAState (fun _ => 0) false true false false 0 in
  let op := mkUserOp 0 0 true true false true true true true in
  execute s op = Some (committed s op).
Proof. reflexivity. Qed.

Theorem SA_018_escape_owner_valid_operation_is_reachable :
  let s := mkSAState (fun _ => 0) false true true false 0 in
  let op := mkUserOp 0 0 true true true true true true true in
  execute s op = Some (committed s op).
Proof. reflexivity. Qed.

Print Assumptions SA_001_success_requires_authorization.
Print Assumptions SA_002_success_requires_current_nonce.
Print Assumptions SA_003_success_consumes_exactly_one_nonce.
Print Assumptions SA_004_parallel_channels_are_independent.
Print Assumptions SA_005_replay_or_out_of_order_is_rejected.
Print Assumptions SA_006_failed_execution_is_atomic.
Print Assumptions SA_007_reentrancy_is_rejected.
Print Assumptions SA_008_active_escape_requires_backup_owner.
Print Assumptions SA_009_success_advances_effects_once.
Print Assumptions SA_010_failed_execution_does_not_advance_effects.
Print Assumptions SA_011_success_clears_active_escape.
Print Assumptions SA_012_failed_execution_preserves_nonce.
Print Assumptions and_chain_components.
Print Assumptions admissible_components.
Print Assumptions set_cursor_self.
Print Assumptions set_cursor_other.

Print Assumptions SA_013_admissible_operation_is_accepted.
Print Assumptions SA_014_success_prevents_immediate_replay.
Print Assumptions SA_015_success_releases_lock.
Print Assumptions SA_016_native_valid_operation_is_reachable.
Print Assumptions SA_017_verifier_valid_operation_is_reachable.
Print Assumptions SA_018_escape_owner_valid_operation_is_reachable.
Print Assumptions SA_019_success_requires_operation_shape.
Print Assumptions SA_020_disabled_callbacks_do_not_gate_execution.
