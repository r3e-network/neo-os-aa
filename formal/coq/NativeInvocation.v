(*
  Frame-bound SmartAccount callback authority. Frame tokens and caller facts are
  abstract inputs; this is not a proof of C# context identity, witness evaluation,
  registered native service behavior, or complete NeoVM refinement.
*)
From Coq Require Import List Bool PeanoNat Lia.
Import ListNotations.

Record Grant := mkGrant {
  account : nat; root : nat; frame : nat; kind : nat; phase : nat;
  children : list nat
}.
Definition may_delegate (p : nat) : bool := p <? 3.
Definition module_authorized (g : Grant) (a k p script current parent : nat)
    (deployed core_query : bool) : bool :=
  deployed && core_query && (k <? 2) && (k =? kind g) &&
  (a =? account g) && (p =? phase g) &&
  (((script =? root g) && (current =? frame g)) ||
   (may_delegate (phase g) && existsb (Nat.eqb script) (children g) &&
    (parent =? frame g))).
Definition on_fault (_ : option Grant) : option Grant := None.
Definition witness_authorized (grant original_witness : bool) : bool :=
  grant && original_witness.

(* Native module entry checks the fixed service before accepting an authenticated
   phase grant. Addresses and the query result remain abstract, not compiler or
   cryptographic evidence. *)
Definition native_module_entry (configured expected : nat) (context : bool) : bool :=
  (configured =? expected) && context.

(* The successful legacy witness evaluation is an abstract input. In particular,
   it includes Neo's immediate-caller shortcut. An Application proxy restriction
   is represented by registered_proxy; full WitnessRule/NeoVM semantics and the
   correspondence from runtime frames to these facts are separate obligations. *)
Definition service_witness (active service registered_proxy target_frame legacy : bool) : bool :=
  if active then negb service &&
    (if registered_proxy then target_frame && legacy else legacy)
  else legacy.

Theorem module_rejects_wrong_service : forall configured expected context,
  configured <> expected -> native_module_entry configured expected context = false.
Proof.
  intros. unfold native_module_entry.
  apply Nat.eqb_neq in H. rewrite H. reflexivity.
Qed.

Theorem module_requires_context : forall configured expected,
  native_module_entry configured expected false = false.
Proof. intros. unfold native_module_entry. apply andb_false_r. Qed.

Theorem module_matching_context_is_reachable : forall service,
  native_module_entry service service true = true.
Proof. intros. unfold native_module_entry. rewrite Nat.eqb_refl. reflexivity. Qed.

Print Assumptions module_rejects_wrong_service.
Print Assumptions module_requires_context.
Print Assumptions module_matching_context_is_reachable.

Theorem wrong_account_is_rejected : forall g a k p s c r d q,
  a <> account g -> module_authorized g a k p s c r d q = false.
Proof.
  intros. unfold module_authorized.
  assert ((a =? account g) = false) as E by (apply Nat.eqb_neq; assumption).
  rewrite E. repeat rewrite andb_false_r. reflexivity.
Qed.

Theorem wrong_phase_is_rejected : forall g a k p s c r d q,
  p <> phase g -> module_authorized g a k p s c r d q = false.
Proof.
  intros. unfold module_authorized.
  assert ((p =? phase g) = false) as E by (apply Nat.eqb_neq; assumption).
  rewrite E. repeat rewrite andb_false_r. reflexivity.
Qed.

Theorem same_hash_new_frame_is_not_root_authority : forall g a k p c r d q,
  children g = [] -> c <> frame g ->
  module_authorized g a k p (root g) c r d q = false.
Proof.
  intros g a k p c r d q Empty Different. unfold module_authorized.
  assert ((c =? frame g) = false) as E by (apply Nat.eqb_neq; assumption).
  rewrite Empty, E. simpl. repeat rewrite andb_false_r. reflexivity.
Qed.

Theorem grandchild_is_rejected : forall g a k p s c r d q,
  s <> root g -> r <> frame g -> module_authorized g a k p s c r d q = false.
Proof.
  intros. unfold module_authorized.
  assert ((s =? root g) = false) as E by (apply Nat.eqb_neq; assumption).
  assert ((r =? frame g) = false) as R by (apply Nat.eqb_neq; assumption).
  rewrite E, R. simpl. repeat rewrite andb_false_r. reflexivity.
Qed.

Theorem target_does_not_authorize_modules : forall g a k p s c r d q,
  kind g = 2 -> module_authorized g a k p s c r d q = false.
Proof.
  intros g a k p s c r d q K. apply Bool.not_true_is_false.
  intro H. unfold module_authorized in H.
  repeat rewrite andb_true_iff in H.
  repeat match goal with X : _ /\ _ |- _ => destruct X end.
  match goal with X : (k <? 2) = true |- _ => apply Nat.ltb_lt in X end.
  match goal with X : (k =? kind g) = true |- _ => apply Nat.eqb_eq in X end.
  lia.
Qed.

Theorem fault_clears_all_authority : forall active, on_fault active = None.
Proof. reflexivity. Qed.

Theorem configuration_does_not_delegate : forall g a k p s c r d q,
  phase g = 3 -> s <> root g -> module_authorized g a k p s c r d q = false.
Proof.
  intros g a k p s c r d q P Different. unfold module_authorized.
  assert ((s =? root g) = false) as E by (apply Nat.eqb_neq; assumption).
  rewrite E, P. unfold may_delegate. simpl. apply andb_false_r.
Qed.

Theorem witness_needs_original_witness : forall grant,
  witness_authorized grant false = false.
Proof. intros. unfold witness_authorized. apply andb_false_r. Qed.

Theorem undeployed_caller_is_rejected : forall g a k p s c r q,
  module_authorized g a k p s c r false q = false.
Proof. reflexivity. Qed.

Theorem non_core_query_is_rejected : forall g a k p s c r d,
  module_authorized g a k p s c r d false = false.
Proof. intros. unfold module_authorized. rewrite andb_false_r. reflexivity. Qed.

Theorem direct_root_is_reachable : forall g,
  kind g < 2 -> module_authorized g (account g) (kind g) (phase g)
     (root g) (frame g) 0 true true = true.
Proof.
  intros g K. unfold module_authorized.
  assert ((kind g <? 2) = true) as E by (apply Nat.ltb_lt; assumption).
  rewrite E. repeat rewrite Nat.eqb_refl. reflexivity.
Qed.

Example direct_leaf_is_reachable :
  module_authorized (mkGrant 1 3 100 0 0 [4]) 1 0 0 4 101 100 true true = true.
Proof. reflexivity. Qed.

Print Assumptions wrong_account_is_rejected.
Print Assumptions wrong_phase_is_rejected.
Print Assumptions same_hash_new_frame_is_not_root_authority.
Print Assumptions grandchild_is_rejected.
Print Assumptions target_does_not_authorize_modules.
Print Assumptions fault_clears_all_authority.
Print Assumptions configuration_does_not_delegate.
Print Assumptions witness_needs_original_witness.
Print Assumptions undeployed_caller_is_rejected.
Print Assumptions non_core_query_is_rejected.
Print Assumptions direct_root_is_reachable.
Print Assumptions direct_leaf_is_reachable.

Theorem inactive_service_preserves_legacy : forall service proxy frame legacy,
  service_witness false service proxy frame legacy = legacy.
Proof. reflexivity. Qed.

Theorem dispatcher_never_supplies_a_witness : forall proxy frame legacy,
  service_witness true true proxy frame legacy = false.
Proof. reflexivity. Qed.

Theorem registered_proxy_requires_frame : forall service legacy,
  service_witness true service true false legacy = false.
Proof. intros []; reflexivity. Qed.

Theorem registered_proxy_requires_legacy_witness : forall service frame,
  service_witness true service true frame false = false.
Proof. intros [] []; reflexivity. Qed.

Theorem unregistered_nonservice_preserves_legacy : forall frame legacy,
  service_witness true false false frame legacy = legacy.
Proof. reflexivity. Qed.

Theorem authorized_proxy_is_reachable :
  service_witness true false true true true = true.
Proof. reflexivity. Qed.

Print Assumptions inactive_service_preserves_legacy.
Print Assumptions dispatcher_never_supplies_a_witness.
Print Assumptions registered_proxy_requires_frame.
Print Assumptions registered_proxy_requires_legacy_witness.
Print Assumptions unregistered_nonservice_preserves_legacy.
Print Assumptions authorized_proxy_is_reachable.
