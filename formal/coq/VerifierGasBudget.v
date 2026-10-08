(*
  NeoOS formal verification -- bounded verifier callback budgets.

  This model captures the safety property required by the platform extension:
  a callback budget is checked against the callback itself and every enclosing
  budget before any counter is changed.  A failed charge therefore has no
  partial state update, and a nested callback cannot escape its ancestor.

  Applies only to the private PLATFORM profile using CallWithGasLimit. The
  public v3 profile uses standard Contract.Call and has no such child budget.

  The model is intentionally independent of cryptography, witness parsing and
  complete NeoVM semantics.  Those remain separate correspondence obligations.
*)
From Coq Require Import List Bool PeanoNat Lia.
Import ListNotations.

Record Budget : Type := mkBudget {
  budget_limit : nat;
  budget_consumed : nat
}.

Definition can_charge (budget : Budget) (amount : nat) : bool :=
  Nat.leb (budget_consumed budget + amount) (budget_limit budget).

Fixpoint all_can_charge (budgets : list Budget) (amount : nat) : bool :=
  match budgets with
  | [] => true
  | budget :: rest => can_charge budget amount && all_can_charge rest amount
  end.

Definition charged (budget : Budget) (amount : nat) : Budget :=
  mkBudget (budget_limit budget) (budget_consumed budget + amount).

Definition charge_all (budgets : list Budget) (amount : nat) : option (list Budget) :=
  if all_can_charge budgets amount
  then Some (map (fun budget => charged budget amount) budgets)
  else None.

Definition charge_atomic (budgets : list Budget) (amount : nat)
    : bool * list Budget :=
  match charge_all budgets amount with
  | Some next => (true, next)
  | None => (false, budgets)
  end.

Lemma all_can_charge_components :
  forall budgets amount,
    all_can_charge budgets amount = true ->
    Forall (fun budget => budget_consumed budget + amount <= budget_limit budget) budgets.
Proof.
  induction budgets as [|budget rest IH]; intros amount H.
  - constructor.
  - simpl in H.
    apply andb_true_iff in H.
    destruct H as [Hhead Hrest].
    constructor.
    + apply Nat.leb_le. exact Hhead.
    + apply IH. exact Hrest.
Qed.

Lemma charged_limits_are_preserved :
  forall budget amount,
    can_charge budget amount = true ->
    budget_consumed (charged budget amount) <= budget_limit (charged budget amount).
Proof.
  intros budget amount H.
  unfold can_charge in H.
  apply Nat.leb_le in H.
  unfold charged.
  simpl.
  exact H.
Qed.

Theorem VGB_001_failed_charge_is_atomic :
  forall budgets amount,
    charge_all budgets amount = None ->
    charge_atomic budgets amount = (false, budgets).
Proof.
  intros budgets amount H.
  unfold charge_atomic.
  rewrite H.
  reflexivity.
Qed.

Theorem VGB_002_success_charges_every_ancestor :
  forall budgets amount next,
    charge_all budgets amount = Some next ->
    next = map (fun budget => charged budget amount) budgets.
Proof.
  intros budgets amount next H.
  unfold charge_all in H.
  destruct (all_can_charge budgets amount) eqn:Hcan; [| discriminate].
  injection H as Hnext.
  symmetry. exact Hnext.
Qed.

Theorem VGB_003_success_stays_within_every_ancestor :
  forall budgets amount next,
    charge_all budgets amount = Some next ->
    Forall (fun budget => budget_consumed budget <= budget_limit budget) next.
Proof.
  intros budgets amount next H.
  pose proof (VGB_002_success_charges_every_ancestor budgets amount next H) as Hnext.
  subst next.
  unfold charge_all in H.
  destruct (all_can_charge budgets amount) eqn:Hcan; [| discriminate].
  clear H.
  apply Forall_forall.
  intros budget Hmember.
  apply in_map_iff in Hmember.
  destruct Hmember as [original [Hcharged Hin]].
  subst budget.
  pose proof (all_can_charge_components budgets amount Hcan) as Hall.
  pose proof (proj1 (@Forall_forall Budget
    (fun budget => budget_consumed budget + amount <= budget_limit budget)
    budgets) Hall) as HallPoint.
  specialize (HallPoint original Hin).
  unfold charged.
  simpl.
  exact HallPoint.
Qed.

Theorem VGB_004_nested_charge_requires_ancestor :
  forall child parent amount,
    can_charge child amount = true ->
    can_charge parent amount = false ->
    charge_all [child; parent] amount = None.
Proof.
  intros child parent amount Hchild Hparent.
  unfold charge_all, all_can_charge.
  rewrite Hchild.
  rewrite Hparent.
  simpl.
  reflexivity.
Qed.

Print Assumptions all_can_charge_components.
Print Assumptions charged_limits_are_preserved.
Print Assumptions VGB_001_failed_charge_is_atomic.
Print Assumptions VGB_002_success_charges_every_ancestor.
Print Assumptions VGB_003_success_stays_within_every_ancestor.
Print Assumptions VGB_004_nested_charge_requires_ancestor.
