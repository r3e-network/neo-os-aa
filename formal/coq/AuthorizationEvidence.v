(*
  NeoOS formal verification -- authorization evidence boundary.

  This module makes the protocol obligations at the cryptographic and witness
  boundary explicit without pretending to prove a primitive that is not
  modelled here. [evidence_valid] is an oracle supplied by the relevant Neo
  cryptographic syscall, native witness engine, attestation verifier or proof
  verifier. The theorems prove that an accepted result must still be bound to
  the account, target, nonce and provider, must carry a non-zero replay token,
  and must not reuse a consumed token.

  Consequently this is a closed proof of the protocol's fail-closed binding
  logic, not a proof of ECDSA, WebAuthn, TEE attestation, ZK proof soundness,
  Neo witness-rule evaluation, or the concrete C# implementation of any of
  those primitives.
*)
From Coq Require Import List Bool PeanoNat Lia.
Import ListNotations.

Record Claim : Type := mkClaim {
  claim_account : nat;
  claim_target : nat;
  claim_nonce : nat;
  claim_provider : nat
}.

Record Evidence : Type := mkEvidence {
  evidence_valid : bool;
  evidence_account : nat;
  evidence_target : nat;
  evidence_nonce : nat;
  evidence_provider : nat;
  evidence_nullifier : nat
}.

Definition claim_matches (claim : Claim) (evidence : Evidence) : bool :=
  Nat.eqb (evidence_account evidence) (claim_account claim) &&
  Nat.eqb (evidence_target evidence) (claim_target claim) &&
  Nat.eqb (evidence_nonce evidence) (claim_nonce claim) &&
  Nat.eqb (evidence_provider evidence) (claim_provider claim).

Definition evidence_preconditions (claim : Claim) (evidence : Evidence) : bool :=
  evidence_valid evidence &&
  claim_matches claim evidence &&
  negb (Nat.eqb (evidence_nullifier evidence) 0).

Definition nullifier_fresh (used : list nat) (evidence : Evidence) : bool :=
  negb (existsb (Nat.eqb (evidence_nullifier evidence)) used).

Definition accepts (used : list nat) (claim : Claim) (evidence : Evidence) : bool :=
  evidence_preconditions claim evidence && nullifier_fresh used evidence.

Definition consume (used : list nat) (evidence : Evidence) : list nat :=
  evidence_nullifier evidence :: used.

Theorem accepted_evidence_is_bound :
  forall used claim evidence,
    accepts used claim evidence = true ->
    evidence_valid evidence = true /\
    evidence_account evidence = claim_account claim /\
    evidence_target evidence = claim_target claim /\
    evidence_nonce evidence = claim_nonce claim /\
    evidence_provider evidence = claim_provider claim /\
    evidence_nullifier evidence <> 0 /\
    nullifier_fresh used evidence = true.
Proof.
  intros used claim evidence H.
  unfold accepts, evidence_preconditions, claim_matches in H.
  repeat rewrite andb_true_iff in H.
  destruct H as [[[Hvalid Hmatch] Hnonzero] Hfresh].
  destruct Hmatch as [[[Haccount Htarget] Hnonce] Hprovider].
  apply negb_true_iff in Hnonzero.
  apply Nat.eqb_neq in Hnonzero.
  apply Nat.eqb_eq in Haccount, Htarget, Hnonce, Hprovider.
  repeat split; assumption.
Qed.

Lemma consumed_nullifier_is_not_fresh :
  forall used evidence,
    nullifier_fresh (consume used evidence) evidence = false.
Proof.
  intros used evidence.
  unfold nullifier_fresh, consume.
  simpl.
  rewrite Nat.eqb_refl.
  reflexivity.
Qed.

Theorem accepted_evidence_cannot_be_replayed :
  forall used claim evidence,
    accepts used claim evidence = true ->
    accepts (consume used evidence) claim evidence = false.
Proof.
  intros used claim evidence H.
  unfold accepts.
  rewrite consumed_nullifier_is_not_fresh.
  destruct (evidence_preconditions claim evidence); reflexivity.
Qed.

Theorem accepted_evidence_has_nonzero_nullifier :
  forall used claim evidence,
    accepts used claim evidence = true ->
    evidence_nullifier evidence <> 0.
Proof.
  intros used claim evidence H.
  pose proof (accepted_evidence_is_bound used claim evidence H) as Hbound.
  destruct Hbound as [Hvalid [Haccount [Htarget [Hnonce [Hprovider [Hnonzero Hfresh]]]]]].
  exact Hnonzero.
Qed.

Example valid_bound_evidence :
  accepts []
    (mkClaim 7 11 13 17)
    (mkEvidence true 7 11 13 17 19) = true.
Proof. vm_compute. reflexivity. Qed.

Example wrong_target_rejected :
  accepts []
    (mkClaim 7 11 13 17)
    (mkEvidence true 7 12 13 17 19) = false.
Proof. vm_compute. reflexivity. Qed.

Example zero_nullifier_rejected :
  accepts []
    (mkClaim 7 11 13 17)
    (mkEvidence true 7 11 13 17 0) = false.
Proof. vm_compute. reflexivity. Qed.

Print Assumptions accepted_evidence_is_bound.
Print Assumptions consumed_nullifier_is_not_fresh.
Print Assumptions accepted_evidence_cannot_be_replayed.
Print Assumptions accepted_evidence_has_nonzero_nullifier.
Print Assumptions valid_bound_evidence.
Print Assumptions wrong_target_rejected.
Print Assumptions zero_nullifier_rejected.
