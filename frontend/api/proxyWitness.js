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

/**
 * A §4.1 argument is a ByteString of the stored byte order; a hash is therefore reversed into
 * display hex, and a method is the UTF-8 text of its bytes. Neither shape is guessed: an argument
 * that is not a ByteString has no interpretation here and yields an empty string.
 */
function byteStringHash(item) {
  if (item?.type !== 'ByteString' || typeof item.value !== 'string') return '';
  const raw = clean(item.value);
  return raw ? raw.match(/../g).reverse().join('') : '';
}

function byteStringText(item) {
  if (item?.type !== 'ByteString' || typeof item.value !== 'string') return '';
  const bytes = clean(item.value).match(/../g) || [];
  return Buffer.from(bytes.map((pair) => Number.parseInt(pair, 16))).toString('utf8');
}

function proxyHashOf(coreHash, accountId) {
  const script = createProxyVerificationScript({ coreHash, accountId });
  return createHash('ripemd160').update(createHash('sha256').update(Buffer.from(script, 'hex')).digest()).digest().reverse().toString('hex');
}

/** True when one 13-field v4 operation moves an asset out of the account's own proxy address. */
function operationTransfersFromProxy(operation, proxy) {
  const fields = ['Struct', 'Array'].includes(operation?.type) ? operation.value : [];
  if (!Array.isArray(fields) || fields.length !== 13) return false;
  if (byteStringText(fields[2]) !== 'transfer') return false;
  const args = fields[3]?.value;
  return Array.isArray(args) && byteStringHash(args[0]) === proxy;
}

/**
 * Resolve the account's own proxy-witness transaction: the shape-bound executeUserOp(s) script, the
 * fee payer's signer, the restricted WitnessRules proxy signer and the proxy verification witness.
 * Every one of those is produced by the SDK builder in src/shared/proxyWitness.mjs, so the relay, the
 * wallet frontend and the SDK cannot grow separate constructions of this authority.
 *
 * Request metadata cannot choose signers, rules or witnesses: the core's own proxy derivation is read
 * from the submitting RPC and the transaction is pinned to it. Returns null when the envelope moves
 * no asset out of the account's proxy address.
 */
export async function resolveProxyTransferWitness({ invocation, feePayer, rpcClient, sc, enabled = false }) {
  if (!enabled) return null;
  const methods = ['executeUserOp', 'executeUserOps', 'executeSponsoredUserOp', 'executeSponsoredUserOps'];
  if (!methods.includes(invocation.operation)) return null;
  const args = invocation.args || [];
  const sponsored = invocation.operation.startsWith('executeSponsored');
  if (args.length !== (sponsored ? 5 : 2)) throw new Error('Invalid account execution envelope');
  const accountId = byteStringHash(args[0]);
  if (!/^[0-9a-f]{40}$/.test(accountId)) throw new Error('Invalid account execution envelope');
  const coreHash = clean(invocation.scriptHash);
  const batch = invocation.operation.endsWith('Ops');
  const ops = batch ? (args[1]?.type === 'Array' ? args[1].value : null) : [args[1]];
  if (!Array.isArray(ops) || ops.length === 0) throw new Error('Invalid account execution operations');
  const proxy = proxyHashOf(coreHash, accountId);
  const transfers = ops.filter((op) => operationTransfersFromProxy(op, proxy));
  if (transfers.length === 0) return null;
  // A transaction witness outlives ExecuteUserOp's hook/verification context.
  // An untrusted paymaster can reuse target scope during settlement. Keep this
  // envelope disabled until sponsorship has a separately verified authority model.
  if (sponsored) throw new Error('Sponsored proxy transfers are not supported: settlement authority is not isolated');
  // One read to the submitting node; the transaction is pinned to the answer, so a proxy that
  // changed between the read and verification is refused by the chain, not silently accepted.
  return resolveProxyWitnessTransaction({
    coreHash,
    accountId,
    invocation: { scriptHash: coreHash, operation: invocation.operation, args },
    proxyHash: proxy,
    feePayer,
    readState: async (request) => ({
      proxyHash: decodeHash(await rpcClient.invokeFunction(coreHash, 'getProxyScriptHash', [sc.ContractParam.hash160(request.accountId)])),
    }),
  });
}
