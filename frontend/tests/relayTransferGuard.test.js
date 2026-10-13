// CU-06 route tests: the real api/relay-transaction.js handler against a loopback JSON-RPC node that answers
// with the results recorded on the deployed AA core (AA-09 cases 1, 7, 8, 9; aa-chain-records-20261005.json).
//
// Recorded fault (AA-09 case 8 and 9): a session-signed GAS transfer out of the account's proxy address, with the
// relay as the only signer, simulates as ok:true, HALT, stack [false]; the route then broadcast it (system fee
// 0.99 GAS, network fee 0.0137 GAS paid by the relay), the nonce was consumed and no GAS left the proxy. The node
// below counts every RPC method it receives, so "the broadcast is refused" is checked as "sendrawtransaction was
// never called" (and no fee was even calculated).
//
// No live host is contacted: the node listens on 127.0.0.1 only.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORE_HASH,
  GAS_HASH,
  MOCK_TARGET_HASH,
  boolItem,
  executeUserOpInvocation,
  executeUserOpsInvocation,
  gasTransferArgs,
  relayRoute,
  userOpParam,
} from './fixtures/aaChainFixtures.js';
import { RELAY_WIF, haltResult, post, relayAccount, startNode, withRelay } from './fixtures/relayHarness.js';

const case7 = relayRoute.case7BroadcastGaslessOp;
const case8 = relayRoute.case8SimulateSessionGasTransfer;
const case9 = relayRoute.case9BroadcastSameTransfer;

const CODE = 'relay_transfer_returned_false';
const MESSAGE = /transfer returned false/i;

const transferInvocation = (overrides = {}) => executeUserOpInvocation({ target: GAS_HASH, method: 'transfer', args: gasTransferArgs(), ...overrides });

test('CU-06 case 8: the preflight of a session-signed GAS transfer out of the proxy is ok:false and costs nothing', async () => {
  const node = await startNode({ invokeScript: () => haltResult(case8.gasConsumed, boolItem(case8.stackFirst)) });
  try {
    const { status, body } = await withRelay(node, {}, () => post({ metaInvocation: transferInvocation(), simulate: true }));
    assert.equal(status, 200);
    assert.equal(body.ok, false, 'recorded before the fix: ok:true');
    assert.equal(body.code, CODE);
    assert.equal(body.vmState, 'HALT');
    assert.equal(body.gasConsumed, case8.gasConsumed);
    assert.equal(body.operation, 'executeUserOp');
    assert.match(body.exception, MESSAGE);
    assert.deepEqual(body.stack, [boolItem(false)], 'the stack stays inspectable');
    assert.deepEqual(body.failedOperations, [0]);
    assert.equal(node.count('sendrawtransaction'), 0);
    assert.equal(node.count('calculatenetworkfee'), 0);
  } finally {
    await node.close();
  }
});

test('CU-06 case 9: the broadcast of the same transfer is refused, sendrawtransaction is never called', async () => {
  assert.equal(case9.status, 200, 'recorded: the route answered the broadcast with 200');
  assert.match(case9.txid, /^0x[0-9a-f]{64}$/, 'recorded: with a txid, 0.99 GAS of system fee paid by the relay and the nonce consumed');
  assert.equal(case9.systemFee, case8.gasConsumed, 'recorded: the fee it paid is the simulated cost of the no-op');

  const node = await startNode({ invokeScript: () => haltResult(case8.gasConsumed, boolItem(false)) });
  try {
    const { status, body } = await withRelay(node, {}, () => post({ metaInvocation: transferInvocation() }));
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.code, CODE);
    assert.equal(body.txid, undefined, 'recorded before the fix: 200 with txid, fee paid, nonce consumed');
    assert.equal(body.systemFee, undefined);
    assert.equal(node.count('sendrawtransaction'), 0, 'spy: nothing was broadcast');
    assert.equal(node.count('calculatenetworkfee'), 0, 'no fee was even priced');
    assert.equal(node.count('getblockcount'), 0, 'no transaction was built');
    assert.equal(node.count('invokescript'), 1, 'only the preview ran');
  } finally {
    await node.close();
  }
});

test('CU-06 positive control (AA-09 case 7): a transfer that returns true passes the preflight and is broadcast', async () => {
  const node = await startNode({ invokeScript: () => haltResult(case7.systemFee, boolItem(true)) });
  try {
    const invocation = transferInvocation({ target: MOCK_TARGET_HASH });
    const preflight = await withRelay(node, {}, () => post({ metaInvocation: invocation, simulate: true }));
    assert.equal(preflight.status, 200);
    assert.equal(preflight.body.ok, true);
    assert.equal(preflight.body.vmState, 'HALT');
    assert.deepEqual(preflight.body.stack, [boolItem(true)]);
    assert.equal(preflight.body.code, undefined);

    const sent = await withRelay(node, {}, () => post({ metaInvocation: invocation }));
    assert.equal(sent.status, 200);
    assert.equal(sent.body.txid, case7.txid);
    assert.equal(sent.body.systemFee, case7.systemFee);
    assert.equal(sent.body.networkFee, case7.networkFee);
    assert.equal(node.count('sendrawtransaction'), 1);
  } finally {
    await node.close();
  }
});

test('CU-06: a false result of an operation that is not a transfer is not a failure (arming calls return false)', async () => {
  const node = await startNode({ invokeScript: () => haltResult('34153200', boolItem(false)) });
  try {
    const invocation = executeUserOpInvocation({ target: MOCK_TARGET_HASH, method: 'setSessionKey', args: [] });
    const preflight = await withRelay(node, {}, () => post({ metaInvocation: invocation, simulate: true }));
    assert.equal(preflight.body.ok, true);
    const sent = await withRelay(node, {}, () => post({ metaInvocation: invocation }));
    assert.equal(sent.body.txid, case7.txid);
    assert.equal(node.count('sendrawtransaction'), 1);
  } finally {
    await node.close();
  }
});

test('CU-06: results that are not a Boolean false are never rejected', async () => {
  for (const stack of [[{ type: 'Integer', value: '0' }], [{ type: 'Any' }], [], [{ type: 'ByteString', value: '' }]]) {
    const node = await startNode({ invokeScript: () => haltResult('1000', ...stack) });
    try {
      const { body } = await withRelay(node, {}, () => post({ metaInvocation: transferInvocation(), simulate: true }));
      assert.equal(body.ok, true, `stack ${JSON.stringify(stack)}`);
    } finally {
      await node.close();
    }
  }
});

test('CU-06: a batch is refused when one of its transfers returned false, and only then', async () => {
  const batch = (methods) => executeUserOpsInvocation(methods.map((method, nonce) => ({
    target: GAS_HASH, method, nonce, args: method === 'transfer' ? gasTransferArgs() : [],
  })));
  const results = (...values) => [{ type: 'Array', value: values.map((value) => boolItem(value)) }];
  const run = async (methods, stack, { simulate = true } = {}) => {
    const node = await startNode({ invokeScript: () => haltResult('2000', ...stack) });
    try {
      const response = await withRelay(node, {}, () => post({ metaInvocation: batch(methods), simulate }));
      return { ...response, sent: node.count('sendrawtransaction') };
    } finally {
      await node.close();
    }
  };

  const failed = await run(['transfer', 'transfer'], results(true, false));
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.code, CODE);
  assert.deepEqual(failed.body.failedOperations, [1]);

  const firstFailed = await run(['transfer', 'setSessionKey'], results(false, false), { simulate: false });
  assert.equal(firstFailed.body.code, CODE);
  assert.equal(firstFailed.sent, 0);

  const fine = await run(['setSessionKey', 'transfer'], results(false, true), { simulate: false });
  assert.equal(fine.body.txid, case7.txid, 'the false belongs to the arming call');
  assert.equal(fine.sent, 1);
});

test('CU-06: the method name cannot be disguised as bytes, and the sponsored entry point is judged too', async () => {
  const transferAsBytes = executeUserOpInvocation({ target: GAS_HASH, method: 'transfer', args: gasTransferArgs() });
  transferAsBytes.args[1].value[1] = { type: 'ByteArray', value: `0x${Buffer.from('transfer').toString('hex')}` };

  const sponsored = {
    scriptHash: CORE_HASH,
    operation: 'executeSponsoredUserOp',
    args: [
      ...transferInvocation().args,
      { type: 'Hash160', value: `0x${MOCK_TARGET_HASH}` },
      { type: 'Hash160', value: `0x${MOCK_TARGET_HASH}` },
      { type: 'Integer', value: '300000000' },
    ],
  };

  for (const [name, invocation] of Object.entries({ transferAsBytes, sponsored })) {
    const node = await startNode({ invokeScript: () => haltResult('2000', boolItem(false)) });
    try {
      const { body } = await withRelay(node, {}, () => post({ metaInvocation: invocation }));
      assert.equal(body.code, CODE, name);
      assert.equal(node.count('sendrawtransaction'), 0, name);
    } finally {
      await node.close();
    }
  }
});

test('CU-06/CU-203: the legacy executeUnifiedByAddress envelope is refused at validation, before any simulation', async () => {
  // CU-06 used to feed this envelope through the transfer guard. CU-203 established that no
  // deployed manifest and no contract source defines executeUnifiedByAddress, so it is no longer
  // one of the entrypoints the relay accepts: the route refuses it during validation, names the
  // operation, and never simulates. What keeps this case safe is the allowlist, not the guard.
  const legacy = {
    scriptHash: CORE_HASH,
    operation: 'executeUnifiedByAddress',
    args: [
      { type: 'Hash160', value: `0x${GAS_HASH}` },
      { type: 'Hash160', value: `0x${GAS_HASH}` },
      { type: 'String', value: 'transfer' },
      { type: 'Array', value: gasTransferArgs() },
    ],
  };

  const node = await startNode({ invokeScript: () => haltResult('2000', boolItem(false)) });
  try {
    const { status, body } = await withRelay(node, {}, () => post({ metaInvocation: legacy }));
    assert.equal(status, 400);
    assert.equal(body.error, 'relay_meta_invocation_not_allowed');
    assert.match(body.reason, /unsupported relay operation: executeUnifiedByAddress/);
    assert.equal(node.count('invokescript'), 0, 'refused before any simulation');
    assert.equal(node.count('sendrawtransaction'), 0);
  } finally {
    await node.close();
  }
});

test('CU-06: the result is checked again on the simulation that prices the transaction (state changes between the two)', async () => {
  // The preview (first simulation) sees true, the pricing simulation (second) sees false: nothing may be signed.
  const node = await startNode({ invokeScript: (index) => haltResult('2000', boolItem(index === 0)) });
  try {
    const { status, body } = await withRelay(node, {}, () => post({ metaInvocation: transferInvocation({ target: MOCK_TARGET_HASH }) }));
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.code, CODE);
    assert.equal(body.txid, undefined);
    assert.equal(node.count('invokescript'), 2);
    assert.equal(node.count('calculatenetworkfee'), 0);
    assert.equal(node.count('sendrawtransaction'), 0);
  } finally {
    await node.close();
  }
});

test('CU-06 acceptance: the route still refuses without an opt-in (case 3) and without a fee ceiling (case 4)', async () => {
  const node = await startNode({ invokeScript: () => haltResult('2000', boolItem(true)) });
  try {
    const noOptIn = await withRelay(node, { AA_RELAY_ALLOW_UNSPONSORED: null, AA_RELAY_MAX_SYSTEM_FEE: '2000000000' }, () => post({ metaInvocation: transferInvocation({ target: MOCK_TARGET_HASH }) }));
    assert.equal(noOptIn.status, 402);
    assert.equal(noOptIn.body.error, 'paymaster_denied');

    const noCeiling = await withRelay(node, { AA_RELAY_MAX_SYSTEM_FEE: null, AA_RELAY_MAX_NETWORK_FEE: null }, () => post({ metaInvocation: transferInvocation({ target: MOCK_TARGET_HASH }) }));
    assert.equal(noCeiling.status, 400);
    assert.equal(noCeiling.body.error, 'relay_fee_ceiling_not_configured');

    assert.equal(node.count('sendrawtransaction'), 0);
  } finally {
    await node.close();
  }
});

test('CU-06: refusals carry no key material and no stack trace (the L2 switch stays off)', async () => {
  const node = await startNode({ invokeScript: () => haltResult(case8.gasConsumed, boolItem(false)) });
  try {
    for (const simulate of [true, false]) {
      const { body } = await withRelay(node, {}, () => post({ metaInvocation: transferInvocation(), simulate }));
      const text = JSON.stringify(body);
      assert.equal(text.includes(RELAY_WIF), false);
      assert.equal(text.includes(relayAccount.privateKey), false);
      assert.doesNotMatch(text, /\n\s+at |node:internal|rawMessage/);
      assert.equal(body.rawMessage, undefined);
    }
  } finally {
    await node.close();
  }
});

test('CU-06: userOpParam helper builds the Struct the route reads (guards the fixtures themselves)', () => {
  const param = userOpParam({ method: 'transfer' });
  assert.equal(param.type, 'Struct');
  assert.equal(param.value[1].value, 'transfer');
});
