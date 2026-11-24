From Coq Require Import List NArith Lia. Require Import PathFee. Import ListNotations. Open Scope N_scope.
Definition isExecutionActive_fees : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;2;8192;2048;2;2;0;16;0;32768;1;32;2;0;0].
Example isExecutionActive_total : units isExecutionActive_fees = 459510. Proof. reflexivity. Qed.
Theorem isExecutionActive_budget : forall factor budget amount,
  settle factor budget 0 isExecutionActive_fees = Paid amount <->
  factor * 459510 <= budget /\ amount = factor * 459510.
Proof. intros. rewrite settle_paid by lia. rewrite isExecutionActive_total. reflexivity. Qed.
Print Assumptions isExecutionActive_budget.
Definition hasPendingVerifierUpdate_fees : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;2;8192;2048;2;2;0;16;0;32768;1;32;2;0;0].
Example hasPendingVerifierUpdate_total : units hasPendingVerifierUpdate_fees = 459510. Proof. reflexivity. Qed.
Theorem hasPendingVerifierUpdate_budget : forall factor budget amount,
  settle factor budget 0 hasPendingVerifierUpdate_fees = Paid amount <->
  factor * 459510 <= budget /\ amount = factor * 459510.
Proof. intros. rewrite settle_paid by lia. rewrite hasPendingVerifierUpdate_total. reflexivity. Qed.
Print Assumptions hasPendingVerifierUpdate_budget.
Definition hasPendingHookUpdate_fees : list N := [8;1;2048;1;8;8;0;32768;16;8;8192;2;8;8;8;8;8;8;1;2048;2;8;8;8;8;8;8;8;8;1;2048;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;1;2;1;2;1;2;8;8192;2;1;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;8;8192;2;0;64;2;2;8192;2048;2;2;0;16;0;32768;1;32;2;0;0].
Example hasPendingHookUpdate_total : units hasPendingHookUpdate_fees = 459510. Proof. reflexivity. Qed.
Theorem hasPendingHookUpdate_budget : forall factor budget amount,
  settle factor budget 0 hasPendingHookUpdate_fees = Paid amount <->
  factor * 459510 <= budget /\ amount = factor * 459510.
Proof. intros. rewrite settle_paid by lia. rewrite hasPendingHookUpdate_total. reflexivity. Qed.
Print Assumptions hasPendingHookUpdate_budget.
Print Assumptions exhausted_at_first_overrun.
