(** * Load-time manifest and method-token admission

    Three dispatch lanes start from an already resolved method descriptor and an
    already loaded contract state. None of them records what a manifest or a nef
    token is allowed to *declare* before that point, so nothing there
    distinguishes a declaration the loader refuses from one it accepts and the
    dispatcher later cannot resolve.

    The model has two independent surfaces, and the point of separating them is
    that they refuse different things:

    - a fixed list of [guards], each a [bool] read out of the pinned source, all
      of which a declaration must satisfy;
    - three inclusive [within] bounds on counts -- token array length, token
      method name length, manifest length -- which no guard consults.

    So an admitted declaration can still be refused for being too long, and a
    short one can still be refused for a guard. The recorded read order is the
    third subject: the checksum is compared last and only when asked, so
    structural admission happens before integrity is considered at all. *)

Require Import Coq.Lists.List Coq.Bool.Bool Coq.Arith.Arith Coq.micromega.Lia.
Import ListNotations.

(** ** The ordered reads of one nef deserialization *)

Inductive LoadStep :=
| ReadMagic
| ReadCompiler
| ReadSource
| ReadReserveByte
| ReadTokens
| ReadReserveShort
| ReadScript
| VerifyChecksum.

Scheme Equality for LoadStep.

(** Where a read sits in the recorded order. *)
Fixpoint index_of (needle : LoadStep) (steps : list LoadStep) (from : nat) : option nat :=
  match steps with
  | [] => None
  | head :: tail =>
      if LoadStep_eq_dec head needle then Some from else index_of needle tail (S from)
  end.

(** [earlier a b steps] holds when [a] is recorded strictly before [b]. *)
Definition earlier (a b : LoadStep) (steps : list LoadStep) : bool :=
  match index_of a steps 0 with
  | Some i =>
      match index_of b steps 0 with
      | Some j => Nat.ltb i j
      | None => false
      end
  | None => false
  end.

(** ** The guards a declaration must pass

    One constructor per projected boolean, in the order the pin reads them. *)
Inductive GuardName :=
| GMagic
| GReserves
| GScript
| GChecksumForm
| GVerifyFlag
| GUnderscore
| GFlagByte
| GManifestName
| GFeatures
| GRepeatedNames
| GManifestLength
| GAbiNonEmpty
| GArityKey
| GArityRange
| GWildcard
| GMissIsNull
| GMethodName
| GParamNames
| GReturnType
| GOffset.

Scheme Equality for GuardName.

(** ** The projected record

    One field per projected key, same polarity: [true] always means "the source
    says so". The three [nat] fields are declared bounds, not decisions; they are
    consumed by [within], never by [guard]. *)
Record AdmissionProgram := admission_program {
  ap_steps : list LoadStep;
  ap_magic_is_the_declared_nef3_constant : bool;
  ap_the_reserved_fields_must_be_zero : bool;
  ap_token_array_cap : nat;
  ap_the_script_cannot_be_empty : bool;
  ap_the_checksum_is_compared_for_inequality : bool;
  ap_the_checksum_check_is_guarded_by_the_verify_flag : bool;
  ap_a_token_method_cannot_start_with_underscore : bool;
  ap_token_method_name_limit : nat;
  ap_a_token_flag_byte_must_be_a_declared_flag : bool;
  ap_the_manifest_name_cannot_be_empty : bool;
  ap_the_features_field_must_be_empty : bool;
  ap_the_manifest_names_cannot_repeat : bool;
  ap_manifest_length_cap : nat;
  ap_the_manifest_length_cap_is_enforced_before_parsing : bool;
  ap_the_abi_needs_at_least_one_method : bool;
  ap_the_exact_lookup_is_keyed_by_name_and_arity : bool;
  ap_the_arity_is_range_checked : bool;
  ap_the_wildcard_lookup_ignores_the_arity : bool;
  ap_the_exact_lookup_returns_null_when_absent : bool;
  ap_a_method_name_cannot_be_empty : bool;
  ap_a_method_parameter_name_cannot_repeat : bool;
  ap_a_method_return_type_must_be_defined : bool;
  ap_a_method_offset_cannot_be_negative : bool;
}.

(** ** The guard set *)

Definition guard (p : AdmissionProgram) (g : GuardName) : bool :=
  match g with
  | GMagic => ap_magic_is_the_declared_nef3_constant p
  | GReserves => ap_the_reserved_fields_must_be_zero p
  | GScript => ap_the_script_cannot_be_empty p
  | GChecksumForm => ap_the_checksum_is_compared_for_inequality p
  | GVerifyFlag => ap_the_checksum_check_is_guarded_by_the_verify_flag p
  | GUnderscore => ap_a_token_method_cannot_start_with_underscore p
  | GFlagByte => ap_a_token_flag_byte_must_be_a_declared_flag p
  | GManifestName => ap_the_manifest_name_cannot_be_empty p
  | GFeatures => ap_the_features_field_must_be_empty p
  | GRepeatedNames => ap_the_manifest_names_cannot_repeat p
  | GManifestLength => ap_the_manifest_length_cap_is_enforced_before_parsing p
  | GAbiNonEmpty => ap_the_abi_needs_at_least_one_method p
  | GArityKey => ap_the_exact_lookup_is_keyed_by_name_and_arity p
  | GArityRange => ap_the_arity_is_range_checked p
  | GWildcard => ap_the_wildcard_lookup_ignores_the_arity p
  | GMissIsNull => ap_the_exact_lookup_returns_null_when_absent p
  | GMethodName => ap_a_method_name_cannot_be_empty p
  | GParamNames => ap_a_method_parameter_name_cannot_repeat p
  | GReturnType => ap_a_method_return_type_must_be_defined p
  | GOffset => ap_a_method_offset_cannot_be_negative p
  end.

(** The whole list is consulted; [every_guard_is_consulted] proves no
    constructor is missing from it. *)
Definition guards : list GuardName :=
  [GMagic; GReserves; GScript; GChecksumForm; GVerifyFlag; GUnderscore; GFlagByte;
   GManifestName; GFeatures; GRepeatedNames; GManifestLength; GAbiNonEmpty; GArityKey;
   GArityRange; GWildcard; GMissIsNull; GMethodName; GParamNames; GReturnType; GOffset].

Fixpoint all_guards (p : AdmissionProgram) (gs : list GuardName) : bool :=
  match gs with
  | [] => true
  | g :: rest => andb (guard p g) (all_guards p rest)
  end.

Definition admitted (p : AdmissionProgram) : bool := all_guards p guards.

(** ** The three inclusive bounds

    [within cap count] is the decision; [count = cap] is inside it, because the
    source compares with a length, not with a "strictly less than". *)
Definition within (cap count : nat) : bool := Nat.leb count cap.

Definition loads (p : AdmissionProgram)
                (tokenCount methodNameLength manifestLength : nat) : bool :=
  andb (admitted p)
       (andb (within (ap_token_array_cap p) tokenCount)
             (andb (within (ap_token_method_name_limit p) methodNameLength)
                   (within (ap_manifest_length_cap p) manifestLength))).

(** ** Two readers of the same bytes *)

Definition canonical_steps : list LoadStep :=
  [ReadMagic; ReadCompiler; ReadSource; ReadReserveByte;
   ReadTokens; ReadReserveShort; ReadScript; VerifyChecksum].

(** The reserve byte read before the source string: a wire-order defect that
    keeps every guard satisfied and only moves the recorded order. *)
Definition swapped_read_steps : list LoadStep :=
  [ReadMagic; ReadCompiler; ReadReserveByte; ReadSource;
   ReadTokens; ReadReserveShort; ReadScript; VerifyChecksum].

Definition reviewed_program : AdmissionProgram :=
  {| ap_steps := canonical_steps;
     ap_magic_is_the_declared_nef3_constant := true;
     ap_the_reserved_fields_must_be_zero := true;
     ap_token_array_cap := 128;
     ap_the_script_cannot_be_empty := true;
     ap_the_checksum_is_compared_for_inequality := true;
     ap_the_checksum_check_is_guarded_by_the_verify_flag := true;
     ap_a_token_method_cannot_start_with_underscore := true;
     ap_token_method_name_limit := 32;
     ap_a_token_flag_byte_must_be_a_declared_flag := true;
     ap_the_manifest_name_cannot_be_empty := true;
     ap_the_features_field_must_be_empty := true;
     ap_the_manifest_names_cannot_repeat := true;
     ap_manifest_length_cap := 65535;
     ap_the_manifest_length_cap_is_enforced_before_parsing := true;
     ap_the_abi_needs_at_least_one_method := true;
     ap_the_exact_lookup_is_keyed_by_name_and_arity := true;
     ap_the_arity_is_range_checked := true;
     ap_the_wildcard_lookup_ignores_the_arity := true;
     ap_the_exact_lookup_returns_null_when_absent := true;
     ap_a_method_name_cannot_be_empty := true;
     ap_a_method_parameter_name_cannot_repeat := true;
     ap_a_method_return_type_must_be_defined := true;
     ap_a_method_offset_cannot_be_negative := true |}.

Definition swapped_read_program : AdmissionProgram :=
  {| ap_steps := swapped_read_steps;
     ap_magic_is_the_declared_nef3_constant := true;
     ap_the_reserved_fields_must_be_zero := true;
     ap_token_array_cap := 128;
     ap_the_script_cannot_be_empty := true;
     ap_the_checksum_is_compared_for_inequality := true;
     ap_the_checksum_check_is_guarded_by_the_verify_flag := true;
     ap_a_token_method_cannot_start_with_underscore := true;
     ap_token_method_name_limit := 32;
     ap_a_token_flag_byte_must_be_a_declared_flag := true;
     ap_the_manifest_name_cannot_be_empty := true;
     ap_the_features_field_must_be_empty := true;
     ap_the_manifest_names_cannot_repeat := true;
     ap_manifest_length_cap := 65535;
     ap_the_manifest_length_cap_is_enforced_before_parsing := true;
     ap_the_abi_needs_at_least_one_method := true;
     ap_the_exact_lookup_is_keyed_by_name_and_arity := true;
     ap_the_arity_is_range_checked := true;
     ap_the_wildcard_lookup_ignores_the_arity := true;
     ap_the_exact_lookup_returns_null_when_absent := true;
     ap_a_method_name_cannot_be_empty := true;
     ap_a_method_parameter_name_cannot_repeat := true;
     ap_a_method_return_type_must_be_defined := true;
     ap_a_method_offset_cannot_be_negative := true |}.

(** ** Admission is all-or-nothing *)

Lemma all_guards_true :
  forall p gs, all_guards p gs = true -> forall g, In g gs -> guard p g = true.
Proof.
  intros p gs. induction gs as [|h t IH]; intros H g Hin.
  - destruct Hin.
  - simpl in H. apply andb_true_iff in H. destruct H as [Hh Ht].
    destruct Hin as [Heq | Hin].
    + subst. exact Hh.
    + exact (IH Ht g Hin).
Qed.

Lemma all_guards_false :
  forall p gs, all_guards p gs = false -> exists g, In g gs /\ guard p g = false.
Proof.
  intros p gs. induction gs as [|h t IH]; intros H.
  - simpl in H. discriminate.
  - simpl in H. apply andb_false_iff in H. destruct H as [Hh | Ht].
    + exists h. split. left. reflexivity. exact Hh.
    + destruct (IH Ht) as [g [Hin Hg]]. exists g. split.
      right. exact Hin. exact Hg.
Qed.

Theorem an_admitted_program_passes_every_guard :
  forall p, admitted p = true -> forall g, In g guards -> guard p g = true.
Proof.
  intros p H g Hin. exact (all_guards_true p guards H g Hin).
Qed.

Theorem a_single_false_guard_refuses :
  forall p g, In g guards -> guard p g = false -> admitted p = false.
Proof.
  intros p g Hin Hg.
  destruct (admitted p) eqn:E.
  - exfalso.
    pose proof (an_admitted_program_passes_every_guard p E g Hin) as Ht.
    rewrite Hg in Ht. discriminate.
  - reflexivity.
Qed.

Theorem every_guard_is_consulted : forall g, In g guards.
Proof. intros g. destruct g; simpl; auto 40. Qed.

(** ** The declared read order is load bearing *)

Theorem the_magic_is_read_before_the_tokens :
  earlier ReadMagic ReadTokens canonical_steps = true.
Proof. reflexivity. Qed.

Theorem the_tokens_are_read_before_the_script :
  earlier ReadTokens ReadScript canonical_steps = true.
Proof. reflexivity. Qed.

Theorem the_script_is_read_before_the_checksum :
  earlier ReadScript VerifyChecksum canonical_steps = true.
Proof. reflexivity. Qed.

Theorem the_checksum_is_the_last_read :
  forall s, In s canonical_steps -> s = VerifyChecksum \/ earlier s VerifyChecksum canonical_steps = true.
Proof.
  intros s H. destruct s; simpl in *; auto; right; reflexivity.
Qed.

Theorem the_compiler_is_read_after_the_magic :
  earlier ReadMagic ReadCompiler canonical_steps = true.
Proof. reflexivity. Qed.

Theorem a_reordered_reader_reports_a_different_step_order :
  swapped_read_steps <> canonical_steps.
Proof. intros H. discriminate H. Qed.

Theorem the_reordered_reader_still_verifies_the_checksum_last :
  earlier ReadScript VerifyChecksum swapped_read_steps = true.
Proof. reflexivity. Qed.

(** ** The bounds are inclusive and do not depend on the guards *)

Theorem the_bound_is_inclusive : forall cap, within cap cap = true.
Proof. intros cap. apply Nat.leb_le. lia. Qed.

Theorem one_past_the_bound_is_refused : forall cap, within cap (S cap) = false.
Proof. intros cap. apply Nat.leb_gt. lia. Qed.

Theorem raising_the_bound_admits_one_more :
  forall cap count, within cap count = true -> within (S cap) count = true.
Proof.
  intros cap count H. apply Nat.leb_le in H. apply Nat.leb_le. lia.
Qed.

Theorem a_raised_bound_admits_exactly_one_more :
  forall cap count, within cap count = false -> within (S cap) count = true -> count = S cap.
Proof.
  intros cap count H1 H2.
  apply Nat.leb_gt in H1. apply Nat.leb_le in H2. lia.
Qed.

(** ** A declaration is loaded only when both surfaces agree *)

Theorem loads_requires_the_guards :
  forall p t n m, loads p t n m = true -> admitted p = true.
Proof.
  intros p t n m H. unfold loads in H. apply andb_true_iff in H. exact (proj1 H).
Qed.

Theorem loads_requires_every_bound :
  forall p t n m, loads p t n m = true ->
    t <= ap_token_array_cap p /\ n <= ap_token_method_name_limit p
    /\ m <= ap_manifest_length_cap p.
Proof.
  intros p t n m H. unfold loads in H.
  apply andb_true_iff in H. destruct H as [_ Hrest].
  apply andb_true_iff in Hrest. destruct Hrest as [Ht Hrest].
  apply andb_true_iff in Hrest. destruct Hrest as [Hn Hm].
  apply Nat.leb_le in Ht. apply Nat.leb_le in Hn. apply Nat.leb_le in Hm.
  auto.
Qed.

Theorem a_count_past_the_token_cap_is_refused :
  forall p t n m, within (ap_token_array_cap p) t = false -> loads p t n m = false.
Proof.
  intros p t n m H. unfold loads. rewrite H. repeat rewrite andb_false_r. reflexivity.
Qed.

Theorem a_name_past_the_limit_is_refused :
  forall p t n m, within (ap_token_method_name_limit p) n = false -> loads p t n m = false.
Proof.
  intros p t n m H. unfold loads. rewrite H. repeat rewrite andb_false_r. reflexivity.
Qed.

Theorem a_manifest_past_the_cap_is_refused :
  forall p t n m, within (ap_manifest_length_cap p) m = false -> loads p t n m = false.
Proof.
  intros p t n m H. unfold loads. rewrite H. repeat rewrite andb_false_r. reflexivity.
Qed.

Theorem the_guards_alone_do_not_admit_a_long_name :
  forall p n, admitted p = true -> within (ap_token_method_name_limit p) n = false ->
    loads p 0 n 0 = false.
Proof.
  intros p n Hg Hn. unfold loads. rewrite Hg. rewrite Hn. repeat rewrite andb_false_r. reflexivity.
Qed.

(** ** The reviewed record *)

Theorem reviewed_program_is_admitted : admitted reviewed_program = true.
Proof. reflexivity. Qed.

Theorem reviewed_program_reads_the_canonical_order :
  ap_steps reviewed_program = canonical_steps.
Proof. reflexivity. Qed.

Theorem reviewed_program_loads_its_declared_maxima :
  loads reviewed_program 128 32 65535 = true.
Proof. vm_compute. reflexivity. Qed.

Theorem one_token_past_the_cap_is_not_loaded :
  loads reviewed_program 129 32 65535 = false.
Proof. vm_compute. reflexivity. Qed.

Theorem a_name_one_past_the_limit_is_not_loaded :
  loads reviewed_program 128 33 65535 = false.
Proof. vm_compute. reflexivity. Qed.

Theorem a_manifest_one_past_the_cap_is_not_loaded :
  loads reviewed_program 128 32 65536 = false.
Proof. vm_compute. reflexivity. Qed.

Theorem an_admitted_program_admits_its_empty_declaration :
  forall p, admitted p = true -> loads p 0 0 0 = true.
Proof.
  intros p H. unfold loads. rewrite H. reflexivity.
Qed.

Theorem the_reordered_reader_admits_the_same_declaration :
  loads swapped_read_program 128 32 65535 = true.
Proof. vm_compute. reflexivity. Qed.

(** * Assumption inventory *)

Print Assumptions all_guards_true.
Print Assumptions all_guards_false.
Print Assumptions an_admitted_program_passes_every_guard.
Print Assumptions a_single_false_guard_refuses.
Print Assumptions every_guard_is_consulted.
Print Assumptions the_magic_is_read_before_the_tokens.
Print Assumptions the_tokens_are_read_before_the_script.
Print Assumptions the_script_is_read_before_the_checksum.
Print Assumptions the_checksum_is_the_last_read.
Print Assumptions the_compiler_is_read_after_the_magic.
Print Assumptions a_reordered_reader_reports_a_different_step_order.
Print Assumptions the_reordered_reader_still_verifies_the_checksum_last.
Print Assumptions the_bound_is_inclusive.
Print Assumptions one_past_the_bound_is_refused.
Print Assumptions raising_the_bound_admits_one_more.
Print Assumptions a_raised_bound_admits_exactly_one_more.
Print Assumptions loads_requires_the_guards.
Print Assumptions loads_requires_every_bound.
Print Assumptions a_count_past_the_token_cap_is_refused.
Print Assumptions a_name_past_the_limit_is_refused.
Print Assumptions a_manifest_past_the_cap_is_refused.
Print Assumptions the_guards_alone_do_not_admit_a_long_name.
Print Assumptions reviewed_program_is_admitted.
Print Assumptions reviewed_program_reads_the_canonical_order.
Print Assumptions reviewed_program_loads_its_declared_maxima.
Print Assumptions one_token_past_the_cap_is_not_loaded.
Print Assumptions a_name_one_past_the_limit_is_not_loaded.
Print Assumptions a_manifest_one_past_the_cap_is_not_loaded.
Print Assumptions an_admitted_program_admits_its_empty_declaration.
Print Assumptions the_reordered_reader_admits_the_same_declaration.
