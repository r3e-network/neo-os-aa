From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import InitializerReferences CapMethodVm PublicPureMethods QueryReferences ReferenceArtifact.
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

Ltac count_drive := repeat first [progress pure_norm
 | progress cbv [roots] in *
 | multimatch goal with H : ?lhs = ?rhs |- _ => progress rewrite H end
 | match goal with |- context[Z.to_nat ?z] => let n := eval vm_compute in (Z.to_nat z) in progress change (Z.to_nat z) with n end
 | rewrite counts_unroll].
Definition getAccountImplementationId_bytes := [12%nat;38%nat;111%nat;114%nat;103%nat;46%nat;114%nat;51%nat;101%nat;46%nat;110%nat;101%nat;111%nat;46%nat;97%nat;97%nat;46%nat;117%nat;110%nat;105%nat;102%nat;105%nat;101%nat;100%nat;45%nat;115%nat;109%nat;97%nat;114%nat;116%nat;45%nat;119%nat;97%nat;108%nat;108%nat;101%nat;116%nat;46%nat;118%nat;51%nat;34%nat;2%nat;64%nat].
Definition getAccountImplementationId_counts (x:option (list nat)) sf hp st :=
  checked_counts 24 getAccountImplementationId_bytes (last counts_after 0%nat) 0
    (initial_public [] sf hp st).
Theorem getAccountImplementationId_body_peak : forall x sf hp st,
 fold_right Nat.max 0%nat (getAccountImplementationId_counts x sf hp st) = 65%nat.
Proof. intros. unfold getAccountImplementationId_counts, getAccountImplementationId_bytes. rewrite final_usage.
all: count_drive; reflexivity. Qed.
Theorem getAccountImplementationId_through_return : forall x sf hp st base limit, (base <= limit)%nat ->
 (fits base limit (counts_after ++ getAccountImplementationId_counts x sf hp st) = true <-> (base + 65 <= limit)%nat).
Proof. intros. rewrite fit_iff_peak by assumption.
 rewrite peak_app, peak, getAccountImplementationId_body_peak. reflexivity. Qed.
Print Assumptions getAccountImplementationId_through_return.
Definition supportsExecutionMode_bytes := [87%nat;0%nat;1%nat;120%nat;12%nat;6%nat;115%nat;105%nat;110%nat;103%nat;108%nat;101%nat;151%nat;38%nat;5%nat;8%nat;34%nat;11%nat;120%nat;12%nat;5%nat;98%nat;97%nat;116%nat;99%nat;104%nat;151%nat;38%nat;5%nat;8%nat;34%nat;18%nat;120%nat;12%nat;12%nat;98%nat;97%nat;116%nat;99%nat;104%nat;45%nat;97%nat;116%nat;111%nat;109%nat;105%nat;99%nat;151%nat;34%nat;2%nat;64%nat].
Definition supportsExecutionMode_counts (x:option (list nat)) sf hp st :=
  checked_counts 24 supportsExecutionMode_bytes (last counts_after 0%nat) 1
    (initial_public [match x with Some b => VBytes b | None => VNull end] sf hp st).
Theorem supportsExecutionMode_body_peak : forall x sf hp st,
 fold_right Nat.max 0%nat (supportsExecutionMode_counts x sf hp st) = 66%nat.
Proof. intros. unfold supportsExecutionMode_counts, supportsExecutionMode_bytes. rewrite final_usage.
destruct x as [bytes|]; [ | count_drive; reflexivity ].
assert ((0 <? 65536) = true) by (vm_compute; reflexivity).
assert ((Z.of_nat 5 <=? 65536) = true) by (vm_compute; reflexivity).
assert ((Z.of_nat 6 <=? 65536) = true) by (vm_compute; reflexivity).
assert ((Z.of_nat 12 <=? 65536) = true) by (vm_compute; reflexivity).
destruct (Z.of_nat (length bytes) <=? 65536) eqn:Esize.
all: destruct (bytes_eqb bytes [115%nat;105%nat;110%nat;103%nat;108%nat;101%nat]) eqn:E0.
all: destruct (bytes_eqb bytes [98%nat;97%nat;116%nat;99%nat;104%nat]) eqn:E1.
all: destruct (bytes_eqb bytes [98%nat;97%nat;116%nat;99%nat;104%nat;45%nat;97%nat;116%nat;111%nat;109%nat;105%nat;99%nat]) eqn:E2.
all: count_drive; reflexivity. Qed.
Theorem supportsExecutionMode_through_return : forall x sf hp st base limit, (base <= limit)%nat ->
 (fits base limit (counts_after ++ supportsExecutionMode_counts x sf hp st) = true <-> (base + 66 <= limit)%nat).
Proof. intros. rewrite fit_iff_peak by assumption.
 rewrite peak_app, peak, supportsExecutionMode_body_peak. reflexivity. Qed.
Print Assumptions supportsExecutionMode_through_return.
Definition supportsModuleType_bytes := [87%nat;0%nat;1%nat;120%nat;12%nat;9%nat;118%nat;97%nat;108%nat;105%nat;100%nat;97%nat;116%nat;111%nat;114%nat;151%nat;38%nat;5%nat;8%nat;34%nat;14%nat;120%nat;12%nat;8%nat;118%nat;101%nat;114%nat;105%nat;102%nat;105%nat;101%nat;114%nat;151%nat;38%nat;5%nat;8%nat;34%nat;10%nat;120%nat;12%nat;4%nat;104%nat;111%nat;111%nat;107%nat;151%nat;34%nat;2%nat;64%nat].
Definition supportsModuleType_counts (x:option (list nat)) sf hp st :=
  checked_counts 24 supportsModuleType_bytes (last counts_after 0%nat) 1
    (initial_public [match x with Some b => VBytes b | None => VNull end] sf hp st).
Theorem supportsModuleType_body_peak : forall x sf hp st,
 fold_right Nat.max 0%nat (supportsModuleType_counts x sf hp st) = 66%nat.
Proof. intros. unfold supportsModuleType_counts, supportsModuleType_bytes. rewrite final_usage.
destruct x as [bytes|]; [ | count_drive; reflexivity ].
assert ((0 <? 65536) = true) by (vm_compute; reflexivity).
assert ((Z.of_nat 4 <=? 65536) = true) by (vm_compute; reflexivity).
assert ((Z.of_nat 8 <=? 65536) = true) by (vm_compute; reflexivity).
assert ((Z.of_nat 9 <=? 65536) = true) by (vm_compute; reflexivity).
destruct (Z.of_nat (length bytes) <=? 65536) eqn:Esize.
all: destruct (bytes_eqb bytes [118%nat;97%nat;108%nat;105%nat;100%nat;97%nat;116%nat;111%nat;114%nat]) eqn:E0.
all: destruct (bytes_eqb bytes [118%nat;101%nat;114%nat;105%nat;102%nat;105%nat;101%nat;114%nat]) eqn:E1.
all: destruct (bytes_eqb bytes [104%nat;111%nat;111%nat;107%nat]) eqn:E2.
all: count_drive; reflexivity. Qed.
Theorem supportsModuleType_through_return : forall x sf hp st base limit, (base <= limit)%nat ->
 (fits base limit (counts_after ++ supportsModuleType_counts x sf hp st) = true <-> (base + 66 <= limit)%nat).
Proof. intros. rewrite fit_iff_peak by assumption.
 rewrite peak_app, peak, supportsModuleType_body_peak. reflexivity. Qed.
Print Assumptions supportsModuleType_through_return.
