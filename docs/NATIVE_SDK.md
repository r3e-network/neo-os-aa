# Native SmartAccount SDK (v4)

`NativeSmartAccountClient` targets the consensus-native kernel; `SmartAccountClient` targets a
custom-deployed kernel. Both speak the v4 protocol: one 13-field operation, one identity derivation,
one module/intent model and the same `SA_*` error vocabulary. A custom-kernel account does not become
a native account by changing a core hash: the kernels differ in delivery — proxy script, call flags,
the native contract's negative id — not in the operation they accept.

`shared/nativeSmartAccountClient.mjs` is the implementation; `sdk/js/src/native.js` binds it to the
native contract hash and to the Node transaction tools. The frontend mirror is byte-identical.

## Discovery and activation

`discover()` is the ABI gate, and it reads the chain rather than a pinned parameter digest:

1. `getversion` must report the expected network magic, and `getcontractstate` must report the
   expected hash, the native contract id sign, and the manifest name `SmartAccount`.
2. Every entry of `NATIVE_REQUIRED_ABI` must exist exactly once with its pinned parameter types,
   return type and `safe` flag; every event of `NATIVE_REQUIRED_EVENTS` must exist.
3. `getProtocolInfo()` must answer protocol version `4`.
4. `getAccountImplementationId()` must answer the implementation id this client was reviewed
   against (`NativeSmartAccount/v4` for the native core).

It returns a frozen profile `{contract, networkMagic, protocolVersion, implementationId}`.
The native kernel is callable only once the node activates `HF_SmartAccountV1`; private tests do not
establish public activation.

```js
const { NativeSmartAccountClient, nativeCodec: c } = require('smart-account');

const client = new NativeSmartAccountClient({ rpcUrl, networkMagic });
const profile = await client.discover();
```

## Typed bytes and identity

Hash160 inputs are display-order hex; `nativeCodec.hashValue(hash)` converts them to wire-order
ByteString. ByteString values are always hex, never implicit base64; use `c.stringValue(text)` for
UTF-8. Large integers use decimal strings or BigInt. Exact Array/Struct types are preserved; Map,
Buffer, cycles and profile-bound violations are rejected. Reads use `invokescript`, so a Struct value
survives the RPC.

Identity is derived, not registered: `accountId = hash160('aa524704' || custody || salt)` with a salt
of 1..128 bytes. The proxy address follows from the account id, the kernel hash and the kernel's call
flags, so the pair `(custody, salt)` re-derives the account on either kernel.

```js
const identity = client.deriveIdentity({ custodyAddress: custodyWallet.account, salt });
```

## Creation

`createAccount(Hash160 accountId, Hash160 custody, ByteArray salt, Integer recoveryTimelockMs, Array
actions)` commits to the identity once. The custody address must witness the transaction; the core
re-derives the id from `(custody, salt)` and faults on a mismatch. A timelock of `0` selects the 7-day
minimum; the accepted range is 7..90 days in milliseconds.

The `actions` array is the atomic exception to the 24-hour intent delay: the core executes it inside
creation, so an account can start with its first validator installed. When any action is applied, the
account must end with at least one validator module unless default operation authorization is on.

```js
const create = {
  custodyAddress: custodyWallet.account,
  salt: randomBytesHex,
  recoveryTimelockMs: 30 * 86_400_000,
};
const plan = client.buildCreateAccountScript(create);
const limits = {maxSystemFee:'1000000000', maxNetworkFee:'300000000', maxTotalFee:'1300000000'};
const tx = await client.prepareTransaction(plan, {
  feePayer: payerWallet,
  recipe: { method: 'buildCreateAccountScript', input: create },
  ...limits,
});
const signed = await client.signTransaction(tx);
await client.preflightTransaction(signed);
await client.broadcastTransaction(signed);
```

`prepareTransaction` rebuilds the plan from the review `recipe` and refuses a plan whose bytes the
rebuild does not reproduce, so an archived review stays checkable. It resolves the fee payer to scope
`None` and every `authorizers` entry to a witness scoped to exactly the core hash. The account proxy
cannot be the fee payer, and it cannot also be listed as an authorizer. Fee caps are mandatory. A
wallet explicitly selected in several roles is encoded once with only its derived scopes; standard
wallet multisignatures count public keys inside one wallet witness and are distinct from a threshold
policy over modules.

Wait for a confirmed receipt and read `getAccount` against the independently derived identity. Persist
the salt: recovery does not replace the identity. Submission returns `{submitted:true,confirmed:false}`;
`getTransactionReceipt(signed)` verifies the persisted raw bytes and returns Application results. An
unknown or pending transaction can produce an RPC error — poll the same txid with bounded retries and
never silently sign a replacement.

## Account state

`getAccount(accountId)` returns `null` for an absent account, otherwise the control record: existence,
status (`Active`/`Frozen`/`MigrationRequired`), custody, recovery authority, authority epoch,
configuration nonce, recovery timelock, default operation and message authorization, owner-only
recovery, hook-order revision, control revision, the pending recovery with its maturity, the market
escrow marker and the legacy row marker. The descriptor refuses an authority epoch above the
configuration nonce, and refuses a custody or recovery identity that is the proxy, the core, or zero
where zero is not allowed.

## Execution

`buildExecutionScript({accountId, operations})` emits `executeUserOp(accountId, op)` for one operation
and `executeUserOps(accountId, ops)` for a batch. An operation is the 13-field v4 array: version,
target, method, args, nonce, nonce subkey, deadline, validator id, credential generation, authority
epoch, configuration nonce, signature and hook proofs.

`deriveNonceRouting(accountId, routing)` and `getNonce(accountId, lookup)` read the routing the
operation must carry; `getNonceSequence` reads a channel cursor. `getOperationDigest` and
`validateUserOp` read the digest and the core's verdict before anything is signed. The core has no
message entry: a message signature is checked against the account's default message authorization by
the signing module, which is the contract that owns the subject records.

`getNonce` takes `{validatorId, nonceSubkey}` and optionally the pair `{credentialGeneration,
authorityEpoch}`. With the pair supplied the read is a cross-check: the channel the core returned must
equal the one this client derives, otherwise the call fails before anything is signed. With neither
supplied only the channel the contract returned is used, because the core resolves the generation
itself (see *Credential generations*). `resolveCredentialGeneration` answers that value for an installed
validator; the built-in route's is not published by the ABI, and it reports that rather than guessing.

```js
const plan = client.buildExecutionScript({ accountId: state.accountId, operations: [operation] });
```

The proxy witness is synthesized by the SDK: its scope is `CustomContracts` restricted to the
operation target, and its witness is an empty invocation plus the canonical verification script.
Custody and recovery witnesses are recognized by `Runtime.CheckWitness` inside the core, so they are
scoped to exactly the core hash. Payer-only payment never grants account authority.

`validateNativeInvocationResult` checks execution evidence before signing and again on the exact
signed transaction. A single operation must return exactly one well-formed serializable VM item; a
batch must return one exact Array with one result per operation. A method named `transfer` must return
strictly Boolean `true`; absent, truncated, mistyped, false or non-Boolean transfer results cannot
authorize submission. Other target methods keep their native return semantics, including Boolean
`false` and Null. Lifecycle calls may legitimately return an empty stack, but a missing or malformed
stack is rejected. Faulted simulations stay available for diagnosis and never supply a fee approval.

## Credential generations

Three different generations reach the §4.3 domain and the §6 channel, and they are never
interchangeable:

| Route | Generation the core binds | Where it lives |
| --- | --- | --- |
| built-in validator (`validatorId` 0) | the account's `SubjectRevision` | 0x57 subject record |
| installed validator | that instance's `CredentialGeneration` | 0x52 instance record, published by `getModule` |
| active threshold policy | the policy's `CredentialGeneration` | 0x5B policy record |

The core resolves the generation internally on every operation and on every `getNonce` read, so the
channel an accepted operation lands on is the one the core derived, never a client-side guess. An
operation that carries a generation the account has left behind fails with `SA_CREDENTIAL_STALE`, and a
reshaped threshold policy kills the channels of its previous generation the same way.

There is no default anywhere in the client stack. An offline builder has no RPC and `getAccount` does
not carry the revision, so `UserOperationBuilder` refuses to build without an explicit
`credentialGeneration` (`SDK_011`) and the frontend operation factory raises
`EC_credential_generation_required`; neither substitutes 1 for the built-in route nor 2 for anything
else. A reviewed fixture may state a generation explicitly, which is a declaration about that fixture
and not a fallback. The digest and the channel both bind the value, so a stale generation does not
silently move to the next channel: it is a refusal.

## Modules

Registration may carry installs atomically: the core executes at most 16 actions at registration, and
the only actions it still runs are `installModule` and `uninstallModule`. Everything afterwards goes
through two public methods.

`installModule(accountId, moduleType, moduleContractHash, initData)` and
`removeModule(accountId, moduleId, deInitData)` take the v4 install code — validator (1) or hook (4) —
and no profile digest, because the core reads the module's own profile; a registration action carries
one and the shared core compares it. Either call accepts the custody witness or the witness of an
already installed validator instance (the governance shape a user-space governance module uses to
administer itself), and either advances the configuration nonce.

```js
const install = client.buildAccountActionScript({
  method: 'installModule',
  accountId: state.accountId,
  args: [moduleTypeCode, moduleContractHash, initData],
});
```

The core keeps no configuration intent: a change that matures for 24 hours and is then confirmed or
cancelled belongs to a governance module, which submits the matured call through those two methods. A
client that expects a proposal window is targeting a different contract. `getAccount` still publishes
`configurationNonce` and `hookOrderRevision` so a reader can order changes, and it keeps the recovery
slots in the descriptor for ABI stability, reporting their inactive value.

`getModules(accountId, 'validator'|'hook', {cursor, limit})` pages installed instances;
`getModule(accountId, moduleId)` reads one descriptor (type, contract hash and id, update counter,
NEF and profile digests, module revision, credential generation, instance isolation, message
capability, threshold eligibility). `isModuleInstalled` answers the admission question without paging
and `getAuthorizedModuleId` reports the instance the core routed a phase to. A module can only read
its own state — lifecycle callbacks belong to the core.

Hook ordering is derived from the installed hook instances and the `hookOrderRevision` the descriptor
publishes; the orchestrator that calls them is a module, so the core has no order to read and none to
change. Credential generations are advanced by removing and reinstalling an instance, which is the
custody-authorized `removeModule`/`installModule` pair — there is no separate revoke entry on the
core.

## Account actions

`freezeAccount(accountId)` and `unfreezeAccount(accountId)` are the two immediate transitions the core
owns, both built with `buildAccountActionScript` and both custody-only. Freezing advances the
authority epoch, so every signature produced before it stops validating; unfreezing is refused unless
the account is frozen. Both are refused while the account awaits migration.

Recovery is a module. `beginRecovery`, `cancelRecovery`, `executeRecovery` and `getRecoveryStatus`
are the recovery module's own methods: the handover delay and its maturity live in that module's
storage, so the core neither plans nor validates them, and the SDK does not derive a recovery
authority set from a core plan. A client that needs recovery targets the recovery module's script
hash.

Freeze advances the configuration nonce and clears the core's recovery slots. Both transitions
invalidate old signatures through the authority epoch, and the SDK re-reads state, digest and nonce
before signing and before broadcast.


## Fees and final preflight

Fees from RPC must be canonical nonnegative Int64 decimal strings; malformed values and a
`minimumrequiredfee` below `gasconsumed` are rejected before signing. Final signed preflight requires
both fields and applies the same checks. `calculatenetworkfee` accounts for the complete witness shape
and is repeated on the final signed witnesses.

`preflightTransaction` calls `invoketransaction(base64RawTx)` and requires a matching hash and network,
the snapshot identity, Verification Succeed, Application HALT, `relayed:false`,
`mempoolChecked:false`, and a minimum admission fee within the signed SystemFee. It also requires the
RPC's `simulation` declaration: `mode:'single-transaction-next-block'`,
`height:snapshot.height+1`, a canonical UInt64 decimal-string `timestamp`, UInt8 `primaryIndex`,
`view:0`, `transactionCount:1`, `onPersist:'HALT'` and a canonical UInt160 `nextConsensus`. That
confirms native fee processing ran before Application in a disposable single-transaction next-block
context; it does not predict other transactions, the next primary or timestamp, or mempool
acceptance. Broadcast repeats preflight on identical signed bytes.

A committed FAULT still charges the fee payer. Once `sendrawtransaction` was attempted, its outcome is
retained; errors carry the txid and `submissionAttempted`, so resolve a timeout by querying that txid.
Do not increase fees or re-sign after a refusal on your own initiative.

## Chain time

Deadlines and delays use chain milliseconds, not the client clock. Standard witness Verification reads
the snapshot's persisted block time; Application reads the executing block time. Equality at the
deadline is valid, but the next block may already be too late. Final preflight uses its declared
hypothetical timestamp, so check the persisted result even after a successful replay. Configuration
and recovery maturity are inclusive.

## Artifacts and browser boundary

`client.exportSignedTransaction(signed)` produces a versioned public artifact with the exact signed
bytes, transaction fields, profile and witnesses. A browser can import it for the same reviewed plan,
validate wallet signatures and fee ceilings, run complete signed preflight, and explicitly send those
bytes. Import does not grant the workspace access to signing keys.

The default RPC transport preserves a JSON-RPC error's numeric `code` and structured `data`; signed
preflight errors retain the original `cause`, and broadcast adds the immutable `txid`.

## Evidence and boundaries

Native tests cover v4 byte vectors, epochs and counter maxima, exact envelopes, strict types, hostile
RPC responses, nonce routing and batches, fee caps, real P-256 transaction signatures and preflight
rejection. `npm run test:package` installs a real tarball outside the repo and checks CJS/ESM/types.

The reproducible v4 runbook is `sdk/js/tests/testnet-v4-harness.js` and the operator scripts beside
it. The harness loads `contracts/bin/public` (including `validators/` and `hooks/`), deploys the core
and the modules it installs, and drives the 13-field operation, the `proposeConfiguration` /
`confirmConfiguration` intent plans, threshold policies and recovery through the SDK. These scripts
are runbooks, not gates: `npm test` does not run them and they are not run in the migration phase.
`native-runtime-verifiers.py` and `native-runtime-driver.mjs` are retired v3 evidence and exit
non-zero instead of half-driving a chain. A PASS applies only to the pinned source, runtime and
artifacts named in its receipt. Real activated-node execution on a public network is an independent
gate; inspect the current runtime receipt before claiming it passed.

Protocol requirements and remaining activation gates are mapped in the
[issue 242 conformance review](proposals/SMARTACCOUNT-ISSUE-242-CONFORMANCE.md).
