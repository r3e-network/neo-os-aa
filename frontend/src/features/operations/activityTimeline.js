import { buildTransactionExplorerUrl, normalizeTransactionId } from './explorer.js';

export function buildActivityFilters(t) {
  return [
    { id: 'all', label: t ? t('operations.filterAll', 'All Events') : 'All Events' },
    { id: 'workflow', label: t ? t('operations.filterWorkflow', 'Workflow') : 'Workflow' },
    { id: 'identity', label: t ? t('operations.filterIdentity', 'Identity') : 'Identity' },
    { id: 'signatures', label: t ? t('operations.filterSignatures', 'Signatures') : 'Signatures' },
    { id: 'relay', label: t ? t('operations.filterRelay', 'Relay') : 'Relay' },
    { id: 'broadcast', label: t ? t('operations.filterBroadcast', 'Broadcast') : 'Broadcast' },
  ];
}

export const ACTIVITY_FILTERS = buildActivityFilters();

const TYPE_TO_GROUP = {
  account_loaded: 'workflow',
  operation_staged: 'workflow',
  draft_created: 'workflow',
  collaborator_link_rotated: 'workflow',
  operator_link_rotated: 'workflow',
  did_bound: 'identity',
  did_notice_sent: 'identity',
  recovery_requested: 'identity',
  recovery_finalized: 'identity',
  recovery_cancelled: 'identity',
  proxy_session_requested: 'identity',
  proxy_session_revoked: 'identity',
  signature_added: 'signatures',
  relay_preflight: 'relay',
  broadcast_client: 'broadcast',
  broadcast_relay: 'broadcast',
};

const SVG = {
  account: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"></path></svg>',
  document: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>',
  plus: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>',
  refresh: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>',
  shield: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>',
  mail: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg>',
  check: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>',
  xCircle: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>',
  layers: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>',
  minusCircle: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>',
  pencil: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>',
  bolt: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>',
  upload: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>',
  arrowUpRight: '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 17L17 7m0 0H7m10 0v10"></path></svg>',
  dot: '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"></circle></svg>',
};

const LEGACY_ICONS = {
  did_bound: '◈',
  did_notice_sent: '✉',
  recovery_requested: '↻',
  recovery_finalized: '✓',
  recovery_cancelled: '✕',
  proxy_session_requested: '▦',
  proxy_session_revoked: '⊖',
  signature_added: '✍',
  relay_preflight: '⇄',
  broadcast_client: '⇪',
  broadcast_relay: '⇪',
};

function buildTypePresentationMap(t) {
  return {
    account_loaded: { icon: SVG.account, tone: 'workflow', label: t ? t('operations.typeAccountLoaded', 'Account Loaded') : 'Account Loaded' },
    operation_staged: { icon: SVG.document, tone: 'workflow', label: t ? t('operations.typeOperationStaged', 'Operation Staged') : 'Operation Staged' },
    draft_created: { icon: SVG.plus, tone: 'workflow', label: t ? t('operations.typeDraftCreated', 'Draft Created') : 'Draft Created' },
    collaborator_link_rotated: { icon: SVG.refresh, tone: 'workflow', label: t ? t('operations.typeCollaboratorRotated', 'Collaborator Link Rotated') : 'Collaborator Link Rotated' },
    operator_link_rotated: { icon: SVG.refresh, tone: 'workflow', label: t ? t('operations.typeOperatorRotated', 'Operator Link Rotated') : 'Operator Link Rotated' },
    did_bound: { icon: SVG.shield, tone: 'identity', label: t ? t('operations.typeDidBound', 'DID Bound') : 'DID Bound' },
    did_notice_sent: { icon: SVG.mail, tone: 'identity', label: t ? t('operations.typeDidNotice', 'Recovery Notice Sent') : 'Recovery Notice Sent' },
    recovery_requested: { icon: SVG.refresh, tone: 'identity', label: t ? t('operations.typeRecoveryRequested', 'Recovery Requested') : 'Recovery Requested' },
    recovery_finalized: { icon: SVG.check, tone: 'identity', label: t ? t('operations.typeRecoveryFinalized', 'Recovery Finalized') : 'Recovery Finalized' },
    recovery_cancelled: { icon: SVG.xCircle, tone: 'identity', label: t ? t('operations.typeRecoveryCancelled', 'Recovery Cancelled') : 'Recovery Cancelled' },
    proxy_session_requested: { icon: SVG.layers, tone: 'identity', label: t ? t('operations.typeProxyRequested', 'Private Session Requested') : 'Private Session Requested' },
    proxy_session_revoked: { icon: SVG.minusCircle, tone: 'identity', label: t ? t('operations.typeProxyRevoked', 'Private Session Revoked') : 'Private Session Revoked' },
    signature_added: { icon: SVG.pencil, tone: 'signature', label: t ? t('operations.typeSignatureAdded', 'Signature Added') : 'Signature Added' },
    relay_preflight: { icon: SVG.bolt, tone: 'relay', label: t ? t('operations.typeRelayCheck', 'Relay Check') : 'Relay Check' },
    broadcast_client: { icon: SVG.upload, tone: 'broadcast', label: t ? t('operations.typeBroadcastClient', 'Client Broadcast') : 'Client Broadcast' },
    broadcast_relay: { icon: SVG.arrowUpRight, tone: 'broadcast', label: t ? t('operations.typeBroadcastRelay', 'Relay Broadcast') : 'Relay Broadcast' },
  };
}

function buildFilterEmptyStates(t) {
  return {
    all: t ? t('operations.emptyAll', 'No activity recorded yet.') : 'No activity recorded yet.',
    workflow: t ? t('operations.emptyWorkflow', 'Load an account and stage an operation to populate workflow activity.') : 'Load an account and stage an operation to populate workflow activity.',
    identity: t ? t('operations.emptyIdentity', 'Connect DID, bind NeoDID, or request recovery/private sessions to populate identity activity.') : 'Connect DID, bind NeoDID, or request recovery/private sessions to populate identity activity.',
    signatures: t ? t('operations.emptySignatures', 'Use Append Manual Signature or Sign with EVM Wallet to populate the signatures timeline.') : 'Use Append Manual Signature or Sign with EVM Wallet to populate the signatures timeline.',
    relay: t ? t('operations.emptyRelay', 'Run Check Relay to create relay diagnostics and readiness activity.') : 'Run Check Relay to create relay diagnostics and readiness activity.',
    broadcast: t ? t('operations.emptyBroadcast', 'Use Broadcast with Neo Wallet or Submit via Relay to create broadcast events.') : 'Use Broadcast with Neo Wallet or Submit via Relay to create broadcast events.',
  };
}

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function dateKey(date, useUtc = false) {
  const value = toDate(date);
  const year = useUtc ? value.getUTCFullYear() : value.getFullYear();
  const month = String((useUtc ? value.getUTCMonth() : value.getMonth()) + 1).padStart(2, '0');
  const day = String(useUtc ? value.getUTCDate() : value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatActivityDateLabel(dateValue, { now = new Date(), useUtc = false, t } = {}) {
  const currentKey = dateKey(now, useUtc);
  const yesterdayBase = toDate(now);
  if (useUtc) {
    yesterdayBase.setUTCDate(yesterdayBase.getUTCDate() - 1);
  } else {
    yesterdayBase.setDate(yesterdayBase.getDate() - 1);
  }
  const yesterdayKey = dateKey(yesterdayBase, useUtc);
  const targetKey = /^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || '')) ? String(dateValue) : dateKey(dateValue, useUtc);

  if (targetKey === currentKey) return t ? t('operations.today', 'Today') : 'Today';
  if (targetKey === yesterdayKey) return t ? t('operations.yesterday', 'Yesterday') : 'Yesterday';
  return targetKey;
}

export function formatActivityTimeLabel(dateValue, { now = new Date(), useUtc = false, t } = {}) {
  const value = toDate(dateValue);
  const diffMs = now.getTime() - value.getTime();
  if (diffMs >= 0) {
    const diffMinutes = Math.floor(diffMs / 60000);
    if (diffMinutes < 1) return t ? t('operations.justNow', 'just now') : 'just now';
    if (diffMinutes < 60) return t ? t('operations.minutesAgo', '{n}m ago').replace('{n}', diffMinutes) : `${diffMinutes}m ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return t ? t('operations.hoursAgo', '{n}h ago').replace('{n}', diffHours) : `${diffHours}h ago`;
  }
  const hours = String(useUtc ? value.getUTCHours() : value.getHours()).padStart(2, '0');
  const minutes = String(useUtc ? value.getUTCMinutes() : value.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function classifyActivityEvent(event = {}) {
  return TYPE_TO_GROUP[event.type] || 'workflow';
}

export function buildActivityPresentation(event = {}, { t } = {}) {
  const map = buildTypePresentationMap(t);
  const resolved = map[event.type] || { icon: SVG.dot, tone: 'workflow', label: event.type || (t ? t('operations.typeGenericEvent', 'Event') : 'Event') };
  if (!t) {
    return {
      ...resolved,
      icon: LEGACY_ICONS[event.type] || '•',
    };
  }
  return resolved;
}

export function buildActivityActions(event = {}, context = {}) {
  const actions = [];
  const t = context.t;

  if (event.type === 'draft_created' && context.shareUrl) {
    actions.push({ id: 'copy-share', label: t ? t('operations.copyShareLink', 'Copy Share Link') : 'Copy Share Link', value: context.shareUrl });
  }

  if (event.type === 'relay_preflight' && context.relayTargetId) {
    actions.push({ id: 'jump-relay', label: t ? t('operations.jumpToRelay', 'Jump to Relay') : 'Jump to Relay', targetId: context.relayTargetId });
  }

  if (event.type === 'broadcast_client' || event.type === 'broadcast_relay') {
    const txid = normalizeTransactionId(event.detail);
    if (txid) {
      actions.push({ id: 'copy-txid', label: t ? t('operations.copyTxId', 'Copy TxID') : 'Copy TxID', value: txid });
      const explorerUrl = buildTransactionExplorerUrl(context.explorerBaseUrl, txid);
      if (explorerUrl) {
        actions.push({ id: 'open-url', label: t ? t('operations.openExplorer', 'Open Explorer') : 'Open Explorer', url: explorerUrl });
      }
    }
  }

  return actions;
}

export function buildActivityEmptyState(filterId = 'all', t) {
  const states = buildFilterEmptyStates(t);
  return states[filterId] || states.all;
}

export function buildActivityFilterCounts(entries = []) {
  const counts = {
    all: 0,
    workflow: 0,
    identity: 0,
    signatures: 0,
    relay: 0,
    broadcast: 0,
  };

  for (const item of Array.isArray(entries) ? entries : []) {
    const group = classifyActivityEvent(item);
    counts.all += 1;
    if (Object.prototype.hasOwnProperty.call(counts, group)) {
      counts[group] += 1;
    }
  }

  return counts;
}

export function filterActivityEntries(entries = [], filterId = 'all') {
  const items = Array.isArray(entries) ? entries : [];
  if (!filterId || filterId === 'all') return items;
  return items.filter((item) => classifyActivityEvent(item) === filterId);
}

export function buildActivityGroups(entries = []) {
  const groups = new Map();
  for (const item of Array.isArray(entries) ? entries : []) {
    const date = String(item?.createdAt || '').slice(0, 10) || 'unknown';
    const bucket = groups.get(date) || [];
    bucket.push(item);
    groups.set(date, bucket);
  }

  return Array.from(groups.entries())
    .sort((left, right) => right[0].localeCompare(left[0]))
    .map(([date, items]) => ({
      date,
      items: items.slice().sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
    }));
}
