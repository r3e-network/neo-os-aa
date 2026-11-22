# NeoOS SA — Neo N3 Smart Accounts

`neo-os-sa` is the NeoOS account-abstraction project. It contains the smart contracts, frontend tooling, and SDK for creating and using Smart Accounts on Neo N3.

The protocol is implemented once on this branch, as the
[native `SmartAccount` profile](contracts/native/README.md) in `contracts/native/`. The former C#
user-contract delivery path and its paymaster, address-market and platform-registrar services were
removed when the repository went native-only. Start with the
[implementation strategy](docs/SA-IMPLEMENTATION-STRATEGY.md) and
[capability boundaries](docs/SA-SYSTEM-STATUS.md), then the
[native system architecture](docs/NATIVE_SYSTEM_ARCHITECTURE.md), [native SDK](docs/NATIVE_SDK.md) and
[native account workspace](docs/NATIVE_ACCOUNT_WORKSPACE.md). The service uses stable account
identity, explicitly scoped authorization, bounded module callbacks, independent fee payment, and
recovery that revokes old modules without calling them.

The native track implements the unactivated ABI 2 draft associated with
[proposal #243](https://github.com/neo-project/proposals/pull/243) and
[discussion #242](https://github.com/neo-project/proposals/issues/242).
Selecting a public RPC endpoint cannot enable it. The workspace verifies native
activation and the exact protocol profile before enabling account actions.

The deployed-contract track is usable on the published Neo N3 runtime after
its own artifact, integration, and deployment readback gates. Its identity,
wire format, callback resources, recovery and sponsorship guarantees remain
profile-specific; passing native profile checks does not reclassify a v4
deployment as native.

The [usability follow-up](docs/reports/sa-native-usability-20261009.md) covers
guarded policy cancellation, standard wallet threshold recovery, signed-file
submission and receipt restoration, and measured module costs. The earlier
[consistency follow-up](docs/reports/sa-consistency-iteration-20261009.md)
retains its original SDK/relay and private-chain checkpoint. Both distinguish
local implementation evidence from the remaining protocol and activation gates.

Runtime and deployment boundaries:

- This repository ships protocol version 4 for the public deployments listed below, alongside the native `SmartAccount` implementation; the deployed contract keeps the `SmartAccountV3` manifest label so existing indexers keep resolving it.
- v4 removes the old role-heavy / dome-heavy core wallet model and replaces it with a minimalist account core plus validator and hook modules installed through configuration intents.
- The `public` build uses published Neo packages and standard contract calls. The separate `PLATFORM` build needs a private runtime with bounded child calls. Native SmartAccount uses its own ABI 2 identity and activation boundary; neither compatibility build enables it.
- [System capability boundaries](docs/SA-SYSTEM-STATUS.md) distinguish supported source behavior, operational prerequisites, and work that still requires protocol changes. Repository tests do not establish parity with a deployed public contract.
- The canonical mainnet SA anchor now points to the clean deploy `0x0268a387913b250166ddec032b03332690a1ef78` and resolves from `smartwallet.neo` plus `sa.morpheus.neo`.
- The canonical shared testnet SA anchor now points to the clean deployment `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2`, with shared `Web3AuthVerifier` `0x1111f5b6b046a964c75d208998c13945ce172e85`.

The canonical source root is the
[native SmartAccount profile](contracts/native/README.md) in `contracts/native/`. The validator,
hook and recovery modules the native core installs live in `contracts/plugins/`;
`contracts/native/profile.json` maps the canonical source roots, compatibility paths, artifacts and
profile-specific verification commands.

## Architecture authority

In the NeoOS workspace ownership map, `neo-os-sa` is the sole authority for account abstraction: user operations, proxy
verification, and recovery (`protocol-sa-core`). Native consensus enforcement lives in the matching
Neo core `SmartAccount` implementation; this repository supplies its profile, modules, SDK and UI.
SA decides whether an actor authorized an
operation and nothing more: it does not grant DID eligibility, hold network identity, or
select signers, and it has no dependency on the DID registry. The operation-policy layer
composes `SAAuthorization` with an independently verified `EligibilityProof` when a product
needs both.

The binding is declared in `neo-os-web/docs/workspace/neoos-target-architecture.v1.json` and
checked by the architecture source-coverage gate.

Proposed v2 binding: in `neo-os-web/docs/workspace/neoos-target-architecture.v2.json` (status `PROPOSED`, validated by `npm run check:architecture:v2` in `neo-os-web`) this repository is v2 layer L1 (chain-protocol) and owns C03 account. The v1 binding above remains the enforced contract until the v2 adoption procedure completes.


## Protocol v4 features
- **Deterministic accounts**: Each account is keyed by a 20-byte `accountId` derived from a custody key and salt, and resolves to a stable Neo virtual address without deploying per-user wallet logic.
- **Validator Module Authorization**: Install Web3Auth, TEE, P-256, session-key, subscription, delegated-identity, witness or multi-signature validator modules per account instance.
- **Hook Module Policy Enforcement**: Attach hook modules for daily limits, token restrictions, credential gates and post-execution controls; the core owns the hook order that runs them.
- **Configuration Intents**: Installing, uninstalling, re-binding or re-configuring a module is staged as an intent that matures after 24 hours and expires seven days later; `proposeConfiguration`, `confirmConfiguration` and `cancelConfiguration` are the only write paths.
- **Backup-Owner Recovery**: Every account can define a native Neo backup owner, and recovery is delegated to an installed recovery service; see [recovery boundaries](docs/ACCOUNT_RECOVERY_AND_IDENTITY.md).
- **Trustless SA Address Escrow Market**: Deterministic SA addresses can be listed, escrow-locked, purchased with GAS, and transferred atomically on-chain.
- **Cross-Chain EVM Compatibility**: v4 accepts secp256k1 / Keccak256 EIP-712 signatures through the delegated identity validator path.
- **On-Chain Paymaster (Sponsored Transactions)**: The `SAPaymaster` contract enables trustless gasless execution — sponsors deposit GAS, create per-account or global sponsorship policies, and relays are reimbursed automatically after successful `UserOp` execution. Supports per-op limits, daily budgets, total budgets, target/method restrictions, and expiry timestamps.
- **Policy-Gated Execution**: New integrations should flow through `executeUserOp(accountId, op)` where nonce handling, validation, hooks, and target execution stay centralized.

## Public v4 App + Market Deployment

The frontend now separates:

- a marketing-style home page,
- an app workspace for account creation and operation flow,
- and a trustless SA address market backed by an on-chain escrow contract.

For the market UI, set `VITE_SA_MARKET_HASH` to the deployed `SAAddressMarket` contract hash.

For a Vercel deployment, set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SA_RELAY_URL`, and `VITE_SA_RELAY_RPC_URL`, then apply every file in `supabase/migrations/` in filename order — the chain is replayable end to end on a fresh database. Its CI replay gate is currently disabled (`.github/workflows/supabase-migrations.yml.disabled`, deliberately parked on 2026-09-27 to drop the CI runner cost; see the deployment checklist below for the current manual replay step). The full chain keeps the public share link read-only, narrows collaborator links to signature-safe writes, moves operator-only status/relay mutations behind the signed operator mutation server route in `frontend/api/draft-operator.js`, and bounds anonymous draft payloads. `supabase/migrations/20260327_security_hardening.sql` and `supabase/migrations/20260611_draft_metadata_hardening.sql` are mandatory — without them the draft tables keep permissive RLS policies, racy metadata writers, and unbounded anonymous draft creation.

If you deploy the bundled server routes, keep `SUPABASE_SERVICE_ROLE_KEY` and `SA_RELAY_WIF` on the server, prefer `SA_RELAY_RPC_URL` for the relay backend, pin `SA_RELAY_ALLOWED_HASH` to the intended SA contract, and leave `SA_RELAY_ALLOW_RAW_FORWARD=0` unless you explicitly want raw passthrough in `frontend/api/relay-transaction.js`.
For local setup, start from `frontend/.env.example` and copy the values you need into `frontend/.env.local` or your hosting provider's environment-variable dashboard.

The chain-side paymaster contract was removed with the custom track, so this repository no longer ships a sponsorship policy engine. Deployment configuration now comes from `contracts/native/profile.json` and `contracts/plugins/native-profile/profiles.json`: they name the canonical source roots, the six native-profile modules, the ABI 2 authority and the artifacts each verification command consumes. Native activation remains a runtime property that selecting an RPC endpoint cannot enable.

Proxy-held token transfers require an additional account witness. The supported relay path is direct execution with a configured scope target, an explicit network-fee reserve and fee ceilings. Sponsored proxy witnesses are rejected because settlement is outside the operation's hook boundary. See [proxy transfers](docs/SA-PROXY-TRANSFERS.md).

If you want relay submission to request Morpheus off-chain sponsorship before broadcasting, also configure the server-side paymaster bridge:

- `MORPHEUS_PAYMASTER_TESTNET_ENDPOINT`
- `MORPHEUS_PAYMASTER_TESTNET_API_TOKEN`
- `MORPHEUS_PAYMASTER_MAINNET_ENDPOINT`
- `MORPHEUS_PAYMASTER_MAINNET_API_TOKEN`
- Optional debug only: `SA_RELAY_INCLUDE_RAW_ERRORS=1`

The relay route now forwards optional paymaster metadata and can request Morpheus paymaster pre-authorization before broadcasting a relay-ready `executeUserOp` or `executeUserOps` invocation. Failures are now phase-tagged as `preview`, `paymaster`, `relay`, or `response` so operator logs can separate Morpheus sponsorship errors from on-chain relay failures.

### Validation Preview And Trust Boundaries

Production integrations should treat the core SA runtime as having three distinct boundaries:

- **validation preview**: `previewUserOpValidation(accountId, op)` is a read-only check for deadline validity, nonce acceptability, and the installed validator/hook module set
- **authorization**: only an installed validator module, or the backing witness of a delegated session, can authorize `executeUserOp`
- **execution**: hooks and target contracts still run after authorization and can still reject the operation

The relay is an operator convenience layer, not an authority layer:

- **relay trust boundary**: the relay can simulate, package, and submit, but it cannot authorize on behalf of the account
- relay preflight and validation preview help operators simulate readiness before submit
- relay submission can package and pay for transactions, but it does not replace on-chain signature validation
- paymaster sponsorship (on-chain or off-chain) does not replace the installed validator or backup-owner witness
- paymaster does not authorize execution — it only funds the relay reimbursement after successful verification

### Module Lifecycle

v4 stages every module change as a configuration intent and reports the resulting instance:

- **install**: installing a module instance emits `ModuleInstanceInstalled`; binding it to the core through a confirmed intent emits `ModuleInstalled`
- **configure**: re-configuring a live instance emits `ModuleInstanceConfigured`
- **uninstall**: removing an instance emits `ModuleInstanceRemoved`; clearing its core binding emits `ModuleRemoved`
- **intents**: `proposeConfiguration` emits `ConfigurationIntentProposed`, `confirmConfiguration` emits `ConfigurationIntentConfirmed`, `cancelConfiguration` emits `ConfigurationIntentCancelled`, and an intent past its seven-day window emits `ConfigurationIntentExpired`

`HookOrderSet` and `ThresholdPolicySet` record the core-owned hook order and the multi-signature threshold. This is the recommended surface for indexers, dashboards, and operational tooling: an event names the module id and type instead of assuming one bound verifier field.

## Canonical Morpheus Network Anchors

When this repo references Morpheus-integrated addresses, treat the following as the current canonical Neo N3 anchors. They restate `frontend/src/config/generatedMorpheusRegistry.js`, which is generated from neo-os-services and wins on any conflict; `frontend/tests/morpheusRegistryDocs.test.js` keeps the addresses and domains below equal to it.

| Item | Mainnet | Testnet |
| --- | --- | --- |
| SA core | `0x0268a387913b250166ddec032b03332690a1ef78` | `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2` |
| SA runtime label | `SmartAccountV3` | `SmartAccountV3` |
| Morpheus Oracle | `0xf54d8584ef82315c1800373272ab08ae0db2d5ef` | `0xf54d8584ef82315c1800373272ab08ae0db2d5ef` |
| Morpheus DataFeed | `0x03013f49c42a14546c8bbe58f9d434c3517fccab` | `0x9bea75cf702f6afc09125aa6d22f082bfd2ee064` |
| Oracle callback consumer | `0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844` | `0x0ac1fa9cdcb66c1672f0642f62d767902f460f2b` |
| NeoDIDRegistry | `0xb81f31ea81e279793b30411b82c2e82078b63105` | unpublished in the shared registry |
| SA Web3AuthVerifier | `0xf5c452cd4ba29dcdc47026383568c0d8b38d9272` | `0x1111f5b6b046a964c75d208998c13945ce172e85` |
| SocialRecoveryVerifier v2 | `0x198b3a9cec9bccc2110d19bd929b10374a9d034d` | unpublished in the shared registry |

The Morpheus Oracle (MiniApp-OS kernel v2) has the same contract hash on mainnet and testnet. The testnet hash `0x4b882e94ed766807c4fd728768f972e13008ad52` still seen in older records is the retired v1 oracle — do not integrate against it.

Domain rules:

- mainnet SA domain: `smartwallet.neo`
- mainnet SA additional alias: `sa.morpheus.neo`
- mainnet NeoDID domain: `neodid.morpheus.neo`
- testnet currently has no shared SA / NeoDID NNS aliases
- the `*.miniapp.neo` spellings are the retired migration names: on 2026-11-16 the canonical registry restored the `smartwallet.neo` / `*.morpheus.neo` set above
- `oracle.morpheus.neo` pointed to the superseded oracle `0x5b492098fc094c760402e01f7e0b631b939d2bea` before the 2026-11-16 rebinding; the canonical registry now publishes it for the current oracle

Current published Morpheus CVM attestation anchors:

- Oracle request/response CVM: `oracle-morpheus-neo-r3e` / `ddff154546fe22d15b65667156dd4b7c611e6093`
- Oracle attestation explorer: `https://cloud.phala.com/explorer/app_ddff154546fe22d15b65667156dd4b7c611e6093`
- DataFeed CVM: `datafeed-morpheus-neo-r3e` / `ac5b6886a2832df36e479294206611652400178f`
- DataFeed attestation explorer: `https://cloud.phala.com/explorer/app_ac5b6886a2832df36e479294206611652400178f`

Do not conflate the SA recovery service with the independent NeoDID registry:

- `SocialRecoveryVerifier` is the registered SA-specific recovery service entry; in v4 an account reaches it through the installed recovery-service validator rather than a bound field
- `NeoDIDRegistry` is the independent Morpheus identity / action-ticket registry

Current validation references:

- `docs/SECURITY_MODEL.md` is the bounded-claim ledger for validator modules, hooks, recovery and paymaster paths.
- `docs/PROTOCOL_COMPLETENESS_AUDIT.md` states protocol coverage and the deployment gates that remain open.
- The on-chain `SAPaymaster` contract provides an alternative trustless sponsorship model without off-chain dependencies.

For Morpheus / NeoDID production integration, also set:

- `VITE_WEB3AUTH_CLIENT_ID`
- `VITE_WEB3AUTH_NETWORK=sapphire_mainnet`
- `VITE_MORPHEUS_RUNTIME_URL=https://oracle.meshmini.app/mainnet`
- `VITE_MORPHEUS_TESTNET_RUNTIME_URL=https://oracle.meshmini.app/testnet`
- `VITE_MORPHEUS_NEODID_SERVICE_DID=did:morpheus:neo_n3:service:neodid`
- server-only `WEB3AUTH_CLIENT_SECRET`
- server-only `MORPHEUS_RUNTIME_URL=https://oracle.meshmini.app/mainnet`
- server-only `MORPHEUS_TESTNET_RUNTIME_URL=https://oracle.meshmini.app/testnet`

Shared draft metadata is intentionally bounded: the frontend keeps the latest 100 activity entries and the latest 12 submission receipts per draft so long-lived collaboration records do not grow without limit.

### Deployment Checklist

- Apply every file in `supabase/migrations/` in filename order (`20260308_home_operations_workspace.sql` through `20261118_rename_aa_to_sa.sql`). The chain replays cleanly on a fresh database; do not cherry-pick individual files.
- Treat `supabase/migrations/20260327_security_hardening.sql` as mandatory: it removes the permissive `aa_account_metadata` RLS policies, revokes direct table access on `aa_transaction_drafts`, and fixes the signature-append race.
- Treat `supabase/migrations/20260611_draft_metadata_hardening.sql` as mandatory: it locks the remaining draft metadata writers against lost updates, bounds anonymous `create_sa_draft` payloads (64 KiB cap, array caps, inbound activity/receipt trimming), and revokes anon execute on the internal activity-scope helper.
- Treat `supabase/migrations/20261118_rename_aa_to_sa.sql` as mandatory: it renames the `aa_transaction_drafts` / `aa_account_metadata` tables plus every `aa_` draft function, trigger, index, and read policy to their `sa_` names, and re-issues the surviving plpgsql bodies with `sa_` references (they resolve table and function names at execution time, so the renames alone would break every draft RPC at runtime), so all table and RPC references after it must use the `sa_` spelling.
- The migration chain is designed for CI replay, but its gate `.github/workflows/supabase-migrations.yml.disabled` has been disabled since 2026-09-27 (runner-cost decision; database operations run manually). Until it is re-enabled — which is only removing the `.disabled` suffix, since the workflow file, the migration files and `supabase/tests/replay_assertions.sql` still match each other — verify a migration change by replaying every file in filename order against a scratch Postgres 16 and then running `supabase/tests/replay_assertions.sql` yourself.
- Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for browser-side anonymous draft persistence.
- Share the normal draft URL for read-only review, the collaborator link for signature collection, and the operator link for relay checks, broadcast, and other operator-only actions. Signer links cannot append operator-class relay or broadcast activity entries.
- Use the Rotate Collaborator Link action when a signer link leaks, and rotate the operator link if an operator-only URL should be invalidated without rebuilding the draft.
- Set `VITE_SA_RELAY_URL`, `VITE_SA_RELAY_RPC_URL`, and server-side `SA_RELAY_WIF` before enabling relay submission flows.
- Set server-only `SUPABASE_SERVICE_ROLE_KEY` so `frontend/api/draft-operator.js` can accept signed operator mutation requests for status changes, relay-preflight persistence, submission receipts, and link rotation.
- Prefer server-side `SA_RELAY_RPC_URL`, pin `SA_RELAY_ALLOWED_HASH` to the intended SA contract, and keep `SA_RELAY_ALLOW_RAW_FORWARD` disabled unless you intentionally want the relay route to forward already-signed raw transactions.
- Set `VITE_SA_EXPLORER_BASE_URL` if you want tx receipts and timeline actions to open your preferred explorer.
- Expect shared draft metadata to retain only the latest 100 activity entries and the latest 12 submission receipts.

### Documentation Map

If you want the clearest end-to-end explanation, read these docs in order:

- **How It Works & Usage Guide** — the full mental model, user roles, and practical usage path
- **Core Architecture** — deterministic verify addresses, the master contract, and execution pipelines
- **Workflow Lifecycle** — how a transaction moves from compose to sign to submit
- **Data Flow & Storage** — what lives in the browser, Supabase, relay, and on-chain boundaries
- **SDK Integration** — runtime variables, relay behavior, and deployment setup
- **Mixed Multi-Sig (N3 + EVM)** — how combined native + EVM signing works in practice
- **Morpheus Private Actions** — NeoDID / Web3Auth integration, session keys, and TEE validator private actions in `docs/MORPHEUS_PRIVATE_ACTIONS.md`

## Quickstart

### Prerequisites
- `.NET SDK 10`
- `Node.js 22.12+`
- the Neo compiler, pinned: `dotnet tool install -g neo.compiler.csharp --version 3.9.1`
- access to nuget.org. The custom contract and test projects use published packages pinned
  by `Directory.Build.props`, `nuget.config` and the `packages.lock.json` files;
  `node scripts/check_neo_platform_packages.mjs` checks the pins and
- access to nuget.org. Every contract and test project restores published packages pinned by
  `Directory.Build.props`, `nuget.config` and the `packages.lock.json` files;
  `node scripts/check_neo_platform_packages.mjs` checks the pins and
  `docs/SA-REPRODUCIBLE-BUILD.md` is the restore, build, reproduce and bump recipe. The native
  kernel and its six modules compile against the pinned core checkout and run in the public VM
  through the epoch probe; the retired `public`/`PLATFORM` artifacts are archival only
  (`docs/NEO-PLATFORM-PACKAGES.md`).
pinned MyGet Neo.VM package), builds native modules twice, and executes the measured composite
matrix. This is host-VM evidence; the [native SDK integration](docs/NATIVE_SDK.md#browser-and-validation-boundaries)
is the separate full-node gate. Neither lane activates a public network.

### Install

```bash
(cd frontend && npm ci)
(cd sdk/js && npm ci)
```

### Test

```bash
dotnet test SmartAccount.sln -c Release --nologo
(cd frontend && npm test)
(cd sdk/js && npm test)
```

`./scripts/verify_repo.sh` is the preferred local verification entrypoint for this repository.

To run the full local verification sequence in one command:

```bash
./scripts/verify_repo.sh
```

The formal gate and the private-chain validation are opt-in steps of the same
entrypoint because they need extra tooling (Coq/Rocq, Z3, a JDK with the TLA+ tools;
the `neoxp` tool and `openssl`). When not requested they are reported as NOT RUN;
when requested, a missing tool fails the gate rather than producing a pass:

```bash
./scripts/verify_repo.sh --contracts-only --formal --neoexpress
```

./scripts/verify_repo.sh --contracts-only --formal
```

The public source suite that `--neoexpress` used to run was retired with the custom track. Native
chain-side validation runs through its separate documented validators
(`scripts/neoexpress_native_*_validate.py`), and this source suite does not establish public
deployment.
`restore` runs in locked mode, so it fails with `NU1403` ("package content hash validation
failed") when the machine's global NuGet cache holds bytes that differ from the audited
`packages.lock.json` content hashes. Do not delete or edit the lock files. Restore into a fresh,
isolated package folder so every package is re-downloaded from nuget.org:

```bash
dotnet restore SmartAccount.sln -p:RestorePackagesPath=./nuget-isolated
```

### Morpheus Generated Config

`frontend/src/config/generatedMorpheusRegistry.js`, `frontend/src/config/generatedMorpheusRuntimeCatalog.js` and
`frontend/src/utils/morpheusConfidentialEnvelope.generated.js` are generated from a neo-os-services checkout
(`MORPHEUS_ORACLE_ROOT`, else a sibling `../neo-os-services`) and must not be edited by hand:

```bash
node scripts/sync_morpheus_registry.mjs --dry-run   # compare only (alias --check); exits 1 on any difference
node scripts/sync_morpheus_registry.mjs             # regenerate after reviewing the canonical change
```

`frontend/tests/morpheusCanonicalSync.test.js` runs the same comparison inside `npm test` whenever that checkout is
present. Without it the comparison is skipped and says why, unless `NEOOS_REQUIRE_SERVICES_ARTIFACTS=1` (the
release-grade cross-repository switch that `verify_repo.sh` also honours) makes the missing checkout a failure.

### Live Testnet Validation

See [`docs/TESTNET_QUICKSTART.md`](docs/TESTNET_QUICKSTART.md) for the dry-run-first entry point.

```bash
cd sdk/js
cp .env.example .env
# fill in TEST_WIF or NEO_TESTNET_WIF
npm run testnet:validate:dry-run
npm run testnet:validate
```

When public testnet RPC reliability matters, you can pin one endpoint with `TESTNET_RPC_URL` or provide a candidate list with `TESTNET_RPC_URLS`. When neither is set, the validators auto-probe the official public seeds `seed1` through `seed5.neo.org:20332` before falling back to `https://testnet1.neo.coz.io:443`.

For the off-chain Morpheus paymaster lanes, the validators also fall back to the remote worker path through `phala` (or `npx --yes phala`) when the public `paymaster/authorize` endpoint rejects a valid Phala Cloud API token with `401` or `403`.

The runner executes the v4 live testnet flow in order:

- `testnet_smoke.js`
- `testnet_plugin_matrix.js`
- `testnet_market_escrow.js`
- `testnet_paymaster_onchain.mjs`
- `testnet_paymaster_policy.mjs` when `MORPHEUS_RUNTIME_TOKEN` or `PHALA_API_TOKEN` is available, plus `SA_CORE_HASH_TESTNET` and `PAYMASTER_ACCOUNT_ID`
- `testnet_paymaster_relay.mjs` when `MORPHEUS_RUNTIME_TOKEN` or `PHALA_API_TOKEN` is available

Every stage deploys the v4 kernel and the modules it installs under their canonical manifest names, because the SDK client only adopts a contract named `SmartAccount` and the kernel binds a module by comparing the profile's `contractName` with the deployed manifest name ([§7.3](docs/SA-MODULE-PROTOCOL.md)). Only non-module contracts (paymaster, address market, test probe) carry a per-run suffix. `SA_VALIDATION_RUN_ID` names one run, `SA_VALIDATION_DEPLOY_TAG` overrides the derived tag, and `SA_MATRIX_SCENARIOS` narrows the plugin matrix to a comma-separated scenario list.

You can also run the stages individually with:

```bash
npm run testnet:validate:smoke
npm run testnet:validate:plugin-matrix
npm run testnet:validate:market
npm run testnet:validate:paymaster-onchain
npm run testnet:validate:paymaster-policy
npm run testnet:validate:paymaster
npm run testnet:validate:report
```

The suite writes JSON artifacts under `docs/reports/`.

### Platform Registrar Pointer

The registrar pointer is configured through the core's timelocked
`proposePlatformRegistrar` / `confirmPlatformRegistrar` admin path. The standalone
`SAPlatformRegistrar` service contract that consumed the pointer was removed with
the retired custom implementation, so the core now records and re-validates the
pointer without an in-repository registrar to call it.

### Build

```bash
cd frontend && npm run build
```

## Verified Testnet Status

### Historical Testnet Records

The last verifier / hook matrix is a **historical record**: it ran on **Neo N3 testnet** on
**March 13, 2026** against a deployment set that is not the current canonical one. Every positive
execution targeted `MockTransferTarget` (`tests/mocks/MockTransferTarget.cs`), the
repository's test-only target whose `transfer` returns true without moving an asset, so the record
proves the authorization path and its negative cases and never value movement. It is not the state
of this repository's acceptance today, and it is not reproduced here.

The evidence this repository can reproduce today is the local-chain suite
(`tests/localchain/README.md`). Its deployed variant runs the eight artifacts pinned by SHA-256 in
`tests/localchain/expected-deployed.json` — `SmartAccount`, `MockTransferTarget`,
`WebAuthnVerifier`, `SessionKeyVerifier`, `SAPaymaster`, `WhitelistHook`, `DailyLimitHook` and
`SocialRecoveryVerifier` — and it performs no public-chain readback.

Production note:

- `ZKEmailVerifier` is intentionally disabled until a real proof-verification implementation is added. It advertises no capability, so the core rejects installing it on an account; its validation path also fails closed as defense in depth. The previous placeholder behavior was not production-safe.

### Historical V1/V2 Validation (archived)

Earlier validation reports from **March 6-8, 2026** covered the pre-V3,
role-based wallet generation (`executeUnified`, admins/managers/thresholds,
dome/oracle unlock) and its `sdk/js/tests/sa_testnet_*` validators. That
wallet model and those validators were removed in the V3 rewrite, so the
reports no longer describe this repo's shipping surface. They are preserved
verbatim in
[`docs/reports/testnet-validation-v1v2-2026-03.md`](docs/reports/testnet-validation-v1v2-2026-03.md).

## Structure
- `contracts/native/`: True source of the native consensus `SmartAccount` service and the overlay Neo core project that compiles it.
- `contracts/plugins/`: Module contracts the native core installs.
- `contracts/plugins/validators/`: Validator modules (Web3Auth, NeoWitness, P256, TeeKey, SessionKey, Subscription, DelegatedIdentity, MultiSig, and the disabled ZKEmail template).
- `contracts/plugins/hooks/`: Hook modules (DailyLimit, Whitelist, TokenRestricted, NeoDIDCredential; MultiHook is retired).
- `contracts/plugins/recovery/`: The optional social-recovery service and the action-session validator that delegates to it.
- `contracts/plugins/templates/`: Starting points for third-party validator and hook modules.
- `contracts/plugins/native-profile/`: Native-profile builds of the shared modules.
- `contracts/build/`: Pinned artifacts of the public deployments.
- `tests/`: Contract, native and local-chain test suites, with the mock contracts they deploy in `tests/mocks/`.
- `frontend/`: Vue components demonstrating Account creation and signature workflows.
- `sdk/js/`: JavaScript/TypeScript SDK for dApp integration.
- `docs/`: Protocol design and specification standards.

## Frontend Security Status

The repository verification gate requires **0 high/critical production vulnerabilities** in both the frontend and JavaScript SDK.

The frontend still carries the upstream Web3Auth/Torus dependency chain for the active NeoDID/Web3Auth login flow. Both frontend audit modes accept only Elliptic advisory `GHSA-848j-6mx2-7j84` and deepmerge advisory `GHSA-gcqx-w48m-w2h4`, each at most low severity, including findings propagated through dependent packages. A new advisory on any package, any severity increase, and malformed or incomplete audit reports fail the gate. These remaining advisories have no patched release; passing the gate does not mean zero vulnerabilities. See [the dependency security assessment](docs/FRONTEND_DEPENDENCY_SECURITY.md) for exposure and upgrade constraints. The SDK runs a separate production-only audit so its smaller dependency surface cannot regress silently.
