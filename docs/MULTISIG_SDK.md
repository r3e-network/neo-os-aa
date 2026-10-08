# MultiSig SDK and frontend session

`createMultiSigClient` in the JS SDK and `createMultiSigDraftSession` in the frontend use the same `shared/multiSigCore.mjs`. They construct the `StdLib.Serialize(object[])` proof expected by `MultiSigVerifier`. This is an explicit session API; generic collaborator records and roster counts are never inferred to be verifier children.

1. `fetchContext({ coreContractHash, accountIdHash })` reads the RPC network magic, account's bound root verifier, its authorized core and ordered `getConfig` result. It pins account, core, network, root, child order and threshold into `configDigest`.
2. `prepareOperation({ context, operation })` fixes the channel nonce, deadline and core-computed argument hash. Share this exact operation context with each child signer. The deadline is milliseconds and is explicitly chosen by the caller.
3. `buildChildTypedData({ context, operation, childVerifierHash })` creates an EVM signature domain for that child, **not the MultiSig root**. `fetchChildPayload({ context, operation, childVerifierHash })` reads the individual child's `getPayload` for SessionKey/WebAuthn-style adapters and returns those exact bytes plus their child/operation context; adapters that bind their cryptographic payload to the child identity reject reuse in another child domain. This is not a universal property of opaque proof bytes or native-witness children, which may use empty proof bytes and derive authorization from transaction witnesses.
4. Collect explicit `{ childVerifierHash, kind, operation, signatureHex }` proofs. EVM proofs additionally carry `typedData`, `signatureFullHex` and optional `signerAddress`. Opaque proofs use an adapter for that child's real signing format; operation metadata alone is not proof of validity.
5. `validateBundle` rereads the network, root/config, nonce and argument hash, rejects drift, constructs exact ordered slots and simulates `validateSignature` against the bound root. It rereads the config after simulation. A rejected or faulting verifier fails closed.

```js
const { createMultiSigClient } = require('neo-abstract-account');
const multisig = createMultiSigClient({ rpcUrl });
const context = await multisig.fetchContext({ coreContractHash, accountIdHash });
const operation = await multisig.prepareOperation({
  context,
  operation: { targetContract, method: 'symbol', args: [], deadline: String(Date.now() + 600_000) },
});
// Each childSigns() adapter receives the same operation and its own verifier identity.
const childProofs = await collectChildProofs(context, operation);
const bundle = await multisig.validateBundle({ context, operation, childProofs });
// bundle.invocation is the complete executeUserOp payload for the normal transaction path.
// Review/simulate that full transaction, including its fee payer and any required proxy witness.
```

`buildBundle` is the offline structural builder; its result has `chainValidated: false`. `validateBundle` sets that field to true only for a successful signature simulation at the read state. Neither value is transaction finality or a reservation of nonce/configuration. Full execution preview and normal chain authorization remain required. Signer witnesses can be passed to `createMultiSigClient`/`createMultiSigDraftSession` for children that require transaction witnesses; the final transaction must carry the same required authorization.

The serializer is bounded to 10 slots and 65,535 total bytes. Missing children use null slots at their original indices, only after enough explicit proofs are supplied to meet the threshold. Empty hex is a ByteString and is different from null. Repeated/unknown children, changed operation fields, insufficient proofs, parent-domain EVM signatures and altered configuration pins are rejected.

Public V3 thresholds count verifier modules, not independent keys or people. Different modules can share credentials or controllers; a successful quorum simulation does not establish signer independence. The native composition profile defines its own signer-domain rules and must be discovered separately.

## Configuring child credentials

For cores exposing the new `callVerifierChild` API, `buildChildConfiguration` creates an invocation for the owner-controlled, timelocked child configuration path. It accepts only `setPublicKey(accountId, publicKey)` or `setConfig(accountId, signers, threshold)` and only direct configured children. The first call stages the exact intent and returns false; submit identical calldata after the 24-hour delay to apply it. Successful Void child configuration may return null. Changed root, child, child order, threshold or arguments restarts the delay.

`readPendingConfiguration({ context })` reads the shared verifier pending slot (`moduleHash`, `callHash`, `initiatedAt`). The slot is shared with root verifier configuration; a pending record alone does not prove it corresponds to a particular child request. Compare against the exact intended invocation and authoritative core state before owner confirmation. See [child configuration](MULTISIG_CHILD_CONFIGURATION.md) for the contract boundary. Older deployed cores do not gain this API from an SDK update.

## Evidence and boundary

`MultiSigSdkVectorTests.cs` runs the actual JS serializer, compares its bytes with VM `StdLib.Serialize`, rejects shifted and duplicated child proofs, exercises threshold-preserving null slots and executes a real core UserOperation with two independently configured SessionKey children. Child payloads are domain-separated. This proves the serialization/aggregation path for that runtime and child combination; it does not establish public deployment or every possible verifier adapter.

SDK unit tests cover chain config/order/threshold/network/nonce/argument drift, typed-data child domains, bad pins, duplicate children and configuration payload scope. Frontend tests verify RPC Array and base64 ByteArray wire encoding. No new generic “multisig complete” UI badge is introduced.
