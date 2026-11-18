import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { appendSignatureRecord, createDraftRecord, createDraftStore } from '../src/features/operations/drafts.js';
import {
  buildDraftCollaborationPath,
  buildDraftCollaborationUrl,
  buildDraftSharePath,
  buildDraftShareUrl,
} from '../src/features/operations/shareLinks.js';

// Markup from a parent SFC was extracted into colocated child components living
// in a sibling folder named after the parent (e.g. `TransactionInfoView.vue` ->
// `TransactionInfoView/*.vue`). This helper reads the parent file plus every
// colocated child so source-text contract assertions still check the real
// current location of the asserted markup.
function readComponentTree(parentVuePath) {
  const sources = [fs.readFileSync(parentVuePath, 'utf8')];
  const childDir = parentVuePath.replace(/\.vue$/, '');
  if (fs.existsSync(childDir) && fs.statSync(childDir).isDirectory()) {
    for (const entry of fs.readdirSync(childDir).sort()) {
      const childPath = path.join(childDir, entry);
      if (fs.statSync(childPath).isFile()) {
        sources.push(fs.readFileSync(childPath, 'utf8'));
      }
    }
  }
  return sources.join('\n\n');
}

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}

test('draft records serialize immutable transaction data and append-only signatures', () => {
  const record = createDraftRecord({
    draftId: 'draft-1',
    shareSlug: 'draft-1',
    collaborationSlug: 'collab-1',
    operatorSlug: 'operator-1',
    transactionBody: { txHex: 'deadbeef' },
    signerRequirements: [{ id: 'neo:alice', kind: 'neo' }],
  });
  const next = appendSignatureRecord(record, { signerId: 'neo:alice', kind: 'neo', signatureHex: '11' });
  const duplicate = appendSignatureRecord(next, { signerId: 'neo:alice', kind: 'neo', signatureHex: '22' });

  assert.equal(record.transaction_body.txHex, 'deadbeef');
  assert.equal(next.signatures.length, 1);
  assert.equal(duplicate.signatures.length, 1);
  assert.equal(next.share_path, '/tx/draft-1');
});

test('draft records create opaque read, collaborator, and operator capabilities by default', () => {
  const record = createDraftRecord({ transactionBody: { txHex: 'deadbeef' } });

  assert.notEqual(record.share_slug, record.draft_id);
  assert.match(record.share_slug, /^[0-9a-f-]{16,}$/i);
  assert.notEqual(record.collaboration_slug, record.share_slug);
  assert.notEqual(record.operator_slug, record.share_slug);
  assert.notEqual(record.operator_slug, record.collaboration_slug);
  assert.match(record.collaboration_slug, /^[0-9a-f-]{16,}$/i);
  assert.match(record.operator_slug, /^[0-9a-f-]{16,}$/i);
  assert.equal(record.share_path, `/tx/${record.share_slug}`);
  assert.equal(record.collaboration_path, `/tx/${record.share_slug}?access=${record.collaboration_slug}`);
  assert.equal(record.operator_path, `/tx/${record.share_slug}?access=${record.operator_slug}`);
  assert.equal(record.can_write, true);
  assert.equal(record.can_operate, true);
  assert.equal(record.access_scope, 'operate');
});

test('draft store falls back to local storage with read, collaborator, and operator scopes', async () => {
  const storage = createMemoryStorage();
  const store = createDraftStore({ supabase: null, storage });

  const created = await store.createDraft({
    draftId: 'draft-local-1',
    shareSlug: 'share-local-1',
    collaborationSlug: 'collab-local-1',
    operatorSlug: 'operator-local-1',
    transactionBody: { txHex: 'deadbeef' },
    signerRequirements: [{ id: 'neo:alice', kind: 'neo' }],
  });

  assert.equal(created.share_slug, 'share-local-1');
  assert.equal(created.collaboration_slug, 'collab-local-1');
  assert.equal(created.operator_slug, 'operator-local-1');
  assert.equal(created.access_scope, 'operate');
  assert.equal(created.can_operate, true);

  const readOnly = await store.loadDraft('share-local-1');
  assert.equal(readOnly.draft_id, 'draft-local-1');
  assert.equal(readOnly.collaboration_slug, undefined);
  assert.equal(readOnly.operator_slug, undefined);
  assert.equal(readOnly.can_write, false);
  assert.equal(readOnly.can_operate, false);
  assert.equal(readOnly.access_scope, 'read');

  const collaborator = await store.loadDraft('share-local-1', { collaborationSlug: 'collab-local-1' });
  assert.equal(collaborator.collaboration_slug, 'collab-local-1');
  assert.equal(collaborator.operator_slug, undefined);
  assert.equal(collaborator.can_write, true);
  assert.equal(collaborator.can_operate, false);
  assert.equal(collaborator.access_scope, 'sign');

  const operator = await store.loadDraft('share-local-1', { operatorSlug: 'operator-local-1' });
  assert.equal(operator.collaboration_slug, 'collab-local-1');
  assert.equal(operator.operator_slug, 'operator-local-1');
  assert.equal(operator.can_write, true);
  assert.equal(operator.can_operate, true);
  assert.equal(operator.access_scope, 'operate');

  await assert.rejects(
    () => store.appendSignature('share-local-1', {
      signerId: 'neo:alice',
      kind: 'neo',
      signatureHex: '11',
    }),
    /collaborator access/i,
  );

  const withSignature = await store.appendSignature('share-local-1', {
    signerId: 'neo:alice',
    kind: 'neo',
    signatureHex: '11',
  }, {
    collaborationSlug: 'collab-local-1',
  });
  assert.equal(withSignature.signatures.length, 1);
  assert.equal(withSignature.access_scope, 'sign');
  assert.equal(withSignature.can_operate, false);

  await assert.rejects(
    () => store.updateStatus('share-local-1', 'broadcasted', { collaborationSlug: 'collab-local-1' }),
    /operator access/i,
  );

  const withStatus = await store.updateStatus('share-local-1', 'broadcasted', {
    operatorSlug: 'operator-local-1',
  });
  assert.equal(withStatus.status, 'broadcasted');
  assert.equal(withStatus.operator_slug, 'operator-local-1');
  assert.equal(withStatus.access_scope, 'operate');
});

test('draft store does not expose a generic metadata patch helper anymore', () => {
  const storage = createMemoryStorage();
  const store = createDraftStore({ supabase: null, storage });

  assert.equal(store.updateMetadata, undefined);
});

test('draft store persists relay preflight snapshots through an operator-only helper', async () => {
  const storage = createMemoryStorage();
  const store = createDraftStore({ supabase: null, storage });

  await store.createDraft({
    draftId: 'draft-local-2',
    shareSlug: 'share-local-2',
    collaborationSlug: 'collab-local-2',
    operatorSlug: 'operator-local-2',
    metadata: { createdBy: 'local-user' },
    transactionBody: { txHex: 'deadbeef' },
  });

  await assert.rejects(
    () => store.setRelayPreflight('share-local-2', {
      label: 'Relay Check Passed',
      vmState: 'HALT',
      gasConsumed: '42',
    }, { collaborationSlug: 'collab-local-2' }),
    /operator access/i,
  );

  const updated = await store.setRelayPreflight('share-local-2', {
    label: 'Relay Check Passed',
    vmState: 'HALT',
    gasConsumed: '42',
  }, {
    operatorSlug: 'operator-local-2',
  });

  assert.equal(updated.metadata.createdBy, 'local-user');
  assert.equal(updated.metadata.relayPreflight.label, 'Relay Check Passed');
  assert.equal(updated.metadata.relayPreflight.vmState, 'HALT');
  assert.equal(updated.can_operate, true);
});

test('draft store appends submission receipt history only for operator scope', async () => {
  const storage = createMemoryStorage();
  const store = createDraftStore({ supabase: null, storage });

  await store.createDraft({
    draftId: 'draft-local-4',
    shareSlug: 'share-local-4',
    collaborationSlug: 'collab-local-4',
    operatorSlug: 'operator-local-4',
    metadata: { submissionReceipts: [] },
    transactionBody: { txHex: 'deadbeef' },
  });

  await assert.rejects(
    () => store.appendSubmissionReceipt('share-local-4', {
      action: 'relay-submit',
      phase: 'success',
      detail: 'Relay submission completed.',
      txid: '0x' + 'ab'.repeat(32),
      createdAt: '2026-03-09T00:00:00.000Z',
    }, { collaborationSlug: 'collab-local-4' }),
    /operator access/i,
  );

  const updated = await store.appendSubmissionReceipt('share-local-4', {
    action: 'relay-submit',
    phase: 'success',
    detail: 'Relay submission completed.',
    txid: '0x' + 'ab'.repeat(32),
    createdAt: '2026-03-09T00:00:00.000Z',
  }, {
    operatorSlug: 'operator-local-4',
  });

  assert.equal(updated.metadata.submissionReceipts.length, 1);
  assert.equal(updated.metadata.submissionReceipts[0].action, 'relay-submit');
});

test('draft store can rotate collaborator links and revoke the previous signer capability', async () => {
  const storage = createMemoryStorage();
  const store = createDraftStore({ supabase: null, storage });

  await store.createDraft({
    draftId: 'draft-local-5',
    shareSlug: 'share-local-5',
    collaborationSlug: 'collab-local-5',
    operatorSlug: 'operator-local-5',
    transactionBody: { txHex: 'deadbeef' },
  });

  const rotated = await store.rotateCollaboratorLink('share-local-5', {
    operatorSlug: 'operator-local-5',
  });

  assert.notEqual(rotated.collaboration_slug, 'collab-local-5');
  assert.equal(rotated.operator_slug, 'operator-local-5');
  assert.equal(rotated.can_operate, true);
  assert.match(rotated.collaboration_path, /access=/);

  await assert.rejects(
    () => store.appendSignature('share-local-5', {
      signerId: 'neo:alice',
      kind: 'neo',
      signatureHex: '11',
    }, { collaborationSlug: 'collab-local-5' }),
    /collaborator access/i,
  );

  const writable = await store.loadDraft('share-local-5', {
    collaborationSlug: rotated.collaboration_slug,
  });
  assert.equal(writable.can_write, true);
  assert.equal(writable.can_operate, false);
  assert.equal(writable.collaboration_slug, rotated.collaboration_slug);
});

test('draft store can rotate operator links and revoke the previous operator capability', async () => {
  const storage = createMemoryStorage();
  const store = createDraftStore({ supabase: null, storage });

  await store.createDraft({
    draftId: 'draft-local-6',
    shareSlug: 'share-local-6',
    collaborationSlug: 'collab-local-6',
    operatorSlug: 'operator-local-6',
    transactionBody: { txHex: 'deadbeef' },
  });

  const rotated = await store.rotateOperatorLink('share-local-6', {
    operatorSlug: 'operator-local-6',
  });

  assert.notEqual(rotated.operator_slug, 'operator-local-6');
  assert.equal(rotated.can_operate, true);
  assert.match(rotated.operator_path, /access=/);

  await assert.rejects(
    () => store.updateStatus('share-local-6', 'broadcasted', { operatorSlug: 'operator-local-6' }),
    /operator access/i,
  );

  const writable = await store.loadDraft('share-local-6', {
    operatorSlug: rotated.operator_slug,
  });
  assert.equal(writable.can_operate, true);
  assert.equal(writable.operator_slug, rotated.operator_slug);
});

test('draft store limits signer-scope activity to signature events and reserves relay activity for operator scope', async () => {
  const storage = createMemoryStorage();
  const store = createDraftStore({ supabase: null, storage });

  await store.createDraft({
    draftId: 'draft-local-7',
    shareSlug: 'share-local-7',
    collaborationSlug: 'collab-local-7',
    operatorSlug: 'operator-local-7',
    metadata: { activity: [] },
    transactionBody: { txHex: 'deadbeef' },
  });

  const signerEvent = await store.appendActivity('share-local-7', {
    type: 'signature_added',
    actor: 'neo',
    detail: 'Signature appended',
    createdAt: '2026-03-09T00:00:00.000Z',
  }, {
    collaborationSlug: 'collab-local-7',
  });

  assert.equal(signerEvent.metadata.activity.length, 1);
  assert.equal(signerEvent.metadata.activity[0].type, 'signature_added');
  assert.equal(signerEvent.access_scope, 'sign');

  await assert.rejects(
    () => store.appendActivity('share-local-7', {
      type: 'broadcast_relay',
      actor: 'relay',
      detail: 'Relay submission completed',
      createdAt: '2026-03-09T00:00:01.000Z',
    }, {
      collaborationSlug: 'collab-local-7',
    }),
    /cannot record that activity/i,
  );

  const operatorEvent = await store.appendActivity('share-local-7', {
    type: 'broadcast_relay',
    actor: 'relay',
    detail: 'Relay submission completed',
    createdAt: '2026-03-09T00:00:02.000Z',
  }, {
    operatorSlug: 'operator-local-7',
  });

  assert.equal(operatorEvent.metadata.activity.length, 2);
  assert.equal(operatorEvent.metadata.activity[1].type, 'broadcast_relay');
  assert.equal(operatorEvent.access_scope, 'operate');
});

test('draft store appends activity timeline events for persisted drafts', async () => {
  const storage = createMemoryStorage();
  const store = createDraftStore({ supabase: null, storage });

  await store.createDraft({
    draftId: 'draft-local-3',
    shareSlug: 'share-local-3',
    collaborationSlug: 'collab-local-3',
    operatorSlug: 'operator-local-3',
    metadata: { activity: [] },
    transactionBody: { txHex: 'deadbeef' },
  });

  let updated = null;
  for (let index = 0; index < 102; index += 1) {
    updated = await store.appendActivity('share-local-3', {
      type: 'relay_preflight',
      actor: 'relay',
      detail: `HALT gas ${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    }, {
      operatorSlug: 'operator-local-3',
    });
  }

  assert.equal(updated.metadata.activity.length, 100);
  assert.equal(updated.metadata.activity[0].detail, 'HALT gas 2');
  assert.equal(updated.metadata.activity.at(-1).detail, 'HALT gas 101');
  assert.equal(updated.access_scope, 'operate');
});

test('remote operator mutations use signed operator transport instead of direct anonymous RPC bearer writes', async () => {
  const calls = [];
  const operatorResult = {
    share_slug: 'share-remote-1',
    collaboration_slug: 'collab-remote-1',
    operator_slug: 'operator-remote-1',
    status: 'broadcasted',
    can_write: true,
    can_operate: true,
    access_scope: 'operate',
  };
  const supabase = {
    async rpc(name, args) {
      calls.push({ kind: 'rpc', name, args });
      return { data: {}, error: null };
    },
  };
  const operatorMutationTransport = {
    async run(input) {
      calls.push({ kind: 'transport', input });
      return operatorResult;
    },
  };
  const store = createDraftStore({ supabase, operatorMutationTransport });

  const updated = await store.updateStatus('share-remote-1', 'broadcasted', { operatorSlug: 'operator-remote-1' });

  assert.equal(updated.status, 'broadcasted');
  assert.equal(updated.access_scope, 'operate');
  assert.deepEqual(calls, [{
    kind: 'transport',
    input: {
      shareSlug: 'share-remote-1',
      accessSlug: 'operator-remote-1',
      mutation: 'setStatus',
      payload: { status: 'broadcasted' },
    },
  }]);
});

test('remote activity syncs with only an accessSlug and lets the server resolve the scope', async () => {
  const calls = [];
  const supabase = {
    async rpc(name, args) {
      calls.push({ kind: 'rpc', name, args });
      return {
        data: {
          share_slug: 'share-remote-3',
          collaboration_slug: 'collab-remote-3',
          can_write: true,
          can_operate: false,
          access_scope: 'sign',
          metadata: { activity: [args.p_event] },
        },
        error: null,
      };
    },
  };
  const store = createDraftStore({ supabase });

  // Production callers only know their opaque access slug; the previous
  // client-side scope inference treated this as 'read' and silently dropped
  // every event before it reached Supabase.
  const updated = await store.appendActivity('share-remote-3', {
    type: 'signature_added',
    actor: 'neo',
    detail: 'Signature appended',
    createdAt: '2026-06-11T00:00:00.000Z',
  }, { accessSlug: 'collab-remote-3' });

  assert.equal(updated.metadata.activity[0].type, 'signature_added');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'append_sa_draft_activity');
  assert.equal(calls[0].args.p_access_slug, 'collab-remote-3');
  assert.equal(calls[0].args.p_event.type, 'signature_added');
});

test('remote store surfaces specific access errors instead of degrading them to the generic failure', async () => {
  const supabase = {
    async rpc() {
      return { data: null, error: new Error('draft_collaboration_access_required') };
    },
  };
  const store = createDraftStore({ supabase });

  // A single normalization pass must map the Postgres exception to its EC
  // code; re-normalizing the EC message used to flatten it to
  // EC_draft_request_failed.
  await assert.rejects(
    () => store.appendSignature('share-remote-4', { signerId: 'neo:alice', kind: 'neo', signatureHex: '11' }, {
      accessSlug: 'collab-remote-4',
    }),
    /EC_collaborator_access_required/,
  );

  const scopedSupabase = {
    async rpc() {
      return { data: null, error: new Error('draft_activity_scope_not_allowed') };
    },
  };
  const scopedStore = createDraftStore({ supabase: scopedSupabase });
  await assert.rejects(
    () => scopedStore.appendActivity('share-remote-4', { type: 'broadcast_relay' }, { accessSlug: 'collab-remote-4' }),
    /EC_activity_scope_denied/,
  );
});

test('remote collaborator activity stays on the anonymous Supabase path for signature events', async () => {
  const calls = [];
  const supabase = {
    async rpc(name, args) {
      calls.push({ kind: 'rpc', name, args });
      return {
        data: {
          share_slug: 'share-remote-2',
          collaboration_slug: 'collab-remote-2',
          can_write: true,
          can_operate: false,
          access_scope: 'sign',
          metadata: { activity: [args.p_event] },
        },
        error: null,
      };
    },
  };
  const operatorMutationTransport = {
    async run(input) {
      calls.push({ kind: 'transport', input });
      return {};
    },
  };
  const store = createDraftStore({ supabase, operatorMutationTransport });

  const updated = await store.appendActivity('share-remote-2', {
    type: 'signature_added',
    actor: 'neo',
    detail: 'Signature appended',
    createdAt: '2026-03-09T00:00:00.000Z',
  }, { collaborationSlug: 'collab-remote-2' });

  assert.equal(updated.access_scope, 'sign');
  assert.equal(calls[0].kind, 'rpc');
  assert.equal(calls[0].name, 'append_sa_draft_activity');
  assert.equal(calls[0].args.p_access_slug, 'collab-remote-2');
  assert.equal(calls.find((entry) => entry.kind === 'transport'), undefined);
});

test('share link helpers generate separate public and scoped draft links', () => {
  assert.equal(buildDraftSharePath('draft-1'), '/tx/draft-1');
  assert.equal(buildDraftShareUrl('https://example.org/', 'draft-1'), 'https://example.org/tx/draft-1');
  assert.equal(buildDraftCollaborationPath('draft-1', 'collab-1'), '/tx/draft-1?access=collab-1');
  assert.equal(buildDraftCollaborationUrl('https://example.org/', 'draft-1', 'collab-1'), 'https://example.org/tx/draft-1?access=collab-1');
  assert.equal(buildDraftCollaborationPath('draft-1', 'operator-1'), '/tx/draft-1?access=operator-1');
});

test('transaction info view reuses the draft status banner', () => {
  const txViewSource = fs.readFileSync(path.resolve('src/views/TransactionInfoView.vue'), 'utf8');

  assert.match(txViewSource, /DraftStatusBanner/);
});

test('transaction info view exposes the polished shared draft workspace sections', () => {
  // Several shared-draft sections (operation snapshot, signer checklist, latest
  // submission / receipt history, access-scope notice) were extracted into
  // colocated TransactionInfoView/*.vue child components, so scan the tree.
  const txViewSource = readComponentTree(path.resolve('src/views/TransactionInfoView.vue'));

  assert.match(txViewSource, /Shared Draft Overview/);
  assert.match(txViewSource, /Paymaster Readiness/);
  assert.match(txViewSource, /Open Validation Ledger/);
  assert.match(txViewSource, /Open Explorer Tx/);
  assert.match(txViewSource, /paymasterValidation/);
  assert.match(txViewSource, /Operation Snapshot/);
  assert.match(txViewSource, /Signer Checklist/);
  assert.match(txViewSource, /Signature Actions/);
  assert.match(txViewSource, /Broadcast & Relay/);
  assert.match(txViewSource, /View Latest in Explorer/);
  assert.match(txViewSource, /Checking Relay…/);
  assert.match(txViewSource, /Broadcasting…/);
  assert.match(txViewSource, /Submitting…/);
  assert.match(txViewSource, /Submission Receipt/);
  assert.match(txViewSource, /Receipt History/);
  assert.match(txViewSource, /Collaborator Link/);
  assert.match(txViewSource, /Operator Link/);
  assert.match(txViewSource, /signature-only/);
});

test('router and transaction info view support shared draft loading', () => {
  const routerSource = fs.readFileSync(path.resolve('src/router/index.js'), 'utf8');
  const txViewSource = fs.readFileSync(path.resolve('src/views/TransactionInfoView.vue'), 'utf8');

  assert.match(routerSource, /path:\s*'tx\/:draftId'/);
  assert.match(txViewSource, /draftId/);
  assert.match(txViewSource, /createDraftStore|getSupabaseClient|loadDraft/);
  assert.match(txViewSource, /useRoute/);
  assert.match(txViewSource, /route\.query\.access/);
  assert.match(txViewSource, /Copy Operator Link/);
});

test('receipt history uses formatted labels instead of raw createdAt fields', () => {
  // Receipt rendering (including the formatted createdLabel) lives in the
  // colocated TransactionInfoView/*.vue child components.
  const source = readComponentTree(path.resolve('src/views/TransactionInfoView.vue'));
  assert.match(source, /createdLabel/);
});
