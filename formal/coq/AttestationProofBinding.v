(*
  NeoOS formal verification -- attestation/proof envelope binding.

  This module covers the protocol envelope shared by external attestation and
  zero-knowledge-proof verifiers.  [proof_valid] is deliberately an oracle for
  the concrete verifier: this file does not claim to prove ECDSA, a TEE quote,
  WebAuthn, a ZK circuit, or a pairing-based proof system.  It proves the
  obligations that remain after that primitive returns: the accepted evidence
  is bound to the account, target, nonce, issuer and measurement commitment,
  carries a non-zero nullifier, and cannot be consumed twice.
*)
From Coq Require Import List Bool PeanoNat Lia.
Import ListNotations.

Record Claim : Type := mkClaim {
  claim_account : nat;
  claim_target : nat;
  claim_nonce : nat;
  claim_issuer : nat;
  claim_measurement : nat
}.

Record Proof : Type := mkProof {
  proof_valid : bool;
  proof_account : nat;
  proof_target : nat;
  proof_nonce : nat;
  proof_issuer : nat;
  proof_measurement : nat;
  proof_nullifier : nat
}.

Definition proof_matches (claim : Claim) (proof : Proof) : bool :=
  Nat.eqb (proof_account proof) (claim_account claim) &&
  Nat.eqb (proof_target proof) (claim_target claim) &&
  Nat.eqb (proof_nonce proof) (claim_nonce claim) &&
  Nat.eqb (proof_issuer proof) (claim_issuer claim) &&
  Nat.eqb (proof_measurement proof) (claim_measurement claim).

Definition nullifier_fresh (used : list nat) (proof : Proof) : bool :=
  negb (existsb (Nat.eqb (proof_nullifier proof)) used).

Definition accepts (used : list nat) (claim : Claim) (proof : Proof) : bool :=
  proof_valid proof &&
  proof_matches claim proof &&
  negb (Nat.eqb (proof_nullifier proof) 0) &&
  nullifier_fresh used proof.

Definition consume (used : list nat) (proof : Proof) : list nat :=
  proof_nullifier proof :: used.

Theorem accepted_proof_is_bound :
  forall used claim proof,
    accepts used claim proof = true ->
    proof_valid proof = true /\
    proof_account proof = claim_account claim /\
    proof_target proof = claim_target claim /\
    proof_nonce proof = claim_nonce claim /\
    proof_issuer proof = claim_issuer claim /\
    proof_measurement proof = claim_measurement claim /\
    proof_nullifier proof <> 0 /\
    nullifier_fresh used proof = true.
Proof.
  intros used claim proof H.
  unfold accepts, proof_matches in H.
  repeat rewrite andb_true_iff in H.
  destruct H as [[[Hvalid Hmatch] Hnonzero] Hfresh].
  destruct Hmatch as [[[[Haccount Htarget] Hnonce] Hissuer] Hmeasurement].
  apply negb_true_iff in Hnonzero.
  apply Nat.eqb_neq in Hnonzero.
  apply Nat.eqb_eq in Haccount, Htarget, Hnonce, Hissuer, Hmeasurement.
  repeat split; assumption.
Qed.

Lemma consumed_nullifier_is_not_fresh :
  forall used proof,
    nullifier_fresh (consume used proof) proof = false.
Proof.
  intros used proof.
  unfold nullifier_fresh, consume.
  simpl.
  rewrite Nat.eqb_refl.
  reflexivity.
Qed.

Theorem accepted_proof_cannot_be_replayed :
  forall used claim proof,
    accepts used claim proof = true ->
    accepts (consume used proof) claim proof = false.
Proof.
  intros used claim proof H.
  unfold accepts.
  rewrite consumed_nullifier_is_not_fresh.
  destruct (proof_valid proof && proof_matches claim proof &&
            negb (Nat.eqb (proof_nullifier proof) 0)); reflexivity.
Qed.

Theorem accepted_proof_has_nonzero_nullifier :
  forall used claim proof,
    accepts used claim proof = true -> proof_nullifier proof <> 0.
Proof.
  intros used claim proof H.
  pose proof (accepted_proof_is_bound used claim proof H) as Hbound.
  destruct Hbound as [Hvalid [Haccount [Htarget [Hnonce [Hissuer
    [Hmeasurement [Hnonzero Hfresh]]]]]]].
  exact Hnonzero.
Qed.

Example valid_attestation_or_zk_envelope :
  accepts []
    (mkClaim 7 11 13 17 19)
    (mkProof true 7 11 13 17 19 23) = true.
Proof. vm_compute. reflexivity. Qed.

Example wrong_measurement_is_rejected :
  accepts []
    (mkClaim 7 11 13 17 19)
    (mkProof true 7 11 13 17 20 23) = false.
Proof. vm_compute. reflexivity. Qed.

Example wrong_issuer_is_rejected :
  accepts []
    (mkClaim 7 11 13 17 19)
    (mkProof true 7 11 13 18 19 23) = false.
Proof. vm_compute. reflexivity. Qed.

Print Assumptions accepted_proof_is_bound.
Print Assumptions consumed_nullifier_is_not_fresh.
Print Assumptions accepted_proof_cannot_be_replayed.
Print Assumptions accepted_proof_has_nonzero_nullifier.
Print Assumptions valid_attestation_or_zk_envelope.
Print Assumptions wrong_measurement_is_rejected.
Print Assumptions wrong_issuer_is_rejected.
