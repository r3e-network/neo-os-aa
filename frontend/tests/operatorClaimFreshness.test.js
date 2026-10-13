import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/draft-operator.js';
import { canonicalizeOperatorMutationPayload, signOperatorMutationPayload } from '../api/operatorMutationHelpers.js';

test('claim stays fresh and only an exact signed mutation can replay its cached result', async () => {
  const configured = {
    UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'local-test-token',
    SUPABASE_URL: 'https://supabase.example.test', SUPABASE_SERVICE_ROLE_KEY: 'local-test-service-key',
  };
  const before = Object.fromEntries(Object.keys(configured).map((key) => [key, process.env[key]]));
  Object.assign(process.env, configured);
  const fetchBefore = globalThis.fetch;
  const redis = new Map();
  const first = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const second = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', first.publicKey);
  const wrongJwk = await crypto.subtle.exportKey('jwk', second.publicKey);
  const draft = { draft_id: 'draft-id', share_slug: 'share-one', operator_slug: 'access-one', operator_public_key: publicJwk, operator_counter: 0 };
  let databaseReads = 0;
  globalThis.fetch = async (resource, options = {}) => {
    const url = String(resource);
    if (url.startsWith('https://supabase.example.test/rest/v1/aa_transaction_drafts')) {
      databaseReads += 1;
      if (options.method === 'PATCH') Object.assign(draft, JSON.parse(options.body));
      return Response.json(draft);
    }
    if (url.startsWith('https://redis.example.test/get/')) {
      const key = decodeURIComponent(url.split('/get/')[1]);
      return new Response(redis.get(key) || 'null');
    }
    if (url === 'https://redis.example.test/pipeline') {
      const commands = JSON.parse(options.body);
      return Response.json(commands.map(([command, key, value, ...flags]) => {
        if (command === 'SET') {
          if (flags.includes('NX') && redis.has(key)) return { result: null };
          redis.set(key, value); return { result: 'OK' };
        }
        if (command === 'DEL') { redis.delete(key); return { result: 1 }; }
        return { result: command === 'PTTL' ? 60_000 : 1 };
      }));
    }
    throw new Error('Unexpected test network destination');
  };
  async function claim(key) {
    const res = { status(code) { this.code = code; return this; }, setHeader() {}, json(body) { this.body = body; } };
    await handler({ method: 'POST', headers: { 'idempotency-key': 'repeated-client-key' }, socket: { remoteAddress: '127.0.0.14' },
      body: { action: 'claim', shareSlug: 'share-one', accessSlug: 'access-one', publicKeyJwk: key } }, res);
    return res;
  }
  try {
    assert.equal((await claim(publicJwk)).code, 200);
    const wrong = await claim(wrongJwk);
    assert.equal(wrong.code, 403);
    assert.equal(wrong.body.error, 'operator_key_already_claimed');
    draft.operator_counter = 8;
    const fresh = await claim(publicJwk);
    assert.equal(fresh.code, 200);
    assert.equal(fresh.body.operatorCounter, 8);
    assert.equal(databaseReads, 3);

    const mutation = { shareSlug: 'share-one', mutation: 'rotateOperatorLink', payload: {}, counter: 8 };
    const signature = await signOperatorMutationPayload(canonicalizeOperatorMutationPayload(mutation), first.privateKey);
    async function mutate(signed, method = 'POST') {
      const res = { status(code) { this.code = code; return this; }, setHeader() {}, json(body) { this.body = body; } };
      await handler({ method, headers: { 'idempotency-key': 'exact-mutation-retry' }, socket: { remoteAddress: '127.0.0.14' },
        body: { ...mutation, action: 'mutate', accessSlug: 'access-one', signature: signed } }, res);
      return res;
    }
    const executed = await mutate(signature);
    assert.equal(executed.code, 200);
    assert.equal(executed.body.operatorCounter, 9);
    assert.notEqual(executed.body.draft.operator_slug, 'access-one');
    const readsAfterMutation = databaseReads;
    const retried = await mutate(signature);
    assert.equal(retried.code, 200);
    assert.equal(retried.body.draft.operator_slug, executed.body.draft.operator_slug);
    assert.equal(databaseReads, readsAfterMutation, 'an exact signed retry retains mutation idempotency');
    assert.equal(draft.operator_counter, 9, 'retry does not execute twice');
    const unsigned = await mutate('');
    const wrongMethod = await mutate(signature, 'GET');
    assert.deepEqual({ unsigned: unsigned.code, wrongMethod: wrongMethod.code }, { unsigned: 403, wrongMethod: 405 },
      'cache cannot bypass signature or method validation');
    assert.equal(unsigned.body.draft, undefined);
  } finally {
    globalThis.fetch = fetchBefore;
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
