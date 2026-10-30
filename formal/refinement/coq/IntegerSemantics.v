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
  if integer_fitsb z then Some z else None.
Inductive BinaryOp := Add | Sub | Mul | Shl | Min | Max.
Definition binary_value (op : BinaryOp) (left right : Z) : Z :=
  match op with
  | Add => left + right | Sub => left - right | Mul => left * right
  (* The shift count is a mathematical exponent here; the VM checks the result
     for representability like every other arithmetic instruction. *)
  | Shl => left * 2 ^ right
  | Min => Z.min left right | Max => Z.max left right
  end.
Definition checked_binary (op : BinaryOp) (left right : Z) : option Z :=
  checked_integer (binary_value op left right).

Lemma integer_limit_positive : 1 < integer_limit.
Proof. unfold integer_limit. lia. Qed.
Lemma integer_fitsb_spec : forall z, integer_fitsb z = true <-> integer_fits z.
Proof. intros. unfold integer_fitsb, integer_fits.
  rewrite andb_true_iff, Z.leb_le, Z.ltb_lt. reflexivity. Qed.
Lemma checked_integer_in_range : forall z,
  integer_fits z -> checked_integer z = Some z.
Proof. intros z H. unfold checked_integer.
  apply integer_fitsb_spec in H. rewrite H. reflexivity. Qed.
Theorem checked_integer_result_is_representable : forall z result,
  checked_integer z = Some result -> result = z /\ integer_fits result.
Proof. intros z result H. unfold checked_integer in H.
  destruct (integer_fitsb z) eqn:E; [|discriminate].
  injection H as Hr. subst result. split; [reflexivity|].
  apply integer_fitsb_spec. exact E. Qed.
Theorem integer_overflow_faults : forall z,
  ~ integer_fits z -> checked_integer z = None.
Proof. intros z H. unfold checked_integer.
  destruct (integer_fitsb z) eqn:E; [|reflexivity].
  apply integer_fitsb_spec in E. contradiction. Qed.
Example signed_maximum_addition_faults :
  checked_binary Add (integer_limit - 1) 1 = None.
Proof. unfold checked_binary, binary_value.
  apply integer_overflow_faults. unfold integer_fits. lia. Qed.
Example signed_minimum_subtraction_faults :
  checked_binary Sub (-integer_limit) 1 = None.
Proof. unfold checked_binary, binary_value.
  apply integer_overflow_faults. unfold integer_fits. lia. Qed.

Print Assumptions integer_limit_positive.
Print Assumptions integer_fitsb_spec.
Print Assumptions checked_integer_in_range.
Print Assumptions checked_integer_result_is_representable.
Print Assumptions integer_overflow_faults.
Print Assumptions signed_maximum_addition_faults.
Print Assumptions signed_minimum_subtraction_faults.
