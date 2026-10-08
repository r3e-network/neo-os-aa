(*)
  NeoOS formal verification -- bounded NeoVM call/return subset.

  This model is intentionally limited to the instruction classes used by the
  proxy verification-script boundary: pure stack pushes, PACK, a contract-call
  terminator, and RET. It proves that the accepted bounded shape contains only
  pure pushes before one exact call/return tail, and rejects an unsafe prefix,
  a truncated tail, and a trailing instruction.

  It does not claim to model all NeoVM opcodes, ApplicationEngine gas rules,
  syscall dispatch, witness evaluation, or C# to NEF compiler refinement. The
  byte-level opcode table and the concrete execution engine are separate Neo
  implementation obligations.
*)
From Coq Require Import List Bool Arith PeanoNat.
Import ListNotations.

Inductive instruction : Type :=
| PushData : nat -> instruction
| PushInteger : nat -> instruction
| Pack : nat -> instruction
| ContractCall : instruction
| Ret : instruction
| Other : instruction.

Definition pure_push (op : instruction) : bool :=
  match op with
  | PushData _ => true
  | PushInteger _ => true
  | Pack _ => true
  | _ => false
  end.

Definition instruction_eqb (a b : instruction) : bool :=
  match a, b with
  | PushData x, PushData y => Nat.eqb x y
  | PushInteger x, PushInteger y => Nat.eqb x y
  | Pack x, Pack y => Nat.eqb x y
  | ContractCall, ContractCall => true
  | Ret, Ret => true
  | Other, Other => true
  | _, _ => false
  end.

Fixpoint list_eqb (left right : list instruction) : bool :=
  match left, right with
  | [], [] => true
  | x :: xs, y :: ys => instruction_eqb x y && list_eqb xs ys
  | _, _ => false
  end.

Definition exact_call_return (tail : list instruction) : bool :=
  list_eqb tail [ContractCall; Ret].

Definition accepted_program (program : list instruction) : bool :=
  let split := length program - 2 in
  forallb pure_push (firstn split program) &&
  exact_call_return (skipn split program).

Definition canonical_program : list instruction :=
  [PushData 7; Pack 2; ContractCall; Ret].

Example NVM_001_canonical_program_is_accepted :
  accepted_program canonical_program = true.
Proof. vm_compute. reflexivity. Qed.

Example NVM_002_unsafe_prefix_is_rejected :
  accepted_program [Other; ContractCall; Ret] = false.
Proof. vm_compute. reflexivity. Qed.

Example NVM_003_truncated_call_tail_is_rejected :
  accepted_program [PushData 7; ContractCall] = false.
Proof. vm_compute. reflexivity. Qed.

Example NVM_004_trailing_instruction_is_rejected :
  accepted_program [PushData 7; ContractCall; Ret; Other] = false.
Proof. vm_compute. reflexivity. Qed.

Example NVM_005_non_push_before_call_is_rejected :
  accepted_program [PushInteger 1; Other; ContractCall; Ret] = false.
Proof. vm_compute. reflexivity. Qed.

Print Assumptions NVM_001_canonical_program_is_accepted.
Print Assumptions NVM_002_unsafe_prefix_is_rejected.
Print Assumptions NVM_003_truncated_call_tail_is_rejected.
Print Assumptions NVM_004_trailing_instruction_is_rejected.
Print Assumptions NVM_005_non_push_before_call_is_rejected.
