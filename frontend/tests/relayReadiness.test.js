import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRelayReadiness } from '../src/features/operations/relayReadiness.js';
import { executeUserOpInvocation } from './fixtures/aaChainFixtures.js';

test('relay readiness marks raw transactions as payload-ready until preflight passes', () => {
  const readiness = evaluateRelayReadiness({
    runtime: { relayEnabled: true, relayMetaEnabled: false, relayRawEnabled: true },
    transactionBody: { rawTransaction: '0xdeadbeef' },
    signatures: [],
  });

  assert.deepEqual(readiness, {
    level: 'warning',
    mode: 'raw',
    isReady: false,
    payloadReady: true,
    label: 'Relay Payload Ready',
    detail: 'Signed raw transaction is staged. Run Relay Preflight to verify the server signer and runtime credentials before submission.',
  });
});

test('relay readiness warns when a raw transaction exists but raw relay forwarding is disabled', () => {
  const readiness = evaluateRelayReadiness({
    runtime: { relayEnabled: true, relayMetaEnabled: false, relayRawEnabled: false },
    transactionBody: { rawTransaction: '0xdeadbeef' },
    signatures: [],
  });

  assert.equal(readiness.isReady, false);
  assert.equal(readiness.payloadReady, false);
  assert.equal(readiness.level, 'warning');
  assert.equal(readiness.mode, 'raw');
  assert.match(readiness.detail, /enable raw relay forwarding/i);
});

test('relay readiness marks relay invocations as payload-ready until preflight passes', () => {
  const readiness = evaluateRelayReadiness({
    runtime: { relayEnabled: true, relayMetaEnabled: true },
    transactionBody: {},
    signatures: [{
      kind: 'evm',
      metadata: { metaInvocation: executeUserOpInvocation() },
    }],
  });

  assert.equal(readiness.isReady, false);
  assert.equal(readiness.payloadReady, true);
  assert.equal(readiness.mode, 'meta');
  assert.equal(readiness.level, 'warning');
  assert.match(readiness.detail, /run relay preflight/i);
});

test('relay readiness is warning-only when relay invocations exist but relay invocation mode is not publicly enabled', () => {
  const readiness = evaluateRelayReadiness({
    runtime: { relayEnabled: true, relayMetaEnabled: false },
    transactionBody: {},
    signatures: [{
      kind: 'evm',
      metadata: { metaInvocation: executeUserOpInvocation() },
    }],
  });

  assert.equal(readiness.isReady, false);
  assert.equal(readiness.payloadReady, false);
  assert.equal(readiness.level, 'warning');
  assert.equal(readiness.mode, 'meta');
  assert.match(readiness.detail, /enable relay invocation mode/i);
});

test('relay readiness is blocked when no relay endpoint is configured', () => {
  const readiness = evaluateRelayReadiness({
    runtime: { relayEnabled: false, relayMetaEnabled: false },
    transactionBody: { rawTransaction: '0xdeadbeef' },
    signatures: [],
  });

  assert.equal(readiness.isReady, false);
  assert.equal(readiness.payloadReady, false);
  assert.equal(readiness.level, 'blocked');
  assert.match(readiness.detail, /relay endpoint is not configured/i);
});
