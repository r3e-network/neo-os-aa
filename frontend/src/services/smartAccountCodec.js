/**
 * The one v4 protocol codec the wallet frontend uses.
 *
 * `shared/nativeSmartAccount.mjs` owns the wire format (13-field operation,
 * §4.3 domain, nonce namespaces, proxy script, threshold envelopes). It takes
 * sha256/hash160 as injected synchronous hex adapters so the same module can
 * run in the SDK, the relay and here. Creating the codec once means every
 * screen derives the same operation digest, nonce channel and proxy address as
 * the kernel that will verify them.
 */

import { ripemd160, sha256 } from 'ethers';
import { createProtocolCodec } from '../shared/nativeSmartAccount.mjs';
import { sanitizeHex } from '../utils/hex.js';

/** sha256(hex) -> 32-byte hex, the adapter shape the codec expects. */
export function sha256Hex(hex) {
  return sanitizeHex(sha256(`0x${sanitizeHex(hex)}`));
}

/** RIPEMD160(SHA256(hex)) -> 20-byte hex. */
export function hash160Hex(hex) {
  return sanitizeHex(ripemd160(sha256(`0x${sanitizeHex(hex)}`)));
}

export const smartAccountCodec = createProtocolCodec({
  sha256: sha256Hex,
  hash160: hash160Hex,
});
