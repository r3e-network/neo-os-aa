import { cloneImmutable } from './helpers.js';
import { getSupabaseClient } from '../../lib/supabaseClient.js';
import { buildDraftCollaborationPath, buildDraftSharePath } from './shareLinks.js';
import { appendSignatureEntries } from './signatures.js';
import { appendActivityEntries } from './activity.js';
import { appendSubmissionReceiptEntries } from './submissionReceipts.js';
import { EC, isErrorCode } from '../../config/errorCodes.js';

function createScopedError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

export const DRAFTS_TABLE = 'sa_transaction_drafts';
export const LOCAL_DRAFTS_STORAGE_KEY = 'sa_transaction_drafts_local_v1';

const SIGNER_SCOPE_ACTIVITY_TYPES = new Set([
  'signature_added',
]);

const OPERATOR_SCOPE_ACTIVITY_TYPES = new Set([
  ...SIGNER_SCOPE_ACTIVITY_TYPES,
  'draft_created',
  'relay_preflight',
  'broadcast_client',
  'broadcast_relay',
  'collaborator_link_rotated',
  'operator_link_rotated',
]);

function nextDraftId() {
  return globalThis.crypto?.randomUUID?.() || `draft-${Date.now()}`;
}

function nextShareSlug() {
  return globalThis.crypto?.randomUUID?.() || `share-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function nextScopedSlug(...reserved) {
  let candidate = nextShareSlug();
  while (reserved.includes(candidate)) {
    candidate = nextShareSlug();
  }
  return candidate;
}

function unwrapRpcResult(data) {
  return Array.isArray(data) ? data[0] || null : data;
}

function normalizeDraftStoreError(error) {
  const message = String(error?.message || error || '');
  // Idempotent: errors already carrying an EC code (locally thrown or
  // previously normalized) pass through so specific codes never degrade
  // to the generic draft-request failure.
  if (isErrorCode(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  if (/draft_operator_access_required/i.test(message)) {
    return new Error(EC.operatorAccessRequired);
  }
  if (/draft_collaboration_access_required/i.test(message)) {
    return new Error(EC.collaboratorAccessRequired);
  }
  if (/draft_not_found/i.test(message)) {
    return new Error(EC.draftNotFound);
  }
  if (/draft_activity_scope_not_allowed/i.test(message)) {
    return new Error(EC.activityScopeDenied);
  }
  const err = new Error(EC.draftRequestFailed);
  err.apiDetail = message || null;
  return err;
}

function getBrowserStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage || null;
  } catch (err) {
    if (import.meta.env.DEV) console.warn('[drafts] localStorage access denied:', err?.message);
    return null;
  }
}

function readLocalDraftMap(storage) {
  const backend = getBrowserStorage(storage);
  if (!backend) {
    throw new Error(EC.draftStorageUnavailable);
  }

  const raw = backend.getItem(LOCAL_DRAFTS_STORAGE_KEY);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (import.meta.env.DEV) console.warn('[drafts] Malformed draft JSON:', err?.message);
    return {};
  }
}

function writeLocalDraftMap(storage, value) {
  const backend = getBrowserStorage(storage);
  if (!backend) {
    throw new Error(EC.draftStorageUnavailable);
  }
  backend.setItem(LOCAL_DRAFTS_STORAGE_KEY, JSON.stringify(value));
}

function resolveOperatorSlug(options = {}) {
  return String(options?.operatorSlug || options?.operator_slug || '').trim();
}

function resolveAccessSlug(options = {}) {
  return String(
    options?.accessSlug
      || options?.access_slug
      || options?.operatorSlug
      || options?.operator_slug
      || options?.collaborationSlug
      || options?.collaboration_slug
      || ''
  ).trim();
}

function resolveAccessContext(record, options = {}) {
  const accessSlug = resolveAccessSlug(options);
  if (!record || !accessSlug) {
    return { accessSlug: '', accessScope: 'read' };
  }
  if (record.operator_slug && accessSlug === record.operator_slug) {
    return { accessSlug, accessScope: 'operate' };
  }
  if (record.collaboration_slug && accessSlug === record.collaboration_slug) {
    return { accessSlug, accessScope: 'sign' };
  }
  return { accessSlug: '', accessScope: 'read' };
}

function buildScopedPath(record = {}, slug = '') {
  return buildDraftCollaborationPath(record.share_slug || record.draft_id || '', slug);
}

function withDraftAccess(record, options = {}) {
  const payload = cloneImmutable(record || null);
  if (!payload) return payload;

  const { accessScope } = resolveAccessContext(payload, options);
  const next = {
    ...payload,
    share_path: payload.share_path || buildDraftSharePath(payload.share_slug || payload.draft_id || ''),
    access_scope: accessScope,
    can_write: accessScope === 'sign' || accessScope === 'operate',
    can_operate: accessScope === 'operate',
  };

  if (accessScope === 'operate') {
    next.collaboration_slug = payload.collaboration_slug;
    next.collaboration_path = payload.collaboration_path || buildScopedPath(payload, payload.collaboration_slug);
    next.operator_slug = payload.operator_slug;
    next.operator_path = payload.operator_path || buildScopedPath(payload, payload.operator_slug);
    return next;
  }

  if (accessScope === 'sign') {
    next.collaboration_slug = payload.collaboration_slug;
    next.collaboration_path = payload.collaboration_path || buildScopedPath(payload, payload.collaboration_slug);
    delete next.operator_slug;
    delete next.operator_path;
    return next;
  }

  delete next.collaboration_slug;
  delete next.collaboration_path;
  delete next.operator_slug;
  delete next.operator_path;
  return next;
}

function requireLocalCollaboratorAccess(record, options = {}) {
  const { accessSlug, accessScope } = resolveAccessContext(record, options);
  if (accessScope === 'sign' || accessScope === 'operate') {
    return { accessSlug, accessScope };
  }
  throw createScopedError(EC.collaboratorAccessRequired, 'collaborator access required');
}

function requireLocalOperatorAccess(record, options = {}) {
  const { accessSlug, accessScope } = resolveAccessContext(record, options);
  if (accessScope === 'operate') {
    return accessSlug;
  }
  throw createScopedError(EC.operatorAccessRequired, 'operator access required');
}

function sanitizeDraftActivityEvent(event = {}, { accessScope = 'read' } = {}) {
  const nextEvent = cloneImmutable(event || {});
  const type = String(nextEvent?.type || '').trim();

  if (!type) {
    throw createScopedError(EC.activityScopeDenied, 'cannot record that activity');
  }

  const allowedTypes = accessScope === 'operate'
    ? OPERATOR_SCOPE_ACTIVITY_TYPES
    : accessScope === 'sign'
      ? SIGNER_SCOPE_ACTIVITY_TYPES
      : null;

  if (!allowedTypes || !allowedTypes.has(type)) {
    throw createScopedError(EC.activityScopeDenied, 'cannot record that activity');
  }

  return nextEvent;
}

function mergeDraftMetadata(record, metadataPatch = {}) {
  return {
    ...record,
    metadata: {
      ...(record?.metadata || {}),
      ...(cloneImmutable(metadataPatch) || {}),
    },
  };
}

function createLocalDraftStore(storage) {
  return {
    async createDraft(record) {
      const payload = createDraftRecord(record);
      const current = readLocalDraftMap(storage);
      current[payload.share_slug] = payload;
      writeLocalDraftMap(storage, current);
      return withDraftAccess(payload, { accessSlug: payload.operator_slug });
    },
    async loadDraft(shareSlug, options = {}) {
      const current = readLocalDraftMap(storage);
      const record = current[shareSlug];
      if (!record) {
        throw new Error(EC.draftNotFound);
      }
      return withDraftAccess(record, options);
    },
    async appendSignature(shareSlug, signature, options = {}) {
      const current = readLocalDraftMap(storage);
      const record = current[shareSlug];
      if (!record) {
        throw new Error(EC.draftNotFound);
      }
      const { accessSlug } = requireLocalCollaboratorAccess(record, options);
      const next = appendSignatureRecord(record, signature);
      current[shareSlug] = next;
      writeLocalDraftMap(storage, current);
      return withDraftAccess(next, { accessSlug });
    },
    async updateStatus(shareSlug, status, options = {}) {
      const current = readLocalDraftMap(storage);
      const record = current[shareSlug];
      if (!record) {
        throw new Error(EC.draftNotFound);
      }
      const accessSlug = requireLocalOperatorAccess(record, options);
      const next = {
        ...record,
        status,
      };
      current[shareSlug] = next;
      writeLocalDraftMap(storage, current);
      return withDraftAccess(next, { accessSlug });
    },
    async setRelayPreflight(shareSlug, relayPreflight, options = {}) {
      const current = readLocalDraftMap(storage);
      const record = current[shareSlug];
      if (!record) {
        throw new Error(EC.draftNotFound);
      }
      const accessSlug = requireLocalOperatorAccess(record, options);
      const next = mergeDraftMetadata(record, { relayPreflight: cloneImmutable(relayPreflight || null) });
      current[shareSlug] = next;
      writeLocalDraftMap(storage, current);
      return withDraftAccess(next, { accessSlug });
    },
    async appendActivity(shareSlug, event, options = {}) {
      const current = readLocalDraftMap(storage);
      const record = current[shareSlug];
      if (!record) {
        throw new Error(EC.draftNotFound);
      }
      const { accessSlug, accessScope } = requireLocalCollaboratorAccess(record, options);
      const next = mergeDraftMetadata(record, {
        activity: appendActivityEntries(
          record?.metadata?.activity || [],
          sanitizeDraftActivityEvent(event, { accessScope }),
        ),
      });
      current[shareSlug] = next;
      writeLocalDraftMap(storage, current);
      return withDraftAccess(next, { accessSlug });
    },
    async appendSubmissionReceipt(shareSlug, receipt, options = {}) {
      const current = readLocalDraftMap(storage);
      const record = current[shareSlug];
      if (!record) {
        throw new Error(EC.draftNotFound);
      }
      const accessSlug = requireLocalOperatorAccess(record, options);
      const next = mergeDraftMetadata(record, {
        submissionReceipts: appendSubmissionReceiptEntries(record?.metadata?.submissionReceipts || [], receipt),
      });
      current[shareSlug] = next;
      writeLocalDraftMap(storage, current);
      return withDraftAccess(next, { accessSlug });
    },
    async rotateCollaboratorLink(shareSlug, options = {}) {
      const current = readLocalDraftMap(storage);
      const record = current[shareSlug];
      if (!record) {
        throw new Error(EC.draftNotFound);
      }
      const accessSlug = requireLocalOperatorAccess(record, options);
      const nextCollaboration = nextScopedSlug(record.share_slug, record.collaboration_slug, record.operator_slug);
      const next = {
        ...record,
        collaboration_slug: nextCollaboration,
        collaboration_path: buildScopedPath(record, nextCollaboration),
      };
      current[shareSlug] = next;
      writeLocalDraftMap(storage, current);
      return withDraftAccess(next, { accessSlug });
    },
    async rotateOperatorLink(shareSlug, options = {}) {
      const current = readLocalDraftMap(storage);
      const record = current[shareSlug];
      if (!record) {
        throw new Error(EC.draftNotFound);
      }
      requireLocalOperatorAccess(record, options);
      const nextOperator = nextScopedSlug(record.share_slug, record.operator_slug, record.collaboration_slug);
      const next = {
        ...record,
        operator_slug: nextOperator,
        operator_path: buildScopedPath(record, nextOperator),
      };
      current[shareSlug] = next;
      writeLocalDraftMap(storage, current);
      return withDraftAccess(next, { accessSlug: nextOperator });
    },
  };
}

export function createDraftRecord({
  draftId = nextDraftId(),
  shareSlug = nextShareSlug(),
  collaborationSlug = nextScopedSlug(shareSlug),
  operatorSlug = nextScopedSlug(shareSlug, collaborationSlug),
  account = {},
  operationBody = null,
  transactionBody = null,
  signerRequirements = [],
  signatures = [],
  broadcastMode = 'client',
  metadata = {},
} = {}) {
  return {
    draft_id: draftId,
    share_slug: shareSlug,
    collaboration_slug: collaborationSlug,
    operator_slug: operatorSlug,
    status: 'draft',
    account: cloneImmutable(account),
    operation_body: cloneImmutable(operationBody),
    transaction_body: cloneImmutable(transactionBody),
    signer_requirements: cloneImmutable(signerRequirements),
    signatures: cloneImmutable(signatures),
    broadcast_mode: broadcastMode,
    metadata: cloneImmutable(metadata),
    share_path: buildDraftSharePath(shareSlug),
    collaboration_path: buildDraftCollaborationPath(shareSlug, collaborationSlug),
    operator_path: buildDraftCollaborationPath(shareSlug, operatorSlug),
    access_scope: 'operate',
    can_write: true,
    can_operate: true,
  };
}

export function appendSignatureRecord(record, signature) {
  return {
    ...record,
    signatures: appendSignatureEntries(record?.signatures || [], signature),
  };
}

export function createDraftStore({ supabase = getSupabaseClient(), storage = null, operatorMutationTransport = null } = {}) {
  if (!supabase) {
    return createLocalDraftStore(storage);
  }

  async function runOperatorMutation({ shareSlug, accessSlug, mutation, payload }) {
    if (!operatorMutationTransport?.run) {
      throw new Error(EC.operatorMutationsUnavailable);
    }
    return operatorMutationTransport.run({ shareSlug, accessSlug, mutation, payload });
  }

  return {
    async createDraft(record) {
      try {
        const payload = createDraftRecord(record);
        const { data, error } = await supabase.rpc('create_sa_draft', {
          p_payload: payload,
        });
        if (error) throw error;
        return unwrapRpcResult(data);
      } catch (error) {
        throw normalizeDraftStoreError(error);
      }
    },
    async loadDraft(shareSlug, options = {}) {
      try {
        const { data, error } = await supabase.rpc('get_sa_draft_by_share_slug', {
          p_share_slug: shareSlug,
          p_access_slug: resolveAccessSlug(options) || null,
        });
        if (error) throw error;
        return unwrapRpcResult(data);
      } catch (error) {
        throw normalizeDraftStoreError(error);
      }
    },
    async appendSignature(shareSlug, signature, options = {}) {
      const accessSlug = resolveAccessSlug(options);
      if (!accessSlug) {
        throw new Error(EC.collaboratorAccessRequired);
      }
      try {
        const { data, error } = await supabase.rpc('append_sa_draft_signature', {
          p_share_slug: shareSlug,
          p_access_slug: accessSlug,
          p_signature: cloneImmutable(signature),
        });
        if (error) throw error;
        return unwrapRpcResult(data);
      } catch (error) {
        throw normalizeDraftStoreError(error);
      }
    },
    async updateStatus(shareSlug, status, options = {}) {
      const accessSlug = resolveOperatorSlug(options) || resolveAccessSlug(options);
      if (!accessSlug) {
        throw new Error(EC.operatorAccessRequired);
      }
      try {
        return await runOperatorMutation({
          shareSlug,
          accessSlug,
          mutation: 'setStatus',
          payload: { status },
        });
      } catch (error) {
        throw normalizeDraftStoreError(error);
      }
    },
    async setRelayPreflight(shareSlug, relayPreflight, options = {}) {
      const accessSlug = resolveOperatorSlug(options) || resolveAccessSlug(options);
      if (!accessSlug) {
        throw new Error(EC.operatorAccessRequired);
      }
      try {
        return await runOperatorMutation({
          shareSlug,
          accessSlug,
          mutation: 'setRelayPreflight',
          payload: { relayPreflight: cloneImmutable(relayPreflight || null) },
        });
      } catch (error) {
        throw normalizeDraftStoreError(error);
      }
    },
    async appendActivity(shareSlug, event, options = {}) {
      const accessSlug = resolveAccessSlug(options);
      if (!accessSlug) {
        throw new Error(EC.collaboratorAccessRequired);
      }
      // Callers only know their access slug; append_sa_draft_activity resolves
      // whether it is an operator or collaborator capability and enforces the
      // allowed event types server-side.
      try {
        const { data, error } = await supabase.rpc('append_sa_draft_activity', {
          p_share_slug: shareSlug,
          p_access_slug: accessSlug,
          p_event: cloneImmutable(event || {}),
        });
        if (error) throw error;
        return unwrapRpcResult(data);
      } catch (error) {
        throw normalizeDraftStoreError(error);
      }
    },
    async appendSubmissionReceipt(shareSlug, receipt, options = {}) {
      const accessSlug = resolveOperatorSlug(options) || resolveAccessSlug(options);
      if (!accessSlug) {
        throw new Error(EC.operatorAccessRequired);
      }
      try {
        return await runOperatorMutation({
          shareSlug,
          accessSlug,
          mutation: 'appendSubmissionReceipt',
          payload: { receipt: cloneImmutable(receipt || {}) },
        });
      } catch (error) {
        throw normalizeDraftStoreError(error);
      }
    },
    async rotateCollaboratorLink(shareSlug, options = {}) {
      const accessSlug = resolveOperatorSlug(options) || resolveAccessSlug(options);
      if (!accessSlug) {
        throw new Error(EC.operatorAccessRequired);
      }
      try {
        return await runOperatorMutation({
          shareSlug,
          accessSlug,
          mutation: 'rotateCollaboratorLink',
          payload: {},
        });
      } catch (error) {
        throw normalizeDraftStoreError(error);
      }
    },
    async rotateOperatorLink(shareSlug, options = {}) {
      const accessSlug = resolveOperatorSlug(options) || resolveAccessSlug(options);
      if (!accessSlug) {
        throw new Error(EC.operatorAccessRequired);
      }
      try {
        return await runOperatorMutation({
          shareSlug,
          accessSlug,
          mutation: 'rotateOperatorLink',
          payload: {},
        });
      } catch (error) {
        throw normalizeDraftStoreError(error);
      }
    },
  };
}
