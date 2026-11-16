/**
 * Shared session-key registration blob builder for the Neo N3 Abstract
 * Account stack.
 *
 * Single source of truth for the version-0x01 initial session-key blob that
 * SessionKeyVerifier.setPublicKey parses when the core delivers registration
 * verifier params — the same layout as
 * scripts/neoexpress_validate.py session_key_registration_blob. Passing this
 * blob as verifierParamsHex at registration installs the first session key
 * immediately (first installation into an empty slot is immediate by
 * protocol semantics; later changes still go through the verifier's own
 * cooldown and the core's timelocked configuration path).
 *
 * Blob layout (integers little-endian; UInt160 in its stored little-endian
 * form, i.e. reverseHex of the big-endian display hex):
 *
 *   [0] version 0x01 | [1] pubKeyLength + pubKey (33 or 65 bytes) |
 *   targetContract (20) | methodLength (1) + method |
 *   validUntil ms (8) | spendingLimit datoshi (8, 0 = unlimited) |
 *   descriptionLength (1) + description (0-128)
 *
 * Dependency-light by design: imports only the hex helpers from
 * shared/metaTxCore.mjs so browsers and Node consume it identically.
 *
 * Consumers:
 * - sdk/js/src/index.js (CJS; loads this ESM graph via require)
 * - frontend (ESM, reachable the same way as shared/metaTxCore.mjs)
 */

import { sanitizeHex, reverseHex } from './metaTxCore.mjs';

/** Blob format version consumed by SessionKeyVerifier.setPublicKey. */
export const SESSION_KEY_BLOB_VERSION = 0x01;

/** Contract-side description cap (SessionKeyVerifier: "Description too long (max 128 chars)"). */
export const MAX_SESSION_KEY_DESCRIPTION_BYTES = 128;

/** Contract-side session lifetime cap: 30 days in milliseconds. */
export const MAX_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const UINT64_MAX = (1n << 64n) - 1n;

function invalid(message) {
  const error = new Error(`session key blob: ${message}`);
  error.code = 'SESSION_KEY_BLOB_INVALID';
  return error;
}

function requireUint64(value, field) {
  let integer;
  try {
    integer = BigInt(value);
  } catch {
    throw invalid(`${field} must be an integer, got ${value}`);
  }
  if (integer < 0n || integer > UINT64_MAX) {
    throw invalid(`${field} must satisfy 0 <= value < 2^64, got ${value}`);
  }
  return integer;
}

function writeUint64LE(bytes, value) {
  let remaining = value;
  for (let i = 0; i < 8; i++) {
    bytes.push(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
}

/**
 * Builds the version-0x01 registration-time session key blob.
 *
 * @param {Object} options - Session key options
 * @param {string} options.publicKeyHex - secp256r1 public key, compressed
 *   (33 bytes, 02/03 prefix) or uncompressed (65 bytes, 04 prefix), hex
 * @param {string} options.targetContract - Target contract hash, big-endian
 *   display hex (40 hex chars, 0x prefix optional)
 * @param {string} options.method - Allowed target method ("*" wildcard is
 *   accepted by the contract but cannot carry a spending limit)
 * @param {string|number|bigint} options.validUntilMs - Expiry in Neo
 *   Runtime.Time milliseconds; the contract enforces future expiry and the
 *   30-day cap at installation time
 * @param {string|number|bigint} [options.spendingLimitDatoshi=0] - Total
 *   spending cap in datoshi; 0 means unlimited and is the only legal value
 *   for non-"transfer" methods (the limit is only enforceable on the
 *   value-moving transfer path)
 * @param {string} [options.description=''] - Human-readable label, at most
 *   128 UTF-8 bytes
 * @returns {string} Blob as a lowercase hex string (no 0x prefix), ready for
 *   createAccountPayload's verifierParamsHex
 */
export function buildSessionKeyRegistrationBlob({
  publicKeyHex,
  targetContract,
  method,
  validUntilMs,
  spendingLimitDatoshi = 0,
  description = '',
} = {}) {
  const pubKey = sanitizeHex(publicKeyHex);
  if (pubKey.length !== 66 && pubKey.length !== 130) {
    throw invalid(`public key must be 33 or 65 bytes, got ${pubKey.length / 2}`);
  }
  const prefix = pubKey.slice(0, 2);
  if (pubKey.length === 66 && prefix !== '02' && prefix !== '03') {
    throw invalid('compressed public key must start with 02 or 03');
  }
  if (pubKey.length === 130 && prefix !== '04') {
    throw invalid('uncompressed public key must start with 04');
  }

  const target = sanitizeHex(targetContract);
  if (target.length !== 40) {
    throw invalid(`target contract must be 20 bytes (40 hex chars), got ${target.length}`);
  }

  const encoder = new TextEncoder();
  const methodBytes = encoder.encode(String(method || ''));
  if (methodBytes.length === 0 || methodBytes.length > 255) {
    throw invalid(`method must be 1-255 UTF-8 bytes, got ${methodBytes.length}`);
  }
  const descriptionBytes = encoder.encode(String(description || ''));
  if (descriptionBytes.length > MAX_SESSION_KEY_DESCRIPTION_BYTES) {
    throw invalid(`description must be at most ${MAX_SESSION_KEY_DESCRIPTION_BYTES} UTF-8 bytes, got ${descriptionBytes.length}`);
  }

  const validUntil = requireUint64(validUntilMs, 'validUntilMs');
  const spendingLimit = requireUint64(spendingLimitDatoshi, 'spendingLimitDatoshi');
  if (spendingLimit > 0n && String(method) !== 'transfer') {
    // Fail closed exactly like the contract: a positive cap is only
    // enforceable on the value-moving transfer path, so building such a blob
    // would produce a registration the verifier rejects.
    throw invalid('spending limit only enforceable on transfer session keys');
  }

  const bytes = [SESSION_KEY_BLOB_VERSION, pubKey.length / 2];
  for (let i = 0; i < pubKey.length; i += 2) bytes.push(parseInt(pubKey.slice(i, i + 2), 16));
  // The contract copies these 20 bytes straight into a UInt160, so the blob
  // carries the internal little-endian form (reverseHex of display hex).
  const targetLE = reverseHex(target);
  for (let i = 0; i < targetLE.length; i += 2) bytes.push(parseInt(targetLE.slice(i, i + 2), 16));
  bytes.push(methodBytes.length, ...methodBytes);
  writeUint64LE(bytes, validUntil);
  writeUint64LE(bytes, spendingLimit);
  bytes.push(descriptionBytes.length, ...descriptionBytes);
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Builds an ERC-7715-shaped session-key permission grant alongside the
 * on-chain artifacts. The 7715 envelope is a wallet-facing shape
 * (signer + permissions + expiry, expiry in unix seconds per 7715); the
 * registration blob and call arguments carry the canonical Neo values
 * (Runtime.Time milliseconds, datoshi).
 *
 * @param {Object} options - Same options as buildSessionKeyRegistrationBlob
 * @returns {{
 *   permission: Object,
 *   registrationBlobHex: string,
 *   sessionKeyArgs: {publicKeyHex: string, targetContract: string, method: string,
 *     validUntilMs: string, spendingLimitDatoshi: string, description: string},
 * }} 7715-shaped request plus the blob and the canonical call arguments
 */
export function buildSessionKeyPermission(options = {}) {
  const registrationBlobHex = buildSessionKeyRegistrationBlob(options);
  const pubKey = sanitizeHex(options.publicKeyHex);
  const target = sanitizeHex(options.targetContract);
  const validUntil = requireUint64(options.validUntilMs, 'validUntilMs');
  const spendingLimit = requireUint64(options.spendingLimitDatoshi ?? 0, 'spendingLimitDatoshi');
  return {
    permission: {
      signer: { type: 'key', data: { publicKey: `0x${pubKey}` } },
      permissions: [{
        type: 'contract-call',
        data: {
          address: `0x${target}`,
          selector: String(options.method || ''),
          spendingLimit: spendingLimit.toString(),
        },
      }],
      expiry: Number(validUntil / 1000n),
    },
    registrationBlobHex,
    sessionKeyArgs: {
      publicKeyHex: pubKey,
      targetContract: target,
      method: String(options.method || ''),
      validUntilMs: validUntil.toString(),
      spendingLimitDatoshi: spendingLimit.toString(),
      description: String(options.description || ''),
    },
  };
}
