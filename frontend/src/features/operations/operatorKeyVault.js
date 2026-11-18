import {
  encodeBase64Url, decodeBase64Url, importOperatorPublicKey,
  signOperatorMutationPayload, verifyOperatorMutationSignature,
} from '../../../api/operatorMutationHelpers.js';

// AA→SA wave-2 protocol switch: the vault moved to SA-named storage identities.
// The database name doubles as the record AES-GCM AAD format tag; the backup
// envelope format doubles as the backup AAD. Old-domain secrets are
// cutoff-invalid at this switch: the one-time migration below re-seals what it
// can read, everything else fails closed without touching the legacy rows.
const DATABASE = 'sa_operator_keys';
// Pre-switch database (and its AES-GCM AAD tag) — migration source only.
const LEGACY_DATABASE = 'aa_operator_keys';
const OBJECT_STORE = 'keys';
const LEGACY_PREFIX = 'sa_operator_session_v1';
const BACKUP_FORMAT = 'neo-sa-operator-backup';
// Pre-switch backup envelope format — accepted on import only.
const LEGACY_BACKUP_FORMAT = 'neo-aa-operator-backup';
const BACKUP_FORMATS = new Set([BACKUP_FORMAT, LEGACY_BACKUP_FORMAT]);
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
  const challenge = 'neo-sa-operator-key-consistency-v1';
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
  async function read(id) {
    return transact('readonly', (store, finish) => {
      store.get(id).onsuccess = (event) => finish(event.target.result || null);
    });
  }
  async function write(id, record, { ifAbsent = false } = {}) {
    return transact('readwrite', (store, finish) => {
      const put = () => { store.put(record, id).onsuccess = () => finish(record); };
      if (!ifAbsent) return put();
      store.get(id).onsuccess = (event) => {
        if (event.target.result) finish(event.target.result);
        else put();
      };
    });
  }

  function deleteLegacyDatabase() {
    return new Promise((resolve) => {
      // A blocked delete only means another tab still holds the legacy
      // database open; that tab re-runs the migration and deletes later.
      const request = indexedDB.deleteDatabase(LEGACY_DATABASE);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }

  function removeLegacyRecord(db, id) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(OBJECT_STORE, 'readwrite');
      transaction.objectStore(OBJECT_STORE).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(error('EC_operator_key_storage_unavailable'));
    });
  }

  /**
   * One-time AA→SA migration: opens the legacy `aa_operator_keys` database,
   * decrypts every record with the legacy AES-GCM AAD, re-seals each material
   * under the new `sa_operator_keys` database/AAD, and removes a legacy row
   * only after its re-sealed record survives a new-AAD readback. Fail-closed:
   * a record that cannot be decrypted (or whose key does not match an already
   * present new-domain record) stays untouched in the legacy database, and the
   * legacy database is dropped only when every row migrated.
   */
  async function migrate() {
    if (!indexedDB) throw error('EC_operator_key_storage_unavailable');
    const legacyDb = await new Promise((resolve, reject) => {
      const request = indexedDB.open(LEGACY_DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(OBJECT_STORE);
      request.onerror = request.onblocked = () => reject(error('EC_operator_key_storage_unavailable'));
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const entries = await new Promise((resolve, reject) => {
        const transaction = legacyDb.transaction(OBJECT_STORE, 'readonly');
        const store = transaction.objectStore(OBJECT_STORE);
        const keys = store.getAllKeys();
        const records = store.getAll();
        transaction.oncomplete = () => resolve(keys.result.map((id, index) => ({ id, record: records.result[index] })));
        transaction.onerror = transaction.onabort = () => reject(error('EC_operator_key_storage_unavailable'));
      });
      const migrated = [];
      const retained = [];
      for (const { id, record } of entries) {
        try {
          const material = await openMaterial(id, record, LEGACY_DATABASE);
          const persisted = await write(id, await sealMaterial(id, material), { ifAbsent: true });
          const sameKey = persisted?.publicJwk
            && persisted.publicJwk.x === material.publicJwk.x
            && persisted.publicJwk.y === material.publicJwk.y;
          if (!sameKey) { retained.push(id); continue; }
          // Delete the legacy row only after the re-sealed record opens under
          // the new AAD (proves the new database actually holds the key).
          await openMaterial(id, await read(id));
          migrated.push(id);
        } catch { retained.push(id); }
      }
      for (const id of migrated) await removeLegacyRecord(legacyDb, id);
      if (!entries.length || !retained.length) await deleteLegacyDatabase();
      return { migrated: migrated.length, retained: retained.length };
    } finally { legacyDb.close(); }
  }

  return { read, write, migrate };
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

async function openMaterial(shareSlug, record, database = DATABASE) {
  try {
    if (record.version !== 2 || record.shareSlug !== shareSlug || record.wrappingKey?.extractable !== false) throw error('invalid');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decodeExact(record.iv, 12), additionalData: additionalData(shareSlug, database, 2) },
      record.wrappingKey, decodeExact(record.ciphertext),
    );
    return await validateMaterial({ privateJwk: JSON.parse(decoder.decode(plaintext)), publicJwk: record.publicJwk });
  } catch { throw error('EC_operator_key_storage_corrupt'); }
}

function legacyBackend(storage) {
  if (storage !== undefined) return storage;
  try { return globalThis.sessionStorage || null; } catch { return null; }
}

const migratedStores = new WeakSet();

async function ensureMigrated(store) {
  if (typeof store?.migrate !== 'function' || migratedStores.has(store)) return;
  const run = () => store.migrate();
  // The one-time vault migration is serialized across browser tabs where the
  // Web Locks API is available; storage shims without migrate() skip it.
  await (globalThis.navigator?.locks?.request
    ? globalThis.navigator.locks.request('sa-operator-key-vault-migration', run)
    : run());
  migratedStores.add(store);
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
      await ensureMigrated(store);
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
      await ensureMigrated(store);
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
    // SA-switch import compatibility: pre-switch `neo-aa-operator-backup`
    // envelopes decrypt with their own legacy AAD; every export re-seals
    // under the new `neo-sa-operator-backup` format.
    if (!BACKUP_FORMATS.has(envelope?.format) || envelope.version !== 1 || envelope.kdf !== 'PBKDF2-SHA256'
      || envelope.iterations !== BACKUP_ITERATIONS || envelope.cipher !== 'AES-256-GCM') throw error('invalid');
  } catch { throw error('EC_operator_backup_invalid'); }
  if (envelope.shareSlug !== shareSlug) throw error('EC_operator_backup_wrong_draft');
  try {
    const salt = decodeExact(envelope.salt, 16); const iv = decodeExact(envelope.iv, 12);
    const ciphertext = decodeExact(envelope.ciphertext);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(shareSlug, envelope.format, 1) }, await passwordKey(passphrase, salt), ciphertext,
    );
    const material = JSON.parse(decoder.decode(plaintext));
    if (material.shareSlug !== shareSlug) throw error('invalid');
    return await validateMaterial(material);
  } catch { throw error('EC_operator_backup_invalid'); }
}

/** Serialize one draft in this tab and, when available, across browser tabs. */
export async function withOperatorKeyLock(shareSlug, operation) {
  if (globalThis.navigator?.locks?.request) return globalThis.navigator.locks.request(`sa-operator:${shareSlug}`, operation);
  const previous = localLocks.get(shareSlug) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  localLocks.set(shareSlug, current);
  try { return await current; } finally { if (localLocks.get(shareSlug) === current) localLocks.delete(shareSlug); }
}
