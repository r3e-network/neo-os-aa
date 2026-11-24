From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import IntegerSemantics CapArithmetic CapMethodVm PublicPureMethods.
Import ListNotations. Open Scope Z_scope.
Ltac pure_norm := cbv [public_classified return_frame_preserved environment_preserved public_value budget_eval source_eval eval_pure
 limited_equal comparison_allowed comparable_limit decode_public decode
 step_public vm_step initial_public with_stack change pc stack arguments locals heap
 storage effects statics jump_target signed_byte value_eqb
 firstn skipn nth_error length app repeat Nat.add Nat.sub Nat.mul Nat.eqb Nat.leb Nat.ltb
 Bool.eqb andb orb negb] in *.
Ltac pure_drive := repeat first [progress pure_norm
 | multimatch goal with H : ?lhs = ?rhs |- _ => progress rewrite H end
 | match goal with |- context[Z.to_nat ?z] => let n := eval vm_compute in (Z.to_nat z) in progress change (Z.to_nat z) with n end
 | rewrite run_public_one_step].
Definition getAccountImplementationId_code := [12%nat;38%nat;111%nat;114%nat;103%nat;46%nat;114%nat;51%nat;101%nat;46%nat;110%nat;101%nat;111%nat;46%nat;97%nat;97%nat;46%nat;117%nat;110%nat;105%nat;102%nat;105%nat;101%nat;100%nat;45%nat;115%nat;109%nat;97%nat;114%nat;116%nat;45%nat;119%nat;97%nat;108%nat;108%nat;101%nat;116%nat;46%nat;118%nat;51%nat;34%nat;2%nat;64%nat].
Definition getAccountImplementationId_source := (PBytes [111%nat;114%nat;103%nat;46%nat;114%nat;51%nat;101%nat;46%nat;110%nat;101%nat;111%nat;46%nat;97%nat;97%nat;46%nat;117%nat;110%nat;105%nat;102%nat;105%nat;101%nat;100%nat;45%nat;115%nat;109%nat;97%nat;114%nat;116%nat;45%nat;119%nat;97%nat;108%nat;108%nat;101%nat;116%nat;46%nat;118%nat;51%nat]).
Theorem getAccountImplementationId_execution_classified : forall input static_values objects stored,
 public_classified (budget_eval getAccountImplementationId_source input)
 (run_public 24 getAccountImplementationId_code (initial_public [] static_values objects stored))
 (initial_public [] static_values objects stored).
Proof. intros. unfold getAccountImplementationId_code, getAccountImplementationId_source.
pure_drive. repeat split; reflexivity. Qed.
Print Assumptions getAccountImplementationId_execution_classified.

Theorem getAccountImplementationId_budget_reference : forall input static_values objects stored,
 public_value (run_public 24 getAccountImplementationId_code (initial_public [] static_values objects stored)) = budget_eval getAccountImplementationId_source input.
Proof. intros. eapply classification_value. apply getAccountImplementationId_execution_classified. Qed.
Print Assumptions getAccountImplementationId_budget_reference.
Theorem getAccountImplementationId_source_domain : forall input,
 typed_string_argument input -> budget_eval getAccountImplementationId_source input = source_eval getAccountImplementationId_source input.
Proof. intros input Htyped. apply budget_eval_refines_source.
- unfold getAccountImplementationId_source. vm_compute. repeat split; congruence.
- apply typed_string_is_comparable. exact Htyped. Qed.
Print Assumptions getAccountImplementationId_source_domain.
Theorem getAccountImplementationId_source_refinement : forall input static_values objects stored,
 typed_string_argument input -> public_classified (source_eval getAccountImplementationId_source input) (run_public 24 getAccountImplementationId_code (initial_public [] static_values objects stored)) (initial_public [] static_values objects stored).
Proof. intros. rewrite <- getAccountImplementationId_source_domain by assumption. apply getAccountImplementationId_execution_classified. Qed.
Print Assumptions getAccountImplementationId_source_refinement.
Theorem getAccountImplementationId_no_timeout : forall (input : Value) static_values objects stored,
 terminal_public (run_public 24 getAccountImplementationId_code (initial_public [] static_values objects stored)).
Proof. intros input static_values objects stored. exact (classification_terminal (budget_eval getAccountImplementationId_source input) (run_public 24 getAccountImplementationId_code (initial_public [] static_values objects stored)) (initial_public [] static_values objects stored) (getAccountImplementationId_execution_classified input static_values objects stored)). Qed.
Print Assumptions getAccountImplementationId_no_timeout.
Theorem getAccountImplementationId_source_total : forall input, exists value, source_eval getAccountImplementationId_source input = Some value.
Proof. intros. unfold getAccountImplementationId_source.
eexists. reflexivity. Qed.
Print Assumptions getAccountImplementationId_source_total.
Theorem getAccountImplementationId_source_halts_preserves_frame : forall input static_values objects stored,
 typed_string_argument input -> exists value after,
 source_eval getAccountImplementationId_source input = Some value /\ (run_public 24 getAccountImplementationId_code (initial_public [] static_values objects stored)) = Halt value after /\ return_frame_preserved after (initial_public [] static_values objects stored).
Proof. intros input static_values objects stored Htyped.
 destruct (getAccountImplementationId_source_total input) as [value Esource].
 pose proof (getAccountImplementationId_source_refinement input static_values objects stored Htyped) as Hrefine.
 rewrite Esource in Hrefine. apply classification_returns in Hrefine.
 destruct Hrefine as [after [Hrun Henv]]. exists value,after. auto. Qed.
Print Assumptions getAccountImplementationId_source_halts_preserves_frame.
Definition supportsExecutionMode_code := [87%nat;0%nat;1%nat;120%nat;12%nat;6%nat;115%nat;105%nat;110%nat;103%nat;108%nat;101%nat;151%nat;38%nat;5%nat;8%nat;34%nat;11%nat;120%nat;12%nat;5%nat;98%nat;97%nat;116%nat;99%nat;104%nat;151%nat;38%nat;5%nat;8%nat;34%nat;18%nat;120%nat;12%nat;12%nat;98%nat;97%nat;116%nat;99%nat;104%nat;45%nat;97%nat;116%nat;111%nat;109%nat;105%nat;99%nat;151%nat;34%nat;2%nat;64%nat].
Definition supportsExecutionMode_source := (POr (POr (PStringEq PArgument (PBytes [115%nat;105%nat;110%nat;103%nat;108%nat;101%nat])) (PStringEq PArgument (PBytes [98%nat;97%nat;116%nat;99%nat;104%nat]))) (PStringEq PArgument (PBytes [98%nat;97%nat;116%nat;99%nat;104%nat;45%nat;97%nat;116%nat;111%nat;109%nat;105%nat;99%nat]))).
Theorem supportsExecutionMode_execution_classified : forall input static_values objects stored,
 public_classified (budget_eval supportsExecutionMode_source input)
 (run_public 24 supportsExecutionMode_code (initial_public [input] static_values objects stored))
 (initial_public [input] static_values objects stored).
Proof. intros. unfold supportsExecutionMode_code, supportsExecutionMode_source.
assert (Hpositive : (0 <? 65536) = true) by (vm_compute; reflexivity).
assert (Hlen5 : (Z.of_nat 5 <=? 65536) = true) by (vm_compute; reflexivity).
assert (Hlen6 : (Z.of_nat 6 <=? 65536) = true) by (vm_compute; reflexivity).
assert (Hlen12 : (Z.of_nat 12 <=? 65536) = true) by (vm_compute; reflexivity).
destruct input as [z|boolean| |bytes|buffer|ref| |kind values].
- pure_drive; repeat split; reflexivity.
- pure_drive; repeat split; reflexivity.
- pure_drive; repeat split; reflexivity.
- destruct (Z.of_nat (length bytes) <=? 65536) eqn:Hsize.
all: destruct (bytes_eqb bytes [115%nat;105%nat;110%nat;103%nat;108%nat;101%nat]) eqn:H0.
all: destruct (bytes_eqb bytes [98%nat;97%nat;116%nat;99%nat;104%nat]) eqn:H1.
all: destruct (bytes_eqb bytes [98%nat;97%nat;116%nat;99%nat;104%nat;45%nat;97%nat;116%nat;111%nat;109%nat;105%nat;99%nat]) eqn:H2.
all: pure_drive; repeat split; reflexivity.
- pure_drive; repeat split; reflexivity.
- pure_drive; repeat split; reflexivity.
- pure_drive; repeat split; reflexivity.
- pure_drive; repeat split; reflexivity.
Qed.
Print Assumptions supportsExecutionMode_execution_classified.

Theorem supportsExecutionMode_budget_reference : forall input static_values objects stored,
 public_value (run_public 24 supportsExecutionMode_code (initial_public [input] static_values objects stored)) = budget_eval supportsExecutionMode_source input.
Proof. intros. eapply classification_value. apply supportsExecutionMode_execution_classified. Qed.
Print Assumptions supportsExecutionMode_budget_reference.
Theorem supportsExecutionMode_source_domain : forall input,
 typed_string_argument input -> budget_eval supportsExecutionMode_source input = source_eval supportsExecutionMode_source input.
Proof. intros input Htyped. apply budget_eval_refines_source.
- unfold supportsExecutionMode_source. vm_compute. repeat split; congruence.
- apply typed_string_is_comparable. exact Htyped. Qed.
Print Assumptions supportsExecutionMode_source_domain.
Theorem supportsExecutionMode_source_refinement : forall input static_values objects stored,
 typed_string_argument input -> public_classified (source_eval supportsExecutionMode_source input) (run_public 24 supportsExecutionMode_code (initial_public [input] static_values objects stored)) (initial_public [input] static_values objects stored).
Proof. intros. rewrite <- supportsExecutionMode_source_domain by assumption. apply supportsExecutionMode_execution_classified. Qed.
Print Assumptions supportsExecutionMode_source_refinement.
Theorem supportsExecutionMode_no_timeout : forall (input : Value) static_values objects stored,
 terminal_public (run_public 24 supportsExecutionMode_code (initial_public [input] static_values objects stored)).
Proof. intros input static_values objects stored. exact (classification_terminal (budget_eval supportsExecutionMode_source input) (run_public 24 supportsExecutionMode_code (initial_public [input] static_values objects stored)) (initial_public [input] static_values objects stored) (supportsExecutionMode_execution_classified input static_values objects stored)). Qed.
Print Assumptions supportsExecutionMode_no_timeout.
Theorem supportsExecutionMode_source_total : forall input, exists value, source_eval supportsExecutionMode_source input = Some value.
Proof. intros. unfold supportsExecutionMode_source.
destruct input as [z|boolean| |bytes|buffer|ref| |kind values]; try solve [pure_norm; eexists; reflexivity].
destruct (bytes_eqb bytes [115%nat;105%nat;110%nat;103%nat;108%nat;101%nat]) eqn:H0;
destruct (bytes_eqb bytes [98%nat;97%nat;116%nat;99%nat;104%nat]) eqn:H1;
destruct (bytes_eqb bytes [98%nat;97%nat;116%nat;99%nat;104%nat;45%nat;97%nat;116%nat;111%nat;109%nat;105%nat;99%nat]) eqn:H2;
pure_drive; eexists; reflexivity. Qed.
Print Assumptions supportsExecutionMode_source_total.
Theorem supportsExecutionMode_source_halts_preserves_frame : forall input static_values objects stored,
 typed_string_argument input -> exists value after,
 source_eval supportsExecutionMode_source input = Some value /\ (run_public 24 supportsExecutionMode_code (initial_public [input] static_values objects stored)) = Halt value after /\ return_frame_preserved after (initial_public [input] static_values objects stored).
Proof. intros input static_values objects stored Htyped.
 destruct (supportsExecutionMode_source_total input) as [value Esource].
 pose proof (supportsExecutionMode_source_refinement input static_values objects stored Htyped) as Hrefine.
 rewrite Esource in Hrefine. apply classification_returns in Hrefine.
 destruct Hrefine as [after [Hrun Henv]]. exists value,after. auto. Qed.
Print Assumptions supportsExecutionMode_source_halts_preserves_frame.
Theorem supportsExecutionMode_oversized_fault_preserves_frame : forall bytes static_values objects stored,
 comparable_limit < Z.of_nat (length bytes) -> exists after,
 (run_public 24 supportsExecutionMode_code (initial_public [VBytes bytes] static_values objects stored)) = Fault after /\
 environment_preserved after (initial_public [VBytes bytes] static_values objects stored).
Proof. intros bytes static_values objects stored Hsize.
 eapply classification_faults.
 pose proof (supportsExecutionMode_execution_classified (VBytes bytes) static_values objects stored) as Hclass.
 assert (Esize : (Z.of_nat (length bytes) <=? 65536) = false) by (apply Z.leb_gt; exact Hsize).
 assert (Epositive : (0 <? 65536) = true) by (vm_compute; reflexivity).
 unfold supportsExecutionMode_source in Hclass. pure_norm. rewrite Esize,Epositive in Hclass. pure_norm. exact Hclass. Qed.
Print Assumptions supportsExecutionMode_oversized_fault_preserves_frame.
Theorem supportsExecutionMode_missing_argument_fault : forall static_values objects stored,
 run_public 24 supportsExecutionMode_code (initial_public [] static_values objects stored) = Fault (initial_public [] static_values objects stored).
Proof. intros. unfold supportsExecutionMode_code. rewrite run_public_one_step. pure_norm. reflexivity. Qed.
Print Assumptions supportsExecutionMode_missing_argument_fault.
Theorem supportsExecutionMode_non_string_returns_false : forall input static_values objects stored,
 (match input with VBytes _ => False | _ => True end) ->
 public_value (run_public 24 supportsExecutionMode_code (initial_public [input] static_values objects stored)) = Some (VBool false).
Proof. intros input static_values objects stored Htag. rewrite supportsExecutionMode_budget_reference.
 unfold supportsExecutionMode_source. destruct input; pure_norm; try reflexivity; contradiction. Qed.
Print Assumptions supportsExecutionMode_non_string_returns_false.
Definition supportsModuleType_code := [87%nat;0%nat;1%nat;120%nat;12%nat;9%nat;118%nat;97%nat;108%nat;105%nat;100%nat;97%nat;116%nat;111%nat;114%nat;151%nat;38%nat;5%nat;8%nat;34%nat;14%nat;120%nat;12%nat;8%nat;118%nat;101%nat;114%nat;105%nat;102%nat;105%nat;101%nat;114%nat;151%nat;38%nat;5%nat;8%nat;34%nat;10%nat;120%nat;12%nat;4%nat;104%nat;111%nat;111%nat;107%nat;151%nat;34%nat;2%nat;64%nat].
Definition supportsModuleType_source := (POr (POr (PStringEq PArgument (PBytes [118%nat;97%nat;108%nat;105%nat;100%nat;97%nat;116%nat;111%nat;114%nat])) (PStringEq PArgument (PBytes [118%nat;101%nat;114%nat;105%nat;102%nat;105%nat;101%nat;114%nat]))) (PStringEq PArgument (PBytes [104%nat;111%nat;111%nat;107%nat]))).
Theorem supportsModuleType_execution_classified : forall input static_values objects stored,
 public_classified (budget_eval supportsModuleType_source input)
 (run_public 24 supportsModuleType_code (initial_public [input] static_values objects stored))
 (initial_public [input] static_values objects stored).
Proof. intros. unfold supportsModuleType_code, supportsModuleType_source.
assert (Hpositive : (0 <? 65536) = true) by (vm_compute; reflexivity).
assert (Hlen4 : (Z.of_nat 4 <=? 65536) = true) by (vm_compute; reflexivity).
assert (Hlen8 : (Z.of_nat 8 <=? 65536) = true) by (vm_compute; reflexivity).
assert (Hlen9 : (Z.of_nat 9 <=? 65536) = true) by (vm_compute; reflexivity).
destruct input as [z|boolean| |bytes|buffer|ref| |kind values].
- pure_drive; repeat split; reflexivity.
- pure_drive; repeat split; reflexivity.
- pure_drive; repeat split; reflexivity.
- destruct (Z.of_nat (length bytes) <=? 65536) eqn:Hsize.
all: destruct (bytes_eqb bytes [118%nat;97%nat;108%nat;105%nat;100%nat;97%nat;116%nat;111%nat;114%nat]) eqn:H0.
all: destruct (bytes_eqb bytes [118%nat;101%nat;114%nat;105%nat;102%nat;105%nat;101%nat;114%nat]) eqn:H1.
all: destruct (bytes_eqb bytes [104%nat;111%nat;111%nat;107%nat]) eqn:H2.
all: pure_drive; repeat split; reflexivity.
- pure_drive; repeat split; reflexivity.
- pure_drive; repeat split; reflexivity.
- pure_drive; repeat split; reflexivity.
- pure_drive; repeat split; reflexivity.
Qed.
Print Assumptions supportsModuleType_execution_classified.

Theorem supportsModuleType_budget_reference : forall input static_values objects stored,
 public_value (run_public 24 supportsModuleType_code (initial_public [input] static_values objects stored)) = budget_eval supportsModuleType_source input.
Proof. intros. eapply classification_value. apply supportsModuleType_execution_classified. Qed.
Print Assumptions supportsModuleType_budget_reference.
Theorem supportsModuleType_source_domain : forall input,
 typed_string_argument input -> budget_eval supportsModuleType_source input = source_eval supportsModuleType_source input.
Proof. intros input Htyped. apply budget_eval_refines_source.
- unfold supportsModuleType_source. vm_compute. repeat split; congruence.
- apply typed_string_is_comparable. exact Htyped. Qed.
Print Assumptions supportsModuleType_source_domain.
Theorem supportsModuleType_source_refinement : forall input static_values objects stored,
 typed_string_argument input -> public_classified (source_eval supportsModuleType_source input) (run_public 24 supportsModuleType_code (initial_public [input] static_values objects stored)) (initial_public [input] static_values objects stored).
Proof. intros. rewrite <- supportsModuleType_source_domain by assumption. apply supportsModuleType_execution_classified. Qed.
Print Assumptions supportsModuleType_source_refinement.
Theorem supportsModuleType_no_timeout : forall (input : Value) static_values objects stored,
 terminal_public (run_public 24 supportsModuleType_code (initial_public [input] static_values objects stored)).
Proof. intros input static_values objects stored. exact (classification_terminal (budget_eval supportsModuleType_source input) (run_public 24 supportsModuleType_code (initial_public [input] static_values objects stored)) (initial_public [input] static_values objects stored) (supportsModuleType_execution_classified input static_values objects stored)). Qed.
Print Assumptions supportsModuleType_no_timeout.
Theorem supportsModuleType_source_total : forall input, exists value, source_eval supportsModuleType_source input = Some value.
Proof. intros. unfold supportsModuleType_source.
destruct input as [z|boolean| |bytes|buffer|ref| |kind values]; try solve [pure_norm; eexists; reflexivity].
destruct (bytes_eqb bytes [118%nat;97%nat;108%nat;105%nat;100%nat;97%nat;116%nat;111%nat;114%nat]) eqn:H0;
destruct (bytes_eqb bytes [118%nat;101%nat;114%nat;105%nat;102%nat;105%nat;101%nat;114%nat]) eqn:H1;
destruct (bytes_eqb bytes [104%nat;111%nat;111%nat;107%nat]) eqn:H2;
pure_drive; eexists; reflexivity. Qed.
Print Assumptions supportsModuleType_source_total.
Theorem supportsModuleType_source_halts_preserves_frame : forall input static_values objects stored,
 typed_string_argument input -> exists value after,
 source_eval supportsModuleType_source input = Some value /\ (run_public 24 supportsModuleType_code (initial_public [input] static_values objects stored)) = Halt value after /\ return_frame_preserved after (initial_public [input] static_values objects stored).
Proof. intros input static_values objects stored Htyped.
 destruct (supportsModuleType_source_total input) as [value Esource].
 pose proof (supportsModuleType_source_refinement input static_values objects stored Htyped) as Hrefine.
 rewrite Esource in Hrefine. apply classification_returns in Hrefine.
 destruct Hrefine as [after [Hrun Henv]]. exists value,after. auto. Qed.
Print Assumptions supportsModuleType_source_halts_preserves_frame.
Theorem supportsModuleType_oversized_fault_preserves_frame : forall bytes static_values objects stored,
 comparable_limit < Z.of_nat (length bytes) -> exists after,
 (run_public 24 supportsModuleType_code (initial_public [VBytes bytes] static_values objects stored)) = Fault after /\
 environment_preserved after (initial_public [VBytes bytes] static_values objects stored).
Proof. intros bytes static_values objects stored Hsize.
 eapply classification_faults.
 pose proof (supportsModuleType_execution_classified (VBytes bytes) static_values objects stored) as Hclass.
 assert (Esize : (Z.of_nat (length bytes) <=? 65536) = false) by (apply Z.leb_gt; exact Hsize).
 assert (Epositive : (0 <? 65536) = true) by (vm_compute; reflexivity).
 unfold supportsModuleType_source in Hclass. pure_norm. rewrite Esize,Epositive in Hclass. pure_norm. exact Hclass. Qed.
Print Assumptions supportsModuleType_oversized_fault_preserves_frame.
Theorem supportsModuleType_missing_argument_fault : forall static_values objects stored,
 run_public 24 supportsModuleType_code (initial_public [] static_values objects stored) = Fault (initial_public [] static_values objects stored).
Proof. intros. unfold supportsModuleType_code. rewrite run_public_one_step. pure_norm. reflexivity. Qed.
Print Assumptions supportsModuleType_missing_argument_fault.
Theorem supportsModuleType_non_string_returns_false : forall input static_values objects stored,
 (match input with VBytes _ => False | _ => True end) ->
 public_value (run_public 24 supportsModuleType_code (initial_public [input] static_values objects stored)) = Some (VBool false).
Proof. intros input static_values objects stored Htag. rewrite supportsModuleType_budget_reference.
 unfold supportsModuleType_source. destruct input; pure_norm; try reflexivity; contradiction. Qed.
Print Assumptions supportsModuleType_non_string_returns_false.
