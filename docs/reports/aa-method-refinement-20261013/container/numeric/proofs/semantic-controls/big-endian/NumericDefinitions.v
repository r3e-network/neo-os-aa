(* NeoVM 3.10.1 numeric entry reference semantics. This is not a theorem about
   Neo.VM.dll or System.Numerics.BigInteger. Arithmetic GetInteger and explicit
   CONVERT Integer are distinct: Buffer rejects the former; Null is preserved
   by the latter. No dependency on ArithmeticVm, so future composition is acyclic. *)
From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import IntegerSemantics.
Import ListNotations.
Open Scope Z_scope.

Fixpoint pow256 (n : nat) : Z :=
  match n with O => 1 | S rest => 256 * pow256 rest end.
Fixpoint unsigned_le (bytes : list nat) : Z :=
  match bytes with [] => 0 | b :: rest => Z.of_nat b + 256 * unsigned_le rest end.
Fixpoint signed_le (bytes : list nat) : Z :=
  match bytes with
  | [] => 0
  | b :: rest => match rest with
    | [] => Z.of_nat b - (if (128 <=? b)%nat then 256 else 0)
    | _ :: _ => 256 * Z.of_nat b + signed_le rest
    end
  end.
Definition valid_bytes (bytes : list nat) : Prop := Forall (fun b => (b < 256)%nat) bytes.
Definition valid_bytesb (bytes : list nat) : bool := forallb (fun b => (b <? 256)%nat) bytes.
Definition byte_string_integer (bytes : list nat) : option Z :=
  if (length bytes <=? 32)%nat && valid_bytesb bytes then Some (signed_le bytes) else None.
Definition extension_byte (bytes : list nat) : nat := if (128 <=? last bytes 0)%nat then 255 else 0.

Inductive UnsupportedType := ArrayTag | StructTag | MapTag | PointerTag | InteropTag.
Inductive NumericValue :=
| NInteger : Z -> NumericValue
| NBoolean : bool -> NumericValue
| NByteString : list nat -> NumericValue
| NBuffer : list nat -> NumericValue
| NNull : NumericValue
| NUnsupported : UnsupportedType -> NumericValue.
Definition get_integer (value : NumericValue) : option Z :=
  match value with
  | NInteger z => checked_integer z
  | NBoolean b => Some (if b then 1 else 0)
  | NByteString bytes => byte_string_integer bytes
  | NBuffer _ => None
  | NNull => None
  | NUnsupported _ => None
  end.
Definition convert_integer (value : NumericValue) : option NumericValue :=
  match value with
  | NNull => Some NNull
  | NBuffer bytes => option_map NInteger (byte_string_integer bytes)
  | _ => option_map NInteger (get_integer value)
  end.
Definition numeric_refines (value : NumericValue) (source_bigint : Z) : Prop :=
  get_integer value = Some source_bigint.

