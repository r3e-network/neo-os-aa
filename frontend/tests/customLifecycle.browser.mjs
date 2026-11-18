import test from 'node:test';
import assert from 'node:assert/strict';
import { startCustomBrowserServer } from './fixtures/customBrowserServer.mjs';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAddressFromScriptHash } from '../src/utils/neo.js';
import {
  createCustomGovernanceFixture, customOwner, customOtherOwner,
  customAccountId, customOtherAccountId, customCore, customRpcUrl,
  customMagic, customZero,
} from './fixtures/customGovernanceFixture.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const evidenceDir = process.env.CUSTOM_LIFECYCLE_EVIDENCE_DIR || join(tmpdir(), 'sa-custom-lifecycle');
const stage = process.env.CUSTOM_LIFECYCLE_EVIDENCE_STAGE || 'current';

async function withWorkspace(name, run, setup = () => {}) {
  const fixture = createCustomGovernanceFixture();
  setup(fixture);
  const errors = [], navigations = [], documentRequests = [];
  const env = { VITE_SA_RPC_URL: customRpcUrl, VITE_SA_HASH: customCore, VITE_SA_NETWORK_MAGIC: String(customMagic) };
  const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  await mkdir(evidenceDir, { recursive: true });
  const server = await startCustomBrowserServer(root);
  let browser, page;
  try {
    const { origin } = server;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.setDefaultTimeout(10000);
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    page.on('request', (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests.push(request.url()); });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', (route) => fixture.route(route, origin));
    await page.exposeFunction('customWalletInvoke', (request) => fixture.invoke(request));
    await page.addInitScript(({ address, hash, magic }) => {
      localStorage.setItem('sa_locale', 'en');
      window.__customWallet = { address, hash };
      window.neo3Dapi = {
        getAccount: async () => window.__customWallet,
        getNetwork: async () => ({ magic }),
        invoke: (request) => window.customWalletInvoke(request),
      };
    }, { address: getAddressFromScriptHash(customOwner), hash: customOwner, magic: customMagic });
    await page.goto(`${origin}/app`);
    await page.getByRole('heading', { name: /Smart Account Workspace/i }).waitFor();
    assert.equal(page.url(), `${origin}/app`);
    assert.match(await page.title(), /Account|Workspace|App/);
    await page.locator('#main-content').getByRole('button', { name: 'Connect Wallet', exact: true }).click();
    await page.getByRole('tab', { name: 'Manage Governance', exact: true }).waitFor();
    await run({ page, fixture, capture: async (label) => {
      await page.screenshot({ path: join(evidenceDir, `${stage}-${name}-${label}.png`), fullPage: true });
      await writeFile(join(evidenceDir, `${stage}-${name}-${label}.txt`), await page.locator('body').innerText());
    } });
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    assert.deepEqual(documentRequests, [`${origin}/app`], 'immutable built app must not reload during lifecycle actions; router history updates are allowed');
    assert.equal(await page.locator('.app-error-boundary').count(), 0, 'Vue errors caught by the app boundary must fail the browser gate');
    assert.equal(await page.locator('script[src="/@vite/client"]').count(), 0, 'fixture serves the built app without optimizer/HMR');
    assert.deepEqual(errors, [], 'no browser errors');
    assert.deepEqual(fixture.state.failures, [], 'every RPC is explicitly stubbed; raw broadcasts are forbidden');
    assert.deepEqual(fixture.state.unexpectedRequests, [], 'no external or unstubbed network request may escape the fixture');
  } finally {
    await writeFile(join(evidenceDir, `${stage}-${name}-requests.json`), JSON.stringify({
      errors, navigations, documentRequests, rpc: fixture.state.calls, wallet: fixture.state.walletRequests,
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
  await page.locator('#manage-target-account').fill(customAccountId);
  await page.getByRole('button', { name: 'Load account', exact: true }).click();
  await page.getByText('Current account configuration loaded.', { exact: true }).last().waitFor();
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Load account"]')?.disabled);
}
async function confirmDialog(page, label) {
  await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}
async function waitForWallet(page, count) {
  await page.waitForFunction(async (expected) => window.__customWalletInvocationCount === expected, count);
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
function assertRequest(request, operation, args = [{ type: 'Hash160', value: customAccountId }]) {
  assert.equal(request.operation, operation);
  assert.equal(request.scriptHash.replace(/^0x/, ''), customCore);
  assert.deepEqual(request.args, args);
  assert.equal(request.signers.length, 1);
  assert.equal(request.signers[0].account, getAddressFromScriptHash(customOwner));
  assert.equal(request.signers[0].scopes, 1);
}

test('custom registration only authorizes the connected external backup owner', { timeout: 90000 }, async () => {
  await withWorkspace('registration', async ({ page, fixture, capture }) => {
    await page.getByRole('tab', { name: 'Create Account', exact: true }).click();
    const owner = page.locator('#backup-owner-input');
    const register = page.getByRole('button', { name: 'Register V3 Account', exact: true });
    await owner.fill(getAddressFromScriptHash(customOtherOwner));
    await capture('mismatched-owner');
    assert.equal(await register.isDisabled(), true, 'another backup owner cannot be registered with the connected wallet witness');
    assert.equal(fixture.state.walletRequests.length, 0);
    await owner.fill(getAddressFromScriptHash(customOwner));
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Register V3 Account' && !button.disabled));
    await register.click();
    await page.getByText(/Register V3 account submitted/).last().waitFor();
    assert.equal(fixture.state.walletRequests.length, 1);
    const request = fixture.state.walletRequests[0];
    assert.equal(request.operation, 'registerAccount');
    assert.equal(request.args.length, 6);
    assert.deepEqual(request.args[4], { type: 'Hash160', value: customOwner });
    assert.equal(request.signers[0].account, getAddressFromScriptHash(customOwner));
    await capture('matching-owner-submitted');
  });
});

test('custom deployments without full pending getters cannot confirm a hidden target', { timeout: 90000 }, async () => {
  await withWorkspace('old-getters', async ({ page, fixture, capture }) => {
    await loadGovernance(page);
    await capture('loaded');
    for (const role of ['verifier', 'hook']) {
      const card = page.getByTestId(`custom-pending-${role}`);
      assert.equal(await card.count(), 1, 'pending state must be visible even on an older deployment');
      assert.match(await card.innerText(), /This deployment cannot show the pending target and parameters\. Confirmation is unavailable\./);
      assert.equal(await card.getByRole('button', { name: `Confirm ${role} update`, exact: true }).isDisabled(), true);
      assert.equal(await card.getByRole('button', { name: `Cancel ${role} update`, exact: true }).isDisabled(), false);
    }
    assert.equal(fixture.state.calls.some(({ params }) => ['getPendingVerifierUpdate', 'getPendingHookUpdate'].includes(params[1])), false);
    const ownerOnly = page.getByTestId('custom-owner-only-recovery');
    assert.match(await ownerOnly.innerText(), /This deployment does not support permanent owner-only recovery/);
    assert.equal(await ownerOnly.getByRole('button', { name: 'Finalize permanent owner-only recovery', exact: true }).isDisabled(), true);
    assert.equal(fixture.state.calls.some(({ params }) => params[1] === 'isOwnerOnlyRecovery'), false, 'older deployments are never probed with a phantom mode query');
    assert.equal(fixture.state.walletRequests.length, 0);
  }, (fixture) => { fixture.state.fullPendingRoles = []; });
});

test('permanent owner-only recovery requires maturity and irreversible acknowledgement, then blocks plugin configuration', { timeout: 90000 }, async () => {
  await withWorkspace('owner-only', async ({ page, fixture, capture }) => {
    await loadGovernance(page);
    const card = page.getByTestId('custom-owner-only-recovery');
    const finalize = card.getByRole('button', { name: 'Finalize permanent owner-only recovery', exact: true });
    const acknowledge = page.locator('#governance-owner-only-acknowledgement');
    assert.equal(await finalize.isDisabled(), true);
    await acknowledge.check();
    assert.equal(await finalize.isDisabled(), true, 'explicit acknowledgement cannot bypass the chain timelock');
    fixture.state.time += 1;
    await loadGovernance(page);
    assert.equal(await acknowledge.isChecked(), false, 'a fresh snapshot needs a fresh irreversible acknowledgement');
    await acknowledge.check();
    await finalize.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /irreversible.*can never install a verifier or hook again/s);
    assert.match(await dialog.innerText(), /does not transfer or refund balances/);
    assert.match(await dialog.innerText(), /cannot guarantee permissions in external contracts/);
    assert.match(await dialog.innerText(), new RegExp(customOwner));
    await confirmDialog(page, 'Finalize permanent owner-only recovery');
    await waitForFixtureWallet(fixture, 1);
    assertRequest(fixture.state.walletRequests[0], 'finalizeEscapeToOwner');
    await waitForGovernanceIdle(page);
    await loadGovernance(page);
    await page.getByTestId('custom-owner-only-state').waitFor();
    assert.match(await page.getByTestId('custom-owner-only-state').innerText(), /backup owner can directly authorize account operations/i);
    assert.equal(await page.getByText(/Installing into an empty slot is immediate/).count(), 0, 'permanent mode must not suggest plugins can be reinstalled');
    assert.equal(await page.locator('#governance-escape-mode').isDisabled(), true);
    for (const label of ['Update verifier', 'Update hook', 'Initiate escape', 'Finalize escape']) {
      assert.equal(await page.getByRole('button', { name: label, exact: true }).isDisabled(), true, label);
    }
    assert.equal(await finalize.isDisabled(), true, 'the permanent transition cannot be repeated');
    await capture('permanent-mode');
    await page.getByRole('tab', { name: 'Permissions & Limits', exact: true }).click();
    for (const label of ['Call verifier', 'Call hook']) {
      assert.equal(await page.getByRole('button', { name: label, exact: true }).isDisabled(), true, label);
    }
    assert.equal(fixture.state.walletRequests.length, 1);
  }, (fixture) => {
    fixture.state.ownerOnlyRecoverySupported = true;
    fixture.state.escapeActive = true;
    fixture.state.escapeTriggeredAt = fixture.matureAt - fixture.state.escapeTimelock * 1000;
  });
});

test('permanent recovery rechecks on-chain mode after the irreversible review', { timeout: 90000 }, async () => {
  await withWorkspace('owner-only-race', async ({ page, fixture }) => {
    await loadGovernance(page);
    await page.locator('#governance-owner-only-acknowledgement').check();
    await page.getByRole('button', { name: 'Finalize permanent owner-only recovery', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    fixture.state.ownerOnlyRecovery = true;
    fixture.state.verifier = customZero;
    fixture.state.hook = customZero;
    fixture.state.pendingVerifier = null;
    fixture.state.pendingHook = null;
    fixture.state.escapeActive = false;
    fixture.state.escapeTriggeredAt = 0;
    await confirmDialog(page, 'Finalize permanent owner-only recovery');
    await page.getByText(/Governance state changed\. Refresh and review again\./).last().waitFor();
    assert.equal(fixture.state.walletRequests.length, 0, 'a finalized mode on another device must stop before wallet signing');
    await loadGovernance(page);
    await page.getByTestId('custom-owner-only-state').waitFor();
  }, (fixture) => {
    fixture.state.ownerOnlyRecoverySupported = true;
    fixture.state.escapeActive = true;
    fixture.state.time = fixture.matureAt;
    fixture.state.escapeTriggeredAt = fixture.matureAt - fixture.state.escapeTimelock * 1000;
  });
});

test('custom pending updates bind full state, chain maturity and actual wallet invocations', { timeout: 90000 }, async () => {
  await withWorkspace('pending', async ({ page, fixture, capture }) => {
    await loadGovernance(page);
    await capture('before-maturity');
    for (const role of ['verifier', 'hook']) {
      const card = page.getByTestId(`custom-pending-${role}`);
      assert.equal(await card.count(), 1);
      assert.match(await card.innerText(), new RegExp(fixture.state[`pending${role === 'verifier' ? 'Verifier' : 'Hook'}`].module));
      assert.equal(await card.getByRole('button', { name: `Confirm ${role} update`, exact: true }).isDisabled(), true);
    }
    fixture.state.time = fixture.matureAt;
    await loadGovernance(page);
    const verifierCard = page.getByTestId('custom-pending-verifier');
    await page.waitForFunction(() => !document.querySelector('[data-testid="custom-pending-verifier"] button[aria-label="Confirm verifier update"]')?.disabled);
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
      await page.getByTestId(`custom-pending-${role}`).getByRole('button', { name: label, exact: true }).click();
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
      await page.getByTestId(`custom-pending-${role}`).getByRole('button', { name: label, exact: true }).click();
      await confirmDialog(page, label);
      await waitForFixtureWallet(fixture, walletCount + 1);
      await waitForGovernanceIdle(page);
      assertRequest(fixture.state.walletRequests.at(-1), `${action.toLowerCase()}${role === 'verifier' ? 'Verifier' : 'Hook'}Update`);
      await loadGovernance(page);
    }
    assert.equal(fixture.state.walletRequests.length, 4);
    await capture('confirmed-and-cancelled');
    await page.locator('#manage-target-account').fill(customOtherAccountId);
    await page.getByTestId('custom-pending-verifier').waitFor({ state: 'hidden' });
    assert.equal(await page.getByTestId('custom-pending-hook').count(), 0, 'changing account removes the previous snapshot');
    await loadGovernance(page);
    await page.evaluate(({ address, hash }) => {
      window.__customWallet = { address, hash };
      window.dispatchEvent(new CustomEvent('Neo.DapiProvider.ACCOUNT_CHANGED', { detail: { address, hash } }));
    }, { address: getAddressFromScriptHash(customOtherOwner), hash: customOtherOwner });
    await page.getByTestId('custom-pending-verifier').waitFor({ state: 'hidden' });
    assert.equal(await page.getByTestId('custom-pending-hook').count(), 0, 'changing wallet removes the previous snapshot');
    await capture('wallet-invalidated');
  });
});

test('custom escape recovery exposes explicit fallback and verifier parameters after chain maturity', { timeout: 90000 }, async () => {
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
      { type: 'Hash160', value: customAccountId }, { type: 'Hash160', value: customZero }, { type: 'ByteArray', value: '0x' },
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
      { type: 'Hash160', value: customAccountId }, { type: 'Hash160', value: newVerifier }, { type: 'ByteArray', value: '0x03cafe' },
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
