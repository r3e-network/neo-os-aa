import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  DEFAULT_NEO_ADDRESS_VERSION,
  createVerifyScript,
  deriveAccountIdHash,
  deriveRegistrationAccountIdHash,
  deriveRegistrationAccountIdChainHex,
  getAddressFromScriptHash,
  getScriptHashFromAddress,
  reverseHex,
  invokeReadFunction,
} from '../src/utils/neo.js';

const require = createRequire(import.meta.url);
const { AbstractAccountClient } = require('../../sdk/js/src/index.js');

test('reverseHex reverses byte order', () => {
  assert.equal(reverseHex('0123456789abcdef'), 'efcdab8967452301');
});

test('Neo address helpers round-trip a known script hash', () => {
  const scriptHash = '13ef519c362973f9a34648a9eac5b71250b2a80a';
  const address = getAddressFromScriptHash(scriptHash);

  assert.equal(address, 'NLtL2v28d7TyMEaXcPqtekunkFRksJ7wxu');
  assert.equal(getScriptHashFromAddress(address), scriptHash);
  assert.equal(DEFAULT_NEO_ADDRESS_VERSION, 53);
});

test('deriveAccountIdHash normalizes arbitrary seeds into a 20-byte account id', () => {
  assert.equal(
    deriveAccountIdHash('56e5bbd0603bdf01699c047b2397ee0e'),
    'f951cd3eb5196dacde99b339c5dcca37ac38cc22'
  );
});

const REGISTRATION_VECTOR = {
  verifierContractHash: '0x5be915aea3ce85e4752d522632f0a9520e377aaf',
  verifierParamsHex: '11223344',
  backupOwnerAddress: '0x13ef519c362973f9a34648a9eac5b71250b2a80a',
  escapeTimelock: 2592000,
};
// Matches the on-chain ComputeRegistrationAccountId display form and the SDK
// (sdk/js/tests/v3_flow.unit.test.js pins the same value).
const REGISTRATION_VECTOR_DISPLAY_HEX = '27c01243fca45e1b821dc3bb45267a579762d530';
// Internal little-endian VM byte order, for raw script pushes only.
const REGISTRATION_VECTOR_CHAIN_HEX = '30d56297577a2645bbc31d821b5ea4fc4312c027';

test('deriveRegistrationAccountIdHash binds the V3 account id to the registration config', () => {
  assert.equal(
    deriveRegistrationAccountIdHash(REGISTRATION_VECTOR),
    REGISTRATION_VECTOR_DISPLAY_HEX
  );
});

test('registration account id chain hex is the byte-reversed display form', () => {
  assert.equal(
    deriveRegistrationAccountIdChainHex(REGISTRATION_VECTOR),
    REGISTRATION_VECTOR_CHAIN_HEX
  );
  assert.equal(
    deriveRegistrationAccountIdChainHex(REGISTRATION_VECTOR),
    reverseHex(deriveRegistrationAccountIdHash(REGISTRATION_VECTOR))
  );
});

test('frontend and SDK derive byte-identical registration account ids', () => {
  const client = new AbstractAccountClient('https://example.invalid', '0x1234567890123456789012345678901234567890');
  assert.equal(
    deriveRegistrationAccountIdHash(REGISTRATION_VECTOR),
    client.deriveRegistrationAccountIdHash(REGISTRATION_VECTOR)
  );
});

test('deriveRegistrationAccountIdHash rejects escape timelocks outside the contract registration bounds', () => {
  assert.throws(
    () => deriveRegistrationAccountIdHash({
      backupOwnerAddress: '0x13ef519c362973f9a34648a9eac5b71250b2a80a',
      escapeTimelock: 604799,
    }),
    /escape timelock/i
  );

  assert.throws(
    () => deriveRegistrationAccountIdHash({
      backupOwnerAddress: '0x13ef519c362973f9a34648a9eac5b71250b2a80a',
      escapeTimelock: 7776001,
    }),
    /escape timelock/i
  );
});

test('createVerifyScript matches the V3 verify script encoding', () => {
  const script = createVerifyScript(
    '5be915aea3ce85e4752d522632f0a9520e377aaf',
    REGISTRATION_VECTOR_DISPLAY_HEX
  );

  assert.equal(
    script,
    '0c1430d56297577a2645bbc31d821b5ea4fc4312c02711c01f0c067665726966790c14af7a370e52a9f03226522d75e485cea3ae15e95b41627d5b52'
  );
});

test('frontend and SDK derive one canonical virtual account address', () => {
  const coreHash = '0123456789abcdef0123456789abcdef01234567';
  const accountId = '89abcdef0123456789abcdef0123456789abcdef';
  const expectedScript = '0c14efcdab8967452301efcdab8967452301efcdab8911c01f0c067665726966790c1467452301efcdab8967452301efcdab896745230141627d5b52';
  const expectedScriptHash = 'f2afddbbdae6b710f0c2cdebb8b734e40d4d4fda';
  const expectedAddress = 'NfpHVWDgSaedTHuk183urAp9FDBS4i4VYB';
  const client = new AbstractAccountClient('https://example.invalid', coreHash);
  const account = client.deriveVirtualAccount(accountId);

  assert.equal(createVerifyScript(coreHash, accountId), expectedScript);
  assert.equal(account.verifyScript, expectedScript);
  assert.equal(account.scriptHash, expectedScriptHash);
  assert.equal(account.address, expectedAddress);
  assert.equal(getAddressFromScriptHash(expectedScriptHash), expectedAddress);
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
