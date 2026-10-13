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

### Account Lifecycle

```javascript
const accountIdHash = client.deriveRegistrationAccountIdHash({
  verifierContractHash,
  verifierParamsHex,
  hookContractHash,
  backupOwnerAddress,
  escapeTimelock: 7 * 24 * 60 * 60,
});

const payload = client.createAccountPayload({
  verifierContractHash,
  verifierParamsHex,
  hookContractHash,
  backupOwnerAddress,
  escapeTimelock: 7 * 24 * 60 * 60,
});

const state = await client.getAccountState(accountIdHash);
```

`registerAccounts(Array, Hash160, Array, Hash160, Hash160, Integer)` on the deployed core
registers several accounts in one transaction; the SDK has no batch payload builder, so build one
`createAccountPayload` per account and submit them through that entrypoint.

### Removed V2 surfaces

The V1/V2 role model is gone. There is no admin, manager or threshold state on a V3 account, and
the SDK keeps only removed stubs that throw `LEGACY_V3_REMOVED`:

- `client.getAccountsByAdmin()`, `client.getAccountsByManager()` — removed in V3: no arguments,
  always throws `LEGACY_V3_REMOVED`; use `getAccountState(accountIdHash)` per account.
- `client.getAccountAddressesByAdmin()`, `client.getAccountAddressesByManager()` — removed in V3 for
  the same reason.
- `client.createAccountBatchPayload(...)`, `client.getAdmins(...)`,
  `client.getAdminThreshold(...)`, `client.getManagers(...)` — removed names that never existed in
  this SDK.
- `client.getManagerThreshold(...)`, `client.executePayload(...)`,
  `client.executeUnifiedByAddressPayload(...)` — removed names that never existed in this SDK;
  the current builders are `createAccountPayload` and `UserOperationBuilder`.

### Execution

V3 executes through `executeUserOp(accountId, op)` (or `executeUserOps(accountId, ops)` for a
batch); the `executeUnified`/`executeUnifiedByAddress` wrappers were removed and exist in no
deployed manifest and no contract source. Build the operation with the SDK's `UserOperationBuilder`
and sign the typed data the V3 layout defines:

```javascript
const { createUserOpBuilder, buildV3UserOperationTypedData } = require('./sdk/js/src');

const userOp = createUserOpBuilder()
  .setAccountId(accountIdHash)
  .setTarget(targetContract)
  .setMethod('transfer')
  .setArgs([{ type: 'Hash160', value: recipient }, { type: 'Integer', value: '100000000' }])
  .build();

const typedData = buildV3UserOperationTypedData(userOp);
```

### Sponsored Execution (Paymaster)

```javascript
// Check sponsor balance
const balance = await client.querySponsorBalance(paymasterHash, sponsorAddress);

// Validate before submit (relay preflight)
const ok = await client.validatePaymasterOp({
  paymasterHash, sponsorAddress, accountAddress,
  targetContract, method, reimbursementAmount
});

// Build sponsored execution payload
const payload = client.createSponsoredUserOpPayload({
  accountScriptHash, userOp, paymasterHash,
  sponsorAddress, reimbursementAmount
});

// Build sponsored batch payload
const batchPayload = client.createSponsoredBatchPayload({
  accountScriptHash, userOps, paymasterHash,
  sponsorAddress, reimbursementAmount
});
```

### Paymaster Contract Methods (On-Chain)

| Method | Access | Purpose |
| --- | --- | --- |
| `onNEP17Payment` | GAS transfer | Accept sponsor deposits |
| `withdrawDeposit(amount)` | Sponsor witness | Withdraw excess GAS |
| `setPolicy(accountId, target, method, maxPerOp, dailyBudget, totalBudget, validUntil)` | Sponsor witness | Create/update sponsorship policy |
| `revokePolicy(accountId)` | Sponsor witness | Remove policy + clear counters |
| `validatePaymasterOp(sponsor, accountId, target, method, amount)` | Safe (anyone) | Read-only preflight check |
| `settleReimbursement(sponsor, accountId, target, method, relay, amount)` | AA Core only | Atomic settlement after execution |
| `getSponsorDeposit(sponsor)` | Safe | Query deposit balance |
| `getPolicy(sponsor, accountId)` | Safe | Query policy details |
| `getDailySpent(sponsor, accountId)` | Safe | Query 24h spending |
| `getTotalSpent(sponsor, accountId)` | Safe | Query lifetime spending |

The names above are the deployed manifest's, exactly as `contracts/build/AAPaymaster.manifest.json`
spells them; Neo ABI names are case-sensitive.

## Canonical docs

- `docs/HOW_IT_WORKS.md`
- `docs/WORKFLOWS.md`
- `docs/DATA_FLOW.md`
- `docs/architecture.md`
