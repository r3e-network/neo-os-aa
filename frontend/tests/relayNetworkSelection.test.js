import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveNetwork } from '../api/morpheus-base.js';
import * as relayModule from '../api/relay-transaction.js';

// AA-08 regression coverage: the network that pays for a relay (which operator WIF signs,
// mainnet vs testnet) must be SERVER-determined from the deployment env. Client-supplied
// `morpheus_network` (query/body/header/payload/paymaster block) is ignored unless the
// operator explicitly opts in via SA_RELAY_ALLOW_CLIENT_NETWORK=1, and that override is
// itself ignored in production (fail closed — default safe, explicit dev opt-in, production
// ignores the override).

const { resolveRelayExecutionConfig } = relayModule;

const ENV_KEYS = [
  'MORPHEUS_NETWORK',
  'VITE_SA_NETWORK',
  'VITE_MORPHEUS_NETWORK',
  'SA_RELAY_ALLOW_CLIENT_NETWORK',
  'NODE_ENV',
  'VERCEL_ENV',
  'SA_RELAY_MAINNET_WIF',
  'SA_RELAY_TESTNET_WIF',
  'SA_RELAY_WIF',
];

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearNetworkEnv() {
  delete process.env.MORPHEUS_NETWORK;
  delete process.env.VITE_SA_NETWORK;
  delete process.env.VITE_MORPHEUS_NETWORK;
  delete process.env.SA_RELAY_ALLOW_CLIENT_NETWORK;
  delete process.env.NODE_ENV;
  delete process.env.VERCEL_ENV;
}

function setRelayWifs() {
  process.env.SA_RELAY_MAINNET_WIF = 'mainnet-operator-wif';
  process.env.SA_RELAY_TESTNET_WIF = 'testnet-operator-wif';
  delete process.env.SA_RELAY_WIF;
}

test('AA-08: client-supplied morpheus_network is ignored by default — the server env decides', () => {
  const snapshot = snapshotEnv();
  clearNetworkEnv();
  process.env.MORPHEUS_NETWORK = 'mainnet';
  setRelayWifs();

  try {
    assert.equal(resolveNetwork({ query: { morpheus_network: 'testnet' } }), 'mainnet', 'query ignored');
    assert.equal(resolveNetwork({ body: { morpheus_network: 'testnet' } }), 'mainnet', 'body ignored');
    assert.equal(resolveNetwork({ headers: { 'x-morpheus-network': 'testnet' } }), 'mainnet', 'header ignored');

    const fromPayload = resolveRelayExecutionConfig({
      req: { query: {}, body: {}, headers: {} },
      requestPayload: { morpheus_network: 'testnet' },
      paymaster: null,
    });
    assert.equal(fromPayload.network, 'mainnet', 'relay payload network ignored');
    assert.equal(fromPayload.relayWif, 'mainnet-operator-wif', 'the MAINNET operator WIF pays — client cannot pick the testnet one');

    const fromPaymasterBlock = resolveRelayExecutionConfig({
      req: { query: {}, body: {}, headers: {} },
      requestPayload: {},
      paymaster: { network: 'testnet', morpheus_network: 'testnet' },
    });
    assert.equal(fromPaymasterBlock.network, 'mainnet', 'paymaster-block network ignored');
    assert.equal(fromPaymasterBlock.relayWif, 'mainnet-operator-wif');
  } finally {
    restoreEnv(snapshot);
  }
});

test('AA-08: the server network comes from the deployment env (MORPHEUS_NETWORK first)', () => {
  const snapshot = snapshotEnv();
  clearNetworkEnv();

  try {
    assert.equal(resolveNetwork({}), 'mainnet', 'no env configured defaults to mainnet');

    process.env.VITE_SA_NETWORK = 'testnet';
    assert.equal(resolveNetwork({}), 'testnet', 'VITE_SA_NETWORK honored when MORPHEUS_NETWORK is unset');

    process.env.MORPHEUS_NETWORK = 'mainnet';
    assert.equal(resolveNetwork({}), 'mainnet', 'MORPHEUS_NETWORK beats the VITE fallbacks');

    delete process.env.MORPHEUS_NETWORK;
    delete process.env.VITE_SA_NETWORK;
    process.env.VITE_MORPHEUS_NETWORK = 'testnet';
    assert.equal(resolveNetwork({}), 'testnet', 'VITE_MORPHEUS_NETWORK honored as the last fallback');
  } finally {
    restoreEnv(snapshot);
  }
});

test('AA-08: SA_RELAY_ALLOW_CLIENT_NETWORK=1 re-enables client selection outside production (dev convenience)', () => {
  const snapshot = snapshotEnv();
  clearNetworkEnv();
  process.env.MORPHEUS_NETWORK = 'mainnet';
  process.env.SA_RELAY_ALLOW_CLIENT_NETWORK = '1';
  setRelayWifs();

  try {
    assert.equal(
      resolveNetwork({ query: { morpheus_network: 'testnet' } }),
      'testnet',
      'explicit dev opt-in honors the client selection',
    );

    const config = resolveRelayExecutionConfig({
      req: { query: {}, body: {}, headers: {} },
      requestPayload: { morpheus_network: 'testnet' },
      paymaster: null,
    });
    assert.equal(config.network, 'testnet');
    assert.equal(config.relayWif, 'testnet-operator-wif', 'dev override reaches WIF selection');
  } finally {
    restoreEnv(snapshot);
  }
});

test('AA-08: the client-network override is ignored in production (fail closed)', () => {
  const snapshot = snapshotEnv();
  clearNetworkEnv();
  process.env.MORPHEUS_NETWORK = 'mainnet';
  process.env.SA_RELAY_ALLOW_CLIENT_NETWORK = '1';
  setRelayWifs();

  try {
    process.env.NODE_ENV = 'production';
    assert.equal(
      resolveNetwork({ query: { morpheus_network: 'testnet' } }),
      'mainnet',
      'NODE_ENV=production ignores the override',
    );

    delete process.env.NODE_ENV;
    process.env.VERCEL_ENV = 'production';
    assert.equal(
      resolveNetwork({ query: { morpheus_network: 'testnet' } }),
      'mainnet',
      'VERCEL_ENV=production ignores the override',
    );

    const config = resolveRelayExecutionConfig({
      req: { query: { morpheus_network: 'testnet' }, body: {}, headers: {} },
      requestPayload: { morpheus_network: 'testnet' },
      paymaster: { network: 'testnet' },
    });
    assert.equal(config.network, 'mainnet', 'production relay ignores every client network channel');
    assert.equal(config.relayWif, 'mainnet-operator-wif', 'production keeps the server-selected operator WIF');
  } finally {
    restoreEnv(snapshot);
  }
});
