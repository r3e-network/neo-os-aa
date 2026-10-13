(*
  NeoOS formal verification -- bounded callback continuation semantics.

  This is a small executable model for the NeoVM control-flow and budget
  obligations used by SmartAccount callbacks. It covers initialization as a
  per-load context (not a global one-shot flag), CALLT/CALL, RET,
  Runtime.LoadScript-style budget inheritance, native callback continuations,
  post-Huyao ancestor charging, hardfork gating, and transaction rollback.
  It is intentionally not a complete NeoVM model or a compiler refinement
  proof; concrete Neo core tests and private-chain readback remain the
  implementation correspondence evidence.
*)
From Coq Require Import List Bool PeanoNat.
Import ListNotations.

Inductive VmStatus : Type :=
| Running
| Halted
| Faulted.

Record VmConfig : Type := mkVmConfig {
  callback_gas_cap_enabled : bool
}.

Record VmState : Type := mkVmState {
  vm_pc : nat;
  vm_stack : list nat;
  vm_continuations : list nat;
  vm_budget : nat;
  vm_storage : list nat;
  vm_status : VmStatus
}.

Inductive Instruction : Type :=
| IInit
| IPush : nat -> Instruction
| ICallT : nat -> Instruction
| ICall : nat -> Instruction
| ILoadScript : nat -> Instruction
| ICallback : nat -> nat -> Instruction
| ICharge : nat -> Instruction
| IRet.

Definition fault (state : VmState) : VmState :=
  mkVmState (vm_pc state) (vm_stack state) (vm_continuations state)
    (vm_budget state) (vm_storage state) Faulted.

Definition charge_budget (current amount : nat) : option nat :=
  if amount <=? current then Some (current - amount) else None.

(* A bounded call is admitted only when the requested limit fits in every
   enclosing budget. It is not silently truncated to the parent's remainder. *)
Definition callback_budget (parent requested : nat) : option nat :=
  if requested <=? parent then Some requested else None.

Definition push_continuation (state : VmState) (target : nat) : VmState :=
  mkVmState target (vm_stack state) (S (vm_pc state) :: vm_continuations state)
    (vm_budget state) (vm_storage state) Running.

Definition step (config : VmConfig) (instruction : Instruction)
    (state : VmState) : VmState :=
  match vm_status state with
  | Halted | Faulted => state
  | Running =>
      match instruction with
      | IInit =>
          (* ApplicationEngine.LoadContract loads _initialize into a fresh
             context for the contract load; it does not use a global boolean
             that suppresses later contract loads. *)
          mkVmState (S (vm_pc state)) (vm_stack state)
            (vm_continuations state) (vm_budget state) (vm_storage state) Running
      | IPush value =>
          mkVmState (S (vm_pc state)) (value :: vm_stack state)
            (vm_continuations state) (vm_budget state) (vm_storage state) Running
      | ICallT target => push_continuation state target
      | ICall target => push_continuation state target
      | ILoadScript target =>
          (* LoadScript creates a context that returns to its caller and copies
             the caller's ContractCallGasBudget reference. *)
          push_continuation state target
      | ICallback target requested =>
          if callback_gas_cap_enabled config
          then match callback_budget (vm_budget state) requested with
               | Some child_budget =>
                   mkVmState target (vm_stack state)
                     (S (vm_pc state) :: vm_continuations state)
                     child_budget (vm_storage state) Running
               | None => fault state
               end
          else fault state
      | ICharge amount =>
          match charge_budget (vm_budget state) amount with
          | Some next => mkVmState (S (vm_pc state)) (vm_stack state)
              (vm_continuations state) next (vm_storage state) Running
          | None => fault state
          end
      | IRet =>
          match vm_continuations state with
          | [] => mkVmState (vm_pc state) (vm_stack state) []
              (vm_budget state) (vm_storage state) Halted
          | continuation :: rest =>
              mkVmState continuation (vm_stack state) rest (vm_budget state)
                (vm_storage state) Running
          end
      end
  end.

(* A failed application rolls back contract storage, but not the gas already
   consumed by the failed invocation. *)
Definition transaction_result (initial final : VmState) : VmState :=
  match vm_status final with
  | Faulted =>
      mkVmState (vm_pc final) (vm_stack final) (vm_continuations final)
        (vm_budget final) (vm_storage initial) Faulted
  | _ => final
  end.

Definition ancestor_charge (budgets : list nat) (amount : nat)
    : option (list nat) :=
  if forallb (fun budget => amount <=? budget) budgets
  then Some (map (fun budget => budget - amount) budgets)
  else None.

Theorem callback_budget_is_bounded :
  forall parent requested child,
    callback_budget parent requested = Some child ->
    child = requested /\ child <= parent.
Proof.
  intros parent requested child H.
  unfold callback_budget in H.
  destruct (requested <=? parent) eqn:Hfits; try discriminate.
  injection H as Hchild. split; [symmetry; exact Hchild |].
  apply Nat.leb_le. rewrite <- Hchild. exact Hfits.
Qed.

Theorem oversized_callback_is_rejected :
  forall config state target requested,
    vm_status state = Running ->
    vm_budget state < requested ->
    vm_status (step config (ICallback target requested) state) = Faulted.
Proof.
  intros config state target requested Hrun Hover.
  destruct state as [pc stack continuations budget storage status].
  simpl in Hrun. destruct status; try discriminate.
  destruct config as [enabled]. destruct enabled; [| reflexivity].
  assert (Hnot : (requested <=? budget) = false) by (apply Nat.leb_gt; exact Hover).
  unfold step; simpl; unfold callback_budget.
  rewrite Hnot. reflexivity.
Qed.

Theorem load_script_inherits_budget_and_continuation :
  forall config state target,
    vm_status state = Running ->
    vm_budget (step config (ILoadScript target) state) = vm_budget state /\
    vm_continuations (step config (ILoadScript target) state) =
      S (vm_pc state) :: vm_continuations state.
Proof.
  intros config state target H.
  destruct state as [pc stack continuations budget storage status].
  simpl in H. destruct status; try discriminate.
  repeat split; reflexivity.
Qed.

Theorem callt_ret_returns_to_saved_continuation :
  forall config state target,
    vm_status state = Running ->
    vm_status (step config IRet (step config (ICallT target) state)) = Running /\
    vm_pc (step config IRet (step config (ICallT target) state)) = S (vm_pc state).
Proof.
  intros config state target H.
  destruct state as [pc stack continuations budget storage status].
  simpl in H. destruct status; try discriminate.
  repeat split; reflexivity.
Qed.

Theorem initialization_is_per_load_context :
  forall config state,
    vm_status state = Running ->
    vm_status (step config IInit state) = Running /\
    vm_budget (step config IInit state) = vm_budget state.
Proof.
  intros config state H.
  destruct state as [pc stack continuations budget storage status].
  simpl in H. destruct status; try discriminate.
  repeat split; reflexivity.
Qed.

Theorem callback_hardfork_gate_is_fail_closed :
  forall state target requested,
    vm_status state = Running ->
    vm_status (step (mkVmConfig false) (ICallback target requested) state) = Faulted.
Proof.
  intros state target requested H.
  destruct state as [pc stack continuations budget storage status].
  simpl in H. destruct status; try discriminate; reflexivity.
Qed.

Theorem failed_charge_is_atomic :
  forall config state amount,
    vm_status state = Running ->
    vm_budget state < amount ->
    step config (ICharge amount) state = fault state.
Proof.
  intros config state amount Hrun Hbudget.
  destruct state as [pc stack continuations budget storage status].
  simpl in Hrun. destruct status; try discriminate.
  unfold step; simpl; unfold fault, charge_budget.
  assert (Hnot : (amount <=? budget) = false) by (apply Nat.leb_gt; exact Hbudget).
  rewrite Hnot. reflexivity.
Qed.

Theorem post_huyao_charge_attribution_is_atomic :
  forall budgets amount next,
    ancestor_charge budgets amount = Some next ->
    next = map (fun budget => budget - amount) budgets.
Proof.
  intros budgets amount next H.
  unfold ancestor_charge in H.
  destruct (forallb (fun budget => amount <=? budget) budgets) eqn:Hcan;
    [injection H as Hnext; symmetry; exact Hnext | discriminate].
Qed.

Theorem rollback_restores_storage_but_preserves_consumed_budget :
  forall initial final,
    vm_status final = Faulted ->
    vm_storage (transaction_result initial final) = vm_storage initial /\
    vm_budget (transaction_result initial final) = vm_budget final.
Proof.
  intros initial final H.
  unfold transaction_result. rewrite H. repeat split; reflexivity.
Qed.

Example bounded_native_callback_continuation :
  vm_budget
    (step (mkVmConfig true) (ICallback 99 7)
      (mkVmState 7 [] [3] 10 [1] Running)) = 7 /\
  vm_pc
    (step (mkVmConfig true) (ICallback 99 7)
      (mkVmState 7 [] [3] 10 [1] Running)) = 99.
Proof. split; reflexivity. Qed.

Example oversized_native_callback_faults :
  step (mkVmConfig true) (ICallback 99 20)
    (mkVmState 7 [1] [3] 10 [2] Running) =
  fault (mkVmState 7 [1] [3] 10 [2] Running).
Proof. reflexivity. Qed.

Example load_script_preserves_parent_budget :
  vm_budget
    (step (mkVmConfig true) (ILoadScript 99)
      (mkVmState 7 [] [] 123 [] Running)) = 123.
Proof. reflexivity. Qed.

Example initialization_can_run_for_each_load :
  vm_status
    (step (mkVmConfig true) IInit
      (step (mkVmConfig true) IInit
        (mkVmState 7 [] [] 123 [] Running))) = Running.
Proof. reflexivity. Qed.

Example disabled_callback_cap_faults_without_state_change :
  step (mkVmConfig false) (ICallback 99 7)
    (mkVmState 7 [1] [3] 10 [2] Running) =
  fault (mkVmState 7 [1] [3] 10 [2] Running).
Proof. reflexivity. Qed.

Example failed_charge_does_not_reduce_budget :
  vm_budget
    (step (mkVmConfig true) (ICharge 11)
      (mkVmState 7 [] [] 10 [2] Running)) = 10.
Proof. reflexivity. Qed.

Example fault_rolls_back_storage_but_not_budget :
  vm_storage
    (transaction_result
      (mkVmState 7 [] [] 10 [2] Running)
      (mkVmState 8 [] [] 3 [99] Faulted)) = [2] /\
  vm_budget
    (transaction_result
      (mkVmState 7 [] [] 10 [2] Running)
      (mkVmState 8 [] [] 3 [99] Faulted)) = 3.
Proof. split; reflexivity. Qed.

Print Assumptions callback_budget_is_bounded.
Print Assumptions oversized_callback_is_rejected.
Print Assumptions load_script_inherits_budget_and_continuation.
Print Assumptions callt_ret_returns_to_saved_continuation.
Print Assumptions initialization_is_per_load_context.
Print Assumptions callback_hardfork_gate_is_fail_closed.
Print Assumptions failed_charge_is_atomic.
Print Assumptions post_huyao_charge_attribution_is_atomic.
Print Assumptions rollback_restores_storage_but_preserves_consumed_budget.
Print Assumptions bounded_native_callback_continuation.
Print Assumptions oversized_native_callback_faults.
Print Assumptions load_script_preserves_parent_budget.
Print Assumptions initialization_can_run_for_each_load.
Print Assumptions disabled_callback_cap_faults_without_state_change.
Print Assumptions failed_charge_does_not_reduce_budget.
Print Assumptions fault_rolls_back_storage_but_not_budget.
