(*
  Native SmartAccount lifecycle authority and configuration-nonce invalidation.
  The historical field named epoch below is configurationNonce, not ABI 2's
  separate authorityEpoch. NativeAuthorityEpoch.v models the latter and the
  callback-free recovery transition; this module covers only the stated
  authority, status, counter and pending-intent projections. The four-slot
  authority projection additionally models new-recipient consent and the
  exclusion of registered proxies, including pending destinations. Prior-state
  membership represents retained admission consent, not a historical allowlist.
  Structural decoding and the prior state having been validly admitted remain
  external obligations. Future-proxy exclusion is conditional on a false witness;
  witness soundness and cryptographic address disjointness are not proved here.
  Witness results are assumptions supplied by an abstract caller, not proofs
  of Neo witness evaluation. This model does not claim C# refinement, callback
  cleanup, ledger rollback, or complete native-contract semantics.
*)
From Coq Require Import ZArith Bool Lia List.
Import ListNotations.
Open Scope Z_scope.

Record State := mkState {
  active : bool;
  has_recovery : bool;
  epoch : Z;
  pending_verifier : bool;
  pending_hook : bool;
  pending_address : bool;
  pending_recovery : bool
}.
Definition epoch_limit : Z := 2 ^ 64.
Definition configuration_allowed (s : State) : bool :=
  active s && negb (pending_recovery s).
Definition unfreeze_allowed (s : State) (custody recovery : bool) : bool :=
  negb (active s) && custody && (negb (has_recovery s) || recovery).
Definition cancel_recovery_allowed (s : State) (now maturity : Z)
    (custody recovery : bool) : bool :=
  pending_recovery s &&
    ((has_recovery s && recovery) || (custody && (now <? maturity))).
Definition advance (s : State) : option State :=
  if (0 <=? epoch s) && (epoch s <? epoch_limit - 1) then
    Some (mkState (active s) (has_recovery s) (epoch s + 1)
                  false false false false)
  else None.

(* Post-callback binding observations are abstract code/admission identities.
   Store is the entire staged snapshot, including epoch, roster, module writes
   and notifications; this models transaction selection, not NeoVM rollback. *)
Definition configuration_bindings_match (root_pin child_pin : Z)
    (root_now child_now : option Z) : bool :=
  match root_now, child_now with
  | Some r, Some c => Z.eqb r root_pin && Z.eqb c child_pin
  | _, _ => false
  end.

Definition finalize_configuration {Store : Type} (before staged : Store)
    (root_pin child_pin : Z) (root_now child_now : option Z) : bool * Store :=
  if configuration_bindings_match root_pin child_pin root_now child_now
  then (true, staged) else (false, before).

(* Membership gives this bounded list set semantics: duplicate roles do not
   introduce a new address. Zero is an absent authority, including empty intents.
   The booleans supplied to this projection are observations; no callback, signer
   validation, registered-proxy lookup or hashing implementation is modeled. *)
Record AuthorityProjection := mkAuthorityProjection {
  custody_authority : Z;
  recovery_authority : Z;
  pending_rotation_authority : option Z;
  pending_custody_authority : option Z
}.
Definition optional_authority (address : option Z) : Z :=
  match address with Some value => value | None => 0 end.
Definition authority_slots (s : AuthorityProjection) : list Z :=
  [custody_authority s; recovery_authority s;
   optional_authority (pending_rotation_authority s);
   optional_authority (pending_custody_authority s)].
Definition authority_addresses (s : AuthorityProjection) : list Z :=
  filter (fun address => negb (Z.eqb address 0)) (authority_slots s).
Definition authority_member (s : AuthorityProjection) (address : Z) : bool :=
  existsb (Z.eqb address) (authority_addresses s).
Definition authority_admission (registered_proxy witnessed : Z -> bool)
    (prior next : AuthorityProjection) : bool :=
  forallb (fun address => negb (registered_proxy address) &&
    (authority_member prior address || witnessed address))
    (authority_addresses next).
Definition empty_authorities : AuthorityProjection :=
  mkAuthorityProjection 0 0 None None.

Theorem pending_recovery_blocks_configuration : forall s,
  pending_recovery s = true -> configuration_allowed s = false.
Proof. intros s H. unfold configuration_allowed. rewrite H. apply andb_false_r. Qed.

Theorem frozen_blocks_configuration : forall s,
  active s = false -> configuration_allowed s = false.
Proof. intros s H. unfold configuration_allowed. rewrite H. reflexivity. Qed.

Theorem configuration_requires_active_and_no_recovery : forall s,
  configuration_allowed s = true -> active s = true /\ pending_recovery s = false.
Proof.
  intros s H. unfold configuration_allowed in H.
  apply andb_true_iff in H. destruct H as [Hactive Hrecovery].
  apply negb_true_iff in Hrecovery. auto.
Qed.

Theorem joint_unfreeze_requires_recovery : forall s custody,
  has_recovery s = true -> unfreeze_allowed s custody false = false.
Proof.
  intros s custody H. unfold unfreeze_allowed. rewrite H.
  simpl. apply andb_false_r.
Qed.

Theorem unfreeze_requires_custody : forall s recovery,
  unfreeze_allowed s false recovery = false.
Proof. intros. unfold unfreeze_allowed. rewrite andb_false_r. reflexivity. Qed.

Theorem custody_cannot_cancel_at_maturity : forall s now maturity,
  maturity <= now -> cancel_recovery_allowed s now maturity true false = false.
Proof.
  intros s now maturity H. unfold cancel_recovery_allowed.
  assert ((now <? maturity) = false) as Htime by (apply Z.ltb_ge; lia).
  rewrite Htime, andb_false_r. simpl. apply andb_false_r.
Qed.

Theorem recovery_can_cancel_after_maturity : forall s now maturity,
  pending_recovery s = true -> has_recovery s = true ->
  cancel_recovery_allowed s now maturity false true = true.
Proof. intros s now maturity Hp Hr. unfold cancel_recovery_allowed. rewrite Hp, Hr. reflexivity. Qed.

Theorem advance_clears_all_intents : forall s next,
  advance s = Some next ->
  pending_verifier next = false /\ pending_hook next = false /\
  pending_address next = false /\ pending_recovery next = false.
Proof.
  intros s next H. unfold advance in H.
  destruct ((0 <=? epoch s) && (epoch s <? epoch_limit - 1));
    inversion H; subst; simpl; auto.
Qed.

Theorem advance_increments_exactly_once : forall s next,
  advance s = Some next -> epoch next = epoch s + 1.
Proof.
  intros s next H. unfold advance in H.
  destruct ((0 <=? epoch s) && (epoch s <? epoch_limit - 1));
    inversion H; subst; reflexivity.
Qed.

Theorem advance_preserves_status_and_recovery : forall s next,
  advance s = Some next -> active next = active s /\ has_recovery next = has_recovery s.
Proof.
  intros s next H. unfold advance in H.
  destruct ((0 <=? epoch s) && (epoch s <? epoch_limit - 1));
    inversion H; subst; auto.
Qed.

Theorem exhausted_epoch_is_rejected : forall s,
  epoch s = epoch_limit - 1 -> advance s = None.
Proof. intros s H. unfold advance. rewrite H, Z.ltb_irrefl, andb_false_r. reflexivity. Qed.

Theorem advance_stays_in_uint64 : forall s next,
  advance s = Some next -> 0 <= epoch next < epoch_limit.
Proof.
  intros s next H. unfold advance in H.
  destruct ((0 <=? epoch s) && (epoch s <? epoch_limit - 1)) eqn:E; try discriminate.
  apply andb_true_iff in E. destruct E as [El Eu].
  apply Z.leb_le in El. apply Z.ltb_lt in Eu.
  inversion H; subst; simpl. lia.
Qed.

Example custody_can_cancel_strictly_before_maturity :
  cancel_recovery_allowed (mkState true true 0 false false false true) 99 100 true false = true.
Proof. reflexivity. Qed.

Example recovery_free_frozen_account_can_unfreeze :
  unfreeze_allowed (mkState false false 0 false false false false) true false = true.
Proof. reflexivity. Qed.

Print Assumptions pending_recovery_blocks_configuration.
Print Assumptions frozen_blocks_configuration.
Print Assumptions configuration_requires_active_and_no_recovery.
Print Assumptions joint_unfreeze_requires_recovery.
Print Assumptions unfreeze_requires_custody.
Print Assumptions custody_cannot_cancel_at_maturity.
Print Assumptions recovery_can_cancel_after_maturity.
Print Assumptions advance_clears_all_intents.
Print Assumptions advance_increments_exactly_once.
Print Assumptions advance_preserves_status_and_recovery.
Print Assumptions exhausted_epoch_is_rejected.
Print Assumptions advance_stays_in_uint64.
Print Assumptions custody_can_cancel_strictly_before_maturity.
Print Assumptions recovery_free_frozen_account_can_unfreeze.

Theorem configuration_missing_root_rolls_back : forall (Store : Type)
    (before staged : Store) rp cp child,
  finalize_configuration before staged rp cp None child = (false, before).
Proof. intros. unfold finalize_configuration, configuration_bindings_match. reflexivity. Qed.

Theorem configuration_missing_child_rolls_back : forall (Store : Type)
    (before staged : Store) rp cp root,
  finalize_configuration before staged rp cp root None = (false, before).
Proof. intros. destruct root; reflexivity. Qed.

Theorem configuration_changed_root_rolls_back : forall (Store : Type)
    (before staged : Store) rp cp root child,
  root <> rp -> finalize_configuration before staged rp cp (Some root) child = (false, before).
Proof.
  intros. unfold finalize_configuration, configuration_bindings_match. destruct child; [|reflexivity].
  assert (Z.eqb root rp = false) as E by (apply Z.eqb_neq; assumption).
  rewrite E. reflexivity.
Qed.

Theorem configuration_changed_child_rolls_back : forall (Store : Type)
    (before staged : Store) rp cp root child,
  child <> cp -> finalize_configuration before staged rp cp root (Some child) = (false, before).
Proof.
  intros. unfold finalize_configuration, configuration_bindings_match. destruct root; [|reflexivity].
  assert (Z.eqb child cp = false) as E by (apply Z.eqb_neq; assumption).
  rewrite E, andb_false_r. reflexivity.
Qed.

Theorem configuration_success_preserves_pins : forall (Store : Type)
    (before staged : Store) rp cp root child,
  fst (finalize_configuration before staged rp cp root child) = true ->
  root = Some rp /\ child = Some cp.
Proof.
  intros Store before staged rp cp root child H.
  unfold finalize_configuration in H.
  destruct (configuration_bindings_match rp cp root child) eqn:E; [|discriminate].
  unfold configuration_bindings_match in E.
  destruct root, child; try discriminate.
  apply andb_true_iff in E. destruct E as [R C].
  apply Z.eqb_eq in R. apply Z.eqb_eq in C. subst. auto.
Qed.

Theorem configuration_failure_keeps_entire_snapshot : forall (Store : Type)
    (before staged : Store) rp cp root child,
  fst (finalize_configuration before staged rp cp root child) = false ->
  snd (finalize_configuration before staged rp cp root child) = before.
Proof.
  intros Store before staged rp cp root child H.
  unfold finalize_configuration in *.
  destruct (configuration_bindings_match rp cp root child); [discriminate|reflexivity].
Qed.

Theorem configuration_matching_pins_commits : forall (Store : Type)
    (before staged : Store) rp cp,
  finalize_configuration before staged rp cp (Some rp) (Some cp) = (true, staged).
Proof.
  intros. unfold finalize_configuration, configuration_bindings_match.
  repeat rewrite Z.eqb_refl. reflexivity.
Qed.

Example selected_only_check_is_insufficient :
  Z.eqb 7 7 = true /\ finalize_configuration 0 1 5 7 None (Some 7) = (false, 0).
Proof. split; reflexivity. Qed.

Print Assumptions configuration_missing_root_rolls_back.
Print Assumptions configuration_missing_child_rolls_back.
Print Assumptions configuration_changed_root_rolls_back.
Print Assumptions configuration_changed_child_rolls_back.
Print Assumptions configuration_success_preserves_pins.
Print Assumptions configuration_failure_keeps_entire_snapshot.
Print Assumptions configuration_matching_pins_commits.
Print Assumptions selected_only_check_is_insufficient.

Theorem authority_address_membership : forall s address,
  In address (authority_addresses s) <->
    In address (authority_slots s) /\ address <> 0.
Proof.
  intros s address. unfold authority_addresses. rewrite filter_In.
  rewrite negb_true_iff, Z.eqb_neq. reflexivity.
Qed.

Theorem authority_projection_is_bounded : forall s,
  (length (authority_addresses s) <= 4)%nat.
Proof.
  intros s. unfold authority_addresses.
  pose proof (filter_length_le (fun address => negb (Z.eqb address 0)) (authority_slots s)) as H.
  unfold authority_slots in H. simpl in H. exact H.
Qed.

Theorem zero_authority_is_exempt : forall s,
  ~ In 0 (authority_addresses s).
Proof.
  intros s H. apply authority_address_membership in H. tauto.
Qed.

Theorem authority_member_is_membership : forall s address,
  authority_member s address = true <-> In address (authority_addresses s).
Proof.
  intros s address. unfold authority_member. rewrite existsb_exists.
  split.
  - intros [value [Hin Heq]]. apply Z.eqb_eq in Heq. subst value. exact Hin.
  - intros Hin. exists address. split; [exact Hin|apply Z.eqb_refl].
Qed.

Theorem admission_checks_every_next_address : forall registered witnessed prior next address,
  authority_admission registered witnessed prior next = true ->
  In address (authority_addresses next) ->
  registered address = false /\
    (In address (authority_addresses prior) \/ witnessed address = true).
Proof.
  intros registered witnessed prior next address Hadmit Hin.
  unfold authority_admission in Hadmit.
  apply forallb_forall with (x := address) in Hadmit; [|exact Hin].
  apply andb_true_iff in Hadmit as [Hproxy Hconsent].
  apply negb_true_iff in Hproxy. split; [exact Hproxy|].
  apply orb_true_iff in Hconsent as [Hprior|Hwitness]; [left|right].
  - apply authority_member_is_membership. exact Hprior.
  - exact Hwitness.
Qed.

Theorem admission_requires_new_recipient_witness : forall registered witnessed prior next address,
  authority_admission registered witnessed prior next = true ->
  In address (authority_addresses next) ->
  ~ In address (authority_addresses prior) ->
  witnessed address = true.
Proof.
  intros registered witnessed prior next address Hadmit Hin Hnew.
  pose proof (admission_checks_every_next_address _ _ _ _ _ Hadmit Hin) as [_ Hconsent].
  destruct Hconsent as [Hprior|Hwitness]; [contradiction|exact Hwitness].
Qed.

Theorem retained_authorities_need_no_new_witness : forall registered witnessed prior next,
  (forall address, In address (authority_addresses next) -> registered address = false) ->
  (forall address, In address (authority_addresses next) -> In address (authority_addresses prior)) ->
  authority_admission registered witnessed prior next = true.
Proof.
  intros registered witnessed prior next Hproxy Hprior.
  unfold authority_admission. apply forallb_forall. intros address Hin.
  rewrite (Hproxy address Hin). simpl.
  assert (authority_member prior address = true) as Hmember.
  { apply authority_member_is_membership. apply Hprior. exact Hin. }
  rewrite Hmember. reflexivity.
Qed.

Theorem admission_accepts_consented_nonproxy_addresses : forall registered witnessed prior next,
  (forall address, In address (authority_addresses next) -> registered address = false) ->
  (forall address, In address (authority_addresses next) ->
    ~ In address (authority_addresses prior) -> witnessed address = true) ->
  authority_admission registered witnessed prior next = true.
Proof.
  intros registered witnessed prior next Hproxy Hwitness.
  unfold authority_admission. apply forallb_forall. intros address Hin.
  rewrite (Hproxy address Hin). simpl.
  destruct (authority_member prior address) eqn:Hmember; [reflexivity|].
  apply Hwitness; [exact Hin|]. intros Hprior.
  apply authority_member_is_membership in Hprior. rewrite Hprior in Hmember. discriminate.
Qed.

Theorem registered_proxy_is_rejected_even_if_retained : forall registered witnessed prior next address,
  In address (authority_addresses next) -> registered address = true ->
  authority_admission registered witnessed prior next = false.
Proof.
  intros registered witnessed prior next address Hin Hproxy.
  destruct (authority_admission registered witnessed prior next) eqn:Hadmit; [|reflexivity].
  pose proof (admission_checks_every_next_address _ _ _ _ _ Hadmit Hin) as [Hfalse _].
  rewrite Hproxy in Hfalse. discriminate.
Qed.

Theorem unwitnessed_new_authority_is_rejected : forall registered witnessed prior next address,
  In address (authority_addresses next) ->
  ~ In address (authority_addresses prior) -> witnessed address = false ->
  authority_admission registered witnessed prior next = false.
Proof.
  intros registered witnessed prior next address Hin Hnew Hfalse.
  destruct (authority_admission registered witnessed prior next) eqn:Hadmit; [|reflexivity].
  pose proof (admission_requires_new_recipient_witness _ _ _ _ _ Hadmit Hin Hnew) as Htrue.
  rewrite Htrue in Hfalse. discriminate.
Qed.

Theorem removed_then_reintroduced_authority_needs_witness :
  forall registered witnessed before middle next address,
  In address (authority_addresses before) ->
  ~ In address (authority_addresses middle) ->
  In address (authority_addresses next) -> witnessed address = false ->
  authority_admission registered witnessed middle next = false.
Proof.
  intros registered witnessed before middle next address _ Hremoved Hnext Hfalse.
  eapply unwitnessed_new_authority_is_rejected; eassumption.
Qed.

(* No claim is made that an unregistered proxy can never pass actual CheckWitness.
   That soundness/hash-disjointness property is an external boundary. Given false
   witness evidence, precomputing its address does not bypass admission. *)
Theorem future_proxy_without_witness_cannot_be_introduced :
  forall registered witnessed prior next future_proxy,
  registered future_proxy = false ->
  In future_proxy (authority_addresses next) ->
  ~ In future_proxy (authority_addresses prior) -> witnessed future_proxy = false ->
  authority_admission registered witnessed prior next = false.
Proof.
  intros registered witnessed prior next future_proxy _ Hin Hnew Hfalse.
  eapply unwitnessed_new_authority_is_rejected; eassumption.
Qed.

Example registration_requires_each_distinct_recipient :
  authority_admission (fun _ => false) (fun address => Z.eqb address 1)
    empty_authorities (mkAuthorityProjection 1 2 None None) = false /\
  authority_admission (fun _ => false) (fun address => Z.eqb address 1 || Z.eqb address 2)
    empty_authorities (mkAuthorityProjection 1 2 None None) = true.
Proof. split; reflexivity. Qed.

Example zero_slots_do_not_require_witnesses :
  authority_admission (fun _ => true) (fun _ => false)
    empty_authorities empty_authorities = true.
Proof. reflexivity. Qed.

Example previously_consented_pending_promotion_is_permissionless :
  authority_admission (fun _ => false) (fun _ => false)
    (mkAuthorityProjection 1 2 None (Some 3))
    (mkAuthorityProjection 3 2 None None) = true /\
  authority_admission (fun _ => false) (fun _ => false)
    (mkAuthorityProjection 1 2 (Some 3) None)
    (mkAuthorityProjection 1 3 None None) = true.
Proof. split; reflexivity. Qed.

Example pending_destinations_require_consent_at_introduction :
  authority_admission (fun _ => false) (fun _ => false)
    (mkAuthorityProjection 1 2 None None)
    (mkAuthorityProjection 1 2 None (Some 3)) = false /\
  authority_admission (fun _ => false) (fun address => Z.eqb address 3)
    (mkAuthorityProjection 1 2 None None)
    (mkAuthorityProjection 1 2 (Some 3) None) = true.
Proof. split; reflexivity. Qed.

Example registered_pending_proxy_is_rejected :
  authority_admission (fun address => Z.eqb address 3) (fun _ => true)
    (mkAuthorityProjection 1 2 None (Some 3))
    (mkAuthorityProjection 1 2 None (Some 3)) = false.
Proof. reflexivity. Qed.

Example removed_consent_does_not_survive_reintroduction :
  authority_admission (fun _ => false) (fun _ => false)
    (mkAuthorityProjection 1 2 None None)
    (mkAuthorityProjection 1 0 None None) = true /\
  authority_admission (fun _ => false) (fun _ => false)
    (mkAuthorityProjection 1 0 None None)
    (mkAuthorityProjection 1 2 None None) = false.
Proof. split; reflexivity. Qed.

Example future_proxy_without_admission_witness_is_rejected :
  authority_admission (fun _ => false) (fun _ => false)
    (mkAuthorityProjection 1 2 None None)
    (mkAuthorityProjection 1 2 (Some 99) None) = false.
Proof. reflexivity. Qed.

Print Assumptions authority_address_membership.
Print Assumptions authority_projection_is_bounded.
Print Assumptions zero_authority_is_exempt.
Print Assumptions authority_member_is_membership.
Print Assumptions admission_checks_every_next_address.
Print Assumptions admission_requires_new_recipient_witness.
Print Assumptions retained_authorities_need_no_new_witness.
Print Assumptions admission_accepts_consented_nonproxy_addresses.
Print Assumptions registered_proxy_is_rejected_even_if_retained.
Print Assumptions unwitnessed_new_authority_is_rejected.
Print Assumptions removed_then_reintroduced_authority_needs_witness.
Print Assumptions future_proxy_without_witness_cannot_be_introduced.
Print Assumptions registration_requires_each_distinct_recipient.
Print Assumptions zero_slots_do_not_require_witnesses.
Print Assumptions previously_consented_pending_promotion_is_permissionless.
Print Assumptions pending_destinations_require_consent_at_introduction.
Print Assumptions registered_pending_proxy_is_rejected.
Print Assumptions removed_consent_does_not_survive_reintroduction.
Print Assumptions future_proxy_without_admission_witness_is_rejected.
