From Coq Require Import List NArith String Bool.
Import ListNotations. Open Scope string_scope.
Record row := mk { pc:nat; handler:string; need:N; cpu:N; storage:N; arity:nat }.
Fixpoint lookup (pos:nat) (xs:list row) := match xs with
| [] => None | x::rest => if Nat.eqb pos (pc x) then Some x else lookup pos rest end.
Fixpoint bytes_equal (a b:list nat) := match a,b with
| [],[] => true | x::xs,y::ys => andb (Nat.eqb x y) (bytes_equal xs ys) | _,_ => false end.
Definition wrapper : list nat := [16;65;26;247;123;103;64].
Definition script : list nat := [16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64;16;65;26;247;123;103;64].
Definition table := [mk 1 "ApplyConfigurationActions" 15%N 32768%N 0%N 2;mk 8 "CreateAccount" 15%N 32768%N 0%N 5;mk 15 "CreateAccounts" 15%N 32768%N 0%N 4;mk 22 "ExecuteUserOp" 15%N 32768%N 0%N 2;mk 29 "ExecuteUserOps" 15%N 32768%N 0%N 2;mk 36 "FreezeAccount" 15%N 32768%N 0%N 1;mk 43 "GetAccount" 1%N 32768%N 0%N 1;mk 50 "GetAccountAddress" 1%N 32768%N 0%N 1;mk 57 "GetAccountImplementationId" 0%N 32768%N 0%N 0;mk 64 "GetAuthorizedModuleId" 1%N 32768%N 0%N 2;mk 71 "GetMessageSubjects" 1%N 32768%N 0%N 1;mk 78 "GetModule" 1%N 32768%N 0%N 2;mk 85 "GetModules" 1%N 32768%N 0%N 4;mk 92 "GetNonce" 1%N 32768%N 0%N 3;mk 99 "GetNonceSequence" 1%N 32768%N 0%N 2;mk 106 "GetOperationDigest" 1%N 32768%N 0%N 2;mk 113 "GetProtocolInfo" 0%N 32768%N 0%N 0;mk 120 "GetThresholdPolicy" 1%N 32768%N 0%N 2;mk 127 "InstallModule" 15%N 32768%N 0%N 4;mk 134 "IsModuleInstalled" 1%N 32768%N 0%N 4;mk 141 "IsValidSignature" 1%N 32768%N 0%N 3;mk 148 "RemoveModule" 15%N 32768%N 0%N 3;mk 155 "ResetAccount" 15%N 32768%N 0%N 2;mk 162 "RevokeModuleCredentials" 15%N 32768%N 0%N 2;mk 169 "SetBuiltinAuthorization" 15%N 32768%N 0%N 3;mk 176 "SetRecoveryPolicy" 15%N 32768%N 0%N 4;mk 183 "UnfreezeAccount" 15%N 32768%N 0%N 1;mk 190 "ValidateUserOp" 1%N 32768%N 0%N 2;mk 197 "Verify" 5%N 32768%N 0%N 1].

Definition valid_entry start target mask argc :=
  andb (bytes_equal (firstn 7 (skipn start script)) wrapper)
    (match lookup (S start) table with
     | Some r => andb (Nat.eqb (arity r) argc) (andb (String.eqb (handler r) target)
         (andb (N.eqb (need r) mask) (andb (N.eqb (cpu r) 32768) (N.eqb (storage r) 0))))
     | None => false end).
Definition admits (start f:nat) := match lookup (S start) table with
| Some r => N.eqb (N.land (N.of_nat f) (need r)) (need r) | None => false end.
Definition agree (start:nat) (allowed:list nat) :=
  forallb (fun f => Bool.eqb (admits start f) (existsb (Nat.eqb f) allowed)) (seq 0 16).

Inductive clr := Engine | Snapshot | Address | Addresses | Bytes | ByteArrays
               | VMArray | VMItem | Text | Int32 | BigInt | Bit | Unit.
Scheme Equality for clr.
Inductive abi := Hash160 | ByteArray | ArrayType | AnyType | StringType
               | IntegerType | BooleanType | VoidType.
Scheme Equality for abi.
Inductive result_shape := Direct (t:clr) | Task (t:clr).
Record signature_row := sigrow {
  at_pc:nat; raw_parameters:list clr; routed_parameters:list clr;
  result_type:result_shape; use_engine:bool; use_snapshot:bool
}.
Definition wire_type t := match t with
| Engine | Snapshot => None | Address => Some Hash160
| Addresses | ByteArrays | VMArray => Some ArrayType
| Bytes => Some ByteArray | VMItem => Some AnyType | Text => Some StringType
| Int32 | BigInt => Some IntegerType | Bit => Some BooleanType | Unit => Some VoidType end.
Definition result_wire t := match t with Direct c | Task c => wire_type c end.
Definition visible (s:signature_row) :=
  match raw_parameters s, use_engine s, use_snapshot s with
  | Engine :: xs, true, false | Snapshot :: xs, false, true => Some xs
  | xs, false, false => Some xs | _, _, _ => None end.
Fixpoint wire_parameters xs ys := match xs, ys with
| [], [] => true
| x::xt, y::yt => match wire_type x with
  | Some x' => andb (abi_beq x' y) (wire_parameters xt yt) | None => false end
| _, _ => false end.
Definition matches_signature s args ret :=
  match visible s, result_wire (result_type s) with
  | Some raw, Some r =>
    if list_eq_dec clr_eq_dec raw (routed_parameters s)
    then andb (wire_parameters raw args) (abi_beq r ret) else false
  | _, _ => false end.
Definition valid_signature table pc args ret :=
  match List.find (fun s => Nat.eqb (at_pc s) pc) table with
  | Some s => matches_signature s args ret | None => false end.

Definition signatures := [sigrow 1 [Engine;Address;VMArray] [Address;VMArray] (Task Unit) true false;sigrow 8 [Engine;Address;Address;Bytes;BigInt;VMArray] [Address;Address;Bytes;BigInt;VMArray] (Task Unit) true false;sigrow 15 [Engine;Addresses;Address;ByteArrays;BigInt] [Addresses;Address;ByteArrays;BigInt] (Task Unit) true false;sigrow 22 [Engine;Address;VMArray] [Address;VMArray] (Task VMItem) true false;sigrow 29 [Engine;Address;VMArray] [Address;VMArray] (Task VMArray) true false;sigrow 36 [Engine;Address] [Address] (Direct Unit) true false;sigrow 43 [Snapshot;Address] [Address] (Direct VMArray) false true;sigrow 50 [Address] [Address] (Direct Address) false false;sigrow 57 [] [] (Direct Text) false false;sigrow 64 [Engine;Address;Int32] [Address;Int32] (Direct BigInt) true false;sigrow 71 [Snapshot;Address] [Address] (Direct VMArray) false true;sigrow 78 [Snapshot;Address;BigInt] [Address;BigInt] (Direct VMArray) false true;sigrow 85 [Snapshot;Address;Text;BigInt;BigInt] [Address;Text;BigInt;BigInt] (Direct VMArray) false true;sigrow 92 [Engine;Address;BigInt;Bytes] [Address;BigInt;Bytes] (Direct BigInt) true false;sigrow 99 [Engine;Address;BigInt] [Address;BigInt] (Direct BigInt) true false;sigrow 106 [Engine;Address;VMArray] [Address;VMArray] (Direct Bytes) true false;sigrow 113 [] [] (Direct VMArray) false false;sigrow 120 [Snapshot;Address;BigInt] [Address;BigInt] (Direct VMArray) false true;sigrow 127 [Engine;Address;BigInt;Address;VMArray] [Address;BigInt;Address;VMArray] (Task BigInt) true false;sigrow 134 [Snapshot;Address;Text;Address;Bytes] [Address;Text;Address;Bytes] (Direct Bit) false true;sigrow 141 [Engine;Address;Bytes;VMArray] [Address;Bytes;VMArray] (Task Bytes) true false;sigrow 148 [Engine;Address;BigInt;VMArray] [Address;BigInt;VMArray] (Task Unit) true false;sigrow 155 [Engine;Address;Address] [Address;Address] (Direct Unit) true false;sigrow 162 [Engine;Address;BigInt] [Address;BigInt] (Direct Unit) true false;sigrow 169 [Engine;Address;Bit;Bit] [Address;Bit;Bit] (Direct Unit) true false;sigrow 176 [Engine;Address;Address;BigInt;Bit] [Address;Address;BigInt;Bit] (Direct Unit) true false;sigrow 183 [Engine;Address] [Address] (Direct Unit) true false;sigrow 190 [Engine;Address;VMArray] [Address;VMArray] (Task VMArray) true false;sigrow 197 [Engine;Address] [Address] (Task Bit) true false].
Example applyConfigurationActions_dispatch : valid_entry 0 "ApplyConfigurationActions" 15%N 2 = true /\
  valid_signature signatures 1 [Hash160;ArrayType] VoidType = true /\
  agree 0 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions applyConfigurationActions_dispatch.
Example createAccount_dispatch : valid_entry 7 "CreateAccount" 15%N 5 = true /\
  valid_signature signatures 8 [Hash160;Hash160;ByteArray;IntegerType;ArrayType] VoidType = true /\
  agree 7 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions createAccount_dispatch.
Example createAccounts_dispatch : valid_entry 14 "CreateAccounts" 15%N 4 = true /\
  valid_signature signatures 15 [ArrayType;Hash160;ArrayType;IntegerType] VoidType = true /\
  agree 14 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions createAccounts_dispatch.
Example executeUserOp_dispatch : valid_entry 21 "ExecuteUserOp" 15%N 2 = true /\
  valid_signature signatures 22 [Hash160;ArrayType] AnyType = true /\
  agree 21 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions executeUserOp_dispatch.
Example executeUserOps_dispatch : valid_entry 28 "ExecuteUserOps" 15%N 2 = true /\
  valid_signature signatures 29 [Hash160;ArrayType] ArrayType = true /\
  agree 28 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions executeUserOps_dispatch.
Example freezeAccount_dispatch : valid_entry 35 "FreezeAccount" 15%N 1 = true /\
  valid_signature signatures 36 [Hash160] VoidType = true /\
  agree 35 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions freezeAccount_dispatch.
Example getAccount_dispatch : valid_entry 42 "GetAccount" 1%N 1 = true /\
  valid_signature signatures 43 [Hash160] ArrayType = true /\
  agree 42 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getAccount_dispatch.
Example getAccountAddress_dispatch : valid_entry 49 "GetAccountAddress" 1%N 1 = true /\
  valid_signature signatures 50 [Hash160] Hash160 = true /\
  agree 49 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getAccountAddress_dispatch.
Example getAccountImplementationId_dispatch : valid_entry 56 "GetAccountImplementationId" 0%N 0 = true /\
  valid_signature signatures 57 [] StringType = true /\
  agree 56 [0;1;2;3;4;5;6;7;8;9;10;11;12;13;14;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getAccountImplementationId_dispatch.
Example getAuthorizedModuleId_dispatch : valid_entry 63 "GetAuthorizedModuleId" 1%N 2 = true /\
  valid_signature signatures 64 [Hash160;IntegerType] IntegerType = true /\
  agree 63 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getAuthorizedModuleId_dispatch.
Example getMessageSubjects_dispatch : valid_entry 70 "GetMessageSubjects" 1%N 1 = true /\
  valid_signature signatures 71 [Hash160] ArrayType = true /\
  agree 70 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getMessageSubjects_dispatch.
Example getModule_dispatch : valid_entry 77 "GetModule" 1%N 2 = true /\
  valid_signature signatures 78 [Hash160;IntegerType] ArrayType = true /\
  agree 77 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getModule_dispatch.
Example getModules_dispatch : valid_entry 84 "GetModules" 1%N 4 = true /\
  valid_signature signatures 85 [Hash160;StringType;IntegerType;IntegerType] ArrayType = true /\
  agree 84 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getModules_dispatch.
Example getNonce_dispatch : valid_entry 91 "GetNonce" 1%N 3 = true /\
  valid_signature signatures 92 [Hash160;IntegerType;ByteArray] IntegerType = true /\
  agree 91 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getNonce_dispatch.
Example getNonceSequence_dispatch : valid_entry 98 "GetNonceSequence" 1%N 2 = true /\
  valid_signature signatures 99 [Hash160;IntegerType] IntegerType = true /\
  agree 98 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getNonceSequence_dispatch.
Example getOperationDigest_dispatch : valid_entry 105 "GetOperationDigest" 1%N 2 = true /\
  valid_signature signatures 106 [Hash160;ArrayType] ByteArray = true /\
  agree 105 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getOperationDigest_dispatch.
Example getProtocolInfo_dispatch : valid_entry 112 "GetProtocolInfo" 0%N 0 = true /\
  valid_signature signatures 113 [] ArrayType = true /\
  agree 112 [0;1;2;3;4;5;6;7;8;9;10;11;12;13;14;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getProtocolInfo_dispatch.
Example getThresholdPolicy_dispatch : valid_entry 119 "GetThresholdPolicy" 1%N 2 = true /\
  valid_signature signatures 120 [Hash160;IntegerType] ArrayType = true /\
  agree 119 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions getThresholdPolicy_dispatch.
Example installModule_dispatch : valid_entry 126 "InstallModule" 15%N 4 = true /\
  valid_signature signatures 127 [Hash160;IntegerType;Hash160;ArrayType] IntegerType = true /\
  agree 126 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions installModule_dispatch.
Example isModuleInstalled_dispatch : valid_entry 133 "IsModuleInstalled" 1%N 4 = true /\
  valid_signature signatures 134 [Hash160;StringType;Hash160;ByteArray] BooleanType = true /\
  agree 133 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions isModuleInstalled_dispatch.
Example isValidSignature_dispatch : valid_entry 140 "IsValidSignature" 1%N 3 = true /\
  valid_signature signatures 141 [Hash160;ByteArray;ArrayType] ByteArray = true /\
  agree 140 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions isValidSignature_dispatch.
Example removeModule_dispatch : valid_entry 147 "RemoveModule" 15%N 3 = true /\
  valid_signature signatures 148 [Hash160;IntegerType;ArrayType] VoidType = true /\
  agree 147 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions removeModule_dispatch.
Example resetAccount_dispatch : valid_entry 154 "ResetAccount" 15%N 2 = true /\
  valid_signature signatures 155 [Hash160;Hash160] VoidType = true /\
  agree 154 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions resetAccount_dispatch.
Example revokeModuleCredentials_dispatch : valid_entry 161 "RevokeModuleCredentials" 15%N 2 = true /\
  valid_signature signatures 162 [Hash160;IntegerType] VoidType = true /\
  agree 161 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions revokeModuleCredentials_dispatch.
Example setBuiltinAuthorization_dispatch : valid_entry 168 "SetBuiltinAuthorization" 15%N 3 = true /\
  valid_signature signatures 169 [Hash160;BooleanType;BooleanType] VoidType = true /\
  agree 168 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions setBuiltinAuthorization_dispatch.
Example setRecoveryPolicy_dispatch : valid_entry 175 "SetRecoveryPolicy" 15%N 4 = true /\
  valid_signature signatures 176 [Hash160;Hash160;IntegerType;BooleanType] VoidType = true /\
  agree 175 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions setRecoveryPolicy_dispatch.
Example unfreezeAccount_dispatch : valid_entry 182 "UnfreezeAccount" 15%N 1 = true /\
  valid_signature signatures 183 [Hash160] VoidType = true /\
  agree 182 [15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions unfreezeAccount_dispatch.
Example validateUserOp_dispatch : valid_entry 189 "ValidateUserOp" 1%N 2 = true /\
  valid_signature signatures 190 [Hash160;ArrayType] ArrayType = true /\
  agree 189 [1;3;5;7;9;11;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions validateUserOp_dispatch.
Example verify_dispatch : valid_entry 196 "Verify" 5%N 1 = true /\
  valid_signature signatures 197 [Hash160] BooleanType = true /\
  agree 196 [5;7;13;15] = true. Proof. vm_compute. auto. Qed.
Print Assumptions verify_dispatch.
