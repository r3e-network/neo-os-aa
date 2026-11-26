
The product is the **Neo Smart Account — SA**. "AA" is used only where it
names Ethereum account abstraction. Every document below uses SA for this
system.

Start with the root [README](../README.md); this index is the map, not the
manual. Documentation is organized as reader books: each opens with a chapter
table of contents. The frontend help pages under `frontend/src/assets/docs/`
are generated slices of these books: after editing one, regenerate them with
`npm run sync:docs` in `frontend/` (or `node scripts/sync-frontend-docs.mjs`).

## Where to go by role

| Reader | Read this | What it answers |
| --- | --- | --- |
| Users and wallet operators | [GUIDE.md](GUIDE.md) · [中文](GUIDE.zh-CN.md) | The end-to-end mental model, the workflow lifecycle, the native account workspace, threshold wallet authorities and signed transaction import |
| DApp / SDK developers | [SDK.md](SDK.md) · [中文](SDK.zh-CN.md) | `NativeSmartAccountClient` usage: discovery, identity, creation, account state, execution, credential generations, modules, account actions and fees, plus threshold sessions |
| Module (plugin) developers | [SA-MODULE-PROTOCOL.md](SA-MODULE-PROTOCOL.md) · [中文](SA-MODULE-PROTOCOL.zh-CN.md) · [模块 NEP 接入说明](proposals/SMARTACCOUNT-MODULE-NEPS.zh-CN.md) | Module behavior under the closed 26-method native ABI: namespaces, limits, operation encoding, signing domains, callback ABI, lifecycle and time locks, gas and cost, the capability profile and the error and event tables. Module behavior never extends the native ABI; read the [v4.1 IDL](proposals/smartaccount-v4.1.idl.json) first. The last two chapters, "Appendix: Module developer guide" and "Frontend module chooser guide", exist in English only |
| Architects | [ARCHITECTURE.md](ARCHITECTURE.md) · [中文](ARCHITECTURE.zh-CN.md) — and — [SECURITY.md](SECURITY.md) · [中文](SECURITY.zh-CN.md) | Architecture book: native system architecture, account identity and authority, execution and revocation, supported policy modules, fees and user experience, verification and activation. Security book: trust boundaries, execution security, configuration and governance, emergency containment, recovery, failure semantics, module trust assumptions, open boundaries and the frontend dependency security assessment |
| Node operators and operations | [OPERATIONS.md](OPERATIONS.md) · [中文](OPERATIONS.zh-CN.md) | Local validation, generated and pinned files, evidence rules |
| Presenters | [Neo-Smart-Account-Protocol-Design-zh-CN.pptx](Neo-Smart-Account-Protocol-Design-zh-CN.pptx) · [EN](Neo-Smart-Account-Protocol-Design-en-US.pptx) | The 48-slide protocol design deck in Chinese and English (protocol only, no implementation). Each slide carries its speaker notes and a step-by-step build animation; the standalone script, recording and subtitles are not versioned |
| Full protocol specification | [Neo-Smart-Account-Documentation-zh-CN.pdf](Neo-Smart-Account-Documentation-zh-CN.pdf) | 49 pages; a complete Chinese reading edition (PDF) derived from the authoritative [v4.1 IDL](proposals/smartaccount-v4.1.idl.json) and [SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md). It is not an independent authority: conflicts resolve to the IDL and SA-SPEC |

## Language policy

English is the normative text of the reader books. The five reader books and
this index carry a Chinese counterpart named `<name>.zh-CN.md` whose H2/H3
heading sequence matches the English book, and each Chinese file states in its
first paragraph that the English file wins on conflict. The one declared
exception is the module protocol book: chapters 1–18 are parallel and its last
two chapters, "Appendix: Module developer guide" and "Frontend module chooser
guide", exist in English only. The root README is also bilingual. A guard in
`frontend/tests/docsTruth.test.js` compares the heading sequences.

| Coverage | Documents | Note |
| --- | --- | --- |
| Bilingual (EN + `.zh-CN.md`) | The five reader books, this index, the root README, the module protocol book and three native proposals ([SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH](proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.md), [SMARTACCOUNT-NATIVE-MODULE-PROFILES](proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.md), [SMARTACCOUNT-NATIVE-MULTISIG](proposals/SMARTACCOUNT-NATIVE-MULTISIG.md)) | 11 pairs; only the module protocol book has English-only chapters (its last two) |
| English only | The NEP drafts and machine-readable files under [proposals/](proposals/) listed in "Current protocol" below, the [verification book](engineering/VERIFICATION-AND-GATES.md) and the [Morpheus registry record](engineering/MORPHEUS-REGISTRY.md) | NEP drafts are written for the Neo pipeline, which reads English; machine-readable files have no prose to translate |
| Chinese only | [SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md) and [SMARTACCOUNT-MODULE-NEPS.zh-CN.md](proposals/SMARTACCOUNT-MODULE-NEPS.zh-CN.md) | The specification and the module-NEP reading guide |

## Current protocol

There is one protocol and it is unpublished: nothing has been deployed to a public network.

| Layer | Source | Role |
| --- | --- | --- |
| Native ABI | [proposals/smartaccount-v4.1.idl.json](proposals/smartaccount-v4.1.idl.json) · [SA-SPEC.zh-CN.md](SA-SPEC.zh-CN.md) | The authority: 26 methods, 15 events, the operation encoding, nonce channels, digest and signing domain, storage layout and hardfork rules. Where prose and IDL disagree, the IDL wins. `python scripts/check_smartaccount_v41_idl.py` checks the IDL against the native attributes and the manifest fixture |
| Module behavior | [SA-MODULE-PROTOCOL.md](SA-MODULE-PROTOCOL.md) · [中文](SA-MODULE-PROTOCOL.zh-CN.md) | What validators, hooks and policy modules must do under the native ABI |
| Parameters | [proposals/smartaccount-native-profile-parameters.json](proposals/smartaccount-native-profile-parameters.json) · [profile.json](../contracts/native/profile.json) | The single parameter set that wallets, packaging and acceptance check; `docs/proposals/validate-native-smartaccount-profile.py` validates it |
| Core NEP draft | [nep-smartaccount-entry-verifier.mediawiki](proposals/nep-smartaccount-entry-verifier.mediawiki) | The native SmartAccount protocol service and its entry verification |
| Module NEP drafts | [nep-smartaccount-module-interface.mediawiki](proposals/nep-smartaccount-module-interface.mediawiki) · [nep-smartaccount-module-profiles.mediawiki](proposals/nep-smartaccount-module-profiles.mediawiki) | The common module interface and the named module profiles |
| Compiled module ABI | [smartaccount-module-abis.md](proposals/smartaccount-module-abis.md) · [smartaccount-named-module-interfaces.json](proposals/smartaccount-named-module-interfaces.json) · [smartaccount-module-profile.schema.json](proposals/smartaccount-module-profile.schema.json) | The module callback ABI as compiled, the named interfaces and the profile schema |
| Native design notes | [SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH](proposals/SMARTACCOUNT-NATIVE-AUTHORITY-EPOCH.md) · [SMARTACCOUNT-NATIVE-MODULE-PROFILES](proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.md) · [SMARTACCOUNT-NATIVE-MULTISIG](proposals/SMARTACCOUNT-NATIVE-MULTISIG.md) | Authority epochs, module profiles and multisig custody; each has a `.zh-CN.md` counterpart |
| Review map | [SMARTACCOUNT-ISSUE-242-CONFORMANCE.md](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md) | Maps each review area of the [native SmartAccount discussion](https://github.com/neo-project/proposals/issues/242) to its rule and its evidence; it records no upstream acceptance |

## Engineers and verification

- [engineering/VERIFICATION-AND-GATES.md](engineering/VERIFICATION-AND-GATES.md) — "SA Formal Verification" (status, ABI projection acceptance obligations, artifacts, security boundaries) and "SA contracts: reproducible build from published packages" (what is pinned, restore / build / test, reproduce, what the bytes are and are not, how to bump)
- [engineering/MORPHEUS-REGISTRY.md](engineering/MORPHEUS-REGISTRY.md) — the external Morpheus wallet service registry; it is not part of the protocol
- Build packaging: [../sdk/js/PACKAGING.md](../sdk/js/PACKAGING.md) and the Neo platform package pins in [../contracts/neo-platform-packages.json](../contracts/neo-platform-packages.json)
- Open boundaries as a machine-readable ledger: [SA-NATIVE-OPEN-BOUNDARIES.json](SA-NATIVE-OPEN-BOUNDARIES.json)

## Evidence receipts

`docs/reports/` holds dated machine receipts. A receipt is evidence only for
the commit, artifacts and runtime it names; it is never a statement about the
current tree. Each remaining receipt is read by a script:

| Receipt | Read by | Covers |
| --- | --- | --- |
| [sa-formal-gate-20261031.json](reports/sa-formal-gate-20261031.json) | `formal/test_verify.py` | The Coq gate and mutation set of the run it names |
| [sa-native-ci-probe-consistency-20261009.json](reports/sa-native-ci-probe-consistency-20261009.json) | `.github/workflows/native-profile.yml`, `scripts/test_native_profile_ci.py`, `scripts/test_native_budget_benchmark.py` | The native multisig host probe and its pricing |
| [smartaccount-current-20261124/](reports/smartaccount-current-20261124/) | `formal/refinement/` | The local acceptance receipts of the 2026-11-24 tree |
