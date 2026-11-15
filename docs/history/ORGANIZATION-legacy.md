# neo-os-aa Organization

## Repository Purpose

**Sole authority** for account abstraction (`protocol-aa-core`): user operations, proxy verification, recovery. AA decides whether an actor authorized an operation and nothing more.

**Scope**: L1 chain-protocol layer in v2 architecture, component C03 (account).

**Key boundary**: AA does NOT grant DID eligibility, hold network identity, or select signers. No dependency on DID registry. Operation-policy layer composes `AAAuthorization` with independently verified `EligibilityProof`.

## Directory Structure

```
neo-os-aa/
├── contracts/            # SmartAccountV3, verifier/hook plugins, paymaster, market, registrar (platform-service contracts)
├── frontend/             # App workspace, marketing home, trustless AA market UI
│   ├── src/
│   │   └── config/generatedMorpheusRegistry.js  # Generated from neo-os-services
│   ├── api/              # Server routes (relay, operator mutations)
│   ├── tests/
│   │   └── morpheusRegistryDocs.test.js  # Keeps docs equal to generated
│   └── .env.example      # Environment setup template
├── supabase/
│   └── migrations/       # Replayable migration chain (ordered by filename)
├── sdk/                  # Account creation, UserOp SDK
└── docs/                 # Integration guides
```

## File Organization Rules

### Generated Registry (DO NOT EDIT)
- `frontend/src/config/generatedMorpheusRegistry.js` generated from `neo-os-services`
- Test `frontend/tests/morpheusRegistryDocs.test.js` keeps docs equal to generated
- Generated registry wins on conflicts with manual docs

### Supabase Migrations
- Replayable end-to-end on fresh database
- Apply in filename order
- CI replay gate `.github/workflows/supabase-migrations.yml.disabled`: disabled since 2026-09-27 (runner-cost decision); replay is a manual step (scratch Postgres 16 + `supabase/tests/replay_assertions.sql`) until re-enabled by removing the `.disabled` suffix
- **MANDATORY**: `20260327_security_hardening.sql`, `20260611_draft_metadata_hardening.sql`
- Without hardening: permissive RLS, racy metadata writers, unbounded anonymous drafts

### Environment Configuration
- Start from `frontend/.env.example`
- Copy to `frontend/.env.local` or hosting provider dashboard
- Keep `SUPABASE_SERVICE_ROLE_KEY` and `AA_RELAY_WIF` on server only
- Set `AA_RELAY_ALLOWED_HASH` to intended AA contract
- Leave `AA_RELAY_ALLOW_RAW_FORWARD=0` unless explicit passthrough needed

## Current Implementation (V3)

### SmartAccountV3
- Mainnet: `0x0268a387913b250166ddec032b03332690a1ef78`
- Testnet: `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2`
- Mainnet NeoNS: `morpheus-aa.miniapp.neo`, `morpheus-aa-alias.miniapp.neo`
- Shared testnet Web3AuthVerifier: `0x1111f5b6b046a964c75d208998c13945ce172e85`

### V3 Features
- **Deterministic Accounts**: 20-byte `accountId`, stable Neo virtual address, no per-user wallet deployment
- **Verifier Plugin Authorization**: Web3Auth, TEE, WebAuthn, session keys, multisig
- **Hook Plugin Policy**: Daily limits, token restrictions, credential gates, post-execution controls
- **Backup-Owner Escape Hatch**: Native Neo backup owner + timelocked verifier rotation
- **AA Address Market**: Deterministic addresses listed, escrow-locked, purchased with GAS, transferred atomically
- **EVM Compatibility**: secp256k1/Keccak256 EIP-712 `UserOperation` signatures via Web3Auth verifier
- **On-Chain Paymaster**: Gasless execution, sponsors deposit GAS, per-account/global policies, automatic reimbursement
- **Policy-Gated Execution**: `executeUserOp(accountId, op)` centralizes nonce, verification, hooks, execution

## What Belongs Here

**YES**
- AA core contracts (SmartAccountV3)
- Verifier plugins (Web3Auth, TEE, WebAuthn, session keys, multisig)
- Hook plugins (limits, restrictions, gates, controls)
- AAPaymaster contract
- AAAddressMarket contract
- Frontend AA app workspace
- Trustless AA market UI
- SDK for account creation and UserOps
- Relay server routes
- Supabase migrations for AA state
- Integration guides

**NO**
- DID registry → `neo-os-did` (no dependency)
- Network identity → `neo-os-services`
- Signer selection → `neo-os-services`
- Platform contracts → `neo-os-contracts`
- Runtime host → `neo-os-web`
- General SDK → `neo-os-devpack`
- DID eligibility (composes independently with AA authorization)

## Cross-Repository Dependencies

### This repo provides TO
- `neo-os-web` - AA authorization layer
- `neo-os-services` - AA contract addresses and verifier plugins
- All apps - AA account creation and sponsored transactions
- `neo-os-devpack` - AA SDK types

### This repo depends ON
- `neo-os-services` - Generated Morpheus registry (network anchors)
- `neo-os-contracts` - Platform contract patterns (optional)
- None for DID (independent composition)

### Architecture Binding
- Declared in `neo-os-web/docs/workspace/neoos-target-architecture.v1.json`
- Checked by architecture source-coverage gate
- v2 proposal in `neoos-target-architecture.v2.json` (status `PROPOSED`)

## Trust Boundaries

### Three Distinct Boundaries
1. **Validation preview**: `previewUserOpValidation(accountId, op)` - read-only check (deadline, nonce, bindings)
2. **Authorization**: Only configured verifier plugin or backup-owner witness can authorize `executeUserOp`
3. **Execution**: Hooks and target contracts run after authorization, can still reject

### Relay Trust Boundary
- Relay is operator convenience, NOT authority
- Can simulate, package, submit - CANNOT authorize on behalf of account
- Preflight helps simulate readiness before submit
- Submission packages/pays but does NOT replace on-chain signature validation
- Paymaster sponsorship (on-chain/off-chain) does NOT replace verifier/backup-owner witness
- Paymaster does NOT authorize execution - only funds relay reimbursement after verification

## Module Lifecycle

Generic lifecycle for verifiers and hooks:
- **install**: First binding → `ModuleInstalled`
- **replace**: Timelocked rotation → `ModuleUpdateInitiated` → `ModuleUpdateConfirmed`
- **remove**: Clear binding/escape/market cleanup → `ModuleRemoved`
- **cancel**: Abort pending rotation → `ModuleUpdateCancelled`

Recommended surface for indexers, dashboards, operational tooling (agnostic to verifier vs hook).

## Deployment Configuration

### Required Environment Variables
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- `VITE_AA_RELAY_URL`, `VITE_AA_RELAY_RPC_URL`
- `VITE_AA_MARKET_HASH` (deployed AAAddressMarket contract)
- `VITE_AA_PAYMASTER_HASH` (deployed AAPaymaster contract)

### Server-Only Secrets
- `SUPABASE_SERVICE_ROLE_KEY`
- `AA_RELAY_WIF`
- `AA_RELAY_ALLOWED_HASH` (pin to intended AA contract)
- `AA_RELAY_ALLOW_RAW_FORWARD=0` (keep disabled unless explicit need)

### Optional Morpheus Paymaster Bridge
- `MORPHEUS_PAYMASTER_TESTNET_ENDPOINT`, `MORPHEUS_PAYMASTER_TESTNET_API_TOKEN`
- `MORPHEUS_PAYMASTER_MAINNET_ENDPOINT`, `MORPHEUS_PAYMASTER_MAINNET_API_TOKEN`
- `AA_RELAY_INCLUDE_RAW_ERRORS=1` (debug only)

### Relay Features
- Forwards optional paymaster metadata
- Requests Morpheus paymaster pre-authorization before broadcasting
- Phase-tagged failures: `preview`, `paymaster`, `relay`, `response`
- Separates sponsorship errors from on-chain relay failures

## Paymaster (Sponsored Transactions)

### On-Chain Paymaster (`AAPaymaster`)
- Sponsors deposit GAS into Paymaster contract
- Create policies via `setPolicy` (per-account or global)
- Relays call `executeSponsoredUserOp` on AA core
- Core validates policy, executes UserOp, settles reimbursement atomically
- Policy features: per-op limits, daily budgets, total budgets, target/method restrictions, expiry

### SDK Methods
- `createSponsoredUserOpPayload` - Create sponsored UserOp
- `validatePaymasterOp` - Validate paymaster operation

## Verification Commands

**Primary gates**:
```bash
npm test                          # All tests
npm run typecheck                 # TypeScript validation
npm run test:contracts            # Contract tests
npm run test:migrations           # Supabase migration chain
```

**Architecture compliance** (run from `neo-os-web`):
```bash
npm run check:architecture        # v1 (enforced)
npm run check:architecture:v2     # v2 (proposed)
```

## Maintenance Guidelines

### Before Commit
1. Run full test suite
2. Verify Supabase migrations replayable
3. Test contract changes on testnet
4. Update generated registry if service anchors change
5. Run `morpheusRegistryDocs.test.js` to verify docs match generated

### Contract Changes
1. Edit contracts in `contracts/`
2. Add/update tests
3. Deploy to testnet
4. Test with frontend
5. Update SDK if interfaces change
6. Deploy to mainnet
7. Update `generatedMorpheusRegistry.js` via neo-os-services
8. Verify NeoNS resolution

### Frontend Changes
1. Edit frontend in `frontend/src/`
2. Test locally
3. Verify relay routes work
4. Test AA market UI
5. Check Supabase RLS policies
6. Deploy to Vercel
7. Verify production endpoints

### Migration Changes
1. Add new migration file (ordered filename)
2. Test on fresh database
3. Verify replayable from scratch
4. Check CI workflow passes
5. Ensure hardening migrations present
6. Document migration purpose

### SDK Changes
1. Edit SDK in `sdk/`
2. Update TypeScript types
3. Test with sample UserOps
4. Update documentation
5. Test sponsored transactions
6. Version bump per semver

### Relay Configuration
1. Keep secrets server-side only
2. Pin `AA_RELAY_ALLOWED_HASH`
3. Disable raw forward unless explicit need
4. Configure Morpheus paymaster bridge if needed
5. Monitor phase-tagged errors
6. Test pre-authorization flow

## Security Boundaries

**Authorization**: Only verifier plugin or backup-owner authorizes. Relay cannot authorize.

**Paymaster**: Funds reimbursement, does NOT authorize execution.

**DID independence**: AA authorization composes with eligibility proof. AA never grants DID eligibility.

**Relay trust**: Operator convenience only. Cannot replace on-chain verification.

**Migration hardening**: Mandatory security migrations. Without them: permissive RLS, racy writers, unbounded drafts.

**Module lifecycle**: Timelocked rotations, escape hatch for backup owner.

## Canonical Network Anchors

Source: `frontend/src/config/generatedMorpheusRegistry.js` (generated from neo-os-services, wins on conflicts).

| Item | Mainnet | Testnet |
| --- | --- | --- |
| AA core | `0x0268a387913b250166ddec032b03332690a1ef78` | `0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2` |
| AA runtime | SmartAccountV3 | SmartAccountV3 |
| Morpheus Oracle | `0xf54d8584ef82315c1800373272ab08ae0db2d5ef` | `0xf54d8584ef82315c1800373272ab08ae0db2d5ef` |
| Morpheus DataFeed | `0x03013f49c42a14546c8bbe58f9d434c3517fccab` | `0x9bea75cf702f6afc09125aa6d22f082bfd2ee064` |

**Mainnet NeoNS**: `morpheus-aa.miniapp.neo`, `morpheus-aa-alias.miniapp.neo`

Test `frontend/tests/morpheusRegistryDocs.test.js` keeps these equal to generated registry.
