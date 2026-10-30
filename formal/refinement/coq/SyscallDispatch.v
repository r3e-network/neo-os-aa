(* Syscall and CALLT admission, ending exactly where EntryDispatch begins.

   EntryDispatch.v starts "after interop admission and argument conversion".
   This file covers that excluded prefix for the two dynamic-call paths: the
   System.Contract.Call interop handler and the CALLT opcode. Both end by
   handing (method, arity, flags, hasReturnValue, args) to
   ApplicationEngine.CallContractInternal, which is EntryDispatch's entry.

   Pinned to neo d10e9cee ApplicationEngine.Contract.cs (System_Contract_Call
   registration and CallContract), ApplicationEngine.cs (OnSysCall,
   ValidateCallFlags, OnCallT, CallContractInternal), InteropDescriptor.cs,
   MethodToken.cs and CallFlags.cs. CallFlags is a four-bit word there, so
   every range test below stays an explicit N.land/N.eqb.

   Not proved here: AddFee and its gas failure, Convert, the converted Array
   payload's element list, Policy and storage lookups, LoadContract and
   everything after the handoff, exception identity (each reject is a fault,
   not a rollback) and the trusted C# frontend. Values and identities are
   opaque.

   Four pinned guards are reason refinements, not behaviour changes, because
   the same input faults either way: the called contract being absent, the ABI
   method being absent, the CALLT token index being out of range (an unguarded
   array read throws) and the CALLT parameter count exceeding the stack (an
   unguarded Pop throws). They are modelled as unconditional faults instead of
   mutable gates: a mutant that deleted one would keep the same admission
   outcome and would therefore prove nothing. The field set below is exactly
   the set of pinned decisions whose removal changes an outcome or a handed-off
   value. *)
From Coq Require Import NArith PeanoNat List Bool Lia String Ascii.
Require Import EntryDispatch.
Import ListNotations.
Open Scope string_scope.
Open Scope list_scope.

(* ------------------------------------------------------------------ *)
(* The consumed stack window                                           *)
(* ------------------------------------------------------------------ *)

(* `args[i] = Pop()` for i ascending: the head of the stack is argument 0.
   CALLT and the interop handler both consume their parameters this way, so the
   window is polymorphic and its algebra is proved once. *)
Fixpoint pop_window (A : Type) (count : nat) (stack : list A) {struct count}
  : option (list A * list A) :=
  match count with
  | O => Some (nil, stack)
  | S k =>
      match stack with
      | nil => None
      | x :: rest =>
          match pop_window A k rest with
          | Some (args, leftover) => Some (x :: args, leftover)
          | None => None
          end
      end
  end.
Arguments pop_window {A} count stack.

Section Window.
Context {A : Type}.

Lemma pop_window_length : forall (count : nat) (stack args leftover : list A),
  pop_window count stack = Some (args, leftover) -> List.length args = count.
Proof.
  induction count as [|k IH]; intros stack args leftover H.
  - cbn [pop_window] in H. injection H as H1 H2. subst. reflexivity.
  - destruct stack as [|x rest].
    + cbn [pop_window] in H. discriminate H.
    + cbn [pop_window] in H.
      destruct (pop_window k rest) as [[a l]|] eqn:E; cbn in H.
      * injection H as H1 H2. subst. cbn [List.length]. f_equal. eapply IH. exact E.
      * discriminate H.
Qed.

(* The headline structural fact: consuming the window neither reorders nor
   drops anything. The caller's stack is exactly the window followed by the
   rest, so whatever the callee receives as `args` is a contiguous, ordered
   prefix of the caller's stack. *)
Lemma pop_window_splits : forall (count : nat) (stack args leftover : list A),
  pop_window count stack = Some (args, leftover) -> stack = args ++ leftover.
Proof.
  induction count as [|k IH]; intros stack args leftover H.
  - cbn [pop_window] in H. injection H as H1 H2. subst. reflexivity.
  - destruct stack as [|x rest].
    + cbn [pop_window] in H. discriminate H.
    + cbn [pop_window] in H.
      destruct (pop_window k rest) as [[a l]|] eqn:E; cbn in H.
      * injection H as H1 H2. subst. cbn [List.app]. f_equal. eapply IH. exact E.
      * discriminate H.
Qed.

Lemma pop_window_short : forall (count : nat) (stack : list A),
  (List.length stack < count)%nat -> pop_window count stack = None.
Proof.
  induction count as [|k IH]; intros stack H.
  - lia.
  - destruct stack as [|x rest].
    + cbn [pop_window]. reflexivity.
    + cbn [pop_window]. assert (List.length rest < k)%nat as Hk by (cbn in H; lia).
      rewrite (IH rest Hk). reflexivity.
Qed.

Lemma pop_window_total : forall (count : nat) (stack : list A),
  (count <= List.length stack)%nat ->
  exists args leftover, pop_window count stack = Some (args, leftover).
Proof.
  induction count as [|k IH]; intros stack H.
  - exists nil, stack. cbn [pop_window]. reflexivity.
  - destruct stack as [|x rest].
    + cbn in H. lia.
    + assert (k <= List.length rest)%nat as Hk by (cbn in H; lia).
      destruct (IH rest Hk) as [a [l Hsome]].
      exists (x :: a), l. cbn [pop_window]. rewrite Hsome. reflexivity.
Qed.

End Window.

(* The reverse push in CallContractInternal undoes the ascending pops: the
   callee stack is the window again, in the caller's order. *)
Lemma push_window_is_the_window : forall args,
  push_values (rev args) [] = args.
Proof. intros args. rewrite push_values_order, rev_involutive, app_nil_r. reflexivity. Qed.

(* ------------------------------------------------------------------ *)
(* Projection record                                                   *)
(* ------------------------------------------------------------------ *)

(* MethodToken carries contract hash, method name, ushort parameter count,
   return flag and a byte-sized CallFlags. Deserialize, not OnCallT, is what
   forbids a leading underscore and an out-of-range flag word, so both
   obligations are discharged before any CALLT executes. *)
Record Token := method_token {
  token_contract : nat;
  token_method : string;
  token_arity : nat;
  token_flags : N;
  token_returns : bool
}.

(* `=` binds looser than `/\` in Coq, so every conjunct below is parenthesised
   explicitly; without the parentheses this reads as one equation whose right
   side is a conjunction. *)
Definition token_well_formed (t : Token) : Prop :=
  (starts_underscore (token_method t) = false) /\
  (valid_flags (token_flags t)) /\
  (token_arity t <= 65535)%nat.

(* One field per pinned decision whose removal changes an outcome or a value. *)
Record SyscallProgram := syscall_program {
  sp_interop_flag_gate : bool;        (* OnSysCall: ValidateCallFlags(RequiredCallFlags) *)
  sp_interop_required_flags : N;      (* System.Contract.Call: ReadStates|AllowCall *)
  sp_interop_pop_count : nat;         (* the descriptor parameter-list count popped *)
  sp_interop_flag_slot : nat;         (* which popped value is `callFlags` *)
  sp_interop_pushes_result : bool;    (* OnSysCall pushes iff Handler returns non-void *)
  sp_interop_handler_void : bool;     (* CallContract is `void` *)
  sp_interop_result : nat;            (* the opaque pushed value, when it pushes *)
  sp_call_rejects_underscore : bool;
  sp_call_flag_range_gate : bool;     (* (callFlags & ~CallFlags.All) != 0 *)
  sp_call_all_flags : N;
  sp_call_derives_return : bool;      (* hasReturnValue = ReturnType != Void *)
  sp_call_marks_dynamic : bool;       (* IsDynamicCall = true after the call *)
  sp_token_flag_gate : bool;          (* OnCallT: ValidateCallFlags(ReadStates|AllowCall) *)
  sp_token_required_flags : N;
  sp_token_pops : bool;               (* args[i] = Pop(), i ascending *)
  sp_token_marks_dynamic : bool      (* OnCallT leaves IsDynamicCall untouched *)
}.

Definition canonical_syscall :=
  syscall_program true 5%N 4 2 true true 0
    true true 15%N true true
    true 5%N true false.

Inductive Reject :=
| RejectInteropFlags
| RejectUnderscore
| RejectFlagRange
| RejectMissingContract
| RejectMissingMethod
| RejectInteropStack
| RejectTokenFlags
| RejectTokenIndex
| RejectTokenStack.

(* Exactly the CallContractInternal parameter tuple, so a caller of this file
   hands `cf_*` straight to EntryDispatch without translation. *)
Record CallFrame := call_frame {
  cf_method : string;
  cf_arity : nat;
  cf_flags : N;
  cf_returns : bool;
  cf_dynamic : bool
}.

Inductive Outcome :=
| Rejected : Reject -> Outcome
| Accepted : CallFrame -> list nat -> list nat -> Outcome.

Definition flag_gate (have need : N) : bool := N.eqb (N.land have need) need.
Definition flag_range (flags all : N) : bool := N.eqb (N.land flags all) flags.

Definition interop_leftover (p : SyscallProgram) (leftover : list nat) : list nat :=
  if andb (sp_interop_pushes_result p) (negb (sp_interop_handler_void p))
  then sp_interop_result p :: leftover
  else leftover.

Definition handoff_args (p : SyscallProgram) (args : list nat) : list nat :=
  if sp_token_pops p then args else rev args.

(* ------------------------------------------------------------------ *)
(* System.Contract.Call                                                *)
(* ------------------------------------------------------------------ *)

(* OnSysCall validates the caller's own flags and pops every handler parameter
   before it invokes CallContract, so the underscore and flag-range rejections
   sit behind both. `arity` is the converted Array's length and keys the ABI
   lookup; it is independent of `sp_interop_pop_count`. `array` is that Array's
   payload, supplied as an opaque input. *)
Definition interop_admit (p : SyscallProgram) (abi : list Descriptor)
    (name : string) (arity : nat) (caller_flags : N) (contract_present : bool)
    (array : list nat) (stack : list nat) : Outcome :=
  if if sp_interop_flag_gate p then flag_gate caller_flags (sp_interop_required_flags p) else true
  then match pop_window (sp_interop_pop_count p) stack with
       | None => Rejected RejectInteropStack
       | Some (params, leftover) =>
           if if sp_call_rejects_underscore p then negb (starts_underscore name) else true
           then if if sp_call_flag_range_gate p
                  then flag_range (N.of_nat (nth (sp_interop_flag_slot p) params 0)) (sp_call_all_flags p)
                  else true
                then if contract_present
                     then match abi_select abi name arity with
                          | None => Rejected RejectMissingMethod
                          | Some d => Accepted (call_frame name arity
                                         (N.of_nat (nth (sp_interop_flag_slot p) params 0))
                                         (andb (sp_call_derives_return p) (descriptor_nonvoid d))
                                         (sp_call_marks_dynamic p)) array
                                       (interop_leftover p leftover)
                          end
                     else Rejected RejectMissingContract
                else Rejected RejectFlagRange
           else Rejected RejectUnderscore
       end
  else Rejected RejectInteropFlags.

(* ------------------------------------------------------------------ *)
(* CALLT                                                               *)
(* ------------------------------------------------------------------ *)

(* OnCallT reads the token first, then pops `token_arity t` values. It does not
   repeat the underscore or flag-range admission that MethodToken.Deserialize
   already performed, and it does not mark the new context dynamic. *)
Definition token_admit (p : SyscallProgram) (tokens : list Token)
    (index : nat) (caller_flags : N) (stack : list nat) : Outcome :=
  if if sp_token_flag_gate p then flag_gate caller_flags (sp_token_required_flags p) else true
  then match nth_error tokens index with
       | None => Rejected RejectTokenIndex
       | Some t =>
           match pop_window (token_arity t) stack with
           | None => Rejected RejectTokenStack
           | Some (args, leftover) =>
               Accepted (call_frame (token_method t) (token_arity t) (token_flags t)
                           (token_returns t) (sp_token_marks_dynamic p))
                        (handoff_args p args) leftover
           end
       end
  else Rejected RejectTokenFlags.

(* ------------------------------------------------------------------ *)
(* Pinned field values                                                 *)
(* ------------------------------------------------------------------ *)

Lemma canonical_interop_required_flags :
  sp_interop_required_flags canonical_syscall = 5%N.
Proof. reflexivity. Qed.

Lemma canonical_interop_parameter_shape :
  sp_interop_pop_count canonical_syscall = 4 /\ sp_interop_flag_slot canonical_syscall = 2.
Proof. split; reflexivity. Qed.

Lemma canonical_call_all_flags : sp_call_all_flags canonical_syscall = 15%N.
Proof. reflexivity. Qed.

Lemma canonical_token_required_flags :
  sp_token_required_flags canonical_syscall = 5%N.
Proof. reflexivity. Qed.

(* The two paths differ here, and the difference is the whole reason
   EntryDispatch's `dp_dynamic` field is reachable from only one of them. *)
Lemma canonical_dynamic_markers :
  sp_call_marks_dynamic canonical_syscall = true /\
  sp_token_marks_dynamic canonical_syscall = false.
Proof. split; reflexivity. Qed.

Lemma canonical_interop_pushes_nothing : forall leftover,
  interop_leftover canonical_syscall leftover = leftover.
Proof. intros leftover. reflexivity. Qed.

Lemma canonical_handoff_keeps_the_pop_order : forall args,
  handoff_args canonical_syscall args = args.
Proof. intros args. reflexivity. Qed.

Lemma token_well_formed_forbids_underscore : forall t,
  token_well_formed t -> starts_underscore (token_method t) = false.
Proof. intros t [H _]. exact H. Qed.

Lemma token_well_formed_bounds_flags : forall t,
  token_well_formed t -> valid_flags (token_flags t).
Proof. intros t [_ [H _]]. exact H. Qed.

Lemma token_well_formed_bounds_arity : forall t,
  token_well_formed t -> (token_arity t <= 65535)%nat.
Proof. intros t [_ [_ H]]. exact H. Qed.

(* ------------------------------------------------------------------ *)
(* System.Contract.Call: rejection, in source order                     *)
(* ------------------------------------------------------------------ *)

(* OnSysCall runs ValidateCallFlags before anything else, so the caller's own
   flag word is the first gate on this path. *)
Theorem interop_requires_the_caller_flags :
  forall abi name arity caller_flags contract_present array stack,
  flag_gate caller_flags (sp_interop_required_flags canonical_syscall) = false ->
  interop_admit canonical_syscall abi name arity caller_flags contract_present array stack
    = Rejected RejectInteropFlags.
Proof.
  intros abi name arity caller_flags contract_present array stack H.
  unfold interop_admit. unfold canonical_syscall in *. cbn -[pop_window] in *.
  rewrite H. reflexivity.
Qed.

(* The pops precede the underscore test: an exhausted stack faults even for a
   name that could never be admitted. *)
Theorem interop_underflow_precedes_underscore :
  forall abi name arity caller_flags contract_present array stack,
  flag_gate caller_flags (sp_interop_required_flags canonical_syscall) = true ->
  (List.length stack < sp_interop_pop_count canonical_syscall)%nat ->
  interop_admit canonical_syscall abi name arity caller_flags contract_present array stack
    = Rejected RejectInteropStack.
Proof.
  intros abi name arity caller_flags contract_present array stack Hf Hlen.
  unfold interop_admit. unfold canonical_syscall in *. cbn -[pop_window] in *.
  rewrite Hf. cbn -[pop_window]. rewrite (pop_window_short 4 stack Hlen). reflexivity.
Qed.

Theorem interop_rejects_underscore :
  forall abi name arity caller_flags contract_present array stack params leftover,
  flag_gate caller_flags (sp_interop_required_flags canonical_syscall) = true ->
  pop_window (sp_interop_pop_count canonical_syscall) stack = Some (params, leftover) ->
  starts_underscore name = true ->
  interop_admit canonical_syscall abi name arity caller_flags contract_present array stack
    = Rejected RejectUnderscore.
Proof.
  intros abi name arity caller_flags contract_present array stack params leftover Hf Hp Hu.
  unfold interop_admit. unfold canonical_syscall in *. cbn -[pop_window] in *.
  rewrite Hf. cbn -[pop_window]. rewrite Hp. cbn -[pop_window]. rewrite Hu. reflexivity.
Qed.

(* The range test inspects the third popped value, the converted `callFlags`,
   and not the caller's own flags. *)
Theorem interop_rejects_out_of_range_flags :
  forall abi name arity caller_flags contract_present array stack params leftover,
  flag_gate caller_flags (sp_interop_required_flags canonical_syscall) = true ->
  pop_window (sp_interop_pop_count canonical_syscall) stack = Some (params, leftover) ->
  negb (starts_underscore name) = true ->
  flag_range (N.of_nat (nth (sp_interop_flag_slot canonical_syscall) params 0))
    (sp_call_all_flags canonical_syscall) = false ->
  interop_admit canonical_syscall abi name arity caller_flags contract_present array stack
    = Rejected RejectFlagRange.
Proof.
  intros abi name arity caller_flags contract_present array stack params leftover
    Hf Hp Hu Hr.
  unfold interop_admit. unfold canonical_syscall in *. cbn -[pop_window] in *.
  rewrite Hf. cbn -[pop_window]. rewrite Hp. cbn -[pop_window]. rewrite Hu. cbn -[pop_window]. rewrite Hr. reflexivity.
Qed.

Theorem interop_rejects_missing_contract :
  forall abi name arity caller_flags array stack params leftover,
  flag_gate caller_flags (sp_interop_required_flags canonical_syscall) = true ->
  pop_window (sp_interop_pop_count canonical_syscall) stack = Some (params, leftover) ->
  negb (starts_underscore name) = true ->
  flag_range (N.of_nat (nth (sp_interop_flag_slot canonical_syscall) params 0))
    (sp_call_all_flags canonical_syscall) = true ->
  interop_admit canonical_syscall abi name arity caller_flags false array stack
    = Rejected RejectMissingContract.
Proof.
  intros abi name arity caller_flags array stack params leftover Hf Hp Hu Hr.
  unfold interop_admit. unfold canonical_syscall in *. cbn -[pop_window] in *.
  rewrite Hf. cbn -[pop_window]. rewrite Hp. cbn -[pop_window]. rewrite Hu. cbn -[pop_window]. rewrite Hr. cbn -[pop_window]. reflexivity.
Qed.

Theorem interop_rejects_missing_method :
  forall abi name arity caller_flags contract_present array stack params leftover,
  flag_gate caller_flags (sp_interop_required_flags canonical_syscall) = true ->
  pop_window (sp_interop_pop_count canonical_syscall) stack = Some (params, leftover) ->
  negb (starts_underscore name) = true ->
  flag_range (N.of_nat (nth (sp_interop_flag_slot canonical_syscall) params 0))
    (sp_call_all_flags canonical_syscall) = true ->
  contract_present = true ->
  abi_select abi name arity = None ->
  interop_admit canonical_syscall abi name arity caller_flags contract_present array stack
    = Rejected RejectMissingMethod.
Proof.
  intros abi name arity caller_flags contract_present array stack params leftover
    Hf Hp Hu Hr Hc Hm.
  unfold interop_admit. unfold canonical_syscall in *. cbn -[pop_window] in *.
  rewrite Hf. cbn -[pop_window]. rewrite Hp. cbn -[pop_window]. rewrite Hu. cbn -[pop_window]. rewrite Hr. cbn -[pop_window].
  rewrite Hc. cbn -[pop_window]. rewrite Hm. reflexivity.
Qed.

(* The positive envelope: every guard passes, so the caller's flags word is
   replaced by the one popped from slot 2, the return flag is derived from the
   descriptor, the Array payload becomes the argument list, and the stack loses
   exactly the popped window. *)
Theorem interop_accepts :
  forall abi name arity caller_flags array stack params leftover d,
  flag_gate caller_flags (sp_interop_required_flags canonical_syscall) = true ->
  pop_window (sp_interop_pop_count canonical_syscall) stack = Some (params, leftover) ->
  negb (starts_underscore name) = true ->
  flag_range (N.of_nat (nth (sp_interop_flag_slot canonical_syscall) params 0))
    (sp_call_all_flags canonical_syscall) = true ->
  abi_select abi name arity = Some d ->
  interop_admit canonical_syscall abi name arity caller_flags true array stack
    = Accepted (call_frame name arity
                  (N.of_nat (nth (sp_interop_flag_slot canonical_syscall) params 0))
                  (descriptor_nonvoid d)
                  (sp_call_marks_dynamic canonical_syscall))
               array (interop_leftover canonical_syscall leftover).
Proof.
  intros abi name arity caller_flags array stack params leftover d Hf Hp Hu Hr Hm.
  unfold interop_admit. unfold canonical_syscall in *. cbn -[pop_window] in *.
  rewrite Hf. cbn -[pop_window]. rewrite Hp. cbn -[pop_window]. rewrite Hu. cbn -[pop_window]. rewrite Hr. cbn -[pop_window].
  rewrite Hm. cbn -[pop_window]. reflexivity.
Qed.

Theorem interop_consumes_the_parameter_window :
  forall (params leftover stack : list nat),
  pop_window (sp_interop_pop_count canonical_syscall) stack = Some (params, leftover) ->
  stack = params ++ leftover /\ (List.length params = 4)%nat.
Proof.
  intros params leftover stack Hp. split.
  - eapply pop_window_splits. exact Hp.
  - rewrite (pop_window_length 4 stack params leftover Hp). reflexivity.
Qed.

Theorem interop_leaves_the_rest_of_the_stack_untouched :
  forall leftover, interop_leftover canonical_syscall leftover = leftover.
Proof. exact canonical_interop_pushes_nothing. Qed.

Theorem interop_abi_key_is_the_converted_array_length :
  forall abi name arity caller_flags (array stack leftover : list nat) d frame,
  interop_admit canonical_syscall abi name arity caller_flags true array stack
    = Accepted frame array (interop_leftover canonical_syscall leftover) ->
  abi_select abi name arity = Some d ->
  cf_arity frame = arity.
Proof.
  intros abi name arity caller_flags array stack leftover d frame Hacc _.
  unfold interop_admit in Hacc. unfold canonical_syscall in *. cbn -[pop_window] in *.
  destruct (flag_gate caller_flags 5%N) eqn:E1 in Hacc; cbn -[pop_window] in Hacc; [|discriminate Hacc].
  destruct (pop_window 4 stack) as [[ps lo]|] eqn:E2 in Hacc; cbn -[pop_window] in Hacc; [|discriminate Hacc].
  destruct (negb (starts_underscore name)) eqn:E3 in Hacc; cbn -[pop_window] in Hacc; [|discriminate Hacc].
  destruct (flag_range (N.of_nat (nth 2 ps 0)) 15%N) eqn:E4 in Hacc; cbn -[pop_window] in Hacc; [|discriminate Hacc].
  destruct (abi_select abi name arity) as [d0|] eqn:E5 in Hacc; cbn -[pop_window] in Hacc; [|discriminate Hacc].
  inversion Hacc. reflexivity.
Qed.

(* ------------------------------------------------------------------ *)
(* CALLT: rejection and handoff                                        *)
(* ------------------------------------------------------------------ *)

Theorem token_requires_the_caller_flags :
  forall tokens index caller_flags stack,
  flag_gate caller_flags (sp_token_required_flags canonical_syscall) = false ->
  token_admit canonical_syscall tokens index caller_flags stack
    = Rejected RejectTokenFlags.
Proof.
  intros tokens index caller_flags stack H.
  unfold token_admit. unfold canonical_syscall in *. cbn -[pop_window] in *.
  rewrite H. reflexivity.
Qed.

Theorem token_flag_gate_precedes_the_token_index :
  forall tokens index caller_flags stack,
  flag_gate caller_flags (sp_token_required_flags canonical_syscall) = false ->
  nth_error tokens index = None ->
  token_admit canonical_syscall tokens index caller_flags stack
    = Rejected RejectTokenFlags.
Proof.
  intros tokens index caller_flags stack H _.
  apply token_requires_the_caller_flags. exact H.
Qed.

Theorem token_rejects_missing_token :
  forall tokens index caller_flags stack,
  flag_gate caller_flags (sp_token_required_flags canonical_syscall) = true ->
  nth_error tokens index = None ->
  token_admit canonical_syscall tokens index caller_flags stack
    = Rejected RejectTokenIndex.
Proof.
  intros tokens index caller_flags stack Hf Hn.
  unfold token_admit. unfold canonical_syscall in *. cbn -[pop_window] in *.
  rewrite Hf. cbn -[pop_window]. rewrite Hn. reflexivity.
Qed.

Theorem token_rejects_short_stack :
  forall tokens index caller_flags stack t,
  flag_gate caller_flags (sp_token_required_flags canonical_syscall) = true ->
  nth_error tokens index = Some t ->
  (List.length stack < token_arity t)%nat ->
  token_admit canonical_syscall tokens index caller_flags stack
    = Rejected RejectTokenStack.
Proof.
  intros tokens index caller_flags stack t Hf Hn Hlen.
  unfold token_admit. unfold canonical_syscall in *. cbn -[pop_window] in *.
  rewrite Hf. cbn -[pop_window]. rewrite Hn. cbn -[pop_window].
  rewrite (pop_window_short (token_arity t) stack Hlen). reflexivity.
Qed.

(* CALLT re-uses the token's own flag word without repeating the `~All` range
   test, so the handed-off flags are exactly `token_flags t`. *)
Theorem token_accepts :
  forall tokens index caller_flags stack t args leftover,
  flag_gate caller_flags (sp_token_required_flags canonical_syscall) = true ->
  nth_error tokens index = Some t ->
  pop_window (token_arity t) stack = Some (args, leftover) ->
  token_admit canonical_syscall tokens index caller_flags stack
    = Accepted (call_frame (token_method t) (token_arity t) (token_flags t)
                  (token_returns t) (sp_token_marks_dynamic canonical_syscall))
               (handoff_args canonical_syscall args) leftover.
Proof.
  intros tokens index caller_flags stack t args leftover Hf Hn Hp.
  unfold token_admit. unfold canonical_syscall in *. cbn -[pop_window] in *.
  rewrite Hf. cbn -[pop_window]. rewrite Hn. cbn -[pop_window]. rewrite Hp. reflexivity.
Qed.

Theorem token_hands_off_the_token_flags :
  forall tokens index caller_flags stack t args leftover frame,
  token_admit canonical_syscall tokens index caller_flags stack
    = Accepted frame (handoff_args canonical_syscall args) leftover ->
  nth_error tokens index = Some t ->
  pop_window (token_arity t) stack = Some (args, leftover) ->
  flag_gate caller_flags (sp_token_required_flags canonical_syscall) = true ->
  cf_flags frame = token_flags t.
Proof.
  intros tokens index caller_flags stack t args leftover frame Hacc Hn Hp Hf.
  unfold token_admit in Hacc. unfold canonical_syscall in *. cbn -[pop_window] in *.
  rewrite Hf in Hacc. cbn -[pop_window] in Hacc. rewrite Hn in Hacc. cbn -[pop_window] in Hacc.
  rewrite Hp in Hacc. inversion Hacc. reflexivity.
Qed.

Theorem callt_never_marks_the_context_dynamic :
  forall tokens index caller_flags (stack args leftover : list nat) frame,
  token_admit canonical_syscall tokens index caller_flags stack
    = Accepted frame (handoff_args canonical_syscall args) leftover ->
  cf_dynamic frame = false.
Proof.
  intros tokens index caller_flags stack args leftover frame Hacc.
  unfold token_admit in Hacc. unfold canonical_syscall in *. cbn -[pop_window] in *.
  destruct (flag_gate caller_flags 5%N) eqn:E1 in Hacc; cbn -[pop_window] in Hacc; [|discriminate Hacc].
  destruct (nth_error tokens index) as [t0|] eqn:E2 in Hacc; cbn -[pop_window] in Hacc; [|discriminate Hacc].
  destruct (pop_window (token_arity t0) stack) as [[a l]|] eqn:E3 in Hacc; cbn -[pop_window] in Hacc; [|discriminate Hacc].
  inversion Hacc. reflexivity.
Qed.

Theorem system_contract_call_marks_the_context_dynamic :
  forall abi name arity caller_flags (array stack leftover : list nat) frame,
  interop_admit canonical_syscall abi name arity caller_flags true array stack
    = Accepted frame array (interop_leftover canonical_syscall leftover) ->
  cf_dynamic frame = true.
Proof.
  intros abi name arity caller_flags array stack leftover frame Hacc.
  unfold interop_admit in Hacc. unfold canonical_syscall in *. cbn -[pop_window] in *.
  destruct (flag_gate caller_flags 5%N) eqn:E1 in Hacc; cbn -[pop_window] in Hacc; [|discriminate Hacc].
  destruct (pop_window 4 stack) as [[ps lo]|] eqn:E2 in Hacc; cbn -[pop_window] in Hacc; [|discriminate Hacc].
  destruct (negb (starts_underscore name)) eqn:E3 in Hacc; cbn -[pop_window] in Hacc; [|discriminate Hacc].
  destruct (flag_range (N.of_nat (nth 2 ps 0)) 15%N) eqn:E4 in Hacc; cbn -[pop_window] in Hacc; [|discriminate Hacc].
  destruct (abi_select abi name arity) as [d0|] eqn:E5 in Hacc; cbn -[pop_window] in Hacc; [|discriminate Hacc].
  inversion Hacc. reflexivity.
Qed.

(* ------------------------------------------------------------------ *)
(* Composition with EntryDispatch                                      *)
(* ------------------------------------------------------------------ *)

(* The window CALLT pops is the argument vector EntryDispatch's source frame
   pushes, in the same order. Composing the two files therefore does not
   reorder the caller's stack: what the callee sees under its frame is the
   caller's contiguous top window. *)
Theorem callt_window_reaches_the_entry_frame :
  forall (args leftover stack : list nat),
  pop_window (List.length args) stack = Some (args, leftover) ->
  stack = args ++ leftover /\
  source_arguments canonical_program (handoff_args canonical_syscall args) = args.
Proof.
  intros args leftover stack Hp. split.
  - eapply pop_window_splits. exact Hp.
  - rewrite canonical_handoff_keeps_the_pop_order.
    apply reverse_push_preserves_argument_order.
Qed.

(* The same statement in the shape the CALLT certificate uses. *)
Theorem token_window_reaches_the_entry_frame :
  forall tokens index caller_flags stack t args leftover,
  flag_gate caller_flags (sp_token_required_flags canonical_syscall) = true ->
  nth_error tokens index = Some t ->
  pop_window (token_arity t) stack = Some (args, leftover) ->
  stack = (handoff_args canonical_syscall args) ++ leftover /\
  source_arguments canonical_program (handoff_args canonical_syscall args)
    = handoff_args canonical_syscall args.
Proof.
  intros tokens index caller_flags stack t args leftover Hf Hn Hp. split.
  - rewrite canonical_handoff_keeps_the_pop_order. eapply pop_window_splits. exact Hp.
  - apply reverse_push_preserves_argument_order.
Qed.

(* ------------------------------------------------------------------ *)
(* Public concrete witnesses for mutant rejection                       *)
(* ------------------------------------------------------------------ *)

(* Illustrative identities, not any deployed artifact or public method. *)
Definition syscall_fixture_stack : list nat := [11; 13; 15; 17; 19].
Definition syscall_fixture_abi : list Descriptor :=
  [descriptor "probe" 2 101 true true; descriptor "_initialize" 0 109 false false].
Definition syscall_fixture_array : list nat := [23; 29].
Definition syscall_fixture_token : Token := method_token 31 "probe" 2 15%N true.
Definition syscall_fixture_tokens : list Token :=
  [syscall_fixture_token; method_token 37 "other" 0 5%N false].
Definition syscall_fixture_call_stack : list nat := [41; 43; 47].
Definition syscall_fixture_tail : list nat := [53].

Print Assumptions pop_window_length.
Print Assumptions pop_window_splits.
Print Assumptions pop_window_short.
Print Assumptions pop_window_total.
Print Assumptions push_window_is_the_window.
Print Assumptions canonical_interop_required_flags.
Print Assumptions canonical_interop_parameter_shape.
Print Assumptions canonical_call_all_flags.
Print Assumptions canonical_token_required_flags.
Print Assumptions canonical_dynamic_markers.
Print Assumptions canonical_interop_pushes_nothing.
Print Assumptions canonical_handoff_keeps_the_pop_order.
Print Assumptions token_well_formed_forbids_underscore.
Print Assumptions token_well_formed_bounds_flags.
Print Assumptions token_well_formed_bounds_arity.
Print Assumptions interop_requires_the_caller_flags.
Print Assumptions interop_underflow_precedes_underscore.
Print Assumptions interop_rejects_underscore.
Print Assumptions interop_rejects_out_of_range_flags.
Print Assumptions interop_rejects_missing_contract.
Print Assumptions interop_rejects_missing_method.
Print Assumptions interop_accepts.
Print Assumptions interop_consumes_the_parameter_window.
Print Assumptions interop_leaves_the_rest_of_the_stack_untouched.
Print Assumptions interop_abi_key_is_the_converted_array_length.
Print Assumptions token_requires_the_caller_flags.
Print Assumptions token_flag_gate_precedes_the_token_index.
Print Assumptions token_rejects_missing_token.
Print Assumptions token_rejects_short_stack.
Print Assumptions token_accepts.
Print Assumptions token_hands_off_the_token_flags.
Print Assumptions callt_never_marks_the_context_dynamic.
Print Assumptions system_contract_call_marks_the_context_dynamic.
Print Assumptions callt_window_reaches_the_entry_frame.
Print Assumptions token_window_reaches_the_entry_frame.
