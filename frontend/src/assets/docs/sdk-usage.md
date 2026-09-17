# Abstract Account SDK Integration

The JavaScript SDK exposes the current Abstract Account client surface used by the live validation suite. It covers deterministic address derivation, account-creation payloads, and EIP-712 typed-data generation backed by the contract's `computeArgsHash` method.

## Installation

```bash
npm install @cityofzion/neon-js ethers
```

## 1. Initialize the Client

Use a Neo N3 RPC endpoint and the verified hardened testnet deployment hash unless you explicitly override it with another instance.

```javascript
const { AbstractAccountClient } = require('./sdk/js/src');

const rpcUrl = 'https://testnet1.neo.coz.io:443';
const masterHash = '0x5be915aea3ce85e4752d522632f0a9520e377aaf';

const aaClient = new AbstractAccountClient(rpcUrl, masterHash);
```

## 2. Derive the Deterministic Proxy Address

```javascript
const evmPubKey = '04d09c...';
const proxyAddress = aaClient.deriveAddressFromEVM(evmPubKey);
console.log(proxyAddress);
```

The derived address corresponds to the deterministic `verify(accountId)` script for that `accountId`. SDK and frontend helpers accept the big-endian display form and reverse it only while emitting the raw NeoVM `UInt160` bytes.

## 3. Build an Account-Creation Payload

Use `deriveRegistrationAccountIdHash` so the SDK, frontend, and contract agree on the exact `accountId` that `registerAccount` will accept: all three share one derivation (single-sourced in `shared/registrationAccountId.mjs`). The returned value is the big-endian display form — identical to the on-chain `ComputeRegistrationAccountId` display string — so pass it directly as the `{ type: 'Hash160' }` accountId argument. (Only raw script pushes, e.g. building a verify script by hand, need the byte-reversed internal form.)

```javascript
const verifierParamsHex = evmPubKey.slice(2);
const backupOwnerAddress = 'NQh...ownerAddress';
const web3AuthVerifierHash = '0xf5c452cd4ba29dcdc47026383568c0d8b38d9272';

const accountIdHash = aaClient.deriveRegistrationAccountIdHash({
  verifierContractHash: web3AuthVerifierHash,
  verifierParamsHex,
  backupOwnerAddress,
  escapeTimelock: 7 * 24 * 60 * 60,
});

const payload = aaClient.createAccountPayload({
  verifierContractHash: web3AuthVerifierHash,
  verifierParamsHex,
  backupOwnerAddress,
  escapeTimelock: 7 * 24 * 60 * 60,
});

console.log(accountIdHash);      // deterministic registration-bound accountId
console.log(payload.scriptHash); // AA master contract
console.log(payload.operation);  // registerAccount
console.log(payload.args);
```

## 4. Generate an EIP-712 Payload

The SDK asks the contract to compute the canonical `argsHash`, then returns the typed-data object expected by MetaMask or Ethers.

```javascript
const typedData = await aaClient.createEIP712Payload({
  chainId: 894710606,
  accountIdHash,
  targetContract: masterHash,
  method: 'setWhitelistModeByAddress',
  args: [
    { type: 'Hash160', value: '0x1234567890abcdef1234567890abcdef12345678' },
    { type: 'Boolean', value: true },
  ],
  nonce: 0,
  deadline: Date.now() + 3600_000,
});

const signature = await signer.signTypedData(
  typedData.domain,
  typedData.types,
  typedData.message,
);
```

## 5. Paymaster / Sponsored Execution

The SDK provides helpers for building sponsored (gasless) transactions that settle relay fees through the on-chain `AAPaymaster` contract (`contracts/paymaster/Paymaster.cs`). Sponsors deposit GAS into the Paymaster via NEP-17 transfer, then create policies that define which accounts, contracts, and methods they are willing to fund.

### Query a Sponsor Balance

```javascript
const balance = await aaClient.querySponsorBalance(paymasterHash, sponsorAddress);
console.log(`Sponsor has ${balance} fractions of GAS in the Paymaster`);
```

### Create a Sponsored UserOp Payload

`createSponsoredUserOpPayload` wraps a standard `executeUserOp` invocation so the relay is reimbursed from the sponsor's Paymaster deposit instead of the account holder.

```javascript
const payload = await aaClient.createSponsoredUserOpPayload({
  accountScriptHash: accountIdHash,
  userOp,
  paymasterHash,
  sponsorAddress,
  reimbursementAmount: 5_000_000,
});
```

The AA core method called under the hood is `executeSponsoredUserOp(accountId, op, paymaster, sponsor, reimbursementAmount)`. A batch variant `createSponsoredBatchPayload` works identically but targets the batch execution entrypoint.

### Validate Before Submission

```javascript
const ok = await aaClient.validatePaymasterOp({
  paymasterHash,
  sponsorAddress,
  accountAddress: accountIdHash,
  targetContract: userOp.TargetContract,
  method: userOp.Method,
  reimbursementAmount: 5_000_000,
});
```

`validatePaymasterOp` performs a read-only check against the Paymaster's policy and balance state so the relay can reject infeasible sponsorships before broadcasting.

### Settlement Model

Settlement is atomic: the Paymaster validates the sponsor's policy (`setPolicy(accountId, targetContract, method, maxPerOp, dailyBudget, totalBudget, validUntil)`), deducts the reimbursement from the sponsor's deposit, and transfers GAS to the relay, all inside the same contract call. Use `accountId = UInt160.Zero` when creating a global policy that sponsors any account.

The Paymaster never authorizes execution. Verifier and hook plugins must approve the operation independently; the Paymaster only funds the relay after those checks pass.

## 6. App Workspace Runtime Setup

The app workspace accepts both direct browser-wallet broadcast and optional relay broadcast. For a Vercel deployment, wire these environment variables into the frontend:
Start from `frontend/.env.example` when creating a local `frontend/.env.local` file or mirroring the same keys into your deployment provider.

```bash
VITE_AA_RPC_URL=https://testnet1.neo.coz.io:443
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
VITE_AA_RELAY_URL=/api/relay-transaction
VITE_AA_RELAY_RPC_URL=https://testnet1.neo.coz.io:443
VITE_AA_RELAY_META_ENABLED=1
```

- `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` enable anonymous draft persistence.
- `VITE_AA_RELAY_URL` points the UI at the relay submission endpoint.
- `VITE_AA_RELAY_META_ENABLED` tells the frontend that the backend relay is configured to submit stored `executeUnifiedByAddress` invocations.
- `AA_RELAY_WIF` on the server enables relay submission of stored `executeUnifiedByAddress` invocations built from collected EVM signatures.
- shared draft metadata is intentionally bounded: the frontend retains the latest 100 activity entries and the latest 12 submission receipts per draft in both local and Supabase-backed storage.
- client-side broadcast remains the default safe path, while relay mode is reserved for already-signed raw transactions.
- the app workspace presets now stage concrete AA wrapper payloads, so a browser-wallet submission targets `executeUnifiedByAddress` on the AA contract rather than the downstream contract directly.

### Server Runtime Add-Ons

If you deploy the bundled Vercel-style API routes, keep the relay signer and operator persistence settings on the server:

```bash
AA_RELAY_RPC_URL=https://testnet1.neo.coz.io:443
AA_RELAY_WIF=your-relay-wif
AA_RELAY_ALLOWED_HASH=0x5be915aea3ce85e4752d522632f0a9520e377aaf
AA_RELAY_ALLOW_RAW_FORWARD=0
AA_RELAY_INCLUDE_RAW_ERRORS=0
MORPHEUS_NETWORK=testnet
MORPHEUS_PAYMASTER_TESTNET_ENDPOINT=https://oracle.meshmini.app/testnet/paymaster/authorize
MORPHEUS_PAYMASTER_MAINNET_ENDPOINT=https://oracle.meshmini.app/mainnet/paymaster/authorize
MORPHEUS_PAYMASTER_TESTNET_API_TOKEN=your-paymaster-token
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

- `frontend/api/relay-transaction.js` uses `AA_RELAY_RPC_URL`, `AA_RELAY_WIF`, `AA_RELAY_ALLOWED_HASH`, and `AA_RELAY_ALLOW_RAW_FORWARD` to constrain relay behavior. Keep raw forwarding off unless you intentionally want the relay to pass through pre-signed raw Neo transactions.
- `frontend/api/relay-transaction.js` can also request Morpheus paymaster pre-authorization before relay submission. Use `MORPHEUS_PAYMASTER_TESTNET_ENDPOINT` / `MORPHEUS_PAYMASTER_MAINNET_ENDPOINT` and the matching API token only on the server.
- `frontend/api/morpheus-neodid.js` and `frontend/api/morpheus-oracle-public-key.js` now prefer the unified Morpheus runtime domains. Use `MORPHEUS_RUNTIME_URL`, `MORPHEUS_MAINNET_RUNTIME_URL`, or `MORPHEUS_TESTNET_RUNTIME_URL`. Legacy `MORPHEUS_API_BASE_URL` is still tolerated for compatibility.
- `AA_RELAY_INCLUDE_RAW_ERRORS=1` is an operator-only debug knob. Leave it disabled in normal deployments, and enable it temporarily when you need the raw paymaster / relay exception message in API responses.
- `frontend/api/draft-operator.js` is the signed operator mutation endpoint. It uses `SUPABASE_SERVICE_ROLE_KEY` to persist operator-only status updates, relay-preflight snapshots, submission receipts, and collaborator/operator link rotation after the browser proves operator intent with a signature.
- the browser-safe `VITE_*` values tell the UI what features to surface, while the server-only values above decide what the relay and signed operator mutation routes are actually allowed to do.

## Runtime Reference

| Setting | Scope | Purpose |
| --- | --- | --- |
| `VITE_AA_RPC_URL` | Frontend | Neo RPC used for app workspace reads and staging. |
| `VITE_SUPABASE_URL` | Frontend | Enables anonymous shared-draft persistence when paired with the anon key. |
| `VITE_SUPABASE_ANON_KEY` | Frontend | Public browser key for anonymous shared-draft persistence. |
| `VITE_AA_RELAY_URL` | Frontend | Relay endpoint used for preflight checks and relay submission. |
| `VITE_AA_RELAY_RPC_URL` | Frontend | RPC used by relay-aware runtime helpers. |
| `VITE_AA_RELAY_META_ENABLED` | Frontend | Tells the UI that relay-ready meta invocations can be submitted directly. |
| `VITE_AA_EXPLORER_BASE_URL` | Frontend | Optional transaction explorer base for tx links and receipts. |
| `VITE_AA_MATRIX_CONTRACT_HASH` | Frontend | Optional `.matrix` contract hash override used for domain resolution and same-transaction registration. |
| `AA_RELAY_RPC_URL` | Server | Preferred RPC for `frontend/api/relay-transaction.js` when you do not want the server to inherit the browser-facing RPC setting. |
| `AA_RELAY_WIF` | Server | Enables server-side submission of stored `executeUnifiedByAddress` invocations. |
| `AA_RELAY_ALLOWED_HASH` | Server | Pins relayable meta invocations to the expected Abstract Account contract hash. |
| `AA_RELAY_ALLOW_RAW_FORWARD` | Server | Explicit opt-in for relaying already-signed raw transactions; keep disabled by default. |
| `AA_RELAY_INCLUDE_RAW_ERRORS` | Server | Optional operator debug switch that includes the unsanitized exception message and stack in relay API responses. |
| `MORPHEUS_PAYMASTER_TESTNET_ENDPOINT` / `MORPHEUS_PAYMASTER_MAINNET_ENDPOINT` | Server | Optional Morpheus paymaster endpoint used before relay submission. |
| `MORPHEUS_PAYMASTER_TESTNET_API_TOKEN` / `MORPHEUS_PAYMASTER_MAINNET_API_TOKEN` | Server | Optional bearer token for the corresponding Morpheus paymaster endpoint. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server | Required by the `draft-operator` signed operator mutation route for operator-only draft persistence. |
| Draft metadata retention | Frontend + Supabase | Keeps only the latest 100 activity entries and latest 12 submission receipts per draft. |

## Security Posture

- **Safe to expose client-side:** `VITE_AA_RPC_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_AA_RELAY_URL`, `VITE_AA_RELAY_RPC_URL`, `VITE_AA_RELAY_META_ENABLED`, and `VITE_AA_EXPLORER_BASE_URL` are runtime hints the frontend needs in the browser.
- **Server-only:** `AA_RELAY_WIF` and `SUPABASE_SERVICE_ROLE_KEY` are secrets and must stay on the server. `AA_RELAY_ALLOWED_HASH` and `AA_RELAY_ALLOW_RAW_FORWARD` are not secret material, but they are still server-only hardening knobs because they define what the relay and signed operator mutation routes are willing to accept.
- **Debug-only:** `AA_RELAY_INCLUDE_RAW_ERRORS` should stay off in normal operation. Enable it only when you need a temporary deeper error trace for relay or paymaster debugging.
- **Server-only paymaster settings:** `MORPHEUS_PAYMASTER_TESTNET_ENDPOINT`, `MORPHEUS_PAYMASTER_MAINNET_ENDPOINT`, and their matching API tokens should never be exposed to the browser. They let the relay backend request sponsorship tickets from Morpheus before broadcasting.

## Relay Behavior Matrix

| `VITE_AA_RELAY_URL` | `VITE_AA_RELAY_META_ENABLED` | `AA_RELAY_WIF` | Effective behavior |
| --- | --- | --- | --- |
| missing | any | any | No relay path; the UI stays on client-side broadcast only. |
| set | off | missing or set | Preflight only for relay-ready payload inspection, plus signed raw relay when a raw transaction already exists. |
| set | on | missing | Signed raw relay works, and meta payloads can be prepared, but meta relay submission is blocked server-side without the relay signer. |
| set | on | set | Full relay path: preflight only when simulating, signed raw relay, and meta relay submission for stored `executeUnifiedByAddress` invocations. |

## Safe Defaults

- **Client-side broadcast is the default safe path** and works without relay configuration.
- **Optional knobs** such as `VITE_AA_RELAY_META_ENABLED`, `AA_RELAY_WIF`, and `VITE_AA_EXPLORER_BASE_URL` only expand relay and explorer behavior; they are not required for basic local wallet usage.
- **Supabase settings are optional** unless you want anonymous cross-device draft sharing instead of the local-only browser fallback.

## Minimum Capability Matrix

| Missing optional piece | What still works |
| --- | --- |
| without Supabase | Local-only drafts, browser-wallet signing, relay checks, and client-side broadcast still work in the current browser. |
| without relay | Abstract Account loading, draft persistence, local/manual signature collection, and client-side broadcast still work. |
| without explorer | Draft sharing, relay checks, and broadcast still work; only external tx links and explorer shortcuts are reduced. |

## Recommended Deployment Profiles

- **local-only** — use browser wallets with no Supabase and no relay when you only need one-device compose, sign, and client-side broadcast.
- **collaborative** — add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` when you want anonymous shared drafts and mixed approval collection, even if final submission still happens client-side. The default read-only share link is safe for review, the collaborator link is for signature collection, and the operator link is for relay checks, broadcasts, and link rotation. Collaborator links also cannot append operator-class relay/broadcast timeline events. Operators can use the Rotate Collaborator Link or Rotate Operator Link actions to invalidate older write-capable URLs in-place.
- **full relay-enabled** — add Supabase, `VITE_AA_RELAY_URL`, `VITE_AA_RELAY_META_ENABLED`, `VITE_AA_EXPLORER_BASE_URL`, and server-side `AA_RELAY_WIF` when you want shared drafts, relay preflight, signed raw relay, and meta relay submission together.
- **operator-hardened** — add `SUPABASE_SERVICE_ROLE_KEY`, keep `AA_RELAY_ALLOWED_HASH` pinned to the deployed AA contract, and leave `AA_RELAY_ALLOW_RAW_FORWARD=0` unless your operators explicitly need raw-transaction passthrough. This profile keeps `draft-operator` signed operator mutation writes available without widening relay scope.

## .env.local Examples

**local-only profile**

```bash
VITE_AA_RPC_URL=https://testnet1.neo.coz.io:443
```

**collaborative profile**

Use the normal draft URL for read-only review, the collaborator link for signatures, and the operator link for relay/broadcast actions.

```bash
VITE_AA_RPC_URL=https://testnet1.neo.coz.io:443
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

**full relay-enabled profile**

```bash
VITE_AA_RPC_URL=https://testnet1.neo.coz.io:443
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
VITE_AA_RELAY_URL=/api/relay-transaction
VITE_AA_RELAY_RPC_URL=https://testnet1.neo.coz.io:443
VITE_AA_RELAY_META_ENABLED=1
VITE_AA_EXPLORER_BASE_URL=https://testnet.ndoras.com/transaction
```

## Testnet vs Production Checklist

- **testnet** — keep `VITE_AA_RPC_URL` and `VITE_AA_EXPLORER_BASE_URL` pointed at testnet services, and fund a dedicated testnet relay signer before using `AA_RELAY_WIF` for relay validation.
- **production** — switch RPC and explorer endpoints together, keep `AA_RELAY_WIF` only on the server, and treat relay signer funding/monitoring as an operational requirement.
- **relay meta mode** — on production, leave relay meta mode disabled until the backend relay signer and monitoring path are ready for direct meta relay submission.

## Troubleshooting

- **Missing Supabase envs:** if `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is absent, draft sharing falls back to local-only browser storage and anonymous cross-device sharing is unavailable.
- **Missing `AA_RELAY_WIF`:** relay submission can be configured in the UI, but the backend cannot actually sign and send relay-ready meta invocations.
- **Missing `SUPABASE_SERVICE_ROLE_KEY`:** `frontend/api/draft-operator.js` returns `operator_mutation_not_configured`, so signed operator mutation requests cannot persist operator-only status, receipt, or link-rotation changes.
- **Relay meta mode disabled:** if `VITE_AA_RELAY_META_ENABLED` is unset, collected meta invocations stay stored on the draft but the UI treats them as not directly relayable.
- **Relay hash/raw settings feel inconsistent:** confirm `AA_RELAY_ALLOWED_HASH` matches the deployed AA hash and remember that `AA_RELAY_ALLOW_RAW_FORWARD` is off by default, so raw passthrough only works after an explicit server opt-in.
- **Missing explorer base url:** if `VITE_AA_EXPLORER_BASE_URL` is absent, explorer links fall back to the default base URL or may not match your preferred explorer.

## 7. Execution Model Reminder

The typed-data signature authorizes an Abstract Account wrapper call. On hardened deployments, external interactions must flow through AA the canonical runtime entrypoints `executeUnified` / `executeUnifiedByAddress` (plus legacy compatibility wrappers); raw direct proxy-signed external spends are intentionally rejected.


## Matrix Domain Support

The frontend can register a `.matrix` domain in the same wallet transaction as AA creation when the wallet supports batched invocations. Domain resolution is then used as a discovery step: the `.matrix` domain resolves to the controlling wallet address, and the frontend queries the AA contract for bound AA addresses where that wallet is an admin or manager.
