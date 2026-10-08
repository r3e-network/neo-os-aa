import { id, Signature, verifyTypedData } from 'ethers';
import { buildV3UserOperationTypedData } from './metaTx.js';
import { createMultiSigTools, toMultiSigRpcParameter } from '../../shared/multiSigCore.mjs';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';

const tools = createMultiSigTools({
  digest: id,
  buildTypedData: buildV3UserOperationTypedData,
  compactSignature: (full) => { const signature = Signature.from(full); return signature.r.slice(2) + signature.s.slice(2); },
  verifyTypedData,
});

/** Explicit MultiSig session API. Generic collaboration records are never implicitly converted. */
export function createMultiSigDraftSession({ rpcUrl, signers = [], fetchImpl } = {}) {
  const rpc = async (method, params = []) => {
    const response = await fetchWithTimeout(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, { fetchImpl });
    if (!response.ok) throw new Error('MultiSig RPC request failed');
    const payload = await response.json();
    if (payload.error) throw new Error(payload.error.message || 'MultiSig RPC error');
    return payload.result;
  };
  const network = async () => {
    const version = await rpc('getversion');
    const magic = version?.protocol?.network;
    if (!Number.isInteger(magic) || magic < 0 || magic > 0xffffffff) throw new Error('MultiSig: RPC network magic unavailable');
    return String(magic);
  };
  const read = (contract, method, args) => rpc('invokefunction', [`0x${contract}`, method, args.map(toMultiSigRpcParameter), signers]);
  return {
    fetchContext: async (input) => tools.fetchMultiSigContext({ ...input, networkMagic: await network(), read }),
    prepareOperation: (input) => tools.prepareMultiSigOperation({ ...input, read }),
    buildChildTypedData: tools.buildMultiSigChildTypedData,
    fetchChildPayload: (input) => tools.fetchMultiSigChildPayload({ ...input, read }),
    buildBundle: tools.buildMultiSigBundle,
    buildChildConfiguration: tools.buildMultiSigChildConfigurationInvocation,
    readPendingConfiguration: (input) => tools.readMultiSigPendingConfiguration({ ...input, read }),
    validateBundle: async (input) => tools.validateMultiSigBundle({ ...input, networkMagic: await network(), read }),
  };
}
