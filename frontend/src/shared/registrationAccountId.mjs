/**
 * Shared registration account-id derivation for the Neo N3 Abstract Account
 * stack.
 *
 * Single source of truth for the V3 registration account-id payload layout
 * that was previously duplicated between the CJS SDK
 * (sdk/js/src/index.js) and the frontend (frontend/src/utils/neo.js) — and
 * the source of a byte-order split-brain where the two sides disagreed on
 * the returned convention.
 *
 * Byte-order contract (mirrors UnifiedSmartWallet.Accounts.cs
 * ComputeRegistrationAccountId):
 *
 *   payload = 'aa524701' || backupOwner || verifier || hook ||
 *             uint32LE(escapeTimelock) || verifierParams
 *   rawHash = ripemd160(sha256(payload))
 *
 * The contract returns (UInt160)ReverseBytes(rawHash); since a UInt160's
 * display string is the reverse of its internal bytes, the on-chain
 * DISPLAY form equals rawHash in natural order. This module therefore
 * exposes two explicitly-named conventions:
 *
 * - deriveRegistrationAccountIdDisplayHex: big-endian display hex (rawHash
 *   in natural order). Matches the contract's display form and is the only
 *   correct value for RPC {type:'Hash160'} parameters, hash display, and
 *   storage of the id as a string.
 * - deriveRegistrationAccountIdChainHex: the internal little-endian VM
 *   byte order (reverseHex of the display form). Use only when pushing the
 *   raw 20 bytes into a script (e.g. the verify script PUSHDATA), where
 *   the VM interprets pushed bytes as the UInt160 internal representation.
 *
 * The 20-byte inputs (backupOwnerHash160/verifierHash160/hookHash160) are
 * big-endian display hex, matching the contract's ToRegistrationHashBytes
 * which reverses each UInt160 argument to big-endian before hashing.
 *
 * Dependency-light by design: the ripemd160(sha256(x)) primitive is
 * injected by each consumer (ethers in the frontend, neon in the SDK), and
 * address/hash normalization with consumer-specific errors stays in the
 * consumers; this module owns the byte-critical layout and both return
 * conventions.
 *
 * Consumers:
 * - sdk/js/src/index.js (CJS; loads this ESM graph via require)
 * - frontend/src/utils/neo.js (ESM, relative import; reachable in the
 *   frontend build the same way as shared/metaTxCore.mjs)
 */

import { sanitizeHex, reverseHex } from './metaTxCore.mjs';

/** Domain separator prefix, mirrors RegistrationAccountIdDomain in the contract. */
export const REGISTRATION_ACCOUNT_ID_DOMAIN_HEX = 'aa524701';

export const MIN_REGISTRATION_ESCAPE_TIMELOCK_SECONDS = 7 * 24 * 60 * 60;
export const MAX_REGISTRATION_ESCAPE_TIMELOCK_SECONDS = 90 * 24 * 60 * 60;
export const DEFAULT_REGISTRATION_ESCAPE_TIMELOCK_SECONDS = 30 * 24 * 60 * 60;

const ZERO_HASH160_HEX = '00'.repeat(20);

/**
 * Validates the escape timelock against the contract registration bounds.
 * Messages intentionally match what the SDK and frontend threw before the
 * derivation was hoisted here.
 *
 * @param {number} uint32 - Timelock in seconds
 * @private
 */
function validateRegistrationEscapeTimelock(uint32) {
  if (!Number.isInteger(uint32) || uint32 < 0 || uint32 > 0xffffffff) {
    throw new Error('Invalid escape timelock');
  }
  if (uint32 < MIN_REGISTRATION_ESCAPE_TIMELOCK_SECONDS || uint32 > MAX_REGISTRATION_ESCAPE_TIMELOCK_SECONDS) {
    throw new Error('Invalid escape timelock: expected 7-90 days');
  }
}

/**
 * Encodes a uint32 as 4 little-endian hex bytes, mirroring the contract's
 * UInt32ToLittleEndianBytes.
 *
 * @param {number} uint32 - Value to encode
 * @returns {string} 8 hex characters, little-endian
 * @private
 */
function toUint32LittleEndianHex(uint32) {
  validateRegistrationEscapeTimelock(uint32);

  return [
    uint32 & 0xff,
    (uint32 >>> 8) & 0xff,
    (uint32 >>> 16) & 0xff,
    (uint32 >>> 24) & 0xff,
  ].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Requires a value to be a 40-hex-character display-form hash160. This is
 * defense-in-depth: consumers normalize and validate with their own coded
 * errors before delegating here.
 *
 * @param {string} value - Candidate hash160 hex
 * @param {string} fieldName - Field label for the error message
 * @returns {string} Sanitized 40-character hex
 * @private
 */
function requireDisplayHash160(value, fieldName) {
  const sanitized = sanitizeHex(value);
  if (!/^[0-9a-f]{40}$/i.test(sanitized)) {
    throw new Error(`Invalid registration hash160: ${fieldName} must be 40 hex characters`);
  }
  return sanitized;
}

/**
 * Creates the registration account-id derivers with an injected hash160.
 *
 * @param {Object} options - Factory options
 * @param {Function} options.hash160 - hash160(hexString) returning the
 *   ripemd160(sha256(bytes)) digest as hex in natural byte order (e.g.
 *   ethers ripemd160(sha256) or neon u.hash160)
 * @returns {{
 *   deriveRegistrationAccountIdDisplayHex: Function,
 *   deriveRegistrationAccountIdChainHex: Function,
 * }} The derivers for the two byte-order conventions
 */
export function createRegistrationAccountIdDeriver({ hash160 } = {}) {
  if (typeof hash160 !== 'function') {
    throw new TypeError('createRegistrationAccountIdDeriver requires a hash160(hex) implementation');
  }

  /**
   * Computes the raw registration hash in natural byte order.
   *
   * @returns {string} 40-character hex of ripemd160(sha256(payload))
   * @private
   */
  function computeRawHashHex({
    backupOwnerHash160,
    verifierHash160 = '',
    hookHash160 = '',
    escapeTimelock = DEFAULT_REGISTRATION_ESCAPE_TIMELOCK_SECONDS,
    verifierParamsHex = '',
  }) {
    const backupOwner = requireDisplayHash160(backupOwnerHash160, 'backupOwnerHash160');
    const verifier = verifierHash160
      ? requireDisplayHash160(verifierHash160, 'verifierHash160')
      : ZERO_HASH160_HEX;
    const hook = hookHash160
      ? requireDisplayHash160(hookHash160, 'hookHash160')
      : ZERO_HASH160_HEX;

    const payloadHex = [
      REGISTRATION_ACCOUNT_ID_DOMAIN_HEX,
      backupOwner,
      verifier,
      hook,
      toUint32LittleEndianHex(escapeTimelock),
      sanitizeHex(verifierParamsHex || ''),
    ].join('');

    return sanitizeHex(hash160(payloadHex));
  }

  /**
   * Derives the registration-bound account id in big-endian display form.
   *
   * This equals the on-chain ComputeRegistrationAccountId display string
   * and is the value registerAccount expects as its {type:'Hash160'}
   * accountId argument.
   *
   * @param {Object} options - Registration options
   * @param {string} options.backupOwnerHash160 - Backup owner, 40-hex display form
   * @param {string} [options.verifierHash160=''] - Verifier contract, 40-hex display form ('' binds zero)
   * @param {string} [options.hookHash160=''] - Hook contract, 40-hex display form ('' binds zero)
   * @param {number} [options.escapeTimelock=2592000] - Escape hatch timelock in seconds
   * @param {string} [options.verifierParamsHex=''] - Verifier parameters hex
   * @returns {string} 40-character big-endian display hex account id
   */
  function deriveRegistrationAccountIdDisplayHex(options) {
    return computeRawHashHex(options);
  }

  /**
   * Derives the registration-bound account id in the internal little-endian
   * VM byte order (reverseHex of the display form). Only use this when
   * pushing the raw 20 bytes into a script, where pushed bytes are read as
   * the UInt160 internal representation — never for RPC Hash160 params.
   *
   * @param {Object} options - Same options as deriveRegistrationAccountIdDisplayHex
   * @returns {string} 40-character little-endian chain-order hex account id
   */
  function deriveRegistrationAccountIdChainHex(options) {
    return reverseHex(computeRawHashHex(options));
  }

  return {
    deriveRegistrationAccountIdDisplayHex,
    deriveRegistrationAccountIdChainHex,
  };
}
