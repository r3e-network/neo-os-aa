Require Import AliasDefinitions.
Example changed_heap_semantics_disagrees : actual_bad_observation <> expected_good_observation.
Proof. vm_compute. discriminate. Qed.
Print Assumptions changed_heap_semantics_disagrees.
