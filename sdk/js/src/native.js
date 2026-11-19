/**
 * The native kernel SDK entry point: the v4 protocol codec, the shared client
 * bound to the native core, and the transaction lifecycle.
 *
 * The v3 surface (`createNativeCodec`, `NATIVE_ABI_VERSION 2`, the verifier
 * witness registry, `NATIVE_PROFILE_PARAMETER_DIGEST`) is gone. A profile is
 * now read from the chain (`discover()` returns `{contract, networkMagic,
 * protocolVersion, implementationId}`), not pinned as a parameter digest.
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
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
} = require("./native/client");
const { createNativeTransactionTools } = require("./native/transaction");
const { codeIdentityTools } = require("./native/moduleIdentity");

/** The native kernel pushes CallFlags.ReadOnly (5) in the proxy script. */
const NATIVE_PROXY_CALL_FLAGS = 5;
const transactionTools = createNativeTransactionTools(nativeCodec);

const NativeClient = createNativeClientClass(nativeCodec, {
  contractHash: NATIVE_SMART_ACCOUNT_CONTRACT,
  callFlags: NATIVE_PROXY_CALL_FLAGS,
  nativeCore: true,
});

class NativeSmartAccountClient extends NativeClient {
  constructor(options = {}) {
    super({
      ...options,
      rpcClient: options.rpcClient ?? new rpc.RPCClient(options.rpcUrl),
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

module.exports = {
  NativeSmartAccountClient,
  nativeCodec,
  transactionTools,
  codeIdentityTools,
  NATIVE_REQUIRED_ABI,
  NATIVE_REQUIRED_EVENTS,
  NATIVE_SMART_ACCOUNT_CONTRACT,
  NATIVE_ABI_VERSION,
  PROTOCOL_VERSION,
  NATIVE_PROXY_CALL_FLAGS,
};
