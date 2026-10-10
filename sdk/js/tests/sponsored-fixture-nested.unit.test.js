// The AA-11 comparison claims to prove that the SDK-composed sponsored payload reproduces the
// requested operation. Before this fix it compared nested ByteArray bytes and then reported success
// for every other nested type: a reviewer changed a nested Integer(7) to Integer(999) and the fixture
// still answered ok=true. These tests plant one mutation per nested kind into the payload while the
// expectation stays the requested operation, and require the comparison to refuse it by naming the
// type and the path it caught.
//
// The mutations are planted in the payload because that is the direction the property runs: the
// payload must reproduce the request. The pre-fix walk is run against the same mutations in "the
// pre-fix walk is shown accepting every planted mutation below", which is the red this fix is
// measured against; it is a checked-in copy of the branch's own reviewed fixture code, sliced and
// executed here rather than re-described. The copy is what lets the red run in a clean `git archive`
// export: an archive has no `.git`, so a history lookup cannot supply the pre-fix walk there.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../../..');
const FIXTURE = path.join(ROOT, 'scripts/localchain/sdk_paymaster_fixture.mjs');
const COMPARISON = require(path.join(ROOT, 'scripts/localchain/sponsoredArgumentComparison.mjs'));
// The committed pre-fix walk and the SHA-256 of the exact text this test executes out of it. The
// fixture's own header records where the copy came from and why it is a copy.
const PRE_FIX_WALK = path.join(__dirname, 'fixtures', 'sponsored-walk-prefix-c09972a.mjs');
const PRE_FIX_WALK_SHA256 = 'fe602adc7eaeca55121c4d5b561273555d9b95e5ce7e65c220d27793c60cc8db';

const TARGET = '0x' + '22'.repeat(20);
const ACCOUNT = '0x' + '44'.repeat(20);
const CORE = '0x' + '11'.repeat(20);
const PAYMASTER = '0x' + '66'.repeat(20);
const SPONSOR = '0x' + '77'.repeat(20);
const HASH256 = '0x' + '9a'.repeat(32);
const HASH256_OTHER = '0x' + '7c'.repeat(32);

// The five kinds the relay carries as scalars and byte strings, in the positions the mutation paths
// below name, wrapped in the Array a request argument is carried in.
const nestedEntries = [
  ['Integer', { type: 'Integer', value: '7' }],
  ['String', { type: 'String', value: 'memo' }],
  ['Boolean', { type: 'Boolean', value: true }],
  ['Hash256', { type: 'Hash256', value: HASH256 }],
  ['ByteArray', { type: 'ByteArray', value: '0x00aabb' }],
];

const mapEntries = [{ type: 'Map', value: [
  { key: { type: 'String', value: 'rate' }, value: { type: 'Integer', value: '7' } },
  { key: { type: 'Boolean', value: true }, value: { type: 'String', value: 'on' } },
] }];

function entriesOf(table) {
  return table.map(([, parameter]) => JSON.parse(JSON.stringify(parameter)));
}

function requestArgs(entries = entriesOf(nestedEntries)) {
  return [{ type: 'Array', value: entries }];
}

// A payload built from the request, then mutated at one nested parameter. The expectation stays the
// request as written, so every mutation below is a payload that no longer reproduces the operation.
function payloadWith(mutate) {
  const payload = JSON.parse(JSON.stringify(requestArgs()));
  mutate(payload[0].value);
  return payload;
}

// One row per nested kind: the mutation, the refusal it has to produce, and the type and path that
// refusal has to name so the catch is attributable.
const planted = [
  ['Integer value',
    () => payloadWith((entries) => { entries[0].value = '999'; }),
    'argument 0[0] Integer value differs', 'Integer', 'argument 0[0]'],
  ['Integer kind',
    () => payloadWith((entries) => { entries[0] = { type: 'String', value: '7' }; }),
    'argument 0[0] is String, not Integer', 'String', 'argument 0[0]'],
  ['String value',
    () => payloadWith((entries) => { entries[1].value = 'other'; }),
    'argument 0[1] String value differs', 'String', 'argument 0[1]'],
  ['Boolean value',
    () => payloadWith((entries) => { entries[2].value = false; }),
    'argument 0[2] Boolean value differs', 'Boolean', 'argument 0[2]'],
  ['Hash256 value',
    () => payloadWith((entries) => { entries[3].value = HASH256_OTHER; }),
    'argument 0[3] Hash256 value differs', 'Hash256', 'argument 0[3]'],
  ['ByteArray value',
    () => payloadWith((entries) => { entries[4].value = '0x00aacc'; }),
    'argument 0[4] ByteArray value differs', 'ByteArray', 'argument 0[4]'],
  ['nested Array length',
    () => payloadWith((entries) => { entries.splice(1, 1); }),
    'argument 0 does not carry the requested nested parameters', 'nested Array', 'argument 0'],
  ['dropped argument',
    () => [],
    'argument 0 is missing', 'argument', 'argument 0'],
];

const plantedMap = [
  ['map value',
    () => { const payload = requestArgs(entriesOf([['Map', mapEntries[0]]])); payload[0].value[0].value[0].value.value = '999'; return payload; },
    'argument 0[0].value[0].value Integer value differs', 'Integer', 'argument 0[0].value[0].value'],
  ['map entry count',
    () => { const payload = requestArgs(entriesOf([['Map', mapEntries[0]]])); payload[0].value[0].value.pop(); return payload; },
    'argument 0[0] does not carry the requested map entries', 'nested Map', 'argument 0[0]'],
  ['map key kind',
    () => { const payload = requestArgs(entriesOf([['Map', mapEntries[0]]])); payload[0].value[0].value[1].key = { type: 'Integer', value: '1' }; return payload; },
    'argument 0[0].value[1].key is Integer, not Boolean', 'Integer', 'argument 0[0].value[1].key'],
  ['map entry order',
    () => { const payload = requestArgs(entriesOf([['Map', mapEntries[0]]])); payload[0].value[0].value = [payload[0].value[0].value[1], payload[0].value[0].value[0]]; return payload; },
    'argument 0[0].value[0].key is Boolean, not String', 'Boolean', 'argument 0[0].value[0].key'],
];

function refusal(payload, expected = requestArgs()) {
  return COMPARISON.compareSponsArgs(payload, expected);
}

// The complete text of one function or arrow binding, so the walk the red runs is sliced out of the
// reviewed text rather than re-described in the test.
function definitionOf(source, start) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `the reviewed fixture no longer carries ${start}`);
  let depth = 0;
  let opened = false;
  for (let index = from; index < source.length; index += 1) {
    const character = source[index];
    if (character === '{') { depth += 1; opened = true; }
    if (character === '}') {
      depth -= 1;
      if (opened && depth === 0) {
        // A function declaration ends at its brace; an arrow binding takes the semicolon after it.
        return start.startsWith('function')
          ? source.slice(from, index + 1)
          : source.slice(from, index + (source[index + 1] === ';' ? 2 : 1));
      }
    }
    if (!opened && character === ';') return source.slice(from, index + 1);
  }
  throw new Error(`could not read the definition of ${start}`);
}

test('the comparison refuses every planted nested mutation, naming the type and the path', () => {
  for (const [label, mutate, expectedDifference, type, where] of planted) {
    const { difference } = refusal(mutate());
    assert.equal(difference, expectedDifference,
      `${label}: the payload was not refused as expected (got ${JSON.stringify(difference)})`);
    // The failure text names the kind and the path, so a refusal is attributable without reading the
    // payload: an Integer mismatch at argument 0[0] is not a ByteArray mismatch at argument 0[4].
    assert.ok(difference.includes(where), `${label} (${type}): the refusal does not name ${where}`);
    if (difference.includes(' is ')) {
      assert.ok(difference.includes(' is '), `${label} (${type}): the refusal does not name both kinds`);
    }
  }
});

test('the comparison refuses every planted map mutation, including entry order', () => {
  const expected = requestArgs(entriesOf([['Map', mapEntries[0]]]));
  for (const [label, mutate, expectedDifference, type, where] of plantedMap) {
    const { difference } = refusal(mutate(), expected);
    assert.equal(difference, expectedDifference,
      `${label}: the payload was not refused as expected (got ${JSON.stringify(difference)})`);
    assert.ok(difference.includes(where), `${label} (${type}): the refusal does not name ${where}`);
  }
});

test('the pre-fix walk is shown accepting every planted non-byte mutation below', () => {
  // The red this fix is measured against, sliced out of the checked-in copy of the branch's own
  // reviewed fixture at c09972a. Its walk recursed into nested Array lengths and compared nested
  // ByteArray bytes, so it refused those two and returned success for every other kind; the accepted
  // set below is that remainder, which is the defect. If the set ever changes, the planted mutations
  // have stopped reproducing the reported defect and the green above would prove nothing.
  const source = fs.readFileSync(PRE_FIX_WALK, 'utf8');
  const executed = [
    definitionOf(source, 'const byteHex ='),
    definitionOf(source, 'const hex ='),
    definitionOf(source, 'function byteDifference'),
  ].join('\n');
  // A committed copy can drift where a history lookup could not, so the text that is about to run is
  // pinned: this is the digest of the pre-fix text the git-backed red executed, and a changed fixture
  // fails here instead of quietly re-basing the red on a different walk.
  assert.equal(createHash('sha256').update(executed).digest('hex'), PRE_FIX_WALK_SHA256,
    'the fixture no longer carries the reviewed pre-fix walk');
  const preFix = new Function(`
${executed}
    return { byteDifference };`)();
  const expected = requestArgs();
  const mapExpected = requestArgs(entriesOf([['Map', mapEntries[0]]]));
  const accepted = [];
  for (const [label, mutate] of planted) {
    const payload = mutate();
    if (!payload.length) continue;
    if (!preFix.byteDifference(payload[0], expected[0], 'argument 0')) accepted.push(label);
  }
  for (const [label, mutate] of plantedMap) {
    const payload = mutate();
    if (!preFix.byteDifference(payload[0], mapExpected[0], 'argument 0')) accepted.push(label);
  }
  assert.deepEqual(accepted, [
    'Integer value', 'Integer kind', 'String value', 'Boolean value', 'Hash256 value',
    'map value', 'map entry count', 'map key kind', 'map entry order',
  ], 'the pre-fix walk no longer accepts exactly the non-byte nested mutations');
});

test('the comparison still accepts a payload whose every nested value is the requested one', () => {
  assert.equal(refusal(payloadWith(() => {})).difference, null);
  // The same bytes, in the other canonical spelling this boundary allows.
  const respelled = payloadWith((entries) => { entries[4].value = '0x00AABB'; });
  assert.equal(refusal(respelled).difference, null, 'a canonical byte respelling must match');
});

test('the comparison reports how much of the nested tree it actually compared', () => {
  const { difference, inspection } = refusal(payloadWith(() => {}));
  assert.equal(difference, null);
  assert.equal(inspection.arguments, 1);
  assert.equal(inspection.argumentsReached, 1, 'the walk did not reach the nested argument');
  assert.equal(inspection.deepestArgumentDepth, 2, 'the argument is a container inside a container');
  assert.equal(inspection.parameters, 6, 'every nested parameter the payload carries has to be counted');
  assert.equal(inspection.leavesCompared, 3, 'every scalar leaf has to be compared');
  assert.equal(inspection.hashesCompared, 1, 'the nested hash has to be compared');
  assert.equal(inspection.byteArraysCompared, 1, 'the nested byte string has to be compared');
  assert.equal(inspection.skipped, 0, 'the walk skipped a parameter it carries');
  assert.deepEqual(inspection.types, ['Array', 'Integer', 'String', 'Boolean', 'Hash256', 'ByteArray']);
});

function fixtureRequest(args) {
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

function runFixture(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-fixture-nested-'));
  const file = path.join(dir, 'request.json');
  fs.writeFileSync(file, JSON.stringify(fixtureRequest(args)));
  try {
    const stdout = execFileSync(process.execPath, [FIXTURE, file], { encoding: 'utf8', cwd: ROOT });
    return JSON.parse(stdout.trim().split('\n').pop());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the fixture publishes the same walk it refuses on, and accepts the requested operation', () => {
  const body = runFixture(requestArgs());
  assert.equal(body.ok, true, `the fixture refused its own requested operation: ${body.error || body.hint}`);
  assert.deepEqual(body.inspection, refusal(payloadWith(() => {})).inspection,
    'the fixture publishes a different walk than the one under test');
  // The nested tree really is carried by the payload, so the walk above had something to compare.
  assert.deepEqual(body.payload.args[1].value[2].value[0].value.map((item) => item.type),
    ['Integer', 'String', 'Boolean', 'Hash256', 'ByteArray']);
});
