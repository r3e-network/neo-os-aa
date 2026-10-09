import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRelayPreflightRequest,
  normalizeRelayPreflightResult,
  runRelayPreflight,
} from '../src/features/operations/relayPreflight.js';
import {
  GAS_HASH,
  boolItem,
  executeUserOpInvocation,
  executeUserOpsInvocation,
  gasTransferArgs,
  relayRoute,
} from './fixtures/aaChainFixtures.js';

test('buildRelayPreflightRequest reuses the selected relay payload and adds simulate mode', () => {
  const request = buildRelayPreflightRequest({
    relayEndpoint: '/api/relay-transaction',
    relayPayloadMode: 'meta',
    morpheusNetwork: 'testnet',
    transactionBody: {},
    signatures: [{
      kind: 'evm',
      metadata: { metaInvocation: executeUserOpInvocation() },
    }],
  });

  assert.deepEqual(request, {
    relayEndpoint: '/api/relay-transaction',
    relayPayloadMode: 'meta',
    morpheus_network: 'testnet',
    simulate: true,
    metaInvocation: executeUserOpInvocation(),
  });
});

test('normalizeRelayPreflightResult marks successful simulations as ready', () => {
  const result = normalizeRelayPreflightResult({
    simulate: true,
    ok: true,
    vmState: 'HALT',
    gasConsumed: '12345',
    operation: 'executeUserOp',
  });

  assert.deepEqual(result, {
    ok: true,
    level: 'ready',
    label: 'Relay Check Passed',
    detail: 'executeUserOp simulated successfully (gas 12345).',
    vmState: 'HALT',
    gasConsumed: '12345',
    operation: 'executeUserOp',
    payloadMode: 'best',
    exception: '',
    supported: true,
    stack: [],
  });
});

test('normalizeRelayPreflightResult surfaces unsupported raw simulation as warning', () => {
  const result = normalizeRelayPreflightResult({
    simulate: true,
    ok: false,
    supported: false,
    code: 'simulation_not_supported_for_raw',
    message: 'Simulation is only available for relay-ready meta invocations.',
  });

  assert.deepEqual(result, {
    ok: false,
    level: 'warning',
    label: 'Simulation Unsupported',
    detail: 'Simulation is only available for relay-ready meta invocations.',
    vmState: '',
    gasConsumed: '',
    operation: '',
    payloadMode: 'best',
    exception: '',
    supported: false,
    stack: [],
  });
});

test('normalizeRelayPreflightResult preserves fault details for a failed simulation', () => {
  const result = normalizeRelayPreflightResult({
    simulate: true,
    ok: false,
    vmState: 'FAULT',
    operation: 'executeUserOp',
    gasConsumed: '88',
    exception: 'Invalid Nonce',
  });

  assert.deepEqual(result, {
    ok: false,
    level: 'blocked',
    label: 'Relay Check Failed',
    detail: 'Invalid Nonce',
    vmState: 'FAULT',
    gasConsumed: '88',
    operation: 'executeUserOp',
    payloadMode: 'best',
    exception: 'Invalid Nonce',
    supported: true,
    stack: [],
  });
});

test('normalizeRelayPreflightResult preserves returned stack items for inspection', () => {
  const result = normalizeRelayPreflightResult({
    simulate: true,
    ok: true,
    vmState: 'HALT',
    gasConsumed: '99',
    operation: 'executeUserOp',
    stack: [{ type: 'Integer', value: '1' }, { type: 'ByteString', value: 'YWJjZA==' }],
  });

  assert.deepEqual(result.stack, [{ type: 'Integer', value: '1' }, { type: 'ByteString', value: 'YWJjZA==' }]);
});

test('normalizeRelayPreflightResult preserves structured validation preview details', () => {
  const result = normalizeRelayPreflightResult({
    simulate: true,
    ok: true,
    vmState: 'HALT',
    gasConsumed: '42',
    operation: 'executeUserOp',
    validationPreview: {
      deadlineValid: true,
      nonceAcceptable: false,
      hasVerifier: true,
      verifier: 'b4107cb2cb4bace0ebe15bc4842890734abe133a',
      hook: '1111111111111111111111111111111111111111',
    },
  });

  assert.deepEqual(result.validationPreview, {
    deadlineValid: true,
    nonceAcceptable: false,
    hasVerifier: true,
    verifier: 'b4107cb2cb4bace0ebe15bc4842890734abe133a',
    hook: '1111111111111111111111111111111111111111',
  });
});

test('relay preflight payloads are exportable for draft metadata persistence', () => {
  const result = normalizeRelayPreflightResult({
    simulate: true,
    ok: true,
    vmState: 'HALT',
    gasConsumed: '77',
    operation: 'executeUserOp',
    stack: [{ type: 'Integer', value: '1' }],
  }, 'meta');

  assert.equal(result.payloadMode, 'meta');
  assert.deepEqual(result.stack, [{ type: 'Integer', value: '1' }]);
});

test('runRelayPreflight submits simulate requests through the relay transport', async () => {
  const calls = [];
  const walletService = {
    async relayTransaction(payload) {
      calls.push(payload);
      return {
        simulate: true,
        ok: true,
        vmState: 'HALT',
        gasConsumed: '77',
        operation: 'executeUserOp',
        stack: [{ type: 'Integer', value: '1' }],
        validationPreview: {
          deadlineValid: true,
          nonceAcceptable: true,
          hasVerifier: true,
          verifier: 'b4107cb2cb4bace0ebe15bc4842890734abe133a',
          hook: '0000000000000000000000000000000000000000',
        },
      };
    },
  };

  const result = await runRelayPreflight({
    walletService,
    relayEndpoint: '/api/relay-transaction',
    relayPayloadMode: 'meta',
    transactionBody: {},
    signatures: [{
      kind: 'evm',
      metadata: { metaInvocation: executeUserOpInvocation() },
    }],
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].simulate, true);
  assert.equal(result.label, 'Relay Check Passed');
  assert.equal(result.operation, 'executeUserOp');
  assert.equal(result.gasConsumed, '77');
  assert.deepEqual(result.stack, [{ type: 'Integer', value: '1' }]);
  assert.equal(result.validationPreview?.hasVerifier, true);
});

// --- CU-06: the preflight never reports a transfer that returned false as ready ---------------------------------
// Recorded on the deployed core (AA-09 case 8): the route's preflight of a session-signed GAS transfer out of the
// account's proxy address said ok:true, HALT, stack [false]. Nothing would move; the broadcast (case 9) paid the
// fee and burned the nonce.

const case8 = relayRoute.case8SimulateSessionGasTransfer;
const FALSE_TRANSFER_MESSAGE = /transfer returned false/i;

function preflightWith(payload, invocation, payloadMode = 'meta') {
  const walletService = { async relayTransaction() { return payload; } };
  return runRelayPreflight({
    walletService,
    relayEndpoint: '/api/relay-transaction',
    relayPayloadMode: payloadMode,
    transactionBody: {},
    signatures: [{ kind: 'evm', metadata: { metaInvocation: invocation } }],
  });
}

function routePayload(stack, { operation = 'executeUserOp', ok = true } = {}) {
  return {
    simulate: true,
    ok,
    vmState: case8.vmState,
    gasConsumed: case8.gasConsumed,
    operation,
    stack,
    validationPreview: case8.validationPreview,
  };
}

test('CU-06: a route that still answers ok:true for the recorded case 8 payload is not believed', async () => {
  const invocation = executeUserOpInvocation({ target: GAS_HASH, method: 'transfer', args: gasTransferArgs() });
  assert.equal(case8.ok, true, 'recorded: the route reported success');
  assert.equal(case8.stackFirst, false, 'recorded: with a false result');

  const result = await preflightWith(routePayload([boolItem(case8.stackFirst)]), invocation);
  assert.equal(result.ok, false);
  assert.equal(result.level, 'blocked');
  assert.equal(result.label, 'Relay Check Failed');
  assert.match(result.detail, FALSE_TRANSFER_MESSAGE);
  assert.match(result.exception, FALSE_TRANSFER_MESSAGE);
  assert.equal(result.vmState, 'HALT');
  assert.equal(result.gasConsumed, case8.gasConsumed);
  assert.deepEqual(result.stack, [boolItem(false)], 'the stack stays inspectable');
});

test('CU-06: the verdict of the fixed route (ok:false with its stable code) is shown as a failed check', async () => {
  const invocation = executeUserOpInvocation({ target: GAS_HASH, method: 'transfer', args: gasTransferArgs() });
  const result = await preflightWith({
    ...routePayload([boolItem(false)], { ok: false }),
    code: 'relay_transfer_returned_false',
    exception: 'A token transfer returned false, so no tokens moved; the nonce and the fee are still spent.',
  }, invocation);
  assert.equal(result.ok, false);
  assert.equal(result.level, 'blocked');
  assert.match(result.detail, FALSE_TRANSFER_MESSAGE);
});

test('CU-06: positive controls, a transfer that returned true and a non-transfer false stay ready', async () => {
  const transfer = executeUserOpInvocation({ target: GAS_HASH, method: 'transfer', args: gasTransferArgs() });
  const moved = await preflightWith(routePayload([boolItem(true)]), transfer);
  assert.equal(moved.ok, true);
  assert.equal(moved.level, 'ready');

  const arm = executeUserOpInvocation({ target: GAS_HASH, method: 'setSessionKey', args: [] });
  const armed = await preflightWith(routePayload([boolItem(false)]), arm);
  assert.equal(armed.ok, true, 'false is the normal result of an arming call');

  const integerResult = await preflightWith(routePayload([{ type: 'Integer', value: '0' }]), transfer);
  assert.equal(integerResult.ok, true, 'only a Boolean false is a failed transfer');
});

test('CU-06: a batch with a transfer that returned false is blocked, one whose false belongs to another operation is not', async () => {
  const batch = (methods) => executeUserOpsInvocation(methods.map((method, nonce) => ({
    target: GAS_HASH, method, nonce, args: method === 'transfer' ? gasTransferArgs() : [],
  })));
  const stack = (...values) => [{ type: 'Array', value: values.map((value) => boolItem(value)) }];

  const blocked = await preflightWith(routePayload(stack(true, false), { operation: 'executeUserOps' }), batch(['transfer', 'transfer']));
  assert.equal(blocked.ok, false);

  const fine = await preflightWith(routePayload(stack(false, true), { operation: 'executeUserOps' }), batch(['setSessionKey', 'transfer']));
  assert.equal(fine.ok, true);
});

test('CU-06: normalizeRelayPreflightResult without the invocation keeps its old verdicts (no shape to judge)', () => {
  const result = normalizeRelayPreflightResult(routePayload([boolItem(false)]), 'meta');
  assert.equal(result.ok, true, 'the context is what enables the transfer check; callers pass it');
});
