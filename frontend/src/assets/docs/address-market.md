# SA Address Market

The SA address market is a trustless GAS escrow surface for transferring deterministic Neo Smart
Account addresses.

## What A Listing Includes

- SA core contract hash
- accountId hash
- derived proxy address
- seller custody address
- price in GAS
- title
- optional metadata URL

When a listing is created, the account is immediately locked into market escrow on-chain: normal
execution and module maintenance are blocked until the listing is cancelled or settled. The escrow
lock is a core read (`isMarketEscrowActive`), so the block is enforced by the account itself, not by
the market's goodwill.

The listing card also shows what a buyer is actually buying, read from the account record: the account
status, the current custody address, the recovery authority, and whether the escrow lock is active.

## What A Purchase Means

Buying is not just a commercial reservation.

The buyer completes one atomic chain flow:

1. transfer the exact GAS to the market contract
2. settle the listing in the same transaction
3. set custody to the buyer's new custody address
4. clear the recovery authority so the seller keeps no recovery path
5. sweep every installed module and policy callback-free, so old permissions stop applying
6. advance the authority epoch and the configuration nonce, void old signatures and pending intents,
   reset the default authorizations and re-initialize the message subjects against the buyer
7. release the seller's proceeds only if the control transfer succeeded

If settlement fails, the entire transaction fails.

Settlement calls no module: the sweep is callback-free by design, so a hostile module cannot block a
sale or leave a hook behind.

## Seller Checklist

Before listing:

1. confirm you are the current custody address of the account
2. review the installed validators, the hook set and its order, because they stay frozen during escrow
3. document any policy assumption a buyer should know in the metadata URL
4. understand that listing creation blocks normal execution until the listing is cancelled or settled

## Buyer Checklist

Before buying:

1. inspect the account record read from chain: status, custody, recovery authority, escrow lock
2. decide your new custody address before submitting the buy transaction
3. expect every previous module and policy to be swept during settlement
4. configure fresh validators and hooks in the app workspace after settlement

## Operational Notes

- The market contract escrows GAS and control transfer only.
- It does not guarantee off-chain promises made in a metadata URL.
- The market transfers the account shell and the ownership anchor, nothing else.
- Modules are cleared during settlement, so the buyer receives a clean shell rather than a policy stack.
- A third-party module contract may keep its own storage, but it is no longer installed on the account,
  and the new epoch makes anything it signed or expected unusable.
