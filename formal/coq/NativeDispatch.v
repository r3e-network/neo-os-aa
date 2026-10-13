(*
  Native bounded callback origin: explicit activation height, caller admission,
  and separation of native dispatch fees from the returning child's policy.
  This is an abstract guard/attribution model, not C# or VM refinement.
*)
From Coq Require Import ZArith Bool Lia.
Open Scope Z_scope.

Definition selected_height (persisting : option Z) (ledger : Z) : Z :=
  match persisting with Some index => index | None => ledger end.
Definition activated (configuration : option Z) (height : Z) : bool :=
  match configuration with Some boundary => (boundary <=? height) | None => false end.
Definition dispatch_enabled (configuration persisting : option Z) (ledger : Z) : bool :=
  activated configuration (selected_height persisting ledger).
Definition admitted (native same_caller read_states allow_call : bool) : bool :=
  native && same_caller && read_states && allow_call.
Definition dispatch_charge (child_white caller_white : bool) (fee : Z) : Z * bool :=
  (if caller_white then 0 else fee, child_white).

Theorem missing_activation_is_disabled : forall persisting ledger,
  dispatch_enabled None persisting ledger = false.
Proof. reflexivity. Qed.

Theorem future_activation_is_disabled : forall boundary height,
  height < boundary -> activated (Some boundary) height = false.
Proof. intros boundary height H. unfold activated. apply Z.leb_gt. lia. Qed.

Theorem activation_equality_is_enabled : forall boundary,
  activated (Some boundary) boundary = true.
Proof. intros boundary. unfold activated. apply Z.leb_refl. Qed.

Theorem no_block_uses_ledger_height : forall configuration ledger,
  dispatch_enabled configuration None ledger = activated configuration ledger.
Proof. reflexivity. Qed.

Theorem persisting_index_overrides_ledger : forall configuration index ledger,
  dispatch_enabled configuration (Some index) ledger = activated configuration index.
Proof. reflexivity. Qed.

Theorem mismatched_caller_is_rejected : forall native read_states allow_call,
  admitted native false read_states allow_call = false.
Proof. intros. unfold admitted. rewrite andb_false_r. reflexivity. Qed.

Theorem non_native_caller_is_rejected : forall same_caller read_states allow_call,
  admitted false same_caller read_states allow_call = false.
Proof. reflexivity. Qed.

Theorem missing_read_permission_is_rejected : forall native same_caller allow_call,
  admitted native same_caller false allow_call = false.
Proof. intros. unfold admitted. rewrite andb_false_r. reflexivity. Qed.

Theorem missing_call_permission_is_rejected : forall native same_caller read_states,
  admitted native same_caller read_states false = false.
Proof. intros. unfold admitted. apply andb_false_r. Qed.

Theorem native_origin_is_reachable : admitted true true true true = true.
Proof. reflexivity. Qed.

Theorem dispatch_uses_native_caller_fee_policy : forall child_white fee,
  fst (dispatch_charge child_white false fee) = fee.
Proof. reflexivity. Qed.

Theorem exempt_native_caller_is_not_charged_by_child_policy : forall child_white fee,
  fst (dispatch_charge child_white true fee) = 0.
Proof. reflexivity. Qed.

Theorem return_keeps_child_fee_policy : forall child_white caller_white fee,
  snd (dispatch_charge child_white caller_white fee) = child_white.
Proof. reflexivity. Qed.

Print Assumptions missing_activation_is_disabled.
Print Assumptions future_activation_is_disabled.
Print Assumptions activation_equality_is_enabled.
Print Assumptions no_block_uses_ledger_height.
Print Assumptions persisting_index_overrides_ledger.
Print Assumptions mismatched_caller_is_rejected.
Print Assumptions non_native_caller_is_rejected.
Print Assumptions missing_read_permission_is_rejected.
Print Assumptions missing_call_permission_is_rejected.
Print Assumptions native_origin_is_reachable.
Print Assumptions dispatch_uses_native_caller_fee_policy.
Print Assumptions exempt_native_caller_is_not_charged_by_child_policy.
Print Assumptions return_keeps_child_fee_policy.
