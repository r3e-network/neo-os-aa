(*
  NeoOS formal verification -- bounded WitnessRule semantics.

  The definitions mirror the Neo N3 rule evaluator at the protocol boundary:
  the first matching rule decides the result and no matching rule denies the
  witness.  The context fields are an explicit abstraction of Neo's current,
  calling and entry contexts and of the contract groups consulted by the
  Group conditions.  The model also captures the protocol parser bounds of
  at most sixteen children and three nested condition levels.

  This is not a proof of NeoVM, transaction serialization, group-key
  cryptography or the concrete ApplicationEngine implementation.  It is a
  closed proof of the finite rule semantics used by the SmartAccount witness
  boundary, with those platform facts kept as explicit correspondence inputs.
*)
From Coq Require Import List Bool PeanoNat Lia.
Import ListNotations.

Record WitnessContext : Type := mkWitnessContext {
  current_script : nat;
  calling_script : option nat;
  call_depth : nat;
  current_groups : list nat;
  calling_groups : list nat
}.

Inductive Condition : Type :=
| CBoolean : bool -> Condition
| CNot : Condition -> Condition
| CAnd : list Condition -> Condition
| COr : list Condition -> Condition
| CScriptHash : nat -> Condition
| CGroup : nat -> Condition
| CCalledByEntry : Condition
| CCalledByContract : nat -> Condition
| CCalledByGroup : nat -> Condition.

Record Rule : Type := mkRule {
  rule_allow : bool;
  rule_condition : Condition
}.

Definition called_by_entry (ctx : WitnessContext) : bool :=
  Nat.leb (call_depth ctx) 1.

Fixpoint eval_condition (ctx : WitnessContext) (condition : Condition) : bool :=
  match condition with
  | CBoolean value => value
  | CNot expression => negb (eval_condition ctx expression)
  | CAnd expressions => forallb (eval_condition ctx) expressions
  | COr expressions => existsb (eval_condition ctx) expressions
  | CScriptHash hash => Nat.eqb (current_script ctx) hash
  | CGroup group => existsb (Nat.eqb group) (current_groups ctx)
  | CCalledByEntry => called_by_entry ctx
  | CCalledByContract hash =>
      match calling_script ctx with
      | Some caller => Nat.eqb caller hash
      | None => false
      end
  | CCalledByGroup group => existsb (Nat.eqb group) (calling_groups ctx)
  end.

Fixpoint eval_rules (ctx : WitnessContext) (rules : list Rule) : bool :=
  match rules with
  | [] => false
  | rule :: rest =>
      if eval_condition ctx (rule_condition rule)
      then rule_allow rule
      else eval_rules ctx rest
  end.

Fixpoint condition_well_formed (depth : nat) (condition : Condition) : bool :=
  match condition with
  | CBoolean _ | CScriptHash _ | CGroup _ | CCalledByEntry
  | CCalledByContract _ | CCalledByGroup _ => (1 <=? depth)
  | CNot expression => (1 <=? depth) && condition_well_formed (depth - 1) expression
  | CAnd expressions | COr expressions =>
      (1 <=? depth) &&
      (0 <? length expressions) &&
      (length expressions <=? 16) &&
      forallb (condition_well_formed (depth - 1)) expressions
  end.

Definition rules_well_formed (rules : list Rule) : bool :=
  forallb (fun rule => condition_well_formed 3 (rule_condition rule)) rules.

Lemma first_matching_rule_decides :
  forall ctx action condition rest,
    eval_condition ctx condition = true ->
    eval_rules ctx (mkRule action condition :: rest) = action.
Proof.
  intros ctx action condition rest H.
  simpl. rewrite H. reflexivity.
Qed.

Lemma nonmatching_rule_is_skipped :
  forall ctx rule rest,
    eval_condition ctx (rule_condition rule) = false ->
    eval_rules ctx (rule :: rest) = eval_rules ctx rest.
Proof.
  intros ctx rule rest H.
  simpl. rewrite H. reflexivity.
Qed.

Theorem default_deny :
  forall ctx rules,
    Forall (fun rule => eval_condition ctx (rule_condition rule) = false) rules ->
    eval_rules ctx rules = false.
Proof.
  intros ctx rules H.
  induction H as [|rule rest Hhead Htail IH].
  - reflexivity.
  - rewrite nonmatching_rule_is_skipped; [exact IH | exact Hhead].
Qed.

Theorem deny_precedes_later_allow :
  forall ctx condition,
    eval_condition ctx condition = true ->
    eval_rules ctx [mkRule false condition; mkRule true (CBoolean true)] = false.
Proof.
  intros ctx condition H.
  apply first_matching_rule_decides. exact H.
Qed.

Theorem accepted_rule_has_matching_allow :
  forall ctx rules,
    eval_rules ctx rules = true ->
    exists rule, In rule rules /\
      eval_condition ctx (rule_condition rule) = true /\
      rule_allow rule = true.
Proof.
  intros ctx rules.
  induction rules as [|rule rest IH]; simpl; intros H.
  - discriminate.
  - destruct (eval_condition ctx (rule_condition rule)) eqn:Hcondition.
    + exists rule. split; [left; reflexivity |].
      split; [exact Hcondition | exact H].
    + destruct (IH H) as [matching [Hin [Hmatch Hallow]]].
      exists matching. repeat split; try assumption.
      right. exact Hin.
Qed.

Theorem called_by_entry_is_limited_to_entry_and_direct_child :
  forall ctx,
    called_by_entry ctx = true <-> call_depth ctx <= 1.
Proof.
  intros ctx. unfold called_by_entry. apply Nat.leb_le.
Qed.

Example direct_child_is_called_by_entry :
  called_by_entry (mkWitnessContext 11 (Some 7) 1 [] []) = true.
Proof. vm_compute. reflexivity. Qed.

Example deep_child_is_not_called_by_entry :
  called_by_entry (mkWitnessContext 11 (Some 7) 2 [] []) = false.
Proof. vm_compute. reflexivity. Qed.

Example empty_and_is_not_well_formed :
  condition_well_formed 3 (CAnd []) = false.
Proof. vm_compute. reflexivity. Qed.

Example overlarge_or_is_not_well_formed :
  condition_well_formed 3 (COr (repeat (CBoolean true) 17)) = false.
Proof. vm_compute. reflexivity. Qed.

Example zero_depth_leaf_is_rejected :
  condition_well_formed 0 (CBoolean true) = false.
Proof. vm_compute. reflexivity. Qed.

Example three_level_not_is_accepted :
  condition_well_formed 3 (CNot (CNot (CBoolean true))) = true.
Proof. vm_compute. reflexivity. Qed.

Example fourth_level_not_is_rejected :
  condition_well_formed 3 (CNot (CNot (CNot (CBoolean true)))) = false.
Proof. vm_compute. reflexivity. Qed.

Example three_level_mixed_tree_is_accepted :
  condition_well_formed 3 (CAnd [COr [CBoolean true]]) = true.
Proof. vm_compute. reflexivity. Qed.

Example fourth_level_mixed_tree_is_rejected :
  condition_well_formed 3 (CAnd [COr [CNot (CBoolean true)]]) = false.
Proof. vm_compute. reflexivity. Qed.

Print Assumptions first_matching_rule_decides.
Print Assumptions nonmatching_rule_is_skipped.
Print Assumptions default_deny.
Print Assumptions deny_precedes_later_allow.
Print Assumptions accepted_rule_has_matching_allow.
Print Assumptions called_by_entry_is_limited_to_entry_and_direct_child.
Print Assumptions direct_child_is_called_by_entry.
Print Assumptions deep_child_is_not_called_by_entry.
Print Assumptions empty_and_is_not_well_formed.
Print Assumptions overlarge_or_is_not_well_formed.
Print Assumptions zero_depth_leaf_is_rejected.
Print Assumptions three_level_not_is_accepted.
Print Assumptions fourth_level_not_is_rejected.
Print Assumptions three_level_mixed_tree_is_accepted.
Print Assumptions fourth_level_mixed_tree_is_rejected.
