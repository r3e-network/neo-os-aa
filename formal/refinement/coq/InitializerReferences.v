(* Post-instruction reference usage relative to the untouched caller.
   PACK moves n scalar items into a fresh array; its n children are still
   counted. CONVERT replaces a scalar by a buffer. Static fields initially
   contain VM null and are each assigned only scalar values or fresh arrays.
   No initializer instruction mutates an object originally in the caller. *)
From Coq Require Import List Bool PeanoNat Lia.
Import ListNotations.

Inductive action := InitSlots (n:nat) | Push | Pack (n:nat) | Store | Preserve.
Record usage := counts { slots:nat; stack:nat; children:nat }.
Definition total u := slots u + stack u + children u.
Definition step a u :=
  match a with
  | InitSlots n => counts n (stack u) (children u)
  | Push => counts (slots u) (S (stack u)) (children u)
  | Pack n => counts (slots u) (stack u - n) (children u + n)
  | Store => counts (slots u) (pred (stack u)) (children u)
  | Preserve => u
  end.

Fixpoint trace actions u :=
  match actions with
  | [] => []
  | a::rest => let v := step a u in total v :: trace rest v
  end.
Fixpoint fits base limit (ts : list nat) :=
  match ts with
  | [] => true
  | n::rest => (base+n <=? limit) && fits base limit rest
  end.
Theorem fit_iff_peak : forall ts base limit, base <= limit ->
  (fits base limit ts = true <-> base + fold_right Nat.max 0 ts <= limit).
Proof.
  induction ts as [|n rest IH]; intros base limit H; simpl.
  - lia.
  - rewrite Bool.andb_true_iff, Nat.leb_le, IH by assumption. lia.
Qed.

(* Characterizes the first fault, including a large jump on INITSSLOT. *)
Fixpoint completed base limit (ts : list nat) : nat :=
  match ts with
  | [] => 0
  | n::rest => if base+n <=? limit then S (completed base limit rest) else 0
  end.
Theorem first_overflow : forall prefix n tail base limit,
  fits base limit prefix = true -> limit < base+n ->
  completed base limit (prefix ++ n::tail) = length prefix.
Proof.
  induction prefix as [|v rest IH]; intros * F O; simpl in *.
  - destruct (_ <=? _) eqn:E; [apply Nat.leb_le in E; lia|reflexivity].
  - apply Bool.andb_true_iff in F as [V R]. rewrite V, IH by assumption. reflexivity.
Qed.
Print Assumptions fit_iff_peak.
Print Assumptions first_overflow.
