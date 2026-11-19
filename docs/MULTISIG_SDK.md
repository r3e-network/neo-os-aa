# Threshold SDK and frontend session

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

## Configuring members

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

## Evidence and boundary

`MultiSigSdkVectorTests.cs` runs the actual JS serializer, compares its bytes with VM
`StdLib.Serialize`, rejects shifted and duplicated member entries, and exercises the threshold
routing against a real core operation. The serializer is bounded to 10 members and 65,535 total
bytes; empty hex is a ByteString and is different from null.

SDK unit tests cover member digests, generation binding, malformed signatures and assembly order.
Frontend tests verify RPC Array and base64 ByteArray wire encoding. No generic "multisig complete"
badge is introduced.
