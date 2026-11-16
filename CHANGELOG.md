# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project adheres to Semantic Versioning.

## [Unreleased]

### Fixed
- `ZKEmailVerifier` no longer advertises the V3 capability while disabled (2026-11-16 design review): `supportsV3()` returns `false`, so the core's verifier binding check rejects registration and verifier updates up front (`Verifier does not implement V3 interface`) instead of letting an account bind to a verifier whose `validateSignature` always faults and recovering only through the 7-90 day escape path. The execution-time fail-closed assert remains as defense in depth. The NeoExpress scenario and the testnet plugin matrix now assert the bind-time rejection, and a source-invariant test pins both the disabled marker and the bind gate.
- Windows portability of the script test suite (2026-11-16 audit): `implementation_profiles.test.mjs` resolves the repo root through `fileURLToPath` instead of `path.resolve(URL.pathname)` (drive doubling `D:\D:\...`); the `check-artifact-reproducibility` scratch filter normalizes path separators so `bin|obj|build` are excluded on Windows; the `main()` guards of `check-artifact-reproducibility.mjs` and `verify-private-artifact-provenance.mjs` compare against `pathToFileURL(path.resolve(argv[1]))` so paths with spaces or `%` are exact; `wallet_shim_sign_proxy_transfer.mjs` resolves its repo root through `fileURLToPath`; `test_neoexpress_reproducible_build.py` canonicalizes paths with `os.path.realpath` and normalized separators so an 8.3 `%TEMP%` spelling no longer breaks the MSBuild identity comparison; `lib/deploy-helpers.test.mjs` artifact-path pins accept both separators; `lib/gitignore-rules.test.mjs` no longer materializes fixture paths with glob metacharacters (illegal win32 names) on Windows.
- Repository hygiene: 51 historical evidence receipts under `docs/reports/` that are cited by live protocol documents (or by other kept receipts) are now explicitly un-ignored in `.gitignore`, 23 unreferenced ones are untracked and stay local-only per the reports policy, and the ordinary profile's readback evidence pin now matches the actual receipt name `mainnet-smart-account-upgrade-20260915-evidence.json` (renamed from `mainnet-unified-smart-wallet-upgrade-20260915-evidence.json`). `repo_hygiene.test.mjs` passes on Windows; the earlier "git misreports" attribution was wrong — `git check-ignore` without `--no-index` never reports tracked paths, while `git ls-files --cached --ignored` does.

### Added
- Added `scripts/migrate_smart_account_v3.js`, the platform-service migration orchestrator for the extracted V3 candidate: market enrollment (`--enroll-market`), the registrar timelock phases (`--propose-registrar` / `--confirm-registrar`) and the one-time legacy rotation migration (`--migrate-rotations`), dry-run by default with `--execute` gated behind `CONFIRM_AA_TESTNET_MIGRATION` plus an admin WIF; every executed phase re-reads its post-conditions over RPC.

### Changed
- Extracted the platform services from the ordinary V3 core: market escrow settlement (`abandonListing`) moved to `AAAddressMarket`, paymaster reimbursement settlement (`settleReimbursement`) moved to `AAPaymaster`, and platform-account registration plus the owner-rotation timelocks moved to the new standalone `AAPlatformRegistrar` (`contracts/registrar/`), with a one-time core-side `migratePlatformOwnerRotations` migration; event display names are preserved across the move so indexers keep continuity. Contract tests cover the extracted service ABI and the owner-rotation migration, and the candidate NEF/manifest hashes are re-pinned.
- The ordinary source candidate now exposes 109 raw manifest methods (108 unique names; `finalizeEscape` is overloaded) against the 90 methods of the pinned public artifact. `implementations/ordinary/profile.json` records both counts and keeps the `upgrade-required` boundary unchanged; the orchestration order and the cross-repo pin inventory live in `docs/SMARTACCOUNT-V3-UPGRADE-COORDINATION.md`.
- Restored `implementations/native/core/SmartAccount/` as the only editable true source of the native `SmartAccount` contract; the neo core checkout now carries generated copies that `scripts/sync_native_smartaccount.py` rewrites byte-deterministically from it (`--check` exits non-zero on drift, missing or unmanaged copies).
- Converged the native track ahead of that restoration: the overlay compiles the pinned Neo core with the native contract source in place, native module events emit through it, the native service identity pin is bumped, and the profile validators, probes and SDK/shared client mirrors follow the pinned identity.
- The native VM CI lane runs the true-source sync check against the SHA-pinned core checkout before any build or test work, and the pin moved to the regenerated generated-marker commit; BLS12_381 is re-pinned to the nuget.org package hash in the overlay lock files.
- Documentation structure cleanup (2026-11-16): 23 superseded working documents moved under `docs/history/` following the established archive convention — dated snapshots (`AA-MAINNET-UPGRADE-READINESS-20260912.md`, `2026-03-28-aa-professionalization.md`), the pre-V3 manual test checklist, the shared-draft execution note, superseded proposal material with its diagrams and two retired validation scripts (`history/proposals/`), the legacy root `ORGANIZATION.md` (now `history/ORGANIZATION-legacy.md`, superseded by `docs/ORGANIZATION.md`), and 12 completed formal-refinement working drafts whose live state is tracked by `AA-FORMAL-VERIFICATION.md` and `formal/refinement/`. Relative links inside the moved documents were re-pointed, `docs/INDEX.md` now indexes `docs/ORGANIZATION.md`, `docs/mainnet-validation-runbook.md` and `TESTNET_QUICKSTART.md`, and the README links the testnet quickstart from its Live Testnet Validation section.

### Security
- Landed the V3 security remediation in the ordinary core: the session-key method bypass is closed, external plugin configuration is caller-gated, accounts can be frozen and unfrozen through the admin timelock (`freezeAccount` / `unfreezeAccount` / `isAccountFrozen`; candidate ABI, not part of the pinned public artifact), hook policy enforcement fails closed, escape and upgrade paths emit their events, and the confused-deputy path is closed. Contract tests cover account freeze, hook fail-closed behavior, the admin timelock, session keys and the module ABI, and the remediated sources are mirrored into the frontend assets.

## [2026-10-05]

### Fixed
- A token transfer that returns `false` is a failure everywhere it was reported as a success. On the deployed core, `GAS.transfer(proxy -> buyer)` carried by `executeUserOp` with only an owner or relay witness HALTs with result `false`, moves nothing and still burns the nonce and the fee: the web wallet's NEP-17 preset built exactly that call, the confirmation mapper called it confirmed, and the relay route's preflight said `ok: true` and then broadcast it (AA-03 case a, AA-09 cases 8 and 9 of the 2026-10-05 assessment). The preset now refuses a transfer whose source is the account proxy with a typed error (`EC_preset_proxy_transfer_refused`) and the workspace shows it; `txConfirmation` reports a HALT whose transfer returned `false` as failed; the relay route answers `ok: false` with the code `relay_transfer_returned_false` before it prices, signs or broadcasts (the simulation that prices the transaction is judged too); the wallet's relay preflight and `executeBroadcast` do not believe a relay that says otherwise; the SDK's `simulateUserOperation` reports the proxy-sourced transfer (`OP_001`) and the SDK exports the same result rules (`findFailedTransferInInvocation`, `findFailedTransferInExecution`, `isProxySourcedTransfer`). Only a method named `transfer` with a Boolean `false` result is judged, because `false` is the normal result of other calls such as arming a timelocked change; the rules are one module, `shared/transferOutcome.mjs`, vendored byte for byte into `frontend/src/shared/`. The relay route is a serverless function: the fix reaches users when it is deployed.

## [2026-10-04]

### Changed
- The contracts and their tests now build from nuget.org alone (audit finding R-11 / N-DEP-1). `Neo.SmartContract.Framework` and `Neo.SmartContract.Testing` are pinned to the published 3.10.1 in one place, the new root `Directory.Build.props`; the private `3.10.2-CI00384` build and `contracts/Directory.Build.props` are gone. The AA core declares the `System.Contract.CallWithGasLimit` syscall itself, which no published framework does; the compiled NEF and manifest of every contract are byte-identical to what the private framework built from the previous source, so contract behaviour and ABI are unchanged.
- Added `nuget.config` (nuget.org is the only source, with package source mapping) and a committed lock file for every project that restores Neo packages. Restore runs in locked mode, so a changed resolution or different package bytes fail the build. `scripts/check_neo_platform_packages.mjs` now verifies the pins, the lock files and the restored package hashes against `contracts/neo-platform-packages.json` (nine published Neo packages), checks the installed `nccs` is the pinned 3.9.1 package, and names the pinned versions when it fails; CI no longer carries a known-red step.
- The artifacts are reproducible: building all 24 contracts in two clean `git archive` exports at different paths gives byte-identical NEF and manifest files (`docs/reports/aa-published-build-reproducibility-20261004.json`). They differ from the artifacts deployed on MainNet and TestNet, which come from older source; deployed-versus-source evidence for the AA core is a separate task. Recipe: `docs/AA-REPRODUCIBLE-BUILD.md`.
- Four runtime tests that drive a verifier callback through the gas-bounded syscall need a Neo core that registers it; no published core does. On the published packages they are reported skipped (not passed) with the reason, and `NEOOS_REQUIRE_PLATFORM_SYSCALLS=1` makes that a failure. `CompiledCoreSyscallTests` checks the emitted syscalls at the bytecode level on every core.

## [2026-04-06]

### Added
- Added on-chain `AAPaymaster` contract for trustless sponsored/gasless transactions. Sponsors deposit GAS, create per-account or global sponsorship policies with per-op limits, daily budgets, total budgets, target/method restrictions, and expiry timestamps. Relays are reimbursed automatically after successful `UserOp` execution via atomic settlement.
- Added `executeSponsoredUserOp` and `executeSponsoredUserOps` to the AA core for paymaster-integrated execution with pre-validation and post-execution settlement.
- Added `SponsoredUserOpExecuted` event to the AA core for indexing sponsored operations.
- Added SDK methods: `createSponsoredUserOpPayload`, `createSponsoredBatchPayload`, `querySponsorBalance`, and `validatePaymasterOp` for relay and dApp integration with the on-chain Paymaster.
- Added `PaymasterAuthority` with 7-day timelocked admin rotation and authorized-core validation for settlement security.
- Added the home operations workspace for account loading, draft persistence, scoped collaboration links, relay preflight, submission receipts, and mixed Neo + EVM approval flows.
- Added comprehensive explainer docs covering how the abstract account works, architecture, workflow lifecycle, data flow, a root documentation index, and supplemental English/Chinese reference docs.
- Added validated recovery verifier support for Argent, Safe, and Loopring flows, including reproducible build scripts, deployment checklists, official SDK validators, and recorded testnet deployment results.
- Added relay/operator API hardening with in-memory rate limiting, `Retry-After` responses, and a dedicated frontend API security test.
- Added a root-contract compilation helper to isolate `nccs` from recovery build intermediates during repo verification.

### Changed
- Updated the root verification flow to compile the main contract through an isolated helper before running the full repo validation sequence.
- Tightened EVM meta-transaction validation to reject malformed uncompressed public keys before signature verification.
- Updated recovery deployment docs to remove plaintext secrets, reflect real deployed hashes, and point at the validated package-script flows.
- Refined the repo and docs test suites so preserved docs, recovery validator wiring, API rate-limit behavior, and verification-script expectations stay covered.

### Removed
- Removed the legacy V1/V2 `verifiers/AllowAllVerifier` stub (top-level, superseded by the V3 verifiers under `contracts/verifiers/`) along with its source-invariant pin and dedicated `nccs` step in `scripts/verify_repo.sh`.

### Security
- Deployed and validated the recovery verifier contracts on Neo N3 testnet:
  - Argent `0xaa25d77353fbc4cceb372f91ebccf5fb726ed10f`
  - Safe `0xfcd8c4601dfa29910d9fec0bf724ce39fc734a74`
  - Loopring `0x5bc837e96b83f5080e722883398c8188177694ea`
- Preserved browser hardening headers in `frontend/vercel.json` and sanitized relay error responses to avoid exposing raw internal failures.
- Added Supabase performance indexes for common draft lookup paths.

## [1.0.0] - 2026-03-07

### Added
- Added GitHub Actions CI to validate contract, frontend, and SDK workflows.
- Added a testnet validation runbook and dedicated SDK validators for threshold multisig, custom verifier, dome/oracle, concurrency, and approve/allowance live checks.
- Added standalone auxiliary contracts for live validation: `verifiers/AllowAllVerifier`.
- Added a repository quickstart covering install, test, and build flows.
- Added regression coverage for hardened docs/runtime expectations, SDK package metadata, contract safety checks, oracle callback handling, and repo verification coverage.

### Changed
- Hardened account storage-key handling to avoid ambiguous account-ID storage paths.
- Reworked proxy verification script checks to count real syscall instructions instead of matching raw byte patterns.
- Aligned internal self-call authorization with the mixed-signature execution model.
- Added manifest permission for custom verifier `verify` calls and completed live verifier-path validation on the hardened testnet deployment.
- Reworked dome/oracle activation handling to use the compiled callback name, parsed oracle filters, broader truth parsing, deterministic URL comparison, and callback diagnostics, then validated the full oracle unlock flow live on testnet.
- Added bounded concurrency/load validation showing deterministic parallel simulation results and serialized meta-tx nonce progression on testnet.
- Added live approve/allowance enforcement validation against a disposable approval-capable token with AA max-transfer policy applied.
- Clarified docs to describe the actual hardened, policy-gated execution surface.
- Stabilized the full live testnet validator's whitelist-mode path so the end-to-end six-script suite passes consistently on the hardened deployment.
- Replaced the frontend's Neon SDK dependency path with local Neo browser helpers.
- Reduced frontend bundle size with lazy-loaded docs/runtime dependencies, async UI panels, and manual chunk splitting.
- Cleaned contract nullable analysis so the contract project now builds with nullable warnings treated as errors.

### Removed
- Removed stale mirrored contract source files from the frontend.
- Removed tracked generated `.NET` build outputs from `contracts/bin` and `contracts/obj`, while preserving intentional smart-contract artifacts.

### Security
- Reduced frontend production audit findings to zero known production vulnerabilities.
- Preserved hardened execution checks around whitelist, blacklist, transfer-limit, approve/allowance limits, verifier-gated authorization, and wrapper-only execution paths.
