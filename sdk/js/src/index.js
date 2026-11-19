/**
 * Neo Smart Account v4 SDK — custom-kernel client.
 *
 * The custom kernel is a deployed contract (any script hash) that implements
 * the same v4 protocol as the native one, plus the market-escrow, platform
 * registrar, metadata and sponsored-execution services. Two constants differ
 * from the native kernel and both are constructor identity, never options:
 *
 * - `contractHash`: where the kernel answers;
 * - `callFlags`: 15 (CallFlags.All), because the custom proxy calls its own
 *   `verify(accountId)` with full flags while the native proxy pushes 5.
 *
 * Everything protocol-shaped is inherited from the one shared client: the 13
 * field operation, the 191-bit channel nonce, the operation/message digests,
 * configuration intents, module queries, account actions, the ABI gate and the
 * `SA_*` vocabulary. This file adds only what the custom kernel has and the
 * native one does not, and never re-implements a shared derivation.
 *
 * Only entry points a caller of this client can actually satisfy are exposed as
 * plans. The market escrow writes assert the caller is the registered market and
 * the registrar writes assert the caller is the registrar, so they stay reads
 * here and are driven by their own contracts; the ABI gate still pins that the
 * deployment carries them.
 *
 * Removed v3 surface: `registerAccount`, `getVerifier`, `updateVerifier`,
 * `getHook`, `updateHook`, `createAccountPayload`, verifier/hook update
 * confirmations, `getAccountsByAdmin`, `createSponsoredUserOpPayload` with a
 * 6-field operation. There is no alias: a v3 call fails to resolve.
 */

const { rpc, wallet } = require('./neonCompat');
const { codec } = require('./codec');
const {
  EC,
  createError,
  mapRpcError,
  formatError,
  SA_ERRORS,
  SA_ERROR_CODES,
} = require('./errors');
const { validateHash160, validateRpcUrl } = require('./validation');
const { withRetry, isRetryableError } = require('./retry');
const {
  createNativeClientClass,
  declaredType,
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
} = require('../../../shared/nativeSmartAccountClient.mjs');
const { PROTOCOL_VERSION } = require('../../../shared/nativeSmartAccount.mjs');
const { createNativeTransactionTools } = require('./native/transaction');
const metaTx = require('./metaTx');
const transferOutcome = require('../../../shared/transferOutcome.mjs');
const sessionKeyBlob = require('../../../shared/sessionKeyBlob.mjs');

/** The custom kernel pushes CallFlags.All in its proxy verification script. */
const CUSTOM_PROXY_CALL_FLAGS = 15;
/** `SmartAccount.State.cs` pins this implementation id. */
const CUSTOM_IMPLEMENTATION_ID = 'org.r3e.neo.smart-account.v4';

const H = codec.hashValue;
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

/**
 * Custom-only ABI, pinned by type (parameter names are not a byte-positional
 * contract, types and arity are). A kernel that answers the v4 core ABI but
 * lacks these is a different deployment than the one this SDK drives, and the
 * client refuses it at discovery instead of failing mid-transaction.
 */
const CUSTOM_REQUIRED_ABI = freeze({
  enterMarketEscrow: [['Hash160', 'Hash160', 'Integer'], 'Void'],
  cancelMarketEscrow: [['Hash160', 'Integer'], 'Void'],
  settleMarketEscrow: [['Hash160', 'Integer', 'Hash160'], 'Void'],
  setMarketService: [['Hash160', 'Boolean'], 'Void'],
  isMarketService: [['Hash160'], 'Boolean'],
  getMarketEscrowContract: [['Hash160'], 'Hash160'],
  getMarketEscrowListingId: [['Hash160'], 'Integer'],
  isMarketEscrowActive: [['Hash160'], 'Boolean'],
  isAccountFrozen: [['Hash160'], 'Boolean'],
  isOwnerOnlyRecovery: [['Hash160'], 'Boolean'],
  isExecutionActive: [['Hash160'], 'Boolean'],
  isUserOpExecutionActive: [[], 'Boolean'],
  isMigrationRequired: [['Hash160'], 'Boolean'],
  markMigrationRequired: [['Hash160'], 'Void'],
  getMigrationState: [['Hash160'], 'Array'],
  computeAccountIdentity: [['Hash160', 'ByteArray'], 'Hash160'],
  computeRegistrationAccountId: [
    ['Hash160', 'ByteArray', 'Hash160', 'Hash160', 'Integer'],
    'Hash160',
  ],
  computePlatformAccountId: [['ByteArray', 'Hash160', 'Integer'], 'Hash160'],
  computeStablePlatformAccountId: [['ByteArray', 'Integer'], 'Hash160'],
  registerPlatformAccount: [['Hash160', 'ByteArray', 'Hash160', 'Integer'], 'Void'],
  registerStablePlatformAccount: [['Hash160', 'ByteArray', 'Hash160', 'Integer'], 'Void'],
  applyPlatformAccountOwnerRotation: [
    ['Hash160', 'ByteArray', 'Hash160', 'Hash160'],
    'Void',
  ],
  getAccountIdByProxy: [['Hash160'], 'Hash160'],
  getPlatformAccountBinding: [['Hash160'], 'ByteArray'],
  proposePlatformRegistrar: [['Hash160'], 'Void'],
  confirmPlatformRegistrar: [[], 'Void'],
  cancelPlatformRegistrar: [[], 'Void'],
  getPlatformRegistrar: [[], 'Hash160'],
  getPendingPlatformRegistrar: [[], 'Hash160'],
  getPlatformRegistrarAvailableAt: [[], 'Integer'],
  getProxyScriptHash: [['Hash160'], 'Hash160'],
  computeArgsHash: [['Array'], 'ByteArray'],
  setMetadataUri: [['Hash160', 'String'], 'Void'],
  getMetadataUri: [['Hash160'], 'String'],
  executeSponsoredUserOp: [
    ['Hash160', 'Any', 'Hash160', 'Hash160', 'Integer'],
    'Any',
  ],
  executeSponsoredUserOps: [
    ['Hash160', 'Array', 'Hash160', 'Hash160', 'Integer'],
    'Array',
  ],
});

/**
 * Custom methods the account's custody authorises directly (§9). `setMetadataUri`
 * is the only one: `enterMarketEscrow` / `cancelMarketEscrow` /
 * `settleMarketEscrow` assert `Runtime.CallingScriptHash` is the registered
 * market, and the registrar methods assert the caller is the registrar, so a
 * script this client builds could never satisfy them. They stay in the ABI
 * gate (a deployment fingerprint) and are driven by their own contracts.
 */
const CUSTODY_ACTIONS = freeze(['setMetadataUri']);

const asArray = (value, label) => {
  if (!value || value.type !== 'Array' || !Array.isArray(value.value)) {
    throw createError(EC.CONTRACT_INVOCATION_FAILED, { hint: `malformed ${label}` });
  }
  return value.value;
};
const asUint = (value, label) => {
  if (typeof value !== 'bigint') {
    throw createError(EC.CONTRACT_INVOCATION_FAILED, { hint: `malformed ${label}` });
  }
  return value.toString();
};
const asBytes = (value, label) => {
  if (!(value instanceof Uint8Array)) {
    throw createError(EC.CONTRACT_INVOCATION_FAILED, { hint: `malformed ${label}` });
  }
  return Buffer.from(value);
};
const asHash = (value, label) => {
  const bytes = asBytes(value, label);
  if (bytes.length !== 20) {
    throw createError(EC.CONTRACT_INVOCATION_FAILED, { hint: `malformed ${label}` });
  }
  return bytes.reverse().toString('hex');
};
const asText = (value, label) => asBytes(value, label).toString('utf8');

function normalizeAddress(address) {
  if (typeof address !== 'string' || !address.trim()) {
    throw createError(EC.VALIDATION_ADDRESS_INVALID);
  }
  const clean = address.trim();
  if (clean.startsWith('N') && clean.length === 34) {
    return wallet.getScriptHashFromAddress(clean).toLowerCase();
  }
  const hex = clean.replace(/^0x/i, '').toLowerCase();
  validateHash160(hex);
  return hex;
}

/** Wraps a transport so transient read failures retry once, not every call. */
function retryingTransport(transport, options) {
  if (!transport || typeof transport.send !== 'function') {
    throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'rpcClient must expose send' });
  }
  if (options === false) return transport;
  return {
    ...transport,
    send: (method, params) => withRetry(`rpc.${method}`, () => transport.send(method, params), options),
  };
}

const CustomKernel = createNativeClientClass(codec, {
  callFlags: CUSTOM_PROXY_CALL_FLAGS,
  nativeCore: false,
  implementationId: CUSTOM_IMPLEMENTATION_ID,
});

const transactionTools = createNativeTransactionTools(codec);

class SmartAccountClient extends CustomKernel {
  /**
   * @param {Object} options
   * @param {string} [options.rpcUrl] - endpoint when no transport is supplied
   * @param {Object} [options.rpcClient] - transport exposing `send(method,params)`
   * @param {number} options.networkMagic - chain id the digests bind
   * @param {string} options.contractHash - the deployed custom kernel
   * @param {Object|false} [options.retry] - retry profile, `false` to disable
   */
  constructor({ rpcUrl, rpcClient, networkMagic, contractHash, retry } = {}) {
    if (!contractHash) throw createError(EC.VALIDATION_CONTRACT_HASH_REQUIRED);
    if (networkMagic === undefined || networkMagic === null) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'networkMagic is required' });
    }
    if (!rpcClient && !rpcUrl) throw createError(EC.VALIDATION_RPC_URL_REQUIRED);
    if (rpcUrl) validateRpcUrl(rpcUrl);
    const transport = retryingTransport(rpcClient ?? new rpc.RPCClient(rpcUrl), retry);
    super({
      rpcClient: transport,
      networkMagic,
      contractHash,
      callFlags: CUSTOM_PROXY_CALL_FLAGS,
    });
  }

  /**
   * Pins the deployment: the v4 core ABI (shared gate) plus the custom-only
   * services this client builds and reads.
   */
  async _discover() {
    const profile = await super._discover();
    if (profile.implementationId !== CUSTOM_IMPLEMENTATION_ID) {
      throw createError(EC.CONTRACT_ABI_MISMATCH, {
        hint: `implementation id ${profile.implementationId} is not the custom kernel`,
      });
    }
    const state = await this._send('getcontractstate', ['0x' + this.contractHash]);
    const methods = state?.manifest?.abi?.methods;
    if (!Array.isArray(methods)) {
      throw createError(EC.CONTRACT_ABI_MISMATCH, { hint: 'missing custom manifest ABI' });
    }
    for (const [name, [types, returntype]] of Object.entries(CUSTOM_REQUIRED_ABI)) {
      const found = methods.some(
        (method) =>
          method?.name === name &&
          method.returntype === returntype &&
          Array.isArray(method.parameters) &&
          method.parameters.length === types.length &&
          types.every((type, index) =>
            declaredType(type, method.parameters[index]?.type),
          ),
      );
      if (!found) {
        throw createError(EC.CONTRACT_ABI_MISMATCH, { hint: `missing custom method ${name}` });
      }
    }
    this.profile = freeze({ ...profile, kernel: 'custom' });
    return this.profile;
  }

  /** Maps a script fault's `SA_*` answer onto the SDK's single vocabulary. */
  async invokeScript(script, signers = []) {
    try {
      return await super.invokeScript(script, signers);
    } catch (error) {
      const mapped = mapRpcError(error);
      if (!mapped || !mapped.code) throw error;
      const failure = createError(mapped, { rpcDetail: mapped.rpcDetail });
      failure.code = mapped.code;
      throw failure;
    }
  }

  // ---------------------------------------------------------------------
  // Registration (§10)
  // ---------------------------------------------------------------------

  /** Batch form of `buildCreateAccountScript`; ids are derived, not supplied. */
  buildCreateAccountsScript({ custodyAddress, salts, recoveryTimelockMs = 0 }) {
    if (!Array.isArray(salts) || salts.length < 1 || salts.length > 32) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'salts must hold 1..32 entries' });
    }
    const identities = salts.map((salt) => this.deriveIdentity({ custodyAddress, salt }));
    return freeze({
      kind: 'registration',
      method: 'createAccounts',
      accountIds: identities.map((identity) => identity.accountId),
      accountAddresses: identities.map((identity) => identity.accountAddress),
      custodyAddress: codec.hex(custodyAddress, 20),
      signers: identities.map((identity) => identity.accountAddress),
      script: codec.dynamicCall(this.contractHash, 'createAccounts', [
        { type: 'Array', value: identities.map((identity) => H(identity.accountId)) },
        H(custodyAddress),
        { type: 'Array', value: salts.map((salt) => codec.byteStringValue(salt)) },
        codec.integerValue(codec.unsigned(recoveryTimelockMs, 64, 'recovery timelock')),
      ]),
    });
  }

  /** Legacy identity of a v3 registration (migration evidence, read-only). */
  async getRegistrationAccountId({
    verifier,
    verifierParams,
    hookId,
    backupOwner,
    escapeTimelock,
  }) {
    await this._ready();
    return asHash(
      await this._read('computeRegistrationAccountId', [
        H(verifier),
        codec.byteStringValue(verifierParams),
        H(hookId),
        H(backupOwner),
        codec.integerValue(codec.unsigned(escapeTimelock, 64, 'escape timelock')),
      ]),
      'registration account id',
    );
  }

  // ---------------------------------------------------------------------
  // Account actions (custody-authorised)
  // ---------------------------------------------------------------------

  freezeAccount(accountId) {
    return this.buildAccountActionScript({ method: 'freezeAccount', accountId });
  }

  unfreezeAccount(accountId) {
    return this.buildAccountActionScript({ method: 'unfreezeAccount', accountId });
  }

  beginRecovery(accountId, newCustody) {
    return this.buildAccountActionScript({
      method: 'beginRecovery',
      accountId,
      args: [H(newCustody)],
    });
  }

  cancelRecovery(accountId) {
    return this.buildAccountActionScript({ method: 'cancelRecovery', accountId });
  }

  executeRecovery(accountId) {
    return this.buildAccountActionScript({ method: 'executeRecovery', accountId });
  }

  revokeCredentials(accountId, moduleId) {
    return this.buildAccountActionScript({
      method: 'revokeCredentials',
      accountId,
      args: [codec.integerValue(codec.unsigned(moduleId, 64, 'module id'))],
    });
  }

  /**
   * A custom custody-gated action (`setMetadataUri`, escrow enter/cancel).
   * The review recipe name is part of the plan's provenance, so it is rebuilt
   * by the same method that produced it.
   */
  buildCustomActionScript({ method, accountId, args = [] }) {
    if (!CUSTODY_ACTIONS.includes(method)) {
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, {
        hint: `${method} is not a custody-authorised custom action`,
      });
    }
    const id = codec.hex(accountId, 20);
    return freeze({
      kind: 'account',
      method,
      accountId: id,
      accountAddress: this.proxyAddress(id),
      signers: [this.proxyAddress(id)],
      script: codec.dynamicCall(this.contractHash, method, [H(id), ...args]),
    });
  }

  setMetadataUri(accountId, metadataUri) {
    return this.buildCustomActionScript({
      method: 'setMetadataUri',
      accountId,
      args: [codec.stringValue(metadataUri)],
    });
  }

  // ---------------------------------------------------------------------
  // Market escrow state (writes belong to the market contract, §7.5)
  // ---------------------------------------------------------------------

  async getMarketEscrow(accountId) {
    await this._ready();
    const [contract, listingId, active] = await Promise.all([
      this._read('getMarketEscrowContract', [H(accountId)]),
      this._read('getMarketEscrowListingId', [H(accountId)]),
      this._read('isMarketEscrowActive', [H(accountId)]),
    ]);
    return freeze({
      marketContract: asHash(contract, 'market contract'),
      listingId: asUint(listingId, 'listing id'),
      active: active === true,
    });
  }

  async isMarketService(marketContract) {
    await this._ready();
    return (await this._read('isMarketService', [H(marketContract)])) === true;
  }

  // ---------------------------------------------------------------------
  // Platform registrar (registrar/admin-sourced; ids stay v3-stable)
  // ---------------------------------------------------------------------

  async computePlatformAccountId({ appBinding, backupOwner, escapeTimelock }) {
    await this._ready();
    return asHash(
      await this._read('computePlatformAccountId', [
        codec.byteStringValue(appBinding),
        H(backupOwner),
        codec.integerValue(codec.unsigned(escapeTimelock, 64, 'escape timelock')),
      ]),
      'platform account id',
    );
  }

  async computeStablePlatformAccountId({ appBinding, escapeTimelock }) {
    await this._ready();
    return asHash(
      await this._read('computeStablePlatformAccountId', [
        codec.byteStringValue(appBinding),
        codec.integerValue(codec.unsigned(escapeTimelock, 64, 'escape timelock')),
      ]),
      'stable platform account id',
    );
  }

  async getPlatformAccountBinding(accountId) {
    await this._ready();
    const binding = await this._read('getPlatformAccountBinding', [H(accountId)]);
    return binding === null ? null : asBytes(binding, 'platform binding').toString('hex');
  }

  async getAccountIdByProxy(proxy) {
    await this._ready();
    return asHash(await this._read('getAccountIdByProxy', [H(proxy)]), 'account id');
  }

  async getProxyScriptHash(accountId) {
    await this._ready();
    return asHash(await this._read('getProxyScriptHash', [H(accountId)]), 'proxy script hash');
  }

  async getPlatformRegistrar() {
    await this._ready();
    return asHash(await this._read('getPlatformRegistrar'), 'platform registrar');
  }

  async getPendingPlatformRegistrar() {
    await this._ready();
    return asHash(await this._read('getPendingPlatformRegistrar'), 'pending registrar');
  }

  async getPlatformRegistrarAvailableAt() {
    await this._ready();
    return asUint(await this._read('getPlatformRegistrarAvailableAt'), 'registrar maturity');
  }

  // ---------------------------------------------------------------------
  // Metadata, migration and sponsored execution
  // ---------------------------------------------------------------------

  async getMetadataUri(accountId) {
    await this._ready();
    return asText(await this._read('getMetadataUri', [H(accountId)]), 'metadata uri');
  }

  async isMigrationRequired(accountId) {
    await this._ready();
    return (await this._read('isMigrationRequired', [H(accountId)])) === true;
  }

  async getMigrationState(accountId) {
    await this._ready();
    const state = asArray(await this._read('getMigrationState', [H(accountId)]), 'migration state');
    if (state.length !== 6) {
      throw createError(EC.CONTRACT_INVOCATION_FAILED, { hint: 'malformed migration state' });
    }
    return freeze({
      status: asUint(state[0], 'migration status'),
      manifestDigest: asBytes(state[1], 'manifest digest').toString('hex'),
      classification: asText(state[2], 'classification'),
      legacyModuleCount: asUint(state[3], 'legacy module count'),
      legacyScopeInvalidated: state[4] === true,
      importedAt: asUint(state[5], 'imported time'),
    });
  }

  /**
   * Sponsored execution keeps the v4 operation: the sponsor pays, the account
   * still authorises the operation with its own validator signature.
   */
  buildSponsoredExecutionScript({
    accountId,
    operations,
    paymaster,
    sponsor,
    reimbursementAmount,
  }) {
    const list = Array.isArray(operations) ? operations : [operations];
    if (list.length < 1 || list.length > 32) {
      throw createError(EC.OPERATION_BATCH_EMPTY, { hint: '1..32 operations required' });
    }
    if (codec.unsigned(reimbursementAmount, 63, 'reimbursement') === 0n) {
      // The core requires a positive reimbursement (`> 0`, not `>= 0`).
      throw createError(EC.VALIDATION_OPTIONS_REQUIRED, { hint: 'reimbursement must be positive' });
    }
    // The core settles one reimbursement for the whole envelope against the
    // first operation's target and method, so a mixed batch would revert.
    const target = codec.hex(list[0]?.targetContract, 20);
    const callMethod = String(list[0]?.method ?? '');
    for (const operation of list) {
      if (
        codec.hex(operation?.targetContract, 20) !== target ||
        String(operation?.method ?? '') !== callMethod
      ) {
        throw createError(EC.VALIDATION_OPTIONS_REQUIRED, {
          hint: 'sponsored batches must share one target contract and method',
        });
      }
    }
    const id = codec.hex(accountId, 20);
    const method = list.length === 1 ? 'executeSponsoredUserOp' : 'executeSponsoredUserOps';
    const values = list.map((operation) => codec.operationValue(operation));
    return freeze({
      kind: 'execution',
      method,
      accountId: id,
      accountAddress: this.proxyAddress(id),
      proxyCallFlags: this.callFlags,
      batch: list.length !== 1,
      operations: Object.freeze([...list]),
      signers: [this.proxyAddress(id)],
      paymaster: codec.hex(paymaster, 20),
      sponsor: codec.hex(sponsor, 20),
      reimbursementAmount: codec.unsigned(reimbursementAmount, 63, 'reimbursement').toString(),
      script: codec.dynamicCall(this.contractHash, method, [
        H(id),
        list.length === 1 ? values[0] : { type: 'Array', value: values },
        H(paymaster),
        H(sponsor),
        codec.integerValue(codec.unsigned(reimbursementAmount, 63, 'reimbursement')),
      ]),
    });
  }

  // ---------------------------------------------------------------------
  // Transaction lifecycle (shared with the native client)
  // ---------------------------------------------------------------------

  prepareTransaction(plan, options) {
    return transactionTools.prepareNativeTransaction(this, plan, options);
  }

  signTransaction(prepared) {
    return transactionTools.signNativeTransaction(this, prepared);
  }

  exportSignedTransaction(signed) {
    return transactionTools.exportSignedTransaction(this, signed);
  }

  preflightTransaction(signed) {
    return transactionTools.preflightNativeTransaction(this, signed);
  }

  broadcastTransaction(signed) {
    return transactionTools.broadcastNativeTransaction(this, signed);
  }

  getTransactionReceipt(signed) {
    return transactionTools.getNativeTransactionReceipt(this, signed);
  }
}

/**
 * @param {Object} options - see {@link SmartAccountClient}
 * @returns {SmartAccountClient}
 */
function createSmartAccountClient(options) {
  return new SmartAccountClient(options);
}

module.exports = {
  SmartAccountClient,
  createSmartAccountClient,
  // Protocol identity
  codec,
  PROTOCOL_VERSION,
  CUSTOM_PROXY_CALL_FLAGS,
  CUSTOM_IMPLEMENTATION_ID,
  CUSTOM_REQUIRED_ABI,
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
  normalizeAddress,
  // Operations
  UserOperationBuilder: require('./UserOpBuilder').UserOperationBuilder,
  createUserOpBuilder: require('./UserOpBuilder').createUserOpBuilder,
  // Signing surfaces
  ...metaTx,
  // Errors
  EC,
  SA_ERRORS,
  SA_ERROR_CODES,
  createError,
  mapRpcError,
  formatError,
  // Transfer result rules (shared with the relay route and the wallet)
  TRANSFER_RETURNED_FALSE: transferOutcome.TRANSFER_RETURNED_FALSE,
  TRANSFER_RETURNED_FALSE_MESSAGE: transferOutcome.TRANSFER_RETURNED_FALSE_MESSAGE,
  findFailedTransferInInvocation: transferOutcome.findFailedTransferInInvocation,
  findFailedTransferInExecution: transferOutcome.findFailedTransferInExecution,
  isProxySourcedTransfer: transferOutcome.isProxySourcedTransfer,
  // Session-key installation blob (shared layout with the session validator)
  buildSessionKeyInstallCommand: sessionKeyBlob.buildSessionKeyInstallCommand,
  buildSessionKeyClearCommand: sessionKeyBlob.buildSessionKeyClearCommand,
  buildSessionKeyPermission: sessionKeyBlob.buildSessionKeyPermission,
  SESSION_KEY_INSTALL_COMMAND: sessionKeyBlob.SESSION_KEY_INSTALL_COMMAND,
  SESSION_KEY_CLEAR_COMMAND: sessionKeyBlob.SESSION_KEY_CLEAR_COMMAND,
  MAX_SESSION_KEY_DESCRIPTION_BYTES: sessionKeyBlob.MAX_SESSION_KEY_DESCRIPTION_BYTES,
  MAX_SESSION_DURATION_MS: sessionKeyBlob.MAX_SESSION_DURATION_MS,
  // Simulation and preflight: evidence for a review, never permission
  ...require('./simulation'),
  // Retry utility, one classification for every retry layer
  withRetry,
  isRetryableError,
  ...require('./proxyWitness'),
  ...require('./multisig'),
  ...require('./native'),
};
