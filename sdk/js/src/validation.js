/**
 * Input validation utilities for the Neo Abstract Account SDK.
 * Provides validation for addresses, hashes, hex strings, and public keys.
 */

const { EC, createError } = require('./errors');

/**
 * Validates a Neo address format.
 * @param {string} address - The address to validate
 * @throws {Error} If the address is invalid
 * @returns {boolean} True if valid
 */
function validateNeoAddress(address) {
  if (!address || typeof address !== 'string') {
    throw createError(EC.VALIDATION_ADDRESS_INVALID, { provided: address });
  }

  // Neo address format: N followed by Base58 encoded string
  // Total length is 34 characters (including the 'N' prefix)
  if (!/^N[a-zA-Z0-9]{33}$/.test(address)) {
    throw createError(EC.VALIDATION_ADDRESS_INVALID, {
      provided: address,
      hint: 'Expected format: N followed by 33 Base58 characters',
    });
  }

  return true;
}

/**
 * Validates a Hash160 (20-byte script hash).
 * @param {string} hash - The hash to validate
 * @throws {Error} If the hash is invalid
 * @returns {boolean} True if valid
 */
function validateHash160(hash) {
  if (!hash || typeof hash !== 'string') {
    throw createError(EC.VALIDATION_HASH160_INVALID, { provided: hash });
  }

  const cleanHash = hash.replace(/^0x/i, '');

  if (!/^[0-9a-f]{40}$/i.test(cleanHash)) {
    throw createError(EC.VALIDATION_HASH160_INVALID, {
      provided: hash,
      hint: 'Expected 40 hex characters (20 bytes), optionally with 0x prefix',
    });
  }

  return true;
}

/**
 * Validates a hex string.
 * @param {string} hex - The hex string to validate
 * @param {Object} options - Validation options
 * @param {number} options.byteLength - Expected byte length (optional)
 * @param {number} options.minLength - Minimum byte length (optional)
 * @param {number} options.maxLength - Maximum byte length (optional)
 * @throws {Error} If the hex string is invalid
 * @returns {boolean} True if valid
 */
function validateHexString(hex, options = {}) {
  if (!hex || typeof hex !== 'string') {
    throw createError(EC.VALIDATION_HEX_STRING_INVALID, { provided: hex });
  }

  const cleanHex = hex.replace(/^0x/i, '');

  if (!/^[0-9a-f]*$/i.test(cleanHex)) {
    throw createError(EC.VALIDATION_HEX_STRING_INVALID, {
      provided: hex,
      hint: 'Expected only hex characters (0-9, a-f)',
    });
  }

  if (cleanHex.length % 2 !== 0) {
    throw createError(EC.VALIDATION_HEX_STRING_INVALID, {
      provided: hex,
      hint: 'Expected even number of hex characters',
    });
  }

  const byteLength = cleanHex.length / 2;

  if (options.byteLength !== undefined && byteLength !== options.byteLength) {
    throw createError(EC.VALIDATION_HEX_STRING_INVALID, {
      provided: hex,
      hint: `Expected ${options.byteLength} bytes, got ${byteLength}`,
    });
  }

  if (options.minLength !== undefined && byteLength < options.minLength) {
    throw createError(EC.VALIDATION_HEX_STRING_INVALID, {
      provided: hex,
      hint: `Expected at least ${options.minLength} bytes, got ${byteLength}`,
    });
  }

  if (options.maxLength !== undefined && byteLength > options.maxLength) {
    throw createError(EC.VALIDATION_HEX_STRING_INVALID, {
      provided: hex,
      hint: `Expected at most ${options.maxLength} bytes, got ${byteLength}`,
    });
  }

  return true;
}

/**
 * Validates a public key for secp256k1 or secp256r1.
 * @param {string} publicKey - The public key to validate
 * @param {Object} options - Validation options
 * @param {'secp256k1'|'secp256r1'} options.curve - Elliptic curve to validate against
 * @throws {Error} If the public key is invalid
 * @returns {boolean} True if valid
 */
function validatePublicKey(publicKey, options = {}) {
  if (!publicKey || typeof publicKey !== 'string') {
    throw createError(EC.VALIDATION_PUBLIC_KEY_INVALID, { provided: publicKey });
  }

  const cleanKey = publicKey.replace(/^0x/i, '');

  // Compressed: 65 bytes (04 + 64 bytes X,Y) or 33 bytes (02/03 prefix + 32 bytes)
  // For Neo, compressed format is typically 33 bytes (02/03 prefix)
  // Uncompressed: 65 bytes (04 prefix + 32 bytes X + 32 bytes Y)

  const isCompressed = /^[0-9a-f]{66}$/i.test(cleanKey) ||
                       (cleanKey.length === 66 && /^[0-9a-f]{66}$/i.test(cleanKey));

  const isUncompressed = cleanKey.length === 130 && /^04[0-9a-f]{128}$/i.test(cleanKey);

  if (!isCompressed && !isUncompressed) {
    throw createError(EC.VALIDATION_PUBLIC_KEY_INVALID, {
      provided: publicKey,
      hint: 'Expected 66 hex chars (compressed) or 130 hex chars (uncompressed)',
    });
  }

  // Validate curve prefix if specified
  if (options.curve) {
    const prefix = cleanKey.substring(0, 2);
    if (isCompressed) {
      // secp256k1: 02 (even Y), 03 (odd Y)
      // secp256r1: same prefixes
      if (!['02', '03'].includes(prefix)) {
        throw createError(EC.VALIDATION_PUBLIC_KEY_INVALID, {
          provided: publicKey,
          hint: 'Compressed public key must start with 02 or 03',
        });
      }
    }
  }

  return true;
}

/**
 * Validates an account ID (seed or hash).
 * @param {string} accountId - The account ID to validate
 * @throws {Error} If the account ID is invalid
 * @returns {boolean} True if valid
 */
function validateAccountId(accountId) {
  if (!accountId || typeof accountId !== 'string' || accountId.trim() === '') {
    throw createError(EC.VALIDATION_ACCOUNT_ID_REQUIRED, { provided: accountId });
  }

  // Can be a hex string (40 chars for hash) or any non-empty string for seed
  const cleanId = accountId.replace(/^0x/i, '');

  if (cleanId.length === 40 && !/^[0-9a-f]{40}$/i.test(cleanId)) {
    throw createError(EC.VALIDATION_HASH160_INVALID, {
      provided: accountId,
      hint: 'If 40 chars, must be valid hex for account hash',
    });
  }

  return true;
}

/**
 * Validates an address or hash160 for owner fields.
 * Accepts both Neo addresses and hex hashes for flexibility.
 * @param {string} addressOrHash - Address or hash to validate
 * @throws {Error} If the value is invalid
 * @returns {boolean} True if valid
 */
function validateAddressOrHash160(addressOrHash) {
  if (!addressOrHash || typeof addressOrHash !== 'string') {
    return true; // Empty is allowed (optional field)
  }

  const clean = addressOrHash.trim();

  // Check if it's a Neo address
  if (/^N[a-zA-Z0-9]{33}$/.test(clean)) {
    validateNeoAddress(clean);
    return true;
  }

  // Check if it's a hex hash
  const hex = clean.replace(/^0x/i, '');
  if (hex.length === 40) {
    validateHash160(hex);
    return true;
  }

  return true; // Accept other formats for flexibility
}

/**
 * Validates nonce and deadline presence for EIP-712 payloads.
 * The shared typed-data builders perform the NeoVM signed-integer range check
 * before producing a payload; this helper only handles required-field errors.
 *
 * @param {number|string} nonce - The nonce to validate
 * @param {number|string} deadline - The deadline to validate
 * @throws {Error} If either value is invalid
 * @returns {Object} Normalized nonce and deadline
 */
function validateEIP712Fields(nonce, deadline) {
  if (nonce == null || nonce === '') {
    throw createError(EC.VALIDATION_NONCE_REQUIRED);
  }

  if (deadline == null || deadline === '') {
    throw createError(EC.VALIDATION_DEADLINE_REQUIRED);
  }

  const limit = 1n << 255n;
  let normalizedNonce;
  let normalizedDeadline;
  try {
    normalizedNonce = BigInt(nonce);
    normalizedDeadline = BigInt(deadline);
  } catch {
    throw createError(EC.ENCODING_UINT256_INVALID, {
      provided: { nonce, deadline },
      hint: 'Nonce and deadline must be integer values in the NeoVM signed domain',
    });
  }
  if (normalizedNonce < 0n || normalizedNonce >= limit
      || normalizedDeadline < 0n || normalizedDeadline >= limit) {
    throw createError(EC.ENCODING_UINT256_INVALID, {
      provided: { nonce, deadline },
      hint: 'Expected 0 <= nonce, deadline < 2^255 for the NeoVM signed Integer domain',
    });
  }

  return {
    nonce: normalizedNonce.toString(),
    deadline: normalizedDeadline.toString(),
  };
}

/**
 * Validates that an options object is provided and has required fields.
 * @param {Object} options - The options to validate
 * @param {string[]} requiredFields - Required field names
 * @throws {Error} If validation fails
 * @returns {boolean} True if valid
 */
function validateOptions(options, requiredFields = []) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { provided: options });
  }

  const missing = requiredFields.filter(field => !(field in options));
  if (missing.length > 0) {
    throw createError(EC.VALIDATION_OPTIONS_REQUIRED, {
      missingFields: missing.join(', '),
      hint: `Required fields: ${requiredFields.join(', ')}`,
    });
  }

  return true;
}

/**
 * Sanitizes a hex string by removing 0x prefix and converting to lowercase.
 * @param {string} hex - The hex string to sanitize
 * @returns {string} Sanitized hex string
 */
function sanitizeHex(hex) {
  return String(hex || '').replace(/^0x/i, '').toLowerCase();
}

/**
 * Validates an RPC URL format.
 * @param {string} url - The URL to validate
 * @throws {Error} If the URL is invalid
 * @returns {boolean} True if valid
 */
function validateRpcUrl(url) {
  if (!url || typeof url !== 'string') {
    throw createError(EC.VALIDATION_RPC_URL_REQUIRED, { provided: url });
  }

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw createError(EC.VALIDATION_RPC_URL_REQUIRED, {
        provided: url,
        hint: 'Only http and https protocols are supported',
      });
    }
  } catch (e) {
    throw createError(EC.VALIDATION_RPC_URL_REQUIRED, { provided: url });
  }

  return true;
}

module.exports = {
  validateNeoAddress,
  validateHash160,
  validateHexString,
  validatePublicKey,
  validateAccountId,
  validateAddressOrHash160,
  validateEIP712Fields,
  validateOptions,
  validateRpcUrl,
  sanitizeHex,
};
