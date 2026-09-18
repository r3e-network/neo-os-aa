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
- `docs/SECURITY_MODEL.md` — current threat model and trust assumptions
- `docs/reports/aa-protocol-security-build-20260918.json` — reproducible local artifact and security-regression receipt
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
