function hash160Bytes(value) {
  const hex = String(value || '').trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error('A 20-byte hash160 is required');
  return Uint8Array.from(hex.match(/../g), (byte) => Number.parseInt(byte, 16));
}

export async function buildAaActionId({ network = 'neo_n3', aaContract, accountIdRaw, executor, sessionNonce = 0, expiresAt } = {}) {
  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(String(network || 'neo_n3').trim() || 'neo_n3'),
    hash160Bytes(aaContract),
    hash160Bytes(accountIdRaw),
    hash160Bytes(executor),
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
  return `aa_proxy:${hex}`;
}
