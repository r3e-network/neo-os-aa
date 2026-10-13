From Coq Require Import ZArith List.
Require Import NumericDefinitions.
Import ListNotations. Open Scope Z_scope.
Example original_semantics : get_integer (NBuffer []) = None.
Proof. vm_compute. reflexivity. Qed.
