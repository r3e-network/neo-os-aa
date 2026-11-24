(* Storage-key getter source semantics over an abstract contract storage map.
   Bytecode-level execution of these getters is modeled in StorageGetterVm and
   connected to this source-level outcome by the lane certificate; framework
   cast semantics (little-endian BigInteger, 20-byte UInt160) remain pinned
   contracts, and the ApplicationEngine layer stays an open obligation.
   getter_outcome reads one key, which is what every pinned getter does. *)
From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import IntegerSemantics.
Require NumericCoercions.
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
Definition decode_integer (b : bytes) : Outcome :=
  match NumericCoercions.byte_string_integer b with
  | Some n => OK (GInt n)
  | None => Fault
  end.

Theorem stored_integer_exact : forall b, NumericCoercions.valid_bytes b ->
  (length b <= 32)%nat -> decode_integer b = OK (GInt (NumericCoercions.signed_le b)).
Proof. intros. unfold decode_integer. now rewrite NumericCoercions.byte_string_integer_accepts. Qed.
Theorem stored_integer_oversized : forall b,
  (32 < length b)%nat -> decode_integer b = Fault.
Proof. intros. unfold decode_integer. now rewrite NumericCoercions.oversized_byte_string_rejected. Qed.
Print Assumptions stored_integer_exact.
Print Assumptions stored_integer_oversized.

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
