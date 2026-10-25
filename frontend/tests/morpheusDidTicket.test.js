import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

import { EC } from '../src/config/errorCodes.js';
import { buildAaActionId, requireAaSigningText, toNeoInternalHex } from '../src/services/aaTicketService.js';

const core = '000102030405060708090a0b0c0d0e0f10111213';
const account = '1415161718191a1b1c1d1e1f2021222324252627';
const verifier = '28292a2b2c2d2e2f303132333435363738393a3b';
const accountAddress = '3c3d3e3f404142434445464748494a4b4c4d4e4f';
const newOwner = '505152535455565758595a5b5c5d5e5f60616263';
const executor = '6465666768696a6b6c6d6e6f7071727374757677';
const zero = '00'.repeat(20);

function createService({ invokeReadFunction = async () => { throw new Error('unexpected RPC'); } } = {}) {
  const requests = [];
  const signerCalls = [];
  let defaultCoreReads = 0;
  const sanitizeHex = (value) => String(value || '').trim().replace(/^0x/i, '').toLowerCase();
  const decodeStackHash160 = (item) => {
    if (!item || typeof item !== 'object') return '';
    if (item.type === 'Hash160') return sanitizeHex(item.value);
    if (item.type !== 'ByteString') return '';
    return Buffer.from(item.value || '', 'base64').reverse().toString('hex');
  };
  const fetchWithTimeout = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).startsWith('https://oracle-key.test/')) {
      return { ok: true, json: async () => ({ public_key: 'oracle-public-key' }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const bindings = {
    RUNTIME_CONFIG: {
      morpheusOracleKeyEndpoint: 'https://oracle-key.test/',
      morpheusNeoDidEndpoint: 'https://neodid.test/',
      morpheusNetwork: 'neo_n3',
      morpheusNeoDidServiceDid: 'did:neo:test',
    },
    EC,
    notificationService: {},
    invokeReadFunction,
    getScriptHashFromAddress: () => { throw new Error('not an address'); },
    sanitizeHex,
    fetchWithTimeout,
    encryptJsonWithMorpheusOracleKey: async () => 'encrypted-params',
    walletService: { invoke: async (...args) => { signerCalls.push(args); return {}; } },
    getAbstractAccountHash: () => { defaultCoreReads += 1; return core; },
    buildZkLoginVerifierParamsHex: () => '',
    formatZkLoginTicket: (value) => value,
    normalizeZkLoginProvider: (value) => value,
    connectedDidProfile: { value: { provider: 'web3auth', idToken: 'id-token' } },
    decodeStackHash160,
    createAccountIdentityReader: () => async () => { throw new Error('not used'); },
    buildAaActionId,
    requireAaSigningText,
    toNeoInternalHex,
  };
  const source = fs.readFileSync(new URL('../src/services/morpheusDidService.js', import.meta.url), 'utf8')
    .replace(/^import\s+[\s\S]*?\s+from\s+["'][^"']+["'];\s*$/gm, '')
    .replaceAll('import.meta.env.DEV', 'false')
    .replaceAll('export async function ', 'async function ')
    .replaceAll('export function ', 'function ')
    .replaceAll('export const ', 'const ');
  const setup = new Function(...Object.keys(bindings), `${source}\nreturn { morpheusDidService, fetchUnifiedVerifierState };`);
  const exports = setup(...Object.values(bindings));
  return {
    ...exports,
    requests,
    signerCalls,
    defaultCoreReads: () => defaultCoreReads,
  };
}

function recoveryInput() {
  return {
    network: 'neo3-testnet',
    aaContract: `0x${core}`,
    verifierContract: verifier,
    accountIdText: 'shared-account-text',
    accountIdRaw: account,
    accountAddress,
    newOwner,
    recoveryNonce: '0',
    expiresAt: 1_800_000_000_000,
  };
}

function actionInput() {
  return {
    network: 'neo3-testnet',
    aaContract: core,
    verifierContract: verifier,
    accountIdText: 'shared-account-text',
    accountIdRaw: account,
    executor,
    sessionNonce: '0',
    expiresAt: 1_800_000_000_000,
  };
}

function didRequest(harness) {
  assert.equal(harness.requests.length, 2);
  const request = harness.requests[1];
  assert.equal(request.url, 'https://neodid.test/');
  return JSON.parse(request.options.body);
}

test('recovery preview uses only the raw account and converts display Hash160 fields to internal byte order', async () => {
  const harness = createService();
  await harness.morpheusDidService.previewRecoveryTicket({ ...recoveryInput(), accountId: newOwner });
  const body = didRequest(harness);
  assert.equal(body.action, 'recovery-ticket');
  assert.equal(body.account_id, 'shared-account-text');
  assert.equal(body.account_id_raw, toNeoInternalHex(account));
  assert.equal(body.aa_contract, toNeoInternalHex(core));
  assert.equal(body.verifier_contract, toNeoInternalHex(verifier));
  assert.equal(body.account_address, toNeoInternalHex(accountAddress));
  assert.equal(body.new_owner, toNeoInternalHex(newOwner));
  assert.equal(body.callback_encoding, 'neo_n3_recovery_v3');
  assert.equal(harness.signerCalls.length, 0);
  assert.equal(harness.defaultCoreReads(), 0);
});

test('action preview forwards explicit text and internal Hash160 fields', async () => {
  const harness = createService();
  await harness.morpheusDidService.previewActionTicket(actionInput());
  const body = didRequest(harness);
  assert.equal(body.action, 'action-ticket');
  assert.equal(body.account_id, 'shared-account-text');
  assert.equal(body.account_id_raw, toNeoInternalHex(account));
  assert.equal(body.aa_contract, toNeoInternalHex(core));
  assert.equal(body.verifier_contract, toNeoInternalHex(verifier));
  assert.equal(body.disposable_account, toNeoInternalHex(executor));
  assert.match(body.action_id, /^aa_proxy:[0-9a-f]{64}$/);
  assert.equal(harness.signerCalls.length, 0);
  assert.equal(harness.defaultCoreReads(), 0);
});

test('recovery preview marks opaque network labels with the host recovery v3 encoding', async () => {
  for (const network of ['neo3-testnet', 'neo3-local']) {
    const harness = createService();
    await harness.morpheusDidService.previewRecoveryTicket({ ...recoveryInput(), network });
    const body = didRequest(harness);
    assert.equal(body.network, network);
    assert.equal(body.callback_encoding, 'neo_n3_recovery_v3');
  }
});

test('recovery and action previews reject a display accountId without raw account before external calls', async () => {
  const cases = [
    ['previewRecoveryTicket', recoveryInput()],
    ['previewActionTicket', actionInput()],
  ];
  for (const [method, base] of cases) {
    const harness = createService();
    const input = { ...base, accountId: account };
    delete input.accountIdRaw;
    await assert.rejects(
      harness.morpheusDidService[method](input),
      /accountIdRaw must be a non-zero 20-byte Hash160/
    );
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.signerCalls.length, 0);
    assert.equal(harness.defaultCoreReads(), 0);
  }
});

test('recovery and action previews reject every missing required field before Oracle, NeoDID, or signer calls', async () => {
  const cases = [
    ['previewRecoveryTicket', recoveryInput(), ['network', 'accountIdText', 'accountIdRaw', 'aaContract', 'verifierContract', 'newOwner', 'accountAddress']],
    ['previewActionTicket', actionInput(), ['network', 'accountIdText', 'accountIdRaw', 'aaContract', 'verifierContract', 'executor']],
  ];
  for (const [method, base, fields] of cases) {
    const harness = createService();
    for (const field of fields) {
      const input = { ...base };
      delete input[field];
      await assert.rejects(harness.morpheusDidService[method](input), new RegExp(field));
    }
    const rawOnly = { ...base, accountId: account, accountIdText: undefined };
    await assert.rejects(harness.morpheusDidService[method](rawOnly), /accountIdText is required/);
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.signerCalls.length, 0);
    assert.equal(harness.defaultCoreReads(), 0);
  }
});

test('recovery and action previews reject zero Hash160 fields before any external call', async () => {
  const cases = [
    ['previewRecoveryTicket', recoveryInput(), ['accountIdRaw', 'aaContract', 'verifierContract', 'newOwner', 'accountAddress']],
    ['previewActionTicket', actionInput(), ['accountIdRaw', 'aaContract', 'verifierContract', 'executor']],
  ];
  for (const [method, base, fields] of cases) {
    const harness = createService();
    for (const field of fields) {
      await assert.rejects(harness.morpheusDidService[method]({ ...base, [field]: `0x${zero}` }), /non-zero 20-byte Hash160/);
    }
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.signerCalls.length, 0);
  }
});

const byteString = (value) => ({ state: 'HALT', stack: [{ type: 'ByteString', value: Buffer.from(value).toString('base64') }] });
const hash160 = (hex) => ({ state: 'HALT', stack: [{ type: 'ByteString', value: Buffer.from(hex, 'hex').reverse().toString('base64') }] });
const integer = (value = '0') => ({ state: 'HALT', stack: [{ type: 'Integer', value }] });
const array = () => ({ state: 'HALT', stack: [{ type: 'Array', value: [] }] });

function stateRpc(calls, { network, accountIdText, faults = [] }) {
  return async (...args) => {
    calls.push(args);
    const operation = args[2];
    if (faults.includes(operation)) throw new Error(`${operation} unavailable`);
    if (operation === 'getNetwork') return byteString(network);
    if (operation === 'getAccountIdText') return byteString(accountIdText);
    if (operation === 'getAAContract') return hash160(core);
    if (operation === 'getAccountAddress') return hash160(accountAddress);
    if (operation === 'getOwner' || operation === 'getMorpheusOracle') return hash160(verifier);
    if (operation === 'getPendingRecovery' || operation === 'getActiveSession') return array();
    return integer();
  };
}

for (const size of [20, 32]) {
  test(`${size}-byte UTF-8 account text and network remain text and keep Hash160 RPC parameters`, async () => {
    const calls = [];
    const network = 'n'.repeat(size);
    const accountIdText = 'a'.repeat(size);
    const harness = createService({ invokeReadFunction: stateRpc(calls, { network, accountIdText }) });
    const state = await harness.fetchUnifiedVerifierState({ rpcUrl: 'http://rpc.test', verifierHash: verifier, accountIdHex: account });
    assert.equal(state.network, network);
    assert.equal(state.accountIdText, accountIdText);
    assert.equal(state.aaContract, core);
    assert.equal(state.accountAddress, accountAddress);
    assert.ok(!state.accountIdText.startsWith('0x'));
    assert.equal(calls.length, 12);
    for (const call of calls) {
      assert.deepEqual(call[3], [{ type: 'Hash160', value: `0x${account}` }]);
    }
  });
}

test('failed network, core, and account-text reads fail closed instead of fabricating preview context', async () => {
  for (const fault of ['getNetwork', 'getAAContract', 'getAccountIdText']) {
    const calls = [];
    const harness = createService({
      invokeReadFunction: stateRpc(calls, { network: 'neo3-testnet', accountIdText: 'real-text', faults: [fault] }),
    });
    const state = await harness.fetchUnifiedVerifierState({ rpcUrl: 'http://rpc.test', verifierHash: verifier, accountIdHex: account });
    const field = fault === 'getNetwork' ? 'network' : fault === 'getAAContract' ? 'aaContract' : 'accountIdText';
    assert.equal(state[field], '');
    assert.notEqual(state[field], fault === 'getNetwork' ? 'neo_n3' : fault === 'getAAContract' ? core : account);
    const input = { ...recoveryInput(), [field]: state[field] };
    await assert.rejects(harness.morpheusDidService.previewRecoveryTicket(input));
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.signerCalls.length, 0);
    assert.equal(harness.defaultCoreReads(), 0);
  }
});

function rawPreviewActionId(input) {
  const fields = [
    Buffer.from(input.network, 'utf8'),
    ...[input.aaContract, input.accountIdRaw, input.executor].map((value) => Buffer.from(value.replace(/^0x/i, ''), 'hex').reverse()),
    Buffer.from(String(input.sessionNonce ?? '0')),
    Buffer.from(String(input.expiresAt)),
  ];
  const material = Buffer.concat(fields.flatMap((field, index) => index ? [Buffer.from([0x1f]), field] : [field]));
  return `aa_proxy:${createHash('sha256').update(material).digest('hex')}`;
}

test('F3 preview witnesses preserve opaque stored network and accountIdText in both ticket types', async () => {
  for (const [method, inputFactory] of [['previewRecoveryTicket', recoveryInput], ['previewActionTicket', actionInput]]) {
    for (const [field, value] of [['network', ' neo3-testnet '], ['accountIdText', ' shared-account-text ']]) {
      const harness = createService();
      const input = { ...inputFactory(), [field]: value };
      await harness.morpheusDidService[method](input);
      const body = didRequest(harness);
      assert.equal(body.network, input.network);
      assert.equal(body.account_id, input.accountIdText);
      if (method === 'previewActionTicket') assert.equal(body.action_id, rawPreviewActionId(input));
      assert.equal(harness.signerCalls.length, 0);
      assert.equal(harness.defaultCoreReads(), 0);
    }
  }
});

test('F3 previews preserve bounded UTF-8 text without Unicode or whitespace normalization', async () => {
  const values = ['n', 'n'.repeat(255), ` ${'n'.repeat(253)} `, '界'.repeat(85), `${'😀'.repeat(63)}abc`, '\tneo3-testnet\n', ' é ', ' e\u0301 '];
  for (const [method, inputFactory] of [['previewRecoveryTicket', recoveryInput], ['previewActionTicket', actionInput]]) {
    for (const text of values) {
      assert.ok(Buffer.byteLength(text) <= 255);
      const harness = createService();
      const input = { ...inputFactory(), network: text, accountIdText: text };
      await harness.morpheusDidService[method](input);
      const body = didRequest(harness);
      assert.equal(Buffer.from(body.network).toString('hex'), Buffer.from(text).toString('hex'));
      assert.equal(Buffer.from(body.account_id).toString('hex'), Buffer.from(text).toString('hex'));
      if (method === 'previewActionTicket') assert.equal(body.action_id, rawPreviewActionId(input));
      assert.equal(harness.signerCalls.length, 0);
    }
  }
});

test('F3 previews reject invalid signing text before Oracle NeoDID or signer calls', async () => {
  const invalid = [undefined, null, '', ' ', '\t\n', false, 7, {}, [], 'n'.repeat(256), ` ${'n'.repeat(254)} `, '界'.repeat(86), '😀'.repeat(64)];
  for (const [method, inputFactory] of [['previewRecoveryTicket', recoveryInput], ['previewActionTicket', actionInput]]) {
    for (const field of ['network', 'accountIdText']) {
      for (const value of invalid) {
        const harness = createService();
        await assert.rejects(harness.morpheusDidService[method]({ ...inputFactory(), [field]: value }), new RegExp(`${field} (is required|must be at most 255 UTF-8 bytes)`));
        assert.equal(harness.requests.length, 0);
        assert.equal(harness.signerCalls.length, 0);
        assert.equal(harness.defaultCoreReads(), 0);
      }
    }
  }
});

test('F3 generic UI format retains whitespace trimming outside signing context', async () => {
  for (const [format, expected] of [[' json ', 'json'], ['\tjson\n', 'json'], ['   ', null]]) {
    const harness = createService();
    await harness.morpheusDidService.resolveDid({ format });
    assert.equal(harness.requests.length, 1);
    assert.equal(new URL(harness.requests[0].url).searchParams.get('format'), expected);
    assert.equal(harness.signerCalls.length, 0);
    assert.equal(harness.defaultCoreReads(), 0);
  }
});
