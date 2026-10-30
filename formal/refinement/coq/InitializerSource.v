(* Pure typed source initializer semantics. No target bytes or desired static
   output appear in this interpreter. Source member-to-slot binding is external. *)
From Coq Require Import ZArith List Bool Lia.
Require Import IntegerSemantics CapMethodVm.
Import ListNotations.
Open Scope Z_scope.

Inductive SourceIntegerExpression := SourceNumber : Z -> SourceIntegerExpression
  | SourcePrimitive : Z -> BinaryOp -> SourceIntegerExpression -> SourceIntegerExpression -> SourceIntegerExpression.
Definition wrap_signed width value :=
  let half := 2 ^ (width-1) in (value + half) mod (2*half) - half.
Fixpoint source_integer expression : Z :=
  match expression with
  | SourceNumber value => value
  | SourcePrimitive width operator a b =>
      wrap_signed width (binary_value operator (source_integer a) (source_integer b))
  end.
Inductive SourceStaticExpression := SourceInteger : SourceIntegerExpression -> SourceStaticExpression
  | SourceBuffer : list SourceIntegerExpression -> SourceStaticExpression
  | SourceStrings : list (list nat) -> SourceStaticExpression.
Record SourceInitialization := source_initialization {
  source_heap : list Object; source_slots : list Value
}.
Fixpoint source_update_slot index value slots : option (list Value) :=
  match slots, index with
  | [], _ => None
  | _::rest, O => Some (value::rest)
  | head::rest, S next => match source_update_slot next value rest with
      | Some updated => Some (head::updated) | None => None end
  end.
Definition source_static expression hp : Value * list Object :=
  match expression with
  | SourceInteger value => (VInt (source_integer value), hp)
  | SourceBuffer bytes => (VBuffer (map (fun b => Z.to_nat (source_integer b)) bytes), hp)
  | SourceStrings strings =>
      (VRef (length hp), hp ++ [obj ArrayKind (map VBytes strings)])
  end.
Definition source_assignment (assignment : nat * SourceStaticExpression) state :=
  let '(index,expression) := assignment in
  let '(value,hp) := source_static expression (source_heap state) in
  match source_update_slot index value (source_slots state) with
  | Some slots => Some (source_initialization hp slots) | None => None end.
Fixpoint source_initialize assignments state :=
  match assignments with [] => Some state | assignment :: rest =>
    match source_assignment assignment state with
    | Some next => source_initialize rest next | None => None end end.
Definition source_entry count hp := source_initialization hp (repeat VNull count).

Theorem source_assignment_rejects_missing_slot : forall expression hp,
  source_assignment (0%nat,expression) (source_initialization hp []) = None.
Proof. intros expression hp. destruct expression; reflexivity. Qed.
Theorem source_slot_assignment_preserves_length : forall index value slots next,
  source_update_slot index value slots = Some next -> length next = length slots.
Proof. induction index; intros value slots next H; destruct slots; cbn in H; try discriminate.
  - inversion H. reflexivity.
  - destruct (source_update_slot index value slots) eqn:E; [|discriminate].
    inversion H; subst. cbn. f_equal. eapply IHindex. exact E. Qed.
Theorem source_strings_allocate_fresh : forall strings hp,
  fst (source_static (SourceStrings strings) hp) = VRef (length hp) /\
  nth_error hp (length hp) = None.
Proof. intros. split; [reflexivity|]. apply nth_error_None. lia. Qed.
