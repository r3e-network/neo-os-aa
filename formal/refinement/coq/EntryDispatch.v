(* Ordinary ABI admission and pre-execution frame construction only.
   Values, scripts, contracts, contexts and shared states have opaque natural
   number identities. A shared identity denotes the evaluation stack, statics,
   and custom ExecutionContextState together. Equal record snapshots below
   describe the state after the shared argument/caller/dynamic updates.

   The trusted source frontend supplies DispatchProgram. This file does not
   prove that frontend, CLR execution, allocation, policy/storage lookups,
   accounting, limits, callbacks, initializer/body execution, RET or rollback.
   Diagnostics must be disabled and virtual calls must dispatch to the pinned
   ordinary implementations, without host/subclass overrides. External cache,
   fee and reference-counter operations must succeed without changing the
   projected frames; their global side effects are not modeled.
   projection_ready and fresh_dispatch_ids state the successful projection's
   external prerequisites; they are assumptions, not results of this model.
   Entry is after interop admission and argument conversion, not the syscall
   wrapper. Caller preservation concerns projected frame/stack containers, not
   invocation/reference counters, caches, fees, global resources or aliased
   mutable objects. None classifies rejected admission, not exception rollback. *)
From Coq Require Import NArith PeanoNat List Bool Lia String Ascii.
Import ListNotations.
Open Scope string_scope.
Open Scope list_scope.

Record DispatchProgram := dispatch_program {
  dp_exact_arity : bool;
  dp_reject_underscore : bool;
  dp_check_count : bool;
  dp_check_return : bool;
  dp_allowed_flags : N;
  dp_safe_clear_mask : N;
  dp_intersect_flags : bool;
  dp_nonvoid_rv : nat;
  dp_void_rv : nat;
  dp_offset_delta : nat;
  dp_reverse_push : bool;
  dp_initializer_first : bool;
  dp_clone_shared : bool;
  dp_clone_rv : nat;
  dp_record_caller : bool;
  dp_dynamic : bool;
  dp_max_arity : nat
}.

Definition canonical_program :=
  dispatch_program true true true true 15%N 10%N true
    1 0 0 true true true 0 true true 65535.

Record Descriptor := descriptor {
  descriptor_name : string;
  descriptor_arity : nat;
  descriptor_offset : nat;
  descriptor_safe : bool;
  descriptor_nonvoid : bool
}.

Record Frame := frame {
  frame_id : nat;
  frame_contract : nat;
  frame_script : nat;
  frame_offset : nat;
  frame_rv : nat;
  frame_shared : nat;
  frame_stack : list nat;
  frame_locals : option (list nat);
  frame_arguments : option (list nat);
  frame_statics : option (list nat);
  frame_flags : N;
  frame_caller : option nat;
  frame_dynamic : bool
}.

Record DispatchIds := dispatch_ids {
  ids_contract : nat;
  ids_script : nat;
  ids_method : nat;
  ids_initializer : nat;
  ids_shared : nat;
  ids_fresh_clone : nat
}.

Record DispatchOutcome := dispatch_outcome {
  returned_method : Frame;
  invocation_frames : list Frame
}.

Definition starts_underscore (name : string) : bool :=
  match name with
  | EmptyString => false
  | String first _ => Ascii.eqb first "_"%char
  end.

Definition valid_flags (flags : N) : Prop := N.land flags 15%N = flags.

(* The ABI cache is required to be coherent and its keys unique externally.
   Ordered list selection therefore represents the dictionary's exact key. *)
Fixpoint abi_select (abi : list Descriptor) (name : string) (arity : nat)
  : option Descriptor :=
  match abi with
  | [] => None
  | d :: rest =>
      if String.eqb (descriptor_name d) name &&
         Nat.eqb (descriptor_arity d) arity
      then Some d else abi_select rest name arity
  end.

Fixpoint source_lookup (p : DispatchProgram) (abi : list Descriptor)
  (name : string) (arity : nat) : option Descriptor :=
  match abi with
  | [] => None
  | d :: rest =>
      if String.eqb (descriptor_name d) name &&
         (if dp_exact_arity p then Nat.eqb (descriptor_arity d) arity else true)
      then Some d else source_lookup p rest name arity
  end.

Fixpoint push_values (values stack : list nat) : list nat :=
  match values with
  | [] => stack
  | value :: rest => push_values rest (value :: stack)
  end.

Definition source_arguments p args :=
  push_values (if dp_reverse_push p then rev args else args) [].

Definition source_flags p d requested caller :=
  let restricted := if descriptor_safe d
                    then N.ldiff requested (dp_safe_clear_mask p)
                    else requested in
  if dp_intersect_flags p
  then N.land restricted (frame_flags caller)
  else N.lor restricted (frame_flags caller).

Definition source_method p d args requested caller ids : Frame :=
  frame (ids_method ids) (ids_contract ids) (ids_script ids)
    (descriptor_offset d + dp_offset_delta p)
    (if descriptor_nonvoid d then dp_nonvoid_rv p else dp_void_rv p)
    (ids_shared ids) (source_arguments p args) None None None
    (source_flags p d requested caller)
    (if dp_record_caller p then Some (frame_id caller) else None)
    (dp_dynamic p).

Definition source_initializer p method ids offset : Frame :=
  frame (ids_initializer ids) (frame_contract method) (frame_script method)
    offset (dp_clone_rv p)
    (if dp_clone_shared p then frame_shared method else ids_fresh_clone ids)
    (if dp_clone_shared p then frame_stack method else [])
    None None (if dp_clone_shared p then frame_statics method else None)
    (if dp_clone_shared p then frame_flags method else 15%N)
    (if dp_clone_shared p then frame_caller method else None)
    (if dp_clone_shared p then frame_dynamic method else false).

Definition source_frames p method caller tail ids init : list Frame :=
  match init with
  | None => method :: caller :: tail
  | Some offset =>
      let cloned := source_initializer p method ids offset in
      if dp_initializer_first p
      then cloned :: method :: caller :: tail
      else method :: cloned :: caller :: tail
  end.

Definition source_internal_call p d has_return args requested caller tail ids init
  : option DispatchOutcome :=
  if (if dp_check_count p
      then Nat.eqb (List.length args) (descriptor_arity d) else true) &&
     (if dp_check_return p
      then Bool.eqb has_return (descriptor_nonvoid d) else true)
  then let method := source_method p d args requested caller ids in
       Some (dispatch_outcome method
         (source_frames p method caller tail ids init))
  else None.

Definition source_call p abi name args requested caller tail ids init
  : option DispatchOutcome :=
  if (if dp_reject_underscore p then negb (starts_underscore name) else true) &&
     N.eqb (N.land requested (dp_allowed_flags p)) requested &&
     Nat.leb (List.length args) (dp_max_arity p)
  then match source_lookup p abi name (List.length args) with
       | None => None
       | Some d => source_internal_call p d (descriptor_nonvoid d)
                     args requested caller tail ids init
       end
  else None.

(* Normative results have fixed policies, no DispatchProgram argument, no
   reference to the source interpreter and no source push/clone helpers. *)
Definition spec_flags d requested caller :=
  if descriptor_safe d
  then N.land (N.land requested (frame_flags caller)) 5%N
  else N.land requested (frame_flags caller).

Definition spec_method d args requested caller ids : Frame :=
  frame (ids_method ids) (ids_contract ids) (ids_script ids)
    (descriptor_offset d) (if descriptor_nonvoid d then 1 else 0)
    (ids_shared ids) args None None None (spec_flags d requested caller)
    (Some (frame_id caller)) true.

Definition spec_initializer d args requested caller ids offset : Frame :=
  frame (ids_initializer ids) (ids_contract ids) (ids_script ids)
    offset 0 (ids_shared ids) args None None None
    (spec_flags d requested caller) (Some (frame_id caller)) true.

Definition spec_success d args requested caller tail ids init : DispatchOutcome :=
  dispatch_outcome (spec_method d args requested caller ids)
    (match init with
     | None => spec_method d args requested caller ids :: caller :: tail
     | Some offset => spec_initializer d args requested caller ids offset ::
         spec_method d args requested caller ids :: caller :: tail
     end).

Record ProjectionEnvironment := projection_environment {
  env_deployed : bool;
  env_unblocked : bool;
  env_abi_unique : bool;
  env_abi_cache_coherent : bool;
  env_instruction_boundaries : list nat;
  env_stack_limit : nat;
  env_resources_available : bool;
  env_external_operations_succeed : bool;
  env_external_operations_noninterfering : bool;
  env_diagnostics_disabled : bool;
  env_default_dispatch : bool
}.

Definition projection_ready env d (tail : list Frame) (init : option nat) : Prop :=
  env_deployed env = true /\ env_unblocked env = true /\
  env_abi_unique env = true /\ env_abi_cache_coherent env = true /\
  In (descriptor_offset d) (env_instruction_boundaries env) /\
  (match init with None => True
   | Some offset => In offset (env_instruction_boundaries env) end) /\
  (List.length tail + (match init with None => 2 | Some _ => 3 end)
    <= env_stack_limit env)%nat /\
  env_resources_available env = true /\
  env_external_operations_succeed env = true /\
  env_external_operations_noninterfering env = true /\
  env_diagnostics_disabled env = true /\
  env_default_dispatch env = true.

Definition fresh_dispatch_ids ids caller tail : Prop :=
  ~ In (ids_shared ids) (map frame_shared (caller :: tail)) /\
  ~ In (ids_method ids) (map frame_id (caller :: tail)) /\
  ~ In (ids_initializer ids) (map frame_id (caller :: tail)) /\
  ids_method ids <> ids_initializer ids /\
  ids_fresh_clone ids <> ids_shared ids.

Lemma push_values_order : forall values stack,
  push_values values stack = rev values ++ stack.
Proof.
  induction values as [|value rest IH]; intros stack; cbn.
  - reflexivity.
  - rewrite IH, <- app_assoc. reflexivity.
Qed.

Theorem reverse_push_preserves_argument_order : forall args,
  source_arguments canonical_program args = args.
Proof.
  intros args. unfold source_arguments. cbn [dp_reverse_push canonical_program].
  rewrite push_values_order, rev_involutive, app_nil_r. reflexivity.
Qed.

Lemma ldiff_land_right : forall a b c,
  N.ldiff (N.land a b) c = N.land a (N.ldiff b c).
Proof.
  intros a b c. apply N.bits_inj. intro bit.
  repeat rewrite N.ldiff_spec. repeat rewrite N.land_spec.
  repeat rewrite N.ldiff_spec. rewrite Bool.andb_assoc. reflexivity.
Qed.

Lemma safe_mask_is_five : forall requested,
  valid_flags requested -> N.ldiff requested 10%N = N.land requested 5%N.
Proof.
  intros requested H. unfold valid_flags in H.
  rewrite <- H at 1. rewrite ldiff_land_right. reflexivity.
Qed.

Lemma canonical_flags_match : forall d requested caller,
  valid_flags requested ->
  source_flags canonical_program d requested caller = spec_flags d requested caller.
Proof.
  intros d requested caller H. unfold source_flags, spec_flags.
  cbn [canonical_program dp_safe_clear_mask dp_intersect_flags].
  destruct (descriptor_safe d); [|reflexivity].
  rewrite safe_mask_is_five by exact H.
  rewrite <- (N.land_assoc requested 5%N (frame_flags caller)).
  rewrite (N.land_comm 5%N (frame_flags caller)), N.land_assoc. reflexivity.
Qed.

Lemma canonical_lookup_exact : forall abi name arity,
  source_lookup canonical_program abi name arity = abi_select abi name arity.
Proof.
  induction abi as [|d rest IH]; intros name arity; cbn; [reflexivity|].
  rewrite IH. reflexivity.
Qed.

Lemma exact_lookup_matches_count : forall abi name arity d,
  abi_select abi name arity = Some d -> descriptor_arity d = arity.
Proof.
  induction abi as [|head rest IH]; intros name arity d H; cbn in H; [discriminate|].
  destruct (String.eqb (descriptor_name head) name &&
            Nat.eqb (descriptor_arity head) arity) eqn:E.
  - inversion H; subst d. apply andb_true_iff in E as [_ E].
    apply Nat.eqb_eq in E. exact E.
  - eapply IH. exact H.
Qed.

Lemma canonical_method_matches : forall d args requested caller ids,
  valid_flags requested ->
  source_method canonical_program d args requested caller ids =
    spec_method d args requested caller ids.
Proof.
  intros d args requested caller ids H. unfold source_method, spec_method.
  rewrite reverse_push_preserves_argument_order, canonical_flags_match by exact H.
  cbn [canonical_program dp_offset_delta dp_nonvoid_rv dp_void_rv dp_record_caller dp_dynamic].
  rewrite Nat.add_0_r. reflexivity.
Qed.

Lemma canonical_frames_match : forall d args requested caller tail ids init,
  source_frames canonical_program (spec_method d args requested caller ids)
    caller tail ids init = invocation_frames (spec_success d args requested caller tail ids init).
Proof. intros. destruct init; reflexivity. Qed.

Theorem projected_call_refines_spec : forall abi name d args requested caller tail ids init,
  starts_underscore name = false ->
  valid_flags requested ->
  (List.length args <= 65535)%nat ->
  abi_select abi name (List.length args) = Some d ->
  source_call canonical_program abi name args requested caller tail ids init =
    Some (spec_success d args requested caller tail ids init).
Proof.
  intros abi name d args requested caller tail ids init Hname Hflags Hbound Hlookup.
  unfold source_call. cbn [canonical_program dp_reject_underscore dp_allowed_flags dp_max_arity].
  rewrite Hname. unfold valid_flags in Hflags. rewrite Hflags, N.eqb_refl.
  apply Nat.leb_le in Hbound. rewrite Hbound.
  cbn [negb andb]. rewrite canonical_lookup_exact, Hlookup.
  unfold source_internal_call. cbn [canonical_program dp_check_count dp_check_return].
  pose proof (exact_lookup_matches_count _ _ _ _ Hlookup) as Hcount.
  rewrite Hcount, Nat.eqb_refl, Bool.eqb_reflx. cbn [andb].
  rewrite canonical_method_matches by exact Hflags.
  rewrite canonical_frames_match. reflexivity.
Qed.

(* This named theorem is the supported safe, nonvoid successful envelope.
   Readiness/freshness are explicit premises even though the structural
   interpreter cannot establish or fault on the external conditions. *)
Theorem safe_call_frame_refines_spec : forall env abi name d args requested caller tail ids init,
  projection_ready env d tail init ->
  init = option_map descriptor_offset (abi_select abi "_initialize" 0) ->
  fresh_dispatch_ids ids caller tail ->
  descriptor_safe d = true ->
  descriptor_nonvoid d = true ->
  starts_underscore name = false ->
  valid_flags requested ->
  valid_flags (frame_flags caller) ->
  (List.length args <= 65535)%nat ->
  abi_select abi name (List.length args) = Some d ->
  source_call canonical_program abi name args requested caller tail ids init =
    Some (spec_success d args requested caller tail ids init).
Proof.
  intros env abi name d args requested caller tail ids init
    Hready Hinit Hfresh Hsafe Hnonvoid Hname Hflags Hcaller Hbound Hlookup.
  apply projected_call_refines_spec; assumption.
Qed.

(* Generated certificates instantiate this theorem with the actual source
   projection record, and prove its equality by kernel computation. The
   program is used in the conclusion, never merely mentioned in provenance. *)
Theorem source_bound_safe_call_frame_refines_spec : forall p env abi name d args requested caller tail ids init,
  p = canonical_program ->
  projection_ready env d tail init ->
  init = option_map descriptor_offset (abi_select abi "_initialize" 0) ->
  fresh_dispatch_ids ids caller tail ->
  descriptor_safe d = true ->
  descriptor_nonvoid d = true ->
  starts_underscore name = false ->
  valid_flags requested ->
  valid_flags (frame_flags caller) ->
  (List.length args <= 65535)%nat ->
  abi_select abi name (List.length args) = Some d ->
  source_call p abi name args requested caller tail ids init =
    Some (spec_success d args requested caller tail ids init).
Proof.
  intros p env abi name d args requested caller tail ids init Hprogram.
  subst p. apply safe_call_frame_refines_spec.
Qed.

Theorem underscore_admission_rejected : forall abi name args requested caller tail ids init,
  starts_underscore name = true ->
  source_call canonical_program abi name args requested caller tail ids init = None.
Proof.
  intros. unfold source_call. cbn [canonical_program dp_reject_underscore].
  rewrite H. reflexivity.
Qed.

Theorem invalid_flags_admission_rejected : forall abi name args requested caller tail ids init,
  ~ valid_flags requested ->
  source_call canonical_program abi name args requested caller tail ids init = None.
Proof.
  intros abi name args requested caller tail ids init H.
  unfold source_call. cbn [canonical_program dp_reject_underscore dp_allowed_flags].
  assert (N.eqb (N.land requested 15%N) requested = false) as E.
  { apply N.eqb_neq. exact H. }
  rewrite E, andb_false_r. reflexivity.
Qed.

Theorem missing_exact_arity_rejected : forall abi name args requested caller tail ids init,
  abi_select abi name (List.length args) = None ->
  source_call canonical_program abi name args requested caller tail ids init = None.
Proof.
  intros. unfold source_call. rewrite canonical_lookup_exact, H.
  destruct ((if dp_reject_underscore canonical_program
             then negb (starts_underscore name) else true) &&
            N.eqb (N.land requested (dp_allowed_flags canonical_program)) requested &&
            Nat.leb (List.length args) (dp_max_arity canonical_program));
    reflexivity.
Qed.

Theorem oversized_arity_rejected : forall abi name args requested caller tail ids init,
  (65535 < List.length args)%nat ->
  source_call canonical_program abi name args requested caller tail ids init = None.
Proof.
  intros abi name args requested caller tail ids init H.
  unfold source_call. cbn [canonical_program dp_max_arity].
  apply Nat.leb_gt in H. rewrite H, andb_false_r. reflexivity.
Qed.

Theorem count_mismatch_rejected : forall d has_return args requested caller tail ids init,
  List.length args <> descriptor_arity d ->
  source_internal_call canonical_program d has_return args requested caller tail ids init = None.
Proof.
  intros d has_return args requested caller tail ids init H.
  unfold source_internal_call. cbn [canonical_program dp_check_count].
  apply Nat.eqb_neq in H. rewrite H. reflexivity.
Qed.

Theorem return_mismatch_rejected : forall d has_return args requested caller tail ids init,
  has_return <> descriptor_nonvoid d ->
  source_internal_call canonical_program d has_return args requested caller tail ids init = None.
Proof.
  intros d has_return args requested caller tail ids init H.
  unfold source_internal_call. cbn [canonical_program dp_check_return].
  destruct has_return, (descriptor_nonvoid d); try contradiction;
    cbn [Bool.eqb]; rewrite andb_false_r; reflexivity.
Qed.

Theorem constructed_caller_tail_unchanged : forall d args requested caller tail ids init,
  skipn (match init with None => 1 | Some _ => 2 end)
    (invocation_frames (spec_success d args requested caller tail ids init)) = caller :: tail.
Proof. intros. destruct init; reflexivity. Qed.

Theorem method_shared_state_fresh : forall d args requested caller tail ids,
  fresh_dispatch_ids ids caller tail ->
  ~ In (frame_shared (spec_method d args requested caller ids))
       (map frame_shared (caller :: tail)).
Proof. intros d args requested caller tail ids H. exact (proj1 H). Qed.

Theorem initializer_shares_state_and_arguments : forall d args requested caller ids offset,
  frame_shared (spec_initializer d args requested caller ids offset) =
    frame_shared (spec_method d args requested caller ids) /\
  frame_stack (spec_initializer d args requested caller ids offset) = args /\
  frame_statics (spec_initializer d args requested caller ids offset) = None /\
  frame_rv (spec_initializer d args requested caller ids offset) = 0 /\
  frame_caller (spec_initializer d args requested caller ids offset) = Some (frame_id caller) /\
  frame_dynamic (spec_initializer d args requested caller ids offset) = true.
Proof. intros. repeat split; reflexivity. Qed.

(* Public concrete witnesses for source-mutant certificate rejection. They are
   illustrative identities, not any deployed artifact or public method. *)
Definition dispatch_fixture_caller :=
  frame 1 7 11 19 1 2 [41; 43] (Some [47]) (Some [53]) (Some [59]) 15%N None false.
Definition dispatch_fixture_ids := dispatch_ids 71 73 79 83 89 97.
Definition dispatch_fixture_descriptor := descriptor "probe" 2 101 true true.
Definition dispatch_fixture_args := [103; 107].

Print Assumptions push_values_order.
Print Assumptions reverse_push_preserves_argument_order.
Print Assumptions ldiff_land_right.
Print Assumptions safe_mask_is_five.
Print Assumptions canonical_flags_match.
Print Assumptions canonical_lookup_exact.
Print Assumptions exact_lookup_matches_count.
Print Assumptions canonical_method_matches.
Print Assumptions canonical_frames_match.
Print Assumptions projected_call_refines_spec.
Print Assumptions safe_call_frame_refines_spec.
Print Assumptions source_bound_safe_call_frame_refines_spec.
Print Assumptions underscore_admission_rejected.
Print Assumptions invalid_flags_admission_rejected.
Print Assumptions missing_exact_arity_rejected.
Print Assumptions oversized_arity_rejected.
Print Assumptions count_mismatch_rejected.
Print Assumptions return_mismatch_rejected.
Print Assumptions constructed_caller_tail_unchanged.
Print Assumptions method_shared_state_fresh.
Print Assumptions initializer_shares_state_and_arguments.
