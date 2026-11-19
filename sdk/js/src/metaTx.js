/**
 * SDK wrappers around the shared v4 meta-transaction core.
 *
 * Two signing surfaces, one struct:
 *
 * - `buildUserOperationTypedData` is the wallet-facing EIP-712 typed data
 *   (domain "Neo Smart Account"/"4", verifying contract = the validator module).
 * - `buildUserOperationSigningPayload` is the exact 66-byte
 *   `0x1901 ‖ domainSeparator ‖ structHash` the contract's
 *   Web3AuthValidator.BuildPayload returns and verifies with secp256k1.
 *
 * Both are derived from the same typed data, so a signature made through an
 * EIP-712 wallet and one made over `keccak256(payload)` are the same signature.
 * The v3 layouts (MetaTransaction, 7-field UserOperation, version "1" domain)
 * are gone: the validator rejects them and this module no longer produces them.
 */

const { ethers } = require('ethers');
const { EC, createError } = require('./errors');
const metaTxCore = require('../../../shared/metaTxCore.mjs');

const {
  sanitizeHex,
  decodeByteStringStackHex,
  decodeIntegerStack,
  decodeStackBoolean,
  decodeHash160Stack,
  decodeValidationPreviewStack,
  decodeAccountDescriptorStack,
  decodeModuleDescriptorStack,
  decodeRecoveryStatusStack,
  USER_OPERATION_DOMAIN_NAME,
  USER_OPERATION_DOMAIN_VERSION,
} = metaTxCore;

/** Maps the shared core's validation-error kinds onto SDK error codes. */
const CORE_ERROR_CODES = {
  NONCE_REQUIRED: EC.VALIDATION_NONCE_REQUIRED,
  DEADLINE_REQUIRED: EC.VALIDATION_DEADLINE_REQUIRED,
  ARGS_HASH_INVALID: EC.VALIDATION_ARGS_HASH_INVALID,
  OPERATION_DIGEST_INVALID: EC.VALIDATION_OPERATION_DIGEST_INVALID,
  CORE_CONTRACT_REQUIRED: EC.VALIDATION_CONTRACT_HASH_REQUIRED,
  INTEGER_DOMAIN_INVALID: EC.ENCODING_UINT256_INVALID,
};

const { buildUserOperationTypedData, methodHash } = metaTxCore.createMetaTxBuilders({
  keccak256: ethers.keccak256,
  createError: (kind, details) => createError(CORE_ERROR_CODES[kind], details),
});

const requireHash160 = (value, label) => {
  const clean = sanitizeHex(value);
  if (clean.length !== 40) {
    throw createError(EC.ENCODING_HASH160_INVALID, {
      provided: value,
      hint: `${label} must be 40 hex chars (20 bytes)`,
    });
  }
  return clean;
};

/** Hash160 to a 32-byte word right-padded with zeros (contract ToBytes20Word). */
function toBytes20Word(hash160) {
  const clean = requireHash160(hash160, 'hash160');
  const result = new Uint8Array(32);
  result.set(Buffer.from(clean, 'hex'), 0);
  return result;
}

/** Hash160 to a 32-byte EVM address word left-padded with zeros (ToAddressWord). */
function toAddressWord(hash160) {
  const clean = requireHash160(hash160, 'hash160');
  const result = new Uint8Array(32);
  result.set(Buffer.from(clean, 'hex'), 12);
  return result;
}

/** NeoVM signed-domain integer to a 32-byte big-endian word (ToUint256Word). */
function toUint256Word(value) {
  const integer = BigInt(value);
  if (integer < 0n || integer >= 1n << 255n) {
    throw createError(EC.ENCODING_UINT256_INVALID, {
      provided: value,
      hint: 'Value must satisfy 0 <= value < 2^255 for the NeoVM signed Integer domain',
    });
  }
  const result = new Uint8Array(32);
  let remaining = integer;
  for (let i = 0; i < 32 && remaining > 0n; i++) {
    result[31 - i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

/**
 * The exact bytes the Web3AuthValidator verifies: 0x1901, the EIP-712 domain
 * separator and the UserOperation struct hash.
 *
 * @returns {Uint8Array} 66 bytes
 */
function buildUserOperationSigningPayload(options = {}) {
  const typed = buildUserOperationTypedData(options);
  const domainSeparator = ethers.TypedDataEncoder.hashDomain(typed.domain);
  const structHash = ethers.TypedDataEncoder.from(typed.types).hash(typed.message);
  return ethers.getBytes(ethers.concat(['0x1901', domainSeparator, structHash]));
}

/** keccak256 of the signing payload: the 32 bytes a raw secp256k1 signer signs. */
function buildUserOperationSigningDigest(options = {}) {
  return ethers.keccak256(buildUserOperationSigningPayload(options));
}

module.exports = {
  USER_OPERATION_DOMAIN_NAME,
  USER_OPERATION_DOMAIN_VERSION,
  sanitizeHex,
  decodeByteStringStackHex,
  decodeIntegerStack,
  decodeStackBoolean,
  decodeHash160Stack,
  decodeValidationPreviewStack,
  decodeAccountDescriptorStack,
  decodeModuleDescriptorStack,
  decodeRecoveryStatusStack,
  buildUserOperationTypedData,
  buildUserOperationSigningPayload,
  buildUserOperationSigningDigest,
  methodHash,
  toBytes20Word,
  toAddressWord,
  toUint256Word,
};
