(* Real tag/varint/signed-byte framing for the two-scalar ledger domain.
   C#/.NET execution correspondence is a separate checked frontend obligation. *)
From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import IntegerSemantics NumericCoercions CapMethodVm.
Import ListNotations.
Open Scope Z_scope.

Fixpoint positive_payload (fuel : nat) (z : Z) : list nat :=
  match fuel with O => [] | S rest =>
    if z <? 128 then [Z.to_nat z]
    else Z.to_nat (z mod 256) :: positive_payload rest (z / 256)
  end.
Definition encode_integer (z : Z) := if z =? 0 then [] else positive_payload 32 z.
Definition payload_bound (fuel : nat) := 128 * pow256 (Nat.pred fuel).

Lemma positive_payload_nonempty : forall fuel z,
  (0 < fuel)%nat -> positive_payload fuel z <> [].
Proof. destruct fuel; intros; [lia|]. cbn. destruct (z <? 128); discriminate. Qed.
Lemma positive_payload_correct : forall fuel z,
  (0 < fuel)%nat -> 0 <= z < payload_bound fuel ->
  signed_le (positive_payload fuel z) = z /\
  valid_bytes (positive_payload fuel z) /\ (length (positive_payload fuel z) <= fuel)%nat.
Proof.
  induction fuel as [|fuel IH]; intros z Hfuel Hz; [lia|].
  cbn [positive_payload]. destruct (z <? 128) eqn:E.
  - apply Z.ltb_lt in E.
    assert (Hcast : Z.of_nat (Z.to_nat z) = z) by (apply Z2Nat.id; lia).
    assert (Hsmall : (128 <=? Z.to_nat z)%nat = false) by (apply Nat.leb_gt; lia).
    cbn [signed_le]. rewrite Hsmall, Hcast. split; [lia|]. split.
    + unfold valid_bytes. constructor; [lia|constructor].
    + simpl. lia.
  - apply Z.ltb_ge in E.
    assert (Hnonzero : (0 < fuel)%nat).
    { destruct fuel; [unfold payload_bound in Hz; cbn [Nat.pred pow256] in Hz; lia|lia]. }
    assert (Hq : 0 <= z / 256 < payload_bound fuel).
    { unfold payload_bound in *. destruct fuel; [lia|]. cbn [Nat.pred pow256] in *.
      split; [apply Z.div_pos; lia|]. apply Z.div_lt_upper_bound; nia. }
    specialize (IH _ Hnonzero Hq). destruct IH as [Hsigned [Hvalid Hlen]].
    assert (Hr : 0 <= z mod 256 < 256) by (apply Z.mod_pos_bound; lia).
    assert (Hcast : Z.of_nat (Z.to_nat (z mod 256)) = z mod 256) by (apply Z2Nat.id; lia).
    pose proof (positive_payload_nonempty fuel (z/256) Hnonzero) as Hne.
    destruct (positive_payload fuel (z/256)) as [|b tail] eqn:P; [contradiction|].
    change (Z.of_nat (Z.to_nat (z mod 256)) + 256 * signed_le (b::tail) = z /\
      valid_bytes (Z.to_nat (z mod 256)::b::tail) /\ (S (length (b::tail)) <= S fuel)%nat).
    rewrite Hsigned, Hcast.
    split; [pose proof (Z.div_mod z 256); nia|]. split.
    + unfold valid_bytes in *. constructor; [lia|exact Hvalid].
    + simpl in *. lia.
Qed.
Theorem integer_encode_decode_roundtrip : forall z, 0 <= z < integer_limit ->
  signed_le (encode_integer z) = z /\ valid_bytes (encode_integer z) /\
  (length (encode_integer z) <= 32)%nat.
Proof.
  intros z Hz. unfold encode_integer. destruct (z =? 0) eqn:E.
  - apply Z.eqb_eq in E. subst. split; [reflexivity|]. split; [constructor|simpl; lia].
  - apply positive_payload_correct; [lia|]. change (0 <= z < integer_limit). exact Hz.
Qed.
Theorem canonical_integer_encoding_injective : forall x y,
  0 <= x < integer_limit -> 0 <= y < integer_limit -> encode_integer x = encode_integer y -> x = y.
Proof. intros x y Hx Hy E.
  pose proof (integer_encode_decode_roundtrip x Hx) as [X _].
  pose proof (integer_encode_decode_roundtrip y Hy) as [Y _]. rewrite E in X. congruence. Qed.

Definition take_exact (n : nat) (input : list nat) : option (list nat * list nat) :=
  if (n <=? length input)%nat then Some (firstn n input, skipn n input) else None.
Definition read_extended width input :=
  match take_exact width input with
  | Some (payload,rest) => Some (Z.to_nat (unsigned_le payload),rest) | None => None end.
Definition read_varint (input : list nat) : option (nat * list nat) :=
  match input with [] => None | tag::rest =>
    if (tag <? 253)%nat then Some (tag,rest)
    else if Nat.eqb tag 253 then read_extended 2 rest
    else if Nat.eqb tag 254 then read_extended 4 rest
    else if Nat.eqb tag 255 then read_extended 8 rest else None end.
Definition kind_tag kind := match kind with ArrayKind => 64%nat | StructKind => 65%nat end.
Definition hash_tag (is_buffer : bool) := if is_buffer then 48%nat else 40%nat.
Record Ledger := ledger { ledger_kind : Kind; hash_buffer : bool; hash_bytes : list nat; reserved : Z }.
Definition legal_ledger l := length (hash_bytes l) = 32%nat /\ valid_bytes (hash_bytes l) /\ 0 <= reserved l < integer_limit.
Definition encode_ledger l :=
  [kind_tag (ledger_kind l);2%nat;hash_tag (hash_buffer l);32%nat] ++ hash_bytes l ++
  [33%nat;length (encode_integer (reserved l))] ++ encode_integer (reserved l).
Definition decode_ledger_prefix (input : list nat) : option (Ledger * list nat) :=
  match input with [] => None | kt::rest =>
  match if Nat.eqb kt 64 then Some ArrayKind else if Nat.eqb kt 65 then Some StructKind else None with
  | None => None | Some kind =>
  match read_varint rest with
  | Some (count,ht::after_tag) =>
    if Nat.eqb count 2 then
    match if Nat.eqb ht 40 then Some false else if Nat.eqb ht 48 then Some true else None with
    | None => None | Some is_buffer =>
    match read_varint after_tag with
    | Some (len,after_len) => if Nat.eqb len 32 then
      match take_exact 32 after_len with
      | Some (hash,33%nat::after_hash) =>
        match read_varint after_hash with
        | Some (size,after_size) => if (size <=? 32)%nat then
          match take_exact size after_size with
          | Some (payload,tail) =>
              let z := signed_le payload in
              if (0 <=? z) && (z <? integer_limit) then Some (ledger kind is_buffer hash z,tail) else None
          | None => None end
        else None | None => None end
      | _ => None end
    else None | None => None end
    end else None
  | _ => None end end end.

Lemma read_varint_small : forall n tail, (n < 253)%nat -> read_varint (n::tail) = Some (n,tail).
Proof. intros n tail H. unfold read_varint. assert (E : (n <? 253)%nat = true) by (apply Nat.ltb_lt; lia). rewrite E. reflexivity. Qed.
Lemma take_exact_app : forall left right, take_exact (length left) (left ++ right) = Some (left,right).
Proof. intros left right. unfold take_exact. rewrite app_length.
  assert (E : (length left <=? length left + length right)%nat = true) by (apply Nat.leb_le; lia).
  rewrite E, firstn_app, firstn_all, Nat.sub_diag, skipn_app, skipn_all, Nat.sub_diag. simpl. rewrite app_nil_r. reflexivity. Qed.
Theorem ledger_encode_decode_roundtrip : forall l tail,
  legal_ledger l -> decode_ledger_prefix (encode_ledger l ++ tail) = Some (l,tail).
Proof.
  intros [kind buffer hash z] tail [Hhash [Hbytes Hz]]. cbn [hash_bytes reserved] in Hhash, Hbytes, Hz.
  pose proof (integer_encode_decode_roundtrip z Hz) as [Hsigned [Hvalid Hlen]].
  unfold encode_ledger; cbn [ledger_kind hash_buffer hash_bytes reserved].
  repeat rewrite <- app_assoc.
  assert (Htake : forall suffix, take_exact 32 (hash ++ suffix) = Some (hash,suffix)).
  { intros suffix. rewrite <- Hhash. apply take_exact_app. }
  destruct kind, buffer; cbn [decode_ledger_prefix kind_tag hash_tag app Nat.eqb];
    rewrite read_varint_small by lia; cbn [Nat.eqb];
    rewrite read_varint_small by lia; cbn [Nat.eqb];
    rewrite Htake; cbn beta iota zeta;
    rewrite read_varint_small by lia; cbn beta iota zeta;
    assert (Esize : (length (encode_integer z) <=? 32)%nat = true) by (apply Nat.leb_le; lia);
    rewrite Esize, take_exact_app, Hsigned;
    assert (Ez : (0 <=? z) && (z <? integer_limit) = true) by (apply andb_true_iff; split; [apply Z.leb_le|apply Z.ltb_lt]; lia);
    rewrite Ez; reflexivity.
Qed.
Theorem ledger_encoding_injective : forall a b,
  legal_ledger a -> legal_ledger b -> encode_ledger a = encode_ledger b -> a = b.
Proof. intros a b Ha Hb E.
  pose proof (ledger_encode_decode_roundtrip a [] Ha) as A.
  pose proof (ledger_encode_decode_roundtrip b [] Hb) as B. rewrite E in A. congruence. Qed.
Theorem ledger_prefix_parse_unique : forall input a b taila tailb,
  decode_ledger_prefix input = Some (a,taila) -> decode_ledger_prefix input = Some (b,tailb) ->
  a = b /\ taila = tailb.
Proof. intros. split; congruence. Qed.
Theorem canonical_ledger_length : forall l, legal_ledger l ->
  (38 <= length (encode_ledger l) <= 70)%nat.
Proof. intros l [Hhash [_ Hz]].
  pose proof (integer_encode_decode_roundtrip (reserved l) Hz) as [_ [_ Hlen]].
  unfold encode_ledger. repeat rewrite app_length. simpl. lia. Qed.
Definition structured_wire l := VWire (ledger_kind l)
  [if hash_buffer l then VBuffer (hash_bytes l) else VBytes (hash_bytes l);VInt (reserved l)].
Definition decode_to_wire input := option_map (fun '(l,tail) => (structured_wire l,tail)) (decode_ledger_prefix input).
Theorem actual_framing_refines_structured_wire : forall l tail, legal_ledger l ->
  decode_to_wire (encode_ledger l ++ tail) = Some (structured_wire l,tail).
Proof. intros. unfold decode_to_wire. rewrite ledger_encode_decode_roundtrip by assumption. reflexivity. Qed.
Theorem byte_string_wire_is_helper_budget : forall kind hash z,
  structured_wire (ledger kind false hash z) = stored_value (PresentBudget kind hash z).
Proof. reflexivity. Qed.
Theorem wire_tags_are_distinct : forall kind hash z,
  structured_wire (ledger kind false hash z) <> structured_wire (ledger kind true hash z).
Proof. discriminate. Qed.
Theorem helper_serialize_deserialize_roundtrip : forall kind buffer hash z,
  let wire := structured_wire (ledger kind buffer hash z) in
  option_map fst (bind (deserialize (state 0 [] [] [] [] VNull [] (fun _ => None)) wire)
    (fun '(ref,next) => serialize next ref)) = Some wire.
Proof. intros. destruct kind, buffer; reflexivity. Qed.
Example integer_zero_has_empty_payload : encode_integer 0 = [].
Proof. reflexivity. Qed.
Example positive_high_bit_gets_zero_sign_byte : encode_integer 128 = [128%nat;0%nat].
Proof. reflexivity. Qed.
Example integer_sign_extension_decodes_same : signed_le [128%nat;0%nat;0%nat] = 128.
Proof. reflexivity. Qed.
Example varint_nonminimal_two_is_accepted : read_varint [253%nat;2%nat;0%nat;99%nat] = Some (2%nat,[99%nat]).
Proof. reflexivity. Qed.
Example extended_varint_four_bytes : read_varint [254%nat;2%nat;0%nat;0%nat;0%nat;99%nat] = Some (2%nat,[99%nat]).
Proof. reflexivity. Qed.
Example extended_varint_eight_bytes : read_varint [255%nat;2%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;99%nat] = Some (2%nat,[99%nat]).
Proof. reflexivity. Qed.
Example negative_payload_is_rejected :
  decode_ledger_prefix ([64%nat;2%nat;40%nat;32%nat] ++ repeat 0%nat 32 ++ [33%nat;1%nat;255%nat]) = None.
Proof. reflexivity. Qed.
Example oversized_integer_payload_is_rejected :
  decode_ledger_prefix ([64%nat;2%nat;40%nat;32%nat] ++ repeat 0%nat 32 ++ [33%nat;33%nat] ++ repeat 0%nat 33) = None.
Proof. reflexivity. Qed.
Example noncanonical_zero_wire_is_accepted :
  decode_ledger_prefix ([64%nat;253%nat;2%nat;0%nat;40%nat;253%nat;32%nat;0%nat] ++ repeat 0%nat 32 ++ [33%nat;2%nat;0%nat;0%nat;99%nat]) =
  Some (ledger ArrayKind false (repeat 0%nat 32) 0,[99%nat]).
Proof. reflexivity. Qed.

Theorem canonical_ledger_bytes_valid : forall l, legal_ledger l -> valid_bytes (encode_ledger l).
Proof.
  intros [kind buffer hash z] [Hhash [Hbytes Hz]]. cbn [hash_bytes reserved] in *.
  pose proof (integer_encode_decode_roundtrip z Hz) as [_ [Hpayload Hlen]].
  unfold encode_ledger; cbn [ledger_kind hash_buffer hash_bytes reserved].
  unfold valid_bytes in *. apply Forall_app. split.
  - destruct kind, buffer; cbn [kind_tag hash_tag]; repeat constructor; lia.
  - apply Forall_app. split; [exact Hbytes|]. apply Forall_app. split.
    + constructor; [lia|]. constructor; [lia|constructor].
    + exact Hpayload.
Qed.
Definition legal_ledgerb l :=
  Nat.eqb (length (hash_bytes l)) 32 && valid_bytesb (hash_bytes l) &&
  ((0 <=? reserved l) && (reserved l <? integer_limit)).
Lemma legal_ledgerb_spec : forall l, legal_ledgerb l = true <-> legal_ledger l.
Proof. intros l. unfold legal_ledgerb, legal_ledger.
  repeat rewrite andb_true_iff. rewrite Nat.eqb_eq, valid_bytesb_spec, Z.leb_le, Z.ltb_lt. tauto. Qed.
Definition encode_structured_wire value :=
  match value with
  | VWire kind [VBytes hash;VInt z] =>
      let l := ledger kind false hash z in if legal_ledgerb l then Some (encode_ledger l) else None
  | VWire kind [VBuffer hash;VInt z] =>
      let l := ledger kind true hash z in if legal_ledgerb l then Some (encode_ledger l) else None
  | _ => None end.
Theorem structured_wire_encodes_actual_framing : forall l, legal_ledger l ->
  encode_structured_wire (structured_wire l) = Some (encode_ledger l).
Proof. intros [kind buffer hash z] H. apply legal_ledgerb_spec in H.
  destruct buffer; cbn [structured_wire encode_structured_wire ledger_kind hash_buffer hash_bytes reserved];
  rewrite H; reflexivity. Qed.
Theorem structured_wire_binary_roundtrip : forall l suffix, legal_ledger l ->
  exists bytes, encode_structured_wire (structured_wire l) = Some bytes /\
  decode_to_wire (bytes ++ suffix) = Some (structured_wire l,suffix).
Proof. intros. exists (encode_ledger l). split.
  - apply structured_wire_encodes_actual_framing. assumption.
  - apply actual_framing_refines_structured_wire. assumption.
Qed.

Print Assumptions positive_payload_nonempty.
Print Assumptions positive_payload_correct.
Print Assumptions integer_encode_decode_roundtrip.
Print Assumptions canonical_integer_encoding_injective.
Print Assumptions read_varint_small.
Print Assumptions take_exact_app.
Print Assumptions ledger_encode_decode_roundtrip.
Print Assumptions ledger_encoding_injective.
Print Assumptions ledger_prefix_parse_unique.
Print Assumptions canonical_ledger_length.
Print Assumptions actual_framing_refines_structured_wire.
Print Assumptions byte_string_wire_is_helper_budget.
Print Assumptions wire_tags_are_distinct.
Print Assumptions helper_serialize_deserialize_roundtrip.
Print Assumptions integer_zero_has_empty_payload.
Print Assumptions positive_high_bit_gets_zero_sign_byte.
Print Assumptions integer_sign_extension_decodes_same.
Print Assumptions varint_nonminimal_two_is_accepted.
Print Assumptions extended_varint_four_bytes.
Print Assumptions extended_varint_eight_bytes.
Print Assumptions negative_payload_is_rejected.
Print Assumptions oversized_integer_payload_is_rejected.
Print Assumptions noncanonical_zero_wire_is_accepted.
Print Assumptions canonical_ledger_bytes_valid.
Print Assumptions legal_ledgerb_spec.
Print Assumptions structured_wire_encodes_actual_framing.
Print Assumptions structured_wire_binary_roundtrip.
