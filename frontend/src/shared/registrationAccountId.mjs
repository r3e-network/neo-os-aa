/**
 * Account identity for the Neo N3 Smart Account v4 stack.
 *
 * Single source of truth for the derivation the native kernel implements:
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
 * the native core (docs/SA-MODULE-PROTOCOL.md §16.1).
 *
 * The proxy verification script is the account address:
 *
 *   PUSHDATA1 20 accountId | PUSH1 PACK | PUSH<flags> | PUSHDATA1 "verify" |
 *   PUSHDATA1 20 core | SYSCALL System.Contract.Call
 *
 * The native kernel pushes PUSH5 (CallFlags.ReadOnly = 5), which is this
 * module's only accepted flag.
 *
 * Dependency-light by design: the hash160 primitive is injected, and the hex
 * helpers come from metaTxCore.mjs, so the SDK, the relay route and the wallet
 * frontend derive identical bytes.
 */

import { sanitizeHex, reverseHex } from './metaTxCore.mjs';
import { nativeProxyVerificationScript } from './nativeSmartAccount.mjs';

/** Domain prefix of the v4 account identity (contract AccountIdentityDomainV4). */
export const ACCOUNT_IDENTITY_DOMAIN_HEX = 'aa524704';

export const REGISTRATION_SALT_MIN_BYTES = 1;
export const REGISTRATION_SALT_MAX_BYTES = 128;

/** Recovery timelock bounds in milliseconds (AccountControl.RecoveryTimelock*Ms). */
export const MIN_RECOVERY_TIMELOCK_MS = 604_800_000; // 7 days
export const MAX_RECOVERY_TIMELOCK_MS = 7_776_000_000; // 90 days

const ZERO_HASH160_HEX = '00'.repeat(20);

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
   * The fixed proxy verification script. `callFlags` defaults to 5
   * (CallFlags.ReadOnly), the flag the native core pushes.
   */
  function deriveProxyScript({ accountId, coreContractHash, callFlags = 5 } = {}) {
    const account = requireDisplayHash160(accountId, 'accountId');
    const core = requireDisplayHash160(coreContractHash, 'coreContractHash');
    return nativeProxyVerificationScript(account, { coreContractHash: core, callFlags });
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

  return {
    deriveAccountIdentity,
    deriveAccountIdentityChainHex,
    deriveProxyScript,
    deriveAccountAddress,
  };
}
