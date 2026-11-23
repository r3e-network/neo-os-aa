// GENERATED from neo-os-services/packages/shared/src/confidential-envelope.js.
// Source sha256: 6071fcbe03f66281c9504a200a2505e12896c69ca2df305bb81c3ac91bf8ab5d. Re-run scripts/sync_morpheus_registry.mjs after a reviewed canonical change.
// Do not edit manually; import this module through morpheusEncryption.js.

/**
 * Canonical Morpheus confidential-payload envelope (v2).
 *
 * This is the canonical client-side encoder for the
 * X25519-HKDF-SHA256-AES-256-GCM envelope. The measured-runtime decryptor is
 * `crates/morpheus-compute/src/oracle/crypto.rs`; the JavaScript worker
 * decryptor is a compatibility/parity implementation. The wire format MUST
 * NOT change without a coordinated key/format rotation.
 * `confidential-envelope.test.mjs` and the Rust golden vectors pin both sides.
 *
 * Wire format (all base64 of the JSON envelope, itself base64 again):
 *   { v: 2, alg: 'X25519-HKDF-SHA256-AES-256-GCM',
 *     epk: base64(ephemeral X25519 public key, 32 raw bytes),
 *     iv:  base64(12-byte AES-GCM IV),
 *     ct:  base64(ciphertext without tag),
 *     tag: base64(16-byte AES-GCM tag) }
 *
 * Key derivation (MUST match the worker exactly):
 *   sharedSecret = X25519(ephemeralPrivate, recipientPublic)   // 32 bytes
 *   aesKey = HKDF-SHA256(ikm=sharedSecret,
 *                        salt=recipientPublicRaw,
 *                        info=utf8(CONFIDENTIAL_ENVELOPE_INFO) ||
 *                             ephemeralPublicRaw || recipientPublicRaw,
 *                        length=256 bits)
 *
 * Known downstream copies that vendor this wire format and must stay
 * byte-compatible with the golden vector in confidential-envelope.test.mjs:
 * - neo-os-devpack/shared/utils/morpheus-confidential-envelope.ts
 * - neo-abstract-account/frontend/src/utils/morpheusEncryption.js
 * - apps/web/lib/browser-encryption.ts, examples/* in this repo
 *
 * The module is environment-agnostic (Node >= 22 or a browser with
 * WebCrypto X25519 support) and dependency-free so it can be vendored
 * verbatim where a workspace import is not possible.
 */

export const CONFIDENTIAL_ENVELOPE_VERSION = 2;
export const CONFIDENTIAL_ENVELOPE_ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM';
export const CONFIDENTIAL_ENVELOPE_INFO = 'morpheus-confidential-payload-v2';
export const X25519_PUBLIC_KEY_LENGTH_BYTES = 32;
export const AES_GCM_IV_LENGTH_BYTES = 12;
export const AES_GCM_TAG_LENGTH_BYTES = 16;

function getSubtle() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto subtle API is required for confidential envelopes');
  }
  return subtle;
}

function getRandomValues(bytes) {
  const cryptoImpl = globalThis.crypto;
  if (typeof cryptoImpl?.getRandomValues !== 'function') {
    throw new Error('WebCrypto getRandomValues is required for confidential envelopes');
  }
  return cryptoImpl.getRandomValues(bytes);
}

function trimString(value) {
  return String(value || '').trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Base64 decode tolerant of base64url alphabets and missing padding,
 * mirroring `decodeBase64` in workers/nitro-worker/src/platform/core.js.
 */
export function decodeBase64(value) {
  const normalized = trimString(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }
  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeBase64(bytesLike) {
  const bytes = bytesLike instanceof Uint8Array ? bytesLike : new Uint8Array(bytesLike);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return globalThis.btoa(binary);
}

function toBytes(value, label) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string' && trimString(value)) return decodeBase64(value);
  throw new Error(`${label} must be a Uint8Array or base64 string`);
}

function toArrayBuffer(bytes) {
  return Uint8Array.from(bytes).buffer;
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

/**
 * Parses a base64 envelope string into its JSON form. Returns null for
 * anything that is not a well-formed v2 envelope (the worker treats such
 * payloads as unsupported and fails closed).
 */
export function parseConfidentialEnvelope(ciphertext) {
  try {
    const decoded = new TextDecoder().decode(decodeBase64(ciphertext));
    const parsed = JSON.parse(decoded);
    if (!isPlainObject(parsed)) return null;
    if (Number(parsed.v ?? parsed.version) !== CONFIDENTIAL_ENVELOPE_VERSION) return null;
    if (trimString(parsed.alg ?? parsed.algorithm) !== CONFIDENTIAL_ENVELOPE_ALGORITHM) {
      return null;
    }
    if (
      !trimString(parsed.epk) ||
      !trimString(parsed.iv) ||
      !trimString(parsed.ct) ||
      !trimString(parsed.tag)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function deriveEnvelopeAesKey(
  sharedSecretBytes,
  senderPublicKeyBytes,
  recipientPublicKeyBytes,
  usage
) {
  const subtle = getSubtle();
  const keyMaterial = await subtle.importKey(
    'raw',
    toArrayBuffer(sharedSecretBytes),
    'HKDF',
    false,
    ['deriveKey']
  );
  const info = concatBytes(
    new TextEncoder().encode(CONFIDENTIAL_ENVELOPE_INFO),
    senderPublicKeyBytes,
    recipientPublicKeyBytes
  );
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(recipientPublicKeyBytes),
      info: toArrayBuffer(info),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

/**
 * Encrypts a UTF-8 plaintext for the oracle's raw X25519 public key.
 * Returns the base64 envelope string accepted by the worker decryptor.
 */
export async function encryptConfidentialEnvelope(recipientPublicKey, plaintext) {
  const subtle = getSubtle();
  const recipientPublicKeyBytes = toBytes(recipientPublicKey, 'recipient public key');
  if (recipientPublicKeyBytes.length !== X25519_PUBLIC_KEY_LENGTH_BYTES) {
    throw new Error('recipient public key must be a 32-byte raw X25519 key');
  }

  const recipientKey = await subtle.importKey(
    'raw',
    toArrayBuffer(recipientPublicKeyBytes),
    { name: 'X25519' },
    false,
    []
  );
  const ephemeralKeyPair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const ephemeralPublicKeyBytes = new Uint8Array(
    await subtle.exportKey('raw', ephemeralKeyPair.publicKey)
  );
  const sharedSecretBytes = new Uint8Array(
    await subtle.deriveBits(
      { name: 'X25519', public: recipientKey },
      ephemeralKeyPair.privateKey,
      256
    )
  );
  const aesKey = await deriveEnvelopeAesKey(
    sharedSecretBytes,
    ephemeralPublicKeyBytes,
    recipientPublicKeyBytes,
    'encrypt'
  );
  const iv = getRandomValues(new Uint8Array(AES_GCM_IV_LENGTH_BYTES));
  const encryptedBytes = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(plaintext))
  );
  const ciphertextBytes = encryptedBytes.slice(0, encryptedBytes.length - AES_GCM_TAG_LENGTH_BYTES);
  const tagBytes = encryptedBytes.slice(encryptedBytes.length - AES_GCM_TAG_LENGTH_BYTES);

  return encodeBase64(
    new TextEncoder().encode(
      JSON.stringify({
        v: CONFIDENTIAL_ENVELOPE_VERSION,
        alg: CONFIDENTIAL_ENVELOPE_ALGORITHM,
        epk: encodeBase64(ephemeralPublicKeyBytes),
        iv: encodeBase64(iv),
        ct: encodeBase64(ciphertextBytes),
        tag: encodeBase64(tagBytes),
      })
    )
  );
}

/**
 * Decrypts a base64 envelope string with the recipient key material.
 * Accepts base64 strings or Uint8Array for both key fields, plus the
 * worker's `privateKeyPkcs8Bytes`/`publicKeyRawBytes` field names so the
 * worker key-material object can be passed through unchanged.
 */
export async function decryptConfidentialEnvelope(ciphertext, keyMaterial = {}) {
  const envelope = parseConfidentialEnvelope(ciphertext);
  if (!envelope) {
    throw new Error(
      `unsupported confidential payload format; expected ${CONFIDENTIAL_ENVELOPE_ALGORITHM}`
    );
  }

  const privateKeyPkcs8Bytes = toBytes(
    keyMaterial.privateKeyPkcs8Bytes ?? keyMaterial.privateKeyPkcs8,
    'recipient private key (PKCS#8)'
  );
  const recipientPublicKeyBytes = toBytes(
    keyMaterial.publicKeyRawBytes ?? keyMaterial.publicKeyRaw,
    'recipient public key'
  );

  const senderPublicKeyBytes = decodeBase64(envelope.epk);
  if (senderPublicKeyBytes.length !== X25519_PUBLIC_KEY_LENGTH_BYTES) {
    throw new Error('invalid X25519 envelope public key length');
  }
  const iv = decodeBase64(envelope.iv);
  if (iv.length !== AES_GCM_IV_LENGTH_BYTES) {
    throw new Error('invalid X25519 envelope iv length');
  }
  const tag = decodeBase64(envelope.tag);
  if (tag.length !== AES_GCM_TAG_LENGTH_BYTES) {
    throw new Error('invalid X25519 envelope tag length');
  }

  const subtle = getSubtle();
  const [privateKey, senderPublicKey] = await Promise.all([
    subtle.importKey('pkcs8', toArrayBuffer(privateKeyPkcs8Bytes), { name: 'X25519' }, false, [
      'deriveBits',
    ]),
    subtle.importKey('raw', toArrayBuffer(senderPublicKeyBytes), { name: 'X25519' }, false, []),
  ]);
  const sharedSecretBytes = new Uint8Array(
    await subtle.deriveBits({ name: 'X25519', public: senderPublicKey }, privateKey, 256)
  );
  const aesKey = await deriveEnvelopeAesKey(
    sharedSecretBytes,
    senderPublicKeyBytes,
    recipientPublicKeyBytes,
    'decrypt'
  );
  const plaintextBytes = await subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: AES_GCM_TAG_LENGTH_BYTES * 8 },
    aesKey,
    toArrayBuffer(concatBytes(decodeBase64(envelope.ct), tag))
  );
  return new TextDecoder().decode(plaintextBytes);
}

/**
 * Generates fresh recipient key material (raw public key + PKCS#8 private
 * key, both as bytes and base64) for tooling and tests.
 */
export async function generateConfidentialKeyMaterial() {
  const subtle = getSubtle();
  const keyPair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const publicKeyRawBytes = new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey));
  const privateKeyPkcs8Bytes = new Uint8Array(await subtle.exportKey('pkcs8', keyPair.privateKey));
  return {
    algorithm: CONFIDENTIAL_ENVELOPE_ALGORITHM,
    publicKeyRawBytes,
    privateKeyPkcs8Bytes,
    publicKeyRaw: encodeBase64(publicKeyRawBytes),
    privateKeyPkcs8: encodeBase64(privateKeyPkcs8Bytes),
  };
}
