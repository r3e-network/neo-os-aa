From Coq Require Import Bool.Bool Lists.List Arith.PeanoNat.
Import ListNotations.

(* Policy model only. Call/witness authenticity, storage and VM rollback are
   separate implementation obligations. *)
Inductive status := Active | Frozen | MigrationRequired.
Definition accept_authority (admin changed consent valid_address : bool) : bool :=
  admin && valid_address && (negb changed || consent).
Definition recover (s : status) (seat configured mature current_epoch : bool) : bool :=
  match s with
  | Active | Frozen => seat && configured && mature && current_epoch
  | MigrationRequired => false
  end.
Definition hook_trace (hooks : list nat) := hooks ++ rev hooks.

Theorem new_authority_requires_consent : forall a c v,
  accept_authority a true c v = true -> c = true.
Proof. intros [] [] []; cbv; intuition discriminate. Qed.
Theorem unchanged_authority_needs_only_admin_and_valid_address : forall a c v,
  accept_authority a false c v = andb a v.
Proof. intros [] [] []; reflexivity. Qed.
Theorem frozen_recovery_matches_active : forall seat configured mature current_epoch,
  recover Frozen seat configured mature current_epoch =
  recover Active seat configured mature current_epoch.
Proof. reflexivity. Qed.
Theorem frozen_recovery_needs_all_conditions : forall a b c d,
  recover Frozen a b c d = true <-> a = true /\ b = true /\ c = true /\ d = true.
Proof. intros [] [] [] []; cbv; intuition discriminate. Qed.
Theorem migration_never_recovers : forall a b c d,
  recover MigrationRequired a b c d = false.
Proof. reflexivity. Qed.
Theorem nested_hooks_bracket_target : forall h hs,
  hook_trace (h :: hs) = h :: hook_trace hs ++ [h].
Proof. intros. unfold hook_trace. simpl. now rewrite app_assoc. Qed.

Print Assumptions new_authority_requires_consent.
Print Assumptions unchanged_authority_needs_only_admin_and_valid_address.
Print Assumptions frozen_recovery_matches_active.
Print Assumptions frozen_recovery_needs_all_conditions.
Print Assumptions migration_never_recovers.
Print Assumptions nested_hooks_bracket_target.
