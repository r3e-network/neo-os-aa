# SDK package contract

`@r3e-network/neo-smart-account` must work after installing its npm tarball into a project
outside this repository with production dependencies only. The supported public
entrypoint remains `@r3e-network/neo-smart-account`, available through CommonJS `require`
and ESM named/default imports, with TypeScript declarations resolved by package name.
Internal source paths are not public exports.

The repository's `sdk/js/src` and `shared` directories remain canonical. A
`npm run build` (using only Node.js and installed production dependencies) recreates ignored `dist` output with the same
relative layout (`dist/sdk/js/src` and `dist/shared`). This preserves the shared
account-id, signing-data and transfer-result implementations without rewriting
imports or maintaining a second source copy. The build loads the copied public
entrypoint and generates an ESM wrapper from its actual exports, avoiding Node's
partial inference of CommonJS named exports. Package entrypoints resolve inside
`dist`; only JavaScript modules, declarations and the license are copied. A build fails for
missing source directories or symbolic links, and removes stale output first.
No contracts, deployment records, environment files or test fixtures are shipped.

`npm pack` and `npm publish` run this build through `prepack`. No installation hook
or development dependency is needed by a tarball consumer. Node.js 22.12 or later
is required for [synchronous CommonJS loading of the shared ES modules](https://nodejs.org/en/blog/release/v22.12.0).
The package
does not contact a node until the consumer invokes an RPC operation.

From `sdk/js`, validate a candidate with:

```sh
npm ci
npm test
npm run types:check
npm run test:package
npm run audit:prod
```

The package test packs the actual checkout twice, checks byte-identical tarballs,
installs a tarball in an operating-system temporary directory with `--omit=dev`,
imports every public entrypoint through CommonJS and ESM, exercises local account
derivation/signing-data/transfer-result paths, checks module-path confinement and
type-checks CommonJS and ESM consumers without monorepo path aliases. Registry connectivity or a
warm npm cache is required to install the declared production dependencies; a
failed installation is a failed gate. No blockchain writes occur.

For downstream consumers:

```js
const { SmartAccountClient } = require('@r3e-network/neo-smart-account');
const client = new SmartAccountClient({
  rpcUrl: 'http://127.0.0.1:10332',
  contractHash: '11'.repeat(20),
  networkMagic: 894710606,
});
const identity = client.deriveIdentity({
  custodyAddress: '22'.repeat(20),
  salt: 'aa'.repeat(16),
});
// identity.accountId is 40 lowercase hexadecimal characters; no RPC call is made.
```

Imports of the previous bare package name `smart-account` need to migrate to the
scoped package name. Direct imports from `src` were
already blocked by the export map and remain unsupported. Build and tarball
artifacts are disposable; edit canonical source and rebuild. These checks establish
local package usability, not npm publication or deployed-contract compatibility.

## Native v4 recovery

For an immediate change to several settings on one active account, use
`await client.buildConfigurationBatchPlan({ accountId, actions })`. Each action names its
method: `installModule`, `removeModule`, `setBuiltinAuthorization` or `setRecoveryPolicy`.
The SDK reads the account, lists custody and each newly appointed recovery address in
`plan.signers`, and preserves the order you supplied. Use the same input and
`buildConfigurationBatchPlan` as the transaction review recipe. For a change that should
wait 24 hours, submit a proposal to the standard governance module instead.

Use the native client for this profile. Registration can install a recovery seat but does not set a recovery authority. Check both the installed seat and the authority before telling the holder that recovery is available. The SDK's reviewed recovery flow requires the standard seat with the expected code and core binding. An installed third-party seat has its own rules.

The core's `setRecoveryPolicy(accountId, recoveryAuthority, recoveryTimelockMs, ownerOnlyRecovery)` updates the account record. The current administrator authorizes the change; a different recovery wallet must also witness its appointment. The delay is 7–90 days. `ownerOnlyRecovery` is a retained record field with no authorization meaning: the only legal input is `false`, `true` is rejected with `SA_OPERATION_MALFORMED`, and the SDK never displays it as an "owner-only recovery" promise.

On the standard seat, `beginRecovery(accountId, newCustody)` snapshots the delay, recovery authority and authority epoch. Zero keeps the current custody; a nonzero incoming custody must witness the proposal. Once mature, anyone may pay for completion, but execution fails with `SA_EPOCH_STALE` if the authority or delay changed after the request began. Read `getRecoveryPolicySnapshot(accountId)` from the seat to compare the live policy with the pending request. Changing the authority revokes old requests, changing the delay retires them, and writing the same values again leaves them executable (though a reviewed transaction must be reviewed again because the configuration nonce advances). A successful reset keeps the account ID and funding address, clears nonce channels and installed seats, advances the authority epoch and clears the recovery authority. Set up and verify recovery again after a reset.
