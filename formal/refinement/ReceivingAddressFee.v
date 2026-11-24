From Coq Require Import NArith List Lia.
Require Import PathFee.
Import ListNotations. Open Scope N_scope.

(* Positive charges, in execution order, through the native permission check. *)
Definition through_permission : list N := [8;1;2048;1;8;8;32768;1].
Definition address_path := through_permission ++ [32768].

Theorem required_address_budget : forall factor budget amount,
  settle factor budget 0 address_path = Paid amount <->
  67611 * factor <= budget /\ amount = 67611 * factor.
Proof.
  intros. rewrite settle_paid by lia.
  assert (U : units address_path = 67611) by reflexivity.
  rewrite U, N.add_0_l, N.mul_comm. reflexivity.
Qed.

Theorem required_before_permission_refusal : forall factor budget amount,
  settle factor budget 0 through_permission = Paid amount <->
  34843 * factor <= budget /\ amount = 34843 * factor.
Proof.
  intros. rewrite settle_paid by lia.
  assert (U : units through_permission = 34843) by reflexivity.
  rewrite U, N.add_0_l, N.mul_comm. reflexivity.
Qed.

Theorem first_excess_charge : forall factor budget amount,
  settle factor budget 0 address_path = Exhausted amount ->
  exists prefix w rest, address_path = prefix ++ w :: rest /\
    factor * units prefix <= budget /\ budget < amount /\ amount = factor * (units prefix + w).
Proof.
  intros f b a H. apply exhausted_at_first_overrun in H; [exact H|lia].
Qed.
Print Assumptions required_address_budget.
Print Assumptions required_before_permission_refusal.
Print Assumptions first_excess_charge.

(* Huyao's positive charges, in thousandths of the native CPU price unit.
   PACK has one element; only the native wrapper has an explicit RET. *)
Definition huyao_path : list N :=
  [1685;2187;173+2649;2187;1685;1685;32768000;2187;32768000;1085].
Definition minimum_huyao_budget (pico:N) := (65551523 * pico + 9999999) / 10000000.

Theorem huyao_exact_budget : forall pico budget,
  settle pico (budget * 10000000) 0 huyao_path = Paid (65551523 * pico) <->
  minimum_huyao_budget pico <= budget.
Proof.
  intros p b. rewrite settle_paid by lia.
  assert (U : units huyao_path = 65551523) by reflexivity.
  rewrite U, N.add_0_l, (N.mul_comm p). unfold minimum_huyao_budget.
  pose proof (N.div_mod (65551523*p + 9999999) 10000000 ltac:(discriminate)).
  pose proof (N.mod_lt (65551523*p + 9999999) 10000000 ltac:(discriminate)).
  remember (65551523*p) as x. clear Heqx.
  remember ((x+9999999)/10000000) as q. clear Heqq.
  remember ((x+9999999) mod 10000000) as r. clear Heqr.
  destruct (N.le_gt_cases q b); lia.
Qed.
Print Assumptions huyao_exact_budget.
