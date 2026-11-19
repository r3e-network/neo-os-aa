/**
 * Session-key module commands for the Neo N3 Smart Account v4 stack.
 *
 * A session key is a module instance of SessionKeyValidator. Its `initData`
 * (on install) and `configData` (on configure) are command arrays, exactly the
 * shape the validator parses (contracts/plugins/validators/SessionKeyValidator.cs):
 *
 *   ["setSessionKey", pubKey, targetContract, method, validUntil,
 *    spendingLimit, description]
 *   ["clearSessionKey"]
 *
 * The v3 packed binary "registration blob" and the verifier-params registration
 * path are gone: a v4 account installs the validator module and configures it
 * with these arrays through `createAccount` actions or a configuration intent.
 *
 * The commands are operation operands, so they follow the §4.1 grammar exactly:
 * a string is a `ByteString` of its UTF-8 bytes, a `UInt160` is a `ByteString`
 * of its stored byte order (the reverse of the display hex a caller holds), and
 * every entry is `ByteString` or `Integer`. The v3 `Hash160`/`String` kinds do
 * not exist in that grammar and are refused by the operation codec.
 *
 * The validators below mirror the contract's asserts so a malformed command
 * fails in the SDK instead of reverting on chain:
 * - public key: 33-byte compressed (02/03) or 65-byte uncompressed (04);
 * - target: nonzero 20-byte hash;
 * - method: 1..255 UTF-8 bytes;
 * - validUntil: unsigned 64-bit milliseconds, in the future at install time,
 *   at most 30 days out (the contract checks the clock, the SDK checks shape);
 * - spendingLimit: unsigned 64-bit datoshi; 0 means unlimited and is the only
 *   legal value for a non-"transfer" method (the cap is only enforceable on the
 *   value-moving transfer path);
 * - description: at most 128 UTF-8 bytes.
 *
 * Dependency-light by design: imports only the hex helpers from metaTxCore.mjs
 * so browsers and Node consume it identically.
 */

import { sanitizeHex } from './metaTxCore.mjs';

/** Command names the SessionKeyValidator dispatches on. */
export const SESSION_KEY_INSTALL_COMMAND = 'setSessionKey';
export const SESSION_KEY_CLEAR_COMMAND = 'clearSessionKey';

/** Contract-side description cap (SessionKeyValidator: "Description too long (max 128 chars)"). */
export const MAX_SESSION_KEY_DESCRIPTION_BYTES = 128;

/** Contract-side session lifetime cap: 30 days in milliseconds. */
export const MAX_SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const UINT64_MAX = (1n << 64n) - 1n;

function invalid(message) {
  const error = new Error(`session key: ${message}`);
  error.code = 'SESSION_KEY_INVALID';
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

function requirePublicKey(publicKeyHex) {
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
  return pubKey;
}

const encoder = new TextEncoder();
const utf8Hex = (text) =>
  Array.from(encoder.encode(String(text ?? '')), (byte) => byte.toString(16).padStart(2, '0')).join('');
const reverseHex = (hex) => {
  const pairs = hex.match(/../g) ?? [];
  return pairs.reverse().join('');
};

// §4.1 operands: strings are UTF-8 byte strings, a UInt160 is its stored byte order.
const textValue = (text) => ({ type: 'ByteString', value: utf8Hex(text) });
const bytesValue = (hex) => ({ type: 'ByteString', value: hex });
const hashValue = (displayHex) => ({ type: 'ByteString', value: reverseHex(displayHex) });
const integerValue = (value) => ({ type: 'Integer', value: String(value) });

/**
 * Builds the `setSessionKey` command array.
 *
 * @param {Object} options
 * @param {string} options.publicKeyHex - secp256r1 public key (33 or 65 bytes)
 * @param {string} options.targetContract - Target contract, 40-hex display
 * @param {string} options.method - Allowed method (1..255 UTF-8 bytes)
 * @param {string|number|bigint} options.validUntilMs - Expiry (Runtime.Time ms)
 * @param {string|number|bigint} [options.spendingLimitDatoshi=0] - Cap in datoshi
 * @param {string} [options.description=''] - Label, at most 128 UTF-8 bytes
 * @returns {Array} Typed VM command array for `initData` / `configData`
 */
export function buildSessionKeyInstallCommand({
  publicKeyHex,
  targetContract,
  method,
  validUntilMs,
  spendingLimitDatoshi = 0,
  description = '',
} = {}) {
  const pubKey = requirePublicKey(publicKeyHex);
  const target = sanitizeHex(targetContract);
  if (!/^[0-9a-f]{40}$/.test(target) || /^0+$/.test(target)) {
    throw invalid('target contract must be a nonzero 20-byte hash');
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
    throw invalid('spending limit only enforceable on transfer session keys');
  }
  return [
    textValue(SESSION_KEY_INSTALL_COMMAND),
    bytesValue(pubKey),
    hashValue(target),
    textValue(String(method)),
    integerValue(validUntil),
    integerValue(spendingLimit),
    textValue(String(description ?? '')),
  ];
}

/** Builds the `clearSessionKey` command array. */
export function buildSessionKeyClearCommand() {
  return [textValue(SESSION_KEY_CLEAR_COMMAND)];
}

/**
 * Builds an ERC-7715-shaped session-key permission grant alongside the
 * on-chain command. The 7715 envelope is a wallet-facing shape (signer +
 * permissions + expiry, expiry in unix seconds per 7715); the install command
 * carries the canonical Neo values (Runtime.Time milliseconds, datoshi).
 *
 * @param {Object} options - Same options as buildSessionKeyInstallCommand
 * @returns {{
 *   permission: Object,
 *   installCommand: Array,
 *   sessionKeyArgs: {publicKeyHex: string, targetContract: string, method: string,
 *     validUntilMs: string, spendingLimitDatoshi: string, description: string},
 * }} 7715-shaped request plus the command and the canonical arguments
 */
export function buildSessionKeyPermission(options = {}) {
  const installCommand = buildSessionKeyInstallCommand(options);
  const pubKey = requirePublicKey(options.publicKeyHex);
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
    installCommand,
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
