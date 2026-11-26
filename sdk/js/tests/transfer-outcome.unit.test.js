/**
 * CU-06: a transfer that returned false is a spent nonce and fee, not a pass.
 *
 * Recorded on the deployed core (sa-chain-records-20261005.json, SA-03 case a
 * and SA-09 case 8): a GAS.transfer out of the account's proxy address, carried
 * by executeUserOp with only the owner's or the relay's witness, HALTs with
 * result false, moves nothing, and still consumes the nonce and the fee.
 *
 * v4 states that verdict from the result the VM actually returned instead of
 * predicting it locally: `simulate` reports `incompleteTransfers` by position,
 * `execute` refuses the same stack, and the shared rules in
 * `shared/transferOutcome.mjs` are exported so an app judging a relay answer or
 * an application log reaches the same conclusion.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NativeSmartAccountClient,
  TRANSFER_RETURNED_FALSE,
  TRANSFER_RETURNED_FALSE_MESSAGE,
  findFailedTransferInExecution,
  findFailedTransferInInvocation,
  isProxySourcedTransfer,
  simulateUserOperation,
} = require('../src/index');
const { simulatePlan } = require('../src/simulation');

const CORE = 'b1bda4a9170b54dd67898ac3f5fd34ea091f15ee';
const NETWORK = 894710606;
const ACCOUNT_ID = 'f951cd3eb5196dacde99b339c5dcca37ac38cc22';
const GAS = 'd2a4cff31913016155e38e474a2c06d08be276cf';
const BUYER = '49c095ce04d38642e39155f5481615c58227a498';
const DEADLINE = '1700000000000';
const ZERO_SUBKEY = '00'.repeat(32);
const SIGNATURE = '11'.repeat(64);

/** The proxy address the client derives for this account and these call flags. */
const PROXY = new NativeSmartAccountClient({
  rpcClient: { send: async () => ({}) },
  networkMagic: NETWORK,
  contractHash: CORE,
}).proxyAddress(ACCOUNT_ID);
// Hashes travel as ByteString in the VM value model: there is no `Hash160`
// argument type, so nothing can smuggle a display-order conversion in.
const hash = (value) => ({ type: 'ByteString', value });
const integer = (value) => ({ type: 'Integer', value: String(value) });

/** One signed 13-field transfer operation; `nonce` keeps each one distinct. */
function transfer(nonce, from = PROXY, method = 'transfer') {
  return {
    targetContract: GAS,
    method,
    args: [hash(from), hash(BUYER), integer(100000000), { type: 'ByteString', value: '' }],
    nonce,
    nonceSubkey: ZERO_SUBKEY,
    deadline: DEADLINE,
    validatorId: 0,
    credentialGeneration: 1,
    authorityEpoch: 1,
    configurationNonce: 0,
    signature: SIGNATURE,
  };
}

/** A client whose `invokescript` answers with a fixed stack. */
function clientAnswering(stack, { state = 'HALT' } = {}) {
  const client = new NativeSmartAccountClient({
    rpcClient: {
      async send(method) {
        if (method === 'invokescript') return { state, stack, gasconsumed: '100' };
        throw new Error(`unexpected RPC ${method}`);
      },
    },
    networkMagic: NETWORK,
    contractHash: CORE,
    retry: false,
  });
  return client;
}

test('a transfer that answered false is reported incomplete, not passed', async () => {
  const client = clientAnswering([{ type: 'Boolean', value: false }]);
  const result = await simulateUserOperation(client, {
    accountId: ACCOUNT_ID,
    operation: transfer(0),
  });
  assert.equal(result.state, 'HALT');
  assert.deepEqual(result.incompleteTransfers, [0]);
  assert.equal(result.plan.method, 'executeUserOp');
  assert.equal(result.plan.accountAddress, PROXY);
  assert.equal(result.gasConsumed, '100');
  // The answer is reported, never thrown: a review has to show it.
  assert.equal(result.exception, null);
});

test('an Array answer for one operation is judged conservatively, never as a shorter batch', async () => {
  // v4.1 has one operation per transaction, so a single stack item that is an
  // array is not a batch result: it is an answer this protocol never produces.
  // A transfer whose own result cannot be read as Boolean true is incomplete at
  // position 0, because silence must not read as success.
  const client = clientAnswering([
    {
      type: 'Array',
      value: [
        { type: 'Boolean', value: true },
        { type: 'Boolean', value: false },
        { type: 'Boolean', value: false },
      ],
    },
  ]);
  const result = await simulateUserOperation(client, {
    accountId: ACCOUNT_ID,
    operation: transfer(0),
  });
  assert.equal(result.plan.method, 'executeUserOp');
  assert.equal(result.plan.operation.method, 'transfer');
  assert.deepEqual(result.incompleteTransfers, [0]);
});

test('a false from a non-transfer method is never read as a failed transfer', async () => {
  const client = clientAnswering([{ type: 'Boolean', value: false }]);
  const result = await simulateUserOperation(client, {
    accountId: ACCOUNT_ID,
    operation: transfer(0, PROXY, 'setSessionKey'),
  });
  assert.deepEqual(result.incompleteTransfers, []);
});

test('a result that cannot be attributed fails closed', async () => {
  // A list input is the retired batch shape, not a longer execution: refused
  // before any script is built.
  const client = clientAnswering([{ type: 'Boolean', value: true }]);
  assert.throws(
    () =>
      client.buildExecutionScript({
        accountId: ACCOUNT_ID,
        operations: [transfer(0), transfer(1)],
      }),
    /protocol-incompatible: executeUserOps is retired in v4\.1/,
  );

  // A single operation must answer exactly one stack item.
  const empty = clientAnswering([]);
  await assert.rejects(
    () => simulateUserOperation(empty, { accountId: ACCOUNT_ID, operation: transfer(0) }),
    /exactly one item/,
  );

  // A fault is evidence too; it is reported with its exception.
  const faulted = clientAnswering([], { state: 'FAULT' });
  const fault = await simulateUserOperation(faulted, {
    accountId: ACCOUNT_ID,
    operation: transfer(0),
  });
  assert.equal(fault.state, 'FAULT');
  assert.deepEqual(fault.incompleteTransfers, []);
});

test('execute refuses a stack a review would have rejected', async () => {
  const client = clientAnswering([{ type: 'Boolean', value: false }]);
  const plan = client.buildExecutionScript({ accountId: ACCOUNT_ID, operation: transfer(0) });
  // Simulating is allowed to show the refusal; executing is not.
  const simulated = await simulatePlan(client, plan);
  assert.deepEqual(simulated.incompleteTransfers, [0]);
  await assert.rejects(() => client.execute(plan), /transfer/);
});

test('the SDK hands apps the shared result rules', () => {
  assert.equal(TRANSFER_RETURNED_FALSE, 'transfer_returned_false');
  assert.match(TRANSFER_RETURNED_FALSE_MESSAGE, /transfer returned false/i);
  assert.equal(isProxySourcedTransfer({ method: 'transfer', from: `0x${PROXY}`, proxy: PROXY }), true);
  assert.equal(isProxySourcedTransfer({ method: 'transfer', from: `0x${BUYER}`, proxy: PROXY }), false);
  assert.equal(isProxySourcedTransfer({ method: 'Transfer', from: `0x${PROXY}`, proxy: PROXY }), false);

  // A relay-ready invocation carries the serialized thirteen-field Array, the
  // way the client builds it: the method sits at field 2.
  const operation = transfer(0, PROXY);
  const invocation = {
    scriptHash: CORE,
    operation: 'executeUserOp',
    args: [hash(ACCOUNT_ID), { type: 'Array', value: [
      integer(4),
      hash(operation.targetContract),
      { type: 'ByteString', value: Buffer.from('transfer').toString('hex') },
      { type: 'Array', value: operation.args },
      integer(operation.nonce),
      { type: 'ByteString', value: ZERO_SUBKEY },
      integer(operation.deadline),
      integer(0),
      integer(0),
      integer(1),
      integer(0),
      { type: 'ByteString', value: SIGNATURE },
      { type: 'Array', value: [] },
    ] }],
  };
  assert.deepEqual(
    findFailedTransferInInvocation({ invocation, stack: [{ type: 'Boolean', value: false }] }),
    [0],
  );
  assert.deepEqual(
    findFailedTransferInInvocation({ invocation, stack: [{ type: 'Boolean', value: true }] }),
    [],
  );
  assert.deepEqual(findFailedTransferInInvocation({ invocation, stack: [] }), []);

  const execution = (value, method = 'transfer') => ({
    vmstate: 'HALT',
    stack: [{ type: 'Boolean', value }],
    notifications: [
      {
        contract: `0x${CORE}`,
        eventname: 'UserOpExecuted',
        state: {
          type: 'Array',
          value: [
            { type: 'ByteString', value: 'AAAA' },
            { type: 'ByteString', value: 'AAAA' },
            { type: 'ByteString', value: Buffer.from(method).toString('base64') },
            { type: 'Integer', value: '0' },
          ],
        },
      },
    ],
  });
  assert.deepEqual(findFailedTransferInExecution(execution(false)), [0]);
  assert.deepEqual(findFailedTransferInExecution(execution(true)), []);
  assert.deepEqual(findFailedTransferInExecution(execution(false, 'setSessionKey')), []);
});
