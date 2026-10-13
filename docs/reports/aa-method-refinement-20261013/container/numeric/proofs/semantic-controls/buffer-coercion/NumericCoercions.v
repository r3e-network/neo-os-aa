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
    | _ :: _ => Z.of_nat b + 256 * signed_le rest
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
  | NBuffer bytes => byte_string_integer bytes
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

Lemma pow256_positive : forall n, 0 < pow256 n.
Proof. induction n; [change (0 < 1); lia|]. change (0 < 256 * pow256 n). nia. Qed.
Lemma pow256_monotone : forall n m, (n <= m)%nat -> pow256 n <= pow256 m.
Proof. intros n m H. induction H; [lia|]. change (pow256 n <= 256 * pow256 m).
  pose proof (pow256_positive m). nia. Qed.
Lemma valid_bytesb_spec : forall bytes, valid_bytesb bytes = true <-> valid_bytes bytes.
Proof. intros bytes. unfold valid_bytesb, valid_bytes.
  rewrite forallb_forall, Forall_forall. split; intros H b Hb;
  specialize (H b Hb); [apply Nat.ltb_lt in H|apply Nat.ltb_lt]; exact H. Qed.
Lemma signed_le_unsigned_relation : forall bytes,
  signed_le bytes = unsigned_le bytes -
    (if (128 <=? last bytes 0)%nat then pow256 (length bytes) else 0).
Proof.
  induction bytes as [|b rest IH]; [reflexivity|].
  destruct rest as [|c tail]; [simpl; destruct (128 <=? b)%nat; lia|].
  change (Z.of_nat b + 256 * signed_le (c :: tail) =
    Z.of_nat b + 256 * unsigned_le (c :: tail) -
    (if (128 <=? last (c :: tail) 0)%nat then 256 * pow256 (length (c :: tail)) else 0)).
  rewrite IH. destruct (128 <=? last (c :: tail) 0)%nat; ring.
Qed.
Lemma signed_le_payload_range : forall bytes, valid_bytes bytes ->
  match bytes with
  | [] => signed_le bytes = 0
  | _ :: rest => -128 * pow256 (length rest) <= signed_le bytes < 128 * pow256 (length rest)
  end.
Proof.
  induction bytes as [|b rest IH]; intros H; [reflexivity|].
  inversion H as [|? ? Hb Hrest]; subst.
  pose proof (Nat2Z.is_nonneg b).
  assert (Hdigit : 0 <= Z.of_nat b <= 255) by lia.
  specialize (IH Hrest). destruct rest as [|c tail].
  - cbn [signed_le pow256 length]. destruct (128 <=? b)%nat eqn:E.
    + apply Nat.leb_le in E. lia.
    + apply Nat.leb_gt in E. lia.
  - cbn [signed_le pow256 length] in *. nia.
Qed.
Lemma maximum_payload_bound : 128 * pow256 31 = integer_limit.
Proof. reflexivity. Qed.
Theorem byte_string_integer_range : forall bytes z,
  byte_string_integer bytes = Some z -> integer_fits z.
Proof.
  intros bytes z H. unfold byte_string_integer in H.
  destruct ((length bytes <=? 32)%nat && valid_bytesb bytes) eqn:E; [|discriminate].
  injection H as Hz. subst z. apply andb_true_iff in E. destruct E as [Hlen Hvalid].
  apply Nat.leb_le in Hlen. apply valid_bytesb_spec in Hvalid.
  pose proof (signed_le_payload_range bytes Hvalid) as Hrange.
  unfold integer_fits. destruct bytes as [|b rest].
  - simpl. pose proof integer_limit_positive. lia.
  - assert (Hsmall : (length rest <= 31)%nat) by (simpl in Hlen; lia).
    pose proof (pow256_monotone _ _ Hsmall) as Hpow.
    rewrite <- maximum_payload_bound.
    change (-128 * pow256 (length rest) <= signed_le (b :: rest) < 128 * pow256 (length rest)) in Hrange.
    nia.
Qed.
Theorem byte_string_integer_accepts : forall bytes,
  valid_bytes bytes -> (length bytes <= 32)%nat -> byte_string_integer bytes = Some (signed_le bytes).
Proof. intros bytes Hvalid Hlen. unfold byte_string_integer.
  apply valid_bytesb_spec in Hvalid. apply Nat.leb_le in Hlen.
  rewrite Hvalid, Hlen. reflexivity. Qed.
Theorem oversized_byte_string_rejected : forall bytes,
  (32 < length bytes)%nat -> byte_string_integer bytes = None.
Proof. intros bytes H. unfold byte_string_integer.
  assert (E : (length bytes <=? 32)%nat = false) by (apply Nat.leb_gt; lia).
  rewrite E. reflexivity. Qed.
Theorem invalid_physical_byte_rejected : forall bytes,
  ~ valid_bytes bytes -> byte_string_integer bytes = None.
Proof. intros bytes H. unfold byte_string_integer.
  destruct (valid_bytesb bytes) eqn:E; [apply valid_bytesb_spec in E; contradiction|].
  rewrite andb_false_r. reflexivity. Qed.
Lemma unsigned_le_append : forall left right,
  unsigned_le (left ++ right) = unsigned_le left + pow256 (length left) * unsigned_le right.
Proof. induction left as [|b tail IH]; intros right.
  - change (unsigned_le right = 0 + 1 * unsigned_le right). ring.
  - change (Z.of_nat b + 256 * unsigned_le (tail ++ right) =
      Z.of_nat b + 256 * unsigned_le tail + (256 * pow256 (length tail)) * unsigned_le right).
    rewrite IH. ring.
Qed.
Lemma last_append_single : forall (bytes : list nat) (b : nat), last (bytes ++ [b]) 0%nat = b.
Proof. induction bytes as [|h tail IH]; intros b; [reflexivity|].
  destruct tail; simpl in *; [reflexivity|exact (IH b)]. Qed.
Theorem signed_le_sign_extension : forall bytes,
  bytes <> [] -> signed_le (bytes ++ [extension_byte bytes]) = signed_le bytes.
Proof.
  intros bytes Hnonempty. rewrite !signed_le_unsigned_relation.
  rewrite unsigned_le_append, last_append_single, app_length.
  unfold extension_byte. destruct (128 <=? last bytes 0)%nat eqn:E.
  - change (unsigned_le bytes + pow256 (length bytes) * 255 - pow256 (length bytes + 1) =
      unsigned_le bytes - pow256 (length bytes)).
    rewrite Nat.add_1_r.
    change (unsigned_le bytes + pow256 (length bytes) * 255 - 256 * pow256 (length bytes) =
      unsigned_le bytes - pow256 (length bytes)). ring.
  - change (unsigned_le bytes + pow256 (length bytes) * 0 - 0 = unsigned_le bytes - 0). ring.
Qed.
Theorem sign_extension_admitted_within_limit : forall bytes,
  bytes <> [] -> valid_bytes bytes -> (length bytes < 32)%nat ->
  byte_string_integer (bytes ++ [extension_byte bytes]) = byte_string_integer bytes.
Proof.
  intros bytes Hnonempty Hvalid Hlen.
  assert (Hex : valid_bytes [extension_byte bytes]).
  { unfold valid_bytes, extension_byte. destruct (128 <=? last bytes 0)%nat; repeat constructor; lia. }
  rewrite byte_string_integer_accepts.
  - rewrite signed_le_sign_extension by exact Hnonempty.
    symmetry. apply byte_string_integer_accepts; [exact Hvalid|lia].
  - unfold valid_bytes in *. apply Forall_app. split; assumption.
  - rewrite app_length. simpl. lia.
Qed.
Theorem get_integer_range : forall value z,
  get_integer value = Some z -> integer_fits z.
Proof.
  intros value z H. destruct value; simpl in H; try discriminate.
  - apply checked_integer_result_is_representable in H. tauto.
  - destruct b; injection H as Hz; subst z; unfold integer_fits;
      pose proof integer_limit_positive; lia.
  - eapply byte_string_integer_range. exact H.
Qed.
Theorem numeric_refines_integer : forall z,
  integer_fits z -> numeric_refines (NInteger z) z.
Proof. intros z H. unfold numeric_refines, get_integer. apply checked_integer_in_range. exact H. Qed.
Theorem numeric_refines_unique : forall value left right,
  numeric_refines value left -> numeric_refines value right -> left = right.
Proof. unfold numeric_refines. intros. congruence. Qed.
Theorem numeric_refines_bytes : forall bytes,
  valid_bytes bytes -> (length bytes <= 32)%nat -> numeric_refines (NByteString bytes) (signed_le bytes).
Proof. unfold numeric_refines, get_integer. intros. apply byte_string_integer_accepts; assumption. Qed.
Theorem buffer_get_integer_rejected : forall bytes, get_integer (NBuffer bytes) = None.
Proof. reflexivity. Qed.
Theorem null_get_integer_rejected : get_integer NNull = None.
Proof. reflexivity. Qed.
Theorem unsupported_get_integer_rejected : forall tag, get_integer (NUnsupported tag) = None.
Proof. reflexivity. Qed.
Theorem null_convert_preserves_null : convert_integer NNull = Some NNull.
Proof. reflexivity. Qed.
Theorem buffer_convert_integer : forall bytes,
  valid_bytes bytes -> (length bytes <= 32)%nat ->
  convert_integer (NBuffer bytes) = Some (NInteger (signed_le bytes)).
Proof. intros bytes Hvalid Hlen. unfold convert_integer. rewrite byte_string_integer_accepts by assumption. reflexivity. Qed.
Example boolean_true_is_one : get_integer (NBoolean true) = Some 1.
Proof. reflexivity. Qed.
Example boolean_false_is_zero : get_integer (NBoolean false) = Some 0.
Proof. reflexivity. Qed.
Example empty_byte_string_is_zero : get_integer (NByteString []) = Some 0.
Proof. reflexivity. Qed.
Example high_bit_byte_is_negative : get_integer (NByteString [128%nat]) = Some (-128).
Proof. reflexivity. Qed.
Example noncanonical_minus_one_accepted : get_integer (NByteString [255%nat;255%nat]) = Some (-1).
Proof. reflexivity. Qed.
Example sign_byte_prevents_negative_128 : get_integer (NByteString [128%nat;0%nat]) = Some 128.
Proof. reflexivity. Qed.

Print Assumptions pow256_positive.
Print Assumptions pow256_monotone.
Print Assumptions valid_bytesb_spec.
Print Assumptions signed_le_unsigned_relation.
Print Assumptions signed_le_payload_range.
Print Assumptions maximum_payload_bound.
Print Assumptions byte_string_integer_range.
Print Assumptions byte_string_integer_accepts.
Print Assumptions oversized_byte_string_rejected.
Print Assumptions invalid_physical_byte_rejected.
Print Assumptions unsigned_le_append.
Print Assumptions last_append_single.
Print Assumptions signed_le_sign_extension.
Print Assumptions sign_extension_admitted_within_limit.
Print Assumptions get_integer_range.
Print Assumptions numeric_refines_integer.
Print Assumptions numeric_refines_unique.
Print Assumptions numeric_refines_bytes.
Print Assumptions buffer_get_integer_rejected.
Print Assumptions null_get_integer_rejected.
Print Assumptions unsupported_get_integer_rejected.
Print Assumptions null_convert_preserves_null.
Print Assumptions buffer_convert_integer.
Print Assumptions boolean_true_is_one.
Print Assumptions boolean_false_is_zero.
Print Assumptions empty_byte_string_is_zero.
Print Assumptions high_bit_byte_is_negative.
Print Assumptions noncanonical_minus_one_accepted.
Print Assumptions sign_byte_prevents_negative_128.
