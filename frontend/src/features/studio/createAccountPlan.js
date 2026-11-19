/**
 * Account creation plan for the v4 protocol (§10).
 *
 * A v4 identity is committed to before registration: accountId =
 * hash160('aa524704' || custody || salt). Modules are NOT chosen here — a v4
 * account is created with its custody, its salt and its recovery timelock, and
 * every verifier or hook is installed later through a configuration intent.
 * Keeping creation to that shape is what makes the address reproducible from
 * the pair alone, on both kernels.
 */

import {
  MAX_RECOVERY_TIMELOCK_DAYS,
  MAX_RECOVERY_TIMELOCK_MS,
  MIN_RECOVERY_TIMELOCK_DAYS,
  MIN_RECOVERY_TIMELOCK_MS,
  REGISTRATION_SALT_MAX_BYTES,
  REGISTRATION_SALT_MIN_BYTES,
  createProxyScript,
  deriveAccountAddress,
  deriveAccountIdentity,
} from '../../utils/neo.js';
import { EC } from '../../config/errorCodes.js';
import { sanitizeHex } from '../../utils/hex.js';
import { planCreateAccount as planCreateAccountInvocation } from '../../services/smartAccountProtocol.js';
import { hash160Param } from './helpers.js';

/** 16 bytes is enough to make a collision implausible and short to read back. */
export const REGISTRATION_SALT_BYTES = 16;

/**
 * Fresh salt material. The salt is public uniqueness input, not a secret, but
 * it must come from a real random source: a weak one makes two accounts
 * addressable by the same id.
 */
export function generateRegistrationSalt(byteLength = REGISTRATION_SALT_BYTES) {
  if (!Number.isInteger(byteLength)
    || byteLength < REGISTRATION_SALT_MIN_BYTES
    || byteLength > REGISTRATION_SALT_MAX_BYTES) {
    throw new Error(EC.registrationSaltInvalid);
  }
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== 'function') {
    throw new Error('Registration salt generation requires a secure random source');
  }
  const bytes = new Uint8Array(byteLength);
  source.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizeRegistrationSalt(value) {
  const salt = sanitizeHex(value || '');
  if (!/^(?:[0-9a-f]{2})*$/.test(salt)) throw new Error(EC.registrationSaltInvalid);
  const bytes = salt.length / 2;
  if (bytes < REGISTRATION_SALT_MIN_BYTES || bytes > REGISTRATION_SALT_MAX_BYTES) {
    throw new Error(EC.registrationSaltInvalid);
  }
  return salt;
}

/** The form collects days; the contract takes milliseconds. */
export function recoveryTimelockDaysToMs(days) {
  const value = Number(days);
  if (!Number.isFinite(value)) throw new Error(EC.recoveryTimelockInvalid);
  const ms = Math.round(value * 86_400_000);
  if (ms < MIN_RECOVERY_TIMELOCK_MS || ms > MAX_RECOVERY_TIMELOCK_MS) {
    throw new Error(EC.recoveryTimelockInvalid);
  }
  return ms;
}

/**
 * Everything the create flow needs from one pass over the form: the identity,
 * the proxy script (which is the account address), and the createAccount
 * invocation the wallet signs.
 *
 * @param {Object} form - { custody, salt, recoveryTimelockDays }
 * @param {string} coreContractHash - the deployed SmartAccount core
 */
export function planCreateAccount(form, coreContractHash) {
  if (!form || typeof form !== 'object') {
    throw new TypeError('A create form is required to plan an account registration');
  }
  if (!coreContractHash) throw new Error(EC.contractNotFound);

  const custodyAddress = hash160Param(form.custody);
  const salt = normalizeRegistrationSalt(form.salt);
  const recoveryTimelockMs = recoveryTimelockDaysToMs(form.recoveryTimelockDays);

  const { accountId, identityPreimageHex } = deriveAccountIdentity({ custodyAddress, salt });
  const verificationScript = createProxyScript(coreContractHash, accountId);
  const accountAddress = deriveAccountAddress({ accountId, coreContractHash });

  return {
    custodyAddress,
    salt,
    recoveryTimelockMs,
    accountId,
    identityPreimageHex,
    verificationScript,
    accountAddress,
    invocation: planCreateAccountInvocation({
      accountId,
      custodyAddress,
      salt,
      recoveryTimelockMs,
    }),
  };
}

export { MIN_RECOVERY_TIMELOCK_DAYS, MAX_RECOVERY_TIMELOCK_DAYS };
