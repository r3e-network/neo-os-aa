(*
  Native ABI 2 authority-generation and configuration-counter abstraction.

  Both counters are mathematical integers checked against an inclusive maximum;
  uint64_max instantiates that parameter to 2^64-1. Their values are independent.
  A successful recovery consumes a previously authorized pending intent. The
  authority_valid input represents stored-authority/intent validation, including
  the proposal's authorization and replacement-custody restrictions; it is NOT
  a requirement for an old-custody witness when executing a mature recovery.

  The recovery transition has no module callback. Returning (false, before)
  models atomic rejection; it is not a proof of NeoVM or ledger rollback.
  Decoded account states additionally require authorityEpoch <= configurationNonce.
  decode_counter_pair models that predicate; the transition helper is an
  over-approximation that assumes the native account decoder already ran.
  The preservation theorems require the before-state ordering explicitly.
  configuration_advance models only the counter/pending-intent update helper,
  not configuration authorization, callback execution, freeze or unfreeze.

  A namespace is the mathematical pair (account, authorityEpoch), with the
  0xA2 tag, policy prefix and suffix held fixed. It abstracts the tagged tuple
  behind 0xA2 || policyPrefix || accountIdLE20 || authorityEpochLE64 || suffix.
  Its payload represents ALL account-owned module state, including grants and
  transient snapshots. Empty-generation results require no writes for a future
  epoch. Authenticated epoch reads, injective byte-key encoding and exclusive
  use of these keys by actual modules are external implementation obligations.

  Authorization binds account plus BOTH counters. The domain tuple is supplied
  by the four-argument execution envelope in the unsigned transaction script;
  valid_signature abstracts the selected verifier or custody/witness evidence.
  Operation signatures also bind this tuple in their authorization preimage.
  Native transaction-witness modes cannot bypass the explicit counter guard.
  Actual envelope decoding and transaction-signature commitment are external
  correspondence obligations. Network/core/version and
  canonical operation encoding are held fixed here, not cryptographically proved.
  These theorems do not establish C# refinement, storage serialization, migration
  from ABI 1, event emission, gas bounds, consensus activation or deployment.
*)
From Coq Require Import ZArith Bool Lia List.
Import ListNotations.
Open Scope Z_scope.

Definition uint64_max : Z := 2 ^ 64 - 1.
Definition counter_in_range (maximum value : Z) : bool :=
  (0 <=? value) && (value <=? maximum).
Definition incrementable (maximum value : Z) : bool :=
  (0 <=? value) && (value <? maximum).

Record RecoveryIntent := mkRecoveryIntent {
  replacement_custody : Z;
  proposed_at : Z;
  execute_at : Z;
  expected_configuration : Z
}.
Record State := mkState {
  account_id : Z;
  proxy_address : Z;
  custody_address : Z;
  recovery_address : option Z;
  authority_epoch : Z;
  configuration_nonce : Z;
  verifier_root : option Z;
  hook_root : option Z;
  dependencies : list Z;
  pending_verifier : bool;
  pending_hook : bool;
  pending_address : bool;
  pending_recovery : option RecoveryIntent;
  target_nonces : list (Z * Z);
  frozen : bool
}.

Definition has_recovery (s : State) : bool :=
  match recovery_address s with Some _ => true | None => false end.
Definition mature_intent (maximum delay now : Z) (p : RecoveryIntent) : bool :=
  (0 <? delay) && counter_in_range maximum (proposed_at p) &&
  counter_in_range maximum (execute_at p) &&
  Z.eqb (execute_at p) (proposed_at p + delay) && (execute_at p <=? now).
Definition recovery_permitted (maximum delay now : Z) (authority_valid : bool)
    (s : State) (p : RecoveryIntent) : bool :=
  authority_valid && has_recovery s && mature_intent maximum delay now p &&
  Z.eqb (expected_configuration p) (configuration_nonce s) &&
  incrementable maximum (authority_epoch s) &&
  incrementable maximum (configuration_nonce s).
Definition recovered (s : State) (p : RecoveryIntent) : State :=
  mkState (account_id s) (proxy_address s) (replacement_custody p)
    (recovery_address s) (authority_epoch s + 1) (configuration_nonce s + 1)
    None None [] false false false None (target_nonces s) (frozen s).
Definition recover (maximum delay now : Z) (authority_valid : bool) (s : State)
    : bool * State :=
  match pending_recovery s with
  | Some p => if recovery_permitted maximum delay now authority_valid s p
              then (true, recovered s p) else (false, s)
  | None => (false, s)
  end.

Definition configured (s : State) : State :=
  mkState (account_id s) (proxy_address s) (custody_address s)
    (recovery_address s) (authority_epoch s) (configuration_nonce s + 1)
    (verifier_root s) (hook_root s) (dependencies s)
    false false false None (target_nonces s) (frozen s).
Definition configuration_advance (maximum : Z) (s : State) : bool * State :=
  if counter_in_range maximum (authority_epoch s) &&
     incrementable maximum (configuration_nonce s)
  then (true, configured s) else (false, s).

Definition Namespace := (Z * Z)%type.
Definition namespace (account generation : Z) : Namespace := (account, generation).
Definition namespace_matches (left right : Namespace) : bool :=
  Z.eqb (fst left) (fst right) && Z.eqb (snd left) (snd right).
Definition state_namespace (s : State) : Namespace :=
  namespace (account_id s) (authority_epoch s).
Fixpoint read_namespace {Payload : Type} (key : Namespace)
    (store : list (Namespace * Payload)) : option Payload :=
  match store with
  | [] => None
  | (stored_key, payload) :: rest =>
      if namespace_matches key stored_key then Some payload
      else read_namespace key rest
  end.
Definition no_future_generation {Payload : Type} (account generation : Z)
    (store : list (Namespace * Payload)) : Prop :=
  Forall (fun cell => fst (fst cell) = account -> snd (fst cell) <= generation) store.

Record AuthorizationDomain := mkAuthorizationDomain {
  signed_account : Z;
  signed_epoch : Z;
  signed_configuration : Z
}.
Definition current_domain (s : State) : AuthorizationDomain :=
  mkAuthorizationDomain (account_id s) (authority_epoch s) (configuration_nonce s).
Definition authorized (maximum : Z) (s : State) (domain : AuthorizationDomain)
    (valid_signature : bool) : bool :=
  valid_signature && counter_in_range maximum (authority_epoch s) &&
  counter_in_range maximum (configuration_nonce s) &&
  Z.eqb (signed_account domain) (account_id s) &&
  Z.eqb (signed_epoch domain) (authority_epoch s) &&
  Z.eqb (signed_configuration domain) (configuration_nonce s).

Definition decode_counter_pair (maximum epoch configuration : Z) : bool :=
  counter_in_range maximum epoch && counter_in_range maximum configuration && (epoch <=? configuration).

Definition execution_authorized (arity maximum : Z) (s : State)
    (domain : AuthorizationDomain) (valid_signature : bool) : bool :=
  Z.eqb arity 4 && authorized maximum s domain valid_signature.

(* Definitions end here: mutation preflight compiles this prefix separately. *)

Lemma incrementable_range : forall maximum value,
  incrementable maximum value = true <-> 0 <= value < maximum.
Proof. intros. unfold incrementable. rewrite andb_true_iff, Z.leb_le, Z.ltb_lt. reflexivity. Qed.

Lemma recovery_success_shape : forall maximum delay now valid s,
  fst (recover maximum delay now valid s) = true ->
  exists p, pending_recovery s = Some p /\
    recovery_permitted maximum delay now valid s p = true /\
    snd (recover maximum delay now valid s) = recovered s p.
Proof.
  intros maximum delay now valid s H. unfold recover in *.
  destruct (pending_recovery s) as [p|] eqn:E; [|discriminate].
  destruct (recovery_permitted maximum delay now valid s p) eqn:A; [|discriminate].
  exists p. repeat split; assumption || reflexivity.
Qed.

Theorem recovery_failure_preserves_entire_state : forall maximum delay now valid s,
  fst (recover maximum delay now valid s) = false ->
  snd (recover maximum delay now valid s) = s.
Proof.
  intros maximum delay now valid s H. unfold recover in *.
  destruct (pending_recovery s) as [p|]; [|reflexivity].
  destruct (recovery_permitted maximum delay now valid s p); [discriminate|reflexivity].
Qed.

Theorem recovery_requires_authority : forall maximum delay now s,
  recover maximum delay now false s = (false, s).
Proof. intros. unfold recover. destruct (pending_recovery s); reflexivity. Qed.

Theorem recovery_requires_configured_recovery : forall maximum delay now valid s,
  recovery_address s = None -> recover maximum delay now valid s = (false, s).
Proof.
  intros maximum delay now valid s H. unfold recover.
  destruct (pending_recovery s); [|reflexivity].
  unfold recovery_permitted, has_recovery. rewrite H, andb_false_r. reflexivity.
Qed.

Theorem recovery_requires_pending_intent : forall maximum delay now valid s,
  pending_recovery s = None -> recover maximum delay now valid s = (false, s).
Proof. intros. unfold recover. rewrite H. reflexivity. Qed.

Theorem recovery_requires_exact_mature_delay : forall maximum delay now valid s,
  fst (recover maximum delay now valid s) = true ->
  exists p, pending_recovery s = Some p /\ 0 < delay /\
    0 <= proposed_at p <= maximum /\ 0 <= execute_at p <= maximum /\
    execute_at p = proposed_at p + delay /\ execute_at p <= now /\
    expected_configuration p = configuration_nonce s.
Proof.
  intros maximum delay now valid s H.
  destruct (recovery_success_shape _ _ _ _ _ H) as [p [Hp [Ha _]]].
  unfold recovery_permitted, mature_intent, counter_in_range in Ha.
  repeat rewrite andb_true_iff in Ha.
  destruct Ha as [[[[[_ _] Htime] Hexpected] _] _].
  destruct Htime as [[[[Hdelay [Hpl Hpu]] [Hel Heu]] Heq] Hnow].
  apply Z.ltb_lt in Hdelay. apply Z.leb_le in Hpl, Hpu, Hel, Heu, Hnow.
  apply Z.eqb_eq in Heq, Hexpected. exists p. repeat split; assumption.
Qed.

Theorem recovery_increments_independent_counters : forall maximum delay now valid s,
  fst (recover maximum delay now valid s) = true ->
  authority_epoch (snd (recover maximum delay now valid s)) = authority_epoch s + 1 /\
  configuration_nonce (snd (recover maximum delay now valid s)) = configuration_nonce s + 1.
Proof.
  intros maximum delay now valid s H.
  destruct (recovery_success_shape _ _ _ _ _ H) as [p [_ [_ E]]].
  rewrite E. split; reflexivity.
Qed.

Theorem recovery_counters_stay_in_range : forall maximum delay now valid s,
  fst (recover maximum delay now valid s) = true ->
  0 <= authority_epoch (snd (recover maximum delay now valid s)) <= maximum /\
  0 <= configuration_nonce (snd (recover maximum delay now valid s)) <= maximum.
Proof.
  intros maximum delay now valid s H.
  destruct (recovery_success_shape _ _ _ _ _ H) as [p [_ [A E]]].
  unfold recovery_permitted in A. repeat rewrite andb_true_iff in A.
  destruct A as [[_ He] Hc]. apply incrementable_range in He, Hc.
  rewrite E. simpl. lia.
Qed.

Theorem recovery_rejects_exhausted_epoch : forall maximum delay now valid s,
  maximum <= authority_epoch s -> recover maximum delay now valid s = (false, s).
Proof.
  intros maximum delay now valid s H. unfold recover.
  destruct (pending_recovery s); [|reflexivity].
  unfold recovery_permitted, incrementable.
  assert (E : (authority_epoch s <? maximum) = false) by (apply Z.ltb_ge; lia).
  rewrite E, !andb_false_r. reflexivity.
Qed.

Theorem recovery_rejects_exhausted_configuration : forall maximum delay now valid s,
  maximum <= configuration_nonce s -> recover maximum delay now valid s = (false, s).
Proof.
  intros maximum delay now valid s H. unfold recover.
  destruct (pending_recovery s); [|reflexivity].
  unfold recovery_permitted, incrementable.
  assert (E : (configuration_nonce s <? maximum) = false) by (apply Z.ltb_ge; lia).
  rewrite E, !andb_false_r. reflexivity.
Qed.

Theorem recovery_clears_roots_dependencies_and_pending : forall maximum delay now valid s,
  fst (recover maximum delay now valid s) = true ->
  let next := snd (recover maximum delay now valid s) in
  verifier_root next = None /\ hook_root next = None /\ dependencies next = [] /\
  pending_verifier next = false /\ pending_hook next = false /\
  pending_address next = false /\ pending_recovery next = None.
Proof.
  intros maximum delay now valid s H.
  destruct (recovery_success_shape _ _ _ _ _ H) as [p [_ [_ E]]].
  rewrite E. repeat split; reflexivity.
Qed.

Theorem recovery_preserves_identity_proxy_nonces_freeze_and_recovery :
  forall maximum delay now valid s,
  fst (recover maximum delay now valid s) = true ->
  let next := snd (recover maximum delay now valid s) in
  account_id next = account_id s /\ proxy_address next = proxy_address s /\
  target_nonces next = target_nonces s /\ frozen next = frozen s /\
  recovery_address next = recovery_address s.
Proof.
  intros maximum delay now valid s H.
  destruct (recovery_success_shape _ _ _ _ _ H) as [p [_ [_ E]]].
  rewrite E. repeat split; reflexivity.
Qed.

Theorem recovery_installs_intended_custody : forall maximum delay now valid s p,
  pending_recovery s = Some p -> fst (recover maximum delay now valid s) = true ->
  custody_address (snd (recover maximum delay now valid s)) = replacement_custody p.
Proof.
  intros maximum delay now valid s p Hp H.
  destruct (recovery_success_shape _ _ _ _ _ H) as [actual [Ha [_ E]]].
  rewrite Hp in Ha. inversion Ha; subst. rewrite E. reflexivity.
Qed.

Theorem configuration_only_advances_configuration_counter : forall maximum s,
  fst (configuration_advance maximum s) = true ->
  authority_epoch (snd (configuration_advance maximum s)) = authority_epoch s /\
  configuration_nonce (snd (configuration_advance maximum s)) = configuration_nonce s + 1.
Proof.
  intros maximum s H. unfold configuration_advance in *.
  destruct (counter_in_range maximum (authority_epoch s) &&
    incrementable maximum (configuration_nonce s)); [|discriminate].
  split; reflexivity.
Qed.

Theorem configuration_failure_preserves_entire_state : forall maximum s,
  fst (configuration_advance maximum s) = false ->
  snd (configuration_advance maximum s) = s.
Proof.
  intros maximum s H. unfold configuration_advance in *.
  destruct (counter_in_range maximum (authority_epoch s) &&
    incrementable maximum (configuration_nonce s)); [discriminate|reflexivity].
Qed.

Theorem configuration_preserves_namespace : forall maximum s,
  state_namespace (snd (configuration_advance maximum s)) = state_namespace s.
Proof.
  intros maximum s. unfold configuration_advance.
  destruct (counter_in_range maximum (authority_epoch s) &&
    incrementable maximum (configuration_nonce s)); reflexivity.
Qed.

Theorem namespace_pair_is_injective : forall a e other_a other_e,
  namespace a e = namespace other_a other_e -> a = other_a /\ e = other_e.
Proof. intros a e other_a other_e H. inversion H. auto. Qed.

Theorem recovery_changes_namespace : forall maximum delay now valid s,
  fst (recover maximum delay now valid s) = true ->
  state_namespace (snd (recover maximum delay now valid s)) <> state_namespace s.
Proof.
  intros maximum delay now valid s H E.
  destruct (recovery_success_shape _ _ _ _ _ H) as [p [_ [_ Next]]].
  rewrite Next in E. unfold state_namespace, recovered, namespace in E.
  inversion E. lia.
Qed.

Theorem old_generations_are_invisible : forall (Payload : Type) store a e,
  @no_future_generation Payload a e store ->
  read_namespace (namespace a (e + 1)) store = None.
Proof.
  intros Payload store. induction store as [|[[stored_a stored_e] payload] rest IH];
    intros a e H; [reflexivity|].
  inversion H as [|cell tail Hhead Htail]; subst.
  simpl in Hhead. simpl. unfold namespace_matches, namespace. simpl.
  destruct (Z.eqb a stored_a) eqn:Ea.
  - apply Z.eqb_eq in Ea. subst stored_a.
    specialize (Hhead eq_refl).
    assert (Ee : Z.eqb (e + 1) stored_e = false) by (apply Z.eqb_neq; lia).
    rewrite Ee. apply IH. exact Htail.
  - apply IH. exact Htail.
Qed.

Theorem recovered_module_namespace_is_empty : forall (Payload : Type) store
    maximum delay now valid s,
  @no_future_generation Payload (account_id s) (authority_epoch s) store ->
  fst (recover maximum delay now valid s) = true ->
  read_namespace (state_namespace (snd (recover maximum delay now valid s))) store = None.
Proof.
  intros Payload store maximum delay now valid s Hpast H.
  destruct (recovery_success_shape _ _ _ _ _ H) as [p [_ [_ Next]]].
  rewrite Next. apply old_generations_are_invisible. exact Hpast.
Qed.

Theorem another_account_cannot_read_namespace : forall (Payload : Type) a e b f (value : Payload),
  a <> b -> read_namespace (namespace a e) [(namespace b f, value)] = None.
Proof.
  intros Payload a e b f value H. simpl. unfold namespace_matches, namespace. simpl.
  assert (E : Z.eqb a b = false) by (apply Z.eqb_neq; exact H).
  rewrite E. reflexivity.
Qed.

Theorem current_namespace_is_readable : forall (Payload : Type) a e (value : Payload),
  read_namespace (namespace a e) [(namespace a e, value)] = Some value.
Proof. intros. simpl. unfold namespace_matches, namespace. simpl. rewrite !Z.eqb_refl. reflexivity. Qed.

Theorem stale_epoch_signature_rejected : forall maximum s domain valid_signature,
  signed_epoch domain <> authority_epoch s -> authorized maximum s domain valid_signature = false.
Proof.
  intros maximum s domain valid_signature H. unfold authorized.
  apply Z.eqb_neq in H. rewrite H, !andb_false_r. reflexivity.
Qed.

Theorem stale_configuration_signature_rejected : forall maximum s domain valid_signature,
  signed_configuration domain <> configuration_nonce s ->
  authorized maximum s domain valid_signature = false.
Proof.
  intros maximum s domain valid_signature H. unfold authorized.
  apply Z.eqb_neq in H. rewrite H, andb_false_r. reflexivity.
Qed.

Theorem wrong_account_signature_rejected : forall maximum s domain valid_signature,
  signed_account domain <> account_id s -> authorized maximum s domain valid_signature = false.
Proof.
  intros maximum s domain valid_signature H. unfold authorized.
  apply Z.eqb_neq in H. rewrite H, !andb_false_r. reflexivity.
Qed.

Theorem invalid_signature_rejected : forall maximum s domain,
  authorized maximum s domain false = false.
Proof. reflexivity. Qed.

Theorem current_domain_authorization_is_reachable : forall maximum s,
  counter_in_range maximum (authority_epoch s) = true ->
  counter_in_range maximum (configuration_nonce s) = true ->
  authorized maximum s (current_domain s) true = true.
Proof.
  intros maximum s He Hc. unfold authorized, current_domain. simpl.
  rewrite He, Hc, !Z.eqb_refl. reflexivity.
Qed.

Theorem recovery_invalidates_old_signature : forall maximum delay now valid s signature,
  fst (recover maximum delay now valid s) = true ->
  authorized maximum (snd (recover maximum delay now valid s)) (current_domain s) signature = false.
Proof.
  intros maximum delay now valid s signature H. apply stale_epoch_signature_rejected.
  destruct (recovery_increments_independent_counters _ _ _ _ _ H) as [E _].
  rewrite E. simpl. lia.
Qed.

Theorem configuration_invalidates_old_signature : forall maximum s signature,
  fst (configuration_advance maximum s) = true ->
  authorized maximum (snd (configuration_advance maximum s)) (current_domain s) signature = false.
Proof.
  intros maximum s signature H. apply stale_configuration_signature_rejected.
  destruct (configuration_only_advances_configuration_counter _ _ H) as [_ E].
  rewrite E. simpl. lia.
Qed.

Theorem decoded_counter_pair_has_reachable_order : forall maximum epoch configuration,
  decode_counter_pair maximum epoch configuration = true -> epoch <= configuration.
Proof.
  intros maximum epoch configuration H. unfold decode_counter_pair in H.
  apply andb_true_iff in H. destruct H as [_ H]. apply Z.leb_le. exact H.
Qed.

Theorem recovery_preserves_counter_order : forall maximum delay now valid s,
  authority_epoch s <= configuration_nonce s ->
  fst (recover maximum delay now valid s) = true ->
  authority_epoch (snd (recover maximum delay now valid s)) <=
    configuration_nonce (snd (recover maximum delay now valid s)).
Proof.
  intros maximum delay now valid s Horder H.
  destruct (recovery_increments_independent_counters _ _ _ _ _ H) as [He Hc].
  rewrite He, Hc. lia.
Qed.

Theorem configuration_preserves_counter_order : forall maximum s,
  authority_epoch s <= configuration_nonce s ->
  fst (configuration_advance maximum s) = true ->
  authority_epoch (snd (configuration_advance maximum s)) <=
    configuration_nonce (snd (configuration_advance maximum s)).
Proof.
  intros maximum s Horder H.
  destruct (configuration_only_advances_configuration_counter _ _ H) as [He Hc].
  rewrite He, Hc. lia.
Qed.

Theorem execution_rejects_legacy_two_argument_envelope : forall maximum s domain evidence,
  execution_authorized 2 maximum s domain evidence = false.
Proof. reflexivity. Qed.

Theorem execution_requires_current_counters : forall arity maximum s domain evidence,
  execution_authorized arity maximum s domain evidence = true ->
  signed_epoch domain = authority_epoch s /\
  signed_configuration domain = configuration_nonce s.
Proof.
  intros arity maximum s domain evidence H. unfold execution_authorized in H.
  apply andb_true_iff in H. destruct H as [_ H]. unfold authorized in H.
  repeat rewrite andb_true_iff in H. destruct H as [[_ He] Hc].
  apply Z.eqb_eq in He, Hc. split; assumption.
Qed.

Theorem transaction_witness_cannot_bypass_stale_counters : forall maximum s domain,
  signed_epoch domain <> authority_epoch s \/
  signed_configuration domain <> configuration_nonce s ->
  execution_authorized 4 maximum s domain true = false.
Proof.
  intros maximum s domain [He|Hc]; unfold execution_authorized; simpl.
  - apply stale_epoch_signature_rejected. exact He.
  - apply stale_configuration_signature_rejected. exact Hc.
Qed.

Definition example_intent : RecoveryIntent := mkRecoveryIntent 30 10 20 42.
Definition example_state (e c : Z) : State :=
  mkState 1 2 3 (Some 4) e c (Some 5) (Some 6) [7; 8]
    true true true (Some example_intent) [(9, 12)] true.

Example recovery_with_distinct_counters_is_reachable :
  recover uint64_max 10 20 true (example_state 7 42) =
    (true, mkState 1 2 30 (Some 4) 8 43 None None [] false false false None [(9, 12)] true).
Proof. vm_compute. reflexivity. Qed.

Example four_argument_witness_authorization_is_reachable :
  execution_authorized 4 uint64_max (example_state 7 11)
    (current_domain (example_state 7 11)) true = true.
Proof. vm_compute. reflexivity. Qed.

Example before_maturity_rejects_atomically :
  recover uint64_max 10 19 true (example_state 7 42) = (false, example_state 7 42).
Proof. vm_compute. reflexivity. Qed.

Example wrong_fixed_delay_rejects_atomically :
  recover uint64_max 9 20 true (example_state 7 42) = (false, example_state 7 42).
Proof. vm_compute. reflexivity. Qed.

Example stale_pending_configuration_rejects_atomically :
  recover uint64_max 10 20 true (example_state 7 43) = (false, example_state 7 43).
Proof. vm_compute. reflexivity. Qed.

Example exhausted_epoch_does_not_wrap :
  recover uint64_max 10 20 true (example_state uint64_max 42) =
    (false, example_state uint64_max 42).
Proof. vm_compute. reflexivity. Qed.

Example unreachable_counter_helper_does_not_model_account_decoder :
  fst (configuration_advance uint64_max (example_state uint64_max 42)) = true /\
  authority_epoch (snd (configuration_advance uint64_max (example_state uint64_max 42))) = uint64_max /\
  configuration_nonce (snd (configuration_advance uint64_max (example_state uint64_max 42))) = 43.
Proof. vm_compute. repeat split; reflexivity. Qed.

Example future_generation_requires_an_explicit_assumption :
  read_namespace (namespace 1 8) [(namespace 1 8, 99)] = Some 99.
Proof. reflexivity. Qed.

Print Assumptions incrementable_range.
Print Assumptions recovery_success_shape.
Print Assumptions recovery_failure_preserves_entire_state.
Print Assumptions recovery_requires_authority.
Print Assumptions recovery_requires_configured_recovery.
Print Assumptions recovery_requires_pending_intent.
Print Assumptions recovery_requires_exact_mature_delay.
Print Assumptions recovery_increments_independent_counters.
Print Assumptions recovery_counters_stay_in_range.
Print Assumptions recovery_rejects_exhausted_epoch.
Print Assumptions recovery_rejects_exhausted_configuration.
Print Assumptions recovery_clears_roots_dependencies_and_pending.
Print Assumptions recovery_preserves_identity_proxy_nonces_freeze_and_recovery.
Print Assumptions recovery_installs_intended_custody.
Print Assumptions configuration_only_advances_configuration_counter.
Print Assumptions configuration_failure_preserves_entire_state.
Print Assumptions configuration_preserves_namespace.
Print Assumptions namespace_pair_is_injective.
Print Assumptions recovery_changes_namespace.
Print Assumptions old_generations_are_invisible.
Print Assumptions recovered_module_namespace_is_empty.
Print Assumptions another_account_cannot_read_namespace.
Print Assumptions current_namespace_is_readable.
Print Assumptions stale_epoch_signature_rejected.
Print Assumptions stale_configuration_signature_rejected.
Print Assumptions wrong_account_signature_rejected.
Print Assumptions invalid_signature_rejected.
Print Assumptions current_domain_authorization_is_reachable.
Print Assumptions recovery_invalidates_old_signature.
Print Assumptions configuration_invalidates_old_signature.
Print Assumptions recovery_with_distinct_counters_is_reachable.
Print Assumptions before_maturity_rejects_atomically.
Print Assumptions wrong_fixed_delay_rejects_atomically.
Print Assumptions stale_pending_configuration_rejects_atomically.
Print Assumptions exhausted_epoch_does_not_wrap.
Print Assumptions unreachable_counter_helper_does_not_model_account_decoder.
Print Assumptions future_generation_requires_an_explicit_assumption.

Print Assumptions decoded_counter_pair_has_reachable_order.
Print Assumptions recovery_preserves_counter_order.
Print Assumptions configuration_preserves_counter_order.

Print Assumptions execution_rejects_legacy_two_argument_envelope.
Print Assumptions execution_requires_current_counters.
Print Assumptions transaction_witness_cannot_bypass_stale_counters.
Print Assumptions four_argument_witness_authorization_is_reachable.
