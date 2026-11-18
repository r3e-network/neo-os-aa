import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVITY_FILTERS,
  buildActivityActions,
  buildActivityEmptyState,
  buildActivityFilterCounts,
  buildActivityGroups,
  buildActivityPresentation,
  classifyActivityEvent,
  filterActivityEntries,
  formatActivityDateLabel,
  formatActivityTimeLabel,
} from '../src/features/operations/activityTimeline.js';

const sample = [
  { id: '1', type: 'account_loaded', detail: 'Loaded account', createdAt: '2026-03-09T00:00:00.000Z' },
  { id: '2', type: 'did_bound', detail: 'Bound DID', createdAt: '2026-03-09T00:00:30.000Z' },
  { id: '3', type: 'signature_added', detail: 'Added signature', createdAt: '2026-03-09T00:01:00.000Z' },
  { id: '4', type: 'relay_preflight', detail: 'Relay check', createdAt: '2026-03-09T00:02:00.000Z' },
  { id: '5', type: 'broadcast_relay', detail: 'Relayed', createdAt: '2026-03-09T00:03:00.000Z' },
];

test('activity filters expose stable category ids', () => {
  assert.deepEqual(ACTIVITY_FILTERS.map((item) => item.id), ['all', 'workflow', 'identity', 'signatures', 'relay', 'broadcast']);
});

test('classifyActivityEvent maps event types into timeline categories', () => {
  assert.equal(classifyActivityEvent(sample[0]), 'workflow');
  assert.equal(classifyActivityEvent(sample[1]), 'identity');
  assert.equal(classifyActivityEvent(sample[2]), 'signatures');
  assert.equal(classifyActivityEvent(sample[3]), 'relay');
  assert.equal(classifyActivityEvent(sample[4]), 'broadcast');
});

test('buildActivityFilterCounts summarizes all categories for filter badges', () => {
  assert.deepEqual(buildActivityFilterCounts(sample), {
    all: 5,
    workflow: 1,
    identity: 1,
    signatures: 1,
    relay: 1,
    broadcast: 1,
  });
});

test('filterActivityEntries narrows the timeline by selected category', () => {
  assert.equal(filterActivityEntries(sample, 'all').length, 5);
  assert.deepEqual(filterActivityEntries(sample, 'identity').map((item) => item.id), ['2']);
  assert.deepEqual(filterActivityEntries(sample, 'signatures').map((item) => item.id), ['3']);
  assert.deepEqual(filterActivityEntries(sample, 'relay').map((item) => item.id), ['4']);
  assert.deepEqual(filterActivityEntries(sample, 'broadcast').map((item) => item.id), ['5']);
});

test('formatActivityDateLabel returns Today and Yesterday when applicable', () => {
  const now = '2026-03-09T12:00:00.000Z';

  assert.equal(formatActivityDateLabel('2026-03-09', { now, useUtc: true }), 'Today');
  assert.equal(formatActivityDateLabel('2026-03-08', { now, useUtc: true }), 'Yesterday');
  assert.equal(formatActivityDateLabel('2026-03-01', { now, useUtc: true }), '2026-03-01');
});

test('formatActivityTimeLabel returns compact HH:MM output', () => {
  assert.equal(formatActivityTimeLabel('2026-03-09T04:05:00.000Z', { useUtc: true }), '04:05');
});

test('buildActivityActions returns copy and jump helpers for supported event types', () => {
  const shareActions = buildActivityActions(
    { type: 'draft_created', detail: 'Share draft persisted' },
    { shareUrl: 'https://example.org/tx/share-1' }
  );
  const relayActions = buildActivityActions(
    { type: 'relay_preflight', detail: 'Relay Check Passed' },
    { relayTargetId: 'relay-preflight-panel' }
  );
  const txActions = buildActivityActions(
    { type: 'broadcast_relay', detail: '0x' + 'ab'.repeat(32) },
    { explorerBaseUrl: 'https://testnet.ndoras.com/transaction' }
  );

  assert.deepEqual(shareActions, [{ id: 'copy-share', label: 'Copy Share Link', value: 'https://example.org/tx/share-1' }]);
  assert.deepEqual(relayActions, [{ id: 'jump-relay', label: 'Jump to Relay', targetId: 'relay-preflight-panel' }]);
  assert.deepEqual(txActions, [
    { id: 'copy-txid', label: 'Copy TxID', value: '0x' + 'ab'.repeat(32) },
    { id: 'open-url', label: 'Open Explorer', url: 'https://testnet.ndoras.com/transaction/0x' + 'ab'.repeat(32) },
  ]);
});

test('buildActivityEmptyState returns tailored guidance for each filter', () => {
  assert.match(buildActivityEmptyState('identity'), /Connect DID|NeoDID|recovery|private session/i);
  assert.match(buildActivityEmptyState('relay'), /Check Relay/i);
  assert.match(buildActivityEmptyState('signatures'), /Append Manual Signature|Sign with EVM Wallet/i);
  assert.match(buildActivityEmptyState('broadcast'), /Broadcast with Neo Wallet|Submit via Relay/i);
  assert.match(buildActivityEmptyState('workflow'), /Load Smart Account|Stage/i);
});

test('buildActivityPresentation returns icon and tone metadata for known event types', () => {
  assert.deepEqual(buildActivityPresentation({ type: 'did_bound' }), {
    icon: '◈',
    tone: 'identity',
    label: 'DID Bound',
  });
  assert.deepEqual(buildActivityPresentation({ type: 'signature_added' }), {
    icon: '✍',
    tone: 'signature',
    label: 'Signature Added',
  });
  assert.deepEqual(buildActivityPresentation({ type: 'relay_preflight' }), {
    icon: '⇄',
    tone: 'relay',
    label: 'Relay Check',
  });
});

test('buildActivityGroups groups filtered entries by day for display', () => {
  const groups = buildActivityGroups([
    ...sample,
    { id: '6', type: 'broadcast_client', detail: 'Client sent', createdAt: '2026-03-10T00:03:00.000Z' },
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].date, '2026-03-10');
  assert.equal(groups[0].items.length, 1);
  assert.equal(groups[1].date, '2026-03-09');
  assert.equal(groups[1].items.length, 5);
});
