const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SmartAccountClient,
  buildSessionKeyRegistrationBlob,
  buildSessionKeyPermission,
  toErc4337UserOperation,
  estimateUserOperationGas,
  SESSION_KEY_BLOB_VERSION,
  MAX_SESSION_KEY_DESCRIPTION_BYTES,
} = require('../src/index');

// Real nodes return UInt160 stack items as ByteString carrying the internal
// little-endian bytes (base64-encoded). Build that wire shape from the
// big-endian display hex the SDK works with.
function leByteStringStackItem(displayHex) {
  return { type: 'ByteString', value: Buffer.from(displayHex, 'hex').reverse().toString('base64') };
}

function boolItem(value) {
  return { type: 'Boolean', value };
}

function intItem(value) {
  return { type: 'Integer', value: String(value) };
}

function mockClient(stackValue) {
  const client = new SmartAccountClient('https://example.invalid', '0x1234567890123456789012345678901234567890');
  const calls = [];
  client.rpcClient = {
    async invokeFunction(scriptHash, operation, params, signers) {
      calls.push({ scriptHash, operation, params, signers });
      return { state: 'HALT', stack: [{ type: 'Array', value: stackValue }] };
    },
  };
  return { client, calls };
}

const ACCOUNT_ID = 'f951cd3eb5196dacde99b339c5dcca37ac38cc22';
const VERIFIER = 'b4107cb2cb4bace0ebe15bc4842890734abe133a';
const HOOK = '1111111111111111111111111111111111111111';
const BACKUP = '2222222222222222222222222222222222222222';
const ESCROW = '3333333333333333333333333333333333333333';
const TARGET = '49c095ce04d38642e39155f5481615c58227a498';

test('describeAccount decodes the 14-field descriptor from one call', async () => {
  const { client, calls } = mockClient([
    boolItem(true),
    leByteStringStackItem(VERIFIER),
    leByteStringStackItem(HOOK),
    leByteStringStackItem(BACKUP),
    intItem(604800),
    intItem(0),
    boolItem(false),
    leByteStringStackItem(ESCROW),
    intItem(7),
    boolItem(true),
    boolItem(true),
    intItem(1700003600000),
    boolItem(false),
    intItem(0),
  ]);

  const descriptor = await client.describeAccount(ACCOUNT_ID);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'describeAccount');
  assert.deepEqual(calls[0].params, [{ type: 'Hash160', value: ACCOUNT_ID }]);
  assert.deepEqual(descriptor, {
    exists: true,
    verifier: VERIFIER,
    hook: HOOK,
    backupOwner: BACKUP,
    escapeTimelock: '604800',
    escapeTriggeredAt: '0',
    escapeActive: false,
    marketEscrowContract: ESCROW,
    marketEscrowListingId: '7',
    marketEscrowActive: true,
    pendingVerifierUpdate: true,
    pendingVerifierMatureAt: '1700003600000',
    pendingHookUpdate: false,
    pendingHookMatureAt: '0',
  });
});

test('describeAccount decodes an unknown account without faulting', async () => {
  const { client } = mockClient([
    boolItem(false),
    leByteStringStackItem('00'.repeat(20)),
    leByteStringStackItem('00'.repeat(20)),
    leByteStringStackItem('00'.repeat(20)),
    intItem(0),
    intItem(0),
    boolItem(false),
    leByteStringStackItem('00'.repeat(20)),
    intItem(0),
    boolItem(false),
    boolItem(false),
    intItem(0),
    boolItem(false),
    intItem(0),
  ]);

  const descriptor = await client.describeAccount(ACCOUNT_ID);

  assert.equal(descriptor.exists, false);
  assert.equal(descriptor.verifier, '00'.repeat(20));
  assert.equal(descriptor.marketEscrowActive, false);
  assert.equal(descriptor.pendingVerifierMatureAt, '0');
});

test('simulateUserOp decodes the 7-field preflight and forwards signers', async () => {
  const { client, calls } = mockClient([
    boolItem(true),
    boolItem(true),
    boolItem(true),
    boolItem(true),
    boolItem(false),
    boolItem(false),
    boolItem(false),
  ]);
  const signers = [{ account: BACKUP, scopes: 'None' }];

  const simulation = await client.simulateUserOp({
    accountIdHash: ACCOUNT_ID,
    targetContract: TARGET,
    method: 'transfer',
    args: [],
    nonce: 3,
    deadline: 1700000000000,
    signers,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'simulateUserOp');
  assert.deepEqual(calls[0].signers, signers);
  assert.equal(calls[0].params[0].type, 'Hash160');
  assert.equal(calls[0].params[1].type, 'Struct');
  assert.deepEqual(
    calls[0].params[1].value.map((field) => field.type),
    ['Hash160', 'String', 'Array', 'Integer', 'Integer', 'ByteArray'],
  );
  assert.deepEqual(simulation, {
    accountExists: true,
    deadlineOk: true,
    nonceOk: true,
    verifierBound: true,
    nativeWitnessPresent: false,
    marketEscrowBlocks: false,
    escapeActive: false,
  });
});

test('simulateUserOp decodes the unknown-account all-false result', async () => {
  const { client } = mockClient(Array.from({ length: 7 }, () => boolItem(false)));
  const simulation = await client.simulateUserOp({
    accountIdHash: ACCOUNT_ID,
    targetContract: TARGET,
    method: 'transfer',
  });
  assert.deepEqual(simulation, {
    accountExists: false,
    deadlineOk: false,
    nonceOk: false,
    verifierBound: false,
    nativeWitnessPresent: false,
    marketEscrowBlocks: false,
    escapeActive: false,
  });
});

// Golden vector cross-checked byte-for-byte against the live validator's
// session_key_registration_blob in scripts/neoexpress_validate.py.
test('buildSessionKeyRegistrationBlob matches the contract blob layout', () => {
  const blob = buildSessionKeyRegistrationBlob({
    publicKeyHex: `02${'11'.repeat(32)}`,
    targetContract: VERIFIER,
    method: 'transfer',
    validUntilMs: 1700000000000,
    spendingLimitDatoshi: 0,
    description: 'demo',
  });
  assert.equal(
    blob,
    '01'
    + '21' + `02${'11'.repeat(32)}`
    + '3a13be4a73902884c45be1ebe0ac4bcbb27c10b4' // target in stored little-endian form
    + '08' + Buffer.from('transfer', 'utf8').toString('hex')
    + '0068e5cf8b010000' // 1700000000000 as uint64 LE
    + '0000000000000000' // unlimited spending
    + '04' + Buffer.from('demo', 'utf8').toString('hex'),
  );
});

test('buildSessionKeyRegistrationBlob enforces the contract-side invariants', () => {
  assert.throws(
    () => buildSessionKeyRegistrationBlob({
      publicKeyHex: `05${'11'.repeat(32)}`,
      targetContract: VERIFIER,
      method: 'transfer',
      validUntilMs: 1700000000000,
    }),
    /02 or 03/,
  );
  // Fail closed exactly like the contract: a positive cap is only enforceable
  // on the value-moving transfer path.
  assert.throws(
    () => buildSessionKeyRegistrationBlob({
      publicKeyHex: `02${'11'.repeat(32)}`,
      targetContract: VERIFIER,
      method: 'mint',
      validUntilMs: 1700000000000,
      spendingLimitDatoshi: 1000,
    }),
    /only enforceable on transfer/,
  );
  assert.throws(
    () => buildSessionKeyRegistrationBlob({
      publicKeyHex: `02${'11'.repeat(32)}`,
      targetContract: VERIFIER,
      method: 'transfer',
      validUntilMs: 1700000000000,
      description: 'x'.repeat(MAX_SESSION_KEY_DESCRIPTION_BYTES + 1),
    }),
    /at most 128 UTF-8 bytes/,
  );
});

test('buildSessionKeyPermission returns the 7715-shaped grant with canonical artifacts', () => {
  const grant = buildSessionKeyPermission({
    publicKeyHex: `02${'11'.repeat(32)}`,
    targetContract: VERIFIER,
    method: 'transfer',
    validUntilMs: 1700000000000,
    spendingLimitDatoshi: 500,
    description: 'day-one',
  });
  assert.equal(grant.permission.signer.type, 'key');
  assert.equal(grant.permission.signer.data.publicKey, `0x02${'11'.repeat(32)}`);
  assert.equal(grant.permission.permissions[0].type, 'contract-call');
  assert.equal(grant.permission.permissions[0].data.address, `0x${VERIFIER}`);
  assert.equal(grant.permission.permissions[0].data.selector, 'transfer');
  assert.equal(grant.permission.permissions[0].data.spendingLimit, '500');
  assert.equal(grant.permission.expiry, 1700000000); // 7715 expiry is unix seconds
  assert.equal(grant.registrationBlobHex[0] + grant.registrationBlobHex[1], '01');
  assert.equal(grant.sessionKeyArgs.validUntilMs, '1700000000000');
  assert.equal(grant.sessionKeyArgs.spendingLimitDatoshi, '500');
  assert.equal(SESSION_KEY_BLOB_VERSION, 1);
});

test('createSessionKeyAccountPayload routes the blob through createAccountPayload', () => {
  const client = new SmartAccountClient('https://example.invalid', '0x1234567890123456789012345678901234567890');
  const payload = client.createSessionKeyAccountPayload({
    sessionKeyVerifierHash: VERIFIER,
    sessionKey: {
      publicKeyHex: `02${'11'.repeat(32)}`,
      targetContract: TARGET,
      method: 'transfer',
      validUntilMs: 1700000000000,
    },
    backupOwnerAddress: BACKUP,
    escapeTimelock: 7 * 24 * 60 * 60,
  });
  assert.equal(payload.operation, 'registerAccount');
  assert.equal(payload.args[1].value.toBigEndian(), VERIFIER);
  // args[2] carries the version-0x01 blob as a ByteArray parameter; the RPC
  // wire form (toJSON base64) must reproduce the canonical blob bytes.
  const expectedBlob = buildSessionKeyRegistrationBlob({
    publicKeyHex: `02${'11'.repeat(32)}`,
    targetContract: TARGET,
    method: 'transfer',
    validUntilMs: 1700000000000,
  });
  const blobParam = payload.args[2];
  assert.equal(blobParam.type, 18); // ContractParamType.ByteArray
  const wireHex = Buffer.from(blobParam.toJSON().value, 'base64').toString('hex');
  assert.equal(wireHex, expectedBlob);
  // The registration-bound account id commits to the blob bytes.
  const withBlob = client.deriveRegistrationAccountIdHash({
    verifierContractHash: VERIFIER,
    verifierParamsHex: expectedBlob,
    backupOwnerAddress: BACKUP,
    escapeTimelock: 7 * 24 * 60 * 60,
  });
  assert.equal(payload.args[0].value.toBigEndian(), withBlob);
});

test('toErc4337UserOperation maps the V3 fields onto the 4337 shape', () => {
  const op = toErc4337UserOperation({
    accountIdHash: ACCOUNT_ID,
    targetContract: TARGET,
    method: 'transfer',
    args: [],
    nonce: 5,
    deadline: 1700000000000,
    signatureHex: 'abcd',
  });
  assert.equal(op.sender, `0x${ACCOUNT_ID}`);
  assert.equal(op.nonce, '0x5');
  // callData is the Neo VM System.Contract.Call script for target.method(args).
  assert.match(op.callData, /^0x[0-9a-f]+$/);
  assert.ok(op.callData.length > 40);
  assert.equal(op.signature, '0xabcd');
  assert.equal(op.callGasLimit, '0x0');
  assert.equal(op.maxFeePerGas, '0x0');
  assert.equal(op.deadline, '1700000000000');
});

test('estimateUserOperationGas anchors the 4337 gas shape on simulateUserOp', async () => {
  const { client } = mockClient(Array.from({ length: 7 }, () => boolItem(true)));
  const estimate = await estimateUserOperationGas(client, {
    accountIdHash: ACCOUNT_ID,
    targetContract: TARGET,
    method: 'transfer',
    nonce: 0,
    deadline: 1700000000000,
  });
  assert.equal(estimate.preVerificationGas, '0x0');
  assert.equal(estimate.verificationGasLimit, '0x0');
  assert.equal(estimate.callGasLimit, '0x0');
  assert.equal(estimate.simulation.accountExists, true);
  assert.match(estimate.note, /VM execution/);
});
