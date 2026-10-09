# Documentation Index

This index keeps the root documentation set visible and easy to browse.

## Native SmartAccount

- [System architecture](NATIVE_SYSTEM_ARCHITECTURE.md) — identity, authorities, execution, recovery, fees and activation
- [Native SDK](NATIVE_SDK.md) — exact ABI discovery, account plans and signed transactions
- [Native workspace](NATIVE_ACCOUNT_WORKSPACE.md) — account discovery, registration, backup and wallet boundaries
- [Protocol profile](proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md) — normative ABI 2 draft for Neo proposals #242 and #243
- [Module profiles](proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.md) — supported native modules and lifecycle requirements
- [Authority epochs](proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.md) — recovery revocation and module storage isolation
- [ABI 2 vectors](proposals/smartaccount-native-profile-v2-vectors.json) — current authorization and execution commitments
- [Formal scope](AA-FORMAL-VERIFICATION.md) — bounded models and remaining refinement boundaries
- [Open proof boundaries](reports/aa-native-open-boundaries-20261008.json) — claims that local tests and model proofs do not establish

Historical validation applies only to its recorded source and runtime. Earlier
native receipts do not validate the current ABI 2 execution envelope or recovery
semantics. Receipts absent from this checkout are not current release evidence.

## Core Explainers

- `docs/AA-SYSTEM-STATUS.md` — capability boundaries and operational prerequisites
- `docs/ACCOUNT_RECOVERY_AND_IDENTITY.md` — recovery limitations and canonical account identity reads
- `docs/OPERATOR_KEY_RECOVERY.md` — encrypted operator backups and browser recovery
- `docs/AA-PROXY-TRANSFERS.md` — direct proxy witness construction, fee policy and sponsorship refusal
- `sdk/js/PACKAGING.md` — independently installable SDK package and consumer validation
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
- `docs/reports/aa-neoexpress-gas-cap-20260921.json` — historical matching-core private-chain validation: 25 artifacts, 12 scenarios, adversarial verifier gas-cap fault and nonce rollback, and RPC readback parity; no public network touched
- `docs/reports/aa-public-readback-20260920.json` — read-only TestNet/MainNet AA core readback; known public artifacts differ from the current local artifact
- `docs/reports/aa-platform-gas-cap-20260920.json` — isolated Neo core/DevPack verifier-budget prototype receipt; AA integration and hardfork activation remain pending
- `docs/reports/aa-platform-gas-cap-20260921.json` — historical Neo core/DevPack plus AA integration receipt; private NeoExpress verified at that snapshot, public activation/deployment pending
- `docs/reports/aa-formal-gate-20260921.json` — historical 5-Coq-module/30-mutation formal gate with cached-base Docker BuildKit evidence and 20/20 runner tests
- `docs/reports/aa-artifact-reproducibility-20260921.json` — 76 NEF/manifest artifacts reproduced byte-for-byte from that source snapshot; the historical `contracts/build` anchor is explicitly reported as intentional drift
- `docs/reports/aa-current-revalidation-20260920.json` — independent read-only revalidation receipt; local runtime gates pass, while that environment's formal runner was unavailable and public parity remains open
- `docs/SECURITY_AUDIT.md`
- `docs/ETHEREUM_AA_COMPARISON.md`
- `docs/PLUGIN_MATRIX.md`
- `docs/PLUGIN_DEVELOPER_GUIDE.md`
- `SECURITY_IMPROVEMENTS.md` — historical 2026-03-09 hardening note (pre-V3 tree)

## Build Toolchain

- `docs/AA-REPRODUCIBLE-BUILD.md` — the pinned, published toolchain, how to restore, build and reproduce the AA contracts byte for byte, and how to bump a pin (R-11 / N-DEP-1)
- `docs/NEO-PLATFORM-PACKAGES.md` — published dependency pins and the separate private `PLATFORM` runtime requirement
- `contracts/neo-platform-packages.json` — audited hashes of the nine published Neo packages and the nccs compiler; `scripts/check_neo_platform_packages.mjs` enforces them together with the `packages.lock.json` files
- `docs/reports/aa-published-build-reproducibility-20261004.json` — receipt: 76 artifacts built from published packages in two clean exports at different paths, byte-identical

## Historical Reports

- `docs/reports/testnet-validation-v1v2-2026-03.md` — archived pre-V3 (V1/V2) testnet validation status

## Matrix Domain Support

- same-transaction AA creation plus `.matrix` registration is supported for compatible Neo wallets
- `.matrix` resolution is used to discover linked AA addresses through admin/manager indexes

- [Native issue 242 conformance map](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md): required protocol sections, implementation evidence and remaining public-activation gates.
