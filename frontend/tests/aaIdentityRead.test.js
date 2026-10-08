import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createAccountIdentityReader } from '../src/services/aaIdentityReadService.js';
import { EC } from '../src/config/errorCodes.js';

const core = '12131415161718191a1b1c1d1e1f202122232425';
const account = '0102030405060708090a0b0c0d0e0f1011121314';
const proxy = '2122232425262728292a2b2c2d2e2f3031323334';
const verifier = '4142434445464748494a4b4c4d4e4f5051525354';
const config = { rpcUrl: 'http://127.0.0.1:10332', aaContractHash: core };
const uint160 = (hex) => ({ state: 'HALT', stack: [{ type: 'ByteString', value: Buffer.from(hex, 'hex').reverse().toString('base64') }] });

function reader(responses) {
  const calls = [];
  const read = createAccountIdentityReader(async (...args) => {
    calls.push(args);
    const response = responses[args[2]];
    if (!response) throw new Error(`Unexpected ABI call: ${args[2]}`);
    return response;
  });
  return { read, calls };
}

test('proxy resolution uses existing ABI and preserves UInt160 byte order', async () => {
  const { read, calls } = reader({ getAccountIdByProxy: uint160(account), getProxyScriptHash: uint160(proxy), getVerifier: uint160(verifier) });
  assert.deepEqual(await read({ ...config, accountAddressScriptHash: `0x${proxy}` }), { accountIdHex: account, verifierHash: verifier });
  assert.deepEqual(calls.map((call) => call.slice(1)), [
    [core, 'getAccountIdByProxy', [{ type: 'Hash160', value: `0x${proxy}` }]],
    [core, 'getProxyScriptHash', [{ type: 'Hash160', value: `0x${account}` }]],
    [core, 'getVerifier', [{ type: 'Hash160', value: `0x${account}` }]],
  ]);
});

test('explicit legacy account ID works without a reverse index', async () => {
  const { read, calls } = reader({ getVerifier: uint160(verifier) });
  assert.deepEqual(await read({ ...config, accountIdHex: `0x${account}` }), { accountIdHex: account, verifierHash: verifier });
  assert.deepEqual(calls.map((call) => call[2]), ['getVerifier']);
});

test('zero reverse lookup does not guess that proxy hash is the account ID', async () => {
  const { read, calls } = reader({ getAccountIdByProxy: uint160('00'.repeat(20)) });
  await assert.rejects(read({ ...config, accountAddressScriptHash: proxy }), { message: EC.accountSeedOrHashRequired });
  assert.equal(calls.length, 1);
});

test('explicit account and requested proxy must agree before reading verifier', async () => {
  const { read, calls } = reader({ getProxyScriptHash: uint160('99'.repeat(20)) });
  await assert.rejects(read({ ...config, accountIdHex: account, accountAddressScriptHash: proxy }), { message: EC.addressValidationFailed });
  assert.deepEqual(calls.map((call) => call[2]), ['getProxyScriptHash']);
});

test('zero verifier is a valid backup-owner account without a plugin', async () => {
  const { read } = reader({ getVerifier: uint160('00'.repeat(20)) });
  assert.deepEqual(await read({ ...config, accountIdHex: account }), { accountIdHex: account, verifierHash: '' });
});

test('unconfigured or malformed identity context is refused before RPC', async () => {
  const { read, calls } = reader({});
  for (const options of [
    {}, { ...config }, { ...config, accountIdHex: '00'.repeat(20) },
    { ...config, accountIdHex: 'zz'.repeat(20) },
    { ...config, accountIdHex: account, rpcUrl: '' },
    { ...config, accountIdHex: account, aaContractHash: '' },
    { ...config, accountIdHex: account, aaContractHash: '00'.repeat(20) },
    { ...config, accountIdHex: account, accountAddressScriptHash: 'not-a-hash' },
  ]) await assert.rejects(read(options));
  assert.equal(calls.length, 0);
});

test('faults and malformed UInt160 results cannot become an account context', async () => {
  for (const response of [
    { state: 'FAULT', exception: 'method missing', stack: [] },
    { state: 'HALT', stack: [] },
    { state: 'HALT', stack: [{ type: 'Integer', value: '123' }] },
    { state: 'HALT', stack: [{ type: 'ByteString', value: Buffer.alloc(19).toString('base64') }] },
    { state: 'HALT', stack: [{ type: 'ByteString', value: '!'.repeat(28) }] },
    { stack: uint160(account).stack },
  ]) {
    const { read } = reader({ getVerifier: response });
    await assert.rejects(read({ ...config, accountIdHex: account }));
  }
});

test('identity resolver names and signatures match the checked-in core ABI', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../../contracts/build/UnifiedSmartWalletV3.manifest.json', import.meta.url)));
  for (const name of ['getAccountIdByProxy', 'getProxyScriptHash', 'getVerifier']) {
    const method = manifest.abi.methods.find((entry) => entry.name === name);
    assert.ok(method, `${name} exists`);
    assert.equal(method.safe, true);
    assert.equal(method.returntype, 'Hash160');
    assert.deepEqual(method.parameters.map((entry) => entry.type), ['Hash160']);
  }
});
