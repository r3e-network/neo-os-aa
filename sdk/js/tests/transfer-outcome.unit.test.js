/**
 * CU-06: the SDK equivalent of the wallet's guards.
 *
 * Recorded on the deployed AA core (aa-chain-records-20261005.json, AA-03 case a and AA-09 case 8): a
 * GAS.transfer out of the account's proxy address, carried by executeUserOp with the owner's witness (or the
 * relay's), HALTs with result false, moves nothing and still consumes the nonce and the fee. The SDK must not call
 * that operation passable (simulateUserOperation), and it hands apps the same result rules the relay route and
 * the wallet use (shared/transferOutcome.mjs) to judge the result they get back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AbstractAccountClient,
  EC,
  TRANSFER_RETURNED_FALSE,
  TRANSFER_RETURNED_FALSE_MESSAGE,
  findFailedTransferInExecution,
  findFailedTransferInInvocation,
  isProxySourcedTransfer,
  preFlightCheck,
  simulateUserOperation,
} = require('../src/index');
const { wallet } = require('../src/neonCompat');

const MASTER_HASH = 'b1bda4a9170b54dd67898ac3f5fd34ea091f15ee'; // UnifiedSmartWalletV3 of the recorded run
const ACCOUNT_ID = 'f951cd3eb5196dacde99b339c5dcca37ac38cc22';
const GAS_HASH = 'd2a4cff31913016155e38e474a2c06d08be276cf';
const BUYER_HASH = '49c095ce04d38642e39155f5481615c58227a498';
const VERIFIER = 'b4107cb2cb4bace0ebe15bc4842890734abe133a';

function newClient({ previewThrows = false } = {}) {
  const client = new AbstractAccountClient('http://127.0.0.1:9', MASTER_HASH);
  client.getUserOpValidationPreview = async () => {
    if (previewThrows) throw new Error('rpc unavailable');
    return { deadlineValid: true, nonceAcceptable: true, hasVerifier: true, verifier: VERIFIER, hook: '' };
  };
  return client;
}

const proxyOf = (client) => client.deriveVirtualAccount(ACCOUNT_ID).scriptHash;

const hash160Param = (hash) => ({ type: 'Hash160', value: `0x${hash}` });
const transferArgs = (from) => [hash160Param(from), hash160Param(BUYER_HASH), { type: 'Integer', value: '100000000' }, { type: 'ByteArray', value: '0x' }];

const baseOptions = (overrides = {}) => ({
  accountIdHash: ACCOUNT_ID,
  targetContract: GAS_HASH,
  method: 'transfer',
  nonce: 0,
  deadline: Date.now() + 3_600_000,
  ...overrides,
});

test('simulateUserOperation does not pass a transfer out of the account proxy (the preview checks alone said passed:true)', async () => {
  const client = newClient();
  const proxy = proxyOf(client);
  assert.match(proxy, /^[0-9a-f]{40}$/);

  const result = await simulateUserOperation(client, baseOptions({ args: transferArgs(proxy) }));
  assert.equal(result.passed, false);
  assert.equal(result.signatureVerified, false);
  assert.equal(result.checks.nonceAcceptable, true, 'the preview still ran and is reported');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^\[OP_001\]/);
  assert.equal(result.errors[0], `[${EC.OPERATION_PROXY_TRANSFER_REFUSED.code}] ${EC.OPERATION_PROXY_TRANSFER_REFUSED.message}`);
});

test('the refusal reads the source however it is written and reaches preFlightCheck', async () => {
  const client = newClient();
  const proxy = proxyOf(client);
  const address = wallet.getAddressFromScriptHash(proxy);

  for (const first of [
    hash160Param(proxy),
    { type: 'Hash160', value: proxy.toUpperCase() },
    { type: 'Hash160', value: address },
    { type: 'Address', value: address },
  ]) {
    const result = await simulateUserOperation(client, baseOptions({ args: [first, hash160Param(BUYER_HASH), { type: 'Integer', value: '1' }] }));
    assert.equal(result.passed, false, JSON.stringify(first));
  }

  // The legacy accountAddress is the proxy itself.
  const legacy = await simulateUserOperation(newClient(), {
    accountAddress: proxy,
    targetContract: GAS_HASH,
    method: 'transfer',
    args: transferArgs(proxy),
    nonce: 0,
    deadline: Date.now() + 3_600_000,
  });
  assert.equal(legacy.passed, false);

  const suite = await preFlightCheck(
    Object.assign(newClient(), {
      async getAccountState() { return { verifier: VERIFIER, hook: '', escapeActive: false }; },
    }),
    { accountHashOrAddress: ACCOUNT_ID, userOp: baseOptions({ args: transferArgs(proxy) }) },
  );
  assert.equal(suite.passed, false);
  assert.match(suite.errors.join('\n'), /OP_001/);
});

test('the refusal also holds when the preview RPC fails', async () => {
  const client = newClient({ previewThrows: true });
  const result = await simulateUserOperation(client, baseOptions({ args: transferArgs(proxyOf(client)) }));
  assert.equal(result.passed, false);
  assert.match(result.errors.join('\n'), /OP_001/);
  assert.match(result.errors.join('\n'), /rpc unavailable/);
});

test('positive controls: other sources, other methods and no arguments are not refused', async () => {
  const client = newClient();
  const proxy = proxyOf(client);

  const fromBuyer = await simulateUserOperation(client, baseOptions({ args: transferArgs(BUYER_HASH) }));
  assert.equal(fromBuyer.passed, true, 'an owner-witness source that is not the proxy');

  const notTransfer = await simulateUserOperation(client, baseOptions({ method: 'balanceOf', args: [hash160Param(proxy)] }));
  assert.equal(notTransfer.passed, true);

  const noArgs = await simulateUserOperation(client, baseOptions({ args: [] }));
  assert.equal(noArgs.passed, true, 'the shape used by the existing flow tests');

  // A stub client that cannot derive the proxy cannot be judged: the old behaviour, not a crash.
  const stub = await simulateUserOperation({
    async getUserOpValidationPreview() {
      return { deadlineValid: true, nonceAcceptable: true, hasVerifier: true, verifier: VERIFIER, hook: '' };
    },
  }, baseOptions({ args: transferArgs(proxy) }));
  assert.equal(stub.passed, true);
});

test('the SDK hands apps the shared result rules (recorded AA-09 case 8 and AA-03 case c)', () => {
  assert.equal(TRANSFER_RETURNED_FALSE, 'transfer_returned_false');
  assert.match(TRANSFER_RETURNED_FALSE_MESSAGE, /transfer returned false/i);
  assert.equal(isProxySourcedTransfer({ method: 'transfer', from: `0x${ACCOUNT_ID}`, proxy: ACCOUNT_ID }), true);

  const invocation = {
    scriptHash: MASTER_HASH,
    operation: 'executeUserOp',
    args: [
      hash160Param(ACCOUNT_ID),
      {
        type: 'Struct',
        value: [
          hash160Param(GAS_HASH),
          { type: 'String', value: 'transfer' },
          { type: 'Array', value: transferArgs(ACCOUNT_ID) },
          { type: 'Integer', value: '0' },
          { type: 'Integer', value: '9999999999999' },
          { type: 'ByteArray', value: '0x' },
        ],
      },
    ],
  };
  assert.deepEqual(findFailedTransferInInvocation({ invocation, stack: [{ type: 'Boolean', value: false }] }), [0]);
  assert.deepEqual(findFailedTransferInInvocation({ invocation, stack: [{ type: 'Boolean', value: true }] }), []);
  assert.deepEqual(findFailedTransferInInvocation({ invocation, stack: [] }), []);

  const execution = (value, method = 'transfer') => ({
    vmstate: 'HALT',
    stack: [{ type: 'Boolean', value }],
    notifications: [{
      contract: `0x${MASTER_HASH}`,
      eventname: 'UserOpExecuted',
      state: { type: 'Array', value: [{ type: 'ByteString', value: 'AAAA' }, { type: 'ByteString', value: 'AAAA' }, { type: 'ByteString', value: Buffer.from(method).toString('base64') }, { type: 'Integer', value: '0' }] },
    }],
  });
  assert.deepEqual(findFailedTransferInExecution(execution(false)), [0]);
  assert.deepEqual(findFailedTransferInExecution(execution(true)), []);
  assert.deepEqual(findFailedTransferInExecution(execution(false, 'setSessionKey')), [], 'a false that is not a transfer');
});
