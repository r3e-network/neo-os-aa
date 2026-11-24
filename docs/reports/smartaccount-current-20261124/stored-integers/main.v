From Coq Require Import ZArith List Bool.
Require Import IntegerSemantics CapMethodVm CapContext StorageGetter StorageGetterVm.
Import ListNotations. Open Scope Z_scope.
Definition lookup_slot (s:InitOutcome) (i:nat) :=
 match s with InitReturned r => match init_slots r with
 | Some xs => nth_error xs i | _ => None end | _ => None end.
Definition expected (payload:option bytes) (delay:Z) :=
 match payload with None => Done (GInt 0)
 | Some b => match NumericCoercions.byte_string_integer b with
 | Some z => match checked_integer (z + delay) with Some v => Done (GInt v) | None => Thrown end
 | None => Thrown end end.
Definition expected_read (payload:option bytes) :=
 match payload with None => Done (GInt 0) | Some b => match NumericCoercions.byte_string_integer b with
 | Some z => Done (GInt z) | None => Thrown end end.
Definition read_field (s:InitOutcome) i :=
 match lookup_slot s i with Some (VBuffer b) => Some (GBytes b)
 | Some (VInt z) => Some (GInt z) | _ => None end.
Local Opaque integer_fitsb.
Definition init_code : list nat := [86%nat;50%nat;12%nat;4%nat;170%nat;82%nat;71%nat;1%nat;219%nat;48%nat;96%nat;12%nat;15%nat;115%nat;101%nat;116%nat;68%nat;75%nat;73%nat;77%nat;82%nat;101%nat;103%nat;105%nat;115%nat;116%nat;114%nat;121%nat;12%nat;18%nat;99%nat;114%nat;101%nat;97%nat;116%nat;101%nat;83%nat;117%nat;98%nat;115%nat;99%nat;114%nat;105%nat;112%nat;116%nat;105%nat;111%nat;110%nat;12%nat;9%nat;115%nat;101%nat;116%nat;67%nat;111%nat;110%nat;102%nat;105%nat;103%nat;12%nat;15%nat;99%nat;108%nat;101%nat;97%nat;114%nat;83%nat;101%nat;115%nat;115%nat;105%nat;111%nat;110%nat;75%nat;101%nat;121%nat;12%nat;13%nat;115%nat;101%nat;116%nat;83%nat;101%nat;115%nat;115%nat;105%nat;111%nat;110%nat;75%nat;101%nat;121%nat;12%nat;12%nat;99%nat;108%nat;101%nat;97%nat;114%nat;65%nat;99%nat;99%nat;111%nat;117%nat;110%nat;116%nat;22%nat;192%nat;103%nat;9%nat;12%nat;12%nat;99%nat;108%nat;101%nat;97%nat;114%nat;65%nat;99%nat;99%nat;111%nat;117%nat;110%nat;116%nat;12%nat;9%nat;115%nat;101%nat;116%nat;67%nat;111%nat;110%nat;102%nat;105%nat;103%nat;12%nat;8%nat;115%nat;101%nat;116%nat;72%nat;111%nat;111%nat;107%nat;115%nat;12%nat;11%nat;115%nat;101%nat;116%nat;82%nat;101%nat;103%nat;105%nat;115%nat;116%nat;114%nat;121%nat;12%nat;38%nat;114%nat;101%nat;113%nat;117%nat;105%nat;114%nat;101%nat;67%nat;114%nat;101%nat;100%nat;101%nat;110%nat;116%nat;105%nat;97%nat;108%nat;67%nat;111%nat;109%nat;109%nat;105%nat;116%nat;109%nat;101%nat;110%nat;116%nat;70%nat;111%nat;114%nat;67%nat;111%nat;110%nat;116%nat;114%nat;97%nat;99%nat;116%nat;12%nat;18%nat;115%nat;101%nat;116%nat;82%nat;101%nat;115%nat;116%nat;114%nat;105%nat;99%nat;116%nat;101%nat;100%nat;84%nat;111%nat;107%nat;101%nat;110%nat;12%nat;12%nat;115%nat;101%nat;116%nat;87%nat;104%nat;105%nat;116%nat;101%nat;108%nat;105%nat;115%nat;116%nat;12%nat;13%nat;115%nat;101%nat;116%nat;68%nat;97%nat;105%nat;108%nat;121%nat;76%nat;105%nat;109%nat;105%nat;116%nat;24%nat;192%nat;103%nat;11%nat;12%nat;1%nat;17%nat;219%nat;48%nat;103%nat;13%nat;12%nat;1%nat;26%nat;219%nat;48%nat;103%nat;16%nat;12%nat;1%nat;27%nat;219%nat;48%nat;103%nat;17%nat;12%nat;1%nat;20%nat;219%nat;48%nat;103%nat;18%nat;2%nat;0%nat;132%nat;12%nat;36%nat;103%nat;19%nat;12%nat;1%nat;21%nat;219%nat;48%nat;103%nat;20%nat;12%nat;1%nat;22%nat;219%nat;48%nat;103%nat;21%nat;12%nat;1%nat;18%nat;219%nat;48%nat;103%nat;14%nat;12%nat;1%nat;19%nat;219%nat;48%nat;103%nat;15%nat;12%nat;1%nat;1%nat;219%nat;48%nat;97%nat;12%nat;1%nat;2%nat;219%nat;48%nat;103%nat;29%nat;12%nat;1%nat;3%nat;219%nat;48%nat;103%nat;27%nat;12%nat;1%nat;4%nat;219%nat;48%nat;98%nat;12%nat;1%nat;5%nat;219%nat;48%nat;103%nat;7%nat;12%nat;1%nat;6%nat;219%nat;48%nat;99%nat;12%nat;1%nat;7%nat;219%nat;48%nat;100%nat;12%nat;1%nat;8%nat;219%nat;48%nat;103%nat;22%nat;12%nat;1%nat;9%nat;219%nat;48%nat;103%nat;8%nat;12%nat;1%nat;10%nat;219%nat;48%nat;101%nat;12%nat;1%nat;11%nat;219%nat;48%nat;103%nat;25%nat;12%nat;1%nat;12%nat;219%nat;48%nat;103%nat;24%nat;12%nat;1%nat;13%nat;219%nat;48%nat;103%nat;28%nat;12%nat;1%nat;14%nat;219%nat;48%nat;103%nat;26%nat;12%nat;1%nat;15%nat;219%nat;48%nat;103%nat;10%nat;12%nat;1%nat;16%nat;219%nat;48%nat;103%nat;12%nat;12%nat;1%nat;28%nat;219%nat;48%nat;103%nat;44%nat;1%nat;240%nat;0%nat;103%nat;43%nat;2%nat;128%nat;238%nat;54%nat;0%nat;103%nat;23%nat;2%nat;0%nat;92%nat;38%nat;5%nat;102%nat;12%nat;1%nat;29%nat;219%nat;48%nat;103%nat;30%nat;2%nat;0%nat;132%nat;12%nat;36%nat;103%nat;31%nat;12%nat;1%nat;23%nat;219%nat;48%nat;103%nat;33%nat;12%nat;1%nat;24%nat;219%nat;48%nat;103%nat;39%nat;12%nat;1%nat;25%nat;219%nat;48%nat;103%nat;40%nat;12%nat;1%nat;30%nat;219%nat;48%nat;103%nat;34%nat;12%nat;1%nat;31%nat;219%nat;48%nat;103%nat;38%nat;12%nat;4%nat;170%nat;82%nat;71%nat;2%nat;219%nat;48%nat;103%nat;32%nat;12%nat;2%nat;12%nat;20%nat;219%nat;48%nat;103%nat;35%nat;12%nat;13%nat;17%nat;192%nat;31%nat;12%nat;6%nat;118%nat;101%nat;114%nat;105%nat;102%nat;121%nat;12%nat;20%nat;219%nat;48%nat;103%nat;36%nat;12%nat;5%nat;65%nat;98%nat;125%nat;91%nat;82%nat;219%nat;48%nat;103%nat;37%nat;12%nat;4%nat;22%nat;38%nat;186%nat;126%nat;219%nat;48%nat;103%nat;42%nat;12%nat;4%nat;255%nat;255%nat;255%nat;255%nat;219%nat;48%nat;103%nat;41%nat;12%nat;2%nat;12%nat;20%nat;219%nat;48%nat;103%nat;46%nat;12%nat;2%nat;18%nat;192%nat;219%nat;48%nat;103%nat;47%nat;12%nat;15%nat;12%nat;13%nat;101%nat;120%nat;101%nat;99%nat;117%nat;116%nat;101%nat;85%nat;115%nat;101%nat;114%nat;79%nat;112%nat;219%nat;48%nat;103%nat;48%nat;12%nat;16%nat;12%nat;14%nat;101%nat;120%nat;101%nat;99%nat;117%nat;116%nat;101%nat;85%nat;115%nat;101%nat;114%nat;79%nat;112%nat;115%nat;219%nat;48%nat;103%nat;49%nat;12%nat;5%nat;65%nat;98%nat;125%nat;91%nat;82%nat;219%nat;48%nat;103%nat;45%nat;64%nat].
Definition getMarketEscrowListingId_ops : list Ins := [InitSlot 2 1;LdStatic 4;LdArg;Convert 48;Concat;StLoc 0;LdLoc 0;GetContext;StorageGet;StLoc 1;LdLoc 1;Push GNull;EqualIns;JumpIfNot 16;Push (GInt 0);Jump 24;LdLoc 1;Dup;IsNull;JumpIfNot 23;Drop;Push (GInt 0);Jump 24;Convert 33;Jump 25;Ret].
Definition getMarketEscrowListingId_init hp (account:bytes) := run_init 161 init_code (initializer_entry hp [VBytes account]).
Lemma getMarketEscrowListingId_slot4 : forall hp account,
 read_field (getMarketEscrowListingId_init hp account) 4 = Some (GBytes [7%nat]).
Proof. intros; vm_compute; reflexivity. Qed.
Theorem getMarketEscrowListingId_result : forall hp (account:bytes) (store:storage),
 run 26 0 (fun pc => nth pc getMarketEscrowListingId_ops Unsupported)
 (machine [] [] [GBytes account] (read_field (getMarketEscrowListingId_init hp account)) store [] (fun _ _ => GNull))
 = expected_read (store (7%nat :: account)).
Proof. intros hp account store.
 remember (read_field (getMarketEscrowListingId_init hp account)) as fields eqn:F.
 assert (H4: fields 4%nat = Some (GBytes [7%nat])) by (rewrite F; apply getMarketEscrowListingId_slot4).
 clear F. destruct (store (7%nat :: account)) as [b|] eqn:Hstore.
 - destruct (NumericCoercions.byte_string_integer b) as [z|] eqn:E.
   1: assert (D: decode_integer b = OK (GInt z)) by (unfold decode_integer; rewrite E; reflexivity).
   2: assert (D: decode_integer b = Fault) by (unfold decode_integer; rewrite E; reflexivity).
   all: unfold expected, expected_read, checked_integer; unfold getMarketEscrowListingId_ops;
   repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
       mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gbytes_eqb gval_eqb negb Nat.eqb andb]
       | multimatch goal with H : ?l = ?r |- _ => progress rewrite H end
       | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end]; reflexivity.
 - unfold expected, expected_read, getMarketEscrowListingId_ops; repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
       mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gbytes_eqb gval_eqb negb Nat.eqb andb]
       | multimatch goal with H : ?l = ?r |- _ => progress rewrite H end
       | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end]; reflexivity.
Qed.
Print Assumptions getMarketEscrowListingId_result.
Definition getAdminTransferAvailableAt_ops : list Ins := [InitSlot 1 0;LdStatic 21;GetContext;StorageGet;StLoc 0;LdLoc 0;Push GNull;EqualIns;JumpIfNot 11;Push (GInt 0);Jump 21;LdLoc 0;Dup;IsNull;JumpIfNot 18;Drop;Push (GInt 0);Jump 19;Convert 33;LdStatic 19;AddIns;Jump 22;Ret].
Definition getAdminTransferAvailableAt_init hp (account:bytes) := run_init 161 init_code (initializer_entry hp []).
Lemma getAdminTransferAvailableAt_slot21 : forall hp account,
 read_field (getAdminTransferAvailableAt_init hp account) 21 = Some (GBytes [22%nat]).
Proof. intros; vm_compute; reflexivity. Qed.
Lemma getAdminTransferAvailableAt_slot19 : forall hp account,
 read_field (getAdminTransferAvailableAt_init hp account) 19 = Some (GInt 604800000).
Proof. intros; vm_compute; reflexivity. Qed.
Theorem getAdminTransferAvailableAt_result : forall hp (account:bytes) (store:storage),
 run 23 0 (fun pc => nth pc getAdminTransferAvailableAt_ops Unsupported)
 (machine [] [] [] (read_field (getAdminTransferAvailableAt_init hp account)) store [] (fun _ _ => GNull))
 = expected (store [22%nat]) 604800000.
Proof. intros hp account store.
 remember (read_field (getAdminTransferAvailableAt_init hp account)) as fields eqn:F.
 assert (H21: fields 21%nat = Some (GBytes [22%nat])) by (rewrite F; apply getAdminTransferAvailableAt_slot21).
 assert (H19: fields 19%nat = Some (GInt 604800000)) by (rewrite F; apply getAdminTransferAvailableAt_slot19).
 clear F. destruct (store [22%nat]) as [b|] eqn:Hstore.
 - destruct (NumericCoercions.byte_string_integer b) as [z|] eqn:E.
   1: assert (D: decode_integer b = OK (GInt z)) by (unfold decode_integer; rewrite E; reflexivity).
   2: assert (D: decode_integer b = Fault) by (unfold decode_integer; rewrite E; reflexivity).
   all: try destruct (integer_fitsb (z + 604800000)) eqn:B; unfold expected, expected_read, checked_integer; unfold getAdminTransferAvailableAt_ops;
   repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
       mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gbytes_eqb gval_eqb negb Nat.eqb andb]
       | multimatch goal with H : ?l = ?r |- _ => progress rewrite H end
       | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end]; reflexivity.
 - unfold expected, expected_read, getAdminTransferAvailableAt_ops; repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
       mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gbytes_eqb gval_eqb negb Nat.eqb andb]
       | multimatch goal with H : ?l = ?r |- _ => progress rewrite H end
       | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end]; reflexivity.
Qed.
Print Assumptions getAdminTransferAvailableAt_result.
Definition getPlatformRegistrarAvailableAt_ops : list Ins := [InitSlot 1 0;LdStatic 40;GetContext;StorageGet;StLoc 0;LdLoc 0;Push GNull;EqualIns;JumpIfNot 11;Push (GInt 0);Jump 21;LdLoc 0;Dup;IsNull;JumpIfNot 18;Drop;Push (GInt 0);Jump 19;Convert 33;LdStatic 19;AddIns;Jump 22;Ret].
Definition getPlatformRegistrarAvailableAt_init hp (account:bytes) := run_init 161 init_code (initializer_entry hp []).
Lemma getPlatformRegistrarAvailableAt_slot40 : forall hp account,
 read_field (getPlatformRegistrarAvailableAt_init hp account) 40 = Some (GBytes [25%nat]).
Proof. intros; vm_compute; reflexivity. Qed.
Lemma getPlatformRegistrarAvailableAt_slot19 : forall hp account,
 read_field (getPlatformRegistrarAvailableAt_init hp account) 19 = Some (GInt 604800000).
Proof. intros; vm_compute; reflexivity. Qed.
Theorem getPlatformRegistrarAvailableAt_result : forall hp (account:bytes) (store:storage),
 run 23 0 (fun pc => nth pc getPlatformRegistrarAvailableAt_ops Unsupported)
 (machine [] [] [] (read_field (getPlatformRegistrarAvailableAt_init hp account)) store [] (fun _ _ => GNull))
 = expected (store [25%nat]) 604800000.
Proof. intros hp account store.
 remember (read_field (getPlatformRegistrarAvailableAt_init hp account)) as fields eqn:F.
 assert (H40: fields 40%nat = Some (GBytes [25%nat])) by (rewrite F; apply getPlatformRegistrarAvailableAt_slot40).
 assert (H19: fields 19%nat = Some (GInt 604800000)) by (rewrite F; apply getPlatformRegistrarAvailableAt_slot19).
 clear F. destruct (store [25%nat]) as [b|] eqn:Hstore.
 - destruct (NumericCoercions.byte_string_integer b) as [z|] eqn:E.
   1: assert (D: decode_integer b = OK (GInt z)) by (unfold decode_integer; rewrite E; reflexivity).
   2: assert (D: decode_integer b = Fault) by (unfold decode_integer; rewrite E; reflexivity).
   all: try destruct (integer_fitsb (z + 604800000)) eqn:B; unfold expected, expected_read, checked_integer; unfold getPlatformRegistrarAvailableAt_ops;
   repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
       mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gbytes_eqb gval_eqb negb Nat.eqb andb]
       | multimatch goal with H : ?l = ?r |- _ => progress rewrite H end
       | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end]; reflexivity.
 - unfold expected, expected_read, getPlatformRegistrarAvailableAt_ops; repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
       mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gbytes_eqb gval_eqb negb Nat.eqb andb]
       | multimatch goal with H : ?l = ?r |- _ => progress rewrite H end
       | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end]; reflexivity.
Qed.
Print Assumptions getPlatformRegistrarAvailableAt_result.
