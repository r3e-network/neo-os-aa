/**
 * The native kernel SDK entry point: the v4 protocol codec, the shared client
 * bound to the native core, and the transaction lifecycle.
 *
 * Discovery verifies the native manifest and v4 parameter digest before
 * returning the contract, network, protocol version and implementation ID.
 */

const { rpc } = require("./neonCompat");
const { codec: nativeCodec } = require("./codec");
const {
  NATIVE_SMART_ACCOUNT_CONTRACT,
  NATIVE_ABI_VERSION,
  PROTOCOL_VERSION,
} = require("../../../shared/nativeSmartAccount.mjs");
const {
  createNativeClientClass,
  NATIVE_ACCOUNT_ADDRESS_ABI,
  NATIVE_PROFILE_PARAMETER_DIGEST,
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
} = require("./native/client");
const { createNativeTransactionTools } = require("./native/transaction");
const { codeIdentityTools } = require("./native/moduleIdentity");
const { withRetry } = require("./retry");

/** The native kernel pushes CallFlags.ReadOnly (5) in the proxy script. */
const NATIVE_PROXY_CALL_FLAGS = 5;
const transactionTools = createNativeTransactionTools(nativeCodec);

/**
 * Retry belongs to the transport, not to each caller: every read the client
 * makes goes through `send`, so wrapping it here covers discovery, descriptor
 * reads and simulations alike. A contract fault is an answer, not a transient
 * failure, so only the shared retryable classification is retried. `retry:
 * false` opts out; an object overrides the backoff (as `withRetry` accepts).
 */
function retryingTransport(transport, retry) {
  if (retry === false) return transport;
  const config = retry && typeof retry === "object" ? retry : undefined;
  return {
    ...transport,
    send: (method, params) =>
      withRetry(method, () => transport.send(method, params), config),
  };
}

const NativeClient = createNativeClientClass(nativeCodec, {
  contractHash: NATIVE_SMART_ACCOUNT_CONTRACT,
  callFlags: NATIVE_PROXY_CALL_FLAGS,
});

class NativeSmartAccountClient extends NativeClient {
  constructor(options = {}) {
    const { retry, rpcClient, ...rest } = options;
    const transport = rpcClient ?? new rpc.RPCClient(rest.rpcUrl);
    super({
      ...rest,
      rpcClient: retryingTransport(transport, retry),
    });
  }
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
 * Factory form of the native client entry point; the only kernel this SDK
 * ships. Options are those of {@link NativeSmartAccountClient}.
 */
function createNativeSmartAccountClient(options) {
  return new NativeSmartAccountClient(options);
}

module.exports = {
  NativeSmartAccountClient,
  createNativeSmartAccountClient,
  nativeCodec,
  transactionTools,
  codeIdentityTools,
  NATIVE_ACCOUNT_ADDRESS_ABI,
  NATIVE_PROFILE_PARAMETER_DIGEST,
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
  NATIVE_SMART_ACCOUNT_CONTRACT,
  NATIVE_ABI_VERSION,
  PROTOCOL_VERSION,
  NATIVE_PROXY_CALL_FLAGS,
};
