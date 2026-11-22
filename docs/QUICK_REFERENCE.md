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

Every snippet below drives the v4 protocol through `sdk/js/src/index.js` or the shared
`nativeSmartAccountClient.mjs`, which reach the same native kernel and the same 13-field
operation and raise the same `SA_*` vocabulary. The v3 calls (`registerAccount`,
`createAccountPayload`, `getVerifier`, `updateHook`) were removed with the v3 runtime: there is
no alias.

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
timelock, authority epoch, configuration nonce, hook-order revision). The recovery slots the
descriptor still carries report their inactive value: the recovery lifecycle is a module's, so a
reader never mistakes an ABI-stability slot for a pending handover.

### Modules

Modules are installed either atomically at registration or afterwards through
`installModule(accountId, moduleType, moduleContractHash, initData)` and
`removeModule(accountId, moduleId, deInitData)`. Both accept the custody witness or the witness of an
already installed validator instance, and both advance the configuration nonce. The core keeps no
proposal window: a change that matures for 24 hours is a governance module's contract, which submits
the matured call through those two methods.

```javascript
// moduleTypeCode is the v4 install code: validator (1) or hook (4). The core reads the
// module's own profile, so the public entry carries no digest.
const install = client.buildAccountActionScript({
  method: 'installModule',
  accountId: identity.accountId,
  args: [moduleTypeCode, moduleContractHash, initData],
});
```

`getModules(accountId, 'validator' | 'hook', { cursor, limit })` pages the installed instances and
`getModule(accountId, moduleId)` reads one. `isModuleInstalled` answers the admission question
without paging, and `getAuthorizedModuleId` reports the instance the core routed a phase to. Hook
ordering is derived from the installed hook instances and the `hookOrderRevision` the descriptor
publishes, because the orchestrator that calls them is a module. Every module also exposes its own
safe reads (`getModuleProfile`, `getConfig`, `getSessionKey`, `getThreshold`, `getPublicKey`,
`getDailyLimit`, and so on); those are the only module methods a caller invokes directly, because
the core owns the lifecycle callbacks.

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

## Canonical docs

- `docs/HOW_IT_WORKS.md`
- `docs/WORKFLOWS.md`
- `docs/DATA_FLOW.md`
- `docs/architecture.md`
