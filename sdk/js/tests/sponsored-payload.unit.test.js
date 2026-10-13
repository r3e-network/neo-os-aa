const test = require('node:test');
const assert = require('node:assert/strict');
const { sc, u } = require('@cityofzion/neon-js');
const compat = require('../src/neonCompat');
const { AbstractAccountClient } = require('../src/index');

const MASTER = '11'.repeat(20);
const ACCOUNT = '22'.repeat(20);
const TARGET = '1234567890abcdef1234567890abcdef12345678';
const PAYMASTER = '33'.repeat(20);
const SPONSOR = '44'.repeat(20);
const HASH256 = '0123456789abcdef'.repeat(4);
const PUBLIC_KEY = '036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296';
const SIGNATURE = '0123456789abcdef'.repeat(8);
const client = new AbstractAccountClient('http://127.0.0.1:1', MASTER);
const json = (value) => JSON.parse(JSON.stringify(value));
const bytes = (hex) => sc.ContractParam.byteArray(u.HexString.fromHex(hex, true));
const op = (args = []) => ({ TargetContract: TARGET, Method: 'transfer', Args: args,
  Nonce: '9007199254740993', Deadline: '1900000000000', Signature: SIGNATURE });
const options = { accountScriptHash: ACCOUNT, paymasterHash: PAYMASTER,
  sponsorAddress: SPONSOR, reimbursementAmount: '123456789' };
const single = (args) => client.createSponsoredUserOpPayload({ ...options, userOp: op(args) });
const batch = (args) => client.createSponsoredBatchPayload({ ...options, userOps: [op(args)] });

function expected(operation, innerArgs) {
  const userOp = sc.ContractParam.array(sc.ContractParam.hash160(TARGET), sc.ContractParam.string('transfer'),
    sc.ContractParam.array(...innerArgs), sc.ContractParam.integer('9007199254740993'),
    sc.ContractParam.integer('1900000000000'), bytes(SIGNATURE));
  return sc.createScript({ scriptHash: MASTER, operation, args: [sc.ContractParam.hash160(ACCOUNT),
    operation === 'executeSponsoredUserOps' ? sc.ContractParam.array(userOp) : userOp,
    sc.ContractParam.hash160(PAYMASTER), sc.ContractParam.hash160(SPONSOR), sc.ContractParam.integer('123456789')] });
}

async function relayScript(payload) {
  const { convertContractParamFromJson } = await import('../../../frontend/api/relayHelpers.js');
  const decoded = json(payload);
  return sc.createScript({ ...decoded, args: decoded.args.map((arg) => convertContractParamFromJson(arg, { sc, u })) });
}

const typed = [
  { type: 'Hash160', value: `0x${TARGET}` }, { type: 'Hash256', value: HASH256 },
  { type: 'PublicKey', value: PUBLIC_KEY }, { type: 'ByteArray', value: '0x00aabbff' },
  { type: 'Boolean', value: false }, { type: 'Any' },
  { type: 'Array', value: [{ type: 'Integer', value: '-9007199254740993' }, { type: 'ByteArray', value: 'qrs=' }] },
  { type: 'Map', value: [{ key: { type: 'String', value: 'entry' },
    value: { type: 'Array', value: [{ type: 'String', value: '你好' }, { type: 'Integer', value: '7' }] } }] },
];
const expectedArgs = () => [sc.ContractParam.hash160(TARGET), sc.ContractParam.hash256(HASH256),
  sc.ContractParam.publicKey(PUBLIC_KEY), bytes('00aabbff'), sc.ContractParam.boolean(false), sc.ContractParam.any(null),
  sc.ContractParam.array(sc.ContractParam.integer('-9007199254740993'), bytes('aabb')),
  sc.ContractParam.map({ key: sc.ContractParam.string('entry'), value: sc.ContractParam.array(sc.ContractParam.string('你好'), sc.ContractParam.integer('7')) })];

for (const [name, build] of [['single', single], ['batch', batch]]) {
  test(`${name} sponsored SDK JSON reproduces exact relay script bytes for every supported type`, async () => {
    const payload = build(typed);
    assert.equal(await relayScript(payload), expected(payload.operation, expectedArgs()));
  });
  test(`${name} sponsored SDK supports real Neon ContractParam instances`, async () => {
    const args = expectedArgs();
    const before = json(args);
    const payload = build(args);
    assert.deepEqual(json(args), before, 'caller parameters must not be mutated');
    assert.equal(await relayScript(payload), expected(payload.operation, args));
  });
  test(`${name} sponsored SDK supports compatibility ContractParam instances with nonempty bytes`, async () => {
    const args = [compat.sc.ContractParam.byteArray('00aabbff'), compat.sc.ContractParam.array(compat.sc.ContractParam.integer('7'))];
    assert.equal(await relayScript(build(args)), expected(build(args).operation, [bytes('00aabbff'), sc.ContractParam.array(sc.ContractParam.integer('7'))]));
  });
  test(`${name} sponsored SDK rejects malformed parameters instead of coercing or dropping them`, () => {
    const invalid = ['untyped', {}, { type: 'Unknown', value: 'aa' }, { type: 18, value: 'qrs=' },
      { type: 'Any', value: 'text' }, { type: 'Boolean', value: 'false' }, { type: 'String', value: 3 },
      { type: 'Integer', value: 9007199254740992 }, { type: 'Integer', value: '3.1' }, { type: 'Integer', value: 1n << 255n },
      { type: 'ByteArray', value: 'zz' }, { type: 'ByteArray', value: 'aabb' }, { type: 'ByteArray', value: '0xz1' },
      { type: 'ByteArray', value: 'qr==' }, { type: 'Hash160', value: '22' }, { type: 'Hash256', value: 'aa' },
      { type: 'PublicKey', value: '04'.repeat(33) }, { type: 'Array', value: ['raw'] },
      { type: 'Array', value: null }, { type: 'Map', value: [{ key: { type: 'Any' }, value: { type: 'Integer', value: '1' } }] },
      { type: 'Map', value: [{ key: { type: 'String', value: 'k' } }] }];
    for (const arg of invalid) assert.throws(() => build([arg]), (error) => error.code === 'SDK_011', `accepted ${String(arg?.type || arg)}`);
  });
  test(`${name} sponsored SDK refuses cyclic arguments and arguments beyond relay depth`, () => {
    const cycle = { type: 'Array', value: [] }; cycle.value.push(cycle);
    let deep = { type: 'Integer', value: '1' };
    for (let i = 0; i < 10; i += 1) deep = { type: 'Array', value: [deep] };
    for (const args of [[cycle], [deep], 'not-an-array']) assert.throws(() => build(args), (error) => error.code === 'SDK_011');
  });
}

// Every parameter kind the relay cannot carry has to be refused at build time with the path of the
// offending argument, not coerced into an untyped carrier the relay refuses later. Each row names
// the one path the refusal must report.
const rejectedKind = [
  ['a kind the SDK does not carry (Signature)', [{ type: 'Signature', value: SIGNATURE }], '[0]'],
  ['a kind the SDK does not carry (Address)', [{ type: 'Address', value: `0x${TARGET}` }], '[0]'],
  ['an unknown type name', [{ type: 'Wibble', value: 'aa' }], '[0]'],
  ['a non-null Any', [{ type: 'Any', value: 'text' }], '[0]'],
  ['an untyped argument', ['raw-value'], '[0]'],
  ['an object without a type', [{ not: 'a parameter' }], '[0]'],
  ['a date argument that is not a contract parameter', [new Date(0)], '[0]'],
  ['a nested array value', [{ type: 'Array', value: [[{ type: 'Integer', value: '7' }]] }], '[0][0]'],
  ['an untyped nested value', [{ type: 'Array', value: [{ type: 'Integer', value: '7' }, 'raw-value'] }], '[0][1]'],
  ['an unsupported kind at nesting level two', [{ type: 'Array', value: [{ type: 'Array', value: [{ type: 'Signature', value: SIGNATURE }] }] }], '[0][0][0]'],
  ['an unsupported kind as a Map value', [{ type: 'Map', value: [{ key: { type: 'String', value: 'k' }, value: { type: 'Wibble', value: 'x' } }] }], '[0].value[0].value'],
  ['an unsupported kind as a Map key', [{ type: 'Map', value: [{ key: { type: 'Signature', value: SIGNATURE }, value: { type: 'Integer', value: '1' } }] }], '[0].value[0].key'],
  ['an untyped Struct item', [{ type: 'Struct', value: [{ type: 'Integer', value: '1' }, 'raw-value'] }], '[0][1]'],
];

for (const [name, build] of [['single', single], ['batch', batch]]) {
  test(`${name} sponsored SDK names the offending path of every unsupported argument kind`, () => {
    for (const [label, args, path] of rejectedKind) {
      assert.throws(() => build(args), (error) => error.code === 'SDK_011'
        && (error.details?.hint || '').includes(`userOp.Args${path}`),
      `${name} did not name ${path} for ${label}: expected a refusal naming userOp.Args${path}`);
    }
  });

  test(`${name} sponsored SDK refuses every unsupported argument kind without coercion`, () => {
    for (const [label, args] of rejectedKind) {
      assert.throws(() => build(args), (error) => error.code === 'SDK_011', `${name} accepted ${label}`);
    }
  });
}

test('batch contains the exact same operation DTO as a single payload and keeps each operation separate', () => {
  const singleJson = json(single(typed));
  const batchJson = json(client.createSponsoredBatchPayload({ ...options, userOps: [op(typed), { ...op([]), Nonce: '9007199254740994' }] }));
  assert.equal(batchJson.args[1].type, 'Array');
  assert.equal(batchJson.args[1].value.length, 2);
  assert.deepEqual(batchJson.args[1].value[0], singleJson.args[1]);
  assert.deepEqual(batchJson.args[1].value[1].value[3], { type: 'Integer', value: '9007199254740994' });
  assert.deepEqual(singleJson.args[1].value[5], { type: 'ByteArray', value: `0x${SIGNATURE}` });
});

test('empty argument lists are canonical arrays and reimbursement remains positive', async () => {
  for (const build of [single, batch]) {
    for (const args of [undefined, null, []]) assert.equal(await relayScript(build(args)), expected(build(args).operation, []));
  }
  for (const amount of [0, -1]) assert.throws(() => client.createSponsoredUserOpPayload({ ...options, reimbursementAmount: amount, userOp: op([]) }), (error) => error.code === 'SDK_011');
});

test('real computeArgsHash RPC JSON and sponsored relay use identical argument scripts', async (t) => {
  let captured;
  const hash = 'ab'.repeat(32);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    captured = JSON.parse(options.body);
    return { ok: true, json: async () => ({ result: { state: 'HALT', stack: [
      { type: 'ByteString', value: Buffer.from(hash, 'hex').toString('base64') },
    ] } }) };
  });
  const { convertContractParamFromJson } = await import('../../../frontend/api/relayHelpers.js');
  const { UserOperationBuilder } = require('../src/index');
  for (const args of [typed, expectedArgs()]) {
    assert.equal(await client.computeArgsHash(args), hash);
    assert.equal(captured.method, 'invokefunction');
    assert.deepEqual(captured.params.slice(0, 2), [`0x${MASTER}`, 'computeArgsHash']);
    assert.deepEqual(captured.params[2][0], sc.ContractParam.array(...expectedArgs()).toJson());
    const rpcParameter = sc.ContractParam.fromJson(captured.params[2][0]);
    const relayParameter = convertContractParamFromJson(json(single(args)).args[1].value[2], { sc, u });
    const push = (parameter) => new sc.ScriptBuilder().emitContractParam(parameter).str;
    assert.equal(push(rpcParameter), push(relayParameter), 'the two deterministic StdLib.Serialize inputs must be byte-identical');
    const builder = new UserOperationBuilder().setTarget(TARGET).setMethod('transfer').setArgs(args)
      .setAccountId(ACCOUNT).setCoreContract(MASTER).setVerifier(PAYMASTER).setChainId('894710606')
      .setNonce('9007199254740993').setDeadline('1900000000000').setArgsHash(hash);
    const data = builder.buildEIP712();
    assert.equal(data.message.argsHash.replace(/^0x/, ''), hash);
  }
});

test('sponsored operation scalars fail before transport if they cannot represent exact values', () => {
  for (const override of [{ Method: 123 }, { Nonce: 9007199254740992 }, { Deadline: '1.1' }, { Signature: 'zz' }]) {
    assert.throws(() => client.createSponsoredUserOpPayload({ ...options, userOp: { ...op(), ...override } }), (error) => error.code === 'SDK_011');
  }
});

test('sponsored and args-hash inputs reject duplicate Map keys before RPC or signing', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('duplicate keys must not reach transport'); });
  const duplicate = { type: 'Map', value: [
    { key: { type: 'String', value: 'a' }, value: { type: 'Integer', value: '1' } },
    { key: { type: 'ByteArray', value: '0x61' }, value: { type: 'Integer', value: '2' } },
  ] };
  for (const build of [single, batch]) assert.throws(() => build([duplicate]), (error) => error.code === 'SDK_011' && /duplicate Map key/.test(error.details?.hint));
  await assert.rejects(() => client.computeArgsHash([duplicate]), (error) => error.code === 'SDK_011' && /duplicate Map key/.test(error.details?.hint));
});
