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
const { AbstractAccountClient } = require('../src/index');
const neonCompat = require('../src/neonCompat');

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

const walletAbi = loadAbiMethods('UnifiedSmartWalletV3.manifest.json');
const paymasterAbi = loadAbiMethods('AAPaymaster.manifest.json');

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

  const missing = [...operations].filter((op) => !walletAbi.has(op) && !paymasterAbi.has(op));
  assert.deepEqual(missing, [],
    `SDK emits operations that exist in no compiled ABI (method-not-found FAULT on-chain): ${missing.join(', ')}`);
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
  const client = new AbstractAccountClient('https://example.invalid', `0x${MASTER_HASH}`);
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
    assert.ok(arities, `operation '${payload.operation}' missing from UnifiedSmartWalletV3 ABI`);
    assert.ok(arities.has(payload.args.length),
      `operation '${payload.operation}' arity ${payload.args.length} does not match ABI (${[...(arities || [])].join('/')})`);
  }
});

test('client read methods invoke manifest methods with matching arity', async () => {
  const client = new AbstractAccountClient('https://example.invalid', `0x${MASTER_HASH}`);
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
    const abiName = target === PAYMASTER_HASH ? 'AAPaymaster' : 'UnifiedSmartWalletV3';
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
