import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const origin = 'https://aa.neoos.network';
const output = fileURLToPath(new URL(`../../.automation-logs/identity-production/${Date.now()}/`, import.meta.url));
const report = { origin, startedAt: new Date().toISOString(), scope: 'Unauthenticated identity security regression; not login acceptance', checks: [], passed: false };
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.AA_BROWSER_EXECUTABLE ? { executablePath: process.env.AA_BROWSER_EXECUTABLE } : {}),
});
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    try {
      await context.addInitScript(() => {
        localStorage.setItem('aa_connected_did_profile', JSON.stringify({
          did: 'FORGED_AUDIT_IDENTITY', name: 'FORGED_AUDIT_IDENTITY',
          provider: 'web3auth', idToken: 'forged.invalid.token',
        }));
      });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      const response = await page.goto(`${origin}/identity?network=mainnet`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.getByRole('heading', { name: /Web3Auth \/ NeoDID Workspace/i }).waitFor();
      const body = await page.locator('body').innerText();
      const check = {
        viewport, status: response.status(),
        cacheRemoved: await page.evaluate(() => localStorage.getItem('aa_connected_did_profile') === null),
        forgedIdentityRendered: body.includes('FORGED_AUDIT_IDENTITY'),
        providerUnconfigured: body.includes('not configured'), pageErrors,
        assets: await page.locator('script[src]').evaluateAll(elements => elements.map(element => element.getAttribute('src'))),
      };
      report.checks.push(check);
      await page.screenshot({ path: `${output}/identity-${viewport.width}.png`, fullPage: true });
      assert.equal(check.status, 200);
      assert.equal(check.cacheRemoved, true);
      assert.equal(check.forgedIdentityRendered, false);
      assert.deepEqual(pageErrors, []);
      assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), `${origin}/`);
      for (const network of ['testnet', 'invalid', '', 'mainnet&network=testnet']) {
        await page.goto(`${origin}/identity?network=${network}`, { waitUntil: 'networkidle', timeout: 60000 });
        await page.getByTestId('network-mismatch').waitFor();
        assert.equal(await page.getByRole('heading', { name: /Web3Auth \/ NeoDID Workspace/i }).count(), 0);
        assert.equal(await page.getByRole('button', { name: /Connect Wallet/i }).count(), 0);
      }
      check.networkMismatchBlocked = true;
      await page.screenshot({ path: `${output}/network-mismatch-${viewport.width}.png`, fullPage: true });
      await page.getByRole('link', { name: 'Open this network home' }).click();
      await page.getByRole('heading', { name: /Neo AA Operations Console/i }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('network'), 'mainnet');
      const get = await context.request.get(`${origin}/api/did-verify`);
      assert.equal(get.status(), 405);
      assert.equal(get.headers().allow, 'POST');
      const missing = await context.request.post(`${origin}/api/did-verify`, { data: {} });
      assert.equal(missing.status(), 400);
      const forged = await context.request.post(`${origin}/api/did-verify`, { data: { idToken: 'forged.invalid.token' } });
      const payload = await forged.json();
      check.api = { get: get.status(), missingToken: missing.status(), forgedToken: forged.status() };
      assert.equal(payload.ok, undefined);
      assert.equal(payload.profile, undefined);
      // An unconfigured deployment is recorded explicitly, never as working login.
      if (forged.status() === 500) {
        assert.equal(payload.error, 'WEB3AUTH_CLIENT_ID is not configured');
        check.api.providerUnconfigured = true;
      } else {
        assert.equal(forged.status(), 401);
      }
    } finally {
      await context.close();
    }
  }
  report.passed = true;
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, ...report }, null, 2));
}
