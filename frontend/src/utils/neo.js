import { ripemd160, sha256 } from 'ethers';
import { EC } from '../config/errorCodes.js';
import { sanitizeHex } from './hex.js';
import { fetchWithTimeout } from './fetchWithTimeout.js';
import { createRegistrationAccountIdDeriver } from '../shared/registrationAccountId.mjs';

export const DEFAULT_NEO_ADDRESS_VERSION = 53;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((char, index) => [char, index]));

// The escape-timelock bounds live in the vendored shared/registrationAccountId.mjs so the
// frontend, the SDK, and the on-chain registration guard cannot drift apart.
export {
  MIN_REGISTRATION_ESCAPE_TIMELOCK_SECONDS,
  MAX_REGISTRATION_ESCAPE_TIMELOCK_SECONDS,
} from '../shared/registrationAccountId.mjs';
export const MIN_REGISTRATION_ESCAPE_TIMELOCK_DAYS = 7;
export const MAX_REGISTRATION_ESCAPE_TIMELOCK_DAYS = 90;

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

function emitPushData(hexValue) {
  const hex = sanitizeHex(hexValue);
  const length = hex.length / 2;
  if (length < 0x100) {
    return `0c${length.toString(16).padStart(2, '0')}${hex}`;
  }
  if (length < 0x10000) {
    const sizeHex = `${(length & 0xff).toString(16).padStart(2, '0')}${((length >> 8) & 0xff).toString(16).padStart(2, '0')}`;
    return `0d${sizeHex}${hex}`;
  }
  throw new Error(EC.dataTooLargeToPush);
}

function emitSmallInteger(value) {
  if (value < 0 || value > 16) {
    throw new Error(EC.unsupportedSmallInteger);
  }
  return (0x10 + value).toString(16).padStart(2, '0');
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

const registrationAccountIdDeriver = createRegistrationAccountIdDeriver({ hash160: hash160Hex });

// Maps the public address/hash options onto the shared deriver's normalized
// display-form hash160 inputs, keeping this module's EC-coded validation errors.
function normalizeRegistrationOptions({
  verifierContractHash = '',
  verifierParamsHex = '',
  hookContractHash = '',
  backupOwnerAddress = '',
  escapeTimelock = 30 * 24 * 60 * 60,
} = {}) {
  const backupOwner = normalizeHash160Input(backupOwnerAddress);
  if (!/^[0-9a-f]{40}$/i.test(backupOwner)) {
    throw new Error(EC.addressValidationFailed);
  }

  const verifierHash = verifierContractHash
    ? normalizeHash160Input(verifierContractHash)
    : '';
  const hookHash = hookContractHash
    ? normalizeHash160Input(hookContractHash)
    : '';

  if ((verifierHash && !/^[0-9a-f]{40}$/i.test(verifierHash)) || (hookHash && !/^[0-9a-f]{40}$/i.test(hookHash))) {
    throw new Error(EC.addressValidationFailed);
  }

  return {
    backupOwnerHash160: backupOwner,
    verifierHash160: verifierHash,
    hookHash160: hookHash,
    escapeTimelock,
    verifierParamsHex,
  };
}

/**
 * Derives the registration-bound account id in big-endian display form.
 *
 * Single-sourced in shared/registrationAccountId.mjs with the SDK and the
 * on-chain ComputeRegistrationAccountId: the returned value equals the
 * contract's UInt160 display string and is exactly what registerAccount
 * expects as its {type:'Hash160'} accountId argument. (An earlier version
 * returned the byte-reversed internal form here, which faults the on-chain
 * account-id assert when passed as a Hash160 RPC param.)
 */
export function deriveRegistrationAccountIdHash(options = {}) {
  return registrationAccountIdDeriver.deriveRegistrationAccountIdDisplayHex(
    normalizeRegistrationOptions(options)
  );
}

/**
 * Derives the same account id in the internal little-endian VM byte order
 * (reverseHex of the display form). Only use this when pushing the raw 20
 * bytes into a script (e.g. createVerifyScript), where pushed bytes are read
 * as the UInt160 internal representation — never for RPC Hash160 params.
 */
export function deriveRegistrationAccountIdChainHex(options = {}) {
  return registrationAccountIdDeriver.deriveRegistrationAccountIdChainHex(
    normalizeRegistrationOptions(options)
  );
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

export function createVerifyScript(contractHash, accountIdHex) {
  const accountId = reverseHex(deriveAccountIdHash(accountIdHex));
  const contract = sanitizeHex(contractHash);
  const operationHex = bytesToHex(new TextEncoder().encode('verify'));

  return [
    emitPushData(accountId),
    emitSmallInteger(1),
    'c0',
    emitSmallInteger(15),
    emitPushData(operationHex),
    emitPushData(reverseHex(contract)),
    '41627d5b52',
  ].join('');
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
