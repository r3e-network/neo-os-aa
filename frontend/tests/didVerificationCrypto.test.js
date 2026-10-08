import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import handler from '../api/did-verify.js';
import { authenticateVerifiedDid } from '../src/services/verifiedDidProfile.js';

// A local test issuer exercises the real JWKS fetch and JOSE verifier. It is
// deliberately not evidence of an external Web3Auth OAuth session.
test('DID adapter accepts only cryptographically verified, audience-bound, unexpired identity tokens', async () => {
  const trusted = await generateKeyPair('ES256');
  const other = await generateKeyPair('ES256');
  const publicKey = { ...await exportJWK(trusted.publicKey), kid: 'test-key', alg: 'ES256', use: 'sig' };
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [publicKey] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const old = { WEB3AUTH_JWKS_URL: process.env.WEB3AUTH_JWKS_URL, WEB3AUTH_CLIENT_ID: process.env.WEB3AUTH_CLIENT_ID };
  process.env.WEB3AUTH_JWKS_URL = `http://127.0.0.1:${server.address().port}/jwks`;
  process.env.WEB3AUTH_CLIENT_ID = 'test-did-audience';
  try {
    const token = (key, audience = 'test-did-audience', expiry = '5m') => new SignJWT({ verifier: 'google', verifierId: 'test-user' })
      .setProtectedHeader({ alg: 'ES256', kid: 'test-key' }).setAudience(audience).setSubject('test-user')
      .setIssuedAt().setExpirationTime(expiry).sign(key);
    let sequence = 0;
    const verify = async (idToken) => {
      const res = { statusCode: 200, payload: null, setHeader() {},
        status(code) { this.statusCode = code; return this; }, json(body) { this.payload = body; return this; } };
      await handler({ method: 'POST', body: { idToken }, headers: {},
        socket: { remoteAddress: `did-crypto-${++sequence}` } }, res);
      if (res.statusCode !== 200) throw Error(`server_rejected_${res.statusCode}`);
      return res.payload;
    };
    const valid = await token(trusted.privateKey);
    const profile = await authenticateVerifiedDid({ getIdentityToken: async () => ({ idToken: valid }) }, verify);
    assert.equal(profile.did, 'web3auth:google:test-user');
    assert.equal(profile.tokenClaims.aud, 'test-did-audience');
    for (const invalid of [await token(other.privateKey), await token(trusted.privateKey, 'other-app'),
      await token(trusted.privateKey, 'test-did-audience', '0s'), 'untrusted.payload.signature']) {
      await assert.rejects(authenticateVerifiedDid({ getIdentityToken: async () => ({ idToken: invalid }) }, verify), /server_rejected_401/);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
