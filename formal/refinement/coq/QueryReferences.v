(* Root accounting for queries with scalar inputs and results, whose instructions
   do not allocate compound values. The caller has a separate frame and static
   slot context. INITSLOT transfers an input root into an argument slot. RET
   retires the fresh slots/arguments and transfers exactly one result root. *)
From Coq Require Import List PeanoNat.
Require Import CapMethodVm PublicPureMethods.
Import ListNotations.

Definition roots (s : State) := length (stack s) + length (arguments s) + length (locals s).
Fixpoint checked_counts fuel code fixed arity s : list nat :=
  match fuel with
  | O => []
  | S k =>
    match decode_public code (pc s) with
    | Some (op,w) =>
      match step_public op w s with
      | Continue next => (fixed + roots next - arity) :: checked_counts k code fixed arity next
      | Halt _ _ => [1 - arity]
      | _ => [] (* an instruction which throws does not complete its post-check *)
      end
    | None => [] end
  end.
Lemma counts_unroll : forall k c f a s, checked_counts (S k) c f a s =
  match decode_public c (pc s) with
  | Some (op,w) => match step_public op w s with
      | Continue next => (f + roots next - a) :: checked_counts k c f a next
      | Halt _ _ => [1-a] | _ => [] end
  | None => [] end.
Proof. reflexivity. Qed.

Lemma peak_app : forall xs ys : list nat,
  fold_right Nat.max 0 (xs ++ ys) = Nat.max (fold_right Nat.max 0 xs) (fold_right Nat.max 0 ys).
Proof. induction xs; intros; simpl; [reflexivity | now rewrite IHxs, Nat.max_assoc]. Qed.
