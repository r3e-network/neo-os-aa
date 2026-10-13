(* Daily net-outflow policy. Token balance honesty, authenticated callbacks,
   clock values and atomic VM rollback remain external correspondence inputs. *)
From Coq Require Import Bool PeanoNat ZArith Lia.

Definition window_ms : nat := 86400000.
Definition active_window (timestamp now : nat) : bool := now <? timestamp + window_ms.
Record Window := Budget { since : option nat; used : nat }.
Definition current_spent (w : Window) (now : nat) : nat :=
  match since w with None => 0 | Some timestamp =>
    if active_window timestamp now then used w else 0 end.
Definition next_anchor (w : Window) (now : nat) : nat :=
  match since w with None => now | Some timestamp =>
    if active_window timestamp now then timestamp else now end.
Definition fixed_charge (w : Window) (now delta cap : nat) : option Window :=
  if delta =? 0 then Some w else
  if current_spent w now + delta <=? cap
  then Some (Budget (Some (next_anchor w now)) (current_spent w now + delta)) else None.
Definition observed_outflow (_result : bool) (before after : nat) : nat := before - after.
Definition rolling_live (timestamp now : nat) : bool := now - window_ms <=? timestamp.
Definition rolling_admit (spent amount count cap : nat) : bool :=
  (spent + amount <=? cap) && (count <? 50).

From Coq Require Import List.
Import ListNotations.
Record Payment := Entry { payment_time : nat; payment_amount : nat }.
Fixpoint history_scan (now : nat) (rows : list Payment) : nat * nat :=
  match rows with
  | [] => (0, 0)
  | r :: rest =>
    let tail := history_scan now rest in
    if rolling_live (payment_time r) now
    then (payment_amount r + fst tail, S (snd tail)) else tail
  end.
Definition retained (now : nat) (rows : list Payment) : list Payment :=
  filter (fun r => rolling_live (payment_time r) now) rows.
Fixpoint history_total (rows : list Payment) : nat :=
  match rows with [] => 0 | r :: rest => payment_amount r + history_total rest end.

(* A query outcome is not a balance until exact Integer/nonnegative admission.
   Mapping VM stack items and engine faults to these cases remains external. *)
Inductive BalanceReply := IntegerBalance (value : Z) | OtherBalanceType | BalanceQueryFault.
Definition decode_balance (reply : BalanceReply) : option nat :=
  match reply with
  | IntegerBalance value => if Z.geb value 0 then Some (Z.to_nat value) else None
  | OtherBalanceType => None
  | BalanceQueryFault => None
  end.
Definition checked_outflow (before after : BalanceReply) : option nat :=
  match decode_balance before, decode_balance after with
  | Some b, Some a => Some (b - a)
  | _, _ => None
  end.

Theorem fixed_anchor_stays : forall timestamp spent now delta cap next,
  now < timestamp + window_ms -> delta <> 0 ->
  fixed_charge (Budget (Some timestamp) spent) now delta cap = Some next -> since next = Some timestamp.
Proof.
  intros. unfold fixed_charge in H1.
  assert (D : (delta =? 0) = false) by (apply Nat.eqb_neq; assumption).
  rewrite D in H1. destruct (current_spent (Budget (Some timestamp) spent) now + delta <=? cap); inversion H1.
  simpl. unfold next_anchor. simpl.
  assert (E : active_window timestamp now = true) by (unfold active_window; apply Nat.ltb_lt; assumption).
  rewrite E. reflexivity.
Qed.

Theorem fixed_expiry_restarts : forall timestamp spent now delta cap next,
  timestamp + window_ms <= now -> delta <> 0 ->
  fixed_charge (Budget (Some timestamp) spent) now delta cap = Some next -> since next = Some now.
Proof.
  intros. unfold fixed_charge in H1.
  assert (D : (delta =? 0) = false) by (apply Nat.eqb_neq; assumption).
  rewrite D in H1. destruct (current_spent (Budget (Some timestamp) spent) now + delta <=? cap); inversion H1.
  simpl. unfold next_anchor. simpl.
  assert (E : active_window timestamp now = false) by (unfold active_window; apply Nat.ltb_ge; assumption).
  rewrite E. reflexivity.
Qed.

Theorem fixed_expired_spending_is_zero : forall timestamp spent now,
  timestamp + window_ms <= now -> current_spent (Budget (Some timestamp) spent) now = 0.
Proof.
  intros. unfold current_spent. simpl.
  assert (E : active_window timestamp now = false) by (unfold active_window; apply Nat.ltb_ge; assumption).
  rewrite E. reflexivity.
Qed.

Theorem fixed_charge_within_cap : forall w now delta cap next,
  delta <> 0 -> fixed_charge w now delta cap = Some next -> used next <= cap.
Proof.
  intros. unfold fixed_charge in H0.
  assert (D : (delta =? 0) = false) by (apply Nat.eqb_neq; assumption).
  rewrite D in H0. destruct (current_spent w now + delta <=? cap) eqn:E; inversion H0; subst.
  simpl. apply Nat.leb_le. exact E.
Qed.

Theorem zero_outflow_preserves_window : forall w now cap, fixed_charge w now 0 cap = Some w.
Proof. reflexivity. Qed.

Theorem false_result_still_meters : forall before after,
  observed_outflow false before after = before - after.
Proof. reflexivity. Qed.

Theorem inflow_is_not_outflow : forall result before after,
  before <= after -> observed_outflow result before after = 0.
Proof. intros. unfold observed_outflow. lia. Qed.

Theorem rolling_lower_boundary_included : forall now, rolling_live (now - window_ms) now = true.
Proof. intros. unfold rolling_live. apply Nat.leb_refl. Qed.

Theorem rolling_expired_excluded : forall timestamp now,
  timestamp < now - window_ms -> rolling_live timestamp now = false.
Proof. intros. unfold rolling_live. apply Nat.leb_gt. assumption. Qed.

Theorem rolling_full_rejects : forall spent amount cap, rolling_admit spent amount 50 cap = false.
Proof. intros. unfold rolling_admit. simpl. apply andb_false_r. Qed.

Theorem first_outflow_is_reachable : fixed_charge (Budget None 0) 100 3 5 = Some (Budget (Some 100) 3).
Proof. reflexivity. Qed.

Print Assumptions fixed_anchor_stays.
Print Assumptions fixed_expiry_restarts.
Print Assumptions fixed_expired_spending_is_zero.
Print Assumptions fixed_charge_within_cap.
Print Assumptions zero_outflow_preserves_window.
Print Assumptions false_result_still_meters.
Print Assumptions inflow_is_not_outflow.
Print Assumptions rolling_lower_boundary_included.
Print Assumptions rolling_expired_excluded.
Print Assumptions rolling_full_rejects.
Print Assumptions first_outflow_is_reachable.

Theorem history_scan_agrees : forall now rows,
  history_scan now rows = (history_total (retained now rows), length (retained now rows)).
Proof.
  intros now rows. induction rows as [|r rest IH]; simpl; [reflexivity|].
  unfold retained in *. simpl. destruct (rolling_live (payment_time r) now); rewrite IH; reflexivity.
Qed.

Theorem pruning_preserves_scan : forall now rows,
  history_scan now (retained now rows) = history_scan now rows.
Proof.
  intros now rows. induction rows as [|r rest IH]; simpl; [reflexivity|].
  unfold retained in *. simpl. destruct (rolling_live (payment_time r) now) eqn:E; simpl.
  - rewrite E, IH. reflexivity.
  - exact IH.
Qed.

Theorem retains_every_live_record : forall now rows r,
  In r rows -> rolling_live (payment_time r) now = true -> In r (retained now rows).
Proof. intros. unfold retained. apply filter_In. split; assumption. Qed.

Theorem history_capacity_rejects : forall now rows amount cap,
  snd (history_scan now rows) = 50 ->
  rolling_admit (fst (history_scan now rows)) amount (snd (history_scan now rows)) cap = false.
Proof. intros. rewrite H. apply rolling_full_rejects. Qed.

Theorem live_record_increments_count : forall now rows r,
  rolling_live (payment_time r) now = true ->
  snd (history_scan now (r :: rows)) = S (snd (history_scan now rows)).
Proof. intros. simpl. rewrite H. reflexivity. Qed.

Theorem append_preserves_capacity : forall now rows amount cap,
  rolling_admit (fst (history_scan now rows)) amount (snd (history_scan now rows)) cap = true ->
  S (snd (history_scan now rows)) <= 50.
Proof.
  intros. unfold rolling_admit in H. apply andb_true_iff in H.
  destruct H as [_ H]. apply Nat.ltb_lt in H. lia.
Qed.

Print Assumptions history_scan_agrees.
Print Assumptions pruning_preserves_scan.
Print Assumptions retains_every_live_record.
Print Assumptions history_capacity_rejects.
Print Assumptions live_record_increments_count.
Print Assumptions append_preserves_capacity.

Theorem nonnegative_balance_exact : forall value,
  (0 <= value)%Z -> decode_balance (IntegerBalance value) = Some (Z.to_nat value).
Proof.
  intros. simpl. assert (E : Z.geb value 0 = true) by (apply Z.geb_le; assumption).
  rewrite E. reflexivity.
Qed.

Theorem negative_balance_rejected : forall value,
  (value < 0)%Z -> decode_balance (IntegerBalance value) = None.
Proof.
  intros. simpl. destruct (Z.geb value 0) eqn:E; [apply Z.geb_le in E; lia|reflexivity].
Qed.

Theorem noninteger_balance_rejected : decode_balance OtherBalanceType = None.
Proof. reflexivity. Qed.

Theorem failed_balance_query_rejected : decode_balance BalanceQueryFault = None.
Proof. reflexivity. Qed.

Theorem accepted_balance_is_nonnegative : forall reply amount,
  decode_balance reply = Some amount ->
  exists value, reply = IntegerBalance value /\ (0 <= value)%Z /\ amount = Z.to_nat value.
Proof.
  intros reply amount H. destruct reply as [value| |]; simpl in H; try discriminate.
  destruct (Z.geb value 0) eqn:E; inversion H; subst.
  exists value. split; [reflexivity|]. split; [apply Z.geb_le; exact E|reflexivity].
Qed.

Theorem rejected_observation_aborts_delta : forall before after,
  decode_balance before = None \/ decode_balance after = None -> checked_outflow before after = None.
Proof.
  intros before after [H|H]; unfold checked_outflow; rewrite H.
  - reflexivity.
  - destruct (decode_balance before); reflexivity.
Qed.

Theorem accepted_delta_exact : forall before after,
  checked_outflow (IntegerBalance (Z.of_nat before)) (IntegerBalance (Z.of_nat after)) = Some (before - after).
Proof.
  intros. unfold checked_outflow.
  rewrite !nonnegative_balance_exact by lia. rewrite !Nat2Z.id. reflexivity.
Qed.

Print Assumptions nonnegative_balance_exact.
Print Assumptions negative_balance_rejected.
Print Assumptions noninteger_balance_rejected.
Print Assumptions failed_balance_query_rejected.
Print Assumptions accepted_balance_is_nonnegative.
Print Assumptions rejected_observation_aborts_delta.
Print Assumptions accepted_delta_exact.
