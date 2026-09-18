(* Independent threshold-policy model, manually related to MultiSigVerifier.cs.
   IDs abstract nonzero contract hashes; approve abstracts normal true returns.
   A null signature, false return or catchable child failure maps to false.
   Distinct contract IDs do NOT imply distinct owners/keys/trust domains.
   Crypto, serialization, gas exhaustion and post-target callback stability
   are NOT modelled. Validation and post-execution may have different approve
   functions: no stability assumption is silently made between these phases. *)
From Stdlib Require Import List Bool PeanoNat Lia.
Import ListNotations.

(* Computable duplicate check. The decidable NoDup_dec would be the obvious
   choice, but its proof term does not reduce under vm_compute, so the concrete
   Examples at the bottom of this file could never close on it. *)
Fixpoint unique (ids : list nat) : bool :=
  match ids with
  | [] => true
  | id :: rest => negb (existsb (Nat.eqb id) rest) && unique rest
  end.

Definition config_valid (ids : list nat) (threshold : nat) : bool :=
  (0 <? length ids) && (length ids <=? 10) &&
  (0 <? threshold) && (threshold <=? length ids) &&
  forallb (fun id => negb (Nat.eqb id 0)) ids && unique ids.

Fixpoint tally (approve : nat -> bool) (ids : list nat) : nat :=
  match ids with
  | [] => 0
  | id :: rest => (if approve id then 1 else 0) + tally approve rest
  end.

Definition accepts (ids : list nat) (threshold signature_count : nat)
    (approve : nat -> bool) : bool :=
  config_valid ids threshold && Nat.eqb signature_count (length ids) &&
  (threshold <=? tally approve ids).

Lemma unique_sound : forall ids, unique ids = true -> NoDup ids.
Proof.
  induction ids as [|id rest IH]; simpl; intros H.
  - constructor.
  - apply andb_true_iff in H. destruct H as [Hnotin Hrest].
    constructor.
    + intros Hin. apply negb_true_iff in Hnotin.
      assert (existsb (Nat.eqb id) rest = true) as Hex.
      { apply existsb_exists. exists id. split; [assumption | apply Nat.eqb_refl]. }
      rewrite Hex in Hnotin. discriminate.
    + apply IH. assumption.
Qed.

Lemma tally_is_filter_length : forall approve ids,
  tally approve ids = length (filter approve ids).
Proof.
  intros approve ids. induction ids as [|id rest IH]; simpl; auto.
  destruct (approve id); simpl; rewrite IH; reflexivity.
Qed.

Theorem config_sound : forall ids threshold,
  config_valid ids threshold = true ->
  0 < length ids /\ length ids <= 10 /\
  0 < threshold /\ threshold <= length ids /\
  Forall (fun id => id <> 0) ids /\ NoDup ids.
Proof.
  intros ids threshold H. unfold config_valid in H.
  repeat rewrite andb_true_iff in H.
  destruct H as [[[[[Hlen Hmax] Hpos] Hupper] Hnonzero] Huniq].
  apply Nat.ltb_lt in Hlen. apply Nat.leb_le in Hmax.
  apply Nat.ltb_lt in Hpos. apply Nat.leb_le in Hupper.
  apply unique_sound in Huniq.
  repeat split; try assumption.
  apply Forall_forall. intros id Hin.
  rewrite forallb_forall in Hnonzero. specialize (Hnonzero id Hin).
  apply negb_true_iff in Hnonzero. apply Nat.eqb_neq in Hnonzero. assumption.
Qed.

Theorem accepted_has_distinct_threshold_support : forall ids threshold count approve,
  accepts ids threshold count approve = true ->
  NoDup (filter approve ids) /\ threshold <= length (filter approve ids) /\
  0 < threshold /\ count = length ids.
Proof.
  intros ids threshold count approve H. unfold accepts in H.
  repeat rewrite andb_true_iff in H. destruct H as [[Hconfig Hcount] Hvotes].
  apply config_sound in Hconfig.
  destruct Hconfig as [Hlen [Hmax [Hpos [Hupper [Hzero Hunique]]]]].
  apply Nat.eqb_eq in Hcount. apply Nat.leb_le in Hvotes.
  rewrite tally_is_filter_length in Hvotes.
  repeat split; try assumption. apply NoDup_filter. assumption.
Qed.

Theorem supporters_are_approved_members :
  forall (ids : list nat) (approve : nat -> bool) (id : nat),
  In id (filter approve ids) <-> In id ids /\ approve id = true.
Proof. intros. apply filter_In. Qed.

Theorem accepted_has_support : forall ids threshold count approve,
  accepts ids threshold count approve = true ->
  exists id, In id ids /\ approve id = true.
Proof.
  intros ids threshold count approve H.
  apply accepted_has_distinct_threshold_support in H.
  destruct H as [_ [Hcount [Hpos _]]].
  destruct (filter approve ids) as [|id rest] eqn:E; simpl in Hcount; try lia.
  exists id. apply filter_In. rewrite E. simpl. auto.
Qed.

Theorem acceptance_complete : forall ids threshold count approve,
  config_valid ids threshold = true -> count = length ids ->
  threshold <= length (filter approve ids) ->
  accepts ids threshold count approve = true.
Proof.
  intros ids threshold count approve Hconfig Hcount Hvotes.
  unfold accepts. rewrite Hconfig, Hcount, Nat.eqb_refl. simpl.
  apply Nat.leb_le. rewrite tally_is_filter_length. assumption.
Qed.

Example valid_two_of_two : accepts [1; 2] 2 2 (fun _ => true) = true.
Proof. vm_compute. reflexivity. Qed.

Example duplicate_rejected : config_valid [1; 1] 2 = false.
Proof. vm_compute. reflexivity. Qed.

Example no_approval_rejected : accepts [1; 2] 1 2 (fun _ => false) = false.
Proof. vm_compute. reflexivity. Qed.

Print Assumptions unique_sound.
Print Assumptions tally_is_filter_length.
Print Assumptions config_sound.
Print Assumptions accepted_has_distinct_threshold_support.
Print Assumptions supporters_are_approved_members.
Print Assumptions accepted_has_support.
Print Assumptions acceptance_complete.
Print Assumptions valid_two_of_two.
Print Assumptions duplicate_rejected.
Print Assumptions no_approval_rejected.
