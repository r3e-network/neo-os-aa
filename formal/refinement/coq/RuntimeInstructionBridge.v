(* Source-action evaluator for an explicitly delimited C# handler language.
   Programs are emitted from captured runtime C# bodies by a trusted parser.
   This evaluator does not invoke CapMethodVm.vm_step. Engine primitive/API
   representations, scheduling, resources and compiled-DLL correspondence
   remain external. Fault observations erase the partially consumed stack. *)
From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import IntegerSemantics NumericCoercions CapMethodVm.
Import ListNotations.
Open Scope Z_scope.

Inductive SlotKind := LocalSlot | ArgumentSlot | StaticSlot.
Inductive Atom := AVM : Value -> Atom | AInt : Z -> Atom | ABool : bool -> Atom
| AStack | ASlot : SlotKind -> Atom.
Inductive Operator := OAdd | OSub | OMul | OMin | OMax
| OLess | OGreater | OLessEqual | OGreaterEqual | OEqual | ONotEqual | OOr | OAnd.
Inductive Expression :=
| ConstantInt : Z -> Expression | ConstantBool : bool -> Expression
| EVariable : nat -> Expression | PopValue : Expression | PeekValue : Expression -> Expression
| GetInteger : Expression -> Expression | GetBoolean : Expression -> Expression
| Apply : Operator -> Expression -> Expression -> Expression
| Negate : Expression -> Expression | Not : Expression -> Expression
| IsNull : Expression -> Expression | StackReference : Expression | StackCount : Expression
| SlotReference : SlotKind -> Expression | SlotCount : Expression -> Expression
| SlotIsNull : Expression -> Expression | SlotRead : Expression -> Expression -> Expression
| CurrentPc | ScriptLength | OperandUnsigned | OperandSigned
| CheckedInt32 : Expression -> Expression.
Inductive Action :=
| Declare : nat -> Expression -> Action | Ignore : Expression -> Action
| PushValue : Expression -> Action
| SwapValues : Expression -> Expression -> Action
| InsertValue : Expression -> Expression -> Action
| SetSlot : Expression -> Expression -> Expression -> Action
| SetPc : Expression -> Action | SetJumping : Expression -> Action
| IfThenElse : Expression -> list Action -> list Action -> Action | Raise : Action.

Record RawFrame := raw_frame {
  raw_stack : list Value; raw_locals : list Value; raw_arguments : list Value;
  raw_statics : nat -> option Value; raw_static_count : nat;
  raw_pc : Z; raw_script_length : nat; raw_unsigned : nat; raw_signed : Z;
  raw_jumping : bool; raw_environment : list (nat * Atom)
}.
Definition replace_stack f st := raw_frame st (raw_locals f) (raw_arguments f)
  (raw_statics f) (raw_static_count f) (raw_pc f) (raw_script_length f)
  (raw_unsigned f) (raw_signed f) (raw_jumping f) (raw_environment f).
Definition replace_environment f environment := raw_frame (raw_stack f) (raw_locals f)
  (raw_arguments f) (raw_statics f) (raw_static_count f) (raw_pc f) (raw_script_length f)
  (raw_unsigned f) (raw_signed f) (raw_jumping f) environment.
Definition replace_position f position jumping := raw_frame (raw_stack f) (raw_locals f)
  (raw_arguments f) (raw_statics f) (raw_static_count f) position (raw_script_length f)
  (raw_unsigned f) (raw_signed f) jumping (raw_environment f).
Definition replace_slot f kind values :=
  match kind with
  | LocalSlot => raw_frame (raw_stack f) values (raw_arguments f) (raw_statics f)
      (raw_static_count f) (raw_pc f) (raw_script_length f) (raw_unsigned f) (raw_signed f)
      (raw_jumping f) (raw_environment f)
  | ArgumentSlot => raw_frame (raw_stack f) (raw_locals f) values (raw_statics f)
      (raw_static_count f) (raw_pc f) (raw_script_length f) (raw_unsigned f) (raw_signed f)
      (raw_jumping f) (raw_environment f)
  | StaticSlot => f
  end.
Definition slot_count f kind := match kind with
  | LocalSlot => length (raw_locals f) | ArgumentSlot => length (raw_arguments f)
  | StaticSlot => raw_static_count f end.
Definition slot_read f kind index := match kind with
  | LocalSlot => nth_error (raw_locals f) index | ArgumentSlot => nth_error (raw_arguments f) index
  | StaticSlot => (raw_statics f) index end.
Fixpoint lookup (index : nat) (environment : list (nat * Atom)) : option Atom := match environment with
  | [] => None | (name,value)::rest => if Nat.eqb index name then Some value else lookup index rest end.
Fixpoint update_at (index : nat) (value : Value) (values : list Value) : option (list Value) := match index,values with
  | O,_::rest => Some (value::rest)
  | S n,head::rest => option_map (fun changed => head::changed) (update_at n value rest)
  | _,_ => None end.
Fixpoint insert_at (index : nat) (value : Value) (values : list Value) : option (list Value) := match index,values with
  | O,_ => Some (value::values)
  | S n,head::rest => option_map (fun changed => head::changed) (insert_at n value rest)
  | _,_ => None end.
Definition numeric_projection value := match value with
  | VInt z => NInteger z | VBool b => NBoolean b | VBytes bytes => NByteString bytes
  | VBuffer bytes => NBuffer bytes | VNull => NNull | _ => NUnsupported InteropTag end.
Definition boolean_projection value := match value with
  | VBool b => Some b | VInt z => Some (negb (Z.eqb z 0)) | VNull => Some false
  | VBuffer _ | VRef _ => Some true | _ => None end.
Definition bind {A B} (item : option A) (next : A -> option B) := match item with
  | Some value => next value | None => None end.
Definition integer_atom value := match value with AInt z => Some z | _ => None end.
Definition bool_atom value := match value with ABool b => Some b | _ => None end.
Definition vm_atom value := match value with
  | AVM v => Some v | AInt z => option_map VInt (checked_integer z)
  | ABool b => Some (VBool b) | _ => None end.
Definition apply_operator op lhs_value rhs_value := match op,lhs_value,rhs_value with
  | OAdd,AInt a,AInt b => Some (AInt (a+b)) | OSub,AInt a,AInt b => Some (AInt (a-b))
  | OMul,AInt a,AInt b => Some (AInt (a*b)) | OMin,AInt a,AInt b => Some (AInt (Z.min a b))
  | OMax,AInt a,AInt b => Some (AInt (Z.max a b))
  | OLess,AInt a,AInt b => Some (ABool (a <? b)) | OGreater,AInt a,AInt b => Some (ABool (b <? a))
  | OLessEqual,AInt a,AInt b => Some (ABool (a <=? b)) | OGreaterEqual,AInt a,AInt b => Some (ABool (b <=? a))
  | OEqual,AInt a,AInt b => Some (ABool (Z.eqb a b)) | ONotEqual,AInt a,AInt b => Some (ABool (negb (Z.eqb a b)))
  | OOr,ABool a,ABool b => Some (ABool (a || b)) | OAnd,ABool a,ABool b => Some (ABool (a && b))
  | _,_,_ => None end.

Fixpoint evaluate expression frame : option (Atom * RawFrame) :=
  match expression with
  | ConstantInt z => Some (AInt z,frame) | ConstantBool b => Some (ABool b,frame)
  | EVariable index => option_map (fun value => (value,frame)) (lookup index (raw_environment frame))
  | PopValue => match raw_stack frame with [] => None | value::rest => Some (AVM value,replace_stack frame rest) end
  | PeekValue index => bind (evaluate index frame) (fun '(value,after) =>
      bind (integer_atom value) (fun i => if 0 <=? i then
      option_map (fun item => (AVM item,after)) (nth_error (raw_stack after) (Z.to_nat i)) else None))
  | GetInteger expression => bind (evaluate expression frame) (fun '(value,after) =>
      match value with AVM item => option_map (fun z => (AInt z,after)) (get_integer (numeric_projection item)) | _ => None end)
  | GetBoolean expression => bind (evaluate expression frame) (fun '(value,after) =>
      match value with AVM item => option_map (fun b => (ABool b,after)) (boolean_projection item) | _ => None end)
  | Apply op lhs rhs => bind (evaluate lhs frame) (fun '(lhs_value,after_left) =>
      match op,lhs_value with
      | OOr,ABool true => Some (ABool true,after_left)
      | OAnd,ABool false => Some (ABool false,after_left)
      | _,_ => bind (evaluate rhs after_left) (fun '(rhs_value,after_right) =>
          option_map (fun value => (value,after_right)) (apply_operator op lhs_value rhs_value)) end)
  | Negate expression => bind (evaluate expression frame) (fun '(value,after) =>
      option_map (fun z => (AInt (-z),after)) (integer_atom value))
  | Not expression => bind (evaluate expression frame) (fun '(value,after) =>
      option_map (fun b => (ABool (negb b),after)) (bool_atom value))
  | IsNull expression => bind (evaluate expression frame) (fun '(value,after) =>
      match value with AVM item => Some (ABool (match item with VNull => true | _ => false end),after) | _ => None end)
  | StackReference => Some (AStack,frame)
  | StackCount => Some (AInt (Z.of_nat (length (raw_stack frame))),frame)
  | SlotReference kind => Some (ASlot kind,frame)
  | SlotCount expression => bind (evaluate expression frame) (fun '(value,after) =>
      match value with ASlot kind => Some (AInt (Z.of_nat (slot_count after kind)),after) | _ => None end)
  | SlotIsNull expression => bind (evaluate expression frame) (fun '(value,after) =>
      match value with ASlot _ => Some (ABool false,after) | _ => None end)
  | SlotRead expression index => bind (evaluate expression frame) (fun '(slot,after_slot) =>
      bind (evaluate index after_slot) (fun '(value,after_index) => match slot,value with
      | ASlot kind,AInt i => if 0 <=? i then option_map (fun value => (AVM value,after_index))
          (slot_read after_index kind (Z.to_nat i)) else None | _,_ => None end))
  | CurrentPc => Some (AInt (raw_pc frame),frame)
  | ScriptLength => Some (AInt (Z.of_nat (raw_script_length frame)),frame)
  | OperandUnsigned => Some (AInt (Z.of_nat (raw_unsigned frame)),frame)
  | OperandSigned => Some (AInt (raw_signed frame),frame)
  | CheckedInt32 expression => bind (evaluate expression frame) (fun '(value,after) =>
      bind (integer_atom value) (fun z => if (-2^31 <=? z) && (z <? 2^31) then Some (AInt z,after) else None))
  end.

Fixpoint execute fuel actions frame : option RawFrame :=
  match fuel with O => None | S n =>
  match actions with [] => Some frame | action::rest =>
    let result := match action with
    | Declare index expression => bind (evaluate expression frame) (fun '(value,after) =>
        Some (replace_environment after ((index,value)::raw_environment after)))
    | Ignore expression => option_map snd (evaluate expression frame)
    | PushValue expression => bind (evaluate expression frame) (fun '(value,after) =>
        option_map (fun item => replace_stack after (item::raw_stack after)) (vm_atom value))
    | SwapValues first second => bind (evaluate first frame) (fun '(x,after_x) =>
        bind (evaluate second after_x) (fun '(y,after_y) => match x,y with
        | AInt i,AInt j => if (0 <=? i) && (0 <=? j) then
          bind (nth_error (raw_stack after_y) (Z.to_nat i)) (fun a =>
          bind (nth_error (raw_stack after_y) (Z.to_nat j)) (fun b =>
          bind (update_at (Z.to_nat i) b (raw_stack after_y)) (fun swapped =>
            option_map (replace_stack after_y) (update_at (Z.to_nat j) a swapped)))) else None
        | _,_ => None end))
    | InsertValue index expression => bind (evaluate index frame) (fun '(i,after_i) =>
        bind (evaluate expression after_i) (fun '(item,after_item) => match i,item with
        | AInt z,AVM value => if 0 <=? z then option_map (replace_stack after_item)
          (insert_at (Z.to_nat z) value (raw_stack after_item)) else None | _,_ => None end))
    | SetSlot slot index expression => bind (evaluate slot frame) (fun '(which,after_slot) =>
        bind (evaluate index after_slot) (fun '(i,after_index) => bind (evaluate expression after_index) (fun '(value,after_value) =>
        match which,i,value with ASlot kind,AInt z,AVM item => if 0 <=? z then
          match kind with LocalSlot => option_map (replace_slot after_value kind) (update_at (Z.to_nat z) item (raw_locals after_value))
          | ArgumentSlot => option_map (replace_slot after_value kind) (update_at (Z.to_nat z) item (raw_arguments after_value))
          | StaticSlot => None end else None | _,_,_ => None end)))
    | SetPc expression => bind (evaluate expression frame) (fun '(value,after) =>
        option_map (fun z => replace_position after z (raw_jumping after)) (integer_atom value))
    | SetJumping expression => bind (evaluate expression frame) (fun '(value,after) =>
        option_map (fun b => replace_position after (raw_pc after) b) (bool_atom value))
    | IfThenElse condition yes no => bind (evaluate condition frame) (fun '(value,after) =>
        bind (bool_atom value) (fun b => execute n (if b then yes else no) after))
    | Raise => None end in bind result (execute n rest)
  end end.

Definition initial_frame (s : State) operand script_length static_count :=
  raw_frame (stack s) (locals s) (arguments s) (statics s) static_count (Z.of_nat (pc s))
    script_length operand (signed_byte operand) false [].
Definition project_success s width frame :=
  change s (if raw_jumping frame then Z.to_nat (raw_pc frame) else (pc s + width)%nat)
    (raw_stack frame) (raw_arguments frame) (raw_locals frame) (heap s) (storage s) (effects s).
Definition source_step actions width s operand script_length static_count :=
  option_map (project_success s width) (execute 8 actions (initial_frame s operand script_length static_count)).
Definition instruction_observation outcome := match outcome with Continue next => Some next | _ => None end.

Lemma update_at_as_indexed_assignment : forall index values value,
  (index < length values)%nat -> update_at index value values =
    Some (firstn index values ++ value::skipn (S index) values).
Proof. induction index as [|i IH]; intros [|head rest] value H; simpl in *; try lia;
  [reflexivity|]. rewrite IH by lia. reflexivity. Qed.
Lemma native_integer_read : forall z, integer_fits z -> get_integer (numeric_projection (VInt z)) = Some z.
Proof. intros z H. apply checked_integer_in_range. exact H. Qed.

Print Assumptions update_at_as_indexed_assignment.
Print Assumptions native_integer_read.
