import { createHash } from 'node:crypto';
import { resolveProxyWitnessTransaction, createProxyVerificationScript } from '../src/shared/proxyWitness.mjs';
const clean = (value) => String(value || '').replace(/^0x/i, '').toLowerCase();

function decodeHash(result) {
  const item = result?.stack?.[0];
  if (result?.state !== 'HALT' || item?.type !== 'ByteString') throw new Error('Proxy witness requires a successful core scope read');
  const bytes = Buffer.from(item.value, 'base64');
  if (bytes.length !== 20) throw new Error('Proxy witness core hash read is malformed');
  return bytes.reverse().toString('hex');
}

function proxyHashOf(coreHash, accountId) {
  const script = createProxyVerificationScript({ coreHash, accountId });
  return createHash('ripemd160').update(createHash('sha256').update(Buffer.from(script, 'hex')).digest()).digest().reverse().toString('hex');
}

/**
 * Resolve the account's own proxy-witness transaction: the shape-bound executeUserOp(s) script, the
 * fee payer's signer, the restricted WitnessRules proxy signer and the proxy verification witness.
 * Every one of those is produced by the SDK builder in src/shared/proxyWitness.mjs, so the relay, the
 * wallet frontend and the SDK cannot grow separate constructions of this authority.
 *
 * Request metadata cannot choose signers, rules, witnesses or the scope target: the scope target and
 * the core's own proxy derivation are read from the submitting RPC, and a caller-supplied value is
 * never used. Returns null when the envelope moves no asset out of the account's proxy address.
 */
export async function resolveProxyTransferWitness({ invocation, feePayer, rpcClient, sc, enabled = false }) {
  if (!enabled) return null;
  const methods = ['executeUserOp', 'executeUserOps', 'executeSponsoredUserOp', 'executeSponsoredUserOps'];
  if (!methods.includes(invocation.operation)) return null;
  const args = invocation.args || [];
  const sponsored = invocation.operation.startsWith('executeSponsored');
  if (args.length !== (sponsored ? 5 : 2) || args[0]?.type !== 'Hash160') throw new Error('Invalid account execution envelope');
  const accountId = clean(args[0].value);
  const coreHash = clean(invocation.scriptHash);
  const batch = invocation.operation.endsWith('Ops');
  const ops = batch ? (args[1]?.type === 'Array' ? args[1].value : null) : [args[1]];
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('Invalid account execution operations');
  const proxy = proxyHashOf(coreHash, accountId);
  const transfers = ops.filter((op) => {
    const fields = ['Struct', 'Array'].includes(op?.type) ? op.value : [];
    return fields?.[1]?.type === 'String' && fields[1].value === 'transfer'
      && fields[2]?.type === 'Array' && fields[2].value?.[0]?.type === 'Hash160'
      && clean(fields[2].value[0].value) === proxy;
  });
  if (transfers.length === 0) return null;
  // A transaction witness outlives ExecuteUserOp's hook/verification context.
  // An untrusted paymaster can reuse target scope during settlement. Keep this
  // envelope disabled until sponsorship has a separately verified authority model.
  if (sponsored) throw new Error('Sponsored proxy transfers are not supported: settlement authority is not isolated');
  // Sequential reads to one node; a racing scope change is still rejected by witness verification.
  return resolveProxyWitnessTransaction({
    coreHash,
    accountId,
    invocation: { scriptHash: coreHash, operation: invocation.operation, args },
    feePayer,
    readState: async (request) => {
      const readArgs = [sc.ContractParam.hash160(request.accountId)];
      return {
        expectedProxyHash: decodeHash(await rpcClient.invokeFunction(coreHash, 'getProxyScriptHash', readArgs)),
        scopeTarget: decodeHash(await rpcClient.invokeFunction(coreHash, 'getVerifyScopeTarget', readArgs)),
      };
    },
  });
}
