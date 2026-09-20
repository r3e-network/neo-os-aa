# Documentation Index

This index keeps the root documentation set visible and easy to browse.

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

- `docs/AA-FORMAL-VERIFICATION.md` — AA formal-model, runtime-correspondence and boundary report
- `docs/proposals/AA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.md` — exact NeoVM/DevPack verifier-budget extension and integration gates
- `docs/SECURITY_MODEL.md` — current threat model and trust assumptions
- `docs/reports/aa-protocol-security-build-20260918.json` — reproducible local artifact and security-regression receipt
- `docs/reports/aa-neoexpress-readback-20260918.json` — isolated NeoExpress deployment/readback receipt; public-chain parity remains unverified
- `docs/reports/aa-neoexpress-readback-20260919.json` — historical pre-callback-ABI-fix NeoExpress readback; superseded by the 2026-09-20 receipt
- `docs/reports/aa-neoexpress-readback-20260920.json` — historical post-callback-ABI readback; superseded by the current post-remediation receipt
- `docs/reports/aa-neoexpress-readback-20260920-current.json` — post-remediation core NeoExpress readback of the core artifact before the branch-free reimbursement cap; local NEF/manifest parity verified then, public artifacts differ
- `docs/reports/aa-neoexpress-validation-20260920.json` — full private-chain validation of the current artifacts: all 24 deployed to a fresh NeoExpress chain, 10 transaction-driven scenarios (65 halted transactions, 23 expected faults, 51 on-chain assertions), RPC readback parity for every contract; local-chain evidence only
- `docs/reports/aa-public-readback-20260920.json` — read-only TestNet/MainNet AA core readback; known public artifacts differ from the current local artifact
- `docs/reports/aa-platform-gas-cap-20260920.json` — isolated Neo core/DevPack verifier-budget prototype receipt; AA integration and hardfork activation remain pending
- `docs/reports/aa-current-revalidation-20260920.json` — independent read-only revalidation receipt; local runtime gates pass, while that environment's formal runner was unavailable and public parity remains open
- `docs/SECURITY_AUDIT.md`
- `docs/ETHEREUM_AA_COMPARISON.md`
- `docs/PLUGIN_MATRIX.md`
- `docs/PLUGIN_DEVELOPER_GUIDE.md`
- `SECURITY_IMPROVEMENTS.md` — historical 2026-03-09 hardening note (pre-V3 tree)

## Historical Reports

- `docs/reports/testnet-validation-v1v2-2026-03.md` — archived pre-V3 (V1/V2) testnet validation status

## Matrix Domain Support

- same-transaction AA creation plus `.matrix` registration is supported for compatible Neo wallets
- `.matrix` resolution is used to discover linked AA addresses through admin/manager indexes
