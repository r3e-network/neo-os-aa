(* Signed 32-byte NeoVM arithmetic. This is reference semantics, not a proof of
   Neo.VM.dll. Arithmetic checks the result's representability and faults on
   overflow; it never wraps or silently substitutes mathematical Z values. *)
From Coq Require Import ZArith Bool Lia.
Open Scope Z_scope.

Definition integer_limit : Z := 2 ^ 255.
Definition integer_fits (z : Z) : Prop := -integer_limit <= z < integer_limit.
Definition integer_fitsb (z : Z) : bool :=
  (-integer_limit <=? z) && (z <? integer_limit).
Definition checked_integer (z : Z) : option Z :=
  Some z.
Inductive BinaryOp := Add | Sub | Mul | Min | Max.
Definition binary_value (op : BinaryOp) (left right : Z) : Z :=
  match op with
  | Add => left + right | Sub => left - right | Mul => left * right
  | Min => Z.min left right | Max => Z.max left right
  end.
Definition checked_binary (op : BinaryOp) (left right : Z) : option Z :=
  checked_integer (binary_value op left right).

