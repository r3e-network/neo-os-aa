import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TX_STATUS,
  extractVmState,
  extractVmException,
  fetchApplicationLog,
  waitForTransactionConfirmation,
} from '../src/features/studio/txConfirmation.js';
import {
  GAS_HASH,
  MOCK_TARGET_HASH,
  applicationLog,
  boolItem,
  byteStringText,
  integerItem,
  records,
  userOpExecutedNotification,
} from './fixtures/aaChainFixtures.js';

const RPC_URL = 'https://rpc.example/neo';
const TXID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

function jsonResponse(payload, { ok = true } = {}) {
  return {
    ok,
    async json() {
      return payload;
    },
  };
}

function haltLog() {
  return { executions: [{ vmstate: 'HALT', exception: null }] };
}

function faultLog(exception = 'ASSERT failed') {
  return { executions: [{ vmstate: 'FAULT', exception }] };
}

test('extractVmState reads the first execution state across response shapes', () => {
  assert.equal(extractVmState(haltLog()), 'HALT');
  assert.equal(extractVmState(faultLog()), 'FAULT');
  assert.equal(extractVmState({ vmstate: 'halt' }), 'HALT'); // legacy flat shape, normalized
  assert.equal(extractVmState(null), '');
  assert.equal(extractVmState({}), '');
});

test('extractVmException surfaces the fault reason', () => {
  assert.equal(extractVmException(faultLog('insufficient gas')), 'insufficient gas');
  assert.equal(extractVmException(haltLog()), '');
});

test('fetchApplicationLog returns null when the node has not indexed the tx yet', async () => {
  const fetchImpl = async () => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -100, message: 'Unknown transaction' } });
  const result = await fetchApplicationLog(RPC_URL, TXID, { fetchImpl });
  assert.equal(result, null);
});

test('fetchApplicationLog prefixes the txid and returns the result payload', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(JSON.parse(options.body));
    return jsonResponse({ jsonrpc: '2.0', id: 1, result: haltLog() });
  };
  const result = await fetchApplicationLog(RPC_URL, TXID, { fetchImpl });
  assert.equal(extractVmState(result), 'HALT');
  assert.equal(seen[0].method, 'getapplicationlog');
  assert.equal(seen[0].params[0], `0x${TXID}`, 'txid must be 0x-prefixed for the RPC');
});

test('fetchApplicationLog treats a network error as "not available yet"', async () => {
  const fetchImpl = async () => { throw new Error('Failed to fetch'); };
  const result = await fetchApplicationLog(RPC_URL, TXID, { fetchImpl });
  assert.equal(result, null);
});

test('waitForTransactionConfirmation resolves confirmed on HALT', async () => {
  const fetchImpl = async () => jsonResponse({ result: haltLog() });
  const outcome = await waitForTransactionConfirmation(RPC_URL, TXID, {
    fetchImpl,
    sleep: async () => {},
    initialDelayMs: 1,
  });
  assert.equal(outcome.status, TX_STATUS.CONFIRMED);
  assert.equal(outcome.vmState, 'HALT');
});

test('waitForTransactionConfirmation resolves failed on FAULT and carries the exception', async () => {
  const fetchImpl = async () => jsonResponse({ result: faultLog('no auth') });
  const outcome = await waitForTransactionConfirmation(RPC_URL, TXID, {
    fetchImpl,
    sleep: async () => {},
    initialDelayMs: 1,
  });
  assert.equal(outcome.status, TX_STATUS.FAILED);
  assert.equal(outcome.exception, 'no auth');
});

test('waitForTransactionConfirmation keeps polling until the log appears', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    // Not indexed for the first two polls, then HALT.
    if (calls < 3) return jsonResponse({ error: { message: 'Unknown transaction' } });
    return jsonResponse({ result: haltLog() });
  };
  const outcome = await waitForTransactionConfirmation(RPC_URL, TXID, {
    fetchImpl,
    sleep: async () => {},
    initialDelayMs: 1,
  });
  assert.equal(outcome.status, TX_STATUS.CONFIRMED);
  assert.equal(calls, 3);
});

test('waitForTransactionConfirmation degrades to pending when the budget is exhausted', async () => {
  // Simulate a clock that jumps past the timeout after the first poll so a
  // never-confirming tx never reports a false success.
  let virtualNow = 0;
  const fetchImpl = async () => jsonResponse({ error: { message: 'Unknown transaction' } });
  const outcome = await waitForTransactionConfirmation(RPC_URL, TXID, {
    fetchImpl,
    sleep: async (ms) => { virtualNow += ms; },
    now: () => virtualNow,
    initialDelayMs: 50,
    timeoutMs: 40,
  });
  assert.equal(outcome.status, TX_STATUS.PENDING);
});

test('waitForTransactionConfirmation returns pending for an empty txid without polling', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse({ result: haltLog() }); };
  const outcome = await waitForTransactionConfirmation(RPC_URL, '', { fetchImpl, sleep: async () => {} });
  assert.equal(outcome.status, TX_STATUS.PENDING);
  assert.equal(calls, 0);
});

// --- CU-06: HALT is not success for a transfer that returned false -----------------------------------------------
// Fixtures: the recorded AA-03 steps (aa-chain-records-20261005.json). Step 36 is GAS.transfer(proxy -> buyer)
// submitted with the owner's witness: HALT, result false, nothing moved, nonce consumed.

async function confirm(log) {
  const fetchImpl = async () => jsonResponse({ result: log });
  return waitForTransactionConfirmation(RPC_URL, TXID, { fetchImpl, sleep: async () => {}, initialDelayMs: 1 });
}

test('CU-06: HALT with stack [false] for a transfer user operation is failed, not confirmed', async () => {
  const log = applicationLog(records.gasTransferFromProxyByPlainWallet);
  assert.equal(extractVmState(log), 'HALT', 'the VM did HALT: this is the case the old mapper called confirmed');
  assert.deepEqual(log.executions[0].stack, [boolItem(false)]);

  const outcome = await confirm(log);
  assert.equal(outcome.status, TX_STATUS.FAILED);
  assert.equal(outcome.vmState, 'HALT');
  assert.equal(outcome.code, 'transfer_returned_false');
  assert.match(outcome.exception, /transfer returned false/i);
});

test('CU-06: positive controls, a transfer that returned true and operations whose result is not a verdict stay confirmed', async () => {
  // AA-03 case c: proxy-witness transfer, result true, Transfer + UserOpExecuted events.
  const moved = await confirm(applicationLog(records.gasTransferProxyWitness));
  assert.equal(moved.status, TX_STATUS.CONFIRMED);

  // AA-02 shape: an owner-witness user operation that is not a transfer (mock target, method transfer returns true).
  const ownerOp = await confirm(applicationLog(records.ownerWitnessUserOp, { op: { target: MOCK_TARGET_HASH } }));
  assert.equal(ownerOp.status, TX_STATUS.CONFIRMED);

  // Arming a timelocked configuration returns false by design (callVerifier / callHook, no UserOpExecuted event).
  for (const record of [records.armSessionKey, records.armDailyLimit]) {
    const armed = await confirm(applicationLog(record));
    assert.equal(armed.status, TX_STATUS.CONFIRMED, `${record.call} returns false when it only arms: not a failure`);
  }

  // A user operation whose method is not transfer and whose result is false (a session-key arm sent through executeUserOp).
  const nonTransfer = await confirm(applicationLog(records.gasTransferFromProxyByPlainWallet, { op: { method: 'setSessionKey' } }));
  assert.equal(nonTransfer.status, TX_STATUS.CONFIRMED);
});

test('CU-06: only a Boolean false is a failed transfer; other result shapes are not rejected', async () => {
  const base = records.gasTransferFromProxyByPlainWallet;
  for (const stack of [
    [integerItem(0)],
    [integerItem(1)],
    [byteStringText('')],
    [{ type: 'Any' }],
    [],
  ]) {
    const outcome = await confirm(applicationLog(base, { stack }));
    assert.equal(outcome.status, TX_STATUS.CONFIRMED, `stack ${JSON.stringify(stack)} is not a Boolean false`);
  }
});

test('CU-06: a batch is judged operation by operation, in order', async () => {
  const base = records.gasTransferFromProxyByPlainWallet;
  const batch = (methods, results) => applicationLog(base, {
    stack: [{ type: 'Array', value: results }],
    notifications: methods.map((method, nonce) => userOpExecutedNotification({ method, nonce, target: GAS_HASH })),
  });

  assert.equal((await confirm(batch(['transfer', 'transfer'], [boolItem(true), boolItem(true)]))).status, TX_STATUS.CONFIRMED);
  const second = await confirm(batch(['transfer', 'transfer'], [boolItem(true), boolItem(false)]));
  assert.equal(second.status, TX_STATUS.FAILED, 'the second transfer returned false');
  const first = await confirm(batch(['transfer', 'setSessionKey'], [boolItem(false), boolItem(false)]));
  assert.equal(first.status, TX_STATUS.FAILED, 'the transfer returned false even though the other operation legitimately returned false');
  const other = await confirm(batch(['setSessionKey', 'transfer'], [boolItem(false), boolItem(true)]));
  assert.equal(other.status, TX_STATUS.CONFIRMED, 'only the non-transfer returned false');
});

test('CU-06: FAULT and a missing log keep their old meaning', async () => {
  const fault = await confirm({ executions: [{ vmstate: 'FAULT', exception: 'ASSERT failed', stack: [boolItem(false)] }] });
  assert.equal(fault.status, TX_STATUS.FAILED);
  assert.equal(fault.exception, 'ASSERT failed');
  assert.equal(fault.code, undefined, 'a VM fault is reported by its exception, not by the transfer code');

  const noStack = await confirm({ executions: [{ vmstate: 'HALT', exception: null }] });
  assert.equal(noStack.status, TX_STATUS.CONFIRMED, 'no result to judge: the old behaviour');
});
