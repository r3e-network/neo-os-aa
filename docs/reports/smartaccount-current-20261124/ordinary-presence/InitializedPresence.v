From Coq Require Import List.
Require Import CapMethodVm CapContext StorageGetter StorageGetterVm StorageView PresenceArtifact OrdinaryInitializerArtifact.
Import ListNotations. Open Scope nat_scope.
Definition byte_fields (values:list Value) i : option GVal :=
  match nth_error values i with Some (VBuffer b) => Some (GBytes b) | _ => None end.
Definition resume_getter fuel program store finish :=
  match finish with
  | InitReturned s => match init_slots s, init_stack s with
    | Some values, [VBytes account] =>
        StorageGetterVm.run fuel 0 program
          (machine [] [] [GBytes account] (byte_fields values) store [] (fun _ _ => GNull))
    | _,_ => Thrown end
  | _ => Thrown end.
Theorem isExecutionActive_from_initializer : forall hp account (store:storage),
  resume_getter 13 (fun pc => nth pc isExecutionActive_ops Unsupported) store
    (run_init 170 OrdinaryInitializerArtifact.code (initializer_entry hp [VBytes account])) =
  Done (GBool (exists_at (store ([11%nat] ++ account)))).
Proof. intros. rewrite init_exact. lazy.
  destruct (store ([11%nat] ++ account)) eqn:E; simpl in E; rewrite ?E; reflexivity. Qed.
Corollary isExecutionActive_from_snapshot : forall hp account o b id,
  resume_getter 13 (fun pc => nth pc isExecutionActive_ops Unsupported) (visible o b id)
    (run_init 170 OrdinaryInitializerArtifact.code (initializer_entry hp [VBytes account])) =
  Done (GBool (exists_at (visible o b id ([11%nat] ++ account)))).
Proof. intros. apply isExecutionActive_from_initializer. Qed.
Print Assumptions isExecutionActive_from_snapshot.
Theorem hasPendingVerifierUpdate_from_initializer : forall hp account (store:storage),
  resume_getter 13 (fun pc => nth pc hasPendingVerifierUpdate_ops Unsupported) store
    (run_init 170 OrdinaryInitializerArtifact.code (initializer_entry hp [VBytes account])) =
  Done (GBool (exists_at (store ([9%nat] ++ account)))).
Proof. intros. rewrite init_exact. lazy.
  destruct (store ([9%nat] ++ account)) eqn:E; simpl in E; rewrite ?E; reflexivity. Qed.
Corollary hasPendingVerifierUpdate_from_snapshot : forall hp account o b id,
  resume_getter 13 (fun pc => nth pc hasPendingVerifierUpdate_ops Unsupported) (visible o b id)
    (run_init 170 OrdinaryInitializerArtifact.code (initializer_entry hp [VBytes account])) =
  Done (GBool (exists_at (visible o b id ([9%nat] ++ account)))).
Proof. intros. apply hasPendingVerifierUpdate_from_initializer. Qed.
Print Assumptions hasPendingVerifierUpdate_from_snapshot.
Theorem hasPendingHookUpdate_from_initializer : forall hp account (store:storage),
  resume_getter 13 (fun pc => nth pc hasPendingHookUpdate_ops Unsupported) store
    (run_init 170 OrdinaryInitializerArtifact.code (initializer_entry hp [VBytes account])) =
  Done (GBool (exists_at (store ([10%nat] ++ account)))).
Proof. intros. rewrite init_exact. lazy.
  destruct (store ([10%nat] ++ account)) eqn:E; simpl in E; rewrite ?E; reflexivity. Qed.
Corollary hasPendingHookUpdate_from_snapshot : forall hp account o b id,
  resume_getter 13 (fun pc => nth pc hasPendingHookUpdate_ops Unsupported) (visible o b id)
    (run_init 170 OrdinaryInitializerArtifact.code (initializer_entry hp [VBytes account])) =
  Done (GBool (exists_at (visible o b id ([10%nat] ++ account)))).
Proof. intros. apply hasPendingHookUpdate_from_initializer. Qed.
Print Assumptions hasPendingHookUpdate_from_snapshot.
