From Coq Require Import List.
Import ListNotations.

(* A transaction can inspect and update its private application state. The
   outer block snapshot already includes OnPersist; fees are not reverted. *)
Section Block.
  Context {State : Type}.
  Definition Tx := State -> bool * State.
  Definition apply_tx (s : State) (t : Tx) : State :=
    let '(halt, child) := t s in if halt then child else s.
  Definition execute (s : State) (ts : list Tx) := fold_left apply_tx ts s.

  Theorem failed_tx_in_block : forall initial prefix tx child suffix,
    tx (execute initial prefix) = (false, child) ->
    execute initial (prefix ++ tx :: suffix) =
    execute (execute initial prefix) suffix.
  Proof.
    intros initial prefix tx child suffix H. unfold execute in *.
    rewrite fold_left_app. simpl. unfold apply_tx at 2. rewrite H. reflexivity.
  Qed.

  Theorem successful_tx_in_block : forall initial prefix tx child suffix,
    tx (execute initial prefix) = (true, child) ->
    execute initial (prefix ++ tx :: suffix) = execute child suffix.
  Proof.
    intros initial prefix tx child suffix H. unfold execute in *.
    rewrite fold_left_app. simpl. unfold apply_tx at 2. rewrite H. reflexivity.
  Qed.
End Block.
