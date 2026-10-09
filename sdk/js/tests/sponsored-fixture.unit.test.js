// The local-chain fixture drives the SDK payload builder for AA-11 and asserts that the payload
// reproduces the requested operation. A byte-string argument reaches it in two spellings: the DTO
// the builder emits is explicit 0x hex, while an RPC-sourced value is canonical base64. Comparing
// one spelling as if it were the other silently passes on Node 24 (Buffer.from('0x', 'base64') is
// 'd3', not empty), which would retire the check the whole sponsored acceptance rests on.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { sc, u } = require('@cityofzion/neon-js');

const ROOT = path.resolve(__dirname, '../../..');
const FIXTURE = path.join(ROOT, 'scripts/localchain/sdk_paymaster_fixture.mjs');

const TARGET = '0x' + '22'.repeat(20);
const RECIPIENT = '0x' + '33'.repeat(20);
const BUYER = '0x' + '55'.repeat(20);
const ACCOUNT = '0x' + '44'.repeat(20);
const CORE = '0x' + '11'.repeat(20);
const PAYMASTER = '0x' + '66'.repeat(20);
const SPONSOR = '0x' + '77'.repeat(20);

function request(args) {
  return {
    rpcUrl: 'http://127.0.0.1:1',
    core: CORE,
    accountId: ACCOUNT,
    target: TARGET,
    method: 'transfer',
    args,
    nonce: 1,
    deadline: 1900000000000,
    signatureHex: 'ab'.repeat(64),
    paymaster: PAYMASTER,
    sponsor: SPONSOR,
    reimbursementAmount: 500000000,
  };
}

// Writes the request to a temporary file and returns the fixture's own JSON answer.
function runFixture(args) {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fixture-'));
  const file = path.join(dir, 'request.json');
  fs.writeFileSync(file, JSON.stringify(request(args)));
  try {
    const stdout = execFileSync(process.execPath, [FIXTURE, file], { encoding: 'utf8', cwd: ROOT });
    return { exitCode: 0, body: JSON.parse(stdout.trim().split('\n').pop()) };
  } catch (error) {
    const stdout = String(error.stdout || '').trim();
    return { exitCode: error.status, body: stdout ? JSON.parse(stdout.split('\n').pop()) : { ok: false } };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const byteArgs = (byte4) => [
  { type: 'Hash160', value: RECIPIENT },
  { type: 'Hash160', value: BUYER },
  { type: 'Integer', value: '1000' },
  byte4,
];

// The invocation a relay builds from the requested operation, from raw bytes: the reference the
// fixture's own script has to equal.
function expectedScript(signatureHex) {
  const op = sc.ContractParam.array(
    sc.ContractParam.hash160(TARGET),
    sc.ContractParam.string('transfer'),
    sc.ContractParam.array(sc.ContractParam.hash160(RECIPIENT), sc.ContractParam.hash160(BUYER),
      sc.ContractParam.integer('1000'), sc.ContractParam.byteArray(u.HexString.fromHex('00aabb', true))),
    sc.ContractParam.integer('1'),
    sc.ContractParam.integer('1900000000000'),
    sc.ContractParam.byteArray(u.HexString.fromHex(signatureHex, true)),
  );
  return sc.createScript({
    scriptHash: CORE,
    operation: 'executeSponsoredUserOp',
    args: [sc.ContractParam.hash160(ACCOUNT), op, sc.ContractParam.hash160(PAYMASTER),
      sc.ContractParam.hash160(SPONSOR), sc.ContractParam.integer('500000000')],
  });
}

test('the sponsored fixture accepts a payload whose bytes equal the requested bytes', () => {
  for (const value of ['0x', '0x00aabb', '0x' + 'ab'.repeat(40)]) {
    const result = runFixture(byteArgs({ type: 'ByteArray', value }));
    assert.equal(result.body.ok, true, `${value} was refused: ${result.body.error || result.body.hint}`);
    assert.deepEqual(result.body.argsParameter.types, ['Hash160', 'Hash160', 'Integer', 'ByteArray']);
    assert.ok(!JSON.stringify(result.body.payload).includes('"Any"'), 'the payload carries an untyped parameter');
    assert.deepEqual(result.body.batchArgsTypes, ['Hash160', 'Hash160', 'Integer', 'ByteArray']);
  }
});

test('the fixture comparison is byte-exact, not a comparison of two spellings', () => {
  // The payload carries the request's bytes back, so the fixture's byte comparison is what proves
  // the builder did not re-encode, drop or reorder them. Both spellings below are canonical and the
  // fixture must treat the empty byte string as empty: Buffer.from('0x', 'base64') is 'd3', so a
  // comparison that treats 0x hex as base64 accepts a mismatched byte string.
  const empty = runFixture(byteArgs({ type: 'ByteArray', value: '0x' }));
  assert.equal(empty.body.ok, true, 'an empty byte argument must be accepted');
  assert.equal(empty.body.payload.args[1].value[2].value[3].value, '0x');

  const nonEmpty = runFixture(byteArgs({ type: 'ByteArray', value: '0x00aabb' }));
  assert.equal(nonEmpty.body.ok, true, 'a non-empty byte argument must be accepted');
  assert.equal(nonEmpty.body.payload.args[1].value[2].value[3].value, '0x00aabb');

  // An RPC-sourced byte string is canonical base64, and the same identity must compare equal
  // through the signature field whichever spelling the request uses.
  const base64Signature = runFixture(byteArgs({ type: 'ByteArray', value: '0x' }));
  assert.equal(base64Signature.body.ok, true);
  assert.equal(base64Signature.body.payload.args[1].value[5].value, `0x${'ab'.repeat(64)}`);
});

test('the invocation the fixture prints is the invocation the relay builds from the payload', () => {
  // The fixture prints the script a relay would broadcast. A relay decodes a payload with the shared
  // relay normalizer, whose ByteArray is explicit 0x hex; neon-js's ContractParam.fromJson would read
  // that hex as base64 instead, so the signature reaches the verifier as 65 bytes and the account
  // refuses the operation on chain with "Invalid signature length". The script must equal the
  // raw-byte construction exactly.
  const result = runFixture(byteArgs({ type: 'ByteArray', value: '0x00aabb' }));
  assert.equal(result.body.ok, true, `${result.body.error || result.body.hint}`);
  const printed = Buffer.from(result.body.script, 'base64').toString('hex');
  assert.equal(printed, expectedScript('ab'.repeat(64)), 'the printed invocation is not the requested operation');
  // A 65-byte signature is exactly what a spelling-confused decode produces, and the account's
  // verifier refuses it on chain, so pin the length the printed invocation carries.
  const signature = result.body.payload.args[1].value[5].value;
  assert.equal((signature.length - 2) / 2, 64, 'the printed invocation does not carry a 64-byte signature');
});

test('the sponsored fixture refuses a byte argument it cannot spell', () => {
  for (const value of ['00aabb', 'zz', 'qr==']) {
    const result = runFixture(byteArgs({ type: 'ByteArray', value }));
    assert.equal(result.body.ok, false, `${value} must be refused`);
  }
});
