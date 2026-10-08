(*
  NeoOS formal verification -- fault-aware WitnessRule refinement.

  This module closes the structural correspondence between the executable,
  fault-aware evaluator and the Boolean rule model for finite condition trees
  and rule lists. Parser-admissible inputs receive a constructive uniform
  fuel certificate derived from their depth and fan-out bounds, provided the
  platform permission read succeeds. Fuel is an explicit termination
  certificate for this executable evaluator; this module is not a model of
  transaction decoding, cryptography, or the full
  ApplicationEngine.
*)
From Coq Require Import List Bool PeanoNat Lia.
Import ListNotations.

Inductive EvalResult : Type :=
| EValue : bool -> EvalResult
| EFault : EvalResult.

Record Context : Type := mkContext {
  read_states : bool;
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

Fixpoint member_nat (value : nat) (values : list nat) : bool :=
  match values with
  | [] => false
  | head :: tail => if Nat.eqb value head then true else member_nat value tail
  end.

Definition called_by_entry (ctx : Context) : bool :=
  Nat.leb (call_depth ctx) 1.

Fixpoint eval_condition (ctx : Context) (condition : Condition) : bool :=
  match condition with
  | CBoolean value => value
  | CNot expression => negb (eval_condition ctx expression)
  | CAnd expressions => forallb (eval_condition ctx) expressions
  | COr expressions => existsb (eval_condition ctx) expressions
  | CScriptHash hash => Nat.eqb (current_script ctx) hash
  | CGroup group => member_nat group (current_groups ctx)
  | CCalledByEntry => called_by_entry ctx
  | CCalledByContract hash =>
      match calling_script ctx with
      | Some caller => Nat.eqb caller hash
      | None => false
      end
  | CCalledByGroup group => member_nat group (calling_groups ctx)
  end.

Fixpoint eval_rules (ctx : Context) (rules : list Rule) : bool :=
  match rules with
  | [] => false
  | rule :: rest =>
      if eval_condition ctx (rule_condition rule)
      then rule_allow rule
      else eval_rules ctx rest
  end.

Definition group_result (ctx : Context) (group : nat) : EvalResult :=
  if read_states ctx
  then EValue (member_nat group (current_groups ctx))
  else EFault.

Definition called_group_result (ctx : Context) (group : nat) : EvalResult :=
  if read_states ctx
  then EValue (member_nat group (calling_groups ctx))
  else EFault.

Fixpoint eval_fault_condition (fuel : nat) (ctx : Context)
    (condition : Condition) : EvalResult :=
  match fuel with
  | 0 => EFault
  | S fuel' =>
      match condition with
      | CBoolean value => EValue value
      | CNot expression =>
          match eval_fault_condition fuel' ctx expression with
          | EValue value => EValue (negb value)
          | EFault => EFault
          end
      | CAnd expressions => eval_fault_and fuel' ctx expressions
      | COr expressions => eval_fault_or fuel' ctx expressions
      | CScriptHash hash => EValue (Nat.eqb (current_script ctx) hash)
      | CGroup group => group_result ctx group
      | CCalledByEntry => EValue (called_by_entry ctx)
      | CCalledByContract hash =>
          match calling_script ctx with
          | Some caller => EValue (Nat.eqb caller hash)
          | None => EValue false
          end
      | CCalledByGroup group => called_group_result ctx group
      end
  end
with eval_fault_and (fuel : nat) (ctx : Context)
    (expressions : list Condition) : EvalResult :=
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
with eval_fault_or (fuel : nat) (ctx : Context)
    (expressions : list Condition) : EvalResult :=
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

Fixpoint eval_fault_rules (fuel : nat) (ctx : Context)
    (rules : list Rule) : EvalResult :=
  match fuel with
  | 0 => EFault
  | S fuel' =>
      match rules with
      | [] => EValue false
      | rule :: rest =>
          match eval_fault_condition fuel' ctx (rule_condition rule) with
          | EFault => EFault
          | EValue true => EValue (rule_allow rule)
          | EValue false => eval_fault_rules fuel' ctx rest
          end
      end
  end.

Inductive ListKind : Type :=
| AndKind
| OrKind.

Inductive Walker : Type :=
| WCondition : Condition -> Walker
| WConditionList : ListKind -> list Condition -> Walker
| WRules : list Rule -> Walker.

Definition eval_walker (fuel : nat) (ctx : Context) (walker : Walker) : EvalResult :=
  match walker with
  | WCondition condition => eval_fault_condition fuel ctx condition
  | WConditionList AndKind expressions => eval_fault_and fuel ctx expressions
  | WConditionList OrKind expressions => eval_fault_or fuel ctx expressions
  | WRules rules => eval_fault_rules fuel ctx rules
  end.

Definition plain_walker (ctx : Context) (walker : Walker) : bool :=
  match walker with
  | WCondition condition => eval_condition ctx condition
  | WConditionList AndKind expressions => forallb (eval_condition ctx) expressions
  | WConditionList OrKind expressions => existsb (eval_condition ctx) expressions
  | WRules rules => eval_rules ctx rules
  end.

(* A certificate records enough fuel for a finite tree.  A sibling list
   consumes one unit per element, while every child receives the same
   predecessor fuel; this exactly mirrors eval_fault_and/eval_fault_or. *)
Inductive Enough : nat -> Walker -> Prop :=
| enough_boolean : forall fuel value,
    Enough (S fuel) (WCondition (CBoolean value))
| enough_not : forall fuel expression,
    Enough fuel (WCondition expression) ->
    Enough (S fuel) (WCondition (CNot expression))
| enough_and : forall fuel expressions,
    Enough fuel (WConditionList AndKind expressions) ->
    Enough (S fuel) (WCondition (CAnd expressions))
| enough_or : forall fuel expressions,
    Enough fuel (WConditionList OrKind expressions) ->
    Enough (S fuel) (WCondition (COr expressions))
| enough_script_hash : forall fuel hash,
    Enough (S fuel) (WCondition (CScriptHash hash))
| enough_group : forall fuel group,
    Enough (S fuel) (WCondition (CGroup group))
| enough_called_by_entry : forall fuel,
    Enough (S fuel) (WCondition CCalledByEntry)
| enough_called_by_contract : forall fuel hash,
    Enough (S fuel) (WCondition (CCalledByContract hash))
| enough_called_by_group : forall fuel group,
    Enough (S fuel) (WCondition (CCalledByGroup group))
| enough_and_list_nil : forall fuel,
    Enough (S fuel) (WConditionList AndKind [])
| enough_and_list_cons : forall fuel expression rest,
    Enough fuel (WCondition expression) ->
    Enough fuel (WConditionList AndKind rest) ->
    Enough (S fuel) (WConditionList AndKind (expression :: rest))
| enough_or_list_nil : forall fuel,
    Enough (S fuel) (WConditionList OrKind [])
| enough_or_list_cons : forall fuel expression rest,
    Enough fuel (WCondition expression) ->
    Enough fuel (WConditionList OrKind rest) ->
    Enough (S fuel) (WConditionList OrKind (expression :: rest))
| enough_rules_nil : forall fuel,
    Enough (S fuel) (WRules [])
| enough_rules_cons : forall fuel rule rest,
    Enough fuel (WCondition (rule_condition rule)) ->
    Enough fuel (WRules rest) ->
    Enough (S fuel) (WRules (rule :: rest)).

(* The parser-bound certificate below removes the existential gap in the
   executable refinement.  It is derived from the same finite shape predicate
   used by the protocol parser model: leaves require positive depth, compound
   nodes require a non-empty list of at most sixteen children, and children
   consume one depth level.  It does not claim correspondence with the full
   NeoVM parser or ApplicationEngine. *)
Fixpoint parser_condition_admissible (depth : nat) (condition : Condition) : bool :=
  match condition with
  | CBoolean _ | CScriptHash _ | CGroup _ | CCalledByEntry
  | CCalledByContract _ | CCalledByGroup _ => (1 <=? depth)
  | CNot expression => (1 <=? depth) && parser_condition_admissible (depth - 1) expression
  | CAnd expressions | COr expressions =>
      (1 <=? depth) &&
      (0 <? length expressions) &&
      (length expressions <=? 16) &&
      forallb (parser_condition_admissible (depth - 1)) expressions
  end.

Fixpoint uniform_condition_fuel (depth : nat) : nat :=
  match depth with
  | 0 => 1
  | S predecessor => S (16 + uniform_condition_fuel predecessor)
  end.

Definition parser_rules_admissible (rules : list Rule) : bool :=
  forallb (fun rule => parser_condition_admissible 3 (rule_condition rule)) rules.

Lemma readable_walker_refines_boolean :
  forall fuel walker ctx,
    Enough fuel walker ->
    read_states ctx = true ->
    eval_walker fuel ctx walker = EValue (plain_walker ctx walker).
Proof.
  intros fuel walker ctx HEnough HRead.
  induction HEnough as
    [ fuel value
    | fuel expression HChild IH
    | fuel expressions HChildren IH
    | fuel expressions HChildren IH
    | fuel hash
    | fuel group
    | fuel
    | fuel hash
    | fuel group
    | fuel
    | fuel expression rest HExpression IHExpression HRest IHRest
    | fuel
    | fuel expression rest HExpression IHExpression HRest IHRest
    | fuel
    | fuel rule rest HCondition IHCondition HRest IHRest ].
  - cbn [eval_walker plain_walker]. reflexivity.
  - simpl in *.
    rewrite IH. reflexivity.
  - simpl. apply IH; assumption.
  - simpl. apply IH; assumption.
  - cbn [eval_walker plain_walker]. reflexivity.
  - simpl. unfold group_result. rewrite HRead. reflexivity.
  - cbn [eval_walker plain_walker]. reflexivity.
  - cbn [eval_walker plain_walker eval_fault_condition eval_condition].
    destruct (calling_script ctx); reflexivity.
  - simpl. unfold called_group_result. rewrite HRead. reflexivity.
  - reflexivity.
  - simpl in IHExpression, IHRest. simpl. rewrite IHExpression.
    destruct (eval_condition ctx expression); simpl.
    + rewrite IHRest. reflexivity.
    + reflexivity.
  - reflexivity.
  - simpl in IHExpression, IHRest. simpl. rewrite IHExpression.
    destruct (eval_condition ctx expression); simpl.
    + reflexivity.
    + rewrite IHRest. reflexivity.
  - reflexivity.
  - simpl in IHCondition, IHRest. simpl. rewrite IHCondition.
    destruct (eval_condition ctx (rule_condition rule)); simpl.
    + reflexivity.
    + rewrite IHRest. reflexivity.
Qed.

Theorem readable_condition_tree_has_no_spurious_fault :
  forall fuel condition ctx,
    Enough fuel (WCondition condition) ->
    read_states ctx = true ->
    eval_fault_condition fuel ctx condition =
      EValue (eval_condition ctx condition).
Proof.
  intros fuel condition ctx HEnough HRead.
  change (eval_walker fuel ctx (WCondition condition) =
    EValue (plain_walker ctx (WCondition condition))).
  apply readable_walker_refines_boolean; assumption.
Qed.

Theorem readable_rule_list_has_no_spurious_fault :
  forall fuel rules ctx,
    Enough fuel (WRules rules) ->
    read_states ctx = true ->
    eval_fault_rules fuel ctx rules = EValue (eval_rules ctx rules).
Proof.
  intros fuel rules ctx HEnough HRead.
  change (eval_walker fuel ctx (WRules rules) = EValue (plain_walker ctx (WRules rules))).
  apply readable_walker_refines_boolean; assumption.
Qed.

Example readable_nested_tree_refines :
  eval_fault_condition 7
    (mkContext true 9 (Some 4) 1 [7] [6])
    (CAnd [CBoolean true; COr [CGroup 7; CCalledByContract 4]]) =
    EValue (eval_condition (mkContext true 9 (Some 4) 1 [7] [6])
      (CAnd [CBoolean true; COr [CGroup 7; CCalledByContract 4]])).
Proof. vm_compute. reflexivity. Qed.

Example unreadable_group_is_the_only_fault_boundary :
  eval_fault_condition 1
    (mkContext false 9 None 0 [] []) (CGroup 7) = EFault.
Proof. vm_compute. reflexivity. Qed.

Example unreadable_negation_propagates_fault :
  eval_fault_condition 2
    (mkContext false 9 None 0 [] []) (CNot (CGroup 7)) = EFault.
Proof. vm_compute. reflexivity. Qed.

Lemma uniform_condition_fuel_positive :
  forall depth, uniform_condition_fuel depth <> 0.
Proof.
  intros depth. destruct depth; simpl; discriminate.
Qed.

Lemma enough_weaken :
  forall fuel walker, Enough fuel walker -> forall extra,
    Enough (fuel + extra) walker.
Proof.
  intros fuel walker HEnough.
  induction HEnough as
    [ fuel value
    | fuel expression HChild IHChild
    | fuel expressions HChildren IHChildren
    | fuel expressions HChildren IHChildren
    | fuel hash
    | fuel group
    | fuel
    | fuel hash
    | fuel group
    | fuel
    | fuel expression rest HExpression IHExpression HRest IHRest
    | fuel
    | fuel expression rest HExpression IHExpression HRest IHRest
    | fuel
    | fuel rule rest HRule IHRule HRest IHRest ].
  all: intros extra; simpl.
  - apply enough_boolean.
  - apply enough_not. apply IHChild.
  - apply enough_and. apply IHChildren.
  - apply enough_or. apply IHChildren.
  - apply enough_script_hash.
  - apply enough_group.
  - apply enough_called_by_entry.
  - apply enough_called_by_contract.
  - apply enough_called_by_group.
  - apply enough_and_list_nil.
  - apply enough_and_list_cons.
    + apply IHExpression.
    + apply IHRest.
  - apply enough_or_list_nil.
  - apply enough_or_list_cons.
    + apply IHExpression.
    + apply IHRest.
  - apply enough_rules_nil.
  - apply enough_rules_cons.
    + apply IHRule.
    + apply IHRest.
Qed.

Lemma enough_condition_list_by_length :
  forall kind fuel expressions,
    fuel <> 0 ->
    Forall (fun expression => Enough fuel (WCondition expression)) expressions ->
    Enough (length expressions + fuel) (WConditionList kind expressions).
Proof.
  intros kind fuel expressions HPositive HChildren.
  induction HChildren as [|expression rest HExpression HRest IH].
  - simpl. destruct fuel; [contradiction|].
    destruct kind; constructor.
  - simpl. assert (HChild : Enough (length rest + fuel) (WCondition expression)).
    { rewrite Nat.add_comm. apply enough_weaken. exact HExpression. }
    destruct kind; constructor; assumption.
Qed.

Lemma enough_condition_list_bounded :
  forall kind fuel expressions,
    fuel <> 0 -> length expressions <= 16 ->
    Forall (fun expression => Enough fuel (WCondition expression)) expressions ->
    Enough (16 + fuel) (WConditionList kind expressions).
Proof.
  intros kind fuel expressions HPositive HLength HChildren.
  pose proof (enough_condition_list_by_length kind fuel expressions
    HPositive HChildren) as HBase.
  pose proof (enough_weaken _ _ HBase (16 - length expressions)) as HWide.
  replace (length expressions + fuel + (16 - length expressions)) with
    (16 + fuel) in HWide by lia.
  exact HWide.
Qed.

Theorem parser_admissible_condition_has_uniform_fuel :
  forall depth condition,
    parser_condition_admissible depth condition = true ->
    Enough (uniform_condition_fuel depth) (WCondition condition).
Proof.
  induction depth as [|depth IH]; intros condition H;
    destruct condition as [value|expression|expressions|expressions|hash|group| |hash|group].
  all: simpl in H; try discriminate.
  all: try apply enough_boolean; try apply enough_script_hash;
    try apply enough_group; try apply enough_called_by_entry;
    try apply enough_called_by_contract; try apply enough_called_by_group.
  - rewrite Nat.sub_0_r in H. apply enough_not.
    pose proof (enough_weaken _ _ (IH expression H) 16) as HChild.
    rewrite Nat.add_comm in HChild. exact HChild.
  - apply andb_prop in H as [HBounds HChildren].
    apply andb_prop in HBounds as [HNonempty HLength].
    apply Nat.leb_le in HLength. rewrite Nat.sub_0_r in HChildren.
    apply enough_and. apply enough_condition_list_bounded.
    + apply uniform_condition_fuel_positive.
    + exact HLength.
    + apply Forall_forall. intros child HIn. apply IH.
      exact (proj1 (forallb_forall _ _) HChildren child HIn).
  - apply andb_prop in H as [HBounds HChildren].
    apply andb_prop in HBounds as [HNonempty HLength].
    apply Nat.leb_le in HLength. rewrite Nat.sub_0_r in HChildren.
    apply enough_or. apply enough_condition_list_bounded.
    + apply uniform_condition_fuel_positive.
    + exact HLength.
    + apply Forall_forall. intros child HIn. apply IH.
      exact (proj1 (forallb_forall _ _) HChildren child HIn).
Qed.

Theorem parser_admissible_rule_list_has_uniform_fuel :
  forall rules,
    parser_rules_admissible rules = true ->
    Enough (length rules + uniform_condition_fuel 3) (WRules rules).
Proof.
  intros rules H. unfold parser_rules_admissible in H.
  induction rules as [|rule rest IH].
  - simpl. apply enough_rules_nil.
  - simpl in H. apply andb_prop in H as [HRule HRest].
    change (Enough (S (length rest + uniform_condition_fuel 3))
      (WRules (rule :: rest))).
    apply enough_rules_cons.
    + rewrite Nat.add_comm. apply enough_weaken.
      apply parser_admissible_condition_has_uniform_fuel. exact HRule.
    + apply IH. exact HRest.
Qed.

Theorem parser_readable_condition_refines_boolean :
  forall depth condition ctx,
    parser_condition_admissible depth condition = true ->
    read_states ctx = true ->
    eval_fault_condition (uniform_condition_fuel depth) ctx condition =
      EValue (eval_condition ctx condition).
Proof.
  intros depth condition ctx HAdmissible HRead.
  apply readable_condition_tree_has_no_spurious_fault.
  - apply parser_admissible_condition_has_uniform_fuel. exact HAdmissible.
  - exact HRead.
Qed.

Theorem parser_readable_rules_refine_boolean :
  forall rules ctx,
    parser_rules_admissible rules = true ->
    read_states ctx = true ->
    eval_fault_rules (length rules + uniform_condition_fuel 3) ctx rules =
      EValue (eval_rules ctx rules).
Proof.
  intros rules ctx HAdmissible HRead.
  apply readable_rule_list_has_no_spurious_fault.
  - apply parser_admissible_rule_list_has_uniform_fuel. exact HAdmissible.
  - exact HRead.
Qed.

Example parser_rejects_empty_compound :
  parser_condition_admissible 3 (CAnd []) = false /\
  parser_condition_admissible 3 (COr []) = false.
Proof. vm_compute. split; reflexivity. Qed.

Example parser_rejects_seventeen_children :
  parser_condition_admissible 3 (CAnd (repeat (CBoolean true) 17)) = false /\
  parser_condition_admissible 3 (COr (repeat (CBoolean false) 17)) = false.
Proof. vm_compute. split; reflexivity. Qed.

Example parser_rejects_fourth_level :
  parser_condition_admissible 3 (CNot (CNot (CNot (CBoolean true)))) = false /\
  parser_rules_admissible [mkRule true (CNot (CNot (CNot (CBoolean true))))] = false.
Proof. vm_compute. split; reflexivity. Qed.

Example parser_rejects_zero_depth :
  parser_condition_admissible 0 (CBoolean true) = false /\
  parser_condition_admissible 0 (CCalledByEntry) = false.
Proof. vm_compute. split; reflexivity. Qed.

Example parser_accepts_full_width_depth_three :
  parser_condition_admissible 3
    (CAnd (repeat (COr (repeat (CBoolean false) 16)) 16)) = true.
Proof. vm_compute. reflexivity. Qed.

(* The first fifteen rules do not match. The final conjunction visits all
   sixteen children before the final rule allows the witness. *)
Example full_width_rule_list_refines :
  let condition := CAnd (repeat (CNot (CBoolean false)) 16) in
  let rules := repeat (mkRule false (CNot (CBoolean true))) 15 ++
    [mkRule true condition] in
  let ctx := mkContext true 9 None 0 [] [] in
  eval_fault_rules 68 ctx rules = EValue (eval_rules ctx rules) /\
  eval_rules ctx rules = true.
Proof. vm_compute. split; reflexivity. Qed.

Example full_width_nested_condition_refines :
  let condition := CAnd (repeat (COr
    (repeat (CBoolean false) 15 ++ [CBoolean true])) 16) in
  let ctx := mkContext true 9 None 0 [] [] in
  eval_fault_condition 52 ctx condition = EValue true.
Proof. vm_compute. reflexivity. Qed.

Print Assumptions readable_walker_refines_boolean.
Print Assumptions readable_condition_tree_has_no_spurious_fault.
Print Assumptions readable_rule_list_has_no_spurious_fault.
Print Assumptions readable_nested_tree_refines.
Print Assumptions unreadable_group_is_the_only_fault_boundary.
Print Assumptions unreadable_negation_propagates_fault.
Print Assumptions uniform_condition_fuel_positive.
Print Assumptions enough_weaken.
Print Assumptions enough_condition_list_by_length.
Print Assumptions enough_condition_list_bounded.
Print Assumptions parser_admissible_condition_has_uniform_fuel.
Print Assumptions parser_admissible_rule_list_has_uniform_fuel.
Print Assumptions parser_readable_condition_refines_boolean.
Print Assumptions parser_readable_rules_refine_boolean.
Print Assumptions parser_rejects_empty_compound.
Print Assumptions parser_rejects_seventeen_children.
Print Assumptions parser_rejects_fourth_level.
Print Assumptions parser_rejects_zero_depth.
Print Assumptions parser_accepts_full_width_depth_three.
Print Assumptions full_width_rule_list_refines.
Print Assumptions full_width_nested_condition_refines.
