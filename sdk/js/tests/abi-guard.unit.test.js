/**
 * ABI guard: the SDK may only emit contract operations the v4 kernel really
 * declares, with the exact name, arity and declared types, and it may only
 * speak the `SA_*` vocabulary the kernels really raise.
 *
 * Neo N3 method lookup is exact-match (case-sensitive, name plus parameter
 * count), so one wrong casing or arity is a method-not-found FAULT on chain.
 * Three sources are checked against each other:
 *
 * - `tests/fixtures/custom-abi-v4.json`: the checked-in snapshot of every
 *   compiled custom-kernel signature (overloads kept). Hermetic, so the suite
 *   runs without a local build.
 * - `contracts/bin/public/SmartAccount.manifest.json`: the freshly compiled
 *   ABI, compared with the snapshot whenever a build is present, so drift in
 *   the kernel cannot hide behind a stale snapshot.
 * - `contracts/native/SmartAccount/*.cs` and `contracts/custom/**`: the two
 *   kernels' sources, for the error-code vocabulary and for the operation
 *   parameter shape the native build declares.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CUSTOM_IMPLEMENTATION_ID,
  CUSTOM_REQUIRED_ABI,
  SA_ERROR_CODES,
  SA_ERRORS,
} = require('../src/index');
const {
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
  PROTOCOL_VERSION,
} = require('../src/native');
const { declaredType } = require('../../../shared/nativeSmartAccountClient.mjs');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const fixture = require('./fixtures/custom-abi-v4.json');
const compiledPath = path.join(
  repoRoot,
  'contracts',
  'bin',
  'public',
  'SmartAccount.manifest.json',
);

const signature = (method) => ({
  types: method.parameters.map((parameter) => parameter.type),
  names: method.parameters.map((parameter) => parameter.name),
  returntype: method.returntype,
  safe: Boolean(method.safe),
});

/**
 * Line and block comments carry the migration notes that name removed v3
 * operations; only executable text counts as a reference.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every snapshot signature of one name, normalised for comparison. */
const signatures = (name) => (fixture.methods[name] ?? []).map(signature);

/** One canonical string per declared signature, from either source. */
const canonical = (list) =>
  list
    .map((entry) =>
      JSON.stringify(
        signature({
          parameters: entry.parameters ?? entry.types.map((type, index) => ({ name: entry.names[index], type })),
          returntype: entry.returntype,
          safe: entry.safe,
        }),
      ),
    )
    .sort();

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

test('the custom kernel ABI is the v4 surface, not a renamed v3 one', () => {
  const methods = fixture.methods;
  // The v4 protocol entry points, including the intent, module, recovery and
  // migration surfaces (§3, §7, §10, §16).
  for (const name of [
    'computeAccountIdentity',
    'computeRegistrationAccountId',
    'createAccount',
    'createAccounts',
    'getOperationDigest',
    'validateUserOp',
    'executeUserOp',
    'executeUserOps',
    'isValidSignature',
    'getNonce',
    'getNonceSequence',
    'proposeConfiguration',
    'confirmConfiguration',
    'cancelConfiguration',
    'getPendingConfiguration',
    'getPendingConfigurationIntentIds',
    'getModules',
    'getModule',
    'isModuleInstalled',
    'getHookOrder',
    'getAuthorizedModuleId',
    'revokeCredentials',
    'freezeAccount',
    'unfreezeAccount',
    'isAccountFrozen',
    'beginRecovery',
    'cancelRecovery',
    'executeRecovery',
    'getRecoveryStatus',
    'isMigrationRequired',
    'markMigrationRequired',
    'getMigrationState',
    'setMetadataUri',
    'getMetadataUri',
    'getProtocolInfo',
    'getAccount',
    'getAccountImplementationId',
    'verify',
  ]) {
    assert.ok(methods[name], `missing v4 method ${name}`);
  }
  // Removed with the single-slot verifier/hook model: there is no alias, so a
  // v3 caller must fail to resolve rather than silently reach a renamed method.
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
  ]) {
    assert.equal(methods[name], undefined, `v3 method ${name} is still in the ABI`);
  }
});

test('the compiled v4 ABI and the checked-in snapshot agree', () => {
  if (!fs.existsSync(compiledPath)) return;
  const compiled = JSON.parse(fs.readFileSync(compiledPath, 'utf8'));
  const fresh = {};
  for (const method of compiled.abi.methods) (fresh[method.name] ??= []).push(signature(method));
  assert.deepEqual(
    Object.keys(fresh).sort(),
    Object.keys(fixture.methods).sort(),
    'regenerate sdk/js/tests/fixtures/custom-abi-v4.json: the kernel ABI changed',
  );
  for (const name of Object.keys(fresh)) {
    assert.deepEqual(canonical(fresh[name]), canonical(fixture.methods[name]), name);
  }
  assert.deepEqual(
    compiled.abi.events.map((event) => event.name).sort(),
    fixture.events,
    'regenerate the snapshot: the kernel event surface changed',
  );
});

test('every SDK-required operation is declared once with the exact shape', () => {
  // The shared gate pins parameter names as well as types; the custom-only gate
  // pins the custom services this client builds and reads.
  for (const [name, [types, returntype, safe, names]] of Object.entries(NATIVE_REQUIRED_ABI)) {
    const declared = signatures(name);
    const match = declared.find(
      (entry) =>
        entry.returntype === returntype &&
        entry.safe === safe &&
        entry.types.length === types.length &&
        types.every((type, index) => declaredType(type, entry.types[index])) &&
        names.every((parameter, index) => entry.names[index] === parameter),
    );
    assert.ok(match, `shared gate requires ${name}(${types.join(',')}) -> ${returntype}`);
  }
  for (const [name, [types, returntype]] of Object.entries(CUSTOM_REQUIRED_ABI)) {
    const match = signatures(name).find(
      (entry) =>
        entry.returntype === returntype &&
        entry.types.length === types.length &&
        types.every((type, index) => declaredType(type, entry.types[index])),
    );
    assert.ok(match, `custom gate requires ${name}(${types.join(',')}) -> ${returntype}`);
    assert.equal(signatures(name).length, 1, `${name} must not be overloaded`);
  }
});

test('the operation argument is a compound the client always serializes as an Array', () => {
  // Spec §4: one operation is one Array of thirteen items. The native build
  // declares `Array`; the custom build's compiler infers `Any` from its
  // `object operation` parameter. The gate tolerates exactly that pair, and the
  // native source must not drift to anything weaker. These are the only six
  // declarations in the compiled custom ABI that name `Any`:
  // `_deploy` (framework hook, never called by the SDK) and the five entry
  // points that take one serialized operation.
  for (const name of ['getOperationDigest', 'validateUserOp', 'executeUserOp', 'isValidSignature']) {
    const [entry] = signatures(name);
    const index = entry.types.findIndex((type) => type === 'Array' || type === 'Any');
    assert.ok(index >= 0, `${name} must declare a compound operation parameter`);
    assert.equal(entry.types[index], 'Any', `${name} still declares the compiler-inferred parameter`);
  }
  // The sponsored entry point takes the same single operation in the middle.
  assert.equal(signatures('executeSponsoredUserOp')[0].types[1], 'Any');
  // `executeUserOps` takes the operations Array itself, so it declares Array.
  assert.equal(signatures('executeUserOps')[0].types[1], 'Array');
  assert.equal(declaredType('Array', 'Array'), true);
  assert.equal(declaredType('Array', 'Any'), true);
  // Nothing else is interchangeable, in either direction.
  assert.equal(declaredType('Any', 'Array'), false);
  assert.equal(declaredType('ByteArray', 'Any'), false);
  assert.equal(declaredType('Array', 'Struct'), false);
  assert.equal(declaredType('Hash160', 'ByteArray'), false);
  // No other method may hide behind `Any`: the tolerance is not a general one.
  const inferred = [
    'getOperationDigest',
    'validateUserOp',
    'executeUserOp',
    'executeSponsoredUserOp',
    'isValidSignature',
    '_deploy',
  ];
  for (const [name, list] of Object.entries(fixture.methods)) {
    for (const entry of list) {
      if (!entry.parameters.some((parameter) => parameter.type === 'Any')) continue;
      assert.ok(inferred.includes(name), `${name} declares Any outside the documented operation parameter`);
    }
  }
  const native = csharpSources('contracts/native/SmartAccount').map((file) => fs.readFileSync(file, 'utf8'));
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

test('every operation string the SDK emits exists in the compiled ABI', () => {
  const files = [
    path.join(__dirname, '..', 'src', 'index.js'),
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
  assert.ok(emitted.size >= 30, `only ${emitted.size} operations found in the SDK source`);
  for (const [name, file] of emitted) {
    assert.ok(fixture.methods[name], `${file} emits ${name}, which the v4 ABI does not declare`);
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

test('the SA_* vocabulary is exactly the vocabulary both kernels raise', () => {
  assert.equal(PROTOCOL_VERSION, 4);
  assert.equal(CUSTOM_IMPLEMENTATION_ID, 'org.r3e.neo.smart-account.v4');
  const codes = (directory) =>
    new Set(
      csharpSources(directory).flatMap((file) =>
        [...fs.readFileSync(file, 'utf8').matchAll(/"(SA_[A-Z0-9_]+)"/g)].map((match) => match[1]),
      ),
    );
  const custom = codes('contracts/custom');
  const native = codes('contracts/native/SmartAccount');
  const sdk = new Set(SA_ERROR_CODES);
  assert.ok(sdk.size >= 40, `only ${sdk.size} SA_* codes are mapped`);
  assert.deepEqual([...sdk].sort(), [...native].sort(), 'SDK and native kernel vocabularies differ');
  for (const code of custom) assert.ok(sdk.has(code), `custom kernel raises unmapped ${code}`);
  // The map is bidirectional: the name resolves back to its own index.
  SA_ERROR_CODES.forEach((name, index) => {
    assert.equal(SA_ERRORS[name] && index >= 0, true, `${name} has no message`);
  });
});
