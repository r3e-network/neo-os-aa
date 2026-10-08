// Test harness for the AA relay route: a loopback JSON-RPC node that counts every method it receives, an
// environment isolator for the AA_RELAY_* switches, and a request helper for the real handler. No live host is
// contacted: the node listens on 127.0.0.1 only.
import http from 'node:http';
import { createRequire } from 'node:module';

import relayHandler from '../../api/relay-transaction.js';
import { CORE_HASH, chain, relayRoute } from './aaChainFixtures.js';

const sdkRequire = createRequire(new URL('../../../sdk/js/package.json', import.meta.url));
const { wallet } = sdkRequire('@cityofzion/neon-js');

// Throwaway key for the relay signer of these tests. It is never printed and never leaves the process.
export const relayAccount = new wallet.Account();
export const RELAY_WIF = relayAccount.WIF;

const case7 = relayRoute.case7BroadcastGaslessOp;

export function haltResult(gasconsumed, ...stack) {
  return { script: 'AAAA', state: 'HALT', gasconsumed, exception: null, stack };
}

// Loopback JSON-RPC node. `invokeScript(n)` answers the n-th (0-based) invokescript call.
export async function startNode({ invokeScript }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const rpc = JSON.parse(raw);
      const index = calls.filter((method) => method === rpc.method).length;
      calls.push(rpc.method);
      const reply = (result, error) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(error
          ? { jsonrpc: '2.0', id: rpc.id, error }
          : { jsonrpc: '2.0', id: rpc.id, result }));
      };
      switch (rpc.method) {
        case 'getversion':
          return reply({ tcpport: 0, wsport: 0, nonce: 1, useragent: '/loopback-node/', protocol: { network: chain.source.networkMagic, addressversion: 53, msperblock: 15000 } });
        case 'invokescript':
          return reply(invokeScript(index));
        case 'invokefunction':
          return reply(null, { code: -100, message: 'previewUserOpValidation is not simulated by this node' });
        case 'getblockcount':
          return reply(1234);
        case 'calculatenetworkfee':
          return reply({ networkfee: case7.networkFee });
        case 'sendrawtransaction':
          return reply({ hash: case7.txid });
        default:
          return reply(null, { code: -32601, message: 'Method not found' });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    count: (method) => calls.filter((name) => name === method).length,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const ENV_OWNED = /^(AA_RELAY|AA_PAYMASTER|AA_API_FETCH|MORPHEUS_|UPSTASH_|VITE_AA_|VITE_MORPHEUS_)/;

export async function withRelay(node, overrides, fn) {
  const snapshot = {};
  for (const key of Object.keys(process.env)) {
    if (ENV_OWNED.test(key)) {
      snapshot[key] = process.env[key];
      delete process.env[key];
    }
  }
  const env = {
    AA_RELAY_RPC_URL: node.url,
    AA_RELAY_WIF: RELAY_WIF,
    AA_RELAY_ALLOWED_HASH: `0x${CORE_HASH}`,
    AA_RELAY_ALLOW_UNSPONSORED: '1',
    AA_RELAY_MAX_SYSTEM_FEE: '2000000000',
    AA_RELAY_MAX_NETWORK_FEE: '2000000000',
    ...overrides,
  };
  const touched = [];
  for (const [key, value] of Object.entries(env)) {
    if (value == null) continue;
    process.env[key] = value;
    touched.push(key);
  }
  try {
    return await fn();
  } finally {
    for (const key of touched) delete process.env[key];
    for (const [key, value] of Object.entries(snapshot)) process.env[key] = value;
  }
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    json(value) { this.payload = value; return this; },
  };
}

let sequence = 0;
export async function post(body) {
  const response = createResponse();
  await relayHandler({
    method: 'POST',
    headers: {},
    query: {},
    body,
    socket: { remoteAddress: `cu06-${process.pid}-${Date.now()}-${sequence += 1}` },
  }, response);
  return { status: response.statusCode, body: response.payload };
}

