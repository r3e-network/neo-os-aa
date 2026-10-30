(* Storage-key getter source semantics over an abstract contract storage map.
   Bytecode-level execution of these getters is modeled in StorageGetterVm and
   connected to this source-level outcome by the lane certificate; framework
   cast semantics (little-endian BigInteger, 20-byte UInt160) remain pinned
   contracts, and the ApplicationEngine layer stays an open obligation.
   getter_outcome reads one key; fallback_outcome reads the active key and
   falls back to the historical key, which is what the legacy-compatibility
   getters (the escrow owner-cancel readers and getVerifyScopeTarget) do. *)
From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import IntegerSemantics.
Import ListNotations.
Open Scope Z_scope.

Definition bytes := list nat.
Definition storage := bytes -> option bytes.

Definition valid_bytes (b : bytes) := forallb (fun n => (n <=? 255)%nat) b.

Inductive GVal :=
| GBytes : bytes -> GVal
| GInt : Z -> GVal
| GBool : bool -> GVal
| GArray : list GVal -> GVal
| GNull : GVal.

Inductive Outcome :=
| OK : GVal -> Outcome
| Fault : Outcome.

(* NeoVM (BigInteger) cast on storage payload: little-endian two's complement.
   The empty payload decodes to zero, matching the framework contract. *)
Fixpoint le_accum (acc : Z) (b : bytes) : Z :=
  match b with
  | [] => acc
  | n :: rest => le_accum (acc + Z.of_nat n * 256 ^ Z.of_nat (length rest)) rest
  end.

Definition decode_integer (b : bytes) : Outcome :=
  if valid_bytes b then
    match b with
    | [] => OK (GInt 0)
    | _ => let magnitude := le_accum 0 b in
           let width := 256 ^ Z.of_nat (length b) in
           let signed := if width / 2 <=? magnitude
                         then magnitude - width else magnitude in
           OK (GInt signed)
    end
  else Fault.

(* NeoVM (UInt160) cast: exactly 20 valid payload bytes. *)
Definition decode_hash160 (b : bytes) : Outcome :=
  if valid_bytes b && (length b =? 20)%nat then OK (GBytes b) else Fault.

Definition getter_outcome
           (pfx : bytes) (default : GVal) (decode : bytes -> Outcome)
           (sto : storage) (account : bytes) : Outcome :=
  match sto (pfx ++ account) with
  | None => OK default
  | Some payload => match decode payload with
                    | OK value => OK value
                    | Fault => Fault
                    end
  end.

Definition zeros (n : nat) : bytes := repeat 0%nat n.

Definition hash160_default : bytes := zeros 20.

(* Legacy-compatibility read: the active key is authoritative and the legacy
   key is consulted only when the active key is unbound. The read order is
   part of the pinned contract, not an implementation detail: the getters
   below all prefer the active prefix and fall back to the historical one. *)
Definition read_fallback (active legacy : bytes) (sto : storage) (account : bytes)
  : option bytes :=
  match sto (active ++ account) with
  | Some payload => Some payload
  | None => sto (legacy ++ account)
  end.

(* The fallback twin of getter_outcome, for a single scalar projection. *)
Definition fallback_outcome
           (active legacy : bytes) (default : GVal) (decode : bytes -> Outcome)
           (sto : storage) (account : bytes) : Outcome :=
  match read_fallback active legacy sto account with
  | None => OK default
  | Some payload => decode payload
  end.
