From Coq Require Import ZArith List Bool Lia.
Require Import IntegerSemantics CapArithmetic CapMethodVm.
Import ListNotations.
Open Scope Z_scope.
Definition artifact : list nat := [87%nat;7%nat;1%nat;65%nat;45%nat;81%nat;8%nat;48%nat;16%nat;206%nat;112%nat;95%nat;34%nat;65%nat;155%nat;246%nat;103%nat;206%nat;65%nat;146%nat;93%nat;232%nat;49%nat;113%nat;105%nat;11%nat;151%nat;38%nat;41%nat;16%nat;12%nat;32%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;18%nat;192%nat;34%nat;6%nat;105%nat;55%nat;4%nat;0%nat;114%nat;106%nat;16%nat;206%nat;104%nat;152%nat;38%nat;16%nat;104%nat;74%nat;106%nat;16%nat;81%nat;208%nat;69%nat;16%nat;74%nat;106%nat;17%nat;81%nat;208%nat;69%nat;65%nat;45%nat;81%nat;8%nat;48%nat;20%nat;206%nat;65%nat;45%nat;81%nat;8%nat;48%nat;21%nat;206%nat;158%nat;115%nat;17%nat;17%nat;107%nat;185%nat;159%nat;116%nat;16%nat;107%nat;106%nat;17%nat;206%nat;159%nat;186%nat;108%nat;120%nat;160%nat;158%nat;117%nat;109%nat;120%nat;185%nat;118%nat;110%nat;16%nat;183%nat;36%nat;42%nat;12%nat;37%nat;82%nat;101%nat;105%nat;109%nat;98%nat;117%nat;114%nat;115%nat;101%nat;109%nat;101%nat;110%nat;116%nat;32%nat;101%nat;120%nat;99%nat;101%nat;101%nat;100%nat;115%nat;32%nat;97%nat;99%nat;116%nat;117%nat;97%nat;108%nat;32%nat;103%nat;97%nat;115%nat;32%nat;99%nat;111%nat;115%nat;116%nat;224%nat;106%nat;74%nat;17%nat;206%nat;110%nat;158%nat;78%nat;17%nat;80%nat;208%nat;69%nat;106%nat;55%nat;3%nat;0%nat;95%nat;34%nat;65%nat;155%nat;246%nat;103%nat;206%nat;65%nat;230%nat;63%nat;24%nat;132%nat;110%nat;34%nat;2%nat;64%nat].
Definition source : list Stmt := [(SLet 0%nat (EField ETransaction 0%nat));
 (SLet 1%nat (EGet EContext EKey));
 (SIf (EEq (ELocal 1%nat) (EVal VNull)) [(SLet 2%nat (ENew ArrayKind [(EVal (VBytes [0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat])); (EVal (VInt (0)%Z))]))] [(SLet 2%nat (EDeserialize (ELocal 1%nat)))]);
 (SIf (ENeq (EField (ELocal 2%nat) 0%nat) (ELocal 0%nat)) [(SSetField (ELocal 2%nat) 0%nat (ELocal 0%nat));
 (SSetField (ELocal 2%nat) 1%nat (EVal (VInt (0)%Z)))] []);
 (SLet 3%nat (EBinary Add (EField ETransaction 4%nat) (EField ETransaction 5%nat)));
 (SLet 4%nat (EBinary Sub (EVal (VInt (1)%Z)) (EBinary Min (ELocal 3%nat) (EVal (VInt (1)%Z)))));
 (SLet 5%nat (EBinary Add (EBinary Max (EBinary Sub (ELocal 3%nat) (EField (ELocal 2%nat) 1%nat)) (EVal (VInt (0)%Z))) (EBinary Mul (ELocal 4%nat) (EArg 0%nat))));
 (SLet 6%nat (EBinary Min (EArg 0%nat) (ELocal 5%nat)));
 (SSetField (ELocal 2%nat) 1%nat (EBinary Add (EField (ELocal 2%nat) 1%nat) (ELocal 6%nat)));
 (SExpr (EPut EContext EKey (ESerialize (ELocal 2%nat))));
 (SReturn (ELocal 6%nat))].

Ltac source_norm := cbn [source initial_source eval_expr eval_args bind
 with_local with_heap with_effect with_storage allocate deserialize serialize
 read_field write_field get_storage put_storage value_eqb scalar tx_object
 change pc stack statics arguments locals heap storage effects object_kind fields
 skipn firstn nth_error repeat length app Nat.eqb Nat.leb Nat.ltb Nat.add Nat.sub Nat.mul
 andb orb negb Bool.eqb binary_value forallb].
Ltac state_norm := cbv [with_stack with_local with_heap with_effect with_storage change
  pc stack arguments locals heap storage effects statics object_kind fields tx_object
  firstn skipn nth_error length app repeat Nat.add Nat.sub Nat.mul].
Theorem source_present_classified : forall hash old sf nf q r kind,
 observe (run_source 40 source (initial_source hash sf nf q (VWire kind [VBytes old;VInt r]))) =
 classified (if bytes_eqb old hash then old else hash) sf nf q
 (if bytes_eqb old hash then r else 0) kind
 (VWire kind [VBytes old;VInt r]) [ReadStorage (VWire kind [VBytes old;VInt r]);Deserialized (VWire kind [VBytes old;VInt r])].
Proof.
 intros. destruct (bytes_eqb old hash) eqn:E;
 [destruct (0 <? charge_expression (sf+nf) q r) eqn:Hguard | destruct (0 <? charge_expression (sf+nf) q 0) eqn:Hguard];
 unfold charge_expression in Hguard; cbn [repeat] in E; unfold initial_source, source.
 all: repeat (rewrite run_source_one_step; source_norm; rewrite ?E, ?Hguard; source_norm; state_norm).
 all: unfold classified, charge_expression.
 all: rewrite Hguard; cbn [observe]; source_norm; reflexivity.
Qed.
Print Assumptions source_present_classified.
Theorem source_absent_classified : forall hash sf nf q,
 observe (run_source 40 source (initial_source hash sf nf q VNull)) =
 classified (if bytes_eqb (repeat 0%nat 32) hash then repeat 0%nat 32 else hash)
 sf nf q 0 ArrayKind VNull [ReadStorage VNull].
Proof.
 intros. destruct (bytes_eqb (repeat 0%nat 32) hash) eqn:E;
 destruct (0 <? charge_expression (sf+nf) q 0) eqn:Hguard;
 unfold charge_expression in Hguard; cbn [repeat] in E; unfold initial_source, source.
 all: repeat (rewrite run_source_one_step; source_norm; rewrite ?E, ?Hguard; source_norm; state_norm).
 all: unfold classified, charge_expression.
 all: rewrite Hguard; cbn [observe]; source_norm; reflexivity.
Qed.
Print Assumptions source_absent_classified.


Ltac norm := cbv [artifact decode vm_step with_stack change with_local with_heap
       with_effect with_storage allocate deserialize serialize read_field write_field
       get_storage put_storage value_eqb scalar jump_target signed_byte
       pc stack arguments locals heap storage effects object_kind fields tx_object
       skipn firstn nth_error repeat length app Nat.eqb Nat.leb Nat.ltb Nat.add Nat.sub Nat.mul andb orb negb Bool.eqb checked_binary binary_value statics forallb Z.of_nat Pos.of_succ_nat Pos.succ Z.leb Z.compare].
Ltac drive sf nf q r Heq Hstatic := repeat (first [ progress norm
 | progress (rewrite ?Heq, ?Hstatic)
 | match goal with |- context[Z.to_nat ?z] =>
   let n := eval vm_compute in (Z.to_nat z) in progress change (Z.to_nat z) with n end
 |
   match goal with
   | |- observe (run_vm (S ?fuel) ?code ?s) = _ => rewrite (run_vm_one_step fuel code s)
   end
 | progress (rewrite (Z.min_comm 1 (sf+nf)))
 | progress (rewrite (Z.max_comm 0 (sf+nf-r)))
 | progress (rewrite (Z.min_comm (Z.max (sf+nf-r) 0+(1-Z.min (sf+nf) 1)*q) q))
 | match goal with
   | |- context[checked_integer ?z] => rewrite (checked_integer_in_range z) by (unfold integer_fits in *; lia)
   end
 ]).
Theorem vm_same_hash_classified : forall hash old sf nf q r kind static_values,
 static_values 34%nat = Some (VBuffer [33%nat]) ->
 cap_domain (sf+nf) q r ->
 integer_fits (r + charge_expression (sf+nf) q r) ->
 bytes_eqb old hash = true ->
 observe (run_vm 110 artifact (initial_vm hash sf nf q (VWire kind [VBytes old;VInt r]) static_values)) =
 classified old sf nf q r kind (VWire kind [VBytes old;VInt r])
 [ReadStorage (VWire kind [VBytes old;VInt r]);Deserialized (VWire kind [VBytes old;VInt r])].
Proof.
 intros hash old sf nf q r kind static_values Hstatic Hdom Hsum Heq.
 unfold charge_expression in Hsum.
 pose proof (cap_intermediates_representable (sf+nf) q r Hdom) as [H1 [H2 [H3 [H4 [H5 [H6 H7]]]]]].
 assert (Hcost : integer_fits (sf+nf)) by (apply nonnegative_integer_fits; destruct Hdom as [H _]; exact H).
 pose proof integer_limit_positive as HL.
 assert (Hsmall : 8 < integer_limit) by (vm_compute; reflexivity).
 unfold initial_vm, classified, charge_expression, method_error.
 drive sf nf q r Heq Hstatic.
 destruct (0 <? Z.min q (Z.max (sf+nf-r) 0+(1-Z.min (sf+nf) 1)*q)) eqn:Hpositive; drive sf nf q r Heq Hstatic.
 all: cbv [observe]; norm; reflexivity.
Qed.
Print Assumptions vm_same_hash_classified.
Theorem vm_different_hash_classified : forall hash old sf nf q r kind static_values,
 static_values 34%nat = Some (VBuffer [33%nat]) ->
 cap_domain (sf+nf) q 0 ->
 integer_fits (0 + charge_expression (sf+nf) q 0) ->
 bytes_eqb old hash = false ->
 observe (run_vm 110 artifact (initial_vm hash sf nf q (VWire kind [VBytes old;VInt r]) static_values)) =
 classified hash sf nf q 0 kind (VWire kind [VBytes old;VInt r])
 [ReadStorage (VWire kind [VBytes old;VInt r]);Deserialized (VWire kind [VBytes old;VInt r])].
Proof.
 intros hash old sf nf q r kind static_values Hstatic Hdom Hsum Heq.
 unfold charge_expression in Hsum.
 pose proof (cap_intermediates_representable (sf+nf) q 0 Hdom) as [H1 [H2 [H3 [H4 [H5 [H6 H7]]]]]].
 assert (Hcost : integer_fits (sf+nf)) by (apply nonnegative_integer_fits; destruct Hdom as [H _]; exact H).
 pose proof integer_limit_positive as HL.
 assert (Hsmall : 8 < integer_limit) by (vm_compute; reflexivity).
 unfold initial_vm, classified, charge_expression, method_error.
 drive sf nf q constr:(0) Heq Hstatic.
 destruct (0 <? Z.min q (Z.max (sf+nf-0) 0+(1-Z.min (sf+nf) 1)*q)) eqn:Hpositive;
 drive sf nf q constr:(0) Heq Hstatic.
 all: cbv [observe]; norm; reflexivity.
Qed.
Print Assumptions vm_different_hash_classified.


Theorem vm_absent_classified : forall hash sf nf q static_values,
 static_values 34%nat = Some (VBuffer [33%nat]) ->
 cap_domain (sf+nf) q 0 ->
 integer_fits (0 + charge_expression (sf+nf) q 0) ->
 observe (run_vm 110 artifact (initial_vm hash sf nf q VNull static_values)) =
 classified (if bytes_eqb (repeat 0%nat 32) hash then repeat 0%nat 32 else hash)
 sf nf q 0 ArrayKind VNull [ReadStorage VNull].
Proof.
 intros hash sf nf q static_values Hstatic Hdom Hsum.
 unfold charge_expression in Hsum.
 pose proof (cap_intermediates_representable (sf+nf) q 0 Hdom) as [H1 [H2 [H3 [H4 [H5 [H6 H7]]]]]].
 assert (Hcost : integer_fits (sf+nf)) by (apply nonnegative_integer_fits; destruct Hdom as [H _]; exact H).
 pose proof integer_limit_positive as HL.
 assert (Hsmall : 8 < integer_limit) by (vm_compute; reflexivity).
 destruct (bytes_eqb (repeat 0%nat 32) hash) eqn:Heq;
 cbn [repeat] in Heq;
 unfold initial_vm, classified, charge_expression, method_error;
 drive sf nf q constr:(0) Heq Hstatic.
 all: destruct (0 <? Z.min q (Z.max (sf+nf-0) 0+(1-Z.min (sf+nf) 1)*q)) eqn:Hpositive;
 drive sf nf q constr:(0) Heq Hstatic.
 all: cbv [observe]; norm; reflexivity.
Qed.
Print Assumptions vm_absent_classified.


Theorem source_method_classified : forall hash sf nf q input,
 legal_inputs hash sf nf q input ->
 observe (run_source 40 source (initial_source hash sf nf q (stored_value input))) =
 contract_observation hash sf nf q input.
Proof.
 intros hash sf nf q input Hlegal.
 pose proof (classified_refines_contract hash sf nf q input Hlegal) as Hcontract.
 destruct input as [|kind old reserved].
 - cbn [stored_value input_kind effective_reserved input_trace] in *.
   rewrite source_absent_classified.
   replace (if bytes_eqb (repeat 0%nat 32) hash then repeat 0%nat 32 else hash) with hash.
   + exact Hcontract.
   + destruct (bytes_eqb (repeat 0%nat 32) hash) eqn:E; [|reflexivity].
     symmetry. apply bytes_eqb_true. exact E.
 - cbn [stored_value input_kind effective_reserved input_trace] in *.
   rewrite source_present_classified.
   destruct (bytes_eqb old hash) eqn:E.
   + rewrite (bytes_eqb_true old hash E). rewrite (bytes_eqb_true old hash E) in Hcontract. exact Hcontract.
   + exact Hcontract.
Qed.
Print Assumptions source_method_classified.
Theorem vm_method_classified : forall hash sf nf q input static_values,
 legal_inputs hash sf nf q input ->
 static_values 34%nat = Some (VBuffer [33%nat]) ->
 observe (run_vm 110 artifact (initial_vm hash sf nf q (stored_value input) static_values)) =
 contract_observation hash sf nf q input.
Proof.
 intros hash sf nf q input static_values Hlegal Hstatic.
 pose proof (legal_cap_domain hash sf nf q input Hlegal) as Hdomain.
 pose proof (legal_update_fits hash sf nf q input Hlegal) as Hsum.
 pose proof (classified_refines_contract hash sf nf q input Hlegal) as Hcontract.
 destruct input as [|kind old reserved].
 - cbn [stored_value input_kind effective_reserved input_trace] in *.
   rewrite vm_absent_classified by assumption.
   replace (if bytes_eqb (repeat 0%nat 32) hash then repeat 0%nat 32 else hash) with hash.
   + exact Hcontract.
   + destruct (bytes_eqb (repeat 0%nat 32) hash) eqn:E; [|reflexivity].
     symmetry. apply bytes_eqb_true. exact E.
 - cbn [stored_value input_kind effective_reserved input_trace] in *.
   destruct (bytes_eqb old hash) eqn:E.
   + rewrite vm_same_hash_classified by assumption.
     rewrite (bytes_eqb_true old hash E). rewrite (bytes_eqb_true old hash E) in Hcontract. exact Hcontract.
   + rewrite vm_different_hash_classified by assumption. exact Hcontract.
Qed.
Theorem complete_helper_reference_refinement : forall hash sf nf q input static_values,
 legal_inputs hash sf nf q input ->
 static_values 34%nat = Some (VBuffer [33%nat]) ->
 observe (run_vm 110 artifact (initial_vm hash sf nf q (stored_value input) static_values)) =
 observe (run_source 40 source (initial_source hash sf nf q (stored_value input))).
Proof. intros. rewrite vm_method_classified by assumption.
 symmetry. apply source_method_classified. assumption. Qed.

Theorem complete_helper_no_fault_or_timeout : forall hash sf nf q input static_values,
 legal_inputs hash sf nf q input ->
 static_values 34%nat = Some (VBuffer [33%nat]) ->
 exists s, (exists result, run_vm 110 artifact (initial_vm hash sf nf q (stored_value input) static_values) = Halt result s)
        \/ (exists message, run_vm 110 artifact (initial_vm hash sf nf q (stored_value input) static_values) = Aborted message s).
Proof.
 intros. pose proof (vm_method_classified hash sf nf q input static_values H H0) as Hclass.
 unfold contract_observation in Hclass.
 destruct (0 <? source_charge (sf+nf) q (effective_reserved hash input));
 destruct (run_vm 110 artifact (initial_vm hash sf nf q (stored_value input) static_values));
 cbn [observe] in Hclass; try discriminate; eauto.
Qed.
Theorem complete_helper_paid_exhaustion_aborts : forall hash sf nf q input static_values,
 legal_inputs hash sf nf q input ->
 static_values 34%nat = Some (VBuffer [33%nat]) ->
 0 < sf+nf -> sf+nf <= effective_reserved hash input ->
 observe (run_vm 110 artifact (initial_vm hash sf nf q (stored_value input) static_values)) =
 Rejected method_error (stored_value input) (input_trace input).
Proof.
 intros hash sf nf q input static_values Hlegal Hstatic Hpaid Hspent.
 rewrite vm_method_classified by assumption.
 pose proof (legal_cap_domain hash sf nf q input Hlegal) as [_ [Hq Hr]].
 unfold contract_observation, source_charge.
 assert (E : (sf+nf =? 0) = false) by (apply Z.eqb_neq; lia).
 rewrite E, Z.max_r by lia. rewrite Z.min_r by lia. reflexivity.
Qed.

Definition reviewed_statics (slot : nat) := if Nat.eqb slot 34 then Some (VBuffer [33%nat]) else None.
Example actual_nonempty_success :
 observe (run_vm 110 artifact (initial_vm (repeat 1%nat 32) 50 10 90 VNull reviewed_statics)) =
 Returned (VInt 60) (VWire ArrayKind [VBytes (repeat 1%nat 32);VInt 60])
 [ReadStorage VNull;Serialized (VWire ArrayKind [VBytes (repeat 1%nat 32);VInt 60]);
 WroteStorage (VWire ArrayKind [VBytes (repeat 1%nat 32);VInt 60])].
Proof. vm_compute. reflexivity. Qed.
Example actual_zero_estimation_overflow_counterexample :
 let before := VWire StructKind [VBytes (repeat 1%nat 32);VInt (integer_limit-1)] in
 let after := VWire StructKind [VBytes (repeat 1%nat 32);VInt integer_limit] in
 observe (run_vm 110 artifact (initial_vm (repeat 1%nat 32) 0 0 1 before reviewed_statics)) =
 Faulted before [ReadStorage before;Deserialized before] /\
 observe (run_source 40 source (initial_source (repeat 1%nat 32) 0 0 1 before)) =
 Returned (VInt 1) after [ReadStorage before;Deserialized before;Serialized after;WroteStorage after].
Proof. vm_compute. split; reflexivity. Qed.
Print Assumptions vm_method_classified.
Print Assumptions complete_helper_reference_refinement.
Print Assumptions complete_helper_no_fault_or_timeout.
Print Assumptions complete_helper_paid_exhaustion_aborts.
Print Assumptions actual_nonempty_success.
Print Assumptions actual_zero_estimation_overflow_counterexample.

