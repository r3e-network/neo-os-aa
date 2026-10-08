import {
  encodeBase64Url, decodeBase64Url, importOperatorPublicKey,
  signOperatorMutationPayload, verifyOperatorMutationSignature,
} from '../../../api/operatorMutationHelpers.js';

const DATABASE = 'aa_operator_keys';
const OBJECT_STORE = 'keys';
const LEGACY_PREFIX = 'aa_operator_session_v1';
const BACKUP_FORMAT = 'neo-aa-operator-backup';
const BACKUP_ITERATIONS = 600_000;
const MAX_BACKUP_BYTES = 16_384;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const localLocks = new Map();

function error(code) { return new Error(code); }

function assertDraft(shareSlug) {
  if (typeof shareSlug !== 'string' || !shareSlug || shareSlug.length > 256) throw error('EC_operator_backup_wrong_draft');
}

function decodeExact(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw error('EC_operator_backup_invalid');
  const bytes = decodeBase64Url(value);
  if ((length && bytes.length !== length) || encodeBase64Url(bytes) !== value) throw error('EC_operator_backup_invalid');
  return bytes;
}

function additionalData(shareSlug, format = BACKUP_FORMAT, version = 1) {
  return encoder.encode(JSON.stringify({ format, version, shareSlug }));
}

async function validateMaterial(material) {
  const { privateJwk, publicJwk } = material || {};
  const publicFields = new Set(['kty', 'crv', 'x', 'y', 'ext', 'key_ops']);
  if (!privateJwk || !publicJwk || Object.keys(publicJwk).some((key) => !publicFields.has(key))
    || Object.keys(privateJwk).some((key) => !publicFields.has(key) && key !== 'd')) throw error('EC_operator_backup_invalid');
  for (const jwk of [privateJwk, publicJwk]) {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw error('EC_operator_backup_invalid');
    decodeExact(jwk.x, 32); decodeExact(jwk.y, 32);
  }
  decodeExact(privateJwk.d, 32);
  if (privateJwk.x !== publicJwk.x || privateJwk.y !== publicJwk.y) throw error('EC_operator_backup_invalid');
  const privateKey = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const publicKey = await importOperatorPublicKey(publicJwk);
  const challenge = 'neo-aa-operator-key-consistency-v1';
  if (!await verifyOperatorMutationSignature(challenge, await signOperatorMutationPayload(challenge, privateKey), publicKey)) throw error('EC_operator_backup_invalid');
  return { privateJwk, publicJwk, privateKey };
}

/** IndexedDB preserves non-extractable CryptoKeys through structured cloning. */
export function createIndexedDbOperatorKeyStore({ indexedDB = globalThis.indexedDB } = {}) {
  async function transact(mode, action) {
    if (!indexedDB) throw error('EC_operator_key_storage_unavailable');
    let db;
    try {
      db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(OBJECT_STORE);
        request.onerror = () => reject(error('EC_operator_key_storage_unavailable'));
        request.onblocked = () => reject(error('EC_operator_key_storage_unavailable'));
        request.onsuccess = () => resolve(request.result);
      });
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(OBJECT_STORE, mode);
        let result;
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = transaction.onabort = () => reject(error('EC_operator_key_storage_unavailable'));
        action(transaction.objectStore(OBJECT_STORE), (value) => { result = value; });
      });
    } catch { throw error('EC_operator_key_storage_unavailable'); }
    finally { db?.close(); }
  }
  return {
    read(id) {
      return transact('readonly', (store, finish) => {
        store.get(id).onsuccess = (event) => finish(event.target.result || null);
      });
    },
    write(id, record, { ifAbsent = false } = {}) {
      return transact('readwrite', (store, finish) => {
        const put = () => { store.put(record, id).onsuccess = () => finish(record); };
        if (!ifAbsent) return put();
        store.get(id).onsuccess = (event) => {
          if (event.target.result) finish(event.target.result);
          else put();
        };
      });
    },
  };
}

async function sealMaterial(shareSlug, material) {
  const validated = await validateMaterial(material);
  const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(shareSlug, DATABASE, 2) }, wrappingKey,
    encoder.encode(JSON.stringify(validated.privateJwk)),
  );
  return { version: 2, shareSlug, publicJwk: validated.publicJwk, wrappingKey, iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(ciphertext) };
}

async function openMaterial(shareSlug, record) {
  try {
    if (record.version !== 2 || record.shareSlug !== shareSlug || record.wrappingKey?.extractable !== false) throw error('invalid');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decodeExact(record.iv, 12), additionalData: additionalData(shareSlug, DATABASE, 2) },
      record.wrappingKey, decodeExact(record.ciphertext),
    );
    return await validateMaterial({ privateJwk: JSON.parse(decoder.decode(plaintext)), publicJwk: record.publicJwk });
  } catch { throw error('EC_operator_key_storage_corrupt'); }
}

function legacyBackend(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.sessionStorage || null; } catch { return null; }
}

export function createOperatorKeyVault({ store = createIndexedDbOperatorKeyStore(), legacyStorage } = {}) {
  async function readLegacy(shareSlug) {
    assertDraft(shareSlug);
    let raw;
    try { raw = legacyBackend(legacyStorage)?.getItem(`${LEGACY_PREFIX}:${shareSlug}`); }
    catch { throw error('EC_operator_key_storage_unavailable'); }
    if (!raw) return null;
    try { return await validateMaterial(JSON.parse(raw)); }
    catch { throw error('EC_operator_key_storage_corrupt'); }
  }
  function removeLegacy(shareSlug) {
    try { legacyBackend(legacyStorage)?.removeItem(`${LEGACY_PREFIX}:${shareSlug}`); }
    catch { throw error('EC_operator_key_storage_unavailable'); }
  }
  async function read(shareSlug) {
    try { return await store.read(shareSlug); } catch { throw error('EC_operator_key_storage_unavailable'); }
  }
  async function write(shareSlug, record, options) {
    try {
      await store.write(shareSlug, record, options);
      const persisted = await store.read(shareSlug);
      if (!persisted) throw error('missing');
      return persisted;
    } catch { throw error('EC_operator_key_storage_unavailable'); }
  }
  return {
    readLegacy,
    removeLegacy,
    async getOrCreate(shareSlug) {
      assertDraft(shareSlug);
      const existing = await read(shareSlug);
      if (existing) return openMaterial(shareSlug, existing);
      const legacy = await readLegacy(shareSlug);
      let material = legacy;
      if (!material) {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        material = { privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey), publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) };
      }
      const persisted = await write(shareSlug, await sealMaterial(shareSlug, material), { ifAbsent: true });
      const result = await openMaterial(shareSlug, persisted);
      if (legacy) {
        // Delete the legacy plaintext only when the same key has survived readback.
        if (result.publicJwk.x !== material.publicJwk.x || result.publicJwk.y !== material.publicJwk.y) throw error('EC_operator_key_storage_corrupt');
        removeLegacy(shareSlug);
      }
      return result;
    },
    async save(shareSlug, material) {
      assertDraft(shareSlug);
      const persisted = await write(shareSlug, await sealMaterial(shareSlug, material));
      return openMaterial(shareSlug, persisted);
    },
  };
}

export function assertOperatorBackupPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) throw error('EC_operator_backup_password_weak');
}

async function passwordKey(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: BACKUP_ITERATIONS, salt }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function encryptOperatorBackup(shareSlug, material, passphrase) {
  assertDraft(shareSlug); assertOperatorBackupPassphrase(passphrase);
  const { privateJwk, publicJwk } = await validateMaterial(material);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(shareSlug) }, await passwordKey(passphrase, salt),
    encoder.encode(JSON.stringify({ shareSlug, privateJwk, publicJwk })),
  );
  return JSON.stringify({
    format: BACKUP_FORMAT, version: 1, shareSlug, kdf: 'PBKDF2-SHA256', iterations: BACKUP_ITERATIONS,
    cipher: 'AES-256-GCM', salt: encodeBase64Url(salt), iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(ciphertext),
  });
}

export async function decryptOperatorBackup(backup, passphrase, shareSlug) {
  assertDraft(shareSlug);
  let envelope;
  try {
    if (typeof backup !== 'string' || encoder.encode(backup).length > MAX_BACKUP_BYTES
      || typeof passphrase !== 'string' || passphrase.length > 1024) throw error('invalid');
    envelope = JSON.parse(backup);
    if (envelope?.format !== BACKUP_FORMAT || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA256'
      || envelope.iterations !== BACKUP_ITERATIONS || envelope.cipher !== 'AES-256-GCM') throw error('invalid');
  } catch { throw error('EC_operator_backup_invalid'); }
  if (envelope.shareSlug !== shareSlug) throw error('EC_operator_backup_wrong_draft');
  try {
    const salt = decodeExact(envelope.salt, 16); const iv = decodeExact(envelope.iv, 12);
    const ciphertext = decodeExact(envelope.ciphertext);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(shareSlug) }, await passwordKey(passphrase, salt), ciphertext,
    );
    const material = JSON.parse(decoder.decode(plaintext));
    if (material.shareSlug !== shareSlug) throw error('invalid');
    return await validateMaterial(material);
  } catch { throw error('EC_operator_backup_invalid'); }
}

/** Serialize one draft in this tab and, when available, across browser tabs. */
export async function withOperatorKeyLock(shareSlug, operation) {
  if (globalThis.navigator?.locks?.request) return globalThis.navigator.locks.request(`aa-operator:${shareSlug}`, operation);
  const previous = localLocks.get(shareSlug) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  localLocks.set(shareSlug, current);
  try { return await current; } finally { if (localLocks.get(shareSlug) === current) localLocks.delete(shareSlug); }
}
