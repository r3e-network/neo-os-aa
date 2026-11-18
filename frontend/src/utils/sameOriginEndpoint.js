// F-15 (re-verified from code): the client's credential-carrying API calls —
// relay broadcast (a fully-signed transaction), DID verification and DID
// notifications (the Web3Auth idToken bearer credential) — accepted arbitrary
// absolute endpoints, so a misconfigured or attacker-influenced endpoint could
// ship those credentials to a third-party origin. These calls must stay on the
// app's own origin: relative same-origin paths, or absolute URLs that provably
// match the running origin. Everything else fails closed BEFORE any fetch.

/**
 * Resolve whether an API endpoint is same-origin for this runtime.
 * Returns { ok: true, value } or { ok: false, reason }.
 *
 * - '' / blank                       -> refused (empty)
 * - '//host/...' (protocol-relative) -> refused (cross-origin in disguise)
 * - '/path...' (root-relative)       -> allowed (same-origin by construction)
 * - absolute http(s) URL             -> allowed only when its origin equals the
 *                                      runtime origin (window.location). With no
 *                                      runtime origin available (Node), an
 *                                      absolute URL can never be proven
 *                                      same-origin and is refused (fail closed).
 * - every other scheme/shape         -> refused
 */
export function resolveSameOriginApiEndpoint(endpoint, { location = globalThis.location } = {}) {
  const value = String(endpoint ?? '').trim();
  if (!value) return { ok: false, reason: 'empty' };
  if (value.startsWith('//')) return { ok: false, reason: 'protocol_relative' };
  if (value.startsWith('/')) return { ok: true, value };

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'unsupported_protocol' };
  }

  const runtimeOrigin = String(location?.origin || '').trim();
  if (!runtimeOrigin) {
    // No runtime origin to compare against: an absolute URL cannot be proven
    // same-origin, so it is refused rather than trusted.
    return { ok: false, reason: 'origin_unavailable' };
  }
  if (parsed.origin !== runtimeOrigin) {
    return { ok: false, reason: 'cross_origin' };
  }
  return { ok: true, value };
}

/**
 * True only for a provably same-origin API endpoint. Convenience wrapper for
 * call sites that just need the verdict.
 */
export function isSameOriginApiEndpoint(endpoint, deps) {
  return resolveSameOriginApiEndpoint(endpoint, deps).ok;
}
