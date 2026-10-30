(* Private tuple-builder source/VM relation. Record representation and caller
   admission remain explicit; PACK/PICKITEM retain references, not deep copies. *)
From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import IntegerSemantics CapArithmetic CapMethodVm.
Import ListNotations.
Open Scope Z_scope.

Definition hook_tuple target method args nonce deadline signature :=
 obj ArrayKind [target;method;args;nonce;deadline;signature].
Definition hook_vm_initial operation args objects stored static_values :=
 state 0 [operation;args] [] [] objects stored [] static_values.
Definition hook_source_initial operation args objects stored static_values :=
 state 0 [] [operation;args] [] objects stored [] static_values.
Inductive HookObservation :=
 | HookReturned : Value -> list Object -> Value -> list Effect -> HookObservation
 | HookFaulted : list Object -> Value -> list Effect -> HookObservation
 | HookOpen.
Definition hook_observe outcome := match outcome with
 | Halt value after => HookReturned value (heap after) (storage after) (effects after)
 | Fault after => HookFaulted (heap after) (storage after) (effects after)
 | _ => HookOpen end.
Definition hook_expected objects stored target method args nonce deadline signature :=
 HookReturned (VRef (length objects))
 (objects ++ [hook_tuple target method args nonce deadline signature]) stored [].
Lemma append_allocates_fresh : forall (objects : list Object) (value : Object),
 nth_error objects (length objects) = None /\
 nth_error (objects ++ [value]) (length objects) = Some value.
Proof. intros. split.
- apply nth_error_None. lia.
- rewrite nth_error_app2 by lia. rewrite Nat.sub_diag. reflexivity. Qed.
Print Assumptions append_allocates_fresh.
Lemma append_preserves_existing_objects : forall (objects : list Object) (value : Object) index,
 (index < length objects)%nat -> nth_error (objects ++ [value]) index = nth_error objects index.
Proof. intros. apply nth_error_app1. assumption. Qed.
Print Assumptions append_preserves_existing_objects.
Lemma tuple_retains_argument_identity : forall target method args nonce deadline signature,
 nth_error (fields (hook_tuple target method args nonce deadline signature)) 2 = Some args.
Proof. reflexivity. Qed.
Print Assumptions tuple_retains_argument_identity.
Lemma tuple_argument_alias_unchanged : forall objects argument_ref argument_object target method nonce deadline signature,
 nth_error objects argument_ref = Some argument_object ->
 nth_error (objects ++ [hook_tuple target method (VRef argument_ref) nonce deadline signature]) argument_ref =
 Some argument_object.
Proof. intros. rewrite append_preserves_existing_objects; [assumption|].
 apply nth_error_Some. rewrite H. discriminate. Qed.
Print Assumptions tuple_argument_alias_unchanged.
Lemma tuple_is_not_existing_argument : forall (objects : list Object) argument_ref (argument_object : Object),
 nth_error objects argument_ref = Some argument_object -> length objects <> argument_ref.
Proof. intros objects argument_ref argument_object H Eq. subst.
 rewrite (proj1 (append_allocates_fresh objects argument_object)) in H. discriminate. Qed.
Print Assumptions tuple_is_not_existing_argument.
Example struct_argument_is_not_cloned :
 let argument := obj StructKind [VInt 7] in
 let operation := obj ArrayKind [VNull;VNull;VNull;VInt 0;VInt 0;VNull] in
 let before := [operation;argument] in
 nth_error (fields (hook_tuple VNull VNull (VRef 1) (VInt 0) (VInt 0) VNull)) 2 = Some (VRef 1) /\
 nth_error (before ++ [hook_tuple VNull VNull (VRef 1) (VInt 0) (VInt 0) VNull]) 1 = Some argument.
Proof. split; reflexivity. Qed.
Print Assumptions struct_argument_is_not_cloned.
