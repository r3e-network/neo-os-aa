import { EC } from '../config/errorCodes.js';

export const DEFAULT_FETCH_TIMEOUT_MS = 15000;

/**
 * fetch with an abort-based timeout so a stalled connection can never hang
 * the UI indefinitely. Redirects are always rejected before a second request.
 * Accepts an injectable fetchImpl for tests; when the caller supplies its own
 * AbortSignal it is honored instead of the timeout.
 */
export async function fetchWithTimeout(resource, options = {}, { fetchImpl, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(resource, { ...options, redirect: 'error', signal: options.signal || controller.signal });
  } catch (error) {
    if (!options.signal && controller.signal.aborted) {
      const err = new Error(EC.requestTimedOut);
      err.rpcDetail = `request exceeded ${timeoutMs}ms`;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
