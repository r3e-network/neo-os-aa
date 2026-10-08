const textEncoder = new TextEncoder();

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    return Object.keys(value)
      .sort()
      .reduce((accumulator, key) => {
        accumulator[key] = sortValue(value[key]);
        return accumulator;
      }, {});
  }
  return value;
}

export function canonicalizeOperatorMutationPayload(payload = {}) {
  return JSON.stringify(sortValue(payload));
}

function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(value, 'base64'));
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function encodeBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeBase64Url(value = '') {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return fromBase64(`${normalized}${padding}`);
}

export async function importOperatorPrivateKey(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
}

export async function importOperatorPublicKey(jwk) {
  if (!jwk || Object.prototype.hasOwnProperty.call(jwk, 'd')) {
    throw new Error('invalid_operator_public_key');
  }
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
}

// PostgreSQL JSONB may reorder object properties. Compare the actual P-256 key,
// never the serialization order or optional JWK metadata.
export function operatorPublicKeysMatch(left, right) {
  return [left, right].every((key) => key && key.kty === 'EC' && key.crv === 'P-256'
    && !Object.prototype.hasOwnProperty.call(key, 'd')
    && typeof key.x === 'string' && typeof key.y === 'string')
    && left.x === right.x && left.y === right.y;
}

export async function signOperatorMutationPayload(payload, privateKey) {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    textEncoder.encode(String(payload || '')),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

export async function verifyOperatorMutationSignature(payload, signature, publicKey) {
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    decodeBase64Url(signature),
    textEncoder.encode(String(payload || '')),
  );
}
