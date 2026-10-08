import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { resolveProxyTransferWitness } from '../api/proxyWitness.js';
import { buildOperationFromPreset } from '../src/features/operations/presets.js';
import { post, withRelay, relayAccount } from './fixtures/relayHarness.js';
import { CORE_HASH, GAS_HASH, BUYER_HASH } from './fixtures/aaChainFixtures.js';
const require = createRequire(new URL('../../sdk/js/package.json', import.meta.url));
const { tx, sc, wallet } = require('@cityofzion/neon-js');
const { createProxyWitness } = require('../../sdk/js/src/proxyWitness.js');
const accountId = 'ab'.repeat(20);
const core = CORE_HASH.replace(/^0x/, '');
const target = GAS_HASH.replace(/^0x/, '');
const expected = createProxyWitness({ coreHash: core, accountId, targetContract: target, scopeTarget: target, feePayer: relayAccount.scriptHash });
const proxy = expected.signer.account;
const hashResult = (hash) => ({ state: 'HALT', stack: [{ type: 'ByteString', value: Buffer.from(hash.replace(/^0x/, ''), 'hex').reverse().toString('base64') }] });
function invocation(sponsored = false) {
  return { scriptHash: core, operation: sponsored ? 'executeSponsoredUserOp' : 'executeUserOp', args: [
    { type: 'Hash160', value: accountId },
    { type: 'Struct', value: [ { type: 'Hash160', value: target }, { type: 'String', value: 'transfer' },
      { type: 'Array', value: [{ type: 'Hash160', value: proxy }, { type: 'Hash160', value: BUYER_HASH }, { type: 'Integer', value: '100' }, { type: 'Any', value: null }] },
      { type: 'Integer', value: '0' }, { type: 'Integer', value: '9999999999999' }, { type: 'ByteArray', value: '01'.repeat(64) },
    ] },
    ...(sponsored ? [{ type: 'Hash160', value: 'cd'.repeat(20) }, { type: 'Hash160', value: 'ef'.repeat(20) }, { type: 'Integer', value: '10000' }] : []),
  ] };
}

test('resolver derives immutable proxy signer and rejects unconfigured/mismatched chain data', async () => {
  const calls = [];
  const rpcClient = { async invokeFunction(hash, method) { calls.push([hash, method]); return hashResult(method === 'getProxyScriptHash' ? proxy : target); } };
  const options = { invocation: invocation(), feePayer: relayAccount.scriptHash, rpcClient, sc, enabled: true };
  assert.deepEqual(await resolveProxyTransferWitness(options), expected);
  assert.deepEqual(calls.map((item) => item[1]), ['getProxyScriptHash', 'getVerifyScopeTarget']);
  await assert.rejects(resolveProxyTransferWitness({ ...options, invocation: invocation(true) }), /Sponsored proxy transfers are not supported/);
  for (const badScope of ['0'.repeat(40), 'dd'.repeat(20)]) {
    await assert.rejects(resolveProxyTransferWitness({ ...options, rpcClient: { async invokeFunction(_, method) { return hashResult(method === 'getProxyScriptHash' ? proxy : badScope); } } }), /scope/i);
  }
  await assert.rejects(resolveProxyTransferWitness({ ...options, rpcClient: { async invokeFunction() { return hashResult('cc'.repeat(20)); } } }), /scope|proxy/i);
  assert.equal(await resolveProxyTransferWitness({ ...options, enabled: false }), null);
});

test('proxy NEP-17 preset is available only for relay and preserves required-witness marker', () => {
  const options = { preset: 'nep17Transfer', account: { accountAddressScriptHash: proxy }, transfer: { tokenScriptHash: target, recipient: BUYER_HASH, amount: '100' } };
  assert.throws(() => buildOperationFromPreset(options));
  assert.equal(buildOperationFromPreset({ ...options, broadcastMode: 'relay' }).metadata.requiresProxyWitness, true);
});

function batchInvocation(sponsored = false) {
  const result = invocation(sponsored);
  result.operation += 's';
  result.args[1] = { type: 'Array', value: [result.args[1]] };
  return result;
}


async function nodeHarness() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const input = JSON.parse(raw); requests.push(input);
      let result;
      switch (input.method) {
        case 'invokefunction': result = hashResult(input.params[1] === 'getProxyScriptHash' ? proxy : target); break;
        case 'invokescript': result = { state: 'HALT', gasconsumed: '1000000', stack: [{ type: 'Boolean', value: true }] }; break;
        case 'getversion': result = { protocol: { network: 123456 } }; break;
        case 'getblockcount': result = 100; break;
        case 'calculatenetworkfee': result = { networkfee: '10000' }; break;
        case 'sendrawtransaction': result = { hash: `0x${'ab'.repeat(32)}` }; break;
        default: throw new Error(input.method);
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('relay prices and signs complete proxy envelope and caps fees before broadcast', async () => {
  const node = await nodeHarness();
  try {
    for (const metaInvocation of [invocation(), batchInvocation()]) {
      const reply = await withRelay(node, { AA_RELAY_PROXY_WITNESS_ENABLED: '1', AA_RELAY_PROXY_NETWORK_FEE_RESERVE: '200000000' }, () => post({ metaInvocation }));
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.ok(reply.body.txid);
      assert.equal(reply.body.networkFee, "200010000");
    }
    for (const request of node.requests.filter((item) => ['calculatenetworkfee', 'sendrawtransaction'].includes(item.method))) {
      const transaction = tx.Transaction.deserialize(Buffer.from(request.params[0], 'base64').toString('hex'));
      assert.equal(transaction.signers.length, 2);
      assert.equal(transaction.signers[0].account.toBigEndian(), relayAccount.scriptHash);
      assert.equal(transaction.signers[1].account.toBigEndian(), proxy);
      assert.deepEqual(transaction.signers[1].rules.map((rule) => rule.toJson()), new tx.Signer(expected.signer).rules.map((rule) => rule.toJson()));
      assert.equal(transaction.witnesses.length, 2);
      assert.equal(transaction.witnesses[1].invocationScript.toBigEndian(), '');
      assert.equal(transaction.witnesses[1].verificationScript.toBigEndian(), expected.witness.verificationScript);
      assert.equal(transaction.witnesses[0].scriptHash, relayAccount.scriptHash);
      assert.equal(wallet.verify(`40e20100${Buffer.from(transaction.hash(), 'hex').reverse().toString('hex')}`, transaction.witnesses[0].invocationScript.toBigEndian().slice(4), relayAccount.publicKey), true);
    }
    const before = node.requests.filter((item) => item.method === 'sendrawtransaction').length;
    const missingReserve = await withRelay(node, { AA_RELAY_PROXY_WITNESS_ENABLED: '1' }, () => post({ metaInvocation: invocation() }));
    assert.equal(missingReserve.status, 502);
    assert.equal(node.requests.filter((item) => item.method === 'sendrawtransaction').length, before);
    const denied = await withRelay(node, { AA_RELAY_PROXY_WITNESS_ENABLED: '1', AA_RELAY_PROXY_NETWORK_FEE_RESERVE: '200000000', AA_RELAY_MAX_NETWORK_FEE: '1' }, () => post({ metaInvocation: invocation() }));
    assert.equal(denied.status, 502);
    assert.equal(node.requests.filter((item) => item.method === 'sendrawtransaction').length, before);
  } finally { await node.close(); }
});


test('real relay handler refuses both sponsored proxy envelopes before fee calculation or broadcast', async () => {
  const node = await nodeHarness();
  try {
    for (const metaInvocation of [invocation(true), batchInvocation(true)]) {
      const reply = await withRelay(node, { AA_RELAY_PROXY_WITNESS_ENABLED: '1', AA_RELAY_PROXY_NETWORK_FEE_RESERVE: '200000000', AA_RELAY_INCLUDE_RAW_ERRORS: '1' }, () => post({ metaInvocation }));
      assert.equal(reply.status, 502);
      assert.match(reply.body.rawMessage, /Sponsored proxy transfers are not supported/);
      assert.equal(reply.body.txid, undefined);
    }
    assert.equal(node.requests.some((item) => ['calculatenetworkfee', 'sendrawtransaction'].includes(item.method)), false);
  } finally { await node.close(); }
});
