(* Parameterized price/CFG model. Decoder, C# pricing projection and actual AE
   correspondence are separate trusted boundaries, not axioms in this model. *)
From Coq Require Import ZArith List Bool Lia.
Require Import GasSemantics.
Import ListNotations.
Open Scope Z_scope.

Definition put_bytes (absent : bool) (old new : Z) :=
 if absent then 1 + new else
 if new =? 0 then 0 else
 if new <=? old then (new - 1) / 4 + 1 else
 if old =? 0 then new else (old - 1) / 4 + 1 + new - old.

Lemma quarter_ceiling_bound : forall n, 1 <= n -> 0 <= (n-1)/4+1 <= n.
Proof. intros n H.
 assert (0 <= (n-1)/4) as L by (apply Z.div_pos; lia).
 assert ((n-1)/4 <= n-1) as U by (apply Z.div_le_upper_bound; lia).
 lia. Qed.

Theorem put_bytes_nonnegative_and_bounded : forall absent old new,
 0 <= old -> 0 <= new -> 0 <= put_bytes absent old new <= 1 + new.
Proof. intros absent old new O N. unfold put_bytes. destruct absent; [lia|].
 destruct (new =? 0) eqn:E; [apply Z.eqb_eq in E; lia|].
 apply Z.eqb_neq in E. assert (1 <= new) as P by lia.
 destruct (new <=? old) eqn:C.
 - pose proof (quarter_ceiling_bound new P); lia.
 - apply Z.leb_gt in C. destruct (old =? 0) eqn:Z; [lia|].
   apply Z.eqb_neq in Z. assert (1 <= old) as Q by lia.
   pose proof (quarter_ceiling_bound old Q); lia. Qed.

Theorem ledger_put_bytes_bound : forall absent old new,
 0 <= old -> 38 <= new <= 70 -> 0 <= put_bytes absent old new <= 71.
Proof. intros. pose proof (put_bytes_nonnegative_and_bounded absent old new).
 specialize (H1 H ltac:(lia)). lia. Qed.

Theorem admitted_storage_charge_int64_safe : forall absent old new price,
 0 <= old -> 38 <= new <= 70 -> 0 <= price <= 4294967295 ->
 0 <= put_bytes absent old new * price < 9223372036854775808.
Proof. intros. pose proof (ledger_put_bytes_bound absent old new H H0). nia. Qed.

Record HelperEvent := helper_event {
 helper_pc : Z; execution_coefficient : Z; is_storage_put : bool
}.
Record GasNode := gas_node { node_event : HelperEvent; node_successors : list Z }.
Fixpoint find_node nodes pc := match nodes with
 | [] => None
 | node::rest => if helper_pc (node_event node) =? pc then Some node else find_node rest pc end.
Fixpoint enumerate_cfg fuel nodes pc : option (list (list HelperEvent)) :=
 match fuel with O => None | S fuel' =>
 match find_node nodes pc with None => None | Some node =>
 let prefix := fun paths => map (fun path => node_event node :: path) paths in
 match node_successors node with
 | [] => Some [[node_event node]]
 | [next] => match enumerate_cfg fuel' nodes next with Some paths => Some (prefix paths) | None => None end
 | [first;second] => match enumerate_cfg fuel' nodes first, enumerate_cfg fuel' nodes second with
   | Some a, Some b => Some (prefix a ++ prefix b) | _,_ => None end
 | _ => None end end end.
Fixpoint execution_sum path := match path with
 | [] => 0 | event::rest => execution_coefficient event + execution_sum rest end.
Fixpoint put_count path := match path with
 | [] => 0 | event::rest => if is_storage_put event then put_count rest + 1 else put_count rest end.
Definition safe_path maximum path :=
 ((execution_sum path <=? maximum) && (put_count path <=? 1) &&
 forallb (fun event => 0 <=? execution_coefficient event) path)%bool.
Lemma safe_path_sound : forall maximum path,
 safe_path maximum path = true -> execution_sum path <= maximum /\ put_count path <= 1 /\
 Forall (fun event => 0 <= execution_coefficient event) path.
Proof. intros m p H. unfold safe_path in H.
 apply andb_true_iff in H as [A B]. apply andb_true_iff in A as [C D].
 apply Z.leb_le in C. apply Z.leb_le in D. split; [exact C|]. split; [exact D|].
 apply Forall_forall. intros x X. apply forallb_forall with (x:=x) in B; [apply Z.leb_le in B; exact B|exact X]. Qed.

Definition helper_charge event exec storage factor absent old new :=
 execution_coefficient event * exec +
 (if is_storage_put event then put_bytes absent old new * storage * factor else 0).
Definition helper_bound maximum exec storage factor := maximum * exec + 71 * storage * factor.

Section PricedHelper.
Variable Store : Type.
Variable effects : Z -> Store -> Store.
Definition priced_helper path exec storage factor absent old new : list (PricedEvent Store) :=
 map (fun event => @priced_event Store (helper_charge event exec storage factor absent old new)
    (effects (helper_pc event))) path.
Lemma priced_helper_total : forall path exec storage factor absent old new,
 total_charge Store (priced_helper path exec storage factor absent old new) =
 execution_sum path * exec + put_count path * put_bytes absent old new * storage * factor.
Proof. induction path as [|event rest IH]; intros; cbn [priced_helper map total_charge event_charge execution_sum put_count].
 - ring.
 - unfold priced_helper in IH. rewrite IH. unfold helper_charge. destruct (is_storage_put event); cbn; ring. Qed.
Lemma priced_helper_nonnegative : forall path exec storage factor absent old new,
 Forall (fun event => 0 <= execution_coefficient event) path ->
 0 <= exec -> 0 <= storage -> 0 <= factor -> 0 <= old -> 0 <= new ->
 nonnegative_events Store (priced_helper path exec storage factor absent old new).
Proof. intros path e s f a o n P E S F O N.
 pose proof (put_bytes_nonnegative_and_bounded a o n O N) as B.
 unfold nonnegative_events, priced_helper. apply Forall_map.
 induction P; constructor; auto. cbn [event_charge]. unfold helper_charge.
 destruct (is_storage_put x); nia. Qed.
Theorem successful_path_price_bound : forall maximum path exec storage factor absent old new,
 safe_path maximum path = true -> 0 <= exec -> 0 <= storage -> 0 <= factor ->
 0 <= old -> 38 <= new <= 70 ->
 total_charge Store (priced_helper path exec storage factor absent old new) <=
 helper_bound maximum exec storage factor.
Proof. intros m p e s f a o n P E S F O N.
 apply safe_path_sound in P as [C [K P]].
 pose proof (ledger_put_bytes_bound a o n O N) as B.
 assert (0 <= put_count p) as L.
 { clear C K P. induction p; cbn [put_count]; [lia|]. destruct (is_storage_put a0); lia. }
 assert (execution_sum p * e <= m * e) as X by nia.
 assert (put_count p * put_bytes a o n <= 71) as Y by nia.
 assert (0 <= s * f) as SF by nia.
 assert ((put_count p * put_bytes a o n) * (s*f) <= 71 * (s*f)) as Z by nia.
 rewrite priced_helper_total. unfold helper_bound. nia. Qed.
Theorem sufficient_helper_budget_erases_metering : forall maximum path exec storage factor absent old new budget consumed state,
 safe_path maximum path = true -> 0 <= exec -> 0 <= storage -> 0 <= factor ->
 0 <= old -> 38 <= new <= 70 -> consumed + helper_bound maximum exec storage factor <= budget ->
 metered Store (priced_helper path exec storage factor absent old new) budget consumed state =
 TraceHalt Store (consumed + total_charge Store (priced_helper path exec storage factor absent old new))
   (unmetered Store (priced_helper path exec storage factor absent old new) state).
Proof. intros. apply sufficient_budget_erases_metering.
 - apply priced_helper_nonnegative; try lia. apply safe_path_sound in H; tauto.
 - pose proof (successful_path_price_bound maximum path exec storage factor absent old new H H0 H1 H2 H3 H4). lia. Qed.
Theorem sufficient_budget_for_charge_refinement : forall maximum path exec storage factor absent old new events budget consumed state,
 safe_path maximum path = true -> 0 <= exec -> 0 <= storage -> 0 <= factor ->
 0 <= old -> 38 <= new <= 70 ->
 nonnegative_events Store events ->
 total_charge Store events = total_charge Store (priced_helper path exec storage factor absent old new) ->
 consumed + helper_bound maximum exec storage factor <= budget ->
 metered Store events budget consumed state =
 TraceHalt Store (consumed + total_charge Store events) (unmetered Store events state).
Proof. intros. apply sufficient_budget_erases_metering; [assumption|].
 pose proof (successful_path_price_bound maximum path exec storage factor absent old new H H0 H1 H2 H3 H4).
 lia. Qed.
End PricedHelper.
