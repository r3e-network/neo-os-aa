(*
  NeoOS formal verification -- bounded callback continuation semantics.

  This executable control-flow model tracks a current bounded-call remainder
  and its ancestor remainders. Ordinary CALL/CALLT/LoadScript frames alias that
  chain; bounded callback frames add one child and discard only that child on
  return. ICharge models an explicit nonnegative bounded-call charge, including
  atomic ancestor attribution. Instruction prices, transaction-level fees and
  whitelisting, and concrete VM/compiler correspondence are outside this model.
*)
From Coq Require Import List Bool PeanoNat.
Import ListNotations.

Inductive VmStatus : Type := Running | Halted | Faulted.

Record VmConfig : Type := mkVmConfig {
  callback_gas_cap_enabled : bool
}.

(* A shared frame keeps the same budget reference. A bounded frame returns to
   the already-charged parent, rather than restoring an uncharged saved value. *)
Inductive VmContinuation : Type :=
| SharedContinuation : nat -> VmContinuation
| BoundedContinuation : nat -> VmContinuation.

Record VmState : Type := mkVmState {
  vm_pc : nat;
  vm_stack : list nat;
  vm_continuations : list VmContinuation;
  vm_budget : nat;
  vm_ancestor_budgets : list nat;
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
    (vm_budget state) (vm_ancestor_budgets state) (vm_storage state) Faulted.

(* A zero limit is rejected, as in LoadBoundedContractCall. Limits are never
   silently truncated to an enclosing remainder. *)
Definition callback_budget (parent requested : nat) : option nat :=
  if (0 <? requested) && (requested <=? parent) then Some requested else None.

Definition callback_chain_budget (parent : nat) (ancestors : list nat)
    (requested : nat) : option nat :=
  match callback_budget parent requested with
  | Some child =>
      if forallb (fun budget => requested <=? budget) ancestors
      then Some child else None
  | None => None
  end.

Definition ancestor_charge (budgets : list nat) (amount : nat)
    : option (list nat) :=
  if forallb (fun budget => amount <=? budget) budgets
  then Some (map (fun budget => budget - amount) budgets)
  else None.

Definition push_continuation (state : VmState) (target : nat) : VmState :=
  mkVmState target (vm_stack state)
    (SharedContinuation (S (vm_pc state)) :: vm_continuations state)
    (vm_budget state) (vm_ancestor_budgets state) (vm_storage state) Running.

Definition step (config : VmConfig) (instruction : Instruction)
    (state : VmState) : VmState :=
  match vm_status state with
  | Halted | Faulted => state
  | Running =>
      match instruction with
      | IInit =>
          (* Initialization is per contract load, not a global one-shot flag. *)
          mkVmState (S (vm_pc state)) (vm_stack state)
            (vm_continuations state) (vm_budget state) (vm_ancestor_budgets state)
            (vm_storage state) Running
      | IPush value =>
          mkVmState (S (vm_pc state)) (value :: vm_stack state)
            (vm_continuations state) (vm_budget state) (vm_ancestor_budgets state)
            (vm_storage state) Running
      | ICallT target => push_continuation state target
      | ICall target => push_continuation state target
      | ILoadScript target =>
          (* Ordinary descendants alias the current ContractCallGasBudget. *)
          push_continuation state target
      | ICallback target requested =>
          if callback_gas_cap_enabled config
          then match callback_chain_budget (vm_budget state)
                       (vm_ancestor_budgets state) requested with
               | Some child_budget =>
                   mkVmState target (vm_stack state)
                     (BoundedContinuation (S (vm_pc state)) :: vm_continuations state)
                     child_budget (vm_budget state :: vm_ancestor_budgets state)
                     (vm_storage state) Running
               | None => fault state
               end
          else fault state
      | ICharge amount =>
          match ancestor_charge (vm_budget state :: vm_ancestor_budgets state) amount with
          | Some (next :: ancestors) =>
              mkVmState (S (vm_pc state)) (vm_stack state)
                (vm_continuations state) next ancestors (vm_storage state) Running
          | _ => fault state
          end
      | IRet =>
          match vm_continuations state with
          | [] => mkVmState (vm_pc state) (vm_stack state) []
              (vm_budget state) (vm_ancestor_budgets state) (vm_storage state) Halted
          | SharedContinuation continuation :: rest =>
              mkVmState continuation (vm_stack state) rest (vm_budget state)
                (vm_ancestor_budgets state) (vm_storage state) Running
          | BoundedContinuation continuation :: rest =>
              match vm_ancestor_budgets state with
              | parent :: ancestors =>
                  mkVmState continuation (vm_stack state) rest parent ancestors
                    (vm_storage state) Running
              | [] => fault state
              end
          end
      end
  end.

(* A failed application restores storage, not the bounded budgets already spent. *)
Definition transaction_result (initial final : VmState) : VmState :=
  match vm_status final with
  | Faulted =>
      mkVmState (vm_pc final) (vm_stack final) (vm_continuations final)
        (vm_budget final) (vm_ancestor_budgets final) (vm_storage initial) Faulted
  | _ => final
  end.

(* A supplied instruction trace is used only for executable regression examples;
   it does not decode a concrete script or model opcode prices. *)
Fixpoint run (config : VmConfig) (instructions : list Instruction) (state : VmState) : VmState :=
  match instructions with
  | [] => state
  | instruction :: rest => run config rest (step config instruction state)
  end.

Definition example_initial := mkVmState 7 [] [] 100 [] [1] Running.

Theorem callback_budget_is_bounded :
  forall parent requested child,
    callback_budget parent requested = Some child ->
    child = requested /\ child <= parent.
Proof.
  intros parent requested child H.
  unfold callback_budget in H.
  destruct ((0 <? requested) && (requested <=? parent)) eqn:Hfits; try discriminate.
  apply andb_true_iff in Hfits as [_ Hfits].
  injection H as Hchild. split; [symmetry; exact Hchild |].
  apply Nat.leb_le. rewrite <- Hchild. exact Hfits.
Qed.

Theorem callback_budget_is_positive :
  forall parent requested child,
    callback_budget parent requested = Some child -> 0 < child.
Proof.
  intros parent requested child H.
  unfold callback_budget in H.
  destruct ((0 <? requested) && (requested <=? parent)) eqn:Hfits; try discriminate.
  apply andb_true_iff in Hfits as [Hpositive _].
  injection H as Hchild. rewrite <- Hchild. apply Nat.ltb_lt. exact Hpositive.
Qed.

Theorem callback_chain_checks_every_ancestor :
  forall parent ancestors requested child,
    callback_chain_budget parent ancestors requested = Some child ->
    child = requested /\ 0 < child /\
    Forall (fun budget => child <= budget) (parent :: ancestors).
Proof.
  intros parent ancestors requested child H.
  unfold callback_chain_budget in H.
  destruct (callback_budget parent requested) as [candidate|] eqn:Hparent; try discriminate.
  destruct (forallb (fun budget => requested <=? budget) ancestors) eqn:Hancestors;
    try discriminate.
  injection H as Hchild. subst child.
  pose proof (callback_budget_is_bounded _ _ _ Hparent) as [Heq Hbound].
  pose proof (callback_budget_is_positive _ _ _ Hparent) as Hpositive.
  split; [exact Heq|]. split; [exact Hpositive|].
  constructor; [exact Hbound|].
  apply Forall_forall. intros budget Hin. rewrite Heq.
  apply Nat.leb_le. apply forallb_forall with (x := budget) in Hancestors; assumption.
Qed.

Theorem oversized_callback_is_rejected :
  forall config state target requested,
    vm_status state = Running ->
    vm_budget state < requested ->
    vm_status (step config (ICallback target requested) state) = Faulted.
Proof.
  intros config [pc stack continuations budget ancestors storage status] target requested Hrun Hover.
  simpl in Hrun, Hover. destruct status; try discriminate.
  destruct config as [enabled]. destruct enabled; [|reflexivity].
  assert (Hnot : (requested <=? budget) = false) by (apply Nat.leb_gt; exact Hover).
  unfold step; simpl; unfold callback_chain_budget, callback_budget.
  rewrite Hnot, andb_false_r. reflexivity.
Qed.

Theorem zero_callback_is_rejected :
  forall config state target,
    vm_status state = Running ->
    step config (ICallback target 0) state = fault state.
Proof.
  intros [enabled] [pc stack continuations budget ancestors storage status] target Hrun.
  simpl in Hrun. destruct status; try discriminate.
  destruct enabled; reflexivity.
Qed.

Theorem load_script_inherits_budget_and_continuation :
  forall config state target,
    vm_status state = Running ->
    vm_budget (step config (ILoadScript target) state) = vm_budget state /\
    vm_ancestor_budgets (step config (ILoadScript target) state) = vm_ancestor_budgets state /\
    vm_continuations (step config (ILoadScript target) state) =
      SharedContinuation (S (vm_pc state)) :: vm_continuations state.
Proof.
  intros config [pc stack continuations budget ancestors storage status] target H.
  simpl in H. destruct status; try discriminate. repeat split; reflexivity.
Qed.

Theorem callt_ret_returns_to_saved_continuation :
  forall config state target,
    vm_status state = Running ->
    vm_status (step config IRet (step config (ICallT target) state)) = Running /\
    vm_pc (step config IRet (step config (ICallT target) state)) = S (vm_pc state).
Proof.
  intros config [pc stack continuations budget ancestors storage status] target H.
  simpl in H. destruct status; try discriminate. repeat split; reflexivity.
Qed.

Theorem ordinary_calls_share_budget_chain :
  forall config state target,
    step config (ICall target) state = step config (ICallT target) state /\
    step config (ILoadScript target) state = step config (ICallT target) state.
Proof.
  intros config [pc stack continuations budget ancestors storage status] target.
  destruct status; split; reflexivity.
Qed.

Theorem shared_call_charge_return_preserves_debits :
  forall config state target amount next ancestors,
    vm_status state = Running ->
    ancestor_charge (vm_budget state :: vm_ancestor_budgets state) amount = Some (next :: ancestors) ->
    step config IRet (step config (ICharge amount) (step config (ICallT target) state)) =
      mkVmState (S (vm_pc state)) (vm_stack state) (vm_continuations state)
        next ancestors (vm_storage state) Running.
Proof.
  intros config [pc stack continuations budget parents storage status]
    target amount next ancestors Hrun Hcharge.
  simpl in Hrun, Hcharge. destruct status; try discriminate.
  cbn [step push_continuation vm_status vm_budget vm_ancestor_budgets vm_pc vm_stack vm_continuations vm_storage].
  rewrite Hcharge. reflexivity.
Qed.

Theorem bounded_call_charge_return_restores_charged_parent :
  forall state target requested child amount remaining parent ancestors,
    vm_status state = Running ->
    callback_chain_budget (vm_budget state) (vm_ancestor_budgets state) requested = Some child ->
    ancestor_charge (child :: vm_budget state :: vm_ancestor_budgets state) amount =
      Some (remaining :: parent :: ancestors) ->
    step (mkVmConfig true) IRet
      (step (mkVmConfig true) (ICharge amount)
        (step (mkVmConfig true) (ICallback target requested) state)) =
      mkVmState (S (vm_pc state)) (vm_stack state) (vm_continuations state)
        parent ancestors (vm_storage state) Running.
Proof.
  intros [pc stack continuations budget parents storage status]
    target requested child amount remaining parent ancestors Hrun Hadmit Hcharge.
  simpl in Hrun, Hadmit, Hcharge. destruct status; try discriminate.
  cbn [step callback_gas_cap_enabled vm_status vm_budget vm_ancestor_budgets vm_pc vm_stack vm_continuations vm_storage].
  rewrite Hadmit.
  cbn [step vm_status vm_budget vm_ancestor_budgets vm_pc vm_stack vm_continuations vm_storage].
  rewrite Hcharge. reflexivity.
Qed.

Theorem initialization_is_per_load_context :
  forall config state,
    vm_status state = Running ->
    vm_status (step config IInit state) = Running /\
    vm_budget (step config IInit state) = vm_budget state.
Proof.
  intros config [pc stack continuations budget ancestors storage status] H.
  simpl in H. destruct status; try discriminate. repeat split; reflexivity.
Qed.

Theorem callback_hardfork_gate_is_fail_closed :
  forall state target requested,
    vm_status state = Running ->
    vm_status (step (mkVmConfig false) (ICallback target requested) state) = Faulted.
Proof.
  intros [pc stack continuations budget ancestors storage status] target requested H.
  simpl in H. destruct status; try discriminate; reflexivity.
Qed.

Theorem failed_charge_is_atomic :
  forall config state amount,
    vm_status state = Running ->
    vm_budget state < amount ->
    step config (ICharge amount) state = fault state.
Proof.
  intros config [pc stack continuations budget ancestors storage status] amount Hrun Hbudget.
  simpl in Hrun, Hbudget. destruct status; try discriminate.
  assert (Hnot : (amount <=? budget) = false) by (apply Nat.leb_gt; exact Hbudget).
  unfold step; simpl; unfold ancestor_charge. simpl. rewrite Hnot. reflexivity.
Qed.

Theorem failed_ancestor_charge_is_atomic :
  forall config state amount,
    vm_status state = Running ->
    (exists ancestor, In ancestor (vm_ancestor_budgets state) /\ ancestor < amount) ->
    step config (ICharge amount) state = fault state.
Proof.
  intros config [pc stack continuations budget ancestors storage status] amount Hrun [ancestor [Hin Hover]].
  simpl in Hrun, Hin. destruct status; try discriminate.
  assert (Hnot : forallb (fun b => amount <=? b) ancestors = false).
  { destruct (forallb (fun b => amount <=? b) ancestors) eqn:Hfits; [|reflexivity].
    apply forallb_forall with (x := ancestor) in Hfits; [|exact Hin].
    apply Nat.leb_le in Hfits. exfalso. apply (Nat.lt_irrefl amount).
    exact (Nat.le_lt_trans amount ancestor amount Hfits Hover). }
  unfold step; simpl; unfold ancestor_charge. simpl. rewrite Hnot, andb_false_r. reflexivity.
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

Theorem successful_step_charges_every_ancestor :
  forall config state amount next ancestors,
    vm_status state = Running ->
    ancestor_charge (vm_budget state :: vm_ancestor_budgets state) amount = Some (next :: ancestors) ->
    vm_budget (step config (ICharge amount) state) ::
      vm_ancestor_budgets (step config (ICharge amount) state) =
      map (fun budget => budget - amount) (vm_budget state :: vm_ancestor_budgets state).
Proof.
  intros config [pc stack continuations budget parents storage status] amount next ancestors Hrun Hcharge.
  simpl in Hrun, Hcharge. destruct status; try discriminate.
  cbn [step vm_status vm_budget vm_ancestor_budgets]. rewrite Hcharge.
  apply post_huyao_charge_attribution_is_atomic. exact Hcharge.
Qed.

Theorem rollback_restores_storage_but_preserves_consumed_budget :
  forall initial final,
    vm_status final = Faulted ->
    vm_storage (transaction_result initial final) = vm_storage initial /\
    vm_budget (transaction_result initial final) = vm_budget final /\
    vm_ancestor_budgets (transaction_result initial final) = vm_ancestor_budgets final.
Proof.
  intros initial final H. unfold transaction_result. rewrite H. repeat split; reflexivity.
Qed.

Example bounded_native_callback_continuation :
  step (mkVmConfig true) (ICallback 99 7) example_initial =
    mkVmState 99 [] [BoundedContinuation 8] 7 [100] [1] Running.
Proof. reflexivity. Qed.

Example oversized_native_callback_faults :
  step (mkVmConfig true) (ICallback 99 101) example_initial = fault example_initial.
Proof. reflexivity. Qed.

Example zero_native_callback_faults :
  step (mkVmConfig true) (ICallback 99 0) example_initial = fault example_initial.
Proof. reflexivity. Qed.

Example load_script_preserves_parent_budget :
  step (mkVmConfig true) (ILoadScript 99) example_initial =
    mkVmState 99 [] [SharedContinuation 8] 100 [] [1] Running.
Proof. reflexivity. Qed.

Example initialization_can_run_for_each_load :
  vm_status (run (mkVmConfig true) [IInit; IInit] example_initial) = Running.
Proof. reflexivity. Qed.

Example disabled_callback_cap_faults_without_state_change :
  step (mkVmConfig false) (ICallback 99 7) example_initial = fault example_initial.
Proof. reflexivity. Qed.

Example failed_charge_does_not_reduce_budget :
  step (mkVmConfig true) (ICharge 101) example_initial = fault example_initial.
Proof. reflexivity. Qed.

Example callback_return_preserves_parent_97 :
  run (mkVmConfig true) [ICallback 99 10; ICharge 3; IRet] example_initial =
    mkVmState 8 [] [] 97 [] [1] Running.
Proof. reflexivity. Qed.

Example sibling_callback_20_is_admitted :
  run (mkVmConfig true) [ICallback 99 10; ICharge 3; IRet; ICallback 77 20] example_initial =
    mkVmState 77 [] [BoundedContinuation 9] 20 [97] [1] Running.
Proof. reflexivity. Qed.

Example nested_callbacks_charge_all_ancestors :
  run (mkVmConfig true) [ICallback 99 10; ICallback 88 5; ICharge 3] example_initial =
    mkVmState 89 [] [BoundedContinuation 100; BoundedContinuation 8] 2 [7; 97] [1] Running.
Proof. reflexivity. Qed.

Example nested_callbacks_restore_all_ancestors :
  run (mkVmConfig true) [ICallback 99 10; ICallback 88 5; ICharge 3; IRet; IRet] example_initial =
    mkVmState 8 [] [] 97 [] [1] Running.
Proof. reflexivity. Qed.

Example ordinary_descendants_alias_budget_once :
  run (mkVmConfig true)
    [ICallback 99 10; ICallT 88; ICall 77; ILoadScript 66; ICharge 3; IRet; IRet; IRet; IRet]
    example_initial = mkVmState 8 [] [] 97 [] [1] Running.
Proof. reflexivity. Qed.

Example ancestor_admission_is_checked :
  step (mkVmConfig true) (ICallback 99 8) (mkVmState 7 [] [] 10 [7; 100] [1] Running) =
    fault (mkVmState 7 [] [] 10 [7; 100] [1] Running).
Proof. reflexivity. Qed.

Example ancestor_exhaustion_is_atomic :
  step (mkVmConfig true) (ICharge 8) (mkVmState 7 [] [] 10 [7; 100] [1] Running) =
    fault (mkVmState 7 [] [] 10 [7; 100] [1] Running).
Proof. reflexivity. Qed.

Example child_exhaustion_is_atomic :
  run (mkVmConfig true) [ICallback 99 10; ICharge 3; ICharge 8] example_initial =
    mkVmState 100 [] [BoundedContinuation 8] 7 [97] [1] Faulted.
Proof. reflexivity. Qed.

Example fault_rolls_back_storage_but_not_budget :
  transaction_result example_initial
    (mkVmState 8 [] [BoundedContinuation 8] 3 [93] [99] Faulted) =
    mkVmState 8 [] [BoundedContinuation 8] 3 [93] [1] Faulted.
Proof. reflexivity. Qed.

Print Assumptions callback_budget_is_bounded.
Print Assumptions callback_budget_is_positive.
Print Assumptions callback_chain_checks_every_ancestor.
Print Assumptions oversized_callback_is_rejected.
Print Assumptions zero_callback_is_rejected.
Print Assumptions load_script_inherits_budget_and_continuation.
Print Assumptions callt_ret_returns_to_saved_continuation.
Print Assumptions ordinary_calls_share_budget_chain.
Print Assumptions shared_call_charge_return_preserves_debits.
Print Assumptions bounded_call_charge_return_restores_charged_parent.
Print Assumptions initialization_is_per_load_context.
Print Assumptions callback_hardfork_gate_is_fail_closed.
Print Assumptions failed_charge_is_atomic.
Print Assumptions failed_ancestor_charge_is_atomic.
Print Assumptions post_huyao_charge_attribution_is_atomic.
Print Assumptions successful_step_charges_every_ancestor.
Print Assumptions rollback_restores_storage_but_preserves_consumed_budget.
Print Assumptions bounded_native_callback_continuation.
Print Assumptions oversized_native_callback_faults.
Print Assumptions zero_native_callback_faults.
Print Assumptions load_script_preserves_parent_budget.
Print Assumptions initialization_can_run_for_each_load.
Print Assumptions disabled_callback_cap_faults_without_state_change.
Print Assumptions failed_charge_does_not_reduce_budget.
Print Assumptions callback_return_preserves_parent_97.
Print Assumptions sibling_callback_20_is_admitted.
Print Assumptions nested_callbacks_charge_all_ancestors.
Print Assumptions nested_callbacks_restore_all_ancestors.
Print Assumptions ordinary_descendants_alias_budget_once.
Print Assumptions ancestor_admission_is_checked.
Print Assumptions ancestor_exhaustion_is_atomic.
Print Assumptions child_exhaustion_is_atomic.
Print Assumptions fault_rolls_back_storage_but_not_budget.
