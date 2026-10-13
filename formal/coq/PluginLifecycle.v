(*
  NeoOS formal verification -- plugin admission and cleanup completeness.

  The lifecycle ABI proves that the core can call clearAccount.  It does not
  prove that the callback removed every account-scoped storage item owned by a
  future plugin.  This finite model records that distinction and provides a
  conditional theorem for the stronger, certificate-backed case.
*)
From Coq Require Import List Bool.
Import ListNotations.

Record Plugin : Type := mkPlugin {
  lifecycle_abi : bool;
  stored_keys : list nat;
  clear_account : list nat -> list nat
}.

Definition admitted (plugin : Plugin) : bool := lifecycle_abi plugin.

Definition cleanup_complete (plugin : Plugin) : bool :=
  match clear_account plugin (stored_keys plugin) with
  | [] => true
  | _ => false
  end.

Definition certified_clear (plugin : Plugin) : Prop :=
  forall state, clear_account plugin state = [].

Theorem PL_001_lifecycle_abi_does_not_imply_cleanup_completeness :
  exists plugin,
    admitted plugin = true /\ cleanup_complete plugin = false.
Proof.
  exists (mkPlugin true [99] (fun state => state)).
  split; reflexivity.
Qed.

Theorem PL_002_certified_clear_is_complete :
  forall plugin,
    certified_clear plugin -> cleanup_complete plugin = true.
Proof.
  intros plugin H.
  unfold cleanup_complete.
  rewrite H.
  reflexivity.
Qed.

Example PL_003_hidden_storage_is_a_future_plugin_counterexample :
  admitted (mkPlugin true [99] (fun state => state)) = true /\
  cleanup_complete (mkPlugin true [99] (fun state => state)) = false.
Proof. split; reflexivity. Qed.

Print Assumptions PL_001_lifecycle_abi_does_not_imply_cleanup_completeness.
Print Assumptions PL_002_certified_clear_is_complete.
Print Assumptions PL_003_hidden_storage_is_a_future_plugin_counterexample.
