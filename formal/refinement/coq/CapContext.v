(* Explicit initialization extension. Raw instruction decoding is independent
   of any desired key or static slot. No resource or ApplicationEngine claim. *)
From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import IntegerSemantics CapArithmetic CapMethodVm.
Import ListNotations.
Open Scope Z_scope.

Record InitState := init_state {
  init_pc : nat; init_stack : list Value; init_heap : list Object;
  init_slots : option (list Value)
}.
Inductive InitInstruction :=
| InitStatics : nat -> InitInstruction
| InitPush : Value -> InitInstruction
| InitStore : nat -> InitInstruction
| InitConvertBuffer | InitPack | InitReturn.
Fixpoint little_unsigned (bs : list nat) : Z :=
  match bs with [] => 0 | b::rest => Z.of_nat b + 256 * little_unsigned rest end.
Definition little_signed (bs : list nat) : Z :=
  let u := little_unsigned bs in
  let width := 8 * Z.of_nat (length bs) in
  if Z.testbit u (width-1) then u - 2^width else u.
Definition init_decode (code : list nat) (p : nat) : option (InitInstruction * nat) :=
  match skipn p code with
  | 86%nat::n::_ => Some (InitStatics n,2%nat)
  | 103%nat::n::_ => Some (InitStore n,2%nat)
  | 219%nat::48%nat::_ => Some (InitConvertBuffer,2%nat)
  | 12%nat::n::rest => if (n <=? length rest)%nat
      then Some (InitPush (VBytes (firstn n rest)),(n+2)%nat) else None
  | 1%nat::a::b::_ => Some (InitPush (VInt (little_signed [a;b])),3%nat)
  | 2%nat::a::b::c::d::_ => Some (InitPush (VInt (little_signed [a;b;c;d])),5%nat)
  | byte::_ =>
      if (16 <=? byte)%nat && (byte <=? 32)%nat
      then Some (InitPush (VInt (Z.of_nat (byte-16))),1%nat)
      else if (96 <=? byte)%nat && (byte <=? 102)%nat
      then Some (InitStore (byte-96)%nat,1%nat)
      else match byte with
      | 192%nat => Some (InitPack,1%nat)
      | 64%nat => Some (InitReturn,1%nat)
      | _ => None end
  | _ => None end.
Inductive InitStep := InitNext : InitState -> InitStep
| InitHalt : InitState -> InitStep | InitFault.
Definition init_step (instruction : InitInstruction) (size : nat) (s : InitState) : InitStep :=
  let next st hp sl := InitNext (init_state (init_pc s+size) st hp sl) in
  match instruction with
  | InitStatics count => match init_slots s with
      | None => if (0 <? count)%nat
          then next (init_stack s) (init_heap s) (Some (repeat VNull count))
          else InitFault
      | Some _ => InitFault end
  | InitPush value => next (value::init_stack s) (init_heap s) (init_slots s)
  | InitStore index => match init_stack s, init_slots s with
      | value::rest, Some slots => if (index <? length slots)%nat
          then next rest (init_heap s) (Some (firstn index slots ++ value::skipn (S index) slots))
          else InitFault
      | _,_ => InitFault end
  | InitConvertBuffer => match init_stack s with
      | VBytes bytes::rest => next (VBuffer bytes::rest) (init_heap s) (init_slots s)
      | VBuffer bytes::rest => next (VBuffer bytes::rest) (init_heap s) (init_slots s)
      | _ => InitFault end
  | InitPack => match init_stack s with
      | VInt count::rest => if (0 <=? count) && (Z.to_nat count <=? length rest)%nat
          then next (VRef (length (init_heap s))::skipn (Z.to_nat count) rest)
            (init_heap s ++ [obj ArrayKind (firstn (Z.to_nat count) rest)]) (init_slots s)
          else InitFault
      | _ => InitFault end
  | InitReturn => InitHalt s
  end.
Inductive InitOutcome := InitReturned : InitState -> InitOutcome
| InitFaulted | InitTimedOut.
Fixpoint run_init (fuel : nat) (code : list nat) (s : InitState) : InitOutcome :=
  match fuel with
  | O => InitTimedOut
  | S remaining => match init_decode code (init_pc s) with
      | None => InitFaulted
      | Some (instruction,size) => match init_step instruction size s with
          | InitNext next => run_init remaining code next
          | InitHalt final => InitReturned final
          | InitFault => InitFaulted end end end.
Definition initializer_entry hp st := init_state 0 st hp None.
Definition lookup_init_static s index :=
  match init_slots s with Some slots => nth_error slots index | None => None end.
Lemma run_init_one_step : forall fuel code s,
 run_init (S fuel) code s =
 match init_decode code (init_pc s) with
 | None => InitFaulted
 | Some (instruction,size) => match init_step instruction size s with
   | InitNext next => run_init fuel code next
   | InitHalt final => InitReturned final | InitFault => InitFaulted end end.
Proof. reflexivity. Qed.
Lemma heap_append_preserves_existing : forall (hp added : list Object) index,
 (index < length hp)%nat -> nth_error (hp++added) index = nth_error hp index.
Proof. intros. apply nth_error_app1. assumption. Qed.
Lemma first_appended_reference_fresh : forall (hp : list Object) o,
 nth_error hp (length hp) = None /\ nth_error (hp++[o]) (length hp) = Some o.
Proof. intros. split. apply nth_error_None. lia.
 rewrite nth_error_app2 by lia. rewrite Nat.sub_diag. reflexivity. Qed.

(* Contextual helper extension: same-script CALL shares the evaluation stack;
   Runtime.GetScriptContainer projects a fresh transaction array each time.
   Other helper instructions retain the frozen reference semantics. *)
Definition context_step hash sf nf instruction width s : Outcome :=
  match instruction with
  | Syscall [45%nat;81%nat;8%nat;48%nat] =>
      let '(reference,allocated) := allocate s ArrayKind (fields (tx_object hash sf nf)) in
      Continue (with_stack allocated (pc s+width)%nat (reference::stack s))
  | Return => match stack s with
      | value::rest => Halt value (with_stack s (pc s+width)%nat (value::rest))
      | [] => Fault s end
  | _ => vm_step instruction width s
  end.
Fixpoint run_context fuel code hash sf nf s :=
  match fuel with O => Timeout s | S remaining =>
    match decode code (pc s) with
    | None => Fault s
    | Some (instruction,width) => match context_step hash sf nf instruction width s with
      | Continue next => run_context remaining code hash sf nf next
      | terminal => terminal end end end.
Definition context_entry requested stored static_values hp tail :=
  state 0 (VInt requested::tail) [] [] hp stored [] static_values.
Lemma run_context_one_step : forall fuel code hash sf nf s,
 run_context (S fuel) code hash sf nf s =
 match decode code (pc s) with
 | None => Fault s
 | Some (instruction,width) => match context_step hash sf nf instruction width s with
   | Continue next => run_context fuel code hash sf nf next | terminal => terminal end end.
Proof. reflexivity. Qed.
Lemma nth_error_heap_suffix : forall (hp suffix : list Object) k,
 nth_error (hp++suffix) (length hp+k) = nth_error suffix k.
Proof. intros. rewrite nth_error_app2 by lia. f_equal. lia. Qed.
Lemma firstn_heap_suffix : forall (hp suffix : list Object) k,
 firstn (length hp+k) (hp++suffix) = hp++firstn k suffix.
Proof. intros. rewrite firstn_app. rewrite firstn_all2 by lia.
 replace (length hp+k-length hp)%nat with k by lia. reflexivity. Qed.
Lemma skipn_heap_suffix : forall (hp suffix : list Object) k,
 skipn (length hp+k) (hp++suffix) = skipn k suffix.
Proof. intros. rewrite skipn_app. rewrite skipn_all2 by lia.
 replace (length hp+k-length hp)%nat with k by lia. reflexivity. Qed.

Record ContextView := context_view {
 view_observation : Observation; view_stack : list Value; view_heap : list Object;
 view_statics : nat -> option Value
}.
Definition observe_context outcome : option ContextView :=
 match outcome with
 | Halt _ s | Aborted _ s => Some (context_view (observe outcome) (stack s) (heap s) (statics s))
 | _ => None end.
Definition contextual_classified hp tail static_values hash current_hash sf nf q r kind stored trace :=
 let paid := charge_expression (sf+nf) q r in
 let tx := tx_object current_hash sf nf in
 if 0 <? paid then
 Some (context_view (classified hash sf nf q r kind stored trace)
   (VInt paid::tail)
   (hp++[tx;obj kind [VBytes hash;VInt (r+paid)];tx;tx]) static_values)
 else Some (context_view (classified hash sf nf q r kind stored trace) tail
   (hp++[tx;obj kind [VBytes hash;VInt r];tx;tx]) static_values).
Lemma skipn_successor_heap_suffix : forall (hp suffix : list Object) k,
 (match hp++suffix with [] => [] | _::rest => skipn (length hp+k) rest end) = skipn (S k) suffix.
Proof.
 intros. change (skipn (S (length hp+k)) (hp++suffix) = skipn (S k) suffix).
 replace (S (length hp+k))%nat with (length hp+S k)%nat by lia.
 apply skipn_heap_suffix.
Qed.

Lemma contextual_classified_projection : forall hp tail static_values hash current_hash sf nf q r kind stored trace,
 option_map view_observation (contextual_classified hp tail static_values hash current_hash sf nf q r kind stored trace) =
 Some (classified hash sf nf q r kind stored trace).
Proof. intros. unfold contextual_classified. destruct (0 <? charge_expression (sf+nf) q r); reflexivity. Qed.
(* The frame theorem is stated where the helper's headroom assertion succeeds.
   That assertion guards the reservation addition, and the legal domain proves
   it always succeeds (`legal_update_fits`), so this is a precondition the
   composition layer discharges rather than an assumption about callers. Stated
   without it, the rejection branch would require a claim about the frame left
   behind by an abort, which is not what any consumer of this lemma needs. *)
Lemma vm_leb_margin_of_fits : forall reserved settled,
 integer_fits (reserved + settled) ->
 vm_leb reserved (1 * 2 ^ 254 - 1 + 1 * 2 ^ 254 - settled) = true.
Proof.
 intros reserved settled Hfits. apply vm_leb_spec.
 assert (Hmax : 1 * 2 ^ 254 - 1 + 1 * 2 ^ 254 = integer_limit - 1) by (vm_compute; reflexivity).
 rewrite Hmax. unfold integer_fits in Hfits. lia.
Qed.
Print Assumptions vm_leb_margin_of_fits.
Lemma context_frame_from_classification : forall hp tail static_values hash current_hash sf nf q r kind stored trace outcome,
 integer_fits (r + charge_expression (sf+nf) q r) ->
 observe_context outcome = contextual_classified hp tail static_values hash current_hash sf nf q r kind stored trace ->
 exists final,
 ((exists value, outcome = Halt value final /\ stack final = value::tail) \/
  (exists message, outcome = Aborted message final /\ stack final = tail)) /\
 (exists added, length added = 4%nat /\ heap final = hp++added) /\
 statics final = static_values.
Proof.
 intros hp tail static_values hash current_hash sf nf q r kind stored trace outcome Hfits H.
 unfold contextual_classified, classified in H.
 (* The headroom assertion is discharged from the hypothesis before the case
    split, so the case where it rejects never appears: that branch is an abort
    whose frame is not what this lemma is about. `vm_max` is unfolded so the
    guard and the lemma's conclusion share one normal form. *)
 unfold vm_max in H.
 rewrite (vm_leb_margin_of_fits r (charge_expression (sf+nf) q r) Hfits) in H.
 destruct (0 <? charge_expression (sf+nf) q r) eqn:E.
 all: destruct outcome as [s|value s|message s|s|s].
 all: cbn [observe_context observe] in H.
 all: try discriminate.
 all: inversion H; subst.
 all: try (exists s; repeat split; eauto).
 all: match goal with Hheap : heap ?st = ?base ++ ?added |- _ =>
   exists added; split; [reflexivity|exact Hheap] end.
Qed.
Print Assumptions context_frame_from_classification.
Lemma fresh_appended_index : forall (hp added : list Object) index,
 (index < length added)%nat ->
 nth_error hp (length hp+index) = None /\
 exists value, nth_error (hp++added) (length hp+index) = Some value.
Proof.
 intros hp added index Hindex. split.
 - apply nth_error_None. lia.
 - rewrite nth_error_heap_suffix.
   destruct (nth_error added index) eqn:E; [eauto|].
   apply nth_error_None in E. lia.
Qed.
Lemma fresh_index_not_caller_alias : forall (hp : list Object) old index,
 (old < length hp)%nat -> VRef old <> VRef (length hp+index).
Proof. intros hp old index Hbound Heq. inversion Heq. lia. Qed.
Lemma distinct_fresh_indices : forall (hp : list Object) first second,
 first <> second -> VRef (length hp+first) <> VRef (length hp+second).
Proof. intros hp first second Hneq Heq. inversion Heq. apply Hneq. lia. Qed.
Print Assumptions fresh_appended_index.
Print Assumptions fresh_index_not_caller_alias.
Print Assumptions distinct_fresh_indices.
Lemma context_observation_from_classification : forall hp tail static_values hash current_hash sf nf q r kind stored trace outcome,
 observe_context outcome = contextual_classified hp tail static_values hash current_hash sf nf q r kind stored trace ->
 observe outcome = classified hash sf nf q r kind stored trace.
Proof.
 intros hp tail static_values hash current_hash sf nf q r kind stored trace outcome H.
 pose proof (f_equal (option_map view_observation) H) as P.
 rewrite contextual_classified_projection in P.
 destruct outcome; cbn [observe_context option_map] in P; try discriminate.
 all: injection P as P; exact P.
Qed.
Print Assumptions context_observation_from_classification.
