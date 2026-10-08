const crypto = require("node:crypto");
const { rpc } = require("./neonCompat");
const {
  createNativeCodec,
  NATIVE_ACCOUNT_SERVICE,
  NATIVE_ABI_VERSION,
} = require("../../../shared/nativeSmartAccount.mjs");
const digest = (algorithm, hex) =>
  crypto.createHash(algorithm).update(Buffer.from(hex, "hex")).digest("hex");
const nativeCodec = createNativeCodec({
  sha256: (hex) => digest("sha256", hex),
  hash160: (hex) => digest("ripemd160", digest("sha256", hex)),
});
const {
  createNativeClientClass,
  NATIVE_PROFILE_PARAMETER_DIGEST,
} = require("./native/client");
const { createNativeTransactionTools } = require("./native/transaction");
const transactionTools = createNativeTransactionTools(nativeCodec);
class NativeSmartAccountClient extends createNativeClientClass(nativeCodec) {
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
  preflightTransaction(signed) {
    return transactionTools.preflightNativeTransaction(this, signed);
  }
  getTransactionReceipt(signed) {
    return transactionTools.getNativeTransactionReceipt(this, signed);
  }
  broadcastTransaction(signed) {
    return transactionTools.broadcastNativeTransaction(this, signed);
  }
}
module.exports = {
  NativeSmartAccountClient,
  NATIVE_PROFILE_PARAMETER_DIGEST,
  nativeCodec,
  createNativeCodec,
  NATIVE_ACCOUNT_SERVICE,
  NATIVE_ABI_VERSION,
};
