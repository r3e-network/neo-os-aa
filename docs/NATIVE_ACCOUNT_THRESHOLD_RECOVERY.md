# Threshold wallet authorities

A standard Neo P-256 m-of-n wallet can be the account's guardian, custody or fee
payer. This is a transaction-witness account, not a `MultiSigVerifier` module or
another native account proxy. It does not change account identity, recovery
delays, or the custody-plus-guardian unfreeze rule. Public activation remains a
separate protocol decision.

## Signer contract

Supply the standard wallet script hash as `account` and its exact canonical
`verificationScript`. Single-signature adapters keep returning a 64-byte P1363
signature string. A multisig adapter returns an array of
`{ publicKey, signature }` entries from `sign(signDataHex)`. Public keys are
compressed P-256 points and signatures cover the exact supplied network-bound
transaction sign data with P-256/SHA-256 once. The SDK stores no private keys.

```js
const guardian = {
  account: guardianScriptHash,
  verificationScript: guardianVerificationScript,
  async sign(signDataHex) {
    return Promise.all(availableMembers.map(async member => ({
      publicKey: member.publicKey,
      signature: await member.sign(signDataHex),
    })));
  },
};
const plan = await client.buildAction({ accountId, action: 'unfreeze' });
const prepared = await client.prepareTransaction(plan, {
  feePayer: payer, authoritySigners: [custody, guardian], ...feeLimits,
});
const signed = await client.signTransaction(prepared);
await client.broadcastTransaction(signed);
```

Before signing, present the fixed transaction, threshold, complete public-key
roster, account role, scopes and fees to each participant. A guardian is one
transaction signer with one witness containing m signatures. Listing its member
wallet hashes as separate signers does not satisfy the guardian witness.

Only canonical standard CHECKSIG and CHECKMULTISIG scripts are accepted. Every
point must be valid; multisig members must be unique and ordered as Neo orders
EC points (X, then Y). The script hash must match the signer. All submitted
signatures are checked, including signatures beyond the threshold. Duplicate,
unknown or invalid entries reject the response; none are silently discarded.
After validation, the first m available members in script order form the witness,
independent of callback completion or response-array order.

Both invocation and verification scripts must fit Neo's existing 1,024-byte
witness limits. Standard 66-byte signature pushes limit m to 15; canonical
35-byte public-key pushes and script framing limit n to 29. Larger scripts are
rejected rather than expanding protocol limits. Network-fee estimation uses m
signature placeholders and the full verification script, then checks the final
witness fee. These limits do not promise a transaction fits every other fee,
size or verification-gas bound; signed preflight still must succeed.

The portable signed-transaction import path must use the same script, signature,
ordering and size validation. JSON is not permission to sign or broadcast.
Browser validation uses P-256 WebCrypto and the same public script parser; no
private key or signing capability is required to inspect a signed artifact.

## Availability and recovery boundaries

For a 2-of-3 guardian, losing one member key still leaves a working quorum.
Frozen-account unfreeze needs that quorum **and** custody. If custody was lost,
the quorum may use the existing seven-day recovery procedure; after recovery,
the new custody and guardian quorum must still cooperate to unfreeze.

If fewer than m guardian keys remain usable, a Frozen account has no
custody-only escape. Restoring enough existing backups can restore the quorum;
changing the threshold or roster produces a different wallet script hash and
does not alter the configured guardian. While Active with no pending custody
recovery, custody can use the existing delayed guardian replacement procedure.
Loss of all necessary authorization has no cryptographic recovery shortcut.

Keep the threshold, complete public-key roster and exact verification script
with public account records, and keep participant wallet backups independently.
Different public keys do not prove different people or independent backups.
Any available quorum can exercise guardian freeze and recovery powers, so
thresholds distribute those powers as well as improving key-loss tolerance.

## Validation and rollout

SDK tests cover all 2-of-3 quorums, response order, invalid surplus signatures,
malformed or oversized scripts, fee placeholders, and guardian/custody/payer
roles. Core tests use public fixture keys and actual transaction Verification
before freeze, recovery and joint unfreeze. They do not exercise registered
native-account cross-proxy authority. Runtime support must be demonstrated with
the chosen wallet integration before relying on a threshold guardian; ordinary
wallet `invoke` alone does not prove multisig coordination capability.
