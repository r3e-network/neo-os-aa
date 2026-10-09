// A malformed nested container must be named by the path it sits at.
//
// The SDK walk validates every node with the relay's own normaliser and, on a refusal, names the
// argument path that caused it. A container whose value is not an array, or a Map entry that is not an
// entry, was handed to the normaliser without the wrapper that adds the path, so the caller learned
// that a nested container was malformed but not where: the sibling cases ("an unsupported kind at
// nesting level two") do report userOp.Args[0][0][0]. These tests pin the missing paths.
const test = require('node:test');
const assert = require('node:assert/strict');

const SDK = require('../src/index.js');

const TARGET = '0x' + '22'.repeat(20);
const ACCOUNT = '0x' + '44'.repeat(20);
const CORE = '0x' + '11'.repeat(20);
const PAYMASTER = '0x' + '66'.repeat(20);
const SPONSOR = '0x' + '77'.repeat(20);

function client() {
  return new SDK.AbstractAccountClient('http://127.0.0.1:1', CORE);
}

function userOp(args) {
  return {
    TargetContract: TARGET,
    Method: 'transfer',
    Args: args,
    Nonce: 1,
    Deadline: 1900000000000,
    Signature: 'ab'.repeat(64),
  };
}

function options(args) {
  return {
    accountScriptHash: ACCOUNT,
    userOp: userOp(args),
    paymasterHash: PAYMASTER,
    sponsorAddress: SPONSOR,
    reimbursementAmount: 500000000,
  };
}

// Every malformed nested container, with the path the refusal has to name. The last two are named
// against their container rather than their own value: the value they carry is not a container at all,
// so the check is that they are not silently accepted.
const malformed = [
  ['a nested Array whose value is not a list',
    [{ type: 'Array', value: [{ type: 'Array', value: null }] }], 'userOp.Args[0][0]'],
  ['a nested Struct whose value is not a list',
    [{ type: 'Array', value: [{ type: 'Struct', value: 'not-a-list' }] }], 'userOp.Args[0][0]'],
  ['a container nested two levels deep',
    [{ type: 'Array', value: [{ type: 'Array', value: [{ type: 'Array', value: null }] }] }], 'userOp.Args[0][0][0]'],
  ['a Map whose value is not an entry list',
    [{ type: 'Map', value: null }], 'userOp.Args[0]'],
  ['a Map entry in a nested Map',
    [{ type: 'Array', value: [{ type: 'Map', value: [null] }] }], 'userOp.Args[0][0]'],
];

function build(args) {
  return client().createSponsoredUserOpPayload(options(args));
}

test('the sponsored SDK names the path of a malformed nested container', () => {
  for (const [label, args, path] of malformed) {
    assert.throws(() => build(args), (error) => error.code === 'SDK_011'
      && String(error.details?.hint || '').includes(path),
    `${label} must name ${path}, got ${JSON.stringify(buildHint(args))}`);
  }
});

function buildHint(args) {
  try {
    build(args);
    return { accepted: true };
  } catch (error) {
    return error.details?.hint || error.message;
  }
}

test('the batch builder names the same path as the single builder', () => {
  for (const [label, args, path] of malformed) {
    assert.throws(() => client().createSponsoredBatchPayload({ ...options(args), userOps: [userOp(args)] }),
      (error) => error.code === 'SDK_011' && String(error.details?.hint || '').includes(path),
      `${label} must name ${path} in the batch payload too`);
  }
});

test('a well-formed nested container is still accepted', () => {
  const payload = build([
    { type: 'Array', value: [{ type: 'Map', value: [{ key: { type: 'String', value: 'k' }, value: { type: 'Integer', value: '1' } }] }] },
  ]);
  assert.equal(payload.operation, 'executeSponsoredUserOp');
});
