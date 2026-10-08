# Documentation Index

This index keeps the root documentation set visible and easy to browse.

## Native SmartAccount validation

- `docs/proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.md` — native module ABI, authority, signing and lifecycle requirements
- `docs/AA-FORMAL-VERIFICATION.md` — current bounded proof scope and remaining refinement boundaries
- `docs/proposals/SMARTACCOUNT-NATIVE-NEF-PROBES.md` — unchanged-bytecode host probes, fault-injection boundary and complete coverage denominators
- `docs/reports/aa-native-nef-phases-validation-20261008.json` — current pre/post balance-type representatives, phase and callback shape rejection, rollback and measured incomplete bytecode coverage
- `docs/reports/aa-native-nef-probe-validation-20261008.json` — earlier pre-phase probe with missing/stale snapshots, administration and historical coverage measurements
- `docs/reports/aa-native-restricted-validation-20261008.json` — native restricted-token adaptation, indirect movement, hostile-query rollback, independent replay and five-profile regression evidence
- `docs/reports/aa-native-session-scope-validation-20261007.json` — current uncapped/wildcard semantics, complete grant/storage observations and identical-signature key-reuse counterexamples on two private chains
- `docs/reports/aa-native-session-lifecycle-validation-20261007.json` — actual P-256/GAS witness, rotation, cap, revocation and independent private replay evidence
- `docs/reports/aa-native-daily-balance-validation-20261007.json` — current native daily-limit malformed/faulting query rejection, raw-storage rollback, delayed recovery and independent private replay evidence
- `docs/reports/aa-native-daily-capacity-validation-20261007.json` — earlier capacity repair, actual false-result outflow and callback-isolation evidence
- `docs/reports/aa-native-daily-validation-20261007.json` — earlier daily-limit snapshot before the single-pass capacity repair
- `docs/reports/aa-formal-gate-native-nef-phases-20261008.json` — current host-only gate: 24 Coq modules, 349 closed declarations and 192 rejected mutations; not implementation refinement
- `docs/reports/aa-artifact-reproducibility-native-restricted-20261008.json` — current legacy-profile rebuild comparison: 76 artifacts; native artifacts have separate build receipts
- `docs/reports/aa-open-formal-boundaries-20261007.json` — unclosed proof obligations; public-chain deployment remains excluded

## Core Explainers

- `docs/HOW_IT_WORKS.md` — end-to-end mental model and usage guide
- `docs/USER_GUIDE.md` — practical operator / signer usage steps
- `docs/WORKFLOWS.md` — transaction lifecycle and submission flows
- `docs/DATA_FLOW.md` — browser / Supabase / relay / chain boundaries
- `docs/architecture.md` — technical architecture details
- `docs/QUICK_REFERENCE.md` — commands and quick lookup material
- `docs/POST_DEPLOY_SMOKE_TEST.md` — post-deployment frontend smoke-test checklist

## Chinese Counterparts

- `docs/HOW_IT_WORKS.zh-CN.md`
- `docs/USER_GUIDE.zh-CN.md`
- `docs/WORKFLOWS.zh-CN.md`
- `docs/DATA_FLOW.zh-CN.md`
- `docs/architecture.zh-CN.md`
- `docs/QUICK_REFERENCE.zh-CN.md`
- `docs/MORPHEUS_PRIVATE_ACTIONS.zh-CN.md`

## Recovery Verifier

- `contracts/recovery/README.md`
- `contracts/recovery/PRE_DEPLOYMENT_CHECKLIST.md`
- `contracts/recovery/TEST_STATUS.md`
- `contracts/recovery/TESTNET_VALIDATION_2026-03-09.md`
- `docs/MORPHEUS_PRIVATE_ACTIONS.md`
- `docs/MORPHEUS_PRIVATE_ACTIONS.zh-CN.md`

## Paymaster / Sponsored Transactions

- `docs/PAYMASTER_RELAY_VALIDATION.md` — Morpheus off-chain paymaster relay validation
- `contracts/paymaster/Paymaster.cs` — on-chain `AAPaymaster` contract (deposits, policies, settlement)
- `contracts/paymaster/PaymasterAuthority.cs` — authority pattern for Paymaster admin and core validation
- `contracts/UnifiedSmartWallet.Paymaster.cs` — AA core integration (`executeSponsoredUserOp`)

## Security Notes

- `docs/proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md` — normative native profile draft for Issue #242, including identity, activation, state, lifecycle, resource, governance, migration, and conformance rules
- `docs/proposals/smartaccount-native-profile-v1-vectors.json` — machine-readable version-1 identity and authorization vectors
- `docs/proposals/validate-native-smartaccount-profile.py` — deterministic profile and vector validation
- `docs/AA-FORMAL-VERIFICATION.md` — AA formal-model, runtime-correspondence and boundary report
- `docs/proposals/AA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.md` — exact NeoVM/DevPack verifier-budget extension and integration gates
- `docs/SECURITY_MODEL.md` — current threat model and trust assumptions
- `docs/reports/aa-protocol-security-build-20260918.json` — reproducible local artifact and security-regression receipt
- `docs/reports/aa-neoexpress-readback-20260918.json` — isolated NeoExpress deployment/readback receipt; public-chain parity remains unverified
- `docs/reports/aa-neoexpress-readback-20260919.json` — historical pre-callback-ABI-fix NeoExpress readback; superseded by the 2026-09-20 receipt
- `docs/reports/aa-neoexpress-readback-20260920.json` — historical post-callback-ABI readback; superseded by the current post-remediation receipt
- `docs/reports/aa-neoexpress-readback-20260920-current.json` — post-remediation core NeoExpress readback of the core artifact before the branch-free reimbursement cap; local NEF/manifest parity verified then, public artifacts differ
- `docs/reports/aa-neoexpress-validation-20260920.json` — historical private-chain validation of that snapshot: all 24 deployed to a fresh NeoExpress chain, 10 transaction-driven scenarios (65 halted transactions, 23 expected faults, 51 on-chain assertions), RPC readback parity for every contract; local-chain evidence only
- `docs/reports/aa-artifact-reproducibility-20261006.json` — historical source-to-release rebuild certificate: 76 artifacts compared, with no drift or missing artifacts at that snapshot
- `docs/reports/aa-neoexpress-validation-20261006.json` — matching-core NeoExpress validation of that snapshot: 25 deployments, 14 scenarios, 108 persisted transactions, 84 assertions, and complete private RPC readback parity; not a release approval
- `docs/reports/aa-neo-core-semantic-validation-20261006.json` — read-only Neo core executable validation at `c033cd55`: 1,453/1,453 core tests passed, including 26 WitnessCondition and 150 ApplicationEngine/interop tests
- `docs/reports/aa-neoexpress-validation-20261005-unmatched-runner.json` — failed fail-closed rerun with the incompatible installed 3.10.1.18 runner; retained as runner-incompatibility evidence, not protocol evidence
- `docs/reports/aa-neoexpress-gas-cap-20260921.json` — historical matching-core private-chain validation: 25 artifacts, 12 scenarios, adversarial verifier gas-cap fault and nonce rollback, and RPC readback parity; no public network touched
- `docs/reports/aa-public-readback-20260920.json` — read-only TestNet/MainNet AA core readback; known public artifacts differ from the current local artifact
- `docs/reports/aa-platform-gas-cap-20260920.json` — isolated Neo core/DevPack verifier-budget prototype receipt; AA integration and hardfork activation remain pending
- `docs/reports/aa-platform-gas-cap-20260921.json` — historical Neo core/DevPack plus AA integration receipt; private NeoExpress verified at that snapshot, public activation/deployment pending
- `docs/reports/aa-formal-gate-20260921.json` — historical 5-Coq-module/30-mutation formal gate with cached-base Docker BuildKit evidence and 20/20 runner tests
- `docs/reports/aa-artifact-reproducibility-20260921.json` — 76 NEF/manifest artifacts reproduced byte-for-byte from that source snapshot; the historical `contracts/build` anchor is explicitly reported as intentional drift
- `docs/reports/aa-private-artifact-provenance-20261006.json` — historical read-only join of a 74-input source/rebuild certificate to 24 local artifacts and the matching private NeoExpress RPC readback
- `docs/reports/aa-formal-gate-20261006-witness-refinement.json` — historical fail-closed formal gate: 16 Coq modules, 86 semantic mutations rejected, 61,460 TLC states, 6 SMT obligations, and 37/37 runner tests
- That earlier formal receipt records a pinned Docker reproduction: Coq 8.18, Z3 4.8.12, OpenJDK 21, TLA+ 2026.10.04, and 37/37 runner tests. It does not cover the current model set, whose container execution remains unverified.
- `docs/reports/aa-open-formal-boundaries-20261006.json` — explicit open-boundary ledger; no complete NeoVM/compiler refinement, primitive crypto/attestation/ZK soundness proof, private-key independence proof, or arbitrary-future-plugin storage proof is claimed
- `docs/reports/aa-current-revalidation-20260920.json` — independent read-only revalidation receipt; local runtime gates pass, while that environment's formal runner was unavailable and public parity remains open
- `docs/SECURITY_AUDIT.md`
- `docs/ETHEREUM_AA_COMPARISON.md`
- `docs/PLUGIN_MATRIX.md`
- `docs/PLUGIN_DEVELOPER_GUIDE.md`
- `SECURITY_IMPROVEMENTS.md` — historical 2026-03-09 hardening note (pre-V3 tree)

## Build Toolchain

- `docs/NEO-PLATFORM-PACKAGES.md` — why CI cannot restore the pinned private Neo framework (R-11 / N-DEP-1), what is and is not affected, and the owner action that fixes it
- `contracts/neo-platform-packages.json` — audited hashes of the eight private packages; `scripts/check_neo_platform_packages.mjs` enforces them

## Historical Reports

- `docs/reports/testnet-validation-v1v2-2026-03.md` — archived pre-V3 (V1/V2) testnet validation status

## Matrix Domain Support

- same-transaction AA creation plus `.matrix` registration is supported for compatible Neo wallets
- `.matrix` resolution is used to discover linked AA addresses through admin/manager indexes
