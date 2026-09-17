const { ethers } = require('ethers');
const { EC, createError } = require('./errors');
// Shared meta-tx core (single source of truth for the EIP-712 typed-data
// layouts and the stack-item decode helpers; also consumed by the frontend).
const metaTxCore = require('../../../shared/metaTxCore.mjs');

const {
  sanitizeHex,
  decodeByteStringStackHex,
  decodeIntegerStack,
  decodeStackBoolean,
  decodeHash160Stack,
  decodeValidationPreviewStack,
} = metaTxCore;

/**
 * Maps the shared core's validation-error kinds onto SDK error codes so the
 * builders keep throwing the exact errors this SDK has always thrown.
 */
const CORE_ERROR_CODES = {
  NONCE_REQUIRED: EC.VALIDATION_NONCE_REQUIRED,
  DEADLINE_REQUIRED: EC.VALIDATION_DEADLINE_REQUIRED,
  ARGS_HASH_INVALID: EC.VALIDATION_ARGS_HASH_INVALID,
  CORE_CONTRACT_REQUIRED: EC.VALIDATION_OPTIONS_REQUIRED,
};

/**
 * EIP-712 typed-data builders, delegated to the shared core.
 *
 * buildMetaTransactionTypedData builds the legacy MetaTransaction layout;
 * buildV3UserOperationTypedData builds the V3 UserOperation layout. Both
 * validate nonce/deadline presence and the 32-byte args hash, throwing SDK
 * errors (SDK_008/SDK_009/SDK_010) on failure.
 */
const {
  buildMetaTransactionTypedData,
  buildV3UserOperationTypedData,
} = metaTxCore.createMetaTxBuilders({
  keccak256: ethers.keccak256,
  createError: (kind, details) => createError(CORE_ERROR_CODES[kind], details),
});

/**
 * Converts a Hash160 to a 32-byte word (20 bytes right-padded with zeros).
 * Matches Web3AuthVerifier.ToBytes20Word in contract.
 *
 * The input is big-endian display hex and is copied as-is — no client-side
 * byte reversal. The contract's UInt160 is little-endian internally and its
 * ToBytes20Word reverses to big-endian, so both sides already agree.
 *
 * @param {string} hash160 - 20-byte hash (40 hex chars, big-endian display hex)
 * @returns {Uint8Array} 32-byte word: 20 big-endian bytes then 12 zero bytes
 * @private
 */
function toBytes20Word(hash160) {
  const clean = sanitizeHex(hash160);
  if (clean.length !== 40) {
    throw createError(EC.ENCODING_HASH160_INVALID, {
      provided: hash160,
      hint: 'Expected 40 hex chars (20 bytes)',
    });
  }
  const source = Buffer.from(clean, 'hex');
  const result = new Uint8Array(32);
  // Input is already big-endian (neon-js display format). Contract's UInt160
  // is little-endian internally and ToBytes20Word reverses to big-endian.
  // Both sides must produce the same big-endian result, so we just right-pad.
  for (let i = 0; i < 20; i++) {
    result[i] = source[i];
  }
  return result;
}

/**
 * Converts a Hash160 to a 32-byte EVM address word (left-padded with zeros).
 * Matches Web3AuthVerifier.ToAddressWord in contract.
 *
 * The input is big-endian display hex and is copied as-is — no client-side
 * byte reversal. The contract's UInt160 is little-endian internally and its
 * ToAddressWord reverses to big-endian, so both sides already agree.
 *
 * @param {string} hash160 - 20-byte hash (40 hex chars, big-endian display hex)
 * @returns {Uint8Array} 32-byte word: 12 zero bytes then 20 big-endian bytes
 * @private
 */
function toAddressWord(hash160) {
  const clean = sanitizeHex(hash160);
  if (clean.length !== 40) {
    throw createError(EC.ENCODING_HASH160_INVALID, {
      provided: hash160,
      hint: 'Expected 40 hex chars (20 bytes)',
    });
  }
  const address = Buffer.from(clean, 'hex');
  const result = new Uint8Array(32);
  // Input is already big-endian (neon-js display format). Contract's UInt160
  // is little-endian internally and ToAddressWord reverses to big-endian.
  // Both sides must produce the same big-endian result, so just left-pad.
  for (let i = 0; i < 20; i++) {
    result[12 + i] = address[i];
  }
  return result;
}

/**
 * Converts a number to 32-byte big-endian uint256 word.
 * Matches Web3AuthVerifier.ToUint256Word in contract.
 *
 * @param {number|string|bigint} value - The value to encode
 * @returns {Uint8Array} 32-byte big-endian uint256
 * @private
 */
function toUint256Word(value) {
  const bigintValue = BigInt(value);
  if (bigintValue < 0n) {
    throw createError(EC.ENCODING_UINT256_INVALID, {
      provided: value,
      hint: 'Value must be non-negative',
    });
  }
  const result = new Uint8Array(32);
  // Convert to big-endian: least significant byte at position 31
  let remaining = bigintValue;
  for (let i = 0; i < 32 && remaining > 0n; i++) {
    result[31 - i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

/**
 * Type hash for EIP-712 domain.
 * Pre-computed keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
 * — the canonical 4-field domain type hash; the preimage below includes the
 * name and version hashes accordingly.
 */
const EIP712_DOMAIN_TYPE_HASH = new Uint8Array([
  0x8b, 0x73, 0xc3, 0xc6, 0x9b, 0xb8, 0xfe, 0x3d,
  0x51, 0x2e, 0xcc, 0x4c, 0xf7, 0x59, 0xcc, 0x79,
  0x23, 0x9f, 0x7b, 0x17, 0x9b, 0x0f, 0xfa, 0xca,
  0xa9, 0xa7, 0x5d, 0x52, 0x2b, 0x39, 0x40, 0x0f,
]);

/**
 * Pre-computed keccak256 of "Neo N3 Abstract Account" name.
 */
const EIP712_NAME_HASH = new Uint8Array([
  0x2e, 0x3d, 0x38, 0xea, 0x00, 0x55, 0xad, 0x99,
  0xb5, 0x57, 0x2e, 0x06, 0x66, 0x58, 0x43, 0x1f,
  0xf4, 0xc4, 0x0d, 0xba, 0xf3, 0xe1, 0x6e, 0x21,
  0x54, 0x63, 0x9d, 0xc6, 0xe2, 0x63, 0x48, 0x03,
]);

/**
 * Pre-computed keccak256 of "1" version.
 */
const EIP712_VERSION_HASH = new Uint8Array([
  0xc8, 0x9e, 0xfd, 0xaa, 0x54, 0xc0, 0xf2, 0x0c,
  0x7a, 0xdf, 0x61, 0x28, 0x82, 0xdf, 0x09, 0x50,
  0xf5, 0xa9, 0x51, 0x63, 0x7e, 0x03, 0x07, 0xcd,
  0xcb, 0x4c, 0x67, 0x2f, 0x29, 0x8b, 0x8b, 0xc6,
]);

/**
 * Type hash for UserOperation struct.
 * Pre-computed keccak256("UserOperation(bytes20 accountId,bytes20 coreContract,address targetContract,string method,bytes32 argsHash,uint256 nonce,uint256 deadline)")
 */
const USER_OPERATION_TYPE_HASH = new Uint8Array([
  0x57, 0x7a, 0x3a, 0x6b, 0xd9, 0x16, 0x83, 0xe3,
  0x00, 0xe8, 0x14, 0xcd, 0x25, 0xff, 0x62, 0x47,
  0xab, 0x7c, 0xa2, 0x73, 0xdd, 0xd0, 0x15, 0x3a,
  0x99, 0x91, 0x9d, 0x72, 0xdd, 0xf9, 0xfa, 0x04,
]);

/**
 * Builds the contract-compatible domain separator hash.
 * Matches Web3AuthVerifier.BuildDomainSeparator in contract.
 *
 * @param {number|string|bigint} network - The network magic/chain ID
 * @param {string} verifyingContract - The verifier contract hash (40 hex chars)
 * @returns {string} 32-byte domain separator hash (hex string)
 */
function buildContractCompatibleDomainSeparator(network, verifyingContract) {
  const encoded = new Uint8Array(
    EIP712_DOMAIN_TYPE_HASH.length +
    EIP712_NAME_HASH.length +
    EIP712_VERSION_HASH.length +
    32 + // uint256 network
    32 // address verifyingContract
  );

  let offset = 0;
  encoded.set(EIP712_DOMAIN_TYPE_HASH, offset);
  offset += EIP712_DOMAIN_TYPE_HASH.length;
  encoded.set(EIP712_NAME_HASH, offset);
  offset += EIP712_NAME_HASH.length;
  encoded.set(EIP712_VERSION_HASH, offset);
  offset += EIP712_VERSION_HASH.length;
  encoded.set(toUint256Word(network), offset);
  offset += 32;
  encoded.set(toAddressWord(verifyingContract), offset);

  return ethers.keccak256(encoded);
}

/**
 * Builds the contract-compatible struct hash for UserOperation.
 * Matches Web3AuthVerifier.BuildMetaTxStructHash in contract.
 *
 * This function replicates the contract's custom encoding:
 * - Uses raw keccak256 of method string (not EIP-712 string encoding)
 * - Right-pads the big-endian accountId and AA core bytes to 32 bytes (ToBytes20Word)
 * - Left-pads the big-endian targetContract bytes to 32 bytes (ToAddressWord)
 * - Uses big-endian encoding for nonce/deadline
 *
 * All Hash160 inputs are big-endian display hex; no client-side byte
 * reversal is performed (the contract reverses its internal little-endian
 * form, so both sides already agree).
 *
 * @param {Object} options - Struct hash options
 * @param {string} options.accountIdHash - Account ID hash (40 hex chars)
 * @param {string} options.coreContractHash - Authorized AA core hash (40 hex chars)
 * @param {string} options.targetContract - Target contract hash (40 hex chars)
 * @param {string} options.method - Method name
 * @param {string} options.argsHash - Serialized args hash (32 bytes, 64 hex chars)
 * @param {number|string|bigint} options.nonce - Nonce value
 * @param {number|string|bigint} options.deadline - Deadline in Neo Runtime.Time milliseconds
 * @returns {string} 32-byte struct hash (hex string with 0x prefix)
 *
 * @throws {Error} If any parameter is invalid
 *
 * @example
 * ```javascript
 * const structHash = buildContractCompatibleStructHash({
 *   accountIdHash: 'f951...hash',
 *   coreContractHash: 'dbf3...hash',
 *   targetContract: '49c0...hash',
 *   method: 'transfer',
 *   argsHash: '0xabcd...hash',
 *   nonce: 0,
 *   deadline: Date.now() + 3600_000,
 * });
 *
 * // Create the 66-byte signing payload (0x1901 || domainSeparator || structHash)
 * const payload = buildWeb3AuthSigningPayload({
 *   chainId, verifierHash, accountIdHash, coreContractHash, targetContract,
 *   method, argsHash, nonce, deadline,
 * });
 *
 * // Sign the raw keccak256 digest — the contract verifies keccak256(payload)
 * // with NO EIP-191 prefix, and expects a 64-byte r||s signature.
 * const digest = ethers.keccak256(payload);
 * const sig = wallet.signingKey.sign(digest);
 * const signature = sanitizeHex(sig.r) + sanitizeHex(sig.s);
 * ```
 */
function buildContractCompatibleStructHash({
  accountIdHash,
  coreContractHash,
  targetContract,
  method,
  argsHash,
  nonce,
  deadline,
}) {
  // Validate inputs
  const cleanAccountId = sanitizeHex(accountIdHash);
  const cleanTarget = sanitizeHex(targetContract);
  const cleanArgsHash = sanitizeHex(argsHash);

  if (cleanAccountId.length !== 40) {
    throw createError(EC.ENCODING_HASH160_INVALID, {
      provided: accountIdHash,
      hint: 'accountIdHash must be 40 hex chars (20 bytes)',
    });
  }
  const cleanCoreContract = sanitizeHex(coreContractHash);
  if (cleanCoreContract.length !== 40) {
    throw createError(EC.ENCODING_HASH160_INVALID, {
      provided: coreContractHash,
      hint: 'coreContractHash must be 40 hex chars (20 bytes)',
    });
  }
  if (cleanTarget.length !== 40) {
    throw createError(EC.ENCODING_HASH160_INVALID, {
      provided: targetContract,
      hint: 'targetContract must be 40 hex chars (20 bytes)',
    });
  }
  if (cleanArgsHash.length !== 64) {
    throw createError(EC.ENCODING_ARGS_HASH_INVALID, {
      provided: argsHash,
      hint: 'argsHash must be 64 hex chars (32 bytes)',
    });
  }

  // Compute method hash using raw keccak256 of method string bytes
  // Contract does: NativeCryptoLib.Keccak256((ByteString)op.Method)
  const methodBytes = ethers.toUtf8Bytes(String(method));
  const methodHash = ethers.keccak256(methodBytes);

  // Build struct payload matching contract's concatenation order:
  // keccak256(UserOperationTypeHash || ToBytes20Word(accountId) ||
  //   ToBytes20Word(coreContract) || ToAddressWord(targetContract) ||
  //   keccak256(method) ||
  //   keccak256(serializedArgs) || ToUint256Word(nonce) ||
  //   ToUint256Word(deadline))
  const payload = ethers.concat([
    USER_OPERATION_TYPE_HASH,
    toBytes20Word(cleanAccountId),
    toBytes20Word(cleanCoreContract),
    toAddressWord(cleanTarget),
    methodHash,
    `0x${cleanArgsHash}`,
    toUint256Word(nonce),
    toUint256Word(deadline),
  ]);

  return ethers.keccak256(payload);
}

/**
 * Creates the complete EIP-712 signing payload for Web3Auth verification.
 * Combines domain separator with struct hash using 0x1901 prefix.
 *
 * @param {Object} options - EIP-712 payload options
 * @param {number|string|bigint} options.chainId - Network chain ID
 * @param {string} options.verifierHash - Verifier contract hash (40 hex chars)
 * @param {string} options.accountIdHash - Account ID hash (40 hex chars)
 * @param {string} options.coreContractHash - Authorized AA core hash (40 hex chars)
 * @param {string} options.targetContract - Target contract hash (40 hex chars)
 * @param {string} options.method - Method name
 * @param {string} options.argsHash - Args hash (32 bytes, 64 hex chars)
 * @param {number|string|bigint} options.nonce - Nonce value
 * @param {number|string|bigint} options.deadline - Deadline in Neo Runtime.Time milliseconds
 * @returns {Uint8Array} 66-byte payload (0x1901 + domainSep(32) + structHash(32))
 */
function buildWeb3AuthSigningPayload({
  chainId,
  verifierHash,
  accountIdHash,
  coreContractHash,
  targetContract,
  method,
  argsHash,
  nonce,
  deadline,
}) {
  const domainSeparator = ethers.getBytes(
    buildContractCompatibleDomainSeparator(chainId, verifierHash)
  );
  const structHash = ethers.getBytes(
    buildContractCompatibleStructHash({
      accountIdHash,
      coreContractHash,
      targetContract,
      method,
      argsHash,
      nonce,
      deadline,
    })
  );

  // 0x19 0x01 || domainSeparator || structHash
  const payload = new Uint8Array(2 + domainSeparator.length + structHash.length);
  payload[0] = 0x19;
  payload[1] = 0x01;
  payload.set(domainSeparator, 2);
  payload.set(structHash, 2 + domainSeparator.length);

  return payload;
}

module.exports = {
  sanitizeHex,
  decodeByteStringStackHex,
  decodeIntegerStack,
  decodeStackBoolean,
  decodeHash160Stack,
  decodeValidationPreviewStack,
  buildMetaTransactionTypedData,
  buildV3UserOperationTypedData,
  buildContractCompatibleStructHash,
  buildContractCompatibleDomainSeparator,
  buildWeb3AuthSigningPayload,
  toBytes20Word,
  toAddressWord,
  toUint256Word,
};
