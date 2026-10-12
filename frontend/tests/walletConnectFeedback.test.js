import test from 'node:test';
import assert from 'node:assert/strict';

import { EC, translateError } from '../src/config/errorCodes.js';

// Connect Wallet is the first thing a user does. A failure that renders nothing, or that reports a
// user's refusal as "the wallet did not return an address", is the defect this slice closes.
// Messages are read through the real i18n controller so the sentences under test are the shipped ones.

const errorCodes = await import('../src/config/errorCodes.js');
const { createI18nController } = await import('../src/i18n/index.js');

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    has: (key) => values.has(key),
  };
}

function createWindowStub({ storage, providers = {} } = {}) {
  const listeners = new Map();
  return {
    localStorage: storage,
    location: { host: 'localhost', hostname: 'localhost', origin: 'http://localhost' },
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
    },
    removeEventListener(name, handler) {
      listeners.get(name)?.delete(handler);
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event?.type) ?? []) handler(event);
      return true;
    },
    ...providers,
  };
}

let importCounter = 0;
async function loadWalletService(windowStub) {
  globalThis.window = windowStub;
  try {
    importCounter += 1;
    const moduleUrl = new URL(`../src/services/walletService.js?connect-feedback=${importCounter}`, import.meta.url);
    return await import(moduleUrl.href);
  } finally {
    delete globalThis.window;
  }
}

async function connectWith(provider) {
  const windowStub = createWindowStub({ storage: createMemoryStorage(), providers: { NEP21Provider: provider } });
  const { walletService } = await loadWalletService(windowStub);
  globalThis.window = windowStub;
  try {
    return await walletService.connect();
  } catch (error) {
    return { error };
  } finally {
    delete globalThis.window;
  }
}

function rejectingProvider(message) {
  const error = message instanceof Error ? message : new Error(message);
  return {
    dapiVersion: '1.0',
    name: 'WalletShim',
    getAccounts: async () => {
      throw error;
    },
    invoke: async () => ({ txid: '0xstub' }),
  };
}

async function translatorFor(locale) {
  const controller = createI18nController({ storage: createMemoryStorage(), forceNew: true });
  await controller.setLocale(locale);
  return (key, fallback = '') => controller.t(key, fallback);
}

test('a refused wallet connection is named as a refusal and keeps the wallet words', async () => {
  const words = 'User rejected the request.';
  const outcome = await connectWith(rejectingProvider(words));
  const thrown = outcome.error;
  assert.ok(thrown, 'a refused connection must fail');
  assert.notEqual(thrown.message, EC.walletAddressMissing,
    'a refusal must not be reported as a missing address');

  const { connectErrorMessage } = errorCodes;
  assert.equal(typeof connectErrorMessage, 'function', 'connectErrorMessage is exported from errorCodes.js');
  const t = await translatorFor('en');
  const rendered = connectErrorMessage(thrown, t);
  assert.ok(rendered.trim().length > 0, 'a refusal renders a message');
  assert.match(rendered, /refus/i, 'the refusal is named as a refusal');
  assert.ok(rendered.includes(words), `the wallet's own words are kept: ${rendered}`);
});

test('an error with no message still renders a sentence in en and zh', async () => {
  const { connectErrorMessage } = errorCodes;
  assert.equal(typeof connectErrorMessage, 'function', 'connectErrorMessage is exported from errorCodes.js');

  for (const locale of ['en', 'zh-CN']) {
    const t = await translatorFor(locale);
    const expected = t('errors.walletConnectFailed', '');
    assert.ok(expected.trim().length > 0, `the ${locale} sentence exists and is not the key`);
    for (const failure of [new Error(''), new Error(), {}, null, undefined, { message: '   ' }]) {
      const rendered = connectErrorMessage(failure, t);
      assert.equal(typeof rendered, 'string');
      assert.ok(rendered.trim().length > 0,
        `no failure renders empty in ${locale}: ${JSON.stringify(failure)}`);
    }
    assert.equal(connectErrorMessage(new Error(), t), expected, `the ${locale} sentence is used`);
    assert.notEqual(connectErrorMessage(new Error(), t), 'errors.walletConnectFailed',
      `the ${locale} message is a sentence, not a key`);
  }
});

test('every connect failure shape renders a non-empty message', async () => {
  const { connectErrorMessage } = errorCodes;
  assert.equal(typeof connectErrorMessage, 'function', 'connectErrorMessage is exported from errorCodes.js');
  const t = await translatorFor('en');

  const shapes = [
    new Error(EC.walletProviderMissing),
    new Error(EC.walletAddressMissing),
    new Error(EC.evmProviderMissing),
    new Error(EC.walletRequestFailed),
    new Error('Could not find wallet'),
    { message: 'The user disapproved the request' },
    { code: '4001', message: 'User rejected the request.' },
    { message: 'User denied account authorization' },
  ];
  for (const failure of shapes) {
    const rendered = connectErrorMessage(failure, t);
    assert.equal(typeof rendered, 'string');
    assert.ok(rendered.trim().length > 0, `renders a message for ${JSON.stringify(failure)}`);
  }

  // An error code is still translated rather than shown as a code.
  assert.equal(connectErrorMessage(new Error(EC.walletProviderMissing), t), t('errors.walletProviderMissing'));
  assert.equal(translateError(EC.walletProviderMissing, t), t('errors.walletProviderMissing'));
});
