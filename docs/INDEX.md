# Documentation Index

The product is the **Neo Smart Account — SA**. "AA" survives only where it names
Ethereum account abstraction (ERC-4337/7579/7702/7715). The protocol string
switch is complete: the EIP-712 domain name is `"Neo Smart Account"` and the
`sa_contract` / `sa_proxy` wire keys use the SA prefixes. Tickets signed under
the pre-switch domain cut off at that switch. Every document below uses SA for
this system.

Start with the root [README](../README.md); this index is the map, not the manual.

## Language policy

English is the normative text. Every document in this index carries a Chinese
counterpart named `<name>.zh-CN.md`; the two versions are kept structurally
identical, and a Chinese file states in its first paragraph that the English file
wins on conflict. That covers the reading path, the native set, account
operations, the security model, the runtime specification, the closure and
formal-verification chapters, build and packaging, and the reference material
(guides, runbooks and audits). [SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md) remains the
Chinese reading guide to the chapter set.

| Coverage | Documents | Note |
| --- | --- | --- |
| Bilingual (EN + `.zh-CN.md`) | Protocol, architecture, account, closure and reference documents | 56 pairs; the four dated `reports/*.md` snapshots remain English-only |

## Start here

| Document | What it answers | Language |
| --- | --- | --- |
| [SA-SYSTEM-STATUS.md](SA-SYSTEM-STATUS.md) | What is built, deployed, verified — and what is not | EN · [中文](SA-SYSTEM-STATUS.zh-CN.md) |
| [HOW_IT_WORKS.md](HOW_IT_WORKS.md) | End-to-end mental model and usage guide | EN · [中文](HOW_IT_WORKS.zh-CN.md) |
| [USER_GUIDE.md](USER_GUIDE.md) | Practical operator / signer steps | EN · [中文](USER_GUIDE.zh-CN.md) |
| [QUICK_REFERENCE.md](QUICK_REFERENCE.md) | Commands and quick lookup | EN · [中文](QUICK_REFERENCE.zh-CN.md) |
| [WORKFLOWS.md](WORKFLOWS.md) | Transaction lifecycle and submission flows | EN · [中文](WORKFLOWS.zh-CN.md) |
| [DATA_FLOW.md](DATA_FLOW.md) | Browser / Supabase / relay / chain boundaries | EN · [中文](DATA_FLOW.zh-CN.md) |
| [architecture.md](architecture.md) | Technical architecture details | EN · [中文](architecture.zh-CN.md) |
| [NEOOS_ARCHITECTURE.md](NEOOS_ARCHITECTURE.md) | Where this repository sits in the NeoOS workspace architecture (pointer) | EN · [中文](NEOOS_ARCHITECTURE.zh-CN.md) |
| [ORGANIZATION.md](ORGANIZATION.md) | Repository layout and the verification map | EN · [中文](ORGANIZATION.zh-CN.md) |
| [SA-IMPLEMENTATION-STRATEGY.md](SA-IMPLEMENTATION-STRATEGY.md) | The two implementation paths and their delivery boundaries | EN · [中文](SA-IMPLEMENTATION-STRATEGY.zh-CN.md) |

## Native SmartAccount

- [NATIVE_SYSTEM_ARCHITECTURE.md](NATIVE_SYSTEM_ARCHITECTURE.md) · [中文](NATIVE_SYSTEM_ARCHITECTURE.zh-CN.md) — identity, authorities, execution, recovery, fees, activation
- [NATIVE_SDK.md](NATIVE_SDK.md) · [中文](NATIVE_SDK.zh-CN.md) — ABI discovery, account plans, signed transactions
- [NATIVE_ACCOUNT_WORKSPACE.md](NATIVE_ACCOUNT_WORKSPACE.md) · [中文](NATIVE_ACCOUNT_WORKSPACE.zh-CN.md) — discovery, registration, backup, wallet boundaries
- [NATIVE_ACCOUNT_USER_GUIDE.md](NATIVE_ACCOUNT_USER_GUIDE.md) · [中文](NATIVE_ACCOUNT_USER_GUIDE.zh-CN.md) — backups, authority matrix, key-loss decisions
- [NATIVE_ACCOUNT_TRANSACTION_GUARDS.md](NATIVE_ACCOUNT_TRANSACTION_GUARDS.md) · [中文](NATIVE_ACCOUNT_TRANSACTION_GUARDS.zh-CN.md) — exact-script cancellation guard
- [NATIVE_ACCOUNT_THRESHOLD_RECOVERY.md](NATIVE_ACCOUNT_THRESHOLD_RECOVERY.md) · [中文](NATIVE_ACCOUNT_THRESHOLD_RECOVERY.zh-CN.md) — threshold wallets as guardian, custody or payer
- [NATIVE_SIGNED_TRANSACTION_IMPORT.md](NATIVE_SIGNED_TRANSACTION_IMPORT.md) · [中文](NATIVE_SIGNED_TRANSACTION_IMPORT.zh-CN.md) — portable signed artifact and receipt recovery
- [NATIVE_ACCOUNT_PERFORMANCE.md](NATIVE_ACCOUNT_PERFORMANCE.md) · [中文](NATIVE_ACCOUNT_PERFORMANCE.zh-CN.md) — measured budgets and fee behaviour
- [proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md](proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md) · [中文](proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.zh-CN.md) — normative ABI 2 draft (Neo proposals #242/#243)
- [proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.md](proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.md) · [中文](proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.zh-CN.md) — six native artifacts, packaging, formal boundary
- [proposals/SMARTACCOUNT-NATIVE-MULTISIG.md](proposals/SMARTACCOUNT-NATIVE-MULTISIG.md) · [中文](proposals/SMARTACCOUNT-NATIVE-MULTISIG.zh-CN.md) — composite verifier, ephemeral approval receipt, argument isolation
- [proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.md](proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.md) · [中文](proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.zh-CN.md) — module lifecycle and recovery revocation
- [proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.md](proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.md) · [中文](proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.zh-CN.md) — source-built runtime, proxy, configuration and recovery evidence
- [proposals/smartaccount-native-profile-v2-vectors.json](proposals/smartaccount-native-profile-v2-vectors.json) — current authorization and execution vectors
- [proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md) · [中文](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.zh-CN.md) — required protocol sections, evidence, open activation gates
- [reports/sa-native-open-boundaries-20261008.json](reports/sa-native-open-boundaries-20261008.json) — claims local tests and model proofs do not establish

Earlier native receipts describe their recorded source and runtime only. They do not
validate the current ABI 2 envelope, and a receipt absent from this checkout is not
current release evidence.

## SA runtime specification

- [SA-EIP-712-SPEC.md](SA-EIP-712-SPEC.md) · [中文](SA-EIP-712-SPEC.zh-CN.md) — typed-data layout the verifiers hash on-chain
- [SA-IMPLEMENTATION-REFINEMENT.md](SA-IMPLEMENTATION-REFINEMENT.md) · [中文](SA-IMPLEMENTATION-REFINEMENT.zh-CN.md) — refinement scope and acceptance conditions
- [SA-METHOD-REFINEMENT.md](SA-METHOD-REFINEMENT.md) · [中文](SA-METHOD-REFINEMENT.zh-CN.md) — every method-level lane in one document, each keeping its own scope: artifact inventory, source projection, reference VM, runtime checks, arithmetic, fee semantics, public bodies, syscall admission, interop conversion and charge, exception identity
- [SA-PROXY-TRANSFERS.md](SA-PROXY-TRANSFERS.md) · [中文](SA-PROXY-TRANSFERS.zh-CN.md) — direct proxy witness construction, fee policy, sponsorship refusal
- [SA-MODULE-PROTOCOL.md](SA-MODULE-PROTOCOL.md) · [中文](SA-MODULE-PROTOCOL.zh-CN.md) — protocol v4 shared module specification for both kernels
- [SA-MIGRATION-MANIFEST.md](SA-MIGRATION-MANIFEST.md) · [中文](SA-MIGRATION-MANIFEST.zh-CN.md) — legacy-to-v4 migration manifest and idempotency rules
- [SA-CONTRACT-HANDOFF.md](SA-CONTRACT-HANDOFF.md) · [SA-FRONTEND-CORRESPONDENCE.md](SA-FRONTEND-CORRESPONDENCE.md) — contract/SDK/frontend contracts of record ([中文](SA-CONTRACT-HANDOFF.zh-CN.md) · [中文](SA-FRONTEND-CORRESPONDENCE.zh-CN.md))
- Chinese guide to this whole chapter set: [SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md)

## Closure and formal verification

- [SA-CLOSURE-GATE.md](SA-CLOSURE-GATE.md) · [中文](SA-CLOSURE-GATE.zh-CN.md) — the gate that decides whether any entrypoint counts as verified
- [SA-ENTRYPOINT-CLOSURE.md](SA-ENTRYPOINT-CLOSURE.md) · [中文](SA-ENTRYPOINT-CLOSURE.zh-CN.md) — per-entrypoint closure rules
- [SA-FORMAL-VERIFICATION.md](SA-FORMAL-VERIFICATION.md) · [中文](SA-FORMAL-VERIFICATION.zh-CN.md) — bounded Coq models, runtime correspondence, open boundaries
- [reports/sa-closure-gate-20261117.json](reports/sa-closure-gate-20261117.json) — current integrated receipt: scoped PASS, **NO-GO** for full implementation

The closure receipt is fail-closed on purpose: `status: NO-GO` with zero verified
entrypoints is the honest state, not a regression.

## Accounts, recovery and operations

- [ACCOUNT_RECOVERY_AND_IDENTITY.md](ACCOUNT_RECOVERY_AND_IDENTITY.md) · [中文](ACCOUNT_RECOVERY_AND_IDENTITY.zh-CN.md) — recovery limits and canonical identity reads
- [OPERATOR_KEY_RECOVERY.md](OPERATOR_KEY_RECOVERY.md) · [中文](OPERATOR_KEY_RECOVERY.zh-CN.md) — encrypted operator backups and browser recovery
- [MORPHEUS_PRIVATE_ACTIONS.md](MORPHEUS_PRIVATE_ACTIONS.md) · [中文](MORPHEUS_PRIVATE_ACTIONS.zh-CN.md) — recovery verifier and private actions
- [action-sessions.md](action-sessions.md) · [中文](action-sessions.zh-CN.md) — session-key scoping, expiry and reauthorization
- [MULTISIG_SDK.md](MULTISIG_SDK.md) · [MULTISIG_CHILD_CONFIGURATION.md](MULTISIG_CHILD_CONFIGURATION.md) — multisig bundles and child proofs ([中文](MULTISIG_SDK.zh-CN.md) · [中文](MULTISIG_CHILD_CONFIGURATION.zh-CN.md))
- [PENDING_CONFIG_UPDATE_READ_ABI.md](PENDING_CONFIG_UPDATE_READ_ABI.md) · [中文](PENDING_CONFIG_UPDATE_READ_ABI.zh-CN.md) — config-update read surface
- [CUSTOM_ACCOUNT_WORKSPACE.md](CUSTOM_ACCOUNT_WORKSPACE.md) · [中文](CUSTOM_ACCOUNT_WORKSPACE.zh-CN.md) — custom-profile workspace
- [mainnet-validation-runbook.md](mainnet-validation-runbook.md) · [中文](mainnet-validation-runbook.zh-CN.md) — read-only mainnet validation
- [TESTNET_QUICKSTART.md](TESTNET_QUICKSTART.md) · [中文](TESTNET_QUICKSTART.zh-CN.md) — the two commands to run before any live testnet validation
- [testnet-validation-runbook.md](testnet-validation-runbook.md) · [中文](testnet-validation-runbook.zh-CN.md) — dry-run-first testnet validation
- [POST_DEPLOY_SMOKE_TEST.md](POST_DEPLOY_SMOKE_TEST.md) · [中文](POST_DEPLOY_SMOKE_TEST.zh-CN.md) — post-deployment frontend checklist

## Security, audit and comparisons

- [SECURITY_MODEL.md](SECURITY_MODEL.md) · [中文](SECURITY_MODEL.zh-CN.md) — current threat model and trust assumptions
- [PROTOCOL_COMPLETENESS_AUDIT.md](PROTOCOL_COMPLETENESS_AUDIT.md) · [中文](PROTOCOL_COMPLETENESS_AUDIT.zh-CN.md) — protocol coverage and known boundaries
- [ETHEREUM_AA_COMPARISON.md](ETHEREUM_AA_COMPARISON.md) · [中文](ETHEREUM_AA_COMPARISON.zh-CN.md) — Ethereum AA (4337/7702/7579/7715) alignment and deliberate divergences
- [FRONTEND_DEPENDENCY_SECURITY.md](FRONTEND_DEPENDENCY_SECURITY.md) · [中文](FRONTEND_DEPENDENCY_SECURITY.zh-CN.md) — frontend dependency exposure
- [PLUGIN_DEVELOPER_GUIDE.md](PLUGIN_DEVELOPER_GUIDE.md) · [中文](PLUGIN_DEVELOPER_GUIDE.zh-CN.md) — supported verifier/hook plugins, lifecycle and cleanup
- [contracts/plugins/templates/](../contracts/plugins/templates/) — minimal verifier/hook starting points (`README.md` inside)
- [proposals/SA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.md](proposals/SA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.md) · [中文](proposals/SA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.zh-CN.md) — NeoVM/DevPack verifier-budget extension
- [proposals/nep-smartaccount-entry-verifier.mediawiki](proposals/nep-smartaccount-entry-verifier.mediawiki) — NEP draft for the entry verifier

## Build and packaging

- [SA-REPRODUCIBLE-BUILD.md](SA-REPRODUCIBLE-BUILD.md) · [中文](SA-REPRODUCIBLE-BUILD.zh-CN.md) — pinned toolchain, byte-for-byte rebuild, pin bumps
- [NEO-PLATFORM-PACKAGES.md](NEO-PLATFORM-PACKAGES.md) · [中文](NEO-PLATFORM-PACKAGES.zh-CN.md) · [../contracts/neo-platform-packages.json](../contracts/neo-platform-packages.json) — audited package pins enforced by `scripts/check_neo_platform_packages.mjs`
- [../sdk/js/PACKAGING.md](../sdk/js/PACKAGING.md) — independently installable SDK package

## Evidence receipts

`docs/reports/` holds dated machine receipts. A receipt is evidence only for the
commit, artifacts and runtime it names; it is never a statement about the current
tree. The current pinned set:

| Receipt | Covers |
| --- | --- |
| [sa-closure-gate-20261117.json](reports/sa-closure-gate-20261117.json) | integrated closure, NO-GO |
| [sa-artifact-reproducibility-20261116.json](reports/sa-artifact-reproducibility-20261116.json) | byte-identical artifact rebuild |
| [sa-formal-gate-20261031.json](reports/sa-formal-gate-20261031.json) | Coq gate and mutation set |
| [sa-neoexpress-validation-20261031.json](reports/sa-neoexpress-validation-20261031.json) | private-chain deployment and readback |
| [sa-ordinary-candidate-compatibility-20261116.json](reports/sa-ordinary-candidate-compatibility-20261116.json) | custom-profile candidate matrix |

Historical and superseded receipts stay only where a guard or a formal scope pins
them. [reports/testnet-validation-v1v2-2026-03.md](reports/testnet-validation-v1v2-2026-03.md)
is the archived pre-V3 status.

## Matrix domain

Same-transaction SA creation plus `.matrix` registration is supported for compatible
Neo wallets. `.matrix` resolves a human-readable name to a controlling address; the
frontend then reads the core's per-account state (`getAccountState`, the derived
proxy and the bound verifier) to confirm the account behind that address. The
contract exposes no reverse index from an owner address to its accounts, so a
`.matrix` name is a starting point for a lookup, not proof of account ownership.
