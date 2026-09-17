/**
 * Fluent builder for constructing UserOperations.
 * Provides a chainable API for building UserOperation objects.
 */

const { EC, createError } = require('./errors');
const { validateHash160, validateEIP712Fields, sanitizeHex } = require('./validation');
const {
  buildMetaTransactionTypedData,
  buildV3UserOperationTypedData,
} = require('./metaTx');

/**
 * Default deadline buffer (seconds) from current time.
 * Neo Runtime.Time is expressed in milliseconds, so generated deadlines are ms.
 */
const DEFAULT_DEADLINE_BUFFER = 3600; // 1 hour

/**
 * Default nonce starting value
 */
const DEFAULT_NONCE = 0;

/**
 * UserOperation builder class.
 * Use fluent methods to configure and build a UserOperation.
 *
 * @example
 * const builder = new UserOperationBuilder()
 *   .setTarget('0x1234...')
 *   .setMethod('transfer')
 *   .setArgs([{ type: 'Address', value: '0xabcd...' }])
 *   .setAccountId('f951...')
 *   .autoNonce()
 *   .autoDeadline();
 *
 * const userOp = builder.build();
 * const typedData = await builder.buildEIP712();
 */
class UserOperationBuilder {
  constructor(options = {}) {
    /** @type {string} The account ID hash (20 bytes) */
    this.accountIdHash = options.accountIdHash || '';

    /** @type {string} The target contract hash (20 bytes) */
    this.targetContract = options.targetContract || '';

    /** @type {string} The method name to call */
    this.method = options.method || '';

    /** @type {Array} The method arguments */
    this.args = options.args || [];

    /** @type {string|number} The nonce value */
    this.nonce = options.nonce ?? DEFAULT_NONCE;

    /** @type {string|number} The deadline in Neo Runtime.Time milliseconds */
    this.deadline = options.deadline || '';

    /** @type {string} The verifier contract hash for EIP-712 */
    this.verifierHash = options.verifierHash || '';

    /** @type {string} The authorized AA core hash for EIP-712 */
    this.coreContractHash = options.coreContractHash || '';

    /** @type {string} The chain ID for EIP-712 */
    this.chainId = options.chainId || '';

    /** @type {string} Optional account address script hash (legacy) */
    this.accountAddressScriptHash = options.accountAddressScriptHash || '';

    /** @type {string} Optional account address hash (legacy) */
    this.accountAddressHash = options.accountAddressHash || '';

    /** @type {string} The signature (empty by default) */
    this.signature = options.signature || '';

    /** @type {string} Computed args hash (cached) */
    this._argsHash = null;
  }

  /**
   * Sets the account ID hash.
   * @param {string} accountIdHash - 20-byte hash (40 hex chars)
   * @returns {UserOperationBuilder} This builder for chaining
   */
  setAccountId(accountIdHash) {
    this.accountIdHash = sanitizeHex(accountIdHash);
    if (this.accountIdHash) {
      validateHash160(this.accountIdHash);
    }
    this._argsHash = null; // Clear cache
    return this;
  }

  /**
   * Sets the target contract.
   * @param {string} contractHash - 20-byte hash (40 hex chars)
   * @returns {UserOperationBuilder} This builder for chaining
   */
  setTarget(contractHash) {
    this.targetContract = sanitizeHex(contractHash);
    if (this.targetContract) {
      validateHash160(this.targetContract);
    }
    return this;
  }

  /**
   * Sets the method name.
   * @param {string} method - The method name
   * @returns {UserOperationBuilder} This builder for chaining
   */
  setMethod(method) {
    this.method = String(method || '');
    return this;
  }

  /**
   * Sets the method arguments.
   * @param {Array} args - The method arguments (Neo contract param format)
   * @returns {UserOperationBuilder} This builder for chaining
   */
  setArgs(args) {
    this.args = Array.isArray(args) ? args : [];
    this._argsHash = null; // Clear cache
    return this;
  }

  /**
   * Adds a single argument.
   * @param {*} arg - The argument to add
   * @returns {UserOperationBuilder} This builder for chaining
   */
  addArg(arg) {
    this.args.push(arg);
    this._argsHash = null; // Clear cache
    return this;
  }

  /**
   * Sets the nonce.
   * @param {string|number} nonce - The nonce value
   * @returns {UserOperationBuilder} This builder for chaining
   */
  setNonce(nonce) {
    this.nonce = nonce;
    return this;
  }

  /**
   * Auto-generates the nonce (defaults to 0).
   * In production, this should fetch the current nonce from the contract.
   *
   * Await-aware: when the fetcher returns a promise, a promise resolving to
   * this builder is returned so the awaited nonce value (never the promise
   * itself) is stored. Synchronous fetchers keep the synchronous chaining.
   *
   * @param {Function} fetchNonceFn - Optional function to fetch current nonce
   * @returns {UserOperationBuilder|Promise<UserOperationBuilder>} This builder for chaining
   */
  autoNonce(fetchNonceFn) {
    if (typeof fetchNonceFn === 'function') {
      const result = fetchNonceFn();
      if (result && typeof result.then === 'function') {
        return result.then((nonce) => {
          this.nonce = nonce;
          return this;
        });
      }
      this.nonce = result;
    } else {
      this.nonce = DEFAULT_NONCE;
    }
    return this;
  }

  /**
   * Sets the deadline.
   * @param {string|number} deadline - Deadline in Neo Runtime.Time milliseconds
   * @returns {UserOperationBuilder} This builder for chaining
   */
  setDeadline(deadline) {
    this.deadline = deadline;
    return this;
  }

  /**
   * Auto-generates the deadline with a buffer from current time.
   * @param {number} bufferSeconds - Buffer in seconds (default: 3600)
   * @returns {UserOperationBuilder} This builder for chaining
   */
  autoDeadline(bufferSeconds = DEFAULT_DEADLINE_BUFFER) {
    this.deadline = (Date.now() + (Number(bufferSeconds) * 1000)).toString();
    return this;
  }

  /**
   * Sets the verifier contract hash for EIP-712 signing.
   * @param {string} verifierHash - 20-byte hash (40 hex chars)
   * @returns {UserOperationBuilder} This builder for chaining
   */
  setVerifier(verifierHash) {
    this.verifierHash = sanitizeHex(verifierHash);
    if (this.verifierHash) {
      validateHash160(this.verifierHash);
    }
    return this;
  }

  /**
   * Sets the authorized AA core contract hash for EIP-712 signing.
   * @param {string} coreContractHash - 20-byte AA core hash (40 hex chars)
   * @returns {UserOperationBuilder} This builder for chaining
   */
  setCoreContract(coreContractHash) {
    this.coreContractHash = sanitizeHex(coreContractHash);
    if (this.coreContractHash) {
      validateHash160(this.coreContractHash);
    }
    return this;
  }

  /**
   * Sets the chain ID for EIP-712 signing.
   * @param {string|number} chainId - The chain ID
   * @returns {UserOperationBuilder} This builder for chaining
   */
  setChainId(chainId) {
    this.chainId = String(chainId || '');
    return this;
  }

  /**
   * Sets the legacy account address script hash.
   * @param {string} scriptHash - 20-byte hash (40 hex chars)
   * @returns {UserOperationBuilder} This builder for chaining
   */
  setAccountAddressScriptHash(scriptHash) {
    this.accountAddressScriptHash = sanitizeHex(scriptHash);
    if (this.accountAddressScriptHash) {
      validateHash160(this.accountAddressScriptHash);
    }
    return this;
  }

  /**
   * Sets the signature.
   * @param {string} signature - The signature hex string
   * @returns {UserOperationBuilder} This builder for chaining
   */
  setSignature(signature) {
    this.signature = signature || '';
    return this;
  }

  /**
   * Sets the args hash directly (bypasses computation).
   * @param {string} argsHash - 32-byte hash (64 hex chars)
   * @returns {UserOperationBuilder} This builder for chaining
   */
  setArgsHash(argsHash) {
    const cleanHash = sanitizeHex(argsHash);
    if (cleanHash.length !== 64) {
      throw createError(EC.VALIDATION_ARGS_HASH_INVALID, {
        provided: argsHash,
        hint: 'Expected 32 bytes (64 hex characters)',
      });
    }
    this._argsHash = cleanHash;
    return this;
  }

  /**
   * Computes the args hash from the current args array.
   * Note: This requires a computeArgsHash RPC call which is not implemented here.
   * In practice, this should be called with the result from the contract.
   * @param {string} argsHash - The pre-computed args hash
   * @returns {UserOperationBuilder} This builder for chaining
   */
  computeArgsHash(argsHash) {
    return this.setArgsHash(argsHash);
  }

  /**
   * Builds the UserOperation object.
   * @returns {Object} The UserOperation object
   */
  build() {
    if (!this.targetContract) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, {
        hint: 'Target contract is required',
      });
    }
    if (!this.method) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, {
        hint: 'Method name is required',
      });
    }

    return {
      TargetContract: this.targetContract,
      Method: this.method,
      Args: this.args,
      Nonce: this.nonce,
      Deadline: this.deadline,
      Signature: this.signature,
    };
  }

  /**
   * Builds the EIP-712 typed data for V3 UserOperation.
   * Delegates to the shared buildV3UserOperationTypedData so the builder can
   * never drift from the layout the verifier contracts check.
   * @param {string} argsHash - The computed args hash (32 bytes)
   * @returns {Object} The EIP-712 typed data structure
   */
  buildEIP712(argsHash) {
    // Use provided args hash or cached one
    const finalArgsHash = argsHash || this._argsHash;
    if (!finalArgsHash) {
      throw createError(EC.VALIDATION_ARGS_HASH_INVALID, {
        hint: 'Args hash must be set via setArgsHash() or computed first',
      });
    }

    // Validate EIP-712 fields
    validateEIP712Fields(this.nonce, this.deadline);

    if (!this.accountIdHash) {
      throw createError(EC.VALIDATION_ACCOUNT_ID_REQUIRED, {
        hint: 'Account ID hash is required for V3 EIP-712',
      });
    }

    if (!this.verifierHash) {
      throw createError(EC.ACCOUNT_VERIFIER_NOT_CONFIGURED, {
        hint: 'Verifier hash is required for EIP-712 signing',
      });
    }

    if (!this.coreContractHash) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, {
        hint: 'Authorized AA core hash is required for EIP-712 signing',
      });
    }

    if (!this.chainId) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, {
        hint: 'Chain ID is required for EIP-712',
      });
    }

    return buildV3UserOperationTypedData({
      chainId: this.chainId,
      verifyingContract: this.verifierHash,
      accountIdHash: this.accountIdHash,
      coreContractHash: this.coreContractHash,
      targetContract: this.targetContract,
      method: this.method,
      argsHashHex: finalArgsHash,
      nonce: this.nonce,
      deadline: this.deadline,
    });
  }

  /**
   * Builds the legacy MetaTransaction EIP-712 typed data.
   * Delegates to the shared buildMetaTransactionTypedData.
   *
   * The legacy flow verifies against the MASTER contract, not the account's
   * verifier plugin, so the verifying contract must be passed explicitly
   * (AbstractAccountClient.createEIP712Payload uses its masterContractHash).
   *
   * @param {string} argsHash - The computed args hash (32 bytes)
   * @param {string} verifyingContract - The master contract hash the legacy
   *   flow verifies against (40 hex chars)
   * @returns {Object} The EIP-712 typed data structure
   */
  buildLegacyEIP712(argsHash, verifyingContract) {
    const finalArgsHash = argsHash || this._argsHash;
    if (!finalArgsHash) {
      throw createError(EC.VALIDATION_ARGS_HASH_INVALID, {
        hint: 'Args hash must be set via setArgsHash() or computed first',
      });
    }

    validateEIP712Fields(this.nonce, this.deadline);

    if (!verifyingContract) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, {
        hint: 'Explicit verifyingContract (master contract hash) is required for legacy EIP-712',
      });
    }
    validateHash160(sanitizeHex(verifyingContract));

    const resolvedAccountHash = this.accountAddressScriptHash ||
                                this.accountAddressHash;

    if (!resolvedAccountHash) {
      throw createError(EC.ACCOUNT_MISSING_BINDING, {
        hint: 'Account address script/hash is required for legacy EIP-712',
      });
    }

    return buildMetaTransactionTypedData({
      chainId: this.chainId,
      verifyingContract,
      accountAddressScriptHash: this.accountAddressScriptHash,
      accountAddressHash: this.accountAddressHash,
      targetContract: this.targetContract,
      method: this.method,
      argsHashHex: finalArgsHash,
      nonce: this.nonce,
      deadline: this.deadline,
    });
  }

  /**
   * Clones the builder with current state, including the cached args hash.
   * @returns {UserOperationBuilder} A new builder instance
   */
  clone() {
    const cloned = new UserOperationBuilder({
      accountIdHash: this.accountIdHash,
      targetContract: this.targetContract,
      method: this.method,
      args: [...this.args],
      nonce: this.nonce,
      deadline: this.deadline,
      verifierHash: this.verifierHash,
      coreContractHash: this.coreContractHash,
      chainId: this.chainId,
      accountAddressScriptHash: this.accountAddressScriptHash,
      accountAddressHash: this.accountAddressHash,
      signature: this.signature,
    });
    cloned._argsHash = this._argsHash;
    return cloned;
  }

  /**
   * Resets the builder to initial state.
   * @returns {UserOperationBuilder} This builder for chaining
   */
  reset() {
    this.accountIdHash = '';
    this.targetContract = '';
    this.method = '';
    this.args = [];
    this.nonce = DEFAULT_NONCE;
    this.deadline = '';
    this.verifierHash = '';
    this.coreContractHash = '';
    this.chainId = '';
    this.accountAddressScriptHash = '';
    this.accountAddressHash = '';
    this.signature = '';
    this._argsHash = null;
    return this;
  }

  /**
   * Converts to a plain object representation.
   * @returns {Object} Plain object with all builder state
   */
  toJSON() {
    return {
      accountIdHash: this.accountIdHash,
      targetContract: this.targetContract,
      method: this.method,
      args: this.args,
      nonce: this.nonce,
      deadline: this.deadline,
      verifierHash: this.verifierHash,
      coreContractHash: this.coreContractHash,
      chainId: this.chainId,
      accountAddressScriptHash: this.accountAddressScriptHash,
      accountAddressHash: this.accountAddressHash,
      signature: this.signature,
      argsHash: this._argsHash,
    };
  }
}

/**
 * Creates a new UserOperationBuilder.
 * @param {Object} options - Initial options
 * @returns {UserOperationBuilder} A new builder instance
 */
function createUserOpBuilder(options) {
  return new UserOperationBuilder(options);
}

module.exports = {
  UserOperationBuilder,
  createUserOpBuilder,
  DEFAULT_DEADLINE_BUFFER,
  DEFAULT_NONCE,
};
