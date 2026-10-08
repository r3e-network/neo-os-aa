import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';

// This probe is copied into an isolated frontend-only tree, without a sibling
// SDK. Its imports and handlers are the actual deployable source files.
for (const file of await fs.readdir(new URL('./api/', import.meta.url))) {
  if (file.endsWith('.js')) await import(new URL(`./api/${file}`, import.meta.url));
}
const require = createRequire(import.meta.url);
const { wallet } = require('@cityofzion/neon-js');
const { default: relay } = await import('./api/relay-transaction.js');
const { default: metadata } = await import('./api/account-metadata.js');
const calls = [];
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => {
    const rpc = JSON.parse(data);
    calls.push(rpc.method);
    assert.ok(['invokefunction', 'invokescript'].includes(rpc.method), `unexpected mutation or RPC: ${rpc.method}`);
    const result = rpc.method === 'invokescript'
      ? { state: 'HALT', gasconsumed: '1000000', stack: [{ type: 'Boolean', value: true }] }
      : { state: 'HALT', stack: [{ type: 'ByteString', value: Buffer.alloc(20).toString('base64') }] };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const rpcUrl = `http://127.0.0.1:${server.address().port}`;
const coreHash = '11'.repeat(20);
const account = new wallet.Account(); // Ephemeral test key, never persisted or printed.
Object.assign(process.env, {
  AA_RELAY_RPC_URL: rpcUrl,
  AA_RELAY_WIF: account.WIF,
  AA_RELAY_ALLOWED_HASH: coreHash,
  AA_RELAY_ALLOW_UNSPONSORED: '1',
  SUPABASE_URL: rpcUrl,
  SUPABASE_SERVICE_ROLE_KEY: 'local-test-service-key',
});

function response() {
  return {
    code: 200, body: null,
    status(code) { this.code = code; return this; },
    setHeader() {},
    json(body) { this.body = body; return this; },
  };
}
function request(body) {
  return { method: 'POST', headers: {}, query: {}, body, socket: { remoteAddress: '127.0.0.1' } };
}

try {
  const relayResponse = response();
  await relay(request({ simulate: true, metaInvocation: {
    scriptHash: coreHash, operation: 'executeUserOp', args: [
      { type: 'Hash160', value: '22'.repeat(20) },
      { type: 'Struct', value: [
        { type: 'Hash160', value: '33'.repeat(20) }, { type: 'String', value: 'balanceOf' },
        { type: 'Array', value: [] }, { type: 'Integer', value: '0' },
        { type: 'Integer', value: '2000000000000' }, { type: 'ByteArray', value: 'aa'.repeat(64) },
      ] },
    ],
  } }), relayResponse);
  assert.equal(relayResponse.code, 200, JSON.stringify(relayResponse.body));
  assert.equal(relayResponse.body.ok, true, JSON.stringify(relayResponse.body));
  assert.ok(calls.includes('invokescript'), 'real relay transaction serializer and Neon RPC client ran');

  const metadataResponse = response();
  await metadata(request({ action: 'upsert', accountIdHash: '22'.repeat(20), ownerProof: {} }), metadataResponse);
  assert.equal(metadataResponse.code, 401, JSON.stringify(metadataResponse.body));
  assert.equal(metadataResponse.body.error, 'Invalid backup owner signature');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
