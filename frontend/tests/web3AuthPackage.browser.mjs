import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

// Exercise the installed, published browser SDK. The connector is a unit-test
// boundary; this does not claim an OAuth login or a valid server identity.
test('published Web3Auth v10 identity API reaches mandatory server verification', async () => {
  const packagePath = fileURLToPath(new URL('../node_modules/@web3auth/modal/package.json', import.meta.url));
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  assert.match(pkg.version, /^10\./, 'a major upgrade needs an explicit adapter contract migration');
  const helper = await readFile(new URL('../src/services/verifiedDidProfile.js', import.meta.url), 'utf8');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => route.request().isNavigationRequest()
      ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Web3Auth package contract</title><body>Package contract</body>' })
      : route.abort());
    await page.goto('https://package-contract.invalid');
    await page.addScriptTag({ path: path.join(path.dirname(packagePath), 'dist/modal.umd.min.js') });
    assert.deepEqual(errors, [], 'published UMD must load in a real browser');
    const result = await page.evaluate(async (helperSource) => {
      const { authenticateVerifiedDid } = await import('data:text/javascript;base64,' + btoa(helperSource));
      const { Web3Auth, CONNECTOR_STATUS, WEB3AUTH_NETWORK } = window.Modal;
      const client = new Web3Auth({ clientId: 'package-contract',
        web3AuthNetwork: WEB3AUTH_NETWORK.SAPPHIRE_DEVNET, disableAnalytics: true,
        storageType: 'session', chains: [{ chainNamespace: 'eip155', chainId: '0x1', rpcTarget: 'https://rpc.invalid' }] });
      let connectorCalls = 0, verifierCalls = 0;
      client.status = CONNECTOR_STATUS.CONNECTED;
      client.state.connectedConnectorName = 'auth';
      client.connectors = [{ name: 'auth', connectorNamespace: 'multichain',
        getIdentityToken: async () => { connectorCalls++; return { idToken: 'untrusted.unit.token' }; } }];
      let rejection;
      try {
        await authenticateVerifiedDid(client, async (token) => {
          verifierCalls++;
          if (token !== 'untrusted.unit.token') throw Error('wrong token');
          throw Error('server_rejected_untrusted_token');
        });
      } catch (error) { rejection = error.message; }
      client.status = CONNECTOR_STATUS.NOT_READY;
      let disconnectedRejected = false;
      try { await authenticateVerifiedDid(client, () => { verifierCalls++; }); }
      catch { disconnectedRejected = true; }
      return { connectorCalls, verifierCalls, rejection, disconnectedRejected,
        legacyMethod: typeof client.authenticateUser, supportedMethod: typeof client.getIdentityToken };
    }, helper);
    assert.deepEqual(result, { connectorCalls: 1, verifierCalls: 1,
      rejection: 'server_rejected_untrusted_token', disconnectedRejected: true,
      legacyMethod: 'undefined', supportedMethod: 'function' });
  } finally { await browser.close(); }
});
