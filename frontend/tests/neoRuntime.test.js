import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { EC } from '../src/config/errorCodes.js';
import {
  DEFAULT_NEO_ADDRESS_VERSION,
  MAX_RECOVERY_TIMELOCK_MS,
  MIN_RECOVERY_TIMELOCK_MS,
  REGISTRATION_SALT_MAX_BYTES,
  createProxyScript,
  deriveAccountAddress,
  deriveAccountIdHash,
  deriveAccountIdentity,
  deriveAccountIdentityChainHex,
  getAddressFromScriptHash,
  getScriptHashFromAddress,
  hash160,
  reverseHex,
  invokeReadFunction,
} from '../src/utils/neo.js';

const require = createRequire(import.meta.url);
const { NativeSmartAccountClient } = require('../../sdk/js/src/index.js');

/** hash160 as the protocol defines it, computed here instead of by the module under test. */
const hash160Hex = (hex) => createHash('ripemd160')
  .update(createHash('sha256').update(Buffer.from(hex, 'hex')).digest())
  .digest('hex');

const CORE_HASH = '5be915aea3ce85e4752d522632f0a9520e377aaf';
const CUSTODY = '13ef519c362973f9a34648a9eac5b71250b2a80a';
const SALT = '0a1b2c3d';

// §16.1: accountId = hash160('aa524704' || reverse(custody) || salt).
const EXPECTED_ACCOUNT_ID = hash160Hex(`aa524704${reverseHex(CUSTODY)}${SALT}`);

test('reverseHex reverses byte order', () => {
  assert.equal(reverseHex('0123456789abcdef'), 'efcdab8967452301');
});

test('Neo address helpers round-trip a known script hash', () => {
  const scriptHash = '13ef519c362973f9a34648a9eac5b71250b2a80a';
  const address = getAddressFromScriptHash(scriptHash);

  assert.equal(address, 'NLtL2v28d7TyMEaXcPqtekunkFRksJ7wxu');
  assert.equal(getScriptHashFromAddress(address), scriptHash);
  assert.equal(DEFAULT_NEO_ADDRESS_VERSION, 53);
  assert.equal(hash160(reverseHex(scriptHash)), hash160Hex(reverseHex(scriptHash)));
});

test('deriveAccountIdHash normalizes arbitrary seeds into a 20-byte account id', () => {
  assert.equal(
    deriveAccountIdHash('56e5bbd0603bdf01699c047b2397ee0e'),
    'f951cd3eb5196dacde99b339c5dcca37ac38cc22',
  );
  // A 20-byte id is already an id: it is returned untouched.
  assert.equal(deriveAccountIdHash(`0x${CUSTODY}`), CUSTODY);
  assert.throws(() => deriveAccountIdHash(''), (error) => error.message === EC.accountSeedRequired);
});

test('deriveAccountIdentity hashes the v4 custody+salt preimage', () => {
  const identity = deriveAccountIdentity({ custodyAddress: CUSTODY, salt: SALT });
  assert.equal(identity.accountId, EXPECTED_ACCOUNT_ID);
  assert.equal(identity.identityPreimageHex, `aa524704${reverseHex(CUSTODY)}${SALT}`);
  // A Neo address names its own custody hash; both spellings derive one identity.
  assert.equal(
    deriveAccountIdentity({ custodyAddress: getAddressFromScriptHash(CUSTODY), salt: SALT }).accountId,
    EXPECTED_ACCOUNT_ID,
  );
  assert.equal(deriveAccountIdentityChainHex({ custodyAddress: CUSTODY, salt: SALT }), reverseHex(EXPECTED_ACCOUNT_ID));
});

test('the identity derivation binds the salt and refuses inputs it cannot hash', () => {
  assert.notEqual(
    deriveAccountIdentity({ custodyAddress: CUSTODY, salt: 'aabb' }).accountId,
    deriveAccountIdentity({ custodyAddress: CUSTODY, salt: 'aabbcc' }).accountId,
  );
  // An empty salt has no uniqueness material and a salt beyond 128 bytes has no protocol form.
  for (const salt of ['', 'aa'.repeat(REGISTRATION_SALT_MAX_BYTES + 1), 'zz']) {
    assert.throws(
      () => deriveAccountIdentity({ custodyAddress: CUSTODY, salt }),
      (error) => error.message === EC.registrationSaltInvalid,
      `salt ${salt.slice(0, 8)} must be refused`,
    );
  }
  for (const custodyAddress of ['', '0x12', 'zz'.repeat(20)]) {
    assert.throws(
      () => deriveAccountIdentity({ custodyAddress, salt: SALT }),
      (error) => error.message === EC.addressValidationFailed,
    );
  }
});

test('frontend and SDK derive byte-identical account identities', () => {
  const client = new NativeSmartAccountClient({ rpcClient: { send: async () => ({}) }, networkMagic: 894710606, contractHash: CORE_HASH });
  assert.equal(
    deriveAccountIdentity({ custodyAddress: CUSTODY, salt: SALT }).accountId,
    client.deriveIdentity({ custodyAddress: CUSTODY, salt: SALT }).accountId,
  );
});

test('the recovery timelock bounds are the protocol window in milliseconds', () => {
  assert.equal(MIN_RECOVERY_TIMELOCK_MS, 7 * 86_400_000);
  assert.equal(MAX_RECOVERY_TIMELOCK_MS, 90 * 86_400_000);
});

test('createProxyScript emits the §16.1 proxy verification script', () => {
  const accountId = '89abcdef0123456789abcdef0123456789abcdef';
  const script = createProxyScript(CORE_HASH, accountId);

  // PUSHDATA1 20 accountId | PUSH1 PACK | PUSH5 | PUSHDATA1 "verify" | PUSHDATA1 20 core | SYSCALL
  assert.equal(
    script,
    `0c14${reverseHex(accountId)}11c0150c067665726966790c14${reverseHex(CORE_HASH)}41627d5b52`,
  );
  assert.throws(() => createProxyScript(CORE_HASH, accountId, 15));
  assert.throws(() => createProxyScript(CORE_HASH, '00'.repeat(20)));
});

test('frontend and SDK derive one canonical account address', () => {
  const accountId = EXPECTED_ACCOUNT_ID;
  const script = createProxyScript(CORE_HASH, accountId);
  const address = deriveAccountAddress({ accountId, coreContractHash: CORE_HASH });
  const client = new NativeSmartAccountClient({ rpcClient: { send: async () => ({}) }, networkMagic: 894710606, contractHash: CORE_HASH });

  assert.equal(address, reverseHex(hash160Hex(script)));
  assert.equal(client.proxyAddress(accountId), address);
  assert.equal(client.deriveIdentity({ custodyAddress: CUSTODY, salt: SALT }).accountAddress, address);
  assert.notEqual(getScriptHashFromAddress(getAddressFromScriptHash(address)), '');
});

test('invokeReadFunction posts an invokefunction payload', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push([url, options]);
    return {
      ok: true,
      status: 200,
      async json() {
        return { result: { state: 'HALT', stack: [] } };
      },
    };
  };

  try {
    const result = await invokeReadFunction('https://rpc.example.org', '0xabc', 'getThing', [
      { type: 'Hash160', value: '0011' },
    ]);

    assert.deepEqual(result, { state: 'HALT', stack: [] });
    assert.equal(calls.length, 1);
    const [url, options] = calls[0];
    assert.equal(url, 'https://rpc.example.org');
    assert.equal(options.method, 'POST');
    const payload = JSON.parse(options.body);
    assert.equal(payload.method, 'invokefunction');
    assert.deepEqual(payload.params, ['0xabc', 'getThing', [{ type: 'Hash160', value: '0011' }]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
