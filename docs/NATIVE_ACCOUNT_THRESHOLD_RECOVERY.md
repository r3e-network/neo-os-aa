# Threshold wallet authorities

A standard Neo P-256 m-of-n wallet can be the account's custody address, its recovery authority or
its fee payer. It is a transaction-witness account, not a threshold policy over modules and not
another native account proxy. It does not change account identity, the recovery timelock or the
module model. Public activation remains a separate protocol decision.

The account's recovery authority is set by a `setRecoveryPolicy` action inside a configuration intent,
so it matures for 24 hours like every other intent. `beginRecovery(accountId, newCustody)` then needs
the custody address **or** the configured recovery authority, and additionally the new custody
address's witness. `cancelRecovery(accountId)` accepts either of the two. `freezeAccount` is
custody-only, and — unlike the v3 guardian model — `unfreezeAccount` is custody-only as well:
authorising a recovery authority grants recovery power, not unfreeze power.

## Signer contract

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

const action = { method: 'unfreezeAccount', accountId };
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
to witness scope `None`, and scopes every `authorizers` entry to exactly the core hash, because the
core recognizes an authority with `Runtime.CheckWitness`. Present the fixed transaction, threshold,
complete public-key roster, account role, scopes and fees to each participant before signing.

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

## Availability and recovery boundaries

For a 2-of-3 recovery authority, losing one member key still leaves a working quorum. `beginRecovery`
carries a 7..90 day timelock chosen at creation, and `executeRecovery` is permissionless once that
timelock matures and the authority epoch is unchanged. Execution is callback-free: it deletes every
module-model row, clears the recovery authority, restores `Active`, and re-enables default operation
and message authorization. The new custody therefore starts without any installed module and must
install its validators again through configuration intents.

If custody is lost and fewer than m recovery members remain usable, there is no cryptographic
shortcut: changing the threshold or roster produces a different wallet script hash and does not
change the configured recovery authority. While Active with no pending recovery, custody can propose
a recovery-authority replacement, which matures for 24 hours.

Keep the threshold, complete public-key roster and exact verification script with public account
records, and keep participant wallet backups independently. Different public keys do not prove
different people or independent backups. Any available quorum can exercise recovery, so a threshold
distributes that power as well as improving key-loss tolerance. Because the recovery authority does
not gate unfreeze, custody should not be a single key you cannot replace.

## Validation and rollout

SDK tests cover all 2-of-3 quorums, response order, invalid surplus signatures, malformed or oversized
scripts, fee placeholders, and authority/custody/payer roles. Core tests use public fixture keys and
actual transaction Verification before freeze, recovery and unfreeze. They do not exercise registered
native-account cross-proxy authority. Runtime support must be demonstrated with the chosen wallet
integration before relying on a threshold authority; an ordinary wallet `invoke` alone does not prove
multisig coordination capability.
