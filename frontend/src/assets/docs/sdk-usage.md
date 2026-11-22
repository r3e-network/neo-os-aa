# Smart Account SDK Integration

The JavaScript SDK drives the v4 protocol: one 13-field operation, one derivation for the account
identity, and the `SA_*` vocabulary the native kernel raises. The v3 surface
(`registerAccount`, `createAccountPayload`, `getVerifier`) was removed: there is no alias.

## Installation

```bash
npm install @cityofzion/neon-js ethers
```

## 1. Initialize the Client

Use a Neo N3 RPC endpoint, the deployed kernel hash and the chain id the digests bind, unless you
explicitly override them with another instance. The canonical anchors are generated from
neo-os-services into `frontend/src/config/generatedMorpheusRegistry.js`; the repository README
restates them and that generated module wins on any conflict.

```javascript
const { createSmartAccountClient } = require('./sdk/js/src');

const client = createSmartAccountClient({
  rpcUrl: 'https://testnet1.neo.coz.io:443',
  contractHash: '0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2',
  networkMagic: 894710606,
});
await client.discover(); // protocol version, implementation id and required ABI
```

The generated registry also publishes the legacy deployment anchors the testnet still lists, so an
integrator can tell an old anchor from the v4 kernel. The verifier address below is public chain
data from that registry; v4 accounts install validator modules instead of that shared verifier.

```javascript
const web3AuthVerifierHash = '0x1111f5b6b046a964c75d208998c13945ce172e85';
```

## 2. Derive the Account Identity

A v4 identity is `accountId = hash160('aa524704' || custody || salt)`. The salt is 1..128 bytes of
public uniqueness input, and the proxy address follows from the account id and the kernel hash, so
the pair is enough to re-derive the account on either kernel.

```javascript
const identity = client.deriveIdentity({
  custodyAddress: 'N...custody',
  salt: '0x00112233445566778899aabbccddeeff',
});
console.log(identity.accountId);
console.log(identity.accountAddress);
console.log(identity.verificationScript);
```

The derivation is single-sourced in `shared/` and the contract exposes the same function
(`computeAccountIdentity`), so the client, the frontend and the chain cannot disagree on the id.

## 3. Build the Account-Creation Invocation

The create call commits to the identity: `createAccount(Hash160 accountId, Hash160 custody,
ByteArray salt, Integer recoveryTimelockMs, Array actions)`. The recovery timelock is 7..90 days in
milliseconds, and no validator or hook module is chosen here. Modules are installed afterwards by a
configuration intent.

```javascript
const plan = client.buildCreateAccountScript({
  custodyAddress: 'N...custody',
  salt: '0x00112233445566778899aabbccddeeff',
  recoveryTimelockMs: 30 * 86_400_000,
});

console.log(plan.method);          // createAccount
console.log(plan.accountId);       // derived identity, never supplied by the caller
console.log(plan.accountAddress);  // the proxy address the script deploys
console.log(plan.script);          // the NeoVM script the custody wallet signs
```

`createAccounts` registers a batch in one transaction. The account state is read with
`client.getAccount(accountId)`: custody, recovery authority and timelock, authority epoch,
configuration nonce, hook-order revision, installed modules and the pending configuration intent.

## 4. Generate the Typed Data

The SDK returns the typed data the core checks, and the same fields are what
`computeArgsHash`/`getOperationDigest` bind on-chain.

```javascript
const typedData = buildUserOperationTypedData({
  chainId: 894710606,
  verifyingContract: identity.accountAddress,
  accountId: identity.accountId,
  coreContractHash: client.contractHash,
  validatorId: 1,
  targetContract,
  method: 'transfer',
  argsHashHex,
  nonce,
  deadline: Date.now() + 3600_000,
  operationDigest,
});

const signature = await signer.signTypedData(
  typedData.domain,
  typedData.types,
  typedData.message,
);
```

Operation argument DTOs: their `ByteArray` values are explicit `0x` hex, including the signature.
They are not direct Neo RPC JSON (which uses base64). The operation builder and `computeArgsHash`
accept typed argument DTOs or Neon `ContractParam` instances and preserve nested arrays/maps,
hashes, and public keys. For plain `ByteArray` input, use `0x` hex or unambiguous canonical base64;
ambiguous bare hex such as `aabb` is rejected, so migrate it to `0xaabb`. Numeric enum types require
a real `ContractParam` instance; do not JSON-stringify the instance first. Unknown types, non-null
`Any`, coerced booleans and unsafe numeric integers are rejected. Map entry order is preserved across
RPC hashing and relay execution; duplicate VM keys (including String/ByteArray aliases) are rejected
before signing. Use decimal strings for large integers. Argument nesting must fit the relay's
depth-eight limit, including the surrounding operation/batch arrays. Use `computeArgsHash` with the
same arguments before signing.

## 5. App Workspace Runtime Setup

The app workspace accepts both direct browser-wallet broadcast and optional relay broadcast. For a Vercel deployment, wire these environment variables into the frontend:
Start from `frontend/.env.example` when creating a local `frontend/.env.local` file or mirroring the same keys into your deployment provider.

```bash
VITE_SA_RPC_URL=https://testnet1.neo.coz.io:443
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
VITE_SA_RELAY_URL=/api/relay-transaction
VITE_SA_RELAY_RPC_URL=https://testnet1.neo.coz.io:443
VITE_SA_RELAY_META_ENABLED=1
```

- `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` enable anonymous draft persistence.
- `VITE_SA_RELAY_URL` points the UI at the relay submission endpoint.
- `VITE_SA_RELAY_META_ENABLED` tells the frontend that the backend relay is configured to submit stored `executeUserOp` invocations.
- `SA_RELAY_WIF` on the server enables relay submission of stored `executeUserOp` invocations built from collected EVM signatures.
- shared draft metadata is intentionally bounded: the frontend retains the latest 100 activity entries and the latest 12 submission receipts per draft in both local and Supabase-backed storage.
- client-side broadcast remains the default safe path, while relay mode is reserved for already-signed raw transactions.
- the app workspace presets now stage concrete SA wrapper payloads, so a browser-wallet submission targets `executeUserOp` on the SA contract rather than the downstream contract directly.

### Server Runtime Add-Ons

If you deploy the bundled Vercel-style API routes, keep the relay signer and operator persistence settings on the server:

```bash
SA_RELAY_RPC_URL=https://testnet1.neo.coz.io:443
SA_RELAY_WIF=your-relay-wif
SA_RELAY_ALLOWED_HASH=0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2
SA_RELAY_ALLOW_RAW_FORWARD=0
SA_RELAY_INCLUDE_RAW_ERRORS=0
MORPHEUS_NETWORK=testnet
MORPHEUS_PAYMASTER_TESTNET_ENDPOINT=https://oracle.meshmini.app/testnet/paymaster/authorize
MORPHEUS_PAYMASTER_MAINNET_ENDPOINT=https://oracle.meshmini.app/mainnet/paymaster/authorize
MORPHEUS_PAYMASTER_TESTNET_API_TOKEN=your-paymaster-token
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

- `frontend/api/relay-transaction.js` uses `SA_RELAY_RPC_URL`, `SA_RELAY_WIF`, `SA_RELAY_ALLOWED_HASH`, and `SA_RELAY_ALLOW_RAW_FORWARD` to constrain relay behavior. Keep raw forwarding off unless you intentionally want the relay to pass through pre-signed raw Neo transactions.
- `frontend/api/relay-transaction.js` can also request Morpheus paymaster pre-authorization before relay submission. Use `MORPHEUS_PAYMASTER_TESTNET_ENDPOINT` / `MORPHEUS_PAYMASTER_MAINNET_ENDPOINT` and the matching API token only on the server.
- `frontend/api/morpheus-neodid.js` and `frontend/api/morpheus-oracle-public-key.js` now prefer the unified Morpheus runtime domains. Use `MORPHEUS_RUNTIME_URL`, `MORPHEUS_MAINNET_RUNTIME_URL`, or `MORPHEUS_TESTNET_RUNTIME_URL`. Legacy `MORPHEUS_API_BASE_URL` is still tolerated for compatibility.
- `SA_RELAY_INCLUDE_RAW_ERRORS=1` is an operator-only debug knob. Leave it disabled in normal deployments, and enable it temporarily when you need the raw paymaster / relay exception message in API responses.
- `frontend/api/draft-operator.js` is the signed operator mutation endpoint. It uses `SUPABASE_SERVICE_ROLE_KEY` to persist operator-only status updates, relay-preflight snapshots, submission receipts, and collaborator/operator link rotation after the browser proves operator intent with a signature.
- the browser-safe `VITE_*` values tell the UI what features to surface, while the server-only values above decide what the relay and signed operator mutation routes are actually allowed to do.

## Runtime Reference

| Setting | Scope | Purpose |
| --- | --- | --- |
| `VITE_SA_RPC_URL` | Frontend | Neo RPC used for app workspace reads and staging. |
| `VITE_SUPABASE_URL` | Frontend | Enables anonymous shared-draft persistence when paired with the anon key. |
| `VITE_SUPABASE_ANON_KEY` | Frontend | Public browser key for anonymous shared-draft persistence. |
| `VITE_SA_RELAY_URL` | Frontend | Relay endpoint used for preflight checks and relay submission. |
| `VITE_SA_RELAY_RPC_URL` | Frontend | RPC used by relay-aware runtime helpers. |
| `VITE_SA_RELAY_META_ENABLED` | Frontend | Tells the UI that relay-ready meta invocations can be submitted directly. |
| `VITE_SA_EXPLORER_BASE_URL` | Frontend | Optional transaction explorer base for tx links and receipts. |
| `VITE_SA_MATRIX_CONTRACT_HASH` | Frontend | Optional `.matrix` contract hash override used for domain resolution and same-transaction registration. |
| `SA_RELAY_RPC_URL` | Server | Preferred RPC for `frontend/api/relay-transaction.js` when you do not want the server to inherit the browser-facing RPC setting. |
| `SA_RELAY_WIF` | Server | Enables server-side submission of stored `executeUserOp` invocations. |
| `SA_RELAY_ALLOWED_HASH` | Server | Pins relayable meta invocations to the expected Smart Account contract hash. |
| `SA_RELAY_ALLOW_RAW_FORWARD` | Server | Explicit opt-in for relaying already-signed raw transactions; keep disabled by default. |
| `SA_RELAY_INCLUDE_RAW_ERRORS` | Server | Optional operator debug switch that includes the unsanitized exception message and stack in relay API responses. |
| `MORPHEUS_PAYMASTER_TESTNET_ENDPOINT` / `MORPHEUS_PAYMASTER_MAINNET_ENDPOINT` | Server | Optional Morpheus paymaster endpoint used before relay submission. |
| `MORPHEUS_PAYMASTER_TESTNET_API_TOKEN` / `MORPHEUS_PAYMASTER_MAINNET_API_TOKEN` | Server | Optional bearer token for the corresponding Morpheus paymaster endpoint. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server | Required by the `draft-operator` signed operator mutation route for operator-only draft persistence. |
| Draft metadata retention | Frontend + Supabase | Keeps only the latest 100 activity entries and latest 12 submission receipts per draft. |

## Security Posture

- **Safe to expose client-side:** `VITE_SA_RPC_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SA_RELAY_URL`, `VITE_SA_RELAY_RPC_URL`, `VITE_SA_RELAY_META_ENABLED`, and `VITE_SA_EXPLORER_BASE_URL` are runtime hints the frontend needs in the browser.
- **Server-only:** `SA_RELAY_WIF` and `SUPABASE_SERVICE_ROLE_KEY` are secrets and must stay on the server. `SA_RELAY_ALLOWED_HASH` and `SA_RELAY_ALLOW_RAW_FORWARD` are not secret material, but they are still server-only hardening knobs because they define what the relay and signed operator mutation routes are willing to accept.
- **Debug-only:** `SA_RELAY_INCLUDE_RAW_ERRORS` should stay off in normal operation. Enable it only when you need a temporary deeper error trace for relay or paymaster debugging.
- **Server-only paymaster settings:** `MORPHEUS_PAYMASTER_TESTNET_ENDPOINT`, `MORPHEUS_PAYMASTER_MAINNET_ENDPOINT`, and their matching API tokens should never be exposed to the browser. They let the relay backend request sponsorship tickets from Morpheus before broadcasting.

## Relay Behavior Matrix

| `VITE_SA_RELAY_URL` | `VITE_SA_RELAY_META_ENABLED` | `SA_RELAY_WIF` | Effective behavior |
| --- | --- | --- | --- |
| missing | any | any | No relay path; the UI stays on client-side broadcast only. |
| set | off | missing or set | Preflight only for relay-ready payload inspection, plus signed raw relay when a raw transaction already exists. |
| set | on | missing | Signed raw relay works, and meta payloads can be prepared, but meta relay submission is blocked server-side without the relay signer. |
| set | on | set | Full relay path: preflight only when simulating, signed raw relay, and meta relay submission for stored `executeUserOp` invocations. |

## Safe Defaults

- **Client-side broadcast is the default safe path** and works without relay configuration.
- **Optional knobs** such as `VITE_SA_RELAY_META_ENABLED`, `SA_RELAY_WIF`, and `VITE_SA_EXPLORER_BASE_URL` only expand relay and explorer behavior; they are not required for basic local wallet usage.
- **Supabase settings are optional** unless you want anonymous cross-device draft sharing instead of the local-only browser fallback.

## Minimum Capability Matrix

| Missing optional piece | What still works |
| --- | --- |
| without Supabase | Local-only drafts, browser-wallet signing, relay checks, and client-side broadcast still work in the current browser. |
| without relay | Smart Account loading, draft persistence, local/manual signature collection, and client-side broadcast still work. |
| without explorer | Draft sharing, relay checks, and broadcast still work; only external tx links and explorer shortcuts are reduced. |

## Recommended Deployment Profiles

- **local-only** — use browser wallets with no Supabase and no relay when you only need one-device compose, sign, and client-side broadcast.
- **collaborative** — add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` when you want anonymous shared drafts and mixed approval collection, even if final submission still happens client-side. The default read-only share link is safe for review, the collaborator link is for signature collection, and the operator link is for relay checks, broadcasts, and link rotation. Collaborator links also cannot append operator-class relay/broadcast timeline events. Operators can use the Rotate Collaborator Link or Rotate Operator Link actions to invalidate older write-capable URLs in-place.
- **full relay-enabled** — add Supabase, `VITE_SA_RELAY_URL`, `VITE_SA_RELAY_META_ENABLED`, `VITE_SA_EXPLORER_BASE_URL`, and server-side `SA_RELAY_WIF` when you want shared drafts, relay preflight, signed raw relay, and meta relay submission together.
- **operator-hardened** — add `SUPABASE_SERVICE_ROLE_KEY`, keep `SA_RELAY_ALLOWED_HASH` pinned to the deployed SA contract, and leave `SA_RELAY_ALLOW_RAW_FORWARD=0` unless your operators explicitly need raw-transaction passthrough. This profile keeps `draft-operator` signed operator mutation writes available without widening relay scope.

## .env.local Examples

**local-only profile**

```bash
VITE_SA_RPC_URL=https://testnet1.neo.coz.io:443
```

**collaborative profile**

Use the normal draft URL for read-only review, the collaborator link for signatures, and the operator link for relay/broadcast actions.

```bash
VITE_SA_RPC_URL=https://testnet1.neo.coz.io:443
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

**full relay-enabled profile**

```bash
VITE_SA_RPC_URL=https://testnet1.neo.coz.io:443
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
VITE_SA_RELAY_URL=/api/relay-transaction
VITE_SA_RELAY_RPC_URL=https://testnet1.neo.coz.io:443
VITE_SA_RELAY_META_ENABLED=1
VITE_SA_EXPLORER_BASE_URL=https://testnet.ndoras.com/transaction
```

## Testnet vs Production Checklist

- **testnet** — keep `VITE_SA_RPC_URL` and `VITE_SA_EXPLORER_BASE_URL` pointed at testnet services, and fund a dedicated testnet relay signer before using `SA_RELAY_WIF` for relay validation.
- **production** — switch RPC and explorer endpoints together, keep `SA_RELAY_WIF` only on the server, and treat relay signer funding/monitoring as an operational requirement.
- **relay meta mode** — on production, leave relay meta mode disabled until the backend relay signer and monitoring path are ready for direct meta relay submission.

## Troubleshooting

- **Missing Supabase envs:** if `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is absent, draft sharing falls back to local-only browser storage and anonymous cross-device sharing is unavailable.
- **Missing `SA_RELAY_WIF`:** relay submission can be configured in the UI, but the backend cannot actually sign and send relay-ready meta invocations.
- **Missing `SUPABASE_SERVICE_ROLE_KEY`:** `frontend/api/draft-operator.js` returns `operator_mutation_not_configured`, so signed operator mutation requests cannot persist operator-only status, receipt, or link-rotation changes.
- **Relay meta mode disabled:** if `VITE_SA_RELAY_META_ENABLED` is unset, collected meta invocations stay stored on the draft but the UI treats them as not directly relayable.
- **Relay hash/raw settings feel inconsistent:** confirm `SA_RELAY_ALLOWED_HASH` matches the deployed SA hash and remember that `SA_RELAY_ALLOW_RAW_FORWARD` is off by default, so raw passthrough only works after an explicit server opt-in.
- **Missing explorer base url:** if `VITE_SA_EXPLORER_BASE_URL` is absent, explorer links fall back to the default base URL or may not match your preferred explorer.

## 7. Execution Model Reminder

The typed-data signature authorises a v4 Smart Account runtime call. External interactions must flow
through the canonical v4 entrypoint `executeUserOp` (or `executeUserOps` for a batch); raw direct
proxy-signed external spends are rejected. The `executeUnified` and `executeUnifiedByAddress` wrappers are absent from every v4 manifest and every v4 source file, so a payload naming them cannot execute.


## Matrix Domain Support

The frontend can register a `.matrix` domain in the same wallet transaction as SA creation when the wallet supports batched invocations. Domain resolution is then used as a discovery step: the `.matrix` domain resolves to the controlling wallet address, and the frontend reads the accounts where that wallet is the custody.
