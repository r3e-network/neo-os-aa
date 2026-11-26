/**
 * Shared stack-item decoders and EIP-712-style typed-data builders for the
 * Neo N3 Smart Account v4 stack.
 *
 * Single source of truth for the shapes the SDK (sdk/js/src/metaTx.js), the
 * relay route and the wallet frontend decode, and for the secp256k1 signing
 * payload the Web3AuthValidator verifies (contracts/plugins/validators/
 * Web3AuthValidator.cs). A layout change happens here and nowhere else.
 *
 * The v4 typed data signs the core's §4.3 operation digest plus the context
 * that binds it to the account, the core and one validator instance:
 *
 *   UserOperation(bytes20 accountId, bytes20 coreContract, uint64 validatorId,
 *     address targetContract, string method, bytes32 argsHash, uint256 nonce,
 *     uint256 deadline, bytes32 operationDigest)
 *   domain: "Neo Smart Account" / version "4" / chainId / verifyingContract = module
 *
 * The domain version is the module protocol version: signatures over the v3
 * "1" domain are invalid and there is no dual-domain verification.
 *
 * Dependency-light by design: no imports; keccak256 is injected and base64
 * decoding falls back from Buffer (Node) to atob (browsers).
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
 * uses the same big-endian display form that all SDK and frontend hash inputs
 * accept.
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

function arrayValues(item, length) {
  const values = item?.type === 'Array' && Array.isArray(item.value) ? item.value : [];
  return length === undefined || values.length === length ? values : [];
}

const ACCOUNT_STATUS_NAMES = ['Active', 'Frozen'];

/**
 * Decodes the 9-field v4.1 `getAccount` descriptor (docs/SA-SPEC.zh-CN.md §9).
 *
 * [exists, status, custody, authorityEpoch, configurationNonce,
 *  defaultOperationAuthorization, defaultMessageAuthorization,
 *  requiredValidatorId, controlRevision]
 *
 * The v4.0 recovery authority, recovery timelock, hook-order revision,
 * recovery-pending and market-escrow fields are gone: recovery is a user-space
 * module, so its policy and pending request are read from the recovery seat.
 *
 * @param {Object} item - Array stack item from getAccount
 * @returns {Object|null} Descriptor, or null for a missing account
 */
export function decodeAccountDescriptorStack(item) {
  if (item?.type === 'Null' || item == null) return null;
  const values = arrayValues(item, 9);
  if (values.length === 0) return null;
  if (!decodeStackBoolean(values[0])) return null;
  const status = Number(decodeIntegerStack(values[1]));
  return {
    exists: true,
    status,
    statusName: ACCOUNT_STATUS_NAMES[status] ?? '',
    custody: decodeHash160Stack(values[2]),
    authorityEpoch: decodeIntegerStack(values[3]).toString(),
    configurationNonce: decodeIntegerStack(values[4]).toString(),
    defaultOperationAuthorization: decodeStackBoolean(values[5]),
    defaultMessageAuthorization: decodeStackBoolean(values[6]),
    requiredValidatorId: decodeIntegerStack(values[7]).toString(),
    controlRevision: decodeIntegerStack(values[8]).toString(),
  };
}

/**
 * Decodes the 15-field v4.1 `getModule` descriptor.
 *
 * [moduleId, moduleType, contractHash, contractId, updateCounter, nefSha256,
 *  profileSha256, moduleRevision, credentialGeneration, instanceIsolation,
 *  messageCapability, thresholdMemberEligible, compositeLayer, governance,
 *  hookPlanner]
 *
 * @param {Object} item - Array stack item from getModule
 * @returns {Object|null} Descriptor, or null for a missing module
 */
export function decodeModuleDescriptorStack(item) {
  const values = arrayValues(item, 15);
  if (values.length === 0) return null;
  return {
    moduleId: decodeIntegerStack(values[0]).toString(),
    moduleType: Number(decodeIntegerStack(values[1])),
    contractHash: decodeHash160Stack(values[2]),
    contractId: decodeIntegerStack(values[3]).toString(),
    updateCounter: decodeIntegerStack(values[4]).toString(),
    nefSha256: decodeByteStringStackHex(values[5]),
    profileSha256: decodeByteStringStackHex(values[6]),
    moduleRevision: decodeIntegerStack(values[7]).toString(),
    credentialGeneration: decodeIntegerStack(values[8]).toString(),
    instanceIsolation: decodeStackBoolean(values[9]),
    messageCapability: decodeStackBoolean(values[10]),
    thresholdMemberEligible: decodeStackBoolean(values[11]),
    compositeLayer: decodeStackBoolean(values[12]),
    governance: decodeStackBoolean(values[13]),
    hookPlanner: decodeStackBoolean(values[14]),
  };
}

/**
 * Decodes the `validateUserOp` result: [accepted, operationDigest].
 *
 * The digest is the core's §4.3 digest. Clients MUST compare it to their own
 * locally computed digest before signing or broadcasting.
 *
 * @param {Object} item - Array stack item from validateUserOp
 * @returns {{ accepted: boolean, operationDigest: string }}
 */
export function decodeValidationPreviewStack(item) {
  const values = arrayValues(item, 2);
  return {
    accepted: decodeStackBoolean(values[0]),
    operationDigest: decodeByteStringStackHex(values[1]),
  };
}

/**
 * Decodes the `getRecoveryStatus` result.
 *
 * @param {Object} item - Array stack item from getRecoveryStatus
 * @returns {Object|null} Recovery status, or null when no recovery is pending
 */
export function decodeRecoveryStatusStack(item) {
  const values = item?.type === 'Array' && Array.isArray(item.value) ? item.value : [];
  if (values.length === 0) return null;
  // RecoveryModule v4.1 answers its twelve-field request record, or an empty
  // Array when no request exists.
  if (values.length !== 12) return null;
  return {
    pending: Number(decodeIntegerStack(values[4])) === 1,
    nonce: decodeIntegerStack(values[0]).toString(),
    initiatedAt: decodeIntegerStack(values[2]).toString(),
    matureAt: decodeIntegerStack(values[3]).toString(),
    authorityEpochAtInit: decodeIntegerStack(values[6]).toString(),
    configurationNonceAtInit: decodeIntegerStack(values[7]).toString(),
    newCustody: decodeHash160Stack(values[5]),
    policyRevision: decodeIntegerStack(values[9]).toString(),
  };
}

/**
 * Validation-error kinds raised by the typed-data builders. Consumers may map
 * these onto their own error systems via the createError option of
 * createMetaTxBuilders().
 */
const CORE_ERRORS = {
  NONCE_REQUIRED: {
    code: 'METATX_NONCE_REQUIRED',
    message: 'Nonce is required for the EIP-712 payload',
  },
  DEADLINE_REQUIRED: {
    code: 'METATX_DEADLINE_REQUIRED',
    message: 'Deadline is required for the EIP-712 payload',
  },
  ARGS_HASH_INVALID: {
    code: 'METATX_ARGS_HASH_INVALID',
    message: 'Args hash must be 32 bytes (64 hex characters)',
  },
  OPERATION_DIGEST_INVALID: {
    code: 'METATX_OPERATION_DIGEST_INVALID',
    message: 'Operation digest must be 32 bytes (64 hex characters)',
  },
  CORE_CONTRACT_REQUIRED: {
    code: 'METATX_CORE_CONTRACT_REQUIRED',
    message: 'SA core contract is required for the v4 payload binding',
  },
  INTEGER_DOMAIN_INVALID: {
    code: 'METATX_INTEGER_DOMAIN_INVALID',
    message: 'Nonce and deadline must be non-negative NeoVM signed integers below 2^255',
  },
};

const NEO_SIGNED_INTEGER_LIMIT = 1n << 255n;
const UINT64_LIMIT = 1n << 64n;
export const USER_OPERATION_DOMAIN_NAME = 'Neo Smart Account';
export const USER_OPERATION_DOMAIN_VERSION = '4';

function defaultCreateError(kind, details = {}) {
  const spec = CORE_ERRORS[kind];
  const error = new Error(spec.message);
  error.code = spec.code;
  error.details = details;
  return error;
}

/**
 * Creates the v4 typed-data builder with an injected keccak256.
 *
 * @param {Object} options
 * @param {Function} options.keccak256 - keccak256(Uint8Array) returning a
 *   0x-prefixed 32-byte hex string (e.g. ethers.keccak256)
 * @param {Function} [options.createError] - Optional (kind, details) => Error
 * @returns {{ buildUserOperationTypedData: Function }}
 */
export function createMetaTxBuilders({ keccak256, createError = defaultCreateError } = {}) {
  if (typeof keccak256 !== 'function') {
    throw new TypeError('createMetaTxBuilders requires a keccak256(bytes) implementation');
  }

  const utf8Encoder = new TextEncoder();

  function requireSignedFields({ nonce, deadline, argsHashHex, operationDigest }) {
    if (nonce == null) throw createError('NONCE_REQUIRED', {});
    if (deadline == null) throw createError('DEADLINE_REQUIRED', {});
    for (const [field, value] of [['nonce', nonce], ['deadline', deadline]]) {
      let integer;
      try {
        integer = BigInt(value);
      } catch {
        throw createError('INTEGER_DOMAIN_INVALID', { field, provided: value });
      }
      if (integer < 0n || integer >= NEO_SIGNED_INTEGER_LIMIT) {
        throw createError('INTEGER_DOMAIN_INVALID', {
          field,
          provided: value,
          hint: 'Expected 0 <= value < 2^255 for the NeoVM signed Integer domain',
        });
      }
    }
    const argsHash = sanitizeHex(argsHashHex);
    if (argsHash.length !== 64) {
      throw createError('ARGS_HASH_INVALID', {
        provided: argsHashHex,
        hint: `Expected 64 hex chars, got ${argsHash.length}`,
      });
    }
    const digest = sanitizeHex(operationDigest);
    if (digest.length !== 64) {
      throw createError('OPERATION_DIGEST_INVALID', {
        provided: operationDigest,
        hint: `Expected 64 hex chars, got ${digest.length}`,
      });
    }
    return { argsHash, digest };
  }

  /**
   * Builds the EIP-712-style typed data the Web3AuthValidator (and any
   * secp256k1 signer) signs for one operation routed to one validator instance.
   *
   * @param {Object} options
   * @param {string|number} options.chainId - Network magic
   * @param {string} options.verifyingContract - Validator (module) script hash
   * @param {string} options.accountId - 40-hex account id
   * @param {string} options.coreContractHash - 40-hex authorized SA core
   * @param {string|number} options.validatorId - Module instance id
   * @param {string} options.targetContract - 40-hex operation target
   * @param {string} options.method - Operation method
   * @param {string} options.argsHashHex - keccak256(StdLib.Serialize(args))
   * @param {string|number} options.nonce - Packed 255-bit operation nonce
   * @param {string|number} options.deadline - Deadline (Runtime.Time ms)
   * @param {string} options.operationDigest - Core §4.3 digest
   * @returns {Object} EIP-712 typed data structure
   */
  function buildUserOperationTypedData({
    chainId,
    verifyingContract,
    accountId,
    coreContractHash,
    validatorId,
    targetContract,
    method,
    argsHashHex,
    nonce,
    deadline,
    operationDigest,
  }) {
    const { argsHash, digest } = requireSignedFields({ nonce, deadline, argsHashHex, operationDigest });
    if (!coreContractHash) throw createError('CORE_CONTRACT_REQUIRED', {});
    let validator;
    try {
      validator = BigInt(validatorId ?? 0);
    } catch {
      throw createError('INTEGER_DOMAIN_INVALID', { field: 'validatorId', provided: validatorId });
    }
    if (validator < 0n || validator >= UINT64_LIMIT) {
      throw createError('INTEGER_DOMAIN_INVALID', { field: 'validatorId', provided: validatorId });
    }
    return {
      domain: {
        name: USER_OPERATION_DOMAIN_NAME,
        version: USER_OPERATION_DOMAIN_VERSION,
        chainId,
        verifyingContract: `0x${sanitizeHex(verifyingContract)}`,
      },
      types: {
        UserOperation: [
          { name: 'accountId', type: 'bytes20' },
          { name: 'coreContract', type: 'bytes20' },
          { name: 'validatorId', type: 'uint64' },
          { name: 'targetContract', type: 'address' },
          { name: 'method', type: 'string' },
          { name: 'argsHash', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'operationDigest', type: 'bytes32' },
        ],
      },
      message: {
        accountId: `0x${sanitizeHex(accountId)}`,
        coreContract: `0x${sanitizeHex(coreContractHash)}`,
        validatorId: validator.toString(),
        targetContract: `0x${sanitizeHex(targetContract)}`,
        method: String(method || ''),
        argsHash: `0x${argsHash}`,
        nonce: String(nonce),
        deadline: String(deadline),
        operationDigest: `0x${digest}`,
      },
    };
  }

  /** keccak256 of the UTF-8 method name, the struct's `method` field is a string. */
  function methodHash(method) {
    return keccak256(utf8Encoder.encode(String(method || '')));
  }

  return {
    buildUserOperationTypedData,
    methodHash,
  };
}
