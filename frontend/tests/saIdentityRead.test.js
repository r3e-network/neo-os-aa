import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAccountIdentityReader } from '../src/services/saIdentityReadService.js';
import { EC } from '../src/config/errorCodes.js';

const core = '12131415161718191a1b1c1d1e1f202122232425';
const account = '0102030405060708090a0b0c0d0e0f1011121314';
const proxy = '2122232425262728292a2b2c2d2e2f3031323334';
const custody = '3132333435363738393a3b3c3d3e3f4041424344';
const verifier = '4142434445464748494a4b4c4d4e4f5051525354';
const recoveryAuthority = '7172737475767778797a7b7c7d7e7f8081828384';
const config = { rpcUrl: 'http://127.0.0.1:10332', saContractHash: core };

const int = (value) => ({ type: 'Integer', value: String(value) });
const bool = (value) => ({ type: 'Boolean', value: Boolean(value) });
// Neo RPC encodes UInt160 (and every fixed-width hash) as little-endian bytes.
const uint160 = (hex) => ({
  type: 'ByteString',
  value: Buffer.from(hex, 'hex').reverse().toString('base64'),
});
const digest = (hex) => ({ type: 'ByteString', value: Buffer.from(hex, 'hex').toString('base64') });

// getAccount -> [exists, status, custody, recoveryAuthority, authorityEpoch,
// configurationNonce, recoveryTimelockMs, defaultOperationAuthorization,
// defaultMessageAuthorization, ownerOnlyRecovery, hookOrderRevision,
// controlRevision, recoveryPending, recoveryMatureAt, marketEscrowActive,
// legacyRow]
function accountDescriptor({ exists = true, status = 0 } = {}) {
  return {
    type: 'Array',
    value: [
      bool(exists), int(status), uint160(custody), uint160(recoveryAuthority),
      int(0), int(4), int(604_800_000), bool(true), bool(true), bool(false),
      int(2), int(9), bool(false), int(0), bool(false), bool(false),
    ],
  };
}

// getModules -> [ids[], nextCursor, configurationNonce]
function modulePage(ids = []) {
  return { type: 'Array', value: [{ type: 'Array', value: ids.map(int) }, int(0), int(4)] };
}

// getModule -> the 12-field instance descriptor
function moduleDescriptor({ moduleId = 1, moduleType = 1, contractHash = verifier } = {}) {
  return {
    type: 'Array',
    value: [
      int(moduleId), int(moduleType), uint160(contractHash), int(7), int(1),
      digest('aa'.repeat(32)), digest('bb'.repeat(32)), int(3), int(5),
      bool(true), bool(true), bool(true),
    ],
  };
}

function reader(responses) {
  const calls = [];
  const read = createAccountIdentityReader(async (...args) => {
    calls.push(args);
    const response = responses[args[2]];
    if (!response) throw new Error(`Unexpected ABI call: ${args[2]}`);
    return { state: 'HALT', stack: [response] };
  });
  return { read, calls };
}

test('proxy resolution reads the v4 account and validator module, preserving UInt160 byte order', async () => {
  const { read, calls } = reader({
    getAccountIdByProxy: uint160(account),
    getProxyScriptHash: uint160(proxy),
    getAccount: accountDescriptor(),
    getModules: modulePage([1]),
    getModule: moduleDescriptor(),
  });
  assert.deepEqual(await read({ ...config, accountAddressScriptHash: `0x${proxy}` }), {
    accountIdHex: account,
    validatorHash: verifier,
    custody,
    status: 'active',
    authorityEpoch: '0',
    configurationNonce: '4',
  });
  assert.deepEqual(calls.map((call) => call.slice(1)), [
    [core, 'getAccountIdByProxy', [{ type: 'Hash160', value: `0x${proxy}` }]],
    [core, 'getProxyScriptHash', [{ type: 'Hash160', value: `0x${account}` }]],
    [core, 'getAccount', [{ type: 'Hash160', value: `0x${account}` }]],
    [core, 'getModules', [
      { type: 'Hash160', value: `0x${account}` },
      { type: 'String', value: 'validator' },
      { type: 'Integer', value: '0' },
      { type: 'Integer', value: '1' },
    ]],
    [core, 'getModule', [
      { type: 'Hash160', value: `0x${account}` },
      { type: 'Integer', value: '1' },
    ]],
  ]);
});

test('an explicit account id skips the reverse index and still proves existence', async () => {
  const { read, calls } = reader({
    getAccount: accountDescriptor(),
    getModules: modulePage([1]),
    getModule: moduleDescriptor(),
  });
  assert.deepEqual(await read({ ...config, accountIdHex: `0x${account}` }), {
    accountIdHex: account,
    validatorHash: verifier,
    custody,
    status: 'active',
    authorityEpoch: '0',
    configurationNonce: '4',
  });
  assert.deepEqual(calls.map((call) => call[2]), ['getAccount', 'getModules', 'getModule']);
});

test('zero reverse lookup does not guess that proxy hash is the account ID', async () => {
  const { read, calls } = reader({ getAccountIdByProxy: uint160('00'.repeat(20)) });
  await assert.rejects(read({ ...config, accountAddressScriptHash: proxy }), { message: EC.accountSeedOrHashRequired });
  assert.equal(calls.length, 1);
});

test('explicit account and requested proxy must agree before reading the account', async () => {
  const { read, calls } = reader({ getProxyScriptHash: uint160('99'.repeat(20)) });
  await assert.rejects(read({ ...config, accountIdHex: account, accountAddressScriptHash: proxy }), { message: EC.addressValidationFailed });
  assert.deepEqual(calls.map((call) => call[2]), ['getProxyScriptHash']);
});

test('an account with no validator instance resolves with no validator hash', async () => {
  const { read, calls } = reader({
    getAccount: accountDescriptor(),
    getModules: modulePage([]),
  });
  assert.deepEqual(await read({ ...config, accountIdHex: account }), {
    accountIdHex: account,
    validatorHash: '',
    custody,
    status: 'active',
    authorityEpoch: '0',
    configurationNonce: '4',
  });
  assert.deepEqual(calls.map((call) => call[2]), ['getAccount', 'getModules']);
});

test('a frozen account reports its v4 status instead of a boolean', async () => {
  const { read } = reader({
    getAccount: accountDescriptor({ status: 1 }),
    getModules: modulePage([]),
  });
  const identity = await read({ ...config, accountIdHex: account });
  assert.equal(identity.status, 'frozen');
});

test('an absent descriptor cannot become an identity', async () => {
  for (const getAccount of [
    accountDescriptor({ exists: false }),
    { type: 'Array', value: [] },
  ]) {
    const { read } = reader({ getAccount, getModules: modulePage([]) });
    await assert.rejects(read({ ...config, accountIdHex: account }), { message: EC.accountNotRegistered });
  }
});

test('unconfigured or malformed identity context is refused before RPC', async () => {
  const { read, calls } = reader({});
  for (const options of [
    {}, { ...config }, { ...config, accountIdHex: '00'.repeat(20) },
    { ...config, accountIdHex: 'zz'.repeat(20) },
    { ...config, accountIdHex: account, rpcUrl: '' },
    { ...config, accountIdHex: account, saContractHash: '' },
    { ...config, accountIdHex: account, saContractHash: '00'.repeat(20) },
    { ...config, accountIdHex: account, accountAddressScriptHash: 'not-a-hash' },
  ]) await assert.rejects(read(options));
  assert.equal(calls.length, 0);
});

test('faults and malformed descriptors cannot become an account context', async () => {
  const malformed = [
    { state: 'FAULT', exception: 'method missing', stack: [] },
    { state: 'HALT', stack: [] },
    { state: 'HALT', stack: [{ type: 'Integer', value: '123' }] },
    { state: 'HALT', stack: [{ type: 'Array', value: new Array(15).fill(int(0)) }] },
    { state: 'HALT', stack: [accountDescriptor()], extra: 'not-a-stack' },
  ];
  for (const response of malformed) {
    const read = createAccountIdentityReader(async () => response);
    await assert.rejects(read({ ...config, accountIdHex: account }), 'a malformed response became an identity');
  }
  // A well-formed descriptor passes the same reader, so the loop above is not
  // rejecting every response.
  const { read } = reader({ getAccount: accountDescriptor(), getModules: modulePage([]) });
  assert.equal((await read({ ...config, accountIdHex: account })).accountIdHex, account);
});

test('identity resolver names and signatures match the built v4 core ABI', () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../../contracts/bin/public/SmartAccount.manifest.json', import.meta.url)),
  );
  const methods = new Map(manifest.abi.methods.map((entry) => [entry.name, entry]));
  const expected = {
    getAccountIdByProxy: { returntype: 'Hash160', parameters: ['Hash160'] },
    getProxyScriptHash: { returntype: 'Hash160', parameters: ['Hash160'] },
    getAccount: { returntype: 'Array', parameters: ['Hash160'] },
    getModules: { returntype: 'Array', parameters: ['Hash160', 'String', 'Integer', 'Integer'] },
    getModule: { returntype: 'Array', parameters: ['Hash160', 'Integer'] },
  };
  for (const [name, shape] of Object.entries(expected)) {
    const method = methods.get(name);
    assert.ok(method, `${name} exists in the v4 ABI`);
    assert.equal(method.safe, true);
    assert.equal(method.returntype, shape.returntype);
    assert.deepEqual(method.parameters.map((entry) => entry.type), shape.parameters);
  }
  // The single-verifier and escape-era reads this reader used to call are gone.
  for (const retired of ['getVerifier', 'getHook', 'getBackupOwner', 'getEscapeTimelock']) {
    assert.equal(methods.has(retired), false, `${retired} must not exist in the v4 ABI`);
  }
});
