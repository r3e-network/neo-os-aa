/**
 * v4 retry: one classification for every retry layer.
 *
 * v3 exposed `invokeScriptWithRetry` / `invokeFunctionWithRetry` helpers that
 * callers had to remember. v4 retries inside the transport, so every read the
 * client makes is covered by construction and no caller can forget it, while
 * `retry: false` still opts out. A contract fault is never retried: a FAULT is
 * an answer, not a transport failure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { SmartAccountClient } = require('../src/index');
const { withRetry, isRetryableError } = require('../src/retry');

const CORE = '1234567890123456789012345678901234567890';
const NETWORK = 894710606;
const ACCOUNT_ID = 'f951cd3eb5196dacde99b339c5dcca37ac38cc22';
/** Fast enough for a unit test while still exercising the backoff loop. */
const FAST = { maxAttempts: 3, baseDelayMs: 1, backoffMultiplier: 1 };

const halt = (stack = []) => ({ state: 'HALT', stack });

/** A client whose transport answers from a scripted list of behaviours. */
function scripted(behaviours, options = {}) {
  const client = new SmartAccountClient({
    rpcClient: {
      async send(method, params) {
        const behaviour = behaviours[method];
        return typeof behaviour === 'function' ? behaviour(params) : { result: behaviour };
      },
    },
    networkMagic: NETWORK,
    contractHash: CORE,
    retry: FAST,
    ...options,
  });
  return client;
}

test('withRetry retries a transport failure and returns the third answer', async () => {
  let attempts = 0;
  const answer = await withRetry(
    'rpc.invokescript',
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('Client network socket disconnected before secure TLS connection was established');
      }
      return 'halted';
    },
    FAST,
  );
  assert.equal(answer, 'halted');
  assert.equal(attempts, 3);
});

test('withRetry never retries a contract fault or a malformed answer', async () => {
  for (const message of ['contract fault', 'SmartAccount v4: malformed account descriptor']) {
    let attempts = 0;
    await assert.rejects(
      () =>
        withRetry(
          'rpc.invokescript',
          async () => {
            attempts += 1;
            throw new Error(message);
          },
          FAST,
        ),
      new RegExp(message.slice(0, 20)),
    );
    assert.equal(attempts, 1, `${message} must surface on the first attempt`);
  }
  // The classification is the one the whole SDK shares.
  assert.equal(isRetryableError(new Error('socket hang up')), true);
  assert.equal(isRetryableError(new Error('502 Bad Gateway')), true);
  assert.equal(isRetryableError(new Error('SA_NONCE_INVALID')), false);
});

test('every client read is retried by the transport, not by the caller', async () => {
  let attempts = 0;
  const client = scripted({
    getversion: () => {
      attempts += 1;
      if (attempts < 3) throw new Error('socket hang up');
      return halt();
    },
  });
  // `getversion` is the first call discovery makes; the retry belongs to the
  // transport, so the caller only sees the settled answer.
  const version = await client._send('getversion', []);
  assert.equal(attempts, 3);
  assert.equal(version.state, 'HALT');
});

test('retry:false leaves a transient failure to the caller', async () => {
  let attempts = 0;
  const client = scripted(
    {
      getversion: () => {
        attempts += 1;
        throw new Error('socket hang up');
      },
    },
    { retry: false },
  );
  await assert.rejects(() => client._send('getversion', []), /socket hang up/);
  assert.equal(attempts, 1);
});
