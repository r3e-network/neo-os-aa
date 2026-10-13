(* Fault-aware reservation arithmetic, not a bytecode/heap/storage certificate.
   The suffix's guard and Integer addition are executable here. Protocol ledger
   functions are imported from the existing model. Array identity, SETITEM,
   serialization, storage and transaction rollback require separate semantics. *)
From Coq Require Import ZArith Bool List Lia.
Require Import IntegerSemantics CapArithmetic OrdinarySponsorship.
Import ListNotations.
Open Scope Z_scope.

Definition checked_update (reserved settled : Z) : option Z :=
  if 0 <=? settled then checked_binary Add reserved settled else None.
Definition checked_reservation (cost requested reserved : Z) : option Z :=
  checked_update reserved (OrdinarySponsorship.charge cost requested reserved).

(* A representability-aware lifting of the existing abstract protocol reserve.
   This projection is not a replacement for the actual helper's effect proof. *)
Definition bounded_reserve (tx : nat) (cost requested : Z) (before : Ledger) : option Ledger :=
  match OrdinarySponsorship.reserve tx cost requested before with
  | None => None
  | Some next => match checked_integer (ledger_spent next) with
      | None => None
      | Some bounded => Some (mkLedger tx bounded)
      end
  end.
Definition apply_bounded_reserve (tx : nat) (cost requested : Z) (before : Ledger) : Ledger :=
  match bounded_reserve tx cost requested before with Some next => next | None => before end.
Fixpoint bounded_reserve_many (tx : nat) (cost : Z) (requests : list Z) (before : Ledger) : option Ledger :=
  match requests with
  | [] => Some before
  | requested :: rest => match bounded_reserve tx cost requested before with
      | None => None
      | Some reserved => bounded_reserve_many tx cost rest reserved
      end
  end.

