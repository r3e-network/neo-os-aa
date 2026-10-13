(* Actual NeoVM opcode bytes for a straight-line arithmetic region.
   Supported one-byte opcodes are decoded from bytes, not exporter names.
   None denotes rejection/FAULT in this Integer-typed subset (bad stack/index,
   unsupported typed operation/opcode or Integer overflow). Numeric coercions
   from non-Integer StackItems are not specified by this model.
   Array/Struct PICKITEM reads use the same index semantics. Heap mutation,
   instruction gas, and the Neo.VM implementation itself are outside this model. *)
From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import IntegerSemantics CapArithmetic.
Import ListNotations.
Open Scope Z_scope.

Inductive Value :=
| VInteger : Z -> Value
| VNull : Value
| VBoolean : bool -> Value
| VBytes : list nat -> Value
| VBuffer : list nat -> Value
| VPointer : nat -> Value
| VInterop : nat -> Value
| VArray : list Value -> Value
| VStruct : list Value -> Value
| VMap : list (Value * Value) -> Value.
Record Machine := mkMachine {
  pc : nat;
  stack : list Value;
  arguments : list Value;
  locals : list Value
}.
Inductive Opcode :=
| Push : Z -> Opcode
| LoadLocal : nat -> Opcode
| StoreLocal : nat -> Opcode
| LoadArgument : nat -> Opcode
| Binary : BinaryOp -> Opcode
| PickItem : Opcode.

Definition decode_opcode (byte : nat) : option Opcode :=
  if (16 <=? byte)%nat && (byte <=? 32)%nat then Some (Push (Z.of_nat (byte - 16)))
  else if (104 <=? byte)%nat && (byte <=? 110)%nat then Some (LoadLocal (byte - 104))
  else if (112 <=? byte)%nat && (byte <=? 118)%nat then Some (StoreLocal (byte - 112))
  else if (120 <=? byte)%nat && (byte <=? 126)%nat then Some (LoadArgument (byte - 120))
  else match byte with
       | 158%nat => Some (Binary Add) | 159%nat => Some (Binary Sub)
       | 160%nat => Some (Binary Mul) | 185%nat => Some (Binary Min)
       | 186%nat => Some (Binary Max) | 206%nat => Some PickItem
       | _ => None end.

Fixpoint replace_local (index : nat) (value : Value) (items : list Value) : option (list Value) :=
  match index, items with
  | O, _ :: rest => Some (value :: rest)
  | S n, head :: rest => option_bind (replace_local n value rest) (fun changed => Some (head :: changed))
  | _, _ => None end.
Definition advance (s : Machine) (new_stack new_locals : list Value) : Machine :=
  mkMachine (S (pc s)) new_stack (arguments s) new_locals.
Definition read_item (items : list Value) (index : Z) : option Value :=
  if index <? 0 then None else nth_error items (Z.to_nat index).
Definition vm_step (instruction : Opcode) (s : Machine) : option Machine :=
  match instruction with
  | Push z => option_bind (checked_integer z) (fun integer =>
      Some (advance s (VInteger integer :: stack s) (locals s)))
  | LoadLocal index => option_bind (nth_error (locals s) index) (fun value =>
      Some (advance s (value :: stack s) (locals s)))
  | LoadArgument index => option_bind (nth_error (arguments s) index) (fun value =>
      Some (advance s (value :: stack s) (locals s)))
  | StoreLocal index => match stack s with
      | [] => None
      | value :: rest => option_bind (replace_local index value (locals s))
          (fun changed => Some (advance s rest changed)) end
  | Binary operation => match stack s with
      | VInteger rhs :: VInteger lhs :: rest =>
          option_bind (checked_binary operation rhs lhs) (fun result =>
            Some (advance s (VInteger result :: rest) (locals s)))
      | _ => None end
  | PickItem => match stack s with
      | VInteger index :: VArray items :: rest
      | VInteger index :: VStruct items :: rest =>
          option_bind (read_item items index) (fun value =>
            Some (advance s (value :: rest) (locals s)))
      | _ => None end
  end.
Definition step_byte (byte : nat) (s : Machine) : option Machine :=
  option_bind (decode_opcode byte) (fun op => vm_step op s).
Fixpoint run_bytes (bytes : list nat) (s : Machine) : option Machine :=
  match bytes with [] => Some s
  | byte :: rest => option_bind (step_byte byte s) (run_bytes rest) end.

Inductive Input := Cost | Requested | Reserved.
Inductive Expression :=
| Constant : Z -> Expression
| Read : Input -> Expression
| Apply : BinaryOp -> Expression -> Expression -> Expression.
Fixpoint source_eval (expr : Expression) (cost requested reserved : Z) : Z :=
  match expr with
  | Constant z => z
  | Read Cost => cost | Read Requested => requested | Read Reserved => reserved
  | Apply op lhs rhs => binary_value op
      (source_eval lhs cost requested reserved) (source_eval rhs cost requested reserved)
  end.

Definition initial_machine (start : nat) (cost requested reserved : Z)
    (hash data old_flag old_cap old_settled : Value) (struct_record : bool) : Machine :=
  mkMachine start [] [VInteger requested]
    [hash; data; (if struct_record then VStruct else VArray) [hash; VInteger reserved];
     VInteger cost; old_flag; old_cap; old_settled].
Definition observed_result (result : option Machine) : option (nat * list Value * Value) :=
  option_bind result (fun final => option_bind (nth_error (locals final) 6)
    (fun settled => Some (pc final, stack final, settled))).
Definition preserves_expression (program : list nat) (expr : Expression) : Prop :=
  forall start cost requested reserved hash data old_flag old_cap old_settled is_struct,
  cap_domain cost requested reserved ->
  let before := initial_machine start cost requested reserved hash data old_flag old_cap old_settled is_struct in
  match run_bytes program before with
  | None => False
  | Some final =>
      observed_result (Some final) =
        Some ((start + length program)%nat, [], VInteger (source_eval expr cost requested reserved)) /\
      arguments final = arguments before /\
      firstn 4 (locals final) = firstn 4 (locals before) /\
      length (locals final) = 7%nat
  end.

(* A certificate includes a proof of universal semantics, not an asserted
   "equivalent" Boolean supplied by a Python/Roslyn/SMT generator. *)
Record Certificate (expr : Expression) := mkCertificate {
  certified_program : list nat;
  certified_semantics : preserves_expression certified_program expr
}.
Fixpoint bytes_equal (left right : list nat) : bool :=
  match left, right with
  | [], [] => true
  | x :: xs, y :: ys => Nat.eqb x y && bytes_equal xs ys
  | _, _ => false end.
Definition check_certificate (expr : Expression) (bytes : list nat) (certificate : Certificate expr) : bool :=
  bytes_equal bytes (certified_program expr certificate).
