(* Public pure-method reference semantics. Extends the frozen decoder only for
   PUSHT; preserves the existing VM operations except explicit equality limits. *)
From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import IntegerSemantics CapArithmetic CapMethodVm.
Import ListNotations.
Open Scope Z_scope.

Definition comparable_limit : Z := 65536.
Definition byte_value_ok bytes := forallb (fun b => (b <=? 255)%nat) bytes.
Definition typed_string_argument v :=
 match v with
 | VBytes bytes => byte_value_ok bytes = true /\ Z.of_nat (length bytes) <= comparable_limit
 | VNull => True
 | _ => False end.
Definition comparison_allowed lhs rhs :=
 match lhs,rhs with
 | VBytes a,VBytes b => (0 <? comparable_limit) &&
     (Z.of_nat (length a) <=? comparable_limit) && (Z.of_nat (length b) <=? comparable_limit)
 | _,_ => true end.
Definition limited_equal lhs rhs :=
 if comparison_allowed lhs rhs then Some (value_eqb lhs rhs) else None.

Inductive PureExpr := PBytes : list nat -> PureExpr | PArgument : PureExpr
 | PStringEq : PureExpr -> PureExpr -> PureExpr | POr : PureExpr -> PureExpr -> PureExpr.
Fixpoint eval_pure (equal : Value -> Value -> option bool) expression argument : option Value :=
 match expression with
 | PBytes bytes => Some (VBytes bytes)
 | PArgument => Some argument
 | PStringEq a b =>
   match eval_pure equal a argument,eval_pure equal b argument with
   | Some lhs,Some rhs => match equal lhs rhs with Some b => Some (VBool b) | None => None end
   | _,_ => None end
 | POr a b =>
   match eval_pure equal a argument with
   | Some (VBool true) => Some (VBool true)
   | Some (VBool false) => eval_pure equal b argument
   | _ => None end end.
Definition source_eval := eval_pure (fun lhs rhs => Some (value_eqb lhs rhs)).
Definition budget_eval := eval_pure limited_equal.

Definition decode_public code p :=
 match skipn p code with
 | 8%nat::_ => Some (Push (VBool true),1%nat)
 | _ => decode code p end.
Lemma decoder_existing_subset : forall code p,
 (match skipn p code with 8%nat::_ => False | _ => True end) ->
 decode_public code p = decode code p.
Proof. intros code p H. unfold decode_public. destruct (skipn p code) as [|head tail];
 [reflexivity|]. destruct head as [|head]; [reflexivity|].
 do 7 (destruct head as [|head]; [reflexivity|]).
 destruct head as [|head]; [contradiction|reflexivity]. Qed.
Print Assumptions decoder_existing_subset.
Lemma decoder_pusht : forall rest, decode_public (8%nat::rest) 0 = Some (Push (VBool true),1%nat).
Proof. reflexivity. Qed.
Print Assumptions decoder_pusht.

Definition step_public instruction width s :=
 match instruction,stack s with
 | Equal _,rhs::lhs::_ => if comparison_allowed lhs rhs then vm_step instruction width s else Fault s
 | _,_ => vm_step instruction width s end.
Lemma step_existing_subset : forall instruction width s,
 (match instruction,stack s with Equal _,rhs::lhs::_ => comparison_allowed lhs rhs = true | _,_ => True end) ->
 step_public instruction width s = vm_step instruction width s.
Proof. intros instruction width s H. unfold step_public.
 destruct instruction; try reflexivity.
 destruct (stack s) as [|rhs [|lhs rest]]; try reflexivity. rewrite H. reflexivity. Qed.
Print Assumptions step_existing_subset.

Fixpoint run_public fuel code s :=
 match fuel with O => Timeout s | S n =>
 match decode_public code (pc s) with
 | None => Fault s
 | Some (instruction,width) => match step_public instruction width s with
   | Continue next => run_public n code next | terminal => terminal end end end.
Definition initial_public (inputs : list Value) (static_values : nat -> option Value)
 (objects : list Object) (stored : Value) := state 0 inputs [] [] objects stored [] static_values.
Definition public_value outcome : option Value :=
 match outcome with Halt result _ => Some result | _ => None end.
Definition public_frame_preserved outcome before :=
 match outcome with
 | Halt _ after => heap after = heap before /\ storage after = storage before /\
                   effects after = effects before /\ statics after = statics before
 | _ => False end.
Lemma run_public_one_step : forall fuel code s,
 run_public (S fuel) code s =
 match decode_public code (pc s) with
 | None => Fault s
 | Some (instruction,width) => match step_public instruction width s with
   | Continue next => run_public fuel code next | terminal => terminal end end.
Proof. reflexivity. Qed.
Print Assumptions run_public_one_step.
Lemma non_string_comparison_false : forall v bytes,
 (match v with VBytes _ => False | _ => True end) ->
 limited_equal v (VBytes bytes) = Some false.
Proof. intros v bytes H. destruct v; cbn [limited_equal comparison_allowed value_eqb];
 try reflexivity. contradiction. Qed.
Print Assumptions non_string_comparison_false.

Definition value_comparable v := match v with VBytes bytes => Z.of_nat (length bytes) <= comparable_limit | _ => True end.
Fixpoint literals_comparable expression :=
 match expression with PBytes bytes => Z.of_nat (length bytes) <= comparable_limit
 | PArgument => True | PStringEq a b | POr a b => literals_comparable a /\ literals_comparable b end.
Lemma comparison_allowed_comparable : forall lhs rhs,
 value_comparable lhs -> value_comparable rhs -> comparison_allowed lhs rhs = true.
Proof.
 intros lhs rhs Hlhs Hrhs. destruct lhs; destruct rhs;
 cbn [value_comparable comparison_allowed] in *; try reflexivity.
 apply Z.leb_le in Hlhs. apply Z.leb_le in Hrhs. rewrite Hlhs,Hrhs.
 vm_compute. reflexivity.
Qed.
Print Assumptions comparison_allowed_comparable.
Lemma source_result_comparable : forall expression argument value,
 literals_comparable expression -> value_comparable argument ->
 source_eval expression argument = Some value -> value_comparable value.
Proof.
 induction expression as [bytes| |a IHa b IHb|a IHa b IHb]; intros argument value Hliteral Harg Hresult.
 - cbn [source_eval eval_pure] in Hresult. inversion Hresult; subst. exact Hliteral.
 - cbn [source_eval eval_pure] in Hresult. inversion Hresult; subst. exact Harg.
 - cbn [source_eval eval_pure] in Hresult.
   destruct (source_eval a argument);
   destruct (source_eval b argument); try discriminate.
   inversion Hresult; subst. exact I.
 - cbn [source_eval eval_pure] in Hresult.
   destruct (source_eval a argument) as [left|] eqn:Hleft; try discriminate.
   destruct left as [z|boolean| |bytes|buffer|ref| |kind values]; try discriminate.
   destruct boolean.
   + inversion Hresult; subst. exact I.
   + apply (IHb argument value); [exact (proj2 Hliteral)|exact Harg|exact Hresult].
Qed.
Print Assumptions source_result_comparable.
Lemma budget_eval_refines_source : forall expression argument,
 literals_comparable expression -> value_comparable argument ->
 budget_eval expression argument = source_eval expression argument.
Proof.
 induction expression as [bytes| |a IHa b IHb|a IHa b IHb]; intros argument Hliteral Harg; try reflexivity.
 - destruct Hliteral as [Ha Hb].
   cbn [budget_eval source_eval eval_pure].
   rewrite (IHa argument Ha Harg),(IHb argument Hb Harg).
   destruct (source_eval a argument) as [lhs|] eqn:El;
   destruct (source_eval b argument) as [rhs|] eqn:Er; try reflexivity.
   unfold limited_equal.
   rewrite comparison_allowed_comparable.
   + reflexivity.
   + exact (source_result_comparable a argument lhs Ha Harg El).
   + exact (source_result_comparable b argument rhs Hb Harg Er).
 - destruct Hliteral as [Ha Hb]. cbn [budget_eval source_eval eval_pure].
   rewrite (IHa argument Ha Harg),(IHb argument Hb Harg). reflexivity.
Qed.
Print Assumptions budget_eval_refines_source.
Lemma typed_string_is_comparable : forall value,
 typed_string_argument value -> value_comparable value.
Proof. intros value H. destruct value; cbn [typed_string_argument value_comparable] in *; tauto. Qed.
Print Assumptions typed_string_is_comparable.
Definition environment_preserved after before :=
 heap after = heap before /\ storage after = storage before /\
 effects after = effects before /\ statics after = statics before.
Definition return_frame_preserved after before :=
 environment_preserved after before /\ stack after = [] /\ locals after = [] /\ arguments after = stack before.
Definition public_classified expected outcome before :=
 match expected,outcome with
 | Some value,Halt actual after => actual = value /\ return_frame_preserved after before
 | None,Fault after => environment_preserved after before
 | _,_ => False end.
Definition terminal_public outcome := match outcome with Halt _ _ | Fault _ => True | _ => False end.
Lemma classification_value : forall expected outcome before,
 public_classified expected outcome before -> public_value outcome = expected.
Proof. intros expected outcome before H. destruct expected; destruct outcome;
 cbn [public_classified public_value] in *; try contradiction.
 destruct H as [Hvalue Henv]. subst. reflexivity. reflexivity. Qed.
Print Assumptions classification_value.
Lemma classification_terminal : forall expected outcome before,
 public_classified expected outcome before -> terminal_public outcome.
Proof. intros expected outcome before H. destruct expected; destruct outcome;
 cbn [public_classified terminal_public] in *; tauto. Qed.
Print Assumptions classification_terminal.
Lemma classification_returns : forall value outcome before,
 public_classified (Some value) outcome before ->
 exists after, outcome = Halt value after /\ return_frame_preserved after before.
Proof. intros value outcome before H. destruct outcome;
 cbn [public_classified] in H; try contradiction.
 destruct H as [Hvalue Henv]. subst. eauto. Qed.
Print Assumptions classification_returns.
Lemma classification_faults : forall outcome before,
 public_classified None outcome before ->
 exists after, outcome = Fault after /\ environment_preserved after before.
Proof. intros outcome before H. destruct outcome;
 cbn [public_classified] in H; try contradiction. eauto. Qed.
Print Assumptions classification_faults.
