# Ordinary contract account workspace

`/app` uses the deployed V3 ordinary contract account and is the main NeoOS
application path. `/native` uses the independent native protocol and node
capability; account identity, deployment address and signing context must not be
mixed between them.

## Creation

After connecting a Neo N3 wallet, enter the account's verifier, initialization
parameters, optional hook and a 7–90 day recovery delay. The backup owner must be
an address, or its Neo script hash, that can supply a Neo transaction witness; it
is not an Ethereum address. The current registration screen requests a signature
only from the connected Neo wallet, and that wallet is both the registration
authority and the fee payer, so the backup owner must match it. To use a different
backup address, connect the corresponding wallet.

Keep the account ID and the derived receiving address. The account ID reads and
manages the account; the derived address receives funds. Wait for on-chain
confirmation after submitting; a wallet-returned transaction ID does not mean the
account is registered.

## Replacing a verifier or hook

Enter the account ID on the governance page and read chain state. Installing into
an empty slot takes effect directly; replacing an installed plugin first stages a
pending change that the backup owner confirms after the 24-hour delay. It can be
cancelled while pending. The page shows the current plugin, the pending plugin,
the verifier parameters, the initiation time and the maturity time.

Maturity is judged by the selected node's block time. Refresh after the time
passes; the local clock does not prove maturity. Read the account, authorities and
pending record again before submitting, and re-review if anything changed. Another
device can still alter pending state between wallet confirmation and inclusion;
the ordinary contract's existing confirm/cancel ABI does not preserve the reviewed
state.

A complete review requires the deployment to expose the `getPendingVerifierUpdate`
and `getPendingHookUpdate` read methods. When an older deployment exposes only
existence and maturity, the page states that the target and parameters cannot be
read and disables blind confirmation; read-only inspection and explicit
role-scoped cancellation of the pending change remain available. Nothing can be
confirmed or cancelled when no pending item exists.

## Backup recovery

Only the current backup owner can start and complete recovery. After initiating,
wait for the account's configured timelock and complete it explicitly from that
address; maturity does not replace the verifier automatically. Completion can
restore backup-owner authorization directly, or name a new verifier together with
the initialization parameters it requires. The new verifier address and its
parameters must be reviewed as a pair.

A successful recovery removes the old hook, clears the account configuration of
the old verifier and hook, and deletes pending plugin replacements, pending plugin
calls and the on-chain metadata URI; it does not move the balance to another
address. The old plugins must successfully execute `clearAccount`, so a destroyed
plugin or one that refuses cleanup can block recovery. A cleanup failure fails the
transaction and rolls state back; the UI must not report success or moved assets,
and an included failed transaction can still charge fees.

Recovery availability depends on a usable Neo witness for the backup owner. Losing
the only backup key leaves no substitute for this path. Keep an independent backup
and confirm the address and recovery arrangement before funding the account.

## Account metadata

Saving metadata requires the current backup owner. The page re-verifies the
account and owner before requesting the wallet, and pins this attempt's account,
network, core contract and metadata content. Off-chain description and icon
updates are written only after the on-chain `setMetadataUri` confirms; a failure or
unconfirmed transaction writes no off-chain mirror.

Switching account, wallet, network or identity, or editing the form while waiting
for a signature or confirmation, stops the off-chain synchronization. A confirmed
on-chain change is not rolled back; reload the original account to verify the
result. Off-chain synchronization still needs valid proof of account control and
reports its own failure separately. Metadata saving and governance actions cannot
request the wallet at the same time.

## Validation boundary

This round of interface validation uses local node fixtures and mocked wallet
requests; it creates no user keys, signs no real transaction and submits nothing
to a public chain. Tests must cover a wrong or different backup address,
confirmation before maturity, older deployments without the complete read
methods, a changed pending record, account or wallet switching, new verifier
parameters, on-chain failure and an unconfirmed timeout.
