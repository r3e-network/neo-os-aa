import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = process.env.BUNDLE_DIST_DIR || path.join(root, 'dist');

test('built routes defer identity crypto and the bundled provider still loads', { timeout: 90000 }, async () => {
  const assets = path.join(dist, 'assets');
  const files = (await readdir(assets)).filter((file) => file.endsWith('.js'));
  const ellipticChunks = [];
  for (const file of files) {
    if ((await readFile(path.join(assets, file), 'utf8')).includes('_truncateToN')) ellipticChunks.push(file);
  }
  // This marker is stable in the pinned, unpatched Elliptic release. Do not let
  // a vacuous scan pass if a package change moves or removes it; reassess then.
  assert.ok(ellipticChunks.length > 0, 'locate the actual installed Elliptic code');
  const identityService = files.find((file) => /^didService-.*\.js$/.test(file));
  assert.ok(identityService, 'the public identity service must remain bundled');
  const routes = [
    ['/', /Neo AA Operations Console/i],
    ['/identity', /Web3Auth \/ NeoDID Workspace/i],
    ['/docs', /Documentation/i],
  ];
  // The public maintenance branch also uses this test before the native feature
  // lands. Record actual tested routes, and require native when it is registered.
  const router = await readFile(path.join(root, 'src/router/index.js'), 'utf8');
  if (/path:\s*['"]native['"]/.test(router)) routes.unshift(['/native', /^Native accounts$/]);
  const server = await preview({ root, build: { outDir: dist },
    preview: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'silent' });
  const browser = await chromium.launch({ headless: true });
  try {
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const receipts = [];
    for (const [route, heading] of routes) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const scripts = new Set(), errors = [];
        page.on('request', (request) => {
          if (request.resourceType() === 'script') scripts.add(new URL(request.url()).pathname.split('/').at(-1));
        });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.addInitScript(() => localStorage.setItem('aa_locale', 'en'));
        await page.goto(origin + route, { waitUntil: 'networkidle' });
        if (route === '/docs') await page.getByLabel(/Search documentation/i).waitFor();
        else await page.getByRole('heading', { name: heading }).first().waitFor();
        assert.deepEqual(errors, [], route);
        assert.deepEqual(ellipticChunks.filter((file) => scripts.has(file)), [], `${route}: Elliptic loaded before identity initialization`);
        assert.deepEqual([...scripts].filter((file) => /^(?:identity-runtime|identity-analytics-runtime|walletconnect-runtime|didService)-/.test(file)), [], route);
        const scriptBytes = (await Promise.all([...scripts].map(async (file) => (await stat(path.join(assets, file))).size))).reduce((a, b) => a + b, 0);
        receipts.push({ route, scriptBytes, scriptRequests: scripts.size });
        if (route === '/identity') {
          // Exercise the actual production ESM chunk graph, not a separate UMD
          // build. Loading/constructing the provider performs no wallet signing.
          const result = await page.evaluate(async (file) => {
            const { didService } = await import(`/assets/${file}`);
            const modal = await didService.loadModal();
            const client = new modal.Web3Auth({ clientId: 'bundle-contract',
              web3AuthNetwork: modal.WEB3AUTH_NETWORK.SAPPHIRE_DEVNET, disableAnalytics: true,
              storageType: 'session', chains: [{ chainNamespace: 'eip155', chainId: '0x1', rpcTarget: 'https://rpc.invalid' }] });
            return { identity: typeof client.getIdentityToken, connect: typeof client.connect };
          }, identityService);
          assert.deepEqual(result, { identity: 'function', connect: 'function' });
          assert.deepEqual(errors, [], 'identity initialization');
          assert.ok(ellipticChunks.some((file) => scripts.has(file)), 'deferred provider dependency must remain available');
        }
      } finally { await context.close(); }
    }
    console.log(JSON.stringify({ ellipticChunks, testedRoutes: receipts }));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
});
