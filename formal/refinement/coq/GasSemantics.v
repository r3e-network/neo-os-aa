(* Source-statement interpretation and metered event semantics. Runtime price
   extraction and general C# frontend correctness are separate obligations. *)
From Coq Require Import ZArith List Bool Lia.
Import ListNotations.
Open Scope Z_scope.

Record FeeState := fee_state { gas_argument : Z; fee_consumed : Z }.
Record FeeEnvironment := fee_environment {
  fee_limit : Z; fee_factor : Z; apply_factor : bool; whitelisted : bool
}.
Inductive FeeError := NegativeFee | InsufficientGas.
Inductive FeeOutcome := FeeContinue : FeeState -> FeeOutcome
  | FeeReturned : FeeState -> FeeOutcome
  | FeeFailed : FeeError -> FeeState -> FeeOutcome.
Inductive FeeExpr := Gas | Consumed | Limit | Factor | Constant : Z -> FeeExpr
  | Plus : FeeExpr -> FeeExpr -> FeeExpr
  | Minus : FeeExpr -> FeeExpr -> FeeExpr
  | Times : FeeExpr -> FeeExpr -> FeeExpr.
Inductive FeeCondition := IsWhitelisted | ShouldApplyFactor
  | Less : FeeExpr -> FeeExpr -> FeeCondition
  | LessEqual : FeeExpr -> FeeExpr -> FeeCondition
  | More : FeeExpr -> FeeExpr -> FeeCondition
  | MoreEqual : FeeExpr -> FeeExpr -> FeeCondition.
Inductive FeeStatement := FeeIf : FeeCondition -> list FeeStatement -> FeeStatement
  | SetGas : FeeExpr -> FeeStatement | SetConsumed : FeeExpr -> FeeStatement
  | FeeThrow : FeeError -> FeeStatement | FeeReturn.

Fixpoint fee_expr expression environment state : Z :=
  match expression with
  | Gas => gas_argument state | Consumed => fee_consumed state
  | Limit => fee_limit environment | Factor => fee_factor environment
  | Constant n => n
  | Plus a b => fee_expr a environment state + fee_expr b environment state
  | Minus a b => fee_expr a environment state - fee_expr b environment state
  | Times a b => fee_expr a environment state * fee_expr b environment state
  end.
Definition fee_condition condition environment state : bool :=
  match condition with
  | IsWhitelisted => whitelisted environment | ShouldApplyFactor => apply_factor environment
  | Less a b => fee_expr a environment state <? fee_expr b environment state
  | LessEqual a b => fee_expr a environment state <=? fee_expr b environment state
  | More a b => fee_expr b environment state <? fee_expr a environment state
  | MoreEqual a b => fee_expr b environment state <=? fee_expr a environment state
  end.
Fixpoint fee_program fuel program environment state : option FeeOutcome :=
  match fuel with O => None | S remaining =>
  match program with [] => Some (FeeContinue state) | statement :: rest =>
    let current := match statement with
      | FeeIf condition body => if fee_condition condition environment state
        then fee_program remaining body environment state else Some (FeeContinue state)
      | SetGas expression => Some (FeeContinue (fee_state (fee_expr expression environment state) (fee_consumed state)))
      | SetConsumed expression => Some (FeeContinue (fee_state (gas_argument state) (fee_expr expression environment state)))
      | FeeThrow error => Some (FeeFailed error state)
      | FeeReturn => Some (FeeReturned state)
      end in
    match current with Some (FeeContinue next) => fee_program remaining rest environment next
      | terminal => terminal end
  end end.
Definition normalize_fee_outcome result :=
  match result with Some (FeeContinue state) => Some (FeeReturned state) | other => other end.

Definition charged_gas environment gas :=
  if apply_factor environment then gas * fee_factor environment else gas.
Definition add_fee environment state : FeeOutcome :=
  if gas_argument state <? 0 then FeeFailed NegativeFee state
  else if whitelisted environment then FeeReturned state
  else let charge := charged_gas environment (gas_argument state) in
       let next := fee_state charge (fee_consumed state + charge) in
       if fee_limit environment <? fee_consumed next then FeeFailed InsufficientGas next
       else FeeReturned next.

Theorem negative_fee_before_whitelist : forall environment state,
  gas_argument state < 0 -> add_fee environment state = FeeFailed NegativeFee state.
Proof. intros e s H. unfold add_fee. destruct (gas_argument s <? 0) eqn:E.
  - reflexivity.
  - apply Z.ltb_ge in E. lia. Qed.

Theorem nonnegative_whitelist_unchanged : forall environment state,
  0 <= gas_argument state -> whitelisted environment = true ->
  add_fee environment state = FeeReturned state.
Proof. intros e s H W. unfold add_fee. destruct (gas_argument s <? 0) eqn:E.
  - apply Z.ltb_lt in E. lia.
  - rewrite W. reflexivity. Qed.

Theorem charged_gas_nonnegative : forall environment gas,
  0 <= fee_factor environment -> 0 <= gas -> 0 <= charged_gas environment gas.
Proof. intros e g F G. unfold charged_gas. destruct (apply_factor e); nia. Qed.

Theorem unlisted_exact_budget_succeeds : forall environment state,
  0 <= gas_argument state -> whitelisted environment = false ->
  fee_consumed state + charged_gas environment (gas_argument state) = fee_limit environment ->
  add_fee environment state = FeeReturned
    (fee_state (charged_gas environment (gas_argument state)) (fee_limit environment)).
Proof. intros e s G W L. unfold add_fee. destruct (gas_argument s <? 0) eqn:E.
  - apply Z.ltb_lt in E. lia.
  - rewrite W. cbn [fee_consumed]. rewrite L, Z.ltb_irrefl. reflexivity. Qed.

Theorem insufficient_fee_keeps_attempted_charge : forall environment state,
  0 <= gas_argument state -> whitelisted environment = false ->
  fee_limit environment < fee_consumed state + charged_gas environment (gas_argument state) ->
  add_fee environment state = FeeFailed InsufficientGas
    (fee_state (charged_gas environment (gas_argument state))
       (fee_consumed state + charged_gas environment (gas_argument state))).
Proof. intros e s G W L. unfold add_fee. destruct (gas_argument s <? 0) eqn:E.
  - apply Z.ltb_lt in E. lia.
  - rewrite W. cbn [fee_consumed]. destruct (fee_limit e <? fee_consumed s + charged_gas e (gas_argument s)) eqn:C.
    + reflexivity.
    + apply Z.ltb_ge in C. lia. Qed.

Theorem fee_success_monotonic : forall environment state next,
  0 <= fee_factor environment -> 0 <= gas_argument state ->
  add_fee environment state = FeeReturned next -> fee_consumed state <= fee_consumed next.
Proof. intros e s n F G H. unfold add_fee in H.
  destruct (gas_argument s <? 0); [discriminate|].
  destruct (whitelisted e); [inversion H; lia|].
  destruct (fee_limit e <? fee_consumed (fee_state (charged_gas e (gas_argument s))
    (fee_consumed s + charged_gas e (gas_argument s)))); [discriminate|].
  inversion H. cbn [fee_consumed]. pose proof (charged_gas_nonnegative e (gas_argument s) F G). lia. Qed.

(* An event's charge precedes its state effect. This abstract trace must still
   be instantiated with all actual opcode and dynamic charges. *)
Section MeteredTrace.
Variable Store : Type.
Record PricedEvent := priced_event { event_charge : Z; event_effect : Store -> Store }.
Inductive TraceOutcome := TraceHalt : Z -> Store -> TraceOutcome
  | TraceGasFault : FeeError -> Z -> Store -> TraceOutcome.
Fixpoint unmetered events state :=
  match events with [] => state | event :: rest => unmetered rest (event_effect event state) end.
Fixpoint total_charge events :=
  match events with [] => 0 | event :: rest => event_charge event + total_charge rest end.
Fixpoint metered events budget consumed state :=
  match events with [] => TraceHalt consumed state | event :: rest =>
    match add_fee (fee_environment budget 1 false false) (fee_state (event_charge event) consumed) with
    | FeeReturned next => metered rest budget (fee_consumed next) (event_effect event state)
    | FeeFailed error next => TraceGasFault error (fee_consumed next) state
    | FeeContinue next => TraceGasFault NegativeFee (fee_consumed next) state
    end end.
Definition nonnegative_events events := Forall (fun event => 0 <= event_charge event) events.

Lemma nonnegative_total : forall events,
  nonnegative_events events -> 0 <= total_charge events.
Proof. intros events H. induction H; cbn [total_charge]; lia. Qed.

Theorem sufficient_budget_erases_metering : forall events budget consumed state,
  nonnegative_events events -> consumed + total_charge events <= budget ->
  metered events budget consumed state = TraceHalt (consumed + total_charge events) (unmetered events state).
Proof. induction events as [|event rest IH]; intros budget consumed state H B.
  - cbn [metered total_charge unmetered]. f_equal. lia.
  - inversion H as [|? ? Hcharge Hrest]; subst.
    pose proof (nonnegative_total rest Hrest) as R.
    cbn [metered]. unfold add_fee. cbn [gas_argument fee_consumed charged_gas apply_factor whitelisted fee_limit fee_factor].
    assert ((event_charge event <? 0) = false) as E by (apply Z.ltb_ge; lia).
    rewrite E. cbn [fee_consumed].
    assert ((budget <? consumed + event_charge event) = false) as L.
    { apply Z.ltb_ge. cbn [total_charge] in B. lia. }
    rewrite L. cbn [fee_consumed]. rewrite IH; [|exact Hrest|cbn [total_charge] in B; lia].
    cbn [total_charge unmetered]. f_equal. lia. Qed.

Theorem exhausted_charge_prevents_event_effect : forall event rest budget consumed state,
  0 <= event_charge event -> budget < consumed + event_charge event ->
  metered (event :: rest) budget consumed state =
    TraceGasFault InsufficientGas (consumed + event_charge event) state.
Proof. intros event rest budget consumed state G L. cbn [metered].
  rewrite insufficient_fee_keeps_attempted_charge; cbn [gas_argument whitelisted charged_gas apply_factor fee_limit fee_consumed]; auto. Qed.

Theorem negative_charge_prevents_event_effect : forall event rest budget consumed state,
  event_charge event < 0 -> metered (event :: rest) budget consumed state =
    TraceGasFault NegativeFee consumed state.
Proof. intros event rest budget consumed state G. cbn [metered].
  rewrite negative_fee_before_whitelist; cbn [gas_argument fee_consumed]; auto. Qed.
End MeteredTrace.
