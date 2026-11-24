"""Tests of the gate, not formal proof evidence. Run with unittest discovery."""
import copy
import hashlib
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
    def test_duplicate_cross_model_mutation_names_have_distinct_evidence_paths(self):
        labels = [verify.coq_mutation_label(module, mutation)
                  for module, mutations in verify.COQ_MODULES.items() for mutation in mutations]
        self.assertEqual(len(labels), len(set(labels)))
        self.assertNotEqual(verify.coq_mutation_label('NativeAuthorityEpoch.v', 'recovery-retains-verifier'),
                            verify.coq_mutation_label('CustomRecovery.v', 'recovery-retains-verifier'))

    def test_archived_custom_receipt_is_tracked_and_source_bound(self):
        # c7fd0a1 archived these bytes; 9f6819c renamed the file without changing it.
        # These assertions validate the October archive, not the current native kernel.
        receipt_path = verify.ROOT.parent / 'docs/reports/sa-formal-gate-20261031.json'
        self.assertTrue(receipt_path.exists())
        self.assertEqual(
            '0e4d67450a326c318f971ddd7c31c6c5383fe097d5aa9a33ef48b2e814088198',
            hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
        )
        receipt = json.loads(receipt_path.read_text())
        self.assertTrue(receipt['modelChecksPassed'])
        self.assertFalse(receipt['implementationVerified'])
        self.assertIn('coq/OrdinaryGovernance.v', receipt['modelProfiles'])
        self.assertEqual(['v3', 'platform'], receipt['modelProfiles']['coq/OrdinaryGovernance.v'])
        self.assertEqual(29, len(receipt['coqDeclarations']))
        self.assertEqual(554, sum(receipt['coqDeclarations'].values()))
        self.assertEqual(311, sum(len(names) for names in receipt['coqMutationsRejected'].values()))
        self.assertEqual(4, len(receipt['tlcMutationsRejected']))
        self.assertEqual(61460, receipt['tlc']['distinct'])
        self.assertEqual(7, receipt['smt']['obligations'])
        self.assertEqual(7, receipt['smt']['controls'])
        self.assertEqual(311, len(receipt['nativeCoreSourceSha256']))

    def test_native_composite_phase_model_is_registered(self):
        self.assertIn('coq/NativeCompositePhase.v', verify.ARTIFACTS)
        model = (verify.ROOT / 'coq/NativeCompositePhase.v').read_text()
        for name in ('selection_preserves_membership', 'selection_preserves_uniqueness',
                     'selection_has_exact_threshold', 'post_requires_application_operation',
                     'local_receipt_requires_fresh_application_validation',
                     'post_requires_current_policy', 'post_requires_all_active_pins',
                     'post_plan_checks_even_unapproved_pins',
                     'completion_rechecks_policy', 'verification_receipt_is_discarded',
                     'operation_completion_discards_receipt', 'valid_receipt_completes'):
            self.assertIn(name, verify.coq_declarations(model))
        self.assertGreaterEqual(len(verify.COQ_MODULES['NativeCompositePhase.v']), 20)
        self.assertEqual(['public', 'platform'], verify.MODEL_PROFILES['coq/MultiSigPolicy.v'])
        self.assertEqual(['native'], verify.MODEL_PROFILES['coq/NativeCompositePhase.v'])

    def test_native_composite_bounds_and_receipt_lifetime(self):
        result = verify.check_native_composite_bounded()
        self.assertEqual({'children': 3, 'threshold': 2, 'approved': 2, 'domains': 3}, result['caps'])
        self.assertGreater(result['selectionCases'], 100)
        self.assertGreater(result['validationCases'], 1000)
        self.assertEqual(32, result['allActivePinCases'])
        self.assertGreater(result['receiptCases'], 1000)
        self.assertEqual('oneApplicationOperation', result['lifetime'])

    def test_native_composite_post_checks_unapproved_children(self):
        active = [1, 2, 3]
        self.assertEqual([1, 2], verify.native_composite_post_plan([1, 2], active, 2, 3,
                                                                {1: True, 2: True, 3: True}))
        self.assertEqual([], verify.native_composite_post_plan([1, 2], active, 2, 3,
                                                             {1: True, 2: True, 3: False}))
        for reply in ('false', 'nonboolean', 'rejected'):
            self.assertEqual([2], verify.native_composite_selection([1, 2], 1, [reply, 'true']))

    def test_native_composite_profile_drift_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            relative = Path('docs/archive/native-research/smartaccount-native-profile-v2-parameters.json')
            destination = root / relative
            destination.parent.mkdir(parents=True)
            profile = json.loads((verify.ROOT.parent / relative).read_text())
            for field, value in (('compositeVerifierMaxChildren', 10),
                                 ('compositeVerifierMaxThreshold', 3),
                                 ('compositeVerifierMaxApprovedChildren', 3),
                                 ('compositeVerifierMaxSignerDomains', 4)):
                changed = copy.deepcopy(profile); changed[field] = value
                destination.write_text(json.dumps(changed))
                with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'Native composite profile'):
                    verify.check_native_composite_bounded(root)
            for section, field, value in (('compositeReceipt', 'verificationReceiptReused', True),
                                          ('compositeReceipt', 'version', True),
                                          ('compositeReceipt', 'selection', 'allValidChildren')):
                changed = copy.deepcopy(profile); changed[section][field] = value
                destination.write_text(json.dumps(changed))
                with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'Native composite profile'):
                    verify.check_native_composite_bounded(root)
            profile['compositeVerifierCallbacks']['validation']['safe'] = 0
            destination.write_text(json.dumps(profile))
            with self.assertRaisesRegex(ValueError, 'Native composite profile'):
                verify.check_native_composite_bounded(root)

    def test_native_restricted_policy_is_registered_and_fail_closed(self):
        self.assertIn('coq/NativeRestrictedPolicy.v', verify.ARTIFACTS)
        model=(verify.ROOT/'coq/NativeRestrictedPolicy.v').read_text()
        for name in ('missing_snapshot_rejects', 'invalid_query_rejects',
                     'outflow_rejects', 'inflow_allowed', 'direct_target_rejects',
                     'every_restriction_must_hold', 'false_result_does_not_bypass',
                     'removal_preserves_other_tokens', 'cleanup_clears_both_prefixes'):
            self.assertIn(name, verify.coq_declarations(model))
        self.assertIn('contracts/plugins/hooks/TokenRestrictedHook.cs', verify.SOURCE_FILES)
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
        self.assertIn('contracts/plugins/hooks/DailyLimitHook.cs',verify.SOURCE_FILES)
        self.assertEqual(15,len(verify.COQ_MODULES['NativeDailyPolicy.v']))

    def test_budget_model_is_bounded_profiles_only(self):
        profiles = verify.MODEL_PROFILES
        self.assertEqual(["platform", "native"], profiles["coq/VerifierGasBudget.v"])
        self.assertEqual(verify.ARTIFACTS, set(profiles))
        self.assertFalse(verify.RUNTIME_PROFILES["public"]["verifierChildBudgetEnforced"])
        self.assertTrue(verify.RUNTIME_PROFILES["platform"]["verifierChildBudgetEnforced"])

    def test_native_scope_and_authority_model_are_explicit(self):
        self.assertTrue(verify.RUNTIME_PROFILES["native"]["verifierChildBudgetEnforced"])
        self.assertEqual(["native"], verify.MODEL_PROFILES["coq/NativeAuthorityEpoch.v"])
        self.assertEqual(["native"], verify.MODEL_PROFILES["coq/CallbackPluginTopology.v"])
        self.assertEqual(["public", "platform"], verify.MODEL_PROFILES["coq/ProxyWitnessScript.v"])
        self.assertEqual(22, len(verify.COQ_MODULES["NativeAuthorityEpoch.v"]))
        # Legacy escape-owner and uint256/paymaster models are not native ABI 2 semantics.
        for model in ("coq/SmartAccountSA.v", "tla/SmartAccountSA.tla", "smt/sa_core.smt2"):
            self.assertNotIn("native", verify.MODEL_PROFILES[model])
        self.assertEqual(["native"], verify.MODEL_PROFILES["coq/NativeIntegerDomain.v"])
        self.assertEqual(["native"], verify.MODEL_PROFILES["coq/PluginLifecycle.v"])

    def test_custom_governance_model_is_registered_and_scoped(self):
        self.assertIn('coq/CustomGovernance.v', verify.ARTIFACTS)
        model = (verify.ROOT / 'coq' / 'CustomGovernance.v').read_text()
        for theorem in (
            'OG_001_proposal_requires_current_registrar_and_valid_owner',
            'OG_002_duplicate_pending_proposal_is_rejected',
            'OG_003_confirm_requires_delay_and_new_owner_witness',
            'OG_004_confirm_before_delay_preserves_state',
            'OG_005_cancel_requires_registrar_or_current_owner',
            'OG_006_unauthorized_cancel_preserves_state',
            'OG_007_boundary_clears_pending_rotation',
            'OG_011_successful_confirmation_clears_pending_and_sets_owner',
            'OG_012_successful_proposal_records_pending_owner_and_time',
            'OG_013_successful_confirmation_requires_current_registrar',
            'OG_014_successful_proposal_requires_no_escape_or_escrow',
            'OG_015_owner_witness_is_independent_of_caller',
            'OG_016_owner_can_cancel_through_another_caller',
            'OG_017_owner_authorization_requires_witness',
            'OG_018_delay_is_seven_days_in_milliseconds'):
            self.assertIn(theorem, verify.coq_declarations(model))
        self.assertEqual(['public', 'platform'], verify.MODEL_PROFILES['coq/CustomGovernance.v'])
        # Archived model: registered and scoped as compile-and-mutation evidence
        # only; the custom kernel it modelled was retired in Phase 3, so it no
        # longer claims any live source link.
        self.assertEqual(14, len(verify.COQ_MODULES['CustomGovernance.v']))

    def test_source_roster_is_native_only_and_pinned(self):
        self.assertFalse([path for path in verify.SOURCE_FILES if 'custom' in path])
        self.assertIn('contracts/native/SmartAccount/SmartAccount.Modules.cs', verify.SOURCE_FILES)
        for path in verify.SOURCE_FILES:
            self.assertTrue((verify.ROOT.parent / path).is_file(), path)
        lock = json.loads((verify.ROOT / 'source-lock.json').read_text())
        self.assertEqual(set(lock['sources']), verify.SOURCE_FILES)
        verify.check_inventory()

    def test_native_threshold_policy_guards_are_retired(self):
        # Threshold policy ownership moved to the user-space ThresholdPolicyModule,
        # so the native-side correspondence guards and their bounded config/acceptance
        # model retired from the gate. None of those symbols may linger.
        for name in ('THRESHOLD_POLICY_GUARDS', 'THRESHOLD_POLICY_MUTATIONS',
                     'THRESHOLD_POLICY_CONFIG_SOURCE', 'THRESHOLD_POLICY_ROUTING_SOURCE',
                     'THRESHOLD_POLICY_BOUNDS_SOURCE', 'check_multisig_bounded',
                     'threshold_policy_bounds', 'multisig_config_valid', 'multisig_accepts'):
            self.assertFalse(hasattr(verify, name), name)
        # The abstract public/platform MultiSigPolicy.v Coq model stays registered as
        # compile-and-mutation evidence; only the native source link retired.
        self.assertIn('coq/MultiSigPolicy.v', verify.ARTIFACTS)
        self.assertEqual(['public', 'platform'], verify.MODEL_PROFILES['coq/MultiSigPolicy.v'])
        self.assertIn('MultiSigPolicy.v', verify.COQ_MODULES)

    def test_custom_sponsorship_is_transaction_wide_and_scoped(self):
        self.assertEqual(['public', 'platform'], verify.MODEL_PROFILES['coq/CustomSponsorship.v'])
        model = (verify.ROOT / 'coq/CustomSponsorship.v').read_text()
        for name in ('OS_001_same_transaction_retains_spend', 'OS_002_new_transaction_starts_at_zero',
                     'OS_005_success_preserves_transaction_and_total_cap',
                     'OS_007_multiple_calls_share_one_total_fee_cap', 'OS_008_exhausted_fee_rejects',
                     'OS_009_failed_reservation_preserves_ledger', 'OS_010_failed_settlement_rolls_back_ledger',
                     'OS_014_estimation_is_not_a_persisted_fee_bound',
                     'OS_015_branch_free_cap_matches_abstract_charge'):
            self.assertIn(name, verify.coq_declarations(model))
        self.assertEqual(10, len(verify.COQ_MODULES['CustomSponsorship.v']))

    def test_custom_recovery_is_callback_free_and_irreversible(self):
        self.assertEqual(['public', 'platform'], verify.MODEL_PROFILES['coq/CustomRecovery.v'])
        model = (verify.ROOT / 'coq/CustomRecovery.v').read_text()
        for name in ('OR_001_recovery_does_not_depend_on_old_plugin',
                     'OR_002_recovery_requires_authority_and_safe_boundary',
                     'OR_003_success_detaches_all_authority', 'OR_004_success_preserves_identity_and_nonce',
                     'OR_005_failed_recovery_preserves_entire_projection',
                     'OR_006_latched_account_rejects_nonzero_roots',
                     'OR_007_configuration_never_clears_latch',
                     'OR_008_successful_latched_configuration_has_no_roots',
                     'OR_009_broken_old_plugin_does_not_block_recovery'):
            self.assertIn(name, verify.coq_declarations(model))
        self.assertEqual(16, len(verify.COQ_MODULES['CustomRecovery.v']))

    def test_native_core_provenance_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            core = Path(directory)
            for name in verify.NATIVE_CORE_REQUIRED_FILES:
                path = core / name; path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("// reviewed fixture\n")
            pins = verify.native_core_hashes(core)
            lock = {"nativeCoreSources": pins}
            verify.check_native_core_sources(lock, core)
            with self.assertRaisesRegex(ValueError, "native-core-root"):
                verify.check_native_core_sources(lock, None)
            changed = core / next(iter(verify.NATIVE_CORE_REQUIRED_FILES))
            changed.write_text("// drift\n")
            with self.assertRaisesRegex(ValueError, "Native core source drift"):
                verify.check_native_core_sources(lock, core)
            lock["nativeCoreSources"] = verify.native_core_hashes(core)
            added = core / "src/Neo/Unreviewed.cs"; added.write_text("// new file\n")
            with self.assertRaisesRegex(ValueError, "Native core source roster"):
                verify.check_native_core_sources(lock, core)
            added.unlink(); changed.unlink()
            with self.assertRaisesRegex(ValueError, "Native core source missing"):
                verify.check_native_core_sources(lock, core)

    def test_source_lock_may_not_claim_public_child_budget(self):
        lock = {"runtimeProfiles": copy.deepcopy(verify.RUNTIME_PROFILES), "modelProfiles": copy.deepcopy(verify.MODEL_PROFILES)}
        verify.check_profile_scope(lock)
        lock["modelProfiles"]["coq/VerifierGasBudget.v"].append("public")
        with self.assertRaisesRegex(ValueError, "Model profile scope"):
            verify.check_profile_scope(lock)

    def test_source_lock_may_not_change_runtime_capability(self):
        lock = {"runtimeProfiles": copy.deepcopy(verify.RUNTIME_PROFILES), "modelProfiles": copy.deepcopy(verify.MODEL_PROFILES)}
        lock["runtimeProfiles"]["public"]["verifierChildBudgetEnforced"] = True
        with self.assertRaisesRegex(ValueError, "Runtime profile scope"):
            verify.check_profile_scope(lock)

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

    def test_legacy_execution_model_scopes_optional_callbacks(self):
        model = (verify.ROOT / "coq" / "SmartAccountSA.v").read_text()
        declarations = verify.coq_declarations(model)
        self.assertIn("SA_020_disabled_callbacks_do_not_gate_execution", declarations)
        self.assertIn("pre_callback_valid", model)
        self.assertIn("post_callback_valid", model)
        self.assertIn("hookInstalled s || verifierConfigured s", model)

    def test_callback_model_includes_dependency_registry_atomicity(self):
        model = (verify.ROOT / "coq" / "CallbackPluginTopology.v").read_text()
        self.assertIn("CPT_014_dependency_replacement_requires_cleanup", model)
        self.assertIn("CPT_015_failed_dependency_replacement_is_atomic", model)
        self.assertIn("CPT_016_successful_dependency_replacement_has_no_removed_child", model)
        self.assertIn("CPT_017_composite_children_are_leaves", model)
        self.assertIn("CPT_018_disabled_callbacks_omit_phases", model)
        self.assertIn("CPT_019_configured_callbacks_match_full_trace", model)
        for theorem in ("CPT_020_absent_hook_results_are_irrelevant",
                        "CPT_021_absent_verifier_result_is_irrelevant",
                        "CPT_022_configured_trace_exact_acceptance"):
            self.assertIn(theorem, verify.coq_declarations(model))
        for mutation in ("callback-absent-hook-result", "callback-absent-hook-post-result",
                         "callback-absent-verifier-result", "callback-installed-hook-result",
                         "callback-installed-hook-post-result", "callback-installed-verifier-result"):
            self.assertIn(mutation, verify.CALLBACK_PLUGIN_COQ_MUTATIONS)

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
        ledger = json.loads((verify.ROOT.parent / "docs/SA-NATIVE-OPEN-BOUNDARIES.json").read_text())
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
                        "abi_projection_rejects_extra_manifest_method",
                        "exact_projection_preserves_source_signatures",
                        "abi_projection_rejects_retyped_parameter",
                        "abi_projection_rejects_reordered_parameters",
                        "abi_projection_rejects_malformed_source_arity",
                        "abi_projection_rejects_malformed_manifest_arity",
                        "abi_projection_rejects_initializer_parameters"):
            self.assertIn(theorem, model)
        for mutation in ("abi-requires-initializer", "abi-requires-unique-dispatch-keys",
                         "abi-requires-every-manifest-method", "abi-requires-safe-flag-equality",
                         "abi-requires-ordered-parameter-types", "abi-requires-parameter-order",
                         "abi-requires-consistent-arities", "abi-requires-empty-initializer-parameters"):
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
                         "neo-vm-rollback-storage", "neo-vm-ancestor-charge",
                         "neo-vm-positive-child-budget", "neo-vm-ancestor-admission",
                         "neo-vm-step-ancestor-charge", "neo-vm-bounded-return-parent",
                         "neo-vm-bounded-return-ancestors", "neo-vm-atomic-chain-check"):
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
        self.assertEqual(22, len(verify.NATIVE_INVOCATION_COQ_MUTATIONS))
        for theorem in ("module_authorization_checks_all_layers", "invalid_role_phase_is_rejected",
                        "invalid_trigger_is_rejected", "verifier_preexecute_is_rejected",
                        "hook_validation_is_rejected", "unknown_role_is_rejected",
                        "unknown_phase_is_rejected", "verification_mutable_phase_is_rejected",
                        "other_triggers_are_rejected", "admitted_direct_root_is_reachable",
                        "every_legal_application_role_phase_is_reachable",
                        "verification_verifier_validation_is_reachable", "admitted_direct_leaf_is_reachable"):
            self.assertIn(theorem, verify.coq_declarations(model))
        for mutation in ("invocation-role-phase-admission", "invocation-trigger-admission",
                         "invocation-verifier-preexecute", "invocation-hook-validation",
                         "invocation-unknown-phase", "invocation-verification-mutable-phase",
                         "invocation-other-trigger"):
            self.assertIn(mutation, verify.NATIVE_INVOCATION_COQ_MUTATIONS)
        for theorem in ("module_rejects_wrong_service", "module_requires_context", "module_matching_context_is_reachable"):
            self.assertIn(theorem, verify.coq_declarations(model))
        self.assertIn("contracts/plugins/native-profile/NativeAuthority.cs", verify.SOURCE_FILES)

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
        self.assertIn("contracts/plugins/validators/SessionKeyValidator.cs",verify.SOURCE_FILES)
        self.assertIn("contracts/plugins/validators/ValidatorClock.cs",verify.SOURCE_FILES)

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
        self.assertEqual(17, len(verify.NATIVE_LIFECYCLE_COQ_MUTATIONS))

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
        output = "OBL:one\nunsat\nCTRL:one\nsat\nDONE:sa_core"
        self.assertEqual({"obligations": 1, "controls": 1}, verify.parse_smt(source, output, 0))
        for bad in [output.replace("unsat", "unknown"), output.replace("unsat", "sat"),
                    output.replace("CTRL:one\nsat\n", ""), output + "\nsat",
                    output.replace("DONE:sa_core", "")]:
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
            lock = {"schema": "sa-formal-source-lock/v2", "runtimeProfiles": verify.RUNTIME_PROFILES,
                    "modelProfiles": verify.MODEL_PROFILES,
                    "sources": {name: verify.content_digest(repo / name) for name in verify.SOURCE_FILES}}
            (formal / "source-lock.json").write_text(json.dumps(lock))
            verify.check_inventory(formal)
            (repo / "contracts/native/SmartAccount/SmartAccount.Execution.cs").write_text("// drift\n")
            with self.assertRaisesRegex(ValueError, "Source drift"):
                verify.check_inventory(formal)

    def write_fake_java(self, directory, name, exit_code, message):
        launcher = Path(directory) / name
        launcher.write_text(f"#!/bin/sh\necho '{message}' 1>&2\nexit {exit_code}\n")
        launcher.chmod(0o755)
        return str(launcher)

    @unittest.skipIf(os.name == "nt", "fake launchers are #!/bin/sh scripts, which Windows neither finds nor executes")
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
            env = {**os.environ, "COQC": "/nonexistent-sa-formal/coqc"}
            process = subprocess.run([sys.executable, str(verify.ROOT / "verify.py"), "--output", output],
                                     env=env, capture_output=True, text=True, timeout=20)
            self.assertNotEqual(0, process.returncode)
            self.assertFalse(json.loads(result.read_text())["modelChecksPassed"])
            self.assertIn("Missing required tool", process.stderr)


if __name__ == "__main__":
    unittest.main()
