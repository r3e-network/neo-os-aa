import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from '../src/utils/fetchWithTimeout.js';

// L1: every outbound fetch from the API surface must run behind an abort-based timeout so a
// hung upstream (RPC node, morpheus runtime, Upstash, webhooks) can never wedge a serverless
// invocation until the platform kills it. Reuses the shared src/utils fetchWithTimeout
// helper; the default budget is DEFAULT_FETCH_TIMEOUT_MS and operators can tighten/relax it
// via AA_API_FETCH_TIMEOUT_MS (also what keeps the behavior testable). Redirects are rejected
// even when a caller supplies redirect: follow.
export function resolveApiFetchTimeoutMs() {
  const raw = Number(process.env.AA_API_FETCH_TIMEOUT_MS || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_FETCH_TIMEOUT_MS;
}

export function apiFetch(resource, options = {}, overrides = {}) {
  return fetchWithTimeout(resource, { ...options, redirect: 'error' }, { timeoutMs: resolveApiFetchTimeoutMs(), ...overrides });
}
