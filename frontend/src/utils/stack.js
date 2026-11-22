/**
 * Neo VM stack decoders shared by the protocol and identity readers.
 *
 * `invokeFunction` returns values in node encoding, not in the display encoding
 * the ABI names: UInt160 arrives as a little-endian 20-byte ByteString and a
 * contract id arrives as a plain hex ByteString. Both call sites read the same
 * v4 account descriptor, so the decoders live here rather than in a feature
 * directory.
 */

import { EC } from '../config/errorCodes.js';
import { sanitizeHex } from './hex.js';
import { getScriptHashFromAddress, reverseHex } from './neo.js';

export function base64ToHex(base64Value) {
  if (!base64Value) return '';
  try {
    const binary = atob(base64Value);
    let hex = '';
    for (let i = 0; i < binary.length; i++) {
      hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return hex.toLowerCase();
  } catch (_) {
    if (import.meta.env.DEV) console.warn('[stack] base64ToHex decode failed');
    return '';
  }
}

export function normalizeAddress(input) {
  const value = String(input || '').trim();
  if (!value) return value;

  if (value.startsWith('N') && value.length === 34) {
    return getScriptHashFromAddress(value);
  }
  if (value.startsWith('0x')) {
    return value.slice(2);
  }
  return value;
}

export function hash160Param(value) {
  const normalized = normalizeAddress(value);
  if (!/^[0-9a-fA-F]{40}$/.test(normalized)) {
    throw new Error(EC.addressValidationFailed);
  }
  return normalized;
}

export function decodeStackByteStringHex(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'ByteString') return base64ToHex(item.value);
  return '';
}

export function decodeStackHash160(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'Hash160') return sanitizeHex(item.value);
  // Nodes return UInt160 stack values as ByteString of the internal
  // little-endian bytes; reverse to the big-endian display form so the value
  // round-trips through hash160Param and the update operations.
  if (item.type === 'ByteString') {
    const hex = sanitizeHex(base64ToHex(item.value));
    return hex ? reverseHex(hex) : '';
  }
  return '';
}
