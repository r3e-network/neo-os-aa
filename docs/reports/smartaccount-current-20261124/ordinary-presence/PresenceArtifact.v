From Coq Require Import List.
Require Import StorageGetter StorageGetterVm StorageView.
Import ListNotations. Open Scope nat_scope.
Definition statics (i:nat) : option GVal := match i with
| 0 => Some (GBytes [170%nat;82%nat;71%nat;1%nat])
| 1 => Some (GBytes [1%nat])
| 2 => Some (GBytes [4%nat])
| 3 => Some (GBytes [34%nat])
| 4 => Some (GBytes [6%nat])
| 5 => Some (GBytes [7%nat])
| 6 => Some (GBytes [10%nat])
| 8 => Some (GBytes [5%nat])
| 9 => Some (GBytes [9%nat])
| 11 => Some (GBytes [15%nat])
| 13 => Some (GBytes [16%nat])
| 14 => Some (GBytes [17%nat])
| 15 => Some (GBytes [18%nat])
| 16 => Some (GBytes [19%nat])
| 17 => Some (GBytes [26%nat])
| 18 => Some (GBytes [27%nat])
| 19 => Some (GBytes [20%nat])
| 21 => Some (GBytes [21%nat])
| 22 => Some (GBytes [22%nat])
| 23 => Some (GBytes [11%nat])
| 24 => Some (GBytes [2%nat])
| 25 => Some (GBytes [14%nat])
| 26 => Some (GBytes [13%nat])
| 27 => Some (GBytes [32%nat])
| 28 => Some (GBytes [8%nat])
| 29 => Some (GBytes [12%nat])
| 30 => Some (GBytes [29%nat])
| 32 => Some (GBytes [3%nat])
| 34 => Some (GBytes [33%nat])
| 35 => Some (GBytes [170%nat;82%nat;71%nat;2%nat])
| 36 => Some (GBytes [23%nat])
| 37 => Some (GBytes [30%nat])
| 38 => Some (GBytes [12%nat;20%nat])
| 39 => Some (GBytes [17%nat;192%nat;31%nat;12%nat;6%nat;118%nat;101%nat;114%nat;105%nat;102%nat;121%nat;12%nat;20%nat])
| 40 => Some (GBytes [65%nat;98%nat;125%nat;91%nat;82%nat])
| 41 => Some (GBytes [31%nat])
| 42 => Some (GBytes [24%nat])
| 43 => Some (GBytes [25%nat])
| 44 => Some (GBytes [255%nat;255%nat;255%nat;255%nat])
| 45 => Some (GBytes [22%nat;38%nat;186%nat;126%nat])
| 47 => Some (GBytes [28%nat])
| 48 => Some (GBytes [65%nat;98%nat;125%nat;91%nat;82%nat])
| 49 => Some (GBytes [12%nat;20%nat])
| 50 => Some (GBytes [18%nat;192%nat])
| 51 => Some (GBytes [12%nat;13%nat;101%nat;120%nat;101%nat;99%nat;117%nat;116%nat;101%nat;85%nat;115%nat;101%nat;114%nat;79%nat;112%nat])
| 52 => Some (GBytes [12%nat;14%nat;101%nat;120%nat;101%nat;99%nat;117%nat;116%nat;101%nat;85%nat;115%nat;101%nat;114%nat;79%nat;112%nat;115%nat])
| _ => None end.
Definition isExecutionActive_ops : list Ins := [InitSlot 1 1; LdStatic 23; LdArg; Convert 48; Concat; StLoc 0; LdLoc 0; GetContext; StorageGet; Push GNull; NotEqualIns; Jump 12; Ret].
Theorem isExecutionActive_exact : forall (sto:storage) (account:bytes),
  run 13 0 (fun pc => nth pc isExecutionActive_ops Unsupported)
      (machine [] [] [GBytes account] statics sto [] (fun _ _ => GNull)) =
  Done (GBool (match sto ([11%nat] ++ account) with Some _ => true | None => false end)).
Proof. intros sto account.
  lazy. destruct (sto ([11%nat] ++ account)) eqn:E; simpl in E; rewrite ?E; reflexivity.
Qed.
Print Assumptions isExecutionActive_exact.
Definition isExecutionActive_read o b id account :=
  run 13 0 (fun pc => nth pc isExecutionActive_ops Unsupported)
      (machine [] [] [GBytes account] statics (visible o b id) [] (fun _ _ => GNull)).
Theorem isExecutionActive_visible : forall o b id account, isExecutionActive_read o b id account =
  Done (GBool (exists_at (visible o b id ([11%nat] ++ account)))).
Proof. intros. apply isExecutionActive_exact. Qed.
Theorem isExecutionActive_isolated : forall o b o' b' id account,
  o id ([11%nat] ++ account) = o' id ([11%nat] ++ account) ->
  b id ([11%nat] ++ account) = b' id ([11%nat] ++ account) ->
  isExecutionActive_read o b id account = isExecutionActive_read o' b' id account.
Proof. intros. rewrite !isExecutionActive_visible.
  now rewrite (key_isolation o b o' b' id _ H H0). Qed.
Print Assumptions isExecutionActive_visible.
Print Assumptions isExecutionActive_isolated.
Definition hasPendingVerifierUpdate_ops : list Ins := [InitSlot 1 1; LdStatic 9; LdArg; Convert 48; Concat; StLoc 0; LdLoc 0; GetContext; StorageGet; Push GNull; NotEqualIns; Jump 12; Ret].
Theorem hasPendingVerifierUpdate_exact : forall (sto:storage) (account:bytes),
  run 13 0 (fun pc => nth pc hasPendingVerifierUpdate_ops Unsupported)
      (machine [] [] [GBytes account] statics sto [] (fun _ _ => GNull)) =
  Done (GBool (match sto ([9%nat] ++ account) with Some _ => true | None => false end)).
Proof. intros sto account.
  lazy. destruct (sto ([9%nat] ++ account)) eqn:E; simpl in E; rewrite ?E; reflexivity.
Qed.
Print Assumptions hasPendingVerifierUpdate_exact.
Definition hasPendingVerifierUpdate_read o b id account :=
  run 13 0 (fun pc => nth pc hasPendingVerifierUpdate_ops Unsupported)
      (machine [] [] [GBytes account] statics (visible o b id) [] (fun _ _ => GNull)).
Theorem hasPendingVerifierUpdate_visible : forall o b id account, hasPendingVerifierUpdate_read o b id account =
  Done (GBool (exists_at (visible o b id ([9%nat] ++ account)))).
Proof. intros. apply hasPendingVerifierUpdate_exact. Qed.
Theorem hasPendingVerifierUpdate_isolated : forall o b o' b' id account,
  o id ([9%nat] ++ account) = o' id ([9%nat] ++ account) ->
  b id ([9%nat] ++ account) = b' id ([9%nat] ++ account) ->
  hasPendingVerifierUpdate_read o b id account = hasPendingVerifierUpdate_read o' b' id account.
Proof. intros. rewrite !hasPendingVerifierUpdate_visible.
  now rewrite (key_isolation o b o' b' id _ H H0). Qed.
Print Assumptions hasPendingVerifierUpdate_visible.
Print Assumptions hasPendingVerifierUpdate_isolated.
Definition hasPendingHookUpdate_ops : list Ins := [InitSlot 1 1; LdStatic 6; LdArg; Convert 48; Concat; StLoc 0; LdLoc 0; GetContext; StorageGet; Push GNull; NotEqualIns; Jump 12; Ret].
Theorem hasPendingHookUpdate_exact : forall (sto:storage) (account:bytes),
  run 13 0 (fun pc => nth pc hasPendingHookUpdate_ops Unsupported)
      (machine [] [] [GBytes account] statics sto [] (fun _ _ => GNull)) =
  Done (GBool (match sto ([10%nat] ++ account) with Some _ => true | None => false end)).
Proof. intros sto account.
  lazy. destruct (sto ([10%nat] ++ account)) eqn:E; simpl in E; rewrite ?E; reflexivity.
Qed.
Print Assumptions hasPendingHookUpdate_exact.
Definition hasPendingHookUpdate_read o b id account :=
  run 13 0 (fun pc => nth pc hasPendingHookUpdate_ops Unsupported)
      (machine [] [] [GBytes account] statics (visible o b id) [] (fun _ _ => GNull)).
Theorem hasPendingHookUpdate_visible : forall o b id account, hasPendingHookUpdate_read o b id account =
  Done (GBool (exists_at (visible o b id ([10%nat] ++ account)))).
Proof. intros. apply hasPendingHookUpdate_exact. Qed.
Theorem hasPendingHookUpdate_isolated : forall o b o' b' id account,
  o id ([10%nat] ++ account) = o' id ([10%nat] ++ account) ->
  b id ([10%nat] ++ account) = b' id ([10%nat] ++ account) ->
  hasPendingHookUpdate_read o b id account = hasPendingHookUpdate_read o' b' id account.
Proof. intros. rewrite !hasPendingHookUpdate_visible.
  now rewrite (key_isolation o b o' b' id _ H H0). Qed.
Print Assumptions hasPendingHookUpdate_visible.
Print Assumptions hasPendingHookUpdate_isolated.
