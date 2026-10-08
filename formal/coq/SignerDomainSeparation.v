(*
  NeoOS formal verification -- authorization-domain separation.

  MultiSig can reject duplicate configured signer domains, but that fact does
  not prove that two operators use independent private keys. The protocol
  property enforceable at this boundary is more useful: a signature is valid
  only for the exact authorization domain and payload it was produced for.

  The cryptographic validity of the signature is intentionally outside this
  model. Concrete verifiers remain responsible for proving possession of the
  key; this file proves only the domain and payload binding supplied to that
  primitive.
*)
From Coq Require Import Bool PeanoNat.

Record AuthorizationDomain : Type := mkAuthorizationDomain {
  domain_scheme : nat;
  domain_material : nat
}.

Record AuthorizationSignature : Type := mkAuthorizationSignature {
  signature_domain : AuthorizationDomain;
  signature_payload : nat
}.

Definition signature_matches
    (expected : AuthorizationSignature)
    (actual : AuthorizationSignature) : bool :=
  Nat.eqb (domain_scheme (signature_domain actual))
    (domain_scheme (signature_domain expected)) &&
  Nat.eqb (domain_material (signature_domain actual))
    (domain_material (signature_domain expected)) &&
  Nat.eqb (signature_payload actual) (signature_payload expected).

Theorem signature_match_binds_domain_and_payload :
  forall expected actual,
    signature_matches expected actual = true ->
    signature_domain actual = signature_domain expected /\
    signature_payload actual = signature_payload expected.
Proof.
  intros expected actual H.
  unfold signature_matches in H.
  repeat rewrite andb_true_iff in H.
  destruct H as [[Hscheme Hmaterial] Hpayload].
  apply Nat.eqb_eq in Hscheme, Hmaterial, Hpayload.
  destruct (signature_domain expected) as [expectedScheme expectedMaterial].
  destruct (signature_domain actual) as [actualScheme actualMaterial].
  simpl in Hscheme, Hmaterial.
  subst actualScheme.
  subst actualMaterial.
  split; [reflexivity | exact Hpayload].
Qed.

Theorem different_domains_reject_same_payload :
  forall expected actual,
    signature_payload actual = signature_payload expected ->
    signature_domain actual <> signature_domain expected ->
    signature_matches expected actual = false.
Proof.
  intros expected actual Hpayload Hdomain.
  destruct (signature_matches expected actual) eqn:Hmatch; [|reflexivity].
  exfalso.
  apply Hdomain.
  pose proof (signature_match_binds_domain_and_payload expected actual Hmatch) as Hbound.
  exact (proj1 Hbound).
Qed.

Example cross_domain_replay_is_rejected :
  signature_matches
    (mkAuthorizationSignature (mkAuthorizationDomain 1 7) 99)
    (mkAuthorizationSignature (mkAuthorizationDomain 2 7) 99) = false.
Proof. vm_compute. reflexivity. Qed.

Example same_domain_same_payload_is_accepted_by_the_binding_layer :
  signature_matches
    (mkAuthorizationSignature (mkAuthorizationDomain 1 7) 99)
    (mkAuthorizationSignature (mkAuthorizationDomain 1 7) 99) = true.
Proof. vm_compute. reflexivity. Qed.

Print Assumptions signature_match_binds_domain_and_payload.
Print Assumptions different_domains_reject_same_payload.
Print Assumptions cross_domain_replay_is_rejected.
Print Assumptions same_domain_same_payload_is_accepted_by_the_binding_layer.
