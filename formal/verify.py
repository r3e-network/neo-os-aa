#!/usr/bin/env python3
"""Fail-closed, offline AA model checks; never substitutes tests for proofs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent
ARTIFACTS = {"coq/UnifiedSmartWalletAA.v", "coq/MultiSigPolicy.v",
             "coq/ProxyWitnessScript.v",
             "coq/CallbackPluginTopology.v", "coq/VerifierGasBudget.v",
             "coq/AuthorizationEvidence.v", "coq/WitnessRuleSemantics.v",
             "coq/NeoVmCallSubset.v", "coq/AttestationProofBinding.v",
             "coq/SignerIndependence.v", "coq/PluginLifecycle.v",
             "coq/WitnessRuleFaultSemantics.v", "coq/SignerDomainSeparation.v",
             "coq/AbiManifestProjection.v", "coq/NeoVmContinuationSemantics.v",
             "coq/WitnessRuleRefinement.v",
             "coq/NativeAuthorityEpoch.v", "coq/NativeIntegerDomain.v", "coq/NativeLifecycle.v", "coq/NativeDispatch.v", "coq/NativeInvocation.v",
             "coq/NativeSessionPolicy.v",
             "coq/NativeSessionScope.v",
             "coq/NativeDailyPolicy.v",
             "coq/NativeRestrictedPolicy.v", "coq/NativeCompositePhase.v",
             "tla/UnifiedSmartWalletAA.tla",
             "tla/UnifiedSmartWalletAA.cfg", "smt/aa_core.smt2"}
# Scope is part of the fail-closed source correspondence record. Successful
# abstract budget proofs must never be attributed to standard public Call.
RUNTIME_PROFILES = {
    "v3": {"artifactDirectory": "contracts/bin/v3", "define": None,
           "verifierCall": "System.Contract.Call", "verifierChildBudgetEnforced": False},
    "platform": {"artifactDirectory": "contracts/bin/platform", "define": "PLATFORM",
                 "verifierCall": "System.Contract.CallWithGasLimit", "verifierChildBudgetEnforced": True},
    "native": {"artifactDirectory": "explicit native build output", "define": "SMARTACCOUNT_NATIVE",
               "core": "AccountManagement", "abiVersion": 2, "identityVersion": 1,
               "verifierCall": "bounded native callback", "verifierChildBudgetEnforced": True,
               "verifierBudgetDatoshi": 100000000, "hookBudgetDatoshi": 250000000},
}
SHARED_MODELS = {"coq/MultiSigPolicy.v"}
PUBLIC_MODELS = {"coq/UnifiedSmartWalletAA.v", "coq/ProxyWitnessScript.v",
                 "tla/UnifiedSmartWalletAA.tla", "tla/UnifiedSmartWalletAA.cfg", "smt/aa_core.smt2"}
MODEL_PROFILES = {name: (["platform", "native"] if name == "coq/VerifierGasBudget.v" else
                         ["v3", "platform", "native"] if name in SHARED_MODELS else
                         ["v3", "platform"] if name in PUBLIC_MODELS else ["native"])
                  for name in sorted(ARTIFACTS)}
# The core checkout is external: no host path is committed or trusted as identity.
# Hash the full selected Neo source graph, not only AccountManagement partials.
NATIVE_CORE_REQUIRED_FILES = {
    "src/Neo/Neo.csproj", "src/Neo/Hardfork.cs", "src/Neo/ProtocolSettings.cs",
    "src/Neo/SmartContract/ApplicationEngine.cs", "src/Neo/SmartContract/ApplicationEngine.Contract.cs",
    "src/Neo/SmartContract/ApplicationEngine.Runtime.cs", "src/Neo/SmartContract/Native/NativeContract.cs",
    *{"src/Neo/SmartContract/Native/" + name for name in (
        "AccountManagement.cs", "AccountManagement.Execution.cs", "AccountManagement.Modules.cs",
        "SmartAccountProtocol.cs", "SmartAccountState.cs", "SmartAccountModulePolicy.cs",
        "SmartAccountCanonicalJson.cs", "SmartAccountInvocationContext.cs", "SmartAccountEnvelope.cs")},
}

SOURCE_FILES = {"contracts/compile.sh", "contracts/UnifiedSmartWallet.csproj",
                "contracts/UnifiedSmartWallet.VerifierChildren.cs",
                "contracts/UnifiedSmartWallet.Execution.cs",
                "contracts/UnifiedSmartWallet.Accounts.cs",
                "contracts/UnifiedSmartWallet.Internal.cs",
                "contracts/UnifiedSmartWallet.Models.cs",
                "contracts/UnifiedSmartWallet.State.cs",
                "contracts/UnifiedSmartWallet.Escape.cs",
                "contracts/UnifiedSmartWallet.Paymaster.cs",
                "contracts/paymaster/Paymaster.cs",
                "contracts/verifiers/VerifierPayload.cs",
                "contracts/verifiers/SignerDomain.cs",
                "contracts/verifiers/MultiSigVerifier.cs",
                "contracts/hooks/MultiHook.cs",
                "contracts/native/NativeAuthority.cs",
                "contracts/verifiers/VerifierAuthority.cs",
                "contracts/verifiers/NeoNativeVerifier.cs",
                "contracts/verifiers/SessionKeyVerifier.cs",
                "contracts/verifiers/NativeOperation.cs",
                "contracts/verifiers/VerifierClock.cs",
                "contracts/hooks/HookAuthority.cs",
                "contracts/hooks/WhitelistHook.cs",
                "contracts/hooks/DailyLimitHook.cs",
                "contracts/hooks/TokenRestrictedHook.cs",
                "contracts/UnifiedSmartWallet.VerifyContext.cs",
                "docs/proposals/smartaccount-native-profile-v2-parameters.json",
                "docs/proposals/smartaccount-native-profile-v2-vectors.json",
                "scripts/native_module_profile.py", "scripts/build_native_modules.py",
                "contracts/native/profiles.json"}
SOURCE_FILES.update({"Directory.Build.props", "nuget.config", "contracts/neo-platform-packages.json",
                     "scripts/verify_repo.sh", "scripts/check_neo_platform_packages.mjs",
                     "formal/verify.py", "formal/verify-in-docker.sh",
                     "docs/proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md",
                     "docs/proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.md",
                     "docs/proposals/SMARTACCOUNT-NATIVE-MULTISIG.md",
                     "docs/proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.md",
                     "docs/proposals/validate-native-smartaccount-profile.py"})
for _module in ("NeoNativeVerifier", "SessionKeyVerifier", "MultiSigVerifier", "WhitelistHook", "DailyLimitHook", "TokenRestrictedHook"):
    SOURCE_FILES.add(f"contracts/native/{_module}.Native.csproj")
    SOURCE_FILES.add(f"contracts/native/packages.{_module}.Native.lock.json")

MULTISIG_SOURCE = "contracts/verifiers/MultiSigVerifier.cs"
MULTISIG_SOURCE_GUARDS = {
    "non_empty": "verifiers != null && verifiers.Length > 0",
    "maximum_size": "verifiers.Length <= MaxChildVerifiers",
    "threshold_range": "threshold > 0 && threshold <= verifiers.Length",
    "address_validity": "verifiers[i] != UInt160.Zero && verifiers[i].IsValid",
    "no_duplicates": "verifiers[i] != verifiers[j]",
    "post_execute_threshold": "ExecutionEngine.Assert(validCount >= config.Threshold, \"Verifier rejected signature\")",
}
MULTISIG_SOURCE_MUTATIONS = {
    "non_empty": ("verifiers != null && verifiers.Length > 0", "true"),
    "maximum_size": ("verifiers.Length <= MaxChildVerifiers", "true"),
    "threshold_range": ("threshold > 0 && threshold <= verifiers.Length", "true"),
    "address_validity": ("verifiers[i] != UInt160.Zero && verifiers[i].IsValid", "true"),
    "no_duplicates": ("verifiers[i] != verifiers[j]", "true"),
    "post_execute_threshold": ("ExecutionEngine.Assert(validCount >= config.Threshold, \"Verifier rejected signature\")",
                               "ExecutionEngine.Assert(true, \"Verifier rejected signature\")"),
}
COQ_MUTATIONS = {
    "authorization": ("  authorized s op &&", "  true &&"),
    "nonce-check": ("\n  Nat.eqb (opSequence op) (cursor s (opChannel op)) &&\n", "\n  true &&\n"),
    "nonce-increment": ("(S (cursor s (opChannel op))))", "(S (S (cursor s (opChannel op)))))"),
    "reentrancy": ("  negb (executing s) &&", "  true &&"),
    "escape-owner": ("base && ownerWitness op", "base"),
    "rollback": ("  | None => s", "  | None => committed s op"),
    "operation-shape": ("  operationShapeValid op &&\n  deadlineValid op", "  true &&\n  deadlineValid op"),
    "reject-all": ("if admissible s op then", "if false then"),
}
MULTISIG_COQ_MUTATIONS = {
    # Each removes one acceptance condition from the policy model. A mutant that
    # still compiles would mean the theorems never depended on that condition.
    "multisig-threshold": ("(threshold <=? tally approve ids)",
                           "(0 <=? tally approve ids)"),
    "multisig-signature-count": ("Nat.eqb signature_count (length ids)",
                                 "Nat.eqb signature_count signature_count"),
    "multisig-uniqueness": ("forallb (fun id => negb (Nat.eqb id 0)) ids && unique ids.",
                            "forallb (fun id => negb (Nat.eqb id 0)) ids."),
}
PROXY_WITNESS_COQ_MUTATIONS = {
    # Each drops one clause of the transaction-script shape check. A mutant that
    # still compiles would mean the theorems never depended on that clause.
    "witness-prefix-check": ("  script_prefix_is_data_pushes s (length s - tl).", "  true."),
    "witness-account-binding": ("  bytes_eq (firstn 20 (skipn 2 t)) account &&", "  true &&"),
    "witness-core-binding": ("  bytes_eq (firstn 20 (skipn (27 + length method_push) t)) core &&",
                             "  true &&"),
    "witness-flags-range": ("  flags_in_range (at_ t 24) &&", "  true &&"),
    "witness-method-arity": ("  bytes_eq (firstn 2 (skipn 22 t)) PUSH2_PACK &&", "  true &&"),
    "witness-entrypoint-allowlist": (
        "  || script_is_single_execute_call s account core METHOD_EXECUTE_USER_OPS.",
        "  || script_is_single_execute_call s account core METHOD_EXECUTE_USER_OPS\n"
        "  || script_is_single_execute_call s account core METHOD_EXECUTE_SPONSORED_USER_OP."),
    "witness-syscall-tail": ("  bytes_eq (firstn 5 (skipn (47 + length method_push) t)) SYSCALL_CONTRACT_CALL.",
                             "  true."),
    "witness-unknown-opcode": ("  else if op =? 219 then 2                            (* CONVERT <type> *)\n  else 0.",
                               "  else if op =? 219 then 2                            (* CONVERT <type> *)\n  else 1."),
}
CALLBACK_PLUGIN_COQ_MUTATIONS = {
    # These mutations remove a concrete correspondence condition from the
    # callback/scope/cleanup definitions.  A mutant that still compiles would
    # mean the closed theorem roster did not depend on that condition.
    "callback-target-binding": ("Nat.eqb t (target op)", "true"),
    "callback-signature-binding": ("Nat.eqb s (signature op)", "true"),
    "callback-post-order": (
        "&& target_ok && hook_post_ok && verifier_post_ok\n  then [Validate; PreHook; TargetCall; PostHook; VerifierPost; Emit]",
        "&& target_ok && true\n  then [Validate; PreHook; TargetCall; PostHook; VerifierPost; Emit]"),
    "verifier-post-order": (
        "&& target_ok && hook_post_ok && verifier_post_ok\n  then [Validate; PreHook; TargetCall; PostHook; VerifierPost; Emit]",
        "&& target_ok && hook_post_ok && true\n  then [Validate; PreHook; TargetCall; PostHook; VerifierPost; Emit]"),
    "scope-entry-binding": ("CalledByEntry => Nat.eqb entry target", "CalledByEntry => true"),
    "cleanup-fail-closed": ("if cleanup_ok\n  then", "if true\n  then"),
    "composite-cleanup-all-children": (
        "Nat.eqb (length children) (length results) &&\n  forallb (fun result => result) results",
        "true"),
    "composite-root-clear": (
        "then mkCompositeState (composite_pointer new) 0\n         (clear_child_storage",
        "then mkCompositeState (composite_pointer new) 1\n         (clear_child_storage"),
    "composite-failure-rollback": (
        "if children_cleanup_ok (composite_children old) child_results\n  then mkCompositeState (composite_pointer new) 0\n         (clear_child_storage (composite_children old))\n  else old.",
        "if children_cleanup_ok (composite_children old) child_results\n  then mkCompositeState (composite_pointer new) 0\n         (clear_child_storage (composite_children old))\n  else mkCompositeState (composite_pointer new) 0\n         (clear_child_storage (composite_children old))."),
    "leaf-mutation-invalidates-root-intent": (
        "mkRootConfigIntent false (S (child_state_version intent))",
        "mkRootConfigIntent true (S (child_state_version intent))"),
    "dependency-replacement-skips-cleanup": (
        "if children_cleanup_ok (removed_children old new) cleanup_results\n  then new\n  else old.",
        "if true\n  then new\n  else old."),
    "dependency-replacement-publishes-on-failure": (
        "if children_cleanup_ok (removed_children old new) cleanup_results\n  then new\n  else old.",
        "if children_cleanup_ok (removed_children old new) cleanup_results\n  then new\n  else new."),
    "topology-all-children-leaf": (
        "forallb (fun child => negb (composite child)) children.",
        "true."),
}
VERIFIER_GAS_BUDGET_COQ_MUTATIONS = {
    # These mutations remove the concrete budget obligations.  They must make
    # at least one closed theorem fail, otherwise the formal gate would not
    # depend on the ancestor/atomicity conditions.
    "budget-limit-check": (
        "Nat.leb (budget_consumed budget + amount) (budget_limit budget)",
        "true"),
    "ancestor-conjunction": (
        "can_charge budget amount && all_can_charge rest amount",
        "can_charge budget amount || all_can_charge rest amount"),
    "atomic-failure-state": (
        "| None => (false, budgets)",
        "| None => (false, [])"),
    "nested-ancestor-requirement": (
        "all_can_charge rest amount",
        "true"),
}
AUTHORIZATION_EVIDENCE_COQ_MUTATIONS = {
    # These mutations remove one binding or replay condition from the
    # protocol-level evidence gate. They do not claim to mutate a primitive
    # cryptographic implementation; the primitive result is an explicit input
    # to the model and remains outside its proof boundary.
    "evidence-validity": (
        "evidence_valid evidence &&",
        "true &&"),
    "evidence-account-binding": (
        "Nat.eqb (evidence_account evidence) (claim_account claim) &&",
        "true &&"),
    "evidence-target-binding": (
        "Nat.eqb (evidence_target evidence) (claim_target claim) &&",
        "true &&"),
    "evidence-nonce-binding": (
        "Nat.eqb (evidence_nonce evidence) (claim_nonce claim) &&",
        "true &&"),
    "evidence-provider-binding": (
        "Nat.eqb (evidence_provider evidence) (claim_provider claim)",
        "true"),
    "evidence-nullifier-nonzero": (
        "negb (Nat.eqb (evidence_nullifier evidence) 0)",
        "true"),
    "evidence-replay-freshness": (
        "evidence_preconditions claim evidence && nullifier_fresh used evidence",
        "evidence_preconditions claim evidence && true"),
}
WITNESS_RULE_COQ_MUTATIONS = {
    # These mutations remove one protocol-semantic condition.  The model is
    # still deliberately bounded and does not claim to refine ApplicationEngine.
    "witness-first-match-action": (
        "then rule_allow rule\n      else eval_rules ctx rest",
        "then true\n      else eval_rules ctx rest"),
    "witness-default-deny": (
        "| [] => false\n  | rule :: rest =>",
        "| [] => true\n  | rule :: rest =>"),
    "witness-called-by-entry-depth": (
        "Nat.leb (call_depth ctx) 1",
        "Nat.eqb (call_depth ctx) 0"),
    "witness-condition-nonempty": (
        "(0 <? length expressions) &&\n      (length expressions <=? 16)",
        "true &&\n      (length expressions <=? 16)"),
    "witness-condition-child-limit": (
        "(length expressions <=? 16) &&\n      forallb",
        "true &&\n      forallb"),
    "witness-condition-depth-guard": (
        "| CBoolean _ | CScriptHash _ | CGroup _ | CCalledByEntry\n"
        "  | CCalledByContract _ | CCalledByGroup _ => (1 <=? depth)",
        "| CBoolean _ | CScriptHash _ | CGroup _ | CCalledByEntry\n"
        "  | CCalledByContract _ | CCalledByGroup _ => true"),
}
NEO_VM_CALL_SUBSET_COQ_MUTATIONS = {
    # The bounded execution-shape examples must fail if any one of their
    # protocol-relevant acceptance conditions is removed.
    "neo-vm-safe-prefix": (
        "forallb pure_push (firstn split program) &&",
        "true &&"),
    "neo-vm-exact-tail": (
        "exact_call_return (skipn split program).",
        "true."),
    "neo-vm-tail-boundary": (
        "let split := length program - 2 in",
        "let split := length program - 1 in"),
}
ATTESTATION_PROOF_COQ_MUTATIONS = {
    # The primitive proof/attestation result is an explicit oracle. These
    # mutations verify that the protocol envelope still depends on every
    # binding and replay condition that it can enforce locally.
    "proof-validity": (
        "  proof_valid proof &&",
        "  true &&"),
    "proof-account-binding": (
        "  Nat.eqb (proof_account proof) (claim_account claim) &&",
        "  true &&"),
    "proof-target-binding": (
        "  Nat.eqb (proof_target proof) (claim_target claim) &&",
        "  true &&"),
    "proof-nonce-binding": (
        "  Nat.eqb (proof_nonce proof) (claim_nonce claim) &&",
        "  true &&"),
    "proof-issuer-binding": (
        "  Nat.eqb (proof_issuer proof) (claim_issuer claim) &&",
        "  true &&"),
    "proof-measurement-binding": (
        "  Nat.eqb (proof_measurement proof) (claim_measurement claim).",
        "  true."),
    "proof-nullifier-nonzero": (
        "  negb (Nat.eqb (proof_nullifier proof) 0) &&",
        "  true &&"),
    "proof-replay-freshness": (
        "  nullifier_fresh used proof.",
        "  true."),
}
SIGNER_INDEPENDENCE_COQ_MUTATIONS = {
    "signer-domain-uniqueness": (
        "unique (map signer_domain signers)",
        "unique (map signer_secret signers)"),
}
PLUGIN_LIFECYCLE_COQ_MUTATIONS = {
    "plugin-admission": (
        "Definition admitted (plugin : Plugin) : bool := lifecycle_abi plugin.",
        "Definition admitted (plugin : Plugin) : bool := false."),
}
WITNESS_RULE_FAULT_COQ_MUTATIONS = {
    "witness-group-permission": (
        "if fault_read_states ctx\n  then EValue (member_nat group (fault_current_groups ctx))\n  else EFault.",
        "if fault_read_states ctx\n  then EValue (member_nat group (fault_current_groups ctx))\n  else EValue false."),
    "witness-caller-group-permission": (
        "if fault_read_states ctx\n  then EValue (member_nat group (fault_calling_groups ctx))\n  else EFault.",
        "if fault_read_states ctx\n  then EValue (member_nat group (fault_calling_groups ctx))\n  else EValue false."),
    "witness-negation-fault": (
        "| EFault => EFault\n          end\n      | FAnd expressions",
        "| EFault => EValue false\n          end\n      | FAnd expressions"),
    "witness-and-short-circuit": (
        "| EValue false => EValue false\n          | EValue true => eval_fault_and fuel' ctx rest",
        "| EValue false => EValue true\n          | EValue true => eval_fault_and fuel' ctx rest"),
    "witness-or-short-circuit": (
        "| EValue true => EValue true\n          | EValue false => eval_fault_or fuel' ctx rest",
        "| EValue true => EValue false\n          | EValue false => eval_fault_or fuel' ctx rest"),
    "witness-rule-fault": (
        "| EFault => EFault\n          | EValue true => EValue (fault_rule_allow rule)\n          | EValue false => eval_fault_rules fuel' ctx rest",
        "| EFault => eval_fault_rules fuel' ctx rest\n          | EValue true => EValue (fault_rule_allow rule)\n          | EValue false => eval_fault_rules fuel' ctx rest"),
}
SIGNER_DOMAIN_SEPARATION_COQ_MUTATIONS = {
    "signer-domain-binding": (
        "Nat.eqb (domain_scheme (signature_domain actual))\n"
        "    (domain_scheme (signature_domain expected)) &&",
        "true &&"),
}
ABI_MANIFEST_PROJECTION_COQ_MUTATIONS = {
    "abi-requires-initializer": (
        "Nat.eqb (length manifest) (S (length source)).",
        "Nat.eqb (length manifest) (length source)."),
    "abi-requires-unique-dispatch-keys": (
        "unique_keys (map dispatch_key_manifest manifest) &&",
        "true &&"),
    "abi-requires-every-manifest-method": (
        "manifest_methods_match source manifest &&",
        "true &&"),
    "abi-requires-safe-flag-equality": (
        "Bool.eqb (manifest_safe manifest) (source_safe source).",
        "true."),
}
NEO_VM_CONTINUATION_COQ_MUTATIONS = {
    "neo-vm-child-budget-bound": (
        "if requested <=? parent then Some requested else None.",
        "if true then Some requested else None."),
    "neo-vm-hardfork-gate": (
        "if callback_gas_cap_enabled config\n          then match callback_budget",
        "if true\n          then match callback_budget"),
    "neo-vm-loadscript-continuation": (
        "          push_continuation state target\n      | ICallback",
        "          mkVmState target (vm_stack state) (vm_continuations state)\n            (vm_budget state) (vm_storage state) Running\n      | ICallback"),
    "neo-vm-callt-return-address": (
        "Definition push_continuation (state : VmState) (target : nat) : VmState :=\n  mkVmState target (vm_stack state) (S (vm_pc state) :: vm_continuations state)",
        "Definition push_continuation (state : VmState) (target : nat) : VmState :=\n  mkVmState target (vm_stack state) (vm_pc state :: vm_continuations state)"),
    "neo-vm-rollback-storage": (
        "(vm_budget final) (vm_storage initial) Faulted",
        "(vm_budget final) (vm_storage final) Faulted"),
    "neo-vm-ancestor-charge": (
        "then Some (map (fun budget => budget - amount) budgets)",
        "then Some budgets"),
}
WITNESS_RULE_REFINEMENT_COQ_MUTATIONS = {
    # These mutations remove one correspondence condition from the executable
    # fault-aware evaluator.  The refinement theorem must fail closed rather
    # than silently proving the Boolean model for a changed evaluator.
    "witness-refinement-readstates": (
        "if read_states ctx\n  then EValue (member_nat group (current_groups ctx))\n  else EFault.",
        "if read_states ctx\n  then EValue (member_nat group (current_groups ctx))\n  else EValue false."),
    "witness-refinement-not-fault": (
        "| EFault => EFault\n          end\n      | CAnd expressions",
        "| EFault => EValue false\n          end\n      | CAnd expressions"),
    "witness-refinement-and-short-circuit": (
        "| EValue false => EValue false\n          | EValue true => eval_fault_and fuel' ctx rest",
        "| EValue false => EValue true\n          | EValue true => eval_fault_and fuel' ctx rest"),
    "witness-refinement-or-short-circuit": (
        "| EValue true => EValue true\n          | EValue false => eval_fault_or fuel' ctx rest",
        "| EValue true => EValue false\n          | EValue false => eval_fault_or fuel' ctx rest"),
    "witness-refinement-rule-action": (
        "| EValue true => EValue (rule_allow rule)\n          | EValue false => eval_fault_rules fuel' ctx rest",
        "| EValue true => EValue true\n          | EValue false => eval_fault_rules fuel' ctx rest"),
    "witness-parser-width": (
        "(length expressions <=? 16) &&\n      forallb (parser_condition_admissible",
        "(length expressions <=? 17) &&\n      forallb (parser_condition_admissible"),
    "witness-parser-nonempty": (
        "(0 <? length expressions) &&\n      (length expressions <=? 16)",
        "true &&\n      (length expressions <=? 16)"),
    "witness-parser-depth": (
        "| CCalledByContract _ | CCalledByGroup _ => (1 <=? depth)",
        "| CCalledByContract _ | CCalledByGroup _ => true"),
    "witness-parser-rule-depth": (
        "forallb (fun rule => parser_condition_admissible 3 (rule_condition rule)) rules.",
        "forallb (fun rule => parser_condition_admissible 4 (rule_condition rule)) rules."),
    "witness-fuel-bound": (
        "| S predecessor => S (16 + uniform_condition_fuel predecessor)",
        "| S predecessor => S predecessor"),
}
NATIVE_INTEGER_DOMAIN_COQ_MUTATIONS = {
    "native-integer-upper-bound": ("Definition nonce_limit : Z := 2 ^ 255.",
                                   "Definition nonce_limit : Z := 2 ^ 256."),
    "native-channel-width": ("Definition channel_limit : Z := 2 ^ 191.",
                             "Definition channel_limit : Z := 2 ^ 192."),
    "native-nonce-consumption": ("then Some (cursor + 1)", "then Some (cursor + 2)"),
    "native-nonce-exhaustion": ("if Z.eqb cursor sequence_limit then None",
                                "if Z.eqb cursor sequence_limit then Some 0"),
    "native-batch-shadow-update": (
        "verify_nonce_batch (update_cursor cursors (channel nonce) next) rest",
        "verify_nonce_batch cursors rest"),
    "native-batch-cross-channel": (
        "if Z.eqb query changed then value else cursors query",
        "if Z.eqb query changed then value else value"),
    "native-batch-failure-acceptance": (
        "| None => None\n      end\n  end.",
        "| None => Some cursors\n      end\n  end."),
}
NATIVE_LIFECYCLE_COQ_MUTATIONS = {
    "native-config-root-postcheck": ("Z.eqb r root_pin && Z.eqb c child_pin", "true && Z.eqb c child_pin"),
    "native-config-child-postcheck": ("Z.eqb r root_pin && Z.eqb c child_pin", "Z.eqb r root_pin && true"),
    "native-config-missing-binding": ("| _, _ => false\n  end.", "| _, _ => true\n  end."),
    "native-config-fault-rollback": ("then (true, staged) else (false, before).", "then (true, staged) else (false, staged)."),
    "native-config-success-commit": ("then (true, staged) else (false, before).", "then (true, before) else (false, before)."),
    "native-lifecycle-frozen-config": ("active s && negb (pending_recovery s)", "true && negb (pending_recovery s)"),
    "native-lifecycle-recovery-config": ("active s && negb (pending_recovery s)", "active s && true"),
    "native-lifecycle-joint-unfreeze": ("(negb (has_recovery s) || recovery)", "true"),
    "native-lifecycle-cancel-boundary": ("(custody && (now <? maturity))", "(custody && (now <=? maturity))"),
    "native-lifecycle-clear-recovery": ("                  false false false false)", "                  false false false (pending_recovery s))"),
    "native-lifecycle-epoch-increment": ("(epoch s + 1)", "(epoch s + 2)"),
    "native-lifecycle-epoch-overflow": ("if (0 <=? epoch s) && (epoch s <? epoch_limit - 1) then", "if (0 <=? epoch s) && (epoch s <=? epoch_limit - 1) then"),
}
NATIVE_DISPATCH_COQ_MUTATIONS = {
    "native-dispatch-missing-activation": ("| None => false end.", "| None => true end."),
    "native-dispatch-future-height": ("Some boundary => (boundary <=? height)", "Some boundary => true"),
    "native-dispatch-ledger-height": ("| None => ledger end.", "| None => 0 end."),
    "native-dispatch-caller-identity": ("native && same_caller && read_states && allow_call", "native && true && read_states && allow_call"),
    "native-dispatch-read-permission": ("native && same_caller && read_states && allow_call", "native && same_caller && true && allow_call"),
    "native-dispatch-fee-attribution": ("if caller_white then 0 else fee", "if child_white then 0 else fee"),
    "native-dispatch-return-policy": ("else fee, child_white", "else fee, caller_white"),
}
NATIVE_INVOCATION_COQ_MUTATIONS = {
    "module-service-identity": ("(configured =? expected) && context.", "true && context."),
    "module-phase-grant": ("(configured =? expected) && context.", "(configured =? expected) && true."),
    "service-witness-gate": ("if active then negb service &&", "if true then negb service &&"),
    "service-witness-identity": ("if active then negb service &&", "if active then true &&"),
    "service-proxy-frame": ("if registered_proxy then target_frame && legacy else legacy", "if registered_proxy then legacy else legacy"),
    "service-proxy-legacy": ("if registered_proxy then target_frame && legacy else legacy", "if registered_proxy then target_frame else legacy"),
    "service-unregistered-legacy": ("if registered_proxy then target_frame && legacy else legacy", "if registered_proxy then target_frame && legacy else true"),
    "invocation-account": ("(a =? account g) &&", "true &&"),
    "invocation-phase": ("(p =? phase g) &&", "true &&"),
    "invocation-frame": ("(current =? frame g)", "true"),
    "invocation-parent": ("(parent =? frame g)", "true"),
    "invocation-target-kind": ("(k <? 2) &&", "true &&"),
    "invocation-fault-reset": ("Definition on_fault (_ : option Grant) : option Grant := None.", "Definition on_fault (active : option Grant) : option Grant := active."),
    "invocation-config-delegation": ("Definition may_delegate (p : nat) : bool := p <? 3.", "Definition may_delegate (p : nat) : bool := p <? 4."),
    "invocation-witness-substitution": ("grant && original_witness.", "grant || original_witness."),
}
NATIVE_SESSION_COQ_MUTATIONS = {
    "session-rotation-reset-spent": ("then Some (Policy true (consumed s) (Some now))", "then Some (Policy true 0 (Some now))"),
    "session-rotation-timestamp": ("then Some (Policy true (consumed s) (Some now))", "then Some (Policy true (consumed s) (rotated_at s))"),
    "session-rotation-cooldown": ("timestamp + cooldown <=? now end.", "true end."),
    "session-revocation-key": ("Policy false 0 (rotated_at s).", "Policy (has_session s) 0 (rotated_at s)."),
    "session-revocation-spent": ("Policy false 0 (rotated_at s).", "Policy false (consumed s) (rotated_at s)."),
    "session-revocation-cooldown": ("Policy false 0 (rotated_at s).", "Policy false 0 None."),
    "session-cleanup-cooldown": ("Definition cleanup_policy (_ : SessionPolicy) : SessionPolicy :=\n  Policy false 0 None.", "Definition cleanup_policy (s : SessionPolicy) : SessionPolicy :=\n  Policy false 0 (rotated_at s)."),
    "session-verification-clock": ("if verification then ledger else Some persisting.", "if verification then Some persisting else Some persisting."),
    "session-application-clock": ("if verification then ledger else Some persisting.", "if verification then ledger else ledger."),
    "session-context": ("context && signature", "true && signature"),
    "session-signature": ("context && signature", "context && true"),
    "session-scope": ("&& scope && live", "&& true && live"),
    "session-expiry": ("&& live && shape", "&& true && shape"),
    "session-shape": ("&& shape && (spent", "&& true && (spent"),
    "session-cap": ("(spent + amount <=? cap).", "true."),
    "session-zero-cap-bypass": ("(spent + amount <=? cap).", "((amount =? 0) || (spent + amount <=? cap))."),
    "session-target-result": ("cap && target_success", "cap && true"),
    "session-fault-rollback": ("else (false, spent).", "else (false, S spent)."),
    "session-exact-debit": ("then (true, spent + amount)", "then (true, S (spent + amount))"),
}
NATIVE_SESSION_SCOPE_COQ_MUTATIONS = {
    "scope-target": ("target_match && (wildcard || method_match).", "true && (wildcard || method_match)."),
    "scope-wildcard": ("(wildcard || method_match).", "method_match."),
    "scope-exact-method": ("(wildcard || method_match).", "(wildcard || true)."),
    "scope-cap-configuration": ("(cap =? 0) || transfer_method.", "true."),
    "scope-context": ("ctx && sig && live && method_scope target_match", "true && sig && live && method_scope target_match"),
    "scope-signature": ("ctx && sig && live && method_scope target_match", "ctx && true && live && method_scope target_match"),
    "scope-expiry": ("ctx && sig && live && method_scope target_match", "ctx && sig && true && method_scope target_match"),
    "scope-zero-cap-shape": ("if cap =? 0 then true else shape", "if cap =? 0 then shape else shape"),
    "scope-capped-shape": ("then true else shape &&", "then true else true &&"),
    "scope-capped-budget": ("shape && (spent + amount <=? cap)", "shape && true"),
    "scope-uncapped-false": ("((cap =? 0) || true_result)", "true_result"),
    "scope-uncapped-debit": ("then spent else spent + amount", "then spent + amount else spent + amount"),
    "scope-target-fault": ("authorized && halted &&", "authorized && true &&"),
    "scope-capped-false": ("((cap =? 0) || true_result)", "true"),
    "scope-revoked-key": ("| None => false", "| None => true"),
    "scope-replaced-key": ("(key =? signing_key) && valid_signature", "true && valid_signature"),
    "scope-nonce-replay": ("&& nonce_current && unexpired", "&& true && unexpired"),
    "scope-expired-signature": ("&& nonce_current && unexpired", "&& nonce_current && true"),
}
NATIVE_DAILY_COQ_MUTATIONS = {
    "daily-moving-anchor": ("then timestamp else now end.", "then now else now end."),
    "daily-expiry-boundary": ("now <? timestamp + window_ms.", "now <=? timestamp + window_ms."),
    "daily-retains-expired-spend": ("then used w else 0 end.", "then used w else used w end."),
    "daily-cap-removed": ("if current_spent w now + delta <=? cap", "if true"),
    "daily-false-result-bypass": ("Definition observed_outflow (_result : bool) (before after : nat) : nat := before - after.", "Definition observed_outflow (result : bool) (before after : nat) : nat := if result then before - after else 0."),
    "daily-reversed-delta": ("Definition observed_outflow (_result : bool) (before after : nat) : nat := before - after.", "Definition observed_outflow (_result : bool) (before after : nat) : nat := after - before."),
    "daily-expired-record-retained": ("now - window_ms <=? timestamp.", "true."),
    "daily-history-cap-removed": ("&& (count <? 50).", "&& true."),
    "daily-scan-ignores-amount": ("then (payment_amount r + fst tail, S (snd tail)) else tail", "then (fst tail, S (snd tail)) else tail"),
    "daily-scan-ignores-count": ("then (payment_amount r + fst tail, S (snd tail)) else tail", "then (payment_amount r + fst tail, snd tail) else tail"),
    "daily-prune-live-records": ("filter (fun r => rolling_live (payment_time r) now) rows.", "filter (fun r => false) rows."),
    "daily-negative-balance-coercion": ("if Z.geb value 0 then Some (Z.to_nat value) else None", "if true then Some (Z.to_nat value) else None"),
    "daily-noninteger-balance-coercion": ("| OtherBalanceType => None", "| OtherBalanceType => Some 0"),
    "daily-query-fault-coercion": ("| BalanceQueryFault => None", "| BalanceQueryFault => Some 0"),
    "daily-invalid-delta-fallback": ("| _, _ => None\n  end.", "| _, _ => Some 0\n  end."),
}
NATIVE_RESTRICTED_COQ_MUTATIONS = {
    "restricted-missing-snapshot": ("match snapshot with\n  | None => false", "match snapshot with\n  | None => true"),
    "restricted-invalid-query": ("match reply with\n    | None => false", "match reply with\n    | None => true"),
    "restricted-outflow": ("| Some after => before <=? after", "| Some after => true"),
    "restricted-direct-target": ("context && negb direct_restricted && queries_valid.", "context && true && queries_valid."),
    "restricted-ignore-later-token": ("check && all_restrictions rest end.", "check end."),
    "restricted-false-result-bypass": ("context && all_restrictions checks.", "context && (negb target_result || all_restrictions checks)."),
    "restricted-removal-snapshot": ("(without_token token (snapshots s)).", "(snapshots s)."),
    "restricted-cleanup-snapshot": ("RestrictionState := State [] [].", "RestrictionState := State [] (snapshots s)."),
}
NATIVE_COMPOSITE_PHASE_MUTATIONS = {
    "composite-old-entry-post": ("| PostEntry, PostPhase => true", "| PostEntry, PostPhase | ValidationEntry, PostPhase => true"),
    "composite-post-entry-validation": ("| ValidationEntry, ValidationPhase => true", "| ValidationEntry, ValidationPhase | PostEntry, ValidationPhase => true"),
    "composite-missing-grant": ("grant && phase_allowed entry phase", "true && phase_allowed entry phase"),
    "composite-nonboolean-vote": ("TrueReply => true | _ => false", "TrueReply | NonBooleanReply => true | _ => false"),
    "composite-post-wrong-entry": ("native_approve PostEntry PostPhase grant (reply id)", "native_approve ValidationEntry PostPhase grant (reply id)"),
    "composite-post-inverts-support": ("filter (fun id => native_approve PostEntry PostPhase grant (reply id)) ids.", "filter (fun id => negb (native_approve PostEntry PostPhase grant (reply id))) ids."),
}
NATIVE_AUTHORITY_EPOCH_MUTATIONS = {'epoch-bound-inclusive': ('(0 <=? value) && (value <? maximum).', '(0 <=? value) && (value <=? maximum).'),
 'recovery-authority-bypass': ('authority_valid && has_recovery s && mature_intent',
                               'true && has_recovery s && mature_intent'),
 'recovery-timelock-bypass': ('has_recovery s && mature_intent maximum delay now p &&',
                              'has_recovery s && true &&'),
 'recovery-stale-proposal-bypass': ('Z.eqb (expected_configuration p) (configuration_nonce s) &&', 'true &&'),
 'recovery-epoch-overflow-bypass': ('incrementable maximum (authority_epoch s) &&', 'true &&'),
 'recovery-config-overflow-bypass': ('incrementable maximum (configuration_nonce s).', 'true.'),
 'recovery-retains-old-epoch': ('(recovery_address s) (authority_epoch s + 1) (configuration_nonce s + 1)',
                                '(recovery_address s) (authority_epoch s) (configuration_nonce s + 1)'),
 'recovery-retains-old-config': ('(recovery_address s) (authority_epoch s + 1) (configuration_nonce s + 1)',
                                 '(recovery_address s) (authority_epoch s + 1) (configuration_nonce s)'),
 'recovery-retains-verifier': ('None None [] false false false None (target_nonces s) (frozen s).',
                               '(verifier_root s) None [] false false false None (target_nonces s) (frozen '
                               's).'),
 'recovery-retains-hook': ('None None [] false false false None (target_nonces s) (frozen s).',
                           'None (hook_root s) [] false false false None (target_nonces s) (frozen s).'),
 'recovery-retains-dependencies': ('None None [] false false false None (target_nonces s) (frozen s).',
                                   'None None (dependencies s) false false false None (target_nonces s) '
                                   '(frozen s).'),
 'recovery-retains-pending': ('None None [] false false false None (target_nonces s) (frozen s).',
                              'None None [] false false false (pending_recovery s) (target_nonces s) (frozen '
                              's).'),
 'recovery-unfreezes': ('None None [] false false false None (target_nonces s) (frozen s).',
                        'None None [] false false false None (target_nonces s) false.'),
 'recovery-resets-target-nonces': ('None None [] false false false None (target_nonces s) (frozen s).',
                                   'None None [] false false false None [] (frozen s).'),
 'failed-recovery-commits': ('then (true, recovered s p) else (false, s)',
                             'then (true, recovered s p) else (false, recovered s p)'),
 'configuration-changes-epoch': ('(recovery_address s) (authority_epoch s) (configuration_nonce s + 1)',
                                 '(recovery_address s) (authority_epoch s + 1) (configuration_nonce s + 1)'),
 'namespace-ignores-epoch': ('Z.eqb (fst left) (fst right) && Z.eqb (snd left) (snd right).',
                             'Z.eqb (fst left) (fst right).'),
 'namespace-ignores-account': ('Z.eqb (fst left) (fst right) && Z.eqb (snd left) (snd right).',
                               'Z.eqb (snd left) (snd right).'),
 'signature-ignores-epoch': ('Z.eqb (signed_epoch domain) (authority_epoch s) &&', 'true &&'),
 'signature-ignores-configuration': ('Z.eqb (signed_configuration domain) (configuration_nonce s).', 'true.')}

NATIVE_AUTHORITY_EPOCH_MUTATIONS["epoch-unreachable-state-admission"] = (
    "counter_in_range maximum configuration && (epoch <=? configuration).",
    "counter_in_range maximum configuration && true.")

NATIVE_AUTHORITY_EPOCH_MUTATIONS["execution-envelope-arity-bypass"] = (
    "Z.eqb arity 4 && authorized maximum s domain valid_signature.",
    "true && authorized maximum s domain valid_signature.")

COQ_MODULES = {
    "NativeAuthorityEpoch.v": NATIVE_AUTHORITY_EPOCH_MUTATIONS,
    "NativeCompositePhase.v": NATIVE_COMPOSITE_PHASE_MUTATIONS,
    "NativeRestrictedPolicy.v": NATIVE_RESTRICTED_COQ_MUTATIONS,
    "NativeSessionScope.v": NATIVE_SESSION_SCOPE_COQ_MUTATIONS,
    "NativeDailyPolicy.v": NATIVE_DAILY_COQ_MUTATIONS,
    "NativeSessionPolicy.v": NATIVE_SESSION_COQ_MUTATIONS,
    "UnifiedSmartWalletAA.v": COQ_MUTATIONS,
    "MultiSigPolicy.v": MULTISIG_COQ_MUTATIONS,
    "ProxyWitnessScript.v": PROXY_WITNESS_COQ_MUTATIONS,
    "CallbackPluginTopology.v": CALLBACK_PLUGIN_COQ_MUTATIONS,
    "VerifierGasBudget.v": VERIFIER_GAS_BUDGET_COQ_MUTATIONS,
    "AuthorizationEvidence.v": AUTHORIZATION_EVIDENCE_COQ_MUTATIONS,
    "WitnessRuleSemantics.v": WITNESS_RULE_COQ_MUTATIONS,
    "NeoVmCallSubset.v": NEO_VM_CALL_SUBSET_COQ_MUTATIONS,
    "AttestationProofBinding.v": ATTESTATION_PROOF_COQ_MUTATIONS,
    "SignerIndependence.v": SIGNER_INDEPENDENCE_COQ_MUTATIONS,
    "PluginLifecycle.v": PLUGIN_LIFECYCLE_COQ_MUTATIONS,
    "WitnessRuleFaultSemantics.v": WITNESS_RULE_FAULT_COQ_MUTATIONS,
    "SignerDomainSeparation.v": SIGNER_DOMAIN_SEPARATION_COQ_MUTATIONS,
    "AbiManifestProjection.v": ABI_MANIFEST_PROJECTION_COQ_MUTATIONS,
    "NeoVmContinuationSemantics.v": NEO_VM_CONTINUATION_COQ_MUTATIONS,
    "WitnessRuleRefinement.v": WITNESS_RULE_REFINEMENT_COQ_MUTATIONS,
    "NativeIntegerDomain.v": NATIVE_INTEGER_DOMAIN_COQ_MUTATIONS,
    "NativeLifecycle.v": NATIVE_LIFECYCLE_COQ_MUTATIONS,
    "NativeDispatch.v": NATIVE_DISPATCH_COQ_MUTATIONS,
    "NativeInvocation.v": NATIVE_INVOCATION_COQ_MUTATIONS,
}
TLA_MUTATIONS = {
    "authorization": ("SuccessAuthorizationGuard == pendingAuthorized",
                      "SuccessAuthorizationGuard == TRUE", "SuccessWasAuthorized"),
    "operation-shape": ("SuccessShapeGuard == pendingShape",
                        "SuccessShapeGuard == TRUE", "SuccessWasWellShaped"),
    "nonce-increment": ("![pendingChannel] = @ + 1", "![pendingChannel] = @ + 2", "SuccessNonceTransition"),
    "rollback": ("    /\\ cursor' = cursor", "    /\\ cursor' = [cursor EXCEPT ![pendingChannel] = @ + 1]", "FailureAtomic"),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def replace_once(source, old, new):
    require(source.count(old) == 1, f"Mutation match is not unique: {old!r}")
    require(old != new, "Mutation made no change")
    return source.replace(old, new, 1)


def check_profile_scope(lock):
    require(lock.get("runtimeProfiles") == RUNTIME_PROFILES,
            "Runtime profile scope changed; explicit review required")
    require(lock.get("modelProfiles") == MODEL_PROFILES,
            "Model profile scope changed; public child-budget claims are forbidden")


def native_core_hashes(core_root):
    require(core_root is not None, "Missing --native-core-root (or NEOOS_NATIVE_CORE_SOURCE)")
    core_root = Path(core_root).resolve()
    def checked(path):
        require(not any(part.is_symlink() for part in (path, *path.parents) if part != core_root and core_root in part.parents),
                f"Native core source symlink: {path.relative_to(core_root)}")
        require(core_root in path.resolve().parents, "Native core source escapes repository")
        return path
    for name in sorted(NATIVE_CORE_REQUIRED_FILES):
        checked(core_root / name)
        require((core_root / name).is_file(), f"Native core source missing: {name}")
    selected = set()
    for directory in ("src/Neo", "src/Neo.Extensions", "src/Neo.IO", "src/Neo.Json"):
        for path in (core_root / directory).rglob("*"):
            relative = path.relative_to(core_root)
            if any(part in {"bin", "obj", ".git"} for part in relative.parts):
                continue
            if path.is_file() and (path.suffix.lower() in {".cs", ".csproj", ".props", ".targets", ".resx", ".ico", ".png"} or relative.as_posix().startswith("src/Neo/Resources/BIP-39.") and path.suffix == ".txt"):
                checked(path)
                selected.add(relative.as_posix())
    for name in ("global.json", "Directory.Build.props", "Directory.Build.targets", "version.json", "src/Directory.Build.props", "src/Directory.Build.targets"):
        if (core_root / name).is_file():
            checked(core_root / name)
            selected.add(name)
    return {name: hashlib.sha256((core_root / name).read_bytes()).hexdigest() for name in sorted(selected)}


def check_native_core_sources(lock, core_root):
    current = native_core_hashes(core_root)
    expected = lock.get("nativeCoreSources")
    require(isinstance(expected, dict) and bool(expected), "Missing reviewed nativeCoreSources pins")
    require(set(current) == set(expected), "Native core source roster changed; explicit review required")
    changed = [name for name in current if current[name] != expected[name]]
    require(not changed, f"Native core source drift: {changed}")
    return current


def check_inventory(root=ROOT):
    found = {str(p.relative_to(root)) for d in ("coq", "tla", "smt")
             for p in (root / d).rglob("*") if p.suffix in {".v", ".tla", ".cfg", ".smt2"}}
    require(found == ARTIFACTS, f"Artifact inventory mismatch: {found ^ ARTIFACTS}")
    lock = json.loads((root / "source-lock.json").read_text())
    require(lock["schema"] == "aa-formal-source-lock/v2", "Unknown source-lock schema")
    check_profile_scope(lock)
    require(set(lock["sources"]) == SOURCE_FILES, "Source roster changed; explicit review required")
    for name, expected in lock["sources"].items():
        actual = hashlib.sha256((root.parent / name).read_bytes()).hexdigest()
        require(actual == expected, f"Source drift: {name}; review correspondence before updating pins")


def multisig_config_valid(verifiers, threshold):
    """Executable bounded specification for MultiSigVerifier.SetConfig."""
    return (0 < len(verifiers) <= 10
            and 0 < threshold <= len(verifiers)
            and all(verifier > 0 for verifier in verifiers)
            and len(set(verifiers)) == len(verifiers))


def multisig_accepts(verifier_count, threshold, signature_count, valid_children):
    """Executable bounded specification for both validation and PostExecute gating."""
    return signature_count == verifier_count and sum(valid_children) >= threshold


def check_multisig_bounded(repo_root=ROOT.parent):
    """Check the finite MultiSig policy space and reject guard-removal mutants.

    This is deliberately a bounded correspondence aid, not a claim of cryptographic or
    NeoVM-semantic proof. The concrete VM vectors live in VerifierSignatureRuntimeTests.
    """
    source = (repo_root / MULTISIG_SOURCE).read_text()
    for name, fragment in MULTISIG_SOURCE_GUARDS.items():
        require(fragment in source, f"Missing MultiSig source guard: {name}")

    for name, (old, new) in MULTISIG_SOURCE_MUTATIONS.items():
        mutant = replace_once(source, old, new)
        require(any(fragment not in mutant for fragment in MULTISIG_SOURCE_GUARDS.values()),
                f"MultiSig guard mutation escaped source gate: {name}")

    config_cases = 0
    # Past MaxChildVerifiers on purpose: counts 11 and 12 enumerate the rejection
    # boundary instead of leaving it to the three spot checks below.
    for count in range(0, 13):
        verifiers = list(range(1, count + 1))
        for threshold in range(0, count + 2):
            expected = 1 <= count <= 10 and 0 < threshold <= count
            require(multisig_config_valid(verifiers, threshold) == expected,
                    f"MultiSig config model mismatch: count={count}, threshold={threshold}")
            config_cases += 1

    require(not multisig_config_valid([1] * 2, 1), "Duplicate verifier accepted by model")
    require(not multisig_config_valid([0, 1], 1), "Zero verifier accepted by model")
    require(not multisig_config_valid(list(range(1, 12)), 1), "Oversized verifier set accepted by model")

    acceptance_cases = 0
    for count in range(1, 11):
        for threshold in range(1, count + 1):
            for signature_count in range(0, count + 2):
                for mask in range(1 << count):
                    valid_children = [(mask >> index) & 1 == 1 for index in range(count)]
                    expected = signature_count == count and sum(valid_children) >= threshold
                    require(multisig_accepts(count, threshold, signature_count, valid_children) == expected,
                            f"MultiSig acceptance model mismatch: count={count}, threshold={threshold}, "
                            f"signature_count={signature_count}, mask={mask}")
                    acceptance_cases += 1
    return {"configCases": config_cases, "acceptanceCases": acceptance_cases,
            "sourceGuards": len(MULTISIG_SOURCE_GUARDS),
            "sourceMutationsRejected": list(MULTISIG_SOURCE_MUTATIONS)}


def artifact_hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sorted(ARTIFACTS)}


def coq_declarations(source):
    # Strip nested comments for auditing declarations, not for proof compilation.
    clean = source
    while "(*" in clean:
        clean, n = re.subn(r"\(\*(?:(?!\(\*|\*\)).)*\*\)", "", clean, flags=re.S)
        require(n > 0, "Unterminated Coq comment")
    require(not re.search(r"\b(Admitted|admit|Abort|Axiom|Parameter|Hypothesis|give_up)\b", clean),
            "Coq proof-gap marker")
    declared = re.findall(r"\b(?:Theorem|Lemma|Corollary|Proposition|Fact|Example|Remark)\s+(\w+)\s*:", clean)
    printed = re.findall(r"\bPrint\s+Assumptions\s+(\w+)\s*\.", clean)
    require(len(declared) > 0 and len(declared) == len(set(declared)), "Missing/duplicate declarations")
    require(sorted(declared) == sorted(printed), "Each declaration needs exactly one named assumption audit")
    return declared


def parse_tlc(output, returncode):
    require(returncode == 0, f"TLC exited {returncode}")
    require("Model checking completed. No error has been found." in output, "TLC did not exhaust the model")
    require(not re.search(r"^Error:", output, re.M), "TLC error")
    # Do not read progress counters as final state counts.
    final = re.findall(r"^(\d+) states generated, (\d+) distinct states found, 0 states left on queue\.$",
                       output, re.M)
    require(len(final) == 1 and int(final[0][1]) > 1, "Missing/non-trivial final TLC summary")
    rows = re.findall(r"^<(\w+) line .*?>: (\d+):(\d+)$", output, re.M)
    expected_actions = ("Init", "Tick", "Begin", "CompleteSuccess", "CompleteFailure")
    # TLC emits one coverage sample per -coverage interval.  The final sample
    # is the only one that represents the completed run; earlier samples are
    # expected when model checking takes longer than the interval.  Select one
    # complete final roster while rejecting missing, reordered, or extra rows.
    require(len(rows) >= len(expected_actions), "TLC action coverage roster missing")
    final_rows = rows[-len(expected_actions):]
    require(tuple(name for name, _, _ in final_rows) == expected_actions,
            "TLC action coverage roster mismatch")
    actions = dict((name, int(generated)) for name, distinct, generated in final_rows)
    require(all(actions.values()), "Unreachable TLC action")
    return {"generated": int(final[0][0]), "distinct": int(final[0][1]), "actions": actions}


def parse_smt(source, output, returncode):
    require(returncode == 0 and "(error" not in output, "Z3 failed")
    labels = re.findall(r'^\(echo "((?:OBL|CTRL):[^"]+)"\)$', source, re.M)
    require(labels and len(labels) == len(set(labels)), "Missing/duplicate SMT labels")
    tokens = [line for line in output.splitlines()
              if re.match(r"^(OBL:|CTRL:|DONE:|sat$|unsat$|unknown$)", line)]
    expected = []
    for label in labels:
        expected += [label, "unsat" if label.startswith("OBL:") else "sat"]
    expected += ["DONE:aa_core"]
    require(tokens == expected, "SMT verdict missing, unexpected, reordered, unknown or incorrect")
    return {"obligations": sum(s.startswith("OBL:") for s in labels),
            "controls": sum(s.startswith("CTRL:") for s in labels)}


def run(args, cwd, logs, name, timeout=180):
    completed = subprocess.run([str(arg) for arg in args], cwd=cwd, text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    output = completed.stdout
    # Local logs may contain tool paths; they are ignored and never public evidence.
    (logs / f"{name}.log").write_text(output)
    return completed.returncode, output


def executable(env, default):
    value = os.environ.get(env, default)
    path = shutil.which(value)
    require(path is not None, f"Missing required tool {env} ({value})")
    return path


def java_candidates(environ=None, platform=None):
    """Candidate Java launchers, most explicit first.

    An explicit JAVA_BIN is the only candidate when set: a reviewer who names a
    runtime must not be silently redirected to another one. Otherwise JAVA_HOME,
    the macOS java_home locator, the Homebrew OpenJDK kegs and PATH are tried in
    that order. macOS ships /usr/bin/java as a launcher stub that fails with
    "Unable to locate a Java Runtime" when no JDK is installed; probing each
    candidate with -version is what separates a working runtime from that stub.
    """
    environ = os.environ if environ is None else environ
    platform = sys.platform if platform is None else platform
    explicit = environ.get("JAVA_BIN")
    if explicit:
        return [explicit]
    candidates = []
    java_home = environ.get("JAVA_HOME")
    if java_home:
        candidates.append(str(Path(java_home) / "bin" / "java"))
    if platform == "darwin":
        locator = shutil.which("/usr/libexec/java_home")
        if locator is not None:
            located = subprocess.run([locator], capture_output=True, text=True, timeout=30)
            if located.returncode == 0 and located.stdout.strip():
                candidates.append(str(Path(located.stdout.strip()) / "bin" / "java"))
        candidates += ["/opt/homebrew/opt/openjdk/bin/java", "/opt/homebrew/opt/openjdk@21/bin/java",
                       "/opt/homebrew/opt/openjdk@17/bin/java", "/usr/local/opt/openjdk/bin/java"]
    candidates.append("java")
    return candidates


def resolve_java(candidates, logs):
    """Return (path, version line) for the first candidate whose -version succeeds.

    Fails closed with every probe result when none works; a missing runtime is a
    failure of the gate, never a reason to skip TLC.
    """
    attempts = []
    for index, candidate in enumerate(candidates):
        path = shutil.which(candidate)
        if path is None:
            attempts.append(f"{candidate}: not found")
            continue
        rc, output = run([path, "-version"], ROOT, logs, f"java-probe-{index}", timeout=60)
        first = output.strip().splitlines()[0] if output.strip() else ""
        if rc == 0 and "version" in output:
            return path, first
        attempts.append(f"{path}: exit {rc}: {first}")
    raise ValueError("No working Java runtime for TLC (" + "; ".join(attempts)
                     + "). Set JAVA_BIN to a JDK's bin/java; on macOS `brew install openjdk`.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / ".runs" / "latest")
    parser.add_argument("--native-core-root", type=Path, default=os.environ.get("NEOOS_NATIVE_CORE_SOURCE"))
    args = parser.parse_args()
    logs = args.output.resolve()
    logs.mkdir(parents=True, exist_ok=True)
    # Invalidate a previous success before any current gate runs.
    report = {"modelChecksPassed": False, "implementationVerified": False,
              "boundary": "Hand-written abstractions; no VM/source/NEF refinement or liveness proof",
              "runtimeProfiles": RUNTIME_PROFILES, "modelProfiles": MODEL_PROFILES}
    report_path = logs / "result.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    try:
        coqc = executable("COQC", "coqc")
        check_inventory()
        source_lock = json.loads((ROOT / "source-lock.json").read_text())
        report["nativeCoreSourceSha256"] = check_native_core_sources(source_lock, args.native_core_root)
        report["multisigBoundedModel"] = check_multisig_bounded()
        coqc = executable("COQC", "coqc")
        z3 = executable("Z3", "z3")
        java, java_version = resolve_java(java_candidates(), logs)
        jar = Path(os.environ.get("TLA_JAR", str(Path.home() / "tools/tla/tla2tools.jar"))).resolve()
        require(jar.is_file(), "Missing TLA_JAR; no simulated success allowed")
        report["artifactSha256"] = artifact_hashes()
        report["sourceSha256"] = json.loads((ROOT / "source-lock.json").read_text())["sources"]
        report["tlcJarSha256"] = hashlib.sha256(jar.read_bytes()).hexdigest()
        report["toolVersions"] = {"java": java_version}
        for name, command in {"coq": [coqc, "--version"], "z3": [z3, "--version"]}.items():
            rc, output = run(command, ROOT, logs, name + "-version")
            require(rc == 0 and output.strip(), f"Cannot read {name} version")
            report["toolVersions"][name] = output.splitlines()[0]
        with tempfile.TemporaryDirectory(prefix="aa-formal-") as scratch:
            work = Path(scratch)
            for relative in ARTIFACTS:
                shutil.copyfile(ROOT / relative, work / Path(relative).name)
            # Every registered Coq module is compiled, assumption-audited and
            # mutation-tested. Compiling only the module named here is how
            # MultiSigPolicy.v came to sit in the tree unchecked while the run
            # still reported PASS.
            report["coqDeclarations"] = {}
            report["coqMutationsRejected"] = {}
            for module, mutations in COQ_MODULES.items():
                require(f"coq/{module}" in ARTIFACTS, f"Unregistered Coq module: {module}")
                require(bool(mutations), f"Coq module without mutations: {module}")
                source = (work / module).read_text()
                names = coq_declarations(source)
                rc, out = run([coqc, "-q", module], work, logs, "coq-" + module)
                require(rc == 0 and out.count("Closed under the global context") == len(names)
                        and "Axioms:" not in out,
                        f"Coq compilation/assumption audit failed: {module}")
                report["coqDeclarations"][module] = len(names)
                for name, (old, new) in mutations.items():
                    mutant = replace_once(source, old, new)
                    directory = work / ("coq-" + name)
                    directory.mkdir()
                    (directory / module).write_text(mutant)
                    # First compile just the definitions: a malformed mutation is
                    # not proof evidence.
                    prefix = re.split(r"^(?:Lemma|Theorem|Corollary|Proposition|Fact|Example|Remark) ",
                                      mutant, maxsplit=1, flags=re.M)[0]
                    (directory / "Definitions.v").write_text(prefix)
                    rc, out = run([coqc, "-q", "Definitions.v"], directory, logs, name + "-definitions")
                    require(rc == 0, f"Invalid model mutation: {name}")
                    rc, out = run([coqc, "-q", module], directory, logs, name + "-mutant")
                    require(rc != 0 and "Error:" in out and "Syntax error" not in out,
                            f"Coq mutation escaped or failed without proof rejection: {name}")
                report["coqMutationsRejected"][module] = list(mutations)
            command = [java, "-Xmx1g", "-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC",
                       "-workers", "1", "-coverage", "1", "-config", "UnifiedSmartWalletAA.cfg",
                       "UnifiedSmartWalletAA.tla"]
            rc, out = run(command, work, logs, "tlc")
            report["tlc"] = parse_tlc(out, rc)
            report["toolVersions"]["tlc"] = out.splitlines()[0]
            model = (work / "UnifiedSmartWalletAA.tla").read_text()
            for name, (old, new, invariant) in TLA_MUTATIONS.items():
                directory = work / ("tla-" + name)
                directory.mkdir()
                shutil.copyfile(work / "UnifiedSmartWalletAA.cfg", directory / "UnifiedSmartWalletAA.cfg")
                (directory / "UnifiedSmartWalletAA.tla").write_text(replace_once(model, old, new))
                rc, out = run(command, directory, logs, "tlc-" + name + "-mutant")
                require(rc != 0 and f"Invariant {invariant} is violated" in out,
                        f"TLC mutation did not produce the expected counterexample: {name}")
            report["tlcMutationsRejected"] = list(TLA_MUTATIONS)
            smt = (work / "aa_core.smt2").read_text()
            rc, out = run([z3, "-T:120", "aa_core.smt2"], work, logs, "z3")
            report["smt"] = parse_smt(smt, out, rc)
        # Detect edits made while the tools were running.
        check_inventory()
        require(json.loads((ROOT / "source-lock.json").read_text()) == source_lock, "Source lock changed during this run")
        check_native_core_sources(source_lock, args.native_core_root)
        require(artifact_hashes() == report["artifactSha256"], "Model artifacts changed during this run")
        report["modelChecksPassed"] = True
        coq_mutation_count = sum(len(m) for m in COQ_MODULES.values())
        print(f"PASS: AA model checks over {len(COQ_MODULES)} Coq modules, MultiSig bounded "
              f"model, source snapshot gate and "
              f"{coq_mutation_count + len(TLA_MUTATIONS)} semantic mutations")
        return 0
    except (ValueError, OSError, KeyError, subprocess.TimeoutExpired) as error:
        report["failure"] = str(error)
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    finally:
        report_path.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    sys.exit(main())
