import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAddressFromScriptHash } from '../src/utils/neo.js';
import {
  createOrdinaryGovernanceFixture, ordinaryOwner, ordinaryOtherOwner,
  ordinaryAccountId, ordinaryOtherAccountId, ordinaryCore, ordinaryRpcUrl,
  ordinaryMagic, ordinaryZero,
} from './fixtures/ordinaryGovernanceFixture.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const evidenceDir = process.env.ORDINARY_LIFECYCLE_EVIDENCE_DIR || join(tmpdir(), 'aa-ordinary-lifecycle');
const stage = process.env.ORDINARY_LIFECYCLE_EVIDENCE_STAGE || 'current';

async function withWorkspace(name, run, setup = () => {}) {
  const fixture = createOrdinaryGovernanceFixture();
  setup(fixture);
  const errors = [];
  const env = { VITE_AA_RPC_URL: ordinaryRpcUrl, VITE_AA_HASH: ordinaryCore, VITE_AA_NETWORK_MAGIC: String(ordinaryMagic) };
  const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  await mkdir(evidenceDir, { recursive: true });
  const server = await createServer({
    root, envFile: false,
    server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*'] } },
    logLevel: 'error',
  });
  let browser, page;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', (route) => fixture.route(route, origin));
    await page.exposeFunction('ordinaryWalletInvoke', (request) => fixture.invoke(request));
    await page.addInitScript(({ address, hash, magic }) => {
      localStorage.setItem('aa_locale', 'en');
      window.__ordinaryWallet = { address, hash };
      window.neo3Dapi = {
        getAccount: async () => window.__ordinaryWallet,
        getNetwork: async () => ({ magic }),
        invoke: (request) => window.ordinaryWalletInvoke(request),
      };
    }, { address: getAddressFromScriptHash(ordinaryOwner), hash: ordinaryOwner, magic: ordinaryMagic });
    await page.goto(`${origin}/app`);
    await page.getByRole('heading', { name: /Abstract Account Workspace/i }).waitFor();
    assert.equal(page.url(), `${origin}/app`);
    assert.match(await page.title(), /Account|Workspace|App/);
    await page.locator('#main-content').getByRole('button', { name: 'Connect Wallet', exact: true }).click();
    await page.getByRole('tab', { name: 'Manage Governance', exact: true }).waitFor();
    await run({ page, fixture, capture: async (label) => {
      await page.screenshot({ path: join(evidenceDir, `${stage}-${name}-${label}.png`), fullPage: true });
      await writeFile(join(evidenceDir, `${stage}-${name}-${label}.txt`), await page.locator('body').innerText());
    } });
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    assert.deepEqual(errors, [], 'no browser errors');
    assert.deepEqual(fixture.state.failures, [], 'every RPC is explicitly stubbed; raw broadcasts are forbidden');
    assert.deepEqual(fixture.state.unexpectedRequests, [], 'no external or unstubbed network request may escape the fixture');
  } finally {
    await writeFile(join(evidenceDir, `${stage}-${name}-requests.json`), JSON.stringify({
      errors, rpc: fixture.state.calls, wallet: fixture.state.walletRequests,
      failures: fixture.state.failures, blocked: fixture.state.unexpectedRequests,
    }, null, 2));
    await browser?.close();
    await server.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function loadGovernance(page) {
  await page.getByRole('tab', { name: 'Manage Governance', exact: true }).click();
  await page.locator('#manage-target-account').fill(ordinaryAccountId);
  await page.getByRole('button', { name: 'Load account', exact: true }).click();
  await page.getByText('Current account configuration loaded.', { exact: true }).last().waitFor();
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Load account"]')?.disabled);
}
async function confirmDialog(page, label) {
  await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}
async function waitForWallet(page, count) {
  await page.waitForFunction(async (expected) => window.__ordinaryWalletInvocationCount === expected, count);
}
async function waitForFixtureWallet(fixture, count, timeout = 5000) {
  const started = Date.now();
  while (fixture.state.walletRequests.length < count && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(fixture.state.walletRequests.length, count, `wallet invoke ${count} should be captured`);
}
async function waitForGovernanceIdle(page) {
  await page.waitForFunction(() => {
    const load = document.querySelector('button[aria-label="Load account"]');
    return load && !load.disabled;
  });
}
function assertRequest(request, operation, args = [{ type: 'Hash160', value: ordinaryAccountId }]) {
  assert.equal(request.operation, operation);
  assert.equal(request.scriptHash.replace(/^0x/, ''), ordinaryCore);
  assert.deepEqual(request.args, args);
  assert.equal(request.signers.length, 1);
  assert.equal(request.signers[0].account, getAddressFromScriptHash(ordinaryOwner));
  assert.equal(request.signers[0].scopes, 1);
}

test('ordinary registration only authorizes the connected external backup owner', { timeout: 90000 }, async () => {
  await withWorkspace('registration', async ({ page, fixture, capture }) => {
    await page.getByRole('tab', { name: 'Create Account', exact: true }).click();
    const owner = page.locator('#backup-owner-input');
    const register = page.getByRole('button', { name: 'Register V3 Account', exact: true });
    await owner.fill(getAddressFromScriptHash(ordinaryOtherOwner));
    await capture('mismatched-owner');
    assert.equal(await register.isDisabled(), true, 'another backup owner cannot be registered with the connected wallet witness');
    assert.equal(fixture.state.walletRequests.length, 0);
    await owner.fill(getAddressFromScriptHash(ordinaryOwner));
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Register V3 Account' && !button.disabled));
    await register.click();
    await page.getByText(/Register V3 account submitted/).last().waitFor();
    assert.equal(fixture.state.walletRequests.length, 1);
    const request = fixture.state.walletRequests[0];
    assert.equal(request.operation, 'registerAccount');
    assert.equal(request.args.length, 6);
    assert.deepEqual(request.args[4], { type: 'Hash160', value: ordinaryOwner });
    assert.equal(request.signers[0].account, getAddressFromScriptHash(ordinaryOwner));
    await capture('matching-owner-submitted');
  });
});

test('ordinary deployments without full pending getters cannot confirm a hidden target', { timeout: 90000 }, async () => {
  await withWorkspace('old-getters', async ({ page, fixture, capture }) => {
    await loadGovernance(page);
    await capture('loaded');
    for (const role of ['verifier', 'hook']) {
      const card = page.getByTestId(`ordinary-pending-${role}`);
      assert.equal(await card.count(), 1, 'pending state must be visible even on an older deployment');
      assert.match(await card.innerText(), /This deployment cannot show the pending target and parameters\. Confirmation is unavailable\./);
      assert.equal(await card.getByRole('button', { name: `Confirm ${role} update`, exact: true }).isDisabled(), true);
      assert.equal(await card.getByRole('button', { name: `Cancel ${role} update`, exact: true }).isDisabled(), false);
    }
    assert.equal(fixture.state.calls.some(({ params }) => ['getPendingVerifierUpdate', 'getPendingHookUpdate'].includes(params[1])), false);
    assert.equal(fixture.state.walletRequests.length, 0);
  }, (fixture) => { fixture.state.fullPendingRoles = []; });
});

test('ordinary pending updates bind full state, chain maturity and actual wallet invocations', { timeout: 90000 }, async () => {
  await withWorkspace('pending', async ({ page, fixture, capture }) => {
    await loadGovernance(page);
    await capture('before-maturity');
    for (const role of ['verifier', 'hook']) {
      const card = page.getByTestId(`ordinary-pending-${role}`);
      assert.equal(await card.count(), 1);
      assert.match(await card.innerText(), new RegExp(fixture.state[`pending${role === 'verifier' ? 'Verifier' : 'Hook'}`].module));
      assert.equal(await card.getByRole('button', { name: `Confirm ${role} update`, exact: true }).isDisabled(), true);
    }
    fixture.state.time = fixture.matureAt;
    await loadGovernance(page);
    const verifierCard = page.getByTestId('ordinary-pending-verifier');
    await page.waitForFunction(() => !document.querySelector('[data-testid="ordinary-pending-verifier"] button[aria-label="Confirm verifier update"]')?.disabled);
    await verifierCard.getByRole('button', { name: 'Confirm verifier update', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    fixture.state.pendingVerifier.params = '03ffff';
    await confirmDialog(page, 'Confirm verifier update');
    await page.getByText(/Governance state changed\. Refresh and review again\./).last().waitFor();
    assert.equal(fixture.state.walletRequests.length, 0, 'a replacement after review must not reach the wallet');
    await capture('changed-pending-rejected');
    await loadGovernance(page);
    for (const [role, action] of [['verifier', 'Confirm'], ['hook', 'Cancel']]) {
      const label = `${action} ${role} update`;
      const walletCount = fixture.state.walletRequests.length;
      await page.getByTestId(`ordinary-pending-${role}`).getByRole('button', { name: label, exact: true }).click();
      await confirmDialog(page, label);
      await waitForFixtureWallet(fixture, walletCount + 1);
      await waitForGovernanceIdle(page);
      assertRequest(fixture.state.walletRequests.at(-1), `${action.toLowerCase()}${role === 'verifier' ? 'Verifier' : 'Hook'}Update`);
      await loadGovernance(page);
    }
    fixture.state.pendingVerifier = fixture.pending('verifier');
    fixture.state.pendingHook = fixture.pending('hook');
    fixture.state.time = fixture.matureAt + 1;
    await loadGovernance(page);
    for (const [role, action] of [['hook', 'Confirm'], ['verifier', 'Cancel']]) {
      const label = `${action} ${role} update`;
      const walletCount = fixture.state.walletRequests.length;
      await page.getByTestId(`ordinary-pending-${role}`).getByRole('button', { name: label, exact: true }).click();
      await confirmDialog(page, label);
      await waitForFixtureWallet(fixture, walletCount + 1);
      await waitForGovernanceIdle(page);
      assertRequest(fixture.state.walletRequests.at(-1), `${action.toLowerCase()}${role === 'verifier' ? 'Verifier' : 'Hook'}Update`);
      await loadGovernance(page);
    }
    assert.equal(fixture.state.walletRequests.length, 4);
    await capture('confirmed-and-cancelled');
    await page.locator('#manage-target-account').fill(ordinaryOtherAccountId);
    await page.getByTestId('ordinary-pending-verifier').waitFor({ state: 'hidden' });
    assert.equal(await page.getByTestId('ordinary-pending-hook').count(), 0, 'changing account removes the previous snapshot');
    await loadGovernance(page);
    await page.evaluate(({ address, hash }) => {
      window.__ordinaryWallet = { address, hash };
      window.dispatchEvent(new CustomEvent('Neo.DapiProvider.ACCOUNT_CHANGED', { detail: { address, hash } }));
    }, { address: getAddressFromScriptHash(ordinaryOtherOwner), hash: ordinaryOtherOwner });
    await page.getByTestId('ordinary-pending-verifier').waitFor({ state: 'hidden' });
    assert.equal(await page.getByTestId('ordinary-pending-hook').count(), 0, 'changing wallet removes the previous snapshot');
    await capture('wallet-invalidated');
  });
});

test('ordinary escape recovery exposes explicit fallback and verifier parameters after chain maturity', { timeout: 90000 }, async () => {
  await withWorkspace('escape', async ({ page, fixture, capture }) => {
    await loadGovernance(page);
    await capture('before-maturity');
    const mode = page.locator('#governance-escape-mode');
    assert.equal(await mode.count(), 1, 'recovery needs an explicit verifier or backup-owner mode');
    const finalize = page.getByRole('button', { name: 'Finalize escape', exact: true });
    assert.equal(await finalize.isDisabled(), true);
    fixture.state.time += 1;
    await loadGovernance(page);
    await mode.selectOption('backup-owner');
    await finalize.click();
    await confirmDialog(page, 'Finalize Escape');
    await waitForFixtureWallet(fixture, 1);
    assertRequest(fixture.state.walletRequests[0], 'finalizeEscape', [
      { type: 'Hash160', value: ordinaryAccountId }, { type: 'Hash160', value: ordinaryZero }, { type: 'ByteArray', value: '0x' },
    ]);
    await loadGovernance(page);
    await page.getByRole('button', { name: 'Initiate escape', exact: true }).click();
    await confirmDialog(page, 'Initiate Escape');
    await waitForFixtureWallet(fixture, 2);
    assertRequest(fixture.state.walletRequests[1], 'initiateEscape');
    fixture.state.time = fixture.state.escapeTriggeredAt + fixture.state.escapeTimelock * 1000;
    await loadGovernance(page);
    await mode.selectOption('verifier');
    const newVerifier = '88'.repeat(19) + '89';
    await page.locator('#governance-escape-verifier').fill(newVerifier);
    await page.locator('#governance-escape-params').fill('03cafe');
    await finalize.click();
    await confirmDialog(page, 'Finalize Escape');
    await waitForFixtureWallet(fixture, 3);
    assertRequest(fixture.state.walletRequests[2], 'finalizeEscape', [
      { type: 'Hash160', value: ordinaryAccountId }, { type: 'Hash160', value: newVerifier }, { type: 'ByteArray', value: '0x03cafe' },
    ]);
    await capture('verifier-parameters');
    await page.setViewportSize({ width: 390, height: 844 });
    await capture('mobile');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
  }, (fixture) => {
    fixture.state.escapeActive = true;
    fixture.state.escapeTriggeredAt = fixture.matureAt - fixture.state.escapeTimelock * 1000;
  });
});
