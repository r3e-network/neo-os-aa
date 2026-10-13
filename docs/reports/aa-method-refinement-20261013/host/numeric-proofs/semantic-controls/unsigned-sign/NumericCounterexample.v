From Coq Require Import ZArith List.
Require Import NumericDefinitions.
Import ListNotations. Open Scope Z_scope.
Example original_semantics : get_integer (NByteString [128%nat]) = Some (-128).
Proof. vm_compute. reflexivity. Qed.
