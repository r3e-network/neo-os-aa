From Coq Require Import List NArith String.
Import ListNotations.

Inductive symbol := Text (s:string) | ToItem | MakeSingleton | MakeArray.
Inductive value := Str (s:string) | I4 (n:nat) | Item (n:nat) | Singleton (n:nat) | Array1 (n:nat).
Definition tok (a b c d:nat) :=
  (N.of_nat a + 256 * (N.of_nat b + 256 * (N.of_nat c + 256 * N.of_nat d)))%N.

(* The VM conversion and the two constructors are explicit library contracts.
   Successful allocations only. Unknown instructions, tokens and stacks reject. *)
Fixpoint eval (fuel:nat) (resolve:N -> option symbol) (code:list nat) (st:list value)
  : option value :=
  match fuel,code with
  | S _, [42] => match st with [x] => Some x | _ => None end
  | S k, op::tail =>
    if andb (Nat.leb 22 op) (Nat.leb op 30) then eval k resolve tail (I4 (op-22)::st)
    else match tail with
      | a::b::c::d::rest =>
        match op,resolve (tok a b c d),st with
        | 114, Some (Text s), _ => eval k resolve rest (Str s::st)
        | 40, Some ToItem, I4 n::xs => eval k resolve rest (Item n::xs)
        | 115, Some MakeSingleton, Item n::xs => eval k resolve rest (Singleton n::xs)
        | 115, Some MakeArray, Singleton n::xs => eval k resolve rest (Array1 n::xs)
        | _,_,_ => None end
      | _ => None end
  | _,_ => None end.
