import { createHash, randomUUID } from 'node:crypto';
import { apiFetch } from './outboundFetch.js';
import { isProductionDeployment } from './deploymentEnv.js';

const DEFAULT_JOURNAL_TTL_MS = 24 * 60 * 60 * 1000;
// F-13 (re-verified from code): how long a caller should wait before retrying
// after a durability-backend outage fails the request closed in production.
const BACKEND_UNAVAILABLE_RETRY_AFTER_SECONDS = 60;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256Hex(value) {
  const source = typeof value === 'string' ? value : stableStringify(value);
  return createHash('sha256').update(source).digest('hex');
}

function getUpstashClient() {
  const url = trimString(process.env.UPSTASH_REDIS_REST_URL).replace(/\/$/, '');
  const token = trimString(process.env.UPSTASH_REDIS_REST_TOKEN);
  if (!url || !token) return null;
  return { url, token };
}

async function upstashPipeline(commands = []) {
  const client = getUpstashClient();
  if (!client) return null;

  const response = await apiFetch(`${client.url}/pipeline`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${client.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  if (!response.ok) {
    throw new Error(`Upstash pipeline failed (${response.status})`);
  }

  return response.json();
}

async function upstashGetJson(key) {
  const client = getUpstashClient();
  if (!client) return null;

  const response = await apiFetch(`${client.url}/get/${encodeURIComponent(key)}`, {
    headers: { authorization: `Bearer ${client.token}` },
  });
  // F-13 (re-verified from code): a failed GET is a backend error, not a cache
  // miss — distinguish them so the caller can fail closed instead of silently
  // proceeding as if no cached response existed.
  if (!response.ok) {
    throw new Error(`Upstash get failed (${response.status})`);
  }

  const raw = await response.text();
  if (!raw || raw === 'null') return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function upstashSetJson(key, value, { ttlMs = 0, nx = false } = {}) {
  const command = ['SET', key, JSON.stringify(value)];
  if (ttlMs > 0) {
    command.push('PX', String(ttlMs));
  }
  if (nx) {
    command.push('NX');
  }
  const result = await upstashPipeline([command]);
  return result?.[0]?.result ?? null;
}

async function upstashDelete(key) {
  await upstashPipeline([['DEL', key]]).catch(() => {});
}

function deriveHeader(req, names = []) {
  for (const name of names) {
    const value = trimString(req.headers?.[name] || '');
    if (value) return value;
  }
  return '';
}

function deriveRequestId(req, payload = {}) {
  return (
    deriveHeader(req, ['x-request-id', 'x-correlation-id']) ||
    trimString(payload.request_id || payload.requestId || '') ||
    randomUUID()
  );
}

function deriveIdempotencyKey(req, payload = {}, fingerprint = null) {
  const explicit = deriveHeader(req, ['idempotency-key', 'x-idempotency-key']);

  const payloadKey = trimString(
    payload.idempotency_key
      || payload.idempotencyKey
      || payload.operation_hash
      || payload.operationHash
      || payload.request_id
      || payload.requestId
      || ''
  );

  // Always incorporate the payload fingerprint into the idempotency key so that
  // the same user-supplied key with a different payload produces a different
  // cache entry, preventing cached-response confusion attacks.
  const fpHash = fingerprint ? sha256Hex(fingerprint) : '';

  const userKey = explicit || payloadKey;
  if (userKey && fpHash) return sha256Hex(userKey + ':' + fpHash);
  if (userKey) return userKey;
  if (fpHash) return fpHash;
  return '';
}

function buildJournalKey(routeName, requestId) {
  // L3: the request id can be client-supplied (x-request-id header / request_id payload
  // field), so it must never become a Redis key verbatim — raw ids give callers unbounded
  // key cardinality and key-injection into the shared sa:request:* namespace. Hash it like
  // the lock/response siblings do; the raw value stays available for logs/echo responses.
  return `sa:request:journal:${routeName}:${sha256Hex(requestId)}`;
}

function buildLockKey(routeName, idempotencyKey) {
  return `sa:request:lock:${routeName}:${sha256Hex(idempotencyKey)}`;
}

function buildResponseKey(routeName, idempotencyKey) {
  return `sa:request:response:${routeName}:${sha256Hex(idempotencyKey)}`;
}

export async function beginDurableRequest({ req, routeName, payload = {}, fingerprint = null, replay = true, journalTtlMs = DEFAULT_JOURNAL_TTL_MS, lockTtlMs = 30_000, responseTtlMs = 15 * 60_000 } = {}) {
  const requestId = deriveRequestId(req, payload);
  // Authorization reads must observe current pins, links and counters. They keep
  // request journaling but cannot reuse a cached authorization response.
  const idempotencyKey = replay ? deriveIdempotencyKey(req, payload, fingerprint) : '';
  const journalKey = buildJournalKey(routeName, requestId);
  const context = {
    requestId,
    routeName,
    journalKey,
    journalTtlMs,
    lockTtlMs,
    responseTtlMs,
    idempotencyKey,
    lockKey: idempotencyKey ? buildLockKey(routeName, idempotencyKey) : '',
    responseKey: idempotencyKey ? buildResponseKey(routeName, idempotencyKey) : '',
    upstashEnabled: Boolean(getUpstashClient()),
  };

  if (!context.upstashEnabled) {
    return { ok: true, context };
  }

  // F-13 (re-verified from code): previously a configured-but-erroring Upstash
  // backend (HTTP error, command error, auth/quota failure) THREW straight out of
  // beginDurableRequest, crashing the route with an opaque platform 500 — the
  // opposite of the AA-07 fail-closed policy the rate limiter already follows.
  // Mirror that policy: in production fail closed with a clear 503; outside
  // production degrade to no durability with a warning.
  try {
    if (context.responseKey) {
      const cached = await upstashGetJson(context.responseKey);
      if (cached?.status && cached.body) {
        await upstashSetJson(journalKey, {
          request_id: requestId,
          route: routeName,
          status: 'replayed',
          replayed_at: new Date().toISOString(),
          idempotency_key: idempotencyKey,
        }, { ttlMs: journalTtlMs });
        return {
          ok: false,
          context,
          replayed: true,
          cached,
        };
      }
    }

    if (context.lockKey) {
      const claimed = await upstashSetJson(context.lockKey, {
        request_id: requestId,
        route: routeName,
        accepted_at: new Date().toISOString(),
      }, { ttlMs: lockTtlMs, nx: true });

      if (claimed !== 'OK') {
        return {
          ok: false,
          context,
          inProgress: true,
        };
      }
    }

    await upstashSetJson(journalKey, {
      request_id: requestId,
      route: routeName,
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      idempotency_key: idempotencyKey || null,
      fingerprint: fingerprint ? sha256Hex(fingerprint) : null,
    }, { ttlMs: journalTtlMs });

    return { ok: true, context };
  } catch (error) {
    if (isProductionDeployment()) {
      console.error(`[requestDurability] CRITICAL: durability backend failed for route ${routeName} in production deployment; failing closed (request_persistence_backend_unavailable):`, error?.message || error);
      return {
        ok: false,
        backendUnavailable: true,
        context,
        retryAfter: BACKEND_UNAVAILABLE_RETRY_AFTER_SECONDS,
      };
    }
    console.warn(`[requestDurability] durability backend failed for route ${routeName} outside production; proceeding without replay cache, idempotency lock and journal:`, error?.message || error);
    return { ok: true, context, degraded: true };
  }
}

// F-14 (re-verified from code): complete/fail run AFTER the relayed work — often
// after a transaction was already broadcast. A backend error here used to throw
// out of the handler, turning a completed broadcast into a client-visible 500
// that invites a retry (and a duplicate broadcast). Bookkeeping is best-effort:
// log and swallow, never fail the response.
async function bestEffortJournalWrite(label, routeName, run) {
  try {
    await run();
  } catch (error) {
    console.error(`[requestDurability] ${label} for route ${routeName} failed after the request executed; the client response is preserved:`, error?.message || error);
  }
}

export async function completeDurableRequest(context, { statusCode = 200, body = null, headers = {} } = {}) {
  if (!context?.upstashEnabled) return;

  await bestEffortJournalWrite('response-cache write', context.routeName, async () => {
    if (context.responseKey && statusCode < 500 && body && typeof body === 'object') {
      await upstashSetJson(context.responseKey, {
        status: statusCode,
        headers,
        body,
      }, { ttlMs: context.responseTtlMs });
    }

    await upstashSetJson(context.journalKey, {
      request_id: context.requestId,
      route: context.routeName,
      status: 'completed',
      completed_at: new Date().toISOString(),
      response_status: statusCode,
      idempotency_key: context.idempotencyKey || null,
    }, { ttlMs: context.journalTtlMs });

    if (context.lockKey) {
      await upstashDelete(context.lockKey);
    }
  });
}

export async function failDurableRequest(context, { statusCode = 500, error = '', phase = '' } = {}) {
  if (!context?.upstashEnabled) return;

  await bestEffortJournalWrite('failure journal write', context.routeName, async () => {
    await upstashSetJson(context.journalKey, {
      request_id: context.requestId,
      route: context.routeName,
      status: 'failed',
      failed_at: new Date().toISOString(),
      response_status: statusCode,
      error: trimString(error),
      phase: trimString(phase),
      idempotency_key: context.idempotencyKey || null,
    }, { ttlMs: context.journalTtlMs });

    if (context.lockKey) {
      await upstashDelete(context.lockKey);
    }
  });
}

export function attachRequestId(payload, requestId) {
  if (!requestId || payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  return {
    ...payload,
    request_id: payload.request_id || requestId,
  };
}
