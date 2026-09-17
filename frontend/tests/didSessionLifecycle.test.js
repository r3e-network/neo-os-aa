import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const proof = (did) => ({ ok: true, profile: { provider: 'web3auth', did }, claims: { sub: did } });

test('DID service lifecycle rejects stale asynchronous identity updates', async (t) => {
  const previous = globalThis.window;
  globalThis.window = { localStorage: { removeItem() {} } };
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [], entries: [] } });
  try {
    const { DidService } = await server.ssrLoadModule('/src/services/didService.js');
    const make = (client, verifyProfile = async () => proof('verified')) => new DidService({
      config: { web3AuthClientId: 'test-project' },
      loadModal: async () => ({ Web3Auth: class { constructor() { return client; } } }),
      verifyProfile,
    });
    await t.test('coalesces initialization and never exposes a half-ready client', async () => {
      const ready = deferred();
      let initialized = 0;
      const client = { init: () => { initialized++; return ready.promise; } };
      const service = make(client);
      const first = service.ensureClient();
      const second = service.ensureClient();
      await Promise.resolve();
      assert.equal(service.web3auth, null);
      ready.resolve();
      assert.equal(await first, client);
      assert.equal(await second, client);
      assert.equal(initialized, 1);
    });
    await t.test('failed initialization can be retried', async () => {
      let calls = 0;
      const client = { init: async () => { if (++calls === 1) throw Error('init failed'); } };
      const service = make(client);
      await assert.rejects(service.ensureClient(), /init failed/);
      assert.equal(service.web3auth, null);
      assert.equal(await service.ensureClient(), client);
    });
    await t.test('logout clears identity immediately and rejects a late verification', async () => {
      const review = deferred(), started = deferred(), logout = deferred();
      const client = { init: async () => {}, getUserInfo: async () => ({}), authenticateUser: async () => 'token', logout: () => logout.promise };
      const service = make(client, () => { started.resolve(); return review.promise; });
      service.persist({ did: 'old', idToken: 'old' });
      const pending = service.refreshProfile();
      const rejection = assert.rejects(pending, /did_session_changed/);
      await started.promise;
      const exit = service.disconnect();
      assert.equal(service.profile, null);
      assert.equal(service.buildNeoDidSubject(), null);
      await assert.rejects(service.connect(), /did_session_changed/);
      review.resolve(proof('late'));
      await rejection;
      logout.resolve();
      await exit;
      assert.equal(service.profile, null);
    });
    await t.test('older failure cannot clear a newer verified identity', async () => {
      const old = deferred(), started = deferred();
      let calls = 0;
      const client = { init: async () => {}, getUserInfo: async () => ({}), authenticateUser: async () => 'token' };
      const service = make(client, () => { if (++calls === 1) { started.resolve(); return old.promise; } return proof('new'); });
      const pending = service.refreshProfile();
      const rejection = assert.rejects(pending, /old failure/);
      await started.promise;
      await service.refreshProfile();
      old.reject(Error('old failure'));
      await rejection;
      assert.equal(service.profile.did, 'new');
    });
    await t.test('older success cannot overwrite a newer verified identity', async () => {
      const old = deferred(), started = deferred();
      let calls = 0;
      const client = { init: async () => {}, getUserInfo: async () => ({}), authenticateUser: async () => 'token' };
      const service = make(client, () => { if (++calls === 1) { started.resolve(); return old.promise; } return proof('new'); });
      const pending = service.refreshProfile();
      const rejection = assert.rejects(pending, /did_session_changed/);
      await started.promise;
      await service.refreshProfile();
      old.resolve(proof('old'));
      await rejection;
      assert.equal(service.profile.did, 'new');
    });
    await t.test('logout during initialization prevents login and logs out the initialized client', async () => {
      const ready = deferred(), started = deferred();
      let loginCalls = 0, logoutCalls = 0;
      const client = { init: () => { started.resolve(); return ready.promise; },
        connect: async () => { loginCalls++; }, logout: async () => { logoutCalls++; } };
      const service = make(client);
      const pending = service.connect();
      const rejection = assert.rejects(pending, /did_session_changed/);
      await started.promise;
      const exit = service.disconnect();
      ready.resolve();
      await Promise.all([exit, rejection]);
      assert.equal(loginCalls, 0);
      assert.equal(logoutCalls, 1);
      assert.equal(service.profile, null);
    });
  } finally { await server.close(); globalThis.window = previous; }
});
