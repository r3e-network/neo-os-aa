/**
 * Error codes for the Neo Abstract Account SDK.
 * Each error code maps to a specific failure mode with descriptive messages.
 */

const EC = {
  // === Validation Errors ===
  VALIDATION_RPC_URL_REQUIRED: {
    code: 'SDK_001',
    message: 'RPC URL is required for initializing the client',
  },
  VALIDATION_CONTRACT_HASH_REQUIRED: {
    code: 'SDK_002',
    message: 'Master contract hash is required for initializing the client',
  },
  VALIDATION_ADDRESS_INVALID: {
    code: 'SDK_003',
    message: 'Invalid Neo address. Expected format: N[a-zA-Z0-9]{33}',
  },
  VALIDATION_HASH160_INVALID: {
    code: 'SDK_004',
    message: 'Invalid Hash160. Expected 40 hex characters (20 bytes)',
  },
  VALIDATION_HEX_STRING_INVALID: {
    code: 'SDK_005',
    message: 'Invalid hex string. Expected even number of hex characters (0-9, a-f)',
  },
  VALIDATION_PUBLIC_KEY_INVALID: {
    code: 'SDK_006',
    message: 'Invalid public key. Expected 66 hex chars (compressed) or 130 hex chars (uncompressed)',
  },
  VALIDATION_ACCOUNT_ID_REQUIRED: {
    code: 'SDK_007',
    message: 'Account ID (seed or hash) is required',
  },
  VALIDATION_NONCE_REQUIRED: {
    code: 'SDK_008',
    message: 'Nonce is required for EIP-712 payload',
  },
  VALIDATION_DEADLINE_REQUIRED: {
    code: 'SDK_009',
    message: 'Deadline is required for EIP-712 payload',
  },
  VALIDATION_ARGS_HASH_INVALID: {
    code: 'SDK_010',
    message: 'Args hash must be 32 bytes (64 hex characters)',
  },
  VALIDATION_OPTIONS_REQUIRED: {
    code: 'SDK_011',
    message: 'Options object is required',
  },

  // === Network Errors ===
  NETWORK_RPC_CONNECTION_FAILED: {
    code: 'NET_001',
    message: 'Failed to connect to RPC endpoint. Check the URL and network connectivity',
  },
  NETWORK_TIMEOUT: {
    code: 'NET_002',
    message: 'Request to RPC endpoint timed out',
  },
  NETWORK_UNAVAILABLE: {
    code: 'NET_003',
    message: 'Network unavailable. Check your internet connection',
  },

  // === Contract Errors ===
  CONTRACT_INVOCATION_FAILED: {
    code: 'CONTRACT_001',
    message: 'Contract invocation failed',
  },
  CONTRACT_VM_FAULT: {
    code: 'CONTRACT_002',
    message: 'VM fault during contract execution',
  },
  CONTRACT_METHOD_NOT_FOUND: {
    code: 'CONTRACT_003',
    message: 'Contract method not found',
  },
  CONTRACT_NOT_DEPLOYED: {
    code: 'CONTRACT_004',
    message: 'Contract not deployed or not found at specified hash',
  },

  // === Account Errors ===
  ACCOUNT_NOT_FOUND: {
    code: 'ACCOUNT_001',
    message: 'Account not found. The account may not be registered',
  },
  ACCOUNT_NO_VERIFIER: {
    code: 'ACCOUNT_002',
    message: 'No verifier configured for this account. A verifier is required for signing',
  },
  ACCOUNT_VERIFIER_NOT_CONFIGURED: {
    code: 'ACCOUNT_003',
    message: 'No verifier is configured for this V3 account',
  },
  ACCOUNT_MISSING_BINDING: {
    code: 'ACCOUNT_004',
    message: 'createEIP712Payload requires an accountIdHash or accountAddress',
  },

  // === Signature Errors ===
  SIGNATURE_VERIFICATION_FAILED: {
    code: 'SIG_001',
    message: 'Signature verification failed',
  },
  SIGNATURE_INVALID: {
    code: 'SIG_002',
    message: 'Invalid signature format',
  },
  SIGNATURE_EXPIRED: {
    code: 'SIG_003',
    message: 'Signature deadline has expired',
  },
  SIGNATURE_NONCE_INVALID: {
    code: 'SIG_004',
    message: 'Invalid nonce. The nonce has already been used or is out of range',
  },

  // === Validation Preview Errors ===
  VALIDATION_DEADLINE_INVALID: {
    code: 'VP_001',
    message: 'Deadline validation failed. The deadline has already passed',
  },
  VALIDATION_NONCE_UNACCEPTABLE: {
    code: 'VP_002',
    message: 'Nonce validation failed. The nonce is invalid or has been used',
  },
  VALIDATION_NO_VERIFIER: {
    code: 'VP_003',
    message: 'No verifier configured for validation',
  },

  // === Operation Errors ===
  OPERATION_PROXY_TRANSFER_REFUSED: {
    code: 'OP_001',
    message: 'A token transfer out of the account proxy address cannot be authorised by an owner or relay witness: the token checks the proxy address as a witness and answers false, and the nonce and the fee are still spent. It needs a proxy-witness transaction, which also requires the contract admin to set the account verify scope target',
  },

  // === Module Errors ===
  MODULE_NOT_INSTALLED: {
    code: 'MODULE_001',
    message: 'Module not installed on the account',
  },
  MODULE_TYPE_UNSUPPORTED: {
    code: 'MODULE_002',
    message: 'Module type not supported by the contract',
  },
  MODULE_INSTALL_FAILED: {
    code: 'MODULE_003',
    message: 'Failed to install module',
  },
  MODULE_UPDATE_FAILED: {
    code: 'MODULE_004',
    message: 'Failed to update module',
  },
  MODULE_REMOVE_FAILED: {
    code: 'MODULE_005',
    message: 'Failed to remove module',
  },

  // === Legacy V2 Errors ===
  LEGACY_V3_REMOVED: {
    code: 'LEGACY_001',
    message: 'Removed in V3: role-based admin/manager discovery no longer exists',
  },

  // === Encoding Errors ===
  ENCODING_HASH160_INVALID: {
    code: 'ENC_001',
    message: 'Hash160 encoding failed. Expected 20 bytes (40 hex chars)',
  },
  ENCODING_UINT256_INVALID: {
    code: 'ENC_002',
    message: 'Uint256 encoding failed. Value must be non-negative',
  },
  ENCODING_ARGS_HASH_INVALID: {
    code: 'ENC_003',
    message: 'Args hash encoding failed. Expected 32 bytes (64 hex chars)',
  },

  // === Internal Errors ===
  INTERNAL_REPO_ROOT_NOT_FOUND: {
    code: 'INT_001',
    message: 'Unable to locate repository root from specified directory',
  },
  INTERNAL_SUBSCRIPTION_CLOSED: {
    code: 'INT_002',
    message: 'Event subscription is closed',
  },
  INTERNAL_EVENT_NAME_REQUIRED: {
    code: 'INT_003',
    message: 'Event name is required for subscription',
  },
  INTERNAL_FROM_BLOCK_REQUIRED: {
    code: 'INT_004',
    message: 'fromBlock is required for getPastEvents',
  },
};

/**
 * Creates a structured error object from an error code.
 * @param {Object} errorCode - The error code object from EC
 * @param {Object} details - Additional details to include
 * @returns {Error} An Error object with code, message, and details
 */
function createError(errorCode, details = {}) {
  const error = new Error(errorCode.message);
  error.code = errorCode.code;
  error.details = details;
  return error;
}

/**
 * Maps RPC error patterns to SDK error codes.
 * @param {string|Object} error - The error from RPC call
 * @returns {Object|null} Mapped error code or null
 */
function mapRpcError(error) {
  const errorMessage = typeof error === 'string' ? error : error?.message || '';

  // Network-related errors
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(errorMessage)) {
    return EC.NETWORK_RPC_CONNECTION_FAILED;
  }
  if (/timeout/i.test(errorMessage)) {
    return EC.NETWORK_TIMEOUT;
  }

  // Contract-related errors
  if (/fault|vm error|abort/i.test(errorMessage)) {
    return { ...EC.CONTRACT_VM_FAULT, rpcDetail: errorMessage };
  }
  if (/method not found|unknown method/i.test(errorMessage)) {
    return { ...EC.CONTRACT_METHOD_NOT_FOUND, rpcDetail: errorMessage };
  }
  if (/contract not found|contract not deployed/i.test(errorMessage)) {
    return EC.CONTRACT_NOT_DEPLOYED;
  }

  return null;
}

/**
 * Formats an error for display, combining error code with context.
 * @param {Error|string} error - The error to format
 * @returns {string} Formatted error message
 */
function formatError(error) {
  if (typeof error === 'string') {
    return error;
  }

  let message = error.message || 'Unknown error';
  if (error.code) {
    message = `[${error.code}] ${message}`;
  }
  if (error.details && Object.keys(error.details).length > 0) {
    const detailStr = Object.entries(error.details)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    message += ` (${detailStr})`;
  }
  return message;
}

module.exports = {
  EC,
  createError,
  mapRpcError,
  formatError,
};
