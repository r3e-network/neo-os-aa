# Native AccountManagement SDK (ABI 2)

`NativeSmartAccountClient` targets the consensus-native service. `AbstractAccountClient` remains the independent public deployed-contract V3 client. Changing its core hash does not convert V3 registration, EIP-712 signatures, identity or transaction format into the native protocol.

Discovery requires the exact ABI 2 manifest/profile digest, native id/hash/name, explicit expected network magic, and callable `getVersion() == 2`. The node must activate `HF_SmartAccountV1`. Private tests do not establish public activation.

## Typed bytes and authority

Account identity, asset address, custody, recovery authority, and fee payer are distinct. Identity derivation remains version 1. ABI 2 adds authorityEpoch at index 13 of its exact fourteen-field account record. The signing domain binds authorization version 2, network, service, account, authorityEpoch and configurationNonce. Canonical execution also requires all four arguments `(accountId, opOrBatch, expectedAuthorityEpoch, expectedConfigurationNonce)`. This transaction-level commitment protects native witness-only authorization after custody or configuration changes. The old two-argument envelope is rejected, with no zero-counter default. Recovery advances both counters and revokes installed modules while preserving identity/assets/nonce channels/Frozen status.

Hash160 inputs are display-order hex; `nativeCodec.hashValue(hash)` converts them to wire-order ByteString. ByteString.value is always hex, never implicit base64. Use `stringValue(text)` for strict UTF-8. Large integers use decimal strings or BigInt. Exact Array/Struct types are preserved; Map, Buffer, cycles/shared compounds and profile-bound violations are rejected. Reads use canonical `invokescript` to avoid RPC conversions that lose Struct values.

## Registration and custody execution

Provide wallet adapters `{account, verificationScript, sign(signDataHex)}` for standard Neo P-256 single-signature accounts. `sign` signs the exact supplied bytes using P-256/SHA-256 once and returns 64-byte IEEE P1363 r||s hex. Do not apply a message prefix or hash an already hashed digest again. The SDK stores no private keys.

```js
const { NativeSmartAccountClient, nativeCodec: c } = require('neo-abstract-account');
const client = new NativeSmartAccountClient({rpcUrl, networkMagic});
await client.discover();
const registration = client.buildRegistration({
  custodyAddress: custodyWallet.account,
  salt: random32BytesHex,
  recoveryAddress: recoveryWallet.account,
});
const limits = {maxSystemFee:'1000000000', maxNetworkFee:'300000000', maxTotalFee:'1300000000'};
const tx = await client.prepareTransaction(registration, {
  feePayer: payerWallet, authoritySigners:[custodyWallet], ...limits,
});
const signed = await client.signTransaction(tx);
await client.preflightTransaction(signed);
await client.broadcastTransaction(signed);
```

Wait for a confirmed receipt and verify AccountCreated/getAccount against the independently derived identity. Fund `registration.accountAddress`, the asset principal. Persist the salt; recovery does not replace the account identity. Submission returns `{submitted:true,confirmed:false}`. `getTransactionReceipt(signed)` verifies persisted raw bytes and returns Application results. An unknown/pending transaction can produce an RPC error; poll the same txid with bounded retries, never silently sign a replacement after timeout.

```js
const state = await client.getAccount(registration.accountId);
const prepared = await client.prepareOperation({
  accountId:state.accountId, targetContract:gasTokenHash, method:'transfer',
  args:[c.hashValue(state.accountAddress), c.hashValue(recipientHash),
        {type:'Integer',value:'100000000'}, {type:'Null'}],
  channel:3n, deadline:deadlineMilliseconds,
});
// verifier=null: real custody transaction witness, empty operation signature.
const plan = client.buildExecution([prepared]);
const transferTx = await client.prepareTransaction(plan, {
  feePayer:payerWallet, authoritySigners:[custodyWallet], ...limits,
});
await client.broadcastTransaction(await client.signTransaction(transferTx));
```

The external payer is signer zero. Its scope is None unless it is also an explicitly required custody/recovery authority. Proxy scope is CustomContracts restricted to operation targets; its witness is empty invocation plus canonical verification script. Custody/recovery scopes target AccountManagement. Proxy-as-payer, conflicting wallet identities and unsupported wallet scripts are rejected. A wallet explicitly selected in several authority roles is encoded once with only those derived scopes. The current transport supports ordinary P-256 single-signature wallets, not arbitrary wallet multisignature scripts.

## Fees and final preflight

Fees are integer datoshi. `gasconsumed` is actual consumption; bounded callbacks can need a larger admission budget. Automatic SystemFee requires `minimumrequiredfee`; an older node needs an explicit SystemFee budget for preparation. This does not bypass final validation. Fee caps are mandatory. `calculatenetworkfee` accounts for complete witness shape and is repeated using final signed witnesses.

`preflightTransaction` calls `invoketransaction(base64RawTx)` and requires matching hash/network, snapshot identity, Verification Succeed, Application HALT, `relayed:false`, `mempoolChecked:false`, and minimum admission fee within the signed SystemFee. It also requires the RPC's `simulation` declaration: `mode:'single-transaction-next-block'`, `height:snapshot.height+1`, a canonical UInt64 decimal-string `timestamp`, UInt8 `primaryIndex`, `view:0`, `transactionCount:1`, `onPersist:'HALT'`, and canonical UInt160 `nextConsensus`. This confirms native fee processing ran before Application in a disposable single-transaction next-block context. It does not predict other transactions, the actual next primary or timestamp, or mempool acceptance. Broadcast repeats preflight on identical signed bytes. Unsupported RPC, a missing preparation declaration, or any mismatch refuses broadcast; the signed raw artifact remains exportable.

This checks a ledger snapshot, not nonce reservation or guaranteed mempool admission. Concurrent submissions of the same txid and raw bytes share one in-flight request. Preflight failures can be retried without re-signing. Once sendrawtransaction was attempted its outcome is retained; errors carry txid and submissionAttempted, so resolve a timeout by querying that txid. Do not automatically increase fees or re-sign after refusal. A simulated transfer returning Boolean false is rejected even if the VM HALTs. After confirmation verify actual asset/nonce/policy changes. A committed FAULT still charges the fee payer; rollback and fee effects are different.

## Module configuration and signing

`buildModuleCall({accountId,role,child?,method,args})` accepts only method-specific args; the core prepends accountId. It checks the deployed configuration capability and ABI. Module admission for both configuration and witness signing requires metadata with numeric `abiVersion: 2`, the exact service profile digest and a Boolean composition marker. Missing, old or mistyped versions are refused. The core revalidates identity/code hash/authority/delay/epoch independently.

For the declared native-v2 `MultiSigVerifier` profile and its exact `setConfig(Hash160, Array, Integer)` capability, the SDK also checks the known configuration shape before staging: 1–3 ordered, unique child hashes and an integer threshold of 1–2 that does not exceed the roster size. Zero, self and service hashes are refused. This is a convenience for the built-in schema, not an inference about arbitrary third-party `setConfig` methods. The three-domain total, disjoint child signer domains, code pins and current child policies remain core-authoritative checks. Initial staging can succeed before child configuration is ready; its simulation does not prove the future configuration can be applied. After maturity, rebuild the complete confirmation and simulate it again before signing.

For native SessionKeyVerifier:

```js
const config = await client.buildModuleCall({
  accountId, role:'verifier', method:'setSessionKey',
  args:[{type:'ByteString',value:compressedP256PublicKeyHex}, c.hashValue(targetHash),
        c.stringValue('transfer'), {type:'Integer',value:sessionExpiryMilliseconds},
        {type:'Integer',value:spendLimitDatoshi}, c.stringValue('limited session')],
});
```

Submit with custody, inspect `getPendingModuleCall`, wait the chain's full 24-hour maturity, then rebuild and submit the identical call. Issued plans are immutable and tied to the current account snapshot. Staging false differs from a completed callback whose result is false: distinguish them by pending state and configurationNonce.

A Session signer signs `prepared.preimage` with P-256/SHA-256 once. `prepared.digest` is its independently computed, chain-matched SHA-256. Attach the signature with `attachSignature(prepared, signatureHex)` and buildExecution. A verifier-authorized operation can use an independent payer without a custody transaction signature. For NeoNativeVerifier, pass `verifierSigners:[walletAdapter]` explicitly to `prepareTransaction`. The SDK reads the core-owned verifier root and active leaf roster, reconstructs complete deployed NEF bytes and JCS manifest code hashes, checks stored pins, and reads each native witness leaf's configured signer list. CustomContracts includes only matching leaves. A MultiSigVerifier root with direct native witness children is supported; recursive or unregistered children are refused. Merely paying fees does not grant verifier authority. Payer/custody and verifier roles can deliberately share a key, but only explicit selection adds that module scope. Config/roster/code pins are rechecked before and after signing and before broadcast.

For native MultiSig, the configured child order is significant: validation selects the first `threshold` children whose submitted proofs pass. Only that selected quorum receives execution-after callbacks and consumes Session policy counters. Three submitted valid proofs in a 2-of-3 account do not mean three child policies were consumed. A caller can deliberately omit a child with a Null slot to choose another allowed quorum; an empty ByteString is a present proof for a NeoNative witness child. Use simulation and the confirmed policy-state readback when reviewing the selected quorum.

Removing an active child clears its account-specific policy and removes it from the enrolled roster. Adding that module back later requires re-enrolling and configuring it through the full delayed child-configuration flow before confirming the new MultiSig roster. A previously successful child configuration is not preserved across removal.

The application supplies the signer adapter; a generic signature record does not prove module approval. Native MultiSig adapters must use core dependency order, current config and disjoint signer domains. Do not reuse public V3 EIP-712 aggregation for native signatures.

`getModuleDependencies` reads authoritative active/cleanup rosters. Dependency setters are internal module continuations; the SDK exposes no custody-authorized helper for them.

## Nonces and recovery

`prepareOperations({accountId,operations})` allocates sequences in input order per channel; buildExecution emits the canonical batch. Channels are below 2^191, sequences below 2^64, and nonce/deadline below 2^255. Cursor 2^64 means exhausted. Thirty-two operations is a syntax limit, not a guarantee they fit the global Verification gas cap.

`buildAction` supports verifier/hook/recovery-address propose/activate/cancel, custody-recovery propose/execute/cancel, freeze/unfreeze, and module-call cancellation. Custody controls configuration; guardian controls recovery proposals/freeze; unfreeze needs both when recovery is configured. Mature recovery execution is permissionless but requires a fee payer. The configured guardian can cancel a pending recovery; custody can cancel only strictly before maturity. Final simulation rechecks the selected actor and current pending state.

Recovery/configuration invalidate old signatures through authorityEpoch/configurationNonce. The SDK rechecks state/domain/digest/nonce before signing and broadcast. Prepared operations and plans are issued by one client instance. Imported JSON must be rebuilt from chain state, not promoted to a trusted signing request.

## Browser and validation boundaries

`shared/nativeSmartAccount.mjs` is the pure Uint8Array codec with injected synchronous hex hash adapters. `shared/nativeSmartAccountClient.mjs` provides the same read/action/operation client with injected RPC. Frontend mirrors are byte-identical. Node P-256 transaction signing is separate in `sdk/js/src/native/transaction.js`.

Native tests cover independent v2 byte vectors, epochs/counter maxima, exact envelopes, strict types, hostile RPC responses, 2Dnonce/batches, fee caps, real P-256 transaction signatures and preflight rejection. `npm run test:package` installs a real tarball outside the repo and checks CJS/ESM/types. Real activated-node execution is an independent gate; inspect the current runtime receipt before claiming it passed.


RPC execution evidence is checked before transaction signing and again on the exact signed transaction. A single operation must return exactly one well-formed, serializable VM item. A batch must return one exact Array with one result per operation. A method named `transfer` must return strictly Boolean `true`; absent, truncated, mistyped, false, or non-Boolean transfer results cannot authorize submission. Other target methods keep their native return semantics, including Boolean `false` and Null. Lifecycle calls may legitimately return an empty stack, but a missing or malformed stack is rejected. Faulted simulations remain available for diagnosis and never supply an automatic fee approval.

The default RPC transport preserves a JSON-RPC error's numeric `code` and structured `data`. Signed preflight errors also retain the original `cause`; broadcast adds the immutable `txid` and `submissionAttempted`. A preflight failure can be retried with the same signed bytes after the node recovers. Once submission has been attempted, inspect that transaction's receipt to resolve uncertainty instead of silently signing or sending another transaction.

The reproducible private integration entry point is `sdk/js/tests/native-runtime-verifiers.py`. Supply `--runtime`, `--build-receipt`, `--artifacts`, `--module-receipt`, `--dotnet` and `--output`. It verifies both build receipts, creates an isolated loopback chain, and uses the actual SDK for NeoNativeVerifier, SessionKeyVerifier, two-Session 2-of-2 and ordered Session/Native 2-of-3 combinations. The matrix includes every two-child quorum, three submitted proofs with only the first two selected, maximum serialized operation args and a maximum nonce channel. Its receipt includes signed preflight, exact persisted raw bytes, scoped signer/code-pin evidence, independent balance/nonce/spending readback, and rejection of a retained signed transaction after configuration changes. Keys enter the Node bridge only on stdin; temporary wallet files use mode 0600. A PASS applies only to the pinned source/runtime/artifacts in that receipt.
