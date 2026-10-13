(*
  NeoOS formal verification -- structural source ABI projection.

  This is the protocol-level part of the C# -> manifest obligation.  A source
  method is projected to the dispatch key, parameter/return types, safe flag,
  and an entry-point offset.  The model proves that an exact projection cannot
  introduce a hidden method, a duplicate dispatch key, or a changed signature.
  The runtime test supplies the concrete C# reflection and NEF/manifest
  evidence; this file deliberately does not claim compiler correctness.
*)
From Coq Require Import List Bool PeanoNat.
Import ListNotations.

Record SourceMethod : Type := mkSourceMethod {
  source_name : nat;
  source_arity : nat;
  source_return : nat;
  source_safe : bool
}.

Record ManifestMethod : Type := mkManifestMethod {
  manifest_name : nat;
  manifest_arity : nat;
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

Definition project (method : SourceMethod) (offset : nat) : ManifestMethod :=
  mkManifestMethod (source_name method) (source_arity method)
    (source_return method) (source_safe method) offset.

Definition initialize_method : ManifestMethod :=
  mkManifestMethod 0 0 0 false 0.

Definition is_initialize (method : ManifestMethod) : bool :=
  Nat.eqb (manifest_name method) 0 &&
  Nat.eqb (manifest_arity method) 0 &&
  Nat.eqb (manifest_return method) 0 &&
  negb (manifest_safe method).

Definition method_matches_source (manifest : ManifestMethod)
    (source : SourceMethod) : bool :=
  pair_eqb (dispatch_key_manifest manifest) (dispatch_key_source source) &&
  Nat.eqb (manifest_return manifest) (source_return source) &&
  Bool.eqb (manifest_safe manifest) (source_safe source).

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

Lemma projected_descriptor_preserves_signature :
  forall method offset,
    manifest_name (project method offset) = source_name method /\
    manifest_arity (project method offset) = source_arity method /\
    manifest_return (project method offset) = source_return method /\
    manifest_safe (project method offset) = source_safe method.
Proof. intros. repeat split; reflexivity. Qed.

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

Theorem abi_projection_rejects_missing_initializer :
  exact_abi_projection [mkSourceMethod 7 1 2 true]
    [project (mkSourceMethod 7 1 2 true) 10] = false.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_accepts_exact_shape :
  exact_abi_projection [mkSourceMethod 7 1 2 true]
    [project (mkSourceMethod 7 1 2 true) 10; initialize_method] = true.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_rejects_changed_safe_flag :
  exact_abi_projection [mkSourceMethod 7 1 2 true]
    [mkManifestMethod 7 1 2 false 10; initialize_method] = false.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_rejects_duplicate_dispatch_key :
  exact_abi_projection [mkSourceMethod 7 1 2 true]
    [project (mkSourceMethod 7 1 2 true) 10;
     project (mkSourceMethod 7 1 2 true) 20] = false.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_rejects_missing_source_method :
  exact_abi_projection
    [mkSourceMethod 7 1 2 true; mkSourceMethod 8 0 0 false]
    [project (mkSourceMethod 7 1 2 true) 10; initialize_method] = false.
Proof. vm_compute. reflexivity. Qed.

Theorem abi_projection_rejects_extra_manifest_method :
  exact_abi_projection [mkSourceMethod 7 1 2 true]
    [project (mkSourceMethod 7 1 2 true) 10;
     mkManifestMethod 8 0 0 false 20] = false.
Proof. vm_compute. reflexivity. Qed.

Print Assumptions projected_descriptor_preserves_signature.
Print Assumptions exact_projection_has_expected_cardinality.
Print Assumptions abi_projection_rejects_missing_initializer.
Print Assumptions abi_projection_accepts_exact_shape.
Print Assumptions abi_projection_rejects_changed_safe_flag.
Print Assumptions abi_projection_rejects_duplicate_dispatch_key.
Print Assumptions abi_projection_rejects_missing_source_method.
Print Assumptions abi_projection_rejects_extra_manifest_method.
