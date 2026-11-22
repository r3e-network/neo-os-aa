# Neo N3 Smart Account (ERC-4337 equivalent)

This project contains the comprehensive standard, smart contract implementation, frontend tooling, and SDK for creating and utilizing Smart Accounts on the Neo N3 blockchain.

Current status note:

- The current `main` branch ships **protocol version 4** — one `SmartAccount` protocol, implemented by the native kernel in `contracts/native/SmartAccount/`.
- v4 keeps the core minimalist: authorization and policy are module instances (`validator` and `hook`), installed through configuration intents instead of bound verifier/hook fields.
- The canonical mainnet SA anchor now points to the clean deploy `0x0268a387913b250166ddec032b03332690a1ef78` and resolves from `smartwallet.neo` plus `sa.morpheus.neo`.
- The canonical shared testnet SA anchor now points to the clean deployment `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2`, with shared `Web3AuthVerifier` `0x1111f5b6b046a964c75d208998c13945ce172e85`.

## Features
- **Deterministic v4 Accounts**: the account id is `hash160(0xAA524704 || custody || salt)`, and the asset-holding address is the proxy script that embeds it, so no per-user wallet logic is deployed.
- **Validator Module Authorization**: install `Web3AuthValidator`, `NeoWitnessValidator`, `P256Validator`, `TeeKeyValidator`, `SessionKeyValidator`, `SubscriptionValidator`, `DelegatedIdentityValidator`, or `MultiSigValidator` as a threshold policy.
- **Hook Module Policy Enforcement**: attach ordered hook modules for daily limits, token restrictions, target allowlists and credential gates; `preCheck` runs forward and `postCheck` reverse over the same snapshot.
- **Cross-Chain EVM Compatibility**: secp256k1 / Keccak256 EIP-712 operation signatures through the `Web3AuthValidator` path.
- **Core-Owned Recovery**: custody self-rescue plus an optional recovery authority behind a 7–90 day per-account timelock; matured recovery is permissionless and removes modules callback-free.
- **Policy-Gated Execution**: integrations flow through `executeUserOp(accountId, op)` (or `executeUserOps` for a batch), where nonce handling, validation, hooks and target execution stay centralized.

## App Deployment

The frontend separates:

- a marketing-style home page,
- and an app workspace for account creation and operation flow.

For a Vercel deployment, set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SA_RELAY_URL`, and `VITE_SA_RELAY_RPC_URL`, then apply every file in `supabase/migrations/` in filename order — the chain is replayable end to end on a fresh database. Its CI replay gate is currently disabled (`.github/workflows/supabase-migrations.yml.disabled`, deliberately parked on 2026-09-27 to drop the CI runner cost; see the deployment checklist below for the current manual replay step). The full chain keeps the public share link read-only, narrows collaborator links to signature-safe writes, moves operator-only status/relay mutations behind the signed operator mutation server route in `frontend/api/draft-operator.js`, and bounds anonymous draft payloads. `supabase/migrations/20260327_security_hardening.sql` and `supabase/migrations/20260611_draft_metadata_hardening.sql` are mandatory — without them the draft tables keep permissive RLS policies, racy metadata writers, and unbounded anonymous draft creation.

If you deploy the bundled server routes, keep `SUPABASE_SERVICE_ROLE_KEY` and `SA_RELAY_WIF` on the server, prefer `SA_RELAY_RPC_URL` for the relay backend, pin `SA_RELAY_ALLOWED_HASH` to the intended SA contract, and leave `SA_RELAY_ALLOW_RAW_FORWARD=0` unless you explicitly want raw passthrough in `frontend/api/relay-transaction.js`.
For local setup, start from `frontend/.env.example` and copy the values you need into `frontend/.env.local` or your hosting provider's environment-variable dashboard.

### Validation Preview And Trust Boundaries

Production integrations should treat the core SA runtime as having three distinct boundaries:

- **validation preview**: the read-only `validateUserOp(accountId, op)` runs the real verification path — status, epoch, deadline, nonce channel, validator route and hook instances — and returns a structured result without writing state
- **authorization**: only the routed validator instance, the threshold policy, or the built-in custody route (gated by the default authorizations) can authorize `executeUserOp`
- **execution**: hooks and target contracts still run after authorization and can still reject the operation

The relay is an operator convenience layer, not an authority layer:

- **relay trust boundary**: the relay can simulate, package, and submit, but it cannot authorize on behalf of the account
- relay preflight and validation preview help operators simulate readiness before submit
- relay submission can package and pay for transactions, but it does not replace on-chain signature validation

### Module Lifecycle

Configuration is an intent, and every step is an event:

- **propose**: `ConfigurationIntentProposed` records the actions, the read set and the authority epoch
- **install**: `ModuleInstalled` and `ModuleInstanceInstalled` carry the module id, so two instances of one contract stay distinguishable
- **configure**: `ModuleInstanceConfigured` runs after the module's own command array
- **replace code**: `ModuleCodeRebound` points an instance at new code
- **remove**: `ModuleRemoved` and `ModuleInstanceRemoved`, including the callback-free sweep during settlement or recovery
- **cancel**: `ConfigurationIntentCancelled`, `ConfigurationIntentExpired` and `ModuleUpdateCancelled`
- **order and threshold**: `HookOrderSet` and `ThresholdPolicySet`

New configuration matures after 24 hours and expires seven days later; registration, emergency freeze and callback-free credential revocation are the only immediate paths. Indexers and dashboards should read the instance events — they name the module id, which the legacy verifier/hook events could not.

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
- `oracle.morpheus.neo` resolves to the superseded oracle `0x5b492098fc094c760402e01f7e0b631b939d2bea`; never integrate through it

Current published Morpheus CVM attestation anchors:

- Oracle request/response CVM: `oracle-morpheus-neo-r3e` / `ddff154546fe22d15b65667156dd4b7c611e6093`
- Oracle attestation explorer: `https://cloud.phala.com/explorer/app_ddff154546fe22d15b65667156dd4b7c611e6093`
- DataFeed CVM: `datafeed-morpheus-neo-r3e` / `ac5b6886a2832df36e479294206611652400178f`
- DataFeed attestation explorer: `https://cloud.phala.com/explorer/app_ac5b6886a2832df36e479294206611652400178f`

Do not conflate the SA recovery verifier with the independent NeoDID registry:

- `SocialRecoveryVerifier` is the SA-specific recovery verifier
- `NeoDIDRegistry` is the independent Morpheus identity / action-ticket registry

Current validation references:

- `docs/SECURITY_MODEL.md` is the bounded-claim ledger for verifiers, hooks and recovery paths.
- `docs/PROTOCOL_COMPLETENESS_AUDIT.md` states protocol coverage and the deployment gates that remain open.

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
- **Morpheus Private Actions** — NeoDID / Web3Auth integration, session keys, and TEE verifier private actions in `docs/MORPHEUS_PRIVATE_ACTIONS.md`

## Quickstart

### Prerequisites
- `.NET SDK 10`
- `Node.js 22+`

### Install

```bash
cd frontend && npm ci
cd ../sdk/js && npm ci
```

### Test

```bash
dotnet test SmartAccount.sln -c Release --nologo
cd frontend && npm test
cd sdk/js && npm test
```

`./scripts/verify_repo.sh` is the preferred local verification entrypoint for this repository.

To run the full local verification sequence in one command:

```bash
./scripts/verify_repo.sh
```

### Live Testnet Validation

```bash
cd sdk/js
cp .env.example .env
# fill in TEST_WIF or NEO_TESTNET_WIF
npm run testnet:validate:dry-run
npm run testnet:validate
```

When public testnet RPC reliability matters, you can pin one endpoint with `TESTNET_RPC_URL` or provide a candidate list with `TESTNET_RPC_URLS`. When neither is set, the validators auto-probe the official public seeds `seed1` through `seed5.neo.org:20332` before falling back to `https://testnet1.neo.coz.io:443`.

For the off-chain Morpheus sponsorship lanes, the validators fall back to the remote worker path through `phala` (or `npx --yes phala`) when the public `paymaster/authorize` endpoint rejects a valid Phala Cloud API token with `401` or `403`.

The runner executes the v4 live testnet flow in order:

- `testnet_smoke.js`
- `testnet_plugin_matrix.js`

Every stage deploys the v4 kernel and the modules it installs under their canonical manifest names, because the SDK client only adopts a contract named `SmartAccount` and the kernel binds a module by comparing the profile's `contractName` with the deployed manifest name. Only non-module contracts (the test probe, for example) carry a per-run suffix. `SA_VALIDATION_RUN_ID` names one run, `SA_VALIDATION_DEPLOY_TAG` overrides the derived tag, and `SA_MATRIX_SCENARIOS` narrows the plugin matrix to a comma-separated scenario list.

You can also run the stages individually with:

```bash
npm run testnet:validate:smoke
npm run testnet:validate:plugin-matrix
npm run testnet:validate:report
```

The suite writes JSON artifacts under `docs/reports/`.

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
`tests/localchain/expected-deployed.json` — `SmartAccountV3`, `MockTransferTarget`,
`WebAuthnVerifier`, `SessionKeyVerifier`, `SAPaymaster`, `WhitelistHook`, `DailyLimitHook` and
`SocialRecoveryVerifier` — and it performs no public-chain readback.

Production note:

- `ZKEmailVerifier` is intentionally disabled until a real proof-verification implementation is added. The previous placeholder behavior was not production-safe.

### Historical V1/V2 Validation (archived)

Earlier validation reports from **March 6-8, 2026** covered the pre-V3,
role-based wallet generation (`executeUnified`, admins/managers/thresholds,
dome/oracle unlock) and its `sdk/js/tests/aa_testnet_*` validators. That
wallet model and those validators were removed in the V3 rewrite, so the
reports no longer describe this repo's shipping surface. They are preserved
verbatim in
[`docs/reports/testnet-validation-v1v2-2026-03.md`](docs/reports/testnet-validation-v1v2-2026-03.md).

## Structure
- `contracts/`: C# Smart Contract implementation of the Master Entry Contract.
- `contracts/plugins/validators/`: Validator modules (Web3Auth, NeoWitness, P256, TEE, SessionKey, Subscription, DelegatedIdentity, MultiSig, and the disabled ZKEmail template).
- `contracts/plugins/hooks/`: Hook modules (DailyLimit, Whitelist, TokenRestricted, NeoDIDCredential; MultiHook is retired).
- `contracts/plugins/recovery/`: Optional social-recovery service and action-session validator; base recovery is core-native.
- `contracts/native/SmartAccount/`: The native SmartAccount kernel that implements the v4 protocol.
- `frontend/`: Vue components demonstrating Account creation and signature workflows.
- `sdk/js/`: JavaScript/TypeScript SDK for dApp integration.
- `docs/`: Protocol design and specification standards.

## Frontend Security Status

The repository verification gate requires **0 high/critical production vulnerabilities** in both the frontend and JavaScript SDK.

The frontend still carries the upstream Web3Auth/Torus dependency chain for the active NeoDID/Web3Auth login flow. Both frontend audit modes accept only Elliptic advisory `GHSA-848j-6mx2-7j84` and deepmerge advisory `GHSA-gcqx-w48m-w2h4`, each at most low severity, including findings propagated through dependent packages. A new advisory on any package, any severity increase, and malformed or incomplete audit reports fail the gate. These remaining advisories have no patched release; passing the gate does not mean zero vulnerabilities. See [the dependency security assessment](docs/FRONTEND_DEPENDENCY_SECURITY.md) for exposure and upgrade constraints. The SDK runs a separate production-only audit so its smaller dependency surface cannot regress silently.
