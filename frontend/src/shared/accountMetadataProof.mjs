// F-10 (re-verified from code): the account-metadata upsert control proof must
// be bound to one exact, canonical challenge. Previously the server accepted
// any backup-owner signature over any message that merely CONTAINED the
// account hash, so a signature produced for another context (a login
// challenge, a payment request) could be replayed to overwrite metadata.
// Both the client and the API route derive the challenge from this module so
// the two sides can never drift apart.

export const ACCOUNT_METADATA_CONTROL_PREFIX = 'sa-metadata-control';

function normalizeAccountIdHash(value) {
  return String(value || '').trim().replace(/^0x/i, '').toLowerCase();
}

/**
 * The one canonical message a backup owner signs to prove control of an
 * account's off-chain metadata. Returns '' for anything that is not a
 * 20-byte hex account hash so callers fail closed on malformed input.
 */
export function buildAccountMetadataControlChallenge(accountIdHash) {
  const normalized = normalizeAccountIdHash(accountIdHash);
  if (!/^[0-9a-f]{40}$/.test(normalized)) return '';
  return `${ACCOUNT_METADATA_CONTROL_PREFIX}:${normalized}`;
}

/**
 * Exact-match check for the canonical challenge. A message that merely
 * contains the account hash (superset text, prefixed/suffixed challenge)
 * must NOT authorize an upsert.
 */
export function isAccountMetadataControlChallenge(message, accountIdHash) {
  const expected = buildAccountMetadataControlChallenge(accountIdHash);
  if (!expected) return false;
  return String(message || '').trim() === expected;
}
