From Coq Require Import ZArith List.
Require Import NumericDefinitions.
Import ListNotations. Open Scope Z_scope.
Example original_semantics : signed_le ([255%nat] ++ [extension_byte [255%nat]]) = signed_le [255%nat].
Proof. vm_compute. reflexivity. Qed.
