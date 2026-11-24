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
Definition getContractAdmin_ops : list Ins := [InitSlot 1 0;LdStatic 13;GetContext;StorageGet;StLoc 0;LdLoc 0;Push GNull;EqualIns;JumpIfNot 11;Push (GBytes [0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat]);Jump 20;LdLoc 0;Dup;IsNull;JumpIf 20;Dup;SizeIns;Push (GInt 20%Z);JumpEq 20;Throw;Jump 21;Ret].
Definition getContractAdmin_fields hp (account : bytes) :=
 read_field (run_init 161 init_code (initializer_entry hp [])).
Lemma getContractAdmin_prefix : forall hp account,
 getContractAdmin_fields hp account 13%nat = Some (GBytes [17%nat]).
Proof. intros; vm_compute; reflexivity. Qed.
Theorem getContractAdmin_result : forall hp (account : bytes) (store : storage),
 run 22 0 (fun pc => nth pc getContractAdmin_ops Unsupported)
 (machine [] [] [] (getContractAdmin_fields hp account) store [] (fun _ _ => GNull)) =
 match store [17%nat] with None => Done (GBytes (repeat 0%nat 20))
 | Some b => if Z.eqb (Z.of_nat (length b)) 20 then Done (GBytes b) else Thrown end.
Proof. intros. remember (getContractAdmin_fields hp account) as fields eqn:F.
 assert (P:fields 13%nat = Some (GBytes [17%nat])) by (rewrite F; apply getContractAdmin_prefix).
 clear F. unfold getContractAdmin_ops. destruct (store [17%nat]) as [b|] eqn:E.
 - destruct (Z.eqb (Z.of_nat (length b)) 20) eqn:B; repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
  mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gval_size
  gbytes_eqb gval_eqb negb Nat.eqb andb] | multimatch goal with H : ?l = ?r |- _ =>
  progress rewrite H end | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end];
  reflexivity.
 - repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
  mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gval_size
  gbytes_eqb gval_eqb negb Nat.eqb andb] | multimatch goal with H : ?l = ?r |- _ =>
  progress rewrite H end | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end];
  reflexivity.
Qed.
Print Assumptions getContractAdmin_result.
Definition getPendingContractAdmin_ops : list Ins := [InitSlot 1 0;LdStatic 20;GetContext;StorageGet;StLoc 0;LdLoc 0;Push GNull;EqualIns;JumpIfNot 11;Push (GBytes [0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat]);Jump 20;LdLoc 0;Dup;IsNull;JumpIf 20;Dup;SizeIns;Push (GInt 20%Z);JumpEq 20;Throw;Jump 21;Ret].
Definition getPendingContractAdmin_fields hp (account : bytes) :=
 read_field (run_init 161 init_code (initializer_entry hp [])).
Lemma getPendingContractAdmin_prefix : forall hp account,
 getPendingContractAdmin_fields hp account 20%nat = Some (GBytes [21%nat]).
Proof. intros; vm_compute; reflexivity. Qed.
Theorem getPendingContractAdmin_result : forall hp (account : bytes) (store : storage),
 run 22 0 (fun pc => nth pc getPendingContractAdmin_ops Unsupported)
 (machine [] [] [] (getPendingContractAdmin_fields hp account) store [] (fun _ _ => GNull)) =
 match store [21%nat] with None => Done (GBytes (repeat 0%nat 20))
 | Some b => if Z.eqb (Z.of_nat (length b)) 20 then Done (GBytes b) else Thrown end.
Proof. intros. remember (getPendingContractAdmin_fields hp account) as fields eqn:F.
 assert (P:fields 20%nat = Some (GBytes [21%nat])) by (rewrite F; apply getPendingContractAdmin_prefix).
 clear F. unfold getPendingContractAdmin_ops. destruct (store [21%nat]) as [b|] eqn:E.
 - destruct (Z.eqb (Z.of_nat (length b)) 20) eqn:B; repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
  mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gval_size
  gbytes_eqb gval_eqb negb Nat.eqb andb] | multimatch goal with H : ?l = ?r |- _ =>
  progress rewrite H end | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end];
  reflexivity.
 - repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
  mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gval_size
  gbytes_eqb gval_eqb negb Nat.eqb andb] | multimatch goal with H : ?l = ?r |- _ =>
  progress rewrite H end | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end];
  reflexivity.
Qed.
Print Assumptions getPendingContractAdmin_result.
Definition getPlatformRegistrar_ops : list Ins := [InitSlot 1 0;LdStatic 33;GetContext;StorageGet;StLoc 0;LdLoc 0;Push GNull;EqualIns;JumpIfNot 11;Push (GBytes [0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat]);Jump 20;LdLoc 0;Dup;IsNull;JumpIf 20;Dup;SizeIns;Push (GInt 20%Z);JumpEq 20;Throw;Jump 21;Ret].
Definition getPlatformRegistrar_fields hp (account : bytes) :=
 read_field (run_init 161 init_code (initializer_entry hp [])).
Lemma getPlatformRegistrar_prefix : forall hp account,
 getPlatformRegistrar_fields hp account 33%nat = Some (GBytes [23%nat]).
Proof. intros; vm_compute; reflexivity. Qed.
Theorem getPlatformRegistrar_result : forall hp (account : bytes) (store : storage),
 run 22 0 (fun pc => nth pc getPlatformRegistrar_ops Unsupported)
 (machine [] [] [] (getPlatformRegistrar_fields hp account) store [] (fun _ _ => GNull)) =
 match store [23%nat] with None => Done (GBytes (repeat 0%nat 20))
 | Some b => if Z.eqb (Z.of_nat (length b)) 20 then Done (GBytes b) else Thrown end.
Proof. intros. remember (getPlatformRegistrar_fields hp account) as fields eqn:F.
 assert (P:fields 33%nat = Some (GBytes [23%nat])) by (rewrite F; apply getPlatformRegistrar_prefix).
 clear F. unfold getPlatformRegistrar_ops. destruct (store [23%nat]) as [b|] eqn:E.
 - destruct (Z.eqb (Z.of_nat (length b)) 20) eqn:B; repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
  mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gval_size
  gbytes_eqb gval_eqb negb Nat.eqb andb] | multimatch goal with H : ?l = ?r |- _ =>
  progress rewrite H end | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end];
  reflexivity.
 - repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
  mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gval_size
  gbytes_eqb gval_eqb negb Nat.eqb andb] | multimatch goal with H : ?l = ?r |- _ =>
  progress rewrite H end | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end];
  reflexivity.
Qed.
Print Assumptions getPlatformRegistrar_result.
Definition getPendingPlatformRegistrar_ops : list Ins := [InitSlot 1 0;LdStatic 39;GetContext;StorageGet;StLoc 0;LdLoc 0;Push GNull;EqualIns;JumpIfNot 11;Push (GBytes [0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat]);Jump 20;LdLoc 0;Dup;IsNull;JumpIf 20;Dup;SizeIns;Push (GInt 20%Z);JumpEq 20;Throw;Jump 21;Ret].
Definition getPendingPlatformRegistrar_fields hp (account : bytes) :=
 read_field (run_init 161 init_code (initializer_entry hp [])).
Lemma getPendingPlatformRegistrar_prefix : forall hp account,
 getPendingPlatformRegistrar_fields hp account 39%nat = Some (GBytes [24%nat]).
Proof. intros; vm_compute; reflexivity. Qed.
Theorem getPendingPlatformRegistrar_result : forall hp (account : bytes) (store : storage),
 run 22 0 (fun pc => nth pc getPendingPlatformRegistrar_ops Unsupported)
 (machine [] [] [] (getPendingPlatformRegistrar_fields hp account) store [] (fun _ _ => GNull)) =
 match store [24%nat] with None => Done (GBytes (repeat 0%nat 20))
 | Some b => if Z.eqb (Z.of_nat (length b)) 20 then Done (GBytes b) else Thrown end.
Proof. intros. remember (getPendingPlatformRegistrar_fields hp account) as fields eqn:F.
 assert (P:fields 39%nat = Some (GBytes [24%nat])) by (rewrite F; apply getPendingPlatformRegistrar_prefix).
 clear F. unfold getPendingPlatformRegistrar_ops. destruct (store [24%nat]) as [b|] eqn:E.
 - destruct (Z.eqb (Z.of_nat (length b)) 20) eqn:B; repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
  mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gval_size
  gbytes_eqb gval_eqb negb Nat.eqb andb] | multimatch goal with H : ?l = ?r |- _ =>
  progress rewrite H end | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end];
  reflexivity.
 - repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
  mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gval_size
  gbytes_eqb gval_eqb negb Nat.eqb andb] | multimatch goal with H : ?l = ?r |- _ =>
  progress rewrite H end | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end];
  reflexivity.
Qed.
Print Assumptions getPendingPlatformRegistrar_result.
Definition getMarketEscrowContract_ops : list Ins := [InitSlot 2 1;LdStatic 3;LdArg;Convert 48;Concat;StLoc 0;LdLoc 0;GetContext;StorageGet;StLoc 1;LdLoc 1;Push GNull;EqualIns;JumpIfNot 16;Push (GBytes [0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat]);Jump 25;LdLoc 1;Dup;IsNull;JumpIf 25;Dup;SizeIns;Push (GInt 20%Z);JumpEq 25;Throw;Jump 26;Ret].
Definition getMarketEscrowContract_fields hp (account : bytes) :=
 read_field (run_init 161 init_code (initializer_entry hp [VBytes account])).
Lemma getMarketEscrowContract_prefix : forall hp account,
 getMarketEscrowContract_fields hp account 3%nat = Some (GBytes [6%nat]).
Proof. intros; vm_compute; reflexivity. Qed.
Theorem getMarketEscrowContract_result : forall hp (account : bytes) (store : storage),
 run 27 0 (fun pc => nth pc getMarketEscrowContract_ops Unsupported)
 (machine [] [] [GBytes account] (getMarketEscrowContract_fields hp account) store [] (fun _ _ => GNull)) =
 match store (6%nat :: account) with None => Done (GBytes (repeat 0%nat 20))
 | Some b => if Z.eqb (Z.of_nat (length b)) 20 then Done (GBytes b) else Thrown end.
Proof. intros. remember (getMarketEscrowContract_fields hp account) as fields eqn:F.
 assert (P:fields 3%nat = Some (GBytes [6%nat])) by (rewrite F; apply getMarketEscrowContract_prefix).
 clear F. unfold getMarketEscrowContract_ops. destruct (store (6%nat :: account)) as [b|] eqn:E.
 - destruct (Z.eqb (Z.of_nat (length b)) 20) eqn:B; repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
  mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gval_size
  gbytes_eqb gval_eqb negb Nat.eqb andb] | multimatch goal with H : ?l = ?r |- _ =>
  progress rewrite H end | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end];
  reflexivity.
 - repeat first [progress cbv [step pop pushv set_stack set_locals mstack margs mlocals
  mstatics msto mcalls mtokens nth nth_error firstn skipn repeat app storage_lookup gval_size
  gbytes_eqb gval_eqb negb Nat.eqb andb] | multimatch goal with H : ?l = ?r |- _ =>
  progress rewrite H end | lazymatch goal with |- run (S _) _ _ _ = _ => rewrite run_S end];
  reflexivity.
Qed.
Print Assumptions getMarketEscrowContract_result.
