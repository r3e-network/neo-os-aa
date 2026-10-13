(*
  SmartAccount Integer ABI and nonce arithmetic.

  The model uses mathematical integers and the explicit signed-32-byte range
  enforced by NeoVM's Integer constructor. It does not prove that constructor,
  serialization, C# execution, or the full VM implementation correct. The node
  tests independently exercise the constructor and published encoding vectors.
*)
From Coq Require Import ZArith Bool Lia List.
Import ListNotations.
Open Scope Z_scope.

Definition nonce_limit : Z := 2 ^ 255.
Definition channel_limit : Z := 2 ^ 191.
Definition sequence_limit : Z := 2 ^ 64.
Definition vm_integer_fits (value : Z) : Prop := -(2 ^ 255) <= value < 2 ^ 255.
Definition nonce_valid (nonce : Z) : bool := (0 <=? nonce) && (nonce <? nonce_limit).
Definition channel (nonce : Z) : Z := nonce / sequence_limit.
Definition sequence (nonce : Z) : Z := nonce mod sequence_limit.
Definition compose (ch seq : Z) : Z := ch * sequence_limit + seq.
Definition consume (nonce cursor : Z) : option Z :=
  if Z.eqb cursor sequence_limit then None
  else if nonce_valid nonce && (0 <=? cursor) && (cursor <? sequence_limit)
          && Z.eqb (sequence nonce) cursor
       then Some (cursor + 1)
       else None.

Definition update_cursor (cursors : Z -> Z) (changed value : Z) : Z -> Z :=
  fun query => if Z.eqb query changed then value else cursors query.

Fixpoint verify_nonce_batch (cursors : Z -> Z) (nonces : list Z)
    : option (Z -> Z) :=
  match nonces with
  | [] => Some cursors
  | nonce :: rest =>
      match consume nonce (cursors (channel nonce)) with
      | Some next => verify_nonce_batch (update_cursor cursors (channel nonce) next) rest
      | None => None
      end
  end.

Lemma nonce_valid_range : forall nonce,
  nonce_valid nonce = true <-> 0 <= nonce < nonce_limit.
Proof.
  intros nonce. unfold nonce_valid.
  rewrite andb_true_iff, Z.leb_le, Z.ltb_lt. reflexivity.
Qed.

Lemma fixed_width_product : nonce_limit = channel_limit * sequence_limit.
Proof. vm_compute. reflexivity. Qed.

Lemma positive_limits : 0 < sequence_limit /\ 0 < channel_limit.
Proof. unfold sequence_limit, channel_limit. lia. Qed.

Theorem admissible_nonce_fits_vm_integer : forall nonce,
  nonce_valid nonce = true -> vm_integer_fits nonce.
Proof.
  intros nonce H. apply nonce_valid_range in H.
  unfold nonce_limit in H. unfold vm_integer_fits. lia.
Qed.

Theorem unsigned_upper_half_cannot_fit_vm_integer : forall value,
  2 ^ 255 <= value < 2 ^ 256 -> ~ vm_integer_fits value.
Proof. intros value Hrange Hfits. unfold vm_integer_fits in Hfits. lia. Qed.

Theorem decomposition_has_representable_channel : forall nonce,
  nonce_valid nonce = true ->
  0 <= channel nonce < channel_limit /\
  0 <= sequence nonce < sequence_limit /\
  compose (channel nonce) (sequence nonce) = nonce.
Proof.
  intros nonce H. apply nonce_valid_range in H.
  destruct positive_limits as [Hbase Hchannel].
  pose proof fixed_width_product as Hproduct.
  unfold channel, sequence, compose.
  split.
  - split.
    + apply Z.div_pos; lia.
    + apply Z.div_lt_upper_bound; nia.
  - split.
    + apply Z.mod_pos_bound. exact Hbase.
    + pose proof (Z.div_mod nonce sequence_limit) as Hdiv.
      specialize (Hdiv ltac:(lia)). nia.
Qed.

Theorem composition_stays_representable : forall ch seq,
  0 <= ch < channel_limit -> 0 <= seq < sequence_limit ->
  nonce_valid (compose ch seq) = true.
Proof.
  intros ch seq Hch Hseq. apply nonce_valid_range. unfold compose.
  pose proof positive_limits. pose proof fixed_width_product. nia.
Qed.

Theorem channel_key_high_bit_is_clear : forall nonce,
  nonce_valid nonce = true -> channel nonce / (2 ^ 191) = 0.
Proof.
  intros nonce H.
  pose proof (decomposition_has_representable_channel nonce H) as [Hch _].
  apply Z.div_small. exact Hch.
Qed.

Lemma compose_preserves_sequence : forall ch seq,
  0 <= seq < sequence_limit -> sequence (compose ch seq) = seq.
Proof.
  intros ch seq Hseq. unfold sequence, compose.
  replace (ch * sequence_limit + seq) with (seq + ch * sequence_limit) by ring.
  rewrite Z.mod_add by (pose proof positive_limits; lia).
  apply Z.mod_small. exact Hseq.
Qed.

Lemma consume_current_sequence : forall nonce,
  nonce_valid nonce = true ->
  consume nonce (sequence nonce) = Some (sequence nonce + 1).
Proof.
  intros nonce H.
  pose proof (decomposition_has_representable_channel nonce H) as [_ [Hseq _]].
  unfold consume.
  assert (Heq : Z.eqb (sequence nonce) sequence_limit = false) by (apply Z.eqb_neq; lia).
  assert (Hnonneg : (0 <=? sequence nonce) = true) by (apply Z.leb_le; lia).
  assert (Hlt : (sequence nonce <? sequence_limit) = true) by (apply Z.ltb_lt; lia).
  rewrite Heq, H, Hnonneg, Hlt, Z.eqb_refl. reflexivity.
Qed.

Theorem final_sequence_exhausts_without_wrap : forall ch,
  0 <= ch < channel_limit ->
  consume (compose ch (sequence_limit - 1)) (sequence_limit - 1) = Some sequence_limit.
Proof.
  intros ch Hch.
  assert (Hseq : 0 <= sequence_limit - 1 < sequence_limit)
    by (pose proof positive_limits; lia).
  pose proof (composition_stays_representable ch (sequence_limit - 1) Hch Hseq) as Hvalid.
  pose proof (consume_current_sequence _ Hvalid) as Hconsume.
  rewrite compose_preserves_sequence in Hconsume by exact Hseq.
  replace (sequence_limit - 1 + 1) with sequence_limit in Hconsume by ring.
  exact Hconsume.
Qed.

Theorem exhausted_cursor_rejects_every_nonce : forall nonce,
  consume nonce sequence_limit = None.
Proof. intros nonce. unfold consume. rewrite Z.eqb_refl. reflexivity. Qed.

Example maximum_nonce_is_representable : nonce_valid (2 ^ 255 - 1) = true.
Proof. vm_compute. reflexivity. Qed.

Example first_unsigned_upper_half_nonce_is_rejected : nonce_valid (2 ^ 255) = false.
Proof. vm_compute. reflexivity. Qed.

Example negative_nonce_is_rejected : nonce_valid (-1) = false.
Proof. vm_compute. reflexivity. Qed.

Lemma consume_success_requires_exact_sequence : forall nonce cursor next,
  consume nonce cursor = Some next ->
  cursor = sequence nonce /\ next = cursor + 1.
Proof.
  intros nonce cursor next H. unfold consume in H.
  destruct (Z.eqb cursor sequence_limit); try discriminate.
  destruct (nonce_valid nonce && (0 <=? cursor) && (cursor <? sequence_limit)
            && Z.eqb (sequence nonce) cursor) eqn:Hchecks; try discriminate.
  inversion H; subst next.
  repeat rewrite andb_true_iff in Hchecks.
  destruct Hchecks as [[[_ _] _] Heq]. apply Z.eqb_eq in Heq.
  split; [symmetry; exact Heq | reflexivity].
Qed.

Lemma update_cursor_same : forall cursors changed value,
  update_cursor cursors changed value changed = value.
Proof. intros. unfold update_cursor. rewrite Z.eqb_refl. reflexivity. Qed.

Lemma update_cursor_other : forall cursors changed value query,
  query <> changed -> update_cursor cursors changed value query = cursors query.
Proof.
  intros cursors changed value query H. unfold update_cursor.
  apply Z.eqb_neq in H. rewrite H. reflexivity.
Qed.

Theorem shadow_batch_preserves_unmentioned_channel : forall nonces cursors final query,
  Forall (fun nonce => query <> channel nonce) nonces ->
  verify_nonce_batch cursors nonces = Some final -> final query = cursors query.
Proof.
  induction nonces as [|nonce rest IH]; intros cursors final query Hchannels Hrun.
  - simpl in Hrun. inversion Hrun. reflexivity.
  - inversion Hchannels as [|? ? Hhead Htail]; subst.
    simpl in Hrun.
    destruct (consume nonce (cursors (channel nonce))) as [next|] eqn:Hconsume; try discriminate.
    rewrite (IH _ _ _ Htail Hrun). apply update_cursor_other. exact Hhead.
Qed.

Theorem shadow_batch_rejects_immediate_replay : forall cursors nonce,
  verify_nonce_batch cursors [nonce; nonce] = None.
Proof.
  intros cursors nonce. simpl.
  destruct (consume nonce (cursors (channel nonce))) as [next|] eqn:Hfirst; [|reflexivity].
  rewrite update_cursor_same.
  destruct (consume nonce next) as [after|] eqn:Hsecond; [|reflexivity].
  pose proof (consume_success_requires_exact_sequence _ _ _ Hfirst) as [Hcursor Hnext].
  pose proof (consume_success_requires_exact_sequence _ _ _ Hsecond) as [Hcursor2 Hafter].
  exfalso. lia.
Qed.

Example shadow_batch_accepts_sequential_nonces :
  option_map (fun cursors => cursors 0) (verify_nonce_batch (fun _ => 0) [0; 1]) = Some 2.
Proof. vm_compute. reflexivity. Qed.

Example shadow_batch_rejects_sequence_gap :
  verify_nonce_batch (fun _ => 0) [0; 2] = None.
Proof. vm_compute. reflexivity. Qed.

Example shadow_batch_exhaustion_does_not_wrap :
  verify_nonce_batch (fun _ => sequence_limit - 1) [sequence_limit - 1; 0] = None.
Proof. vm_compute. reflexivity. Qed.

Example shadow_batch_tracks_independent_channels :
  option_map (fun cursors => (cursors 0, cursors 7))
    (verify_nonce_batch (fun ch => if Z.eqb ch 7 then 9 else 0)
      [0; compose 7 9; 1]) = Some (2, 10).
Proof. vm_compute. reflexivity. Qed.

Print Assumptions nonce_valid_range.
Print Assumptions fixed_width_product.
Print Assumptions positive_limits.
Print Assumptions admissible_nonce_fits_vm_integer.
Print Assumptions unsigned_upper_half_cannot_fit_vm_integer.
Print Assumptions decomposition_has_representable_channel.
Print Assumptions composition_stays_representable.
Print Assumptions channel_key_high_bit_is_clear.
Print Assumptions compose_preserves_sequence.
Print Assumptions consume_current_sequence.
Print Assumptions final_sequence_exhausts_without_wrap.
Print Assumptions exhausted_cursor_rejects_every_nonce.
Print Assumptions maximum_nonce_is_representable.
Print Assumptions first_unsigned_upper_half_nonce_is_rejected.
Print Assumptions negative_nonce_is_rejected.
Print Assumptions consume_success_requires_exact_sequence.
Print Assumptions update_cursor_same.
Print Assumptions update_cursor_other.
Print Assumptions shadow_batch_preserves_unmentioned_channel.
Print Assumptions shadow_batch_rejects_immediate_replay.
Print Assumptions shadow_batch_accepts_sequential_nonces.
Print Assumptions shadow_batch_rejects_sequence_gap.
Print Assumptions shadow_batch_exhaustion_does_not_wrap.
Print Assumptions shadow_batch_tracks_independent_channels.
