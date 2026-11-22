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
  PROTOCOL_VERSION,
} = require('../src/native');
const { nativeAbi } = require('./helpers/nativeAbi');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const abi = nativeAbi(repoRoot);
const nativeSource = 'contracts/native/SmartAccount';

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

test('the native ABI is the minimal-core v4 surface', () => {
  // The 25 exported entry points of the minimal core (spec §3, §7, §9, §10,
  // §12.5): the configuration family plus the four restricted landing
  // entries behind the module decisions.
  for (const name of [
    'computeAccountIdentity',
    'createAccount',
    'createAccounts',
    'getOperationDigest',
    'validateUserOp',
    'executeUserOp',
    'executeUserOps',
    'getNonce',
    'getNonceSequence',
    'installModule',
    'removeModule',
    'setRecoveryPolicy',
    'setBuiltinAuthorization',
    'revokeModuleCredentials',
    'resetAccount',
    'getModules',
    'getModule',
    'isModuleInstalled',
    'getAuthorizedModuleId',
    'freezeAccount',
    'unfreezeAccount',
    'getProtocolInfo',
    'getAccount',
    'getAccountAddress',
    'getAccountImplementationId',
    'verify',
  ]) {
    if (name === 'computeAccountIdentity') continue; // a pure helper, not a contract method
    assert.ok(abi.has(name), `missing v4 method ${name}`);
  }
  assert.equal([...abi.keys()].length, 25, 'the minimal core exports exactly 25 methods');
  // Removed with the single-slot verifier/hook model, the platform services and
  // the features that moved to user-space modules. There is no alias, so an old
  // caller must fail to resolve rather than silently reach a renamed method.
  for (const name of [
    'registerAccount',
    'registerAccounts',
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
    // Features that are user-space module concerns in the minimal core.
    'proposeConfiguration',
    'confirmConfiguration',
    'cancelConfiguration',
    'getPendingConfiguration',
    'getPendingConfigurationIntentIds',
    'beginRecovery',
    'cancelRecovery',
    'executeRecovery',
    'getRecoveryStatus',
    'isValidSignature',
    'getHookOrder',
    'setHookOrder',
    'revokeCredentials',
    'canonicalP256PublicKey',
    'supportsModuleType',
    'supportsExecutionMode',
    'setThresholdPolicy',
    'getThresholdPolicy',
    'updateMessageSubject',
    'getMessageSubjects',
  ]) {
    assert.equal(abi.has(name), false, `retired method ${name} is still in the ABI`);
  }
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
  const native = csharpSources(nativeSource).map((file) => fs.readFileSync(file, 'utf8'));
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
  // `executeUserOps` takes the operations Array itself, so it declares Array too.
  assert.equal(signatures('executeUserOps')[0].types[1], 'Array');
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
  const native = csharpSources(nativeSource).map((file) => fs.readFileSync(file, 'utf8'));
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

test('every operation event the client requires is declared by the native kernel', () => {
  // `[ContractEvent(hardfork, index, "Name", ...)]`: the name is the third
  // positional argument, there is no `Name =` property in the attribute.
  const declared = new Set(
    [...csharpSources(nativeSource).flatMap((file) => [
      ...fs.readFileSync(file, 'utf8').matchAll(/\[ContractEvent\(\s*[^,]+,\s*\d+\s*,\s*"([A-Za-z0-9_]+)"/g),
    ])].map((match) => match[1]),
  );
  assert.ok(declared.size > 0, 'the native source declares no events');
  for (const name of NATIVE_REQUIRED_EVENTS) assert.ok(declared.has(name), `missing event ${name}`);
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
    const source = fs.readFileSync(file, 'utf8');
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
    const source = fs.readFileSync(file, 'utf8');
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
    const source = stripComments(fs.readFileSync(file, 'utf8'));
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
    new Set(
      csharpSources(directory).flatMap((file) =>
        [...fs.readFileSync(file, 'utf8').matchAll(/"(SA_[A-Z0-9_]+)"/g)].map((match) => match[1]),
      ),
    );
  // The native kernel in contracts/native/SmartAccount is the only kernel left,
  // so it is the sole vocabulary the SDK must map exactly.
  const native = codes(nativeSource);
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
