
The product is the **Neo Smart Account — SA**. "AA" survives only where it names
Ethereum account abstraction (ERC-4337/7579/7702/7715). The protocol string
switch is complete: the EIP-712 domain name is `"Neo Smart Account"` and the
`sa_contract` / `sa_proxy` wire keys use the SA prefixes. Tickets signed under
the pre-switch domain cut off at that switch. Every document below uses SA for
this system.

Start with the root [README](../README.md); this index is the map, not the manual.
The former flat topic pages were merged into six reader-role books (docs role-based
reorganization, phase 1), and the seven process documents were merged into two
engineering books under [engineering/](engineering/) (phase 2); each book opens with
a chapter table of contents. The frontend help pages under `frontend/src/assets/docs/`
are generated slices of these books: after editing one, regenerate them with
`npm run sync:docs` in `frontend/` (or `node scripts/sync-frontend-docs.mjs`).

## Where to go by role

| Reader | Read this | What it answers |
| --- | --- | --- |
| Users and wallet operators | [GUIDE.md](GUIDE.md) · [中文](GUIDE.zh-CN.md) | The end-to-end mental model plus practical operator / signer usage guide, quick reference, transaction lifecycle and submission flows, native account workspace, transaction guards, recovery and operational sessions, threshold recovery, signed transaction import (merged from HOW_IT_WORKS, QUICK_REFERENCE, WORKFLOWS, the four NATIVE_ACCOUNT_* pages and RECOVERY_AND_SESSIONS) |
| DApp / SDK developers | [SDK.md](SDK.md) · [中文](SDK.zh-CN.md) | Native SDK usage, threshold sessions, EIP-712 signing, proxy transfers, pending config-update reads (merged from NATIVE_SDK, MULTISIG_SDK, SA-EIP-712-SPEC, SA-PROXY-TRANSFERS, PENDING_CONFIG_UPDATE_READ_ABI) |
| Module (plugin) developers | [SA-MODULE-PROTOCOL.md](SA-MODULE-PROTOCOL.md) · [中文](SA-MODULE-PROTOCOL.zh-CN.md) | The protocol v4 shared module specification for both kernels, with the English-only "Appendix: Module developer guide" for plugin security, lifecycle and cleanup |
| Architects | [ARCHITECTURE.md](ARCHITECTURE.md) · [中文](ARCHITECTURE.zh-CN.md) — and — [SECURITY.md](SECURITY.md) · [中文](SECURITY.zh-CN.md) | Architecture book: technical architecture, native system architecture, repository layout and verification map, system status and capability boundaries, data flow and storage, the Ethereum AA comparison (merged from architecture, NATIVE_SYSTEM_ARCHITECTURE, ORGANIZATION, SA-SYSTEM-STATUS, DATA_FLOW and ETHEREUM_AA_COMPARISON); security book: the current threat model and trust assumptions, with the protocol completeness audit (Appendix A) and frontend dependency security assessment (Appendix B) |
| Node operators and operations | [OPERATIONS.md](OPERATIONS.md) · [中文](OPERATIONS.zh-CN.md) | Dry-run-first testnet validation and read-only mainnet validation runbooks, post-deployment frontend smoke checklist, measured native budgets and fee behaviour (merged from validation-runbooks, POST_DEPLOY_SMOKE_TEST and NATIVE_ACCOUNT_PERFORMANCE) |
| Full protocol specification | [Neo-Smart-Account-Documentation-zh-CN.pdf](Neo-Smart-Account-Documentation-zh-CN.pdf) | The complete specification manuscript (Chinese, PDF) |

## Language policy

English is the normative text. The six role books and this index carry a Chinese
counterpart named `<name>.zh-CN.md`, kept structurally identical, and each Chinese
file states in its first paragraph that the English file wins on conflict. The
process, verification, audit and handoff layer — closure gates, formal
verification, per-entrypoint closure, frontend correspondence, migration
manifest, contract handoff, the build-reproducibility record and the unlocked
proposals — is English-only: these chapters change with every gate run and a
stale translation would misstate the evidence.
[SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md) remains the Chinese reading guide to that
layer.

| Coverage | Documents | Note |
| --- | --- | --- |
| Bilingual (EN + `.zh-CN.md`) | The six role books, the module protocol book, this index, the root README, four native proposals | 12 pairs |
| English only | The two engineering books under [engineering/](engineering/) and the unlocked proposals | 5 documents; the Chinese index keeps their entries with an English-only note |

## Engineers and process records

The process layer (EN only) changes with every gate run. The docs reorganization,
phase 2, merged the seven former process documents into two books under
[engineering/](engineering/), each opening with a chapter table of contents:

- [engineering/VERIFICATION-AND-GATES.md](engineering/VERIFICATION-AND-GATES.md) — SA formal verification (bounded Coq models, runtime correspondence, open boundaries), the reproducible build (pinned toolchain, byte-for-byte rebuild, pin bumps), the integrated refinement closure gate that decides whether any entrypoint counts as verified, the per-entrypoint closure inventory, and the legacy-to-v4 migration manifest with its idempotency rules
- [engineering/HANDOFF-RECORDS.md](engineering/HANDOFF-RECORDS.md) — the kernel-checked contract-internal handoff (eighteenth gate scope) and the source-frontend-to-compiler correspondence of record
- Chinese guide to this layer: [SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md)
- Build packaging: [../sdk/js/PACKAGING.md](../sdk/js/PACKAGING.md) and the audited Neo platform package pins in [../contracts/neo-platform-packages.json](../contracts/neo-platform-packages.json) (behind the SA reproducible-build chapter)

The closure receipt is fail-closed on purpose: `status: NO-GO` with zero verified
entrypoints is the honest state, not a regression. Current integrated receipt:
[reports/sa-closure-gate-20261117.json](reports/sa-closure-gate-20261117.json).

## Native SmartAccount design record (proposals)

- [proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md](proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.md) · [中文](proposals/SMARTACCOUNT-NATIVE-PROFILE-DRAFT.zh-CN.md) — normative ABI 2 draft (Neo proposals #242/#243)
- [proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.md](proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.md) · [中文](proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.zh-CN.md) — six native artifacts, packaging, formal boundary
- [proposals/SMARTACCOUNT-NATIVE-MULTISIG.md](proposals/SMARTACCOUNT-NATIVE-MULTISIG.md) · [中文](proposals/SMARTACCOUNT-NATIVE-MULTISIG.zh-CN.md) — composite verifier, ephemeral approval receipt, argument isolation
- [proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.md](proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.md) · [中文](proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.zh-CN.md) — module lifecycle and recovery revocation
- [proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.md](proposals/SMARTACCOUNT-NATIVE-PRIVATE-VALIDATION.md) — source-built runtime, proxy, configuration and recovery evidence (EN only)
- [proposals/smartaccount-native-profile-v2-vectors.json](proposals/smartaccount-native-profile-v2-vectors.json) — current authorization and execution vectors
- [proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md) — required protocol sections, evidence, open activation gates (EN only)
- [proposals/SA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.md](proposals/SA-VERIFIER-GAS-BUDGET-EXTENSION-20260920.md) — NeoVM/DevPack verifier-budget extension (EN only)
- [proposals/nep-smartaccount-entry-verifier.mediawiki](proposals/nep-smartaccount-entry-verifier.mediawiki) — NEP draft for the entry verifier
- [contracts/plugins/templates/](../contracts/plugins/templates/) — minimal verifier/hook starting points (`README.md` inside)
- [reports/sa-native-open-boundaries-20261008.json](reports/sa-native-open-boundaries-20261008.json) — claims local tests and model proofs do not establish

Earlier native receipts describe their recorded source and runtime only. They do not
validate the current ABI 2 envelope, and a receipt absent from this checkout is not
current release evidence.

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
them.

## Matrix domain

Same-transaction SA creation plus `.matrix` registration is supported for compatible
Neo wallets. `.matrix` resolves a human-readable name to a controlling address; the
frontend then reads the core's per-account state (`getAccount`, the derived
proxy and the account control record) to confirm the account behind that address. The
contract exposes no reverse index from an owner address to its accounts, so a
`.matrix` name is a starting point for a lookup, not proof of account ownership.
