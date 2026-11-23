# SmartAccount SDK Reference

This book is the developer-facing SDK reference. It merges the former NATIVE_SDK, MULTISIG_SDK,
SA-EIP-712-SPEC, SA-PROXY-TRANSFERS and PENDING_CONFIG_UPDATE_READ_ABI topics; their content moved
here verbatim, chapter by chapter.

`NativeSmartAccountClient` targets the consensus-native kernel; `SmartAccountClient` targets a
custom-deployed kernel. Both speak the v4 protocol: one 13-field operation, one identity derivation,
one module/intent model and the same `SA_*` error vocabulary. A custom-kernel account does not become
a native account by changing a core hash: the kernels differ in delivery — proxy script, call flags,
the native contract's negative id — not in the operation they accept.

`shared/nativeSmartAccountClient.mjs` is the implementation; `sdk/js/src/native.js` binds it to the
native contract hash and to the Node transaction tools. The frontend mirror is byte-identical.

## Contents

1. [SDK usage](#sdk-usage) — discovery, identity, creation, state, execution, generations, modules, actions, fees
2. [Threshold sessions](#threshold-sessions) — threshold policy SDK, frontend session, legacy V3 child configuration
3. [EIP-712 signing](#eip-712-signing) — typed-data layout the V3 verifiers hash on-chain
4. [Proxy transfers](#proxy-transfers) — direct proxy witness construction, fee policy, sponsorship refusal
5. [Pending configuration update reads](#pending-configuration-update-reads) — config-update read surface
6. [Frontend app workspace runtime](#frontend-app-workspace-runtime) — browser runtime variables, relay behavior, deployment profiles and troubleshooting

## SDK usage

### Discovery and activation

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

### Typed bytes and identity

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

### Creation

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

### Account state

`getAccount(accountId)` returns `null` for an absent account, otherwise the control record: existence,
status (`Active`/`Frozen`/`MigrationRequired`), custody, recovery authority, authority epoch,
configuration nonce, recovery timelock, default operation and message authorization, owner-only
recovery, hook-order revision, control revision, the pending recovery with its maturity, the market
escrow marker and the legacy row marker. The descriptor refuses an authority epoch above the
configuration nonce, and refuses a custody or recovery identity that is the proxy, the core, or zero
where zero is not allowed.

### Execution

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

### Credential generations

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

### Modules

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

### Account actions

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

### Fees and final preflight

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

### Chain time

Deadlines and delays use chain milliseconds, not the client clock. Standard witness Verification reads
the snapshot's persisted block time; Application reads the executing block time. Equality at the
deadline is valid, but the next block may already be too late. Final preflight uses its declared
hypothetical timestamp, so check the persisted result even after a successful replay. Configuration
and recovery maturity are inclusive.

### Artifacts and browser boundary

`client.exportSignedTransaction(signed)` produces a versioned public artifact with the exact signed
bytes, transaction fields, profile and witnesses. A browser can import it for the same reviewed plan,
validate wallet signatures and fee ceilings, run complete signed preflight, and explicitly send those
bytes. Import does not grant the workspace access to signing keys.

The default RPC transport preserves a JSON-RPC error's numeric `code` and structured `data`; signed
preflight errors retain the original `cause`, and broadcast adds the immutable `txid`.

### Evidence and boundaries

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

## Threshold sessions

v4 has no MultiSig root and no verifier children. A threshold is a policy over installed validator
modules: members are module ids of one account, each member owns its credential generation, and the
operation carries one assembled signature field. `shared/multiSigCore.mjs` is the single
implementation; the JS SDK (`createThresholdClient`) and the frontend (`createThresholdSession`)
only bind it to a client and an RPC.

1. Members come from the core. `prepareMembers` reads every member's module descriptor — installed,
   `thresholdMemberEligible`, and its current `credentialGeneration` — and returns the §5 member
   digest each member must sign. A generation the caller supplies is never trusted: a stale one
   yields a digest the core rejects as `SA_CREDENTIAL_STALE`.
2. Assembly is explicit. `assembleSignature({ members })` serializes `[moduleId, 64-byte signature]`
   pairs, and `assembleOperationSignature({ operationDigest, members })` returns
   `{ signatureHex, members }`, where `signatureHex` is field 11 of the 13-field operation.
3. The policy itself is configuration. Membership and the threshold are set by a
   `setThresholdPolicy` action — `[7, policyId, threshold, memberIds[], active]` — inside a
   configuration intent, so they mature for 24 hours before they apply. `policyId = 0` allocates a
   fresh id from the same monotonic allocator as module instances, so a policy id never aliases a
   module id. Deactivating a policy carries no members and frees those members for uninstall.

```js
const { createThresholdClient } = require('smart-account');

const threshold = createThresholdClient({ client });
const prepared = await threshold.prepareMembers({
  accountId,
  operationDigest,
  memberIds: [1, 2, 3],
});
// Each member signs prepared[i].digest with its own validator key.
const signatureHex = threshold.assembleSignature({
  members: [{ moduleId: 1, signature }, { moduleId: 2, signature }],
});
```

The frontend session (`frontend/src/features/operations/multiSig.js`) reads through one core of the
caller's choice, so a session cannot mix values from two networks:

```js
import { createThresholdSession } from './features/operations/multiSig.js';

const session = createThresholdSession({ rpcUrl });
const prepared = await session.prepareMembers({
  networkMagic,
  coreContractHash,
  accountId,
  operation,
  memberModuleIds: [1, 2],
});
// `preview` re-reads the core's validation result; `readProxyHash` reads the
// account proxy. Every read goes through the core hash the session was given.
```

Threshold membership counts validator instances, not independent keys or people. Different modules
can share credentials or controllers, so a successful quorum does not establish signer
independence.

### Configuring members

Member configuration is ordinary module configuration: `configure` on the validator instance
takes a `configureModule` action inside a configuration intent, so it matures on the same 24-hour
timer as every other intent and a module cannot configure itself. Rotating credentials is
immediate instead: `revokeCredentials(accountId, moduleId)` is a custody-authorised core action
that bumps the instance generation on the spot, which is why signatures bound to the old
generation stop validating the moment it executes.

The core exposes no policy getter. A policy is observable through the `ThresholdPolicySet`
notification (`accountId`, `policyId`, `threshold`, `memberIds`), and each member instance is
observable through `getModule` — the descriptor carries `credentialGeneration` and
`thresholdMemberEligible`, which are exactly the two values a member digest binds. Read
`getPendingConfiguration` for the outstanding intent with its maturity and action digest, and
compare that digest against the exact intent you proposed before confirming; a pending record
alone does not prove it carries the change you expect.

### Evidence and boundary

`MultiSigSdkVectorTests.cs` runs the actual JS serializer, compares its bytes with VM
`StdLib.Serialize`, rejects shifted and duplicated member entries, and exercises the threshold
routing against a real core operation. The serializer is bounded to 10 members and 65,535 total
bytes; empty hex is a ByteString and is different from null.

SDK unit tests cover member digests, generation binding, malformed signatures and assembly order.
Frontend tests verify RPC Array and base64 ByteArray wire encoding. No generic "multisig complete"
badge is introduced.

### Configuring V3 MultiSig children

A MultiSig root forwarding to verifier children belongs to the v3 deployed-contract profile; the v4
threshold above has no MultiSig root and no verifier children. In that legacy profile, each ordinary
verifier requires the pinned SA core to call it with an exact
per-account configuration context. A MultiSig root forwarding to a child cannot
satisfy that check. The core source provides a bounded child initialization path.
`callVerifierChild(accountId, childVerifier, method, args)` and the `getChildVerifierConfig(accountId)` read described below are absent from the pinned
deployed artifact (`contracts/build/SmartAccount.manifest.json` exports
neither), so a deployment must be rebuilt before an integrator can call the path
this section describes (DS-CU-202 finding F1).

- The caller must satisfy the account's backup-owner witness. The account cannot
  be in market escrow or active execution.
- The current root must expose a safe `getChildVerifierConfig(accountId)` read that is absent from
  the pinned deployed artifact while returning the root's ordered children and threshold; this is a
  source requirement, not a property of the deployment in `contracts/build`. MultiSig implements it
  from its existing `getConfig` state; `getConfig` remains unchanged.
- The target must be a current direct child, with complete V3 lifecycle ABI and
  `authorizedCore()` equal to this core. The root must be bound to this core too.
- Only `setPublicKey(Hash160, ByteArray)` and `setConfig(Hash160, Array, Integer)`
  are accepted, and `args[0]` must equal `accountId`.
- The first call stages the existing pending verifier-call record and returns
  `false`. An identical second call after 24 hours invokes the child. The record
  binds the root, child, method, arguments, ordered topology, and threshold;
  confirmation checks the current topology again. Changed current inputs stage
  a new 24-hour proposal. The same pending slot is shared with `callVerifier`.
- The core grants configuration context to that child only, invokes it directly,
  and clears the context on return. Direct child calls remain unauthorized.

For example, register a MultiSig root with empty verifier params, configure its
root `setConfig` through the existing `callVerifier` timelock, then initialize a
Web3Auth child's `setPublicKey` and a NeoNative child's `setConfig` through separate
`callVerifierChild` proposals — absent from the pinned deployed artifact, so this
sequence needs a rebuilt deployment. Each proposal uses the full argument list including
the account ID. Existing pending getters report the root module, commitment hash,
and available time.

This path initializes direct children and does not change cleanup, authority
epochs, or ordinary root configuration. A safe getter is an explicit capability,
not an independent trust attestation for arbitrary third-party root code.

#### Child execution isolation

MultiSig counts only an actual Boolean `true` as a child's approval. An Integer
`1`, or another truthy VM value from a contract with a misleading manifest, does
not count toward the threshold.

`CallFlags.ReadOnly` limits storage and calls; it does not make VM collections
immutable. MultiSig therefore serializes the original arguments once and
deserializes a separate copy for every child validation and post-execution call.
Post-execution results receive the same snapshot-and-copy treatment. A child
cannot change another child's signed arguments or accounting input through shared
Array, Struct, Map, or Buffer objects.

Arguments and target results must be serializable by Neo StdLib. Interop and
iterator results are unsupported and fail closed; the contract never silently
passes an unsupported shared object to the next child. Snapshot work adds
serialization and per-child deserialization cost; the configured child limit is
ten. The threshold remains a threshold over configured modules, not a guarantee
of distinct human owners or cryptographic signer domains.

## EIP-712 signing

Canonical reference for the EIP-712-style signing surface the V3 verifiers
hash and check on-chain. The byte-level source of truth is
`contracts/plugins/verifiers/Web3AuthVerifier.cs`; the SDK mirrors it in
`shared/metaTxCore.mjs` (typed-data shape) and `sdk/js/src/metaTx.js`
(byte-exact payload builders). Where the layout intentionally deviates from
strict EIP-712 the deviation is listed in [Deviations](#deviations-from-strict-eip-712).

### Domain separator

Type string:

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
```

| Field | Value |
| --- | --- |
| `name` | `"Neo Smart Account"` (the wire constant the deployed verifier hashes; switched from `"Neo N3 Abstract Account"` in the SA protocol-string switch — pre-switch-domain signatures cut off at that switch) |
| `version` | `"1"` |
| `chainId` | the Neo network magic (`Runtime.GetNetwork()`), e.g. `860833102` MainNet |
| `verifyingContract` | the **verifier** contract hash (the contract executing `validateSignature`), 20 bytes |

Encoding (`Web3AuthVerifier.BuildDomainSeparator`):

```
domainSeparator = keccak256(
    EIP712_DOMAIN_TYPE_HASH ||
    keccak256("Neo Smart Account") ||
    keccak256("1") ||
    ToUint256Word(chainId) ||          // 32-byte big-endian word
    ToAddressWord(verifyingContract)   // 12 zero bytes || 20 big-endian bytes
)
```

`EIP712_DOMAIN_TYPE_HASH` is
`keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")`
= `8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f`.

### UserOperation struct

Type string (V3):

```
UserOperation(bytes20 accountId,bytes20 coreContract,address targetContract,string method,bytes32 argsHash,uint256 nonce,uint256 deadline)
```

`USER_OPERATION_TYPE_HASH` =
`keccak256("UserOperation(bytes20 accountId,bytes20 coreContract,address targetContract,string method,bytes32 argsHash,uint256 nonce,uint256 deadline)")`
= `577a3a6bd91683e300e814cd25ff6247ab7ca273ddd0153a99919d72ddf9fa04`.

Field encoding (`Web3AuthVerifier.BuildMetaTxStructHash`):

| Field | Word encoding |
| --- | --- |
| `accountId` | `ToBytes20Word`: the 20-byte hash in **big-endian display order**, **right**-padded with 12 zero bytes |
| `coreContract` | same `ToBytes20Word` of the authorized SA core hash (the verifier's bound core) |
| `targetContract` | `ToAddressWord`: 12 zero bytes then the 20 bytes big-endian (standard `address` padding) |
| `method` | `keccak256(utf8(method))` — identical to the EIP-712 `string` encoding |
| `argsHash` | `keccak256(StdLib.Serialize(op.Args))` computed by the core (`computeArgsHash`); the serialization is the NeoVM binary stack-item format, not EVM ABI |
| `nonce` | `uint256` big-endian 32-byte word |
| `deadline` | `uint256` big-endian 32-byte word (Neo `Runtime.Time` milliseconds) |

```
structHash = keccak256(
    USER_OPERATION_TYPE_HASH ||
    ToBytes20Word(accountId) ||
    ToBytes20Word(coreContract) ||
    ToAddressWord(targetContract) ||
    keccak256(utf8(method)) ||
    argsHash ||
    ToUint256Word(nonce) ||
    ToUint256Word(deadline)
)
```

### Signing payload and signature

```
payload = 0x19 || 0x01 || domainSeparator || structHash   // 66 bytes
digest  = keccak256(payload)
```

- The digest is signed with **secp256k1 ECDSA**; there is **no EIP-191
  personal-message prefix** — the 0x1901 prefix is the only envelope.
- The on-chain signature is the compact 64-byte `r || s` form (no `v`).
  `Web3AuthVerifier.validateSignature` asserts exactly 64 bytes.
- `nonce` and `deadline` must satisfy `0 <= value < 2^255` (the NeoVM signed
  `Integer` domain); the SDK builders reject out-of-domain values.
- The account id is registration-bound: `computeRegistrationAccountId`
  commits to the verifier, its params, the hook, the backup owner and the
  escape timelock, so a signature for one configuration cannot be replayed
  against another.

### Deviations from strict EIP-712

1. `bytes20` is not an EIP-712 atom. The layout treats it as a 32-byte word
   holding the 20 hash bytes big-endian **right**-padded (zeros on the
   right), whereas EIP-712 `address` left-pads. Only `accountId` and
   `coreContract` use it; `targetContract` follows the standard left-padded
   `address` encoding.
2. `argsHash` commits to the NeoVM `StdLib.Serialize` byte form of the
   argument list. Cross-language signers must reproduce that serialization
   exactly or obtain the hash from the core's `computeArgsHash` read.
3. `chainId` carries the Neo **network magic**, not an EVM chain id.

These deviations are deliberate: the payload is produced and verified inside
one chain's VM, and wallet-side signing is served by the byte-exact builders
below rather than by a generic EIP-712 implementation.

### SDK builders

- `buildUserOperationTypedData(options)` — wallet/display-facing typed data
  (domain + types + message) for the layout above.
- `buildUserOperationSigningPayload(options)` — the complete 66-byte
  `0x1901`-enveloped payload ready for a raw secp256k1 signer. The domain
  separator and the struct hash are `ethers.TypedDataEncoder` outputs inside
  that payload: the v4 SDK exposes the payload and its digest, not the two
  intermediate hashes as separate builders.
- `buildUserOperationSigningDigest(options)` — `keccak256` of that payload:
  the 32 bytes a raw secp256k1 signer signs.
- `SmartAccountClient.computeArgsHash(args)` — asks the core for the
  canonical `argsHash` instead of re-implementing the serialization.

A golden-vector test (`sdk/js/tests/flow.unit.test.js`, "EIP-712 typed
data hash matches expected test vector") pins the byte layout end to end.

## Proxy transfers

A virtual account holds assets at the hash of its proxy verification script, not at its account ID. The owner or relay witness alone does not authorize an NEP-17 transfer from that address. The relay can construct the additional witness when the operator enables `AA_RELAY_PROXY_WITNESS_ENABLED=1` and configures the account's verify-scope target.

### Exact transaction shape

The transaction has exactly one application call: `core.executeUserOp(accountId, op)` or `core.executeUserOps(accountId, ops)`, each with two arguments. Argument construction may only contain constant pushes and data construction opcodes. The verifier binds the final call to the actual core and actual account ID. For this direct (unsponsored) shape, other entrypoints, other cores/accounts, additional calls and control flow are rejected. The v4 custom Verification kernel separately binds the two five-argument sponsored wrappers with the same data-push discipline, single and batch — see the sponsorship boundary below for what that kernel acceptance does and does not mean.

Signer 0 is the fee-paying relay with `CalledByEntry`. Signer 1 is the derived proxy, with precisely one `Allow` rule containing `Or(CalledByContract(core), CalledByContract(configuredTarget))`. The proxy witness has an empty invocation script and a verification script consisting of `core.verify(accountId)`. The relay signature covers the complete transaction, including both signers, script and fees. Both witnesses are present during network-fee calculation and final serialization. The proxy is never permitted to pay the enclosing transaction's fees.

The relay derives the script locally, compares its hash with `getProxyScriptHash(accountId)`, and reads `getVerifyScopeTarget(accountId)` from the selected core/RPC. The configured target must equal the token being transferred. Every operation in a batch must name that same target. A scope change racing submission is rejected by transaction verification. Client-supplied signer or witness metadata is not used to construct this authority.

### The SDK builder

The whole transaction is assembled in one place, `shared/proxyWitness.mjs`, and the relay route and the wallet frontend both call it:

- `buildExecuteUserOpScript({ coreHash, accountId, invocation })` emits the shape-bound script. It refuses every entrypoint other than `executeUserOp`/`executeUserOps`, a wrong core, a wrong account, a wrong argument count and an empty batch, so the bytes it produces can only be the one application call. Its Neo VM push encoder is pinned by test to be byte-identical to the node's own assembler (`neon-js sc.createScript`) for single, batch and nested-argument invocations.
- `buildProxyWitnessTransaction({ coreHash, accountId, invocation, scopeTarget, expectedProxyHash, feePayer, … })` returns the script, the fee-payer signer, the restricted `WitnessRules` proxy signer and the proxy verification witness, in that signer order. It refuses an absent or all-zero `scopeTarget` with `PROXY_SCOPE_TARGET_REQUIRED`, a scope target that is the core, a scope target that is not the transferred token, mixed targets in a batch, and a fee payer that is the proxy.
- `resolveProxyWitnessTransaction({ …, readState })` performs the same build after reading `scopeTarget` and `expectedProxyHash` through an injected reader. The reader must be the submitting core/RPC; no caller can pass those two values in from request metadata.
- `buildProxyWalletSignRequest({ transaction, scope, allowedContracts })` is the browser-wallet signing path. It re-expresses the fee payer in a custom scope — `CustomContracts` with an explicit allowlist, or `Global` — while the proxy keeps its restricted rules and its witness.

`sdk/js/src/proxyWitness.js` re-exports the module, so the SDK carries the same builder. The frontend vendors a byte-identical copy under `frontend/src/shared/` (enforced by `frontend/tests/transferOutcomeShared.test.js`).

The local-chain scenario `SA-12` drives this builder end to end on the deployed core: a throwaway key that is not the contract admin registers an account, pays the fee and moves exactly 1 GAS out of the account's proxy address from a transaction the SDK built, and the same builder refuses an account the admin never scoped before any transaction exists. The receipt records the built script, both signers and the wallet signing request.

### Fee estimation

Published Neo RPC omits custom nonempty verification scripts in `calculatenetworkfee`: its estimate excludes the proxy's VM verification cost and serialized witness bytes. Proxy mode therefore also requires a positive `AA_RELAY_PROXY_NETWORK_FEE_RESERVE` in datoshi and a network or total fee ceiling. The relay adds this operator-selected reserve to the RPC estimate before enforcing every existing cap.

This is a bounded operational reserve, not an automatic exact fee estimate. An insufficient reserve is rejected by the node; an unnecessarily large reserve pays an unnecessarily large network fee. Operators must validate it against their node, script sizes and accepted operation families. The private-chain acceptance uses a 2 GAS reserve for its tested direct transfer. That test value is not a recommendation for a public deployment.

The relay preserves explicit unsponsored opt-in, off-chain sponsorship approval binding, and system/network/total fee ceilings. A token transfer returning Boolean false is refused during preflight and again during fee estimation. No transaction is broadcast after a failing preflight or exceeded ceiling.

### Sponsorship boundary

**Sponsored proxy transfers are kernel-accepted but not deployment-supported.** The current v4 custom Verification binds exactly four precise transaction shapes — the two-argument `executeUserOp`/`executeUserOps` calls and the five-argument `executeSponsoredUserOp`/`executeSponsoredUserOps` wrappers, each in single and batch form — and the runtime suite drives a real proxy witness through the exact five-argument sponsored envelope for a GAS transfer, rejecting an appended trailing call, a shaped call for another account or core, and a non-proxy fee payer. That is shape-bound kernel acceptance, not an end-to-end capability: the relay route has not been migrated to the v4 module ABI and explicitly refuses proxy transfers using either sponsored entrypoint before calculating fees or signing a transaction for broadcast, and real on-chain evidence for a sponsored proxy transfer is limited to that regression suite, with no current-source on-chain receipt asserting a settlement. Enabling the route still needs the reviewed design below.

A transaction witness survives after `executeUserOp` clears its hook and verification context. Current sponsorship accepts a paymaster based on its self-reported `authorizedCore`; that is not an independent trust decision. If settlement invokes a contract covered by the proxy witness scope, that authority could be reused outside the signed operation's hook accounting. Supporting sponsored proxy transfers therefore needs a reviewed design for paymaster authority and witness lifetime. Passing an ordinary paymaster happy-path test is insufficient.

Direct proxy transfers can still use an off-chain relay sponsorship policy: the transaction itself remains a single `executeUserOp(s)` call, and the fee-paying relay is not reimbursed by an on-chain settlement callback.

### Wallet behavior and acceptance

The NEP-17 preset can stage a proxy transfer in relay mode. The staged operation records that a proxy witness is required. The client path now builds the complete proxy-witness transaction with the SDK builder (`buildClientProxyWitnessTransaction`) and carries its custom-scope wallet signing request, so a wallet that signs a built transaction can complete the move: the dApp asks the wallet to sign the transaction as the fee payer and attaches the proxy verification witness itself. Ordinary wallet `invoke` APIs broadcast their own transaction and cannot carry a verification script they did not create, so `executeBroadcast` still refuses to send through such a wallet rather than submit a transfer that would return false and still burn the fee; imported drafts receive the same check at client broadcast. The wallet end-to-end path (a wallet shim on the local chain) is tracked separately. A relay without the feature enabled retains its previous behavior and refuses a standard token transfer that lacks a valid witness.

The configured scope remains an administrator-managed prerequisite. This change does not make arbitrary accounts self-service for scope configuration or activate a native SmartAccount profile.

The protocol v4 source suite does not drive the relay route: its four scenarios exercise account creation, the configuration intents, the core hook order and owner-only recovery, so no current-source receipt asserts proxy-transfer balances, exact signer rules, fee reserves or relay sponsorship refusal. Those assertions still run against the frozen deployed artifacts and their expectations in `tests/localchain/expected-deployed.json`; that is historical evidence for the deployed contract, not a claim about the v4 core. Re-targeting the relay route at the v4 module ABI is separate work.

### What an artifact refresh does and does not change

Re-pinning the build (the 2026-11-20 reproducibility certificate, its private-chain source receipt and the provenance join) moves artifact identities only. It does not:

- turn the `SA-12` receipt into a v4 source proof — that scenario still runs against the frozen deployed artifacts, and no current-source receipt asserts a proxy-transfer balance, the exact signer rules, the fee reserve or the sponsorship refusal;
- enable sponsored proxy transfers — kernel acceptance of the exact five-argument envelopes does not enable them end to end: the relay still refuses either sponsored entrypoint, real on-chain sponsored proxy-transfer evidence remains limited to the runtime regression suite, and the reviewed paymaster-authority and witness-lifetime design below is still required;
- retarget the relay at the v4 module ABI — that remains separate work, and the relay keeps refusing a standard token transfer that lacks a valid witness whenever the feature is off.

An artifact hash is an identity, never an acceptance. Reading the number as "proxy transfers are now proven on v4" is exactly the inference this section exists to refuse.

## Pending configuration update reads

The custom deployed-contract profile adds two safe methods. They are additive
to the existing pending flags, maturity-time getters, and update/confirm/cancel
methods; they do not change storage or authorization.

| Method | Parameter | Result |
| --- | --- | --- |
| `getPendingVerifierUpdate` | `accountId: Hash160` | `Array` or `null` |
| `getPendingHookUpdate` | `accountId: Hash160` | `Array` or `null` |

Both methods have `safe: true`. A nonzero, valid account ID with no pending
record returns `null`, including an unregistered ID. A null, zero, or malformed
account ID faults. No owner witness is required for these public reads.

A present result is always an explicit four-element array:

1. `newModuleHash`: the proposed verifier or hook, as a 20-byte VM ByteString.
   Zero means removal. Neo RPC exposes Hash160 values in VM byte order; clients
   reverse the bytes when producing the usual display-form hash.
2. `verifierParams`: the proposed verifier parameters as a ByteString. A missing
   verifier parameter value is normalized to empty bytes. Hook results always
   contain empty bytes in this position.
3. `initiatedAt`: an integer Unix timestamp in milliseconds.
4. `matureAt`: an integer Unix timestamp in milliseconds, equal to `initiatedAt`
   plus the configuration timelock (currently 86,400,000 milliseconds).

The internal pending storage object is not the public return layout. Verifier
reads select its verifier field; hook reads select its hook field. Cancellation
or successful confirmation clears the relevant record, so the corresponding
getter subsequently returns `null`.

This ABI describes newly compiled source. Existing deployments that do not
advertise these method names continue to expose only the older reads. A client
must check the manifest or handle a missing-method response; it must not present
the selected target or parameters as chain-verified when only a local form or a
transaction draft supplied them. Build output under `contracts/bin/public` is local
validation output and is not evidence of a deployed upgrade.

## Frontend app workspace runtime

The JavaScript SDK drives the v4 protocol: one 13-field operation, one derivation for the account
identity, and the `SA_*` vocabulary the native kernel raises. The v3 surface
(`registerAccount`, `createAccountPayload`, `getVerifier`) was removed: there is no alias.

### Installation

```bash
npm install @cityofzion/neon-js ethers
```

### 1. Initialize the Client

Use a Neo N3 RPC endpoint and the chain id the digests bind, unless you explicitly override them
with another instance. The canonical anchors are generated from
neo-os-services into `frontend/src/config/generatedMorpheusRegistry.js`; the repository README
restates them and that generated module wins on any conflict. The SDK surface is the native
client: the former deployed-kernel client and its `createSmartAccountClient` factory were removed
with the custom delivery track, and a removed call fails to resolve.

```javascript
const { NativeSmartAccountClient } = require('./sdk/js/src');

const client = new NativeSmartAccountClient({
  rpcUrl: 'https://testnet1.neo.coz.io:443',
  networkMagic: 894710606,
});
await client.discover(); // protocol version, implementation id and required ABI
```

The generated registry also publishes the legacy deployment anchors the testnet still lists, so an
integrator can tell an old anchor from the v4 kernel. The verifier address below is public chain
data from that registry; v4 accounts install validator modules instead of that shared verifier.

```javascript
const web3AuthVerifierHash = '0x1111f5b6b046a964c75d208998c13945ce172e85';
```

### 2. Derive the Account Identity

A v4 identity is `accountId = hash160('aa524704' || custody || salt)`. The salt is 1..128 bytes of
public uniqueness input, and the proxy address follows from the account id and the kernel hash, so
the pair is enough to re-derive the account on either kernel.

```javascript
const identity = client.deriveIdentity({
  custodyAddress: 'N...custody',
  salt: '0x00112233445566778899aabbccddeeff',
});
console.log(identity.accountId);
console.log(identity.accountAddress);
console.log(identity.verificationScript);
```

The derivation is single-sourced in `shared/` and the contract exposes the same function
(`computeAccountIdentity`), so the client, the frontend and the chain cannot disagree on the id.

### 3. Build the Account-Creation Invocation

The create call commits to the identity: `createAccount(Hash160 accountId, Hash160 custody,
ByteArray salt, Integer recoveryTimelockMs, Array actions)`. The recovery timelock is 7..90 days in
milliseconds, and no validator or hook module is chosen here. Modules are installed afterwards by a
configuration intent.

```javascript
const plan = client.buildCreateAccountScript({
  custodyAddress: 'N...custody',
  salt: '0x00112233445566778899aabbccddeeff',
  recoveryTimelockMs: 30 * 86_400_000,
});

console.log(plan.method);          // createAccount
console.log(plan.accountId);       // derived identity, never supplied by the caller
console.log(plan.accountAddress);  // the proxy address the script deploys
console.log(plan.script);          // the NeoVM script the custody wallet signs
```

`createAccounts` registers a batch in one transaction. The account state is read with
`client.getAccount(accountId)`: custody, recovery authority and timelock, authority epoch,
configuration nonce, hook-order revision, installed modules and the pending configuration intent.

### 4. Generate the Typed Data

The SDK returns the typed data the core checks, and the same fields are what
`computeArgsHash`/`getOperationDigest` bind on-chain.

```javascript
const typedData = buildUserOperationTypedData({
  chainId: 894710606,
  verifyingContract: identity.accountAddress,
  accountId: identity.accountId,
  coreContractHash: client.contractHash,
  validatorId: 1,
  targetContract,
  method: 'transfer',
  argsHashHex,
  nonce,
  deadline: Date.now() + 3600_000,
  operationDigest,
});

const signature = await signer.signTypedData(
  typedData.domain,
  typedData.types,
  typedData.message,
);
```

Operation argument DTOs: their `ByteArray` values are explicit `0x` hex, including the signature.
They are not direct Neo RPC JSON (which uses base64). The operation builder and `computeArgsHash`
accept typed argument DTOs or Neon `ContractParam` instances and preserve nested arrays/maps,
hashes, and public keys. For plain `ByteArray` input, use `0x` hex or unambiguous canonical base64;
ambiguous bare hex such as `aabb` is rejected, so migrate it to `0xaabb`. Numeric enum types require
a real `ContractParam` instance; do not JSON-stringify the instance first. Unknown types, non-null
`Any`, coerced booleans and unsafe numeric integers are rejected. Map entry order is preserved across
RPC hashing and relay execution; duplicate VM keys (including String/ByteArray aliases) are rejected
before signing. Use decimal strings for large integers. Argument nesting must fit the relay's
depth-eight limit, including the surrounding operation/batch arrays. Use `computeArgsHash` with the
same arguments before signing.

### 5. App Workspace Runtime Setup

The app workspace accepts both direct browser-wallet broadcast and optional relay broadcast. For a Vercel deployment, wire these environment variables into the frontend:
Start from `frontend/.env.example` when creating a local `frontend/.env.local` file or mirroring the same keys into your deployment provider.

```bash
VITE_SA_RPC_URL=https://testnet1.neo.coz.io:443
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
VITE_SA_RELAY_URL=/api/relay-transaction
VITE_SA_RELAY_RPC_URL=https://testnet1.neo.coz.io:443
VITE_SA_RELAY_META_ENABLED=1
```

- `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` enable anonymous draft persistence.
- `VITE_SA_RELAY_URL` points the UI at the relay submission endpoint.
- `VITE_SA_RELAY_META_ENABLED` tells the frontend that the backend relay is configured to submit stored `executeUserOp` invocations.
- `SA_RELAY_WIF` on the server enables relay submission of stored `executeUserOp` invocations built from collected EVM signatures.
- shared draft metadata is intentionally bounded: the frontend retains the latest 100 activity entries and the latest 12 submission receipts per draft in both local and Supabase-backed storage.
- client-side broadcast remains the default safe path, while relay mode is reserved for already-signed raw transactions.
- the app workspace presets now stage concrete SA wrapper payloads, so a browser-wallet submission targets `executeUserOp` on the SA contract rather than the downstream contract directly.

#### Server Runtime Add-Ons

If you deploy the bundled Vercel-style API routes, keep the relay signer and operator persistence settings on the server:

```bash
SA_RELAY_RPC_URL=https://testnet1.neo.coz.io:443
SA_RELAY_WIF=your-relay-wif
SA_RELAY_ALLOWED_HASH=0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2
SA_RELAY_ALLOW_RAW_FORWARD=0
SA_RELAY_INCLUDE_RAW_ERRORS=0
MORPHEUS_NETWORK=testnet
MORPHEUS_PAYMASTER_TESTNET_ENDPOINT=https://oracle.meshmini.app/testnet/paymaster/authorize
MORPHEUS_PAYMASTER_MAINNET_ENDPOINT=https://oracle.meshmini.app/mainnet/paymaster/authorize
MORPHEUS_PAYMASTER_TESTNET_API_TOKEN=your-paymaster-token
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

- `frontend/api/relay-transaction.js` uses `SA_RELAY_RPC_URL`, `SA_RELAY_WIF`, `SA_RELAY_ALLOWED_HASH`, and `SA_RELAY_ALLOW_RAW_FORWARD` to constrain relay behavior. Keep raw forwarding off unless you intentionally want the relay to pass through pre-signed raw Neo transactions.
- `frontend/api/relay-transaction.js` can also request Morpheus paymaster pre-authorization before relay submission. Use `MORPHEUS_PAYMASTER_TESTNET_ENDPOINT` / `MORPHEUS_PAYMASTER_MAINNET_ENDPOINT` and the matching API token only on the server.
- `frontend/api/morpheus-neodid.js` and `frontend/api/morpheus-oracle-public-key.js` now prefer the unified Morpheus runtime domains. Use `MORPHEUS_RUNTIME_URL`, `MORPHEUS_MAINNET_RUNTIME_URL`, or `MORPHEUS_TESTNET_RUNTIME_URL`. Legacy `MORPHEUS_API_BASE_URL` is still tolerated for compatibility.
- `SA_RELAY_INCLUDE_RAW_ERRORS=1` is an operator-only debug knob. Leave it disabled in normal deployments, and enable it temporarily when you need the raw paymaster / relay exception message in API responses.
- `frontend/api/draft-operator.js` is the signed operator mutation endpoint. It uses `SUPABASE_SERVICE_ROLE_KEY` to persist operator-only status updates, relay-preflight snapshots, submission receipts, and collaborator/operator link rotation after the browser proves operator intent with a signature.
- the browser-safe `VITE_*` values tell the UI what features to surface, while the server-only values above decide what the relay and signed operator mutation routes are actually allowed to do.

### Runtime Reference

| Setting | Scope | Purpose |
| --- | --- | --- |
| `VITE_SA_RPC_URL` | Frontend | Neo RPC used for app workspace reads and staging. |
| `VITE_SUPABASE_URL` | Frontend | Enables anonymous shared-draft persistence when paired with the anon key. |
| `VITE_SUPABASE_ANON_KEY` | Frontend | Public browser key for anonymous shared-draft persistence. |
| `VITE_SA_RELAY_URL` | Frontend | Relay endpoint used for preflight checks and relay submission. |
| `VITE_SA_RELAY_RPC_URL` | Frontend | RPC used by relay-aware runtime helpers. |
| `VITE_SA_RELAY_META_ENABLED` | Frontend | Tells the UI that relay-ready meta invocations can be submitted directly. |
| `VITE_SA_EXPLORER_BASE_URL` | Frontend | Optional transaction explorer base for tx links and receipts. |
| `VITE_SA_MATRIX_CONTRACT_HASH` | Frontend | Optional `.matrix` contract hash override used for domain resolution and same-transaction registration. |
| `SA_RELAY_RPC_URL` | Server | Preferred RPC for `frontend/api/relay-transaction.js` when you do not want the server to inherit the browser-facing RPC setting. |
| `SA_RELAY_WIF` | Server | Enables server-side submission of stored `executeUserOp` invocations. |
| `SA_RELAY_ALLOWED_HASH` | Server | Pins relayable meta invocations to the expected Smart Account contract hash. |
| `SA_RELAY_ALLOW_RAW_FORWARD` | Server | Explicit opt-in for relaying already-signed raw transactions; keep disabled by default. |
| `SA_RELAY_INCLUDE_RAW_ERRORS` | Server | Optional operator debug switch that includes the unsanitized exception message and stack in relay API responses. |
| `MORPHEUS_PAYMASTER_TESTNET_ENDPOINT` / `MORPHEUS_PAYMASTER_MAINNET_ENDPOINT` | Server | Optional Morpheus paymaster endpoint used before relay submission. |
| `MORPHEUS_PAYMASTER_TESTNET_API_TOKEN` / `MORPHEUS_PAYMASTER_MAINNET_API_TOKEN` | Server | Optional bearer token for the corresponding Morpheus paymaster endpoint. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server | Required by the `draft-operator` signed operator mutation route for operator-only draft persistence. |
| Draft metadata retention | Frontend + Supabase | Keeps only the latest 100 activity entries and latest 12 submission receipts per draft. |

### Security Posture

- **Safe to expose client-side:** `VITE_SA_RPC_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SA_RELAY_URL`, `VITE_SA_RELAY_RPC_URL`, `VITE_SA_RELAY_META_ENABLED`, and `VITE_SA_EXPLORER_BASE_URL` are runtime hints the frontend needs in the browser.
- **Server-only:** `SA_RELAY_WIF` and `SUPABASE_SERVICE_ROLE_KEY` are secrets and must stay on the server. `SA_RELAY_ALLOWED_HASH` and `SA_RELAY_ALLOW_RAW_FORWARD` are not secret material, but they are still server-only hardening knobs because they define what the relay and signed operator mutation routes are willing to accept.
- **Debug-only:** `SA_RELAY_INCLUDE_RAW_ERRORS` should stay off in normal operation. Enable it only when you need a temporary deeper error trace for relay or paymaster debugging.
- **Server-only paymaster settings:** `MORPHEUS_PAYMASTER_TESTNET_ENDPOINT`, `MORPHEUS_PAYMASTER_MAINNET_ENDPOINT`, and their matching API tokens should never be exposed to the browser. They let the relay backend request sponsorship tickets from Morpheus before broadcasting.

### Relay Behavior Matrix

| `VITE_SA_RELAY_URL` | `VITE_SA_RELAY_META_ENABLED` | `SA_RELAY_WIF` | Effective behavior |
| --- | --- | --- | --- |
| missing | any | any | No relay path; the UI stays on client-side broadcast only. |
| set | off | missing or set | Preflight only for relay-ready payload inspection, plus signed raw relay when a raw transaction already exists. |
| set | on | missing | Signed raw relay works, and meta payloads can be prepared, but meta relay submission is blocked server-side without the relay signer. |
| set | on | set | Full relay path: preflight only when simulating, signed raw relay, and meta relay submission for stored `executeUserOp` invocations. |

### Safe Defaults

- **Client-side broadcast is the default safe path** and works without relay configuration.
- **Optional knobs** such as `VITE_SA_RELAY_META_ENABLED`, `SA_RELAY_WIF`, and `VITE_SA_EXPLORER_BASE_URL` only expand relay and explorer behavior; they are not required for basic local wallet usage.
- **Supabase settings are optional** unless you want anonymous cross-device draft sharing instead of the local-only browser fallback.

### Minimum Capability Matrix

| Missing optional piece | What still works |
| --- | --- |
| without Supabase | Local-only drafts, browser-wallet signing, relay checks, and client-side broadcast still work in the current browser. |
| without relay | Smart Account loading, draft persistence, local/manual signature collection, and client-side broadcast still work. |
| without explorer | Draft sharing, relay checks, and broadcast still work; only external tx links and explorer shortcuts are reduced. |

### Recommended Deployment Profiles

- **local-only** — use browser wallets with no Supabase and no relay when you only need one-device compose, sign, and client-side broadcast.
- **collaborative** — add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` when you want anonymous shared drafts and mixed approval collection, even if final submission still happens client-side. The default read-only share link is safe for review, the collaborator link is for signature collection, and the operator link is for relay checks, broadcasts, and link rotation. Collaborator links also cannot append operator-class relay/broadcast timeline events. Operators can use the Rotate Collaborator Link or Rotate Operator Link actions to invalidate older write-capable URLs in-place.
- **full relay-enabled** — add Supabase, `VITE_SA_RELAY_URL`, `VITE_SA_RELAY_META_ENABLED`, `VITE_SA_EXPLORER_BASE_URL`, and server-side `SA_RELAY_WIF` when you want shared drafts, relay preflight, signed raw relay, and meta relay submission together.
- **operator-hardened** — add `SUPABASE_SERVICE_ROLE_KEY`, keep `SA_RELAY_ALLOWED_HASH` pinned to the deployed SA contract, and leave `SA_RELAY_ALLOW_RAW_FORWARD=0` unless your operators explicitly need raw-transaction passthrough. This profile keeps `draft-operator` signed operator mutation writes available without widening relay scope.

### .env.local Examples

**local-only profile**

```bash
VITE_SA_RPC_URL=https://testnet1.neo.coz.io:443
```

**collaborative profile**

Use the normal draft URL for read-only review, the collaborator link for signatures, and the operator link for relay/broadcast actions.

```bash
VITE_SA_RPC_URL=https://testnet1.neo.coz.io:443
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

**full relay-enabled profile**

```bash
VITE_SA_RPC_URL=https://testnet1.neo.coz.io:443
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
VITE_SA_RELAY_URL=/api/relay-transaction
VITE_SA_RELAY_RPC_URL=https://testnet1.neo.coz.io:443
VITE_SA_RELAY_META_ENABLED=1
VITE_SA_EXPLORER_BASE_URL=https://testnet.ndoras.com/transaction
```

### Testnet vs Production Checklist

- **testnet** — keep `VITE_SA_RPC_URL` and `VITE_SA_EXPLORER_BASE_URL` pointed at testnet services, and fund a dedicated testnet relay signer before using `SA_RELAY_WIF` for relay validation.
- **production** — switch RPC and explorer endpoints together, keep `SA_RELAY_WIF` only on the server, and treat relay signer funding/monitoring as an operational requirement.
- **relay meta mode** — on production, leave relay meta mode disabled until the backend relay signer and monitoring path are ready for direct meta relay submission.

### Troubleshooting

- **Missing Supabase envs:** if `VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` is absent, draft sharing falls back to local-only browser storage and anonymous cross-device sharing is unavailable.
- **Missing `SA_RELAY_WIF`:** relay submission can be configured in the UI, but the backend cannot actually sign and send relay-ready meta invocations.
- **Missing `SUPABASE_SERVICE_ROLE_KEY`:** `frontend/api/draft-operator.js` returns `operator_mutation_not_configured`, so signed operator mutation requests cannot persist operator-only status, receipt, or link-rotation changes.
- **Relay meta mode disabled:** if `VITE_SA_RELAY_META_ENABLED` is unset, collected meta invocations stay stored on the draft but the UI treats them as not directly relayable.
- **Relay hash/raw settings feel inconsistent:** confirm `SA_RELAY_ALLOWED_HASH` matches the deployed SA hash and remember that `SA_RELAY_ALLOW_RAW_FORWARD` is off by default, so raw passthrough only works after an explicit server opt-in.
- **Missing explorer base url:** if `VITE_SA_EXPLORER_BASE_URL` is absent, explorer links fall back to the default base URL or may not match your preferred explorer.

### Execution Model Reminder

The typed-data signature authorises a v4 Smart Account runtime call. External interactions must flow
through the canonical v4 entrypoint `executeUserOp` (or `executeUserOps` for a batch); raw direct
proxy-signed external spends are rejected. The `executeUnified` and `executeUnifiedByAddress` wrappers are absent from every v4 manifest and every v4 source file, so a payload naming them cannot execute.

### Matrix Domain Support

The frontend can register a `.matrix` domain in the same wallet transaction as SA creation when the wallet supports batched invocations. Domain resolution is then used as a discovery step: the `.matrix` domain resolves to the controlling wallet address, and the frontend reads the accounts where that wallet is the custody.
