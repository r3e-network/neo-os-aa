import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright';
import {
  canonicalizeOperatorMutationPayload, importOperatorPublicKey,
  operatorPublicKeysMatch, verifyOperatorMutationSignature,
} from '../api/operatorMutationHelpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const password = 'operator backup browser test passphrase';
const shareSlug = 'browser-recovery-draft';
const accessSlug = 'browser-operator-link';

test('real Chromium preserves the key across browser restart and restores encrypted download in a fresh profile', { timeout: 90_000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'aa-operator-browser-'));
  const state = { publicJwk: null, counter: 0, requests: [] };
  const server = await createServer({
    configFile: false, root, cacheDir: path.join(temp, 'vite-cache'),
    optimizeDeps: { entries: [], include: ['vue'], noDiscovery: true },
    plugins: [vue(), {
      name: 'operator-key-test-endpoint',
      resolveId(id) { if (id === '/operator-key-entry.js') return '\0operator-key-entry'; },
      load(id) {
        if (id === '\0operator-key-entry') return `import { createApp, h } from 'vue';
          import Panel from '/src/features/operations/components/OperatorKeyBackupPanel.vue';
          export function mount(props) { createApp({ render: () => h(Panel, props) }).mount('#panel'); }`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url === '/operator-key-test') {
            res.setHeader('content-type', 'text/html');
            res.end('<!doctype html><html><body><div id="panel"></div></body></html>');
            return;
          }
          if (req.url !== '/api/draft-operator') return next();
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          state.requests.push(body);
          const reply = (code, value) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
          if (body.accessSlug !== accessSlug) return reply(403, { error: 'draft_operator_access_required' });
          if (body.action === 'claim') {
            if (state.publicJwk && !operatorPublicKeysMatch(state.publicJwk, body.publicKeyJwk)) return reply(403, { error: 'operator_key_already_claimed' });
            // JSONB reorders keys; emulate that readback explicitly.
            state.publicJwk ||= Object.fromEntries(Object.entries(body.publicKeyJwk).reverse());
            return reply(200, { operatorCounter: state.counter, accessSlug });
          }
          const canonical = canonicalizeOperatorMutationPayload({ shareSlug: body.shareSlug, mutation: body.mutation, payload: body.payload, counter: body.counter });
          const verified = await verifyOperatorMutationSignature(canonical, body.signature, await importOperatorPublicKey(state.publicJwk));
          if (!verified || body.counter !== state.counter) return reply(403, { error: 'invalid_operator_signature' });
          state.counter += 1;
          reply(200, { operatorCounter: state.counter, draft: { status: body.payload.status } });
        });
      },
    }],
    resolve: { alias: { '@': path.join(root, 'src') } },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [path.resolve(root, '..')] } },
    logLevel: 'error',
  });
  let context;
  const logs = [];
  try {
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/operator-key-test`;
    async function open(profile) {
      context = await chromium.launchPersistentContext(path.join(temp, profile), { headless: true, acceptDownloads: true });
      const page = await context.newPage();
      page.on('console', (message) => logs.push(message.text()));
      page.on('pageerror', (err) => logs.push(err.message));
      await page.goto(url);
      await page.evaluate(async ({ shareSlug, accessSlug }) => {
        const { mount } = await import('/operator-key-entry.js');
        mount({ shareSlug, accessSlug });
      }, { shareSlug, accessSlug });
      await page.getByText('Operator key backup and recovery', { exact: true }).click();
      return page;
    }
    let page = await open('original');
    await page.getByLabel('Backup password (at least 12 characters)', { exact: true }).fill(password);
    await page.getByLabel('Confirm password for export', { exact: true }).fill(password);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download encrypted backup', exact: true }).click();
    const download = await downloadPromise;
    const backup = await readFile(await download.path(), 'utf8');
    await page.getByRole('status').filter({ hasText: 'Encrypted backup downloaded' }).waitFor();
    assert.equal(backup.includes(password), false);
    assert.equal(backup.includes('privateJwk'), false);
    assert.equal(backup.includes(accessSlug), false);
    assert.equal(await page.getByLabel('Backup password (at least 12 characters)', { exact: true }).inputValue(), '');
    const pinned = { ...state.publicJwk };
    await context.close(); context = null;

    page = await open('original');
    async function mutate(currentPage) {
      return currentPage.evaluate(async ({ shareSlug, accessSlug }) => {
        const { createOperatorMutationTransport } = await import('/src/features/operations/operatorMutationTransport.js');
        return createOperatorMutationTransport().run({ shareSlug, accessSlug, mutation: 'setStatus', payload: { status: 'ready' } });
      }, { shareSlug, accessSlug });
    }
    assert.equal((await mutate(page)).status, 'ready');
    assert.deepEqual(state.publicJwk, pinned);
    assert.equal(state.counter, 1);
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some((key) => key.startsWith('aa_operator_session'))), false);
    await context.close(); context = null;

    page = await open('fresh');
    await page.getByLabel('Encrypted operator backup file', { exact: true }).setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
    await page.getByLabel('Backup password (at least 12 characters)', { exact: true }).fill('this is the wrong password');
    const calls = state.requests.length;
    await page.getByRole('button', { name: 'Restore operator key', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Could not open this backup' }).waitFor();
    assert.equal(state.requests.length, calls);
    await page.getByLabel('Encrypted operator backup file', { exact: true }).setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
    await page.getByLabel('Backup password (at least 12 characters)', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Restore operator key', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Operator key restored and checked' }).waitFor();
    await mutate(page);
    assert.equal(state.counter, 2);
    assert.deepEqual(state.publicJwk, pinned);
    for (const output of [JSON.stringify(logs), JSON.stringify(state.requests)]) {
      assert.equal(output.includes(password), false);
      assert.equal(output.includes('privateJwk'), false);
    }
  } finally {
    await context?.close();
    await server.close();
    await rm(temp, { recursive: true, force: true });
  }
});
