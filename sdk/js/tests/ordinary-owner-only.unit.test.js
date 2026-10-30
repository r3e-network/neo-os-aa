const test = require('node:test');
const assert = require('node:assert/strict');
const { SmartAccountClient } = require('../src/index');
const stateFixture = require('./fixtures/ordinary-owner-only-contract-state.json');

const CORE = '11'.repeat(20);
const ACCOUNT = '22'.repeat(20);
function fixture() { return structuredClone(stateFixture); }
function clientWithState(state = fixture(), result = { state: 'HALT', stack: [{ type: 'Boolean', value: false }] }) {
  const calls = [];
  const client = new SmartAccountClient('http://127.0.0.1:9', CORE);
  client.rpcClient = {
    async send(method, params) {
      calls.push({ method, params });
      assert.equal(method, 'getcontractstate');
      assert.deepEqual(params, ['0x' + CORE]);
      return state;
    },
    async invokeFunction(hash, operation, args, signers) {
      calls.push({ hash, operation, args, signers });
      assert.equal(hash, CORE);
      assert.equal(operation, 'isOwnerOnlyRecovery');
      assert.deepEqual(args, [{ type: 'Hash160', value: ACCOUNT }]);
      assert.deepEqual(signers, []);
      return result;
    },
  };
  return { client, calls };
}

test('ordinary owner-only payload is a direct core call with one account-id Hash160', () => {
  const client = new SmartAccountClient('http://127.0.0.1:9', CORE);
  const payload = client.createFinalizeEscapeToOwnerPayload({ accountScriptHash: '0x' + ACCOUNT });
  assert.equal(payload.scriptHash, CORE);
  assert.equal(payload.operation, 'finalizeEscapeToOwner');
  assert.deepEqual(payload.args.map((arg) => arg.toJSON()), [{ type: 'Hash160', value: ACCOUNT }]);
  assert.throws(() => client.createFinalizeEscapeToOwnerPayload({}), /account/i);
  assert.throws(() => client.createFinalizeEscapeToOwnerPayload({ accountScriptHash: '1234' }), /Hash160/);
  assert.throws(() => client.createFinalizeEscapeToOwnerPayload({ accountScriptHash: ACCOUNT, accountAddress: ACCOUNT }), (error) => error.code === 'SDK_007' && /exactly one/i.test(error.details.hint));
  assert.throws(() => client.createFinalizeEscapeToOwnerPayload({ accountScriptHash: '00'.repeat(20) }), (error) => error.code === 'SDK_007' && /nonzero/i.test(error.details.hint));
});

test('mode query distinguishes verified ordinary support false and true', async () => {
  for (const value of [false, true]) {
    const { client, calls } = clientWithState(fixture(), { state: 'HALT', stack: [{ type: 'Boolean', value }] });
    assert.deepEqual(await client.getOwnerOnlyRecoveryStatus(ACCOUNT), { supported: true, ownerOnlyRecovery: value });
    assert.equal(calls[0].method, 'getcontractstate');
    assert.equal(calls.length, 2);
  }
});

test('old and incompatible ABIs are explicitly unsupported and never invoke the new query', async () => {
  const cases = [
    (s) => { s.manifest.abi.methods = []; },
    (s) => { s.manifest.abi.methods.pop(); },
    (s) => { s.manifest.abi.methods[0].parameters.push({ name: 'replacement', type: 'Hash160' }); },
    (s) => { s.manifest.abi.methods[0].parameters[0].type = 'ByteArray'; },
    (s) => { s.manifest.abi.methods[0].safe = !s.manifest.abi.methods[0].safe; },
    (s) => { s.manifest.abi.methods[0].returntype = 'String'; },
    (s) => { s.manifest.abi.methods[0].name += 'Legacy'; },
    (s) => { s.manifest.abi.methods.push(structuredClone(s.manifest.abi.methods[0])); },
  ];
  for (const change of cases) {
    const state = fixture(); change(state);
    const { client, calls } = clientWithState(state);
    assert.deepEqual(await client.getOwnerOnlyRecoveryStatus(ACCOUNT), { supported: false, ownerOnlyRecovery: null });
    assert.equal(calls.length, 1);
  }
});

test('malformed contract state and wrong core identity cannot become unsupported or false', async () => {
  const cases = [null, {}, { state: 'FAULT', exception: 'manifest lookup fault' }];
  for (const change of [
    (s) => { delete s.hash; },
    (s) => { s.hash = '0x' + ACCOUNT; },
    (s) => { delete s.manifest.abi; },
    (s) => { s.manifest.abi.methods = {}; },
    (s) => { s.manifest.abi.methods[0].safe = 'true'; },
    (s) => { delete s.manifest.abi.methods[0].offset; },
    (s) => { s.manifest.abi.methods[0].offset = -1; },
    (s) => { s.manifest.abi.methods[0].offset = '7142'; },
    (s) => { s.manifest.abi.methods[0].parameters = null; },
    (s) => { s.manifest.abi.methods[0].parameters[0].type = 160; },
  ]) { const state = fixture(); change(state); cases.push(state); }
  for (const state of cases) {
    const { client, calls } = clientWithState(state);
    await assert.rejects(() => client.getOwnerOnlyRecoveryStatus(ACCOUNT));
    assert.equal(calls.length, 1);
  }
});

test('RPC faults and malformed Boolean mode values fail closed', async () => {
  for (const result of [
    { state: 'FAULT', exception: 'Account not found', stack: [] },
    { state: 'HALT', stack: [{ type: 'Boolean', value: 'false' }] },
    { state: 'HALT', stack: [{ type: 'Boolean', value: 0 }] },
    { state: 'HALT', stack: [{ type: 'Integer', value: '0' }] },
    { state: 'HALT', stack: [] },
    { state: 'HALT', stack: [{ type: 'Boolean', value: false }, { type: 'Boolean', value: false }] },
    { state: 'BREAK', stack: [{ type: 'Boolean', value: false }] },
    { stack: [{ type: 'Boolean', value: false }] },
  ]) {
    const { client } = clientWithState(fixture(), result);
    await assert.rejects(() => client.getOwnerOnlyRecoveryStatus(ACCOUNT));
  }
  const { client } = clientWithState();
  client.rpcClient.send = async () => { throw new Error('permission denied'); };
  await assert.rejects(() => client.getOwnerOnlyRecoveryStatus(ACCOUNT), /permission denied/);
});


test('ordinary status query consumes actual JSON-RPC contract-state and Boolean wire responses', async (t) => {
  const { createServer } = require('node:http');
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const message = JSON.parse(raw);
    requests.push(message);
    const result = message.method === 'getcontractstate' ? fixture()
      : { state: 'HALT', stack: [{ type: 'Boolean', value: true }] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new SmartAccountClient(`http://127.0.0.1:${server.address().port}`, CORE);
  assert.deepEqual(await client.getOwnerOnlyRecoveryStatus(ACCOUNT), { supported: true, ownerOnlyRecovery: true });
  assert.deepEqual(requests.map(({ method }) => method), ['getcontractstate', 'invokefunction']);
  assert.deepEqual(requests[0].params, ['0x' + CORE]);
  assert.deepEqual(requests[1].params, ['0x' + CORE, 'isOwnerOnlyRecovery', [{ type: 'Hash160', value: ACCOUNT }], []]);
});
