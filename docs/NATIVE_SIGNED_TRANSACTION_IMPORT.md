# Signed native transaction import

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
