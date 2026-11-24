Require Import CapMethodVm CapContext PublicPureMethods OrdinaryInitializerArtifact OrdinaryPureArtifact OrdinaryReturn.
From Coq Require Import List. Import ListNotations.
Definition resume_pure code stored finish :=
  match finish with
  | InitReturned s => match init_slots s with
    | Some fields => Some (run_public 24 code (initial_public (init_stack s)
        (nth_error fields) (init_heap s) stored))
    | None => None end
  | _ => None end.
Definition to_caller outcome tail :=
  match outcome with
  | Some (Halt v _) => ordinary_dynamic_return VNull (Some 1) [v] tail
  | _ => None end.
Theorem getAccountImplementationId_initialized : forall hp input stored,
  exists outcome, resume_pure getAccountImplementationId_code stored
    (run_init 170 OrdinaryInitializerArtifact.code (initializer_entry hp [])) = Some outcome /\
    public_classified (budget_eval getAccountImplementationId_source input) outcome
      (initial_public [] (nth_error (slots hp)) (heap_after hp) stored).
Proof. intros. rewrite init_exact. eexists. split; [reflexivity|apply getAccountImplementationId_execution_classified]. Qed.
Print Assumptions getAccountImplementationId_initialized.
Theorem getAccountImplementationId_caller_stack : forall hp input stored tail,
  to_caller (resume_pure getAccountImplementationId_code stored
    (run_init 170 OrdinaryInitializerArtifact.code (initializer_entry hp []))) tail =
  option_map (fun v => v :: tail) (budget_eval getAccountImplementationId_source input).
Proof. intros. destruct (getAccountImplementationId_initialized hp input stored) as [out [H C]]. rewrite H.
  destruct (budget_eval getAccountImplementationId_source input), out; simpl in C; try contradiction;
  try reflexivity. destruct C as [-> _]. reflexivity. Qed.
Print Assumptions getAccountImplementationId_caller_stack.
Theorem supportsExecutionMode_initialized : forall hp input stored,
  exists outcome, resume_pure supportsExecutionMode_code stored
    (run_init 170 OrdinaryInitializerArtifact.code (initializer_entry hp [input])) = Some outcome /\
    public_classified (budget_eval supportsExecutionMode_source input) outcome
      (initial_public [input] (nth_error (slots hp)) (heap_after hp) stored).
Proof. intros. rewrite init_exact. eexists. split; [reflexivity|apply supportsExecutionMode_execution_classified]. Qed.
Print Assumptions supportsExecutionMode_initialized.
Theorem supportsExecutionMode_caller_stack : forall hp input stored tail,
  to_caller (resume_pure supportsExecutionMode_code stored
    (run_init 170 OrdinaryInitializerArtifact.code (initializer_entry hp [input]))) tail =
  option_map (fun v => v :: tail) (budget_eval supportsExecutionMode_source input).
Proof. intros. destruct (supportsExecutionMode_initialized hp input stored) as [out [H C]]. rewrite H.
  destruct (budget_eval supportsExecutionMode_source input), out; simpl in C; try contradiction;
  try reflexivity. destruct C as [-> _]. reflexivity. Qed.
Print Assumptions supportsExecutionMode_caller_stack.
Theorem supportsModuleType_initialized : forall hp input stored,
  exists outcome, resume_pure supportsModuleType_code stored
    (run_init 170 OrdinaryInitializerArtifact.code (initializer_entry hp [input])) = Some outcome /\
    public_classified (budget_eval supportsModuleType_source input) outcome
      (initial_public [input] (nth_error (slots hp)) (heap_after hp) stored).
Proof. intros. rewrite init_exact. eexists. split; [reflexivity|apply supportsModuleType_execution_classified]. Qed.
Print Assumptions supportsModuleType_initialized.
Theorem supportsModuleType_caller_stack : forall hp input stored tail,
  to_caller (resume_pure supportsModuleType_code stored
    (run_init 170 OrdinaryInitializerArtifact.code (initializer_entry hp [input]))) tail =
  option_map (fun v => v :: tail) (budget_eval supportsModuleType_source input).
Proof. intros. destruct (supportsModuleType_initialized hp input stored) as [out [H C]]. rewrite H.
  destruct (budget_eval supportsModuleType_source input), out; simpl in C; try contradiction;
  try reflexivity. destruct C as [-> _]. reflexivity. Qed.
Print Assumptions supportsModuleType_caller_stack.
