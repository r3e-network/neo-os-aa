/**
 * Error vocabulary for the Neo Smart Account v4 SDK.
 *
 * Two layers, one vocabulary:
 *
 * - `SA_*` codes are the contract's own abort reasons
 *   (`contracts/<kernel>/SmartAccount.ModuleProtocol.cs`). A VM fault reports
 *   the code as text, often as `"VM Fault: SA_NONCE_INVALID (parameter: nonce)"`,
 *   and `mapRpcError` surfaces exactly that code so callers switch on one
 *   string that the chain and the SDK agree on.
 * - `EC` codes are client-side failures that never reach the chain: bad input,
 *   RPC transport, wallet behaviour. They keep their historical
 *   `SDK_/NET_/CONTRACT_/...` prefixes.
 *
 * Nothing here renames or aliases a contract code: a code the protocol does not
 * define is not in the catalog, and an unknown `SA_*` token is passed through
 * with a generic message rather than silently accepted.
 */

/** Contract abort codes, v4 (identical in the native and custom kernels). */
const SA_ERRORS = {
  SA_PROTOCOL_VERSION: 'The operation or module protocol version is not 4',
  SA_OPERATION_MALFORMED: 'The operation envelope is structurally invalid',
  SA_OPERATION_FIELD_COUNT: 'The operation envelope does not carry exactly 13 fields',
  SA_MODULE_TYPE_UNSUPPORTED: 'The module type is not supported by this core',
  SA_MODULE_LIMIT_VALIDATOR: 'The account already holds the maximum number of validators',
  SA_MODULE_LIMIT_HOOK: 'The account already holds the maximum number of hooks',
  SA_MODULE_LIMIT_THRESHOLD: 'The threshold module holds the maximum number of members',
  SA_MODULE_LIMIT_MEMBERS: 'A threshold signature carries too many members',
  SA_MODULE_LIMIT_ACTIONS: 'A configuration intent carries too many actions',
  SA_MODULE_LIMIT_INTENTS: 'The account holds the maximum number of pending intents',
  SA_MODULE_LIMIT_BATCH: 'The operation batch exceeds the per-envelope limit',
  SA_MODULE_NOT_INSTALLED: 'The referenced module is not installed on the account',
  SA_MODULE_ID_INVALID: 'The module id is malformed or names the wrong instance',
  SA_MODULE_INSTANCE_ISOLATION_REQUIRED: 'The module must be installed per account instance',
  SA_MODULE_CODE_BINDING_MISMATCH: 'The module code no longer matches its pinned identity',
  SA_MODULE_NOT_ROUTABLE: 'The module cannot route this phase or operation',
  SA_MODULE_MESSAGE_CAPABILITY_ABSENT: 'The module does not support message authorization',
  SA_VALIDATION_REJECTED: 'The validator rejected the operation',
  SA_VALIDATOR_NOT_FOUND: 'The operation names a validator that is not installed',
  SA_HOOK_REJECTED: 'A hook rejected the operation',
  SA_HOOK_DATA_TOO_LARGE: 'Hook proofs exceed the aggregate size limit',
  SA_PROOF_INVALID: 'A hook proof or signature envelope is invalid',
  SA_NONCE_INVALID: 'The operation nonce is invalid, already used or out of range',
  SA_NONCE_EXHAUSTED: 'The nonce channel is exhausted and must be rekeyed',
  SA_NONCE_CHANNEL_COLLISION: 'Two different operation namespaces derived the same channel',
  SA_DEADLINE_EXPIRED: 'The operation deadline has passed',
  SA_EPOCH_STALE: 'The operation authority epoch is not the account authority epoch',
  SA_CONFIGURATION_NONCE_STALE: 'The operation configuration nonce is not current',
  SA_CREDENTIAL_STALE: 'The credential generation is stale for this module',
  SA_INTENT_IMMATURE: 'The configuration intent is not mature yet',
  SA_INTENT_EXPIRED: 'The configuration intent has expired',
  SA_INTENT_CONFLICT: 'A conflicting configuration intent is pending',
  SA_INTENT_NOT_FOUND: 'The configuration intent does not exist for this account',
  SA_INTENT_LIMIT: 'The configuration intent limit is reached',
  SA_ACCOUNT_NOT_FOUND: 'The account does not exist on this core',
  SA_ACCOUNT_FROZEN: 'The account is frozen',
  SA_ACCOUNT_STATUS: 'The account status does not permit this action',
  SA_RECOVERY_PENDING: 'A recovery is already pending for this account',
  SA_RECOVERY_LOCKED: 'Recovery is not available in the current account state',
  SA_REENTRANCY_FORBIDDEN: 'The call re-enters the core in a forbidden phase',
  SA_PHASE_VIOLATION: 'The call is not allowed in the current verification phase',
  SA_GAS_BUDGET_EXCEEDED: 'The bounded execution gas budget was exhausted',
  SA_MESSAGE_INVALID: 'The message envelope or signature envelope is invalid',
  SA_MIGRATION_REQUIRED: 'The account must complete migration before this action',
  SA_MARKET_LOCKED: 'The account is locked by an active market escrow',
  SA_UNAUTHORIZED: 'The caller is not authorized for this action',
};

const SA_ERROR_CODES = Object.freeze(Object.keys(SA_ERRORS));
const SA_ERROR_SET = new Set(SA_ERROR_CODES);

/** Client-side codes. None of these is ever produced by the chain. */
const EC = {
  // === Validation errors ===
  VALIDATION_RPC_URL_REQUIRED: {
    code: 'SDK_001',
    message: 'RPC URL is required for initializing the client',
  },
  VALIDATION_CONTRACT_HASH_REQUIRED: {
    code: 'SDK_002',
    message: 'Core contract hash is required for initializing the client',
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
    message: 'Invalid hex string. Expected an even number of hex characters (0-9, a-f)',
  },
  VALIDATION_PUBLIC_KEY_INVALID: {
    code: 'SDK_006',
    message:
      'Invalid public key. Expected 66 hex chars (compressed) or 130 hex chars (uncompressed)',
  },
  VALIDATION_ACCOUNT_ID_REQUIRED: {
    code: 'SDK_007',
    message: 'Account ID (seed or hash) is required',
  },
  VALIDATION_NONCE_REQUIRED: {
    code: 'SDK_008',
    message: 'Nonce is required for the signed payload',
  },
  VALIDATION_DEADLINE_REQUIRED: {
    code: 'SDK_009',
    message: 'Deadline is required for the signed payload',
  },
  VALIDATION_ARGS_HASH_INVALID: {
    code: 'SDK_010',
    message: 'Args hash must be 32 bytes (64 hex characters)',
  },
  VALIDATION_OPTIONS_REQUIRED: {
    code: 'SDK_011',
    message: 'Options object is required',
  },
  VALIDATION_OPERATION_DIGEST_INVALID: {
    code: 'SDK_012',
    message: 'Operation digest must be 32 bytes (64 hex characters)',
  },
  VALIDATION_INTEGER_DOMAIN_INVALID: {
    code: 'SDK_013',
    message: 'Integer must satisfy 0 <= value < 2^255 (NeoVM signed domain)',
  },
  VALIDATION_RECOVERY_TIMELOCK_INVALID: {
    code: 'SDK_014',
    message: 'Recovery timelock must be 604800000..7776000000 ms',
  },
  VALIDATION_SALT_INVALID: {
    code: 'SDK_015',
    message: 'Registration salt must contain 1..128 bytes',
  },

  // === Network errors ===
  NETWORK_RPC_CONNECTION_FAILED: {
    code: 'NET_001',
    message:
      'Failed to connect to RPC endpoint. Check the URL and network connectivity',
  },
  NETWORK_TIMEOUT: {
    code: 'NET_002',
    message: 'Request to RPC endpoint timed out',
  },
  NETWORK_UNAVAILABLE: {
    code: 'NET_003',
    message: 'Network unavailable. Check your internet connection',
  },

  // === Contract errors ===
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
  CONTRACT_ABI_MISMATCH: {
    code: 'CONTRACT_005',
    message: 'The deployed core does not expose the v4 module protocol ABI',
  },

  // === Account errors ===
  ACCOUNT_NOT_FOUND: {
    code: 'ACCOUNT_001',
    message: 'Account not found. The account may not be registered',
  },
  ACCOUNT_STATUS_INVALID: {
    code: 'ACCOUNT_002',
    message: 'The account status does not permit this action',
  },
  ACCOUNT_CUSTODY_REQUIRED: {
    code: 'ACCOUNT_003',
    message: 'The custody key is required for this account action',
  },

  // === Signature errors ===
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
  SIGNATURE_VALIDATOR_REQUIRED: {
    code: 'SIG_005',
    message: 'The operation must name an installed validator before it can be signed',
  },

  // === Validation preview errors ===
  VALIDATION_DEADLINE_INVALID: {
    code: 'VP_001',
    message: 'Deadline validation failed. The deadline has already passed',
  },
  VALIDATION_NONCE_UNACCEPTABLE: {
    code: 'VP_002',
    message: 'Nonce validation failed. The nonce is invalid or has been used',
  },
  VALIDATION_REJECTED: {
    code: 'VP_003',
    message: 'The core validation preview rejected the operation',
  },

  // === Operation errors ===
  OPERATION_PROXY_TRANSFER_REFUSED: {
    code: 'OP_001',
    message:
      'A token transfer out of the account proxy cannot be authorised by an owner or relay witness: the token checks the proxy as a witness, answers false and still spends the nonce and the fee. Proxy-sourced transfers need a proxy-witness transaction, whose script is one executeUserOp(s) call and whose rule is one Allow/CalledByContract(core)',
  },
  OPERATION_BATCH_EMPTY: {
    code: 'OP_002',
    message: 'An operation batch must contain 1..32 operations',
  },
  // The same verdict `shared/transferOutcome.mjs` states for the relay route and
  // the wallet: a transfer that answered false moved nothing and still spent
  // the nonce and the fee, so it is a refusal, never a silent success.
  OPERATION_TRANSFER_RETURNED_FALSE: {
    code: 'OP_003',
    message:
      'A token transfer returned false, so no tokens moved; the nonce and the fee are still spent',
  },

  // === Module errors ===
  MODULE_NOT_INSTALLED: {
    code: 'MODULE_001',
    message: 'Module not installed on the account',
  },
  MODULE_TYPE_UNSUPPORTED: {
    code: 'MODULE_002',
    message: 'Module type not supported by the contract',
  },
  MODULE_QUERY_INVALID: {
    code: 'MODULE_003',
    message: 'Module query returned a malformed descriptor',
  },

  // === Encoding errors ===
  ENCODING_HASH160_INVALID: {
    code: 'ENC_001',
    message: 'Hash160 encoding failed. Expected 20 bytes (40 hex chars)',
  },
  ENCODING_UINT256_INVALID: {
    code: 'ENC_002',
    message: 'NeoVM integer encoding failed. Value must satisfy 0 <= value < 2^255',
  },
  ENCODING_ARGS_HASH_INVALID: {
    code: 'ENC_003',
    message: 'Args hash encoding failed. Expected 32 bytes (64 hex chars)',
  },

  // === Internal errors ===
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

/** Creates a structured error object from an error code. */
function createError(errorCode, details = {}) {
  const error = new Error(errorCode.message);
  error.code = errorCode.code;
  error.details = details;
  return error;
}

/** The first contract abort code that appears in a VM fault text, if any. */
function findSaCode(value) {
  const text = typeof value === 'string' ? value : value?.message || '';
  const match = /\bSA_[A-Z][A-Z_]*\b/.exec(text);
  return match && SA_ERROR_SET.has(match[0]) ? match[0] : null;
}

/** True when `code` is one of the contract's v4 abort codes. */
function isSaError(code) {
  return typeof code === 'string' && SA_ERROR_SET.has(code);
}

/**
 * Maps an RPC/VM failure onto the v4 vocabulary. A contract abort code wins:
 * `SA_*` is the chain's own answer and must not be reinterpreted.
 */
function mapRpcError(error) {
  const errorMessage =
    typeof error === 'string' ? error : error?.exception || error?.message || '';

  const saCode = findSaCode(errorMessage);
  if (saCode) {
    return { code: saCode, message: SA_ERRORS[saCode], rpcDetail: errorMessage };
  }

  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i.test(errorMessage)) {
    return EC.NETWORK_RPC_CONNECTION_FAILED;
  }
  if (/timeout/i.test(errorMessage)) {
    return EC.NETWORK_TIMEOUT;
  }
  if (/method not found|unknown method/i.test(errorMessage)) {
    return EC.CONTRACT_METHOD_NOT_FOUND;
  }
  if (/contract not found|contract not deployed/i.test(errorMessage)) {
    return EC.CONTRACT_NOT_DEPLOYED;
  }
  if (/fault|vm error|abort/i.test(errorMessage)) {
    return { ...EC.CONTRACT_VM_FAULT, rpcDetail: errorMessage };
  }
  return null;
}

/** Formats an error for display, combining code, message and details. */
function formatError(error) {
  if (typeof error === 'string') return error;
  let message = error.message || 'Unknown error';
  if (error.code) message = `[${error.code}] ${message}`;
  if (error.details && Object.keys(error.details).length > 0) {
    message += ` (${Object.entries(error.details)
      .map(([key, value]) => `${key}=${value}`)
      .join(', ')})`;
  }
  return message;
}

module.exports = {
  SA_ERRORS,
  SA_ERROR_CODES,
  EC,
  createError,
  findSaCode,
  isSaError,
  mapRpcError,
  formatError,
};
