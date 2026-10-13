import test from 'node:test';
import assert from 'node:assert/strict';
import { createMultiSigDraftSession } from '../src/features/operations/multiSig.js';

const core = '11'.repeat(20), account = '22'.repeat(20), parent = '33'.repeat(20), child = '44'.repeat(20);
const hash = (value) => ({ type: 'ByteString', value: Buffer.from(value, 'hex').reverse().toString('base64') });
const halt = (value) => ({ state: 'HALT', stack: [value] });
test('frontend MultiSig session validates an explicitly pinned proof using RPC Array/base64 parameters', async () => {
  let validationArgs;
  const session = createMultiSigDraftSession({ rpcUrl: 'http://localhost:20332', fetchImpl: async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    let result;
    if (method === 'getversion') result = { protocol: { network: 894710606 } };
    else if (params[1] === 'getVerifier') result = halt(hash(parent));
    else if (params[1] === 'authorizedCore') result = halt(hash(core));
    else if (params[1] === 'getConfig') result = halt({ type: 'Struct', value: [{ type: 'Array', value: [hash(child)] }, { type: 'Integer', value: '1' }] });
    else if (params[1] === 'getNonce') result = halt({ type: 'Integer', value: '0' });
    else if (params[1] === 'computeArgsHash') result = halt({ type: 'ByteString', value: Buffer.from('aa'.repeat(32), 'hex').toString('base64') });
    else if (params[1] === 'validateSignature') { validationArgs = params[2]; result = halt({ type: 'Boolean', value: true }); }
    else throw new Error('unexpected RPC');
    return { ok: true, json: async () => ({ result }) };
  } });
  const context = await session.fetchContext({ coreContractHash: core, accountIdHash: account });
  const operation = await session.prepareOperation({ context, operation: { targetContract: core, method: 'symbol', args: [], deadline: '2000000000000' } });
  const result = await session.validateBundle({ context, operation, childProofs: [{ kind: 'opaque', childVerifierHash: child, operation, signatureHex: 'aabb' }] });
  assert.equal(result.signatureHex, '40012802aabb');
  assert.equal(result.chainValidated, true);
  assert.equal(validationArgs[1].type, 'Array');
  assert.equal(validationArgs[1].value[5].value, Buffer.from(result.signatureHex, 'hex').toString('base64'));
});

test('frontend rejects RPC errors and absent network identity before loading signing context', async () => {
  const session = createMultiSigDraftSession({ rpcUrl: 'http://localhost:20332', fetchImpl: async () => ({ ok: true, json: async () => ({ result: {} }) }) });
  await assert.rejects(() => session.fetchContext({ coreContractHash: core, accountIdHash: account }), /network magic unavailable/);
});

test('UserOperation args hash RPC uses base64 bytes and RPC Array types', async () => {
  const { computeArgsHash } = await import('../src/features/operations/metaTx.js');
  let params;
  const actual = await computeArgsHash({ rpcUrl: 'http://localhost:20332', aaContractHash: core, args: [{ type: 'ByteArray', value: '0xaabb' }, { type: 'Struct', value: [{ type: 'ByteArray', value: '0x' }] }], fetchImpl: async (_url, options) => {
    params = JSON.parse(options.body).params;
    return { ok: true, json: async () => ({ result: halt({ type: 'ByteString', value: Buffer.from('aa'.repeat(32), 'hex').toString('base64') }) }) };
  } });
  assert.equal(actual, 'aa'.repeat(32));
  assert.deepEqual(params[2][0], { type: 'Array', value: [{ type: 'ByteArray', value: 'qrs=' }, { type: 'Array', value: [{ type: 'ByteArray', value: '' }] }] });
});
