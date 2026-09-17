const { rpc, sc, u, wallet } = require('./neonCompat');
const metaTxExports = require('./metaTx');
const { withRetry } = require('./retry');
const { EC, createError, mapRpcError, formatError } = require('./errors');
const {
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
} = require('./validation');
// Shared registration account-id deriver (single source of truth for the
// payload layout and byte-order conventions; also consumed by the frontend).
const { createRegistrationAccountIdDeriver } = require('../../../shared/registrationAccountId.mjs');

const registrationAccountIdDeriver = createRegistrationAccountIdDeriver({
  hash160: (value) => sanitizeHex(u.hash160(value)),
});

/**
 * Normalizes an address or contract hash to a 40-character hex string.
 * Handles both Neo addresses (N-prefixed) and hex hashes.
 *
 * @param {string} addressHex - Neo address or contract hash
 * @returns {string} 40-character hex string
 * @throws {Error} If address is invalid
 * @private
 */
function normalizeAddress(addressHex) {
  if (!addressHex) {
    throw createError(EC.VALIDATION_ADDRESS_INVALID);
  }

  const clean = addressHex.trim();
  let hex = clean;

  // Check if it's a Neo address (N-prefixed Base58)
  if (clean.startsWith('N') && clean.length === 34) {
    validateNeoAddress(clean);
    return wallet.getScriptHashFromAddress(clean).toLowerCase();
  }

  // Remove 0x prefix
  if (hex.startsWith('0x')) hex = hex.slice(2);

  // Validate as Hash160
  validateHash160(hex);

  return hex.toLowerCase();
}

/**
 * Decodes a ByteString stack item to UTF-8 text.
 *
 * @param {Object} item - Stack item from RPC response
 * @returns {string} Decoded text
 * @private
 */
function decodeByteStringStackText(item) {
  if (!item) return '';
  if (item.type === 'ByteString' && item.value) {
    return Buffer.from(item.value, 'base64').toString('utf8');
  }
  if (item.type === 'String' && item.value) {
    return String(item.value);
  }
  return '';
}

// Stack-item decode helpers shared with the frontend via shared/metaTxCore.mjs.
const { decodeStackBoolean, decodeHash160Stack, decodeValidationPreviewStack } = metaTxExports;

const DEFAULT_RPC_READ_RETRY_ATTEMPTS = 4;
const DEFAULT_RPC_READ_RETRY_DELAY_MS = 250;

/**
 * Retries transient RPC read failures.
 *
 * Thin wrapper over the shared withRetry helper (src/retry.js) so the SDK
 * uses a single retryable-error classification everywhere, while keeping the
 * historical read-path profile: 4 attempts with fast sub-second backoff.
 *
 * @param {Function} fn - The RPC call to retry
 * @param {number} attempts - Maximum attempts (default 4)
 * @returns {Promise<*>} Result of fn
 * @private
 */
function invokeRpcReadWithRetry(fn, attempts = DEFAULT_RPC_READ_RETRY_ATTEMPTS) {
  return withRetry('rpc read', () => fn(), {
    maxAttempts: attempts,
    baseDelayMs: DEFAULT_RPC_READ_RETRY_DELAY_MS,
    backoffMultiplier: 2,
    maxDelayMs: 1000,
  });
}

/**
 * Neo N3 Abstract Account SDK Client.
 *
 * The SDK provides methods for:
 * - Creating and managing abstract accounts
 * - Building UserOperations for signing
 * - Validating operations before submission
 * - Managing verifiers and hooks
 *
 * @example
 * ```javascript
 * const { AbstractAccountClient } = require('neo-abstract-account');
 *
 * const client = new AbstractAccountClient(
 *   'https://rpc.example.com',
 *   '0x1234...40chars'
 * );
 *
 * // Derive a virtual account address
 * const account = client.deriveVirtualAccount('0x04...seed');
 * console.log('Account address:', account.address);
 *
 * // Create a new account registration payload
 * const payload = client.createAccountPayload({
 *   verifierContractHash: '0xabcd...verifier',
 *   hookContractHash: '0xef01...hook',
 *   backupOwnerAddress: '0x1234...owner',
 * });
 * ```
 */
class AbstractAccountClient {
  /**
   * Creates a new AbstractAccountClient instance.
   *
   * @param {string} rpcUrl - RPC endpoint URL (http:// or https://)
   * @param {string} masterContractHash - Master contract hash (40 hex chars)
   * @throws {Error} If RPC URL or contract hash is invalid
   */
  constructor(rpcUrl, masterContractHash) {
    validateRpcUrl(rpcUrl);
    this.rpcClient = new rpc.RPCClient(rpcUrl);
    this.masterContractHash = sanitizeHex(masterContractHash);
  }

  async invokeScriptWithRetry(script, signers = []) {
    return invokeRpcReadWithRetry(() => this.rpcClient.invokeScript(script, signers));
  }

  async invokeFunctionWithRetry(scriptHash, operation, params = [], signers = undefined) {
    return invokeRpcReadWithRetry(() => this.rpcClient.invokeFunction(scriptHash, operation, params, signers));
  }

  /**
   * Builds the verification script for an account.
   *
   * @param {string} accountIdHex - Account ID hash (40 hex chars)
   * @returns {string} Verification script hex
   */
  buildVerifyScript(accountIdHex) {
    const normalizedAccountId = this.deriveAccountIdHash(accountIdHex);
    const byteLength = normalizedAccountId.length / 2;

    return [
      '0c',
      byteLength.toString(16).padStart(2, '0'),
      sanitizeHex(u.reverseHex(normalizedAccountId)),
      '11c01f0c06766572696679',
      '0c14',
      sanitizeHex(u.reverseHex(this.masterContractHash)),
      '41627d5b52',
    ].join('');
  }

  /**
   * Derives the account ID hash from a seed or existing hash.
   *
   * @param {string} accountIdHexOrSeed - Account ID hex or seed string
   * @returns {string} 40-character account ID hash
   * @throws {Error} If account seed is empty
   */
  deriveAccountIdHash(accountIdHexOrSeed) {
    const normalized = sanitizeHex(accountIdHexOrSeed || '');
    if (!normalized) {
      throw createError(EC.VALIDATION_ACCOUNT_ID_REQUIRED);
    }
    if (/^[0-9a-f]{40}$/i.test(normalized)) {
      return normalized;
    }
    return sanitizeHex(u.hash160(normalized));
  }

  /**
   * Derives the registration-bound account ID hash used by V3 account creation.
   *
   * Returns the big-endian display form, identical to the on-chain
   * ComputeRegistrationAccountId display string and exactly what
   * registerAccount expects as its Hash160 accountId argument. The payload
   * layout is single-sourced in shared/registrationAccountId.mjs with the
   * frontend; address/hash normalization keeps this SDK's validation errors.
   *
   * @param {Object} options - Registration options
   * @param {string} [options.verifierContractHash=''] - Verifier contract hash
   * @param {string} [options.verifierParamsHex=''] - Verifier parameters hex
   * @param {string} [options.hookContractHash=''] - Hook contract hash
   * @param {string} options.backupOwnerAddress - Backup owner address or hash160
   * @param {number} [options.escapeTimelock=2592000] - Escape hatch timelock in seconds
   * @returns {string} 40-character account ID hash (big-endian display form)
   */
  deriveRegistrationAccountIdHash(options = {}) {
    const {
      verifierContractHash = '',
      verifierParamsHex = '',
      hookContractHash = '',
      backupOwnerAddress,
      escapeTimelock = 30 * 24 * 60 * 60,
    } = options;

    const backupOwner = normalizeAddress(backupOwnerAddress);
    const verifierHash = verifierContractHash ? normalizeAddress(verifierContractHash) : '';
    const hookHash = hookContractHash ? normalizeAddress(hookContractHash) : '';

    return registrationAccountIdDeriver.deriveRegistrationAccountIdDisplayHex({
      backupOwnerHash160: backupOwner,
      verifierHash160: verifierHash,
      hookHash160: hookHash,
      escapeTimelock,
      verifierParamsHex,
    });
  }

  /**
   * Derives a virtual account from an account seed.
   *
   * @param {string} accountIdSeedHex - Account seed (hex or string)
   * @returns {Object} Virtual account details
   * @returns {string} returns.accountIdHash - 40-character hash
   * @returns {string} returns.verifyScript - Verification script
   * @returns {string} returns.scriptHash - Script hash
   * @returns {string} returns.address - Neo address
   */
  deriveVirtualAccount(accountIdSeedHex) {
    const accountIdHash = this.deriveAccountIdHash(accountIdSeedHex);
    const verifyScript = this.buildVerifyScript(accountIdHash);
    const scriptHash = sanitizeHex(u.reverseHex(u.hash160(verifyScript)));
    const address = wallet.getAddressFromScriptHash(scriptHash);
    return {
      accountIdHash,
      verifyScript,
      scriptHash,
      address,
    };
  }

  /**
   * Derives an Abstract Account Neo address from an EVM public key.
   *
   * @param {string} uncompressedPubKey - Uncompressed public key (130 hex chars or with 0x prefix)
   * @returns {string} Neo address
   * @throws {Error} If public key is invalid
   */
  deriveAddressFromEVM(uncompressedPubKey) {
    let pubKeyHex = uncompressedPubKey;
    if (pubKeyHex.startsWith('0x')) pubKeyHex = pubKeyHex.slice(2);

    // Validate public key format
    if (pubKeyHex.length !== 130 || !/^[0-9a-f]{130}$/i.test(pubKeyHex)) {
      throw createError(EC.VALIDATION_PUBLIC_KEY_INVALID, {
        provided: uncompressedPubKey,
        hint: 'Expected 130 hex characters for uncompressed public key',
      });
    }

    const verifyScript = this.buildVerifyScript(pubKeyHex);
    const scriptHash = sanitizeHex(u.reverseHex(u.hash160(verifyScript)));
    return wallet.getAddressFromScriptHash(scriptHash);
  }

  /**
   * Creates the payload required to register a new V3 Abstract Account.
   *
   * @param {Object} options - Account creation options
   * @param {string} [options.verifierContractHash=''] - Verifier contract hash (40 hex chars)
   * @param {string} [options.verifierParamsHex=''] - Verifier parameters hex
   * @param {string} [options.hookContractHash=''] - Hook contract hash (40 hex chars)
   * @param {string} options.backupOwnerAddress - Backup owner address
   * @param {number} [options.escapeTimelock=2592000] - Escape hatch timelock in seconds (default: 30 days)
   * @returns {Object} Contract invocation payload
   * @throws {Error} If required parameters are missing or invalid
   */
  createAccountPayload(options) {
    validateOptions(options, ['backupOwnerAddress']);

    const {
      verifierContractHash = '',
      verifierParamsHex = '',
      hookContractHash = '',
      backupOwnerAddress,
      escapeTimelock = 30 * 24 * 60 * 60, // 30 days default
    } = options;

    if (verifierContractHash) {
      validateHash160(verifierContractHash);
    }

    // Validate hook contract hash if provided
    if (hookContractHash) {
      validateHash160(hookContractHash);
    }

    // Validate backup owner address if provided
    if (backupOwnerAddress) {
      validateAddressOrHash160(backupOwnerAddress);
    }

    const resolvedAccountHash = this.deriveRegistrationAccountIdHash({
      verifierContractHash,
      verifierParamsHex,
      hookContractHash,
      backupOwnerAddress,
      escapeTimelock,
    });

    return {
      scriptHash: this.masterContractHash,
      operation: 'registerAccount',
      args: [
        sc.ContractParam.hash160(resolvedAccountHash),
        sc.ContractParam.hash160(verifierContractHash ? normalizeAddress(verifierContractHash) : '00'.repeat(20)),
        sc.ContractParam.byteArray(u.HexString.fromHex(sanitizeHex(verifierParamsHex), true)),
        sc.ContractParam.hash160(hookContractHash ? normalizeAddress(hookContractHash) : '00'.repeat(20)),
        sc.ContractParam.hash160(backupOwnerAddress ? normalizeAddress(backupOwnerAddress) : '00'.repeat(20)),
        sc.ContractParam.integer(escapeTimelock)
      ],
    };
  }

  /**
   * Creates a payload to update the verifier for an account.
   *
   * @param {Object} options - Update options
   * @param {string} [options.accountScriptHash] - Account script hash
   * @param {string} [options.accountAddress] - Account address
   * @param {string} options.verifierContractHash - New verifier contract hash
   * @param {string} [options.verifierParamsHex=''] - New verifier parameters
   * @returns {Object} Contract invocation payload
   * @throws {Error} If required parameters are missing
   */
  createUpdateVerifierPayload(options) {
    validateOptions(options, ['verifierContractHash']);

    const {
      accountScriptHash = '',
      accountAddress = '',
      verifierContractHash,
      verifierParamsHex = '',
    } = options || {};

    validateHash160(verifierContractHash);

    const resolvedAccountHash = accountScriptHash
      ? normalizeAddress(accountScriptHash)
      : normalizeAddress(accountAddress);

    return {
      scriptHash: this.masterContractHash,
      operation: 'updateVerifier',
      args: [
        sc.ContractParam.hash160(resolvedAccountHash),
        sc.ContractParam.hash160(normalizeAddress(verifierContractHash)),
        sc.ContractParam.byteArray(u.HexString.fromHex(sanitizeHex(verifierParamsHex), true)),
      ],
    };
  }

  /**
   * Creates a payload to update the hook for an account.
   *
   * @param {Object} options - Update options
   * @param {string} [options.accountScriptHash] - Account script hash
   * @param {string} [options.accountAddress] - Account address
   * @param {string} [options.hookContractHash=''] - New hook contract hash (empty to remove)
   * @returns {Object} Contract invocation payload
   * @throws {Error} If account is not specified
   */
  createUpdateHookPayload(options) {
    const {
      accountScriptHash = '',
      accountAddress = '',
      hookContractHash = '',
    } = options || {};

    // Validate hook contract hash if provided
    if (hookContractHash) {
      validateHash160(hookContractHash);
    }

    if (!accountScriptHash && !accountAddress) {
      throw createError(EC.VALIDATION_ACCOUNT_ID_REQUIRED, {
        hint: 'Either accountScriptHash or accountAddress is required',
      });
    }

    const resolvedAccountHash = accountScriptHash
      ? normalizeAddress(accountScriptHash)
      : normalizeAddress(accountAddress);

    return {
      scriptHash: this.masterContractHash,
      operation: 'updateHook',
      args: [
        sc.ContractParam.hash160(resolvedAccountHash),
        sc.ContractParam.hash160(hookContractHash ? normalizeAddress(hookContractHash) : '00'.repeat(20)),
      ],
    };
  }

  /**
   * Creates a payload to set the metadata URI for an account.
   *
   * @param {Object} options - Metadata options
   * @param {string} [options.accountScriptHash] - Account script hash
   * @param {string} [options.accountAddress] - Account address
   * @param {string} [options.metadataUri=''] - Metadata URI string
   * @returns {Object} Contract invocation payload
   * @throws {Error} If account is not specified
   */
  createSetMetadataUriPayload(options) {
    const {
      accountScriptHash = '',
      accountAddress = '',
      metadataUri = '',
    } = options || {};

    if (!accountScriptHash && !accountAddress) {
      throw createError(EC.VALIDATION_ACCOUNT_ID_REQUIRED, {
        hint: 'Either accountScriptHash or accountAddress is required',
      });
    }

    const resolvedAccountHash = accountScriptHash
      ? normalizeAddress(accountScriptHash)
      : normalizeAddress(accountAddress);

    return {
      scriptHash: this.masterContractHash,
      operation: 'setMetadataUri',
      args: [
        sc.ContractParam.hash160(resolvedAccountHash),
        sc.ContractParam.string(metadataUri),
      ],
    };
  }

  /**
   * Computes the hash of contract arguments for EIP-712 signing.
   *
   * @param {Array} args - Contract arguments array
   * @returns {Promise<string>} 32-byte hash (64 hex characters)
   * @throws {Error} If computation fails or returns empty result
   */
  async computeArgsHash(args = []) {
    const response = await this.invokeFunctionWithRetry(
      this.masterContractHash,
      'computeArgsHash',
      [{ type: 'Array', value: args }],
      []
    );

    if (response?.state === 'FAULT') {
      const mappedError = mapRpcError({ message: response.exception });
      if (mappedError) {
        throw createError(mappedError, { operation: 'computeArgsHash' });
      }
      throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
    }

    const argsHashHex = metaTxExports.decodeByteStringStackHex(response?.stack?.[0]);
    if (!argsHashHex) {
      throw createError(EC.CONTRACT_INVOCATION_FAILED, { hint: 'computeArgsHash returned empty result' });
    }

    return argsHashHex;
  }

  /**
   * Generates the EIP-712 payload for signing a UserOperation.
   * Supports both V3 (accountId-based) and legacy (bound address) formats.
   *
   * @param {Object} options - EIP-712 options
   * @param {string|number} options.chainId - Chain ID for EIP-712 domain
   * @param {string} [options.accountIdHash] - V3 account ID hash (40 hex chars)
   * @param {string} [options.accountIdHex] - Account ID hex (derives accountIdHash)
   * @param {string} [options.verifierHash] - Verifier contract hash (for V3)
   * @param {string} [options.accountAddressScriptHash] - Legacy account script hash
   * @param {string} [options.accountAddressHash] - Legacy account address hash
   * @param {string} options.targetContract - Target contract hash (40 hex chars)
   * @param {string} options.method - Method name
   * @param {Array} [options.args=[]] - Method arguments
   * @param {string|number} options.nonce - Nonce value
   * @param {string|number} options.deadline - Deadline in Neo Runtime.Time milliseconds
   * @returns {Promise<Object>} EIP-712 typed data structure
   * @throws {Error} If required parameters are missing or validation fails
   *
   * @example
   * ```javascript
   * const typedData = await client.createEIP712Payload({
   *   chainId: 860833102,
   *   accountIdHash: 'f951...',
   *   verifierHash: 'b410...',
   *   targetContract: '49c0...',
   *   method: 'transfer',
   *   args: [{ type: 'Address', value: '0xabcd...' }],
   *   nonce: 0,
   *   deadline: Date.now() + 3600_000,
   * });
   *
   * const signature = await signer.signTypedData(
   *   typedData.domain,
   *   typedData.types,
   *   typedData.message
   * );
   * ```
   */
  async createEIP712Payload(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, {
        hint: 'createEIP712Payload expects an options object',
      });
    }

    const {
      chainId,
      accountAddressScriptHash,
      accountAddressHash,
      accountIdHash,
      accountIdHex,
      verifierHash,
      targetContract,
      method,
      args = [],
      nonce,
      deadline,
    } = options;

    // Validate required fields
    validateEIP712Fields(nonce, deadline);

    if (!chainId) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'chainId is required' });
    }

    if (!targetContract) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'targetContract is required' });
    }

    if (!method) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'method is required' });
    }

    // Compute args hash
    const argsHashHex = await this.computeArgsHash(args);

    // Resolve account ID hash for V3
    const resolvedAccountIdHash = accountIdHash
      ? sanitizeHex(accountIdHash)
      : accountIdHex
        ? this.deriveVirtualAccount(accountIdHex).accountIdHash
        : '';

    // V3 path: use accountId and verifier
    if (resolvedAccountIdHash) {
      let resolvedVerifierHash = verifierHash;

      // Auto-resolve verifier if not provided
      if (!resolvedVerifierHash) {
        const script = sc.createScript({
          scriptHash: this.masterContractHash,
          operation: 'getVerifier',
          args: [{ type: 'Hash160', value: resolvedAccountIdHash }],
        });
        const response = await this.invokeScriptWithRetry(u.HexString.fromHex(script), []);

        if (response?.state === 'FAULT') {
          const mappedError = mapRpcError({ message: response.exception });
          if (mappedError) {
            throw createError(mappedError, { operation: 'getVerifier' });
          }
          throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
        }

        // The node returns the UInt160 as a base64 ByteString in little-endian
        // byte order; decode and reverse to the big-endian display form.
        const verifierLeHex = metaTxExports.decodeByteStringStackHex(response?.stack?.[0]);
        resolvedVerifierHash = verifierLeHex ? sanitizeHex(u.reverseHex(verifierLeHex)) : '';
      }

      if (!resolvedVerifierHash) {
        throw createError(EC.ACCOUNT_VERIFIER_NOT_CONFIGURED, {
          accountIdHash: resolvedAccountIdHash,
          hint: 'No verifier is configured for this V3 account',
        });
      }

      return metaTxExports.buildV3UserOperationTypedData({
        chainId,
        verifyingContract: resolvedVerifierHash,
        accountIdHash: resolvedAccountIdHash,
        coreContractHash: this.masterContractHash,
        targetContract,
        method,
        argsHashHex,
        nonce,
        deadline,
      });
    }

    // Legacy path: use bound address
    const resolvedAccountAddressScriptHash = accountAddressScriptHash
      ? sanitizeHex(accountAddressScriptHash)
      : accountAddressHash
        ? sanitizeHex(accountAddressHash)
        : '';

    if (!resolvedAccountAddressScriptHash) {
      throw createError(EC.ACCOUNT_MISSING_BINDING);
    }

    return metaTxExports.buildMetaTransactionTypedData({
      chainId,
      verifyingContract: this.masterContractHash,
      accountAddressScriptHash: resolvedAccountAddressScriptHash,
      targetContract,
      method,
      argsHashHex,
      nonce,
      deadline,
    });
  }

  /**
   * Decodes an address array from a stack item.
   *
   * @param {Object} stackItem - Stack item from RPC response
   * @returns {Array<string>} Array of Neo addresses
   */
  decodeAddressArray(stackItem) {
    if (!stackItem || stackItem.type !== 'Array' || !Array.isArray(stackItem.value)) return [];
    return stackItem.value.map((item) => {
      let rawHex = '';
      if (item.type === 'Hash160' && item.value) rawHex = sanitizeHex(item.value);
      if (item.type === 'ByteString' && item.value) rawHex = sanitizeHex(Buffer.from(item.value, 'base64').toString('hex'));
      if (!rawHex) return null;
      return wallet.getAddressFromScriptHash(sanitizeHex(u.reverseHex(rawHex)));
    }).filter(Boolean);
  }

  /**
   * Gets the account implementation ID.
   *
   * @returns {Promise<string>} Implementation ID string
   * @throws {Error} If RPC call fails
   */
  async getAccountImplementationId() {
    const script = sc.createScript({
      scriptHash: this.masterContractHash,
      operation: 'getAccountImplementationId',
      args: [],
    });
    const response = await this.invokeScriptWithRetry(u.HexString.fromHex(script), []);

    if (response?.state === 'FAULT') {
      throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
    }

    return decodeByteStringStackText(response?.stack?.[0]);
  }

  /**
   * Checks if a specific execution mode is supported.
   *
   * @param {string} mode - Execution mode to check (e.g., 'single', 'batch')
   * @returns {Promise<boolean>} True if mode is supported
   * @throws {Error} If RPC call fails
   */
  async supportsExecutionMode(mode) {
    const script = sc.createScript({
      scriptHash: this.masterContractHash,
      operation: 'supportsExecutionMode',
      args: [{ type: 'String', value: String(mode || '') }],
    });
    const response = await this.invokeScriptWithRetry(u.HexString.fromHex(script), []);

    if (response?.state === 'FAULT') {
      throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
    }

    return decodeStackBoolean(response?.stack?.[0]);
  }

  /**
   * Checks if a specific module type is supported.
   *
   * @param {string} moduleType - Module type to check (e.g., 'validator', 'executor', 'hook')
   * @returns {Promise<boolean>} True if module type is supported
   * @throws {Error} If RPC call fails
   */
  async supportsModuleType(moduleType) {
    const script = sc.createScript({
      scriptHash: this.masterContractHash,
      operation: 'supportsModuleType',
      args: [{ type: 'String', value: String(moduleType || '') }],
    });
    const response = await this.invokeScriptWithRetry(u.HexString.fromHex(script), []);

    if (response?.state === 'FAULT') {
      throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
    }

    return decodeStackBoolean(response?.stack?.[0]);
  }

  /**
   * Checks if a specific module is installed on an account.
   *
   * @param {string} accountHashOrAddress - Account hash or address
   * @param {string} moduleType - Module type (e.g., 'validator', 'executor', 'hook')
   * @param {string} moduleHashOrAddress - Module hash or address
   * @returns {Promise<boolean>} True if module is installed
   * @throws {Error} If RPC call fails
   */
  async isModuleInstalled(accountHashOrAddress, moduleType, moduleHashOrAddress) {
    const accountId = normalizeAddress(accountHashOrAddress);
    const moduleHash = normalizeAddress(moduleHashOrAddress);

    const script = sc.createScript({
      scriptHash: this.masterContractHash,
      operation: 'isModuleInstalled',
      args: [
        { type: 'Hash160', value: accountId },
        { type: 'String', value: String(moduleType || '') },
        { type: 'Hash160', value: moduleHash },
      ],
    });
    const response = await this.invokeScriptWithRetry(u.HexString.fromHex(script), []);

    if (response?.state === 'FAULT') {
      throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
    }

    return decodeStackBoolean(response?.stack?.[0]);
  }

  /**
   * Checks an account signature through the Neo ERC-1271 adapter surface.
   * The returned value is the four-byte magic value as lowercase hex
   * (0x1626ba7e means valid; 0xffffffff means invalid).
   *
   * @param {string} accountHashOrAddress - Account hash or address
   * @param {string} hash - Exactly 32-byte message digest, hex encoded
   * @param {string} signature - Compact 64-byte signature, hex encoded
   * @returns {Promise<string>} ERC-1271-compatible magic value
   */
  async isValidSignature(accountHashOrAddress, hash, signature) {
    const accountId = normalizeAddress(accountHashOrAddress);
    const messageHash = sanitizeHex(hash || '');
    const messageSignature = sanitizeHex(signature || '');
    validateHexString(messageHash, { byteLength: 32 });
    // ERC-1271 callers commonly provide either compact r||s (64 bytes) or
    // recoverable r||s||v (65 bytes). The Neo verifier validates the recovery
    // id when present and strips it before secp256k1 verification.
    validateHexString(messageSignature, { minLength: 64, maxLength: 65 });

    const script = sc.createScript({
      scriptHash: this.masterContractHash,
      operation: 'isValidSignature',
      args: [
        { type: 'Hash160', value: accountId },
        { type: 'ByteArray', value: messageHash },
        { type: 'ByteArray', value: messageSignature },
      ],
    });
    const response = await this.invokeScriptWithRetry(u.HexString.fromHex(script), []);
    if (response?.state === 'FAULT') {
      throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
    }
    return `0x${metaTxExports.decodeByteStringStackHex(response?.stack?.[0])}`;
  }

  /**
   * Gets a validation preview for a UserOperation before submission.
   * Useful for checking if the operation would pass signature validation.
   *
   * @param {Object} options - Preview options
   * @param {string} [options.accountIdHash] - V3 account ID hash
   * @param {string} [options.accountAddress] - Legacy account address
   * @param {string} options.targetContract - Target contract hash
   * @param {string} options.method - Method name
   * @param {Array} [options.args=[]] - Method arguments
   * @param {string|number} [options.nonce=0] - Nonce value
   * @param {string|number} [options.deadline=0] - Deadline in Neo Runtime.Time milliseconds
   * @returns {Promise<Object>} Validation preview
   * @returns {boolean} returns.deadlineValid - Deadline is valid
   * @returns {boolean} returns.nonceAcceptable - Nonce is acceptable
   * @returns {boolean} returns.hasVerifier - Verifier is configured
   * @returns {string} returns.verifier - Verifier hash (big-endian display hex)
   * @returns {string} returns.hook - Hook hash (big-endian display hex)
   * @throws {Error} If RPC call fails
   */
  async getUserOpValidationPreview({
    accountIdHash = '',
    accountAddress = '',
    targetContract,
    method,
    args = [],
    nonce = 0,
    deadline = 0,
  } = {}) {
    const accountId = accountIdHash
      ? normalizeAddress(accountIdHash)
      : normalizeAddress(accountAddress);

    const response = await this.invokeFunctionWithRetry(this.masterContractHash, 'previewUserOpValidation', [
      { type: 'Hash160', value: accountId },
      {
        type: 'Struct',
        value: [
          { type: 'Hash160', value: normalizeAddress(targetContract) },
          { type: 'String', value: String(method || '') },
          { type: 'Array', value: args },
          { type: 'Integer', value: String(nonce) },
          { type: 'Integer', value: String(deadline) },
          { type: 'ByteArray', value: '' },
        ],
      },
    ]);

    if (response?.state === 'FAULT') {
      throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
    }

    return decodeValidationPreviewStack(response?.stack?.[0]);
  }

  /**
   * @deprecated This method is removed in V3. Role-based admin discovery no longer exists.
   * @throws {Error} Always throws with deprecation message
   */
  async getAccountsByAdmin() {
    throw createError(EC.LEGACY_V3_REMOVED, {
      hint: 'Use getAccountState() to check individual account details',
    });
  }

  /**
   * @deprecated This method is removed in V3. Role-based manager discovery no longer exists.
   * @throws {Error} Always throws with deprecation message
   */
  async getAccountsByManager() {
    throw createError(EC.LEGACY_V3_REMOVED, {
      hint: 'Use getAccountState() to check individual account details',
    });
  }

  /**
   * @deprecated This method is removed in V3. Role-based admin discovery no longer exists.
   * @throws {Error} Always throws with deprecation message
   */
  async getAccountAddressesByAdmin() {
    throw createError(EC.LEGACY_V3_REMOVED, {
      hint: 'Use getAccountState() to check individual account details',
    });
  }

  /**
   * @deprecated This method is removed in V3. Role-based manager discovery no longer exists.
   * @throws {Error} Always throws with deprecation message
   */
  async getAccountAddressesByManager() {
    throw createError(EC.LEGACY_V3_REMOVED, {
      hint: 'Use getAccountState() to check individual account details',
    });
  }

  /**
   * Gets the complete state of an abstract account.
   *
   * All Hash160 fields are returned as big-endian display hex (the same
   * byte order every SDK hash input accepts), regardless of the node's
   * little-endian wire encoding.
   *
   * @param {string} accountHashOrAddress - Account hash or address
   * @returns {Promise<Object>} Account state
   * @returns {string} returns.accountId - Account ID hash (big-endian display hex)
   * @returns {string} returns.verifier - Verifier contract hash (big-endian display hex)
   * @returns {string} returns.hook - Hook contract hash (big-endian display hex)
   * @returns {string} returns.backupOwner - Backup owner hash (big-endian display hex)
   * @returns {string} returns.escapeTimelock - Escape hatch timelock (seconds)
   * @returns {string} returns.escapeTriggeredAt - Timestamp when escape was triggered
   * @returns {boolean} returns.escapeActive - Whether escape hatch is active
   * @returns {string} returns.metadataUri - Metadata URI (if set)
   * @throws {Error} If RPC call fails
   */
  async getAccountState(accountHashOrAddress) {
    const accountId = normalizeAddress(accountHashOrAddress);

    const invokeSafe = async (operation) => {
      const response = await this.invokeFunctionWithRetry(
        this.masterContractHash,
        operation,
        [{ type: 'Hash160', value: accountId }],
        []
      );

      if (response?.state === 'FAULT') {
        throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
      }

      return response?.stack?.[0] || null;
    };

    const invokeOptional = async (operation) => {
      try {
        return await invokeSafe(operation);
      } catch (error) {
        if (/method not found/i.test(String(error?.message || ''))) {
          return null;
        }
        throw error;
      }
    };

    const [verifier, hook, backupOwner, escapeTimelock, escapeTriggeredAt, escapeActive, metadataUri] = await Promise.all([
      invokeSafe('getVerifier'),
      invokeSafe('getHook'),
      invokeSafe('getBackupOwner'),
      invokeSafe('getEscapeTimelock'),
      invokeSafe('getEscapeTriggeredAt'),
      invokeSafe('isEscapeActive'),
      invokeOptional('getMetadataUri'),
    ]);

    return {
      accountId,
      verifier: decodeHash160Stack(verifier),
      hook: decodeHash160Stack(hook),
      backupOwner: decodeHash160Stack(backupOwner),
      escapeTimelock: String(escapeTimelock?.value || '0'),
      escapeTriggeredAt: String(escapeTriggeredAt?.value || '0'),
      escapeActive: Boolean(escapeActive?.value),
      metadataUri: decodeByteStringStackText(metadataUri),
    };
  }

  /**
   * Creates a payload to confirm a pending hook update.
   *
   * @param {Object} options - Confirm options
   * @param {string} [options.accountScriptHash] - Account script hash
   * @param {string} [options.accountAddress] - Account address
   * @returns {Object} Contract invocation payload
   * @throws {Error} If account is not specified
   */
  createConfirmHookUpdatePayload(options) {
    const {
      accountScriptHash = '',
      accountAddress = '',
    } = options || {};

    if (!accountScriptHash && !accountAddress) {
      throw createError(EC.VALIDATION_ACCOUNT_ID_REQUIRED, {
        hint: 'Either accountScriptHash or accountAddress is required',
      });
    }

    const resolvedAccountHash = accountScriptHash
      ? normalizeAddress(accountScriptHash)
      : normalizeAddress(accountAddress);

    return {
      scriptHash: this.masterContractHash,
      operation: 'confirmHookUpdate',
      args: [
        sc.ContractParam.hash160(resolvedAccountHash),
      ],
    };
  }

  /**
   * Creates a payload to confirm a pending verifier update.
   *
   * @param {Object} options - Confirm options
   * @param {string} [options.accountScriptHash] - Account script hash
   * @param {string} [options.accountAddress] - Account address
   * @returns {Object} Contract invocation payload
   * @throws {Error} If account is not specified
   */
  createConfirmVerifierUpdatePayload(options) {
    const {
      accountScriptHash = '',
      accountAddress = '',
    } = options || {};

    if (!accountScriptHash && !accountAddress) {
      throw createError(EC.VALIDATION_ACCOUNT_ID_REQUIRED, {
        hint: 'Either accountScriptHash or accountAddress is required',
      });
    }

    const resolvedAccountHash = accountScriptHash
      ? normalizeAddress(accountScriptHash)
      : normalizeAddress(accountAddress);

    return {
      scriptHash: this.masterContractHash,
      operation: 'confirmVerifierUpdate',
      args: [
        sc.ContractParam.hash160(resolvedAccountHash),
      ],
    };
  }

  /**
   * Creates a payload to cancel a pending hook update.
   *
   * @param {Object} options - Cancel options
   * @param {string} [options.accountScriptHash] - Account script hash
   * @param {string} [options.accountAddress] - Account address
   * @returns {Object} Contract invocation payload
   * @throws {Error} If account is not specified
   */
  createCancelHookUpdatePayload(options) {
    const {
      accountScriptHash = '',
      accountAddress = '',
    } = options || {};

    if (!accountScriptHash && !accountAddress) {
      throw createError(EC.VALIDATION_ACCOUNT_ID_REQUIRED, {
        hint: 'Either accountScriptHash or accountAddress is required',
      });
    }

    const resolvedAccountHash = accountScriptHash
      ? normalizeAddress(accountScriptHash)
      : normalizeAddress(accountAddress);

    return {
      scriptHash: this.masterContractHash,
      operation: 'cancelHookUpdate',
      args: [
        sc.ContractParam.hash160(resolvedAccountHash),
      ],
    };
  }

  /**
   * Creates a payload to cancel a pending verifier update.
   *
   * @param {Object} options - Cancel options
   * @param {string} [options.accountScriptHash] - Account script hash
   * @param {string} [options.accountAddress] - Account address
   * @returns {Object} Contract invocation payload
   * @throws {Error} If account is not specified
   */
  createCancelVerifierUpdatePayload(options) {
    const {
      accountScriptHash = '',
      accountAddress = '',
    } = options || {};

    if (!accountScriptHash && !accountAddress) {
      throw createError(EC.VALIDATION_ACCOUNT_ID_REQUIRED, {
        hint: 'Either accountScriptHash or accountAddress is required',
      });
    }

    const resolvedAccountHash = accountScriptHash
      ? normalizeAddress(accountScriptHash)
      : normalizeAddress(accountAddress);

    return {
      scriptHash: this.masterContractHash,
      operation: 'cancelVerifierUpdate',
      args: [
        sc.ContractParam.hash160(resolvedAccountHash),
      ],
    };
  }

  /**
   * Checks if an account has a pending verifier update.
   *
   * @param {string} accountHashOrAddress - Account hash or address
   * @returns {Promise<boolean>} True if there's a pending update
   * @throws {Error} If RPC call fails
   */
  async getHasPendingVerifierUpdate(accountHashOrAddress) {
    const accountId = normalizeAddress(accountHashOrAddress);
    const response = await this.invokeFunctionWithRetry(
      this.masterContractHash,
      'hasPendingVerifierUpdate',
      [{ type: 'Hash160', value: accountId }],
      []
    );

    if (response?.state === 'FAULT') {
      throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
    }

    return response?.stack?.[0]?.value === true || response?.stack?.[0]?.value === 1;
  }

  /**
   * Checks if an account has a pending hook update.
   *
   * @param {string} accountHashOrAddress - Account hash or address
   * @returns {Promise<boolean>} True if there's a pending update
   * @throws {Error} If RPC call fails
   */
  async getHasPendingHookUpdate(accountHashOrAddress) {
    const accountId = normalizeAddress(accountHashOrAddress);
    const response = await this.invokeFunctionWithRetry(
      this.masterContractHash,
      'hasPendingHookUpdate',
      [{ type: 'Hash160', value: accountId }],
      []
    );

    if (response?.state === 'FAULT') {
      throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
    }

    return response?.stack?.[0]?.value === true || response?.stack?.[0]?.value === 1;
  }

  /**
   * Gets the timestamp when a pending verifier update can be confirmed.
   *
   * @param {string} accountHashOrAddress - Account hash or address
   * @returns {Promise<number>} Update timestamp in Neo Runtime.Time milliseconds
   * @throws {Error} If RPC call fails
   */
  async getPendingVerifierUpdateTime(accountHashOrAddress) {
    const accountId = normalizeAddress(accountHashOrAddress);
    const response = await this.invokeFunctionWithRetry(
      this.masterContractHash,
      'getPendingVerifierUpdateTime',
      [{ type: 'Hash160', value: accountId }],
      []
    );

    if (response?.state === 'FAULT') {
      throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
    }

    return response?.stack?.[0]?.value || 0;
  }

  /**
   * Gets the timestamp when a pending hook update can be confirmed.
   *
   * @param {string} accountHashOrAddress - Account hash or address
   * @returns {Promise<number>} Update timestamp in Neo Runtime.Time milliseconds
   * @throws {Error} If RPC call fails
   */
  async getPendingHookUpdateTime(accountHashOrAddress) {
    const accountId = normalizeAddress(accountHashOrAddress);
    const response = await this.invokeFunctionWithRetry(
      this.masterContractHash,
      'getPendingHookUpdateTime',
      [{ type: 'Hash160', value: accountId }],
      []
    );

    if (response?.state === 'FAULT') {
      throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
    }

    return response?.stack?.[0]?.value || 0;
  }

  async getPendingVerifierCall(accountHashOrAddress) {
    const accountId = normalizeAddress(accountHashOrAddress);
    const [hasPending, executeAfter, moduleHashItem, callHashItem] = await Promise.all([
      this.invokeFunctionWithRetry(
        this.masterContractHash,
        'hasPendingVerifierCall',
        [{ type: 'Hash160', value: accountId }],
        []
      ),
      this.invokeFunctionWithRetry(
        this.masterContractHash,
        'getPendingVerifierCallTime',
        [{ type: 'Hash160', value: accountId }],
        []
      ),
      this.invokeFunctionWithRetry(
        this.masterContractHash,
        'getPendingVerifierCallModule',
        [{ type: 'Hash160', value: accountId }],
        []
      ),
      this.invokeFunctionWithRetry(
        this.masterContractHash,
        'getPendingVerifierCallHash',
        [{ type: 'Hash160', value: accountId }],
        []
      ),
    ]);

    for (const response of [hasPending, executeAfter, moduleHashItem, callHashItem]) {
      if (response?.state === 'FAULT') {
        throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
      }
    }

    return {
      hasPending: decodeStackBoolean(hasPending?.stack?.[0]),
      executeAfter: String(executeAfter?.stack?.[0]?.value || '0'),
      moduleHash: decodeHash160Stack(moduleHashItem?.stack?.[0]),
      callHash: metaTxExports.decodeByteStringStackHex(callHashItem?.stack?.[0]),
    };
  }

  async getPendingHookCall(accountHashOrAddress) {
    const accountId = normalizeAddress(accountHashOrAddress);
    const [hasPending, executeAfter, moduleHashItem, callHashItem] = await Promise.all([
      this.invokeFunctionWithRetry(
        this.masterContractHash,
        'hasPendingHookCall',
        [{ type: 'Hash160', value: accountId }],
        []
      ),
      this.invokeFunctionWithRetry(
        this.masterContractHash,
        'getPendingHookCallTime',
        [{ type: 'Hash160', value: accountId }],
        []
      ),
      this.invokeFunctionWithRetry(
        this.masterContractHash,
        'getPendingHookCallModule',
        [{ type: 'Hash160', value: accountId }],
        []
      ),
      this.invokeFunctionWithRetry(
        this.masterContractHash,
        'getPendingHookCallHash',
        [{ type: 'Hash160', value: accountId }],
        []
      ),
    ]);

    for (const response of [hasPending, executeAfter, moduleHashItem, callHashItem]) {
      if (response?.state === 'FAULT') {
        throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
      }
    }

    return {
      hasPending: decodeStackBoolean(hasPending?.stack?.[0]),
      executeAfter: String(executeAfter?.stack?.[0]?.value || '0'),
      moduleHash: decodeHash160Stack(moduleHashItem?.stack?.[0]),
      callHash: metaTxExports.decodeByteStringStackHex(callHashItem?.stack?.[0]),
    };
  }

  /**
   * Checks if an execution is currently active for an account.
   *
   * @param {string} accountHashOrAddress - Account hash or address
   * @returns {Promise<boolean>} True if an execution is active
   * @throws {Error} If RPC call fails
   */
  async getIsExecutionActive(accountHashOrAddress) {
    const accountId = normalizeAddress(accountHashOrAddress);
    const script = sc.createScript({
      scriptHash: this.masterContractHash,
      operation: 'isExecutionActive',
      args: [{ type: 'Hash160', value: accountId }],
    });

    const response = await this.invokeScriptWithRetry(u.HexString.fromHex(script), []);

    if (response?.state === 'FAULT') {
      throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
    }

    return response?.stack?.[0]?.value === true || response?.stack?.[0]?.value === 1;
  }

  // ========================================================================
  // Paymaster / Sponsored Transactions
  // ========================================================================

  /**
   * Creates the payload for executing a sponsored UserOperation via Paymaster.
   * The relay (transaction sender) is reimbursed from the sponsor's deposit.
   *
   * @param {Object} options - Sponsored operation options
   * @param {string} [options.accountScriptHash] - Account script hash (40 hex)
   * @param {string} [options.accountAddress] - Account address (alternative)
   * @param {Object} options.userOp - The UserOperation object (from UserOperationBuilder.build())
   * @param {string} options.paymasterHash - Paymaster contract hash (40 hex)
   * @param {string} options.sponsorAddress - Sponsor address or hash
   * @param {string|number} options.reimbursementAmount - GAS reimbursement in fractions (10^8 = 1 GAS)
   * @returns {Object} Contract invocation payload for executeSponsoredUserOp
   * @throws {Error} If required parameters are missing
   */
  createSponsoredUserOpPayload(options) {
    const {
      accountScriptHash = '',
      accountAddress = '',
      userOp,
      paymasterHash,
      sponsorAddress,
      reimbursementAmount,
    } = options || {};

    if (!userOp) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'userOp is required' });
    }
    if (!paymasterHash) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'paymasterHash is required' });
    }
    if (!sponsorAddress) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'sponsorAddress is required' });
    }
    if (!reimbursementAmount || reimbursementAmount <= 0) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'reimbursementAmount must be positive' });
    }

    validateHash160(paymasterHash);

    const resolvedAccountHash = accountScriptHash
      ? normalizeAddress(accountScriptHash)
      : normalizeAddress(accountAddress);

    return {
      scriptHash: this.masterContractHash,
      operation: 'executeSponsoredUserOp',
      args: [
        sc.ContractParam.hash160(resolvedAccountHash),
        sc.ContractParam.array(
          sc.ContractParam.hash160(normalizeAddress(userOp.TargetContract)),
          sc.ContractParam.string(userOp.Method),
          { type: 'Array', value: userOp.Args || [] },
          sc.ContractParam.integer(userOp.Nonce),
          sc.ContractParam.integer(userOp.Deadline),
          sc.ContractParam.byteArray(
            u.HexString.fromHex(sanitizeHex(userOp.Signature || ''), true)
          ),
        ),
        sc.ContractParam.hash160(normalizeAddress(paymasterHash)),
        sc.ContractParam.hash160(normalizeAddress(sponsorAddress)),
        sc.ContractParam.integer(reimbursementAmount),
      ],
    };
  }

  /**
   * Creates the payload for executing a sponsored batch of UserOperations.
   *
   * @param {Object} options - Sponsored batch options
   * @param {string} [options.accountScriptHash] - Account script hash
   * @param {string} [options.accountAddress] - Account address
   * @param {Array<Object>} options.userOps - Array of UserOperation objects
   * @param {string} options.paymasterHash - Paymaster contract hash
   * @param {string} options.sponsorAddress - Sponsor address
   * @param {string|number} options.reimbursementAmount - Total GAS reimbursement for the batch
   * @returns {Object} Contract invocation payload for executeSponsoredUserOps
   */
  createSponsoredBatchPayload(options) {
    const {
      accountScriptHash = '',
      accountAddress = '',
      userOps,
      paymasterHash,
      sponsorAddress,
      reimbursementAmount,
    } = options || {};

    if (!userOps || !Array.isArray(userOps) || userOps.length === 0) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'userOps array is required' });
    }
    if (!paymasterHash) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'paymasterHash is required' });
    }
    if (!sponsorAddress) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'sponsorAddress is required' });
    }
    if (!reimbursementAmount || reimbursementAmount <= 0) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'reimbursementAmount must be positive' });
    }

    validateHash160(paymasterHash);

    const resolvedAccountHash = accountScriptHash
      ? normalizeAddress(accountScriptHash)
      : normalizeAddress(accountAddress);

    const opsArray = userOps.map(op => sc.ContractParam.array(
      sc.ContractParam.hash160(normalizeAddress(op.TargetContract)),
      sc.ContractParam.string(op.Method),
      { type: 'Array', value: op.Args || [] },
      sc.ContractParam.integer(op.Nonce),
      sc.ContractParam.integer(op.Deadline),
      sc.ContractParam.byteArray(
        u.HexString.fromHex(sanitizeHex(op.Signature || ''), true)
      ),
    ));

    return {
      scriptHash: this.masterContractHash,
      operation: 'executeSponsoredUserOps',
      args: [
        sc.ContractParam.hash160(resolvedAccountHash),
        { type: 'Array', value: opsArray },
        sc.ContractParam.hash160(normalizeAddress(paymasterHash)),
        sc.ContractParam.hash160(normalizeAddress(sponsorAddress)),
        sc.ContractParam.integer(reimbursementAmount),
      ],
    };
  }

  /**
   * Queries the sponsor's GAS deposit balance in a Paymaster contract.
   *
   * @param {string} paymasterHash - Paymaster contract hash (40 hex)
   * @param {string} sponsorAddress - Sponsor address or hash
   * @returns {Promise<string>} Deposit balance in GAS fractions (BigInteger string)
   */
  async querySponsorBalance(paymasterHash, sponsorAddress) {
    validateHash160(paymasterHash);

    const script = sc.createScript({
      scriptHash: sanitizeHex(paymasterHash),
      operation: 'getSponsorDeposit',
      args: [{ type: 'Hash160', value: normalizeAddress(sponsorAddress) }],
    });

    const response = await this.invokeScriptWithRetry(u.HexString.fromHex(script), []);

    if (response?.state === 'FAULT') {
      throw createError(EC.CONTRACT_VM_FAULT, { exception: response.exception });
    }

    return response?.stack?.[0]?.value || '0';
  }

  /**
   * Validates whether a sponsored operation would be accepted by the Paymaster.
   * Use for relay preflight checks before submitting a transaction.
   *
   * @param {Object} options - Validation options
   * @param {string} options.paymasterHash - Paymaster contract hash
   * @param {string} options.sponsorAddress - Sponsor address
   * @param {string} options.accountAddress - Account address or hash
   * @param {string} options.targetContract - Target contract hash
   * @param {string} options.method - Target method name
   * @param {string|number} options.reimbursementAmount - Requested reimbursement
   * @returns {Promise<boolean>} True if the operation would be accepted
   */
  async validatePaymasterOp(options) {
    const {
      paymasterHash,
      sponsorAddress,
      accountAddress,
      targetContract,
      method,
      reimbursementAmount,
    } = options || {};

    validateHash160(paymasterHash);

    const script = sc.createScript({
      scriptHash: sanitizeHex(paymasterHash),
      operation: 'validatePaymasterOp',
      args: [
        { type: 'Hash160', value: normalizeAddress(sponsorAddress) },
        { type: 'Hash160', value: normalizeAddress(accountAddress) },
        { type: 'Hash160', value: normalizeAddress(targetContract) },
        { type: 'String', value: method },
        { type: 'Integer', value: String(reimbursementAmount) },
      ],
    });

    const response = await this.invokeScriptWithRetry(u.HexString.fromHex(script), []);

    if (response?.state === 'FAULT') {
      return false;
    }

    return decodeStackBoolean(response?.stack?.[0]);
  }
}

module.exports = {
  AbstractAccountClient,
  // Meta-tx exports
  buildMetaTransactionTypedData: metaTxExports.buildMetaTransactionTypedData,
  buildV3UserOperationTypedData: metaTxExports.buildV3UserOperationTypedData,
  buildContractCompatibleStructHash: metaTxExports.buildContractCompatibleStructHash,
  buildContractCompatibleDomainSeparator: metaTxExports.buildContractCompatibleDomainSeparator,
  buildWeb3AuthSigningPayload: metaTxExports.buildWeb3AuthSigningPayload,
  decodeByteStringStackHex: metaTxExports.decodeByteStringStackHex,
  toBytes20Word: metaTxExports.toBytes20Word,
  toAddressWord: metaTxExports.toAddressWord,
  toUint256Word: metaTxExports.toUint256Word,
  sanitizeHex: metaTxExports.sanitizeHex,
  // Export new modules
  EC,
  createError,
  mapRpcError,
  formatError,
  UserOperationBuilder: require('./UserOpBuilder').UserOperationBuilder,
  createUserOpBuilder: require('./UserOpBuilder').createUserOpBuilder,
  simulateUserOperation: require('./simulation').simulateUserOperation,
  preFlightCheck: require('./simulation').preFlightCheck,
  // Retry utility
  withRetry: require('./retry').withRetry,
  isRetryableError: require('./retry').isRetryableError,
};
