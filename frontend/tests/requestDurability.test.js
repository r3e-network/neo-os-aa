import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beginDurableRequest,
  completeDurableRequest,
  failDurableRequest,
} from '../api/requestDurability.js';

// L3 regression coverage: client-supplied request ids (x-request-id header / request_id
// payload field) flow into Redis journal keys. The raw id must never become a key — it is
// hashed (mirroring the lock/response siblings), while the raw value is kept only for
// logs/echo responses.
//
// F-13/F-14 (re-verified from code): a configured-but-erroring durability backend used to
// THROW out of beginDurableRequest (opaque platform 500 on the entry path) and out of
// complete/failDurableRequest AFTER the relayed work had already executed (turning a
// completed broadcast into a client-visible failure that invites a duplicate retry). The
// begin phase now mirrors the AA-07 rate-limiter policy — production fails closed with a
// clear 503, non-production degrades without durability — and post-execution bookkeeping
// is best-effort and can never fail the response.

const JOURNAL_KEY_PATTERN = /^sa:request:journal:relay_transaction:[0-9a-f]{64}$/;

const DURABILITY_ENV_KEYS = [
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'NODE_ENV',
  'VERCEL_ENV',
];

function snapshotDurabilityEnv() {
  return Object.fromEntries(DURABILITY_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreDurabilityEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

function configureErroringUpstash() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.example.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
}

function stubThrowingFetch() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('upstash connection reset'); };
  return () => { globalThis.fetch = originalFetch; };
}

function createResStub() {
  const state = { headers: {}, statusCode: null, body: null };
  const res = {
    setHeader(name, value) { state.headers[String(name).toLowerCase()] = String(value); },
    status(code) {
      state.statusCode = code;
      return { json(body) { state.body = body; } };
    },
  };
  return { res, state };
}

async function journalKeyFor(rawRequestId) {
  const { context } = await beginDurableRequest({
    req: { headers: { 'x-request-id': rawRequestId } },
    routeName: 'relay_transaction',
    payload: {},
    fingerprint: { probe: true },
  });
  return context;
}

test('L3: distinct client request ids produce distinct, fixed-shape journal keys', async () => {
  const first = await journalKeyFor('client-id-alpha');
  const second = await journalKeyFor('client-id-beta');

  assert.notEqual(first.journalKey, second.journalKey, 'distinct raw ids map to distinct keys');
  assert.match(first.journalKey, JOURNAL_KEY_PATTERN, 'journal key is the hashed fixed shape');
  assert.match(second.journalKey, JOURNAL_KEY_PATTERN, 'journal key is the hashed fixed shape');
});

test('L3: the same client request id maps deterministically to the same journal key', async () => {
  const first = await journalKeyFor('repeatable-id');
  const second = await journalKeyFor('repeatable-id');

  assert.equal(first.journalKey, second.journalKey, 'idempotent mapping for the same raw id');
});

test('L3: malicious or oversized request ids still produce a fixed-shape key', async () => {
  const injection = await journalKeyFor('sa:request:lock:*');
  const oversized = await journalKeyFor('x'.repeat(512));

  assert.match(injection.journalKey, JOURNAL_KEY_PATTERN, 'key-injection input is neutralized');
  assert.match(oversized.journalKey, JOURNAL_KEY_PATTERN, 'oversized input collapses to the fixed shape');
  assert.notEqual(injection.journalKey, oversized.journalKey);
  assert.ok(
    !injection.journalKey.includes('sa:request:lock'),
    'raw id cannot smuggle another key namespace into the journal key',
  );
});

test('L3: the raw request id is preserved for logs and echo responses, not the key', async () => {
  const rawId = 'echo-me-123';
  const context = await journalKeyFor(rawId);

  assert.equal(context.requestId, rawId, 'raw id stays available for echo/logging');
  assert.ok(!context.journalKey.includes(rawId), 'raw id does not appear in the Redis key');
});

test('live authorization reads can disable replay even with caller-provided idempotency keys', async () => {
  const request = {
    req: { headers: { 'idempotency-key': 'same-client-key' } },
    routeName: 'draft_operator', payload: { action: 'claim' }, fingerprint: { action: 'claim', shareSlug: 'draft-one' },
  };
  const ordinary = await beginDurableRequest(request);
  const fresh = await beginDurableRequest({ ...request, replay: false });
  assert.notEqual(ordinary.context.responseKey, '');
  assert.equal(fresh.context.responseKey, '');
  assert.equal(fresh.context.lockKey, '');
  assert.equal(fresh.context.idempotencyKey, '');
  assert.ok(fresh.context.journalKey);
});

test('F-13: an erroring durability backend fails CLOSED at the begin phase in production', async () => {
  // Re-verified from code: beginDurableRequest used to let the Upstash error
  // propagate — the route crashed with an opaque platform 500 before any work
  // ran. It must instead fail closed with a machine-readable outcome the route
  // can turn into a clear 503 (mirrors the AA-07 rate-limiter policy).
  const snapshot = snapshotDurabilityEnv();
  const restoreFetch = stubThrowingFetch();
  const originalError = console.error;
  const originalWarn = console.warn;
  const errorLogs = [];
  const warnLogs = [];
  console.error = (...args) => errorLogs.push(args.join(' '));
  console.warn = (...args) => warnLogs.push(args.join(' '));

  configureErroringUpstash();
  process.env.NODE_ENV = 'production';
  delete process.env.VERCEL_ENV;

  try {
    const outcome = await beginDurableRequest({
      req: { headers: { 'idempotency-key': 'f13-prod' } },
      routeName: 'relay_transaction',
      payload: {},
      fingerprint: { probe: true },
    });

    assert.equal(outcome.ok, false, 'the request must not proceed as if durable');
    assert.equal(outcome.backendUnavailable, true, 'the outcome names the backend outage');
    assert.ok(outcome.retryAfter > 0, 'a retry hint is attached for the 503 Retry-After header');
    assert.equal(outcome.context.routeName, 'relay_transaction', 'context survives for logging');
    assert.ok(
      errorLogs.some((line) => /production/i.test(line) && /fail/i.test(line)),
      'the fail-closed decision is logged loudly',
    );
  } finally {
    restoreFetch();
    console.error = originalError;
    console.warn = originalWarn;
    restoreDurabilityEnv(snapshot);
  }
});

test('F-13: outside production an erroring durability backend degrades (no replay/lock/journal) with a warning', async () => {
  const snapshot = snapshotDurabilityEnv();
  const restoreFetch = stubThrowingFetch();
  const originalError = console.error;
  const originalWarn = console.warn;
  const errorLogs = [];
  const warnLogs = [];
  console.error = (...args) => errorLogs.push(args.join(' '));
  console.warn = (...args) => warnLogs.push(args.join(' '));

  configureErroringUpstash();
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;

  try {
    const outcome = await beginDurableRequest({
      req: { headers: { 'idempotency-key': 'f13-dev' } },
      routeName: 'relay_transaction',
      payload: {},
      fingerprint: { probe: true },
    });

    assert.equal(outcome.ok, true, 'non-production proceeds without durability');
    assert.equal(outcome.degraded, true, 'the degraded mode is explicit, not silent');
    assert.equal(errorLogs.length, 0, 'no production alarm outside production');
    assert.ok(
      warnLogs.some((line) => /durability backend failed/i.test(line)),
      'the degraded decision is warned about',
    );
  } finally {
    restoreFetch();
    console.error = originalError;
    console.warn = originalWarn;
    restoreDurabilityEnv(snapshot);
  }
});

test('F-14: a response-cache/journal failure after the work executed never fails the client response', async () => {
  // Re-verified from code: completeDurableRequest ran AFTER the relayed work —
  // often after a transaction was already broadcast. A backend error here used
  // to throw out of the handler, converting a completed broadcast into a
  // client-visible 500 that invites a retry (and a duplicate broadcast).
  // Bookkeeping is now best-effort: log, never throw.
  const snapshot = snapshotDurabilityEnv();
  const restoreFetch = stubThrowingFetch();
  const originalError = console.error;
  const errorLogs = [];
  console.error = (...args) => errorLogs.push(args.join(' '));

  configureErroringUpstash();

  try {
    const context = {
      requestId: 'f14-complete',
      routeName: 'relay_transaction',
      journalKey: `sa:request:journal:relay_transaction:${'a'.repeat(64)}`,
      journalTtlMs: 60_000,
      lockTtlMs: 30_000,
      responseTtlMs: 60_000,
      idempotencyKey: 'f14-key',
      lockKey: `sa:request:lock:relay_transaction:${'b'.repeat(64)}`,
      responseKey: `sa:request:response:relay_transaction:${'c'.repeat(64)}`,
      upstashEnabled: true,
    };

    await assert.doesNotReject(
      () => completeDurableRequest(context, { statusCode: 200, body: { ok: true, txid: '0xabc' } }),
      'a failed bookkeeping write must not fail a completed broadcast',
    );
    assert.ok(
      errorLogs.some((line) => /response-cache write/i.test(line)),
      'the swallowed backend error is still logged for operators',
    );
  } finally {
    restoreFetch();
    console.error = originalError;
    restoreDurabilityEnv(snapshot);
  }
});

test('F-14: a failure-journal write against an erroring backend never throws either', async () => {
  const snapshot = snapshotDurabilityEnv();
  const restoreFetch = stubThrowingFetch();
  const originalError = console.error;
  const errorLogs = [];
  console.error = (...args) => errorLogs.push(args.join(' '));

  configureErroringUpstash();

  try {
    const context = {
      requestId: 'f14-fail',
      routeName: 'relay_transaction',
      journalKey: `sa:request:journal:relay_transaction:${'a'.repeat(64)}`,
      journalTtlMs: 60_000,
      lockTtlMs: 30_000,
      responseTtlMs: 60_000,
      idempotencyKey: 'f14-fail-key',
      lockKey: `sa:request:lock:relay_transaction:${'b'.repeat(64)}`,
      responseKey: '',
      upstashEnabled: true,
    };

    await assert.doesNotReject(
      () => failDurableRequest(context, { statusCode: 422, error: 'relay_input_invalid', phase: 'validate' }),
      'a failed failure-journal write must not mask the real client response',
    );
    assert.ok(
      errorLogs.some((line) => /failure journal write/i.test(line)),
      'the swallowed backend error is still logged for operators',
    );
  } finally {
    restoreFetch();
    console.error = originalError;
    restoreDurabilityEnv(snapshot);
  }
});

test('F-13: the relay route answers 503 request_persistence_backend_unavailable (with Retry-After) when the backend errors in production', async () => {
  // Route-level wiring: the begin-phase backend outage must surface as a clear
  // 503 BEFORE any validation, rate limiting or relay work runs — not as an
  // opaque platform 500 crash.
  const relayHandler = (await import('../api/relay-transaction.js')).default;
  const snapshot = snapshotDurabilityEnv();
  const restoreFetch = stubThrowingFetch();
  const originalError = console.error;
  const errorLogs = [];
  console.error = (...args) => errorLogs.push(args.join(' '));

  configureErroringUpstash();
  process.env.NODE_ENV = 'production';
  delete process.env.VERCEL_ENV;

  try {
    const { res, state } = createResStub();
    await relayHandler({ method: 'POST', headers: {}, body: { requestId: 'f13-route-probe' } }, res);

    assert.equal(state.statusCode, 503, 'the route fails closed with a clear 5xx');
    assert.equal(state.body?.error, 'request_persistence_backend_unavailable');
    assert.ok(Number(state.body?.retryAfter) > 0, 'the body carries a retry hint');
    assert.ok(Number(state.headers['retry-after']) > 0, 'the Retry-After header is set');
    assert.ok(errorLogs.length >= 1, 'the outage is logged loudly');
  } finally {
    restoreFetch();
    console.error = originalError;
    restoreDurabilityEnv(snapshot);
  }
});

test('F-13: the draft-operator route answers 503 request_persistence_backend_unavailable when the backend errors in production', async () => {
  const draftOperatorHandler = (await import('../api/draft-operator.js')).default;
  const snapshot = snapshotDurabilityEnv();
  const restoreFetch = stubThrowingFetch();
  const originalError = console.error;
  const errorLogs = [];
  console.error = (...args) => errorLogs.push(args.join(' '));

  configureErroringUpstash();
  process.env.NODE_ENV = 'production';
  delete process.env.VERCEL_ENV;

  try {
    const { res, state } = createResStub();
    await draftOperatorHandler({ method: 'POST', headers: {}, body: { action: 'get', requestId: 'f13-draft-probe' } }, res);

    assert.equal(state.statusCode, 503, 'the route fails closed with a clear 5xx');
    assert.equal(state.body?.error, 'request_persistence_backend_unavailable');
    assert.ok(Number(state.body?.retryAfter) > 0, 'the body carries a retry hint');
    assert.ok(Number(state.headers['retry-after']) > 0, 'the Retry-After header is set');
  } finally {
    restoreFetch();
    console.error = originalError;
    restoreDurabilityEnv(snapshot);
  }
});
