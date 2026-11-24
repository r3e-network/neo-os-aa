(* Logical values only. The dictionary may memoize a backing hit. Backend,
   storage item conversion and non-interfering read callbacks are boundaries. *)
From Coq Require Import List ZArith.
Require Import StorageGetter.
Import ListNotations.

Inductive cached := Clean | Added | Changed | Deleted | NotFound.
Definition overlay := Z -> bytes -> option (cached * bytes).
Definition backing := Z -> storage.

Definition visible (o : overlay) (b : backing) (id : Z) (key : bytes) : option bytes :=
  match o id key with
  | Some (Deleted, _) | Some (NotFound, _) => None
  | Some (_, value) => Some value
  | None => b id key
  end.

Definition exists_at (r : option bytes) : bool :=
  match r with Some _ => true | None => false end.

Lemma key_isolation : forall o b o' b' id key,
  o id key = o' id key -> b id key = b' id key ->
  visible o b id key = visible o' b' id key.
Proof. intros. unfold visible. now rewrite H,H0. Qed.

Lemma deleted_hides_backing : forall o b id key old,
  o id key = Some (Deleted,old) -> visible o b id key = None.
Proof. intros. unfold visible. now rewrite H. Qed.

Lemma cached_miss_hides_backing : forall o b id key old,
  o id key = Some (NotFound,old) -> visible o b id key = None.
Proof. intros. unfold visible. now rewrite H. Qed.

Lemma empty_cached_value_exists : forall o b id key state,
  state <> Deleted -> state <> NotFound -> o id key = Some (state,[]) ->
  exists_at (visible o b id key) = true.
Proof. intros. unfold visible. rewrite H1. destruct state; try reflexivity; contradiction. Qed.

Lemma backing_on_cache_miss : forall o b id key,
  o id key = None -> visible o b id key = b id key.
Proof. intros. unfold visible. now rewrite H. Qed.
