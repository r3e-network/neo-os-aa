/**
 * Builds the v4 13-field user operation (docs/SA-MODULE-PROTOCOL.md §4).
 *
 * The builder owns input shape only: it composes the channel nonce (§6),
 * checks every bound through the shared codec, and hands out the exact value
 * the core serializes. It never hashes a signature and never talks to RPC, so
 * the same operation can be built offline, reviewed, and only then signed.
 *
 * Removed v3 surface: `setVerifier`, `setChainId`, `setArgsHash`,
 * `setAccountAddressScriptHash` and the 6-field `build()`. There is no alias;
 * a caller that still passes a verifier hash gets a shape error, not a
 * silently different operation.
 */

const { codec } = require('./codec');
const { EC, createError } = require('./errors');

const DEFAULT_DEADLINE_BUFFER_MS = 5 * 60 * 1000;

const fail = (errorCode, details) => {
  throw createError(errorCode, details);
};

const integer = (value, label, bits = 64) => {
  if (value === undefined || value === null) {
    fail(EC.VALIDATION_OPTIONS_REQUIRED, { hint: `${label} is required` });
  }
  try {
    return codec.unsigned(value, bits, label).toString();
  } catch (error) {
    fail(EC.VALIDATION_OPTIONS_REQUIRED, { hint: `${label}: ${error.message}` });
  }
};

class UserOperationBuilder {
  /**
   * @param {Object} options
   * @param {number} [options.networkMagic] - chain id the digest domain binds
   * @param {string} [options.coreContractHash] - the kernel answering the proxy
   * @param {string} [options.accountId] - 20-byte account id
   */
  constructor({ networkMagic, coreContractHash, accountId } = {}) {
    this._state = {
      networkMagic,
      coreContractHash,
      accountId,
      targetContract: undefined,
      method: undefined,
      args: [],
      nonce: undefined,
      nonceSubkey: undefined,
      deadline: undefined,
      validatorId: 0,
      credentialGeneration: undefined,
      authorityEpoch: undefined,
      configurationNonce: undefined,
      signature: '',
      hookProofs: [],
    };
  }

  setNetworkMagic(networkMagic) {
    this._state.networkMagic = networkMagic;
    return this;
  }

  setCoreContractHash(coreContractHash) {
    this._state.coreContractHash = coreContractHash;
    return this;
  }

  setAccountId(accountId) {
    this._state.accountId = accountId;
    return this;
  }

  setTarget(targetContract) {
    this._state.targetContract = targetContract;
    return this;
  }

  setMethod(method) {
    this._state.method = method;
    return this;
  }

  setArgs(args = []) {
    if (!Array.isArray(args)) {
      fail(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'args must be an array' });
    }
    this._state.args = [...args];
    return this;
  }

  addArg(arg) {
    this._state.args = [...this._state.args, arg];
    return this;
  }

  /**
   * Routing identity of the nonce channel (§6). A field left out keeps its
   * current value; there is no unset, because a cleared routing field would
   * only be discovered as a missing field at build time.
   *
   * A custody operation uses generation 1. An installed validator or active
   * threshold policy uses its on-chain credential generation.
   */
  setRouting({ validatorId, credentialGeneration, authorityEpoch, configurationNonce }) {
    if (validatorId !== undefined) this._state.validatorId = validatorId;
    if (credentialGeneration !== undefined) this._state.credentialGeneration = credentialGeneration;
    if (authorityEpoch !== undefined) this._state.authorityEpoch = authorityEpoch;
    if (configurationNonce !== undefined) this._state.configurationNonce = configurationNonce;
    return this;
  }

  setNonceSubkey(nonceSubkey) {
    this._state.nonceSubkey = nonceSubkey;
    return this;
  }

  /** A fully packed nonce (channel << 64 | sequence). */
  setNonce(nonce) {
    this._state.nonce = nonce;
    return this;
  }

  /** Compose a packed nonce from a derived channel and the next sequence. */
  setNonceSequence({ channel, sequence }) {
    try {
      const packed = codec.composeNonce(channel, sequence);
      this._state.nonce = packed.toString();
      return this;
    } catch (error) {
      return fail(EC.VALIDATION_NONCE_UNACCEPTABLE, { hint: error.message });
    }
  }

  /**
   * Derive the channel from the current routing and read its sequence, then
   * pack the nonce. `loader` returns `{ sequence }` or a packed `nonce`.
   */
  async autoNonce(loader) {
    if (typeof loader !== 'function') {
      fail(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'autoNonce requires a loader' });
    }
    const routing = this._routing();
    const reply = await loader(routing);
    if (reply && reply.nonce !== undefined) return this.setNonce(reply.nonce);
    return this.setNonceSequence({ channel: routing.channel, sequence: reply?.sequence ?? 0 });
  }

  setDeadline(deadline) {
    this._state.deadline = deadline;
    return this;
  }

  /** Deadline in Neo Runtime.Time milliseconds, `bufferMs` ahead of now. */
  autoDeadline(bufferMs = DEFAULT_DEADLINE_BUFFER_MS) {
    if (!Number.isSafeInteger(bufferMs) || bufferMs < 0) {
      return fail(EC.VALIDATION_DEADLINE_INVALID, { hint: 'buffer must be nonnegative ms' });
    }
    this._state.deadline = Date.now() + bufferMs;
    return this;
  }

  setSignature(signature) {
    this._state.signature = signature ?? '';
    return this;
  }

  /** Ascending `{ hookId, proof }` entries; the codec enforces the order. */
  setHookProofs(hookProofs = []) {
    if (!Array.isArray(hookProofs)) {
      fail(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'hookProofs must be an array' });
    }
    this._state.hookProofs = [...hookProofs];
    return this;
  }

  _routing() {
    const { networkMagic, coreContractHash, accountId, validatorId, credentialGeneration,
      authorityEpoch, nonceSubkey } = this._state;
    if (accountId === undefined) fail(EC.VALIDATION_ACCOUNT_ID_REQUIRED);
    // The generation is not part of the account record and the builder never
    // talks to RPC, so there is nothing to fall back to: report the missing
    // field instead of deriving a namespace the core would reject.
    if (credentialGeneration === undefined || credentialGeneration === null) {
      fail(EC.VALIDATION_OPTIONS_REQUIRED, {
        hint:
          'credential generation is required: use 1 for custody operations or the current validator or policy generation',
      });
    }
    try {
      const context = {
        networkMagic: codec.unsigned(networkMagic, 32, 'network magic').toString(),
        coreContractHash: codec.hex(coreContractHash, 20),
        accountId: codec.hex(accountId, 20),
        authorityEpoch: integer(authorityEpoch, 'authority epoch'),
      };
      const channel = codec.deriveNonceChannel(context, {
        authorityEpoch: context.authorityEpoch,
        validatorId: integer(validatorId, 'validator id'),
        credentialGeneration: integer(credentialGeneration, 'credential generation'),
        nonceSubkey: codec.hex(nonceSubkey, 32),
      });
      return { ...context, validatorId, credentialGeneration, nonceSubkey, channel };
    } catch (error) {
      return fail(EC.VALIDATION_OPTIONS_REQUIRED, { hint: `nonce routing: ${error.message}` });
    }
  }

  /** The derived 191-bit nonce channel for the current routing. */
  nonceChannel() {
    return this._routing().channel;
  }

  /** The operation as the codec serializes it (fields 0-12, §4). */
  build() {
    const state = this._state;
    if (state.targetContract === undefined) {
      fail(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'target contract is required' });
    }
    if (state.method === undefined) {
      fail(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'method is required' });
    }
    if (state.nonce === undefined) fail(EC.VALIDATION_NONCE_REQUIRED);
    if (state.deadline === undefined) fail(EC.VALIDATION_DEADLINE_REQUIRED);
    if (state.nonceSubkey === undefined) {
      fail(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'nonce subkey is required' });
    }
    const operation = {
      targetContract: state.targetContract,
      method: state.method,
      args: state.args,
      nonce: integer(state.nonce, 'nonce', 255),
      nonceSubkey: state.nonceSubkey,
      deadline: integer(state.deadline, 'deadline', 255),
      validatorId: integer(state.validatorId ?? 0, 'validator id'),
      credentialGeneration: integer(state.credentialGeneration, 'credential generation'),
      authorityEpoch: integer(state.authorityEpoch, 'authority epoch'),
      configurationNonce: integer(state.configurationNonce, 'configuration nonce'),
      signature: state.signature ?? '',
      hookProofs: state.hookProofs ?? [],
    };
    try {
      // Validate every field through the one serializer the chain also uses.
      codec.serializeOperation(operation, operation.signature === '');
    } catch (error) {
      return fail(EC.VALIDATION_OPTIONS_REQUIRED, { hint: `operation: ${error.message}` });
    }
    return Object.freeze(operation);
  }

  /** §4.3 operation digest over the unsigned encoding. */
  digest() {
    const operation = this.build();
    try {
      return codec.operationDigest(
        {
          networkMagic: codec.unsigned(this._state.networkMagic, 32, 'network magic').toString(),
          coreContractHash: codec.hex(this._state.coreContractHash, 20),
          accountId: codec.hex(this._state.accountId, 20),
        },
        operation,
      );
    } catch (error) {
      return fail(EC.VALIDATION_OPERATION_DIGEST_INVALID, { hint: error.message });
    }
  }

  /**
   * The NeoVM value (field array) for a script or a read call. An unsigned
   * operation carries an empty signature field, which is exactly what the core
   * hashes; execution scripts still refuse it (the codec requires 1..8192
   * signature bytes there), so a review can inspect an operation before a
   * wallet has signed anything.
   */
  toValue() {
    const operation = this.build();
    return codec.operationValue(operation, operation.signature === '');
  }

  /** Canonical unsigned serialization, the bytes a signer signs over. */
  serialize() {
    return codec.serializeOperation(this.build(), true);
  }

  clone() {
    const copy = new UserOperationBuilder();
    copy._state = {
      ...this._state,
      args: [...this._state.args],
      hookProofs: [...this._state.hookProofs],
    };
    return copy;
  }

  /**
   * Clear the operation (target, method, args, nonce, deadline, signature and
   * hook proofs) and keep the account and routing identity, so the next
   * operation is built on the same nonce channel. Dropping the routing here
   * would silently move the next operation to a different channel.
   */
  reset() {
    this._state = {
      networkMagic: this._state.networkMagic,
      coreContractHash: this._state.coreContractHash,
      accountId: this._state.accountId,
      validatorId: this._state.validatorId,
      credentialGeneration: this._state.credentialGeneration,
      authorityEpoch: this._state.authorityEpoch,
      configurationNonce: this._state.configurationNonce,
      nonceSubkey: this._state.nonceSubkey,
      args: [],
      signature: '',
      hookProofs: [],
    };
    return this;
  }

  toJSON() {
    return { ...this._state, args: [...this._state.args], hookProofs: [...this._state.hookProofs] };
  }
}

/**
 * @param {Object} options - see {@link UserOperationBuilder}
 * @returns {UserOperationBuilder}
 */
function createUserOpBuilder(options) {
  return new UserOperationBuilder(options);
}

module.exports = { UserOperationBuilder, createUserOpBuilder };
