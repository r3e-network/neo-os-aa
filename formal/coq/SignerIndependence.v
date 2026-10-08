(*
  NeoOS formal verification -- signer-domain versus key independence.

  A signer-domain commitment is public configuration data.  It can prove that
  two configured identities are not byte-for-byte equal, but it cannot prove
  that two operators did not deliberately reuse one secret across different
  cryptographic schemes or authority profiles.  This finite countermodel is
  kept in the gate so the implementation and the documentation cannot silently
  promote domain uniqueness into a private-key independence proof.
*)
From Coq Require Import List Bool.
Import ListNotations.

Record Signer : Type := mkSigner {
  signer_secret : nat;
  signer_domain : nat
}.

Fixpoint unique (values : list nat) : bool :=
  match values with
  | [] => true
  | value :: rest => negb (existsb (Nat.eqb value) rest) && unique rest
  end.

Definition domain_unique (signers : list Signer) : bool :=
  unique (map signer_domain signers).

Definition key_independent (signers : list Signer) : bool :=
  unique (map signer_secret signers).

Theorem SID_001_domain_uniqueness_does_not_imply_key_independence :
  exists signers,
    domain_unique signers = true /\ key_independent signers = false.
Proof.
  exists [mkSigner 7 1; mkSigner 7 2].
  split; reflexivity.
Qed.

Theorem SID_002_key_independence_implies_domain_or_explicit_profile_check :
  forall signers,
    key_independent signers = true ->
    unique (map signer_secret signers) = true.
Proof.
  intros signers H. exact H.
Qed.

Example SID_003_distinct_domains_same_secret_is_a_valid_counterexample :
  domain_unique [mkSigner 7 1; mkSigner 7 2] = true /\
  key_independent [mkSigner 7 1; mkSigner 7 2] = false.
Proof. split; reflexivity. Qed.

Print Assumptions SID_001_domain_uniqueness_does_not_imply_key_independence.
Print Assumptions SID_002_key_independence_implies_domain_or_explicit_profile_check.
Print Assumptions SID_003_distinct_domains_same_secret_is_a_valid_counterexample.
