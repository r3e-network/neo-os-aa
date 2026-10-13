(* A universal source-expression theorem for the arithmetic region only.
   This is not yet the artifact certificate: ArithmeticVm.v connects these
   checked operations to actual decoded instructions. *)
From Coq Require Import ZArith Bool Lia List.
Require Import IntegerSemantics.
Import ListNotations.
Open Scope Z_scope.

Definition cap_domain (cost requested reserved : Z) : Prop :=
  0 <= cost < integer_limit /\
  0 < requested < integer_limit /\
  0 <= reserved < integer_limit.
Definition source_charge (cost requested reserved : Z) : Z :=
  if Z.eqb cost 0 then requested
  else Z.min requested (Z.max (cost - reserved) 0).
Definition option_bind {A B : Type} (x : option A) (f : A -> option B) : option B :=
  match x with Some value => f value | None => None end.
Definition checked_cap (cost requested reserved : Z) : option Z :=
  option_bind (checked_binary Min cost 1) (fun minimum =>
  option_bind (checked_binary Sub 1 minimum) (fun flag =>
  option_bind (checked_binary Sub cost reserved) (fun difference =>
  option_bind (checked_binary Max difference 0) (fun remaining =>
  option_bind (checked_binary Mul flag requested) (fun quote =>
  option_bind (checked_binary Add remaining quote) (fun cap =>
  checked_binary Min requested cap)))))).

Lemma nonnegative_integer_fits : forall z,
  0 <= z < integer_limit -> integer_fits z.
Proof. intros z H. unfold integer_fits. pose proof integer_limit_positive. lia. Qed.
Lemma cost_minimum : forall cost, 0 <= cost ->
  Z.min cost 1 = if Z.eqb cost 0 then 0 else 1.
Proof. intros cost H. destruct (Z.eqb cost 0) eqn:E.
  - apply Z.eqb_eq in E. subst. reflexivity.
  - apply Z.eqb_neq in E. apply Z.min_r. lia. Qed.
Lemma difference_fits : forall cost reserved,
  0 <= cost < integer_limit -> 0 <= reserved < integer_limit ->
  integer_fits (cost - reserved).
Proof. intros. unfold integer_fits. lia. Qed.
Lemma remaining_range : forall cost reserved,
  0 <= cost -> 0 <= reserved -> 0 <= Z.max (cost - reserved) 0 <= cost.
Proof. intros cost reserved Hc Hr. split.
  - apply Z.le_max_r.
  - apply Z.max_lub; lia. Qed.

Lemma cap_intermediates_representable : forall cost requested reserved,
  cap_domain cost requested reserved ->
  integer_fits (Z.min cost 1) /\
  integer_fits (1 - Z.min cost 1) /\
  integer_fits (cost - reserved) /\
  integer_fits (Z.max (cost - reserved) 0) /\
  integer_fits ((1 - Z.min cost 1) * requested) /\
  integer_fits (Z.max (cost - reserved) 0 + (1 - Z.min cost 1) * requested) /\
  integer_fits (Z.min requested (Z.max (cost - reserved) 0 + (1 - Z.min cost 1) * requested)).
Proof.
  intros cost requested reserved [Hc [Hq Hr]].
  pose proof integer_limit_positive as HL.
  pose proof (difference_fits cost reserved Hc Hr) as Hd.
  pose proof (remaining_range cost reserved ltac:(lia) ltac:(lia)) as Hrem.
  rewrite cost_minimum by lia.
  destruct (Z.eqb cost 0) eqn:E.
  - apply Z.eqb_eq in E. subst cost. replace (1 - 0) with 1 by ring.
    replace (1 * requested) with requested by ring.
    rewrite Z.max_r by lia. rewrite Z.add_0_l, Z.min_id.
    repeat split; unfold integer_fits in *; lia.
  - apply Z.eqb_neq in E. replace (1 - 1) with 0 by ring.
    rewrite Z.mul_0_l, Z.add_0_r.
    assert (Hmin : 0 <= Z.min requested (Z.max (cost - reserved) 0) < integer_limit).
    { split; [apply Z.min_glb; lia|eapply Z.le_lt_trans; [apply Z.le_min_l|lia]]. }
    repeat split; unfold integer_fits in *; lia.
Qed.

Theorem cap_all_inputs_preserved : forall cost requested reserved,
  cap_domain cost requested reserved ->
  checked_cap cost requested reserved = Some (source_charge cost requested reserved).
Proof.
  intros cost requested reserved [Hc [Hq Hr]].
  pose proof integer_limit_positive as HL.
  pose proof (difference_fits cost reserved Hc Hr) as Hd.
  pose proof (remaining_range cost reserved ltac:(lia) ltac:(lia)) as Hrem.
  unfold checked_cap, checked_binary.
  rewrite (checked_integer_in_range (binary_value Min cost 1)).
  2: { simpl. rewrite cost_minimum by lia.
       destruct (Z.eqb cost 0); apply nonnegative_integer_fits; lia. }
  cbn [option_bind binary_value].
  rewrite cost_minimum by lia.
  destruct (Z.eqb cost 0) eqn:Ec.
  - apply Z.eqb_eq in Ec. subst cost.
    replace (1 - 0) with 1 by ring.
    rewrite (checked_integer_in_range 1) by (apply nonnegative_integer_fits; lia).
    cbn [option_bind].
    rewrite (checked_integer_in_range (0 - reserved)) by exact Hd.
    cbn [option_bind].
    rewrite Z.max_r by lia.
    rewrite (checked_integer_in_range 0) by (apply nonnegative_integer_fits; lia).
    cbn [option_bind].
    rewrite (checked_integer_in_range (1 * requested)) by (apply nonnegative_integer_fits; lia).
    cbn [option_bind].
    rewrite (checked_integer_in_range (0 + 1 * requested)) by (apply nonnegative_integer_fits; lia).
    cbn [option_bind].
    replace (0 + 1 * requested) with requested by ring.
    rewrite Z.min_id.
    rewrite checked_integer_in_range by (apply nonnegative_integer_fits; lia).
    unfold source_charge. rewrite Z.eqb_refl. reflexivity.
  - apply Z.eqb_neq in Ec.
    replace (1 - 1) with 0 by ring.
    rewrite (checked_integer_in_range 0) by (apply nonnegative_integer_fits; lia).
    cbn [option_bind].
    rewrite (checked_integer_in_range (cost - reserved)) by exact Hd.
    cbn [option_bind].
    rewrite (checked_integer_in_range (Z.max (cost - reserved) 0)) by
      (apply nonnegative_integer_fits; lia).
    cbn [option_bind].
    rewrite (checked_integer_in_range (0 * requested)) by (apply nonnegative_integer_fits; lia).
    cbn [option_bind].
    rewrite Z.add_0_r.
    rewrite (checked_integer_in_range (Z.max (cost - reserved) 0)) by
      (apply nonnegative_integer_fits; lia).
    cbn [option_bind].
    rewrite checked_integer_in_range.
    2: { apply nonnegative_integer_fits. split.
         - apply Z.min_glb; lia.
         - eapply Z.le_lt_trans; [apply Z.le_min_l|lia]. }
    unfold source_charge. destruct (Z.eqb cost 0) eqn:E;
      [apply Z.eqb_eq in E; contradiction|reflexivity].
Qed.

Theorem paid_charge_bounded : forall cost requested reserved,
  cap_domain cost requested reserved -> cost > 0 ->
  0 <= source_charge cost requested reserved <= requested /\
  source_charge cost requested reserved <= Z.max (cost - reserved) 0.
Proof. intros cost requested reserved [Hc [Hq Hr]] Hp.
  unfold source_charge. assert (Z.eqb cost 0 = false) as E by (apply Z.eqb_neq; lia).
  rewrite E. split.
  - split; [apply Z.min_glb; [lia|apply Z.le_max_r]|apply Z.le_min_l].
  - apply Z.le_min_r. Qed.

Print Assumptions nonnegative_integer_fits.
Print Assumptions cost_minimum.
Print Assumptions difference_fits.
Print Assumptions remaining_range.
Print Assumptions cap_intermediates_representable.
Print Assumptions cap_all_inputs_preserved.
Print Assumptions paid_charge_bounded.
