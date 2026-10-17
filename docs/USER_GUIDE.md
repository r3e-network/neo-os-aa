# User Guide

This guide is a practical, user-first companion to `docs/HOW_IT_WORKS.md`.

## Who should read this

- Operators preparing transactions
- Signers reviewing and approving drafts
- Developers trying to understand the UI flow quickly

## Fast path

1. Open the home workspace
2. Load the abstract account
3. Choose a preset or compose a custom invocation
4. Persist the draft
5. Share the right scoped link
6. Collect signatures
7. Run relay preflight if needed
8. Broadcast via wallet or relay

## Roles

### Read-only reviewer
- Uses the public share link
- Can inspect the draft but cannot mutate it

### Collaborator / signer
- Uses the collaborator link
- Can add signatures or approvals
- Cannot perform operator-only relay or broadcast actions

### Operator
- Uses the operator link
- Can run relay checks, append receipts, rotate links, and submit transactions

## Account Discovery

### Finding accounts you control

V3 has no admin, manager or threshold state and no reverse indices: that V1/V2 role model was
removed. The removed `getAccountsByAdmin`/`getAccountsByManager` reads exist only as SDK stubs that
throw `LEGACY_V3_REMOVED`, and no deployed manifest exports them. Read an account you know about
with `getAccountState(accountHashOrAddress)`:

**Via SDK:**
```javascript
const client = new AbstractAccountClient(rpcUrl, masterContractHash);

const state = await client.getAccountState(accountIdHash);
```

**Use cases:**
- Portfolio management: read every account you hold the id or address for, one call each
- Access audit: check the verifier, hook and backup owner the account actually has

## Batch Account Creation

### Creating multiple accounts efficiently

`registerAccounts(accountIds, verifier, verifierParamsList, hookId, backupOwner, escapeTimelock)`
registers several accounts in one transaction. Every account gets the same verifier, hook and backup
owner; V3 has no shared admin/manager governance (that V1/V2 model was removed), and registration
requires the witness of the `backupOwner` argument, not of the transaction sender.

**Via SDK:**
```javascript
// One payload per account: the SDK has no batch payload builder
const payload = client.createAccountPayload({
  verifierContractHash,
  verifierParamsHex,
  hookContractHash,
  backupOwnerAddress,
  escapeTimelock: 7 * 24 * 60 * 60,
});

// The same derivation the contract's computeRegistrationAccountId uses
const accountId = client.deriveRegistrationAccountIdHash({
  verifierContractHash,
  verifierParamsHex,
  hookContractHash,
  backupOwnerAddress,
  escapeTimelock: 7 * 24 * 60 * 60,
});
// Submit the account ids through registerAccounts(Array, Hash160, Array, Hash160, Hash160, Integer)
```

**Key behaviors:**
- Registration requires the backup owner's witness (`contracts/UnifiedSmartWallet.Accounts.cs:75`)
- Every account carries its own verifier, hook and backup owner; there is no shared governance state
- Single transaction reduces fees
- Atomic operation: all accounts created or none

**Use cases:**
- Team onboarding: register several accounts for team members with the same configuration
- Project setup: deploy dev/staging/prod accounts together
- Service accounts: register a set of accounts one call at a time, atomically

## Recommended references

- `docs/HOW_IT_WORKS.md`
- `docs/WORKFLOWS.md`
- `docs/DATA_FLOW.md`
- `contracts/recovery/TESTNET_VALIDATION_2026-03-09.md`
- `docs/MORPHEUS_PRIVATE_ACTIONS.md`


## Loading by `.matrix`

If you remember your `.matrix` name more easily than an AA address, enter the domain in the load field. The frontend resolves the domain to the controlling wallet address. V3 has no admin or manager role query, so a domain does not by itself list bound AA accounts: read each one with `getAccountState(accountHashOrAddress)`. The V2 account-discovery helper that named the removed `getAccountAddressesByAdmin` / `getAccountAddressesByManager` reads has been deleted, so no frontend path targets those reads any more.
