From Coq Require Import NArith List Lia.
Import ListNotations. Open Scope N_scope.

Fixpoint units (ws : list N) : N :=
  match ws with [] => 0 | w :: tail => w + units tail end.
Lemma units_append : forall a b, units (a ++ b) = units a + units b.
Proof. induction a; intros; simpl; [reflexivity | rewrite IHa; lia]. Qed.
Inductive settlement := Paid (amount:N) | Exhausted (amount:N).
Fixpoint settle (factor budget used:N) (ws:list N) : settlement :=
  match ws with
  | [] => Paid used
  | w :: tail =>
      let next := used + factor * w in
      if next <=? budget then settle factor budget next tail else Exhausted next
  end.

Lemma settle_paid : forall ws factor budget used amount, used <= budget ->
  (settle factor budget used ws = Paid amount <->
   used + factor * units ws <= budget /\ amount = used + factor * units ws).
Proof.
  induction ws as [|w ws IH]; intros; cbn [settle units].
  - rewrite N.mul_0_r, N.add_0_r. split.
    + intro E. inversion E; subst. split; [assumption | reflexivity].
    + intros [_ ->]. reflexivity.
  - destruct (used + factor * w <=? budget) eqn:D.
    + apply N.leb_le in D. rewrite IH by exact D. rewrite N.mul_add_distr_l. replace (used + (factor*w + factor*units ws)) with (used + factor*w + factor*units ws) by lia. reflexivity.
    + apply N.leb_gt in D. split; [discriminate|intros [L _]; rewrite N.mul_add_distr_l in L; lia].
Qed.

Lemma exhausted_at_first_overrun : forall ws factor budget used amount, used <= budget ->
  settle factor budget used ws = Exhausted amount ->
  exists prefix w tail, ws = prefix ++ w :: tail /\
    used + factor * units prefix <= budget /\ budget < amount /\
    amount = used + factor * (units prefix + w).
Proof.
  induction ws as [|w ws IH]; intros f b u a H E; cbn [settle] in E; [discriminate|].
  destruct (u + f*w <=? b) eqn:D.
  - apply N.leb_le in D. destruct (IH _ _ _ _ D E) as (p & k & t & -> & L & G & A).
    exists (w::p), k, t. cbn [units app]. repeat split; nia.
  - apply N.leb_gt in D. inversion E; subst. exists [], w, ws. cbn [units app]. repeat split; nia.
Qed.

Definition datoshi (pico:N) : N :=
  let q := pico / 10000 in if pico mod 10000 =? 0 then q else q + 1.

Lemma datoshi_budget : forall pico budget,
  pico <= budget * 10000 <-> datoshi pico <= budget.
Proof.
  intros p b. unfold datoshi.
  pose proof (N.div_mod p 10000 ltac:(discriminate)) as D.
  pose proof (N.mod_lt p 10000 ltac:(discriminate)) as R.
  destruct (p mod 10000 =? 0) eqn:H.
  - apply N.eqb_eq in H. lia.
  - apply N.eqb_neq in H. remember (p / 10000) as q in *.
    remember (p mod 10000) as r in *. split; intro; lia.
Qed.

Theorem pico_budget_exact : forall ws rate budget paid,
  settle rate (budget * 10000) 0 ws = Paid paid <->
  datoshi (rate * units ws) <= budget /\ paid = rate * units ws.
Proof. intros. rewrite settle_paid by lia. cbn [N.add]. rewrite datoshi_budget. reflexivity. Qed.

Definition amount (s:settlement) := match s with Paid n | Exhausted n => n end.

Lemma scaled_units : forall rate ws, units (map (N.mul rate) ws) = rate * units ws.
Proof. intros rate ws. induction ws; cbn [map units]; nia. Qed.

Theorem fixed_method_budget : forall driver rate flat prior budget paid,
  prior <= budget * 10000 ->
  settle 1 (budget * 10000) prior (map (N.mul rate) driver ++ [flat * 10000]) = Paid paid <->
  datoshi (prior + rate * units driver) + flat <= budget /\
  paid = prior + rate * units driver + flat * 10000.
Proof.
  intros. rewrite settle_paid by assumption. rewrite units_append, scaled_units.
  cbn [units]. remember (prior + rate * units driver) as prefix.
  replace (prior + 1 * (rate * units driver + (flat * 10000 + 0)))
    with (prefix + flat * 10000) by nia.
  destruct (N.le_gt_cases flat budget).
  - pose proof (datoshi_budget prefix (budget-flat)). lia.
  - lia.
Qed.
Lemma charge_bound : forall ws rate budget prior,
  amount (settle rate budget prior ws) <= prior + rate * units ws.
Proof.
  induction ws as [|w ws IH]; intros; cbn [settle units amount]; [nia|].
  destruct (prior + rate * w <=? budget); [specialize (IH rate budget (prior + rate * w))|];
  cbn [amount]; nia.
Qed.

Definition max_long : N := 9223372036854775807.
Definition fee_readback pico budget :=
  if max_long <? datoshi pico then budget else datoshi pico.

Lemma readback_headroom : forall ws cap rate budget prior,
  units ws <= cap -> rate <= 1000000 ->
  prior + 1000000 * cap <= max_long * 10000 ->
  let used := amount (settle rate (budget * 10000) prior ws) in
  datoshi used <= max_long /\ fee_readback used budget = datoshi used.
Proof.
  intros ws cap rate budget prior C R H used.
  pose proof (charge_bound ws rate (budget * 10000) prior) as A.
  assert (K : datoshi used <= max_long).
  { apply datoshi_budget. unfold used. nia. }
  split; [exact K|]. unfold fee_readback.
  apply N.ltb_ge in K. rewrite K. reflexivity.
Qed.
