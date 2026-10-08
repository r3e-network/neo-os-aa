import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createDraftStore } from '../src/features/operations/drafts.js';
import { createOperatorMutationTransport } from '../src/features/operations/operatorMutationTransport.js';
import {
  canonicalizeOperatorMutationPayload,
  importOperatorPublicKey,
  verifyOperatorMutationSignature,
} from '../api/operatorMutationHelpers.js';

function createMemoryStorage() {
  const values = new Map();
  return {
    async read(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async write(key, value, { ifAbsent = false } = {}) {
      if (!ifAbsent || !values.has(key)) values.set(key, value);
      return values.get(key);
    },
  };
}

// Fake /api/draft-operator endpoint mirroring api/draft-operator.js: a claim
// registers the operator public key, a mutate verifies the signed canonical
// payload against it before applying the mutation.
function createFakeDraftOperatorEndpoint(draft) {
  const state = { publicKeyJwk: null, operatorCounter: 0, requests: [] };
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    state.requests.push({ url, body });

    if (body.accessSlug !== draft.operator_slug) {
      return { ok: false, status: 403, async json() { return { error: 'draft_operator_access_required' }; } };
    }
    if (body.action === 'claim') {
      state.publicKeyJwk = state.publicKeyJwk || body.publicKeyJwk;
      return {
        ok: true,
        async json() {
          return { operatorCounter: state.operatorCounter, accessSlug: draft.operator_slug };
        },
      };
    }
    if (body.action === 'mutate') {
      const canonicalPayload = canonicalizeOperatorMutationPayload({
        shareSlug: body.shareSlug,
        mutation: body.mutation,
        payload: body.payload,
        counter: body.counter,
      });
      const publicKey = await importOperatorPublicKey(state.publicKeyJwk);
      const verified = await verifyOperatorMutationSignature(canonicalPayload, body.signature, publicKey);
      if (!verified || body.counter !== state.operatorCounter) {
        return { ok: false, status: 403, async json() { return { error: 'invalid_operator_signature' }; } };
      }
      state.operatorCounter += 1;
      const nextDraft = body.mutation === 'setStatus'
        ? { ...draft, status: body.payload.status }
        : draft;
      return {
        ok: true,
        async json() {
          return { draft: nextDraft, operatorCounter: state.operatorCounter, accessSlug: draft.operator_slug };
        },
      };
    }
    return { ok: false, status: 400, async json() { return { error: 'unsupported_operator_action' }; } };
  };
  return { state, fetchImpl };
}

const REMOTE_DRAFT = {
  share_slug: 'share-wired-1',
  collaboration_slug: 'collab-wired-1',
  operator_slug: 'operator-wired-1',
  status: 'draft',
  can_write: true,
  can_operate: true,
  access_scope: 'operate',
  metadata: {},
};

test('Supabase draft store works end-to-end with the real operator mutation transport factory', async () => {
  const rpcCalls = [];
  const supabase = {
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      return { data: REMOTE_DRAFT, error: null };
    },
  };
  const { state, fetchImpl } = createFakeDraftOperatorEndpoint(REMOTE_DRAFT);
  const store = createDraftStore({
    supabase,
    operatorMutationTransport: createOperatorMutationTransport({
      fetchImpl,
      keyStore: createMemoryStorage(),
    }),
  });

  const updated = await store.updateStatus('share-wired-1', 'broadcasted', {
    accessSlug: 'operator-wired-1',
  });

  assert.equal(updated.status, 'broadcasted');
  // claim + signed mutate, both against the operator endpoint.
  assert.deepEqual(state.requests.map((entry) => entry.body.action), ['claim', 'mutate']);
  assert.equal(state.requests[0].url, '/api/draft-operator');
  assert.equal(state.requests[1].body.mutation, 'setStatus');
  assert.equal(state.operatorCounter, 1);
  // Operator mutations never fall back to anonymous bearer RPC writes.
  assert.equal(rpcCalls.length, 0);
});

test('the real transport reuses its claimed key and advances the counter across mutations', async () => {
  const supabase = { async rpc() { return { data: REMOTE_DRAFT, error: null }; } };
  const { state, fetchImpl } = createFakeDraftOperatorEndpoint(REMOTE_DRAFT);
  const store = createDraftStore({
    supabase,
    operatorMutationTransport: createOperatorMutationTransport({
      fetchImpl,
      keyStore: createMemoryStorage(),
    }),
  });

  await store.updateStatus('share-wired-1', 'broadcasted', { accessSlug: 'operator-wired-1' });
  await store.appendSubmissionReceipt('share-wired-1', { phase: 'success' }, { accessSlug: 'operator-wired-1' });

  const claims = state.requests.filter((entry) => entry.body.action === 'claim');
  assert.equal(claims.length, 2);
  assert.equal(claims[0].body.publicKeyJwk.x, claims[1].body.publicKeyJwk.x, 'key material must be reused');
  assert.equal(state.operatorCounter, 2);
});

test('operator mutations without a transport surface EC_operator_mutations_unavailable', async () => {
  const supabase = { async rpc() { return { data: REMOTE_DRAFT, error: null }; } };
  const store = createDraftStore({ supabase });

  await assert.rejects(
    () => store.updateStatus('share-wired-1', 'broadcasted', { accessSlug: 'operator-wired-1' }),
    /EC_operator_mutations_unavailable/,
  );
});

test('both workspace views construct the draft store with the operator mutation transport', () => {
  const workspaceSource = fs.readFileSync(
    path.resolve('src/features/operations/components/HomeOperationsWorkspace.vue'),
    'utf8',
  );
  const txViewSource = fs.readFileSync(path.resolve('src/views/TransactionInfoView.vue'), 'utf8');

  for (const source of [workspaceSource, txViewSource]) {
    assert.match(source, /createOperatorMutationTransport/);
    assert.match(
      source,
      /createDraftStore\(\{\s*operatorMutationTransport:\s*createOperatorMutationTransport\(\),?\s*\}\)/,
    );
  }
});

test('post-broadcast status sync is best-effort so an on-chain success is never toasted as an error', () => {
  const workspaceSource = fs.readFileSync(
    path.resolve('src/features/operations/components/HomeOperationsWorkspace.vue'),
    'utf8',
  );
  const txViewSource = fs.readFileSync(path.resolve('src/views/TransactionInfoView.vue'), 'utf8');

  const workspaceSync = workspaceSource.match(/async function updateDraftStatus\(status\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(workspaceSync, 'expected updateDraftStatus in HomeOperationsWorkspace');
  assert.match(workspaceSync, /try \{/);
  assert.match(workspaceSync, /catch/);

  const viewSync = txViewSource.match(/async function refreshDraftStatus\(status\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(viewSync, 'expected refreshDraftStatus in TransactionInfoView');
  assert.match(viewSync, /try \{/);
  assert.match(viewSync, /catch/);
});

test('signing flows skip the immutable transaction-body mutation after persistence', () => {
  const workspaceSource = fs.readFileSync(
    path.resolve('src/features/operations/components/HomeOperationsWorkspace.vue'),
    'utf8',
  );

  const guards = workspaceSource.match(/if \(!workspace\.isDraftImmutable\.value\) \{/g) || [];
  assert.equal(guards.length, 2, 'both signWithEvmWallet and signWithZkLogin must guard setTransactionBody');
});
