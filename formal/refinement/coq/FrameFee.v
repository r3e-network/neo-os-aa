From Coq Require Import List NArith Lia.
Require Import PathFee.
Import ListNotations. Open Scope N_scope.

(* Contract entry allocates fresh shared state; an initializer or internal
   clone uses its method's state. Work prices here are already in picoGAS. *)
Inductive schedule :=
| Done | Work (price : N) (next : schedule)
| Contract (flat : option N) (body next : schedule)
| Clone (body next : schedule).
Inductive event := PushFresh | PushClone | Register (flat : N) | Pop | Charge (price : N).
Fixpoint events (s : schedule) : list event :=
  match s with
  | Done => []
  | Work w n => Charge w :: events n
  | Contract f b n => PushFresh :: (match f with Some k => [Register k] | None => [] end)
                            ++ events b ++ Pop :: events n
  | Clone b n => PushClone :: events b ++ Pop :: events n
  end.

(* Read the flag on the active frame at each charge. Register is the
   successful admission action: charge first, then mark the shared state. *)
Fixpoint replay (es : list event) (stack : list bool) : option (list N * list bool) :=
  match es with
  | [] => Some ([],stack)
  | e :: tail =>
    let step := fun (ws:list N) (st:list bool) =>
      match replay tail st with Some (ts,last) => Some (ws++ts,last) | None => None end in
    match e, stack with
    | PushFresh, _ => step [] (false::stack)
    | PushClone, x::_ => step [] (x::stack)
    | Register k, false::xs => step [k*10000] (true::xs)
    | Pop, _::xs => step [] xs
    | Charge w, x::_ => step (if x then [] else [w]) stack
    | _, _ => None
    end
  end.

Fixpoint billed (s:schedule) (free:bool) : list N :=
  match s with
  | Done => []
  | Work w n => (if free then [] else [w]) ++ billed n free
  | Contract (Some k) b n => k*10000 :: billed b true ++ billed n free
  | Contract None b n => billed b false ++ billed n free
  | Clone b n => billed b free ++ billed n free
  end.

Lemma replay_cont : forall s free outer tail,
  replay (events s ++ tail) (free::outer) =
  match replay tail (free::outer) with
  | Some (charges,last) => Some (billed s free ++ charges,last) | None => None end.
Proof.
  induction s as [|w n IH|f b IHb n IHn|b IHb n IHn]; intros.
  - cbn. destruct (replay tail (free::outer)) as [[? ?]|]; reflexivity.
  - cbn [events app replay]. rewrite IH. destruct (replay tail (free::outer)) as [[? ?]|];
      destruct free; reflexivity.
  - destruct f; cbn [events app replay]; rewrite <- app_assoc, IHb; cbn [app replay];
      rewrite IHn; destruct (replay tail (free::outer)) as [[? ?]|]; cbn [billed app];
      try rewrite app_assoc; reflexivity.
  - cbn [events app replay]; rewrite <- app_assoc, IHb; cbn [app replay];
      rewrite IHn; destruct (replay tail (free::outer)) as [[? ?]|]; cbn [billed app];
      try rewrite app_assoc; reflexivity.
Qed.

Theorem frame_charges : forall s free outer,
  replay (events s) (free::outer) = Some (billed s free, free::outer).
Proof. intros. pose proof (replay_cont s free outer []) as H.
  rewrite app_nil_r in H. cbn [replay] in H. now rewrite app_nil_r in H. Qed.

Theorem frame_budget : forall s free prior budget paid, prior <= budget*10000 ->
  (settle 1 (budget*10000) prior (billed s free) = Paid paid <->
   datoshi (prior + units (billed s free)) <= budget /\ paid = prior + units (billed s free)).
Proof. intros. rewrite settle_paid by assumption. rewrite N.mul_1_l, datoshi_budget. reflexivity. Qed.
Print Assumptions frame_charges.
Print Assumptions frame_budget.
