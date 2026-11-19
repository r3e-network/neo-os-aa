/**
 * Account identity for the Neo N3 Smart Account v4 stack.
 *
 * Single source of truth for the derivation that both kernels implement:
 *
 *   payload = 'aa524704' || custody               || salt
 *   digest  = ripemd160(sha256(payload))
 *   accountId display hex = digest                (big-endian)
 *   accountId stored bytes = reverse(digest)      (UInt160 internal order)
 *
 * `custody` is a 40-hex-character display-form hash160; the derivation hashes
 * its internal (little-endian) bytes, i.e. reverse(display). The salt is 1..128
 * bytes of caller-chosen uniqueness material. No core hash and no network
 * enter the identity: the same custody+salt yields the same account id under
 * both kernels (docs/SA-MODULE-PROTOCOL.md §16.1).
 *
 * The proxy verification script is the account address:
 *
 *   PUSHDATA1 20 accountId | PUSH1 PACK | PUSH<flags> | PUSHDATA1 "verify" |
 *   PUSHDATA1 20 core | SYSCALL System.Contract.Call
 *
 * The custom kernel builds PUSH15 (CallFlags.All = 15); the native kernel
 * pushes PUSH5 (CallFlags.ReadOnly = 5). The flag is an explicit parameter
 * because the account address must be the one the submitting kernel derives.
 *
 * The pre-v4 registration identity ('aa524701' || ...) is retained ONLY for
 * the platform registrar, whose registered account ids must stay stable across
 * the upgrade (contracts/custom/SmartAccount.Accounts.cs). It is not a v4
 * authorization source and is not used by ordinary registration.
 *
 * Dependency-light by design: the hash160 primitive is injected, and the hex
 * helpers come from metaTxCore.mjs, so the SDK, the relay route and the wallet
 * frontend derive identical bytes.
 */

import { sanitizeHex, reverseHex } from './metaTxCore.mjs';

/** Domain prefix of the v4 account identity (contract AccountIdentityDomainV4). */
export const ACCOUNT_IDENTITY_DOMAIN_HEX = 'aa524704';
/** Pre-v4 registration domain, platform-registrar ids only. */
export const PLATFORM_REGISTRATION_DOMAIN_HEX = 'aa524701';

export const REGISTRATION_SALT_MIN_BYTES = 1;
export const REGISTRATION_SALT_MAX_BYTES = 128;

/** Recovery timelock bounds in milliseconds (AccountControl.RecoveryTimelock*Ms). */
export const MIN_RECOVERY_TIMELOCK_MS = 604_800_000; // 7 days
export const MAX_RECOVERY_TIMELOCK_MS = 7_776_000_000; // 90 days

const ZERO_HASH160_HEX = '00'.repeat(20);
const VERIFY_METHOD_HEX = '766572696679'; // "verify"
const MIN_REGISTRATION_ESCAPE_TIMELOCK_SECONDS = 7 * 24 * 60 * 60;
const MAX_REGISTRATION_ESCAPE_TIMELOCK_SECONDS = 90 * 24 * 60 * 60;
const DEFAULT_REGISTRATION_ESCAPE_TIMELOCK_SECONDS = 30 * 24 * 60 * 60;

function requireDisplayHash160(value, fieldName) {
  const sanitized = sanitizeHex(value);
  if (!/^[0-9a-f]{40}$/.test(sanitized)) {
    throw new Error(`Invalid account identity: ${fieldName} must be 40 hex characters`);
  }
  return sanitized;
}

function requireSaltHex(value) {
  const sanitized = sanitizeHex(value ?? '');
  if (!/^(?:[0-9a-f]{2})*$/.test(sanitized)) {
    throw new Error('Invalid account identity: salt must be canonical hex bytes');
  }
  const bytes = sanitized.length / 2;
  if (bytes < REGISTRATION_SALT_MIN_BYTES || bytes > REGISTRATION_SALT_MAX_BYTES) {
    throw new Error(
      `Invalid account identity: salt must contain ${REGISTRATION_SALT_MIN_BYTES} through ${REGISTRATION_SALT_MAX_BYTES} bytes`,
    );
  }
  return sanitized;
}

/** NeoVM constant push for the small call-flag values both kernels use. */
function pushSmallInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < -1 || n > 16) {
    throw new Error('Invalid account identity: call flags must be -1..16');
  }
  return (n + 16).toString(16).padStart(2, '0');
}

function toUint32LittleEndianHex(uint32) {
  if (!Number.isInteger(uint32) || uint32 < 0 || uint32 > 0xffffffff) {
    throw new Error('Invalid escape timelock');
  }
  if (
    uint32 < MIN_REGISTRATION_ESCAPE_TIMELOCK_SECONDS ||
    uint32 > MAX_REGISTRATION_ESCAPE_TIMELOCK_SECONDS
  ) {
    throw new Error('Invalid escape timelock: expected 7-90 days');
  }
  return [uint32 & 0xff, (uint32 >>> 8) & 0xff, (uint32 >>> 16) & 0xff, (uint32 >>> 24) & 0xff]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Creates the identity derivers with an injected hash160.
 *
 * @param {Object} options
 * @param {Function} options.hash160 - hash160(hexBytes) returning
 *   ripemd160(sha256(bytes)) as 40 hex characters in natural (display) order
 */
export function createRegistrationIdentityDeriver({ hash160 } = {}) {
  if (typeof hash160 !== 'function') {
    throw new TypeError('createRegistrationIdentityDeriver requires a hash160(hex) implementation');
  }

  /**
   * v4 identity of a custody+salt pair.
   *
   * @param {{ custody: string, salt: string }} options 40-hex custody, salt hex
   * @returns {{ accountId: string, identityPreimageHex: string }}
   */
  function deriveAccountIdentity({ custody, salt } = {}) {
    const owner = requireDisplayHash160(custody, 'custody');
    if (owner === ZERO_HASH160_HEX) {
      throw new Error('Invalid account identity: custody must be nonzero');
    }
    const saltHex = requireSaltHex(salt);
    const identityPreimageHex = `${ACCOUNT_IDENTITY_DOMAIN_HEX}${reverseHex(owner)}${saltHex}`;
    const accountId = sanitizeHex(hash160(identityPreimageHex));
    if (!/^[0-9a-f]{40}$/.test(accountId) || accountId === ZERO_HASH160_HEX) {
      throw new Error('Invalid account identity: hash160 returned a malformed id');
    }
    return { accountId, identityPreimageHex };
  }

  /** Stored (little-endian) form of the same identity, for script bytes only. */
  function deriveAccountIdentityChainHex(options) {
    return reverseHex(deriveAccountIdentity(options).accountId);
  }

  /**
   * The fixed proxy verification script. `callFlags` defaults to 15
   * (CallFlags.All, the custom kernel); the native kernel passes 5.
   */
  function deriveProxyScript({ accountId, coreContractHash, callFlags = 15 } = {}) {
    const account = requireDisplayHash160(accountId, 'accountId');
    const core = requireDisplayHash160(coreContractHash, 'coreContractHash');
    return [
      '0c14',
      reverseHex(account),
      '11c0',
      pushSmallInt(callFlags),
      '0c06',
      VERIFY_METHOD_HEX,
      '0c14',
      reverseHex(core),
      '41627d5b52',
    ].join('').toLowerCase();
  }

  /**
   * The account address: the proxy script's hash in chain (display) order.
   * hash160 yields the natural digest; a script hash is displayed and carried
   * in RPC parameters reversed, so the two derivations (this one and the
   * protocol codec's `accountAddress`) name the same on-chain value.
   */
  function deriveAccountAddress(options) {
    return reverseHex(sanitizeHex(hash160(deriveProxyScript(options))));
  }

  /**
   * Pre-v4 registration identity retained for the platform registrar only:
   * 'aa524701' || backupOwner || verifier || hook ||
   * uint32LE(escapeTimelock) || verifierParams, each hash in display order.
   */
  function derivePlatformRegistrarAccountId({
    backupOwnerHash160,
    verifierHash160 = '',
    hookHash160 = '',
    escapeTimelock = DEFAULT_REGISTRATION_ESCAPE_TIMELOCK_SECONDS,
    verifierParamsHex = '',
  } = {}) {
    const backupOwner = requireDisplayHash160(backupOwnerHash160, 'backupOwnerHash160');
    const verifier = verifierHash160
      ? requireDisplayHash160(verifierHash160, 'verifierHash160')
      : ZERO_HASH160_HEX;
    const hook = hookHash160
      ? requireDisplayHash160(hookHash160, 'hookHash160')
      : ZERO_HASH160_HEX;
    const params = sanitizeHex(verifierParamsHex || '');
    if (!/^(?:[0-9a-f]{2})*$/.test(params)) {
      throw new Error('Invalid verifier parameters hex');
    }
    const payloadHex = [
      PLATFORM_REGISTRATION_DOMAIN_HEX,
      backupOwner,
      verifier,
      hook,
      toUint32LittleEndianHex(escapeTimelock),
      params,
    ].join('');
    return sanitizeHex(hash160(payloadHex));
  }

  return {
    deriveAccountIdentity,
    deriveAccountIdentityChainHex,
    deriveProxyScript,
    deriveAccountAddress,
    derivePlatformRegistrarAccountId,
  };
}
