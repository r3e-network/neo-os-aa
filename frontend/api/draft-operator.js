import { createClient } from '@supabase/supabase-js';
import { DRAFT_METADATA_HISTORY_LIMITS } from '../src/features/operations/constants.js';
import {
  canonicalizeOperatorMutationPayload,
  importOperatorPublicKey,
  operatorPublicKeysMatch,
  verifyOperatorMutationSignature,
} from './operatorMutationHelpers.js';
import { attachRequestId, beginDurableRequest, completeDurableRequest, failDurableRequest } from './requestDurability.js';
import { checkRateLimit, resolveClientIp, resolveRateLimitFailure } from './rateLimiter.js';

const OPERATOR_ACTIVITY_TYPES = new Set([
  'signature_added',
  'draft_created',
  'relay_preflight',
  'broadcast_client',
  'broadcast_relay',
  'collaborator_link_rotated',
  'operator_link_rotated',
]);

function getServiceSupabaseClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !serviceRoleKey) {
    return null;
  }
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}

function createScopedPath(shareSlug, slug) {
  return `/tx/${shareSlug}?access=${slug}`;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function trimEventList(items = [], limit = DRAFT_METADATA_HISTORY_LIMITS.activity) {
  const list = Array.isArray(items) ? items.map((item) => clone(item)) : [];
  return list
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .slice(Math.max(0, list.length - limit));
}

function trimReceiptList(items = [], limit = DRAFT_METADATA_HISTORY_LIMITS.submissionReceipts) {
  const list = Array.isArray(items) ? items.map((item) => clone(item)) : [];
  return list
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .slice(Math.max(0, list.length - limit));
}

function resolveOperatorAccessScope(draft = {}, accessSlug = '') {
  return draft?.operator_slug && accessSlug === draft.operator_slug ? 'operate' : 'read';
}

function serializeDraft(draft = {}, { accessScope = 'read' } = {}) {
  const base = {
    draft_id: draft.draft_id,
    share_slug: draft.share_slug,
    status: draft.status,
    account: clone(draft.account || {}),
    operation_body: clone(draft.operation_body || null),
    transaction_body: clone(draft.transaction_body || null),
    signer_requirements: clone(draft.signer_requirements || []),
    signatures: clone(draft.signatures || []),
    broadcast_mode: draft.broadcast_mode || 'client',
    metadata: clone(draft.metadata || {}),
    share_path: draft.share_path || `/tx/${draft.share_slug}`,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
    access_scope: accessScope,
    can_write: accessScope === 'operate',
    can_operate: accessScope === 'operate',
  };

  if (accessScope === 'operate') {
    base.collaboration_slug = draft.collaboration_slug;
    base.collaboration_path = draft.collaboration_path || createScopedPath(draft.share_slug, draft.collaboration_slug);
    base.operator_slug = draft.operator_slug;
    base.operator_path = draft.operator_path || createScopedPath(draft.share_slug, draft.operator_slug);
    base.operator_counter = Number(draft.operator_counter || 0);
  }

  return base;
}

async function loadDraftByShareSlug(supabase, shareSlug) {
  const { data, error } = await supabase
    .from('aa_transaction_drafts')
    .select('*')
    .eq('share_slug', shareSlug)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('draft_not_found');
  return data;
}

function assertOperatorAccess(draft, accessSlug) {
  if (!draft?.operator_slug || draft.operator_slug !== accessSlug) {
    throw new Error('draft_operator_access_required');
  }
}

function nextScopedSlug(...reserved) {
  let candidate = globalThis.crypto?.randomUUID?.() || `share-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  while (reserved.includes(candidate)) {
    candidate = globalThis.crypto?.randomUUID?.() || `share-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  return candidate;
}

function assertOperatorActivityAllowed(payload = {}) {
  const type = String(payload?.type || '').trim();
  if (!OPERATOR_ACTIVITY_TYPES.has(type)) {
    throw new Error('draft_activity_scope_not_allowed');
  }
}

function sendJson(res, statusCode, payload, requestId) {
  if (requestId) {
    res.setHeader?.('X-Request-Id', requestId);
  }
  res.status(statusCode).json(attachRequestId(payload, requestId));
}

async function handleClaim({ supabase, shareSlug, accessSlug, publicKeyJwk }) {
  const draft = await loadDraftByShareSlug(supabase, shareSlug);
  assertOperatorAccess(draft, accessSlug);

  const currentPublicKey = draft.operator_public_key || null;
  if (currentPublicKey && !operatorPublicKeysMatch(currentPublicKey, publicKeyJwk)) {
    throw new Error('operator_key_already_claimed');
  }

  if (!currentPublicKey) {
    if (!publicKeyJwk) {
      throw new Error('missing_operator_public_key');
    }

    await importOperatorPublicKey(publicKeyJwk);

    const { data, error } = await supabase
      .from('aa_transaction_drafts')
      .update({
        operator_public_key: publicKeyJwk,
        operator_key_claimed_at: new Date().toISOString(),
        operator_counter: Number(draft.operator_counter || 0),
      })
      .eq('draft_id', draft.draft_id)
      .eq('operator_slug', accessSlug)
      .is('operator_public_key', null)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new Error('operator_key_claim_failed');
    }
    return {
      draft: serializeDraft(data, { accessScope: 'operate' }),
      operatorCounter: Number(data.operator_counter || 0),
      accessSlug: data.operator_slug,
    };
  }

  return {
    draft: serializeDraft(draft, { accessScope: 'operate' }),
    operatorCounter: Number(draft.operator_counter || 0),
    accessSlug: draft.operator_slug,
  };
}

async function handleMutation({ supabase, shareSlug, accessSlug, mutation, payload, counter, signature }) {
  const draft = await loadDraftByShareSlug(supabase, shareSlug);
  assertOperatorAccess(draft, accessSlug);
  if (!draft.operator_public_key) {
    throw new Error('operator_key_not_claimed');
  }

  const expectedCounter = Number(draft.operator_counter || 0);
  if (Number(counter) !== expectedCounter) {
    throw new Error('operator_counter_mismatch');
  }

  const publicKey = await importOperatorPublicKey(draft.operator_public_key);
  const canonicalPayload = canonicalizeOperatorMutationPayload({
    shareSlug,
    mutation,
    payload,
    counter: expectedCounter,
  });
  const verified = await verifyOperatorMutationSignature(canonicalPayload, signature, publicKey);
  if (!verified) {
    throw new Error('invalid_operator_signature');
  }

  const metadata = clone(draft.metadata || {});
  const patch = {};

  switch (mutation) {
    case 'setStatus':
      patch.status = String(payload?.status || '').trim() || draft.status;
      break;
    case 'setRelayPreflight':
      patch.metadata = {
        ...metadata,
        relayPreflight: clone(payload?.relayPreflight ?? null),
      };
      break;
    case 'appendSubmissionReceipt': {
      const nextReceipts = trimReceiptList([...(metadata.submissionReceipts || []), clone(payload?.receipt || {})]);
      patch.metadata = { ...metadata, submissionReceipts: nextReceipts };
      break;
    }
    case 'appendActivity': {
      assertOperatorActivityAllowed(payload?.event || {});
      const nextActivity = trimEventList([...(metadata.activity || []), clone(payload?.event || {})]);
      patch.metadata = { ...metadata, activity: nextActivity };
      break;
    }
    case 'rotateCollaboratorLink': {
      const nextCollaboration = nextScopedSlug(draft.share_slug, draft.collaboration_slug, draft.operator_slug);
      patch.collaboration_slug = nextCollaboration;
      patch.collaboration_path = createScopedPath(draft.share_slug, nextCollaboration);
      break;
    }
    case 'rotateOperatorLink': {
      const nextOperator = nextScopedSlug(draft.share_slug, draft.collaboration_slug, draft.operator_slug);
      patch.operator_slug = nextOperator;
      patch.operator_path = createScopedPath(draft.share_slug, nextOperator);
      break;
    }
    default:
      throw new Error('unsupported_operator_mutation');
  }

  patch.operator_counter = expectedCounter + 1;

  const { data, error } = await supabase
    .from('aa_transaction_drafts')
    .update(patch)
    .eq('draft_id', draft.draft_id)
    .eq('operator_slug', accessSlug)
    .eq('operator_counter', expectedCounter)
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('operator_counter_mismatch');

  return {
    draft: serializeDraft(data, { accessScope: 'operate' }),
    operatorCounter: Number(data.operator_counter || 0),
    accessSlug: data.operator_slug,
  };
}

export default async function handler(req, res) {
  const requestPayload = req.body || {};
  const durable = await beginDurableRequest({
    req,
    routeName: 'draft_operator',
    payload: requestPayload,
    replay: String(requestPayload.action || '').trim() !== 'claim',
    fingerprint: {
      method: req.method,
      action: requestPayload.action || '',
      shareSlug: requestPayload.shareSlug || '',
      accessSlug: requestPayload.accessSlug || '',
      mutation: requestPayload.mutation || '',
      counter: requestPayload.counter ?? null,
      signature: requestPayload.signature || '',
      payload: requestPayload.payload || null,
    },
  });
  const requestId = durable.context.requestId;

  if (!durable.ok) {
    if (durable.replayed) {
      return sendJson(res, durable.cached.status, durable.cached.body, requestId);
    }
    if (durable.inProgress) {
      return sendJson(res, 409, { error: 'request_in_progress' }, requestId);
    }
  }

  if (req.method !== 'POST') {
    await failDurableRequest(durable.context, { statusCode: 405, error: 'method_not_allowed', phase: 'method' });
    return sendJson(res, 405, { error: 'method_not_allowed' }, requestId);
  }

  const clientIp = resolveClientIp(req);
  const rateLimit = await checkRateLimit(clientIp);
  
  if (!rateLimit.allowed) {
    const failure = resolveRateLimitFailure(rateLimit);
    if (failure.retryAfter) res.setHeader?.('Retry-After', String(failure.retryAfter));
    await failDurableRequest(durable.context, { statusCode: failure.statusCode, error: failure.error, phase: 'rate_limit' });
    return sendJson(res, failure.statusCode, {
      error: failure.error,
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
    }, requestId);
  }

  const supabase = getServiceSupabaseClient();
  if (!supabase) {
    await failDurableRequest(durable.context, { statusCode: 501, error: 'operator_mutation_not_configured', phase: 'config' });
    return sendJson(res, 501, { error: 'operator_mutation_not_configured', message: 'Signed operator mutations require SUPABASE_SERVICE_ROLE_KEY on the server.' }, requestId);
  }

  const action = String(requestPayload?.action || '').trim();
  const shareSlug = String(requestPayload?.shareSlug || '').trim();
  const accessSlug = String(requestPayload?.accessSlug || '').trim();

  try {
    if (!shareSlug || !accessSlug) {
      throw new Error('missing_operator_access');
    }

    if (action === 'claim') {
      const result = await handleClaim({
        supabase,
        shareSlug,
        accessSlug,
        publicKeyJwk: requestPayload?.publicKeyJwk || null,
      });
      await completeDurableRequest(durable.context, { statusCode: 200, body: attachRequestId(result, requestId) });
      return sendJson(res, 200, result, requestId);
    }

    if (action === 'mutate') {
      const result = await handleMutation({
        supabase,
        shareSlug,
        accessSlug,
        mutation: String(requestPayload?.mutation || '').trim(),
        payload: requestPayload?.payload || {},
        counter: requestPayload?.counter,
        signature: String(requestPayload?.signature || ''),
      });
      await completeDurableRequest(durable.context, { statusCode: 200, body: attachRequestId(result, requestId) });
      return sendJson(res, 200, result, requestId);
    }

    await failDurableRequest(durable.context, { statusCode: 400, error: 'unsupported_operator_action', phase: 'validation' });
    return sendJson(res, 400, { error: 'unsupported_operator_action' }, requestId);
  } catch (error) {
    const message = error?.message || String(error);
    const status = /not_configured/.test(message)
      ? 501
      : /missing_operator_access|unsupported_operator_action|draft_activity_scope_not_allowed/.test(message)
        ? 400
        : /draft_not_found/.test(message)
          ? 404
          : /draft_operator_access_required|invalid_operator_signature|operator_counter_mismatch|operator_key_already_claimed|operator_key_not_claimed|operator_key_claim_failed/.test(message)
            ? 403
            : 500;
    const body = {
      error: message,
      message,
    };
    await failDurableRequest(durable.context, { statusCode: status, error: message, phase: 'handler' });
    return sendJson(res, status, body, requestId);
  }
}
