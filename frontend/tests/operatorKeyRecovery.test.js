import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperatorMutationTransport } from '../src/features/operations/operatorMutationTransport.js';
import { createDraftStore } from '../src/features/operations/drafts.js';
import { createOperatorKeyVault, decryptOperatorBackup } from '../src/features/operations/operatorKeyVault.js';
import {
  canonicalizeOperatorMutationPayload, importOperatorPublicKey,
  verifyOperatorMutationSignature,
} from '../api/operatorMutationHelpers.js';

const PASSPHRASE = 'correct horse battery staple for tests';
const args = { shareSlug: 'draft-one', accessSlug: 'operator-one', mutation: 'setStatus', payload: { status: 'ready' } };

function memoryStore() {
  const records = new Map();
  return {
    records,
    async read(id) { return records.get(id) || null; },
    async write(id, record, { ifAbsent = false } = {}) {
      if (!ifAbsent || !records.has(id)) records.set(id, structuredClone(record));
      return records.get(id);
    },
  };
}

function endpoint() {
  const drafts = new Map();
  const requests = [];
  return {
    drafts, requests,
    async fetchImpl(url, options) {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      const state = drafts.get(body.shareSlug) || { publicJwk: null, counter: 0 };
      const reply = (ok, data) => ({ ok, async json() { return data; } });
      if (body.accessSlug !== 'operator-one') return reply(false, { error: 'draft_operator_access_required' });
      if (body.action === 'claim') {
        if (state.publicJwk && JSON.stringify(state.publicJwk) !== JSON.stringify(body.publicKeyJwk)) {
          return reply(false, { error: 'operator_key_already_claimed' });
        }
        state.publicJwk ||= body.publicKeyJwk;
        drafts.set(body.shareSlug, state);
        return reply(true, { operatorCounter: state.counter, accessSlug: body.accessSlug });
      }
      const canonical = canonicalizeOperatorMutationPayload({
        shareSlug: body.shareSlug, mutation: body.mutation, payload: body.payload, counter: body.counter,
      });
      const valid = await verifyOperatorMutationSignature(canonical, body.signature, await importOperatorPublicKey(state.publicJwk));
      if (!valid || body.counter !== state.counter) return reply(false, { error: 'invalid_operator_signature' });
      state.counter += 1;
      return reply(true, { operatorCounter: state.counter, draft: { status: body.payload.status } });
    },
  };
}

function transport(store, server, options = {}) {
  return createOperatorMutationTransport({ keyStore: store, fetchImpl: server.fetchImpl, ...options });
}

test('a fresh transport reuses durable key after the browser session is gone', async () => {
  const store = memoryStore(); const server = endpoint();
  await transport(store, server).run(args);
  const firstKey = server.drafts.get(args.shareSlug).publicJwk;
  await transport(store, server).run(args);
  assert.deepEqual(server.drafts.get(args.shareSlug).publicJwk, firstKey);
  assert.equal(server.drafts.get(args.shareSlug).counter, 2);
  const record = store.records.get(args.shareSlug);
  assert.equal(record.wrappingKey.extractable, false);
  assert.equal(record.privateJwk, undefined);
  assert.equal(JSON.stringify(record).includes('"d":'), false);
});

test('encrypted backup restores the pinned key in a new browser and resumes server counter', async () => {
  const store = memoryStore(); const server = endpoint(); const first = transport(store, server);
  await first.run(args);
  const backup = await first.exportBackup({ ...args, passphrase: PASSPHRASE });
  const newBrowser = transport(memoryStore(), server);
  await newBrowser.importBackup({ ...args, backup, passphrase: PASSPHRASE });
  await newBrowser.run(args);
  assert.equal(server.drafts.get(args.shareSlug).counter, 2);
  assert.equal(backup.includes('privateJwk'), false);
  assert.equal(backup.includes(args.accessSlug), false);
});

test('wrong key backup cannot replace server pin or an existing working local key', async () => {
  const server = endpoint(); const goodStore = memoryStore(); const good = transport(goodStore, server);
  await good.run(args);
  const before = goodStore.records.get(args.shareSlug);
  const unrelated = transport(memoryStore(), endpoint());
  const backup = await unrelated.exportBackup({ ...args, passphrase: PASSPHRASE });
  await assert.rejects(good.importBackup({ ...args, backup, passphrase: PASSPHRASE }), /operator_key_recovery_required/);
  assert.equal(goodStore.records.get(args.shareSlug), before);
  await good.run(args);
  assert.equal(server.drafts.get(args.shareSlug).counter, 2);
});

test('corrupt backups, wrong password and malformed parameters fail before server calls', async () => {
  const server = endpoint(); const client = transport(memoryStore(), server);
  const backup = await client.exportBackup({ ...args, passphrase: PASSPHRASE });
  const envelope = JSON.parse(backup);
  const corrupted = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -8)}AAAAAAAA` };
  const cases = [
    ['{bad-json', PASSPHRASE], [backup, 'another long password'],
    [JSON.stringify(corrupted), PASSPHRASE],
    [JSON.stringify({ ...envelope, iterations: 1_000_000_000 }), PASSPHRASE],
    ['x'.repeat(16_385), PASSPHRASE],
  ];
  const calls = server.requests.length;
  for (const [candidate, passphrase] of cases) {
    await assert.rejects(client.importBackup({ ...args, backup: candidate, passphrase }), /operator_backup_invalid/);
  }
  assert.equal(server.requests.length, calls);
});

test('backups and durable records cannot cross draft boundaries', async () => {
  const server = endpoint(); const store = memoryStore(); const client = transport(store, server);
  const backup = await client.exportBackup({ ...args, passphrase: PASSPHRASE });
  await assert.rejects(client.importBackup({ ...args, shareSlug: 'draft-two', backup, passphrase: PASSPHRASE }), /operator_backup_wrong_draft/);
  const envelope = JSON.parse(backup);
  await assert.rejects(decryptOperatorBackup(JSON.stringify({ ...envelope, shareSlug: 'draft-two' }), PASSPHRASE, 'draft-two'), /operator_backup_invalid/);
  store.records.set('draft-two', store.records.get('draft-one'));
  await assert.rejects(client.run({ ...args, shareSlug: 'draft-two' }), /operator_key_storage_corrupt/);
});

test('no key or password secrets are put in requests, URLs or error messages', async () => {
  const server = endpoint(); const store = memoryStore(); const client = transport(store, server);
  const backup = await client.exportBackup({ ...args, passphrase: PASSPHRASE });
  const material = await decryptOperatorBackup(backup, PASSPHRASE, args.shareSlug);
  await client.run(args);
  const wire = JSON.stringify(server.requests);
  for (const secret of [PASSPHRASE, material.privateJwk.d, 'privateJwk', backup]) assert.equal(wire.includes(secret), false);
  assert.ok(server.requests.every(({ url }) => url === '/api/draft-operator'));
  await assert.rejects(client.importBackup({ ...args, backup: material.privateJwk.d, passphrase: PASSPHRASE }), { message: 'EC_operator_backup_invalid' });
});

test('legacy session key migrates once with public JWK ordering preserved', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const material = {
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
  };
  const values = new Map([[`aa_operator_session_v1:${args.shareSlug}`, JSON.stringify(material)]]);
  const legacyStorage = { getItem: (key) => values.get(key), removeItem: (key) => values.delete(key) };
  const server = endpoint(); const store = memoryStore();
  server.drafts.set(args.shareSlug, { publicJwk: material.publicJwk, counter: 7 });
  await transport(store, server, { legacyStorage }).run(args);
  assert.equal(values.size, 0);
  assert.equal(server.drafts.get(args.shareSlug).counter, 8);
  assert.equal(JSON.stringify(store.records.get(args.shareSlug).publicJwk), JSON.stringify(material.publicJwk));
});

test('unavailable persistence fails before a public key can become permanently pinned', async () => {
  const server = endpoint(); const store = memoryStore();
  store.write = async () => { throw new Error('QuotaExceededError'); };
  await assert.rejects(transport(store, server).run(args), /operator_key_storage_unavailable/);
  assert.equal(server.requests.length, 0);
});

test('malformed legacy data is preserved and never silently replaced', async () => {
  const server = endpoint();
  const legacyStorage = { getItem: () => '{corrupt', removeItem: () => assert.fail('must not remove corrupt legacy key') };
  await assert.rejects(transport(memoryStore(), server, { legacyStorage }).run(args), /operator_key_storage_corrupt/);
  assert.equal(server.requests.length, 0);
});

test('parallel first reads converge on one durable key', async () => {
  const store = memoryStore();
  const first = createOperatorKeyVault({ store }); const second = createOperatorKeyVault({ store });
  const [a, b] = await Promise.all([first.getOrCreate('draft-one'), second.getOrCreate('draft-one')]);
  assert.deepEqual(a.publicJwk, b.publicJwk);
});

test('weak backup passwords are rejected before claim or generation', async () => {
  const server = endpoint(); const store = memoryStore();
  await assert.rejects(transport(store, server).exportBackup({ ...args, passphrase: 'short' }), /operator_backup_password_weak/);
  assert.equal(server.requests.length, 0);
  assert.equal(store.records.size, 0);
});

test('original session can recover its pinned legacy key after a fresh tab persisted a rejected key', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const material = {
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
  };
  const values = new Map([[`aa_operator_session_v1:${args.shareSlug}`, JSON.stringify(material)]]);
  const legacyStorage = { getItem: (key) => values.get(key), removeItem: (key) => values.delete(key) };
  const server = endpoint(); const store = memoryStore();
  server.drafts.set(args.shareSlug, { publicJwk: material.publicJwk, counter: 3 });
  await assert.rejects(transport(store, server, { legacyStorage: null }).run(args), /operator_key_recovery_required/);
  const rejectedKey = store.records.get(args.shareSlug).publicJwk;
  assert.notEqual(rejectedKey.x, material.publicJwk.x);
  await transport(store, server, { legacyStorage }).run(args);
  assert.deepEqual(store.records.get(args.shareSlug).publicJwk, material.publicJwk);
  assert.equal(server.drafts.get(args.shareSlug).counter, 4);
  assert.equal(values.size, 0);
});

test('draft store preserves actionable recovery errors for workspace mutation UI', async () => {
  const server = endpoint();
  await transport(memoryStore(), server).run(args);
  const store = createDraftStore({ supabase: {}, operatorMutationTransport: transport(memoryStore(), server) });
  await assert.rejects(store.updateStatus(args.shareSlug, 'ready', { accessSlug: args.accessSlug }), /operator_key_recovery_required/);
});
