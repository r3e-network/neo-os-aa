# Native account user guide

Native SmartAccount is a draft protocol. Use a node that has explicitly
activated the matching profile and completes native discovery. External review,
public-network activation and production deployment remain separate decisions.
Selecting a public RPC endpoint does not activate the service.

## Set up and keep the right backups

| Item | Purpose | What to keep |
| --- | --- | --- |
| Account ID | Identifies the account and its settings | Network and account ID |
| Funding address | Holds the account's assets | The independently verified address shown after registration |
| Public recovery descriptor | Records the original custody, salt, identity, funding address and profile | A copy you can use to find and verify the account |
| Custody wallet backup | Authorizes administration and default execution | The wallet's private-key or recovery backup, stored securely |
| Guardian wallet backup | Authorizes emergency freeze and custody recovery | A separate secure backup controlled independently from custody |

The descriptor contains no private key. It cannot sign, restore a lost wallet
key or remove a guardian. After custody recovery, its original identity fields
still identify the same account; fresh on-chain state shows the current custody.
Never put private keys in a descriptor or reviewed request.

In the [native workspace](NATIVE_ACCOUNT_WORKSPACE.md), verify the network and
node, then choose accepted Neo wallet authorities for custody and an independently
controlled guardian. Review the derived account ID and separate funding address,
confirm registration, and read the recorded account state before funding it.
Fund the account's funding address. Keep wallet backups separately from the
public descriptor. The [SDK guide](NATIVE_SDK.md) describes supported signing
interfaces and exact transaction review.

## Who can act, and when

The guardian is the account's configured recovery authority. Every action needs
a transaction fee payer; paying does not grant account authority. A payer can
also act as custody or guardian when it controls the required wallet.

| Change | Who starts it | Who completes it, and when | Who can cancel while pending |
| --- | --- | --- | --- |
| Replace or remove verifier/hook; change guardian | Custody, while Active with no pending custody recovery | Any payer after 24 hours; account must still meet those state conditions | Custody, including after maturity until activation executes |
| Change module policy, including a session key | Custody, while Active with no pending custody recovery | Custody repeats the exact stored call after 24 hours | Custody; select the verifier or hook role and review its pending call |
| Recover custody to a new wallet | Configured guardian, while Active or Frozen | Any payer after seven days | Guardian at any time while pending; custody only strictly before maturity |
| Freeze | Configured guardian, while Active | Takes effect when the transaction executes; no protocol waiting period | No pending proposal; resuming requires unfreeze |
| Unfreeze | Custody and configured guardian together | Takes effect when the transaction executes; no protocol waiting period | No pending proposal |

A mature activation applies the authorized intent present when it executes; its
payer does not choose the replacement in the activation call. Module replacement still requires valid
module code and successful cleanup. Module-policy application is a different
action and requires custody again. Inspect the current pending payload before
activation or cancellation. Cancelling a policy proposal does not revoke the
currently active policy.

In the workspace, refresh the account and chain time before acting. For a policy
call, select its verifier/hook role, refresh the pending policy, inspect the
stored arguments and choose the cancellation or activation review. A snapshot
does not update itself when another transaction changes the account.
Revalidation rejects changes it observes. The SDK's policy-cancellation transaction
also compares the complete reviewed pending content on chain immediately before
cancelling. If the content changed or disappeared, the transaction fails instead
of cancelling another proposal. Use the complete exported script: an ordinary
wallet method invocation cannot preserve this check. An exactly identical record
recreated in the same block still matches; there is no unique proposal-instance
number. Other activation and recovery calls act on their current pending state
at execution. Coordinate custody devices and inspect confirmed account and
pending-policy state.

Deadlines and delays use **chain time in milliseconds**, not your device clock.
An operation is valid at its exact deadline; an intent is mature at its exact
maturity time. Custody's right to cancel recovery ends at that time. A transaction
included in a later block can miss its deadline even after a successful preview.
Counter-advancing transitions invalidate other pending configuration; reload
state before each subsequent action.

## Emergency containment and guardian trust

Removing or changing a session key is delayed. An active key can keep exercising
its existing permission until it expires or the account is frozen. When immediate
containment is needed, ask the guardian to **freeze first**, confirm the Frozen
state, and **then start recovery** if custody needs replacement.

Freeze clears **all pending intents**, including recovery, verifier/hook changes,
guardian changes and module-policy calls. Freezing after proposing recovery
therefore cancels that recovery proposal. Proposing recovery alone does not
freeze an Active account.

Recovery preserves the account ID, funding address, operation nonce channels,
guardian and Frozen status. It replaces custody and detaches the old verifier
and hook without calling them. Unfreezing still requires the new custody and
configured guardian. A Frozen account must be unfrozen before new module
configuration. Once Active, custody can use default execution while new policies
follow their normal activation delays.

Choose a guardian you trust to remain available and cooperate. It can freeze
without custody, and custody cannot unfreeze alone when a guardian is configured.
The profile has no custody-only override if the guardian key is lost while
Frozen. Recovery does not remove or replace the guardian. While Active and
without pending custody recovery, custody can propose a guardian replacement
with a 24-hour delay; that pending change is also cleared by freeze.

A standard Neo threshold multisignature wallet can serve as the guardian. For
example, independently backed-up 2-of-3 keys tolerate one unavailable key while
the remaining two still authorize the guardian. This is one guardian address
with a threshold witness, separate from the account's verifier module. Custody
must still participate in unfreezing. If fewer than the threshold remain while
Frozen, there is no override; threshold recovery reduces individual-key failure
risk without creating authority after all usable backups are lost.

## If a key or backup is lost

| Situation | Available path |
| --- | --- |
| Custody key lost; guardian available | Guardian proposes recovery to a new custody wallet; complete after seven days. Freeze first if the old key may be compromised. |
| Guardian key lost; account Active and custody available | With no pending custody recovery, custody can propose a new guardian and activate it after 24 hours. |
| Guardian key lost; account Frozen | Restore the guardian wallet from its backup. Custody recovery does not bypass the guardian needed for unfreeze. |
| Session key lost or compromised; custody available | Review a delayed replacement/removal. Use guardian freeze for immediate containment if necessary. |
| Descriptor lost; wallet keys available | Recover the known network/account ID from your records and verify on-chain state. Wallet backups and a descriptor serve different purposes. |
| Custody key lost; no usable guardian | There is no key-recovery shortcut in this profile. A configured verifier may still allow its own operations, but does not replace custody for administration. |

## Fees, results and uncertain submissions

Review the exact target, arguments, deadline, authorities and system/network/total
fee limits before signing. The native account itself cannot be the fee payer.
An external payer signs the complete transaction and pays its fees.
Workspace consumption and minimum-budget previews are not a final transaction
quote; review the final network fee and total with the wallet or SDK.

A transaction committed with Application FAULT can still charge the payer;
rolling back application changes does not refund transaction fees. Boolean
`false` from a target is a business result, not itself a VM fault. Applicable
modules may reject it; the SDK refuses a `transfer` result other than Boolean
`true`. Check the actual receipt and resulting balances, nonces and policies.

A returned transaction ID means submission, not confirmation. If a request times
out, query **that same transaction ID** and inspect the wallet's submission before
preparing a replacement. Do not automatically sign another transaction or raise
fees. A successful preview reserves neither a nonce nor a place in a block.
