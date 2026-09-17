/**
 * Shared meta-transaction core for the Neo N3 Abstract Account stack.
 *
 * Single source of truth for the EIP-712 typed-data layouts and the Neo RPC
 * stack-item decode helpers that were previously duplicated between the CJS
 * SDK (sdk/js/src/metaTx.js) and the frontend
 * (frontend/src/features/operations/metaTx.js). The typed data built here is
 * the exact structure the verifier contracts hash and check signatures
 * against, so any layout change MUST happen here and nowhere else.
 *
 * Dependency-light by design: this module has no imports. keccak256 (needed
 * for the legacy MetaTransaction methodHash) is injected by each consumer
 * through createMetaTxBuilders(), and base64 decoding falls back from Buffer
 * (Node) to atob (browsers).
 *
 * Consumers:
 * - sdk/js/src/metaTx.js (CJS; loads this synchronous ESM graph via require)
 * - frontend/src/features/operations/metaTx.js (ESM, relative import; the
 *   frontend vite config also aliases the repo root as `@repo` and allows it
 *   in server.fs, so the module is reachable as @repo/shared/metaTxCore.mjs)
 */

/**
 * Sanitizes a hex string by removing the 0x prefix and lowercasing.
 *
 * @param {string} value - The hex string to sanitize
 * @returns {string} Sanitized hex string
 */
export function sanitizeHex(value) {
  return String(value || '').replace(/^0x/i, '').toLowerCase();
}

/**
 * Reverses the byte order of an even-length hex string.
 *
 * @param {string} hex - Hex string (no 0x prefix, even length)
 * @returns {string} Byte-reversed hex string
 */
export function reverseHex(hex) {
  const pairs = String(hex || '').match(/.{2}/g);
  return pairs ? pairs.reverse().join('') : '';
}

/**
 * Decodes a base64 string to lowercase hex. Uses Buffer when available
 * (Node) and falls back to atob (browsers).
 *
 * Both are read through globalThis on purpose: a free `Buffer` identifier
 * would make bundler node-polyfill plugins inject a shim import into this
 * file, which cannot resolve from outside the frontend package.
 *
 * @param {string} value - Base64-encoded bytes
 * @returns {string} Lowercase hex string
 * @private
 */
function base64ToHex(value) {
  if (!value) return '';
  if (typeof globalThis.Buffer !== 'undefined') {
    return globalThis.Buffer.from(value, 'base64').toString('hex').toLowerCase();
  }
  const binary = globalThis.atob ? globalThis.atob(value) : '';
  return Array.from(binary, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

/**
 * Decodes a ByteString stack item to a lowercase hex string.
 *
 * @param {Object} item - Stack item from an RPC response
 * @returns {string} Decoded hex string (lowercase), '' when not a ByteString
 */
export function decodeByteStringStackHex(item) {
  if (!item || item.type !== 'ByteString' || !item.value) return '';
  return base64ToHex(item.value);
}

/**
 * Decodes an Integer stack item to a BigInt.
 *
 * @param {Object} item - Stack item from an RPC response
 * @returns {bigint} Decoded integer, 0n when not an Integer
 */
export function decodeIntegerStack(item) {
  if (!item || item.type !== 'Integer' || item.value == null) return 0n;
  return BigInt(item.value);
}

/**
 * Decodes a stack item to a boolean value.
 *
 * @param {Object} item - Stack item from an RPC response
 * @returns {boolean} Boolean value
 */
export function decodeStackBoolean(item) {
  return item?.value === true
    || item?.value === 1
    || item?.value === '1'
    || item?.value === 'true'
    || item?.value === 'True';
}

/**
 * Decodes a Hash160 stack item to big-endian display hex.
 *
 * Real nodes return UInt160 values as ByteString stack items carrying the
 * internal little-endian bytes; this helper reverses them so every output
 * uses the same big-endian display form (e.g. 0xb4107cb2...) that all SDK
 * and frontend hash inputs accept.
 *
 * @param {Object} item - Stack item from an RPC response
 * @returns {string} 40-character big-endian display hex string, '' when empty
 */
export function decodeHash160Stack(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'Hash160' && item.value) return sanitizeHex(item.value);
  if (item.type === 'ByteString' && item.value) {
    const rawHex = base64ToHex(item.value);
    return rawHex ? sanitizeHex(reverseHex(rawHex)) : '';
  }
  return '';
}

/**
 * Decodes a previewUserOpValidation result stack item.
 *
 * @param {Object} item - Array stack item from previewUserOpValidation
 * @returns {Object} Preview with deadlineValid, nonceAcceptable, hasVerifier,
 *   verifier and hook (big-endian display hex)
 */
export function decodeValidationPreviewStack(item) {
  const values = item?.type === 'Array' && Array.isArray(item.value) ? item.value : [];
  return {
    deadlineValid: decodeStackBoolean(values[0]),
    nonceAcceptable: decodeStackBoolean(values[1]),
    hasVerifier: decodeStackBoolean(values[2]),
    verifier: decodeHash160Stack(values[3]),
    hook: decodeHash160Stack(values[4]),
  };
}

/**
 * Validation-error kinds raised by the typed-data builders. Consumers may
 * map these onto their own error systems via the createError option of
 * createMetaTxBuilders().
 */
const CORE_ERRORS = {
  NONCE_REQUIRED: {
    code: 'METATX_NONCE_REQUIRED',
    message: 'Nonce is required for EIP-712 payload',
  },
  DEADLINE_REQUIRED: {
    code: 'METATX_DEADLINE_REQUIRED',
    message: 'Deadline is required for EIP-712 payload',
  },
  ARGS_HASH_INVALID: {
    code: 'METATX_ARGS_HASH_INVALID',
    message: 'Args hash must be 32 bytes (64 hex characters)',
  },
  CORE_CONTRACT_REQUIRED: {
    code: 'METATX_CORE_CONTRACT_REQUIRED',
    message: 'AA core contract is required for V3 payload binding',
  },
};

/**
 * Default error factory: a plain Error carrying a stable code and details.
 *
 * @param {string} kind - One of the CORE_ERRORS keys
 * @param {Object} details - Additional details for the failure
 * @returns {Error} Error with code and details attached
 * @private
 */
function defaultCreateError(kind, details = {}) {
  const spec = CORE_ERRORS[kind];
  const error = new Error(spec.message);
  error.code = spec.code;
  error.details = details;
  return error;
}

/**
 * Creates the EIP-712 typed-data builders with an injected keccak256.
 *
 * @param {Object} options - Factory options
 * @param {Function} options.keccak256 - keccak256(Uint8Array) returning a
 *   0x-prefixed 32-byte hex string (e.g. ethers.keccak256)
 * @param {Function} [options.createError] - Optional (kind, details) => Error
 *   factory used for validation failures; kinds are NONCE_REQUIRED,
 *   DEADLINE_REQUIRED and ARGS_HASH_INVALID
 * @returns {{
 *   buildMetaTransactionTypedData: Function,
 *   buildV3UserOperationTypedData: Function,
 * }} The typed-data builders
 */
export function createMetaTxBuilders({ keccak256, createError = defaultCreateError } = {}) {
  if (typeof keccak256 !== 'function') {
    throw new TypeError('createMetaTxBuilders requires a keccak256(bytes) implementation');
  }

  const utf8Encoder = new TextEncoder();

  /**
   * Validates the signature-critical fields shared by both layouts.
   * Carries the SDK validation guards: nonce and deadline must be present
   * and the args hash must be exactly 32 bytes.
   *
   * @returns {string} Sanitized 64-hex-char args hash
   * @private
   */
  function requireSignedFields({ nonce, deadline, argsHashHex }) {
    if (nonce == null) throw createError('NONCE_REQUIRED', {});
    if (deadline == null) throw createError('DEADLINE_REQUIRED', {});
    const sanitized = sanitizeHex(argsHashHex);
    if (sanitized.length !== 64) {
      throw createError('ARGS_HASH_INVALID', {
        provided: argsHashHex,
        hint: `Expected 64 hex chars, got ${sanitized.length}`,
      });
    }
    return sanitized;
  }

  /**
   * Builds the EIP-712 typed data for a legacy MetaTransaction.
   * Compatible with the legacy account-binding format.
   *
   * @param {Object} options - Typed data options
   * @param {string|number} options.chainId - Chain ID for the EIP-712 domain
   * @param {string} options.verifyingContract - Verifying contract hash (40 hex chars)
   * @param {string} [options.accountAddressScriptHash] - Account script hash (legacy)
   * @param {string} [options.accountAddressHash] - Account address hash (legacy)
   * @param {string} options.targetContract - Target contract hash (40 hex chars)
   * @param {string} options.method - Method name
   * @param {string} options.argsHashHex - Args hash (32 bytes, 64 hex chars)
   * @param {string|number} options.nonce - Nonce value
   * @param {string|number} options.deadline - Deadline in Neo Runtime.Time milliseconds
   * @returns {Object} EIP-712 typed data structure
   * @throws {Error} If nonce/deadline are missing or the args hash is invalid
   */
  function buildMetaTransactionTypedData({
    chainId,
    verifyingContract,
    accountAddressScriptHash,
    accountAddressHash,
    targetContract,
    method,
    argsHashHex,
    nonce,
    deadline,
  }) {
    const sanitizedArgsHash = requireSignedFields({ nonce, deadline, argsHashHex });
    return {
      domain: {
        name: 'Neo N3 Abstract Account',
        version: '1',
        chainId,
        verifyingContract: `0x${sanitizeHex(verifyingContract)}`,
      },
      types: {
        MetaTransaction: [
          { name: 'accountAddress', type: 'address' },
          { name: 'targetContract', type: 'address' },
          { name: 'methodHash', type: 'bytes32' },
          { name: 'argsHash', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      message: {
        accountAddress: `0x${sanitizeHex(accountAddressScriptHash || accountAddressHash)}`,
        targetContract: `0x${sanitizeHex(targetContract)}`,
        methodHash: keccak256(utf8Encoder.encode(String(method || ''))),
        argsHash: `0x${sanitizedArgsHash}`,
        nonce: String(nonce),
        deadline: String(deadline),
      },
    };
  }

  /**
   * Builds the EIP-712 typed data for a V3 UserOperation.
   * Uses accountId-based verification (V3 format).
   *
   * @param {Object} options - Typed data options
   * @param {string|number} options.chainId - Chain ID for the EIP-712 domain
   * @param {string} options.verifyingContract - Verifier contract hash (40 hex chars)
 * @param {string} options.accountIdHash - Account ID hash (40 hex chars)
 * @param {string} options.coreContractHash - Authorized AA core hash (40 hex chars)
   * @param {string} options.targetContract - Target contract hash (40 hex chars)
   * @param {string} options.method - Method name
   * @param {string} options.argsHashHex - Args hash (32 bytes, 64 hex chars)
   * @param {string|number} options.nonce - Nonce value
   * @param {string|number} options.deadline - Deadline in Neo Runtime.Time milliseconds
   * @returns {Object} EIP-712 typed data structure
   * @throws {Error} If nonce/deadline are missing or the args hash is invalid
   */
  function buildV3UserOperationTypedData({
    chainId,
    verifyingContract,
    accountIdHash,
    coreContractHash,
    targetContract,
    method,
    argsHashHex,
    nonce,
    deadline,
  }) {
    const sanitizedArgsHash = requireSignedFields({ nonce, deadline, argsHashHex });
    if (!coreContractHash) throw createError('CORE_CONTRACT_REQUIRED', {});
    return {
      domain: {
        name: 'Neo N3 Abstract Account',
        version: '1',
        chainId,
        verifyingContract: `0x${sanitizeHex(verifyingContract)}`,
      },
      types: {
        UserOperation: [
          { name: 'accountId', type: 'bytes20' },
          { name: 'coreContract', type: 'bytes20' },
          { name: 'targetContract', type: 'address' },
          { name: 'method', type: 'string' },
          { name: 'argsHash', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      message: {
        accountId: `0x${sanitizeHex(accountIdHash)}`,
        coreContract: `0x${sanitizeHex(coreContractHash)}`,
        targetContract: `0x${sanitizeHex(targetContract)}`,
        method: String(method || ''),
        argsHash: `0x${sanitizedArgsHash}`,
        nonce: String(nonce),
        deadline: String(deadline),
      },
    };
  }

  return {
    buildMetaTransactionTypedData,
    buildV3UserOperationTypedData,
  };
}
