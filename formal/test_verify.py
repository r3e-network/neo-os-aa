"""Tests of the gate, not formal proof evidence. Run with unittest discovery."""
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import verify


class VerificationGateTests(unittest.TestCase):
    def test_native_composite_phase_model_is_registered(self):
        self.assertIn('coq/NativeCompositePhase.v', verify.ARTIFACTS)
        model = (verify.ROOT / 'coq/NativeCompositePhase.v').read_text()
        for name in ('old_entry_rejects_post', 'post_entry_rejects_validation', 'missing_grant_rejects',
                     'both_entries_use_same_policy', 'nonboolean_not_support', 'post_plan_exact_support',
                     'post_plan_preserves_membership', 'post_plan_preserves_uniqueness'):
            self.assertIn(name, verify.coq_declarations(model))
        self.assertEqual(6, len(verify.COQ_MODULES['NativeCompositePhase.v']))

    def test_native_restricted_policy_is_registered_and_fail_closed(self):
        self.assertIn('coq/NativeRestrictedPolicy.v', verify.ARTIFACTS)
        model=(verify.ROOT/'coq/NativeRestrictedPolicy.v').read_text()
        for name in ('missing_snapshot_rejects', 'invalid_query_rejects',
                     'outflow_rejects', 'inflow_allowed', 'direct_target_rejects',
                     'every_restriction_must_hold', 'false_result_does_not_bypass',
                     'removal_preserves_other_tokens', 'cleanup_clears_both_prefixes'):
            self.assertIn(name, verify.coq_declarations(model))
        self.assertIn('contracts/hooks/TokenRestrictedHook.cs', verify.SOURCE_FILES)
        self.assertEqual(8,len(verify.COQ_MODULES['NativeRestrictedPolicy.v']))

    def test_native_session_scope_has_uncapped_and_key_reuse_controls(self):
        self.assertIn('coq/NativeSessionScope.v', verify.ARTIFACTS)
        model=(verify.ROOT/'coq/NativeSessionScope.v').read_text()
        for name in ('wildcard_retains_target', 'uncapped_shape_independent',
                     'uncapped_false_completes', 'uncapped_spending_unchanged',
                     'target_fault_rolls_back', 'capped_false_rolls_back',
                     'revoked_key_rejects', 'replaced_key_rejects',
                     'restored_key_can_revive_signature', 'consumed_nonce_still_rejects'):
            self.assertIn(name, verify.coq_declarations(model))
        self.assertEqual(18,len(verify.COQ_MODULES['NativeSessionScope.v']))

    def test_native_daily_window_model_is_registered(self):
        self.assertIn('coq/NativeDailyPolicy.v',verify.ARTIFACTS)
        model=(verify.ROOT/'coq/NativeDailyPolicy.v').read_text()
        for theorem in ('fixed_anchor_stays', 'fixed_expiry_restarts', 'fixed_charge_within_cap',
                        'zero_outflow_preserves_window', 'false_result_still_meters', 'inflow_is_not_outflow',
                        'rolling_lower_boundary_included', 'rolling_expired_excluded', 'rolling_full_rejects',
                        'history_scan_agrees', 'pruning_preserves_scan', 'retains_every_live_record',
                        'history_capacity_rejects', 'live_record_increments_count', 'append_preserves_capacity',
                        'nonnegative_balance_exact', 'negative_balance_rejected', 'noninteger_balance_rejected',
                        'failed_balance_query_rejected', 'accepted_balance_is_nonnegative',
                        'rejected_observation_aborts_delta', 'accepted_delta_exact'):
            self.assertIn(theorem,verify.coq_declarations(model))
        self.assertIn('contracts/hooks/DailyLimitHook.cs',verify.SOURCE_FILES)
        self.assertEqual(15,len(verify.COQ_MODULES['NativeDailyPolicy.v']))

    def tlc_output(self):
        return "\n".join([
            "Progress(2): 10 states generated, 3 distinct states found, 1 states left on queue.",
            "Model checking completed. No error has been found.",
            "100 states generated, 20 distinct states found, 0 states left on queue.",
            *[f"<{action} line 1, col 1 of module M>: 0:7" for action in
              ("Init", "Tick", "Begin", "CompleteSuccess", "CompleteFailure")],
        ])

    def test_final_counts_not_progress_and_generated_not_distinct(self):
        result = verify.parse_tlc(self.tlc_output(), 0)
        self.assertEqual(20, result["distinct"])
        self.assertEqual(7, result["actions"]["Begin"])

    def test_tlc_nonzero_exit_even_with_success_marker(self):
        with self.assertRaises(ValueError):
            verify.parse_tlc(self.tlc_output(), 1)

    def test_tlc_truncated_summary(self):
        with self.assertRaises(ValueError):
            verify.parse_tlc(self.tlc_output().replace("0 states left on queue.", "1 states left on queue."), 0)

    def test_tlc_unreachable_action(self):
        with self.assertRaises(ValueError):
            verify.parse_tlc(self.tlc_output().replace(": 0:7", ": 0:0"), 0)

    def test_tlc_missing_action(self):
        with self.assertRaises(ValueError):
            verify.parse_tlc(self.tlc_output().replace("CompleteFailure", "Other"), 0)

    def test_tlc_duplicate_action_row_fails_closed(self):
        with self.assertRaises(ValueError):
            verify.parse_tlc(self.tlc_output() + "\n<Begin line 1, col 1 of module M>: 0:9", 0)

    def test_tlc_repeated_coverage_samples_use_final_roster(self):
        sample = self.tlc_output()
        coverage = "\n".join(line for line in sample.splitlines() if line.startswith("<"))
        result = verify.parse_tlc(sample + "\n" + coverage, 0)
        self.assertEqual(7, result["actions"]["Begin"])

    def test_callback_mutation_roster_includes_composite_cleanup(self):
        self.assertIn("composite-cleanup-all-children", verify.CALLBACK_PLUGIN_COQ_MUTATIONS)
        self.assertIn("composite-root-clear", verify.CALLBACK_PLUGIN_COQ_MUTATIONS)
        self.assertIn("composite-failure-rollback", verify.CALLBACK_PLUGIN_COQ_MUTATIONS)
        self.assertIn("verifier-post-order", verify.CALLBACK_PLUGIN_COQ_MUTATIONS)
        self.assertIn("dependency-replacement-skips-cleanup", verify.CALLBACK_PLUGIN_COQ_MUTATIONS)
        self.assertIn("dependency-replacement-publishes-on-failure", verify.CALLBACK_PLUGIN_COQ_MUTATIONS)

    def test_callback_model_includes_verifier_post_phase(self):
        model = (verify.ROOT / "coq" / "CallbackPluginTopology.v").read_text()
        self.assertIn("| VerifierPost", model)
        self.assertIn("PostHook; VerifierPost; Emit", model)

    def test_callback_model_includes_dependency_registry_atomicity(self):
        model = (verify.ROOT / "coq" / "CallbackPluginTopology.v").read_text()
        self.assertIn("CPT_014_dependency_replacement_requires_cleanup", model)
        self.assertIn("CPT_015_failed_dependency_replacement_is_atomic", model)
        self.assertIn("CPT_016_successful_dependency_replacement_has_no_removed_child", model)
        self.assertIn("CPT_017_composite_children_are_leaves", model)

    def test_authorization_evidence_model_is_registered(self):
        model = (verify.ROOT / "coq" / "AuthorizationEvidence.v").read_text()
        self.assertIn("accepted_evidence_is_bound", model)
        self.assertIn("accepted_evidence_cannot_be_replayed", model)
        self.assertIn("evidence-replay-freshness", verify.AUTHORIZATION_EVIDENCE_COQ_MUTATIONS)

    def test_attestation_proof_envelope_model_is_registered(self):
        model = (verify.ROOT / "coq" / "AttestationProofBinding.v").read_text()
        self.assertIn("accepted_proof_is_bound", model)
        self.assertIn("accepted_proof_cannot_be_replayed", model)
        self.assertIn("proof-measurement-binding", verify.ATTESTATION_PROOF_COQ_MUTATIONS)
        self.assertIn("proof-replay-freshness", verify.ATTESTATION_PROOF_COQ_MUTATIONS)

    def test_open_formal_boundary_ledger_remains_explicit(self):
        ledger = json.loads((verify.ROOT.parent / "docs/reports/aa-open-formal-boundaries-20261006.json").read_text())
        self.assertEqual("OPEN_BOUNDARIES_RETAINED", ledger["status"])
        statuses = {item["id"]: item["status"] for item in ledger["boundaries"]}
        self.assertEqual("OPEN", statuses["FORMAL-NEOVM-COMPILER-REFINEMENT"])
        self.assertEqual("PARTIAL", statuses["FORMAL-CRYPTO-WITNESS-ATTESTATION-ZK"])
        self.assertEqual("PARTIAL", statuses["FORMAL-MULTISIG-FUTURE-PLUGIN"])

    def test_native_service_witness_boundary_is_registered(self):
        model = (verify.ROOT / "coq" / "NativeInvocation.v").read_text()
        for theorem in ("inactive_service_preserves_legacy", "dispatcher_never_supplies_a_witness",
                        "registered_proxy_requires_frame", "registered_proxy_requires_legacy_witness",
                        "unregistered_nonservice_preserves_legacy"):
            self.assertIn(theorem, model)
        for mutation in ("service-witness-gate", "service-witness-identity", "service-proxy-frame",
                         "service-proxy-legacy", "service-unregistered-legacy"):
            self.assertIn(mutation, verify.NATIVE_INVOCATION_COQ_MUTATIONS)

    def test_witness_rule_model_is_registered(self):
        model = (verify.ROOT / "coq" / "WitnessRuleSemantics.v").read_text()
        self.assertIn("first_matching_rule_decides", model)
        self.assertIn("default_deny", model)
        self.assertIn("deny_precedes_later_allow", model)
        self.assertIn("witness-called-by-entry-depth", verify.WITNESS_RULE_COQ_MUTATIONS)

    def test_witness_fault_semantics_have_general_correspondence_proofs(self):
        model = (verify.ROOT / "coq" / "WitnessRuleFaultSemantics.v").read_text()
        for theorem in ("readable_group_condition_refines_boolean",
                        "readable_called_group_condition_refines_boolean",
                        "faulting_rule_prevents_later_allow",
                        "negation_preserves_fault"):
            self.assertIn(theorem, model)
        for mutant in ("witness-group-permission", "witness-caller-group-permission",
                       "witness-negation-fault", "witness-rule-fault",
                       "witness-and-short-circuit", "witness-or-short-circuit"):
            self.assertIn(mutant, verify.WITNESS_RULE_FAULT_COQ_MUTATIONS)

    def test_bounded_neo_vm_call_model_is_registered(self):
        model = (verify.ROOT / "coq" / "NeoVmCallSubset.v").read_text()
        self.assertIn("NVM_001_canonical_program_is_accepted", model)
        self.assertIn("NVM_004_trailing_instruction_is_rejected", model)
        self.assertIn("neo-vm-safe-prefix", verify.NEO_VM_CALL_SUBSET_COQ_MUTATIONS)

    def test_signer_independence_countermodel_is_registered(self):
        model = (verify.ROOT / "coq" / "SignerIndependence.v").read_text()
        self.assertIn("SID_001_domain_uniqueness_does_not_imply_key_independence", model)
        self.assertIn("signer-domain-uniqueness", verify.SIGNER_INDEPENDENCE_COQ_MUTATIONS)

    def test_future_plugin_cleanup_countermodel_is_registered(self):
        model = (verify.ROOT / "coq" / "PluginLifecycle.v").read_text()
        self.assertIn("PL_001_lifecycle_abi_does_not_imply_cleanup_completeness", model)
        self.assertIn("PL_002_certified_clear_is_complete", model)
        self.assertIn("plugin-admission", verify.PLUGIN_LIFECYCLE_COQ_MUTATIONS)

    def test_signer_domain_binding_model_is_registered(self):
        model = (verify.ROOT / "coq" / "SignerDomainSeparation.v").read_text()
        self.assertIn("signature_match_binds_domain_and_payload", model)
        self.assertIn("cross_domain_replay_is_rejected", model)
        self.assertIn("signer-domain-binding", verify.SIGNER_DOMAIN_SEPARATION_COQ_MUTATIONS)

    def test_abi_manifest_projection_model_is_registered(self):
        model = (verify.ROOT / "coq" / "AbiManifestProjection.v").read_text()
        for theorem in ("projected_descriptor_preserves_signature",
                        "abi_projection_rejects_missing_initializer",
                        "abi_projection_rejects_duplicate_dispatch_key",
                        "abi_projection_rejects_missing_source_method",
                        "abi_projection_rejects_extra_manifest_method"):
            self.assertIn(theorem, model)
        for mutation in ("abi-requires-initializer", "abi-requires-unique-dispatch-keys",
                         "abi-requires-every-manifest-method", "abi-requires-safe-flag-equality"):
            self.assertIn(mutation, verify.ABI_MANIFEST_PROJECTION_COQ_MUTATIONS)

    def test_neo_vm_continuation_model_is_registered(self):
        model = (verify.ROOT / "coq" / "NeoVmContinuationSemantics.v").read_text()
        for theorem in ("oversized_callback_is_rejected",
                        "load_script_inherits_budget_and_continuation",
                        "callt_ret_returns_to_saved_continuation",
                        "initialization_is_per_load_context",
                        "callback_hardfork_gate_is_fail_closed",
                        "rollback_restores_storage_but_preserves_consumed_budget"):
            self.assertIn(theorem, model)
        for mutation in ("neo-vm-child-budget-bound", "neo-vm-hardfork-gate",
                         "neo-vm-loadscript-continuation", "neo-vm-callt-return-address",
                         "neo-vm-rollback-storage", "neo-vm-ancestor-charge"):
            self.assertIn(mutation, verify.NEO_VM_CONTINUATION_COQ_MUTATIONS)

    def test_witness_fault_model_is_registered(self):
        model = (verify.ROOT / "coq" / "WitnessRuleFaultSemantics.v").read_text()
        for theorem in ("readable_group_condition_refines_boolean",
                        "readable_called_group_condition_refines_boolean",
                        "negation_preserves_fault", "and_short_circuits_false",
                        "or_short_circuits_true", "faulting_rule_prevents_later_allow"):
            self.assertIn(theorem, model)
        for mutation in ("witness-group-permission", "witness-caller-group-permission",
                         "witness-negation-fault", "witness-and-short-circuit",
                         "witness-or-short-circuit", "witness-rule-fault"):
            self.assertIn(mutation, verify.WITNESS_RULE_FAULT_COQ_MUTATIONS)

    def test_witness_rule_refinement_model_is_registered(self):
        model = (verify.ROOT / "coq" / "WitnessRuleRefinement.v").read_text()
        for theorem in ("readable_walker_refines_boolean",
                        "readable_condition_tree_has_no_spurious_fault",
                        "readable_rule_list_has_no_spurious_fault"):
            self.assertIn(theorem, model)
        for mutation in ("witness-refinement-readstates", "witness-refinement-not-fault",
                         "witness-refinement-and-short-circuit",
                         "witness-refinement-or-short-circuit",
                         "witness-refinement-rule-action"):
            self.assertIn(mutation, verify.WITNESS_RULE_REFINEMENT_COQ_MUTATIONS)

    def test_parser_bounded_refinement_needs_no_external_fuel_certificate(self):
        model = (verify.ROOT / "coq" / "WitnessRuleRefinement.v").read_text()
        for theorem in ("parser_readable_condition_refines_boolean",
                        "parser_readable_rules_refine_boolean",
                        "parser_rejects_empty_compound",
                        "parser_rejects_seventeen_children",
                        "parser_rejects_fourth_level",
                        "parser_accepts_full_width_depth_three",
                        "full_width_rule_list_refines"):
            self.assertIn(theorem, verify.coq_declarations(model))
        for mutation in ("witness-parser-width", "witness-parser-nonempty",
                         "witness-parser-depth", "witness-parser-rule-depth",
                         "witness-fuel-bound"):
            self.assertIn(mutation, verify.WITNESS_RULE_REFINEMENT_COQ_MUTATIONS)

    def test_witness_parser_models_have_identical_shape_predicates(self):
        boolean = (verify.ROOT / "coq" / "WitnessRuleSemantics.v").read_text()
        refinement = (verify.ROOT / "coq" / "WitnessRuleRefinement.v").read_text()
        def predicate(source, name):
            matched = re.search(r"Fixpoint " + name + r"\b.*?\n  end\.", source, re.S)
            self.assertIsNotNone(matched)
            return re.sub(r"\s+", " ", matched.group(0).replace(name, "predicate"))
        self.assertEqual(predicate(boolean, "condition_well_formed"),
                         predicate(refinement, "parser_condition_admissible"))

    def test_native_dispatch_model_is_registered(self):
        model = (verify.ROOT / "coq" / "NativeDispatch.v").read_text()
        for theorem in ("missing_activation_is_disabled", "future_activation_is_disabled",
                        "no_block_uses_ledger_height", "mismatched_caller_is_rejected",
                        "dispatch_uses_native_caller_fee_policy", "return_keeps_child_fee_policy"):
            self.assertIn(theorem, verify.coq_declarations(model))
        self.assertIn("coq/NativeDispatch.v", verify.ARTIFACTS)
        self.assertIs(verify.COQ_MODULES["NativeDispatch.v"], verify.NATIVE_DISPATCH_COQ_MUTATIONS)
        self.assertEqual(7, len(verify.NATIVE_DISPATCH_COQ_MUTATIONS))

    def test_native_invocation_model_is_registered(self):
        model = (verify.ROOT / "coq" / "NativeInvocation.v").read_text()
        for theorem in ("wrong_account_is_rejected", "wrong_phase_is_rejected",
                        "same_hash_new_frame_is_not_root_authority", "grandchild_is_rejected",
                        "target_does_not_authorize_modules", "fault_clears_all_authority",
                        "configuration_does_not_delegate", "witness_needs_original_witness"):
            self.assertIn(theorem, verify.coq_declarations(model))
        self.assertIn("coq/NativeInvocation.v", verify.ARTIFACTS)
        self.assertIs(verify.COQ_MODULES["NativeInvocation.v"], verify.NATIVE_INVOCATION_COQ_MUTATIONS)
        self.assertEqual(15, len(verify.NATIVE_INVOCATION_COQ_MUTATIONS))
        for theorem in ("module_rejects_wrong_service", "module_requires_context", "module_matching_context_is_reachable"):
            self.assertIn(theorem, verify.coq_declarations(model))
        self.assertIn("contracts/native/NativeAuthority.cs", verify.SOURCE_FILES)

    def test_native_session_policy_is_registered(self):
        self.assertIn("coq/NativeSessionPolicy.v", verify.ARTIFACTS)
        model=(verify.ROOT / "coq/NativeSessionPolicy.v").read_text()
        for theorem in ("session_requires_context", "session_requires_signature", "session_requires_scope",
                        "session_requires_liveness", "session_requires_transfer_shape", "session_within_cap",
                        "false_target_preserves_spent", "session_fault_preserves_spent", "session_success_debits_exactly",
                        "session_success_stays_within_cap", "valid_session_is_reachable",
                        "verification_clock_uses_ledger", "missing_ledger_rejects_verification",
                        "application_clock_uses_persisting_block"):
            self.assertIn(theorem, verify.coq_declarations(model))
        self.assertEqual(19,len(verify.COQ_MODULES["NativeSessionPolicy.v"]))
        self.assertIn("contracts/verifiers/SessionKeyVerifier.cs",verify.SOURCE_FILES)
        self.assertIn("contracts/verifiers/VerifierClock.cs",verify.SOURCE_FILES)

    def test_native_session_lifecycle_and_zero_cap_are_registered(self):
        model=(verify.ROOT / "coq/NativeSessionPolicy.v").read_text()
        for theorem in ("rotation_preserves_spent", "rotation_sets_timestamp",
                        "rotation_before_cooldown_rejects", "first_grant_is_reachable",
                        "revoke_clears_key_and_spent", "revoke_retains_rotation",
                        "cleanup_removes_rotation", "lowered_cap_rejects_zero", "zero_at_cap_is_reachable"):
            self.assertIn(theorem, verify.coq_declarations(model))
        for mutation in ("session-rotation-reset-spent", "session-rotation-timestamp", "session-rotation-cooldown",
                         "session-revocation-key", "session-revocation-spent", "session-revocation-cooldown",
                         "session-cleanup-cooldown", "session-zero-cap-bypass"):
            self.assertIn(mutation,verify.NATIVE_SESSION_COQ_MUTATIONS)

    def test_native_lifecycle_model_is_registered(self):
        model = (verify.ROOT / "coq" / "NativeLifecycle.v").read_text()
        for theorem in ("pending_recovery_blocks_configuration", "frozen_blocks_configuration",
                        "joint_unfreeze_requires_recovery", "custody_cannot_cancel_at_maturity",
                        "advance_clears_all_intents", "advance_increments_exactly_once",
                        "exhausted_epoch_is_rejected"):
            self.assertIn(theorem, verify.coq_declarations(model))
        self.assertIn("coq/NativeLifecycle.v", verify.ARTIFACTS)
        self.assertIs(verify.COQ_MODULES["NativeLifecycle.v"], verify.NATIVE_LIFECYCLE_COQ_MUTATIONS)
        self.assertEqual(12, len(verify.NATIVE_LIFECYCLE_COQ_MUTATIONS))

    def test_configuration_postcondition_checks_both_bindings_and_rollback(self):
        model = (verify.ROOT / "coq" / "NativeLifecycle.v").read_text()
        for theorem in ("configuration_missing_root_rolls_back", "configuration_missing_child_rolls_back",
                        "configuration_changed_root_rolls_back", "configuration_changed_child_rolls_back",
                        "configuration_success_preserves_pins", "configuration_failure_keeps_entire_snapshot",
                        "configuration_matching_pins_commits", "selected_only_check_is_insufficient"):
            self.assertIn(theorem, verify.coq_declarations(model))

    def test_native_integer_domain_is_registered_with_semantic_mutations(self):
        module = "NativeIntegerDomain.v"
        self.assertIn(module, verify.COQ_MODULES)
        model = (verify.ROOT / "coq" / module).read_text()
        for theorem in ("admissible_nonce_fits_vm_integer",
                        "unsigned_upper_half_cannot_fit_vm_integer",
                        "decomposition_has_representable_channel",
                        "composition_stays_representable",
                        "channel_key_high_bit_is_clear",
                        "final_sequence_exhausts_without_wrap",
                        "exhausted_cursor_rejects_every_nonce"):
            self.assertIn(theorem, verify.coq_declarations(model))
        for mutation in ("native-integer-upper-bound", "native-channel-width",
                         "native-nonce-consumption", "native-nonce-exhaustion"):
            self.assertIn(mutation, verify.COQ_MODULES[module])

    def test_native_batch_shadow_cursor_proofs_are_registered(self):
        model = (verify.ROOT / "coq" / "NativeIntegerDomain.v").read_text()
        for theorem in ("consume_success_requires_exact_sequence",
                        "shadow_batch_preserves_unmentioned_channel",
                        "shadow_batch_rejects_immediate_replay",
                        "shadow_batch_accepts_sequential_nonces",
                        "shadow_batch_rejects_sequence_gap",
                        "shadow_batch_exhaustion_does_not_wrap"):
            self.assertIn(theorem, verify.coq_declarations(model))
        for mutation in ("native-batch-shadow-update", "native-batch-cross-channel",
                         "native-batch-failure-acceptance"):
            self.assertIn(mutation, verify.COQ_MODULES["NativeIntegerDomain.v"])

    def test_smt_exact_verdicts(self):
        source = '(echo "OBL:one")\n(echo "CTRL:one")'
        output = "OBL:one\nunsat\nCTRL:one\nsat\nDONE:aa_core"
        self.assertEqual({"obligations": 1, "controls": 1}, verify.parse_smt(source, output, 0))
        for bad in [output.replace("unsat", "unknown"), output.replace("unsat", "sat"),
                    output.replace("CTRL:one\nsat\n", ""), output + "\nsat",
                    output.replace("DONE:aa_core", "")]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                verify.parse_smt(source, bad, 0)
        with self.assertRaises(ValueError):
            verify.parse_smt(source, output, 1)

    def test_smt_duplicate_labels(self):
        with self.assertRaises(ValueError):
            verify.parse_smt('(echo "OBL:one")\n(echo "OBL:one")', "", 0)

    def test_coq_audit_requires_names_not_just_counts(self):
        with self.assertRaises(ValueError):
            verify.coq_declarations("Theorem one : 1 = 1. Proof. reflexivity. Qed. Print Assumptions two.")

    def test_coq_gap_marker(self):
        with self.assertRaises(ValueError):
            verify.coq_declarations("Theorem one : 1 = 1. Admitted. Print Assumptions one.")

    def test_nested_comments(self):
        source = "(* (* Admitted *) *) Lemma one : 1 = 1. Proof. reflexivity. Qed. Print Assumptions one."
        self.assertEqual(["one"], verify.coq_declarations(source))

    def test_all_coq_mutations_are_unique_and_change_definitions(self):
        # Every mutation must land in the definitions prefix that the gate
        # compiles on its own; one that landed in a proof body would make the
        # "invalid mutation" guard pass without ever compiling the mutant.
        for module, mutations in verify.COQ_MODULES.items():
            source = (verify.ROOT / "coq" / module).read_text()
            prefix = re.split(
                r"^(?:Lemma|Theorem|Corollary|Proposition|Fact|Example|Remark) ",
                source, maxsplit=1, flags=re.M)[0]
            for name, (old, new) in mutations.items():
                with self.subTest(module=module, name=name):
                    self.assertNotEqual(source, verify.replace_once(source, old, new))
                    self.assertIn(old, prefix)

    def test_multisig_bounded_model_and_source_mutations(self):
        result = verify.check_multisig_bounded()
        self.assertEqual(6, result["sourceGuards"])
        self.assertEqual(6, len(result["sourceMutationsRejected"]))
        self.assertGreater(result["configCases"], 100)
        self.assertGreater(result["acceptanceCases"], 10_000)

    def test_multisig_model_rejects_duplicate_zero_and_oversized_sets(self):
        self.assertFalse(verify.multisig_config_valid([1, 1], 1))
        self.assertFalse(verify.multisig_config_valid([0, 1], 1))
        self.assertFalse(verify.multisig_config_valid(list(range(1, 12)), 1))
        self.assertTrue(verify.multisig_config_valid([1, 2, 3], 2))

    def test_missing_or_duplicate_mutation_match_fails(self):
        for source in ["", "aa"]:
            with self.assertRaises(ValueError):
                verify.replace_once(source, "a", "b")

    def test_source_drift_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)
            formal = repo / "formal"
            formal.mkdir()
            for name in verify.ARTIFACTS | {"source-lock.json"}:
                (formal / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(verify.ROOT / name, formal / name)
            for name in verify.SOURCE_FILES:
                (repo / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(verify.ROOT.parent / name, repo / name)
            verify.check_inventory(formal)
            (repo / "contracts/UnifiedSmartWallet.Execution.cs").write_text("// drift\n")
            with self.assertRaisesRegex(ValueError, "Source drift"):
                verify.check_inventory(formal)

    def write_fake_java(self, directory, name, exit_code, message):
        launcher = Path(directory) / name
        launcher.write_text(f"#!/bin/sh\necho '{message}' 1>&2\nexit {exit_code}\n")
        launcher.chmod(0o755)
        return str(launcher)

    def test_java_resolver_skips_stub_launcher_and_uses_working_runtime(self):
        with tempfile.TemporaryDirectory() as temp:
            stub = self.write_fake_java(temp, "java-stub", 1, "Unable to locate a Java Runtime.")
            real = self.write_fake_java(temp, "java-real", 0, 'openjdk version "21.0.2" 2024-01-16')
            logs = Path(temp) / "logs"
            logs.mkdir()
            path, version = verify.resolve_java([stub, real], logs)
            self.assertEqual(real, path)
            self.assertIn("openjdk version", version)

    def test_java_resolver_fails_closed_when_no_candidate_works(self):
        with tempfile.TemporaryDirectory() as temp:
            stub = self.write_fake_java(temp, "java-stub", 1, "Unable to locate a Java Runtime.")
            logs = Path(temp) / "logs"
            logs.mkdir()
            with self.assertRaisesRegex(ValueError, "No working Java runtime"):
                verify.resolve_java([stub, str(Path(temp) / "absent-java")], logs)

    def test_explicit_java_bin_is_the_only_candidate(self):
        # A reviewer who names a runtime must not be silently redirected to another one.
        self.assertEqual(["/explicit/java"], verify.java_candidates({"JAVA_BIN": "/explicit/java"}, "darwin"))
        candidates = verify.java_candidates({"JAVA_HOME": "/jdk"}, "linux")
        self.assertEqual(["/jdk/bin/java", "java"], candidates)
        self.assertEqual(["java"], verify.java_candidates({}, "linux"))

    def test_missing_tool_invalidates_previous_success(self):
        with tempfile.TemporaryDirectory() as output:
            result = Path(output) / "result.json"
            result.write_text('{"modelChecksPassed": true}')
            env = {**os.environ, "COQC": "/nonexistent-aa-formal/coqc"}
            process = subprocess.run([sys.executable, str(verify.ROOT / "verify.py"), "--output", output],
                                     env=env, capture_output=True, text=True, timeout=20)
            self.assertNotEqual(0, process.returncode)
            self.assertFalse(json.loads(result.read_text())["modelChecksPassed"])
            self.assertIn("Missing required tool", process.stderr)


if __name__ == "__main__":
    unittest.main()
