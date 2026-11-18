/**
 * Shared RPC retry utility with configurable backoff.
 * Used across @r3e-network/neo-smart-account, neo-miniapps-platform, and neo-morpheus-oracle.
 */

const DEFAULT_CONFIG = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 15000,
};

// Single retryable-error classification for every retry layer in this SDK
// (withRetry and the RPC read wrapper in src/index.js). 'TLS connection was
// established' also covers Node's longer "socket disconnected before secure
// TLS connection was established" transport error.
const RETRYABLE_PATTERNS = [
  'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EADDRNOTAVAIL',
  'rate limit', 'too many requests', '502', '503', '504',
  'socket hang up', 'network', 'fetch failed',
  'TLS connection was established',
];

function isRetryableError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  return RETRYABLE_PATTERNS.some(p => msg.includes(p.toLowerCase()));
}

async function withRetry(label, fn, config = {}) {
  const opts = { ...DEFAULT_CONFIG, ...config };
  let lastError;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= opts.maxAttempts || !isRetryableError(err)) throw err;
      const delay = Math.min(opts.baseDelayMs * Math.pow(opts.backoffMultiplier, attempt - 1), opts.maxDelayMs);
      if (config.onRetry) config.onRetry(attempt, err, delay);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

module.exports = { withRetry, isRetryableError, DEFAULT_CONFIG, RETRYABLE_PATTERNS };
