import test from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { EC } from '../src/config/errorCodes.js';
import {
  buildClientProxyWitnessTransaction,
  buildClientBroadcastRequest,
} from '../src/features/operations/execution.js';
import { createProxyVerificationScript } from '../src/shared/proxyWitness.mjs';

// What the *provider* is asked for is the contract with the wallet: a scope label the wallet cannot
// act on is the same as asking for nothing. These tests drive the frontend path the way a browser
// wallet would see it and assert the wire form, not the internal object.

const CORE = 'd2a4cff31913016155e38e474a2c06d08be276cf';
const TARGET = 'ef4073a0f2b305a38ec4050e4d3d28bc40ea63f5';
const ACCOUNT = 'ab'.repeat(20);
const VERIFIER = 'cd'.repeat(20);
const FEE_PAYER = '11'.repeat(20);
const WALLET_ADDRESS = 'NZWalletAddressForTheShim';

// The proxy is not a key: it is the hash of the core's own verification script, so the fixture
// derives it the way the core does rather than inventing an address the chain would refuse.
const PROXY = createHash('ripemd160')
  .update(createHash('sha256').update(Buffer.from(createProxyVerificationScript({ coreHash: CORE, accountId: ACCOUNT }), 'hex')).digest())
  .digest()
  .reverse()
  .toString('hex');

function stackHash(hash) {
  return {
    state: 'HALT',
    stack: [{ type: 'Hash160', value: `0x${hash}` }],
  };
}

function chainFetch({ verifier = VERIFIER, scopeTarget = TARGET, proxy = PROXY } = {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const method = body.params[1];
    const answers = {
      getProxyScriptHash: stackHash(proxy),
      getVerifyScopeTarget: stackHash(scopeTarget),
      getVerifier: stackHash(verifier),
    };
    return { async json() { return { jsonrpc: '2.0', id: 1, result: answers[method] }; } };
  };
}

function invocation() {
  return {
    scriptHash: CORE,
    operation: 'executeUserOp',
    args: [
      { type: 'Hash160', value: ACCOUNT },
      {
        type: 'Struct',
        value: [
          { type: 'Hash160', value: TARGET },
          { type: 'String', value: 'transfer' },
          {
            type: 'Array',
            value: [
              { type: 'Hash160', value: PROXY },
              { type: 'Hash160', value: '22'.repeat(20) },
              { type: 'Integer', value: '100000000' },
              { type: 'Any', value: null },
            ],
          },
          { type: 'Integer', value: '0' },
          { type: 'Integer', value: '9999999999999' },
          { type: 'ByteArray', value: '01'.repeat(64) },
        ],
      },
    ],
  };
}

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    has: (key) => values.has(key),
  };
}

function createWindowStub({ storage, providers = {} } = {}) {
  const listeners = new Map();
  return {
    localStorage: storage,
    location: { host: 'localhost', hostname: 'localhost', origin: 'http://localhost' },
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
    },
    removeEventListener(name, handler) {
      listeners.get(name)?.delete(handler);
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event?.type) ?? []) handler(event);
      return true;
    },
    ...providers,
  };
}

let importCounter = 0;
async function loadWalletService(windowStub) {
  globalThis.window = windowStub;
  try {
    importCounter += 1;
    const moduleUrl = new URL(`../src/services/walletService.js?signing-request=${importCounter}`, import.meta.url);
    return await import(moduleUrl.href);
  } finally {
    delete globalThis.window;
  }
}

// The provider is looked up on `window` at call time, so the stub stays installed for the whole
// drive and is torn down when it ends.
async function driveWallet(provider, body) {
  const storage = createMemoryStorage();
  const windowStub = createWindowStub({ storage, providers: { NEP21Provider: provider } });
  const { walletService } = await loadWalletService(windowStub);
  globalThis.window = windowStub;
  try {
    await walletService.connect();
    return await body(walletService);
  } finally {
    delete globalThis.window;
  }
}

function nep21Shim({ address = WALLET_ADDRESS, hash = FEE_PAYER, onInvoke } = {}) {
  const seen = [];
  const provider = {
    dapiVersion: '1.0',
    name: 'WalletShim',
    // A wallet that can carry a verification script it did not create. An invoke-only wallet is
    // refused this request instead of being allowed to drop the proxy witness.
    carriesProxyWitness: true,
    getAccounts: async () => [{ address, hash }],
    invoke: async (invokeArgs, signers) => {
      seen.push({ invokeArgs, signers });
      if (onInvoke) await onInvoke({ invokeArgs, signers });
      return { txid: '0x' + 'ab'.repeat(32) };
    },
  };
  return { provider, seen };
}


test('the wallet is asked for the protocol bit mask, not the scope label', async () => {
  const { provider, seen } = nep21Shim();
  await driveWallet(provider, async (walletService) => {
  const built = await buildClientProxyWitnessTransaction({
    invocation: invocation(),
    feePayer: FEE_PAYER,
    rpcUrl: 'http://127.0.0.1:1',
    fetchImpl: chainFetch(),
  });
  const request = buildClientBroadcastRequest({
    signerAddress: FEE_PAYER,
    transactionBody: { requiresProxyWitness: true, accountAddressScriptHash: built.proxyHash, clientInvocation: invocation() },
    proxyWitnessTransaction: built,
  });
  await walletService.invoke(request);

  assert.equal(seen.length, 1);
  const [entry] = seen[0].invokeArgs;
  assert.equal(entry.operation, 'executeUserOp');
  const [payer, proxy] = seen[0].signers;
  // NEP-21 carries WitnessScope as the bit mask: 16 CustomContracts, 64 WitnessRules, 128 Global.
  assert.equal(payer.scopes, 16);
  assert.equal(proxy.scopes, 64);
  for (const signer of seen[0].signers) {
    assert.notEqual(typeof signer.scopes, 'string', `scope must not be sent as a label: ${String(signer.scopes)}`);
  }
  assert.deepEqual(payer.allowedContracts, [CORE, TARGET]);
  });
});

test('two entries for one account reach the wallet as one signer', async () => {
  const { provider, seen } = nep21Shim();
  await driveWallet(provider, async (walletService) => {
  const built = await buildClientProxyWitnessTransaction({
    invocation: invocation(),
    feePayer: FEE_PAYER,
    rpcUrl: 'http://127.0.0.1:1',
    fetchImpl: chainFetch(),
  });
  // A caller that repeats the fee payer with the same scope (once as the staged signer, once from
  // the built request) must not produce two signers for one account: a node refuses that shape.
  await walletService.invoke({
    scriptHash: CORE,
    operation: 'executeUserOp',
    args: [{ type: 'Hash160', value: ACCOUNT }],
    signers: [
      { account: FEE_PAYER, scopes: 'CustomContracts', allowedContracts: [CORE] },
      { account: FEE_PAYER, scopes: built.feePayerSigner.scopes, allowedContracts: built.feePayerSigner.allowedContracts },
      { account: built.proxyHash, scopes: built.proxySigner.scopes, rules: built.proxySigner.rules },
    ],
  });

  assert.equal(seen.length, 1);
  const accounts = seen[0].signers.map((signer) => signer.account);
  assert.deepEqual(accounts, [...new Set(accounts)], 'one signer per account on the wire');
  assert.equal(accounts.filter((account) => account === FEE_PAYER).length, 1);
  assert.equal(accounts.length, 2);
  const payer = seen[0].signers.find((signer) => signer.account === FEE_PAYER);
  assert.equal(payer.scopes, 16);
  // Both allowlists survive the merge; nothing is silently dropped.
  assert.deepEqual([...payer.allowedContracts].sort(), [CORE, TARGET].sort());

  // Two different scopes for one account is a contradiction, not a union to guess at. The wallet
  // is not asked, and the caller gets a typed refusal instead of a transaction a node will refuse.
  await assert.rejects(
    walletService.invoke({
      scriptHash: CORE,
      operation: 'executeUserOp',
      args: [{ type: 'Hash160', value: ACCOUNT }],
      signers: [
        { account: FEE_PAYER, scopes: 'CalledByEntry' },
        { account: FEE_PAYER, scopes: 'CustomContracts', allowedContracts: [CORE, TARGET] },
      ],
    }),
    (error) => error.message === EC.walletSignerConflict,
  );
  assert.equal(seen.length, 1, 'a contradictory signer list never reaches the wallet');
  });
});

test('the proxy signer stays restricted and the proxy never pays', async () => {
  const { provider, seen } = nep21Shim();
  await driveWallet(provider, async (walletService) => {
  const built = await buildClientProxyWitnessTransaction({
    invocation: invocation(),
    feePayer: FEE_PAYER,
    rpcUrl: 'http://127.0.0.1:1',
    fetchImpl: chainFetch(),
  });

  // CU-39's witness checks, re-asserted through the wallet path: the scope target is required, the
  // proxy keeps its single restricted WitnessRules entry, and it is never the fee payer.
  assert.equal(built.scopeTarget, TARGET);
  assert.equal(built.proxySigner.scopes, 'WitnessRules');
  assert.deepEqual(built.proxySigner.rules, [{
    action: 'Allow',
    condition: {
      type: 'Or',
      expressions: [{ type: 'CalledByContract', hash: CORE }, { type: 'CalledByContract', hash: TARGET }],
    },
  }]);
  assert.equal(built.feePayerSigner.account, FEE_PAYER);
  assert.notEqual(built.feePayerSigner.account, built.proxyHash);
  assert.equal(built.proxyWitness.invocationScript, '');

  const request = buildClientBroadcastRequest({
    signerAddress: FEE_PAYER,
    transactionBody: { requiresProxyWitness: true, accountAddressScriptHash: built.proxyHash, clientInvocation: invocation() },
    proxyWitnessTransaction: built,
  });
  await walletService.invoke(request);
  const proxyOnTheWire = seen[0].signers.find((signer) => signer.account === built.proxyHash);
  assert.equal(proxyOnTheWire.scopes, 64);
  assert.deepEqual(proxyOnTheWire.rules, built.proxySigner.rules);
  });
});

test('a refused owner check is raised before the wallet is asked to sign', async () => {
  const { provider, seen } = nep21Shim();
  await driveWallet(provider, async (walletService) => {
  // A verifier-checked owner cannot authorize through CalledByEntry. The request must be refused
  // before a wallet is shown anything.
  await assert.rejects(
    buildClientProxyWitnessTransaction({
      invocation: invocation(),
      feePayer: FEE_PAYER,
      feePayerScope: 'CalledByEntry',
      rpcUrl: 'http://127.0.0.1:1',
      fetchImpl: chainFetch({ verifier: VERIFIER }),
    }),
    (error) => error.message === EC.walletScopeOwnerRequiresCustomScope,
  );
  assert.equal(seen.length, 0, 'no signing request reaches the wallet');
  assert.equal(walletService.isConnected, true, 'the refused build did not disturb the session');
  });
});
