From Coq Require Import Arith.PeanoNat Bool.Bool Lia.

(* One installed instance and subscription id. Times are nonnegative Unix seconds.
   Only the temporal guard is modelled: witness, token transfer, storage and VM
   execution have separate obligations. The optional receipt is (time, duration). *)
Definition due (now duration : nat) (receipt : option (nat * nat)) : bool :=
  (0 <? now / duration) &&
    match receipt with
    | None => true
    | Some (booked, previous) =>
        (booked / duration <? now / duration) &&
        ((previous =? duration) || (booked / previous <? now / previous))
    end.

Definition following_boundary (booked duration : nat) :=
  duration * S (booked / duration).

Lemma crossed_period_iff : forall now booked duration, 0 < duration ->
  (booked / duration < now / duration <->
   following_boundary booked duration <= now).
Proof.
  intros now booked d Hd. unfold following_boundary. split.
  - intro H. eapply Nat.le_trans; [apply Nat.mul_le_mono_l; exact H|].
    apply Nat.mul_div_le. lia.
  - intro H. apply Nat.div_le_lower_bound; lia.
Qed.

Theorem first_charge_iff : forall now d, 0 < d ->
  (due now d None = true <-> d <= now).
Proof.
  intros now d Hd. unfold due. rewrite Bool.andb_true_r, Nat.ltb_lt.
  pose proof (crossed_period_iff now 0 d Hd) as H.
  unfold following_boundary in H. rewrite Nat.div_0_l in H by lia.
  now rewrite Nat.mul_1_r in H.
Qed.

Theorem rescheduled_charge_iff : forall now booked d p, 0 < d -> 0 < p ->
  (due now d (Some (booked,p)) = true <->
   Nat.max (following_boundary booked p) (following_boundary booked d) <= now).
Proof.
  intros now booked d p Hd Hp. unfold due.
  rewrite !Bool.andb_true_iff, Bool.orb_true_iff, Nat.eqb_eq, !Nat.ltb_lt, Nat.max_lub_iff.
  rewrite <- (crossed_period_iff now booked p Hp), <- (crossed_period_iff now booked d Hd).
  split.
  - intros [_ [H [->|Hprev]]]; auto.
  - intros [Hprev Hcur]. split; [lia|auto].
Qed.

Print Assumptions crossed_period_iff.
Print Assumptions first_charge_iff.
Print Assumptions rescheduled_charge_iff.
