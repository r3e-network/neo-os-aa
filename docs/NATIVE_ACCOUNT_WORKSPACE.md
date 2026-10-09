# Native account workspace

`/native` is an independent ABI 2 workflow. It never substitutes the deployed V3
contract for the fixed native AccountManagement service. A new endpoint starts
read-only; discovery requires the expected network magic, native contract id,
service hash/name, exact ABI, profile digest and successful getVersion=2.

Read the [account user guide](NATIVE_ACCOUNT_USER_GUIDE.md) for the authority and
timing matrix, backup requirements and key-loss scenarios. External protocol
review and public-network activation remain separate draft-release gates.

## User flows and trust boundaries

1. **Connect a node**: enter its RPC URL and expected network magic, then verify.
   Changing either value or a wallet network/account event discards prepared work.
   Public networks without activation show an explicit read-only error.
2. **Create**: generate a cryptographic 32-byte salt; enter Neo custody/recovery
   script hashes from accepted Neo wallet authorities. Default verifier/hook are
   absent so custody witness works immediately. Choose a guardian controlled
   independently from custody; no recovery requires an
   explicit acknowledgment. Preview stable identity and separate funding address.
3. **Backup / restore**: export a public recovery descriptor (network, profile,
   identity, funding address, custody and salt). It contains no private key and
   cannot replace wallet-key backup. Restore checks format, profile and derived
   identity before any RPC; it never selects an imported endpoint.
4. **Manage / recover**: show custody, recovery, frozen state, authority epoch,
   configuration nonce and channel-zero nonce. Proposals show 24-hour module or
   7-day custody recovery delay; activation is a separate transaction. Native ABI
   2 recovery detaches old modules without requiring their callbacks, advances
   authority epoch and preserves funding address, nonces and frozen state.
   The configured recovery authority may cancel any still-pending recovery;
   custody may cancel only strictly before maturity.
   Mature verifier, hook and guardian-address activations, and mature custody
   recovery execution, require only a fee payer. They operate on the pending
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
   never masquerades as an immediate key revocation.
6. **Business operation**: build an exact typed operation with RPC nonce, finite
   deadline, current authority domain and digest cross-check. Show fee payer,
   exact targets, bytes and profile bounds. Native sponsorship is absent; there
   is no gasless checkbox. Execution exports proxy witness and CustomContracts
   target scope for an exact-script SDK/wallet integration, not legacy invoke.

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

## Manual wallet hand-off

Supported registration and lifecycle calls use the existing wallet invoke
service only after fresh discovery, account-state revalidation, successful
simulation, matching live wallet account and matching live wallet network. The
selected provider must expose `getNetwork()` or `getNetworks()` with a recognizable
active network (numeric magic or MainNet/TestNet). A supported-networks list alone
is not proof of the selected network. The actor is the fee payer and uses
`CalledByEntry`; Global scope is never requested. Dual-authority unfreeze,
configuration and proxy execution remain exact-script exports with explicit
required signer/witness details. Wallet confirmation is a user action; automated
QA never requests a live signature. Wallet rejection leaves the review intact.
A returned transaction id is submitted, not confirmed; readback checks its exact
script and HALT application log before marking confirmation.

## Validation contract

Red tests precede implementation for unavailable/native-v1/wrong-digest endpoints,
malformed account records, endpoint-switch stale work, identity-tampered recovery
descriptors, expired operations, unsafe session defaults, network/account mismatch,
changed chain state before handoff, simulation failure, and non-exact wallet lanes.
Browser checks exercise discovery, creation preview, descriptor export/import,
management review and offline states on desktop and mobile. Mock RPC and wallet
fixtures provide interaction evidence only; they do not establish native-network
activation or production deployment readiness.

## Consuming an exported request

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
native service. Recovery cancellation includes its selected custody/recovery
actor in the required set. Receipt checks require the same signer order and exact
scopes; no broader superset is accepted. Additional NeoNativeVerifier or MultiSig
transaction witness signers are not collected by this UI. Such integrations need
a separate SDK review that includes their discovered module scopes; this page
will not call an unreviewed larger signer roster a confirmed success. Do not call arbitrary
methods from an imported JSON file. Never replay an old signature after a script,
nonce, authority epoch or configuration change.

The descriptor's custody/salt describe the **original identity derivation**.
After recovery, the descriptor still finds the same account; fresh on-chain
state supplies current authority. A descriptor does not reset authority or
recover a lost wallet private key.

An exported policy cancellation includes both its explicit verifier/hook role
and the pending-call snapshot reviewed for that role. Reloading before submission
rejects replacement or removal observed by the last revalidation. The native
call encodes only `cancelModuleCall(accountId, role)`, not the snapshot or its
digest. Pending state can still change before inclusion, and cancellation acts
on the role's pending call at execution. Coordinate custody devices to avoid
concurrent changes and inspect confirmed pending state. The same cancel script
does not prove that the original reviewed intent is still current.

Session defaults use a 48-hour expiry so the initial 24-hour configuration delay
leaves a useful session. New grants ending before activation are rejected. The
pending-activation action reloads and repeats the exact stored arguments; it
never silently extends a session. Revocation is also delayed. Freeze remains the
immediate containment action once its transaction executes, and recovery provides
the old-plugin-independent exit. Freeze clears every pending intent, including
custody recovery and policy calls. Freeze first and confirm, then start recovery;
a recovery proposal on its own leaves an Active account active. Recovery retains
the guardian and Frozen status. Unfreeze requires custody and the configured
guardian, so a lost guardian key while Frozen has no custody-only override.
While Active without pending custody recovery, custody can propose a guardian
replacement with the normal 24-hour delay.

Times shown for deadlines and maturity are chain milliseconds. Equality is valid
for a deadline and sufficient for maturity; custody cancellation of recovery
ends strictly before maturity. An included FAULT can charge fees despite rolling
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
