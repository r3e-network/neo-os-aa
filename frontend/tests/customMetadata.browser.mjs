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
  createCustomGovernanceFixture,
  customOwner,
  customOtherOwner,
  customAccountId,
  customCore,
  customRpcUrl,
  customMagic,
} from './fixtures/customGovernanceFixture.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const evidenceDir = process.env.CUSTOM_METADATA_EVIDENCE_DIR || join(tmpdir(), 'sa-custom-metadata');

async function withWorkspace(name, run, setup = () => {}) {
  const fixture = createCustomGovernanceFixture();
  setup(fixture);
  const errors = [];
  const env = {
    VITE_SA_RPC_URL: customRpcUrl,
    VITE_SA_HASH: customCore,
    VITE_SA_NETWORK_MAGIC: String(customMagic),
  };
  const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  await mkdir(evidenceDir, { recursive: true });
  const server = await startCustomBrowserServer(root);
  let browser;
  let page;
  try {
    const { origin } = server;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      // Chromium may probe its local DevTools Inspector endpoint while a
      // request fixture is active. It is not application traffic; keep the
      // fixture's external-request block while excluding this known browser
      // diagnostic from page-health assertions.
      if (message.type() === 'error' && !message.text().includes('ERR_BLOCKED_BY_CLIENT.Inspector')) errors.push(message.text());
    });
    await page.route('**/*', (route) => fixture.route(route, origin));
    await page.exposeFunction('customWalletInvoke', (request) => fixture.invoke(request));
    await page.addInitScript(({ address, hash, magic }) => {
      localStorage.setItem('sa_locale', 'en');
      let override = null;
      try { override = JSON.parse(localStorage.getItem('custom-wallet-override') || 'null'); } catch (_) { /* fixture storage only */ }
      window.__customWallet = override?.address && override?.hash ? override : { address, hash };
      window.neo3Dapi = {
        getAccount: async () => window.__customWallet,
        getNetwork: async () => ({ magic }),
        invoke: (request) => window.customWalletInvoke(request),
      };
    }, { address: getAddressFromScriptHash(customOwner), hash: customOwner, magic: customMagic });
    await page.goto(`${origin}/app`);
    await page.getByRole('heading', { name: /Smart Account Workspace/i }).waitFor();
    await page.locator('#main-content').getByRole('button', { name: 'Connect Wallet', exact: true }).click();
    await page.getByRole('tab', { name: 'Manage Governance', exact: true }).click();
    await loadGovernance(page);
    await run({ page, fixture, origin });
    await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: true });
    await writeFile(join(evidenceDir, `${name}.txt`), await page.locator('body').innerText());
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    assert.equal(await page.locator('.app-error-boundary').count(), 0, 'Vue errors caught by the app boundary must fail the browser gate');
    assert.equal(await page.locator('script[src="/@vite/client"]').count(), 0, 'fixture serves the built app without optimizer/HMR');
    assert.deepEqual(errors, [], 'no browser errors');
    assert.deepEqual(fixture.state.failures, [], 'all fixture RPC calls must be handled');
    assert.deepEqual(fixture.state.unexpectedRequests, [], 'no external or unstubbed request may escape');
  } finally {
    if (page) await writeFile(join(evidenceDir, `${name}-final.txt`), await page.locator('body').innerText().catch(() => ''));
    await writeFile(join(evidenceDir, `${name}-requests.json`), JSON.stringify({
      errors,
      rpc: fixture.state.calls,
      wallet: fixture.state.walletRequests,
      metadata: fixture.state.metadataPosts,
      events: fixture.state.events,
      failures: fixture.state.failures,
      blocked: fixture.state.unexpectedRequests,
    }, null, 2));
    await browser?.close();
    await server.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

async function loadGovernance(page, account = customAccountId) {
  await page.locator('#manage-target-account').fill(account);
  await page.getByRole('button', { name: 'Load account', exact: true }).click();
  await page.getByText('Current account configuration loaded.', { exact: true }).last().waitFor();
}

async function fillMetadata(page, values) {
  await page.locator('#governance-metadata-uri').fill(values.metadataUri);
  await page.locator('#governance-description').fill(values.description);
  await page.locator('#governance-logo-url').fill(values.logoUrl);
}

async function saveButton(page) {
  return page.getByRole('button', { name: /Save Metadata/i });
}

async function waitForFixtureCount(readCount, count, label, timeout = 10000) {
  const started = Date.now();
  while (readCount() < count && Date.now() - started < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(readCount(), count, `${label} ${count} should be observed`);
}

async function waitForFixtureWallet(fixture, count) {
  return waitForFixtureWalletOperation(fixture, count, 'setMetadataUri');
}

async function waitForFixtureWalletOperation(fixture, count, operation) {
  await waitForFixtureCount(() => fixture.state.walletRequests.length, count, 'wallet request');
  assert.equal(fixture.state.walletRequests[count - 1].operation, operation);
  return fixture.state.events.find((entry) => entry.type === 'wallet-invoke' && entry.operation === operation)?.txid;
}

async function waitForFixtureApplicationLog(fixture, count, txid = null) {
  await waitForFixtureCount(
    () => fixture.state.events.filter((entry) => entry.type === 'application-log' && (!txid || entry.txid === txid)).length,
    count,
    'application log',
  );
}

async function waitForMetadataIdle(page) {
  const button = await saveButton(page);
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (await button.count() && !(await button.isDisabled())) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('metadata save did not return to an idle state');
}

async function waitForMetadataTerminal(page) {
  const button = await saveButton(page);
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const count = await button.count();
    if (!count) return;
    const settled = await button.evaluate((element) => (
      !element.classList.contains('btn-loading')
      && !/saving/i.test(element.textContent || '')
    ));
    if (settled) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('metadata save did not reach a terminal state');
}

async function waitForMetadataBusy(page) {
  const button = await saveButton(page);
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (await button.count() && await button.isDisabled()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('metadata save did not enter a busy state');
}

async function waitForGovernanceIdle(page) {
  const button = page.getByRole('button', { name: 'Load account', exact: true });
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (await button.count() && !(await button.isDisabled())) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('governance operation did not return to an idle state');
}

test('metadata save requires the currently connected Neo backup owner', { timeout: 120000 }, async () => {
  await withWorkspace('owner-authorization', async ({ page, fixture }) => {
    await page.evaluate(({ address, hash }) => {
      window.__customWallet = { address, hash };
      window.dispatchEvent(new CustomEvent('Neo.DapiProvider.ACCOUNT_CHANGED', { detail: { address, hash } }));
    }, { address: getAddressFromScriptHash(customOtherOwner), hash: customOtherOwner });
    await page.waitForFunction(() => {
      const field = document.querySelector('#governance-metadata-uri');
      const button = [...document.querySelectorAll('button')].find((entry) => /save metadata/i.test(entry.getAttribute('aria-label') || entry.textContent || ''));
      return !field || button?.disabled === true;
    });
    const button = await saveButton(page);
    if (await button.count()) assert.equal(await button.isDisabled(), true, 'non-owner must not be offered a metadata wallet action');
    assert.equal(fixture.state.walletRequests.length, 0);
  });
});

test('wallet switch followed by reload keeps metadata unavailable to a non-owner', { timeout: 120000 }, async () => {
  await withWorkspace('owner-reload', async ({ page, fixture }) => {
    await page.evaluate(({ address, hash }) => {
      localStorage.setItem('custom-wallet-override', JSON.stringify({ address, hash }));
    }, { address: getAddressFromScriptHash(customOtherOwner), hash: customOtherOwner });
    await page.reload();
    await page.getByRole('heading', { name: /Smart Account Workspace/i }).waitFor();
    await page.evaluate(({ address, hash }) => {
      window.__customWallet = { address, hash };
      window.dispatchEvent(new CustomEvent('Neo.DapiProvider.ACCOUNT_CHANGED', { detail: { address, hash } }));
    }, { address: getAddressFromScriptHash(customOtherOwner), hash: customOtherOwner });
    const connect = page.locator('#main-content').getByRole('button', { name: 'Connect Wallet', exact: true });
    if (await connect.count() && await connect.isVisible()) await connect.click();
    await page.getByRole('tab', { name: 'Manage Governance', exact: true }).click();
    await loadGovernance(page);
    const button = await saveButton(page);
    assert.equal(await button.isDisabled(), true, 'reloaded non-owner must not be offered metadata signing');
    assert.equal(fixture.state.walletRequests.length, 0);
  });
});

test('metadata save rechecks fresh account state before asking the wallet', { timeout: 120000 }, async () => {
  await withWorkspace('fresh-state', async ({ page, fixture }) => {
    fixture.state.backupOwner = customOtherOwner;
    await fillMetadata(page, { metadataUri: 'https://fixture.invalid/stale.json', description: 'stale', logoUrl: '' });
    const button = await saveButton(page);
    assert.equal(await button.isDisabled(), false, 'fixture must exercise the stale-state save path');
    await button.click();
    await waitForMetadataIdle(page);
    assert.equal(fixture.state.walletRequests.length, 0, 'stale backup-owner state must stop before signing');
    assert.equal(fixture.state.metadataPosts.length, 0);
  });
});

test('metadata mirror waits for a HALT setMetadataUri result and never mirrors FAULT or pending', { timeout: 120000 }, async () => {
  for (const [name, vmstate, expectedPosts] of [['metadata-halt', 'HALT', 1], ['metadata-fault', 'FAULT', 0], ['metadata-pending', 'PENDING', 0]]) {
    await withWorkspace(name, async ({ page, fixture }) => {
      await fillMetadata(page, { metadataUri: `https://fixture.invalid/${name}.json`, description: name, logoUrl: '' });
      if (vmstate === 'PENDING') await page.clock.install();
      const expectedUri = `https://fixture.invalid/${name}.json`;
      await (await saveButton(page)).click();
      const txid = await waitForFixtureWallet(fixture, 1);
      if (vmstate === 'PENDING') {
        await page.clock.fastForward('02');
      }
      await waitForFixtureApplicationLog(fixture, 1, txid);
      if (vmstate === 'PENDING') {
        // waitForTransactionConfirmation has a bounded 90-second budget. Run
        // that complete budget so the pending terminal state is observed.
        await page.clock.runFor('01:30');
      }
      await waitForMetadataIdle(page);
      assert.equal(fixture.state.metadataPosts.length, expectedPosts);
      assert.deepEqual(fixture.state.walletRequests[0].args, [
        { type: 'Hash160', value: customAccountId },
        { type: 'String', value: expectedUri },
      ]);
      const logIndex = fixture.state.events.findIndex((entry) => entry.type === 'application-log');
      const postIndex = fixture.state.events.findIndex((entry) => entry.type === 'metadata-post');
      if (expectedPosts) {
        assert.ok(logIndex >= 0 && postIndex > logIndex, 'off-chain mirror follows confirmed chain execution');
        assert.deepEqual(fixture.state.metadataPosts[0], {
          action: 'upsert',
          accountIdHash: customAccountId,
          description: name,
          logoUrl: '',
          metadataUri: expectedUri,
        });
      }
      else assert.equal(postIndex, -1, `${vmstate} must not write an off-chain mirror`);
    }, (fixture) => { fixture.state.metadataLogState = vmstate; });
  }
});

test('metadata save snapshots account fields and suppresses duplicate clicks while wallet is pending', { timeout: 120000 }, async () => {
  await withWorkspace('metadata-snapshot', async ({ page, fixture }) => {
    fixture.state.walletDelayMs = 1500;
    const original = { metadataUri: 'https://fixture.invalid/original.json', description: 'original description', logoUrl: '' };
    const changed = { metadataUri: 'https://fixture.invalid/changed.json', description: 'changed description', logoUrl: '' };
    await fillMetadata(page, original);
    const button = await saveButton(page);
    await button.click();
    await waitForMetadataBusy(page);
    assert.equal(await button.isDisabled(), true, 'save button is busy while the wallet is pending');
    const txid = await waitForFixtureWallet(fixture, 1);
    await page.evaluate(() => {
      const element = [...document.querySelectorAll('button')].find((entry) => /save metadata/i.test(entry.getAttribute('aria-label') || entry.textContent || ''));
      element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await fillMetadata(page, changed);
    await waitForFixtureApplicationLog(fixture, 1, txid);
    await waitForMetadataIdle(page);
    assert.equal(fixture.state.walletRequests.length, 1, 'busy state prevents duplicate wallet requests');
    assert.equal(fixture.state.metadataPosts.length, 0, 'changed fields must not be attached to the confirmed transaction mirror');
    assert.equal(fixture.state.walletRequests[0].args[1].value, original.metadataUri);
    assert.match(await page.locator('body').innerText(), /account or form changed|Refresh the account/i);
  });
});

test('account switch while wallet is waiting never mirrors the original account', { timeout: 120000 }, async () => {
  await withWorkspace('metadata-account-switch', async ({ page, fixture }) => {
    fixture.state.walletDelayMs = 1500;
    const original = { metadataUri: 'https://fixture.invalid/account-switch.json', description: 'original account', logoUrl: '' };
    await fillMetadata(page, original);
    await (await saveButton(page)).click();
    await waitForMetadataBusy(page);
    const txid = await waitForFixtureWallet(fixture, 1);
    await page.evaluate(({ address, hash }) => {
      window.__customWallet = { address, hash };
      window.dispatchEvent(new CustomEvent('Neo.DapiProvider.ACCOUNT_CHANGED', { detail: { address, hash } }));
    }, { address: getAddressFromScriptHash(customOtherOwner), hash: customOtherOwner });
    await waitForFixtureApplicationLog(fixture, 1, txid);
    await page.getByText(/account or form changed|Refresh the account/i).waitFor();
    await waitForMetadataTerminal(page);
    assert.equal(fixture.state.metadataPosts.length, 0, 'account switch during signing must not mirror old intent');
    assert.equal(fixture.state.walletRequests.length, 1);
    assert.equal(fixture.state.walletRequests[0].args[0].value, customAccountId);
    assert.equal(await page.getByTestId('custom-chain-time').count(), 0, 'old account snapshot must be cleared');
  });
});

test('network switch while wallet is waiting never mirrors the old network context', { timeout: 120000 }, async () => {
  await withWorkspace('metadata-network-switch', async ({ page, fixture }) => {
    fixture.state.walletDelayMs = 1500;
    await fillMetadata(page, { metadataUri: 'https://fixture.invalid/network-switch.json', description: 'old network', logoUrl: '' });
    await (await saveButton(page)).click();
    await waitForMetadataBusy(page);
    const txid = await waitForFixtureWallet(fixture, 1);
    await page.evaluate(() => window.dispatchEvent(new Event('Neo.DapiProvider.NETWORK_CHANGED')));
    await waitForFixtureApplicationLog(fixture, 1, txid);
    await page.getByText(/account or form changed|Refresh the account/i).waitFor();
    await waitForMetadataTerminal(page);
    assert.equal(fixture.state.metadataPosts.length, 0, 'network switch during signing must not mirror old context');
    assert.equal(fixture.state.walletRequests.length, 1);
  });
});

test('metadata save is mutually exclusive with a governance wallet operation', { timeout: 120000 }, async () => {
  await withWorkspace('metadata-governance-busy', async ({ page, fixture }) => {
    fixture.state.walletDelayMs = 1500;
    const initiate = page.getByRole('button', { name: /Initiate escape/i });
    await initiate.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Initiate Escape', exact: true }).click();
    const txid = await waitForFixtureWalletOperation(fixture, 1, 'initiateEscape');
    await fillMetadata(page, { metadataUri: 'https://fixture.invalid/governance-busy.json', description: 'blocked', logoUrl: '' });
    assert.equal(await (await saveButton(page)).isDisabled(), true, 'metadata is disabled while governance is signing');
    assert.equal(fixture.state.walletRequests.length, 1, 'metadata must not open a second wallet request while governance is signing');
    assert.equal(fixture.state.metadataPosts.length, 0);
    await waitForFixtureApplicationLog(fixture, 1, txid);
    await waitForGovernanceIdle(page);
  });
});
