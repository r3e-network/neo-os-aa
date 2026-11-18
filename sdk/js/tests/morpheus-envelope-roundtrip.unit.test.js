/**
 * Drift guard for the vendored Morpheus confidential-envelope encryptor
 * (frontend/src/utils/morpheusEncryption.js).
 *
 * The canonical client implementation lives in neo-morpheus-oracle
 * packages/shared/src/confidential-envelope.js and the deployed decryptor in
 * workers/nitro-worker/src/oracle/crypto.js. This test encrypts with the
 * LOCAL frontend copy and decrypts with helpers vendored verbatim from the
 * worker decryptor semantics, with every envelope literal pinned
 * independently below — if the local copy ever drifts from the deployed
 * decryptor, encrypted payloads become undecryptable and this test fails.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Pinned to the deployed worker decryptor contract. Do NOT derive these from
// the implementation under test.
const PINNED_ENVELOPE_VERSION = 2;
const PINNED_ENVELOPE_ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM';
const PINNED_ENVELOPE_INFO = 'morpheus-confidential-payload-v2';
const PINNED_IV_LENGTH_BYTES = 12;
const PINNED_TAG_LENGTH_BYTES = 16;

// Golden vector shared with neo-morpheus-oracle
// packages/shared/src/confidential-envelope.test.mjs (test fixture keypair —
// never use outside tests). It was verified against the live worker
// decryptor when the canonical module was extracted.
const GOLDEN_PUBLIC_KEY_RAW = 'X+mfM9Lg+Tm9GBzniOC0vwDcZE857Za9AbdJCD7IsWM=';
const GOLDEN_PRIVATE_KEY_PKCS8 = 'MC4CAQAwBQYDK2VuBCIEIPBjP3AKvOssGMkua0kFSHbkLd7KkMfh1/8GqVrfajFy';
const GOLDEN_PLAINTEXT =
  '{"kind":"morpheus.confidential.golden.v1","message":"morpheus envelope golden vector","nonce":"0x0123456789abcdef"}';
const GOLDEN_ENVELOPE =
  'eyJ2IjoyLCJhbGciOiJYMjU1MTktSEtERi1TSEEyNTYtQUVTLTI1Ni1HQ00iLCJlcGsiOiJMcnU0NTdSOWNOVUNWNXlZNG85dit4TlVwVm4yNTdUcFJNVDAyUWhlTmhFPSIsIml2IjoiL1MvUTAvWG83MlAydmQ3ciIsImN0IjoiWjllbFNUc0ZNK2crbzYzMWtFdmFMMXkralFIZnh0MldseDdJSkNpYldoL2RYaTFVaFpOY0VzaEk3d1JEMEg3QTIvTWF4TEYyNDBQaGF1M3VUVlZDUWpMOGFtMU94aGFpODNzQTBwc3IyVkpROE1EYVpsZ3RxdjVjS3hlZTNzbmMyR2s0Mm4rZ2NIYVJyVkhnc21Md3U0NjhGZz09IiwidGFnIjoiWE14UDhuQll1MkxrMWF0bEFhNzduUT09In0=';

// The frontend copy targets browsers and references `window`; give it the
// Node globals (atob/btoa/crypto are all available on Node >= 22).
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

const morpheusEncryptionUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', '..', 'frontend', 'src', 'utils', 'morpheusEncryption.js')
).href;

function decodeBase64(value) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function encodeBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function parseEnvelope(envelopeBase64) {
  return JSON.parse(Buffer.from(envelopeBase64, 'base64').toString('utf8'));
}

function toArrayBuffer(bytes) {
  return Uint8Array.from(bytes).buffer;
}

// Vendored from the deployed worker decryptor
// (workers/nitro-worker/src/oracle/crypto.js deriveAesKey).
async function deriveAesKey(sharedSecretBytes, senderPublicKeyBytes, recipientPublicKeyBytes, usage) {
  const subtle = globalThis.crypto.subtle;
  const keyMaterial = await subtle.importKey('raw', toArrayBuffer(sharedSecretBytes), 'HKDF', false, [
    'deriveKey',
  ]);
  const info = new Uint8Array([
    ...new TextEncoder().encode(PINNED_ENVELOPE_INFO),
    ...senderPublicKeyBytes,
    ...recipientPublicKeyBytes,
  ]);
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

// Vendored from the deployed worker decryptor
// (workers/nitro-worker/src/oracle/crypto.js decryptX25519Envelope).
async function decryptX25519Envelope(envelopeBase64, keyMaterial) {
  const envelope = parseEnvelope(envelopeBase64);
  assert.equal(Number(envelope.v), PINNED_ENVELOPE_VERSION, 'unexpected envelope version');
  assert.equal(envelope.alg, PINNED_ENVELOPE_ALGORITHM, 'unexpected envelope algorithm');

  const senderPublicKeyBytes = decodeBase64(envelope.epk);
  assert.equal(senderPublicKeyBytes.length, 32, 'invalid X25519 envelope public key length');
  const iv = decodeBase64(envelope.iv);
  assert.equal(iv.length, PINNED_IV_LENGTH_BYTES, 'invalid X25519 envelope iv length');
  const tag = decodeBase64(envelope.tag);
  assert.equal(tag.length, PINNED_TAG_LENGTH_BYTES, 'invalid X25519 envelope tag length');

  const subtle = globalThis.crypto.subtle;
  const [privateKey, senderPublicKey] = await Promise.all([
    subtle.importKey('pkcs8', toArrayBuffer(keyMaterial.privateKeyPkcs8Bytes), { name: 'X25519' }, false, [
      'deriveBits',
    ]),
    subtle.importKey('raw', toArrayBuffer(senderPublicKeyBytes), { name: 'X25519' }, false, []),
  ]);
  const sharedSecretBytes = new Uint8Array(
    await subtle.deriveBits({ name: 'X25519', public: senderPublicKey }, privateKey, 256)
  );
  const aesKey = await deriveAesKey(
    sharedSecretBytes,
    senderPublicKeyBytes,
    keyMaterial.publicKeyRawBytes,
    'decrypt'
  );
  const ciphertextBytes = decodeBase64(envelope.ct);
  const combined = new Uint8Array(ciphertextBytes.length + tag.length);
  combined.set(ciphertextBytes, 0);
  combined.set(tag, ciphertextBytes.length);
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: PINNED_TAG_LENGTH_BYTES * 8 },
    aesKey,
    toArrayBuffer(combined)
  );
  return Buffer.from(plaintext).toString('utf8');
}

async function generateRecipientKeyMaterial() {
  const subtle = globalThis.crypto.subtle;
  const keyPair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  return {
    publicKeyRawBytes: new Uint8Array(await subtle.exportKey('raw', keyPair.publicKey)),
    privateKeyPkcs8Bytes: new Uint8Array(await subtle.exportKey('pkcs8', keyPair.privateKey)),
  };
}

test('golden vector decrypts with the vendored worker decryptor', async () => {
  const plaintext = await decryptX25519Envelope(GOLDEN_ENVELOPE, {
    privateKeyPkcs8Bytes: decodeBase64(GOLDEN_PRIVATE_KEY_PKCS8),
    publicKeyRawBytes: decodeBase64(GOLDEN_PUBLIC_KEY_RAW),
  });
  assert.equal(plaintext, GOLDEN_PLAINTEXT);
});

test('frontend encryptor output carries the pinned envelope literals', async () => {
  const { encryptJsonWithMorpheusOracleKey } = await import(morpheusEncryptionUrl);
  const recipient = await generateRecipientKeyMaterial();
  const envelopeBase64 = await encryptJsonWithMorpheusOracleKey(
    encodeBase64(recipient.publicKeyRawBytes),
    JSON.stringify({ probe: 'literal-pins' })
  );
  const envelope = parseEnvelope(envelopeBase64);
  assert.equal(envelope.v, PINNED_ENVELOPE_VERSION);
  assert.equal(envelope.alg, PINNED_ENVELOPE_ALGORITHM);
  assert.equal(decodeBase64(envelope.epk).length, 32);
  assert.equal(decodeBase64(envelope.iv).length, PINNED_IV_LENGTH_BYTES);
  assert.equal(decodeBase64(envelope.tag).length, PINNED_TAG_LENGTH_BYTES);
});

test('frontend encryptor roundtrips through the vendored worker decryptor', async () => {
  const { encryptJsonWithMorpheusOracleKey } = await import(morpheusEncryptionUrl);
  const recipient = await generateRecipientKeyMaterial();
  const payload = {
    provider_uid: 'github_uid_777',
    account_id: 'sa-social-recovery-demo',
    recovery_nonce: '7',
  };
  const envelopeBase64 = await encryptJsonWithMorpheusOracleKey(
    encodeBase64(recipient.publicKeyRawBytes),
    JSON.stringify(payload)
  );
  const plaintext = await decryptX25519Envelope(envelopeBase64, recipient);
  assert.deepEqual(JSON.parse(plaintext), payload);
});

test('frontend encryptor rejects non-object payloads', async () => {
  const { encryptJsonWithMorpheusOracleKey } = await import(morpheusEncryptionUrl);
  const recipient = await generateRecipientKeyMaterial();
  await assert.rejects(
    encryptJsonWithMorpheusOracleKey(encodeBase64(recipient.publicKeyRawBytes), JSON.stringify([1, 2]))
  );
});

test('tampered auth tag fails closed', async () => {
  const { encryptJsonWithMorpheusOracleKey } = await import(morpheusEncryptionUrl);
  const recipient = await generateRecipientKeyMaterial();
  const envelopeBase64 = await encryptJsonWithMorpheusOracleKey(
    encodeBase64(recipient.publicKeyRawBytes),
    JSON.stringify({ probe: 'tamper' })
  );
  const envelope = parseEnvelope(envelopeBase64);
  const tagBytes = decodeBase64(envelope.tag);
  tagBytes[0] ^= 0xff;
  envelope.tag = encodeBase64(tagBytes);
  const tampered = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
  await assert.rejects(decryptX25519Envelope(tampered, recipient));
});
