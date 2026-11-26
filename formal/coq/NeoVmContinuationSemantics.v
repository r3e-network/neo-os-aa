(*
  NeoOS formal verification -- ordinary callback continuation semantics.

  This executable control-flow model tracks return continuations only. A module
  callback is an ordinary call frame: CALL, CALLT and LoadScript push the same
  shared continuation and RET discards exactly that frame. The declared system
  fee of the transaction is the only bound a callback has, and every frame of
  the engine shares it; the per-callback budgets this model used to track left
  the core together with the bounded-call syscall they were charged through, so
  there is no child or ancestor remainder to admit, charge or restore.

  Instruction prices, the transaction-level fee and concrete VM/compiler
  correspondence are outside this model.
*)
From Coq Require Import List Bool PeanoNat.
Import ListNotations.

Inductive VmStatus : Type := Running | Halted | Faulted.

Record VmState : Type := mkVmState {
  vm_pc : nat;
  vm_stack : list nat;
  vm_continuations : list nat;
  vm_storage : list nat;
  vm_status : VmStatus
}.

Inductive Instruction : Type :=
| IInit
| IPush : nat -> Instruction
| ICallT : nat -> Instruction
| ICall : nat -> Instruction
| ILoadScript : nat -> Instruction
| IRet.

(* Every call kind saves the address that follows the call. *)
Definition push_continuation (state : VmState) (target : nat) : VmState :=
  mkVmState target (vm_stack state)
    (S (vm_pc state) :: vm_continuations state)
    (vm_storage state) Running.

Definition step (instruction : Instruction) (state : VmState) : VmState :=
  match vm_status state with
  | Halted | Faulted => state
  | Running =>
      match instruction with
      | IInit =>
          (* Initialization is per contract load, not a global one-shot flag. *)
          mkVmState (S (vm_pc state)) (vm_stack state)
            (vm_continuations state) (vm_storage state) Running
      | IPush value =>
          mkVmState (S (vm_pc state)) (value :: vm_stack state)
            (vm_continuations state) (vm_storage state) Running
      | ICallT target => push_continuation state target
      | ICall target => push_continuation state target
      | ILoadScript target =>
          push_continuation state target
      | IRet =>
          match vm_continuations state with
          | [] =>
              mkVmState (vm_pc state) (vm_stack state) [] (vm_storage state) Halted
          | continuation :: rest =>
              mkVmState continuation (vm_stack state) rest (vm_storage state) Running
          end
      end
  end.

(* A failed application restores storage; nothing else in this model is observed. *)
Definition transaction_result (initial final : VmState) : VmState :=
  match vm_status final with
  | Faulted =>
      mkVmState (vm_pc final) (vm_stack final) (vm_continuations final)
        (vm_storage initial) Faulted
  | _ => final
  end.

(* A supplied instruction trace is used only for executable regression examples;
   it does not decode a concrete script or model opcode prices. *)
Fixpoint run (instructions : list Instruction) (state : VmState) : VmState :=
  match instructions with
  | [] => state
  | instruction :: rest => run rest (step instruction state)
  end.

Definition example_initial := mkVmState 7 [] [] [1] Running.

Theorem load_script_pushes_shared_continuation :
  forall state target,
    vm_status state = Running ->
    vm_continuations (step (ILoadScript target) state) =
      S (vm_pc state) :: vm_continuations state.
Proof.
  intros [pc stack continuations storage status] target H.
  simpl in H. destruct status; try discriminate. reflexivity.
Qed.

Theorem callt_ret_returns_to_saved_continuation :
  forall state target,
    vm_status state = Running ->
    vm_status (step IRet (step (ICallT target) state)) = Running /\
    vm_pc (step IRet (step (ICallT target) state)) = S (vm_pc state).
Proof.
  intros [pc stack continuations storage status] target H.
  simpl in H. destruct status; try discriminate. repeat split; reflexivity.
Qed.

Theorem ordinary_calls_share_continuation_chain :
  forall state target,
    step (ICall target) state = step (ICallT target) state /\
    step (ILoadScript target) state = step (ICallT target) state.
Proof.
  intros [pc stack continuations storage status] target.
  destruct status; split; reflexivity.
Qed.

Theorem initialization_is_per_load_context :
  forall state,
    vm_status state = Running ->
    vm_status (step IInit state) = Running /\
    vm_continuations (step IInit state) = vm_continuations state /\
    vm_storage (step IInit state) = vm_storage state.
Proof.
  intros [pc stack continuations storage status] H.
  simpl in H. destruct status; try discriminate. repeat split; reflexivity.
Qed.

Theorem failed_transaction_restores_storage :
  forall initial final,
    vm_status final = Faulted ->
    vm_storage (transaction_result initial final) = vm_storage initial.
Proof.
  intros initial final H. unfold transaction_result. rewrite H. reflexivity.
Qed.

Example callt_pushes_shared_continuation :
  step (ICallT 99) example_initial = mkVmState 99 [] [8] [1] Running.
Proof. reflexivity. Qed.

Example load_script_pushes_shared_continuation_example :
  step (ILoadScript 99) example_initial = mkVmState 99 [] [8] [1] Running.
Proof. reflexivity. Qed.

Example initialization_can_run_for_each_load :
  vm_status (run [IInit; IInit] example_initial) = Running.
Proof. reflexivity. Qed.

Example callback_return_resumes_caller :
  run [ICallT 99; IRet] example_initial = mkVmState 8 [] [] [1] Running.
Proof. reflexivity. Qed.

Example ordinary_descendants_share_one_continuation_chain :
  run [ICallT 88; ICall 77; ILoadScript 66; IRet; IRet; IRet] example_initial =
    mkVmState 8 [] [] [1] Running.
Proof. reflexivity. Qed.

Example fault_rolls_back_storage :
  transaction_result example_initial (mkVmState 8 [] [8] [99] Faulted) =
    mkVmState 8 [] [8] [1] Faulted.
Proof. reflexivity. Qed.

Print Assumptions load_script_pushes_shared_continuation.
Print Assumptions callt_ret_returns_to_saved_continuation.
Print Assumptions ordinary_calls_share_continuation_chain.
Print Assumptions initialization_is_per_load_context.
Print Assumptions failed_transaction_restores_storage.
Print Assumptions callt_pushes_shared_continuation.
Print Assumptions load_script_pushes_shared_continuation_example.
Print Assumptions initialization_can_run_for_each_load.
Print Assumptions callback_return_resumes_caller.
Print Assumptions ordinary_descendants_share_one_continuation_chain.
Print Assumptions fault_rolls_back_storage.
