import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  resolveSameOriginApiEndpoint,
  isSameOriginApiEndpoint,
} from '../src/utils/sameOriginEndpoint.js';

// F-15 (re-verified from code): the client's credential-carrying API calls —
// relay broadcast (a fully-signed transaction), DID verification and DID
// notifications (the Web3Auth idToken bearer credential) — used to accept
// arbitrary absolute endpoints, so a misconfigured or attacker-influenced
// endpoint could ship those credentials to a third-party origin. The guard
// below must fail closed BEFORE any fetch: root-relative paths pass, absolute
// URLs pass only when provably same-origin, everything else is refused.

const APP_LOCATION = { origin: 'https://app.example' };

test('F-15: root-relative endpoints are same-origin by construction', () => {
  const result = resolveSameOriginApiEndpoint('/api/relay-transaction', { location: APP_LOCATION });
  assert.deepEqual(result, { ok: true, value: '/api/relay-transaction' });
  assert.equal(isSameOriginApiEndpoint('/api/relay-transaction', { location: APP_LOCATION }), true);
});

test('F-15: an absolute URL is allowed only when its origin matches the runtime origin', () => {
  assert.deepEqual(
    resolveSameOriginApiEndpoint('https://app.example/api/relay-transaction', { location: APP_LOCATION }),
    { ok: true, value: 'https://app.example/api/relay-transaction' },
    'the app\'s own origin is fine',
  );
  assert.equal(
    resolveSameOriginApiEndpoint('https://evil.example/api/relay-transaction', { location: APP_LOCATION }).reason,
    'cross_origin',
    'a third-party origin is refused',
  );
  assert.equal(
    resolveSameOriginApiEndpoint('http://app.example/api/relay-transaction', { location: APP_LOCATION }).reason,
    'cross_origin',
    'an http downgrade is a different origin',
  );
});

test('F-15: cross-origin-in-disguise and malformed endpoints fail closed', () => {
  assert.equal(resolveSameOriginApiEndpoint('', { location: APP_LOCATION }).reason, 'empty');
  assert.equal(resolveSameOriginApiEndpoint('   ', { location: APP_LOCATION }).reason, 'empty');
  assert.equal(resolveSameOriginApiEndpoint('//evil.example/relay', { location: APP_LOCATION }).reason, 'protocol_relative');
  assert.equal(resolveSameOriginApiEndpoint('javascript:alert(1)', { location: APP_LOCATION }).reason, 'unsupported_protocol');
  assert.equal(resolveSameOriginApiEndpoint('not a url at all', { location: APP_LOCATION }).reason, 'unparseable');
});

test('F-15: with no runtime origin an absolute URL can never be proven same-origin and is refused', () => {
  // Node (and any pre-location runtime) cannot prove an absolute URL is
  // same-origin; the guard must refuse rather than trust (fail closed).
  assert.equal(resolveSameOriginApiEndpoint('https://app.example/api', { location: undefined }).reason, 'origin_unavailable');
  assert.equal(resolveSameOriginApiEndpoint('https://app.example/api', {}).reason, 'origin_unavailable');
  assert.equal(
    isSameOriginApiEndpoint('https://app.example/api', { location: undefined }),
    false,
  );
});

test('F-15: the runtime location of the environment is honored when no explicit location is passed', () => {
  const originalLocation = globalThis.location;
  globalThis.location = { origin: 'https://live.example' };
  try {
    assert.equal(isSameOriginApiEndpoint('https://live.example/api/relay-transaction'), true);
    assert.equal(isSameOriginApiEndpoint('https://other.example/api/relay-transaction'), false);
  } finally {
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

let importCounter = 0;
async function importWalletService(windowStub) {
  globalThis.window = windowStub;
  try {
    importCounter += 1;
    const moduleUrl = new URL(
      `../src/services/walletService.js?same-origin-test=${importCounter}`,
      import.meta.url,
    );
    return await import(moduleUrl.href);
  } finally {
    delete globalThis.window;
  }
}

test('F-15: relayTransaction refuses a cross-origin relay endpoint BEFORE any fetch', async () => {
  // Re-verified from code: relayTransaction used to POST the fully-signed
  // transaction to ANY absolute relayEndpoint supplied in the request. The
  // guard must throw the machine-readable error and never touch the network.
  const windowStub = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    location: { origin: 'https://app.example' },
  };
  const { walletService } = await importWalletService(windowStub);

  const originalFetch = globalThis.fetch;
  let fetchAttempts = 0;
  globalThis.fetch = async () => {
    fetchAttempts += 1;
    throw new Error('fetch must not be reached');
  };

  try {
    await assert.rejects(
      () => walletService.relayTransaction({
        relayEndpoint: 'https://evil.example/api/relay-transaction',
        signedTx: '0xdangerous-signed-transaction',
      }),
      (error) => {
        assert.equal(error?.message, 'EC_credential_endpoint_not_same_origin');
        return true;
      },
      'the refusal names the same-origin policy',
    );
    assert.equal(fetchAttempts, 0, 'no network call may carry the signed transaction away');

    await assert.rejects(
      () => walletService.relayTransaction({
        relayEndpoint: '//evil.example/api/relay-transaction',
        signedTx: '0xdangerous-signed-transaction',
      }),
      (error) => error?.message === 'EC_credential_endpoint_not_same_origin',
      'protocol-relative endpoints are refused too',
    );
    assert.equal(fetchAttempts, 0);

    await assert.rejects(
      () => walletService.relayTransaction({ signedTx: '0xdangerous-signed-transaction' }),
      (error) => error?.message === 'EC_credential_endpoint_not_same_origin',
      'a missing endpoint fails closed, it does not default anywhere',
    );
    assert.equal(fetchAttempts, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('F-15: relayTransaction still reaches the default root-relative relay endpoint', async () => {
  const windowStub = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    location: { origin: 'https://app.example' },
  };
  const { walletService } = await importWalletService(windowStub);

  const originalFetch = globalThis.fetch;
  let fetchAttempts = 0;
  globalThis.fetch = async () => {
    fetchAttempts += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, txid: '0xabc' }),
    };
  };

  try {
    const payload = await walletService.relayTransaction({
      relayEndpoint: '/api/relay-transaction',
      signedTx: '0xlegitimate',
    });
    assert.equal(fetchAttempts, 1, 'the same-origin path is fetched exactly once');
    assert.equal(payload.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('F-15: didService and notificationService guard the idToken-carrying endpoints before any fetch', () => {
  // didService/notificationService import through the '@/' vite alias, so their
  // guard wiring is pinned from source: the same-origin check must run BEFORE
  // the fetch that ships the idToken, using the shared guard + EC code.
  const didSource = fs.readFileSync(
    path.resolve('src/services/didService.js'),
    'utf8',
  );
  const didGuard = didSource.indexOf('resolveSameOriginApiEndpoint');
  const didFetch = didSource.indexOf('await fetchWithTimeout(endpoint');
  assert.ok(didGuard >= 0, 'didService verifies the endpoint origin');
  assert.ok(didFetch >= 0, 'didService still performs the verification fetch');
  assert.ok(didGuard < didFetch, 'the origin check runs BEFORE the idToken is sent');
  assert.match(didSource, /credentialEndpointNotSameOrigin/, 'refusal uses the shared EC error code');

  const notificationSource = fs.readFileSync(
    path.resolve('src/services/notificationService.js'),
    'utf8',
  );
  const notifyGuard = notificationSource.indexOf('resolveSameOriginApiEndpoint');
  const notifyFetch = notificationSource.indexOf('await fetchWithTimeout(endpoint');
  assert.ok(notifyGuard >= 0, 'notificationService verifies the endpoint origin');
  assert.ok(notifyFetch >= 0, 'notificationService still performs the notification fetch');
  assert.ok(notifyGuard < notifyFetch, 'the origin check runs BEFORE the idToken is sent');
  assert.match(notificationSource, /credentialEndpointNotSameOrigin/, 'refusal uses the shared EC error code');
});
