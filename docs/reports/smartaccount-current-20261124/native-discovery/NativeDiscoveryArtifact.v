From Coq Require Import List NArith String. Require Import DiscoveryIL.
Import ListNotations. Open Scope string_scope.
Definition GetAccountImplementationId_code : list nat := [114;111;115;0;112;42].
Definition GetAccountImplementationId_symbols (token:N) : option symbol := if N.eqb token 1879077743%N then Some (Text "NativeSmartAccount") else None.
Theorem GetAccountImplementationId_returns : eval 6 GetAccountImplementationId_symbols GetAccountImplementationId_code [] = Some (Str "NativeSmartAccount").
Proof. vm_compute. reflexivity. Qed.
Print Assumptions GetAccountImplementationId_returns.
Definition GetProtocolInfo_code : list nat := [26;40;156;2;0;10;115;7;5;0;10;115;168;2;0;10;42].
Definition GetProtocolInfo_symbols (token:N) : option symbol := if N.eqb token 167772828%N then Some (ToItem) else if N.eqb token 167773447%N then Some (MakeSingleton) else if N.eqb token 167772840%N then Some (MakeArray) else None.
Theorem GetProtocolInfo_returns : eval 17 GetProtocolInfo_symbols GetProtocolInfo_code [] = Some (Array1 4).
Proof. vm_compute. reflexivity. Qed.
Print Assumptions GetProtocolInfo_returns.
