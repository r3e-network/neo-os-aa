# Neo N3 native SmartAccount convergence — 2026-10-09

Current upstream drafts are [core #4768](https://github.com/neo-project/neo/pull/4768) and [RPC #1115](https://github.com/neo-project/neo-node/pull/1115). They preserve the same source commits; the earlier PR references below identify historical review and validation records.

The implementation target is consensus-native `AccountManagement`, enabled only by an explicit `HF_SmartAccountV1` activation. The AA repository supplies the matching ABI 2 modules, SDK, account workspace and conformance evidence. The deployed public V3 contract remains a separate compatibility profile. Native source integration does not activate a public network.

## Design and repaired boundaries

| Concern | Result |
|---|---|
| Identity and custody | Stable account identity and asset address; separate custody, recovery and external fee payer. Recovery preserves identity, assets and nonce channels. |
| Revocation | Recovery advances the authority epoch, detaches modules without trusting old cleanup callbacks, and invalidates pending configuration. Signatures and exact four-argument execution transactions bind both epoch and configuration nonce. |
| Composite approval | Core-owned, operation-local receipts select the first configured threshold of successful children. Only that quorum receives post-execution authority and consumes policy counters. Fresh policy commitments and every active code pin are checked; no cross-phase or persistent approval cache exists. |
| Signer identity | Strict canonical P-256 validation rejects invalid compressed/uncompressed points. The built-in Session and NeoNative modules normalize the same standard-account key to the same domain, preventing duplicate votes. Arbitrary scripts and third-party claims do not prove independent people or keys. |
| Bounded execution | Verifier callbacks retain the 1 GAS cap. The supported native composite profile has at most three children, two approvals and three aggregate signer domains. Ordinary NeoNative witness quorum remains independently configurable up to ten signers. |
| Asset authority | The proxy witness is restricted to intended target call frames. The native account cannot be the fee payer; fee payment by itself grants no verifier authority. |
| Submission | SDK fee ceilings, exact signer scopes, code pins, signed-transaction preflight and persisted raw-byte readback are mandatory. Failed, malformed or stale results refuse broadcast. A `transfer` must return Boolean true. |
| User workflow | The native workspace shows current authority, modules, lifecycle actions, preflight and transaction state. Stale reviews are invalidated; submission and confirmation are distinct. Unsupported/unactivated services fail discovery. |
| Client efficiency | Identity-provider dependencies are deferred; the native integration snapshot measured 663,571 bytes of initial JavaScript. Session metadata/domain storage was reduced without caching approval or skipping fresh policy checks. |

The fixed-budget maximum measured verifier callback is **95,694,229 datoshi (0.95694229 GAS)**; the maximum full proxy Verification measurement is **106,369,195 datoshi**, below its 150,000,000 limit. These results use execution fee factor 30 and storage price 100000. They cover the recorded built-in implementations and inputs, not arbitrary modules, every future fee policy or every syntactically valid batch.

## Source and protocol identity

- Native profile digest: `4201b02f571b7415121467d67343a8189b8070ad795a82424c0403782d22b1b4`.
- Reproducible runtime core pin: `ff422d940a4722c361c32398c6f28c00fb7f0693`.
- Current core PR head: `d973071ed608aa98053695db668b0ec6587a2fd6`; the only delta is copyright headers/import ordering in two tests. The complete production `src` tree is identical.
- Node/RPC pin: `fa35e69af130661e2ac60bffd43eb6c6c78aa7d5`.
- NeoExpress source pin: `da143f8643ebca7841cc7f56e4e3e00293819fbc`.
- Protocol foundation head: `84b6179999bb0f169d53f803e818a97235de4d17`.

The runtime was built completely from these sources twice. No assembly overlay is used to establish final runtime provenance. The generic private-chain runners accept a caller-supplied runtime and correctly defer provenance to the separate source-build receipt.

## Validation and evidence

| Layer | Result | Evidence |
|---|---|---|
| Native core | 1,786 tests, zero failed/skipped; full-solution formatting; Linux/Windows/macOS CI | [Core equivalence and source review](aa-native-final-core-equivalence-20261009.json), [core PR](https://github.com/neo-project/neo/pull/4766) |
| RPC | 114 client + 228 server tests, zero skipped, matching native and published-package lanes | [RPC PR](https://github.com/neo-project/neo-node/pull/1114) |
| Native module VM | 20 budget/behavior scenarios plus 16 epoch/key regressions; actual NEF | [Budget matrix](aa-native-multisig-budget-20261009.json) |
| Private-chain lifecycle | Ten suites pass, including expected persisted FAULT and admission-refusal controls | [Private runtime matrix](aa-native-final-private-runtime-20261009.json) |
| SDK | 162 unit tests, declarations, four installed-tarball consumer checks; 36 real signed transactions and three rejection controls | [Final SDK runtime](aa-native-final-sdk-runtime-20261009.json) |
| Frontend | 620 tests + seven actual Chromium suites, zero failed/skipped; all 371 recorded source files rechecked | [Native integration receipt](aa-native-final-frontend-20261009.json); [subsequent dependency validation](aa-mirror-dependencies-20261009.json) |
| Build identity | Two independent builds: all 104 runtime files and 13 native module artifacts match; all 80 public/PLATFORM artifacts reproduce | [Build/proof index](aa-native-composite-final-build-proof-20261009.json) |
| Formal models | 26 Coq modules, 443 closed declarations, 247 combined Coq/TLC rejected mutations, 61,460 TLC states, six SMT obligations plus controls | [Formal receipt](aa-native-composite-final-formal-20261009.json) |

Private matrix counts describe recorded scenario outcomes, not every funding/deployment transaction. Four runners were replayed after correcting only their runtime-description strings. Six retained receipts bind those four imported helper files to preserved historical bytes; their exact four-line metadata-only delta is recorded. They must not be described as having all-current producer hashes. The final SDK run separately binds the current helper bytes.

The bounded source review found no unresolved substantive blocker in its 17 pinned files. It is not a whole-system security certification. Formal `implementationVerified` remains **false**: handwritten models and semantic mutations do not prove complete compiler/NeoVM refinement. The private matrix report also records which raw transactions, block headers, temporary chain databases and diagnostic artifacts were not retained; those cases are not offline replay packages.

Earlier `aa-native-abi2-*` and `*.checkpoint.json` files remain historical checkpoints. Their pending statuses and older source pins must not be read as final evidence. Use the final receipts linked here, with their per-file identities and explicit limitations.

## Branch and merge decisions

| Work | Decision and rationale |
|---|---|
| Public implementation PRs #11/#12 | Merged after source/runtime checks; repaired account execution, module accounting, proxy witnesses, drafts and packaging. |
| Public dependency/client PR #14 | Merged at `acbf739785737d9207c0cb94325062a918a61d11`; exact reviewed tree, seven successful checks, no unresolved review threads. |
| Dependency PRs #3/#4/#6/#7 | Changes absorbed through validated integration; closed and remote branches absent. |
| Dependency PRs #8/#9 | Rejected isolated Router/Web3Auth major bumps that lacked compatible migration and acceptance evidence. Heads preserved before remote cleanup. |
| AA native PR #13 | Merged at `5e7428272775393a57d5f52781daf5bb633f69ba`, tree-identical to reviewed `c5306571`. Seven PR build/acceptance checks passed; all five post-merge Actions jobs and Vercel passed. This does not activate the consensus feature. |
| Old native profile PR #10 | Its tip became reachable through #13, so GitHub automatically marked it merged. The exact reviewed remote ref was removed after backup; the original dirty local worktree is retained. |
| Core #4766 / node #1114 / proposal #243 | Keep coordinated upstream drafts for protocol and maintainer review. Green implementation tests do not satisfy upstream review or choose public activation policy. |

Original dirty worktrees and historical checked-out contexts are preserved. Obsolete remote branches and unoccupied integration refs are removed only after verified recoverable Git bundles. After native integration, `origin` contains only `main`; its two native development refs were deleted with exact-head leases. Final dependency follow-up and mirror cleanup readbacks belong to the accompanying maintenance record.

## Secondary remote review and dependency follow-up

Fresh refs confirm that GitLab and RustForNeo are older copies of the same project. GitLab has only `main`; its rewritten history contains 115 patch-equivalent commits and two remaining market-script commits whose repaired file blobs are already present in the canonical history. There is no missing account implementation fix.

RustForNeo `main` is an ancestor of native integration. Its nine development branches were reviewed individually:

- Tailwind 4.3.3, SDK Neon 5.10.1 and TypeScript 7.0.2 are already integrated.
- The organization-document branches are patch-equivalent or obsolete documentation, with no unique account fix.
- Package-only Marked 18 and Vite 8 major upgrades lack the required application/toolchain migration and are rejected as merge candidates.
- The remaining Autoprefixer 10.6.1 and JOSE 6.2.12 updates are applied narrowly to canonical main. Their old branch patches are not merged wholesale: unrelated optional `utf-8-validate` lock entries are retained. [Dependency validation](aa-mirror-dependencies-20261009.json) records actual authentication/JWKS and CSS checks, the full 620-test/seven-browser gate, production build and unchanged advisory allowance.

The two dependency files are a later frontend source snapshot than the native integration frontend receipt. The supplemental receipt, rather than the old per-file hashes, is authoritative for that update. Native core, modules, SDK runtime producers and profile digest are unchanged. All secondary heads and the seven open mirror PR records were included in a separately restored and verified recovery bundle before any cleanup. Old mirror `main` histories are retained; canonical development continues in `r3e-network/neo-os-aa`.

## Remaining external and compatibility boundaries

The native direction is tracked in [proposal issue #242](https://github.com/neo-project/proposals/issues/242) and [foundation PR #243](https://github.com/neo-project/proposals/pull/243). This implementation is an unactivated draft profile, not an accepted NEP or a public-chain release. Upstream protocol review, activation parameters and network rollout remain separate decisions.

GitGuardian reported 33 items at native candidate `c5306571`: 22 public source/project SHA-256 values, one public NEF SHA-256 and ten unsigned conformance vectors. Each detected value was tied to immutable Git bytes and independently recomputed. The provider still reports failure; no status was forged, scan disabled or protected gate bypassed. Every newly introduced or relocated detection was checked again before the native merge. Future candidate detections require the same individual classification.

The frontend dependency graph retains the explicitly recorded low-severity Elliptic advisory `GHSA-848j-6mx2-7j84` (19 production / 24 full-tree affected package entries). No patched release is available in the validated dependency path. The audit gate permits only that identified low advisory and rejects new advisories, higher severity and malformed registry responses. SDK audit is clean. Older GitHub alert rows were range-checked against current lockfiles; platform dismissal/closure is not claimed.

No public-chain activation, user-wallet signing, npm publication or production database migration is part of this convergence. GitHub-connected frontend preview/production automation is a separate deployment surface and must be read back after merge before claiming its current state.
