const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet, TypedDataEncoder } = require('ethers');
const { createMultiSigClient, serializeMultiSigSignatures } = require('../src/multisig');

const H = (byte) => byte.repeat(40);
const core = H('1'), account = H('2'), parent = H('3'), childA = H('4'), childB = H('5'), target = H('6');
const hashItem = (hash) => ({ type: 'ByteString', value: Buffer.from(hash, 'hex').reverse().toString('base64') });
const bytesItem = (hash) => ({ type: 'ByteString', value: Buffer.from(hash, 'hex').toString('base64') });
const halt = (item) => ({ state: 'HALT', stack: [item] });
function fixture() {
  const state = { verifiers: [childA, childB], threshold: 2, network: 894710606, nonce: '7', argsHash: 'ab'.repeat(32), valid: true, bound: parent, authorizedCore: core };
  const rpcClient = {
    getVersion: async () => ({ protocol: { network: state.network } }),
    invokeFunction: async (contract, method) => {
      if (method === 'getVerifier') return halt(hashItem(state.bound));
      if (method === 'authorizedCore') return halt(hashItem(state.authorizedCore));
      if (method === 'getConfig') return halt({ type: 'Struct', value: [{ type: 'Array', value: state.verifiers.map(hashItem) }, { type: 'Integer', value: String(state.threshold) }] });
      if (method === 'getNonce') return halt({ type: 'Integer', value: state.nonce });
      if (method === 'computeArgsHash') return halt(bytesItem(state.argsHash));
      if (method === 'validateSignature') return halt({ type: 'Boolean', value: state.valid });
      throw new Error(`unexpected ${contract}.${method}`);
    },
  };
  rpcClient.send = async (method, params) => {
    assert.equal(method, 'invokefunction');
    return rpcClient.invokeFunction(params[0].replace(/^0x/, ''), params[1], params[2]);
  };
  return { state, client: createMultiSigClient({ rpcClient }), rpcClient };
}
async function prepared() {
  const f = fixture();
  f.context = await f.client.fetchContext({ coreContractHash: core, accountIdHash: account });
  f.operation = await f.client.prepareOperation({ context: f.context, operation: { targetContract: target, method: 'transfer', args: [{ type: 'Integer', value: '1' }], deadline: '2000000000000' } });
  f.proofs = [childB, childA].map((childVerifierHash, index) => ({ childVerifierHash, kind: 'opaque', signatureHex: index ? 'aabb' : 'ccdd', operation: f.operation }));
  return f;
}

test('StdLib byte vectors preserve ordered ByteString and null slots, including varint boundary', () => {
  assert.equal(serializeMultiSigSignatures(['aabb', null, '']), '40032802aabb002800');
  assert.equal(serializeMultiSigSignatures([null, '01']), '400200280101');
  assert.equal(serializeMultiSigSignatures(['aa'.repeat(253)]).slice(0, 12), '400128fdfd00');
  for (const slots of [[], Array(11).fill(null), ['xz'], [1], ['aa'.repeat(65535)]]) assert.throws(() => serializeMultiSigSignatures(slots), /MultiSig/);
});

test('chain-fetched context pins order, threshold, network and authorized core', async () => {
  const f = await prepared();
  assert.equal(f.context.networkMagic, '894710606');
  assert.deepEqual(f.context.verifiers, [childA, childB]);
  assert.equal(f.operation.nonce, '7');
  assert.equal(Object.isFrozen(f.context.verifiers), true);
  f.state.authorizedCore = target;
  await assert.rejects(() => f.client.fetchContext({ coreContractHash: core, accountIdHash: account }), /authorized core mismatch/);
});

test('unordered supplied child proofs become exact configured slots and validate on chain', async () => {
  const f = await prepared();
  const bundle = await f.client.validateBundle({ context: f.context, operation: f.operation, childProofs: f.proofs });
  assert.deepEqual(bundle.slots, ['aabb', 'ccdd']);
  assert.equal(bundle.signatureHex, '40022802aabb2802ccdd');
  assert.equal(bundle.chainValidated, true);
  assert.equal(bundle.invocation.args[1].value[5].value, '0x40022802aabb2802ccdd');
});

test('a met threshold permits abstaining null slots without shifting proofs', async () => {
  const f = fixture(); f.state.threshold = 1;
  const context = await f.client.fetchContext({ coreContractHash: core, accountIdHash: account });
  const operation = await f.client.prepareOperation({ context, operation: { targetContract: target, method: 'x', args: [], deadline: '2000000000000' } });
  const bundle = f.client.buildBundle({ context, operation, childProofs: [{ childVerifierHash: childB, kind: 'opaque', operation, signatureHex: 'aa' }] });
  assert.equal(bundle.signatureHex, '4002002801aa');
  assert.equal(bundle.chainValidated, false);
});

for (const [name, mutate, pattern] of [
  ['duplicate proof', f => { f.proofs[1] = f.proofs[0]; }, /duplicate child/],
  ['unknown child', f => { f.proofs[0].childVerifierHash = target; }, /unknown.*child/],
  ['changed target', f => { f.proofs[0].operation = { ...f.operation, targetContract: core }; }, /operation mismatch/],
  ['changed arguments', f => { f.proofs[0].operation = { ...f.operation, args: [] }; }, /operation mismatch/],
  ['changed nonce', f => { f.proofs[0].operation = { ...f.operation, nonce: '8' }; }, /operation mismatch/],
  ['changed account', f => { f.proofs[0].operation = { ...f.operation, accountIdHash: core }; }, /accountIdHash mismatch/],
  ['below threshold', f => { f.proofs.pop(); }, /insufficient/],
]) test(`builder rejects ${name}`, async () => {
  const f = await prepared(); mutate(f);
  assert.throws(() => f.client.buildBundle({ context: f.context, operation: f.operation, childProofs: f.proofs }), pattern);
});

for (const [name, mutate, pattern] of [
  ['config order', f => { f.state.verifiers.reverse(); }, /config drift/],
  ['threshold', f => { f.state.threshold = 1; }, /config drift/],
  ['bound verifier', f => { f.state.bound = target; }, /bound verifier changed/],
  ['network', f => { f.state.network = 860833102; }, /network changed/],
  ['nonce', f => { f.state.nonce = '8'; }, /nonce or arguments hash drift/],
  ['arguments hash', f => { f.state.argsHash = 'cc'.repeat(32); }, /nonce or arguments hash drift/],
  ['rejected child signatures', f => { f.state.valid = false; }, /verification rejected/],
]) test(`validation rejects ${name}`, async () => {
  const f = await prepared(); mutate(f);
  await assert.rejects(() => f.client.validateBundle({ context: f.context, operation: f.operation, childProofs: f.proofs }), pattern);
});

test('EVM child signatures use the child domain; parent-domain or altered typed data is rejected', async () => {
  const f = await prepared();
  const signer = new Wallet(`0x${'01'.repeat(32)}`);
  const typedData = f.client.buildChildTypedData({ context: f.context, operation: f.operation, childVerifierHash: childA });
  assert.equal(typedData.domain.verifyingContract, `0x${childA}`);
  const signature = signer.signingKey.sign(TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message));
  f.proofs[1] = { childVerifierHash: childA, kind: 'evm', operation: f.operation, typedData, signatureFullHex: signature.serialized, signatureHex: signature.r.slice(2) + signature.s.slice(2), signerAddress: signer.address };
  assert.doesNotThrow(() => f.client.buildBundle({ context: f.context, operation: f.operation, childProofs: f.proofs }));
  typedData.domain.verifyingContract = `0x${parent}`;
  assert.throws(() => f.client.buildBundle({ context: f.context, operation: f.operation, childProofs: f.proofs }), /verifier domain mismatch/);
});

test('malformed config, repeated children and mutable pin are rejected', async () => {
  const f = await prepared();
  const tampered = { ...f.context, threshold: 1 };
  assert.throws(() => f.client.buildBundle({ context: tampered, operation: f.operation, childProofs: f.proofs }), /pinned config/);
  f.state.verifiers = [childA, childA];
  await assert.rejects(() => f.client.fetchContext({ coreContractHash: core, accountIdHash: account }), /duplicate/);
});

test('child configuration payload targets the core exact account and configured child', async () => {
  const f = await prepared();
  const args = [{ type: 'Hash160', value: `0x${account}` }, { type: 'ByteArray', value: `04${'aa'.repeat(64)}` }];
  const request = f.client.buildChildConfiguration({ context: f.context, childVerifierHash: childA, method: 'setPublicKey', args });
  assert.equal(request.scriptHash, core);
  assert.equal(request.operation, 'callVerifierChild');
  assert.equal(request.args[1].value, `0x${childA}`);
  assert.deepEqual(request.args[3].value, args);
  assert.throws(() => f.client.buildChildConfiguration({ context: f.context, childVerifierHash: target, method: 'setPublicKey', args }), /unknown child/);
  assert.throws(() => f.client.buildChildConfiguration({ context: f.context, childVerifierHash: childA, method: 'clearAccount', args }), /unsupported/);
  args[0].value = `0x${target}`;
  assert.throws(() => f.client.buildChildConfiguration({ context: f.context, childVerifierHash: childA, method: 'setPublicKey', args }), /account mismatch/);
});

test('an omitted child operation pin is not silently supplied by the aggregator', async () => {
  const f = await prepared();
  f.proofs[0].operation = { ...f.operation };
  delete f.proofs[0].operation.configDigest;
  assert.throws(() => f.client.buildBundle({ context: f.context, operation: f.operation, childProofs: f.proofs }), /incomplete/);
});

test('real MultiSig SDK RPC transport preserves nested RPC types and encodes bytes once', async (t) => {
  const f = await prepared();
  let actual;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    actual = JSON.parse(options.body);
    return { ok: true, json: async () => ({ result: halt(bytesItem('cafe')) }) };
  });
  const client = createMultiSigClient({ rpcUrl: 'http://localhost:20332' });
  const operation = { ...f.operation, args: [
    { type: 'Struct', value: [{ type: 'ByteArray', value: 'aabb' }] },
    { type: 'Map', value: [{ key: { type: 'String', value: 'k' }, value: { type: 'ByteArray', value: 'ccdd' } }] },
    { type: 'Hash256', value: `0x${'ee'.repeat(32)}` },
    { type: 'PublicKey', value: `02${'ff'.repeat(32)}` },
  ] };
  const result = await client.fetchChildPayload({ context: f.context, operation, childVerifierHash: childB });
  assert.equal(result.payloadHex, 'cafe');
  assert.equal(actual.params[0], `0x${childB}`);
  assert.deepEqual(actual.params[2][3].value, [
    { type: 'Array', value: [{ type: 'ByteArray', value: 'qrs=' }] },
    { type: 'Map', value: [{ key: { type: 'String', value: 'k' }, value: { type: 'ByteArray', value: 'zN0=' } }] },
    operation.args[2], operation.args[3],
  ]);
  assert.equal(actual.params[2][4].value, operation.nonce);
});

test('a child verifier bound to a different core cannot enter a signing context', async () => {
  const f = fixture();
  const original = f.rpcClient.invokeFunction;
  f.rpcClient.invokeFunction = async (contract, method, ...rest) => contract === childA && method === 'authorizedCore'
    ? halt(hashItem(target)) : original(contract, method, ...rest);
  await assert.rejects(() => f.client.fetchContext({ coreContractHash: core, accountIdHash: account }), /child authorized core mismatch/);
});

test('opaque Session child payload is fetched from its own verifier with the fixed operation fields', async () => {
  const f = await prepared();
  let actual;
  const original = f.rpcClient.invokeFunction;
  f.rpcClient.invokeFunction = async (contract, method, args) => {
    if (method === 'getPayload') { actual = { contract, method, args }; return halt(bytesItem('cafe')); }
    return original(contract, method, args);
  };
  const result = await f.client.fetchChildPayload({ context: f.context, operation: f.operation, childVerifierHash: childB });
  assert.equal(result.payloadHex, 'cafe');
  assert.equal(actual.contract, childB);
  assert.equal(actual.args[0].value, `0x${account}`);
  assert.equal(actual.args[4].value, f.operation.nonce);
  assert.deepEqual(actual.args[3].value, f.operation.args);
  await assert.rejects(() => f.client.fetchChildPayload({ context: f.context, operation: f.operation, childVerifierHash: target }), /unknown child/);
});
