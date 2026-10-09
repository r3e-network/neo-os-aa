// The AA-11 fixture claims to prove that the SDK-composed sponsored payload
// reproduces the requested operation. A walk that compares nested ByteArrays and
// then reports success for every other nested type pins less than it claims: a
// reviewer changed a nested Integer(7) to Integer(999) and the fixture still
// answered ok=true. These tests plant one nested mutation per parameter type and
// require the fixture to refuse it, naming the type and the path it caught.
//
// The mutation is planted in the fixture's expectation, not in the payload, so
// the payload really does disagree with what the fixture must reproduce. See
// sdk/js/tests/fixtureNestedMutation.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const FIXTURE = path.join(ROOT, 'scripts/localchain/sdk_paymaster_fixture.mjs');
const HOOK = path.join(__dirname, 'fixtureNestedMutation.cjs');
const SDK_ENTRY = path.join(ROOT, 'sdk/js/src/index.js');

const TARGET = '0x' + '22'.repeat(20);
const ACCOUNT = '0x' + '44'.repeat(20);
const CORE = '0x' + '11'.repeat(20);
const PAYMASTER = '0x' + '66'.repeat(20);
const SPONSOR = '0x' + '77'.repeat(20);
const HASH256 = '9a'.repeat(32);
const HASH256_OTHER = '7c'.repeat(32);

// The argument under test is a nested container, because that is the level the
// fixture's walk skipped: six levels below userOp.Args before the first leaf.
function nestedArgs(entries) {
  return [{ type: 'Array', value: entries }];
}

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

function runFixture(args, mutation) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fixture-nested-'));
  const file = path.join(dir, 'request.json');
  fs.writeFileSync(file, JSON.stringify(request(args)));
  const env = { ...process.env, AA_FIXTURE_MODULE: FIXTURE };
  if (mutation) env.AA_NESTED_MUTATION = JSON.stringify(mutation);
  else delete env.AA_NESTED_MUTATION;
  try {
    const stdout = execFileSync(process.execPath, ['--require', HOOK, FIXTURE, file], {
      encoding: 'utf8', cwd: ROOT, env,
    });
    return { exitCode: 0, body: JSON.parse(stdout.trim().split('\n').pop()) };
  } catch (error) {
    const stdout = String(error.stdout || '').trim();
    return { exitCode: error.status, body: stdout ? JSON.parse(stdout.split('\n').pop()) : { ok: false } };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Every nested parameter kind the relay carries, plus the nesting levels the
// fixture's walk has to cross to reach them.
const nestedTypes = [
  ['Integer', { type: 'Integer', value: '7' }, { op: 'value', path: '0.value.0', value: '999' }, 'argument 0[0] value differs'],
  ['Integer', { type: 'Integer', value: '7' }, { op: 'parameter', path: '0.value.0', parameter: { type: 'String', value: '7' } }, 'argument 0[0] is String, not Integer'],
  ['String', { type: 'String', value: 'memo' }, { op: 'value', path: '0.value.1', value: 'other' }, 'argument 0[1] value differs'],
  ['Boolean', { type: 'Boolean', value: true }, { op: 'value', path: '0.value.2', value: false }, 'argument 0[2] value differs'],
  ['Hash256', { type: 'Hash256', value: `0x${HASH256}` }, { op: 'value', path: '0.value.3', value: `0x${HASH256_OTHER}` }, 'argument 0[3] value differs'],
  ['ByteArray', { type: 'ByteArray', value: '0x00aabb' }, { op: 'value', path: '0.value.4', value: '0x00aacc' }, 'argument 0[4] bytes differ'],
];

test('the fixture refuses a mutation of every nested parameter type, naming type and path', () => {
  for (const [type, parameter, mutation, expected] of nestedTypes) {
    const args = nestedArgs(nestedTypes.map(([, item]) => JSON.parse(JSON.stringify(item))));
    const result = runFixture(args, mutation);
    assert.equal(result.body.ok, false, `a mutated nested ${type} was accepted: ${JSON.stringify(result.body)}`);
    assert.match(result.body.error, /does not reproduce the operation/,
      `a mutated nested ${type} was refused, but not by the reproduction walk: ${result.body.error}`);
    const caught = result.body.error.split('the payload does not reproduce the operation: ')[1] || '';
    assert.ok(caught.startsWith(expected),
      `a mutated nested ${type} must be caught as ${JSON.stringify(expected)}, got ${JSON.stringify(caught)}`);
    void parameter;
  }
});

test('the fixture refuses a nested mutation in the map entries it carries', () => {
  const args = nestedArgs([{ type: 'Map', value: [
    { key: { type: 'String', value: 'rate' }, value: { type: 'Integer', value: '7' } },
    { key: { type: 'Boolean', value: true }, value: { type: 'String', value: 'on' } },
  ] }]);
  for (const [label, mutation, expected] of [
    ['a map value', { op: 'value', path: '0.value.0.value.0', value: '999' }, 'argument 0[0].value[0].value value differs'],
    ['a map entry', { op: 'entry', path: '0.value.0.value.1', entry: { key: { type: 'Integer', value: '1' }, value: { type: 'String', value: 'on' } } }, 'argument 0[0].value[1].key is Integer, not Boolean'],
    ['the map entry order', { op: 'entry', path: '0.value.1', entry: { key: { type: 'Boolean', value: true }, value: { type: 'String', value: 'on' } } }, 'argument 0[1].value[0].key is Boolean, not Integer'],
  ]) {
    const result = runFixture(args, mutation);
    assert.equal(result.body.ok, false, `${label} mutation was accepted: ${JSON.stringify(result.body)}`);
    const caught = result.body.error.split('the payload does not reproduce the operation: ')[1] || '';
    assert.ok(caught.startsWith(expected),
      `${label} must be caught as ${JSON.stringify(expected)}, got ${JSON.stringify(caught)}`);
  }
});

test('the fixture reports how much of the nested tree its walk actually compared', () => {
  const args = nestedArgs(nestedTypes.map(([, item]) => JSON.parse(JSON.stringify(item))));
  const result = runFixture(args);
  assert.equal(result.body.ok, true, `the unmutated request was refused: ${result.body.error || result.body.hint}`);
  const inspection = result.body.inspection;
  assert.ok(inspection, 'the fixture does not report what it inspected');
  assert.equal(inspection.arguments, 1);
  assert.equal(inspection.argumentsReached, 1, 'the walk did not reach the nested argument');
  assert.equal(inspection.deepestArgumentDepth, 2, 'argument 0 is a container inside a container');
  assert.equal(inspection.parameters, 11, 'every nested parameter the payload carries has to be counted');
  assert.equal(inspection.leavesCompared, 6, 'every scalar leaf has to be compared');
  assert.equal(inspection.hashesCompared, 1, 'the nested hash has to be compared');
  assert.equal(inspection.byteArraysCompared, 2, 'the nested and the signature byte strings have to be compared');
  assert.equal(inspection.skipped, 0, 'the walk skipped a parameter it carries');
  assert.deepEqual(inspection.types, ['Array', 'Integer', 'String', 'Boolean', 'Hash256', 'ByteArray'],
    'the report must name every type the walk compared');
});

test('the fixture still accepts a nested tree whose every value is the requested one', () => {
  const args = nestedArgs(nestedTypes.map(([, item]) => JSON.parse(JSON.stringify(item))));
  for (const mutation of [
    { op: 'value', path: '0.value.1', value: 'memo' },
    { op: 'value', path: '0.value.3', value: `0x${HASH256}` },
    { op: 'value', path: '0.value.0', value: '7' },
  ]) {
    const result = runFixture(args, mutation);
    assert.equal(result.body.ok, true, `an unchanged nested value was refused: ${result.body.error || result.body.hint}`);
  }
});
