(* Custom V3 / PLATFORM source-candidate cumulative sponsorship cap.
   A single core ledger is shared by all accounts, sponsors and paymasters.
   Transaction identity, nonnegative paid fee and atomic enclosing-transaction
   rollback are correspondence inputs. This model does not prove NeoVM storage,
   fee calculation, cryptography, or settlement-token behavior. Zero-fee RPC
   estimation deliberately has no real-fee cap claim. *)
From Coq Require Import ZArith Bool List Lia.
Import ListNotations.
Open Scope Z_scope.

Record Ledger := mkLedger { ledger_tx : nat; ledger_spent : Z }.
Definition spent_for (tx : nat) (before : Ledger) : Z :=
  if Nat.eqb tx (ledger_tx before) then ledger_spent before else 0.
Definition charge (cost requested spent : Z) : Z :=
  if Z.eqb cost 0 then requested
  else Z.min requested (Z.max (cost - spent) 0).
Definition reserve (tx : nat) (cost requested : Z) (before : Ledger) : option Ledger :=
  let spent := spent_for tx before in
  let amount := charge cost requested spent in
  if Z.leb 0 cost && Z.ltb 0 requested && Z.leb 0 spent && Z.ltb 0 amount
  then Some (mkLedger tx (spent + amount))
  else None.
Definition apply_reserve (tx : nat) (cost requested : Z) (before : Ledger) : Ledger :=
  match reserve tx cost requested before with Some next => next | None => before end.
Definition finish (before reserved : Ledger) (settlement_ok : bool) : Ledger :=
  if settlement_ok then reserved else before.
Fixpoint reserve_many (tx : nat) (cost : Z) (requests : list Z) (before : Ledger)
    : option Ledger :=
  match requests with
  | [] => Some before
  | requested :: rest =>
      match reserve tx cost requested before with
      | Some next => reserve_many tx cost rest next
      | None => None
      end
  end.

Theorem OS_001_same_transaction_retains_spend : forall tx before,
  ledger_tx before = tx -> spent_for tx before = ledger_spent before.
Proof. intros tx before H. unfold spent_for. rewrite H, Nat.eqb_refl. reflexivity. Qed.

Theorem OS_002_new_transaction_starts_at_zero : forall tx before,
  ledger_tx before <> tx -> spent_for tx before = 0.
Proof. intros tx before H. unfold spent_for.
  assert (E : Nat.eqb tx (ledger_tx before) = false) by (apply Nat.eqb_neq; congruence).
  rewrite E. reflexivity. Qed.

Theorem OS_003_persisted_charge_is_within_remaining_fee : forall cost requested spent,
  cost > 0 -> 0 <= spent <= cost ->
  charge cost requested spent <= cost - spent.
Proof. intros cost requested spent Hc Hs. unfold charge.
  assert (E : Z.eqb cost 0 = false) by (apply Z.eqb_neq; lia).
  rewrite E, Z.max_l by lia. apply Z.le_min_r. Qed.

Theorem OS_004_charge_never_exceeds_request : forall cost requested spent,
  charge cost requested spent <= requested.
Proof. intros. unfold charge. destruct (Z.eqb cost 0); [lia | apply Z.le_min_l]. Qed.

Theorem OS_005_success_preserves_transaction_and_total_cap : forall tx cost requested before next,
  cost > 0 -> 0 <= spent_for tx before <= cost ->
  reserve tx cost requested before = Some next ->
  ledger_tx next = tx /\ 0 <= ledger_spent next <= cost.
Proof. intros tx cost requested before next Hc Hs H.
  unfold reserve in H.
  destruct (Z.leb 0 cost && Z.ltb 0 requested && Z.leb 0 (spent_for tx before) &&
    Z.ltb 0 (charge cost requested (spent_for tx before))) eqn:E; [|discriminate].
  repeat rewrite andb_true_iff in E. destruct E as [[[Ec Er] Es] Ea].
  apply Z.ltb_lt in Ea.
  pose proof (OS_003_persisted_charge_is_within_remaining_fee cost requested
    (spent_for tx before) Hc Hs) as Hcap.
  injection H as Hnext. subst next. simpl. split; [reflexivity|lia]. Qed.

Theorem OS_006_success_reserves_before_external_settlement : forall tx cost requested before next,
  reserve tx cost requested before = Some next ->
  ledger_spent next = spent_for tx before + charge cost requested (spent_for tx before).
Proof. intros tx cost requested before next H. unfold reserve in H.
  destruct (Z.leb 0 cost && Z.ltb 0 requested && Z.leb 0 (spent_for tx before) &&
    Z.ltb 0 (charge cost requested (spent_for tx before))); [|discriminate].
  injection H as Hnext. subst next. reflexivity. Qed.

Theorem OS_007_multiple_calls_share_one_total_fee_cap : forall requests tx cost before next,
  cost > 0 -> ledger_tx before = tx -> 0 <= ledger_spent before <= cost ->
  reserve_many tx cost requests before = Some next ->
  ledger_tx next = tx /\ 0 <= ledger_spent next <= cost.
Proof. induction requests as [|requested rest IH]; intros tx cost before next Hc Htx Hs H.
  - simpl in H. injection H as Hnext. subst next. auto.
  - simpl in H. destruct (reserve tx cost requested before) as [reserved|] eqn:E; [|discriminate].
    assert (Hspent : 0 <= spent_for tx before <= cost).
    { rewrite OS_001_same_transaction_retains_spend by exact Htx. exact Hs. }
    destruct (OS_005_success_preserves_transaction_and_total_cap tx cost requested before reserved Hc Hspent E)
      as [HnextTx HnextSpent].
    eapply IH; eauto. Qed.

Theorem OS_008_exhausted_fee_rejects : forall tx cost requested before,
  cost > 0 -> spent_for tx before = cost -> reserve tx cost requested before = None.
Proof. intros tx cost requested before Hc Hs. unfold reserve, charge.
  assert (E : Z.eqb cost 0 = false) by (apply Z.eqb_neq; lia).
  rewrite E, Hs, Z.sub_diag. cbn.
  assert (Hamount : Z.ltb 0 (Z.min requested 0) = false).
  { apply Z.ltb_ge. apply Z.le_min_r. }
  rewrite Hamount, andb_false_r. reflexivity. Qed.

Theorem OS_009_failed_reservation_preserves_ledger : forall tx cost requested before,
  reserve tx cost requested before = None -> apply_reserve tx cost requested before = before.
Proof. intros tx cost requested before H. unfold apply_reserve. rewrite H. reflexivity. Qed.

Theorem OS_010_failed_settlement_rolls_back_ledger : forall before reserved,
  finish before reserved false = before.
Proof. reflexivity. Qed.

Theorem OS_011_estimation_uses_requested_quote : forall requested spent,
  charge 0 requested spent = requested.
Proof. reflexivity. Qed.

Example OS_012_second_call_gets_only_remaining_fee :
  reserve_many 1 5 [3;3] (mkLedger 1 0) = Some (mkLedger 1 5).
Proof. reflexivity. Qed.

Example OS_013_third_call_at_cap_rejects :
  reserve_many 1 5 [3;3;1] (mkLedger 1 0) = None.
Proof. reflexivity. Qed.

Example OS_014_estimation_is_not_a_persisted_fee_bound :
  reserve_many 1 0 [3;3] (mkLedger 1 0) = Some (mkLedger 1 6).
Proof. reflexivity. Qed.

Theorem OS_015_branch_free_cap_matches_abstract_charge : forall cost requested spent,
  0 <= cost -> 0 <= spent ->
  Z.min requested (Z.max (cost - spent) 0 + (1 - Z.min cost 1) * requested) =
    charge cost requested spent.
Proof. intros cost requested spent Hc Hs. unfold charge.
  destruct (Z.eqb cost 0) eqn:E.
  - apply Z.eqb_eq in E. subst cost.
    rewrite (Z.min_l 0 1) by lia.
    rewrite (Z.max_r (0 - spent) 0) by lia.
    replace (0 + (1 - 0) * requested) with requested by lia.
    apply Z.min_id.
  - apply Z.eqb_neq in E.
    rewrite (Z.min_r cost 1) by lia.
    replace (Z.max (cost - spent) 0 + (1 - 1) * requested)
      with (Z.max (cost - spent) 0) by lia.
    reflexivity.
Qed.

Print Assumptions OS_001_same_transaction_retains_spend.
Print Assumptions OS_002_new_transaction_starts_at_zero.
Print Assumptions OS_003_persisted_charge_is_within_remaining_fee.
Print Assumptions OS_004_charge_never_exceeds_request.
Print Assumptions OS_005_success_preserves_transaction_and_total_cap.
Print Assumptions OS_006_success_reserves_before_external_settlement.
Print Assumptions OS_007_multiple_calls_share_one_total_fee_cap.
Print Assumptions OS_008_exhausted_fee_rejects.
Print Assumptions OS_009_failed_reservation_preserves_ledger.
Print Assumptions OS_010_failed_settlement_rolls_back_ledger.
Print Assumptions OS_011_estimation_uses_requested_quote.
Print Assumptions OS_012_second_call_gets_only_remaining_fee.
Print Assumptions OS_013_third_call_at_cap_rejects.
Print Assumptions OS_014_estimation_is_not_a_persisted_fee_bound.
Print Assumptions OS_015_branch_free_cap_matches_abstract_charge.
