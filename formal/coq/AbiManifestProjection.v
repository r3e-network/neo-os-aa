(*
  NeoOS formal verification -- structural source ABI projection.

  This is the protocol-level part of the C# -> manifest obligation. A source
  method is projected to its dispatch key, ordered parameter types, return
  type, safe flag, and an entry-point offset. Explicit arities must agree with
  the parameter lists. The model proves exact descriptor projection, including
  the zero-parameter initializer, without hidden or duplicate dispatch keys.
  Parameter type identifiers are abstract naturals; concrete reflection/type
  encoding, offset validity, and C#/NEF/VM correspondence remain external.
  The runtime test supplies concrete reflection and NEF/manifest evidence;
  this file deliberately does not claim compiler correctness.
*)
From Coq Require Import List Bool PeanoNat.
Import ListNotations.

Record SourceMethod : Type := mkSourceMethod {
  source_name : nat;
  source_arity : nat;
  source_parameter_types : list nat;
  source_return : nat;
  source_safe : bool
}.

Record ManifestMethod : Type := mkManifestMethod {
  manifest_name : nat;
  manifest_arity : nat;
  manifest_parameter_types : list nat;
  manifest_return : nat;
  manifest_safe : bool;
  manifest_offset : nat
}.

Definition dispatch_key_source (method : SourceMethod) : nat * nat :=
  (source_name method, source_arity method).

Definition dispatch_key_manifest (method : ManifestMethod) : nat * nat :=
  (manifest_name method, manifest_arity method).

Definition pair_eqb (left right : nat * nat) : bool :=
  Nat.eqb (fst left) (fst right) && Nat.eqb (snd left) (snd right).

Fixpoint parameter_types_eqb (left right : list nat) : bool :=
  match left, right with
  | [], [] => true
  | l :: ls, r :: rs => Nat.eqb l r && parameter_types_eqb ls rs
  | _, _ => false
  end.

Definition source_descriptor_valid (method : SourceMethod) : bool :=
  Nat.eqb (source_arity method) (length (source_parameter_types method)).

Definition manifest_descriptor_valid (method : ManifestMethod) : bool :=
  Nat.eqb (manifest_arity method) (length (manifest_parameter_types method)).

Definition project (method : SourceMethod) (offset : nat) : ManifestMethod :=
  mkManifestMethod (source_name method) (source_arity method)
    (source_parameter_types method) (source_return method)
    (source_safe method) offset.

Definition initialize_method : ManifestMethod :=
  mkManifestMethod 0 0 [] 0 false 0.

(* Initializer offsets depend on bytecode layout, so no fixed offset is required. *)
Definition is_initialize (method : ManifestMethod) : bool :=
  Nat.eqb (manifest_name method) 0 &&
  Nat.eqb (manifest_arity method) 0 &&
  parameter_types_eqb (manifest_parameter_types method) [] &&
  Nat.eqb (manifest_return method) 0 &&
  negb (manifest_safe method).

Definition method_matches_source (manifest : ManifestMethod)
    (source : SourceMethod) : bool :=
  source_descriptor_valid source &&
  manifest_descriptor_valid manifest &&
  pair_eqb (dispatch_key_manifest manifest) (dispatch_key_source source) &&
  parameter_types_eqb (manifest_parameter_types manifest)
    (source_parameter_types source) &&
  Nat.eqb (manifest_return manifest) (source_return source) &&
  Bool.eqb (manifest_safe manifest) (source_safe source).

Definition signature_preserved (manifest : ManifestMethod)
    (source : SourceMethod) : Prop :=
  manifest_name manifest = source_name source /\
  manifest_arity manifest = source_arity source /\
  manifest_parameter_types manifest = source_parameter_types source /\
  manifest_return manifest = source_return source /\
  manifest_safe manifest = source_safe source.

Fixpoint unique_keys (keys : list (nat * nat)) : bool :=
  match keys with
  | [] => true
  | key :: rest => negb (existsb (pair_eqb key) rest) && unique_keys rest
  end.

Definition manifest_methods_match (source : list SourceMethod)
    (manifest : list ManifestMethod) : bool :=
  forallb (fun method =>
    is_initialize method ||
    existsb (method_matches_source method) source) manifest.

Definition source_methods_match (source : list SourceMethod)
    (manifest : list ManifestMethod) : bool :=
  forallb (fun method =>
    existsb (fun candidate => method_matches_source candidate method) manifest)
    source.

Definition exact_abi_projection (source : list SourceMethod)
    (manifest : list ManifestMethod) : bool :=
  manifest_methods_match source manifest &&
  source_methods_match source manifest &&
  unique_keys (map dispatch_key_source source) &&
  unique_keys (map dispatch_key_manifest manifest) &&
  Nat.eqb (length manifest) (S (length source)).

Lemma parameter_types_eqb_eq : forall left right,
  parameter_types_eqb left right = true -> left = right.
Proof.
  induction left as [|l ls IH]; intros [|r rs] H; simpl in H;
    try discriminate; [reflexivity|].
  apply andb_true_iff in H as [Hhead Htail].
  apply Nat.eqb_eq in Hhead. apply IH in Htail. now subst.
Qed.

Lemma projected_descriptor_preserves_signature :
  forall method offset,
    signature_preserved (project method offset) method.
Proof. intros. repeat split; reflexivity. Qed.

Lemma matching_descriptor_preserves_signature :
  forall manifest source,
    method_matches_source manifest source = true ->
    signature_preserved manifest source.
Proof.
  intros manifest source H.
  unfold method_matches_source in H.
  repeat rewrite andb_true_iff in H.
  destruct H as [[[[[Hsource Hmanifest] Hkey] Hparameters] Hreturn] Hsafe].
  unfold pair_eqb, dispatch_key_manifest, dispatch_key_source in Hkey.
  simpl in Hkey. apply andb_true_iff in Hkey as [Hname Harity].
  apply Nat.eqb_eq in Hname, Harity, Hreturn.
  apply parameter_types_eqb_eq in Hparameters.
  apply eqb_prop in Hsafe.
  unfold signature_preserved. repeat split; assumption.
Qed.

Lemma matching_descriptor_has_consistent_arities :
  forall manifest source,
    method_matches_source manifest source = true ->
    source_arity source = length (source_parameter_types source) /\
    manifest_arity manifest = length (manifest_parameter_types manifest).
Proof.
  intros manifest source H.
  unfold method_matches_source in H.
  repeat rewrite andb_true_iff in H.
  destruct H as [[[[[Hsource Hmanifest] _] _] _] _].
  unfold source_descriptor_valid in Hsource.
  unfold manifest_descriptor_valid in Hmanifest.
  split; now apply Nat.eqb_eq.
Qed.

Lemma initializer_has_exact_signature : forall manifest,
  is_initialize manifest = true ->
  manifest_name manifest = 0 /\ manifest_arity manifest = 0 /\
  manifest_parameter_types manifest = [] /\
  manifest_return manifest = 0 /\ manifest_safe manifest = false.
Proof.
  intros manifest H. unfold is_initialize in H.
  repeat rewrite andb_true_iff in H.
  destruct H as [[[[Hname Harity] Hparameters] Hreturn] Hsafe].
  apply Nat.eqb_eq in Hname, Harity, Hreturn.
  apply parameter_types_eqb_eq in Hparameters.
  apply negb_true_iff in Hsafe.
  repeat split; assumption.
Qed.

Lemma exact_projection_has_expected_cardinality :
  forall source manifest,
    exact_abi_projection source manifest = true ->
    length manifest = S (length source).
Proof.
  intros source manifest H.
  unfold exact_abi_projection in H.
  apply Nat.eqb_eq.
  repeat (apply andb_true_iff in H; destruct H as [_ H]).
  exact H.
Qed.

Theorem exact_projection_preserves_source_signatures :
  forall source manifest method,
    exact_abi_projection source manifest = true -> In method source ->
    exists candidate, In candidate manifest /\
      signature_preserved candidate method /\
      source_arity method = length (source_parameter_types method) /\
      manifest_arity candidate = length (manifest_parameter_types candidate).
Proof.
  intros source manifest method H Hin.
  unfold exact_abi_projection in H.
  repeat rewrite andb_true_iff in H.
  destruct H as [[[[_ Hsource] _] _] _].
  unfold source_methods_match in Hsource.
  rewrite forallb_forall in Hsource.
  specialize (Hsource method Hin).
  apply existsb_exists in Hsource as [candidate [Hmember Hmatches]].
  exists candidate. split; [exact Hmember|]. split.
  - now apply matching_descriptor_preserves_signature.
  - now apply matching_descriptor_has_consistent_arities.
Qed.

Theorem exact_projection_manifest_is_initializer_or_source_signature :
  forall source manifest candidate,
    exact_abi_projection source manifest = true -> In candidate manifest ->
    is_initialize candidate = true \/
    exists method, In method source /\ signature_preserved candidate method.
Proof.
  intros source manifest candidate H Hin.
  unfold exact_abi_projection in H.
  repeat rewrite andb_true_iff in H.
  destruct H as [[[[Hmanifest _] _] _] _].
  unfold manifest_methods_match in Hmanifest.
  rewrite forallb_forall in Hmanifest.
  specialize (Hmanifest candidate Hin).
  apply orb_true_iff in Hmanifest as [Hinit|Hsource]; [now left|right].
  apply existsb_exists in Hsource as [method [Hmember Hmatches]].
  exists method. split; [exact Hmember|].
  now apply matching_descriptor_preserves_signature.
Qed.

Theorem abi_projection_rejects_missing_initializer :
  exact_abi_projection [mkSourceMethod 7 1 [11] 2 true]
    [project (mkSourceMethod 7 1 [11] 2 true) 10] = false.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_accepts_exact_shape :
  exact_abi_projection [mkSourceMethod 7 1 [11] 2 true]
    [project (mkSourceMethod 7 1 [11] 2 true) 10; initialize_method] = true.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_accepts_ordered_parameters :
  exact_abi_projection [mkSourceMethod 7 2 [11; 22] 2 true]
    [project (mkSourceMethod 7 2 [11; 22] 2 true) 10;
     mkManifestMethod 0 0 [] 0 false 30] = true.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_rejects_retyped_parameter :
  exact_abi_projection [mkSourceMethod 7 1 [11] 2 true]
    [mkManifestMethod 7 1 [22] 2 true 10; initialize_method] = false.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_rejects_reordered_parameters :
  exact_abi_projection [mkSourceMethod 7 2 [11; 22] 2 true]
    [mkManifestMethod 7 2 [22; 11] 2 true 10; initialize_method] = false.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_rejects_malformed_source_arity :
  exact_abi_projection [mkSourceMethod 7 2 [11] 2 true]
    [project (mkSourceMethod 7 2 [11] 2 true) 10; initialize_method] = false.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_rejects_malformed_manifest_arity :
  exact_abi_projection [mkSourceMethod 7 1 [11] 2 true]
    [mkManifestMethod 7 1 [11; 22] 2 true 10; initialize_method] = false.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_rejects_initializer_parameters :
  exact_abi_projection [mkSourceMethod 7 1 [11] 2 true]
    [project (mkSourceMethod 7 1 [11] 2 true) 10;
     mkManifestMethod 0 0 [11] 0 false 0] = false.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_rejects_changed_safe_flag :
  exact_abi_projection [mkSourceMethod 7 1 [11] 2 true]
    [mkManifestMethod 7 1 [11] 2 false 10; initialize_method] = false.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_rejects_duplicate_dispatch_key :
  exact_abi_projection [mkSourceMethod 7 1 [11] 2 true]
    [project (mkSourceMethod 7 1 [11] 2 true) 10;
     project (mkSourceMethod 7 1 [11] 2 true) 20] = false.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_rejects_missing_source_method :
  exact_abi_projection
    [mkSourceMethod 7 1 [11] 2 true; mkSourceMethod 8 0 [] 0 false]
    [project (mkSourceMethod 7 1 [11] 2 true) 10; initialize_method] = false.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_rejects_extra_manifest_method :
  exact_abi_projection [mkSourceMethod 7 1 [11] 2 true]
    [project (mkSourceMethod 7 1 [11] 2 true) 10;
     mkManifestMethod 8 0 [] 0 false 20] = false.
Proof. vm_compute. reflexivity. Qed.

Print Assumptions parameter_types_eqb_eq.
Print Assumptions projected_descriptor_preserves_signature.
Print Assumptions matching_descriptor_preserves_signature.
Print Assumptions matching_descriptor_has_consistent_arities.
Print Assumptions initializer_has_exact_signature.
Print Assumptions exact_projection_has_expected_cardinality.
Print Assumptions exact_projection_preserves_source_signatures.
Print Assumptions exact_projection_manifest_is_initializer_or_source_signature.
Print Assumptions abi_projection_rejects_missing_initializer.
Print Assumptions abi_projection_accepts_exact_shape.
Print Assumptions abi_projection_accepts_ordered_parameters.
Print Assumptions abi_projection_rejects_retyped_parameter.
Print Assumptions abi_projection_rejects_reordered_parameters.
Print Assumptions abi_projection_rejects_malformed_source_arity.
Print Assumptions abi_projection_rejects_malformed_manifest_arity.
Print Assumptions abi_projection_rejects_initializer_parameters.
Print Assumptions abi_projection_rejects_changed_safe_flag.
Print Assumptions abi_projection_rejects_duplicate_dispatch_key.
Print Assumptions abi_projection_rejects_missing_source_method.
Print Assumptions abi_projection_rejects_extra_manifest_method.
