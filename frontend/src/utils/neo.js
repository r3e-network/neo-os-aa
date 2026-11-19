import { ripemd160, sha256 } from 'ethers';
import { EC } from '../config/errorCodes.js';
import { sanitizeHex } from './hex.js';
import { fetchWithTimeout } from './fetchWithTimeout.js';
import {
  createRegistrationIdentityDeriver,
  MAX_RECOVERY_TIMELOCK_MS,
  MIN_RECOVERY_TIMELOCK_MS,
  REGISTRATION_SALT_MAX_BYTES,
  REGISTRATION_SALT_MIN_BYTES,
} from '../shared/registrationAccountId.mjs';

export const DEFAULT_NEO_ADDRESS_VERSION = 53;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((char, index) => [char, index]));

// Identity, salt and recovery-timelock bounds live in the vendored
// shared/registrationAccountId.mjs so the frontend, the SDK, the relay route
// and both kernels cannot drift apart.
export {
  MAX_RECOVERY_TIMELOCK_MS,
  MIN_RECOVERY_TIMELOCK_MS,
  REGISTRATION_SALT_MAX_BYTES,
  REGISTRATION_SALT_MIN_BYTES,
};
export const MIN_RECOVERY_TIMELOCK_DAYS = MIN_RECOVERY_TIMELOCK_MS / 86_400_000;
export const MAX_RECOVERY_TIMELOCK_DAYS = MAX_RECOVERY_TIMELOCK_MS / 86_400_000;

function hexToBytes(hexValue) {
  const hex = sanitizeHex(hexValue);
  if (hex.length % 2 !== 0) {
    throw new Error(EC.invalidHexLength);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function concatBytes(...chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function sha256Bytes(bytes) {
  return hexToBytes(sha256(bytes));
}

function doubleSha256Bytes(bytes) {
  return sha256Bytes(sha256Bytes(bytes));
}

function hash160Hex(hexValue) {
  const bytes = hexToBytes(hexValue);
  const sha = sha256Bytes(bytes);
  return sanitizeHex(ripemd160(sha));
}

function encodeBase58(bytes) {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) + BigInt(byte);
  }

  let output = '';
  while (value > 0n) {
    const remainder = Number(value % 58n);
    output = BASE58_ALPHABET[remainder] + output;
    value /= 58n;
  }

  for (let index = 0; index < bytes.length && bytes[index] === 0; index += 1) {
    output = `1${output}`;
  }

  return output || '1';
}

function decodeBase58(value) {
  let result = 0n;
  for (const char of value) {
    const digit = BASE58_INDEX.get(char);
    if (digit == null) {
      throw new Error(EC.invalidBase58Char);
    }
    result = result * 58n + BigInt(digit);
  }

  const bytes = [];
  while (result > 0n) {
    bytes.unshift(Number(result & 0xffn));
    result >>= 8n;
  }

  let leadingZeroCount = 0;
  for (const char of value) {
    if (char !== '1') break;
    leadingZeroCount += 1;
  }

  return new Uint8Array([...new Array(leadingZeroCount).fill(0), ...bytes]);
}

export function reverseHex(hexValue) {
  const hex = sanitizeHex(hexValue);
  let output = '';
  for (let index = hex.length; index > 0; index -= 2) {
    output += hex.slice(index - 2, index);
  }
  return output;
}

export function hash160(hexValue) {
  return hash160Hex(hexValue);
}

function normalizeHash160Input(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('N') && trimmed.length === 34) {
    return getScriptHashFromAddress(trimmed);
  }
  return sanitizeHex(trimmed);
}

export function deriveAccountIdHash(accountIdHexOrSeed) {
  const normalized = sanitizeHex(accountIdHexOrSeed || '');
  if (!normalized) {
    throw new Error(EC.accountSeedRequired);
  }
  if (/^[0-9a-f]{40}$/i.test(normalized)) {
    return normalized;
  }
  return hash160Hex(normalized);
}

const identityDeriver = createRegistrationIdentityDeriver({ hash160: hash160Hex });

function requireHash160(value) {
  const hash = normalizeHash160Input(value);
  if (!/^[0-9a-f]{40}$/i.test(hash)) {
    throw new Error(EC.addressValidationFailed);
  }
  return hash;
}

/**
 * v4 account identity (§16.1): accountId = hash160('aa524704' || custody || salt).
 *
 * Single-sourced in shared/registrationAccountId.mjs with the SDK, the relay
 * route and both kernels. `custodyAddress` accepts a Neo N3 address or a
 * display-form hash160; `salt` is 1..128 hex-encoded bytes. The returned
 * `accountId` is big-endian display hex — exactly what createAccount expects
 * as its {type:'Hash160'} argument. No core hash and no network enter the
 * identity, so one custody+salt pair names the same account on both kernels.
 */
export function deriveAccountIdentity({ custodyAddress = '', salt = '' } = {}) {
  const custody = requireHash160(custodyAddress);
  try {
    return identityDeriver.deriveAccountIdentity({ custody, salt });
  } catch (err) {
    const message = String(err?.message || '');
    const code = /salt/i.test(message)
      ? EC.registrationSaltInvalid
      : EC.addressValidationFailed;
    throw new Error(code);
  }
}

/**
 * The same identity in internal (little-endian) VM byte order. Only for pushing
 * the raw 20 bytes into a script, never for RPC Hash160 parameters.
 */
export function deriveAccountIdentityChainHex(options = {}) {
  return reverseHex(deriveAccountIdentity(options).accountId);
}

/**
 * The account-bound proxy verification script (§16.1): the account address is
 * hash160 of these bytes. `callFlags` defaults to 15 (CallFlags.All, the custom
 * kernel); the native kernel passes 5.
 */
export function createProxyScript(coreContractHash, accountId, callFlags = 15) {
  try {
    return identityDeriver.deriveProxyScript({
      accountId: sanitizeHex(accountId),
      coreContractHash: sanitizeHex(coreContractHash),
      callFlags,
    });
  } catch (_) {
    throw new Error(EC.addressValidationFailed);
  }
}

/** The account address: the proxy script's hash160 in chain (display) order. */
export function deriveAccountAddress({ accountId, coreContractHash, callFlags = 15 } = {}) {
  return reverseHex(hash160Hex(createProxyScript(coreContractHash, accountId, callFlags)));
}

export function getAddressFromScriptHash(scriptHash, addressVersion = DEFAULT_NEO_ADDRESS_VERSION) {
  const payload = concatBytes(
    new Uint8Array([addressVersion]),
    hexToBytes(reverseHex(scriptHash))
  );
  const checksum = doubleSha256Bytes(payload).slice(0, 4);
  return encodeBase58(concatBytes(payload, checksum));
}

export function getScriptHashFromAddress(address) {
  const decoded = decodeBase58(String(address || '').trim());
  if (decoded.length !== 25) {
    throw new Error(EC.invalidNeoAddressLength);
  }
  const payload = decoded.slice(0, 21);
  const checksum = decoded.slice(21);
  const expectedChecksum = doubleSha256Bytes(payload).slice(0, 4);
  if (bytesToHex(checksum) !== bytesToHex(expectedChecksum)) {
    throw new Error(EC.invalidAddressChecksum);
  }
  return reverseHex(bytesToHex(payload.slice(1)));
}

export async function invokeReadFunction(rpcUrl, scriptHash, operation, args = [], fetchImpl = undefined) {
  const response = await fetchWithTimeout(rpcUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'invokefunction',
      params: [scriptHash, operation, args],
    }),
  }, { fetchImpl });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(EC.rpcRequestFailed);
    err.rpcDetail = text || `HTTP ${response.status}`;
    throw err;
  }

  let payload;
  try {
    payload = await response.json();
  } catch (_parseError) {
    const err = new Error(EC.rpcRequestFailed);
    err.rpcDetail = 'invalid JSON response';
    throw err;
  }

  if (payload.error) {
    const err = new Error(EC.rpcRequestFailed);
    err.rpcDetail = payload.error.message || null;
    throw err;
  }
  return payload.result;
}
