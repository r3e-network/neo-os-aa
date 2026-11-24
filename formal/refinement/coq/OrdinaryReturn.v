(* Projection of normal RET to evaluation stacks, listed top first.
   Stack items are opaque: CopyTo transfers the existing items, not clones.
   Commit, reference bookkeeping, diagnostics and task callbacks must finish
   without interfering with these stacks. No exceptional unwind is modeled. *)
From Coq Require Import List PeanoNat.
Import ListNotations.
Section Return.
Context {A : Type}.

Definition copy_return (shared : bool) (rv : option nat) (src dst : list A) :=
  if shared then Some src else
  if match rv with Some n => Nat.eqb (length src) n | None => true end
  then Some (src ++ dst) else None.

Definition unload_dynamic (null : A) (src dst : list A) :=
  match src with [] => Some (null :: dst) | [_] => Some dst | _ => None end.

Definition ordinary_dynamic_return null rv (src dst : list A) :=
  match copy_return false rv src dst with
  | Some out => unload_dynamic null src out | None => None end.

Theorem initializer_shares_stack : forall args : list A,
  copy_return true (Some 0) args args = Some args.
Proof. reflexivity. Qed.
Theorem nonvoid_caller : forall null value (tail : list A),
  ordinary_dynamic_return null (Some 1) [value] tail = Some (value :: tail).
Proof. reflexivity. Qed.
Theorem void_caller : forall null (tail : list A),
  ordinary_dynamic_return null (Some 0) [] tail = Some (null :: tail).
Proof. reflexivity. Qed.
Theorem wrong_return_count : forall null rv (src tail : list A),
  length src <> rv -> ordinary_dynamic_return null (Some rv) src tail = None.
Proof. intros * H. apply Nat.eqb_neq in H. unfold ordinary_dynamic_return, copy_return.
  now rewrite H. Qed.
Theorem unbounded_multiple : forall null (a b : A) rest tail,
  ordinary_dynamic_return null None (a :: b :: rest) tail = None.
Proof. reflexivity. Qed.
End Return.
