(*
  NeoOS formal verification -- fault-aware WitnessRule semantics.

  Neo's Group and CalledByGroup conditions require ReadStates. A failed
  permission check is a VM fault, not the Boolean value false. This module
  models that distinction, left-to-right short-circuiting, and first-match
  rule evaluation. It deliberately does not model manifest signature
  validation, transaction serialization, group-key cryptography, or the full
  ApplicationEngine.
*)
From Coq Require Import List Bool PeanoNat.
Import ListNotations.

Inductive EvalResult : Type :=
| EValue : bool -> EvalResult
| EFault : EvalResult.

Record FaultContext : Type := mkFaultContext {
  fault_read_states : bool;
  fault_current_script : nat;
  fault_calling_script : option nat;
  fault_call_depth : nat;
  fault_current_groups : list nat;
  fault_calling_groups : list nat
}.

Inductive FaultCondition : Type :=
| FBoolean : bool -> FaultCondition
| FNot : FaultCondition -> FaultCondition
| FAnd : list FaultCondition -> FaultCondition
| FOr : list FaultCondition -> FaultCondition
| FScriptHash : nat -> FaultCondition
| FGroup : nat -> FaultCondition
| FCalledByEntry : FaultCondition
| FCalledByContract : nat -> FaultCondition
| FCalledByGroup : nat -> FaultCondition.

Record FaultRule : Type := mkFaultRule {
  fault_rule_allow : bool;
  fault_rule_condition : FaultCondition
}.

Fixpoint member_nat (value : nat) (values : list nat) : bool :=
  match values with
  | [] => false
  | head :: tail => if Nat.eqb value head then true else member_nat value tail
  end.

Definition group_result (ctx : FaultContext) (group : nat) : EvalResult :=
  if fault_read_states ctx
  then EValue (member_nat group (fault_current_groups ctx))
  else EFault.

Definition called_group_result (ctx : FaultContext) (group : nat) : EvalResult :=
  if fault_read_states ctx
  then EValue (member_nat group (fault_calling_groups ctx))
  else EFault.

Fixpoint eval_fault_condition (fuel : nat) (ctx : FaultContext)
    (condition : FaultCondition) : EvalResult :=
  match fuel with
  | 0 => EFault
  | S fuel' =>
      match condition with
      | FBoolean value => EValue value
      | FNot expression =>
          match eval_fault_condition fuel' ctx expression with
          | EValue value => EValue (negb value)
          | EFault => EFault
          end
      | FAnd expressions => eval_fault_and fuel' ctx expressions
      | FOr expressions => eval_fault_or fuel' ctx expressions
      | FScriptHash hash => EValue (Nat.eqb (fault_current_script ctx) hash)
      | FGroup group => group_result ctx group
      | FCalledByEntry => EValue (Nat.leb (fault_call_depth ctx) 1)
      | FCalledByContract hash =>
          match fault_calling_script ctx with
          | Some caller => EValue (Nat.eqb caller hash)
          | None => EValue false
          end
      | FCalledByGroup group => called_group_result ctx group
      end
  end
with eval_fault_and (fuel : nat) (ctx : FaultContext)
    (expressions : list FaultCondition) : EvalResult :=
  match fuel with
  | 0 => EFault
  | S fuel' =>
      match expressions with
      | [] => EValue true
      | expression :: rest =>
          match eval_fault_condition fuel' ctx expression with
          | EFault => EFault
          | EValue false => EValue false
          | EValue true => eval_fault_and fuel' ctx rest
          end
      end
  end
with eval_fault_or (fuel : nat) (ctx : FaultContext)
    (expressions : list FaultCondition) : EvalResult :=
  match fuel with
  | 0 => EFault
  | S fuel' =>
      match expressions with
      | [] => EValue false
      | expression :: rest =>
          match eval_fault_condition fuel' ctx expression with
          | EFault => EFault
          | EValue true => EValue true
          | EValue false => eval_fault_or fuel' ctx rest
          end
      end
  end.

Fixpoint eval_fault_rules (fuel : nat) (ctx : FaultContext)
    (rules : list FaultRule) : EvalResult :=
  match fuel with
  | 0 => EFault
  | S fuel' =>
      match rules with
      | [] => EValue false
      | rule :: rest =>
          match eval_fault_condition fuel' ctx (fault_rule_condition rule) with
          | EFault => EFault
          | EValue true => EValue (fault_rule_allow rule)
          | EValue false => eval_fault_rules fuel' ctx rest
          end
      end
  end.

Lemma readable_group_condition_refines_boolean :
  forall ctx group,
    fault_read_states ctx = true ->
    eval_fault_condition 3 ctx (FGroup group) =
      EValue (member_nat group (fault_current_groups ctx)).
Proof. intros ctx group H. simpl. unfold group_result. rewrite H. reflexivity. Qed.

Lemma readable_called_group_condition_refines_boolean :
  forall ctx group,
    fault_read_states ctx = true ->
    eval_fault_condition 3 ctx (FCalledByGroup group) =
      EValue (member_nat group (fault_calling_groups ctx)).
Proof. intros ctx group H. simpl. unfold called_group_result. rewrite H. reflexivity. Qed.

Lemma negation_preserves_fault :
  forall fuel ctx condition,
    eval_fault_condition fuel ctx condition = EFault ->
    eval_fault_condition (S fuel) ctx (FNot condition) = EFault.
Proof.
  intros fuel ctx condition H.
  destruct (eval_fault_condition fuel ctx condition) eqn:Hcase.
  - discriminate.
  - simpl. rewrite Hcase. reflexivity.
Qed.

Lemma and_short_circuits_false :
  forall fuel ctx rest,
    eval_fault_condition (S (S (S fuel))) ctx (FAnd (FBoolean false :: rest)) = EValue false.
Proof. intros. simpl. reflexivity. Qed.

Lemma or_short_circuits_true :
  forall fuel ctx rest,
    eval_fault_condition (S (S (S fuel))) ctx (FOr (FBoolean true :: rest)) = EValue true.
Proof. intros. simpl. reflexivity. Qed.

Lemma faulting_rule_prevents_later_allow :
  forall fuel ctx condition rest,
    eval_fault_condition fuel ctx condition = EFault ->
    eval_fault_rules (S fuel) ctx (mkFaultRule true condition :: rest) = EFault.
Proof.
  intros fuel ctx condition rest H.
  destruct (eval_fault_condition fuel ctx condition) eqn:Hcase.
  - discriminate.
  - simpl. rewrite Hcase. reflexivity.
Qed.

Example group_permission_faults :
  eval_fault_condition 3
    (mkFaultContext false 1 None 0 [] []) (FGroup 7) = EFault.
Proof. reflexivity. Qed.

Example called_group_permission_faults :
  eval_fault_condition 3
    (mkFaultContext false 1 (Some 2) 1 [] []) (FCalledByGroup 7) = EFault.
Proof. reflexivity. Qed.

Example false_and_does_not_touch_group :
  eval_fault_condition 3
    (mkFaultContext false 1 None 0 [] []) (FAnd [FBoolean false; FGroup 7]) = EValue false.
Proof. reflexivity. Qed.

Example true_or_does_not_touch_group :
  eval_fault_condition 3
    (mkFaultContext false 1 None 0 [] []) (FOr [FBoolean true; FGroup 7]) = EValue true.
Proof. reflexivity. Qed.

Example group_fault_is_not_later_allow :
  eval_fault_rules 3
    (mkFaultContext false 1 None 0 [] [])
    [mkFaultRule true (FGroup 7); mkFaultRule true (FBoolean true)] = EFault.
Proof. reflexivity. Qed.

Print Assumptions readable_group_condition_refines_boolean.
Print Assumptions readable_called_group_condition_refines_boolean.
Print Assumptions negation_preserves_fault.
Print Assumptions and_short_circuits_false.
Print Assumptions or_short_circuits_true.
Print Assumptions faulting_rule_prevents_later_allow.
Print Assumptions group_permission_faults.
Print Assumptions called_group_permission_faults.
Print Assumptions false_and_does_not_touch_group.
Print Assumptions true_or_does_not_touch_group.
Print Assumptions group_fault_is_not_later_allow.
