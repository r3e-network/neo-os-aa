# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project adheres to Semantic Versioning.

## [Unreleased] - 2026-04-06

### Added
- Added on-chain `AAPaymaster` contract for trustless sponsored/gasless transactions. Sponsors deposit GAS, create per-account or global sponsorship policies with per-op limits, daily budgets, total budgets, target/method restrictions, and expiry timestamps. Relays are reimbursed automatically after successful `UserOp` execution via atomic settlement.
- Added `ExecuteSponsoredUserOp` and `ExecuteSponsoredUserOps` to the AA core for paymaster-integrated execution with pre-validation and post-execution settlement.
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
- (2026-10-04) The contracts and their tests now build from nuget.org alone (audit finding R-11 / N-DEP-1). `Neo.SmartContract.Framework` and `Neo.SmartContract.Testing` are pinned to the published 3.10.1 in one place, the new root `Directory.Build.props`; the private `3.10.2-CI00384` build and `contracts/Directory.Build.props` are gone. The AA core declares the `System.Contract.CallWithGasLimit` syscall itself, which no published framework does; the compiled NEF and manifest of every contract are byte-identical to what the private framework built from the previous source, so contract behaviour and ABI are unchanged.
- Added `nuget.config` (nuget.org is the only source, with package source mapping) and a committed lock file for every project that restores Neo packages. Restore runs in locked mode, so a changed resolution or different package bytes fail the build. `scripts/check_neo_platform_packages.mjs` now verifies the pins, the lock files and the restored package hashes against `contracts/neo-platform-packages.json` (nine published Neo packages), checks the installed `nccs` is the pinned 3.9.1 package, and names the pinned versions when it fails; CI no longer carries a known-red step.
- The artifacts are reproducible: building all 24 contracts in two clean `git archive` exports at different paths gives byte-identical NEF and manifest files (`docs/reports/aa-published-build-reproducibility-20261004.json`). They differ from the artifacts deployed on MainNet and TestNet, which come from older source; deployed-versus-source evidence for the AA core is a separate task. Recipe: `docs/AA-REPRODUCIBLE-BUILD.md`.
- Four runtime tests that drive a verifier callback through the gas-bounded syscall need a Neo core that registers it; no published core does. On the published packages they are reported skipped (not passed) with the reason, and `NEOOS_REQUIRE_PLATFORM_SYSCALLS=1` makes that a failure. `CompiledCoreSyscallTests` checks the emitted syscalls at the bytecode level on every core.

### Removed
- Removed the legacy V1/V2 `verifiers/AllowAllVerifier` stub (top-level, superseded by the V3 verifiers under `contracts/verifiers/`) along with its source-invariant pin and dedicated `nccs` step in `scripts/verify_repo.sh`.

### Fixed
- A token transfer that returns `false` is a failure everywhere it was reported as a success. On the deployed core, `GAS.transfer(proxy -> buyer)` carried by `executeUserOp` with only an owner or relay witness HALTs with result `false`, moves nothing and still burns the nonce and the fee: the web wallet's NEP-17 preset built exactly that call, the confirmation mapper called it confirmed, and the relay route's preflight said `ok: true` and then broadcast it (AA-03 case a, AA-09 cases 8 and 9 of the 2026-10-05 assessment). The preset now refuses a transfer whose source is the account proxy with a typed error (`EC_preset_proxy_transfer_refused`) and the workspace shows it; `txConfirmation` reports a HALT whose transfer returned `false` as failed; the relay route answers `ok: false` with the code `relay_transfer_returned_false` before it prices, signs or broadcasts (the simulation that prices the transaction is judged too); the wallet's relay preflight and `executeBroadcast` do not believe a relay that says otherwise; the SDK's `simulateUserOperation` reports the proxy-sourced transfer (`OP_001`) and the SDK exports the same result rules (`findFailedTransferInInvocation`, `findFailedTransferInExecution`, `isProxySourcedTransfer`). Only a method named `transfer` with a Boolean `false` result is judged, because `false` is the normal result of other calls such as arming a timelocked change; the rules are one module, `shared/transferOutcome.mjs`, vendored byte for byte into `frontend/src/shared/`. The relay route is a serverless function: the fix reaches users when it is deployed.

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
