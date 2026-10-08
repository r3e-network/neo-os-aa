import { sanitizeHex } from '../../utils/hex.js';
import { cloneImmutable } from './helpers.js';

export function normalizeSignatureEntry(input = {}) {
  return {
    signerId: String(input.signerId || '').trim(),
    kind: String(input.kind || '').trim() || 'neo',
    signatureHex: sanitizeHex(input.signatureHex || ''),
    publicKey: sanitizeHex(input.publicKey || ''),
    txHash: sanitizeHex(input.txHash || ''),
    payloadDigest: sanitizeHex(input.payloadDigest || ''),
    metadata: cloneImmutable(input.metadata || null),
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

export function appendSignatureEntries(entries = [], signature) {
  const next = normalizeSignatureEntry(signature);
  const existing = Array.isArray(entries) ? entries.map((item) => cloneImmutable(item)) : [];
  const duplicate = existing.some((item) => item.signerId === next.signerId && item.kind === next.kind);
  return duplicate ? existing : [...existing, next];
}

export function summarizeSignerProgress(requirements = [], signatures = []) {
  // This roster is collaboration metadata, not the verifier's on-chain policy.
  const key = (kind, id) => {
    const value = String(id || '').trim();
    return `${String(kind || '').trim()}:${kind === 'evm' && /^(0x)?[0-9a-f]{40}$/i.test(value) ? sanitizeHex(value) : value}`;
  };
  const uniqueRequirements = [...new Map(requirements.map((item) => [key(item.kind, item.id), item])).values()];
  const signatureKeys = new Set(signatures.filter((item) => item.signatureHex || item.metadata?.metaInvocation)
    .map((item) => key(item.kind, item.signerId)));
  const satisfied = uniqueRequirements.filter((item) => signatureKeys.has(key(item.kind, item.id)));
  const pending = uniqueRequirements.filter((item) => !signatureKeys.has(key(item.kind, item.id)));
  return {
    requiredCount: uniqueRequirements.length,
    signatureCount: satisfied.length,
    recordCount: signatures.length,
    satisfied,
    pending,
    isComplete: pending.length === 0 && uniqueRequirements.length > 0,
    chainQuorumVerified: false,
  };
}

export function buildTransactionDraftExport({ account, operationBody, transactionBody, signerRequirements, signatures, share, broadcast } = {}) {
  return cloneImmutable({
    account,
    operationBody,
    transactionBody,
    signerRequirements,
    signatures,
    share,
    broadcast,
  });
}
