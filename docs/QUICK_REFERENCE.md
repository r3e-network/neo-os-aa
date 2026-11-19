# Quick Reference

## Core local verification

```bash
./scripts/verify_repo.sh

# Release-grade cross-repository identity-kernel gate:
NEOOS_REQUIRE_SERVICES_ARTIFACTS=1 ./scripts/verify_repo.sh --contracts-only

# Opt-in formal gate (Coq/Z3/TLC) and private-chain validation (neoxp):
./scripts/verify_repo.sh --contracts-only --formal --neoexpress
```

## Frontend only

```bash
cd frontend && npm test
cd frontend && npm run build
```

## SDK only

```bash
cd sdk/js && npm test
```



## SDK API Reference

Every snippet below is the v4 client (`sdk/js/src/index.js` for the custom kernel, the shared
`nativeSmartAccountClient.mjs` for the native one). Both drive the same 13-field operation and the
same `SA_*` vocabulary. A v3 call (`registerAccount`, `createAccountPayload`, `getVerifier`,
`updateHook`) does not resolve: there is no alias.

### Account Lifecycle

A v4 identity is committed to at creation and nowhere else:
`accountId = hash160('aa524704' || custody || salt)`. The salt is 1..128 bytes of public uniqueness
input, and the recovery timelock is 7..90 days, passed in milliseconds.

```javascript
const { createSmartAccountClient } = require('./sdk/js/src');

const client = await createSmartAccountClient({ rpcUrl, contractHash, networkMagic });
await client.discover(); // pins protocolVersion and implementationId

const identity = client.deriveIdentity({ custodyAddress: custody, salt });

// createAccount(Hash160 accountId, Hash160 custody, ByteArray salt,
//               Integer recoveryTimelockMs, Array actions)
const plan = client.buildCreateAccountScript({
  custodyAddress: custody,
  salt,
  recoveryTimelockMs: 30 * 86_400_000,
});

const state = await client.getAccount(identity.accountId);
```

The create call carries the derived id, the custody address, the salt and the timelock; no verifier
or hook is chosen at creation. `state` returns the control record (custody, recovery authority and
timelock, authority epoch, configuration nonce, hook-order revision), the installed modules and the
pending configuration intent.

### Modules and configuration intents

Modules are installed afterwards. A configuration change is proposed, matures for 24 hours, and is
then confirmed or cancelled; nothing changes on the account before confirmation.

```javascript
const propose = client.buildConfigurationScript({
  kind: 'propose',
  accountId: identity.accountId,
  // [1, moduleTypeCode, moduleHash, profileDigest, initData]
  actions: [installAction],
  readSet: [],
});

const confirm = client.buildConfigurationScript({
  kind: 'confirm',
  accountId: identity.accountId,
  intentId: intent.intentId,
});
```

`getModules(accountId, 'validator' | 'hook', { cursor, limit })` pages the installed instances and
`getModule(accountId, moduleId)` reads one. `getPendingConfiguration(accountId)` returns the intent,
its maturity and its action digest. Every module exposes its own safe reads (`getModuleProfile`,
`getConfig`, `getSessionKey`, `getThreshold`, `getPublicKey`, `getDailyLimit`, and so on); those are
the only module methods a caller invokes directly, because the core owns the lifecycle callbacks.

### Execution

Execution is `executeUserOp(accountId, op)` for one operation and `executeUserOps(accountId, ops)`
for a batch. The operation is the v4 13-field array: version, target, method, args, nonce,
nonce subkey, deadline, validator id, credential generation, authority epoch, configuration nonce,
signature, hook proofs. Sign the typed data the core checks:

```javascript
const operation = {
  targetContract,
  method: 'transfer',
  args: [{ type: 'Hash160', value: recipient }, { type: 'Integer', value: '100000000' }],
  nonce,
  nonceSubkey,
  deadline,
  validatorId: 1,
  credentialGeneration: 1,
  authorityEpoch,
  configurationNonce,
  signature,
  hookProofs: [],
};

const typedData = buildUserOperationTypedData({
  chainId,
  verifyingContract: proxyAddress,
  accountId,
  coreContractHash,
  validatorId: operation.validatorId,
  targetContract: operation.targetContract,
  method: operation.method,
  argsHashHex,
  nonce: operation.nonce,
  deadline: operation.deadline,
  operationDigest,
});
```

### Sponsored Execution (Paymaster)

Sponsorship keeps the v4 operation: the sponsor pays, and the account still authorises the operation
with its own validator signature. The client refuses a batch whose operations do not share one
target contract and method, because the core settles one reimbursement for the whole envelope.

```javascript
const plan = client.buildSponsoredExecutionScript({
  accountId,
  operations: [operation], // 1..32, one target contract and method
  paymaster: paymasterHash,
  sponsor: sponsorAddress,
  reimbursementAmount: '1000000', // positive
});
```

`plan.method` is `executeSponsoredUserOp` for one operation and `executeSponsoredUserOps` for a
batch. Deposits, policies and counters live on the paymaster contract:

### Paymaster Contract Methods (On-Chain)

| Method | Access | Purpose |
| --- | --- | --- |
| `onNEP17Payment` | GAS transfer | Accept sponsor deposits |
| `withdrawDeposit(amount)` | Sponsor witness | Withdraw excess GAS |
| `setPolicy(accountId, target, method, maxPerOp, dailyBudget, totalBudget, validUntil)` | Sponsor witness | Create/update sponsorship policy |
| `revokePolicy(accountId)` | Sponsor witness | Remove policy + clear counters |
| `validatePaymasterOp(sponsor, accountId, target, method, amount)` | Safe (anyone) | Read-only preflight check |
| `settleReimbursement(sponsor, accountId, target, method, relay, amount)` | SA Core only | Atomic settlement after execution |
| `getSponsorDeposit(sponsor)` | Safe | Query deposit balance |
| `getPolicy(sponsor, accountId)` | Safe | Query policy details |
| `getDailySpent(sponsor, accountId)` | Safe | Query 24h spending |
| `getTotalSpent(sponsor, accountId)` | Safe | Query lifetime spending |

The names above are the deployed manifest's, exactly as `contracts/build/SAPaymaster.manifest.json`
spells them; Neo ABI names are case-sensitive.

## Canonical docs

- `docs/HOW_IT_WORKS.md`
- `docs/WORKFLOWS.md`
- `docs/DATA_FLOW.md`
- `docs/architecture.md`
