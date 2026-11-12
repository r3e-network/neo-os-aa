(* Artifact-specific caller composition. Successful nested returns share the
   reserved view; caught context faults and actual cache semantics are excluded. *)
From Coq Require Import ZArith List Bool Lia.
Require Import IntegerSemantics CapArithmetic CapMethodVm CapMethodArtifact.
Import ListNotations.
Open Scope Z_scope.

Definition decode_return (amount : Z) (wire : Value) : option (Z * BudgetInput) :=
  match wire with
  | VWire kind [VBytes hash;VInt spent] => Some (amount,PresentBudget kind hash spent)
  | _ => None end.
Definition helper_step hash sf nf q before static_values : option (Z * BudgetInput) :=
  match observe (run_vm 130 CapMethodArtifact.artifact
    (initial_vm hash sf nf q (stored_value before) static_values)) with
  | Returned (VInt amount) wire _ => decode_return amount wire
  | _ => None end.
Definition callback_ledger (before reserved : BudgetInput) := reserved.
Fixpoint sum_reservations (amounts : list Z) : Z :=
  match amounts with [] => 0 | amount::rest => amount + sum_reservations rest end.
Inductive NestedCalls hash sf nf static_values : BudgetInput -> BudgetInput -> list Z -> bool -> Prop :=
| CallsDone : forall before, NestedCalls hash sf nf static_values before before [] false
| CallsUncaughtFault : forall before, NestedCalls hash sf nf static_values before before [] true
| CallsRejected : forall before q,
    legal_inputs hash sf nf q before -> helper_step hash sf nf q before static_values = None ->
    NestedCalls hash sf nf static_values before before [] true
| CallsNestedFault : forall before reserved after q amount children,
    legal_inputs hash sf nf q before ->
    helper_step hash sf nf q before static_values = Some (amount,reserved) ->
    NestedCalls hash sf nf static_values (callback_ledger before reserved) after children true ->
    NestedCalls hash sf nf static_values before after (amount::children) true
| CallsNestedReturn : forall before reserved intermediate after q amount children rest failed,
    legal_inputs hash sf nf q before ->
    helper_step hash sf nf q before static_values = Some (amount,reserved) ->
    NestedCalls hash sf nf static_values (callback_ledger before reserved) intermediate children false ->
    NestedCalls hash sf nf static_values intermediate after rest failed ->
    NestedCalls hash sf nf static_values before after (amount::(children++rest)) failed.
Record OuterTransaction := outer_transaction {
  outer_snapshot : BudgetInput; outer_working : BudgetInput;
  outer_reservations : list Z; outer_uncaught_fault : bool
}.
Definition finish_outer (transaction : OuterTransaction) :=
  if outer_uncaught_fault transaction then outer_snapshot transaction else outer_working transaction.
Definition committed_reservations (transaction : OuterTransaction) :=
  if outer_uncaught_fault transaction then [] else outer_reservations transaction.

Lemma sum_reservations_app : forall left right,
 sum_reservations (left++right) = sum_reservations left + sum_reservations right.
Proof. induction left; intros; cbn; [lia|rewrite IHleft; lia]. Qed.
Lemma effective_reserved_nonnegative : forall hash before,
 valid_budget before -> 0 <= effective_reserved hash before.
Proof. intros hash [|kind old spent] H; cbn [valid_budget effective_reserved] in *.
 - lia.
 - destruct H as [_ Hspent]. destruct (bytes_eqb old hash); lia.
Qed.
Theorem helper_reservation_sound : forall hash sf nf q before amount reserved static_values,
 legal_inputs hash sf nf q before ->
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 helper_step hash sf nf q before static_values = Some (amount,reserved) ->
 0 < amount /\
 amount = source_charge (sf+nf) q (effective_reserved hash before) /\
 reserved = PresentBudget (input_kind before) hash (effective_reserved hash before + amount) /\
 valid_budget reserved /\
 effective_reserved hash reserved = effective_reserved hash before + amount /\
 observe (run_vm 130 CapMethodArtifact.artifact
   (initial_vm hash sf nf q (stored_value before) static_values)) =
 Returned (VInt amount) (stored_value reserved)
   (input_trace before ++ [Serialized (stored_value reserved);WroteStorage (stored_value reserved)]).
Proof.
 intros hash sf nf q before amount reserved static_values Hlegal Hstatic Hstep.
 pose proof (CapMethodArtifact.vm_method_classified hash sf nf q before static_values Hlegal Hstatic) as Hvm.
 unfold helper_step in Hstep. rewrite Hvm in Hstep.
 unfold contract_observation in Hstep. cbn zeta in Hstep.
 destruct (0 <? source_charge (sf+nf) q (effective_reserved hash before)) eqn:E; [|discriminate].
 (* The headroom assertion is a second guard over symbolic operands. Leaving it
    unreduced makes the surrounding match stuck, and inversion then explores the
    whole classified term instead of two constructor branches. The legal domain
    supplies the inequality, so the guard is discharged explicitly. *)
 pose proof (legal_cap_domain hash sf nf q before Hlegal) as [_ [_ Hr]].
 pose proof (legal_update_fits hash sf nf q before Hlegal) as Hfit.
 rewrite charge_expression_refines_charge in Hfit by (apply legal_cap_domain; exact Hlegal).
 unfold integer_fits in Hfit.
 assert (Hmargin : vm_leb (effective_reserved hash before)
   (vm_max - source_charge (sf+nf) q (effective_reserved hash before)) = true).
 { unfold vm_leb. apply Z.leb_le. rewrite vm_max_is_top_half. lia. }
 rewrite Hmargin in Hstep.
 cbn [decode_return] in Hstep. inversion Hstep; subst amount reserved.
 apply Z.ltb_lt in E.
 assert (Hhash : valid_hash hash) by (unfold legal_inputs in Hlegal; tauto).
 split; [exact E|]. split; [reflexivity|]. split; [reflexivity|].
 split.
 - cbn [valid_budget]. split; [exact Hhash|lia].
 - split.
   + cbn [effective_reserved]. rewrite bytes_eqb_refl. reflexivity.
   + rewrite Hvm. unfold contract_observation. cbn zeta.
     assert (Eguard : (0 <? source_charge (sf+nf) q (effective_reserved hash before)) = true)
       by (apply Z.ltb_lt; exact E).
     rewrite Eguard, Hmargin. reflexivity.
Qed.
Theorem paid_helper_reservation_bound : forall hash sf nf q before amount reserved static_values,
 legal_inputs hash sf nf q before ->
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 helper_step hash sf nf q before static_values = Some (amount,reserved) ->
 0 < sf+nf -> effective_reserved hash reserved <= sf+nf.
Proof.
 intros hash sf nf q before amount reserved static_values Hlegal Hstatic Hstep Hpaid.
 pose proof (helper_reservation_sound hash sf nf q before amount reserved static_values Hlegal Hstatic Hstep)
   as [Ha [Hamount [_ [_ [Hreserved _]]]]].
 pose proof (legal_cap_domain hash sf nf q before Hlegal) as [Hcost [Hq Hr]].
 rewrite Hreserved, Hamount. unfold source_charge in *.
 assert (E : (sf+nf =? 0) = false) by (apply Z.eqb_neq; lia).
 rewrite E in *. destruct (Z_le_dec (effective_reserved hash before) (sf+nf)).
 - rewrite Z.max_l by lia. pose proof (Z.le_min_r q (sf+nf-effective_reserved hash before)). lia.
 - rewrite Z.max_r in * by lia. rewrite Z.min_r in * by lia. lia.
Qed.
Theorem absent_budget_is_legal : forall hash sf nf q,
 valid_hash hash -> 0 <= sf < 2^63 -> 0 <= nf < 2^63 -> 0 < q < integer_limit ->
 legal_inputs hash sf nf q AbsentBudget.
Proof. intros. unfold legal_inputs; cbn [valid_budget effective_reserved]; unfold valid_hash in *; repeat split; try tauto; lia. Qed.
Theorem paid_caller_conditions : forall hash sf nf q before,
 valid_hash hash -> 0 <= sf < 2^63 -> 0 <= nf < 2^63 -> 0 < q < integer_limit ->
 valid_budget before -> 0 < sf+nf -> legal_inputs hash sf nf q before.
Proof. intros. unfold legal_inputs; unfold valid_hash in *; repeat split; try tauto; lia. Qed.
Theorem zero_fee_caller_conditions : forall hash q before,
 valid_hash hash -> 0 < q < integer_limit -> valid_budget before ->
 effective_reserved hash before + q < integer_limit -> legal_inputs hash 0 0 q before.
Proof. intros. unfold legal_inputs; unfold valid_hash in *; repeat split; try tauto; try lia; vm_compute; reflexivity. Qed.
Theorem cross_transaction_helper_resets : forall hash old sf nf q spent kind amount reserved static_values,
 legal_inputs hash sf nf q (PresentBudget kind old spent) ->
 static_values 38%nat = Some (VBuffer [33%nat]) -> bytes_eqb old hash = false ->
 helper_step hash sf nf q (PresentBudget kind old spent) static_values = Some (amount,reserved) ->
 reserved = PresentBudget kind hash amount.
Proof.
 intros. pose proof (helper_reservation_sound hash sf nf q (PresentBudget kind old spent)
 amount reserved static_values H H0 H2) as [_ [_ [Hreserved _]]].
 cbn [effective_reserved input_kind] in Hreserved. rewrite H1 in Hreserved.
 replace (0+amount) with amount in Hreserved by ring. exact Hreserved.
Qed.
Theorem zero_fee_helper_success_condition : forall hash q before static_values,
 legal_inputs hash 0 0 q before -> static_values 38%nat = Some (VBuffer [33%nat]) ->
 helper_step hash 0 0 q before static_values =
 Some (q,PresentBudget (input_kind before) hash (effective_reserved hash before+q)).
Proof.
 intros. unfold helper_step. rewrite CapMethodArtifact.vm_method_classified by assumption.
 unfold contract_observation, source_charge. cbn zeta.
 assert (Hz : (0 + 0 =? 0) = true) by reflexivity.
 rewrite Hz. cbn zeta.
 pose proof (legal_cap_domain hash 0 0 q before H) as [_ [Hq _]].
 assert (E : (0 <? q) = true) by (apply Z.ltb_lt; lia).
 (* Same headroom guard as above, here discharged from the zero-fee domain. *)
 assert (Hmargin : vm_leb (effective_reserved hash before) (vm_max - q) = true).
 { unfold vm_leb. apply Z.leb_le. rewrite vm_max_is_top_half.
   unfold legal_inputs in H. destruct H as [_ [_ [_ [_ [_ Hzero]]]]].
   pose proof (Hzero eq_refl). lia. }
 rewrite E, Hmargin. reflexivity.
Qed.

Ltac use_step_sound Hstatic :=
 match goal with
 | Hlegal : legal_inputs ?hash ?sf ?nf ?q ?before,
   Hstep : helper_step ?hash ?sf ?nf ?q ?before ?statics = Some (?amount,?reserved) |- _ =>
   pose proof (helper_reservation_sound hash sf nf q before amount reserved statics Hlegal Hstatic Hstep)
    as [?Hpositive [?Hamount [?Hnext [?Hvalid [?Hconservation ?Hobservation]]]]]
 end.
Theorem finite_nested_reservation_conservation : forall hash sf nf static_values before after amounts failed,
 NestedCalls hash sf nf static_values before after amounts failed ->
 static_values 38%nat = Some (VBuffer [33%nat]) ->
 effective_reserved hash after = effective_reserved hash before + sum_reservations amounts.
Proof.
 intros hash sf nf static_values before after amounts failed Hcalls.
 induction Hcalls; intros Hstatic; unfold callback_ledger in *; try (cbn; lia).
 - specialize (IHHcalls Hstatic). use_step_sound Hstatic. cbn. lia.
 - specialize (IHHcalls1 Hstatic). specialize (IHHcalls2 Hstatic).
   use_step_sound Hstatic. cbn. rewrite sum_reservations_app. lia.
Qed.
Theorem finite_nested_positive_reservations : forall hash sf nf static_values before after amounts failed,
 NestedCalls hash sf nf static_values before after amounts failed ->
 static_values 38%nat = Some (VBuffer [33%nat]) -> Forall (fun amount => 0 < amount) amounts.
Proof.
 intros hash sf nf static_values before after amounts failed Hcalls.
 induction Hcalls; intros Hstatic; try solve [constructor].
 - use_step_sound Hstatic. constructor; [assumption|apply IHHcalls; exact Hstatic].
 - use_step_sound Hstatic. constructor; [assumption|]. apply Forall_app. split;
   [apply IHHcalls1|apply IHHcalls2]; exact Hstatic.
Qed.
Theorem finite_nested_valid_ledger : forall hash sf nf static_values before after amounts failed,
 NestedCalls hash sf nf static_values before after amounts failed ->
 static_values 38%nat = Some (VBuffer [33%nat]) -> valid_budget before -> valid_budget after.
Proof.
 intros hash sf nf static_values before after amounts failed Hcalls.
 induction Hcalls; intros Hstatic Hvalid; unfold callback_ledger in *; try assumption.
 - use_step_sound Hstatic. apply IHHcalls; assumption.
 - use_step_sound Hstatic. apply IHHcalls2; [assumption|]. apply IHHcalls1; assumption.
Qed.
Lemma finite_nested_paid_working_bound : forall hash sf nf static_values before after amounts failed,
 NestedCalls hash sf nf static_values before after amounts failed ->
 static_values 38%nat = Some (VBuffer [33%nat]) -> 0 < sf+nf ->
 effective_reserved hash before <= sf+nf -> effective_reserved hash after <= sf+nf.
Proof.
 intros hash sf nf static_values before after amounts failed Hcalls.
 induction Hcalls; intros Hstatic Hpaid Hbefore; unfold callback_ledger in *; try assumption.
 - apply IHHcalls; try assumption. eapply paid_helper_reservation_bound; eauto.
 - apply IHHcalls2; try assumption. apply IHHcalls1; try assumption.
   eapply paid_helper_reservation_bound; eauto.
Qed.
Theorem finite_nested_paid_fee_bound : forall hash sf nf static_values before after amounts failed,
 NestedCalls hash sf nf static_values before after amounts failed ->
 static_values 38%nat = Some (VBuffer [33%nat]) -> 0 < sf+nf -> valid_budget before ->
 effective_reserved hash before <= sf+nf ->
 sum_reservations amounts <= sf+nf /\ effective_reserved hash after <= sf+nf.
Proof.
 intros. pose proof (finite_nested_reservation_conservation hash sf nf static_values before after amounts failed H H0).
 pose proof (finite_nested_paid_working_bound hash sf nf static_values before after amounts failed H H0 H1 H3).
 pose proof (effective_reserved_nonnegative hash before H2). lia.
Qed.
Theorem callback_receives_helper_committed_view : forall hash sf nf q before amount reserved static_values,
 legal_inputs hash sf nf q before -> static_values 38%nat = Some (VBuffer [33%nat]) ->
 helper_step hash sf nf q before static_values = Some (amount,reserved) ->
 observe (run_vm 130 CapMethodArtifact.artifact
   (initial_vm hash sf nf q (stored_value before) static_values)) =
 Returned (VInt amount) (stored_value (callback_ledger before reserved))
 (input_trace before ++ [Serialized (stored_value reserved);WroteStorage (stored_value reserved)]).
Proof. intros. unfold callback_ledger.
 pose proof (helper_reservation_sound hash sf nf q before amount reserved static_values H H0 H1). tauto.
Qed.
Lemma effective_reserved_bounded : forall hash before,
 valid_budget before -> 0 <= effective_reserved hash before < integer_limit.
Proof. intros hash [|kind old spent] H; cbn [valid_budget effective_reserved] in *.
 - pose proof integer_limit_positive. lia.
 - destruct H as [_ Hspent]. destruct (bytes_eqb old hash); [exact Hspent|].
   pose proof integer_limit_positive. lia.
Qed.
Theorem finite_nested_zero_fee_representability : forall hash static_values before after amounts failed,
 NestedCalls hash 0 0 static_values before after amounts failed ->
 static_values 38%nat = Some (VBuffer [33%nat]) -> valid_budget before ->
 integer_fits (effective_reserved hash before + sum_reservations amounts) /\
 effective_reserved hash before + sum_reservations amounts < integer_limit.
Proof.
 intros. pose proof (finite_nested_valid_ledger hash 0 0 static_values before after amounts failed H H0 H1).
 pose proof (effective_reserved_bounded hash after H2).
 pose proof (finite_nested_reservation_conservation hash 0 0 static_values before after amounts failed H H0).
 unfold integer_fits. pose proof integer_limit_positive. lia.
Qed.
Theorem outer_fault_restores_snapshot : forall snapshot working amounts,
 finish_outer (outer_transaction snapshot working amounts true) = snapshot.
Proof. reflexivity. Qed.
Theorem outer_success_commits_working : forall snapshot working amounts,
 finish_outer (outer_transaction snapshot working amounts false) = working.
Proof. reflexivity. Qed.
Theorem outer_fault_commits_no_reservations : forall snapshot working amounts,
 committed_reservations (outer_transaction snapshot working amounts true) = [].
Proof. reflexivity. Qed.
Theorem outer_paid_commit_fee_bound : forall hash sf nf static_values snapshot working amounts failed,
 NestedCalls hash sf nf static_values snapshot working amounts failed ->
 static_values 38%nat = Some (VBuffer [33%nat]) -> 0 < sf+nf -> valid_budget snapshot ->
 effective_reserved hash snapshot <= sf+nf ->
 effective_reserved hash (finish_outer (outer_transaction snapshot working amounts failed)) <= sf+nf /\
 sum_reservations (committed_reservations (outer_transaction snapshot working amounts failed)) <= sf+nf.
Proof.
 intros. pose proof (finite_nested_paid_fee_bound hash sf nf static_values snapshot working amounts failed H H0 H1 H2 H3).
 destruct failed; cbn [finish_outer committed_reservations outer_snapshot outer_working outer_uncaught_fault outer_reservations sum_reservations]; lia.
Qed.

Print Assumptions sum_reservations_app.
Print Assumptions effective_reserved_nonnegative.
Print Assumptions helper_reservation_sound.
Print Assumptions paid_helper_reservation_bound.
Print Assumptions absent_budget_is_legal.
Print Assumptions paid_caller_conditions.
Print Assumptions zero_fee_caller_conditions.
Print Assumptions cross_transaction_helper_resets.
Print Assumptions zero_fee_helper_success_condition.
Print Assumptions finite_nested_reservation_conservation.
Print Assumptions finite_nested_positive_reservations.
Print Assumptions finite_nested_valid_ledger.
Print Assumptions finite_nested_paid_working_bound.
Print Assumptions finite_nested_paid_fee_bound.
Print Assumptions outer_fault_restores_snapshot.
Print Assumptions outer_success_commits_working.
Print Assumptions outer_fault_commits_no_reservations.
Print Assumptions outer_paid_commit_fee_bound.

Print Assumptions callback_receives_helper_committed_view.
Print Assumptions effective_reserved_bounded.
Print Assumptions finite_nested_zero_fee_representability.

Print Assumptions decode_return.
Print Assumptions helper_step.
Print Assumptions callback_ledger.
Print Assumptions sum_reservations.
Print Assumptions NestedCalls.
Print Assumptions OuterTransaction.
Print Assumptions finish_outer.
Print Assumptions committed_reservations.
