// Drives the AA frontend's real relay route handler (frontend/api/relay-transaction.js) against a local chain.
// usage: node relay_probe.mjs <fixture.json>   (env: RELAY_PRIVATE_KEY_HEX = throwaway dev-chain key, never printed)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const AA = fileURLToPath(new URL('../../', import.meta.url));
const fx = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const sdkRequire = createRequire(`${AA}/sdk/js/package.json`);
const { wallet } = sdkRequire('@cityofzion/neon-js');
const relayAccount = new wallet.Account(process.env.RELAY_PRIVATE_KEY_HEX);
delete process.env.RELAY_PRIVATE_KEY_HEX;

const { buildExecuteUserOpInvocation } = await import(`${AA}/frontend/src/features/operations/metaTx.js`);
const relay = await import(`${AA}/frontend/api/relay-transaction.js`);

function baseEnv() {
  for (const k of Object.keys(process.env)) if (k.startsWith('AA_RELAY') || k.startsWith('MORPHEUS_PAYMASTER') || k.startsWith('AA_PAYMASTER')) delete process.env[k];
  process.env.AA_RELAY_RPC_URL = fx.rpcUrl;
  process.env.AA_RELAY_WIF = relayAccount.WIF;
  process.env.AA_RELAY_ALLOWED_HASH = fx.core;
}
function makeRes() {
  const res = { statusCode: 0, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
async function call(body) {
  const req = { method: 'POST', body, headers: {}, query: {}, socket: { remoteAddress: '127.0.0.1' } };
  const res = makeRes();
  await relay.default(req, res);
  return { status: res.statusCode, body: res.body };
}
function meta(nonce, signatureHex) {
  return buildExecuteUserOpInvocation({
    aaContractHash: fx.core, accountIdHash: fx.accountId, targetContract: fx.target, method: fx.method,
    methodArgs: fx.methodArgs, nonce, deadline: fx.deadline, signatureHex,
  });
}
function brief(r) {
  const b = r.body || {};
  return { status: r.status, error: b.error, code: b.code, ok: b.ok, vmState: b.vmState, exception: b.exception, message: b.message,
           txid: b.txid, gasConsumed: b.gasConsumed, systemFee: b.systemFee, networkFee: b.networkFee,
           validationPreview: b.validationPreview, paymaster: b.paymaster };
}
const out = [];
const rec = async (name, fn) => { try { out.push({ case: name, ...brief(await fn()) }); } catch (e) { out.push({ case: name, thrown: String(e?.message || e).slice(0, 300) }); } };

// 1. read-only simulation (what the UI "relay preflight" calls)
baseEnv(); process.env.AA_RELAY_ALLOW_UNSPONSORED = '1';
await rec('1 simulate valid session-signed op', () => call({ metaInvocation: meta(fx.nonce, fx.signatureHex), simulate: true }));
const tampered = (fx.signatureHex.slice(0, 2) === 'ff' ? '00' : 'ff') + fx.signatureHex.slice(2);
await rec('2 simulate tampered signature', () => call({ metaInvocation: meta(fx.nonce, tampered), simulate: true }));
// 3. default production posture: no paymaster configured, no explicit opt-in
baseEnv(); process.env.AA_RELAY_MAX_SYSTEM_FEE = '2000000000';
await rec('3 broadcast with no paymaster and no AA_RELAY_ALLOW_UNSPONSORED', () => call({ metaInvocation: meta(fx.nonce, fx.signatureHex) }));
// 4. opted in, but no fee ceiling
baseEnv(); process.env.AA_RELAY_ALLOW_UNSPONSORED = '1';
await rec('4 broadcast opted-in but no fee ceiling configured', () => call({ metaInvocation: meta(fx.nonce, fx.signatureHex) }));
// 5. wrong contract hash is refused before any signing
baseEnv(); process.env.AA_RELAY_ALLOW_UNSPONSORED = '1'; process.env.AA_RELAY_MAX_SYSTEM_FEE = '2000000000';
await rec('5 meta invocation addressed to another contract', () => call({ metaInvocation: { ...meta(fx.nonce, fx.signatureHex), scriptHash: fx.otherHash } }));
// 6. fee ceiling lower than the real cost
baseEnv(); process.env.AA_RELAY_ALLOW_UNSPONSORED = '1'; process.env.AA_RELAY_MAX_SYSTEM_FEE = '1000';
await rec('6 broadcast with a system-fee ceiling below the real cost', () => call({ metaInvocation: meta(fx.nonce, fx.signatureHex) }));
// 7. real broadcast, paid by the relay account (opted in + ceilings)
baseEnv(); process.env.AA_RELAY_ALLOW_UNSPONSORED = '1'; process.env.AA_RELAY_MAX_SYSTEM_FEE = '2000000000'; process.env.AA_RELAY_MAX_NETWORK_FEE = '2000000000';
await rec('7 broadcast gasless op (relay pays, user holds no GAS)', () => call({ metaInvocation: meta(fx.nonce, fx.signatureHex) }));
// 8. a session-signed GAS transfer from the account's proxy address, as the route would submit it (relay is the only signer)
if (fx.gasFixture) {
  baseEnv(); process.env.AA_RELAY_ALLOW_UNSPONSORED = '1';
  const g = fx.gasFixture;
  const inv = buildExecuteUserOpInvocation({ aaContractHash: fx.core, accountIdHash: g.accountId, targetContract: g.target, method: g.method,
    methodArgs: g.methodArgs, nonce: g.nonce, deadline: g.deadline, signatureHex: g.signatureHex });
  try {
    const r = await call({ metaInvocation: inv, simulate: true });
    const b = r.body || {};
    out.push({ case: '8 simulate session-signed GAS transfer through the route', status: r.status, ok: b.ok, code: b.code, vmState: b.vmState, exception: b.exception,
               gasConsumed: b.gasConsumed, stackFirst: Array.isArray(b.stack) && b.stack[0] ? b.stack[0].value : undefined });
  } catch (e) { out.push({ case: '8 simulate session-signed GAS transfer through the route', thrown: String(e?.message || e).slice(0, 300) }); }
  baseEnv(); process.env.AA_RELAY_ALLOW_UNSPONSORED = '1'; process.env.AA_RELAY_MAX_SYSTEM_FEE = '2000000000'; process.env.AA_RELAY_MAX_NETWORK_FEE = '2000000000';
  try {
    const r = await call({ metaInvocation: inv });
    const b = r.body || {};
    out.push({ case: '9 broadcast the same transfer through the route', status: r.status, error: b.error, code: b.code, ok: b.ok, txid: b.txid, systemFee: b.systemFee, networkFee: b.networkFee });
  } catch (e) { out.push({ case: '9 broadcast the same transfer through the route', thrown: String(e?.message || e).slice(0, 300) }); }
}
console.log(JSON.stringify(out));
