Require Import AliasDefinitions.
Example expected_helper_behavior : actual_bad_observation = expected_good_observation.
Proof. vm_compute. reflexivity. Qed.
