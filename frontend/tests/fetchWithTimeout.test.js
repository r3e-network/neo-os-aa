import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from '../src/utils/fetchWithTimeout.js';
import { invokeReadFunction } from '../src/utils/neo.js';
import { computeArgsHash } from '../src/features/operations/metaTx.js';

test('fetchWithTimeout resolves with the response, passes an abort signal and refuses redirect overrides', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, async json() { return { hello: 'world' }; } };
  };

  const response = await fetchWithTimeout('https://rpc.example.org', { method: 'POST' }, { fetchImpl });
  await fetchWithTimeout('https://rpc.example.org', { method: 'POST', redirect: 'follow' }, { fetchImpl });

  assert.equal(response.ok, true);
  assert.equal(calls[0].url, 'https://rpc.example.org');
  assert.equal(calls[0].options.method, 'POST');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[1].options.redirect, 'error', 'a caller cannot re-enable redirect following');
  assert.equal(DEFAULT_FETCH_TIMEOUT_MS, 15000);
});

test('fetchWithTimeout aborts a stalled request with EC_request_timed_out', async () => {
  const fetchImpl = (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

  await assert.rejects(
    () => fetchWithTimeout('https://rpc.example.org', {}, { fetchImpl, timeoutMs: 25 }),
    /EC_request_timed_out/,
  );
});

test('fetchWithTimeout honors a caller-provided signal instead of the timeout', async () => {
  const controller = new AbortController();
  const fetchImpl = async (url, options) => {
    assert.equal(options.signal, controller.signal);
    return { ok: true };
  };

  const response = await fetchWithTimeout('https://rpc.example.org', { signal: controller.signal }, { fetchImpl });
  assert.equal(response.ok, true);
});

test('invokeReadFunction forwards the injected fetchImpl instead of dropping it', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return {
      ok: true,
      async json() {
        return { result: { state: 'HALT', stack: [] } };
      },
    };
  };

  const result = await invokeReadFunction(
    'https://rpc.example.org',
    '5be915aea3ce85e4752d522632f0a9520e377aaf',
    'getVerifier',
    [{ type: 'Hash160', value: 'f951cd3eb5196dacde99b339c5dcca37ac38cc22' }],
    fetchImpl,
  );

  assert.equal(result.state, 'HALT');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://rpc.example.org');
  assert.equal(calls[0][1].method, 'invokefunction');
  assert.equal(calls[0][1].params[1], 'getVerifier');
});

test('metaTx invokeRead surfaces non-OK responses as EC_rpc_request_failed instead of a parse error', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 502,
    async text() {
      return '<html>Bad Gateway</html>';
    },
    async json() {
      throw new SyntaxError('Unexpected token <');
    },
  });

  await assert.rejects(
    () => computeArgsHash({
      rpcUrl: 'https://rpc.example.org',
      aaContractHash: '5be915aea3ce85e4752d522632f0a9520e377aaf',
      args: [],
      fetchImpl,
    }),
    /EC_rpc_request_failed/,
  );
});
