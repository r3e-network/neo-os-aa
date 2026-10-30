(** * The CallContractInternal handoff and the frame LoadContract builds.

    This layer starts where [EntryDispatch.v] ends forward and where the
    [syscall-dispatch] lane stops: the second [CallContractInternal] overload
    and the context that [LoadContract] returns.  Nothing here says anything
    about executing an instruction of the callee, and nothing here closes an
    entrypoint.

    The record fields below are *projections* of the pinned C#: each one is
    derived from the source text by [contract_handoff_source.py], never
    restated by hand.  A field that can be removed without changing one
    outcome or one handed-off value is not modelled as a field at all; the four
    reason-only guards are recorded as unconditional faults instead. *)

From Coq Require Import NArith PeanoNat List Bool Lia.
Import ListNotations.

(** ** The projected program *)

Record HandoffProgram := handoff_program {
  hp_blocked_gate : bool;
  hp_safe_mask_drops : N;
  hp_authorization_gate : bool;
  hp_authorization_subject_is_caller : bool;
  hp_increment_step : nat;
  hp_caller_flag_intersection : bool;
  hp_calling_context_set : bool;
  hp_fee_from_whitelist : bool;
  hp_whitelist_sets_flag : bool;
  hp_push_reversed : bool;
  hp_rvcount_from_return : bool;
  hp_ip_from_method_offset : bool;
  hp_contract_copied : bool;
  hp_snapshot_cloned : bool;
  hp_initializer_frame : bool;
  hp_initializer_name_is_canonical : bool;
  hp_initializer_pcount : nat;
  hp_lookup_is_arity_keyed : bool
}.

(** The reviewed record: 10 = WriteStates | AllowNotify = 2 | 8, read off the
    CallFlags declaration; 1 = the invocation increment; 0 = _initialize's
    declared parameter count. *)
Definition canonical_handoff :=
  handoff_program true 10%N true true 1 true true true true true true true true
                  true true true 0 true.

(** The same program with the caller-flag intersection removed, used only to
    witness that the intersection can matter. *)
Definition unintersected_handoff :=
  handoff_program true 10%N true true 1 false true true true true true true true
                  true true true 0 true.

(** ** The call site

    Everything the pinned C# reads from the environment is an input here: the
    requested word, the caller's own word, the two policy answers, the
    authorization answer and one fixed fee. *)

Record CallSite := call_site {
  cs_requested_flags : N;
  cs_caller_flags : N;
  cs_method_safe : bool;
  cs_return_void : bool;
  cs_has_return : bool;
  cs_method_offset : nat;
  cs_init_offset : nat;
  cs_init_present : bool;
  cs_parameters : nat;
  cs_args : list nat;
  cs_blocked : bool;
  cs_authorized : bool;
  cs_callee_authorizes_self : bool;
  cs_whitelisted : bool;
  cs_fixed_fee : nat;
  cs_counter : nat
}.

(** ** The constructed frame *)

Record Frame := frame {
  fr_flags : N;
  fr_rvcount : nat;
  fr_offset : nat;
  fr_contract_copied : bool;
  fr_snapshot_cloned : bool;
  fr_initializer_frames : nat;
  fr_calling_context_set : bool;
  fr_whitelisted : bool;
  fr_fee : nat;
  fr_counter : nat;
  fr_stack : list nat
}.

Inductive Reject :=
  RejectBlocked | RejectUnauthorized | RejectArity | RejectReturn.

(** A rejection carries the counter as it stands *after* the rejection, which
    is what makes the placement of the increment observable. *)
Inductive Outcome :=
  | Rejected : Reject -> nat -> Outcome
  | Accepted : Frame -> Outcome.

Definition outcome_counter (o : Outcome) : nat :=
  match o with
  | Rejected _ counter => counter
  | Accepted built => fr_counter built
  end.

(** [Bool.eqb] matches on its first argument only, so it does not reduce on two
    syntactically equal but unknown booleans without this. *)
Lemma eqb_diag : forall b : bool, Bool.eqb b b = true.
Proof. intros b. destruct b; reflexivity. Qed.
Print Assumptions eqb_diag.

(** ** Derivation *)

(** The mask the source applies to the requested word when the callee method is
    marked safe.  [N.lxor 15 drops] is the complement inside the four-bit
    CallFlags universe. *)
Definition cleared_flags (p : HandoffProgram) (c : CallSite) : N :=
  if cs_method_safe c
  then N.land (cs_requested_flags c) (N.lxor 15 (hp_safe_mask_drops p))
  else cs_requested_flags c.

Definition authorized (p : HandoffProgram) (c : CallSite) : bool :=
  if hp_authorization_subject_is_caller p
  then cs_authorized c
  else cs_callee_authorizes_self c.

Definition handed_flags (p : HandoffProgram) (c : CallSite) : N :=
  if hp_caller_flag_intersection p
  then N.land (cleared_flags p c) (cs_caller_flags c)
  else cleared_flags p c.

Definition initializer_lookup_succeeds (p : HandoffProgram) (c : CallSite) : bool :=
  andb (cs_init_present c)
       (andb (hp_initializer_name_is_canonical p)
             (andb (hp_lookup_is_arity_keyed p) (Nat.eqb (hp_initializer_pcount p) 0))).

Definition initializer_frames (p : HandoffProgram) (c : CallSite) : nat :=
  if andb (hp_initializer_frame p) (initializer_lookup_succeeds p c) then 1 else 0.

Definition frame_of (p : HandoffProgram) (c : CallSite) : Frame :=
  {| fr_flags := handed_flags p c;
     fr_rvcount := if hp_rvcount_from_return p
                   then (if cs_return_void c then 0 else 1)
                   else (if cs_return_void c then 1 else 0);
     fr_offset := if hp_ip_from_method_offset p then cs_method_offset c else 0;
     fr_contract_copied := hp_contract_copied p;
     fr_snapshot_cloned := hp_snapshot_cloned p;
     fr_initializer_frames := initializer_frames p c;
     fr_calling_context_set := hp_calling_context_set p;
     fr_whitelisted := if cs_whitelisted c then hp_whitelist_sets_flag p else false;
     fr_fee := if andb (cs_whitelisted c) (hp_fee_from_whitelist p)
               then cs_fixed_fee c else 0;
     fr_counter := cs_counter c + hp_increment_step p;
     fr_stack := if hp_push_reversed p then rev (cs_args c) else cs_args c |}.

(** The increment sits before the arity and return-type checks in the source,
    so both of those rejections still carry the incremented counter. *)
Definition handoff (p : HandoffProgram) (c : CallSite) : Outcome :=
  if andb (cs_blocked c) (hp_blocked_gate p) then
    Rejected RejectBlocked (cs_counter c)
  else if andb (negb (cs_method_safe c))
               (andb (hp_authorization_gate p) (negb (authorized p c))) then
    Rejected RejectUnauthorized (cs_counter c)
  else if Nat.eqb (length (cs_args c)) (cs_parameters c) then
    if Bool.eqb (cs_has_return c) (negb (cs_return_void c)) then
      Accepted (frame_of p c)
    else Rejected RejectReturn (cs_counter c + hp_increment_step p)
  else Rejected RejectArity (cs_counter c + hp_increment_step p).

(** ** Concrete probes

    Only used to witness claims that would otherwise need bit-level lemmas
    about the whole CallFlags lattice. *)

Definition probe (requested caller : N) (safe : bool) : CallSite :=
  {| cs_requested_flags := requested; cs_caller_flags := caller;
     cs_method_safe := safe; cs_return_void := false; cs_has_return := true;
     cs_method_offset := 7; cs_init_offset := 3; cs_init_present := true;
     cs_parameters := 2; cs_args := [11; 13]; cs_blocked := false;
     cs_authorized := true; cs_callee_authorizes_self := false;
     cs_whitelisted := false; cs_fixed_fee := 0; cs_counter := 0 |}.

(** ** Rejection *)

Theorem blocked_rejects : forall p c,
  hp_blocked_gate p = true -> cs_blocked c = true ->
  handoff p c = Rejected RejectBlocked (cs_counter c).
Proof. intros p c Hg Hb. unfold handoff. rewrite Hb, Hg. cbn. reflexivity. Qed.
Print Assumptions blocked_rejects.

Theorem blocked_counter_is_untouched : forall p c,
  hp_blocked_gate p = true -> cs_blocked c = true ->
  outcome_counter (handoff p c) = cs_counter c.
Proof.
  intros p c Hg Hb. rewrite blocked_rejects by assumption. reflexivity.
Qed.
Print Assumptions blocked_counter_is_untouched.

Theorem blocked_precedes_authorization : forall p c,
  hp_blocked_gate p = true -> cs_blocked c = true -> authorized p c = false ->
  handoff p c = Rejected RejectBlocked (cs_counter c).
Proof. intros p c Hg Hb _. rewrite blocked_rejects by assumption. reflexivity. Qed.
Print Assumptions blocked_precedes_authorization.

Theorem unauthorized_rejects : forall p c,
  cs_blocked c = false -> cs_method_safe c = false -> hp_authorization_gate p = true ->
  authorized p c = false ->
  handoff p c = Rejected RejectUnauthorized (cs_counter c).
Proof.
  intros p c Hb Hs Hg Ha. unfold handoff. rewrite Hb, Hs, Hg, Ha. cbn. reflexivity.
Qed.
Print Assumptions unauthorized_rejects.

Theorem unauthorized_counter_is_untouched : forall p c,
  cs_blocked c = false -> cs_method_safe c = false -> hp_authorization_gate p = true ->
  authorized p c = false ->
  outcome_counter (handoff p c) = cs_counter c.
Proof.
  intros p c Hb Hs Hg Ha. rewrite unauthorized_rejects by assumption. reflexivity.
Qed.
Print Assumptions unauthorized_counter_is_untouched.

Theorem authorization_precedes_arity : forall p c,
  cs_blocked c = false -> cs_method_safe c = false -> hp_authorization_gate p = true ->
  authorized p c = false -> length (cs_args c) <> cs_parameters c ->
  handoff p c = Rejected RejectUnauthorized (cs_counter c).
Proof.
  intros p c Hb Hs Hg Ha _. rewrite unauthorized_rejects by assumption. reflexivity.
Qed.
Print Assumptions authorization_precedes_arity.

Theorem safe_method_skips_authorization : forall p c,
  cs_method_safe c = true -> hp_authorization_gate p = true -> authorized p c = false ->
  cs_blocked c = false -> Nat.eqb (length (cs_args c)) (cs_parameters c) = true ->
  cs_has_return c = negb (cs_return_void c) ->
  handoff p c = Accepted (frame_of p c).
Proof.
  intros p c Hs Hg Ha Hb Har Hret. unfold handoff.
  rewrite Hs, Hb, Har, Hret, eqb_diag. cbn. reflexivity.
Qed.
Print Assumptions safe_method_skips_authorization.

Theorem arity_mismatch_never_accepts : forall p c,
  cs_blocked c = false -> Nat.eqb (length (cs_args c)) (cs_parameters c) = false ->
  exists r n, handoff p c = Rejected r n.
Proof.
  intros p c Hb Har. unfold handoff. rewrite Hb.
  destruct (negb (cs_method_safe c)).
  - destruct (hp_authorization_gate p).
    + destruct (negb (authorized p c)).
      * cbn. eauto.
      * rewrite Har. cbn. eauto.
    + rewrite Har. cbn. eauto.
  - rewrite Har. cbn. eauto.
Qed.
Print Assumptions arity_mismatch_never_accepts.

Theorem arity_mismatch_rejects : forall p c,
  cs_blocked c = false -> Nat.eqb (length (cs_args c)) (cs_parameters c) = false ->
  (cs_method_safe c = true \/ hp_authorization_gate p = false \/ authorized p c = true) ->
  handoff p c = Rejected RejectArity (cs_counter c + hp_increment_step p).
Proof.
  intros p c Hb Har Hpass. unfold handoff. rewrite Hb.
  destruct (negb (cs_method_safe c)) eqn:Hs.
  - destruct (hp_authorization_gate p) eqn:Hg.
    + destruct (negb (authorized p c)) eqn:Ha.
      * apply negb_true_iff in Hs. apply negb_true_iff in Ha.
        destruct Hpass as [H1 | [H2 | H3]]; congruence.
      * rewrite Har. cbn. reflexivity.
    + rewrite Har. cbn. reflexivity.
  - rewrite Har. cbn. reflexivity.
Qed.
Print Assumptions arity_mismatch_rejects.

Theorem arity_precedes_return : forall p c,
  cs_blocked c = false -> Nat.eqb (length (cs_args c)) (cs_parameters c) = false ->
  (cs_method_safe c = true \/ hp_authorization_gate p = false \/ authorized p c = true) ->
  cs_has_return c <> negb (cs_return_void c) ->
  handoff p c = Rejected RejectArity (cs_counter c + hp_increment_step p).
Proof.
  intros p c Hb Har Hpass _. apply arity_mismatch_rejects; assumption.
Qed.
Print Assumptions arity_precedes_return.

Theorem arity_rejection_after_the_increment : forall p c,
  cs_blocked c = false -> cs_method_safe c = true ->
  Nat.eqb (length (cs_args c)) (cs_parameters c) = false ->
  handoff p c = Rejected RejectArity (cs_counter c + hp_increment_step p).
Proof.
  intros p c Hb Hs Har. unfold handoff. rewrite Hb, Hs, Har. cbn. reflexivity.
Qed.
Print Assumptions arity_rejection_after_the_increment.

Theorem return_mismatch_rejects : forall p c,
  cs_blocked c = false -> cs_method_safe c = true ->
  Nat.eqb (length (cs_args c)) (cs_parameters c) = true ->
  Bool.eqb (cs_has_return c) (negb (cs_return_void c)) = false ->
  handoff p c = Rejected RejectReturn (cs_counter c + hp_increment_step p).
Proof.
  intros p c Hb Hs Har Hret. unfold handoff. rewrite Hb, Hs, Har, Hret. cbn.
  reflexivity.
Qed.
Print Assumptions return_mismatch_rejects.

Theorem return_rejection_after_the_increment : forall p c,
  cs_blocked c = false -> cs_method_safe c = true ->
  Nat.eqb (length (cs_args c)) (cs_parameters c) = true ->
  Bool.eqb (cs_has_return c) (negb (cs_return_void c)) = false ->
  outcome_counter (handoff p c) = cs_counter c + hp_increment_step p.
Proof.
  intros p c Hb Hs Har Hret. rewrite return_mismatch_rejects by assumption.
  reflexivity.
Qed.
Print Assumptions return_rejection_after_the_increment.

(** ** Acceptance *)

Theorem accepted_frame_records_the_call : forall p c,
  cs_blocked c = false -> Nat.eqb (length (cs_args c)) (cs_parameters c) = true ->
  Bool.eqb (cs_has_return c) (negb (cs_return_void c)) = true ->
  (cs_method_safe c = true \/
   (hp_authorization_gate p = true -> authorized p c = true)) ->
  handoff p c = Accepted (frame_of p c).
Proof.
  intros p c Hb Har Hret Hopen.
  destruct (cs_method_safe c) eqn:Hs.
  - unfold handoff. rewrite Hb, Har, Hret, Hs. cbn. reflexivity.
  - destruct Hopen as [Hc | Hauth]. { discriminate Hc. }
    unfold handoff. rewrite Hb, Har, Hret, Hs.
    destruct (hp_authorization_gate p) eqn:Hg.
    + rewrite (Hauth eq_refl). cbn. reflexivity.
    + cbn. reflexivity.
Qed.
Print Assumptions accepted_frame_records_the_call.

Theorem accepted_counter_is_incremented : forall p c,
  cs_blocked c = false -> cs_method_safe c = true ->
  Nat.eqb (length (cs_args c)) (cs_parameters c) = true ->
  Bool.eqb (cs_has_return c) (negb (cs_return_void c)) = true ->
  outcome_counter (handoff p c) = cs_counter c + hp_increment_step p.
Proof.
  intros p c Hb Hs Har Hret. rewrite accepted_frame_records_the_call
    by (auto; left; assumption). reflexivity.
Qed.
Print Assumptions accepted_counter_is_incremented.

(** ** Flags *)

Theorem handed_flags_are_the_intersection : forall p c,
  hp_caller_flag_intersection p = true ->
  fr_flags (frame_of p c) = N.land (cleared_flags p c) (cs_caller_flags c).
Proof. intros p c H. unfold frame_of, handed_flags. rewrite H. reflexivity. Qed.
Print Assumptions handed_flags_are_the_intersection.

Theorem handed_flags_do_not_exceed_the_caller : forall p c,
  hp_caller_flag_intersection p = true ->
  (fr_flags (frame_of p c) <= cs_caller_flags c)%N.
Proof.
  intros p c H. rewrite handed_flags_are_the_intersection by assumption.
  apply N.land_le_r.
Qed.
Print Assumptions handed_flags_do_not_exceed_the_caller.

Example raw_handoff_can_exceed_the_caller :
  fr_flags (frame_of unintersected_handoff (probe 15%N 5%N false)) <>
  cs_caller_flags (probe 15%N 5%N false).
Proof. cbn. discriminate. Qed.
Print Assumptions raw_handoff_can_exceed_the_caller.

Example mask_removes_the_projected_bits :
  fr_flags (frame_of canonical_handoff (probe 15%N 15%N true)) = 5%N.
Proof. cbn. reflexivity. Qed.
Print Assumptions mask_removes_the_projected_bits.

(** ** Return value count and initial position *)

Theorem rvcount_is_zero_for_void : forall p c,
  hp_rvcount_from_return p = true -> cs_return_void c = true ->
  fr_rvcount (frame_of p c) = 0.
Proof. intros p c H V. unfold frame_of. rewrite H, V. reflexivity. Qed.
Print Assumptions rvcount_is_zero_for_void.

Theorem rvcount_is_one_for_non_void : forall p c,
  hp_rvcount_from_return p = true -> cs_return_void c = false ->
  fr_rvcount (frame_of p c) = 1.
Proof. intros p c H V. unfold frame_of. rewrite H, V. reflexivity. Qed.
Print Assumptions rvcount_is_one_for_non_void.

Theorem swapped_projection_inverts_the_void_case : forall p c,
  hp_rvcount_from_return p = false -> cs_return_void c = true ->
  fr_rvcount (frame_of p c) = 1.
Proof. intros p c H V. unfold frame_of. rewrite H, V. reflexivity. Qed.
Print Assumptions swapped_projection_inverts_the_void_case.

Theorem offset_is_the_method_offset : forall p c,
  hp_ip_from_method_offset p = true ->
  fr_offset (frame_of p c) = cs_method_offset c.
Proof. intros p c H. unfold frame_of. rewrite H. reflexivity. Qed.
Print Assumptions offset_is_the_method_offset.

Theorem offset_is_zero_when_the_projection_says_so : forall p c,
  hp_ip_from_method_offset p = false ->
  fr_offset (frame_of p c) = 0.
Proof. intros p c H. unfold frame_of. rewrite H. reflexivity. Qed.
Print Assumptions offset_is_zero_when_the_projection_says_so.

(** ** Contract copy, snapshot clone, calling context *)

Theorem contract_fields_are_copied : forall p c,
  hp_contract_copied p = true -> fr_contract_copied (frame_of p c) = true.
Proof. intros p c H. unfold frame_of. rewrite H. reflexivity. Qed.
Print Assumptions contract_fields_are_copied.

Theorem snapshot_cache_is_cloned : forall p c,
  hp_snapshot_cloned p = true -> fr_snapshot_cloned (frame_of p c) = true.
Proof. intros p c H. unfold frame_of. rewrite H. reflexivity. Qed.
Print Assumptions snapshot_cache_is_cloned.

Theorem calling_context_points_at_the_caller : forall p c,
  hp_calling_context_set p = true -> fr_calling_context_set (frame_of p c) = true.
Proof. intros p c H. unfold frame_of. rewrite H. reflexivity. Qed.
Print Assumptions calling_context_points_at_the_caller.

(** ** The initializer frame *)

Theorem initializer_adds_one_frame : forall p c,
  hp_initializer_frame p = true -> cs_init_present c = true ->
  hp_initializer_name_is_canonical p = true -> hp_lookup_is_arity_keyed p = true ->
  hp_initializer_pcount p = 0 ->
  fr_initializer_frames (frame_of p c) = 1.
Proof.
  intros p c H P N L C. unfold frame_of, initializer_frames,
  initializer_lookup_succeeds. rewrite H, P, N, L, C. cbn. reflexivity.
Qed.
Print Assumptions initializer_adds_one_frame.

(** A lookup that failed builds no frame.  The [andb] chain in
    [initializer_lookup_succeeds] is left-stuck on a variable, so [andb X false]
    does not reduce on its own; the split on the projection is done once here
    instead of in each of the four component theorems below. *)
Lemma no_frame_without_the_lookup : forall p c,
  initializer_lookup_succeeds p c = false ->
  fr_initializer_frames (frame_of p c) = 0.
Proof.
  intros p c H. unfold frame_of, initializer_frames. rewrite H.
  destruct (hp_initializer_frame p); reflexivity.
Qed.
Print Assumptions no_frame_without_the_lookup.

Theorem absent_initializer_adds_none : forall p c,
  cs_init_present c = false -> fr_initializer_frames (frame_of p c) = 0.
Proof.
  intros p c P. apply no_frame_without_the_lookup.
  unfold initializer_lookup_succeeds. rewrite P. reflexivity.
Qed.
Print Assumptions absent_initializer_adds_none.

Theorem initializer_requires_the_canonical_name : forall p c,
  hp_initializer_name_is_canonical p = false ->
  fr_initializer_frames (frame_of p c) = 0.
Proof.
  intros p c N. apply no_frame_without_the_lookup.
  unfold initializer_lookup_succeeds. rewrite N.
  destruct (cs_init_present c); reflexivity.
Qed.
Print Assumptions initializer_requires_the_canonical_name.

Theorem initializer_requires_zero_parameters : forall p c,
  hp_initializer_pcount p = 1 -> fr_initializer_frames (frame_of p c) = 0.
Proof.
  intros p c C. apply no_frame_without_the_lookup.
  unfold initializer_lookup_succeeds. rewrite C. cbn.
  destruct (cs_init_present c), (hp_initializer_name_is_canonical p),
           (hp_lookup_is_arity_keyed p); reflexivity.
Qed.
Print Assumptions initializer_requires_zero_parameters.

Theorem initializer_requires_arity_keyed_lookup : forall p c,
  hp_lookup_is_arity_keyed p = false -> fr_initializer_frames (frame_of p c) = 0.
Proof.
  intros p c L. apply no_frame_without_the_lookup.
  unfold initializer_lookup_succeeds. rewrite L. cbn.
  destruct (cs_init_present c), (hp_initializer_name_is_canonical p); reflexivity.
Qed.
Print Assumptions initializer_requires_arity_keyed_lookup.

(** ** The handed-off argument stack *)

Theorem stack_is_the_reverse_of_the_argument_vector : forall p c,
  hp_push_reversed p = true -> fr_stack (frame_of p c) = rev (cs_args c).
Proof. intros p c H. unfold frame_of. rewrite H. reflexivity. Qed.
Print Assumptions stack_is_the_reverse_of_the_argument_vector.

Theorem stack_is_the_argument_vector_in_order : forall p c,
  hp_push_reversed p = false -> fr_stack (frame_of p c) = cs_args c.
Proof. intros p c H. unfold frame_of. rewrite H. reflexivity. Qed.
Print Assumptions stack_is_the_argument_vector_in_order.

Theorem reverse_preserves_the_argument_count : forall p c,
  length (fr_stack (frame_of p c)) = length (cs_args c).
Proof.
  intros p c. unfold frame_of. destruct (hp_push_reversed p); cbn.
  - apply length_rev.
  - reflexivity.
Qed.
Print Assumptions reverse_preserves_the_argument_count.

(** ** Whitelisted fees *)

Theorem whitelisted_fee_is_charged : forall p c,
  cs_whitelisted c = true -> hp_fee_from_whitelist p = true ->
  fr_fee (frame_of p c) = cs_fixed_fee c.
Proof. intros p c W F. unfold frame_of. rewrite W, F. reflexivity. Qed.
Print Assumptions whitelisted_fee_is_charged.

Theorem no_whitelist_no_fee : forall p c,
  cs_whitelisted c = false -> fr_fee (frame_of p c) = 0.
Proof. intros p c W. unfold frame_of. rewrite W. reflexivity. Qed.
Print Assumptions no_whitelist_no_fee.

Theorem whitelisted_flag_follows_the_gate : forall p c,
  cs_whitelisted c = true ->
  fr_whitelisted (frame_of p c) = hp_whitelist_sets_flag p.
Proof. intros p c W. unfold frame_of. rewrite W. reflexivity. Qed.
Print Assumptions whitelisted_flag_follows_the_gate.

Theorem not_whitelisted_clears_the_flag : forall p c,
  cs_whitelisted c = false -> fr_whitelisted (frame_of p c) = false.
Proof. intros p c W. unfold frame_of. rewrite W. reflexivity. Qed.
Print Assumptions not_whitelisted_clears_the_flag.

(** ** The canonical record is the reviewed one *)

Example increment_step_is_one_for_the_canonical_program :
  hp_increment_step canonical_handoff = 1.
Proof. reflexivity. Qed.
Print Assumptions increment_step_is_one_for_the_canonical_program.
