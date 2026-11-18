import { isProductionDeployment } from './deploymentEnv.js';
import { apiFetch } from './outboundFetch.js';

const WINDOW_MS = 60000;
const MAX_REQUESTS = 10;
// AA-07: default cap for the in-memory fallback store (override via
// SA_RATE_LIMIT_IN_MEMORY_MAX). Without a bound the Map grew forever per instance under
// hostile identifier churn.
const IN_MEMORY_MAX_ENTRIES_DEFAULT = 10000;
const TRUSTED_PROXY_HEADER_NAMES = new Set([
  'x-vercel-forwarded-for',
  'cf-connecting-ip',
  'x-real-ip',
]);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function headerValue(headers = {}, name) {
  const direct = headers?.[name];
  if (Array.isArray(direct)) return trimString(direct[0] || '');
  if (direct) return trimString(direct);

  const expected = String(name).toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() !== expected) continue;
    if (Array.isArray(value)) return trimString(value[0] || '');
    return trimString(value);
  }
  return '';
}

function trustProxyHeaders() {
  return /^(1|true|yes|on)$/i.test(trimString(
    process.env.SA_TRUST_PROXY_HEADERS
      || process.env.TRUST_PROXY_HEADERS
      || ''
  ));
}

function trustedProxyHeaderName() {
  const configured = trimString(
    process.env.SA_TRUST_PROXY_HEADER
      || process.env.TRUST_PROXY_HEADER
      || ''
  ).toLowerCase();
  return TRUSTED_PROXY_HEADER_NAMES.has(configured) ? configured : '';
}

function firstForwardedAddress(value) {
  return trimString(String(value || '').split(',')[0] || '');
}

export function resolveClientIp(req = {}) {
  const socketAddress = trimString(
    req?.socket?.remoteAddress
      || req?.connection?.remoteAddress
      || ''
  );

  if (!trustProxyHeaders()) return socketAddress;

  const configuredHeader = trustedProxyHeaderName();
  const proxyAddress = configuredHeader
    ? firstForwardedAddress(headerValue(req.headers, configuredHeader))
    : '';

  return proxyAddress || socketAddress;
}

function getRedisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

async function rateLimitWithRedis(identifier) {
  const client = getRedisClient();
  if (!client) return null;

  // F-12 (re-verified from code): live under the sa:* Redis namespace like the
  // request-persistence keys (sa:request:*), not the pre-rename flat namespace.
  const key = `sa:ratelimit:${identifier}`;

  try {
    const response = await apiFetch(`${client.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${client.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', key],
        ['PTTL', key],
      ]),
    });
    if (!response.ok) return null;

    const result = await response.json();
    const incrEntry = Array.isArray(result) ? result[0] : null;
    const pttlEntry = Array.isArray(result) ? result[1] : null;

    // F-12 (re-verified from code): Upstash answers a failed command inside an
    // HTTP 200 pipeline as { error } or a non-numeric result. Previously that was
    // read as "count = 0" and the request was allowed — the limiter failed OPEN on
    // a broken backend while looking healthy. A command error is a backend
    // failure: return null so the AA-07 fail-closed path decides.
    if (!incrEntry || incrEntry.error != null || incrEntry.result == null
      || !Number.isFinite(Number(incrEntry.result))) {
      return null;
    }
    const count = Number(incrEntry.result);
    let ttl = -1;
    if (pttlEntry && pttlEntry.error == null && Number.isFinite(Number(pttlEntry.result))) {
      ttl = Number(pttlEntry.result);
    }

    if (count <= 1 || ttl < 0) {
      const expireResponse = await apiFetch(`${client.url}/pipeline`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${client.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          ['PEXPIRE', key, String(WINDOW_MS)],
        ]),
      });
      if (!expireResponse.ok) return null;
      const expireResult = await expireResponse.json().catch(() => null);
      const expireEntry = Array.isArray(expireResult) ? expireResult[0] : null;
      // F-12 (re-verified from code): an unconfirmed PEXPIRE leaves the counter
      // without a TTL — the identifier would be locked out forever because the
      // count only grows. A failed PEXPIRE command is a backend failure, not a
      // silent success.
      if (!expireEntry || expireEntry.error != null
        || (!Number.isFinite(Number(expireEntry.result)) && expireEntry.result !== 'OK')) {
        return null;
      }
      ttl = WINDOW_MS;
    }

    if (count > MAX_REQUESTS) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(Math.ceil(ttl / 1000), 1),
      };
    }

    return { allowed: true, remaining: Math.max(MAX_REQUESTS - count, 0) };
  } catch {
    return null;
  }
}

const inMemoryRequests = new Map();

function inMemoryMaxEntries() {
  const raw = trimString(process.env.SA_RATE_LIMIT_IN_MEMORY_MAX || '');
  if (!raw) return IN_MEMORY_MAX_ENTRIES_DEFAULT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : IN_MEMORY_MAX_ENTRIES_DEFAULT;
}

// AA-07: bound the fallback store. Map iteration follows insertion order and entries are
// re-inserted on every hit (see rateLimitInMemory), so the first keys are the
// least-recently-used identifiers — evict those first.
function evictInMemoryOverflow() {
  let excess = inMemoryRequests.size - inMemoryMaxEntries();
  if (excess <= 0) return;
  for (const key of inMemoryRequests.keys()) {
    if (excess <= 0) break;
    inMemoryRequests.delete(key);
    excess -= 1;
  }
}

function rateLimitInMemory(identifier) {
  const now = Date.now();
  const key = String(identifier);

  const existing = inMemoryRequests.get(key);
  const timestamps = (existing || []).filter(t => now - t < WINDOW_MS);

  if (timestamps.length >= MAX_REQUESTS) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((timestamps[0] + WINDOW_MS - now) / 1000) };
  }

  timestamps.push(now);
  // Delete-then-set refreshes recency so the eviction sweep is LRU-ordered.
  if (existing) inMemoryRequests.delete(key);
  inMemoryRequests.set(key, timestamps);
  evictInMemoryOverflow();

  return { allowed: true, remaining: MAX_REQUESTS - timestamps.length };
}

export async function checkRateLimit(identifier) {
  if (!trimString(identifier)) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: 60,
      error: 'client_identity_unavailable',
    };
  }
  const redisConfigured = Boolean(getRedisClient());
  const redisResult = await rateLimitWithRedis(identifier);
  if (redisResult !== null) return redisResult;
  if (redisConfigured) {
    // AA-07: Redis IS configured but the call failed (HTTP error or fetch threw). Previously
    // this silently failed OPEN — requests flowed with no limiting and no signal. Fail
    // closed in production with a loud log; outside production fall back to the best-effort
    // in-memory limiter with a warning.
    if (isProductionDeployment()) {
      console.error('[rateLimiter] CRITICAL: Redis rate-limit backend failed in production deployment; failing closed (rate_limit_backend_unavailable).');
      return {
        allowed: false,
        remaining: 0,
        retryAfter: 60,
        error: 'rate_limit_backend_unavailable',
      };
    }
    console.warn('[rateLimiter] Redis rate-limit backend failed outside production; falling back to the in-memory limiter.');
  }
  return rateLimitInMemory(identifier);
}

export function resolveRateLimitFailure(rateLimit = {}) {
  if (rateLimit?.error === 'client_identity_unavailable') {
    return {
      statusCode: 400,
      error: 'client_identity_unavailable',
      retryAfter: 0,
    };
  }

  if (rateLimit?.error === 'rate_limit_backend_unavailable') {
    // AA-07: a production backend outage is a server-side failure — surface a clear 5xx,
    // not a client-blaming 429.
    return {
      statusCode: 503,
      error: 'rate_limit_backend_unavailable',
      retryAfter: Number(rateLimit?.retryAfter || 60),
    };
  }

  return {
    statusCode: 429,
    error: 'rate_limit_exceeded',
    retryAfter: Number(rateLimit?.retryAfter || 60),
  };
}

export function sanitizeError(error) {
  const message = String(error?.message || error || 'Unknown error');

  if (message.includes('fault') || message.includes('FAULT')) {
    return 'Transaction simulation failed';
  }

  if (message.includes('Not Deployer') || message.includes('Unauthorized')) {
    return 'Unauthorized operation';
  }

  if (message.includes('nonce') || message.includes('Nonce')) {
    return 'Invalid transaction nonce';
  }

  if (message.includes('expired') || message.includes('deadline')) {
    return 'Transaction signature expired';
  }

  return 'Transaction failed';
}
