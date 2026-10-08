const { id, Signature, verifyTypedData } = require('ethers');
const { rpc } = require('./neonCompat');
const { buildV3UserOperationTypedData } = require('./metaTx');
const { createMultiSigTools, serializeMultiSigSignatures, toMultiSigRpcParameter } = require('../../../shared/multiSigCore.mjs');

const tools = createMultiSigTools({
  digest: id,
  buildTypedData: buildV3UserOperationTypedData,
  compactSignature: (full) => { const signature = Signature.from(full); return signature.r.slice(2) + signature.s.slice(2); },
  verifyTypedData,
});

/** Bind all chain reads and simulations to one RPC client and its reported network magic. */
function createMultiSigClient({ rpcUrl, rpcClient = new rpc.RPCClient(rpcUrl), signers = [] } = {}) {
  if (typeof rpcClient.send !== 'function' || typeof rpcClient.getVersion !== 'function') throw new Error('MultiSig: RPC client must expose send and getVersion');
  // Use the shared wire encoder exactly once; neonCompat.fromJson intentionally supports fewer parameter kinds.
  const read = (contract, method, args) => rpcClient.send('invokefunction', [`0x${contract}`, method, args.map(toMultiSigRpcParameter), signers]);
  const network = async () => {
    const version = await rpcClient.getVersion();
    const magic = version?.protocol?.network;
    if (!Number.isInteger(magic) || magic < 0 || magic > 0xffffffff) throw new Error('MultiSig: RPC network magic unavailable');
    return String(magic);
  };
  return {
    fetchContext: async (input) => tools.fetchMultiSigContext({ ...input, read, networkMagic: await network() }),
    prepareOperation: (input) => tools.prepareMultiSigOperation({ ...input, read }),
    buildChildTypedData: tools.buildMultiSigChildTypedData,
    fetchChildPayload: (input) => tools.fetchMultiSigChildPayload({ ...input, read }),
    buildBundle: tools.buildMultiSigBundle,
    buildChildConfiguration: tools.buildMultiSigChildConfigurationInvocation,
    readPendingConfiguration: (input) => tools.readMultiSigPendingConfiguration({ ...input, read }),
    validateBundle: async (input) => tools.validateMultiSigBundle({ ...input, read, networkMagic: await network() }),
  };
}

module.exports = { createMultiSigClient, serializeMultiSigSignatures, ...tools };
