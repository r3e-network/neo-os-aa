/**
 * Neo Smart Account v4 SDK — the public entry point of the native kernel.
 *
 * One kernel, one protocol: the native SmartAccount core (a native contract,
 * negative id, fixed script hash) speaks the v4 13-field operation, the 191-bit
 * channel nonce, the §4.3 operation digest, the §8 message digest,
 * configuration intents, module instances and the `SA_*` vocabulary. Its proxy
 * verification script calls `verify(accountId)` with CallFlags.ReadOnly (5),
 * so every derived account address is bound to that flag.
 *
 * This module is the single public surface. It re-exports the native client
 * (`NativeSmartAccountClient`), the shared protocol codec, the operation
 * builder, error vocabulary, transfer result rules, session-key commands,
 * simulation/preflight and the transaction lifecycle. Nothing here is
 * kernel-specific beyond the native core identity.
 *
 * Removed with the custom delivery track: the deployed-kernel client
 * (`SmartAccountClient`), `createSmartAccountClient`, the market-escrow,
 * platform-registrar, metadata, migration and sponsored-execution surfaces,
 * and the `CUSTOM_*` constants. Removed earlier with the v3 surface:
 * `registerAccount`, `getVerifier`, `updateVerifier`, `getHook`, `updateHook`,
 * `createAccountPayload` and the 6-field operation. There is no alias: a
 * removed call fails to resolve.
 */

const { wallet } = require('./neonCompat');
const { codec } = require('./codec');
const {
  EC,
  createError,
  mapRpcError,
  formatError,
  SA_ERRORS,
  SA_ERROR_CODES,
} = require('./errors');
const { validateHash160 } = require('./validation');
const { withRetry, isRetryableError } = require('./retry');
const { PROTOCOL_VERSION } = require('../../../shared/nativeSmartAccount.mjs');
const metaTx = require('./metaTx');
const transferOutcome = require('../../../shared/transferOutcome.mjs');
const sessionKeyBlob = require('../../../shared/sessionKeyBlob.mjs');

/** Neo address or 40-hex hash to display-order hex. */
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

module.exports = {
  // Protocol identity
  codec,
  PROTOCOL_VERSION,
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
  // Native kernel client, transaction lifecycle and ABI gates
  ...require('./native'),
};
