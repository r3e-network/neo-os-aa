import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { neon, invokePersisted } = require('./deploy-helpers.js');
const publicHash = '6d0656f6dd91469db1c90cc1e574380613f43738';

function stubContract(t, methods) {
  const descriptor = Object.getOwnPropertyDescriptor(neon.experimental, 'SmartContract');
  class FakeContract {
    testInvoke(...args) { return methods.testInvoke(...args); }
    invoke(...args) { return methods.invoke(...args); }
  }
  Object.defineProperty(neon.experimental, 'SmartContract', { value: FakeContract, configurable: true });
  t.after(() => Object.defineProperty(neon.experimental, 'SmartContract', descriptor));
}

function args(overrides = {}) {
  return { client: {}, account: { scriptHash: publicHash }, networkMagic: 860833102,
    rpcUrl: 'https://example.invalid', contractHash: publicHash, operation: 'update', ...overrides };
}

test('an ambiguous broadcast is attempted once and never retried', async (t) => {
  let broadcasts = 0;
  stubContract(t, {
    testInvoke: async () => ({ state: 'HALT', gasconsumed: '100' }),
    invoke: async () => { broadcasts++; throw new Error('ETIMEDOUT after submission'); },
  });
  await assert.rejects(invokePersisted(args()), /ETIMEDOUT/);
  assert.equal(broadcasts, 1);
});

test('the txid is saved before confirmation, even when the application faults', async (t) => {
  const events = [];
  const txid = `0x${'ab'.repeat(32)}`;
  stubContract(t, {
    testInvoke: async () => ({ state: 'HALT', gasconsumed: '100' }),
    invoke: async () => { events.push('broadcast'); return txid; },
  });
  await assert.rejects(invokePersisted(args({
    onBroadcast: async (id) => { assert.equal(id, txid); events.push('receipt'); },
    client: { getApplicationLog: async () => {
      events.push('confirmation');
      return { executions: [{ vmstate: 'FAULT', exception: 'state changed' }] };
    } },
  })), /expected HALT, got FAULT/);
  assert.deepEqual(events, ['broadcast', 'receipt', 'confirmation']);
});

test('an empty or faulted preview cannot broadcast', async (t) => {
  let preview = {};
  let broadcasts = 0;
  stubContract(t, {
    testInvoke: async () => preview,
    invoke: async () => { broadcasts++; },
  });
  await assert.rejects(invokePersisted(args()), /preview UNKNOWN/);
  preview = { state: 'FAULT', exception: 'Not admin' };
  await assert.rejects(invokePersisted(args()), /^Error: update preview FAULT: Not admin$/);
  assert.equal(broadcasts, 0);
});
