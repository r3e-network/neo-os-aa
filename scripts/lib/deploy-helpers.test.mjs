import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { neon, invokePersisted, artifactPaths, parseVanityVerifyScript, classifyAuthorizedCoreBinding } = require('./deploy-helpers.js');
const publicHash = '6d0656f6dd91469db1c90cc1e574380613f43738';

test('public artifact selection cannot escape into the private profile', () => {
  for (const name of ['../platform/SmartAccount', '/tmp/other', 'verifiers/../../platform/Core', '', '..\\platform\\Core']) {
    assert.throws(() => artifactPaths(name), /public artifact name/);
  }
  // path.join yields native separators; the suffix pin must not depend on the host OS.
  const sep = '[\\\\/]';
  assert.match(artifactPaths('SmartAccount').nef, new RegExp(`contracts${sep}bin${sep}v3${sep}SmartAccount\\.nef$`));
  assert.match(artifactPaths('verifiers/WebAuthnVerifier').nef, new RegExp(`contracts${sep}bin${sep}v3${sep}verifiers${sep}WebAuthnVerifier\\.nef$`));
});

function stubContract(t, methods) {
  const descriptor = Object.getOwnPropertyDescriptor(neon.experimental, 'SmartContract');
  class FakeContract {
    testInvoke(...args) { return methods.testInvoke(...args); }
    invoke(...args) { return methods.invoke(...args); }
  }
  Object.defineProperty(neon.experimental, 'SmartContract', { value: FakeContract, configurable: true });
  t.after(() => Object.defineProperty(neon.experimental, 'SmartContract', descriptor));
}

function args(overrides = {}) {
  return { client: {}, account: { scriptHash: publicHash }, networkMagic: 860833102,
    rpcUrl: 'https://example.invalid', contractHash: publicHash, operation: 'update', ...overrides };
}

test('an ambiguous broadcast is attempted once and never retried', async (t) => {
  let broadcasts = 0;
  stubContract(t, {
    testInvoke: async () => ({ state: 'HALT', gasconsumed: '100' }),
    invoke: async () => { broadcasts++; throw new Error('ETIMEDOUT after submission'); },
  });
  await assert.rejects(invokePersisted(args()), /ETIMEDOUT/);
  assert.equal(broadcasts, 1);
});

test('the txid is saved before confirmation, even when the application faults', async (t) => {
  const events = [];
  const txid = `0x${'ab'.repeat(32)}`;
  stubContract(t, {
    testInvoke: async () => ({ state: 'HALT', gasconsumed: '100' }),
    invoke: async () => { events.push('broadcast'); return txid; },
  });
  await assert.rejects(invokePersisted(args({
    onBroadcast: async (id) => { assert.equal(id, txid); events.push('receipt'); },
    client: { getApplicationLog: async () => {
      events.push('confirmation');
      return { executions: [{ vmstate: 'FAULT', exception: 'state changed' }] };
    } },
  })), /expected HALT, got FAULT/);
  assert.deepEqual(events, ['broadcast', 'receipt', 'confirmation']);
});

test('an empty or faulted preview cannot broadcast', async (t) => {
  let preview = {};
  let broadcasts = 0;
  stubContract(t, {
    testInvoke: async () => preview,
    invoke: async () => { broadcasts++; },
  });
  await assert.rejects(invokePersisted(args()), /preview UNKNOWN/);
  preview = { state: 'FAULT', exception: 'Not admin' };
  await assert.rejects(invokePersisted(args()), /^Error: update preview FAULT: Not admin$/);
  assert.equal(broadcasts, 0);
});

// ── F-18: vanity witness-script parsing ─────────────────────────────────────

const VANITY_ACCOUNT_ID = 'a1b2'.repeat(10);
const VANITY_CORE_DISPLAY = 'c3d4'.repeat(10);
const VANITY_CORE_WIRE = VANITY_CORE_DISPLAY.match(/.{2}/g).reverse().join('');
const VANITY_VERIFY_SCRIPT = `0c14${VANITY_ACCOUNT_ID}11c01f0c067665726966790c14${VANITY_CORE_WIRE}41627d5b52`;

// Both the frontend vanity generator and the SDK's buildVerifyScript emit this
// tail (only the account-id byte order differs between them).
function vanityScript({ accountId = VANITY_ACCOUNT_ID, coreWire = VANITY_CORE_WIRE, tail = '41627d5b52', extra20 = '' } = {}) {
  return `0c14${accountId}11c01f0c067665726966790c14${coreWire}${extra20}${tail}`;
}

test('parseVanityVerifyScript extracts the pushed vanity account id and core binding', () => {
  assert.deepEqual(parseVanityVerifyScript(VANITY_VERIFY_SCRIPT), {
    accountId: VANITY_ACCOUNT_ID,
    coreContractHash: VANITY_CORE_DISPLAY,
  });
  // sanitizeHex normalizes the 0x prefix and case before parsing.
  assert.deepEqual(parseVanityVerifyScript(`0x${VANITY_VERIFY_SCRIPT.toUpperCase()}`), {
    accountId: VANITY_ACCOUNT_ID,
    coreContractHash: VANITY_CORE_DISPLAY,
  });
});

test('parseVanityVerifyScript is strict about the standard vanity layout', () => {
  // Not the Contract.Call syscall tail.
  assert.equal(parseVanityVerifyScript(vanityScript({ tail: '41627d5b53' })), null);
  // A third 20-byte push is not the standard layout.
  assert.equal(parseVanityVerifyScript(vanityScript({ extra20: `0c14${'ff'.repeat(20)}` })), null);
  // Missing the "verify" method-name push.
  assert.equal(parseVanityVerifyScript(`0c14${VANITY_ACCOUNT_ID}11c01f0c14${VANITY_CORE_WIRE}41627d5b52`), null);
  // Truncated script (the final core push exceeds the script end), odd-length
  // hex, empty and non-hex input.
  assert.equal(parseVanityVerifyScript(VANITY_VERIFY_SCRIPT.slice(0, -12)), null);
  assert.equal(parseVanityVerifyScript('0c1'), null);
  assert.equal(parseVanityVerifyScript(''), null);
  assert.equal(parseVanityVerifyScript(null), null);
  assert.equal(parseVanityVerifyScript('zz' + VANITY_VERIFY_SCRIPT.slice(2)), null);
});

// ── F-19: authorized-core binding classification ────────────────────────────

const CORE_A = '11'.repeat(20);
const CORE_B = '22'.repeat(20);

test('classifyAuthorizedCoreBinding distinguishes first-bind, already-bound and rebind', () => {
  // Unset states (empty, 0x-prefixed empty, all-zero) are initial binds.
  assert.equal(classifyAuthorizedCoreBinding('', CORE_A), 'first-bind');
  assert.equal(classifyAuthorizedCoreBinding('0x', CORE_A), 'first-bind');
  assert.equal(classifyAuthorizedCoreBinding('00'.repeat(20), `0x${CORE_A}`), 'first-bind');
  // An exact match is already bound — no broadcast is needed.
  assert.equal(classifyAuthorizedCoreBinding(`0x${CORE_A}`, `0x${CORE_A.toUpperCase()}`), 'already-bound');
  // A different configured core is a rebind, which setAuthorizedCore rejects.
  assert.equal(classifyAuthorizedCoreBinding(`0x${CORE_B}`, CORE_A), 'rebind');
});
