# User Guide

This guide is a practical, user-first companion to `docs/HOW_IT_WORKS.md`.

## Who should read this

- Operators preparing transactions
- Signers reviewing and approving drafts
- Developers trying to understand the UI flow quickly

## Fast path

1. Open the home workspace
2. Load the smart account
3. Choose a module read or compose a custom invocation
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

## Account discovery

### Finding accounts you control

v4 keeps no reverse index and no role state: there is no admin, manager or shared
threshold account, so nothing on chain lists the accounts a wallet controls. Identity is
derived, not registered: `accountId = hash160('aa524704' || custody || salt)`. Persist each
salt, because the salt is the only part of that preimage the chain does not hand back.

Read an account you know with `getAccount(accountId)`. The control record answers custody,
recovery authority and timelock, authority epoch, configuration nonce, hook-order revision,
installed modules and the pending configuration intent.

**Via SDK:**

```javascript
const { createNativeSmartAccountClient } = require('./sdk/js/src');

const client = await createNativeSmartAccountClient({ rpcUrl, contractHash, networkMagic });
await client.discover();

const identity = client.deriveIdentity({ custodyAddress: custody, salt });
const state = await client.getAccount(identity.accountId);
const validators = await client.getModules(identity.accountId, 'validator');
```

**Use cases:**

- Portfolio management: re-derive each account from its custody address and salt, then read it
- Access audit: list the installed validator and hook modules and read each instance with
  `getModule(accountId, moduleId)`

## Batch account creation

### Creating multiple accounts in one transaction

`createAccounts(Hash160[] accountIds, Hash160 custody, ByteArray[] salts, Integer recoveryTimelockMs)`
creates 1..64 accounts in one transaction. The JS client builds one registration script at a time with
`buildCreateAccountScript`; a batch is the same call repeated per id/salt pair, submitted either as
the contract's own `createAccounts` invocation or as one transaction per account. Every account
shares the custody address and the recovery timelock; the call carries no recovery authority, because
the core has no action that sets one — naming another recovery authority is a governance module's
change, not the core's.

**Via SDK:**

```javascript
const plan = client.buildCreateAccountScript({
  custodyAddress: custody,
  salt: saltA,
  recoveryTimelockMs: 30 * 86_400_000,
});
```

**Key behaviors:**

- The custody address must witness the transaction; each account id must equal
  `hash160('aa524704' || custody || salt)` or the call faults
- A timelock of `0` selects the 7-day minimum; the accepted range is 7..90 days, in milliseconds
- A `createAccounts` batch is atomic: every account is created or none is
- No verifier or hook is chosen at creation. Modules are installed afterwards by configuration
  intents, which mature for 24 hours; only the single-account `createAccount` call can carry
  initial install actions atomically

**Use cases:**

- Team onboarding: create several accounts under one custody witness
- Project setup: deploy dev/staging/prod accounts together
- Service accounts: create a set of accounts one call at a time, atomically

## Recommended references

- `docs/HOW_IT_WORKS.md`
- `docs/WORKFLOWS.md`
- `docs/DATA_FLOW.md`
- `docs/SA-MODULE-PROTOCOL.md`
- `docs/MORPHEUS_PRIVATE_ACTIONS.md`


## Loading by `.matrix`

If you remember your `.matrix` name more easily than an SA address, enter the domain in the load
field. The frontend resolves the domain to the controlling wallet address. A domain does not by
itself list the accounts that wallet controls, because v4 keeps no reverse index: re-derive each
account from custody and salt and read it with `getAccount(accountId)`.
