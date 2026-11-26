# SmartAccount User Guide

This book is the user-facing guide for account owners, custodians and wallet
operators of the native SmartAccount protocol. The SDK developer reference lives
in `docs/SDK.md`; module behavior is specified in `docs/SA-MODULE-PROTOCOL.md`.

## Contents

1. [How It Works & Usage Guide](#how-it-works--usage-guide)
2. [Smart Account Workflow Lifecycle](#smart-account-workflow-lifecycle)
3. [Native account workspace](#native-account-workspace)
4. [Threshold wallet authorities](#threshold-wallet-authorities)
5. [Signed native transaction import](#signed-native-transaction-import)

## How It Works & Usage Guide

### 1. One contract, many accounts

SmartAccount is a native protocol service, not a wallet contract deployed per
user. Every account has a stable `accountId` and a funding address derived from
it, so creating an account costs one transaction and no deployment. Receiving and
transferring need no module at all.

Identity is derived, not registered: `accountId = hash160('aa524704' || custody || salt)`.
The salt is 1..128 bytes of public uniqueness input. Persist it: it is the only
part of that preimage the chain does not hand back. Recovery replaces custody but
never the identity or the funding address.

### 2. Custody, modules and governance

| Role | Authority |
| --- | --- |
| Custody | Witnesses account creation and, when no validator is installed, ordinary operations; `freezeAccount` and `revokeModuleCredentials` take effect at once |
| Validator module (type 1) | Authorizes the exact operation; up to 32 instances per account |
| Hook module (type 4) | Checks an operation before and after the target call; up to 8 instances |
| Governance module | Holds every configuration change: 24-hour delay, 7-day window, at most 16 pending intents of 16 actions |
| Recovery seat (type 5) | Holds the guardian policy and the only path to the native reset; one instance |
| Fee payer | Signs and pays for the whole transaction; payment grants no account authority |
| RPC, SDK, UI | Discovery, construction, simulation and submission; no authority |

Custody proposes and confirms governance intents but never writes module state
directly: the core accepts installation, removal, configuration, built-in
authorization changes and unfreezing only from the account's installed governance
instance. A custody-signed direct call fails with `SA_UNAUTHORIZED`.

### 3. Creating an account

- `createAccount(accountId, custody, salt, actions)` requires the custody witness.
  The actions are install-only (at most 16) and apply atomically, so an account
  can start with its validator, hooks, governance module and recovery seat.
- `createAccounts(accountIds, custody, salts)` creates 1..64 accounts for one
  custody in one transaction, all or nothing. A batch entry takes no actions.

```javascript
const { createNativeSmartAccountClient } = require('./sdk/js/src');

const client = await createNativeSmartAccountClient({ rpcUrl, contractHash, networkMagic });
await client.discover();

const identity = client.deriveIdentity({ custodyAddress: custody, salt });
const plan = client.buildCreateAccountScript({ custodyAddress: custody, salt, actions });
const state = await client.getAccount(identity.accountId);
```

### 4. Reading an account

`getAccount(accountId)` answers nine fields: existence, status, custody, authority
epoch, configuration nonce, the two built-in authorization switches, the required
validator id and the control revision. A fresh account is Active, at authority
epoch 1 and configuration nonce 0, with both built-in switches on and no required
validator. Modules are read with `getModules(accountId, 'validator' | 'hook' | 'recovery', ...)`
and `getModule(accountId, moduleId)`; a pending intent is read from the governance
module that holds it.

### 5. Spending

An operation runs through `executeUserOp(accountId, operation)`: one operation per
call and per transaction. The 13-field operation binds the target, method and
arguments to the nonce channel, deadline, validator id, credential generation,
authority epoch and configuration nonce. A validator route or the built-in custody
signature authorizes it inside that call. The account itself cannot pay fees: an
external payer signs the transaction.

### 6. Keep the right backups

| Item | Purpose | What to keep |
| --- | --- | --- |
| Account ID | Identifies the account and its settings | Network and account ID |
| Funding address | Holds the account's assets | The independently verified address shown after registration |
| Public recovery descriptor | Records custody, salt, identity, funding address and configuration | A copy you can use to find and verify the account |
| Custody wallet backup | Authorizes management and default execution | Wallet private key or recovery backup, stored safely |
| Guardian wallet backups | Start a recovery request as a guardian quorum | A separate security backup, controlled independently from custody |

The descriptor contains no private key. Until the recovery seat is installed and
its policy confirmed, the account has no recovery path: a lost custody key cannot
be replaced. The [SDK guide](SDK.md) describes the supported signing interfaces and
the exact transaction review.

## Smart Account Workflow Lifecycle

1. **Connect.** Enter the RPC URL and the expected network magic, then validate.
   Discovery checks the native contract's identity, ABI, parameter digest and
   implementation id. Any change of network, wallet or account discards prepared
   work.
2. **Create.** Generate a 32-byte salt, choose the custody wallet and the initial
   module installs, and preview the identity and funding address before signing.
3. **Configure.** Every later module change is a governance intent: custody
   proposes it on the governance module, confirms the identical stored actions
   after 24 hours and inside the 7-day window, and the module lands it on the core.
4. **Operate.** Build a typed operation with its nonce, deadline and current
   authority domain, review the payer, target, bytes and fee ceilings, simulate,
   then submit. A returned transaction ID means submitted, not confirmed.
5. **Contain.** If a validator credential is compromised, revoke it at once with
   `revokeModuleCredentials`. If containment must be immediate, freeze first and
   confirm the Frozen state. Freezing advances the authority epoch, so every
   pending intent and recovery request becomes stale.
6. **Recover.** Custody, the configured recovery authority or the guardian quorum
   starts a request on the recovery seat. After the configured 7..90 days anyone
   executes it; the account is reset, its module set reinstalled in the same
   transaction and the recovery policy deleted.

Every step reloads account state and chain time before it acts. Deadlines and
delays use on-chain milliseconds, not the device clock.

## Native account workspace

`/native` is the workspace for the native SmartAccount contract. A new endpoint
starts read-only; discovery requires the expected network magic, native contract
id, native contract hash and name, exact ABI and profile digest.

The protocol is in design and has no network activation. Use a node of a local or
private chain that runs the matching native build and completes discovery; a network
without the service shows an explicit read-only error.

Registration takes the custody witness and, optionally, an atomic initial group of module installs; it names no guardian and sets no recovery policy. Guardians, their threshold and the recovery delay are configured later on the installed recovery module, through the governance delay. A recovery request that names a new custody needs that custody's witness as well. The review lists every required witness and fails submission if the selected signing integration cannot supply them. A signer entry without its wallet or contract witness does not satisfy the requirement. Native account proxies are not supported authority addresses. Executing a mature recovery request is permissionless; confirming a governance intent always needs the custody witness.

These are the only consent checks the core and its standard modules make. A guardian or recovery authority that a new policy replaces is not asked to consent on chain; only the custody witness on the governance path authorizes the change.

### Set up and keep the right backups

| Item | Purpose | What to keep |
| --- | --- | --- |
| Account ID | Identifies the account and its settings | Network and account ID |
| Funding address | Holds the account's assets | The independently verified address shown after registration |
| Public recovery descriptor | Records the original custody, salt, identity, funding address and profile | A copy you can use to find and verify the account |
| Custody wallet backup | Authorizes administration and default execution | The wallet's private-key or recovery backup, stored securely |
| Guardian wallet backup | Authorizes a recovery request with the guardian quorum | A separate secure backup controlled independently from custody |

The descriptor contains no private key. It cannot sign, restore a lost wallet key or remove a
guardian. After custody recovery, its original identity fields still identify the same account;
fresh on-chain state shows the current custody. Never put private keys in a descriptor or
reviewed request.

Set up in this workspace: verify the network and node, then choose an accepted Neo wallet
authority for custody and, independently, the guardian addresses you will rely on. Review the
derived account ID and separate funding address, sign registration with custody, confirm it, and
read the recorded account state before funding it. Fund the account's funding address, and keep
wallet backups separately from the public descriptor. Until the recovery module is installed and
its policy is confirmed, the account has no recovery path: a lost custody key cannot be replaced.
The [SDK guide](SDK.md) describes supported signing interfaces and exact transaction
review.

### Who can act, and when

Custody is the administration key. Guardians form the recovery quorum of the recovery module;
they take no part in module configuration or in the thaw. Every action needs a transaction
fee payer; paying does not grant account authority. A payer can also act as custody or a guardian
when it controls the required wallet.

| Change | Who starts it | Who completes it, and when | Who can cancel while pending |
| --- | --- | --- | --- |
| Replace or remove a validator / hook | Custody, through the governance module, while Active | Custody confirms the exact stored actions after 24 hours, within the 7-day window | Custody, until it is confirmed |
| Change a module policy, including a session key or the guardian list | Custody, through the governance module, while Active | Custody confirms the exact stored actions after 24 hours, within the 7-day window | Custody, until it is confirmed |
| Replace custody | Custody, the configured recovery authority or the guardian quorum, while Active or Frozen; a named new custody must also witness | Anyone, once the configured delay of 7 to 90 days has elapsed and the authority epoch, configuration nonce and recovery policy are unchanged | The same authorities, until it is executed |
| Freeze | Custody, while Active | Takes effect when the transaction executes; no protocol waiting period | No pending state; resuming requires unfreeze |
| Unfreeze | Custody, through the governance module, while Frozen | Custody confirms after 24 hours, within the 7-day window | Custody, until it is confirmed |

A confirmation applies the actions stored at proposal time and must resubmit them unchanged, so
the payer cannot choose a different replacement. An installation still requires valid module code,
and a removal requires the module's cleanup callback to succeed. Inspect the pending intent before
confirming or cancelling it. Cancelling a proposal does not change the current policy.

In the workspace, refresh the account and chain time before acting. A snapshot does not update
itself when another transaction changes the account; revalidation rejects changes it observes.
Coordinate custody devices and inspect confirmed account, pending-intent and recovery-request state.
Deadlines and delays use **chain time in milliseconds**, not your device clock: an operation is
valid at its exact deadline, a governance intent can be confirmed from its maturity time until
its expiry time, and a recovery request can be executed from its executable time. A transaction
included in a later block can miss its deadline even after a successful preview. Every
configuration landing, freeze, thaw and recovery advances the configuration nonce or the
authority epoch, which makes the intents and recovery requests that predate it stale; reload
state before each subsequent action.

### Emergency containment and guardian trust

Removing or changing a session key is delayed. An active key can keep exercising its existing
permission until it expires, the account is frozen or its credentials are revoked.
`revokeModuleCredentials` needs only the custody witness and makes every operation signed
under that validator's previous credential generation fail. When immediate containment is needed,
freeze first, confirm the Frozen state, and then start recovery if custody needs replacement.
Freezing advances the authority epoch, so every pending governance intent and recovery request,
including verifier/hook changes, guardian changes and module-policy calls, becomes stale and can
no longer be confirmed or executed.
Proposing recovery alone does not freeze an Active account, and recovery may be started while
Frozen. Recovery keeps the account ID and funding address. It replaces custody when a new one
was named, returns the account to Active, restores the built-in authorization switches, clears the
required validator and retires every module instance; the recovery module then reinstalls the
installed module set in the same transaction under new module ids and credential generations.
The recovery policy, including the guardian list and the delay, does not survive and must be
configured again. Every operation signature, credential and nonce channel that predates the
recovery is invalid. Unfreezing still goes through the
installed governance module and its delay, and a Frozen account must be unfrozen before new
module configuration.

Choose a guardian you trust to remain available and cooperate. Freezing is a custody-only core
entry, and unfreezing is not: the installed governance module requires the custody witness to
propose the thaw and to confirm it after its delay, so a guardian has no part in it and a
custody signature on the core call alone fails with `SA_UNAUTHORIZED`. A guardian key lost
while Frozen therefore does not lock the thaw. Guardians are changed like any other module policy:
custody proposes the new guardian list, threshold and delay on the governance module and confirms
after 24 hours, and that change retires any pending recovery request. One to ten guardians are
accepted, and the threshold may be any number from one up to the list size. A standard Neo
threshold multisignature wallet can serve as one guardian: independently backed-up 2-of-3 keys
tolerate one unavailable key while the remaining two still authorize that guardian. It is separate
from the account's validator modules. Guardians do not sign the thaw or any other configuration;
custody does, on the governance module. If fewer than the threshold remain, the custody key and
the configured recovery authority are the only other ways to start recovery; a guardian quorum
reduces individual-key failure risk without creating authority after all usable backups are lost.

### If a key or backup is lost

| Situation | Available path |
| --- | --- |
| Custody key lost; guardian quorum available | The guardian quorum, or the configured recovery authority, starts recovery to a new custody wallet, which must witness the request; anyone completes it after the configured delay. Freezing needs custody, so start recovery at once when the old key may be compromised. |
| Guardian keys lost below the threshold; account Active and custody available | Custody replaces the guardian list, the threshold or the delay on the recovery module, after the 24-hour governance delay. |
| Guardian keys lost; account Frozen | The thaw does not need the guardians: custody proposes and confirms it on the governance module. Start recovery only if custody also needs replacing. |
| Session key lost or compromised; custody available | Withdraw the validator's credentials at once with `revokeModuleCredentials`; removing or replacing it for good goes through the governance delay. |
| Descriptor lost; wallet keys available | Recover the known network/account ID from your records and verify on-chain state. Wallet backups and a descriptor serve different purposes. |
| Custody key lost, and neither a guardian quorum nor the recovery authority is available | There is no key-recovery shortcut in this profile. Other validators may still allow their own operations, but they do not replace custody for administration, freezing or recovery. |

### Fees, results and uncertain submissions

The native account itself cannot be the fee payer: an external payer signs the complete
transaction and pays its fees. Review the exact target, arguments, deadline, authorities and
system/network/total fee limits before signing. Workspace consumption and minimum-budget
previews are not a final transaction quote; review the final network fee and total with the
wallet or SDK.

A returned transaction ID means submission, not confirmation. If a request times out, query
**that same transaction ID** and inspect the wallet's submission before preparing a replacement.
Do not automatically sign another transaction or raise fees. A successful preview reserves
neither a nonce nor a place in a block.

### User flows and trust boundaries

1. **Connect a node**: enter its RPC URL and expected network magic, then verify.
   Changing either value or a wallet network/account event discards prepared work.
   Public networks without activation show an explicit read-only error.
2. **Create**: generate a cryptographic 32-byte salt; enter the Neo custody
   script hash from accepted Neo wallet authorities and the initial module installs. No verifier or hook is required, so
   the custody witness works immediately. Registration names no guardian
   and sets no recovery policy: both are configured later on the recovery
   module. Preview stable identity and separate funding address.
3. **Backup / restore**: export a public recovery descriptor (network, profile,
   identity, funding address, custody and salt). It contains no private key and
   cannot replace wallet-key backup. Restore checks format, profile and derived
   identity before any RPC; it never selects an imported endpoint.
4. **Manage / recover**: show custody, recovery, frozen state, authority epoch,
   configuration nonce. Proposals show the 24-hour governance delay or the recovery
   module's configured delay; execution is a separate transaction. Recovery resets
   the account and reinstalls its module set in the same transaction, advances
   the authority epoch and keeps the account id and funding address.
   Custody, the recovery authority or the guardian quorum can cancel a pending recovery
   until it is executed, even after its executable time.
   **Cancellation authority** selects the wallet that authorizes cancellation,
   separately from **Fee payer**. The same-wallet default remains available.
   An independent payer receives `None` scope; the selected authority receives
   `CustomContracts` restricted to the native contract. Choosing different wallets
   automatically uses the exact-script SDK path. A pending recovery can be
   cancelled by its authorities even after its executable time. Fresh chain time is checked again before export and handoff.
   Confirming a mature governance intent needs the custody witness; executing a mature
   recovery request needs only a fee payer. Both act on the pending
   intent present at execution and must pass current state and maturity checks.
   The review snapshot does not lock that state until inclusion.
5. **Restricted sessions / multiple approvals**: build declared module calls
   with typed values, finite session expiry and an explicit positive spending
   cap. Session configuration excludes the automatically prepended account id.
   MultiSig thresholds count verifier modules, not independently controlled
   humans. Inspect pending policy calls separately for verifier and hook roles;
   review their selected module, method, typed arguments and maturity. Custody
   can cancel the selected pending call. Cancellation removes that proposal,
   not an active key or policy. Applying the policy after 24 hours still requires
   custody and its exact stored arguments. Delayed policy calls are exported as exact scripts; configuration
   never masquerades as an immediate key revocation. A cancellation export includes an
   execution-time comparison against the reviewed pending bytes.
6. **Business operation**: build an exact typed operation with RPC nonce, finite
   deadline, current authority domain and digest cross-check. Show fee payer,
   exact targets, bytes and profile bounds. The account cannot pay fees. Execution exports proxy witness and CustomContracts
   target scope for an exact-script SDK/wallet integration.

Account state and displayed chain time are snapshots. Use **Refresh account and
chain time** before acting on a pending change. In the policy tab, select
**Module role**, then **Refresh pending policy**. The pending card shows the
root and selected module, method, typed arguments, maturity and checked chain
time. **Review policy cancellation** compares the freshly read pending call to
that inspected snapshot; an observed change requires a new review.
**Review pending activation**
uses the selected role and repeats the exact stored call after maturity. New
hook-policy proposals are built through the SDK.

The review separates **Application consumption** from **Minimum system fee
budget**. Its **Network fee** remains unquoted until an exact transaction and
witness roster are available. These preview values are not a final total-fee
approval; review the wallet's final fees or use SDK fee caps before signing.

### Manual wallet hand-off

Supported registration and lifecycle calls use the existing wallet invoke
service only after fresh discovery, account-state revalidation, successful
simulation, matching live wallet account and matching live wallet network. The
selected provider must expose `getNetwork()` or `getNetworks()` with a recognizable
active network (numeric magic or MainNet/TestNet). A supported-networks list alone is
not proof of the selected network. The actor is the fee payer and uses
`CalledByEntry`; Global scope is never requested. Unfreeze,
configuration, guarded policy cancellation and proxy execution use exact-script
exports with explicit required signer/witness details. A standard wallet
multisignature can represent the configured guardian as one script hash; retain
the complete script, member keys and threshold as described in
[threshold recovery](#threshold-wallet-authorities).
Wallet confirmation is a user action; automated
QA never requests a live signature. Wallet rejection leaves the review intact.
A returned transaction id is submitted, not confirmed; readback checks its exact
script and HALT application log before marking confirmation.

For an exact-script review, the **Import and submit a signed transaction** panel
accepts the SDK's exported JSON file after explicit system, network and total GAS
ceilings are entered. **Check signed transaction** validates its canonical bytes,
network/profile, ordered signer roster, signatures and complete signed preflight.
**Broadcast signed transaction** repeats preflight and sends the same bytes once.
Changing the review or fee limits invalidates the imported approval. A timeout
keeps the original transaction ID available through **Check imported transaction
confirmation**; a committed FAULT is shown as unsuccessful. See
[signed transaction import](#signed-native-transaction-import) for supported
formats and confirmation recovery.

Before freezing, the review shows the custody identity, the effect on pending proposals and
recovery timing, and that thawing needs the installed governance module and its delay, so custody
cannot thaw the account alone. An explicit acknowledgment is required. Guardians take no part in
freezing or in the thaw, so a lost guardian signing quorum does not lock a Frozen account.

### Validation contract

Red tests precede implementation for unavailable or wrong-digest endpoints,
malformed account records, endpoint-switch stale work, identity-tampered recovery
descriptors, expired operations, unsafe session defaults, network/account mismatch,
changed chain state before handoff, simulation failure, and non-exact wallet lanes.
Browser checks exercise discovery, creation preview, descriptor export/import,
management review and offline states on desktop and mobile. Mock RPC and wallet
fixtures provide interaction evidence only; they do not establish behaviour on a network.

### Consuming an exported request

The JSON is a **review document, not a signed transaction or universal wallet
import format**. For SDK consumption, select **Native SDK · exact script** before
building the review. The default management **Wallet invoke** path has a separate
`CalledByEntry` signer schema and exports a primitive `request`; that artifact
must not be fed to the SDK transaction builder. Changing paths discards the old
review and requires another explicit approval. Its `recipe` names the native SDK builder and contains the typed
input; `plan.script` is the exact comparison target. Rebuild in a fresh client
on the recorded network and profile before supplying any private signer:

```js
import { rebuildNativeReview } from "./frontend/src/features/native/nativeWorkspace.js";
const plan = await rebuildNativeReview(client, exported);
```

This repository helper uses an explicit builder whitelist and compares the full
fresh discovery profile and **every public field of the rebuilt plan** with the
review. This includes authority epoch, configuration nonce, full account state,
pending recovery/configuration intent, module-call phase and execution
context/digest/proof. It then revalidates the fresh plan before returning it.
A downstream SDK/wallet integration must preserve these comparisons if it ports
the helper. Comparing only the script is unsafe: `executeRecovery(accountId)`
can have the same script after a different new custody has been proposed.

A signer integration must also compare the exported network, service and profile
digest against the fresh discovery result, and the selected actual fee payer / authority and
proxy signer scopes against the rebuilt plan. Then use the native SDK's
`prepareTransaction` with explicit maximum system, network and total fee bounds,
its actual wallet signer interfaces and final user approval. SDK-mode scopes are
shown before export: payer first (`None` unless also required), proxy second for
execution, then remaining authorities with `CustomContracts` restricted to the
native contract. Recovery cancellation exports its selected `cancellationAuthority`
separately from `feePayer`, and includes only that selected custody/recovery wallet
in the required set. Rebuilding checks the exported authority and the complete
actual signer roster against the fresh plan; it does not change the issued plan.
Older version-one cancellation exports that omit this field are accepted only
when the payer is also the required cancellation authority and their complete
signer roster matches that same-wallet selection. Explicit invalid fields or
an independent-payer roster do not receive this compatibility fallback.
Pass that same `cancellationAuthority` to `prepareTransaction`, supply the payer
wallet as `feePayer`, and supply the selected authority in `authoritySigners` when
it differs from the payer. Editing either selection invalidates the previous
review and any imported signed transaction. Receipt checks require the same signer order and exact
scopes; no broader superset is accepted. Additional NeoWitnessValidator or MultiSig
transaction witness signers are not collected by this UI. Such integrations need
a separate SDK review that includes their discovered module scopes; this page
will not call an unreviewed larger signer roster a confirmed success. Do not call arbitrary
methods from an imported JSON file. Never replay an old signature after a script,
nonce, authority epoch or configuration change.

The descriptor's custody/salt describe the **original identity derivation**.
After recovery, the descriptor still finds the same account; fresh on-chain
state supplies current authority. A descriptor does not reset authority or
recover a lost wallet private key.

An exported policy cancellation includes its explicit verifier/hook role and
the complete pending-call snapshot. Its signed script asserts the canonical
pending bytes on chain before invoking cancellation, so changed or missing
content faults before deletion even if it changed after client revalidation.
The workspace requires exact-script signing and disables ordinary wallet invoke
for this operation. The unchanged native method still supports deliberate role
slot cancellation by other callers. An exactly identical record recreated in
the same block can match the guard; this is content binding rather than a unique
proposal-instance identifier. Inspect confirmed pending state. The guard is the exact script above: it compares the pending bytes on chain before
the cancellation call.

Session defaults use a 48-hour expiry so the initial 24-hour configuration delay
leaves a useful session. New grants ending before activation are rejected. The
pending-activation action reloads and repeats the exact stored arguments; it
never silently extends a session. Revoking a validator's credentials is
immediate on the custody witness; removing or replacing it is delayed. Freeze remains the
immediate containment action once its transaction executes, and recovery provides
the module-independent exit. Freezing advances the authority epoch, so every pending intent, including
custody recovery and policy calls, becomes stale and can no longer be confirmed
or executed. Recovery may be started while Active or Frozen and returns the
account to Active. Unfreeze goes through the installed governance
module on the custody witness, so a lost guardian key while Frozen does not block the thaw.
While Active, custody can change the guardian list, threshold and delay with
the normal 24-hour delay.

Times shown for deadlines and maturity are chain milliseconds. Equality is valid
for a deadline and sufficient for maturity; a pending recovery can be
cancelled by its authorities until it is executed. An included FAULT can charge fees despite rolling
back application changes. Boolean `false` is not itself a VM fault; review the
operation's result and applicable policy. After a timeout, inspect the same
transaction ID before preparing another transaction.

If the wallet request was already opened when the network changed, the
page cannot recall it; a late result asks the user to inspect the wallet before
retrying and is never shown as confirmation of the new context.

`npm run prebuild` synchronizes canonical native sources when the complete repo
is present. A frontend-only deployment uses its committed copies; repository
tests compare their SHA-256 hashes with the canonical modules. Browser QA is
`npm run test:native:browser`, included in the existing frontend browser gate.

## Threshold wallet authorities

A standard Neo P-256 m-of-n wallet can be the account's custody address, its recovery authority or
its fee payer. It is a transaction-witness account, not a threshold policy over modules and not
another native account proxy. It does not change account identity, the recovery timelock or the
module model. The protocol has no network activation today.

The account's recovery authority, where one is configured, is a field of the recovery module's
policy: the core carries no action that sets it, and the policy changes only through a governance
intent. The standard `RecoveryModule` carries the lifecycle, and its
`beginRecovery(accountId, newCustody)` and `cancelRecovery(accountId)` accept the custody address,
the configured recovery authority or the configured guardian threshold, with `beginRecovery`
additionally requiring the new custody address's witness. `freezeAccount` is a core entry and is custody-only. `unfreezeAccount` lands
only when its direct caller is the account's installed, code-bound `Governance` module, so a thaw
signed by custody alone fails with `SA_UNAUTHORIZED`.

### Signer contract

Supply the standard wallet script hash as `account` and its exact canonical `verificationScript`.
Single-signature adapters keep returning a 64-byte P1363 signature string. A multisig adapter returns
an array of `{ publicKey, signature }` entries from `sign(signDataHex)`. Public keys are compressed
P-256 points and signatures cover the exact supplied network-bound transaction sign data with
P-256/SHA-256 once. The SDK stores no private keys.

```js
const authority = {
  account: authorityScriptHash,
  verificationScript: authorityVerificationScript,
  async sign(signDataHex) {
    return Promise.all(availableMembers.map(async member => ({
      publicKey: member.publicKey,
      signature: await member.sign(signDataHex),
    })));
  },
};

// A thaw is not a core call that custody signs: the core accepts it only from the
// account's installed governance module. One recipe carries both steps and
// resolves the module, the pending intent and the delay itself.

// 1. Custody proposes the thaw on that module. The plan targets the module,
//    names custody as its only witness and is reviewed like any other plan.
const proposal = { method: 'buildGovernanceModulePlan', input: { accountId, action: 'unfreezeAccount' } };
const proposed = await client.prepareTransaction(
  await client.buildGovernanceModulePlan(proposal.input),
  { feePayer: payer, recipe: proposal, authorizers: [custody], ...feeLimits },
);
const proposedSigned = await client.signTransaction(proposed);
await client.broadcastTransaction(proposedSigned);

// 2. After the module's delay (24 hours on the standard module), custody confirms
//    that intent. The module repeats the single action 11 and makes the core call
//    custody cannot make itself. The intent id is the proposal's result and is
//    published in the module's pending intents.
const intentId = (await client.getGovernanceSeat(accountId)).intents.find((intent) => intent.kind === 'unfreeze').intentId;
const confirmation = {
  method: 'buildGovernanceModulePlan',
  input: { accountId, action: 'confirmConfiguration', intentId },
};
const confirmed = await client.prepareTransaction(
  await client.buildGovernanceModulePlan(confirmation.input),
  { feePayer: payer, recipe: confirmation, authorizers: [custody], ...feeLimits },
);
const confirmedSigned = await client.signTransaction(confirmed);
await client.broadcastTransaction(confirmedSigned);
```

Both plans target the governance module and both need the custody witness: when custody is a
threshold wallet, `authority` above is the custody signer and its members sign each transaction.
The reviewed `prepareTransaction` path replays a plan only from the builders it knows
(`buildCreateAccountScript`, `buildExecutionScript`, `buildRecoveryModulePlan`,
`buildGovernanceModulePlan`, `buildConfigurationBatchPlan`, `buildAccountActionScript`), so both thaw
steps go through it: custody is scoped to the governance module, and before signing the builder
re-reads the pending unfreeze intent, the authority epoch, the configuration nonce and the chain
time. It refuses a second proposal while one is pending, a confirmation before the intent matures
or after its 7-day window, and an intent recorded under an earlier epoch or configuration nonce.
`buildAccountActionScript({ method: 'unfreezeAccount' })` still builds the core call,
but a transaction signed by custody alone fails with `SA_UNAUTHORIZED`.

A plan one of the other builders produced is reviewed, signed and broadcast the same way; here the
threshold wallet is custody and freezes its account:

```js
const action = { method: 'freezeAccount', accountId };
const plan = client.buildAccountActionScript(action);
const prepared = await client.prepareTransaction(plan, {
  feePayer: payer,
  recipe: { method: 'buildAccountActionScript', input: action },
  authorizers: [custody],
  ...feeLimits,
});
const signed = await client.signTransaction(prepared);
await client.broadcastTransaction(signed);
```

`prepareTransaction` rebuilds the plan from the `recipe` it was reviewed with, resolves the fee payer
to witness scope `None`, and scopes every `authorizers` entry to exactly the contract the plan
calls, because the core recognizes an authority with `Runtime.CheckWitness`. Present the fixed
transaction, threshold, complete public-key roster, account role, scopes and fees to each
participant before signing.

Only canonical standard CHECKSIG and CHECKMULTISIG scripts are accepted. Every point must be valid;
multisig members must be unique and ordered as Neo orders EC points (X, then Y). The script hash must
match the signer. All submitted signatures are checked, including signatures beyond the threshold.
Duplicate, unknown or invalid entries reject the response; none are silently discarded. After
validation, the first m available members in script order form the witness, independent of callback
completion or response-array order.

Both invocation and verification scripts must fit Neo's existing 1,024-byte witness limits. Standard
66-byte signature pushes limit m to 15; canonical 35-byte public-key pushes and script framing limit
n to 29. Larger scripts are rejected rather than expanding protocol limits. Network-fee estimation
uses m signature placeholders and the full verification script, then checks the final witness fee.
These limits do not promise a transaction fits every other fee, size or verification-gas bound;
signed preflight still must succeed.

The portable signed-transaction import path must use the same script, signature, ordering and size
validation. JSON is not permission to sign or broadcast. Browser validation uses P-256 WebCrypto and
the same public script parser; no private key or signing capability is required to inspect a signed
artifact.

### Availability and recovery boundaries

For a 2-of-3 recovery authority, losing one member key still leaves a working quorum. `beginRecovery`
uses the 7..90 day delay in the recovery module's policy, and `executeRecovery` is permissionless once
that delay elapsed and the authority epoch, configuration nonce and policy are unchanged. Execution
resets the account to `Active`, re-enables the built-in authorization and clears the required
validator, then reinstalls the installed module set in the same transaction under new module ids.
The recovery policy does not survive the reset and must be configured again.

If custody is lost and fewer than m recovery members remain usable, there is no cryptographic
shortcut: changing the threshold or roster produces a different wallet script hash and does not
change the configured recovery authority. While Active, custody replaces that
authority, the guardian list or the threshold through a governance intent and its 24-hour
delay.

Keep the threshold, complete public-key roster and exact verification script with public account
records, and keep participant wallet backups independently. Different public keys do not prove
different people or independent backups. Any available quorum can exercise recovery, so a threshold
distributes that power as well as improving key-loss tolerance. The recovery authority has no part
in a thaw: custody proposes and confirms it on the governance module, so custody should not be a
single key you cannot replace.

### Validation and rollout

SDK tests cover all 2-of-3 quorums, response order, invalid surplus signatures, malformed or oversized
scripts, fee placeholders, and authority/custody/payer roles. Core tests use public fixture keys and
actual transaction Verification before freeze, recovery and unfreeze. They do not exercise registered
native-account cross-proxy authority. Runtime support must be demonstrated with the chosen wallet
integration before relying on a threshold authority; an ordinary wallet `invoke` alone does not prove
multisig coordination capability.

## Signed native transaction import

The browser reviews a native plan before accepting a signed transaction. The existing wallet adapter exposes invocation only, so exact scripts and complete witnesses are signed externally with the native SDK. `client.exportSignedTransaction(signed)` produces a versioned JSON artifact containing public transaction fields and witnesses. It never exports signer callbacks or private keys. Only objects signed by the same SDK tool instance can be exported.

The portable artifact transport is shared by the SDK and browser. Import checks bounded input, an exact schema, canonical transaction serialization, transaction hash and network signing bytes, the discovered profile, current review script, ordered signer descriptors and fee payer, explicit fee caps, transaction expiry, canonical proxy witnesses, and every wallet signature through the shared standard wallet witness validator. Unknown verification scripts and extra verifier signers are rejected unless the current review explicitly contains the same supported signer roster. Import does not reconstruct a new transaction or alter signed fees.

Before an explicit broadcast, the transport revalidates the current plan and requires a fresh `invoketransaction` response for the complete signed bytes. SDK and browser call the same response validator: exact transaction/network identity, successful verification and Application execution, successful next-block OnPersist preparation, snapshot identity, complete simulation context, admission fee within the signed budget, and successful token-transfer return values. Application-only simulation is insufficient.

Broadcast transmits the exact imported bytes once. The transport checks the UI's current-review callback immediately before submission. A timeout after submission begins retains the original transaction ID and cached outcome; it does not retry submission or rebuild a transaction. Receipt lookup verifies persisted bytes and Application-log identity against that original artifact. A confirmed FAULT or unsuccessful token transfer is reported as confirmed but unsuccessful. Receipt lookup does not require the pre-execution account state to remain unchanged.

The first format supports version-zero Neo transactions without attributes, the exact reviewed None/CustomContracts signer descriptors, standard wallet witnesses supported by `nativeWalletWitness.mjs`, and the canonical native proxy witness. The browser has no generic raw-transaction parser or authority to infer additional signers. A changed plan, payer, signer set, fee approval, network, or profile requires a new review. JSON input is limited to 1 Mi characters and serialized transactions to 102,400 bytes.

With a freshly rebuilt SDK plan and an existing wallet adapter that signs the exact network transaction data, export the public artifact after the SDK verifies all signatures:

```js
const prepared = await client.prepareTransaction(plan, {
  feePayer,
  authoritySigners,
  maxSystemFee: "300000",
  maxNetworkFee: "100000",
  maxTotalFee: "400000",
});
const signed = await client.signTransaction(prepared);
const artifact = client.exportSignedTransaction(signed);
const artifactJson = JSON.stringify(artifact, null, 2);
```

The example fees are integer datoshi limits and must be chosen for the actual reviewed transaction. Signer adapters are supplied by the existing wallet integration; the workspace does not create keys or convert ordinary message signatures into transaction signatures. In the browser, select the exact-script review, enter explicit fee limits, import the artifact JSON file, inspect the validated transaction and complete signed preflight, and explicitly broadcast. A fresh preflight runs again immediately before transmission.

After a reload, open **Restore a transaction receipt**. Select the original exported review file (`neo-native-reviewed-request`, version 1) under **Archived reviewed request** and its matching artifact under **Signed transaction for receipt**. Choose **Verify receipt files**, then **Check restored receipt**. `restoreForReceipt(client, archivedReview, artifactText)` validates the public signatures, exact bytes, profile, payer and signer descriptors, and reconstructs the archived recipe's script without reading current account state. The current node must still pass native discovery with the same network and profile. Expired or executed transactions can therefore be restored for receipt lookup.

Historical restoration returns an object permanently marked `receiptOnly`. Both signed preflight and broadcast reject it before consulting submission caches. It cannot authorize a new transaction. Receipt lookup still verifies the original persisted raw bytes, transaction ID and Application execution. A successful VM result and strict transfer return values are reported separately from confirmation.

An archived JSON file is not proof of its historical prose or account snapshot. Restoration discards descriptions, old account state, pending-intent labels and authority-role claims. Registration, lifecycle and module-call recipes must reconstruct the exact signed script; guarded cancellation must reconstruct its exact pending-byte assertion. Workspace operation receipts reconstruct the single operation's context, method, arguments, nonce, deadline and proof into the exact script before interpreting transfer results. Unsupported recipes are rejected. `semanticsVerified` means these script-bound semantics were reconstructed; it does not authenticate discarded metadata or assert the resulting current account state.

Regression validation uses only fixed public development vectors, local RPC fixtures and mocked transport. It covers canonical-byte tampering, signer and profile mismatch, wrong signatures and expiry, fee caps, complete signed-preflight failures, review changes before submission, submission uncertainty, exact-byte receipt verification, historical restore after expiry or execution, forged archive semantics, and receipt-only restrictions even when a normal broadcast cache exists. No user wallet, private key or live network is needed.
