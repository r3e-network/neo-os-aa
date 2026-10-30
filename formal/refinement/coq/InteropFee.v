(** * The interop descriptor charge, and what the conversion window can move *)

(** The conversion lane starts after the charge and records only the *absence*
    of an add-fee step inside its window. This model covers that gap: the
    charge is fixed from the descriptor before the first value is popped, so
    nothing the conversion does can change it, and a rejected call pays nothing
    only because the flag check sits in front of the charge. Every field below
    is projected from the pinned C# by [interop_fee_source.py]; the certificate
    re-derives each one and the controls move them one at a time. *)

Require Import Coq.Lists.List Coq.NArith.NArith Coq.ZArith.ZArith Coq.micromega.Lia.
Import ListNotations.

(** ** The projected record *)

(** The six steps the charge is ordered against. *)
Inductive FeeStep := ValidateFlags | Charge | Allocate | ConvertArgs | Invoke | Push.

Scheme Equality for FeeStep.

Record FeeProgram := fee_program {
  fp_order : list FeeStep;
  fp_price_member : bool;
  fp_exec_factor_member : bool;
  fp_skips_the_inner_factor : bool;
  fp_vector_from_descriptor : bool;
  fp_one_pop_per_parameter : bool;
  fp_arity_from_handler : bool;
  fp_price_type_long : bool;
  fp_price_may_be_zero : bool;
  fp_negative_rejected : bool;
  fp_whitelist_bypass : bool;
  fp_factor_branch_only : bool;
  fp_consumed_before_limit : bool;
  fp_limit_strict : bool;
  fp_no_fee_inside : bool
}.

Definition canonical_fee : FeeProgram :=
  {| fp_order := [ValidateFlags; Charge; Allocate; ConvertArgs; Invoke; Push];
     fp_price_member := true;
     fp_exec_factor_member := true;
     fp_skips_the_inner_factor := true;
     fp_vector_from_descriptor := true;
     fp_one_pop_per_parameter := true;
     fp_arity_from_handler := true;
     fp_price_type_long := true;
     fp_price_may_be_zero := true;
     fp_negative_rejected := true;
     fp_whitelist_bypass := true;
     fp_factor_branch_only := true;
     fp_consumed_before_limit := true;
     fp_limit_strict := true;
     fp_no_fee_inside := true |}.

(** ** Ordering *)

Fixpoint index_of (s : FeeStep) (order : list FeeStep) (n : nat) : option nat :=
  match order with
  | [] => None
  | x :: rest => if FeeStep_eq_dec x s then Some n else index_of s rest (S n)
  end.

Definition earlier (a b : FeeStep) (order : list FeeStep) : bool :=
  match index_of a order 0 with
  | None => false
  | Some i =>
      match index_of b order 0 with
      | None => false
      | Some j => Nat.ltb i j
      end
  end.

(** ** The charge *)

(** [FixedPrice] is a non-negative [long]; the model carries the bound so the
    narrowed declaration is visible rather than assumed. *)
Definition int_max : N := 2147483647%N.

Definition charge_price (p : FeeProgram) (price factor : N) : N :=
  match p.(fp_price_member) with true => price | false => factor end.

Definition charge_factor (p : FeeProgram) (price factor : N) : N :=
  match p.(fp_exec_factor_member) with true => factor | false => price end.

Definition charge_base (p : FeeProgram) (price factor : N) : N :=
  N.mul (charge_price p price factor) (charge_factor p price factor).

(** One factor application, unless the record says the inner branch is gone or
    that the charge was told to apply it again. *)
Definition charge_amount (p : FeeProgram) (price factor : N) : N :=
  match p.(fp_factor_branch_only) with
  | true =>
      match p.(fp_skips_the_inner_factor) with
      | true => charge_base p price factor
      | false => N.mul (charge_base p price factor) (charge_factor p price factor)
      end
  | false => N.mul (charge_base p price factor) (charge_factor p price factor)
  end.

Definition price_representable (p : FeeProgram) (price : N) : bool :=
  match p.(fp_price_type_long) with
  | true => true
  | false => N.leb price int_max
  end.

Definition zero_price_is_accepted (p : FeeProgram) (price : N) : bool :=
  match p.(fp_price_may_be_zero) with
  | true => true
  | false => N.ltb 0 price
  end.

Definition negative_gas_rejected (p : FeeProgram) (gas : Z) : bool :=
  match p.(fp_negative_rejected) with
  | true => Z.ltb gas 0
  | false => false
  end.

(** The source compares with a strict [>], so a call landing exactly on the
    limit is inside it. *)
Definition limit_accepts (consumed amount : N) (strict : bool) : bool :=
  match strict with
  | true => N.leb consumed amount
  | false => N.ltb consumed amount
  end.

Definition fee_gate (p : FeeProgram) (consumed amount charge : N) : bool :=
  match p.(fp_consumed_before_limit) with
  | true => limit_accepts (N.add consumed charge) amount p.(fp_limit_strict)
  | false => limit_accepts consumed amount p.(fp_limit_strict)
  end.

Definition charged (p : FeeProgram) (whitelisted : bool) (price factor : N) : N :=
  match p.(fp_whitelist_bypass) with
  | true => if whitelisted then 0%N else charge_amount p price factor
  | false => charge_amount p price factor
  end.

Definition window_fee (p : FeeProgram) : N :=
  match p.(fp_no_fee_inside) with true => 0%N | false => 1%N end.

(** ** The window effect *)

Definition converted_count (arity : nat) (fault_at : option nat) : nat :=
  match fault_at with
  | None => arity
  | Some k => Nat.min (S k) arity
  end.

Definition window_ok (fault_at : option nat) : bool :=
  match fault_at with None => true | Some _ => false end.

Record Outcome := outcome {
  o_charged : N;
  o_window_fee : N;
  o_pops : nat;
  o_faulted : bool;
  o_handler_invoked : bool
}.

Definition silent : Outcome :=
  outcome 0%N 0%N 0 true false.

(** A fault during conversion refunds the charge only when the charge was moved
    behind the conversion. *)
Definition charge_paid (p : FeeProgram) (whitelisted : bool) (price factor : N)
    (fault_at : option nat) : N :=
  match earlier Charge ConvertArgs p.(fp_order) with
  | true => charged p whitelisted price factor
  | false =>
      match window_ok fault_at with
      | true => charged p whitelisted price factor
      | false => 0%N
      end
  end.

Definition converted_outcome (p : FeeProgram) (whitelisted : bool) (price factor : N)
    (arity : nat) (fault_at : option nat) : Outcome :=
  outcome (charge_paid p whitelisted price factor fault_at)
          (window_fee p) (converted_count arity fault_at)
          (negb (window_ok fault_at))
          (match earlier ConvertArgs Invoke p.(fp_order) with
           | true => window_ok fault_at
           | false => true
           end).

Definition on_syscall (p : FeeProgram) (flags_ok whitelisted add_fee_ok : bool)
    (price factor : N) (arity : nat) (fault_at : option nat) : Outcome :=
  match earlier ValidateFlags Charge p.(fp_order) with
  | true =>
      match flags_ok with
      | true =>
          match add_fee_ok with
          | true => converted_outcome p whitelisted price factor arity fault_at
          | false => silent
          end
      | false => silent
      end
  | false =>
      match add_fee_ok with
      | true =>
          match flags_ok with
          | true => converted_outcome p whitelisted price factor arity fault_at
          | false =>
              outcome (charged p whitelisted price factor) 0%N 0 true false
          end
      | false => silent
      end
  end.

(** ** The canonical order *)

Theorem the_charge_sits_between_the_flag_check_and_the_conversion :
  earlier ValidateFlags Charge canonical_fee.(fp_order) = true /\
  earlier Charge ConvertArgs canonical_fee.(fp_order) = true /\
  earlier ConvertArgs Invoke canonical_fee.(fp_order) = true.
Proof. repeat split; reflexivity. Qed.

Theorem an_absent_step_is_never_earlier :
  forall a b order, index_of a order 0 = None -> earlier a b order = false.
Proof.
  intros a b order Hmissing. unfold earlier. rewrite Hmissing. reflexivity.
Qed.

Theorem earlier_is_irreflexive :
  forall s order, earlier s s order = false.
Proof.
  intros s order. unfold earlier.
  destruct (index_of s order 0) as [i|]; [|reflexivity].
  simpl. apply Nat.ltb_irrefl.
Qed.

Theorem the_order_alone_decides_the_flag_priority :
  forall p flags_ok whitelisted add_fee_ok price factor arity fault_at,
    earlier ValidateFlags Charge p.(fp_order) = false ->
    flags_ok = false ->
    o_charged (on_syscall p flags_ok whitelisted add_fee_ok price factor arity fault_at)
      = (match add_fee_ok with
         | true => charged p whitelisted price factor
         | false => 0%N
         end).
Proof.
  intros p flags_ok whitelisted add_fee_ok price factor arity fault_at Horder Hflags.
  unfold on_syscall. rewrite Horder, Hflags.
  destruct add_fee_ok; reflexivity.
Qed.

(** ** What a rejected call pays *)

Theorem a_rejected_call_charges_nothing_when_the_flag_check_comes_first :
  forall p whitelisted add_fee_ok price factor arity fault_at,
    earlier ValidateFlags Charge p.(fp_order) = true ->
    o_charged (on_syscall p false whitelisted add_fee_ok price factor arity fault_at)
      = 0%N.
Proof.
  intros. unfold on_syscall. rewrite H. reflexivity.
Qed.

Theorem a_rejected_call_pops_nothing_when_the_flag_check_comes_first :
  forall p whitelisted add_fee_ok price factor arity fault_at,
    earlier ValidateFlags Charge p.(fp_order) = true ->
    o_pops (on_syscall p false whitelisted add_fee_ok price factor arity fault_at) = 0.
Proof.
  intros. unfold on_syscall. rewrite H. reflexivity.
Qed.

Theorem a_rejected_call_pays_when_the_charge_comes_first :
  forall p whitelisted price factor arity fault_at,
    earlier ValidateFlags Charge p.(fp_order) = false ->
    o_charged (on_syscall p false whitelisted true price factor arity fault_at)
      = charged p whitelisted price factor.
Proof.
  intros. unfold on_syscall. rewrite H. reflexivity.
Qed.

(** ** What the conversion cannot move *)

Theorem the_charge_is_paid_before_the_first_pop :
  forall p whitelisted price factor arity k,
    earlier ValidateFlags Charge p.(fp_order) = true ->
    earlier Charge ConvertArgs p.(fp_order) = true ->
    o_charged (on_syscall p true whitelisted true price factor arity (Some k))
      = charged p whitelisted price factor.
Proof.
  intros p whitelisted price factor arity k Hflags Hcharge.
  unfold on_syscall. rewrite Hflags.
  unfold converted_outcome, charge_paid. rewrite Hcharge. reflexivity.
Qed.

Lemma the_charge_is_paid_before_a_successful_conversion :
  forall p whitelisted price factor arity,
    earlier ValidateFlags Charge p.(fp_order) = true ->
    earlier Charge ConvertArgs p.(fp_order) = true ->
    o_charged (on_syscall p true whitelisted true price factor arity None)
      = charged p whitelisted price factor.
Proof.
  intros. unfold on_syscall. rewrite H.
  unfold converted_outcome, charge_paid. rewrite H0. reflexivity.
Qed.

Theorem a_conversion_fault_does_not_refund_the_charge :
  forall p whitelisted price factor arity k,
    earlier ValidateFlags Charge p.(fp_order) = true ->
    earlier Charge ConvertArgs p.(fp_order) = true ->
    o_charged (on_syscall p true whitelisted true price factor arity (Some k))
      = o_charged (on_syscall p true whitelisted true price factor arity None).
Proof.
  intros p whitelisted price factor arity k Hflags Hcharge.
  rewrite (the_charge_is_paid_before_the_first_pop
             p whitelisted price factor arity k Hflags Hcharge).
  rewrite (the_charge_is_paid_before_a_successful_conversion
             p whitelisted price factor arity Hflags Hcharge).
  reflexivity.
Qed.

Theorem a_conversion_fault_pops_only_the_converted_prefix :
  forall p whitelisted price factor arity k,
    earlier ValidateFlags Charge p.(fp_order) = true ->
    o_pops (on_syscall p true whitelisted true price factor arity (Some k))
      = Nat.min (S k) arity.
Proof.
  intros. unfold on_syscall. rewrite H. reflexivity.
Qed.

Theorem a_fee_shortfall_pops_nothing :
  forall p flags_ok whitelisted price factor arity fault_at,
    earlier ValidateFlags Charge p.(fp_order) = true ->
    o_pops (on_syscall p flags_ok whitelisted false price factor arity fault_at) = 0.
Proof.
  intros. unfold on_syscall. rewrite H.
  destruct flags_ok; reflexivity.
Qed.

Theorem the_charge_does_not_depend_on_the_arity :
  forall p whitelisted price factor m n fault_at,
    earlier ValidateFlags Charge p.(fp_order) = true ->
    o_charged (on_syscall p true whitelisted true price factor m fault_at)
      = o_charged (on_syscall p true whitelisted true price factor n fault_at).
Proof.
  intros. unfold on_syscall. rewrite H. reflexivity.
Qed.

Theorem the_handler_runs_only_after_the_conversion :
  forall p whitelisted price factor arity k,
    earlier ValidateFlags Charge p.(fp_order) = true ->
    earlier ConvertArgs Invoke p.(fp_order) = true ->
    o_handler_invoked (on_syscall p true whitelisted true price factor arity (Some k))
      = false.
Proof.
  intros. unfold on_syscall. rewrite H.
  unfold converted_outcome. rewrite H0. reflexivity.
Qed.

Theorem one_pop_per_parameter_drains_exactly_the_arity :
  forall arity, converted_count arity None = arity.
Proof. reflexivity. Qed.

(** ** The whitelist *)

Theorem a_whitelisted_context_pays_nothing :
  forall p add_fee_ok price factor arity fault_at,
    earlier ValidateFlags Charge p.(fp_order) = true ->
    p.(fp_whitelist_bypass) = true ->
    o_charged (on_syscall p true true add_fee_ok price factor arity fault_at) = 0%N.
Proof.
  intros p add_fee_ok price factor arity fault_at Hflags Hbypass.
  unfold on_syscall. rewrite Hflags.
  unfold converted_outcome, charge_paid, charged.
  rewrite Hbypass.
  destruct add_fee_ok; destruct (earlier Charge ConvertArgs p.(fp_order));
    destruct (window_ok fault_at); reflexivity.
Qed.

Theorem a_whitelisted_context_still_pops :
  forall p whitelisted price factor arity k,
    earlier ValidateFlags Charge p.(fp_order) = true ->
    earlier Charge ConvertArgs p.(fp_order) = true ->
    p.(fp_whitelist_bypass) = true ->
    o_pops (on_syscall p true whitelisted true price factor arity (Some k))
      = Nat.min (S k) arity.
Proof.
  intros p whitelisted price factor arity k Hflags Hcharge Hbypass.
  apply (a_conversion_fault_pops_only_the_converted_prefix
           p whitelisted price factor arity k Hflags).
Qed.

(** ** The factor, once *)

Theorem the_factor_is_applied_once_on_the_reviewed_record :
  charge_amount canonical_fee 3%N 5%N = 15%N.
Proof. reflexivity. Qed.

Theorem asking_for_the_factor_twice_would_charge_seventy_five :
  forall p,
    p.(fp_skips_the_inner_factor) = false ->
    p.(fp_factor_branch_only) = true ->
    p.(fp_price_member) = true ->
    p.(fp_exec_factor_member) = true ->
    charge_amount p 3%N 5%N = 75%N.
Proof.
  intros p Happly Hbranch Hprice Hfactor.
  unfold charge_amount, charge_base, charge_price, charge_factor.
  rewrite Hbranch, Happly, Hprice, Hfactor. reflexivity.
Qed.

Theorem dropping_the_inner_branch_also_doubles_the_charge :
  forall p,
    p.(fp_factor_branch_only) = false ->
    p.(fp_price_member) = true ->
    p.(fp_exec_factor_member) = true ->
    charge_amount p 3%N 5%N = 75%N.
Proof.
  intros p Hbranch Hprice Hfactor.
  unfold charge_amount, charge_base, charge_price, charge_factor.
  rewrite Hbranch, Hprice, Hfactor. reflexivity.
Qed.

Theorem a_zero_price_charges_nothing :
  forall p whitelisted factor arity fault_at,
    earlier ValidateFlags Charge p.(fp_order) = true ->
    earlier Charge ConvertArgs p.(fp_order) = true ->
    p.(fp_price_member) = true ->
    o_charged (on_syscall p true whitelisted true 0%N factor arity fault_at) = 0%N.
Proof.
  intros p whitelisted factor arity fault_at Hflags Hcharge Hprice.
  unfold on_syscall. rewrite Hflags.
  unfold converted_outcome, charge_paid. rewrite Hcharge.
  unfold charged, charge_amount, charge_base, charge_price.
  rewrite Hprice.
  destruct (fp_whitelist_bypass p); destruct whitelisted;
    destruct (fp_factor_branch_only p); destruct (fp_skips_the_inner_factor p);
    reflexivity.
Qed.

(** ** The declared price *)

Theorem the_long_declaration_holds_a_price_above_the_int_range :
  price_representable canonical_fee 3000000000%N = true.
Proof. reflexivity. Qed.

Definition an_int_priced_record : FeeProgram :=
  {|
     fp_order := [ValidateFlags; Charge; Allocate; ConvertArgs; Invoke; Push];
     fp_price_member := true;
     fp_exec_factor_member := true;
     fp_skips_the_inner_factor := true;
     fp_vector_from_descriptor := true;
     fp_one_pop_per_parameter := true;
     fp_arity_from_handler := true;
     fp_price_type_long := false;
     fp_price_may_be_zero := true;
     fp_negative_rejected := true;
     fp_whitelist_bypass := true;
     fp_factor_branch_only := true;
     fp_consumed_before_limit := true;
     fp_limit_strict := true;
     fp_no_fee_inside := true |}.

Theorem the_int_declaration_cannot_hold_that_price :
  price_representable an_int_priced_record 3000000000%N = false.
Proof. reflexivity. Qed.

Theorem a_zero_price_is_legitimate_on_the_reviewed_record :
  zero_price_is_accepted canonical_fee 0%N = true.
Proof. reflexivity. Qed.

Definition a_nonzero_priced_record : FeeProgram :=
  {|
     fp_order := [ValidateFlags; Charge; Allocate; ConvertArgs; Invoke; Push];
     fp_price_member := true;
     fp_exec_factor_member := true;
     fp_skips_the_inner_factor := true;
     fp_vector_from_descriptor := true;
     fp_one_pop_per_parameter := true;
     fp_arity_from_handler := true;
     fp_price_type_long := true;
     fp_price_may_be_zero := false;
     fp_negative_rejected := true;
     fp_whitelist_bypass := true;
     fp_factor_branch_only := true;
     fp_consumed_before_limit := true;
     fp_limit_strict := true;
     fp_no_fee_inside := true |}.

Theorem a_nonzero_declaration_would_reject_a_zero_price :
  zero_price_is_accepted a_nonzero_priced_record 0%N = false.
Proof. reflexivity. Qed.

Theorem a_negative_fee_is_rejected :
  negative_gas_rejected canonical_fee (-1)%Z = true.
Proof. reflexivity. Qed.

Definition a_negative_tolerant_record : FeeProgram :=
  {|
     fp_order := [ValidateFlags; Charge; Allocate; ConvertArgs; Invoke; Push];
     fp_price_member := true;
     fp_exec_factor_member := true;
     fp_skips_the_inner_factor := true;
     fp_vector_from_descriptor := true;
     fp_one_pop_per_parameter := true;
     fp_arity_from_handler := true;
     fp_price_type_long := true;
     fp_price_may_be_zero := true;
     fp_negative_rejected := false;
     fp_whitelist_bypass := true;
     fp_factor_branch_only := true;
     fp_consumed_before_limit := true;
     fp_limit_strict := true;
     fp_no_fee_inside := true |}.

Theorem a_one_less_bound_misses_the_negative_edge :
  negative_gas_rejected a_negative_tolerant_record (-1)%Z = false.
Proof. reflexivity. Qed.

(** ** The limit *)

Theorem the_limit_accepts_a_call_landing_exactly_on_it :
  limit_accepts 5%N 5%N true = true.
Proof. reflexivity. Qed.

Theorem a_non_strict_comparison_would_refuse_that_call :
  limit_accepts 5%N 5%N false = false.
Proof. reflexivity. Qed.

Theorem a_call_that_overruns_the_limit_is_refused :
  fee_gate canonical_fee 3%N 5%N 3%N = false.
Proof. reflexivity. Qed.

Definition a_counter_after_the_check_record : FeeProgram :=
  {|
     fp_order := [ValidateFlags; Charge; Allocate; ConvertArgs; Invoke; Push];
     fp_price_member := true;
     fp_exec_factor_member := true;
     fp_skips_the_inner_factor := true;
     fp_vector_from_descriptor := true;
     fp_one_pop_per_parameter := true;
     fp_arity_from_handler := true;
     fp_price_type_long := true;
     fp_price_may_be_zero := true;
     fp_negative_rejected := true;
     fp_whitelist_bypass := true;
     fp_factor_branch_only := true;
     fp_consumed_before_limit := false;
     fp_limit_strict := true;
     fp_no_fee_inside := true |}.

Theorem checking_the_limit_before_counting_would_accept_the_overrun :
  fee_gate a_counter_after_the_check_record 3%N 5%N 3%N = true.
Proof. reflexivity. Qed.

(** ** The conversion window itself *)

Theorem the_conversion_window_adds_no_fee :
  window_fee canonical_fee = 0%N.
Proof. reflexivity. Qed.

Definition a_window_charging_record : FeeProgram :=
  {|
     fp_order := [ValidateFlags; Charge; Allocate; ConvertArgs; Invoke; Push];
     fp_price_member := true;
     fp_exec_factor_member := true;
     fp_skips_the_inner_factor := true;
     fp_vector_from_descriptor := true;
     fp_one_pop_per_parameter := true;
     fp_arity_from_handler := true;
     fp_price_type_long := true;
     fp_price_may_be_zero := true;
     fp_negative_rejected := true;
     fp_whitelist_bypass := true;
     fp_factor_branch_only := true;
     fp_consumed_before_limit := true;
     fp_limit_strict := true;
     fp_no_fee_inside := false |}.

Theorem a_charge_inside_the_window_is_visible :
  window_fee a_window_charging_record = 1%N.
Proof. reflexivity. Qed.

Theorem the_converted_vector_keeps_one_slot_per_declared_argument :
  fp_vector_from_descriptor canonical_fee = true.
Proof. reflexivity. Qed.

Theorem the_arity_is_read_from_the_handler_signature :
  fp_arity_from_handler canonical_fee = true.
Proof. reflexivity. Qed.

(** * Assumption inventory *)
Print Assumptions the_charge_sits_between_the_flag_check_and_the_conversion.
Print Assumptions an_absent_step_is_never_earlier.
Print Assumptions earlier_is_irreflexive.
Print Assumptions the_order_alone_decides_the_flag_priority.
Print Assumptions a_rejected_call_charges_nothing_when_the_flag_check_comes_first.
Print Assumptions a_rejected_call_pops_nothing_when_the_flag_check_comes_first.
Print Assumptions a_rejected_call_pays_when_the_charge_comes_first.
Print Assumptions the_charge_is_paid_before_the_first_pop.
Print Assumptions the_charge_is_paid_before_a_successful_conversion.
Print Assumptions a_conversion_fault_does_not_refund_the_charge.
Print Assumptions a_conversion_fault_pops_only_the_converted_prefix.
Print Assumptions a_fee_shortfall_pops_nothing.
Print Assumptions the_charge_does_not_depend_on_the_arity.
Print Assumptions the_handler_runs_only_after_the_conversion.
Print Assumptions one_pop_per_parameter_drains_exactly_the_arity.
Print Assumptions a_whitelisted_context_pays_nothing.
Print Assumptions a_whitelisted_context_still_pops.
Print Assumptions the_factor_is_applied_once_on_the_reviewed_record.
Print Assumptions asking_for_the_factor_twice_would_charge_seventy_five.
Print Assumptions dropping_the_inner_branch_also_doubles_the_charge.
Print Assumptions a_zero_price_charges_nothing.
Print Assumptions the_long_declaration_holds_a_price_above_the_int_range.
Print Assumptions the_int_declaration_cannot_hold_that_price.
Print Assumptions a_zero_price_is_legitimate_on_the_reviewed_record.
Print Assumptions a_nonzero_declaration_would_reject_a_zero_price.
Print Assumptions a_negative_fee_is_rejected.
Print Assumptions a_one_less_bound_misses_the_negative_edge.
Print Assumptions the_limit_accepts_a_call_landing_exactly_on_it.
Print Assumptions a_non_strict_comparison_would_refuse_that_call.
Print Assumptions a_call_that_overruns_the_limit_is_refused.
Print Assumptions checking_the_limit_before_counting_would_accept_the_overrun.
Print Assumptions the_conversion_window_adds_no_fee.
Print Assumptions a_charge_inside_the_window_is_visible.
Print Assumptions the_converted_vector_keeps_one_slot_per_declared_argument.
Print Assumptions the_arity_is_read_from_the_handler_signature.
