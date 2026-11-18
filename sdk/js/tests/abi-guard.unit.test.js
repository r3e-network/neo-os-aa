/**
 * ABI guard: every contract operation string the SDK emits must exist in the
 * compiled contract manifests, with matching arity where verifiable.
 *
 * Neo N3 method lookup is exact-match (case-sensitive, name + parameter
 * count), so a single wrong casing or arity silently produces a
 * method-not-found FAULT on-chain. This guard would have caught the six
 * phantom PascalCase operations (SetMetadataUri, ConfirmHookUpdate,
 * ConfirmVerifierUpdate, CancelHookUpdate, CancelVerifierUpdate,
 * IsAnyExecutionActive) the SDK used to emit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SmartAccountClient } = require('../src/index');
const neonCompat = require('../src/neonCompat');
const { createHash } = require('node:crypto');
const recoveryStateFixture = require('./fixtures/ordinary-owner-only-contract-state.json');
const discoveryStateFixture = require('./fixtures/ordinary-candidate-discovery-contract-state.json');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const indexSourcePath = path.join(repoRoot, 'sdk', 'js', 'src', 'index.js');

const MASTER_HASH = '1234567890123456789012345678901234567890';
const PAYMASTER_HASH = 'fedcba9876543210fedcba9876543210fedcba98';
const ACCOUNT_HASH = '0xf951cd3eb5196dacde99b339c5dcca37ac38cc22';
const MODULE_HASH = '0xb4107cb2cb4bace0ebe15bc4842890734abe133a';
const TARGET_HASH = '0x49c095ce04d38642e39155f5481615c58227a498';

function loadAbiMethods(manifestFileName) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'contracts', 'build', manifestFileName), 'utf8'));
  const methods = new Map();
  for (const method of manifest.abi.methods) {
    if (!methods.has(method.name)) methods.set(method.name, new Set());
    methods.get(method.name).add((method.parameters || []).length);
  }
  return methods;
}

const walletAbi = loadAbiMethods('SmartAccount.manifest.json');
const paymasterAbi = loadAbiMethods('SAPaymaster.manifest.json');

// Optional methods are backed by the complete candidate manifest and its
// source-to-artifact receipt, not promoted into the deployed 90-method ABI.
const candidateFixturePath = path.join(__dirname, 'fixtures', 'ordinary-owner-only-candidate.manifest.json');
const candidateBytes = fs.readFileSync(candidateFixturePath);
const candidateManifest = JSON.parse(candidateBytes);
const candidateRecoveryMethods = recoveryStateFixture.manifest.abi.methods;
// Discovery/simulation reads are likewise candidate-only until the upgraded
// core deploys; they ship in their own capability fixture.
const candidateCapabilityMethods = [
  ...candidateRecoveryMethods,
  ...discoveryStateFixture.manifest.abi.methods,
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const descriptor = (method) => ({
  name: method.name, parameters: method.parameters, returntype: method.returntype, safe: method.safe,
});

function assertCandidateEvidence(bytes = candidateBytes) {
  const compatibility = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/reports/sa-ordinary-candidate-compatibility-20261118.json')));
  const reproducibility = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs/reports/sa-artifact-reproducibility-20261118.json')));
  const manifestReceipt = reproducibility.profiles.v3.artifacts.filter((entry) => entry.artifact === 'SmartAccount.manifest.json');
  assert.equal(manifestReceipt.length, 1);
  assert.equal(reproducibility.release_matches_fresh_build, true);
  assert.equal(manifestReceipt[0].match, true);
  assert.equal(manifestReceipt[0].expected_sha256, manifestReceipt[0].actual_sha256);
  assert.equal(sha256(bytes), manifestReceipt[0].actual_sha256, 'candidate fixture must be the reproducibly compiled manifest');
  assert.equal(sha256(bytes), compatibility.candidateArtifact.manifestSha256);
  const publicBytes = fs.readFileSync(path.join(repoRoot, 'contracts/build/SmartAccount.manifest.json'));
  assert.equal(sha256(publicBytes), '24c4710a8ac00a3df236d2a08509726dbe2745174abf833dd52e26d89b03b1b4', 'pinned public artifact is unchanged');
  assert.equal(sha256(publicBytes), compatibility.pinnedArtifact.manifestSha256);
  assert.equal(JSON.parse(publicBytes).abi.methods.length, 90);
  assert.equal(JSON.parse(bytes).abi.methods.length, compatibility.candidateArtifact.abiEntries);
  // Fail if the checked-in compilation source diverges from the receipt that
  // supplies this candidate. No local bin/ directory or compiler is required.
  // The certificate pins the LF form of each text input (see
  // scripts/check-artifact-reproducibility.mjs), so an autocrlf worktree — which
  // materialises CRLF bytes for the same committed content — must hash the same
  // normalized form; on an LF checkout this is byte-for-byte a no-op.
  const sha256LfText = (file) => sha256(Buffer.from(fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n'), 'utf8'));
  for (const [relative, digest] of Object.entries(reproducibility.certificate.source_files)) {
    assert.equal(sha256LfText(path.join(repoRoot, relative)), digest, `candidate source drift: ${relative}`);
  }
  for (const required of candidateCapabilityMethods) {
    const matches = candidateManifest.abi.methods.filter((entry) => entry.name === required.name);
    assert.equal(matches.length, 1);
    assert.deepEqual(descriptor(matches[0]), descriptor(required), `capability descriptor matches compiled candidate: ${required.name}`);
    assert.equal(walletAbi.has(required.name), false, 'candidate-only methods do not enter the public ABI map');
    assert.ok(compatibility.addedMethods.includes(`${required.name}/${required.parameters.length}`));
  }
}

function assertOperationSurface(operations) {
  assertCandidateEvidence();
  for (const operation of operations) {
    if (walletAbi.has(operation) || paymasterAbi.has(operation)) continue;
    const gated = candidateCapabilityMethods.find((entry) => entry.name === operation);
    assert.ok(gated, `SDK operation has no pinned public ABI or verified capability-gated candidate descriptor: ${operation}`);
    assert.ok(candidateManifest.abi.methods.some((entry) => JSON.stringify(descriptor(entry)) === JSON.stringify(descriptor(gated))));
  }
}


test('every operation string in the SDK source exists in a compiled ABI', () => {
  const source = fs.readFileSync(indexSourcePath, 'utf8');
  const operations = new Set();
  for (const pattern of [
    /operation:\s*'([^']+)'/g,
    /invokeFunctionWithRetry\(\s*this\.masterContractHash,\s*'([^']+)'/g,
    /invoke(?:Safe|Optional)\('([^']+)'\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) operations.add(match[1]);
  }

  assert.ok(operations.size >= 30,
    `expected to extract the full operation surface from index.js, got only ${operations.size}`);

  assertOperationSurface(operations);
});

test('candidate evidence and method surfaces fail closed on drift or ungated additions', () => {
  assert.throws(() => assertCandidateEvidence(Buffer.from(candidateBytes.toString().replace('finalizeEscapeToOwner', 'finalizeEscapeToAttacker'))), /candidate fixture/);
  assert.throws(() => assertOperationSurface(['finalizeEscapeToAttacker']), /no pinned public ABI/);
  // This method really exists in the candidate, but is not covered by the
  // recovery capability path. Candidate membership alone is insufficient.
  assert.ok(candidateManifest.abi.methods.some((entry) => entry.name === 'getPendingHookUpdate'));
  assert.throws(() => assertOperationSurface(['getPendingHookUpdate']), /no pinned public ABI/);
});

test('candidate recovery payload and read use exact compiled descriptors after capability verification', async () => {
  assertCandidateEvidence();
  const client = new SmartAccountClient('https://example.invalid', MASTER_HASH);
  const payload = client.createFinalizeEscapeToOwnerPayload({ accountScriptHash: ACCOUNT_HASH });
  const write = candidateManifest.abi.methods.find((entry) => entry.name === payload.operation);
  assert.equal(write.safe, false);
  assert.equal(write.returntype, 'Void');
  assert.deepEqual(payload.args.map((arg) => arg.toJSON().type), write.parameters.map((parameter) => parameter.type));
  const calls = [];
  client.rpcClient = {
    async send(method, params) {
      calls.push(method);
      assert.equal(method, 'getcontractstate');
      assert.deepEqual(params, [`0x${MASTER_HASH}`]);
      return { hash: `0x${MASTER_HASH}`, manifest: candidateManifest };
    },
    async invokeFunction(hash, operation, params, signers) {
      calls.push(operation);
      assert.equal(calls[0], 'getcontractstate', 'query cannot precede capability read');
      assert.equal(hash, MASTER_HASH);
      const read = candidateManifest.abi.methods.find((entry) => entry.name === operation);
      assert.equal(read.safe, true);
      assert.equal(read.returntype, 'Boolean');
      assert.equal(params.length, read.parameters.length);
      assert.deepEqual(params.map((parameter) => parameter.type), read.parameters.map((parameter) => parameter.type));
      assert.deepEqual(signers, []);
      return { state: 'HALT', stack: [{ type: 'Boolean', value: false }] };
    },
  };
  assert.deepEqual(await client.getOwnerOnlyRecoveryStatus(ACCOUNT_HASH), { supported: true, ownerOnlyRecovery: false });
  assert.deepEqual(calls, ['getcontractstate', 'isOwnerOnlyRecovery']);
  // The original public artifact is still exercised and cannot authorize the
  // new query. It reports unknown mode without making a query invocation.
  const pinned = JSON.parse(fs.readFileSync(path.join(repoRoot, 'contracts/build/SmartAccount.manifest.json')));
  client.rpcClient.send = async () => ({ hash: `0x${MASTER_HASH}`, manifest: pinned });
  client.rpcClient.invokeFunction = async () => assert.fail('old public ABI must not invoke candidate read');
  assert.deepEqual(await client.getOwnerOnlyRecoveryStatus(ACCOUNT_HASH), { supported: false, ownerOnlyRecovery: null });
});

test('the six phantom PascalCase operations stay out of the SDK', () => {
  const source = fs.readFileSync(indexSourcePath, 'utf8');
  const phantoms = [
    'SetMetadataUri',
    'ConfirmHookUpdate',
    'ConfirmVerifierUpdate',
    'CancelHookUpdate',
    'CancelVerifierUpdate',
    'IsAnyExecutionActive',
  ];
  for (const phantom of phantoms) {
    assert.equal(source.includes(`'${phantom}'`), false,
      `operation '${phantom}' does not exist in the contract ABI (manifest names are camelCase)`);
  }
});

test('payload builders target manifest methods with matching arity', () => {
  const client = new SmartAccountClient('https://example.invalid', `0x${MASTER_HASH}`);
  const accountScriptHash = ACCOUNT_HASH;
  const userOp = {
    TargetContract: TARGET_HASH,
    Method: 'transfer',
    Args: [],
    Nonce: 0,
    Deadline: 1700000000000,
    Signature: '',
  };

  const payloads = [
    client.createAccountPayload({ backupOwnerAddress: `0x${'44'.repeat(20)}`, escapeTimelock: 604800 }),
    client.createUpdateVerifierPayload({ accountScriptHash, verifierContractHash: MODULE_HASH }),
    client.createUpdateHookPayload({ accountScriptHash, hookContractHash: MODULE_HASH }),
    client.createSetMetadataUriPayload({ accountScriptHash, metadataUri: 'ipfs://demo' }),
    client.createConfirmHookUpdatePayload({ accountScriptHash }),
    client.createConfirmVerifierUpdatePayload({ accountScriptHash }),
    client.createCancelHookUpdatePayload({ accountScriptHash }),
    client.createCancelVerifierUpdatePayload({ accountScriptHash }),
    client.createSponsoredUserOpPayload({
      accountScriptHash,
      userOp,
      paymasterHash: `0x${PAYMASTER_HASH}`,
      sponsorAddress: `0x${'44'.repeat(20)}`,
      reimbursementAmount: 1,
    }),
    client.createSponsoredBatchPayload({
      accountScriptHash,
      userOps: [userOp],
      paymasterHash: `0x${PAYMASTER_HASH}`,
      sponsorAddress: `0x${'44'.repeat(20)}`,
      reimbursementAmount: 1,
    }),
  ];

  for (const payload of payloads) {
    const arities = walletAbi.get(payload.operation);
    assert.ok(arities, `operation '${payload.operation}' missing from SmartAccount ABI`);
    assert.ok(arities.has(payload.args.length),
      `operation '${payload.operation}' arity ${payload.args.length} does not match ABI (${[...(arities || [])].join('/')})`);
  }
});

test('client read methods invoke manifest methods with matching arity', async () => {
  const client = new SmartAccountClient('https://example.invalid', `0x${MASTER_HASH}`);
  const recorded = [];
  const genericResponse = () => ({
    state: 'HALT',
    stack: [{ type: 'ByteString', value: Buffer.from('ab'.repeat(32), 'hex').toString('base64') }],
  });

  client.rpcClient = {
    async send(method, [scriptHash, operation, params = []]) {
      assert.equal(method, 'invokefunction');
      recorded.push({ target: scriptHash.replace(/^0x/, ''), operation, paramCount: params.length });
      return genericResponse();
    },
    async invokeFunction(scriptHash, operation, params = []) {
      recorded.push({ target: scriptHash.replace(/^0x/, ''), operation, paramCount: params.length });
      return genericResponse();
    },
    async invokeScript() {
      return genericResponse();
    },
  };

  // invokeScript-based methods embed the operation in the script; capture it
  // at the createScript boundary.
  const originalCreateScript = neonCompat.sc.createScript;
  neonCompat.sc.createScript = (input) => {
    recorded.push({
      target: String(input.scriptHash).replace(/^0x/, ''),
      operation: input.operation,
      paramCount: (input.args || []).length,
    });
    return originalCreateScript(input);
  };

  try {
    await client.getAccountImplementationId();
    await client.supportsExecutionMode('single');
    await client.supportsModuleType('validator');
    await client.isModuleInstalled(ACCOUNT_HASH, 'validator', MODULE_HASH);
    await client.getIsExecutionActive(ACCOUNT_HASH);
    await client.getUserOpValidationPreview({
      accountIdHash: ACCOUNT_HASH,
      targetContract: TARGET_HASH,
      method: 'transfer',
    });
    await client.getAccountState(ACCOUNT_HASH);
    await client.getHasPendingVerifierUpdate(ACCOUNT_HASH);
    await client.getHasPendingHookUpdate(ACCOUNT_HASH);
    await client.getPendingVerifierUpdateTime(ACCOUNT_HASH);
    await client.getPendingHookUpdateTime(ACCOUNT_HASH);
    await client.getPendingVerifierCall(ACCOUNT_HASH);
    await client.getPendingHookCall(ACCOUNT_HASH);
    await client.computeArgsHash([]);
    await client.createEIP712Payload({
      chainId: 894710606,
      accountIdHash: ACCOUNT_HASH,
      targetContract: TARGET_HASH,
      method: 'transfer',
      nonce: 0,
      deadline: 1700000000000,
    });
    await client.querySponsorBalance(`0x${PAYMASTER_HASH}`, `0x${'44'.repeat(20)}`);
    await client.validatePaymasterOp({
      paymasterHash: `0x${PAYMASTER_HASH}`,
      sponsorAddress: `0x${'44'.repeat(20)}`,
      accountAddress: ACCOUNT_HASH,
      targetContract: TARGET_HASH,
      method: 'transfer',
      reimbursementAmount: 1,
    });
  } finally {
    neonCompat.sc.createScript = originalCreateScript;
  }

  assert.ok(recorded.length >= 20, `expected the exercised methods to record invocations, got ${recorded.length}`);

  for (const { target, operation, paramCount } of recorded) {
    const abi = target === PAYMASTER_HASH ? paymasterAbi : walletAbi;
    const abiName = target === PAYMASTER_HASH ? 'SAPaymaster' : 'SmartAccount';
    const arities = abi.get(operation);
    assert.ok(arities, `operation '${operation}' missing from ${abiName} ABI`);
    assert.ok(arities.has(paramCount),
      `operation '${operation}' invoked with ${paramCount} args, ABI expects ${[...(arities || [])].join('/')}`);
  }
});

test('non-functional events module is removed from the public surface', () => {
  const source = fs.readFileSync(indexSourcePath, 'utf8');
  assert.doesNotMatch(source, /require\('\.\/events'\)/);
  assert.equal(fs.existsSync(path.join(repoRoot, 'sdk', 'js', 'src', 'events.js')), false,
    'events.js was non-functional against real nodes and must stay deleted');

  const exported = require('../src/index');
  assert.equal('EVENT_NAMES' in exported, false);
  assert.equal('EventSubscription' in exported, false);
  assert.equal('createEventSubscription' in exported, false);
});
