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

### Account Discovery

```javascript
// Find accounts by admin role
const accounts = await client.getAccountsByAdmin(address);

// Find accounts by manager role  
const accounts = await client.getAccountsByManager(address);
```

### Batch Account Creation

```javascript
// Create multiple accounts with shared governance
const payload = client.createAccountBatchPayload(
  accountIds,        // Array of account ID strings
  admins,           // Array of admin addresses (optional)
  adminThreshold,   // Required admin signatures
  managers,         // Array of manager addresses (optional)
  managerThreshold  // Required manager signatures
);
```

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

### Role Management

```javascript
// Get admins
const admins = await client.getAdmins(accountId);
const threshold = await client.getAdminThreshold(accountId);

// Get managers
const managers = await client.getManagers(accountId);
const threshold = await client.getManagerThreshold(accountId);
```

### Execution

```javascript
// Execute via account ID
const payload = client.executePayload(accountId, targetContract, method, args);

// Execute via account address
const payload = client.executeUnifiedByAddressPayload(accountAddress, targetContract, method, args);

// Execute meta-transaction
const payload = client.executeUnifiedByAddressPayload(accountAddress, evmPublicKey, targetContract, method, args, argsHash, nonce, deadline, signature);
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
| `OnNEP17Payment` | GAS transfer | Accept sponsor deposits |
| `WithdrawDeposit(amount)` | Sponsor witness | Withdraw excess GAS |
| `SetPolicy(accountId, target, method, maxPerOp, dailyBudget, totalBudget, validUntil)` | Sponsor witness | Create/update sponsorship policy |
| `RevokePolicy(accountId)` | Sponsor witness | Remove policy + clear counters |
| `ValidatePaymasterOp(sponsor, accountId, target, method, amount)` | Safe (anyone) | Read-only preflight check |
| `SettleReimbursement(sponsor, accountId, target, method, relay, amount)` | AA Core only | Atomic settlement after execution |
| `GetSponsorDeposit(sponsor)` | Safe | Query deposit balance |
| `GetPolicy(sponsor, accountId)` | Safe | Query policy details |
| `GetDailySpent(sponsor, accountId)` | Safe | Query 24h spending |
| `GetTotalSpent(sponsor, accountId)` | Safe | Query lifetime spending |

## Canonical docs

- `docs/HOW_IT_WORKS.md`
- `docs/WORKFLOWS.md`
- `docs/DATA_FLOW.md`
- `docs/architecture.md`
