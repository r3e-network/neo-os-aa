// Drives the AA frontend's real relay route handler (frontend/api/relay-transaction.js) against a local chain.
// usage: node relay_probe.mjs <fixture.json>   (env: RELAY_PRIVATE_KEY_HEX = throwaway dev-chain key, never printed)
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
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
  // The route's in-memory limiter allows 10 requests per minute per client, and this probe makes more
  // requests than that: key each case by its own loopback client address instead of waiting a minute.
  process.env.AA_TRUST_PROXY_HEADERS = '1';
  process.env.AA_TRUST_PROXY_HEADER = 'x-real-ip';
}
function makeRes() {
  const res = { statusCode: 0, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
async function call(body, clientIp = '127.0.0.1') {
  const req = { method: 'POST', body, headers: { 'x-real-ip': clientIp }, query: {}, socket: { remoteAddress: '127.0.0.1' } };
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
// The sponsored wire shape (executeSponsoredUserOp: accountId, op, paymaster, sponsor, reimbursementAmount)
// as a wallet would submit it; the route's own allowlist accepts this operation.
function sponsoredMeta() {
  const g = fx.sponsored;
  return {
    scriptHash: fx.core,
    operation: 'executeSponsoredUserOp',
    args: [
      { type: 'Hash160', value: g.accountId },
      { type: 'Struct', value: [
        { type: 'Hash160', value: g.target },
        { type: 'String', value: g.method },
        { type: 'Array', value: g.methodArgs },
        { type: 'Integer', value: String(g.nonce) },
        { type: 'Integer', value: String(g.deadline) },
        { type: 'ByteArray', value: `0x${g.signatureHex}` },
      ] },
      { type: 'Hash160', value: g.paymaster },
      { type: 'Hash160', value: g.sponsor },
      { type: 'Integer', value: String(g.reimbursementAmount) },
    ],
  };
}
const sha256Hex = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Loopback paymaster stub: 127.0.0.1 only, ephemeral port (asserted above 20000), replies scripted per case
// and every request recorded so the caller can check what the route actually sent.
async function startPaymaster() {
  const state = { mode: 'approve', requests: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { body = null; }
      const operationHash = typeof body?.operation_hash === 'string' ? body.operation_hash : '';
      state.requests.push({ mode: state.mode, authorization: req.headers.authorization || '', body, operationHash });
      const echo = { approved: true, operation_hash: operationHash, approved_max_fee: '2000000000' };
      const replies = {
        approve: { status: 200, body: echo },
        deny: { status: 200, body: { approved: false, reason: 'no_budget' } },
        'wrong-hash': { status: 200, body: { ...echo, operation_hash: 'de'.repeat(32) } },
        // Echoes the operation hash but never says approved: true, so only the positive-approval rule
        // can reject this answer and the operation-hash rule cannot mask it.
        unapproved: { status: 200, body: { operation_hash: operationHash, max_fee: '2000000000' } },
        'low-ceiling': { status: 200, body: { ...echo, approved_max_fee: '1' } },
      };
      const reply = replies[state.mode] || replies.approve;
      res.setHeader('content-type', 'application/json');
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  if (!(port > 20000)) throw new Error(`loopback paymaster port ${port} is not above 20000`);
  return { url: `http://127.0.0.1:${port}`, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function closedLoopbackUrl() {
  const probe = http.createServer(() => {});
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  if (!(port > 20000)) throw new Error(`loopback port ${port} is not above 20000`);
  return `http://127.0.0.1:${port}`;
}

// A broadcast returns its transaction id before the transaction is included in a block, so the
// account nonce a later invocation must use only changes once the application log exists. Wait for
// it instead of racing the next invocation against the miner.
async function waitForExecution(txid, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = await fetch(fx.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getapplicationlog', params: [txid] }),
    }).then((r) => r.json()).catch(() => null);
    const execution = reply?.result?.executions?.[0];
    if (execution) return execution;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
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
// 10-15 the paymaster authorization branch, against a loopback stub on 127.0.0.1 (no live host, no token
// besides the stub's own throwaway string). Every request the route makes is recorded and reported.
const paymaster = await startPaymaster();
const withPaymaster = (mode) => {
  baseEnv();
  paymaster.state.mode = mode;
  process.env.MORPHEUS_PAYMASTER_ENDPOINT = paymaster.url;
  process.env.MORPHEUS_PAYMASTER_API_TOKEN = 'loopback-paymaster-token';
  process.env.AA_RELAY_MAX_SYSTEM_FEE = '2000000000';
  process.env.AA_RELAY_MAX_NETWORK_FEE = '2000000000';
};
const approvalCase = async (name, mode, dappId, clientIp) => {
  withPaymaster(mode);
  const from = paymaster.state.requests.length;
  const r = await call({ paymaster: { dapp_id: dappId }, metaInvocation: meta(fx.nonceNext, fx.signatureHexNext) }, clientIp);
  out.push({ case: name, ...brief(r), paymasterRequests: paymaster.state.requests.slice(from) });
};
withPaymaster('approve');
const expected10 = sha256Hex(meta(fx.nonceNext, fx.signatureHexNext));
const from10 = paymaster.state.requests.length;
{
  const broadcast = out.find((entry) => entry.case.startsWith('7 '));
  const executed = broadcast?.txid ? await waitForExecution(broadcast.txid) : null;
  const r = await call({ simulate: true, paymaster: { dapp_id: 'case-10' }, metaInvocation: meta(fx.nonceNext, fx.signatureHexNext) }, '10.0.0.10');
  out.push({ case: '10 simulate with an approved loopback paymaster', ...brief(r), expectedOperationHash: expected10,
             waitedForCase7: Boolean(executed), case7VmState: executed?.vmstate || '',
             sentOperationHash: paymaster.state.requests[from10]?.operationHash || '',
             paymasterRequests: paymaster.state.requests.slice(from10) });
}
await approvalCase('11 broadcast with an approval for another operation hash', 'wrong-hash', 'case-11', '10.0.0.11');
await approvalCase('12 broadcast the paymaster explicitly denies', 'deny', 'case-12', '10.0.0.12');
await approvalCase('13 broadcast an answer without a positive approval', 'unapproved', 'case-13', '10.0.0.13');
await approvalCase('14 broadcast an approval ceiling below the real cost', 'low-ceiling', 'case-14', '10.0.0.14');
// 15. the endpoint is not listening: the route must fail closed instead of signing unsponsored.
baseEnv();
process.env.MORPHEUS_PAYMASTER_ENDPOINT = await closedLoopbackUrl();
process.env.MORPHEUS_PAYMASTER_API_TOKEN = 'loopback-paymaster-token';
process.env.AA_RELAY_MAX_SYSTEM_FEE = '2000000000';
await rec('15 broadcast with an unreachable paymaster endpoint', () => call({ paymaster: { dapp_id: 'case-15' }, metaInvocation: meta(fx.nonceNext, fx.signatureHexNext) }, '10.0.0.15'));
// 16. the route prices every invocation with a simulation, and the deployed core's settlement cap
// (min(requested, systemFee + networkFee)) reads zero fees in that pricing container, so a sponsored
// invocation faults there and the route refuses it. Recorded as the deployed core's limit: a sponsored
// operation is only expressible by direct submission (AA-08), not through this route.
baseEnv(); process.env.AA_RELAY_ALLOW_UNSPONSORED = '1';
process.env.AA_RELAY_MAX_SYSTEM_FEE = '2000000000'; process.env.AA_RELAY_MAX_NETWORK_FEE = '2000000000';
await rec('16 broadcast an on-chain sponsored operation through the route', () => call({ metaInvocation: sponsoredMeta() }, '10.0.0.16'));
await paymaster.close();
console.log(JSON.stringify(out));
