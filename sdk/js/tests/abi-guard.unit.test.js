/**
 * ABI guard: the SDK may only emit contract operations the v4 native kernel
 * really declares, with the exact name, arity and declared types, and it may
 * only speak the `SA_*` vocabulary the kernel really raises.
 *
 * Neo N3 method lookup is exact-match (case-sensitive, name plus parameter
 * count), so one wrong casing or arity is a method-not-found FAULT on chain.
 * Two sources are checked against each other:
 *
 * - `contracts/native/SmartAccount/*.cs`: the true source of the kernel, and
 *   therefore of the ABI the core publishes (a native contract has no compiled
 *   manifest artifact — see `helpers/nativeAbi.js`).
 * - the SDK and shared modules: every operation string they emit, and every
 *   signature the discovery gate requires.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SA_ERROR_CODES, SA_ERRORS } = require('../src/index');
const {
  NATIVE_ACCOUNT_ADDRESS_ABI,
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
  NATIVE_PROFILE_PARAMETER_DIGEST,
  PROTOCOL_VERSION,
} = require('../src/native');
const { nativeAbi } = require('./helpers/nativeAbi');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const abi = nativeAbi(repoRoot);
const nativeSource = 'contracts/native/SmartAccount';

/**
 * Repo text with `core.autocrlf=true` is checked out as CRLF while the index is
 * LF, so any line-oriented comparison (splitting on `\n`, `$` anchors) would see
 * a trailing `\r`. Normalize at the read site: the test compares content, not the
 * platform's checkout style.
 */
const readText = (file, encoding = 'utf8') => fs.readFileSync(file, encoding).replace(/\r\n/g, '\n');

/** Every declared signature of one name, normalised for comparison. */
const signatures = (name) => abi.get(name) ?? [];

const REQUIRED = { ...NATIVE_REQUIRED_ABI, ...NATIVE_ACCOUNT_ADDRESS_ABI };

/**
 * Line and block comments carry the migration notes that name removed v3
 * operations; only executable text counts as a reference.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function csharpSources(directory) {
  return fs
    .readdirSync(path.join(repoRoot, directory), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? csharpSources(path.join(directory, entry.name))
        : entry.name.endsWith('.cs')
          ? [path.join(repoRoot, directory, entry.name)]
          : [],
    );
}

test('native client and core pin the canonical atomic-configuration parameters', () => {
  const crypto = require('node:crypto');
  const params = JSON.parse(readText(path.join(repoRoot, 'docs/proposals/smartaccount-native-profile-parameters.json')));
  const canonical = JSON.stringify(params, Object.keys(params).sort());
  const digest = crypto.createHash('sha256').update('NeoSmartAccount/Profile').update(Buffer.from([4])).update(canonical).digest('hex');
  assert.deepEqual(params.configurationCoreActions, [1, 2, 5]);
  assert.deepEqual(params.governanceOnlyCoreActions, [3, 7]);
  assert.equal(params.configurationActionsMax, 16);
  assert.equal(NATIVE_PROFILE_PARAMETER_DIGEST, digest);
  assert.ok(readText(path.join(repoRoot, nativeSource, 'SmartAccount.cs'), 'utf8').includes('ParameterDigest = "' + digest + '"'));
});

test('the standard recovery module pins follow the profile parameters', () => {
  // The NEF and manifest of the reviewed standard RecoveryModule are part of
  // the protocol identity: the same checked-in profile parameters that feed
  // the fingerprint carry their hashes, so the client constants and the
  // derived profile can never disagree.
  const params = JSON.parse(
    readText(path.join(repoRoot, 'docs/proposals/smartaccount-native-profile-parameters.json')),
  );
  const {
    NATIVE_STANDARD_RECOVERY_NEF_SHA256,
    NATIVE_STANDARD_RECOVERY_MANIFEST_SHA256,
    NATIVE_STANDARD_RECOVERY_PROFILE_SHA256,
  } = require('../src/native/client');
  assert.match(NATIVE_STANDARD_RECOVERY_NEF_SHA256, /^[0-9a-f]{64}$/);
  assert.match(NATIVE_STANDARD_RECOVERY_MANIFEST_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(NATIVE_STANDARD_RECOVERY_NEF_SHA256, params.recoveryNefSha256);
  assert.equal(NATIVE_STANDARD_RECOVERY_MANIFEST_SHA256, params.recoveryManifestSha256);
  // The core publishes the descriptor's profile hash as SHA-256 of the exact
  // getModuleProfile() bytes, and the reviewed-seat check refuses a seat whose
  // hash differs. That pin is therefore derived, never typed: it is the hash of
  // the profile literal the standard recovery module returns.
  const recoverySource = readText(path.join(repoRoot, 'contracts/modules/RecoveryModule/RecoveryModule.cs'));
  const profileLiteral = /ModuleProfileJson\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/.exec(recoverySource);
  assert.ok(profileLiteral, 'the standard recovery module must publish a literal module profile');
  assert.equal(
    NATIVE_STANDARD_RECOVERY_PROFILE_SHA256,
    require('node:crypto').createHash('sha256').update(JSON.parse('"' + profileLiteral[1] + '"')).digest('hex'),
    'the reviewed-seat profile pin must be the hash of the profile the module returns',
  );
});

test('the native ABI is the frozen v4.1 surface', () => {
  // The 26 entry points of the v4.1 core. The manifest fixture is the published
  // surface (`scripts/check_smartaccount_v41_idl.py` proves it is the IDL's);
  // the C# declarations are the source the chain projects it from.
  const surface = [
    'createAccount',
    'createAccounts',
    'getAccount',
    'getAccountAddress',
    'freezeAccount',
    'unfreezeAccount',
    'executeUserOp',
    'validateUserOp',
    'validateMember',
    'verify',
    'getOperationDigest',
    'getNonce',
    'getNonceSequence',
    'installModule',
    'removeModule',
    'configureModule',
    'setBuiltinAuthorization',
    'applyConfigurationActions',
    'revokeModuleCredentials',
    'resetAccount',
    'getModules',
    'getModule',
    'isModuleInstalled',
    'getAuthorizedModuleId',
    'getProtocolInfo',
    'getAccountImplementationId',
  ];
  const manifest = require('../../../tests/fixtures/native-smartaccount.manifest.json');
  assert.deepEqual(manifest.abi.methods.map(({ name }) => name).sort(), [...surface].sort());
  for (const name of surface) {
    assert.ok(abi.has(name), `missing v4.1 method ${name}`);
  }
  // Retired: the single-slot verifier/hook model, the platform services, the
  // native message/threshold/recovery-policy surface (now SigningModule,
  // ThresholdPolicyModule and RecoveryModule) and the features that moved to
  // user-space modules. There is no alias, so an old caller must fail to
  // resolve rather than silently reach a renamed method.
  const published = new Set(surface);
  for (const name of [
    // The v4.0 batch execution entry: physically deleted, not aliased onto
    // executeUserOp, so a caller that still builds a list fails to resolve.
    'executeUserOps',
    'registerAccount',
    'registerAccounts',
    'computeAccountIdentity',
    'updateVerifier',
    'confirmVerifierUpdate',
    'cancelVerifierUpdate',
    'getVerifier',
    'hasPendingVerifierUpdate',
    'hasPendingVerifierCall',
    'getPendingVerifierUpdateTime',
    'updateHook',
    'confirmHookUpdate',
    'cancelHookUpdate',
    'getHook',
    'hasPendingHookUpdate',
    'hasPendingHookCall',
    'callVerifier',
    'callHook',
    'setVerifyScopeTarget',
    'setVerifyScopeTargets',
    'getVerifyScopeTarget',
    'canConfigureVerifier',
    'canConfigureHook',
    'canExecuteVerifier',
    'canExecuteHook',
    'initiateEscape',
    'finalizeEscape',
    'getBackupOwner',
    'getEscapeTimelock',
    'isEscapeActive',
    'previewUserOpValidation',
    'getProxyScriptHash',
    'executeSponsoredUserOp',
    'setMetadataUri',
    'getMetadataUri',
    'isMigrationRequired',
    'markMigrationRequired',
    'getMigrationState',
    // Features that are user-space module concerns in the v4.1 core.
    'proposeConfiguration',
    'confirmConfiguration',
    'cancelConfiguration',
    'getPendingConfiguration',
    'getPendingConfigurationIntentIds',
    'beginRecovery',
    'cancelRecovery',
    'executeRecovery',
    'getRecoveryStatus',
    'getRecoveryPolicySnapshot',
    'setRecoveryPolicy',
    'getHookOrder',
    'setHookOrder',
    'revokeCredentials',
    'canonicalP256PublicKey',
    'supportsModuleType',
    'supportsExecutionMode',
    'setThresholdPolicy',
    'getThresholdPolicy',
    'getMessageSubjects',
    'updateMessageSubject',
    'getUserOpDigest',
    'getConfigurationNonce',
  ]) {
    assert.equal(published.has(name), false, `retired method ${name} is still published`);
  }
  // Message signature verification has exactly one route: the active signing
  // module's own entry point. The native client must not reach a core method.
  const client = readText(path.join(repoRoot, 'shared', 'nativeSmartAccountClient.mjs'));
  assert.equal(
    /nativeCall\([^)]*['"]isValidSignature['"]/.test(client),
    false,
    'the native client must not call a core isValidSignature',
  );
  assert.match(client, /MESSAGE_VERIFY_METHOD\s*=\s*["']isValidSignature["']/, 'the module entry is a named constant');
});

test('every SDK-required operation is declared once with the exact shape', () => {
  for (const [name, [types, returntype, safe, names]] of Object.entries(REQUIRED)) {
    const declared = signatures(name);
    assert.equal(declared.length, 1, `${name} must be declared exactly once`);
    const [entry] = declared;
    assert.deepEqual(entry.types, [...types], `${name} parameter types`);
    assert.deepEqual(entry.names, [...names], `${name} parameter names`);
    assert.equal(entry.returntype, returntype, `${name} return type`);
    assert.equal(entry.safe, safe, `${name} safe flag`);
  }
});

test('the native-only account address query is declared by the native kernel', () => {
  const native = csharpSources(nativeSource).map((file) => readText(file, 'utf8'));
  for (const [name, [types, returntype, safe, names]] of Object.entries(
    NATIVE_ACCOUNT_ADDRESS_ABI,
  )) {
    assert.equal(types.length, names.length, `${name} parameter types and names must agree`);
    const declaration = native
      .flatMap((source) => [...source.matchAll(/\bpublic UInt160 GetAccountAddress\(([^)]*)\)/g)])
      .map((match) => match[1]);
    assert.equal(declaration.length, 1, `native kernel must declare exactly one ${name}`);
    assert.match(declaration[0], /\bUInt160\b/, `${name} takes a Hash160 account id`);
    // The published `safe` flag is the compiler's projection of the attribute, so
    // a method that stopped being ReadStates would be exported as a write.
    const attributed = native.flatMap((source) =>
      [...source.matchAll(/\[ContractMethod\([^\]]*\)\][\s\S]{0,400}?\bpublic UInt160 GetAccountAddress\(/g)].map(
        (match) => match[0],
      ),
    );
    assert.equal(attributed.length, 1, `native ${name} must be an exported contract method`);
    assert.match(attributed[0], /CallFlags\.ReadStates/, `native ${name} must be a pure read`);
    assert.deepEqual([...types], ['Hash160']);
    assert.deepEqual([...names], ['accountId']);
    assert.equal(returntype, 'Hash160');
    assert.equal(safe, true, `${name} is a read`);
  }
});

test('the operation argument is a compound the client always serializes as an Array', () => {
  // Spec §4: one operation is one Array of thirteen items, and the native core
  // declares exactly that. No parameter may be the untyped `Any`.
  for (const name of ['getOperationDigest', 'validateUserOp', 'executeUserOp']) {
    const [entry] = signatures(name);
    assert.deepEqual(entry.types.slice(1).filter((type) => type === 'Array').length, 1, name);
  }
  // `executeUserOps` took the operations Array itself; that entry is retired, so
  // the surface carries exactly one execute entry and it takes one operation.
  assert.equal(abi.has('executeUserOps'), false, 'the batch entry must not be published');
  assert.equal(REQUIRED.executeUserOps, undefined, 'the client must not require the batch entry');
  assert.ok(
    !Object.keys(REQUIRED).includes('executeUserOps'),
    'NATIVE_REQUIRED_ABI must carry exactly the 26 single-operation methods',
  );
  // REQUIRED is the discovery gate's whole surface: 25 core entries plus the
  // native-only account address query, exactly the 26 methods the IDL publishes.
  assert.equal(Object.keys(REQUIRED).length, 26);
  assert.deepEqual(
    Object.keys(REQUIRED).sort(),
    require('../../../tests/fixtures/native-smartaccount.manifest.json').abi.methods
      .map(({ name }) => name)
      .sort(),
    'the discovery gate requires exactly the published 26 methods',
  );
  for (const [name, entries] of abi) {
    for (const entry of entries) {
      assert.equal(
        entry.types.includes('Any'),
        false,
        `${name} declares an untyped Any parameter; the operation is an Array`,
      );
    }
  }
  // The native build declares `Array` on the entry points themselves.
  const native = csharpSources(nativeSource).map((file) => readText(file, 'utf8'));
  for (const method of ['GetOperationDigest', 'ValidateUserOp', 'ExecuteUserOp']) {
    // Declarations wrap, so the parameter list is matched across lines.
    const declaration = native
      .flatMap((source) => [...source.matchAll(new RegExp(`\\b${method}\\(([^)]*)\\)`, 'g'))])
      .map((match) => match[1])
      .find((parameters) => parameters.includes('UInt160'));
    assert.ok(declaration, `native ${method} is not declared`);
    assert.match(declaration, /\bArray\b/, `native ${method} must take a serialized Array`);
  }
});

test('wallet discovery and the native kernel declare exactly the same events', () => {
  // `[ContractEvent(hardfork, index, "Name", ...)]`: the name is the third
  // positional argument, there is no `Name =` property in the attribute.
  const declared = new Set(
    [...csharpSources(nativeSource).flatMap((file) => [
      ...readText(file, 'utf8').matchAll(/\[ContractEvent\(\s*[^,]+,\s*\d+\s*,\s*"([A-Za-z0-9_]+)"/g),
    ])].map((match) => match[1]),
  );
  assert.ok(declared.size > 0, 'the native source declares no events');
  assert.deepEqual([...NATIVE_REQUIRED_EVENTS].sort(), [...declared].sort());
});

test('both protocol event tables match the manifest emitted by the native build', () => {
  const { abi } = require('../../../tests/fixtures/native-smartaccount.manifest.json');
  const expected = abi.events.map(({ name, parameters }) =>
    `| \`${name}\` | ${parameters.map(p => `\`${p.name}: ${p.type}\``).join(', ')} |`);
  for (const doc of ['SA-MODULE-PROTOCOL.md', 'SA-MODULE-PROTOCOL.zh-CN.md']) {
    const section = readText(path.join(repoRoot, 'docs', doc), 'utf8')
      .split(/^## 18\. /m)[1].split(/^---$/m)[0];
    assert.deepEqual(section.split('\n').filter(line => line.startsWith('| `')), expected, doc);
  }
});

test('every operation string the SDK emits exists in the native ABI', () => {
  const files = [
    path.join(__dirname, '..', 'src', 'index.js'),
    path.join(__dirname, '..', 'src', 'native.js'),
    path.join(repoRoot, 'shared', 'nativeSmartAccountClient.mjs'),
    path.join(repoRoot, 'shared', 'nativeTransactionArtifact.mjs'),
  ];
  const emitted = new Map();
  for (const file of files) {
    const source = readText(file, 'utf8');
    // Reads are dispatched by name; plan builders pass literal contract calls.
    for (const [, name] of source.matchAll(/_read\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
      emitted.set(name, path.basename(file));
    }
    for (const [, name] of source.matchAll(/dynamicCall\(\s*(?:[^,()]+(?:\([^)]*\))?)\s*,\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
      emitted.set(name, path.basename(file));
    }
  }
  // The scan must find the surface; an empty map would make this test vacuous.
  for (const name of ['getAccount', 'getOperationDigest', 'validateUserOp', 'getProtocolInfo']) {
    assert.ok(emitted.has(name), `the scan did not find ${name} in the SDK source`);
  }
  for (const [name, file] of emitted) {
    assert.ok(abi.has(name), `${file} emits ${name}, which the v4 ABI does not declare`);
  }
  // A read through invokescript must be declared safe: an unsafe method is a
  // state change requested by a read path.
  for (const file of files) {
    const source = readText(file, 'utf8');
    for (const [, name] of source.matchAll(/_read\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) {
      const [entry] = signatures(name);
      assert.equal(entry?.safe, true, `${name} is read but not safe`);
    }
  }
});

test('the SDK source carries no removed v3 operation', () => {
  const files = [
    ...fs.readdirSync(path.join(__dirname, '..', 'src')).map((name) => path.join(__dirname, '..', 'src', name)),
    ...fs.readdirSync(path.join(__dirname, '..', 'src', 'native')).map((name) =>
      path.join(__dirname, '..', 'src', 'native', name),
    ),
    ...fs.readdirSync(path.join(repoRoot, 'shared')).map((name) => path.join(repoRoot, 'shared', name)),
  ].filter((file) => /\.(?:m?js|ts)$/.test(file));
  const removed = [
    'registerAccount',
    'updateVerifier',
    'confirmVerifierUpdate',
    'cancelVerifierUpdate',
    'updateHook',
    'confirmHookUpdate',
    'cancelHookUpdate',
    'getVerifier',
    'hasPendingVerifierUpdate',
    'setVerifyScopeTarget',
    'createAccountPayload',
    'createSponsoredUserOpPayload',
    'buildLegacyOperationView',
    'supportsV3',
    'clearAccount',
    'buildCustomActionScript',
    'CUSTOM_REQUIRED_ABI',
    'CUSTOM_IMPLEMENTATION_ID',
    'CUSTOM_PROXY_CALL_FLAGS',
  ];
  for (const file of files) {
    const source = stripComments(readText(file, 'utf8'));
    for (const name of removed) {
      assert.equal(
        new RegExp(`\\b${name}\\b`).test(source),
        false,
        `${path.relative(repoRoot, file)} still references removed v3 ${name}`,
      );
    }
  }
});

test('the SA_* vocabulary is exactly the vocabulary the native kernel raises', () => {
  assert.equal(PROTOCOL_VERSION, 4);
  const codes = (directory) =>
    csharpSources(directory).flatMap((file) =>
      [...readText(file, 'utf8').matchAll(/"(SA_[A-Z0-9_]+)"/g)].map((match) => match[1]),
    );
  // The kernel and its user-space modules are the vocabulary the SDK maps: the
  // core owns the operation/account codes, the modules the policy codes.
  const native = new Set([...codes(nativeSource), ...codes('contracts/modules')]);
  const sdk = new Set(SA_ERROR_CODES);
  // The minimal core raises exactly thirty-three distinct codes; the floor keeps
  // a wholesale truncation of the map from passing the set comparison below.
  assert.ok(sdk.size >= 33, `only ${sdk.size} SA_* codes are mapped`);
  assert.deepEqual([...sdk].sort(), [...native].sort(), 'SDK and native kernel vocabularies differ');
  // The map is bidirectional: the name resolves back to its own index.
  SA_ERROR_CODES.forEach((name, index) => {
    assert.equal(SA_ERRORS[name] && index >= 0, true, `${name} has no message`);
  });
});
