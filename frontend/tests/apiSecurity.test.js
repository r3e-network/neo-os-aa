import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import relayHandler, * as relayModule from '../api/relay-transaction.js';
import draftOperatorHandler from '../api/draft-operator.js';
import accountMetadataHandler from '../api/account-metadata.js';
import { checkRateLimit, resolveClientIp, resolveRateLimitFailure } from '../api/rateLimiter.js';
import {
  ALLOWED_RELAY_META_OPERATIONS,
  sanitizeMetaInvocationForRelay,
} from '../api/relayHelpers.js';

const { resolveRelayExecutionConfig } = relayModule;

const sdkRequire = createRequire(new URL('../../sdk/js/package.json', import.meta.url));
const { wallet: neonWallet } = sdkRequire('@cityofzion/neon-js');

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };
}

test('relay API returns Retry-After header when rate limited', async () => {
  const ip = `relay-test-${Date.now()}`;
  for (let i = 0; i < 10; i += 1) {
    await relayHandler({
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
      socket: { remoteAddress: ip },
      body: {},
    }, createResponse());
  }

  const response = createResponse();
  await relayHandler({
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
    socket: { remoteAddress: ip },
    body: {},
  }, response);

  assert.equal(response.statusCode, 429);
  assert.equal(response.payload?.error, 'rate_limit_exceeded');
  assert.ok(Number(response.payload?.retryAfter) > 0);
  assert.equal(String(response.headers['retry-after']), String(response.payload?.retryAfter));
});

test('relay API does not rate limit the first request for a fresh client IP', async () => {
  const ip = `relay-first-${Date.now()}`;
  const response = createResponse();
  await relayHandler({
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
    socket: { remoteAddress: ip },
    body: {},
  }, response);

  assert.notEqual(response.statusCode, 429);
  assert.notEqual(response.payload?.error, 'rate_limit_exceeded');
});

test('relay API reports missing client identity distinctly', async () => {
  const snapshot = {
    AA_TRUST_PROXY_HEADERS: process.env.AA_TRUST_PROXY_HEADERS,
    TRUST_PROXY_HEADERS: process.env.TRUST_PROXY_HEADERS,
    AA_TRUST_PROXY_HEADER: process.env.AA_TRUST_PROXY_HEADER,
    TRUST_PROXY_HEADER: process.env.TRUST_PROXY_HEADER,
  };

  delete process.env.AA_TRUST_PROXY_HEADERS;
  delete process.env.TRUST_PROXY_HEADERS;
  delete process.env.AA_TRUST_PROXY_HEADER;
  delete process.env.TRUST_PROXY_HEADER;

  try {
    const response = createResponse();
    await relayHandler({
      method: 'POST',
      headers: {},
      body: { request_id: `missing-client-${Date.now()}` },
    }, response);

    assert.equal(response.statusCode, 400);
    assert.equal(response.payload?.error, 'client_identity_unavailable');
    assert.equal(response.headers['retry-after'], undefined);
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('draft operator API returns Retry-After header when rate limited', async () => {
  const ip = `operator-test-${Date.now()}`;
  for (let i = 0; i < 10; i += 1) {
    await draftOperatorHandler({
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
      socket: { remoteAddress: ip },
      body: {},
    }, createResponse());
  }

  const response = createResponse();
  await draftOperatorHandler({
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
    socket: { remoteAddress: ip },
    body: {},
  }, response);

  assert.equal(response.statusCode, 429);
  assert.equal(response.payload?.error, 'rate_limit_exceeded');
  assert.ok(Number(response.payload?.retryAfter) > 0);
  assert.equal(String(response.headers['retry-after']), String(response.payload?.retryAfter));
});

test('draft operator API does not rate limit the first request for a fresh client IP', async () => {
  const ip = `operator-first-${Date.now()}`;
  const response = createResponse();
  await draftOperatorHandler({
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
    socket: { remoteAddress: ip },
    body: {},
  }, response);

  assert.notEqual(response.statusCode, 429);
  assert.notEqual(response.payload?.error, 'rate_limit_exceeded');
});

test('relay API rate limit ignores spoofed forwarded-for by default', async () => {
  const socketIp = `relay-socket-${Date.now()}`;
  for (let i = 0; i < 10; i += 1) {
    await relayHandler({
      method: 'POST',
      headers: { 'x-forwarded-for': `spoofed-relay-${i}` },
      socket: { remoteAddress: socketIp },
      body: {},
    }, createResponse());
  }

  const response = createResponse();
  await relayHandler({
    method: 'POST',
    headers: { 'x-forwarded-for': 'spoofed-relay-final' },
    socket: { remoteAddress: socketIp },
    body: {},
  }, response);

  assert.equal(response.statusCode, 429);
  assert.equal(response.payload?.error, 'rate_limit_exceeded');
});

test('draft operator API rate limit ignores spoofed forwarded-for by default', async () => {
  const socketIp = `operator-socket-${Date.now()}`;
  for (let i = 0; i < 10; i += 1) {
    await draftOperatorHandler({
      method: 'POST',
      headers: { 'x-forwarded-for': `spoofed-operator-${i}` },
      socket: { remoteAddress: socketIp },
      body: {},
    }, createResponse());
  }

  const response = createResponse();
  await draftOperatorHandler({
    method: 'POST',
    headers: { 'x-forwarded-for': 'spoofed-operator-final' },
    socket: { remoteAddress: socketIp },
    body: {},
  }, response);

  assert.equal(response.statusCode, 429);
  assert.equal(response.payload?.error, 'rate_limit_exceeded');
});


test('draft operator claim validates the public key and uses compare-and-set semantics', () => {
  const source = fs.readFileSync(path.resolve('api/draft-operator.js'), 'utf8');

  assert.match(source, /importOperatorPublicKey\(publicKeyJwk\)/);
  assert.match(source, /\.is\('operator_public_key', null\)/);
  assert.match(source, /operator_key_already_claimed|operator_key_claim_failed/);
});

test('draft operator mutations use operator_counter compare-and-set updates', () => {
  const source = fs.readFileSync(path.resolve('api/draft-operator.js'), 'utf8');

  assert.match(source, /\.eq\('operator_counter', expectedCounter\)/);
  assert.match(source, /operator_counter_mismatch/);
});

test('relay API contains paymaster authorization before relay submission', () => {
  const source = fs.readFileSync(path.resolve('api/relay-transaction.js'), 'utf8');

  assert.match(source, /maybeAuthorizePaymaster/);
  assert.match(source, /paymaster_denied/);
  assert.match(source, /MORPHEUS_PAYMASTER_/);
});

test('relay API fails closed and caps the system fee when no paymaster is configured', () => {
  const source = fs.readFileSync(path.resolve('api/relay-transaction.js'), 'utf8');

  // Unsponsored opt-in gate guards the broadcast path.
  assert.match(source, /AA_RELAY_ALLOW_UNSPONSORED/);
  assert.match(source, /shouldAllowUnsponsoredRelay/);
  assert.match(source, /paymaster_not_configured/);
  // System fee cap rejects oversized simulations before signing.
  assert.match(source, /AA_RELAY_MAX_SYSTEM_FEE/);
  assert.match(source, /resolveMaxSystemFee/);
  assert.match(source, /exceeds AA_RELAY_MAX_SYSTEM_FEE/);
});

test('relay API binds paymaster requests to dapp and operation hashes', () => {
  const source = fs.readFileSync(path.resolve('api/relay-transaction.js'), 'utf8');

  assert.match(source, /dapp_id/);
  assert.match(source, /operation_hash/);
  assert.match(source, /userop_target_contract/);
  assert.match(source, /userop_method/);
  assert.match(source, /sha256Hex\(metaInvocation\)/);
  assert.match(source, /paymaster \? \{ \.\.\.result, paymaster \} : result/);
  assert.match(source, /resolveMorpheusOracleCvmId/);
});

test('relay API no longer routes paymaster authorization through the retired Phala remote path', () => {
  const source = fs.readFileSync(path.resolve('api/relay-transaction.js'), 'utf8');

  assert.doesNotMatch(source, /phala-remote/);
  assert.doesNotMatch(source, /callRemotePaymasterAuthorize/);
  assert.doesNotMatch(source, /resolvePhalaCliCommand/);
  assert.doesNotMatch(source, /x-phala-token/i);
  assert.doesNotMatch(source, /PHALA_/);
});

test('relay blocks unsponsored broadcasts when no paymaster is configured', async () => {
  const snapshot = {
    AA_RELAY_RPC_URL: process.env.AA_RELAY_RPC_URL,
    AA_RELAY_WIF: process.env.AA_RELAY_WIF,
    AA_RELAY_ALLOWED_HASH: process.env.AA_RELAY_ALLOWED_HASH,
    AA_RELAY_ALLOW_UNSPONSORED: process.env.AA_RELAY_ALLOW_UNSPONSORED,
    MORPHEUS_NETWORK: process.env.MORPHEUS_NETWORK,
    MORPHEUS_PAYMASTER_ENDPOINT: process.env.MORPHEUS_PAYMASTER_ENDPOINT,
    MORPHEUS_PAYMASTER_TESTNET_ENDPOINT: process.env.MORPHEUS_PAYMASTER_TESTNET_ENDPOINT,
    MORPHEUS_PAYMASTER_MAINNET_ENDPOINT: process.env.MORPHEUS_PAYMASTER_MAINNET_ENDPOINT,
    AA_PAYMASTER_ENDPOINT: process.env.AA_PAYMASTER_ENDPOINT,
    MORPHEUS_PAYMASTER_API_TOKEN: process.env.MORPHEUS_PAYMASTER_API_TOKEN,
    MORPHEUS_PAYMASTER_TESTNET_API_TOKEN: process.env.MORPHEUS_PAYMASTER_TESTNET_API_TOKEN,
    MORPHEUS_PAYMASTER_MAINNET_API_TOKEN: process.env.MORPHEUS_PAYMASTER_MAINNET_API_TOKEN,
    AA_PAYMASTER_API_TOKEN: process.env.AA_PAYMASTER_API_TOKEN,
    MORPHEUS_PAYMASTER_APP_ID: process.env.MORPHEUS_PAYMASTER_APP_ID,
    MORPHEUS_TESTNET_PAYMASTER_APP_ID: process.env.MORPHEUS_TESTNET_PAYMASTER_APP_ID,
    MORPHEUS_MAINNET_PAYMASTER_APP_ID: process.env.MORPHEUS_MAINNET_PAYMASTER_APP_ID,
  };

  const allowedHash = `0x${'ab'.repeat(20)}`;
  for (const key of Object.keys(snapshot)) {
    if (key.includes('PAYMASTER') || key === 'AA_RELAY_ALLOW_UNSPONSORED') {
      delete process.env[key];
    }
  }
  process.env.AA_RELAY_RPC_URL = 'https://relay-rpc.invalid';
  process.env.AA_RELAY_WIF = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn';
  process.env.AA_RELAY_ALLOWED_HASH = allowedHash;
  process.env.MORPHEUS_NETWORK = 'testnet';

  const originalFetch = globalThis.fetch;
  let broadcastAttempted = false;
  globalThis.fetch = async (url, cfg) => {
    const text = typeof cfg?.body === 'string' ? cfg.body : '';
    if (/sendrawtransaction/.test(text)) {
      broadcastAttempted = true;
    }
    throw new Error('network access is not expected before the unsponsored relay is blocked');
  };

  const metaInvocation = {
    scriptHash: 'ab'.repeat(20),
    operation: 'executeUserOp',
    args: [
      { type: 'Hash160', value: `0x${'aa'.repeat(20)}` },
      {
        type: 'Struct',
        value: [
          { type: 'Hash160', value: `0x${'bb'.repeat(20)}` },
          { type: 'String', value: 'transfer' },
          { type: 'Array', value: [] },
          { type: 'Integer', value: '1' },
          { type: 'Integer', value: String(Date.now() + 3600_000) },
          { type: 'ByteArray', value: '0x' },
        ],
      },
    ],
  };

  const response = createResponse();
  try {
    await relayHandler({
      method: 'POST',
      headers: { 'x-forwarded-for': `relay-unsponsored-${Date.now()}` },
      socket: { remoteAddress: `relay-unsponsored-${Date.now()}` },
      body: { metaInvocation, request_id: `unsponsored-${Date.now()}` },
    }, response);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(snapshot)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }

  assert.equal(response.statusCode, 402);
  assert.equal(response.payload?.error, 'paymaster_denied');
  assert.equal(response.payload?.paymaster?.approved, false);
  assert.equal(response.payload?.paymaster?.reason, 'paymaster_not_configured');
  assert.equal(broadcastAttempted, false);
});

test('paymaster authorization derives account and operation hash from the sanitized invocation', () => {
  assert.equal(typeof relayModule.buildPaymasterRequest, 'function');

  const accountId = `0x${'aa'.repeat(20)}`;
  const targetContract = `0x${'bb'.repeat(20)}`;
  const metaInvocation = {
    scriptHash: '11'.repeat(20),
    operation: 'executeUserOp',
    args: [
      { type: 'Hash160', value: accountId },
      {
        type: 'Struct',
        value: [
          { type: 'Hash160', value: targetContract },
          { type: 'String', value: 'transfer' },
        ],
      },
    ],
  };

  const request = relayModule.buildPaymasterRequest({
    metaInvocation,
    network: 'testnet',
    paymaster: {
      account_id: `0x${'cc'.repeat(20)}`,
      operation_hash: `0x${'dd'.repeat(32)}`,
      dapp_id: 'client-dapp',
    },
  });

  assert.equal(request.account_id, accountId);
  assert.equal(request.userop_target_contract, targetContract);
  assert.equal(request.operation_hash, `0x${createHash('sha256').update(JSON.stringify(metaInvocation)).digest('hex')}`);
  assert.notEqual(request.account_id, `0x${'cc'.repeat(20)}`);
  assert.notEqual(request.operation_hash, `0x${'dd'.repeat(32)}`);
});

test('paymaster authorization derives downstream fields for legacy wrapper invocations', () => {
  const accountId = `0x${'aa'.repeat(20)}`;
  const targetContract = `0x${'bb'.repeat(20)}`;
  const metaInvocation = {
    scriptHash: '11'.repeat(20),
    operation: 'executeUnifiedByAddress',
    args: [
      { type: 'Hash160', value: accountId },
      { type: 'Hash160', value: targetContract },
      { type: 'String', value: 'transfer' },
      { type: 'Array', value: [] },
      { type: 'Array', value: [{ type: 'ByteArray', value: `0x04${'11'.repeat(64)}` }] },
      { type: 'ByteArray', value: `0x${'ab'.repeat(32)}` },
      { type: 'Integer', value: '7' },
      { type: 'Integer', value: String(Date.now() + 3600_000) },
      { type: 'Array', value: [{ type: 'ByteArray', value: `0x${'12'.repeat(64)}` }] },
    ],
  };

  const request = relayModule.buildPaymasterRequest({
    metaInvocation,
    network: 'testnet',
    paymaster: {
      account_id: `0x${'cc'.repeat(20)}`,
      dapp_id: 'client-dapp',
    },
  });

  assert.equal(request.account_id, accountId);
  assert.equal(request.userop_target_contract, targetContract);
  assert.equal(request.userop_method, 'transfer');
});

test('paymaster authorization derives downstream fields for homogeneous batch user operations', () => {
  const accountId = `0x${'aa'.repeat(20)}`;
  const targetContract = `0x${'bb'.repeat(20)}`;
  const userOp = {
    type: 'Struct',
    value: [
      { type: 'Hash160', value: targetContract },
      { type: 'String', value: 'transfer' },
      { type: 'Array', value: [] },
      { type: 'Integer', value: '1' },
      { type: 'Integer', value: String(Date.now() + 3600_000) },
      { type: 'ByteArray', value: '0x' },
    ],
  };
  const metaInvocation = {
    scriptHash: '11'.repeat(20),
    operation: 'executeUserOps',
    args: [
      { type: 'Hash160', value: accountId },
      { type: 'Array', value: [userOp, JSON.parse(JSON.stringify(userOp))] },
    ],
  };

  const request = relayModule.buildPaymasterRequest({
    metaInvocation,
    network: 'testnet',
    paymaster: { dapp_id: 'client-dapp' },
  });

  assert.equal(request.account_id, accountId);
  assert.equal(request.userop_target_contract, targetContract);
  assert.equal(request.userop_method, 'transfer');
  assert.equal(request.userop_batch_size, 2);
});

test('paymaster authorization rejects malformed account or target hashes', () => {
  assert.throws(() => relayModule.buildPaymasterRequest({
    metaInvocation: {
      scriptHash: '11'.repeat(20),
      operation: 'executeUserOp',
      args: [
        { type: 'Hash160', value: 'not-a-hash' },
        {
          type: 'Struct',
          value: [
            { type: 'Hash160', value: `0x${'bb'.repeat(20)}` },
            { type: 'String', value: 'transfer' },
          ],
        },
      ],
    },
    network: 'testnet',
    paymaster: {},
  }), /requires a supported account-bound operation/);

  assert.throws(() => relayModule.buildPaymasterRequest({
    metaInvocation: {
      scriptHash: '11'.repeat(20),
      operation: 'executeUserOp',
      args: [
        { type: 'Hash160', value: `0x${'aa'.repeat(20)}` },
        {
          type: 'Struct',
          value: [
            { type: 'Hash160', value: '1234' },
            { type: 'String', value: 'transfer' },
          ],
        },
      ],
    },
    network: 'testnet',
    paymaster: {},
  }), /requires a supported account-bound operation/);
});

function feePolicyEnvSnapshot() {
  return {
    AA_RELAY_MAX_SYSTEM_FEE: process.env.AA_RELAY_MAX_SYSTEM_FEE,
    AA_RELAY_MAX_NETWORK_FEE: process.env.AA_RELAY_MAX_NETWORK_FEE,
    AA_RELAY_MAX_TOTAL_FEE: process.env.AA_RELAY_MAX_TOTAL_FEE,
  };
}

function clearFeePolicyEnv() {
  delete process.env.AA_RELAY_MAX_SYSTEM_FEE;
  delete process.env.AA_RELAY_MAX_NETWORK_FEE;
  delete process.env.AA_RELAY_MAX_TOTAL_FEE;
}

test('relay declares the network fee cap and a sponsored fee ceiling requirement', () => {
  const source = fs.readFileSync(path.resolve('api/relay-transaction.js'), 'utf8');

  assert.match(source, /AA_RELAY_MAX_NETWORK_FEE/);
  assert.match(source, /resolveMaxNetworkFee/);
  assert.match(source, /hasConfiguredFeeCeiling/);
  assert.match(source, /relay_fee_ceiling_not_configured/);
  // The fee policy is enforced before the funded transaction is signed/broadcast.
  assert.match(source, /enforceRelayFeePolicy/);
});

test('relay blocks a sponsored op whose networkFee exceeds AA_RELAY_MAX_NETWORK_FEE before broadcast', () => {
  assert.equal(typeof relayModule.enforceRelayFeePolicy, 'function');
  const snapshot = feePolicyEnvSnapshot();
  clearFeePolicyEnv();
  process.env.AA_RELAY_MAX_NETWORK_FEE = '100000';
  try {
    assert.throws(
      () => relayModule.enforceRelayFeePolicy({
        operation: 'executeUserOp',
        systemFee: '10',
        networkFee: '200000',
      }),
      /networkFee 200000 exceeds AA_RELAY_MAX_NETWORK_FEE 100000/,
    );
  } finally {
    restoreEnv(snapshot);
  }
});

test('relay caps the system fee and combined total when both ceilings are configured', () => {
  const snapshot = feePolicyEnvSnapshot();
  clearFeePolicyEnv();
  process.env.AA_RELAY_MAX_SYSTEM_FEE = '500000';
  process.env.AA_RELAY_MAX_TOTAL_FEE = '600000';
  try {
    assert.throws(
      () => relayModule.enforceRelayFeePolicy({
        operation: 'executeUserOp',
        systemFee: '600000',
        networkFee: '1',
      }),
      /systemFee 600000 exceeds AA_RELAY_MAX_SYSTEM_FEE 500000/,
    );
    assert.throws(
      () => relayModule.enforceRelayFeePolicy({
        operation: 'executeUserOp',
        systemFee: '400000',
        networkFee: '300000',
      }),
      /total fee 700000 exceeds AA_RELAY_MAX_TOTAL_FEE 600000/,
    );
  } finally {
    restoreEnv(snapshot);
  }
});

test('relay rejects a paymaster approval whose operation_hash does not match the relayed op', () => {
  assert.equal(typeof relayModule.verifyPaymasterApproval, 'function');

  const expected = `0x${'ab'.repeat(32)}`;
  // A positively approved payload bound to a different operation_hash is refused.
  assert.throws(
    () => relayModule.verifyPaymasterApproval(
      { approved: true, operation_hash: `0x${'cd'.repeat(32)}` },
      expected,
    ),
    /operation_hash does not match/,
  );
  // An "approved" that is merely not-false (e.g. a string/undefined) is refused.
  assert.throws(
    () => relayModule.verifyPaymasterApproval({ operation_hash: expected }, expected),
    /not positively approved/,
  );
  assert.throws(
    () => relayModule.verifyPaymasterApproval({ approved: 'yes', operation_hash: expected }, expected),
    /not positively approved/,
  );
  // An explicit denial passes through untouched so callers can short-circuit.
  const denied = relayModule.verifyPaymasterApproval({ approved: false, reason: 'over_budget' }, expected);
  assert.equal(denied.approved, false);
  assert.equal(denied.reason, 'over_budget');
});

test('relay binds a matching approval and enforces its approved spend ceiling', () => {
  const expected = `0x${'ab'.repeat(32)}`;
  const snapshot = feePolicyEnvSnapshot();
  clearFeePolicyEnv();
  try {
    const bound = relayModule.verifyPaymasterApproval(
      { approved: true, operation_hash: expected, approved_max_fee: '750000' },
      expected,
    );
    assert.equal(bound.approved, true);
    assert.equal(bound.operation_hash, expected);
    assert.equal(bound.approvedMaxFee, '750000');

    // The signing step must reject a total fee above the approved ceiling.
    assert.throws(
      () => relayModule.enforceRelayFeePolicy({
        operation: 'executeUserOp',
        systemFee: '500000',
        networkFee: '300000',
        approvedMaxFee: bound.approvedMaxFee,
      }),
      /total fee 800000 exceeds paymaster-approved maximum 750000/,
    );
  } finally {
    restoreEnv(snapshot);
  }
});

test('relay allows the canonical capped path when every fee is within bounds', () => {
  const expected = `0x${'ab'.repeat(32)}`;
  const snapshot = feePolicyEnvSnapshot();
  clearFeePolicyEnv();
  process.env.AA_RELAY_MAX_SYSTEM_FEE = '1000000';
  process.env.AA_RELAY_MAX_NETWORK_FEE = '1000000';
  process.env.AA_RELAY_MAX_TOTAL_FEE = '1500000';
  try {
    const bound = relayModule.verifyPaymasterApproval(
      { approved: true, operation_hash: expected, approved_max_fee: '1500000' },
      expected,
    );
    assert.equal(bound.approved, true);

    const enforced = relayModule.enforceRelayFeePolicy({
      operation: 'executeUserOp',
      systemFee: '400000',
      networkFee: '300000',
      approvedMaxFee: bound.approvedMaxFee,
    });
    assert.equal(enforced.systemFee, '400000');
    assert.equal(enforced.networkFee, '300000');
  } finally {
    restoreEnv(snapshot);
  }
});

test('relay refuses to sponsor a broadcast when no fee ceiling is configured', async () => {
  const snapshot = {
    ...feePolicyEnvSnapshot(),
    AA_RELAY_RPC_URL: process.env.AA_RELAY_RPC_URL,
    AA_RELAY_WIF: process.env.AA_RELAY_WIF,
    AA_RELAY_ALLOWED_HASH: process.env.AA_RELAY_ALLOWED_HASH,
    AA_RELAY_ALLOW_UNSPONSORED: process.env.AA_RELAY_ALLOW_UNSPONSORED,
    MORPHEUS_NETWORK: process.env.MORPHEUS_NETWORK,
    MORPHEUS_PAYMASTER_ENDPOINT: process.env.MORPHEUS_PAYMASTER_ENDPOINT,
    MORPHEUS_PAYMASTER_TESTNET_ENDPOINT: process.env.MORPHEUS_PAYMASTER_TESTNET_ENDPOINT,
    MORPHEUS_PAYMASTER_API_TOKEN: process.env.MORPHEUS_PAYMASTER_API_TOKEN,
  };

  clearFeePolicyEnv();
  delete process.env.AA_RELAY_ALLOW_UNSPONSORED;
  const allowedHash = `0x${'ab'.repeat(20)}`;
  process.env.AA_RELAY_RPC_URL = 'https://relay-rpc.invalid';
  process.env.AA_RELAY_WIF = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn';
  process.env.AA_RELAY_ALLOWED_HASH = allowedHash;
  process.env.MORPHEUS_NETWORK = 'testnet';
  // Configure a paymaster (sponsoring path) but deliberately leave every fee
  // ceiling unset so the relay must fail closed before broadcasting.
  process.env.MORPHEUS_PAYMASTER_ENDPOINT = 'https://paymaster.invalid/authorize';

  const originalFetch = globalThis.fetch;
  let networkTouched = false;
  globalThis.fetch = async () => {
    networkTouched = true;
    throw new Error('no network access is expected before the fee-ceiling gate blocks the relay');
  };

  const metaInvocation = {
    scriptHash: 'ab'.repeat(20),
    operation: 'executeUserOp',
    args: [
      { type: 'Hash160', value: `0x${'aa'.repeat(20)}` },
      {
        type: 'Struct',
        value: [
          { type: 'Hash160', value: `0x${'bb'.repeat(20)}` },
          { type: 'String', value: 'transfer' },
          { type: 'Array', value: [] },
          { type: 'Integer', value: '1' },
          { type: 'Integer', value: String(Date.now() + 3600_000) },
          { type: 'ByteArray', value: '0x' },
        ],
      },
    ],
  };

  const response = createResponse();
  try {
    await relayHandler({
      method: 'POST',
      headers: { 'x-forwarded-for': `relay-ceiling-${Date.now()}` },
      socket: { remoteAddress: `relay-ceiling-${Date.now()}` },
      body: { metaInvocation, request_id: `fee-ceiling-${Date.now()}` },
    }, response);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(snapshot);
  }

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload?.error, 'relay_fee_ceiling_not_configured');
  assert.equal(networkTouched, false);
});

test('rate limiter trusts only the configured proxy header', () => {
  const snapshot = {
    AA_TRUST_PROXY_HEADERS: process.env.AA_TRUST_PROXY_HEADERS,
    TRUST_PROXY_HEADERS: process.env.TRUST_PROXY_HEADERS,
    AA_TRUST_PROXY_HEADER: process.env.AA_TRUST_PROXY_HEADER,
    TRUST_PROXY_HEADER: process.env.TRUST_PROXY_HEADER,
  };

  process.env.AA_TRUST_PROXY_HEADERS = 'true';
  process.env.AA_TRUST_PROXY_HEADER = 'cf-connecting-ip';
  delete process.env.TRUST_PROXY_HEADERS;
  delete process.env.TRUST_PROXY_HEADER;

  try {
    assert.equal(
      resolveClientIp({
        headers: {
          'x-vercel-forwarded-for': 'spoofed-vercel',
          'x-forwarded-for': 'spoofed-client',
          'x-real-ip': 'spoofed-real-ip',
          'cf-connecting-ip': 'trusted-client',
        },
        socket: { remoteAddress: 'edge-proxy' },
      }),
      'trusted-client',
    );
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('rate limiter refuses generic forwarded-for as a trusted proxy header', () => {
  const snapshot = {
    AA_TRUST_PROXY_HEADERS: process.env.AA_TRUST_PROXY_HEADERS,
    TRUST_PROXY_HEADERS: process.env.TRUST_PROXY_HEADERS,
    AA_TRUST_PROXY_HEADER: process.env.AA_TRUST_PROXY_HEADER,
    TRUST_PROXY_HEADER: process.env.TRUST_PROXY_HEADER,
  };

  process.env.AA_TRUST_PROXY_HEADERS = 'true';
  process.env.AA_TRUST_PROXY_HEADER = 'x-forwarded-for';
  delete process.env.TRUST_PROXY_HEADERS;
  delete process.env.TRUST_PROXY_HEADER;

  try {
    assert.equal(
      resolveClientIp({
        headers: { 'x-forwarded-for': 'spoofed-client' },
        socket: { remoteAddress: 'edge-proxy' },
      }),
      'edge-proxy',
    );
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('rate limiter requires a socket or explicitly configured trusted proxy header', () => {
  const snapshot = {
    AA_TRUST_PROXY_HEADERS: process.env.AA_TRUST_PROXY_HEADERS,
    TRUST_PROXY_HEADERS: process.env.TRUST_PROXY_HEADERS,
    AA_TRUST_PROXY_HEADER: process.env.AA_TRUST_PROXY_HEADER,
    TRUST_PROXY_HEADER: process.env.TRUST_PROXY_HEADER,
  };

  delete process.env.AA_TRUST_PROXY_HEADERS;
  delete process.env.TRUST_PROXY_HEADERS;
  delete process.env.AA_TRUST_PROXY_HEADER;
  delete process.env.TRUST_PROXY_HEADER;

  try {
    assert.equal(
      resolveClientIp({
        headers: { 'x-forwarded-for': 'spoofed-client' },
      }),
      '',
    );
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('rate limiter rejects missing client identity instead of using a shared bucket', async () => {
  const rate = await checkRateLimit('');

  assert.equal(rate.allowed, false);
  assert.equal(rate.error, 'client_identity_unavailable');
});

test('rate limiter formats missing client identity without retry-after', () => {
  const failure = resolveRateLimitFailure({
    allowed: false,
    error: 'client_identity_unavailable',
    retryAfter: 60,
  });

  assert.equal(failure.statusCode, 400);
  assert.equal(failure.error, 'client_identity_unavailable');
  assert.equal(failure.retryAfter, 0);
});

test('relay execution config prefers network-scoped server settings when the server network is testnet', () => {
  const snapshot = {
    AA_RELAY_MAINNET_RPC_URL: process.env.AA_RELAY_MAINNET_RPC_URL,
    AA_RELAY_TESTNET_RPC_URL: process.env.AA_RELAY_TESTNET_RPC_URL,
    AA_RELAY_RPC_URL: process.env.AA_RELAY_RPC_URL,
    AA_RELAY_MAINNET_ALLOWED_HASH: process.env.AA_RELAY_MAINNET_ALLOWED_HASH,
    AA_RELAY_TESTNET_ALLOWED_HASH: process.env.AA_RELAY_TESTNET_ALLOWED_HASH,
    AA_RELAY_ALLOWED_HASH: process.env.AA_RELAY_ALLOWED_HASH,
    AA_RELAY_MAINNET_WIF: process.env.AA_RELAY_MAINNET_WIF,
    AA_RELAY_TESTNET_WIF: process.env.AA_RELAY_TESTNET_WIF,
    AA_RELAY_WIF: process.env.AA_RELAY_WIF,
    AA_RELAY_MAINNET_ALLOW_RAW_FORWARD: process.env.AA_RELAY_MAINNET_ALLOW_RAW_FORWARD,
    AA_RELAY_TESTNET_ALLOW_RAW_FORWARD: process.env.AA_RELAY_TESTNET_ALLOW_RAW_FORWARD,
    AA_RELAY_ALLOW_RAW_FORWARD: process.env.AA_RELAY_ALLOW_RAW_FORWARD,
    MORPHEUS_NETWORK: process.env.MORPHEUS_NETWORK,
  };

  process.env.AA_RELAY_MAINNET_RPC_URL = 'https://mainnet.rpc.example';
  process.env.AA_RELAY_TESTNET_RPC_URL = 'https://testnet.rpc.example';
  process.env.AA_RELAY_RPC_URL = 'https://global.rpc.example';
  process.env.AA_RELAY_MAINNET_ALLOWED_HASH = `0x${'11'.repeat(20)}`;
  process.env.AA_RELAY_TESTNET_ALLOWED_HASH = `0x${'22'.repeat(20)}`;
  process.env.AA_RELAY_ALLOWED_HASH = `0x${'33'.repeat(20)}`;
  process.env.AA_RELAY_MAINNET_WIF = 'mainnet-wif';
  process.env.AA_RELAY_TESTNET_WIF = 'testnet-wif';
  process.env.AA_RELAY_WIF = 'global-wif';
  process.env.AA_RELAY_MAINNET_ALLOW_RAW_FORWARD = '0';
  process.env.AA_RELAY_TESTNET_ALLOW_RAW_FORWARD = '1';
  process.env.AA_RELAY_ALLOW_RAW_FORWARD = '0';
  // AA-08: the request-payload network is ignored by default; the server env selects the
  // network whose scoped settings (RPC URL, WIF, allowed hash, raw-forward) must win.
  process.env.MORPHEUS_NETWORK = 'testnet';

  try {
    const config = resolveRelayExecutionConfig({
      req: {
        query: {},
        headers: {},
      },
      requestPayload: {
        morpheus_network: 'testnet',
      },
      paymaster: null,
    });

    assert.equal(config.network, 'testnet');
    assert.equal(config.rpcUrl, 'https://testnet.rpc.example');
    assert.equal(config.allowedAaContractHash, '2222222222222222222222222222222222222222');
    assert.equal(config.relayWif, 'testnet-wif');
    assert.equal(config.allowRawRelayForwarding, true);
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('account metadata API does not require a browser-visible API key for upserts', () => {
  const source = fs.readFileSync(path.resolve('api/account-metadata.js'), 'utf8');

  assert.doesNotMatch(source, /AA_METADATA_API_KEY/);
  assert.doesNotMatch(source, /x-api-key header required/);
});

function metadataEnvSnapshot() {
  const keys = [
    'SUPABASE_URL', 'VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
    'AA_RELAY_TESTNET_RPC_URL', 'AA_RELAY_RPC_URL', 'VITE_AA_RPC_URL', 'VITE_NEO_RPC_URL',
    'AA_RELAY_TESTNET_ALLOWED_HASH', 'AA_RELAY_ALLOWED_HASH', 'VITE_AA_HASH_TESTNET', 'VITE_ABSTRACT_ACCOUNT_HASH_TESTNET',
    'VITE_AA_NETWORK', 'MORPHEUS_NETWORK',
  ];
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

function stubMetadataNetwork({ backupOwnerScriptHash } = {}) {
  const originalFetch = globalThis.fetch;
  const calls = { rpc: 0, upsert: 0 };
  globalThis.fetch = async (url, cfg) => {
    const target = String(url);
    const text = typeof cfg?.body === 'string' ? cfg.body : '';
    if (target.includes('/rest/v1/')) {
      calls.upsert += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ([]),
        text: async () => '[]',
        headers: { get: () => 'application/json' },
      };
    }
    if (/getBackupOwner/.test(text) || /invokefunction/.test(text)) {
      calls.rpc += 1;
      const stack = backupOwnerScriptHash
        ? [{ type: 'ByteString', value: Buffer.from(backupOwnerScriptHash, 'hex').toString('base64') }]
        : [{ type: 'Any', value: null }];
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { state: 'HALT', gasconsumed: '1', stack } }),
        text: async () => '',
        headers: { get: () => 'application/json' },
      };
    }
    throw new Error(`unexpected fetch in metadata test: ${target}`);
  };
  return {
    calls,
    restore() { globalThis.fetch = originalFetch; },
  };
}

test('account metadata upsert rejects unauthenticated callers', async () => {
  const snapshot = metadataEnvSnapshot();
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.MORPHEUS_NETWORK = 'testnet';

  const stub = stubMetadataNetwork({});
  const response = createResponse();
  try {
    await accountMetadataHandler({
      method: 'POST',
      headers: { 'x-forwarded-for': `metadata-unauth-${Date.now()}` },
      socket: { remoteAddress: `metadata-unauth-${Date.now()}` },
      body: {
        action: 'upsert',
        accountIdHash: 'cd'.repeat(20),
        description: 'unauthorized write',
        logoUrl: 'https://example.com/logo.png',
      },
    }, response);
  } finally {
    stub.restore();
    restoreEnv(snapshot);
  }

  assert.equal(response.statusCode, 403);
  assert.match(String(response.payload?.error || ''), /Proof of account control required/);
  // No control proof means the row is never written.
  assert.equal(stub.calls.upsert, 0);
});

test('account metadata upsert accepts a backup-owner signed proof of control', async () => {
  const snapshot = metadataEnvSnapshot();
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.AA_RELAY_TESTNET_RPC_URL = 'https://aa-rpc.invalid';
  process.env.MORPHEUS_NETWORK = 'testnet';

  const owner = new neonWallet.Account();
  const ownerScriptHash = neonWallet.getScriptHashFromPublicKey(owner.publicKey).replace(/^0x/i, '').toLowerCase();
  const accountIdHash = 'ef'.repeat(20);
  const message = `aa-metadata-control:${accountIdHash}:${Date.now()}`;
  const signature = neonWallet.sign(Buffer.from(message, 'utf8').toString('hex'), owner.privateKey);

  const stub = stubMetadataNetwork({ backupOwnerScriptHash: ownerScriptHash });
  const response = createResponse();
  try {
    await accountMetadataHandler({
      method: 'POST',
      headers: { 'x-forwarded-for': `metadata-auth-${Date.now()}` },
      socket: { remoteAddress: `metadata-auth-${Date.now()}` },
      body: {
        action: 'upsert',
        accountIdHash,
        description: 'authorized write',
        logoUrl: 'https://example.com/logo.png',
        ownerProof: {
          publicKey: owner.publicKey,
          signature,
          message,
        },
      },
    }, response);
  } finally {
    stub.restore();
    restoreEnv(snapshot);
  }

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload?.ok, true);
  assert.equal(stub.calls.upsert, 1);
});

test('account metadata upsert rejects a signed proof from a non-owner key', async () => {
  const snapshot = metadataEnvSnapshot();
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.AA_RELAY_TESTNET_RPC_URL = 'https://aa-rpc.invalid';
  process.env.MORPHEUS_NETWORK = 'testnet';

  const owner = new neonWallet.Account();
  const ownerScriptHash = neonWallet.getScriptHashFromPublicKey(owner.publicKey).replace(/^0x/i, '').toLowerCase();
  const attacker = new neonWallet.Account();
  const accountIdHash = 'ef'.repeat(20);
  const message = `aa-metadata-control:${accountIdHash}:${Date.now()}`;
  const signature = neonWallet.sign(Buffer.from(message, 'utf8').toString('hex'), attacker.privateKey);

  const stub = stubMetadataNetwork({ backupOwnerScriptHash: ownerScriptHash });
  const response = createResponse();
  try {
    await accountMetadataHandler({
      method: 'POST',
      headers: { 'x-forwarded-for': `metadata-spoof-${Date.now()}` },
      socket: { remoteAddress: `metadata-spoof-${Date.now()}` },
      body: {
        action: 'upsert',
        accountIdHash,
        description: 'spoofed write',
        ownerProof: {
          publicKey: attacker.publicKey,
          signature,
          message,
        },
      },
    }, response);
  } finally {
    stub.restore();
    restoreEnv(snapshot);
  }

  assert.equal(response.statusCode, 403);
  assert.equal(stub.calls.upsert, 0);
});

test('account metadata reads remain open without a control proof', async () => {
  const snapshot = metadataEnvSnapshot();
  process.env.SUPABASE_URL = 'https://stub.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  const originalFetch = globalThis.fetch;
  let restGetCalled = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/rest/v1/')) restGetCalled = true;
    return {
      ok: true,
      status: 200,
      json: async () => ({ description: 'public', logo_url: '', metadata_uri: '', updated_at: null }),
      text: async () => JSON.stringify({ description: 'public', logo_url: '', metadata_uri: '', updated_at: null }),
      headers: { get: () => 'application/json' },
    };
  };

  const response = createResponse();
  try {
    await accountMetadataHandler({
      method: 'POST',
      headers: { 'x-forwarded-for': `metadata-read-${Date.now()}` },
      socket: { remoteAddress: `metadata-read-${Date.now()}` },
      body: { action: 'get', accountIdHash: 'ef'.repeat(20) },
    }, response);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(snapshot);
  }

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload?.ok, true);
  assert.equal(restGetCalled, true);
});

test('gitignore quarantines local testnet secret artifacts', () => {
  const source = fs.readFileSync(path.resolve('..', '.gitignore'), 'utf8');

  assert.match(source, /tests\/\.env\.testnet/);
  assert.match(source, /tests\/VALIDATION_SUMMARY\.md/);
  assert.match(source, /tests\/MIXED_VERIFICATION_PLAN\.md/);
  assert.match(source, /tests\/mixed-verification-test\.js/);
  assert.match(source, /tests\/run-mixed-verification\.js/);
});

test('sanitizeMetaInvocationForRelay allows sponsored user operations that carry the on-chain paymaster budget', () => {
  const aaContractHash = '0x5be915aea3ce85e4752d522632f0a9520e377aaf';
  assert.ok(ALLOWED_RELAY_META_OPERATIONS.includes('executeSponsoredUserOp'));
  assert.ok(ALLOWED_RELAY_META_OPERATIONS.includes('executeSponsoredUserOps'));

  const sponsoredOp = {
    scriptHash: aaContractHash,
    operation: 'executeSponsoredUserOp',
    args: [
      { type: 'Hash160', value: `0x${'aa'.repeat(20)}` },
      {
        type: 'Struct',
        value: [
          { type: 'Hash160', value: `0x${'bb'.repeat(20)}` },
          { type: 'String', value: 'transfer' },
          { type: 'Array', value: [] },
          { type: 'Integer', value: '1' },
          { type: 'Integer', value: '1710000000' },
          { type: 'ByteArray', value: '0x' },
        ],
      },
      { type: 'Hash160', value: `0x${'cc'.repeat(20)}` },
      { type: 'Hash160', value: `0x${'dd'.repeat(20)}` },
      { type: 'Integer', value: '1000000' },
    ],
    signers: [{ account: '0xattacker', scopes: 255 }],
  };

  const sanitized = sanitizeMetaInvocationForRelay(sponsoredOp, { aaContractHash });
  assert.ok(sanitized, 'executeSponsoredUserOp should be relayable');
  assert.equal(sanitized.operation, 'executeSponsoredUserOp');
  assert.equal(sanitized.scriptHash, '5be915aea3ce85e4752d522632f0a9520e377aaf');
  // Caller-supplied signers are stripped so the relay controls witness scope.
  assert.equal(sanitized.signers, undefined);
  assert.equal(sanitized.args.length, 5);

  const sponsoredBatch = {
    scriptHash: aaContractHash,
    operation: 'executeSponsoredUserOps',
    args: [
      { type: 'Hash160', value: `0x${'aa'.repeat(20)}` },
      { type: 'Array', value: [] },
      { type: 'Hash160', value: `0x${'cc'.repeat(20)}` },
      { type: 'Hash160', value: `0x${'dd'.repeat(20)}` },
      { type: 'Integer', value: '1000000' },
    ],
  };
  const sanitizedBatch = sanitizeMetaInvocationForRelay(sponsoredBatch, { aaContractHash });
  assert.ok(sanitizedBatch, 'executeSponsoredUserOps should be relayable');
  assert.equal(sanitizedBatch.operation, 'executeSponsoredUserOps');
});

test('sanitizeMetaInvocationForRelay rejects operations outside the relay allowlist', () => {
  const aaContractHash = '0x5be915aea3ce85e4752d522632f0a9520e377aaf';
  // An operation that is not part of the contract surface (and therefore not in
  // the allowlist) must never be forwarded to the relay signer.
  for (const operation of ['executeArbitrary', 'drainPaymaster', 'transfer']) {
    assert.ok(!ALLOWED_RELAY_META_OPERATIONS.includes(operation));
    assert.equal(
      sanitizeMetaInvocationForRelay({
        scriptHash: aaContractHash,
        operation,
        args: [],
      }, { aaContractHash }),
      null,
      `${operation} must be rejected`,
    );
  }
});

test('relay refuses an entrypoint the deployed ABI does not export before any RPC and names it', async () => {
  // CU-203: executeUnified appears in no deployed manifest and in no contract source. Before the
  // fix it passed the helper and the route asked a node to invoke it, so the caller saw a
  // simulation or paymaster error instead of "that operation does not exist". The refusal must now
  // happen at validation, name the operation, and touch no RPC.
  const { CORE_HASH } = await import('./fixtures/aaChainFixtures.js');
  const { withRelay, post, startNode } = await import('./fixtures/relayHarness.js');

  // Count outbound calls without breaking the ones the accepted control needs: the SDK's RPC
  // client is a real HTTP client, so the wrapper forwards. A refused operation must produce none.
  let fetchAttempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    fetchAttempts += 1;
    return originalFetch(...args);
  };

  // The node records every RPC it receives; a refused operation must never reach it. The stub
  // answers a plain HALT so the accepted control below can complete.
  const node = await startNode({ invokeScript: () => ({ script: 'AAAA', state: 'HALT', gasconsumed: '1000', exception: null, stack: [] }) });
  try {
    const refused = await withRelay(node, {}, () => post({
      metaInvocation: {
        scriptHash: CORE_HASH,
        operation: 'executeUnified',
        args: [],
      },
    }));

    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'relay_meta_invocation_not_allowed');
    assert.equal(
      refused.body.reason,
      'unsupported relay operation: executeUnified is not in the deployed Abstract Account ABI',
    );
    assert.equal(node.count('invokescript'), 0, 'the node was never asked to invoke a dead entrypoint');
    assert.equal(fetchAttempts, 0, 'no outbound call was attempted for a refused operation');

    const accepted = await withRelay(node, {}, () => post({
      metaInvocation: {
        scriptHash: CORE_HASH,
        operation: 'executeUserOp',
        args: [
          { type: 'Hash160', value: `0x${'aa'.repeat(20)}` },
          { type: 'Struct', value: [] },
        ],
      },
    }));
    assert.notEqual(accepted.status, 400, 'a deployed entrypoint still reaches the relay');
    assert.ok(node.count('invokescript') >= 1, 'the deployed entrypoint was simulated');
  } finally {
    globalThis.fetch = originalFetch;
    await node.close();
  }
});
