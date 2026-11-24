(* Method-local fee semantics for the pinned pure discovery branches only. *)
From Coq Require Import List NArith String Bool.
Import ListNotations.
Inductive op := Start | Arg | Lit (s:string) | Eqv | Yes | BrFalse (dst:nat)
  | Go (dst:nat) | Return.
Inductive item := Input | Text (s:string) | Bit (b:bool).
Inductive exit := Returned (v:item) | Oversize | Invalid.

Fixpoint walk_acc {A:Type} (charge:A->N->A) (fuel pc:nat) (code:list (op*N)) (st:list item)
  (large:bool) (equal:string->bool) (paid:A) : exit * A :=
  match fuel with O => (Invalid,paid) | S fuel' =>
  match nth_error code pc with None => (Invalid,paid) | Some (instruction,price) =>
    let used := charge paid price in
    let next := fun st => walk_acc charge fuel' (S pc) code st large equal used in
    match instruction, st with
    | Start, [] => next []
    | Arg, _ => next (Input::st)
    | Lit s, _ => next (Text s::st)
    | Eqv, Text s :: Input :: rest => if large then (Oversize,used)
        else next (Bit (equal s)::rest)
    | Yes, _ => next (Bit true::st)
    | BrFalse dest, Bit b::rest => walk_acc charge fuel' (if b then S pc else dest) code rest large equal used
    | Go dest, _ => walk_acc charge fuel' dest code st large equal used
    | Return, [v] => (Returned v,used)
    | _, _ => (Invalid,used) end
  end end.

Definition walk := @walk_acc N N.add.
Definition trace := @walk_acc (list N) (fun ws w => List.app ws [w]).
