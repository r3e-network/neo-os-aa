const MAX_SA_SIGNING_TEXT_BYTES = 255;

export function requireSaSigningText(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
  if (new TextEncoder().encode(value).length > MAX_SA_SIGNING_TEXT_BYTES) {
    throw new Error(`${fieldName} must be at most ${MAX_SA_SIGNING_TEXT_BYTES} UTF-8 bytes`);
  }
  // Stored identity text is opaque signing material; validation must not normalize it.
  return value;
}

function hash160Bytes(value) {
  const hex = String(value || '').trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error('A 20-byte hash160 is required');
  return Uint8Array.from(hex.match(/../g), (byte) => Number.parseInt(byte, 16));
}

export function toNeoInternalHex(value) {
  const hex = String(value || '').trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error('A 20-byte hash160 is required');
  return `0x${hex.match(/../g).reverse().join('')}`;
}

export async function buildSaActionId({ network = 'neo_n3', saContractInternal, accountIdRawInternal, executorInternal, sessionNonce = 0, expiresAt } = {}) {
  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(requireSaSigningText(network, 'network')),
    hash160Bytes(saContractInternal),
    hash160Bytes(accountIdRawInternal),
    hash160Bytes(executorInternal),
    encoder.encode(String(sessionNonce ?? '0')),
    encoder.encode(String(expiresAt)),
  ];
  const material = new Uint8Array(parts.reduce((size, part) => size + part.length + 1, -1));
  let offset = 0;
  parts.forEach((part, index) => {
    if (index > 0) material[offset++] = 0x1f;
    material.set(part, offset);
    offset += part.length;
  });
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is required');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', material);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  // AA→SA wave-2 protocol switch: the action-id prefix moved from `aa_proxy:`;
  // old-domain tickets are cutoff-invalid at this switch (no dual-prefix checks).
  return `sa_proxy:${hex}`;
}
