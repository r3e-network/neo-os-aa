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

## Recovery policy and the owner-only latch

A v4 account has no escape-hatch payload and no plugin roots to remove. `getAccount(accountId)`
returns the control record, including `recoveryAuthority`, `recoveryTimelockMs` and
`ownerOnlyRecovery`. The core carries no action that sets a recovery authority: that slot is changed
by a governance module, which runs its own maturity window before it submits the change.

`ownerOnlyRecovery` is a legacy migration latch, monotonic and permanent: once set it never clears,
and the core refuses every action that touches the module model, so such an account can never
install, configure or uninstall a module. Read it before planning any module work.

```js
const state = await client.getAccount(accountId);
if (state.ownerOnlyRecovery) throw new Error('This account cannot change its modules');
```

Recovery belongs to the recovery module: `beginRecovery(accountId)`, then the permissionless
`executeRecovery(accountId)` once the timelock the module read when the recovery started has passed.
That module preserves account identity, the asset address and the nonce channels; the core exposes
no recovery entry, so a caller that needs recovery targets the module's script hash.
