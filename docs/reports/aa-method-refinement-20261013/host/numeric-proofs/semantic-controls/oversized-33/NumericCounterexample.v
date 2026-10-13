From Coq Require Import ZArith List.
Require Import NumericDefinitions.
Import ListNotations. Open Scope Z_scope.
Example original_semantics : byte_string_integer (repeat 0%nat 33) = None.
Proof. vm_compute. reflexivity. Qed.
