// Builds a proxy-witness account transaction with the SDK's own builder and prints it.
// `usage: node sdk_proxy_builder_fixture.mjs <request.json>` (request on argv, result on stdout,
// one JSON object, exit 0 when the builder accepted the request and 1 when it refused).
//
// The request names the account, the operation and the fee payer. The scope target and the core's
// own proxy derivation are read from the request's RPC by the builder's reader, never taken from the
// request, so this fixture exercises the same authority path the relay and the wallet frontend use.
// The result carries the shape-bound script, both signers and the proxy verification witness: the
// caller may broadcast those exact bytes, or compare them with the node's own assembler.
import { readFileSync } from 'node:fs';
import { normalizeRelayContractParameter } from '../../shared/relayContractParameter.mjs';
import { resolveProxyWitnessTransaction, buildProxyWalletSignRequest } from '../../shared/proxyWitness.mjs';

const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));

function emit(body) {
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.exit(body.ok ? 0 : 1);
}

// An SDK refusal is the answer to an invalid request, not a crash: report the code so a caller can
// tell "the builder refused this" from "the fixture could not run".
process.on('uncaughtException', (error) => {
  emit({ ok: false, error: String(error?.message || error), code: error?.code || '' });
});

function fail(message) {
  emit({ ok: false, error: message });
}

function toParameter(value) {
  return normalizeRelayContractParameter(value, { depth: 0, byteEncoding: 'hex' });
}

function decodeHash160Stack(item) {
  if (item?.type === 'Hash160' && item.value) return String(item.value).replace(/^0x/i, '').toLowerCase();
  if (item?.type === 'ByteString' && item.value) {
    const raw = Buffer.from(item.value, 'base64').toString('hex');
    return raw ? Buffer.from(raw, 'hex').reverse().toString('hex') : '';
  }
  return '';
}

async function rpc(method, params) {
  const response = await fetch(request.rpcUrl, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload?.error) throw new Error(`rpc ${method}: ${payload.error.message || 'failed'}`);
  return payload.result;
}

const operation = request.batch ? 'executeUserOps' : 'executeUserOp';
const ops = (request.batch ? request.ops : [request]).map((entry) => ({
  type: 'Struct',
  value: [
    { type: 'Hash160', value: entry.target },
    { type: 'String', value: entry.method },
    { type: 'Array', value: (entry.args || []).map(toParameter) },
    { type: 'Integer', value: String(entry.nonce) },
    { type: 'Integer', value: String(entry.deadline) },
    { type: 'ByteArray', value: entry.signatureHex ? `0x${String(entry.signatureHex).replace(/^0x/, '')}` : '0x' },
  ],
}));

const invocation = {
  scriptHash: request.core,
  operation,
  args: [
    { type: 'Hash160', value: request.accountId },
    request.batch ? { type: 'Array', value: ops } : ops[0],
  ],
};

const coreHash = String(request.core).replace(/^0x/i, '').toLowerCase();
const accountId = String(request.accountId).replace(/^0x/i, '').toLowerCase();

const built = await resolveProxyWitnessTransaction({
  coreHash,
  accountId,
  invocation,
  feePayer: request.feePayer,
  feePayerScope: 'CalledByEntry',
  readState: async ({ accountId: account }) => {
    const read = async (method) => decodeHash160Stack((await rpc('invokefunction', [coreHash, method, [{ type: 'Hash160', value: `0x${account}` }], []])).stack?.[0]);
    return { expectedProxyHash: await read('getProxyScriptHash'), scopeTarget: await read('getVerifyScopeTarget') };
  },
});

const walletScope = request.feePayerScope || 'CustomContracts';
const signed = buildProxyWalletSignRequest({
  transaction: built,
  scope: walletScope,
  allowedContracts: request.feePayerAllowedContracts
    || (walletScope === 'CustomContracts' ? [coreHash, built.targetContract] : undefined),
});

emit({
  ok: true,
  operation: built.operation,
  script: built.script,
  scriptBase64: Buffer.from(built.script, 'hex').toString('base64'),
  coreHash: built.coreHash,
  accountId: built.accountId,
  scopeTarget: built.scopeTarget,
  targetContract: built.targetContract,
  proxyHash: built.proxyHash,
  signers: [...signed.signers],
  feePayerSigner: signed.feePayerSigner,
  proxySigner: signed.proxySigner,
  proxyWitness: signed.proxyWitness,
  walletSignRequest: { scope: signed.feePayerSigner.scopes, signers: [...signed.signers] },
});
