// CU-06 cross-package gate for shared/transferOutcome.mjs: the rules that decide "this transfer returned false"
// are one module, vendored byte for byte into the frontend (the Vercel project root is frontend/), read by the
// relay route, the wallet's preflight and confirmation mapper, and exported by the SDK. This file pins the
// module's own rules and then runs one table of result shapes through every path to prove they agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import * as shared from '../../shared/transferOutcome.mjs';
import * as vendored from '../src/shared/transferOutcome.mjs';
import { TX_STATUS, waitForTransactionConfirmation } from '../src/features/studio/txConfirmation.js';
import { normalizeRelayPreflightResult } from '../src/features/operations/relayPreflight.js';
import {
  GAS_HASH,
  PROXY_HASH,
  applicationLog,
  boolItem,
  byteStringText,
  executeUserOpInvocation,
  executeUserOpsInvocation,
  gasTransferArgs,
  integerItem,
  records,
  userOpExecutedNotification,
} from './fixtures/aaChainFixtures.js';
import { haltResult, post, startNode, withRelay } from './fixtures/relayHarness.js';

const require = createRequire(import.meta.url);
const sdk = require('../../sdk/js/src/index.js');

const repoShared = path.resolve('..', 'shared');
const frontendShared = path.resolve('src', 'shared');

test('every shared module has a byte-identical vendored copy in the frontend (the SDK reads one, the Vercel root the other)', () => {
  const names = fs.readdirSync(repoShared).filter((name) => name.endsWith('.mjs'));
  assert.ok(names.includes('transferOutcome.mjs'), 'the transfer rules live in shared/');
  for (const name of names) {
    assert.equal(
      fs.readFileSync(path.join(frontendShared, name), 'utf8'),
      fs.readFileSync(path.join(repoShared, name), 'utf8'),
      `frontend/src/shared/${name} drifted from shared/${name}`,
    );
  }
  assert.deepEqual(Object.keys(vendored).sort(), Object.keys(shared).sort());
});

test('isTransferMethod matches the NEP method name exactly', () => {
  assert.equal(shared.isTransferMethod('transfer'), true);
  for (const other of ['Transfer', ' transfer', 'transfer ', 'transferFrom', 'balanceOf', '', null, undefined, 7]) {
    assert.equal(shared.isTransferMethod(other), false, String(other));
  }
});

test('isFalseBooleanItem is true only for a Boolean stack item that is false', () => {
  for (const value of [false, 'false', 'False', 0, '0']) {
    assert.equal(shared.isFalseBooleanItem({ type: 'Boolean', value }), true, `Boolean ${JSON.stringify(value)}`);
  }
  const notFalse = [
    { type: 'Boolean', value: true },
    { type: 'Boolean', value: 1 },
    { type: 'Boolean', value: 'true' },
    { type: 'Boolean' },
    { type: 'Integer', value: '0' },
    { type: 'ByteString', value: '' },
    { type: 'Any' },
    { value: false },
    null,
    undefined,
    'false',
  ];
  for (const item of notFalse) {
    assert.equal(shared.isFalseBooleanItem(item), false, JSON.stringify(item));
  }
});

test('isProxySourcedTransfer compares the source with the account proxy as hashes', () => {
  const yes = (args) => shared.isProxySourcedTransfer({ method: 'transfer', ...args });
  assert.equal(yes({ from: PROXY_HASH, proxy: PROXY_HASH }), true);
  assert.equal(yes({ from: `0x${PROXY_HASH}`, proxy: PROXY_HASH.toUpperCase() }), true);
  assert.equal(yes({ from: PROXY_HASH, proxy: '49c095ce04d38642e39155f5481615c58227a498' }), false);
  assert.equal(yes({ from: '', proxy: '' }), false, 'two unknowns are not equal');
  assert.equal(yes({ from: PROXY_HASH, proxy: '' }), false);
  assert.equal(shared.isProxySourcedTransfer({ method: 'balanceOf', from: PROXY_HASH, proxy: PROXY_HASH }), false);
});

test('extractInvocationShape reads the operation methods of every relayable entry point', () => {
  const op = (method, args = []) => ({ target: GAS_HASH, method, args });
  assert.deepEqual(shared.extractInvocationShape(executeUserOpInvocation(op('transfer'))), { methods: ['transfer'], batch: false });
  assert.deepEqual(
    shared.extractInvocationShape(executeUserOpsInvocation([op('transfer'), op('setSessionKey')])),
    { methods: ['transfer', 'setSessionKey'], batch: true },
  );
  const sponsored = { ...executeUserOpInvocation(op('transfer')), operation: 'executeSponsoredUserOp' };
  assert.deepEqual(shared.extractInvocationShape(sponsored), { methods: ['transfer'], batch: false });
  const sponsoredBatch = { ...executeUserOpsInvocation([op('transfer')]), operation: 'executeSponsoredUserOps' };
  assert.deepEqual(shared.extractInvocationShape(sponsoredBatch), { methods: ['transfer'], batch: true });
  for (const operation of ['executeUnified', 'executeUnifiedByAddress']) {
    assert.deepEqual(
      shared.extractInvocationShape({ operation, args: [{ type: 'Hash160', value: '0x01' }, { type: 'Hash160', value: '0x02' }, { type: 'String', value: 'transfer' }] }),
      { methods: ['transfer'], batch: false },
    );
  }

  const bytes = executeUserOpInvocation(op('transfer'));
  bytes.args[1].value[1] = { type: 'ByteArray', value: `0x${Buffer.from('transfer').toString('hex')}` };
  assert.deepEqual(shared.extractInvocationShape(bytes).methods, ['transfer'], 'ByteArray method');
  bytes.args[1].value[1] = { type: 'Any', value: Buffer.from('transfer').toString('hex') };
  assert.deepEqual(shared.extractInvocationShape(bytes).methods, ['transfer'], 'Any carries hex, like ByteArray');
  bytes.args[1].value[1] = { type: 'Integer', value: '1' };
  assert.deepEqual(shared.extractInvocationShape(bytes).methods, [''], 'a method that is not text or hex is not decoded');
  const asArray = executeUserOpInvocation(op('transfer'));
  asArray.args[1] = { ...asArray.args[1], type: 'Array' };
  assert.deepEqual(shared.extractInvocationShape(asArray), { methods: ['transfer'], batch: false }, 'the relay builds Struct and Array alike');

  for (const junk of [null, undefined, {}, { operation: 'somethingElse', args: [] }]) {
    assert.deepEqual(shared.extractInvocationShape(junk), { methods: [], batch: false }, JSON.stringify(junk));
  }
  for (const junk of [{ operation: 'executeUserOp' }, { operation: 'executeUserOp', args: [] }, { operation: 'executeUserOps', args: [{}, {}] }]) {
    assert.equal(shared.extractInvocationShape(junk).methods.some(shared.isTransferMethod), false, JSON.stringify(junk));
  }
});

test('findFailedTransferResults: positions of transfer operations whose result is Boolean false', () => {
  const find = (methods, head, batch) => shared.findFailedTransferResults({ methods, head, batch });
  const array = (...values) => ({ type: 'Array', value: values });

  assert.deepEqual(find(['transfer'], boolItem(false), false), [0]);
  assert.deepEqual(find(['transfer'], boolItem(true), false), []);
  assert.deepEqual(find(['setSessionKey'], boolItem(false), false), [], 'false of a non-transfer is not judged');
  assert.deepEqual(find(['transfer'], integerItem(0), false), []);
  assert.deepEqual(find(['transfer'], undefined, false), [], 'no result, no verdict');
  assert.deepEqual(find([], boolItem(false), false), []);

  assert.deepEqual(find(['transfer', 'transfer'], array(boolItem(true), boolItem(false)), true), [1]);
  assert.deepEqual(find(['transfer', 'transfer'], array(boolItem(false), boolItem(false)), true), [0, 1]);
  assert.deepEqual(find(['transfer', 'setSessionKey'], array(boolItem(false), boolItem(false)), true), [0]);
  assert.deepEqual(find(['setSessionKey', 'transfer'], array(boolItem(false), boolItem(true)), true), []);

  // A single operation whose own result is an array is not a batch.
  assert.deepEqual(find(['transfer'], array(boolItem(false)), false), []);

  // Results that cannot be attributed to operations: every false is suspect once a transfer is among them (fail closed).
  assert.deepEqual(find(['transfer', 'transfer'], array(boolItem(false)), true), [0]);
  assert.deepEqual(find(['transfer', 'setSessionKey', 'transfer'], array(boolItem(true), boolItem(false)), true), [1]);
  assert.deepEqual(find(['setSessionKey', 'setSessionKey'], array(boolItem(false)), true), []);
});

test('findFailedTransferInExecution reads the operations from the UserOpExecuted notifications', () => {
  const log = (stack, notifications) => applicationLog(records.gasTransferFromProxyByPlainWallet, { stack, notifications }).executions[0];
  const event = (method, nonce = 0) => userOpExecutedNotification({ method, nonce });

  assert.deepEqual(shared.findFailedTransferInExecution(applicationLog(records.gasTransferFromProxyByPlainWallet).executions[0]), [0]);
  assert.deepEqual(shared.findFailedTransferInExecution(applicationLog(records.gasTransferProxyWitness).executions[0]), []);
  assert.deepEqual(shared.findFailedTransferInExecution(applicationLog(records.armSessionKey).executions[0]), [], 'no user operation event: not a transfer');

  // A single result is the outermost operation's: the last event (nested operations emit theirs first).
  assert.deepEqual(shared.findFailedTransferInExecution(log([boolItem(false)], [event('setSessionKey'), event('transfer')])), [0]);
  assert.deepEqual(shared.findFailedTransferInExecution(log([boolItem(false)], [event('transfer'), event('setSessionKey')])), []);

  // A String-typed method (older node encodings) reads the same.
  const stringMethod = event('transfer');
  stringMethod.state.value[2] = { type: 'String', value: 'transfer' };
  assert.deepEqual(shared.findFailedTransferInExecution(log([boolItem(false)], [stringMethod])), [0]);

  // A batch is aligned event by event, or judged conservatively when the counts differ.
  const batch = (values, methods) => log([{ type: 'Array', value: values.map(boolItem) }], methods.map((method, nonce) => event(method, nonce)));
  assert.deepEqual(shared.findFailedTransferInExecution(batch([true, false], ['transfer', 'transfer'])), [1]);
  assert.deepEqual(shared.findFailedTransferInExecution(batch([false, true], ['setSessionKey', 'transfer'])), []);
  assert.deepEqual(shared.findFailedTransferInExecution(batch([true, false], ['transfer', 'transfer', 'transfer'])), [1]);

  for (const junk of [null, undefined, {}, { stack: [] }, { notifications: [] }, { stack: [boolItem(false)], notifications: [{ eventname: 'Transfer' }] }]) {
    assert.deepEqual(shared.findFailedTransferInExecution(junk), [], JSON.stringify(junk));
  }
  // Non-boolean results of a transfer operation are not verdicts.
  assert.deepEqual(shared.findFailedTransferInExecution(log([byteStringText('')], [event('transfer')])), []);
});

test('findFailedTransferInExecution reads logs in a browser (no Buffer) and survives malformed base64', () => {
  const execution = (notification) => ({ stack: [boolItem(false)], notifications: [notification] });
  const good = execution(userOpExecutedNotification({ method: 'transfer' }));
  const malformedEvent = userOpExecutedNotification({ method: 'transfer' });
  malformedEvent.state.value[2] = { type: 'ByteString', value: '***not base64***' };
  const malformed = execution(malformedEvent);

  assert.doesNotThrow(() => shared.findFailedTransferInExecution(malformed), 'with Buffer');
  const realBuffer = globalThis.Buffer;
  try {
    globalThis.Buffer = undefined;
    assert.deepEqual(shared.findFailedTransferInExecution(good), [0], 'the atob path decodes the method');
    assert.deepEqual(shared.findFailedTransferInExecution(malformed), [], 'an unreadable method is not a transfer, and nothing throws');
  } finally {
    globalThis.Buffer = realBuffer;
  }
});

// --- one table, every path ----------------------------------------------------------------------------------------
// shape: the operation methods, whether the invocation is a batch, the result items the VM returned, and whether a
// transfer failed. Every path below must reach the same verdict for every row.
const A = (...items) => ({ type: 'Array', value: items });
const SHAPES = [
  { name: 'single transfer, false', methods: ['transfer'], batch: false, head: boolItem(false), failed: true },
  { name: 'single transfer, true', methods: ['transfer'], batch: false, head: boolItem(true), failed: false },
  { name: 'single transfer, Integer 0', methods: ['transfer'], batch: false, head: integerItem(0), failed: false },
  { name: 'single transfer, no value', methods: ['transfer'], batch: false, head: { type: 'Any' }, failed: false },
  { name: 'single arm call, false', methods: ['setSessionKey'], batch: false, head: boolItem(false), failed: false },
  { name: 'single arm call, true', methods: ['setSessionKey'], batch: false, head: boolItem(true), failed: false },
  { name: 'batch, transfer then failed transfer', methods: ['transfer', 'transfer'], batch: true, head: A(boolItem(true), boolItem(false)), failed: true },
  { name: 'batch, both transfers true', methods: ['transfer', 'transfer'], batch: true, head: A(boolItem(true), boolItem(true)), failed: false },
  { name: 'batch, failed transfer then arm call false', methods: ['transfer', 'setSessionKey'], batch: true, head: A(boolItem(false), boolItem(false)), failed: true },
  { name: 'batch, arm call false then transfer true', methods: ['setSessionKey', 'transfer'], batch: true, head: A(boolItem(false), boolItem(true)), failed: false },
  { name: 'batch of one, transfer false', methods: ['transfer'], batch: true, head: A(boolItem(false)), failed: true },
];

function invocationFor(shape) {
  const ops = shape.methods.map((method, nonce) => ({ target: GAS_HASH, method, nonce, args: method === 'transfer' ? gasTransferArgs() : [] }));
  return shape.batch ? executeUserOpsInvocation(ops) : executeUserOpInvocation(ops[0]);
}

function logFor(shape) {
  return applicationLog(records.gasTransferFromProxyByPlainWallet, {
    stack: [shape.head],
    notifications: shape.methods.map((method, nonce) => userOpExecutedNotification({ method, nonce })),
  });
}

test('every path reaches the same verdict for every result shape', async () => {
  for (const shape of SHAPES) {
    const invocation = invocationFor(shape);
    const stack = [shape.head];
    const log = logFor(shape);
    const verdicts = {};

    verdicts.shared = shared.findFailedTransferInInvocation({ invocation, stack }).length > 0;
    verdicts.sdk = sdk.findFailedTransferInInvocation({ invocation, stack }).length > 0;
    verdicts.sharedLog = shared.findFailedTransferInExecution(log.executions[0]).length > 0;
    verdicts.sdkLog = sdk.findFailedTransferInExecution(log.executions[0]).length > 0;

    const mapped = await waitForTransactionConfirmation('https://rpc.example/neo', 'a1'.repeat(32), {
      fetchImpl: async () => ({ ok: true, async json() { return { result: log }; } }),
      sleep: async () => {},
      initialDelayMs: 1,
    });
    verdicts.mapper = mapped.status === TX_STATUS.FAILED;

    const preflight = normalizeRelayPreflightResult(
      { simulate: true, ok: true, vmState: 'HALT', gasConsumed: '1', operation: invocation.operation, stack },
      'meta',
      undefined,
      { metaInvocation: invocation },
    );
    verdicts.frontendPreflight = preflight.ok === false;

    const node = await startNode({ invokeScript: () => haltResult('1000', ...stack) });
    try {
      const { body } = await withRelay(node, {}, () => post({ metaInvocation: invocation, simulate: true }));
      verdicts.routePreflight = body.ok === false;
      const sent = await withRelay(node, {}, () => post({ metaInvocation: invocation }));
      verdicts.routeBroadcast = sent.body.txid === undefined;
      assert.equal(node.count('sendrawtransaction'), shape.failed ? 0 : 1, `${shape.name}: spy on sendrawtransaction`);
    } finally {
      await node.close();
    }

    assert.equal(Object.keys(verdicts).length, 8, `${shape.name}: every path ran`);
    for (const [route, verdict] of Object.entries(verdicts)) {
      assert.equal(verdict, shape.failed, `${shape.name}: ${route}`);
    }
  }
});

test('the SDK exports the same transfer rules as the frontend', () => {
  assert.equal(sdk.TRANSFER_RETURNED_FALSE, shared.TRANSFER_RETURNED_FALSE);
  assert.equal(sdk.TRANSFER_RETURNED_FALSE_MESSAGE, shared.TRANSFER_RETURNED_FALSE_MESSAGE);
  assert.equal(sdk.isProxySourcedTransfer, shared.isProxySourcedTransfer);
  assert.equal(shared.TRANSFER_RETURNED_FALSE, 'transfer_returned_false');
  assert.match(shared.TRANSFER_RETURNED_FALSE_MESSAGE, /transfer returned false/i);
});
