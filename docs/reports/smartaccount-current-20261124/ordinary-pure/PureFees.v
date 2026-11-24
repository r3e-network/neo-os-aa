From Coq Require Import NArith List Lia String. Require Import PathFee QueryFee. Import ListNotations. Open Scope string_scope. Open Scope N_scope.
Definition push_weight bytes := let n := N.of_nat (String.length bytes) in
 if n <=? 255 then 8 else if n <=? 65535 then 512 else 4096.
Definition common_prefix : list N := [1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0].
Definition prefix (has_arg:bool) bytes := List.app
 (if has_arg then push_weight bytes :: [1;2048] else [16]) common_prefix.
Definition prefix_units (has_arg:bool) bytes := if has_arg then
 push_weight bytes + 416371 else 414338.
Lemma prefix_exact : forall h b, units (prefix h b) = prefix_units h b.
Proof. intros [] b; unfold prefix, prefix_units; cbn [List.app units]; reflexivity. Qed.
Definition suffix outcome : list N := match outcome with Returned _ => [0] | _ => [] end.
Lemma suffix_free : forall o, units (suffix o) = 0. Proof. destruct o; reflexivity. Qed.
Lemma push_ceiling : forall b, push_weight b <= 4096.
Proof. intro b. unfold push_weight. generalize (N.of_nat (String.length b)). intro n.
 destruct (n <=? 255), (n <=? 65535); vm_compute; discriminate || reflexivity. Qed.
Definition getAccountImplementationId_program : list (op*N) := [(Lit "org.r3e.neo.aa.unified-smart-wallet.v3",8%N);(Go 2%nat,2%N);(Return,0%N)].
Definition getAccountImplementationId_expected (large:bool) (equal:string->bool) : exit*N := (Returned (Text "org.r3e.neo.aa.unified-smart-wallet.v3"),10%N).
Definition getAccountImplementationId_lookup  := (fun s : string => false).
Theorem getAccountImplementationId_any_input : forall (large :bool),
 walk 24 0 getAccountImplementationId_program [] large (getAccountImplementationId_lookup ) 0 = getAccountImplementationId_expected large (getAccountImplementationId_lookup ).
Proof. intros. destruct large;  vm_compute; reflexivity. Qed.
Corollary getAccountImplementationId_any_bytes : forall bytes,
 let large := Nat.ltb 65536 (String.length bytes) in
 walk 24 0 getAccountImplementationId_program [] large (getAccountImplementationId_lookup ) 0 = getAccountImplementationId_expected large (String.eqb bytes).
Proof. intro bytes. cbv zeta. rewrite getAccountImplementationId_any_input. reflexivity. Qed.
Print Assumptions getAccountImplementationId_any_bytes.
Theorem getAccountImplementationId_trace_price : forall (large :bool),
 let actual := trace 24 0 getAccountImplementationId_program [] large (getAccountImplementationId_lookup ) [] in
 (fst actual, units (snd actual)) = getAccountImplementationId_expected large (getAccountImplementationId_lookup ).
Proof. intros. destruct large;  vm_compute; reflexivity. Qed.
Definition getAccountImplementationId_body bytes :=
 trace 24 0 getAccountImplementationId_program [] (Nat.ltb 65536 (String.length bytes)) (getAccountImplementationId_lookup ) [].
Definition getAccountImplementationId_cost bytes := getAccountImplementationId_expected (Nat.ltb 65536 (String.length bytes)) (String.eqb bytes).
Lemma getAccountImplementationId_body_exact : forall bytes,
 (fst (getAccountImplementationId_body bytes), units (snd (getAccountImplementationId_body bytes))) = getAccountImplementationId_cost bytes.
Proof. intro bytes. unfold getAccountImplementationId_body, getAccountImplementationId_cost. rewrite getAccountImplementationId_trace_price. reflexivity. Qed.
Definition getAccountImplementationId_charges bytes :=
 List.app (prefix false bytes) (List.app (snd (getAccountImplementationId_body bytes)) (suffix (fst (getAccountImplementationId_body bytes)))).
Theorem getAccountImplementationId_whole_budget : forall bytes factor budget paid,
 let '(outcome,body_units) := getAccountImplementationId_cost bytes in
 settle factor budget 0 (getAccountImplementationId_charges bytes) = Paid paid <->
 let required := factor * (prefix_units false bytes + body_units + units (suffix outcome)) in
 required <= budget /\ paid = required.
Proof. intros. pose proof (getAccountImplementationId_body_exact bytes) as E.
 destruct (getAccountImplementationId_cost bytes) as [o w]. cbn [fst snd] in E.
 inversion E; subst. unfold getAccountImplementationId_charges. rewrite settle_paid by lia.
 rewrite !units_append, prefix_exact. cbn [N.add]. rewrite N.add_assoc. reflexivity. Qed.
Print Assumptions getAccountImplementationId_whole_budget.
Corollary getAccountImplementationId_pico_budget : forall bytes rate budget paid,
 let '(outcome,body_units) := getAccountImplementationId_cost bytes in
 let total := rate * (prefix_units false bytes + body_units + units (suffix outcome)) in
 settle rate (budget * 10000) 0 (getAccountImplementationId_charges bytes) = Paid paid <->
 datoshi total <= budget /\ paid = total.
Proof. intros. pose proof (getAccountImplementationId_whole_budget bytes rate (budget * 10000) paid) as H.
 destruct (getAccountImplementationId_cost bytes) as [o w]. cbv zeta in H |- *. rewrite datoshi_budget in H. exact H. Qed.
Print Assumptions getAccountImplementationId_pico_budget.
Lemma getAccountImplementationId_body_bound : forall large eq,
 snd (getAccountImplementationId_expected large eq) <= 10.
Proof. intros l e. unfold getAccountImplementationId_expected. destruct l;
 repeat match goal with |- context [if ?cond then _ else _] => destruct cond end;
 vm_compute; discriminate || reflexivity. Qed.
Lemma getAccountImplementationId_cost_bound : forall b, snd (getAccountImplementationId_cost b) <= 10.
Proof. intro b. unfold getAccountImplementationId_cost. apply getAccountImplementationId_body_bound. Qed.
Local Opaque getAccountImplementationId_body getAccountImplementationId_cost push_weight.
Lemma getAccountImplementationId_units_bound : forall bytes, units (getAccountImplementationId_charges bytes) <= 414348.
Proof. intro b. unfold getAccountImplementationId_charges. rewrite !units_append, prefix_exact.
 rewrite suffix_free, N.add_0_r.
 pose proof (f_equal (@snd exit N) (getAccountImplementationId_body_exact b)) as E.
 change (units (snd (getAccountImplementationId_body b)) = snd (getAccountImplementationId_cost b)) in E. rewrite E.
 change (414338 + snd (getAccountImplementationId_cost b) <= 414348).
 change (414338 + snd (getAccountImplementationId_cost b) <=
   414338 + 10).
 apply N.add_le_mono; [ reflexivity | apply getAccountImplementationId_cost_bound ]. Qed.
Theorem getAccountImplementationId_readback : forall bytes rate budget prior, rate <= 1000000 ->
 prior + 414348000000 <= max_long * 10000 ->
 let used := amount (settle rate (budget * 10000) prior (getAccountImplementationId_charges bytes)) in
 datoshi used <= max_long /\ fee_readback used budget = datoshi used.
Proof. intros. apply (readback_headroom _ 414348); auto using getAccountImplementationId_units_bound. Qed.
Print Assumptions getAccountImplementationId_readback.
Definition supportsExecutionMode_program : list (op*N) := [(Start,64%N);(Arg,2%N);(Lit "single",8%N);(Eqv,32%N);(BrFalse 7%nat,2%N);(Yes,1%N);(Go 10%nat,2%N);(Arg,2%N);(Lit "batch",8%N);(Eqv,32%N);(BrFalse 13%nat,2%N);(Yes,1%N);(Go 16%nat,2%N);(Arg,2%N);(Lit "batch-atomic",8%N);(Eqv,32%N);(Go 17%nat,2%N);(Return,0%N)].
Definition supportsExecutionMode_expected (large:bool) (equal:string->bool) : exit*N := if large then (Oversize,106%N) else if equal "single" then (Returned (Bit true),118%N) else if equal "batch" then (Returned (Bit true),157%N) else if equal "batch-atomic" then (Returned (Bit true),196%N) else (Returned (Bit false),196%N).
Definition supportsExecutionMode_lookup (b0 b1 b2:bool) := (fun s : string => if String.eqb s "single" then b0 else if String.eqb s "batch" then b1 else if String.eqb s "batch-atomic" then b2 else false).
Theorem supportsExecutionMode_any_input : forall (large b0 b1 b2:bool),
 walk 24 0 supportsExecutionMode_program [] large (supportsExecutionMode_lookup b0 b1 b2) 0 = supportsExecutionMode_expected large (supportsExecutionMode_lookup b0 b1 b2).
Proof. intros. destruct large; destruct b0; destruct b1; destruct b2; vm_compute; reflexivity. Qed.
Corollary supportsExecutionMode_any_bytes : forall bytes,
 let large := Nat.ltb 65536 (String.length bytes) in
 walk 24 0 supportsExecutionMode_program [] large (supportsExecutionMode_lookup (String.eqb bytes "single") (String.eqb bytes "batch") (String.eqb bytes "batch-atomic")) 0 = supportsExecutionMode_expected large (String.eqb bytes).
Proof. intro bytes. cbv zeta. rewrite supportsExecutionMode_any_input. reflexivity. Qed.
Print Assumptions supportsExecutionMode_any_bytes.
Theorem supportsExecutionMode_trace_price : forall (large b0 b1 b2:bool),
 let actual := trace 24 0 supportsExecutionMode_program [] large (supportsExecutionMode_lookup b0 b1 b2) [] in
 (fst actual, units (snd actual)) = supportsExecutionMode_expected large (supportsExecutionMode_lookup b0 b1 b2).
Proof. intros. destruct large; destruct b0; destruct b1; destruct b2; vm_compute; reflexivity. Qed.
Definition supportsExecutionMode_body bytes :=
 trace 24 0 supportsExecutionMode_program [] (Nat.ltb 65536 (String.length bytes)) (supportsExecutionMode_lookup (String.eqb bytes "single") (String.eqb bytes "batch") (String.eqb bytes "batch-atomic")) [].
Definition supportsExecutionMode_cost bytes := supportsExecutionMode_expected (Nat.ltb 65536 (String.length bytes)) (String.eqb bytes).
Lemma supportsExecutionMode_body_exact : forall bytes,
 (fst (supportsExecutionMode_body bytes), units (snd (supportsExecutionMode_body bytes))) = supportsExecutionMode_cost bytes.
Proof. intro bytes. unfold supportsExecutionMode_body, supportsExecutionMode_cost. rewrite supportsExecutionMode_trace_price. reflexivity. Qed.
Definition supportsExecutionMode_charges bytes :=
 List.app (prefix true bytes) (List.app (snd (supportsExecutionMode_body bytes)) (suffix (fst (supportsExecutionMode_body bytes)))).
Theorem supportsExecutionMode_whole_budget : forall bytes factor budget paid,
 let '(outcome,body_units) := supportsExecutionMode_cost bytes in
 settle factor budget 0 (supportsExecutionMode_charges bytes) = Paid paid <->
 let required := factor * (prefix_units true bytes + body_units + units (suffix outcome)) in
 required <= budget /\ paid = required.
Proof. intros. pose proof (supportsExecutionMode_body_exact bytes) as E.
 destruct (supportsExecutionMode_cost bytes) as [o w]. cbn [fst snd] in E.
 inversion E; subst. unfold supportsExecutionMode_charges. rewrite settle_paid by lia.
 rewrite !units_append, prefix_exact. cbn [N.add]. rewrite N.add_assoc. reflexivity. Qed.
Print Assumptions supportsExecutionMode_whole_budget.
Corollary supportsExecutionMode_pico_budget : forall bytes rate budget paid,
 let '(outcome,body_units) := supportsExecutionMode_cost bytes in
 let total := rate * (prefix_units true bytes + body_units + units (suffix outcome)) in
 settle rate (budget * 10000) 0 (supportsExecutionMode_charges bytes) = Paid paid <->
 datoshi total <= budget /\ paid = total.
Proof. intros. pose proof (supportsExecutionMode_whole_budget bytes rate (budget * 10000) paid) as H.
 destruct (supportsExecutionMode_cost bytes) as [o w]. cbv zeta in H |- *. rewrite datoshi_budget in H. exact H. Qed.
Print Assumptions supportsExecutionMode_pico_budget.
Lemma supportsExecutionMode_body_bound : forall large eq,
 snd (supportsExecutionMode_expected large eq) <= 196.
Proof. intros l e. unfold supportsExecutionMode_expected. destruct l;
 repeat match goal with |- context [if ?cond then _ else _] => destruct cond end;
 vm_compute; discriminate || reflexivity. Qed.
Lemma supportsExecutionMode_cost_bound : forall b, snd (supportsExecutionMode_cost b) <= 196.
Proof. intro b. unfold supportsExecutionMode_cost. apply supportsExecutionMode_body_bound. Qed.
Local Opaque supportsExecutionMode_body supportsExecutionMode_cost push_weight.
Lemma supportsExecutionMode_units_bound : forall bytes, units (supportsExecutionMode_charges bytes) <= 420663.
Proof. intro b. unfold supportsExecutionMode_charges. rewrite !units_append, prefix_exact.
 rewrite suffix_free, N.add_0_r.
 pose proof (f_equal (@snd exit N) (supportsExecutionMode_body_exact b)) as E.
 change (units (snd (supportsExecutionMode_body b)) = snd (supportsExecutionMode_cost b)) in E. rewrite E.
 change (push_weight b + 416371 + snd (supportsExecutionMode_cost b) <= 420663).
 change (push_weight b + 416371 + snd (supportsExecutionMode_cost b) <=
   4096 + 416371 + 196).
 apply N.add_le_mono; [ apply N.add_le_mono; [apply push_ceiling | reflexivity] | apply supportsExecutionMode_cost_bound ]. Qed.
Theorem supportsExecutionMode_readback : forall bytes rate budget prior, rate <= 1000000 ->
 prior + 420663000000 <= max_long * 10000 ->
 let used := amount (settle rate (budget * 10000) prior (supportsExecutionMode_charges bytes)) in
 datoshi used <= max_long /\ fee_readback used budget = datoshi used.
Proof. intros. apply (readback_headroom _ 420663); auto using supportsExecutionMode_units_bound. Qed.
Print Assumptions supportsExecutionMode_readback.
Definition supportsModuleType_program : list (op*N) := [(Start,64%N);(Arg,2%N);(Lit "validator",8%N);(Eqv,32%N);(BrFalse 7%nat,2%N);(Yes,1%N);(Go 10%nat,2%N);(Arg,2%N);(Lit "verifier",8%N);(Eqv,32%N);(BrFalse 13%nat,2%N);(Yes,1%N);(Go 16%nat,2%N);(Arg,2%N);(Lit "hook",8%N);(Eqv,32%N);(Go 17%nat,2%N);(Return,0%N)].
Definition supportsModuleType_expected (large:bool) (equal:string->bool) : exit*N := if large then (Oversize,106%N) else if equal "validator" then (Returned (Bit true),118%N) else if equal "verifier" then (Returned (Bit true),157%N) else if equal "hook" then (Returned (Bit true),196%N) else (Returned (Bit false),196%N).
Definition supportsModuleType_lookup (b0 b1 b2:bool) := (fun s : string => if String.eqb s "validator" then b0 else if String.eqb s "verifier" then b1 else if String.eqb s "hook" then b2 else false).
Theorem supportsModuleType_any_input : forall (large b0 b1 b2:bool),
 walk 24 0 supportsModuleType_program [] large (supportsModuleType_lookup b0 b1 b2) 0 = supportsModuleType_expected large (supportsModuleType_lookup b0 b1 b2).
Proof. intros. destruct large; destruct b0; destruct b1; destruct b2; vm_compute; reflexivity. Qed.
Corollary supportsModuleType_any_bytes : forall bytes,
 let large := Nat.ltb 65536 (String.length bytes) in
 walk 24 0 supportsModuleType_program [] large (supportsModuleType_lookup (String.eqb bytes "validator") (String.eqb bytes "verifier") (String.eqb bytes "hook")) 0 = supportsModuleType_expected large (String.eqb bytes).
Proof. intro bytes. cbv zeta. rewrite supportsModuleType_any_input. reflexivity. Qed.
Print Assumptions supportsModuleType_any_bytes.
Theorem supportsModuleType_trace_price : forall (large b0 b1 b2:bool),
 let actual := trace 24 0 supportsModuleType_program [] large (supportsModuleType_lookup b0 b1 b2) [] in
 (fst actual, units (snd actual)) = supportsModuleType_expected large (supportsModuleType_lookup b0 b1 b2).
Proof. intros. destruct large; destruct b0; destruct b1; destruct b2; vm_compute; reflexivity. Qed.
Definition supportsModuleType_body bytes :=
 trace 24 0 supportsModuleType_program [] (Nat.ltb 65536 (String.length bytes)) (supportsModuleType_lookup (String.eqb bytes "validator") (String.eqb bytes "verifier") (String.eqb bytes "hook")) [].
Definition supportsModuleType_cost bytes := supportsModuleType_expected (Nat.ltb 65536 (String.length bytes)) (String.eqb bytes).
Lemma supportsModuleType_body_exact : forall bytes,
 (fst (supportsModuleType_body bytes), units (snd (supportsModuleType_body bytes))) = supportsModuleType_cost bytes.
Proof. intro bytes. unfold supportsModuleType_body, supportsModuleType_cost. rewrite supportsModuleType_trace_price. reflexivity. Qed.
Definition supportsModuleType_charges bytes :=
 List.app (prefix true bytes) (List.app (snd (supportsModuleType_body bytes)) (suffix (fst (supportsModuleType_body bytes)))).
Theorem supportsModuleType_whole_budget : forall bytes factor budget paid,
 let '(outcome,body_units) := supportsModuleType_cost bytes in
 settle factor budget 0 (supportsModuleType_charges bytes) = Paid paid <->
 let required := factor * (prefix_units true bytes + body_units + units (suffix outcome)) in
 required <= budget /\ paid = required.
Proof. intros. pose proof (supportsModuleType_body_exact bytes) as E.
 destruct (supportsModuleType_cost bytes) as [o w]. cbn [fst snd] in E.
 inversion E; subst. unfold supportsModuleType_charges. rewrite settle_paid by lia.
 rewrite !units_append, prefix_exact. cbn [N.add]. rewrite N.add_assoc. reflexivity. Qed.
Print Assumptions supportsModuleType_whole_budget.
Corollary supportsModuleType_pico_budget : forall bytes rate budget paid,
 let '(outcome,body_units) := supportsModuleType_cost bytes in
 let total := rate * (prefix_units true bytes + body_units + units (suffix outcome)) in
 settle rate (budget * 10000) 0 (supportsModuleType_charges bytes) = Paid paid <->
 datoshi total <= budget /\ paid = total.
Proof. intros. pose proof (supportsModuleType_whole_budget bytes rate (budget * 10000) paid) as H.
 destruct (supportsModuleType_cost bytes) as [o w]. cbv zeta in H |- *. rewrite datoshi_budget in H. exact H. Qed.
Print Assumptions supportsModuleType_pico_budget.
Lemma supportsModuleType_body_bound : forall large eq,
 snd (supportsModuleType_expected large eq) <= 196.
Proof. intros l e. unfold supportsModuleType_expected. destruct l;
 repeat match goal with |- context [if ?cond then _ else _] => destruct cond end;
 vm_compute; discriminate || reflexivity. Qed.
Lemma supportsModuleType_cost_bound : forall b, snd (supportsModuleType_cost b) <= 196.
Proof. intro b. unfold supportsModuleType_cost. apply supportsModuleType_body_bound. Qed.
Local Opaque supportsModuleType_body supportsModuleType_cost push_weight.
Lemma supportsModuleType_units_bound : forall bytes, units (supportsModuleType_charges bytes) <= 420663.
Proof. intro b. unfold supportsModuleType_charges. rewrite !units_append, prefix_exact.
 rewrite suffix_free, N.add_0_r.
 pose proof (f_equal (@snd exit N) (supportsModuleType_body_exact b)) as E.
 change (units (snd (supportsModuleType_body b)) = snd (supportsModuleType_cost b)) in E. rewrite E.
 change (push_weight b + 416371 + snd (supportsModuleType_cost b) <= 420663).
 change (push_weight b + 416371 + snd (supportsModuleType_cost b) <=
   4096 + 416371 + 196).
 apply N.add_le_mono; [ apply N.add_le_mono; [apply push_ceiling | reflexivity] | apply supportsModuleType_cost_bound ]. Qed.
Theorem supportsModuleType_readback : forall bytes rate budget prior, rate <= 1000000 ->
 prior + 420663000000 <= max_long * 10000 ->
 let used := amount (settle rate (budget * 10000) prior (supportsModuleType_charges bytes)) in
 datoshi used <= max_long /\ fee_readback used budget = datoshi used.
Proof. intros. apply (readback_headroom _ 420663); auto using supportsModuleType_units_bound. Qed.
Print Assumptions supportsModuleType_readback.
Definition getAccountImplementationId_no_argument_weights : list N := [16;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;8;2;0;0].
Theorem getAccountImplementationId_no_argument_budget : forall factor budget paid,
 settle factor budget 0 getAccountImplementationId_no_argument_weights = Paid paid <->
 factor * 414348 <= budget /\ paid = factor * 414348.
Proof. intros. rewrite settle_paid by lia. change (units getAccountImplementationId_no_argument_weights) with 414348. reflexivity. Qed.
Print Assumptions getAccountImplementationId_no_argument_budget.
Definition supportsExecutionMode_single_weights : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;1;2;2;1;2;2;0;0].
Theorem supportsExecutionMode_single_budget : forall factor budget paid,
 settle factor budget 0 supportsExecutionMode_single_weights = Paid paid <->
 factor * 416497 <= budget /\ paid = factor * 416497.
Proof. intros. rewrite settle_paid by lia. change (units supportsExecutionMode_single_weights) with 416497. reflexivity. Qed.
Print Assumptions supportsExecutionMode_single_budget.
Definition supportsExecutionMode_batch_weights : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;1;2;2;0;0].
Theorem supportsExecutionMode_batch_budget : forall factor budget paid,
 settle factor budget 0 supportsExecutionMode_batch_weights = Paid paid <->
 factor * 416536 <= budget /\ paid = factor * 416536.
Proof. intros. rewrite settle_paid by lia. change (units supportsExecutionMode_batch_weights) with 416536. reflexivity. Qed.
Print Assumptions supportsExecutionMode_batch_budget.
Definition supportsExecutionMode_batch_atomic_weights : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsExecutionMode_batch_atomic_budget : forall factor budget paid,
 settle factor budget 0 supportsExecutionMode_batch_atomic_weights = Paid paid <->
 factor * 416575 <= budget /\ paid = factor * 416575.
Proof. intros. rewrite settle_paid by lia. change (units supportsExecutionMode_batch_atomic_weights) with 416575. reflexivity. Qed.
Print Assumptions supportsExecutionMode_batch_atomic_budget.
Definition supportsExecutionMode_empty_weights : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsExecutionMode_empty_budget : forall factor budget paid,
 settle factor budget 0 supportsExecutionMode_empty_weights = Paid paid <->
 factor * 416575 <= budget /\ paid = factor * 416575.
Proof. intros. rewrite settle_paid by lia. change (units supportsExecutionMode_empty_weights) with 416575. reflexivity. Qed.
Print Assumptions supportsExecutionMode_empty_budget.
Definition supportsExecutionMode_unknown_weights : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsExecutionMode_unknown_budget : forall factor budget paid,
 settle factor budget 0 supportsExecutionMode_unknown_weights = Paid paid <->
 factor * 416575 <= budget /\ paid = factor * 416575.
Proof. intros. rewrite settle_paid by lia. change (units supportsExecutionMode_unknown_weights) with 416575. reflexivity. Qed.
Print Assumptions supportsExecutionMode_unknown_budget.
Definition supportsExecutionMode_integer_weights : list N := [1;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsExecutionMode_integer_budget : forall factor budget paid,
 settle factor budget 0 supportsExecutionMode_integer_weights = Paid paid <->
 factor * 416568 <= budget /\ paid = factor * 416568.
Proof. intros. rewrite settle_paid by lia. change (units supportsExecutionMode_integer_weights) with 416568. reflexivity. Qed.
Print Assumptions supportsExecutionMode_integer_budget.
Definition supportsExecutionMode_bytes255_weights : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsExecutionMode_bytes255_budget : forall factor budget paid,
 settle factor budget 0 supportsExecutionMode_bytes255_weights = Paid paid <->
 factor * 416575 <= budget /\ paid = factor * 416575.
Proof. intros. rewrite settle_paid by lia. change (units supportsExecutionMode_bytes255_weights) with 416575. reflexivity. Qed.
Print Assumptions supportsExecutionMode_bytes255_budget.
Definition supportsExecutionMode_bytes256_weights : list N := [512;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsExecutionMode_bytes256_budget : forall factor budget paid,
 settle factor budget 0 supportsExecutionMode_bytes256_weights = Paid paid <->
 factor * 417079 <= budget /\ paid = factor * 417079.
Proof. intros. rewrite settle_paid by lia. change (units supportsExecutionMode_bytes256_weights) with 417079. reflexivity. Qed.
Print Assumptions supportsExecutionMode_bytes256_budget.
Definition supportsExecutionMode_bytes65535_weights : list N := [512;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsExecutionMode_bytes65535_budget : forall factor budget paid,
 settle factor budget 0 supportsExecutionMode_bytes65535_weights = Paid paid <->
 factor * 417079 <= budget /\ paid = factor * 417079.
Proof. intros. rewrite settle_paid by lia. change (units supportsExecutionMode_bytes65535_weights) with 417079. reflexivity. Qed.
Print Assumptions supportsExecutionMode_bytes65535_budget.
Definition supportsExecutionMode_limit_weights : list N := [4096;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsExecutionMode_limit_budget : forall factor budget paid,
 settle factor budget 0 supportsExecutionMode_limit_weights = Paid paid <->
 factor * 420663 <= budget /\ paid = factor * 420663.
Proof. intros. rewrite settle_paid by lia. change (units supportsExecutionMode_limit_weights) with 420663. reflexivity. Qed.
Print Assumptions supportsExecutionMode_limit_budget.
Definition supportsExecutionMode_over_limit_weights : list N := [4096;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32].
Theorem supportsExecutionMode_over_limit_budget : forall factor budget paid,
 settle factor budget 0 supportsExecutionMode_over_limit_weights = Paid paid <->
 factor * 420573 <= budget /\ paid = factor * 420573.
Proof. intros. rewrite settle_paid by lia. change (units supportsExecutionMode_over_limit_weights) with 420573. reflexivity. Qed.
Print Assumptions supportsExecutionMode_over_limit_budget.
Definition supportsModuleType_validator_weights : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;1;2;2;1;2;2;0;0].
Theorem supportsModuleType_validator_budget : forall factor budget paid,
 settle factor budget 0 supportsModuleType_validator_weights = Paid paid <->
 factor * 416497 <= budget /\ paid = factor * 416497.
Proof. intros. rewrite settle_paid by lia. change (units supportsModuleType_validator_weights) with 416497. reflexivity. Qed.
Print Assumptions supportsModuleType_validator_budget.
Definition supportsModuleType_verifier_weights : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;1;2;2;0;0].
Theorem supportsModuleType_verifier_budget : forall factor budget paid,
 settle factor budget 0 supportsModuleType_verifier_weights = Paid paid <->
 factor * 416536 <= budget /\ paid = factor * 416536.
Proof. intros. rewrite settle_paid by lia. change (units supportsModuleType_verifier_weights) with 416536. reflexivity. Qed.
Print Assumptions supportsModuleType_verifier_budget.
Definition supportsModuleType_hook_weights : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsModuleType_hook_budget : forall factor budget paid,
 settle factor budget 0 supportsModuleType_hook_weights = Paid paid <->
 factor * 416575 <= budget /\ paid = factor * 416575.
Proof. intros. rewrite settle_paid by lia. change (units supportsModuleType_hook_weights) with 416575. reflexivity. Qed.
Print Assumptions supportsModuleType_hook_budget.
Definition supportsModuleType_empty_weights : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsModuleType_empty_budget : forall factor budget paid,
 settle factor budget 0 supportsModuleType_empty_weights = Paid paid <->
 factor * 416575 <= budget /\ paid = factor * 416575.
Proof. intros. rewrite settle_paid by lia. change (units supportsModuleType_empty_weights) with 416575. reflexivity. Qed.
Print Assumptions supportsModuleType_empty_budget.
Definition supportsModuleType_unknown_weights : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsModuleType_unknown_budget : forall factor budget paid,
 settle factor budget 0 supportsModuleType_unknown_weights = Paid paid <->
 factor * 416575 <= budget /\ paid = factor * 416575.
Proof. intros. rewrite settle_paid by lia. change (units supportsModuleType_unknown_weights) with 416575. reflexivity. Qed.
Print Assumptions supportsModuleType_unknown_budget.
Definition supportsModuleType_integer_weights : list N := [1;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsModuleType_integer_budget : forall factor budget paid,
 settle factor budget 0 supportsModuleType_integer_weights = Paid paid <->
 factor * 416568 <= budget /\ paid = factor * 416568.
Proof. intros. rewrite settle_paid by lia. change (units supportsModuleType_integer_weights) with 416568. reflexivity. Qed.
Print Assumptions supportsModuleType_integer_budget.
Definition supportsModuleType_bytes255_weights : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsModuleType_bytes255_budget : forall factor budget paid,
 settle factor budget 0 supportsModuleType_bytes255_weights = Paid paid <->
 factor * 416575 <= budget /\ paid = factor * 416575.
Proof. intros. rewrite settle_paid by lia. change (units supportsModuleType_bytes255_weights) with 416575. reflexivity. Qed.
Print Assumptions supportsModuleType_bytes255_budget.
Definition supportsModuleType_bytes256_weights : list N := [512;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsModuleType_bytes256_budget : forall factor budget paid,
 settle factor budget 0 supportsModuleType_bytes256_weights = Paid paid <->
 factor * 417079 <= budget /\ paid = factor * 417079.
Proof. intros. rewrite settle_paid by lia. change (units supportsModuleType_bytes256_weights) with 417079. reflexivity. Qed.
Print Assumptions supportsModuleType_bytes256_budget.
Definition supportsModuleType_bytes65535_weights : list N := [512;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsModuleType_bytes65535_budget : forall factor budget paid,
 settle factor budget 0 supportsModuleType_bytes65535_weights = Paid paid <->
 factor * 417079 <= budget /\ paid = factor * 417079.
Proof. intros. rewrite settle_paid by lia. change (units supportsModuleType_bytes65535_weights) with 417079. reflexivity. Qed.
Print Assumptions supportsModuleType_bytes65535_budget.
Definition supportsModuleType_limit_weights : list N := [4096;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32;2;2;8;32;2;2;8;32;2;0;0].
Theorem supportsModuleType_limit_budget : forall factor budget paid,
 settle factor budget 0 supportsModuleType_limit_weights = Paid paid <->
 factor * 420663 <= budget /\ paid = factor * 420663.
Proof. intros. rewrite settle_paid by lia. change (units supportsModuleType_limit_weights) with 420663. reflexivity. Qed.
Print Assumptions supportsModuleType_limit_budget.
Definition supportsModuleType_over_limit_weights : list N := [4096;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;8;32].
Theorem supportsModuleType_over_limit_budget : forall factor budget paid,
 settle factor budget 0 supportsModuleType_over_limit_weights = Paid paid <->
 factor * 420573 <= budget /\ paid = factor * 420573.
Proof. intros. rewrite settle_paid by lia. change (units supportsModuleType_over_limit_weights) with 420573. reflexivity. Qed.
Print Assumptions supportsModuleType_over_limit_budget.
Print Assumptions exhausted_at_first_overrun.
Print Assumptions fixed_method_budget.
