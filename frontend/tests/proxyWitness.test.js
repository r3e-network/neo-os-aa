import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { resolveProxyTransferWitness } from '../api/proxyWitness.js';
import { buildClientProxyWitnessTransaction, buildClientBroadcastRequest } from '../src/features/operations/execution.js';
import { buildOperationFromPreset } from '../src/features/operations/presets.js';
import { post, withRelay, relayAccount } from './fixtures/relayHarness.js';
import {
  CORE_HASH,
  GAS_HASH,
  BUYER_HASH,
  ACCOUNT_ID,
  executeUserOpInvocation,
  executeUserOpsInvocation,
  gasTransferArgs,
  userOpParam,
} from './fixtures/saChainFixtures.js';
import { smartAccountCodec } from '../src/services/smartAccountCodec.js';

const require = createRequire(new URL('../../sdk/js/package.json', import.meta.url));
const { tx, sc, wallet } = require('@cityofzion/neon-js');
const sdk = require('../../sdk/js/src/proxyWitness.js');
const { createProxyWitness, buildProxyWitnessTransaction, buildProxyWalletSignRequest } = sdk;

const accountId = ACCOUNT_ID;
const core = CORE_HASH.replace(/^0x/, '');
const target = GAS_HASH.replace(/^0x/, '');
// The proxy address is derived by the protocol codec — the same file the wallet frontend uses, and
// the same preimage the core's getProxyScriptHash hashes. Nothing in these tests invents it.
const proxy = smartAccountCodec.accountAddress(accountId, { coreContractHash: core });
const expected = createProxyWitness({ coreHash: core, accountId, proxyHash: proxy, feePayer: relayAccount.scriptHash });

/** What a node returns for a UInt160: a ByteString in the stored byte order. */
const hashResult = (hash) => ({
  state: 'HALT',
  stack: [{ type: 'ByteString', value: Buffer.from(hash.replace(/^0x/, ''), 'hex').reverse().toString('base64') }],
});

const validationResult = () => ({
  state: 'HALT',
  stack: [{
    type: 'Array',
    value: [{ type: 'Boolean', value: true }, { type: 'ByteString', value: 'ab'.repeat(32) }],
  }],
});

/** A §4.1 argument hash is a ByteString of the stored byte order. */
const byteStringHash = (displayHex) => ({ type: 'ByteString', value: Buffer.from(displayHex, 'hex').reverse().toString('hex') });

const transferArgs = ({ from = proxy, to = BUYER_HASH, amount = '100000000' } = {}) => gasTransferArgs({ from, to, amount });

function invocation({ batch = false, transfer = true } = {}) {
  const options = { target: GAS_HASH, method: 'transfer', args: transfer ? transferArgs() : [] };
  return batch ? executeUserOpsInvocation([options]) : executeUserOpInvocation(options);
}

/** The sponsored surface of the same core: account id, one or more operations, then the paymaster tail. */
function sponsoredInvocation({ batch = false } = {}) {
  const operation = userOpParam({ target: GAS_HASH, method: 'transfer', args: transferArgs() });
  return {
    scriptHash: CORE_HASH,
    operation: batch ? 'executeSponsoredUserOps' : 'executeSponsoredUserOp',
    args: [
      byteStringHash(accountId),
      batch ? { type: 'Array', value: [operation] } : operation,
      { type: 'Hash160', value: `0x${'cd'.repeat(20)}` },
      { type: 'Hash160', value: `0x${'ef'.repeat(20)}` },
      { type: 'Integer', value: '10000' },
    ],
  };
}

test('resolver derives the immutable proxy signer from one core read and refuses a mismatched answer', async () => {
  const calls = [];
  const rpcClient = {
    async invokeFunction(hash, method) {
      calls.push([hash, method]);
      return hashResult(proxy);
    },
  };
  const options = { invocation: invocation(), feePayer: relayAccount.scriptHash, rpcClient, sc, enabled: true };
  // The relay adapter is the SDK builder: the same invocation, the same core readback, one authority.
  const sdkTransaction = buildProxyWitnessTransaction({
    coreHash: core,
    accountId,
    invocation: invocation(),
    proxyHash: proxy,
    expectedProxyHash: proxy,
    feePayer: relayAccount.scriptHash,
  });

  assert.deepEqual(await resolveProxyTransferWitness(options), sdkTransaction);
  assert.deepEqual(sdkTransaction.proxySigner, expected.signer);
  assert.deepEqual(sdkTransaction.proxyWitness, expected.witness);
  assert.deepEqual(sdkTransaction.accountId, accountId);
  assert.deepEqual(sdkTransaction.proxyHash, proxy);
  // The v3 scope target is gone: the proxy address is the only chain value this authority needs.
  assert.deepEqual(calls, [[core, 'getProxyScriptHash']]);

  await assert.rejects(
    resolveProxyTransferWitness({ ...options, invocation: sponsoredInvocation() }),
    /Sponsored proxy transfers are not supported/,
  );
  await assert.rejects(
    resolveProxyTransferWitness({
      ...options,
      rpcClient: { async invokeFunction() { return hashResult('cc'.repeat(20)); } },
    }),
    /differs from the core/i,
  );
  // An operation that moves nothing out of the account's own address needs no second signer.
  assert.equal(await resolveProxyTransferWitness({ ...options, invocation: invocation({ transfer: false }) }), null);
  assert.equal(await resolveProxyTransferWitness({ ...options, invocation: invocation({ batch: true, transfer: false }) }), null);
  assert.equal(await resolveProxyTransferWitness({ ...options, enabled: false }), null);
});

test('the frontend client path builds the same transaction and the custom-scope wallet request', async () => {
  const inv = invocation();
  const fetchImpl = async () => ({
    async json() { return { jsonrpc: '2.0', id: 1, result: hashResult(proxy) }; },
  });
  const built = await buildClientProxyWitnessTransaction({
    invocation: inv,
    feePayer: relayAccount.scriptHash,
    rpcUrl: 'http://127.0.0.1:1',
    fetchImpl,
  });
  assert.deepEqual(built, buildProxyWalletSignRequest({
    transaction: buildProxyWitnessTransaction({
      coreHash: core,
      accountId,
      invocation: inv,
      proxyHash: proxy,
      expectedProxyHash: proxy,
      feePayer: relayAccount.scriptHash,
    }),
    scope: 'CustomContracts',
    allowedContracts: [core, target],
  }));
  assert.equal(built.feePayerSigner.scopes, 'CustomContracts');
  assert.deepEqual(built.feePayerSigner.allowedContracts, [core, target]);
  assert.deepEqual(built.proxySigner, expected.signer);

  // A client broadcast carries the builder's script, both signers and the proxy witness. The
  // envelope is anchored to the intent the operator staged, exactly as a collaborator's would be.
  const body = {
    requiresProxyWitness: true,
    accountAddressScriptHash: proxy,
    accountIdHash: accountId,
    operationBody: { kind: 'invoke', targetContract: target, method: 'transfer', args: transferArgs() },
    metaInvocation: inv,
  };
  const request = buildClientBroadcastRequest({
    signerAddress: relayAccount.scriptHash,
    transactionBody: body,
    proxyWitnessTransaction: built,
  });
  assert.equal(request.script, built.script);
  assert.deepEqual(request.signers, [...built.signers]);
  assert.deepEqual(request.proxyWitness, built.proxyWitness);
  assert.equal(request.walletSignRequest.scope, 'CustomContracts');
  assert.throws(
    () => buildClientBroadcastRequest({ signerAddress: relayAccount.scriptHash, transactionBody: body }),
    /proxy witness/,
  );

  // The core answers a proxy address the builder cannot pin: the client path refuses to build.
  await assert.rejects(
    buildClientProxyWitnessTransaction({
      invocation: inv,
      feePayer: relayAccount.scriptHash,
      rpcUrl: 'http://127.0.0.1:1',
      fetchImpl: async () => ({ async json() { return { jsonrpc: '2.0', id: 1, result: hashResult('cc'.repeat(20)) }; } }),
    }),
    /differs from the core/i,
  );
});

test('proxy NEP-17 preset is available only for relay and preserves required-witness marker', () => {
  const options = {
    preset: 'nep17Transfer',
    account: { accountAddressScriptHash: proxy },
    transfer: { tokenScriptHash: target, recipient: BUYER_HASH, amount: '100' },
  };
  assert.throws(() => buildOperationFromPreset(options));
  assert.equal(buildOperationFromPreset({ ...options, broadcastMode: 'relay' }).metadata.requiresProxyWitness, true);
});

async function nodeHarness() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const input = JSON.parse(raw);
      requests.push(input);
      let result;
      switch (input.method) {
        case 'invokefunction':
          result = input.params[1] === 'getProxyScriptHash' ? hashResult(proxy) : validationResult();
          break;
        case 'invokescript': result = { state: 'HALT', gasconsumed: '1000000', stack: [{ type: 'Boolean', value: true }] }; break;
        case 'getversion': result = { protocol: { network: 123456 } }; break;
        case 'getblockcount': result = 100; break;
        case 'calculatenetworkfee': result = { networkfee: '10000' }; break;
        case 'sendrawtransaction': result = { hash: `0x${'ab'.repeat(32)}` }; break;
        default: throw new Error(input.method);
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('relay prices and signs a complete proxy envelope and caps fees before broadcast', async () => {
  const node = await nodeHarness();
  try {
    for (const metaInvocation of [invocation(), invocation({ batch: true })]) {
      const reply = await withRelay(
        node,
        { SA_RELAY_PROXY_WITNESS_ENABLED: '1', SA_RELAY_PROXY_NETWORK_FEE_RESERVE: '200000000' },
        () => post({ metaInvocation }),
      );
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.ok(reply.body.txid);
      assert.equal(reply.body.networkFee, '200010000');
    }
    const priced = node.requests.filter((item) => ['calculatenetworkfee', 'sendrawtransaction'].includes(item.method));
    assert.equal(priced.length, 4);
    for (const request of priced) {
      const transaction = tx.Transaction.deserialize(Buffer.from(request.params[0], 'base64').toString('hex'));
      assert.equal(transaction.signers.length, 2);
      assert.equal(transaction.signers[0].account.toBigEndian(), relayAccount.scriptHash);
      assert.equal(transaction.signers[1].account.toBigEndian(), proxy);
      assert.deepEqual(
        transaction.signers[1].rules.map((rule) => rule.toJson()),
        new tx.Signer(expected.signer).rules.map((rule) => rule.toJson()),
      );
      assert.equal(transaction.witnesses.length, 2);
      assert.equal(transaction.witnesses[1].invocationScript.toBigEndian(), '');
      assert.equal(transaction.witnesses[1].verificationScript.toBigEndian(), expected.witness.verificationScript);
      assert.equal(transaction.witnesses[0].scriptHash, relayAccount.scriptHash);
      assert.equal(
        wallet.verify(
          `40e20100${Buffer.from(transaction.hash(), 'hex').reverse().toString('hex')}`,
          transaction.witnesses[0].invocationScript.toBigEndian().slice(4),
          relayAccount.publicKey,
        ),
        true,
      );
    }

    const before = node.requests.filter((item) => item.method === 'sendrawtransaction').length;
    const missingReserve = await withRelay(
      node,
      { SA_RELAY_PROXY_WITNESS_ENABLED: '1' },
      () => post({ metaInvocation: invocation() }),
    );
    assert.equal(missingReserve.status, 502);
    assert.equal(node.requests.filter((item) => item.method === 'sendrawtransaction').length, before);
    const denied = await withRelay(
      node,
      { SA_RELAY_PROXY_WITNESS_ENABLED: '1', SA_RELAY_PROXY_NETWORK_FEE_RESERVE: '200000000', SA_RELAY_MAX_NETWORK_FEE: '1' },
      () => post({ metaInvocation: invocation() }),
    );
    assert.equal(denied.status, 502);
    assert.equal(node.requests.filter((item) => item.method === 'sendrawtransaction').length, before);
  } finally {
    await node.close();
  }
});

test('real relay handler refuses both sponsored proxy envelopes before fee calculation or broadcast', async () => {
  const node = await nodeHarness();
  try {
    for (const metaInvocation of [sponsoredInvocation(), sponsoredInvocation({ batch: true })]) {
      const reply = await withRelay(
        node,
        {
          SA_RELAY_PROXY_WITNESS_ENABLED: '1',
          SA_RELAY_PROXY_NETWORK_FEE_RESERVE: '200000000',
          SA_RELAY_INCLUDE_RAW_ERRORS: '1',
        },
        () => post({ metaInvocation }),
      );
      assert.equal(reply.status, 502);
      assert.match(reply.body.rawMessage, /Sponsored proxy transfers are not supported/);
      assert.equal(reply.body.txid, undefined);
    }
    assert.equal(
      node.requests.some((item) => ['calculatenetworkfee', 'sendrawtransaction'].includes(item.method)),
      false,
    );
  } finally {
    await node.close();
  }
});
