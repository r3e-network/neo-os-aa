(*
  NeoOS formal verification -- proxy witness transaction-script shape.

  Source correspondence (read 2026-09-20):
    ../neo-os-aa/contracts/UnifiedSmartWallet.VerifyContext.cs
      ScriptIsSingleExecuteCall, ScriptPrefixIsDataPushes, DataPushInstructionSize

  A proxy verification script carries no secret, so the verification trigger
  binds the witness to the transaction script itself: the script must be data
  pushes followed by exactly one core.executeUserOp(s)(accountId, ...) call.
  This module is a byte-level model of that parser. Scripts are lists of
  naturals standing for bytes; the opcode table, PUSHDATA length decoding,
  bounds checks, tail layout and CallFlags push range mirror the C# source.

  Proved here: an accepted script is a walk of data-push instructions that
  lands exactly on a tail equal to the expected call for the given account id
  and core hash with an in-range CallFlags push; every instruction start in
  that walk carries a data-push opcode, so no SYSCALL, CALL, JMP or TRY can
  begin an instruction before the core call; acceptance binds the account id
  and the core hash uniquely; and the canonical shapes are reachable while a
  leading non-push opcode, a foreign account id and an out-of-range flags push
  are rejected.

  Not proved: that the NeoVM executes a data push exactly as the size table
  says (the table is transcribed, not derived), that Runtime.Transaction and
  Runtime.CallingScriptHash are what the model assumes, witness-rule
  evaluation, signer-scope semantics, or C#-to-NEF refinement. Bytes are not
  bounded to 0..255 in the model; the C# byte type enforces that bound.
*)
From Coq Require Import List Bool PeanoNat Lia.
Import ListNotations.

Definition byte := nat.
Definition script := list byte.

Definition at_ (s : script) (i : nat) : byte := nth i s 0.

(* DataPushInstructionSize before its overrun check: the raw size of the
   instruction at i if it is a pure stack-data instruction, else 0. *)
Definition data_push_raw_size (s : script) (i endp : nat) : nat :=
  let op := at_ s i in
  if op =? 0 then 2                                   (* PUSHINT8 *)
  else if op =? 1 then 3                              (* PUSHINT16 *)
  else if op =? 2 then 5                              (* PUSHINT32 *)
  else if op =? 3 then 9                              (* PUSHINT64 *)
  else if op =? 4 then 17                             (* PUSHINT128 *)
  else if op =? 5 then 33                             (* PUSHINT256 *)
  else if ((op =? 8) || (op =? 9) || (op =? 11)) then 1 (* PUSHT PUSHF PUSHNULL *)
  else if op =? 12 then                               (* PUSHDATA1 *)
    (if i + 1 <? endp then 2 + at_ s (i + 1) else 0)
  else if op =? 13 then                               (* PUSHDATA2 *)
    (if i + 2 <? endp then 3 + at_ s (i + 1) + 256 * at_ s (i + 2) else 0)
  else if op =? 14 then                               (* PUSHDATA4 *)
    (if i + 4 <? endp then
       5 + at_ s (i + 1) + 256 * at_ s (i + 2) + 65536 * at_ s (i + 3)
         + 16777216 * at_ s (i + 4)
     else 0)
  else if ((15 <=? op) && (op <=? 32)) then 1         (* PUSHM1, PUSH0..PUSH16 *)
  else if ((op =? 190) || (op =? 191) || (op =? 192)) then 1 (* PACKMAP PACKSTRUCT PACK *)
  else if ((op =? 194) || (op =? 197) || (op =? 200)) then 1 (* NEWARRAY0 NEWSTRUCT0 NEWMAP *)
  else if op =? 219 then 2                            (* CONVERT <type> *)
  else 0.

(* DataPushInstructionSize: 0 when the instruction is not a data push or
   would overrun the prefix boundary. *)
Definition data_push_size (s : script) (i endp : nat) : nat :=
  let size := data_push_raw_size s i endp in
  if size =? 0 then 0 else if endp <? i + size then 0 else size.

(* The opcode set the parser treats as pure stack data. The grouping of the
   disjuncts matches data_push_raw_size so the proofs can rewrite them. *)
Definition data_push_opcode (op : byte) : bool :=
  (op <=? 5)
  || ((op =? 8) || (op =? 9) || (op =? 11))
  || (op =? 12) || (op =? 13) || (op =? 14)
  || ((op =? 190) || (op =? 191) || (op =? 192))
  || ((op =? 194) || (op =? 197) || (op =? 200))
  || (op =? 219)
  || ((15 <=? op) && (op <=? 32)).

(* ScriptPrefixIsDataPushes: the while loop, with the loop count as fuel.
   Every step advances by at least one byte and never past endp, so fuel =
   endp is exact. *)
Fixpoint prefix_pushes (fuel : nat) (s : script) (i endp : nat) : bool :=
  match fuel with
  | 0 => i =? endp
  | S fuel' =>
      if i <? endp then
        let size := data_push_size s i endp in
        if size =? 0 then false else prefix_pushes fuel' s (i + size) endp
      else i =? endp
  end.

Definition script_prefix_is_data_pushes (s : script) (endp : nat) : bool :=
  prefix_pushes endp s 0 endp.

(* Instruction start positions visited by the same walk. *)
Fixpoint walk_positions (fuel : nat) (s : script) (i endp : nat) : list nat :=
  match fuel with
  | 0 => []
  | S fuel' =>
      if i <? endp then
        let size := data_push_size s i endp in
        if size =? 0 then [i] else i :: walk_positions fuel' s (i + size) endp
      else []
  end.

Definition bytes_eq (a b : script) : bool :=
  if list_eq_dec Nat.eq_dec a b then true else false.

Definition PUSHDATA1_20 : script := [12; 20].
Definition PUSH2_PACK : script := [18; 192].
Definition SYSCALL_CONTRACT_CALL : script := [65; 98; 125; 91; 82].
Definition METHOD_EXECUTE_USER_OP : script :=
  [12; 13; 101; 120; 101; 99; 117; 116; 101; 85; 115; 101; 114; 79; 112].
Definition METHOD_EXECUTE_USER_OPS : script :=
  [12; 14; 101; 120; 101; 99; 117; 116; 101; 85; 115; 101; 114; 79; 112; 115].

(* CallFlags is pushed as PUSH0..PUSH15 (0x10..0x1F). *)
Definition flags_in_range (f : byte) : bool := (16 <=? f) && (f <=? 31).

Definition tail_length (method_push : script) : nat := 52 + length method_push.

Definition expected_tail (account core : script) (flags : byte) (method_push : script) : script :=
  PUSHDATA1_20 ++ account ++ PUSH2_PACK ++ [flags] ++ method_push
    ++ PUSHDATA1_20 ++ core ++ SYSCALL_CONTRACT_CALL.

(* The cursor walk of ScriptIsSingleExecuteCall over the tail slice t. *)
Definition tail_matches (t : script) (account core method_push : script) : bool :=
  bytes_eq (firstn 2 t) PUSHDATA1_20 &&
  bytes_eq (firstn 20 (skipn 2 t)) account &&
  bytes_eq (firstn 2 (skipn 22 t)) PUSH2_PACK &&
  flags_in_range (at_ t 24) &&
  bytes_eq (firstn (length method_push) (skipn 25 t)) method_push &&
  bytes_eq (firstn 2 (skipn (25 + length method_push) t)) PUSHDATA1_20 &&
  bytes_eq (firstn 20 (skipn (27 + length method_push) t)) core &&
  bytes_eq (firstn 5 (skipn (47 + length method_push) t)) SYSCALL_CONTRACT_CALL.

Definition script_is_single_execute_call (s account core method_push : script) : bool :=
  let tl := tail_length method_push in
  (tl <=? length s) &&
  tail_matches (skipn (length s - tl) s) account core method_push &&
  script_prefix_is_data_pushes s (length s - tl).

(* TransactionIsBoundToAccountExecution's script clause. *)
Definition transaction_script_is_bound (s account core : script) : bool :=
  script_is_single_execute_call s account core METHOD_EXECUTE_USER_OP
  || script_is_single_execute_call s account core METHOD_EXECUTE_USER_OPS.

Lemma bytes_eq_true : forall a b, bytes_eq a b = true -> a = b.
Proof.
  intros a b H. unfold bytes_eq in H.
  destruct (list_eq_dec Nat.eq_dec a b); [assumption | discriminate].
Qed.

Lemma skipn_split : forall (n k : nat) (l : script),
  skipn k l = firstn n (skipn k l) ++ skipn (k + n) l.
Proof.
  intros n k l.
  rewrite <- (firstn_skipn n (skipn k l)) at 1.
  rewrite skipn_skipn. rewrite Nat.add_comm. reflexivity.
Qed.

Lemma firstn1_skipn_nth : forall (n : nat) (l : script),
  n < length l -> firstn 1 (skipn n l) = [nth n l 0].
Proof.
  induction n as [| n IH]; intros l Hlen; destruct l as [| a l']; simpl in *.
  - lia.
  - reflexivity.
  - lia.
  - apply IH. lia.
Qed.

Lemma tail_segments : forall (t : script) (lm : nat),
  length t = 52 + lm ->
  t = firstn 2 t
      ++ (firstn 20 (skipn 2 t)
      ++ (firstn 2 (skipn 22 t)
      ++ ([at_ t 24]
      ++ (firstn lm (skipn 25 t)
      ++ (firstn 2 (skipn (25 + lm) t)
      ++ (firstn 20 (skipn (27 + lm) t)
      ++ firstn 5 (skipn (47 + lm) t))))))).
Proof.
  intros t lm Hlen.
  assert (H47 : skipn (47 + lm) t = firstn 5 (skipn (47 + lm) t)).
  { rewrite (skipn_split 5 (47 + lm) t) at 1.
    rewrite (skipn_all2 (n := 47 + lm + 5) t) by lia.
    rewrite app_nil_r. reflexivity. }
  assert (H27 : skipn (27 + lm) t = firstn 20 (skipn (27 + lm) t) ++ skipn (47 + lm) t).
  { rewrite (skipn_split 20 (27 + lm) t) at 1.
    replace (27 + lm + 20) with (47 + lm) by lia. reflexivity. }
  assert (H25 : skipn (25 + lm) t = firstn 2 (skipn (25 + lm) t) ++ skipn (27 + lm) t).
  { rewrite (skipn_split 2 (25 + lm) t) at 1.
    replace (25 + lm + 2) with (27 + lm) by lia. reflexivity. }
  assert (Hm : skipn 25 t = firstn lm (skipn 25 t) ++ skipn (25 + lm) t).
  { rewrite (skipn_split lm 25 t) at 1. reflexivity. }
  assert (H24 : skipn 24 t = [at_ t 24] ++ skipn 25 t).
  { rewrite (skipn_split 1 24 t) at 1. unfold at_.
    rewrite firstn1_skipn_nth; [reflexivity | lia]. }
  assert (H22 : skipn 22 t = firstn 2 (skipn 22 t) ++ skipn 24 t).
  { rewrite (skipn_split 2 22 t) at 1. reflexivity. }
  assert (H2 : skipn 2 t = firstn 20 (skipn 2 t) ++ skipn 22 t).
  { rewrite (skipn_split 20 2 t) at 1. reflexivity. }
  rewrite <- H47, <- H27, <- H25, <- Hm, <- H24, <- H22, <- H2.
  symmetry. apply firstn_skipn.
Qed.

Lemma prefix_pushes_S : forall fuel s i endp,
  prefix_pushes (S fuel) s i endp =
    (if i <? endp then
       (if data_push_size s i endp =? 0 then false
        else prefix_pushes fuel s (i + data_push_size s i endp) endp)
     else i =? endp).
Proof. reflexivity. Qed.

Lemma walk_positions_S : forall fuel s i endp,
  walk_positions (S fuel) s i endp =
    (if i <? endp then
       (if data_push_size s i endp =? 0 then [i]
        else i :: walk_positions fuel s (i + data_push_size s i endp) endp)
     else []).
Proof. reflexivity. Qed.

Lemma raw_size_zero_when_size_zero : forall s i endp,
  data_push_size s i endp <> 0 -> data_push_raw_size s i endp <> 0.
Proof.
  intros s i endp H. unfold data_push_size in H.
  destruct (data_push_raw_size s i endp =? 0) eqn:E.
  - exfalso. apply H. reflexivity.
  - apply Nat.eqb_neq in E. exact E.
Qed.

Theorem PW_001_positive_size_implies_data_push_opcode :
  forall s i endp,
    data_push_raw_size s i endp <> 0 -> data_push_opcode (at_ s i) = true.
Proof.
  intros s i endp. unfold data_push_raw_size, data_push_opcode.
  generalize (at_ s i) as op. intro op.
  destruct (op =? 0) eqn:E0; [apply Nat.eqb_eq in E0; subst; intros; reflexivity |].
  destruct (op =? 1) eqn:E1; [apply Nat.eqb_eq in E1; subst; intros; reflexivity |].
  destruct (op =? 2) eqn:E2; [apply Nat.eqb_eq in E2; subst; intros; reflexivity |].
  destruct (op =? 3) eqn:E3; [apply Nat.eqb_eq in E3; subst; intros; reflexivity |].
  destruct (op =? 4) eqn:E4; [apply Nat.eqb_eq in E4; subst; intros; reflexivity |].
  destruct (op =? 5) eqn:E5; [apply Nat.eqb_eq in E5; subst; intros; reflexivity |].
  destruct ((op =? 8) || (op =? 9) || (op =? 11)) eqn:E8;
    [intros; repeat (rewrite orb_true_r || rewrite orb_true_l); reflexivity |].
  destruct (op =? 12) eqn:E12; [apply Nat.eqb_eq in E12; subst; intros; reflexivity |].
  destruct (op =? 13) eqn:E13; [apply Nat.eqb_eq in E13; subst; intros; reflexivity |].
  destruct (op =? 14) eqn:E14; [apply Nat.eqb_eq in E14; subst; intros; reflexivity |].
  destruct ((15 <=? op) && (op <=? 32)) eqn:Er;
    [intros; repeat (rewrite orb_true_r || rewrite orb_true_l); reflexivity |].
  destruct ((op =? 190) || (op =? 191) || (op =? 192)) eqn:E190;
    [intros; repeat (rewrite orb_true_r || rewrite orb_true_l); reflexivity |].
  destruct ((op =? 194) || (op =? 197) || (op =? 200)) eqn:E194;
    [intros; repeat (rewrite orb_true_r || rewrite orb_true_l); reflexivity |].
  destruct (op =? 219) eqn:E219; [apply Nat.eqb_eq in E219; subst; intros; reflexivity |].
  intro H. exfalso. apply H. reflexivity.
Qed.

Theorem PW_002_prefix_walk_starts_only_data_push_opcodes :
  forall fuel s i endp,
    prefix_pushes fuel s i endp = true ->
    Forall (fun j => data_push_opcode (at_ s j) = true) (walk_positions fuel s i endp).
Proof.
  induction fuel as [| fuel IH]; intros s i endp H.
  - constructor.
  - rewrite prefix_pushes_S in H. rewrite walk_positions_S.
    destruct (i <? endp) eqn:Hi.
    + destruct (data_push_size s i endp =? 0) eqn:Hz; [discriminate |].
      apply Nat.eqb_neq in Hz.
      constructor.
      * apply (PW_001_positive_size_implies_data_push_opcode s i endp).
        apply raw_size_zero_when_size_zero. exact Hz.
      * apply IH. exact H.
    + constructor.
Qed.

Theorem PW_003_no_syscall_starts_an_instruction_before_the_call :
  forall fuel s i endp,
    prefix_pushes fuel s i endp = true ->
    Forall (fun j => at_ s j <> 65) (walk_positions fuel s i endp).
Proof.
  intros fuel s i endp H.
  apply PW_002_prefix_walk_starts_only_data_push_opcodes in H.
  eapply Forall_impl; [| exact H].
  intros j Hj Heq. cbv beta in Hj. rewrite Heq in Hj. discriminate.
Qed.

Theorem PW_004_walk_never_overruns_the_boundary :
  forall fuel s i endp,
    prefix_pushes fuel s i endp = true -> i <= endp.
Proof.
  induction fuel as [| fuel IH]; intros s i endp H.
  - simpl in H. apply Nat.eqb_eq in H. lia.
  - rewrite prefix_pushes_S in H.
    destruct (i <? endp) eqn:Hi.
    + apply Nat.ltb_lt in Hi. lia.
    + apply Nat.eqb_eq in H. lia.
Qed.

Theorem PW_005_accepted_script_is_data_pushes_then_exact_call :
  forall s account core method_push,
    length account = 20 -> length core = 20 ->
    script_is_single_execute_call s account core method_push = true ->
    exists prefix flags,
      s = prefix ++ expected_tail account core flags method_push /\
      flags_in_range flags = true /\
      script_prefix_is_data_pushes s (length prefix) = true.
Proof.
  intros s account core method_push Hacc Hcore H.
  unfold script_is_single_execute_call in H.
  apply andb_true_iff in H. destruct H as [H Hprefix].
  apply andb_true_iff in H. destruct H as [Hlen Htail].
  apply Nat.leb_le in Hlen.
  set (tl := tail_length method_push) in *.
  set (t := skipn (length s - tl) s) in *.
  assert (Htlen : length t = 52 + length method_push).
  { unfold t. rewrite skipn_length. unfold tl, tail_length in *. lia. }
  unfold tail_matches in Htail.
  repeat (apply andb_true_iff in Htail; destruct Htail as [Htail ?]).
  exists (firstn (length s - tl) s), (at_ t 24).
  repeat split.
  - rewrite <- (firstn_skipn (length s - tl) s) at 1.
    fold t.
    f_equal.
    rewrite (tail_segments t (length method_push) Htlen) at 1.
    unfold expected_tail.
    repeat match goal with
           | [Hb : bytes_eq _ _ = true |- _] => apply bytes_eq_true in Hb; rewrite Hb; clear Hb
           end.
    reflexivity.
  - assumption.
  - rewrite firstn_length_le; [exact Hprefix | lia].
Qed.

Theorem PW_006_accepted_call_binds_account_and_core :
  forall s a1 c1 a2 c2 method_push,
    script_is_single_execute_call s a1 c1 method_push = true ->
    script_is_single_execute_call s a2 c2 method_push = true ->
    a1 = a2 /\ c1 = c2.
Proof.
  intros s a1 c1 a2 c2 m H1 H2.
  unfold script_is_single_execute_call in H1, H2.
  apply andb_true_iff in H1. destruct H1 as [H1 _].
  apply andb_true_iff in H1. destruct H1 as [_ H1].
  apply andb_true_iff in H2. destruct H2 as [H2 _].
  apply andb_true_iff in H2. destruct H2 as [_ H2].
  unfold tail_matches in H1, H2.
  repeat (apply andb_true_iff in H1; destruct H1 as [H1 ?]).
  repeat (apply andb_true_iff in H2; destruct H2 as [H2 ?]).
  repeat match goal with
         | [Hb : bytes_eq _ _ = true |- _] => apply bytes_eq_true in Hb
         end.
  split; congruence.
Qed.

Theorem PW_007_bound_transaction_is_an_execute_call :
  forall s account core,
    length account = 20 -> length core = 20 ->
    transaction_script_is_bound s account core = true ->
    exists method_push prefix flags,
      (method_push = METHOD_EXECUTE_USER_OP \/ method_push = METHOD_EXECUTE_USER_OPS) /\
      s = prefix ++ expected_tail account core flags method_push /\
      flags_in_range flags = true /\
      script_prefix_is_data_pushes s (length prefix) = true.
Proof.
  intros s account core Hacc Hcore H.
  unfold transaction_script_is_bound in H.
  apply orb_true_iff in H. destruct H as [H | H].
  - apply PW_005_accepted_script_is_data_pushes_then_exact_call in H; try assumption.
    destruct H as [prefix [flags [Hs [Hf Hp]]]].
    exists METHOD_EXECUTE_USER_OP, prefix, flags. auto.
  - apply PW_005_accepted_script_is_data_pushes_then_exact_call in H; try assumption.
    destruct H as [prefix [flags [Hs [Hf Hp]]]].
    exists METHOD_EXECUTE_USER_OPS, prefix, flags. auto.
Qed.

Definition SAMPLE_ACCOUNT : script := repeat 7 20.
Definition SAMPLE_CORE : script := repeat 9 20.
Definition OTHER_ACCOUNT : script := repeat 8 20.

(* PUSHDATA1 3 bytes, PUSH0, then the exact core call with CallFlags.All (PUSH15). *)
Example PW_008_canonical_single_call_is_accepted :
  transaction_script_is_bound
    ([12; 3; 1; 2; 3] ++ [16] ++ expected_tail SAMPLE_ACCOUNT SAMPLE_CORE 31 METHOD_EXECUTE_USER_OP)
    SAMPLE_ACCOUNT SAMPLE_CORE = true.
Proof. vm_compute. reflexivity. Qed.

Example PW_009_canonical_batch_call_is_accepted :
  transaction_script_is_bound
    ([12; 2; 5; 6] ++ expected_tail SAMPLE_ACCOUNT SAMPLE_CORE 31 METHOD_EXECUTE_USER_OPS)
    SAMPLE_ACCOUNT SAMPLE_CORE = true.
Proof. vm_compute. reflexivity. Qed.

(* A SYSCALL opcode ahead of the core call is not a data push. *)
Example PW_010_leading_syscall_is_rejected :
  transaction_script_is_bound
    ([65; 98; 125; 91; 82] ++ expected_tail SAMPLE_ACCOUNT SAMPLE_CORE 31 METHOD_EXECUTE_USER_OP)
    SAMPLE_ACCOUNT SAMPLE_CORE = false.
Proof. vm_compute. reflexivity. Qed.

Example PW_011_foreign_account_is_rejected :
  transaction_script_is_bound
    (expected_tail SAMPLE_ACCOUNT SAMPLE_CORE 31 METHOD_EXECUTE_USER_OP)
    OTHER_ACCOUNT SAMPLE_CORE = false.
Proof. vm_compute. reflexivity. Qed.

(* PUSH16 (0x20) is a data push but not a CallFlags push. *)
Example PW_012_out_of_range_flags_push_is_rejected :
  transaction_script_is_bound
    (expected_tail SAMPLE_ACCOUNT SAMPLE_CORE 32 METHOD_EXECUTE_USER_OP)
    SAMPLE_ACCOUNT SAMPLE_CORE = false.
Proof. vm_compute. reflexivity. Qed.

(* A trailing instruction after the call breaks the tail alignment. *)
Example PW_013_trailing_instruction_is_rejected :
  transaction_script_is_bound
    (expected_tail SAMPLE_ACCOUNT SAMPLE_CORE 31 METHOD_EXECUTE_USER_OP ++ [16])
    SAMPLE_ACCOUNT SAMPLE_CORE = false.
Proof. vm_compute. reflexivity. Qed.

Print Assumptions bytes_eq_true.
Print Assumptions skipn_split.
Print Assumptions firstn1_skipn_nth.
Print Assumptions tail_segments.
Print Assumptions prefix_pushes_S.
Print Assumptions walk_positions_S.
Print Assumptions raw_size_zero_when_size_zero.
Print Assumptions PW_001_positive_size_implies_data_push_opcode.
Print Assumptions PW_002_prefix_walk_starts_only_data_push_opcodes.
Print Assumptions PW_003_no_syscall_starts_an_instruction_before_the_call.
Print Assumptions PW_004_walk_never_overruns_the_boundary.
Print Assumptions PW_005_accepted_script_is_data_pushes_then_exact_call.
Print Assumptions PW_006_accepted_call_binds_account_and_core.
Print Assumptions PW_007_bound_transaction_is_an_execute_call.
Print Assumptions PW_008_canonical_single_call_is_accepted.
Print Assumptions PW_009_canonical_batch_call_is_accepted.
Print Assumptions PW_010_leading_syscall_is_rejected.
Print Assumptions PW_011_foreign_account_is_rejected.
Print Assumptions PW_012_out_of_range_flags_push_is_rejected.
Print Assumptions PW_013_trailing_instruction_is_rejected.
