import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateVerifiedDid } from '../src/services/verifiedDidProfile.js';
import { connectedDidProfile, hydrateConnectedDidProfileFromStorage, setConnectedDidProfile } from '../src/utils/did.js';

const verified = { ok: true, profile: { did: 'web3auth:verified:user', provider: 'web3auth' }, claims: { sub: 'user' } };
for (const result of ['header.payload.signature', { idToken: 'header.payload.signature' }]) {
  test(`uses server-verified identity with ${typeof result} SDK response`, async () => {
    const profile = await authenticateVerifiedDid({ authenticateUser: async () => result }, async (token) => {
      assert.equal(token, 'header.payload.signature');
      return verified;
    });
    assert.equal(profile.did, verified.profile.did);
    assert.equal(profile.idToken, 'header.payload.signature');
  });
}
test('rejects absent or malformed tokens without calling verification', async () => {
  for (const result of [null, {}, { idToken: {} }, '', ' token ', 7]) {
    await assert.rejects(authenticateVerifiedDid({ authenticateUser: async () => result }, () => assert.fail('must not verify')));
  }
});
test('rejects verification denial, malformed results and outages', async () => {
  const client = { authenticateUser: async () => 'untrusted.payload.signature' };
  for (const result of [null, {}, { ...verified, ok: false }, { ...verified, claims: [] }, { ...verified, profile: { did: '', provider: 'web3auth' } }]) {
    await assert.rejects(authenticateVerifiedDid(client, async () => result), /did_verification_failed/);
  }
  await assert.rejects(authenticateVerifiedDid(client, async () => { throw new Error('verification unavailable'); }), /verification unavailable/);
});
test('does not restore a forged localStorage profile as a connected identity', () => {
  const previous = globalThis.window;
  let removed = false;
  globalThis.window = { localStorage: { getItem: () => JSON.stringify(verified.profile), removeItem: () => { removed = true; } } };
  try {
    setConnectedDidProfile(null);
    assert.equal(hydrateConnectedDidProfileFromStorage(), null);
    assert.equal(connectedDidProfile.value, null);
    assert.equal(removed, true);
  } finally { globalThis.window = previous; setConnectedDidProfile(null); }
});
