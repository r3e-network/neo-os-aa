import test from 'node:test';
import assert from 'node:assert/strict';

import { beginDurableRequest } from '../api/requestDurability.js';

// L3 regression coverage: client-supplied request ids (x-request-id header / request_id
// payload field) flow into Redis journal keys. The raw id must never become a key — it is
// hashed (mirroring the lock/response siblings), while the raw value is kept only for
// logs/echo responses.

const JOURNAL_KEY_PATTERN = /^aa:request:journal:relay_transaction:[0-9a-f]{64}$/;

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
  const injection = await journalKeyFor('aa:request:lock:*');
  const oversized = await journalKeyFor('x'.repeat(512));

  assert.match(injection.journalKey, JOURNAL_KEY_PATTERN, 'key-injection input is neutralized');
  assert.match(oversized.journalKey, JOURNAL_KEY_PATTERN, 'oversized input collapses to the fixed shape');
  assert.notEqual(injection.journalKey, oversized.journalKey);
  assert.ok(
    !injection.journalKey.includes('aa:request:lock'),
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
