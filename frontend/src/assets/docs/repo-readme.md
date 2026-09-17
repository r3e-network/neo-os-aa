# Neo N3 Abstract Account (ERC-4337 equivalent)

This project contains the comprehensive standard, smart contract implementation, frontend tooling, and SDK for creating and utilizing Abstract Accounts on the Neo N3 blockchain.

Current status note:

- The current `main` branch runs `UnifiedSmartWalletV3`.
- V3 removes the old role-heavy / dome-heavy core wallet model and replaces it with a minimalist account core plus verifier and hook plugins.
- The canonical mainnet AA anchor now points to the clean deploy `0x0268a387913b250166ddec032b03332690a1ef78` and resolves from `smartwallet.neo` plus `aa.morpheus.neo`.
- The canonical shared testnet AA anchor now points to the clean deployment `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2`, with shared `Web3AuthVerifier` `0x7147f9a508594a7656a25f45d0a7a7dede7c227f`.

## Features
- **Deterministic V3 Accounts**: Each account is keyed by a 20-byte `accountId` and derives a stable Neo virtual address without deploying per-user wallet logic.
- **Verifier Plugin Authorization**: Bind Web3Auth, TEE, WebAuthn, session keys, multisig, or other verifier plugins per account.
- **Hook Plugin Policy Enforcement**: Attach optional hook plugins for daily limits, token restrictions, credential gates, and post-execution controls.
- **Backup-Owner Escape Hatch**: Every account can define a native Neo backup owner plus timelocked verifier rotation.
- **Trustless AA Address Escrow Market**: Deterministic AA addresses can be listed, escrow-locked, purchased with GAS, and transferred atomically on-chain.
- **Cross-Chain EVM Compatibility**: V3 supports secp256k1 / Keccak256 EIP-712 `UserOperation` signatures through the Web3Auth verifier path.
- **On-Chain Paymaster (Sponsored Transactions)**: The `AAPaymaster` contract enables trustless gasless execution — sponsors deposit GAS, create per-account or global sponsorship policies, and relays are reimbursed automatically after successful `UserOp` execution. Supports per-op limits, daily budgets, total budgets, target/method restrictions, and expiry timestamps.
- **Policy-Gated Execution**: New integrations should flow through `executeUserOp(accountId, op)` where nonce handling, verification, hooks, and target execution stay centralized.

## App + Market Deployment

The frontend now separates:

- a marketing-style home page,
- an app workspace for account creation and operation flow,
- and a trustless AA address market backed by an on-chain escrow contract.

For the market UI, set `VITE_AA_MARKET_HASH` to the deployed `AAAddressMarket` contract hash.

For a Vercel deployment, set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_AA_RELAY_URL`, and `VITE_AA_RELAY_RPC_URL`, then apply every file in `supabase/migrations/` in filename order — the chain is replayable end to end on a fresh database and is exercised against a scratch Postgres by `.github/workflows/supabase-migrations.yml` on every change. The full chain keeps the public share link read-only, narrows collaborator links to signature-safe writes, moves operator-only status/relay mutations behind the signed operator mutation server route in `frontend/api/draft-operator.js`, and bounds anonymous draft payloads. `supabase/migrations/20260327_security_hardening.sql` and `supabase/migrations/20260611_draft_metadata_hardening.sql` are mandatory — without them the draft tables keep permissive RLS policies, racy metadata writers, and unbounded anonymous draft creation.

If you deploy the bundled server routes, keep `SUPABASE_SERVICE_ROLE_KEY` and `AA_RELAY_WIF` on the server, prefer `AA_RELAY_RPC_URL` for the relay backend, pin `AA_RELAY_ALLOWED_HASH` to the intended AA contract, and leave `AA_RELAY_ALLOW_RAW_FORWARD=0` unless you explicitly want raw passthrough in `frontend/api/relay-transaction.js`.
For local setup, start from `frontend/.env.example` and copy the values you need into `frontend/.env.local` or your hosting provider's environment-variable dashboard.

For on-chain sponsored transactions via the `AAPaymaster` contract, set `VITE_AA_PAYMASTER_HASH` to the deployed Paymaster contract hash. Sponsors deposit GAS into the Paymaster, create sponsorship policies via `setPolicy`, and relays call `executeSponsoredUserOp` on the AA core. The core validates the policy, executes the UserOp, then settles the reimbursement atomically. See the SDK's `createSponsoredUserOpPayload` and `validatePaymasterOp` methods.

If you want relay submission to request Morpheus off-chain sponsorship before broadcasting, also configure the server-side paymaster bridge:

- `MORPHEUS_PAYMASTER_TESTNET_ENDPOINT`
- `MORPHEUS_PAYMASTER_TESTNET_API_TOKEN`
- `MORPHEUS_PAYMASTER_MAINNET_ENDPOINT`
- `MORPHEUS_PAYMASTER_MAINNET_API_TOKEN`
- Optional debug only: `AA_RELAY_INCLUDE_RAW_ERRORS=1`

The relay route now forwards optional paymaster metadata and can request Morpheus paymaster pre-authorization before broadcasting a relay-ready `executeUserOp` or `executeUnifiedByAddress` invocation. Failures are now phase-tagged as `preview`, `paymaster`, `relay`, or `response` so operator logs can separate Morpheus sponsorship errors from on-chain relay failures.

### Validation Preview And Trust Boundaries

Production integrations should treat the core AA runtime as having three distinct boundaries:

- **validation preview**: `previewUserOpValidation(accountId, op)` is a read-only check for deadline validity, nonce acceptability, and current verifier/hook bindings
- **authorization**: only the configured verifier plugin or backup-owner witness can authorize `executeUserOp`
- **execution**: hooks and target contracts still run after authorization and can still reject the operation

The relay is an operator convenience layer, not an authority layer:

- **relay trust boundary**: the relay can simulate, package, and submit, but it cannot authorize on behalf of the account
- relay preflight and validation preview help operators simulate readiness before submit
- relay submission can package and pay for transactions, but it does not replace on-chain signature validation
- paymaster sponsorship (on-chain or off-chain) does not replace the configured verifier or backup-owner witness
- paymaster does not authorize execution — it only funds the relay reimbursement after successful verification

### Module Lifecycle

V3 now exposes a generic module lifecycle for new tooling while preserving the legacy verifier/hook events for compatibility.

- **install**: first binding of a verifier or hook emits `ModuleInstalled`
- **replace**: timelocked rotations emit `ModuleUpdateInitiated` and later `ModuleUpdateConfirmed`
- **remove**: clearing a binding, escape-driven clearing, or market-settlement cleanup emits `ModuleRemoved`
- **cancel**: aborting a pending verifier or hook rotation emits `ModuleUpdateCancelled`

This generic lifecycle is the recommended surface for indexers, dashboards, and operational tooling that should not care whether the bound module is a verifier or a hook.

## Canonical Morpheus Network Anchors

When this repo references Morpheus-integrated addresses, treat the following as the current canonical Neo N3 anchors:

| Item | Mainnet | Testnet |
| --- | --- | --- |
| AA core | `0x0268a387913b250166ddec032b03332690a1ef78` | `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2` |
| AA runtime label | `UnifiedSmartWalletV3` | `UnifiedSmartWalletV3` |
| Morpheus Oracle | `0xf54d8584ef82315c1800373272ab08ae0db2d5ef` | `0xf54d8584ef82315c1800373272ab08ae0db2d5ef` |
| Morpheus DataFeed | `0x03013f49c42a14546c8bbe58f9d434c3517fccab` | `0x9bea75cf702f6afc09125aa6d22f082bfd2ee064` |
| Oracle callback consumer | `0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844` | `0x8c506f224d82e67200f20d9d5361f767f0756e3b` |
| NeoDIDRegistry | `0xb81f31ea81e279793b30411b82c2e82078b63105` | unpublished in the shared registry |
| AA Web3AuthVerifier | `0xf5c452cd4ba29dcdc47026383568c0d8b38d9272` | `0x7147f9a508594a7656a25f45d0a7a7dede7c227f` |
| SocialRecoveryVerifier v2 | `0xfb3f605fc6bcd59d265d7c18230093d7dc24ac26` | `recovery.smartwallet.neo` |

The Morpheus Oracle (MiniApp-OS kernel v2) has the same contract hash on mainnet and testnet. The testnet hash `0x4b882e94ed766807c4fd728768f972e13008ad52` still seen in older records is the retired v1 oracle — do not integrate against it.

Domain rules:

- mainnet AA domain: `smartwallet.neo`
- mainnet AA additional alias: `aa.morpheus.neo`
- mainnet NeoDID domain: `neodid.morpheus.neo`
- testnet currently has no shared AA / NeoDID NNS aliases

Current published Morpheus CVM attestation anchors:

- Oracle request/response CVM: `oracle-morpheus-neo-r3e` / `ddff154546fe22d15b65667156dd4b7c611e6093`
- Oracle attestation explorer: `https://cloud.phala.com/explorer/app_ddff154546fe22d15b65667156dd4b7c611e6093`
- DataFeed CVM: `datafeed-morpheus-neo-r3e` / `ac5b6886a2832df36e479294206611652400178f`
- DataFeed attestation explorer: `https://cloud.phala.com/explorer/app_ac5b6886a2832df36e479294206611652400178f`

Do not conflate the AA recovery verifier with the independent NeoDID registry:

- `SocialRecoveryVerifier` is the AA-specific recovery verifier
- `NeoDIDRegistry` is the independent Morpheus identity / action-ticket registry

Current validation references:

- `docs/PLUGIN_MATRIX.md` captures the active verifier / hook matrix.
- `docs/PAYMASTER_RELAY_VALIDATION.md` captures the active AA paymaster relay path (off-chain Morpheus flow).
- The on-chain `AAPaymaster` contract provides an alternative trustless sponsorship model without off-chain dependencies.

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

- Apply every file in `supabase/migrations/` in filename order (`20260308_home_operations_workspace.sql` through `20260611_draft_metadata_hardening.sql`). The chain replays cleanly on a fresh database; do not cherry-pick individual files.
- Treat `supabase/migrations/20260327_security_hardening.sql` as mandatory: it removes the permissive `aa_account_metadata` RLS policies, revokes direct table access on `aa_transaction_drafts`, and fixes the signature-append race.
- Treat `supabase/migrations/20260611_draft_metadata_hardening.sql` as mandatory: it locks the remaining draft metadata writers against lost updates, bounds anonymous `create_aa_draft` payloads (64 KiB cap, array caps, inbound activity/receipt trimming), and revokes anon execute on the internal activity-scope helper.
- The migration chain is replay-tested in CI by `.github/workflows/supabase-migrations.yml`, which applies every file in filename order against a scratch Postgres 16 and then runs `supabase/tests/replay_assertions.sql`.
- Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` for browser-side anonymous draft persistence.
- Share the normal draft URL for read-only review, the collaborator link for signature collection, and the operator link for relay checks, broadcast, and other operator-only actions. Signer links cannot append operator-class relay or broadcast activity entries.
- Use the Rotate Collaborator Link action when a signer link leaks, and rotate the operator link if an operator-only URL should be invalidated without rebuilding the draft.
- Set `VITE_AA_RELAY_URL`, `VITE_AA_RELAY_RPC_URL`, and server-side `AA_RELAY_WIF` before enabling relay submission flows.
- Set server-only `SUPABASE_SERVICE_ROLE_KEY` so `frontend/api/draft-operator.js` can accept signed operator mutation requests for status changes, relay-preflight persistence, submission receipts, and link rotation.
- Prefer server-side `AA_RELAY_RPC_URL`, pin `AA_RELAY_ALLOWED_HASH` to the intended AA contract, and keep `AA_RELAY_ALLOW_RAW_FORWARD` disabled unless you intentionally want the relay route to forward already-signed raw transactions.
- Set `VITE_AA_EXPLORER_BASE_URL` if you want tx receipts and timeline actions to open your preferred explorer.
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
dotnet test neo-abstract-account.sln -c Release --nologo
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
# fill in TEST_WIF
npm run testnet:validate:dry-run
npm run testnet:validate
```

When public testnet RPC reliability matters, you can pin one endpoint with `TESTNET_RPC_URL` or provide a candidate list with `TESTNET_RPC_URLS`. When neither is set, the validators auto-probe the official public seeds `seed1` through `seed5.neo.org:20332` before falling back to `https://testnet1.neo.coz.io:443`.

For the off-chain Morpheus paymaster lanes, the validators also fall back to the remote worker path through `phala` (or `npx --yes phala`) when the public `paymaster/authorize` endpoint rejects a valid Phala Cloud API token with `401` or `403`.

The runner now executes the current V3 live testnet flow in order:

- `v3_testnet_smoke.js`
- `v3_testnet_plugin_matrix.js`
- `v3_testnet_market_escrow.js`
- `v3_testnet_paymaster_onchain.mjs`
- `v3_testnet_paymaster_policy.mjs` when `MORPHEUS_RUNTIME_TOKEN` or `PHALA_API_TOKEN` is available
- `v3_testnet_paymaster_relay.mjs` when `MORPHEUS_RUNTIME_TOKEN` or `PHALA_API_TOKEN` is available

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

The suite writes JSON artifacts under `sdk/docs/reports/`.

### Shared Platform Account Bootstrap

The shared platform-account registrar is enabled in a separate, testnet-only AA upgrade before the PlatformRegistry reciprocal configuration. Start with a read-only exact-update simulation using the AA core's public admin identity:

```bash
AA_TESTNET_UPDATE_SIGNER=<public-AA-admin-address-or-script-hash> \
  node scripts/upgrade_testnet_unified_smart_wallet.js
```

The helper verifies testnet magic, the local `UnifiedSmartWalletV3` artifact, the live update surface, and the exact `update` preview. It writes `docs/reports/testnet-unified-smart-wallet-upgrade-latest.json` without signing or broadcasting. Execution requires `--execute`, `CONFIRM_AA_TESTNET_UPDATE=I_UNDERSTAND_THIS_WRITES_CHAIN`, and `AA_TESTNET_UPDATE_WIF`; the WIF-derived signer must match the public identity used for the preview. After a successful upgrade, rerun the platform shared-AA preflight before configuring the Registry core.

### Build

```bash
cd frontend && npm run build
```

## Verified Testnet Status

### V3 Plugin Matrix

The current V3 verifier / hook matrix was revalidated on **Neo N3 testnet** on **March 13, 2026** with live deployments and adversarial negative cases.

Canonical report:

- `docs/PLUGIN_MATRIX.md`

Verified on-chain in that matrix:

- `Web3AuthVerifier`
- `TEEVerifier`
- `WebAuthnVerifier`
- `SessionKeyVerifier`
- `MultiSigVerifier`
- `SubscriptionVerifier`
- `WhitelistHook`
- `DailyLimitHook`
- `TokenRestrictedHook`
- `MultiHook`
- `NeoDIDCredentialHook`

Security outcomes:

- direct external plugin configuration attempts fault
- typed-data tampering faults
- nonce replay faults
- session-key method overreach faults
- subscription overcharge and replay faults
- whitelist bypass attempts fault
- restricted-target access faults
- credential-missing / revoked-credential access faults
- NeoDID credential gating now checks the on-chain `NeoDIDRegistry` instead of local hook-issued flags

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
- `contracts/verifiers/`: Verifier plugins (Web3Auth, TEE, WebAuthn, SessionKey, MultiSig, etc.).
- `contracts/hooks/`: Hook plugins (DailyLimit, Whitelist, TokenRestricted, MultiHook, NeoDIDCredential).
- `contracts/paymaster/`: On-chain Paymaster contract for sponsored/gasless transactions.
- `frontend/`: Vue components demonstrating Account creation and signature workflows.
- `sdk/js/`: JavaScript/TypeScript SDK for dApp integration.
- `docs/`: Protocol design and specification standards.

## Frontend Security Status

The repository verification gate requires **0 high/critical production vulnerabilities** in both the frontend and JavaScript SDK.

The frontend still carries a bounded upstream Web3Auth/Torus/MetaMask/Solana dependency chain for the active NeoDID/Web3Auth login flow. `scripts/check_frontend_audit_allowlist.mjs` permits only the reviewed low/moderate package families and fails when a new package appears, an allowed package exceeds its reviewed severity, or any finding rises to high/critical. The SDK runs a separate production-only audit so its smaller dependency surface cannot regress silently.
