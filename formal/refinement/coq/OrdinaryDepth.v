(* Invocation capacity only, after ordinary call admission and before bytecode execution. *)
From Coq Require Import List PeanoNat Lia.
Require Import EntryDispatch.
Import ListNotations.

Inductive load_result :=
| MethodFull | InitializerFull (loaded : list Frame) | Loaded (frames : list Frame).

Definition load_frames limit caller tail method_frame (initializer : option Frame) :=
  let original := caller :: tail in
  if Nat.leb limit (length original) then MethodFull else
  let with_method := method_frame :: original in
  match initializer with
  | None => Loaded with_method
  | Some i => if Nat.leb limit (length with_method) then InitializerFull with_method
              else Loaded (i :: with_method)
  end.

Theorem initialized_capacity : forall limit caller tail method_frame init_frame,
  load_frames limit caller tail method_frame (Some init_frame) =
    Loaded (init_frame :: method_frame :: caller :: tail) <->
  length tail + 3 <= limit.
Proof.
 intros. unfold load_frames. simpl length.
 destruct (limit <=? S (length tail)) eqn:A; [apply Nat.leb_le in A|apply Nat.leb_gt in A].
 - split; [discriminate|lia].
 - destruct (limit <=? S (S (length tail))) eqn:B; [apply Nat.leb_le in B|apply Nat.leb_gt in B].
   + split; [discriminate|lia].
   + split; [lia|reflexivity].
Qed.

Theorem full_before_method : forall limit caller tail m i,
  load_frames limit caller tail m i = MethodFull <-> limit <= S (length tail).
Proof.
 intros. unfold load_frames. simpl length.
 destruct (limit <=? S (length tail)) eqn:A; [apply Nat.leb_le in A|apply Nat.leb_gt in A].
 - split; auto.
 - split; [|lia]. destruct i; try discriminate.
   destruct (limit <=? S (S (length tail))); discriminate.
Qed.

Theorem only_method_fits : forall limit caller tail m i,
  load_frames limit caller tail m (Some i) = InitializerFull (m :: caller :: tail) <->
  limit = S (S (length tail)).
Proof.
 intros. unfold load_frames. simpl length.
 destruct (limit <=? S (length tail)) eqn:A; [apply Nat.leb_le in A|apply Nat.leb_gt in A].
 - split; [discriminate|lia].
 - destruct (limit <=? S (S (length tail))) eqn:B; [apply Nat.leb_le in B|apply Nat.leb_gt in B].
   + split; [lia|reflexivity].
   + split; [discriminate|lia].
Qed.

Theorem admission_capacity_suffices : forall env d caller tail m i offset,
  projection_ready env d tail (Some offset) ->
  load_frames (env_stack_limit env) caller tail m (Some i) = Loaded (i::m::caller::tail).
Proof.
 intros. apply initialized_capacity. unfold projection_ready in H. tauto.
Qed.
Print Assumptions initialized_capacity.
Print Assumptions full_before_method.
Print Assumptions only_method_fits.
Print Assumptions admission_capacity_suffices.
