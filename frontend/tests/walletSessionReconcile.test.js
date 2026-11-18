import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Behavioral tests for the lazy-verify wallet session lifecycle:
// the persisted session is restored as 'pending' and reconciled against the
// provider via getAccounts() instead of being trusted from localStorage.

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    has(key) {
      return values.has(key);
    },
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
async function importWalletService(windowStub) {
  globalThis.window = windowStub;
  try {
    importCounter += 1;
    const moduleUrl = new URL(
      `../src/services/walletService.js?session-test=${importCounter}`,
      import.meta.url,
    );
    return await import(moduleUrl.href);
  } finally {
    delete globalThis.window;
  }
}

function makeNep21Provider(accounts) {
  return {
    dapiVersion: '1.0',
    name: 'StubWallet',
    getAccounts: async () => accounts,
    invoke: async () => ({ txid: '0xstub' }),
  };
}

test('persisted session restores as pending and keeps hash metadata', async () => {
  const storage = createMemoryStorage({
    sa_connected_account: JSON.stringify({
      address: 'NAddrCachedAAAAAAAAAAAAAAAAAAAAAAA',
      hash: '0x1122',
      provider: 'StubWallet',
    }),
    sa_wallet_connected: 'true',
  });
  const windowStub = createWindowStub({ storage });

  const { walletService } = await importWalletService(windowStub);

  assert.equal(walletService.sessionState, 'pending');
  assert.equal(walletService.address, 'NAddrCachedAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(walletService.account.hash, '0x1122');
  assert.equal(storage.has('sa_wallet_connected'), false, 'legacy flag key is removed');
  walletService.disconnect();
});

test('legacy plain-address persistence is still accepted', async () => {
  const storage = createMemoryStorage({
    sa_connected_account: 'NAddrLegacyAAAAAAAAAAAAAAAAAAAAAAA',
  });
  const windowStub = createWindowStub({ storage });

  const { walletService } = await importWalletService(windowStub);

  assert.equal(walletService.sessionState, 'pending');
  assert.equal(walletService.address, 'NAddrLegacyAAAAAAAAAAAAAAAAAAAAAAA');
  walletService.disconnect();
});

test('reconcile clears the session when no provider is present', async () => {
  const storage = createMemoryStorage({
    sa_connected_account: JSON.stringify({ address: 'NAddrGoneAAAAAAAAAAAAAAAAAAAAAAAAA' }),
  });
  const windowStub = createWindowStub({ storage });

  const { walletService } = await importWalletService(windowStub);
  globalThis.window = windowStub;
  try {
    const state = await walletService.reconcileSession({ providerTimeoutMs: 10 });
    assert.equal(state, 'disconnected');
    assert.equal(walletService.isConnected, false);
    assert.equal(storage.has('sa_connected_account'), false, 'stale session is purged');
  } finally {
    delete globalThis.window;
  }
});

test('reconcile adopts the provider account when the selection changed', async () => {
  const storage = createMemoryStorage({
    sa_connected_account: JSON.stringify({
      address: 'NAddrOldAAAAAAAAAAAAAAAAAAAAAAAAAA',
      hash: '0xold',
    }),
  });
  const provider = makeNep21Provider([
    { address: 'NAddrNewAAAAAAAAAAAAAAAAAAAAAAAAAA', hash: '0xnew', isDefault: true },
  ]);
  const windowStub = createWindowStub({ storage, providers: { NEP21Provider: provider } });

  const { walletService } = await importWalletService(windowStub);
  globalThis.window = windowStub;
  try {
    const state = await walletService.reconcileSession({ providerTimeoutMs: 10 });
    assert.equal(state, 'verified');
    assert.equal(walletService.address, 'NAddrNewAAAAAAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(walletService.account.hash, '0xnew');
    const persisted = JSON.parse(storage.getItem('sa_connected_account'));
    assert.equal(persisted.address, 'NAddrNewAAAAAAAAAAAAAAAAAAAAAAAAAA');
  } finally {
    delete globalThis.window;
  }
});

test('reconcile verifies a matching cached account and clears it when the roster is empty', async () => {
  const matchingStorage = createMemoryStorage({
    sa_connected_account: JSON.stringify({
      address: 'NAddrSameAAAAAAAAAAAAAAAAAAAAAAAAA',
      hash: '0xkeep',
    }),
  });
  const matchingProvider = makeNep21Provider([
    { address: 'NAddrSameAAAAAAAAAAAAAAAAAAAAAAAAA', isDefault: true },
  ]);
  const matchingWindow = createWindowStub({
    storage: matchingStorage,
    providers: { NEP21Provider: matchingProvider },
  });
  const matching = await importWalletService(matchingWindow);
  globalThis.window = matchingWindow;
  try {
    const state = await matching.walletService.reconcileSession({ providerTimeoutMs: 10 });
    assert.equal(state, 'verified');
    assert.equal(matching.walletService.address, 'NAddrSameAAAAAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(matching.walletService.account.hash, '0xkeep', 'cached hash survives a match');
  } finally {
    delete globalThis.window;
  }

  const emptyStorage = createMemoryStorage({
    sa_connected_account: JSON.stringify({ address: 'NAddrEmptyAAAAAAAAAAAAAAAAAAAAAAAA' }),
  });
  const emptyWindow = createWindowStub({
    storage: emptyStorage,
    providers: { NEP21Provider: makeNep21Provider([]) },
  });
  const empty = await importWalletService(emptyWindow);
  globalThis.window = emptyWindow;
  try {
    const state = await empty.walletService.reconcileSession({ providerTimeoutMs: 10 });
    assert.equal(state, 'disconnected');
    assert.equal(emptyStorage.has('sa_connected_account'), false);
  } finally {
    delete globalThis.window;
  }
});

test('ACCOUNT_CHANGED events rebind the session to the new account', async () => {
  const storage = createMemoryStorage({
    sa_connected_account: JSON.stringify({ address: 'NAddrFirstAAAAAAAAAAAAAAAAAAAAAAAA' }),
  });
  const windowStub = createWindowStub({ storage });

  const { walletService } = await importWalletService(windowStub);
  globalThis.window = windowStub;
  try {
    windowStub.dispatchEvent({
      type: 'NEOLine.NEO.EVENT.ACCOUNT_CHANGED',
      detail: { address: 'NAddrSwitchedAAAAAAAAAAAAAAAAAAAAA' },
    });
    assert.equal(walletService.address, 'NAddrSwitchedAAAAAAAAAAAAAAAAAAAAA');
    const persisted = JSON.parse(storage.getItem('sa_connected_account'));
    assert.equal(persisted.address, 'NAddrSwitchedAAAAAAAAAAAAAAAAAAAAA');
  } finally {
    delete globalThis.window;
  }
});

test('NETWORK_CHANGED events force the session back to pending re-verification', async () => {
  const provider = makeNep21Provider([
    { address: 'NAddrNetAAAAAAAAAAAAAAAAAAAAAAAAAA', isDefault: true },
  ]);
  const storage = createMemoryStorage({
    sa_connected_account: JSON.stringify({ address: 'NAddrNetAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
  });
  const windowStub = createWindowStub({ storage, providers: { NEP21Provider: provider } });

  const { walletService } = await importWalletService(windowStub);
  globalThis.window = windowStub;
  try {
    await walletService.reconcileSession({ providerTimeoutMs: 10 });
    assert.equal(walletService.sessionState, 'verified');

    windowStub.dispatchEvent({ type: 'NEOLine.NEO.EVENT.NETWORK_CHANGED', detail: {} });
    // handleNetworkChanged kicks off an async reconcile; wait for it to settle.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(walletService.sessionState, 'verified');
    assert.equal(walletService.address, 'NAddrNetAAAAAAAAAAAAAAAAAAAAAAAAAA');
  } finally {
    delete globalThis.window;
  }
});

test('useWalletConnection no longer mirrors the session into a second storage key', () => {
  const source = fs.readFileSync(
    path.resolve('src/composables/useWalletConnection.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /sa_wallet_connected/);
  assert.match(source, /reconcileSession/);
  assert.doesNotMatch(source, /await walletService\.connect\(\)\s*;?\s*\}\s*catch/);
});
