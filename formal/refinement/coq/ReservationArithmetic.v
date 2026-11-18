(* Fault-aware reservation arithmetic, not a bytecode/heap/storage certificate.
   The suffix's guard and Integer addition are executable here. Protocol ledger
   functions are imported from the existing model. Array identity, SETITEM,
   serialization, storage and transaction rollback require separate semantics. *)
From Coq Require Import ZArith Bool List Lia.
Require Import IntegerSemantics CapArithmetic CustomSponsorship.
Import ListNotations.
Open Scope Z_scope.

Definition checked_update (reserved settled : Z) : option Z :=
  if 0 <? settled then checked_binary Add reserved settled else None.
Definition checked_reservation (cost requested reserved : Z) : option Z :=
  checked_update reserved (CustomSponsorship.charge cost requested reserved).

(* A representability-aware lifting of the existing abstract protocol reserve.
   This projection is not a replacement for the actual helper's effect proof. *)
Definition bounded_reserve (tx : nat) (cost requested : Z) (before : Ledger) : option Ledger :=
  match CustomSponsorship.reserve tx cost requested before with
  | None => None
  | Some next => match checked_integer (ledger_spent next) with
      | None => None
      | Some bounded => Some (mkLedger tx bounded)
      end
  end.
Definition apply_bounded_reserve (tx : nat) (cost requested : Z) (before : Ledger) : Ledger :=
  match bounded_reserve tx cost requested before with Some next => next | None => before end.
Fixpoint bounded_reserve_many (tx : nat) (cost : Z) (requests : list Z) (before : Ledger) : option Ledger :=
  match requests with
  | [] => Some before
  | requested :: rest => match bounded_reserve tx cost requested before with
      | None => None
      | Some reserved => bounded_reserve_many tx cost rest reserved
      end
  end.

Lemma checked_integer_none_iff : forall z,
  checked_integer z = None <-> ~ integer_fits z.
Proof. intros z. unfold checked_integer. destruct (integer_fitsb z) eqn:E.
  - apply integer_fitsb_spec in E. split; [discriminate|contradiction].
  - split; [|reflexivity]. intros _ H. apply integer_fitsb_spec in H. congruence. Qed.

Theorem checked_update_success_iff : forall reserved settled next,
  checked_update reserved settled = Some next <->
  0 < settled /\ next = reserved + settled /\ integer_fits (reserved + settled).
Proof. intros reserved settled next. unfold checked_update.
  destruct (0 <? settled) eqn:E.
  - apply Z.ltb_lt in E. unfold checked_binary, binary_value. split.
    + intro H. apply checked_integer_result_is_representable in H.
      destruct H as [Hn Hfit]. subst next. auto.
    + intros [_ [Hn Hfit]]. subst next. apply checked_integer_in_range. exact Hfit.
  - apply Z.ltb_ge in E. split; [discriminate|]. intros [H _]. lia. Qed.

Theorem checked_update_nonpositive_fault : forall reserved settled,
  settled <= 0 -> checked_update reserved settled = None.
Proof. intros reserved settled H. unfold checked_update.
  assert ((0 <? settled) = false) as E by (apply Z.ltb_ge; lia). rewrite E. reflexivity. Qed.

Theorem checked_update_overflow_fault : forall reserved settled,
  0 < settled -> ~ integer_fits (reserved + settled) ->
  checked_update reserved settled = None.
Proof. intros reserved settled Hp Ho. unfold checked_update.
  assert ((0 <? settled) = true) as E by (apply Z.ltb_lt; lia). rewrite E.
  unfold checked_binary, binary_value. apply integer_overflow_faults. exact Ho. Qed.

Theorem checked_update_fault_iff : forall reserved settled,
  checked_update reserved settled = None <->
  settled <= 0 \/ ~ integer_fits (reserved + settled).
Proof. intros reserved settled. unfold checked_update.
  destruct (0 <? settled) eqn:E.
  - apply Z.ltb_lt in E. unfold checked_binary, binary_value.
    rewrite checked_integer_none_iff. split; [auto|]. intros [H|H]; [lia|exact H].
  - apply Z.ltb_ge in E. split; [auto|reflexivity]. Qed.

Lemma paid_charge_formula : forall cost requested reserved,
  cost > 0 -> 0 <= reserved <= cost ->
  CustomSponsorship.charge cost requested reserved = Z.min requested (cost - reserved).
Proof. intros cost requested reserved Hc Hr. unfold CustomSponsorship.charge.
  assert ((cost =? 0) = false) as E by (apply Z.eqb_neq; lia).
  rewrite E, Z.max_l by lia. reflexivity. Qed.

Lemma paid_charge_positive_iff : forall cost requested reserved,
  cost > 0 -> requested > 0 -> 0 <= reserved <= cost ->
  0 < CustomSponsorship.charge cost requested reserved <-> reserved < cost.
Proof. intros cost requested reserved Hc Hq Hr.
  rewrite paid_charge_formula by assumption. split.
  - intro H. pose proof (Z.le_min_r requested (cost - reserved)). lia.
  - intro H. apply Z.min_glb_lt; lia. Qed.

Lemma paid_updated_reservation_range : forall cost requested reserved,
  cost > 0 -> requested > 0 -> 0 <= reserved <= cost ->
  reserved <= reserved + CustomSponsorship.charge cost requested reserved <= cost.
Proof. intros cost requested reserved Hc Hq Hr.
  pose proof (OS_003_persisted_charge_is_within_remaining_fee cost requested reserved Hc Hr) as Hcap.
  rewrite paid_charge_formula by assumption. split.
  - assert (0 <= Z.min requested (cost - reserved)) by (apply Z.min_glb; lia). lia.
  - rewrite paid_charge_formula in Hcap by assumption. lia. Qed.

Theorem paid_reservation_success_iff_remaining : forall cost requested reserved,
  0 < cost < integer_limit -> 0 < requested < integer_limit -> 0 <= reserved <= cost ->
  ((exists next, checked_reservation cost requested reserved = Some next) <-> reserved < cost).
Proof. intros cost requested reserved Hc Hq Hr. unfold checked_reservation. split.
  - intros [next H]. apply checked_update_success_iff in H.
    destruct H as [Hpositive _]. apply (paid_charge_positive_iff cost requested reserved); lia.
  - intro Hremaining.
    exists (reserved + CustomSponsorship.charge cost requested reserved).
    apply checked_update_success_iff. split.
    + apply (paid_charge_positive_iff cost requested reserved); lia.
    + split; [reflexivity|].
      pose proof (paid_updated_reservation_range cost requested reserved ltac:(lia) ltac:(lia) Hr) as Hrange.
      apply nonnegative_integer_fits. lia.
Qed.

Theorem paid_reservation_result_bound : forall cost requested reserved next,
  0 < cost < integer_limit -> 0 < requested < integer_limit -> 0 <= reserved <= cost ->
  checked_reservation cost requested reserved = Some next ->
  reserved < next <= cost /\ integer_fits next.
Proof. intros cost requested reserved next Hc Hq Hr H.
  unfold checked_reservation in H. apply checked_update_success_iff in H.
  destruct H as [Hp [Hnext Hfit]]. subst next. split; [|exact Hfit].
  pose proof (paid_updated_reservation_range cost requested reserved ltac:(lia) ltac:(lia) Hr). lia. Qed.

Theorem paid_exhaustion_faults : forall cost requested reserved,
  cost > 0 -> reserved >= cost ->
  checked_reservation cost requested reserved = None.
Proof. intros cost requested reserved Hc Hr. unfold checked_reservation, CustomSponsorship.charge.
  assert ((cost =? 0) = false) as E by (apply Z.eqb_neq; lia). rewrite E.
  rewrite Z.max_r by lia. apply checked_update_nonpositive_fault.
  apply Z.le_min_r. Qed.

Theorem estimation_success_iff_representable : forall requested reserved,
  0 < requested < integer_limit -> 0 <= reserved < integer_limit ->
  (checked_reservation 0 requested reserved = Some (reserved + requested) <->
   reserved + requested < integer_limit).
Proof. intros requested reserved Hq Hr. unfold checked_reservation.
  rewrite OS_011_estimation_uses_requested_quote, checked_update_success_iff.
  unfold integer_fits. pose proof integer_limit_positive. split; intros; lia. Qed.

Theorem estimation_overflow_fault : forall requested reserved,
  0 < requested < integer_limit -> 0 <= reserved < integer_limit ->
  reserved + requested >= integer_limit -> checked_reservation 0 requested reserved = None.
Proof. intros requested reserved Hq Hr Ho. unfold checked_reservation.
  rewrite OS_011_estimation_uses_requested_quote. apply checked_update_overflow_fault; [lia|].
  unfold integer_fits. lia. Qed.

Theorem estimation_success_result : forall requested reserved next,
  0 < requested < integer_limit -> 0 <= reserved < integer_limit ->
  checked_reservation 0 requested reserved = Some next ->
  next = reserved + requested /\ integer_fits next.
Proof. intros requested reserved next Hq Hr H. unfold checked_reservation in H.
  rewrite OS_011_estimation_uses_requested_quote in H. apply checked_update_success_iff in H.
  destruct H as [_ [Hnext Hfit]]. subst next. auto. Qed.

(* This is a target/source-protocol disagreement, not a same-fault theorem.
   The imported unbounded protocol admits the sum; the bounded target rejects. *)
Theorem estimation_overflow_protocol_disagrees : forall tx requested before,
  ledger_tx before = tx -> 0 < requested < integer_limit ->
  0 <= ledger_spent before < integer_limit ->
  ledger_spent before + requested >= integer_limit ->
  bounded_reserve tx 0 requested before = None /\
  CustomSponsorship.reserve tx 0 requested before =
    Some (mkLedger tx (ledger_spent before + requested)).
Proof. intros tx requested before Htx Hq Hr Ho.
  assert (Hsource : CustomSponsorship.reserve tx 0 requested before =
    Some (mkLedger tx (ledger_spent before + requested))).
  { unfold CustomSponsorship.reserve.
    rewrite OS_001_same_transaction_retains_spend by exact Htx.
    rewrite OS_011_estimation_uses_requested_quote.
    assert ((0 <? requested) = true) as Eq by (apply Z.ltb_lt; lia).
    assert ((0 <=? ledger_spent before) = true) as Er by (apply Z.leb_le; lia).
    rewrite Eq, Er. reflexivity. }
  split; [|exact Hsource]. unfold bounded_reserve. rewrite Hsource. simpl.
  rewrite integer_overflow_faults; [reflexivity|]. unfold integer_fits. lia. Qed.

Theorem bounded_reserve_refines_protocol_when_sum_fits : forall tx cost requested before next,
  CustomSponsorship.reserve tx cost requested before = Some next ->
  integer_fits (ledger_spent next) -> bounded_reserve tx cost requested before = Some next.
Proof. intros tx cost requested before next H Hfit.
  assert (Htx : ledger_tx next = tx).
  { unfold CustomSponsorship.reserve in H.
    destruct ((0 <=? cost) && (0 <? requested) && (0 <=? spent_for tx before) &&
      (0 <? CustomSponsorship.charge cost requested (spent_for tx before))); [|discriminate].
    injection H as Hn. subst next. reflexivity. }
  unfold bounded_reserve. rewrite H, checked_integer_in_range by exact Hfit.
  destruct next as [next_tx next_spent]. simpl in Htx. subst next_tx. reflexivity. Qed.

Theorem bounded_reserve_success_refines_protocol : forall tx cost requested before next,
  bounded_reserve tx cost requested before = Some next ->
  CustomSponsorship.reserve tx cost requested before = Some next /\ integer_fits (ledger_spent next).
Proof. intros tx cost requested before next H. unfold bounded_reserve in H.
  destruct (CustomSponsorship.reserve tx cost requested before) as [abstract|] eqn:E; [|discriminate].
  destruct (checked_integer (ledger_spent abstract)) as [bounded|] eqn:Eb; [|discriminate].
  apply checked_integer_result_is_representable in Eb. destruct Eb as [Hb Hfits].
  injection H as Hnext. subst next. simpl. split; [|exact Hfits].
  assert (Htx : ledger_tx abstract = tx).
  { unfold CustomSponsorship.reserve in E.
    destruct ((0 <=? cost) && (0 <? requested) && (0 <=? spent_for tx before) &&
      (0 <? CustomSponsorship.charge cost requested (spent_for tx before))); [|discriminate].
    injection E as Ha. subst abstract. reflexivity. }
  destruct abstract as [abstract_tx abstract_spent]. simpl in *. subst abstract_tx. subst bounded. reflexivity.
Qed.

Theorem bounded_reserve_paid_agrees_protocol : forall tx cost requested before,
  0 < cost < integer_limit -> 0 <= spent_for tx before <= cost ->
  bounded_reserve tx cost requested before = CustomSponsorship.reserve tx cost requested before.
Proof. intros tx cost requested before Hc Hr.
  destruct (CustomSponsorship.reserve tx cost requested before) as [next|] eqn:E.
  - apply bounded_reserve_refines_protocol_when_sum_fits; [exact E|].
    destruct (OS_005_success_preserves_transaction_and_total_cap tx cost requested before next ltac:(lia) Hr E)
      as [_ Hbound]. apply nonnegative_integer_fits. lia.
  - unfold bounded_reserve. rewrite E. reflexivity. Qed.

Theorem failed_bounded_reservation_preserves_projection : forall tx cost requested before,
  bounded_reserve tx cost requested before = None ->
  apply_bounded_reserve tx cost requested before = before.
Proof. intros tx cost requested before H. unfold apply_bounded_reserve. rewrite H. reflexivity. Qed.

Theorem same_transaction_iteration_agrees_protocol : forall requests tx cost before,
  0 < cost < integer_limit -> ledger_tx before = tx -> 0 <= ledger_spent before <= cost ->
  bounded_reserve_many tx cost requests before = CustomSponsorship.reserve_many tx cost requests before.
Proof. induction requests as [|requested rest IH]; intros tx cost before Hc Htx Hr; [reflexivity|].
  cbn [bounded_reserve_many CustomSponsorship.reserve_many].
  assert (Hspent : 0 <= spent_for tx before <= cost).
  { rewrite OS_001_same_transaction_retains_spend by exact Htx. exact Hr. }
  rewrite bounded_reserve_paid_agrees_protocol by assumption.
  destruct (CustomSponsorship.reserve tx cost requested before) as [reserved|] eqn:E; [|reflexivity].
  destruct (OS_005_success_preserves_transaction_and_total_cap tx cost requested before reserved ltac:(lia) Hspent E)
    as [HnextTx HnextRange]. apply IH; assumption. Qed.

Theorem same_transaction_iteration_preserves_fee_bound : forall requests tx cost before next,
  0 < cost < integer_limit -> ledger_tx before = tx -> 0 <= ledger_spent before <= cost ->
  bounded_reserve_many tx cost requests before = Some next ->
  ledger_tx next = tx /\ 0 <= ledger_spent next <= cost /\ integer_fits (ledger_spent next).
Proof. intros requests tx cost before next Hc Htx Hr H.
  rewrite same_transaction_iteration_agrees_protocol in H by assumption.
  destruct (OS_007_multiple_calls_share_one_total_fee_cap requests tx cost before next ltac:(lia) Htx Hr H)
    as [HnextTx HnextRange]. repeat split; try lia; try assumption. Qed.

Example maximum_estimation_reservation_overflows :
  checked_reservation 0 1 (integer_limit - 1) = None.
Proof. apply estimation_overflow_fault; pose proof integer_limit_positive; lia. Qed.
Example fee_exhaustion_is_not_success : checked_reservation 5 3 5 = None.
Proof. reflexivity. Qed.
Example paid_three_reservations_exhaust_fee :
  bounded_reserve_many 1 5 [3;3;1] (mkLedger 1 0) = None.
Proof. reflexivity. Qed.

Print Assumptions checked_integer_none_iff.
Print Assumptions checked_update_success_iff.
Print Assumptions checked_update_nonpositive_fault.
Print Assumptions checked_update_overflow_fault.
Print Assumptions checked_update_fault_iff.
Print Assumptions paid_charge_formula.
Print Assumptions paid_charge_positive_iff.
Print Assumptions paid_updated_reservation_range.
Print Assumptions paid_reservation_success_iff_remaining.
Print Assumptions paid_reservation_result_bound.
Print Assumptions paid_exhaustion_faults.
Print Assumptions estimation_success_iff_representable.
Print Assumptions estimation_overflow_fault.
Print Assumptions estimation_success_result.
Print Assumptions estimation_overflow_protocol_disagrees.
Print Assumptions bounded_reserve_refines_protocol_when_sum_fits.
Print Assumptions bounded_reserve_success_refines_protocol.
Print Assumptions bounded_reserve_paid_agrees_protocol.
Print Assumptions failed_bounded_reservation_preserves_projection.
Print Assumptions same_transaction_iteration_agrees_protocol.
Print Assumptions same_transaction_iteration_preserves_fee_bound.
Print Assumptions maximum_estimation_reservation_overflows.
Print Assumptions fee_exhaustion_is_not_success.
Print Assumptions paid_three_reservations_exhaust_fee.
