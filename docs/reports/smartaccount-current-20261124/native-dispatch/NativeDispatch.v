From Coq Require Import List NArith String Bool.
Import ListNotations. Open Scope string_scope.
Record row := mk { pc:nat; handler:string; need:N; cpu:N; storage:N }.
Fixpoint lookup (pos:nat) (xs:list row) := match xs with
| [] => None | x::rest => if Nat.eqb pos (pc x) then Some x else lookup pos rest end.
Fixpoint bytes_equal (a b:list nat) := match a,b with
| [],[] => true | x::xs,y::ys => andb (Nat.eqb x y) (bytes_equal xs ys) | _,_ => false end.
Definition wrapper : list nat := [16;65;26;247;123;103;64].
Definition script : list nat := [16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64].
Definition table := [mk 1 "ApplyConfigurationActions" 15%N 32768%N 0%N;mk 8 "CreateAccount" 15%N 32768%N 0%N;mk 15 "CreateAccounts" 15%N 32768%N 0%N;mk 22 "ExecuteUserOp" 15%N 32768%N 0%N;mk 29 "ExecuteUserOps" 15%N 32768%N 0%N;mk 36 "FreezeAccount" 15%N 32768%N 0%N;mk 43 "GetAccount" 1%N 32768%N 0%N;mk 50 "GetAccountAddress" 1%N 32768%N 0%N;mk 57 "GetAccountImplementationId" 0%N 32768%N 0%N;mk 64 "GetAuthorizedModuleId" 1%N 32768%N 0%N;mk 71 "GetMessageSubjects" 1%N 32768%N 0%N;mk 78 "GetModule" 1%N 32768%N 0%N;mk 85 "GetModules" 1%N 32768%N 0%N;mk 92 "GetNonce" 1%N 32768%N 0%N;mk 99 "GetNonceSequence" 1%N 32768%N 0%N;mk 106 "GetOperationDigest" 1%N 32768%N 0%N;mk 113 "GetProtocolInfo" 0%N 32768%N 0%N;mk 120 "GetThresholdPolicy" 1%N 32768%N 0%N;mk 127 "InstallModule" 15%N 32768%N 0%N;mk 134 "IsModuleInstalled" 1%N 32768%N 0%N;mk 141 "IsValidSignature" 1%N 32768%N 0%N;mk 148 "RemoveModule" 15%N 32768%N 0%N;mk 155 "ResetAccount" 15%N 32768%N 0%N;mk 162 "RevokeModuleCredentials" 15%N 32768%N 0%N;mk 169 "SetBuiltinAuthorization" 15%N 32768%N 0%N;mk 176 "SetRecoveryPolicy" 15%N 32768%N 0%N;mk 183 "UnfreezeAccount" 15%N 32768%N 0%N;mk 190 "ValidateUserOp" 1%N 32768%N 0%N;mk 197 "Verify" 5%N 32768%N 0%N].

Definition valid_entry start target mask :=
  andb (bytes_equal (firstn 7 (skipn start script)) wrapper)
    (match lookup (S start) table with
     | Some r => andb (String.eqb (handler r) target)
         (andb (N.eqb (need r) mask) (andb (N.eqb (cpu r) 32768) (N.eqb (storage r) 0)))
     | None => false end).
Definition admits (start f:nat) := match lookup (S start) table with
| Some r => N.eqb (N.land (N.of_nat f) (need r)) (need r) | None => false end.
Definition agree (start:nat) (allowed:list nat) :=
  forallb (fun f => Bool.eqb (admits start f) (existsb (Nat.eqb f) allowed)) (seq 0 16).

Example applyConfigurationActions_dispatch : valid_entry 0 "ApplyConfigurationActions" 15%N = true /\
  agree 0 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions applyConfigurationActions_dispatch.
Example createAccount_dispatch : valid_entry 7 "CreateAccount" 15%N = true /\
  agree 7 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions createAccount_dispatch.
Example createAccounts_dispatch : valid_entry 14 "CreateAccounts" 15%N = true /\
  agree 14 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions createAccounts_dispatch.
Example executeUserOp_dispatch : valid_entry 21 "ExecuteUserOp" 15%N = true /\
  agree 21 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions executeUserOp_dispatch.
Example executeUserOps_dispatch : valid_entry 28 "ExecuteUserOps" 15%N = true /\
  agree 28 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions executeUserOps_dispatch.
Example freezeAccount_dispatch : valid_entry 35 "FreezeAccount" 15%N = true /\
  agree 35 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions freezeAccount_dispatch.
Example getAccount_dispatch : valid_entry 42 "GetAccount" 1%N = true /\
  agree 42 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getAccount_dispatch.
Example getAccountAddress_dispatch : valid_entry 49 "GetAccountAddress" 1%N = true /\
  agree 49 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getAccountAddress_dispatch.
Example getAccountImplementationId_dispatch : valid_entry 56 "GetAccountImplementationId" 0%N = true /\
  agree 56 [0;1;2;3;4;5;6;7;8;9;10;11;12;13;14;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getAccountImplementationId_dispatch.
Example getAuthorizedModuleId_dispatch : valid_entry 63 "GetAuthorizedModuleId" 1%N = true /\
  agree 63 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getAuthorizedModuleId_dispatch.
Example getMessageSubjects_dispatch : valid_entry 70 "GetMessageSubjects" 1%N = true /\
  agree 70 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getMessageSubjects_dispatch.
Example getModule_dispatch : valid_entry 77 "GetModule" 1%N = true /\
  agree 77 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getModule_dispatch.
Example getModules_dispatch : valid_entry 84 "GetModules" 1%N = true /\
  agree 84 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getModules_dispatch.
Example getNonce_dispatch : valid_entry 91 "GetNonce" 1%N = true /\
  agree 91 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getNonce_dispatch.
Example getNonceSequence_dispatch : valid_entry 98 "GetNonceSequence" 1%N = true /\
  agree 98 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getNonceSequence_dispatch.
Example getOperationDigest_dispatch : valid_entry 105 "GetOperationDigest" 1%N = true /\
  agree 105 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getOperationDigest_dispatch.
Example getProtocolInfo_dispatch : valid_entry 112 "GetProtocolInfo" 0%N = true /\
  agree 112 [0;1;2;3;4;5;6;7;8;9;10;11;12;13;14;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getProtocolInfo_dispatch.
Example getThresholdPolicy_dispatch : valid_entry 119 "GetThresholdPolicy" 1%N = true /\
  agree 119 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getThresholdPolicy_dispatch.
Example installModule_dispatch : valid_entry 126 "InstallModule" 15%N = true /\
  agree 126 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions installModule_dispatch.
Example isModuleInstalled_dispatch : valid_entry 133 "IsModuleInstalled" 1%N = true /\
  agree 133 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions isModuleInstalled_dispatch.
Example isValidSignature_dispatch : valid_entry 140 "IsValidSignature" 1%N = true /\
  agree 140 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions isValidSignature_dispatch.
Example removeModule_dispatch : valid_entry 147 "RemoveModule" 15%N = true /\
  agree 147 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions removeModule_dispatch.
Example resetAccount_dispatch : valid_entry 154 "ResetAccount" 15%N = true /\
  agree 154 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions resetAccount_dispatch.
Example revokeModuleCredentials_dispatch : valid_entry 161 "RevokeModuleCredentials" 15%N = true /\
  agree 161 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions revokeModuleCredentials_dispatch.
Example setBuiltinAuthorization_dispatch : valid_entry 168 "SetBuiltinAuthorization" 15%N = true /\
  agree 168 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions setBuiltinAuthorization_dispatch.
Example setRecoveryPolicy_dispatch : valid_entry 175 "SetRecoveryPolicy" 15%N = true /\
  agree 175 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions setRecoveryPolicy_dispatch.
Example unfreezeAccount_dispatch : valid_entry 182 "UnfreezeAccount" 15%N = true /\
  agree 182 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions unfreezeAccount_dispatch.
Example validateUserOp_dispatch : valid_entry 189 "ValidateUserOp" 1%N = true /\
  agree 189 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions validateUserOp_dispatch.
Example verify_dispatch : valid_entry 196 "Verify" 5%N = true /\
  agree 196 [5;7;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions verify_dispatch.
