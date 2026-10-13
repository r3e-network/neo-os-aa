// Current-source-only private-chain relay acceptance. Never accepts a public RPC.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const fx = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const endpoint = new URL(fx.rpcUrl);
if (endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) < 20000) throw new Error('Disposable loopback RPC required');
const require = createRequire(new URL('../../frontend/package.json', import.meta.url));
const { wallet, rpc: neonRpc } = require('@cityofzion/neon-js');
const feeCalculations = [];
const originalCalculate = neonRpc.RPCClient.prototype.calculateNetworkFee;
neonRpc.RPCClient.prototype.calculateNetworkFee = async function (transaction) {
  const fee = await originalCalculate.call(this, transaction);
  feeCalculations.push({ fee: String(fee), size: transaction.size, tx: transaction.toJson() });
  return fee;
};
const account = new wallet.Account(process.env.RELAY_PRIVATE_KEY_HEX);
delete process.env.RELAY_PRIVATE_KEY_HEX;
if (`0x${account.scriptHash}` !== fx.relay) throw new Error(`Relay key/address mismatch: ${account.scriptHash} vs ${fx.relay}`);
for (const key of Object.keys(process.env)) if (/^(AA_|MORPHEUS_|UPSTASH_|VITE_)/.test(key)) delete process.env[key];
Object.assign(process.env, { AA_RELAY_RPC_URL: fx.rpcUrl, AA_RELAY_WIF: account.WIF, AA_RELAY_ALLOWED_HASH: fx.core,
  AA_RELAY_ALLOW_UNSPONSORED: '1', AA_RELAY_PROXY_WITNESS_ENABLED: '1', AA_RELAY_MAX_SYSTEM_FEE: '3000000000',
  AA_RELAY_MAX_NETWORK_FEE: '3000000000', AA_RELAY_PROXY_NETWORK_FEE_RESERVE: '200000000', AA_RELAY_MAX_TOTAL_FEE: '3000000000', AA_RELAY_INCLUDE_RAW_ERRORS: '1' });
const { default: handler } = await import('../../frontend/api/relay-transaction.js');
async function rpc(method, params) {
  const reply = await fetch(fx.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
}
async function integer(contract, method, args) {
  const result = await rpc('invokefunction', [contract, method, args]);
  if (result.state !== 'HALT' || result.stack?.[0]?.type !== 'Integer') throw new Error(`${method} read failed`);
  return result.stack[0].value;
}
const H = (value) => ({ type: 'Hash160', value });
async function snapshot() {
  const result = {};
  for (const who of ['proxy', 'buyer', 'owner', 'relay']) result[who] = await integer(fx.gas, 'balanceOf', [H(fx[who])]);
  result.nonce = await integer(fx.core, 'getNonce', [H(fx.accountId), { type: 'Integer', value: '0' }]);
  result.deposit = await integer(fx.paymaster, 'getSponsorDeposit', [H(fx.sponsor)]);
  return result;
}
async function call(name, metaInvocation) {
  const before = await snapshot();
  const res = { statusCode: 0, body: null, setHeader() {}, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await handler({ method: 'POST', body: { metaInvocation }, headers: {}, query: {}, socket: { remoteAddress: `source-${name}` } }, res);
  let execution = null, transaction = null;
  if (res.body?.txid) {
    for (let attempt = 0; attempt < 60; attempt++) {
      try { execution = (await rpc('getapplicationlog', [res.body.txid])).executions?.[0]; } catch {}
      if (execution) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    transaction = await rpc('getrawtransaction', [res.body.txid, 1]);
  }
  return { name, before, after: await snapshot(), status: res.statusCode, response: res.body, execution, transaction };
}
const cases = [await call('invalidSignature', fx.invocations.invalidSignature)];
const refusals = [];
const reserve = process.env.AA_RELAY_PROXY_NETWORK_FEE_RESERVE;
delete process.env.AA_RELAY_PROXY_NETWORK_FEE_RESERVE;
refusals.push(await call('missingReserve', fx.invocations.direct));
process.env.AA_RELAY_PROXY_NETWORK_FEE_RESERVE = '1';
refusals.push(await call('insufficientReserve', fx.invocations.direct));
process.env.AA_RELAY_PROXY_NETWORK_FEE_RESERVE = reserve;
process.env.AA_RELAY_MAX_NETWORK_FEE = '1';
refusals.push(await call('networkFeeCeiling', fx.invocations.direct));
process.env.AA_RELAY_MAX_NETWORK_FEE = '3000000000';
cases.push(await call('direct', fx.invocations.direct));
cases.push(await call('sponsored', fx.invocations.sponsored));
console.log(JSON.stringify({ core: fx.core, accountId: fx.accountId, proxy: fx.proxy, buyer: fx.buyer, owner: fx.owner,
  relay: fx.relay, paymaster: fx.paymaster, sponsor: fx.sponsor, amount: fx.amount, feeCalculations, refusals, cases }));
