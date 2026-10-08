import { createHash } from 'node:crypto';
import { createProxyVerificationScript, createProxyWitness } from '../src/shared/proxyWitness.mjs';
const clean = (value) => String(value || '').replace(/^0x/i, '').toLowerCase();

function decodeHash(result) {
  const item = result?.stack?.[0];
  if (result?.state !== 'HALT' || item?.type !== 'ByteString') throw new Error('Proxy witness requires a successful core scope read');
  const bytes = Buffer.from(item.value, 'base64');
  if (bytes.length !== 20) throw new Error('Proxy witness core hash read is malformed');
  return bytes.reverse().toString('hex');
}

/** Resolve only the account's own transfer witness; request metadata cannot choose signers or scripts. */
export async function resolveProxyTransferWitness({ invocation, feePayer, rpcClient, sc, enabled = false }) {
  if (!enabled) return null;
  const methods = ['executeUserOp', 'executeUserOps', 'executeSponsoredUserOp', 'executeSponsoredUserOps'];
  if (!methods.includes(invocation.operation)) return null;
  const args = invocation.args || [];
  const sponsored = invocation.operation.startsWith('executeSponsored');
  if (args.length !== (sponsored ? 5 : 2) || args[0]?.type !== 'Hash160') throw new Error('Invalid account execution envelope');
  const accountId = clean(args[0].value);
  const coreHash = clean(invocation.scriptHash);
  const script = createProxyVerificationScript({ coreHash, accountId });
  const proxy = createHash('ripemd160').update(createHash('sha256').update(Buffer.from(script, 'hex')).digest()).digest().reverse().toString('hex');
  const batch = invocation.operation.endsWith('Ops');
  const ops = batch ? (args[1]?.type === 'Array' ? args[1].value : null) : [args[1]];
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('Invalid account execution operations');
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
  const target = clean(transfers[0].value[0]?.value);
  if (transfers.some((op) => op.value[0]?.type !== 'Hash160' || clean(op.value[0].value) !== target)) throw new Error('Proxy transfers in a batch must share the configured scope target');
  // Sequential reads to one node; a racing scope change is still rejected by witness verification.
  const readArgs = [sc.ContractParam.hash160(accountId)];
  const expectedProxyHash = decodeHash(await rpcClient.invokeFunction(coreHash, 'getProxyScriptHash', readArgs));
  const scopeTarget = decodeHash(await rpcClient.invokeFunction(coreHash, 'getVerifyScopeTarget', readArgs));
  return createProxyWitness({ coreHash, accountId, targetContract: target, scopeTarget, feePayer, expectedProxyHash });
}
