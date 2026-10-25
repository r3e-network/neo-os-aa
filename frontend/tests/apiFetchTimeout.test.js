import test from 'node:test';
import assert from 'node:assert/strict';

import { apiFetch, resolveApiFetchTimeoutMs } from '../api/outboundFetch.js';
import { DEFAULT_FETCH_TIMEOUT_MS } from '../src/utils/fetchWithTimeout.js';
import morpheusOracleKeyHandler from '../api/morpheus-oracle-public-key.js';
import relayHandler from '../api/relay-transaction.js';

// L1 regression coverage: every outbound fetch from the API surface must run behind an
// abort-based timeout so a hung upstream can never wedge a serverless invocation until the
// platform kills it.

const ENV_KEYS = [
  'AA_API_FETCH_TIMEOUT_MS',
  'MORPHEUS_NETWORK',
  'MORPHEUS_MAINNET_RUNTIME_URL',
  'AA_RELAY_ALLOW_RAW_FORWARD',
  'AA_RELAY_MAINNET_RPC_URL',
  'AA_RELAY_RPC_URL',
  'AA_RELAY_MAINNET_WIF',
  'AA_RELAY_WIF',
];

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

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
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };
}

// A fetch that never resolves on its own; only the abort signal settles it (mirrors how a
// genuinely hung upstream behaves behind an AbortController).
function neverResolvingFetch(calls) {
  return (url, options) => new Promise((resolve, reject) => {
    calls.push({ url, signal: Boolean(options?.signal), redirect: options?.redirect });
    options?.signal?.addEventListener('abort', () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

// Guard so a missing timeout fails the test fast instead of hanging the suite.
async function withinBudget(promise, ms = 3000) {
  let timer;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('no timeout enforced — upstream call hung past the budget')), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

test('L1: apiFetch rejects a stalled upstream with EC_request_timed_out inside the budget', async () => {
  const calls = [];
  await assert.rejects(
    () => apiFetch('https://upstream.example.invalid', { method: 'POST', redirect: 'follow' }, { fetchImpl: neverResolvingFetch(calls), timeoutMs: 25 }),
    /EC_request_timed_out/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal, true, 'an abort signal is always attached');
  assert.equal(calls[0].redirect, 'error', 'apiFetch callers cannot re-enable redirect following');
});

test('L1: the API timeout defaults to the shared default and honors AA_API_FETCH_TIMEOUT_MS', () => {
  const snapshot = snapshotEnv();
  delete process.env.AA_API_FETCH_TIMEOUT_MS;

  try {
    assert.equal(resolveApiFetchTimeoutMs(), DEFAULT_FETCH_TIMEOUT_MS, 'default matches the shared helper default');
    process.env.AA_API_FETCH_TIMEOUT_MS = '25';
    assert.equal(resolveApiFetchTimeoutMs(), 25, 'operator override honored');
    process.env.AA_API_FETCH_TIMEOUT_MS = 'not-a-number';
    assert.equal(resolveApiFetchTimeoutMs(), DEFAULT_FETCH_TIMEOUT_MS, 'invalid override falls back to the default');
  } finally {
    restoreEnv(snapshot);
  }
});

test('L1: morpheus oracle-key proxy cannot be wedged by a hung upstream', async () => {
  const snapshot = snapshotEnv();
  const originalFetch = global.fetch;
  const calls = [];

  process.env.AA_API_FETCH_TIMEOUT_MS = '25';
  delete process.env.MORPHEUS_NETWORK;
  process.env.MORPHEUS_MAINNET_RUNTIME_URL = 'https://oracle.example.invalid';
  global.fetch = neverResolvingFetch(calls);

  try {
    const started = Date.now();
    await assert.rejects(
      () => withinBudget(morpheusOracleKeyHandler({
        method: 'GET',
        query: {},
        headers: {},
        socket: { remoteAddress: `l1-oracle-${Date.now()}` },
      }, createResponse())),
      /EC_request_timed_out|no timeout enforced/,
    );
    assert.ok(Date.now() - started < 3000, 'the invocation settled inside the budget');
    assert.equal(calls.length, 1, 'exactly one upstream call was attempted');
    assert.equal(calls[0].signal, true, 'the upstream call carried an abort signal');
  } finally {
    global.fetch = originalFetch;
    restoreEnv(snapshot);
  }
});

test('L1: relay raw-forward answers 502 (not a hung invocation) when the RPC stalls', async () => {
  const snapshot = snapshotEnv();
  const originalFetch = global.fetch;
  const calls = [];

  process.env.AA_API_FETCH_TIMEOUT_MS = '25';
  delete process.env.MORPHEUS_NETWORK;
  process.env.AA_RELAY_ALLOW_RAW_FORWARD = '1';
  process.env.AA_RELAY_MAINNET_RPC_URL = 'https://rpc.example.invalid';
  process.env.AA_RELAY_MAINNET_WIF = 'dummy-wif';
  global.fetch = neverResolvingFetch(calls);

  try {
    const res = createResponse();
    await withinBudget(relayHandler({
      method: 'POST',
      headers: {},
      socket: { remoteAddress: `l1-relay-${Date.now()}` },
      body: { rawTransaction: '0xdeadbeef' },
    }, res));

    assert.equal(res.statusCode, 502, 'a stalled RPC surfaces as a clean 502');
    assert.equal(res.payload?.error, 'relay_network_error');
    assert.ok(calls.length >= 1, 'the upstream RPC was attempted');
    assert.equal(calls[0].signal, true, 'the RPC call carried an abort signal');
  } finally {
    global.fetch = originalFetch;
    restoreEnv(snapshot);
  }
});
