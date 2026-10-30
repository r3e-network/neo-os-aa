(** * Exception identity and catchability

    The four failure paths a single instruction turn can take, read out of the
    pinned VM and ApplicationEngine declarations:

    - a [Catchable] exception, admitted by the limit guard, with a TRY handler in
      place: the handler runs and receives the *message*;
    - the same exception with no handler: the turn faults and the host records a
      wrapper around the message;
    - the same exception with the limit off: nothing catches it, the outer
      untyped handler faults and the host records the exception itself;
    - any other exception: identical to the previous case, whatever its type.

    The point of the model is that the contract-visible channel carries a string
    and never a type, while the host-visible channel carries the exception and
    never the string alone. *)

Require Import Coq.Lists.List Coq.Bool.Bool Coq.Arith.Arith.
Import ListNotations.

(** ** The recorded exception classes *)

Inductive FaultKind := Catchable | Uncatchable.

Scheme Equality for FaultKind.

(** ** The ordered steps of one instruction turn *)

Inductive ExecStep :=
| ReadInstruction
| GuardedCatch
| PostHook
| AdvancePointer
| FaultHandler.

Scheme Equality for ExecStep.

(** Where a step sits in the recorded order. *)
Fixpoint index_of (needle : ExecStep) (steps : list ExecStep) (from : nat) : option nat :=
  match steps with
  | [] => None
  | head :: tail =>
      if ExecStep_eq_dec head needle then Some from else index_of needle tail (S from)
  end.

(** [earlier a b steps] holds when [a] is recorded strictly before [b]. *)
Definition earlier (a b : ExecStep) (steps : list ExecStep) : bool :=
  match index_of a steps 0 with
  | Some i =>
      match index_of b steps 0 with
      | Some j => Nat.ltb i j
      | None => false
      end
  | None => false
  end.

(** ** The projected record

    One field per projected key, same polarity: [true] always means "the source
    says so". *)

Record CatchProgram := catch_program {
  cp_steps : list ExecStep;
  cp_catch_names_the_catchable_type : bool;
  cp_catch_is_guarded_by_the_limit : bool;
  cp_generic_handler_is_untyped : bool;
  cp_caught_value_is_the_message : bool;
  cp_fault_sets_the_state : bool;
  cp_thrown_value_is_recorded_at_entry : bool;
  cp_a_handler_clears_the_recorded_value : bool;
  cp_the_handler_receives_the_thrown_value : bool;
  cp_the_walk_skips_the_finally_and_consumed_catch : bool;
  cp_an_absent_handler_wraps_the_value : bool;
  cp_a_dedicated_catchable_type_exists : bool;
  cp_the_wrapper_keeps_the_thrown_object : bool;
  cp_the_engine_records_the_fault : bool;
  cp_the_engine_clears_the_notifications : bool;
  cp_the_limit_defaults_to_catching : bool;
}.

(** ** What a caller can observe *)

Record Outcome := outcome {
  o_state_is_fault : bool;
  o_a_handler_ran : bool;
  o_the_contract_received_the_message : bool;
  o_the_host_recorded_the_wrapper : bool;
  o_the_host_recorded_the_original : bool;
  o_the_notifications_were_cleared : bool;
  o_the_pointer_advanced : bool
}.

(** ** Admission

    Admission needs three things at once: the guarded clause must name the class
    that was thrown, the limit must let the filter through, and the guarded
    clause must sit before the terminal fault handler in the recorded order. The
    last conjunct is what a reordered exception table would break. *)

Definition admits (p : CatchProgram) (kind : FaultKind) (limit : bool) : bool :=
  andb (earlier GuardedCatch FaultHandler (cp_steps p))
       (match kind with
        | Catchable =>
            andb (cp_catch_names_the_catchable_type p)
                 (implb (cp_catch_is_guarded_by_the_limit p) limit)
        | Uncatchable => false
        end).

(** ** Surfacing *)

Definition fault_outcome (p : CatchProgram) (wrapper original : bool) : Outcome :=
  {| o_state_is_fault := cp_fault_sets_the_state p;
     o_a_handler_ran := false;
     o_the_contract_received_the_message := false;
     o_the_host_recorded_the_wrapper := wrapper;
     o_the_host_recorded_the_original := original;
     o_the_notifications_were_cleared := cp_the_engine_clears_the_notifications p;
     o_the_pointer_advanced := negb (cp_fault_sets_the_state p) |}.

Definition surfaced (p : CatchProgram) (kind : FaultKind) (limit handler : bool) : Outcome :=
  if admits p kind limit
  then if handler
       then {| o_state_is_fault := false;
               o_a_handler_ran := true;
               o_the_contract_received_the_message := cp_caught_value_is_the_message p;
               o_the_host_recorded_the_wrapper := false;
               o_the_host_recorded_the_original := false;
               o_the_notifications_were_cleared := false;
               o_the_pointer_advanced := true |}
       else fault_outcome p
              (andb (cp_an_absent_handler_wraps_the_value p) (cp_the_engine_records_the_fault p))
              false
  else fault_outcome p false (cp_the_engine_records_the_fault p).

(** ** The recorded orders *)

Definition canonical_steps : list ExecStep :=
  [ReadInstruction; GuardedCatch; PostHook; AdvancePointer; FaultHandler].

Definition fault_first_steps : list ExecStep :=
  [ReadInstruction; PostHook; AdvancePointer; FaultHandler; GuardedCatch].

Definition swapped_hook_steps : list ExecStep :=
  [ReadInstruction; GuardedCatch; AdvancePointer; PostHook; FaultHandler].

(** ** The reviewed record *)

Definition reviewed_program : CatchProgram :=
  {| cp_steps := canonical_steps;
     cp_catch_names_the_catchable_type := true;
     cp_catch_is_guarded_by_the_limit := true;
     cp_generic_handler_is_untyped := true;
     cp_caught_value_is_the_message := true;
     cp_fault_sets_the_state := true;
     cp_thrown_value_is_recorded_at_entry := true;
     cp_a_handler_clears_the_recorded_value := true;
     cp_the_handler_receives_the_thrown_value := true;
     cp_the_walk_skips_the_finally_and_consumed_catch := true;
     cp_an_absent_handler_wraps_the_value := true;
     cp_a_dedicated_catchable_type_exists := true;
     cp_the_wrapper_keeps_the_thrown_object := true;
     cp_the_engine_records_the_fault := true;
     cp_the_engine_clears_the_notifications := true;
     cp_the_limit_defaults_to_catching := true |}.

(** ** Variant records

    One record per counterexample: each differs from the reviewed record in a
    single recorded fact, or in the recorded order alone. *)

Definition a_fault_first_record : CatchProgram :=
  {| cp_steps := fault_first_steps;
     cp_catch_names_the_catchable_type := true;
     cp_catch_is_guarded_by_the_limit := true;
     cp_generic_handler_is_untyped := true;
     cp_caught_value_is_the_message := true;
     cp_fault_sets_the_state := true;
     cp_thrown_value_is_recorded_at_entry := true;
     cp_a_handler_clears_the_recorded_value := true;
     cp_the_handler_receives_the_thrown_value := true;
     cp_the_walk_skips_the_finally_and_consumed_catch := true;
     cp_an_absent_handler_wraps_the_value := true;
     cp_a_dedicated_catchable_type_exists := true;
     cp_the_wrapper_keeps_the_thrown_object := true;
     cp_the_engine_records_the_fault := true;
     cp_the_engine_clears_the_notifications := true;
     cp_the_limit_defaults_to_catching := true |}.

Definition a_swapped_hook_record : CatchProgram :=
  {| cp_steps := swapped_hook_steps;
     cp_catch_names_the_catchable_type := true;
     cp_catch_is_guarded_by_the_limit := true;
     cp_generic_handler_is_untyped := true;
     cp_caught_value_is_the_message := true;
     cp_fault_sets_the_state := true;
     cp_thrown_value_is_recorded_at_entry := true;
     cp_a_handler_clears_the_recorded_value := true;
     cp_the_handler_receives_the_thrown_value := true;
     cp_the_walk_skips_the_finally_and_consumed_catch := true;
     cp_an_absent_handler_wraps_the_value := true;
     cp_a_dedicated_catchable_type_exists := true;
     cp_the_wrapper_keeps_the_thrown_object := true;
     cp_the_engine_records_the_fault := true;
     cp_the_engine_clears_the_notifications := true;
     cp_the_limit_defaults_to_catching := true |}.

Definition an_unguarded_record : CatchProgram :=
  {| cp_steps := canonical_steps;
     cp_catch_names_the_catchable_type := true;
     cp_catch_is_guarded_by_the_limit := false;
     cp_generic_handler_is_untyped := true;
     cp_caught_value_is_the_message := true;
     cp_fault_sets_the_state := true;
     cp_thrown_value_is_recorded_at_entry := true;
     cp_a_handler_clears_the_recorded_value := true;
     cp_the_handler_receives_the_thrown_value := true;
     cp_the_walk_skips_the_finally_and_consumed_catch := true;
     cp_an_absent_handler_wraps_the_value := true;
     cp_a_dedicated_catchable_type_exists := true;
     cp_the_wrapper_keeps_the_thrown_object := true;
     cp_the_engine_records_the_fault := true;
     cp_the_engine_clears_the_notifications := true;
     cp_the_limit_defaults_to_catching := true |}.

Definition a_misnamed_catch_record : CatchProgram :=
  {| cp_steps := canonical_steps;
     cp_catch_names_the_catchable_type := false;
     cp_catch_is_guarded_by_the_limit := true;
     cp_generic_handler_is_untyped := true;
     cp_caught_value_is_the_message := true;
     cp_fault_sets_the_state := true;
     cp_thrown_value_is_recorded_at_entry := true;
     cp_a_handler_clears_the_recorded_value := true;
     cp_the_handler_receives_the_thrown_value := true;
     cp_the_walk_skips_the_finally_and_consumed_catch := true;
     cp_an_absent_handler_wraps_the_value := true;
     cp_a_dedicated_catchable_type_exists := true;
     cp_the_wrapper_keeps_the_thrown_object := true;
     cp_the_engine_records_the_fault := true;
     cp_the_engine_clears_the_notifications := true;
     cp_the_limit_defaults_to_catching := true |}.

Definition an_object_handing_record : CatchProgram :=
  {| cp_steps := canonical_steps;
     cp_catch_names_the_catchable_type := true;
     cp_catch_is_guarded_by_the_limit := true;
     cp_generic_handler_is_untyped := true;
     cp_caught_value_is_the_message := false;
     cp_fault_sets_the_state := true;
     cp_thrown_value_is_recorded_at_entry := true;
     cp_a_handler_clears_the_recorded_value := true;
     cp_the_handler_receives_the_thrown_value := true;
     cp_the_walk_skips_the_finally_and_consumed_catch := true;
     cp_an_absent_handler_wraps_the_value := true;
     cp_a_dedicated_catchable_type_exists := true;
     cp_the_wrapper_keeps_the_thrown_object := true;
     cp_the_engine_records_the_fault := true;
     cp_the_engine_clears_the_notifications := true;
     cp_the_limit_defaults_to_catching := true |}.

Definition a_non_faulting_record : CatchProgram :=
  {| cp_steps := canonical_steps;
     cp_catch_names_the_catchable_type := true;
     cp_catch_is_guarded_by_the_limit := true;
     cp_generic_handler_is_untyped := true;
     cp_caught_value_is_the_message := true;
     cp_fault_sets_the_state := false;
     cp_thrown_value_is_recorded_at_entry := true;
     cp_a_handler_clears_the_recorded_value := true;
     cp_the_handler_receives_the_thrown_value := true;
     cp_the_walk_skips_the_finally_and_consumed_catch := true;
     cp_an_absent_handler_wraps_the_value := true;
     cp_a_dedicated_catchable_type_exists := true;
     cp_the_wrapper_keeps_the_thrown_object := true;
     cp_the_engine_records_the_fault := true;
     cp_the_engine_clears_the_notifications := true;
     cp_the_limit_defaults_to_catching := true |}.

Definition a_notification_keeping_record : CatchProgram :=
  {| cp_steps := canonical_steps;
     cp_catch_names_the_catchable_type := true;
     cp_catch_is_guarded_by_the_limit := true;
     cp_generic_handler_is_untyped := true;
     cp_caught_value_is_the_message := true;
     cp_fault_sets_the_state := true;
     cp_thrown_value_is_recorded_at_entry := true;
     cp_a_handler_clears_the_recorded_value := true;
     cp_the_handler_receives_the_thrown_value := true;
     cp_the_walk_skips_the_finally_and_consumed_catch := true;
     cp_an_absent_handler_wraps_the_value := true;
     cp_a_dedicated_catchable_type_exists := true;
     cp_the_wrapper_keeps_the_thrown_object := true;
     cp_the_engine_records_the_fault := true;
     cp_the_engine_clears_the_notifications := false;
     cp_the_limit_defaults_to_catching := true |}.

Definition an_object_dropping_record : CatchProgram :=
  {| cp_steps := canonical_steps;
     cp_catch_names_the_catchable_type := true;
     cp_catch_is_guarded_by_the_limit := true;
     cp_generic_handler_is_untyped := true;
     cp_caught_value_is_the_message := true;
     cp_fault_sets_the_state := true;
     cp_thrown_value_is_recorded_at_entry := true;
     cp_a_handler_clears_the_recorded_value := true;
     cp_the_handler_receives_the_thrown_value := true;
     cp_the_walk_skips_the_finally_and_consumed_catch := true;
     cp_an_absent_handler_wraps_the_value := false;
     cp_a_dedicated_catchable_type_exists := true;
     cp_the_wrapper_keeps_the_thrown_object := false;
     cp_the_engine_records_the_fault := true;
     cp_the_engine_clears_the_notifications := true;
     cp_the_limit_defaults_to_catching := true |}.

Definition an_unrecorded_engine_record : CatchProgram :=
  {| cp_steps := canonical_steps;
     cp_catch_names_the_catchable_type := true;
     cp_catch_is_guarded_by_the_limit := true;
     cp_generic_handler_is_untyped := true;
     cp_caught_value_is_the_message := true;
     cp_fault_sets_the_state := true;
     cp_thrown_value_is_recorded_at_entry := true;
     cp_a_handler_clears_the_recorded_value := true;
     cp_the_handler_receives_the_thrown_value := true;
     cp_the_walk_skips_the_finally_and_consumed_catch := true;
     cp_an_absent_handler_wraps_the_value := true;
     cp_a_dedicated_catchable_type_exists := true;
     cp_the_wrapper_keeps_the_thrown_object := true;
     cp_the_engine_records_the_fault := false;
     cp_the_engine_clears_the_notifications := true;
     cp_the_limit_defaults_to_catching := true |}.

(** ** The order is load bearing *)

Lemma the_reviewed_order_puts_the_catch_before_the_fault_handler :
  earlier GuardedCatch FaultHandler canonical_steps = true.
Proof. reflexivity. Qed.

Lemma the_reviewed_order_puts_the_hook_before_the_pointer_advance :
  earlier PostHook AdvancePointer canonical_steps = true.
Proof. reflexivity. Qed.

Lemma swapping_the_hook_and_the_pointer_advance_keeps_the_catch_first :
  earlier GuardedCatch FaultHandler swapped_hook_steps = true.
Proof. reflexivity. Qed.

(** ** The reviewed record on each path *)

Lemma the_reviewed_record_catches_a_catchable_exception :
  o_a_handler_ran (surfaced reviewed_program Catchable true true) = true.
Proof. reflexivity. Qed.

Lemma turning_the_limit_off_makes_the_reviewed_record_uncatchable :
  admits reviewed_program Catchable false = false.
Proof. reflexivity. Qed.

Lemma the_reviewed_record_faults_an_uncatchable_exception :
  o_state_is_fault (surfaced reviewed_program Uncatchable true false) = true.
Proof. reflexivity. Qed.

Lemma the_reviewed_record_wraps_when_no_handler_exists :
  o_the_host_recorded_the_wrapper (surfaced reviewed_program Catchable true false) = true.
Proof. reflexivity. Qed.

Lemma a_fault_first_record_admits_nothing :
  admits a_fault_first_record Catchable true = false.
Proof. reflexivity. Qed.

Lemma a_fault_first_record_can_never_run_a_handler :
  forall handler, o_a_handler_ran (surfaced a_fault_first_record Catchable true handler) = false.
Proof. intro handler. reflexivity. Qed.

(** ** Admission over every record *)

Lemma an_uncatchable_exception_is_never_admitted :
  forall p limit, admits p Uncatchable limit = false.
Proof. intros p limit. unfold admits. simpl. apply andb_false_r. Qed.

Lemma an_unguarded_record_catches_with_the_limit_off :
  admits an_unguarded_record Catchable false = true.
Proof. reflexivity. Qed.

Lemma a_misnamed_catch_record_admits_nothing :
  admits a_misnamed_catch_record Catchable true = false.
Proof. reflexivity. Qed.

Lemma surfaced_when_admitted :
  forall p kind limit handler,
    admits p kind limit = true ->
    surfaced p kind limit handler =
      (if handler
       then {| o_state_is_fault := false;
               o_a_handler_ran := true;
               o_the_contract_received_the_message := cp_caught_value_is_the_message p;
               o_the_host_recorded_the_wrapper := false;
               o_the_host_recorded_the_original := false;
               o_the_notifications_were_cleared := false;
               o_the_pointer_advanced := true |}
       else fault_outcome p
              (andb (cp_an_absent_handler_wraps_the_value p) (cp_the_engine_records_the_fault p))
              false).
Proof. intros p kind limit handler admitted. unfold surfaced. rewrite admitted. reflexivity. Qed.

Lemma surfaced_when_not_admitted :
  forall p kind limit handler,
    admits p kind limit = false ->
    surfaced p kind limit handler =
      fault_outcome p false (cp_the_engine_records_the_fault p).
Proof. intros p kind limit handler refused. unfold surfaced. rewrite refused. reflexivity. Qed.

Lemma an_uncatchable_exception_never_reaches_a_handler :
  forall p limit handler, o_a_handler_ran (surfaced p Uncatchable limit handler) = false.
Proof.
  intros p limit handler.
  rewrite (surfaced_when_not_admitted p Uncatchable limit handler
             (an_uncatchable_exception_is_never_admitted p limit)).
  reflexivity.
Qed.

(** ** What the contract is allowed to see *)

Lemma a_caught_turn_is_not_a_fault :
  forall p kind limit,
    admits p kind limit = true ->
    o_state_is_fault (surfaced p kind limit true) = false.
Proof. intros p kind limit admitted. rewrite (surfaced_when_admitted p kind limit true admitted). reflexivity. Qed.

Lemma a_caught_turn_receives_the_message :
  forall p kind limit,
    admits p kind limit = true ->
    o_the_contract_received_the_message (surfaced p kind limit true)
      = cp_caught_value_is_the_message p.
Proof. intros p kind limit admitted. rewrite (surfaced_when_admitted p kind limit true admitted). reflexivity. Qed.

Lemma handing_over_the_object_would_break_the_message_guarantee :
  o_the_contract_received_the_message (surfaced an_object_handing_record Catchable true true) = false.
Proof. reflexivity. Qed.

Lemma failures_the_engine_does_not_catch_are_indistinguishable :
  forall p limit handler (k1 k2 : FaultKind),
    admits p k1 limit = false ->
    admits p k2 limit = false ->
    surfaced p k1 limit handler = surfaced p k2 limit handler.
Proof.
  intros p limit handler k1 k2 h1 h2.
  rewrite (surfaced_when_not_admitted p k1 limit handler h1).
  rewrite (surfaced_when_not_admitted p k2 limit handler h2).
  reflexivity.
Qed.

(** ** The fault state and the finished turn *)

Lemma a_faulted_turn_skips_the_pointer_advance :
  forall p kind limit handler,
    admits p kind limit = false ->
    cp_fault_sets_the_state p = true ->
    o_the_pointer_advanced (surfaced p kind limit handler) = false.
Proof.
  intros p kind limit handler refused faulted.
  rewrite (surfaced_when_not_admitted p kind limit handler refused).
  unfold fault_outcome. simpl. rewrite faulted. reflexivity.
Qed.

Lemma an_engine_that_skips_the_fault_assignment_loses_the_fault_state :
  o_state_is_fault (surfaced a_non_faulting_record Uncatchable true false) = false.
Proof. reflexivity. Qed.

(** ** The notification set *)

Lemma the_fault_path_always_clears_the_notifications :
  forall p kind limit handler,
    admits p kind limit = false ->
    o_the_notifications_were_cleared (surfaced p kind limit handler)
      = cp_the_engine_clears_the_notifications p.
Proof.
  intros p kind limit handler refused.
  rewrite (surfaced_when_not_admitted p kind limit handler refused).
  reflexivity.
Qed.

Lemma a_caught_throw_leaves_the_notifications_alone :
  forall p kind limit,
    admits p kind limit = true ->
    o_the_notifications_were_cleared (surfaced p kind limit true) = false.
Proof. intros p kind limit admitted. rewrite (surfaced_when_admitted p kind limit true admitted). reflexivity. Qed.

Lemma an_engine_that_keeps_the_notifications_leaks_them_on_a_fault :
  o_the_notifications_were_cleared (surfaced a_notification_keeping_record Uncatchable true false)
    = false.
Proof. reflexivity. Qed.

(** ** Host-side identity *)

Lemma the_wrapper_and_the_original_are_never_both_recorded :
  forall p kind limit handler,
    o_the_host_recorded_the_wrapper (surfaced p kind limit handler) = true ->
    o_the_host_recorded_the_original (surfaced p kind limit handler) = false.
Proof.
  intros p kind limit handler wrapper.
  unfold surfaced in *.
  destruct (admits p kind limit).
  - destruct handler; simpl in *; try discriminate; reflexivity.
  - unfold fault_outcome in *. simpl in *. congruence.
Qed.

Lemma a_caught_turn_records_no_wrapper :
  forall p kind limit,
    admits p kind limit = true ->
    o_the_host_recorded_the_wrapper (surfaced p kind limit true) = false.
Proof. intros p kind limit admitted. rewrite (surfaced_when_admitted p kind limit true admitted). reflexivity. Qed.

Lemma a_caught_turn_records_no_exception_at_all :
  forall p kind limit,
    admits p kind limit = true ->
    o_the_host_recorded_the_original (surfaced p kind limit true) = false.
Proof. intros p kind limit admitted. rewrite (surfaced_when_admitted p kind limit true admitted). reflexivity. Qed.

Lemma a_wrapper_that_drops_the_object_leaves_the_host_with_a_shell :
  o_the_host_recorded_the_wrapper (surfaced an_object_dropping_record Catchable true false) = false.
Proof. reflexivity. Qed.

Lemma an_unrecorded_engine_leaves_the_host_with_no_exception :
  o_the_host_recorded_the_original (surfaced an_unrecorded_engine_record Uncatchable true false)
    = false.
Proof. reflexivity. Qed.
(** * Assumption inventory *)
Print Assumptions the_reviewed_order_puts_the_catch_before_the_fault_handler.
Print Assumptions the_reviewed_order_puts_the_hook_before_the_pointer_advance.
Print Assumptions swapping_the_hook_and_the_pointer_advance_keeps_the_catch_first.
Print Assumptions the_reviewed_record_catches_a_catchable_exception.
Print Assumptions turning_the_limit_off_makes_the_reviewed_record_uncatchable.
Print Assumptions the_reviewed_record_faults_an_uncatchable_exception.
Print Assumptions the_reviewed_record_wraps_when_no_handler_exists.
Print Assumptions a_fault_first_record_admits_nothing.
Print Assumptions a_fault_first_record_can_never_run_a_handler.
Print Assumptions an_uncatchable_exception_is_never_admitted.
Print Assumptions an_unguarded_record_catches_with_the_limit_off.
Print Assumptions a_misnamed_catch_record_admits_nothing.
Print Assumptions surfaced_when_admitted.
Print Assumptions surfaced_when_not_admitted.
Print Assumptions an_uncatchable_exception_never_reaches_a_handler.
Print Assumptions a_caught_turn_is_not_a_fault.
Print Assumptions a_caught_turn_receives_the_message.
Print Assumptions handing_over_the_object_would_break_the_message_guarantee.
Print Assumptions failures_the_engine_does_not_catch_are_indistinguishable.
Print Assumptions a_faulted_turn_skips_the_pointer_advance.
Print Assumptions an_engine_that_skips_the_fault_assignment_loses_the_fault_state.
Print Assumptions the_fault_path_always_clears_the_notifications.
Print Assumptions a_caught_throw_leaves_the_notifications_alone.
Print Assumptions an_engine_that_keeps_the_notifications_leaks_them_on_a_fault.
Print Assumptions the_wrapper_and_the_original_are_never_both_recorded.
Print Assumptions a_caught_turn_records_no_wrapper.
Print Assumptions a_caught_turn_records_no_exception_at_all.
Print Assumptions a_wrapper_that_drops_the_object_leaves_the_host_with_a_shell.
Print Assumptions an_unrecorded_engine_leaves_the_host_with_no_exception.
