# SDK package contract

`neo-abstract-account` must work after installing its npm tarball into a project
outside this repository with production dependencies only. The supported public
entrypoint remains `neo-abstract-account`, available through CommonJS `require`
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
const { AbstractAccountClient } = require('neo-abstract-account');
const client = new AbstractAccountClient('http://127.0.0.1:10332', '11'.repeat(20));
const accountId = client.deriveRegistrationAccountIdHash({
  backupOwnerAddress: '22'.repeat(20),
});
// accountId is 40 lowercase hexadecimal characters; no RPC call is made.
```

Existing package-name imports need no migration. Direct imports from `src` were
already blocked by the export map and remain unsupported. Build and tarball
artifacts are disposable; edit canonical source and rebuild. These checks establish
local package usability, not npm publication or deployed-contract compatibility.

## Ordinary owner-only recovery

`AbstractAccountClient.getOwnerOnlyRecoveryStatus(accountId)` checks the deployed
core's exact recovery ABI before reading permanent mode. It returns
`{ supported: false, ownerOnlyRecovery: null }` for an old or incompatible ABI;
with matching support it returns a strict Boolean mode. RPC faults and malformed
responses throw. This check is current deployment capability, not a release or
protocol-activation proof.

After initiating escape and waiting for its timelock, build a direct core call:

```js
const status = await client.getOwnerOnlyRecoveryStatus(accountId);
if (!status.supported) throw new Error('This deployment does not support owner-only recovery');
const payload = client.createFinalizeEscapeToOwnerPayload({ accountScriptHash: accountId });
// Send payload through the backup owner's wallet as a direct core invocation.
```

Use the account ID, never its asset proxy address. Payload construction does not
sign, submit or verify deployment support. Successful recovery permanently
removes both plugin roots and forbids plugin reinstallation, including after an
owner transfer. It preserves account identity, asset address and nonce channels;
it does not refund plugin-held balances or revoke external allowances. It is an
ordinary contract capability and does not use native recovery or a UserOperation.
